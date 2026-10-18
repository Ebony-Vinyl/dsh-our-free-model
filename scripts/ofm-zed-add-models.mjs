#!/usr/bin/env node
/**
 * Menambahkan model gateway yang sudah terbukti hidup ke `available_models`
 * milik penyedia "Our-Free-Local" di settings Zed — secara bedah string,
 * sehingga komentar //, EOL (LF), dan indentasi byte lain tidak berubah.
 *
 * Sumber kebenaran kapabilitas: `~/.our-free-model/catalog.json` → `kiloRows`
 * (vision, contextWindow, maxOutput) plus nama tampilan resminya.
 *
 * Catatan `max_output_tokens`: gateway membatasi output sungguhan dengan
 * `Math.min(entry.maxOutput, settings.defaultMaxTokens ?? 32768)`
 * (lihat src/adapter.js). Jadi nilai yang ditulis ke Zed adalah batas efektif
 * itu, bukan angka katalog mentah — supaya Zed tidak menjanjikan output yang
 * tetap dipotong di sisi gateway.
 *
 * Pemakaian:
 *   node scripts/ofm-zed-add-models.mjs                 # uji (dry-run)
 *   node scripts/ofm-zed-add-models.mjs --write         # tulis + backup
 *   node scripts/ofm-zed-add-models.mjs --write <id...> # hanya id tertentu
 *   node scripts/ofm-zed-add-models.mjs --write --temporary <id...>
 *     # tandai entri dengan sufiks "· sementara" di display_name. Skema Zed
 *     # tidak punya field `temporary`, jadi penandanya adalah nama tampilan.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SETTINGS = path.join(os.homedir(), 'AppData', 'Roaming', 'Zed', 'settings.json');
const OFM_SETTINGS = path.join(os.homedir(), '.our-free-model', 'settings.json');
const CATALOG = path.join(os.homedir(), '.our-free-model', 'catalog.json');

const PROVIDER = 'Our-Free-Local';
const WRITE = process.argv.includes('--write');
const TEMPORARY = process.argv.includes('--temporary');
/** Sufiks penanda untuk model yang kuotanya bisa habis (mis. free tier OpenCode). */
const TEMP_SUFFIX = ' · sementara';

/** Id yang diiklankan gateway pada sesi 15h (semua sudah diprobe hidup). */
const DEFAULT_IDS = [
  'kilo-auto/free',
  'nvidia/nemotron-3.5-super-vl:free',
  'reflection/beam-free',
  'stealth/glyph-cluster',
  'xingchen-agi/xing4.0-29b-a4b:free',
  'dots-studio/dots-3-note-preview:free',
  'liquid/lfm-2.5-2.6b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'cohere/north-mini-code:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'openrouter/free',
  'open_router/cohere/north-mini-code:free',
  'open_router/dots-studio/dots-3-note-preview:free',
  'open_router/nvidia/nemotron-3.5-lightning:free',
  'open_router/xingchen-agi/xing4.0-29b-a4b:free',
  'gemini/gemini-3.8-flash',
];

/**
 * Id yang tidak ada di kiloRows. Nilai diambil dari `src/catalog.js` →
 * `FREE_ID_OVERRIDES` (vision/contextWindow) agar tidak menebak.
 */
const EXTRA = {
  'gemini/gemini-3.8-flash': { name: 'Gemini 3.8 Flash', vision: true, contextWindow: 1000000 },
  'big-pickle': { name: 'Big Pickle', vision: true, contextWindow: 262144 },
  'deepseek-v4.1-flash-free': { name: 'DeepSeek V4.1 Flash (free)', vision: true, contextWindow: 1048576 },
  'glm-5.3-flash-free': { name: 'GLM 5.3 Flash (free)', vision: true, contextWindow: 1048576 },
};

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);

function fail(msg) {
  console.error('GAGAL:', msg);
  process.exit(1);
}

/** Cari indeks penutup yang berpasangan dengan pembuka di `open`. */
function findMatching(text, open, opener, closer) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === QUOTE) inString = false;
      continue;
    }
    if (ch === QUOTE) {
      inString = true;
      continue;
    }
    if (ch === opener) depth++;
    else if (ch === closer) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Pecah isi array menjadi objek top-level { ... }. */
function splitObjects(arrayText) {
  const objects = [];
  let i = 0;
  while (i < arrayText.length) {
    if (arrayText[i] === '{') {
      const end = findMatching(arrayText, i, '{', '}');
      if (end < 0) fail('objek tidak tertutup di dalam available_models');
      objects.push(arrayText.slice(i, end + 1));
      i = end + 1;
    } else {
      i++;
    }
  }
  return objects;
}

/** Buang komentar // di luar string, lalu parse JSON. */
function parseWithComments(text) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === BACKSLASH) escaped = true;
      else if (ch === QUOTE) inString = false;
      continue;
    }
    if (ch === QUOTE) {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    out += ch;
  }
  return JSON.parse(out);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`${label} tidak terbaca: ${err.message}`);
  }
}

// ---- kapabilitas acuan -----------------------------------------------------

const catalog = readJson(CATALOG, 'catalog.json');
const kiloRows = catalog.kiloRows ?? [];
const rows = Array.isArray(kiloRows)
  ? kiloRows
  : Object.entries(kiloRows).map(([id, value]) => ({ id, ...value }));
const byId = new Map();
for (const row of rows) {
  const id = row.id ?? row.model;
  if (typeof id === 'string') byId.set(id, row);
}

const ofmSettings = readJson(OFM_SETTINGS, 'settings OFM');
const gatewayCeiling = Number.isFinite(ofmSettings.defaultMaxTokens)
  ? ofmSettings.defaultMaxTokens
  : 32768;

/** Baris katalog untuk sebuah id, termasuk id berprefiks `open_router/`. */
function capsFor(id) {
  const base = id.startsWith('open_router/') ? id.slice('open_router/'.length) : id;
  const row = byId.get(base);
  if (row) {
    return {
      name: String(row.name ?? id),
      vision: row.vision === true,
      contextWindow: Number.isFinite(row.contextWindow) ? row.contextWindow : 131072,
      maxOutput: Number.isFinite(row.maxOutput) ? row.maxOutput : 32768,
    };
  }
  const extra = EXTRA[id] ?? EXTRA[base];
  if (extra) {
    return {
      name: extra.name,
      vision: extra.vision === true,
      contextWindow: extra.contextWindow ?? 131072,
      maxOutput: gatewayCeiling,
    };
  }
  return null;
}

// ---- target ----------------------------------------------------------------

const argvIds = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const targetIds = argvIds.length > 0 ? argvIds : DEFAULT_IDS;

const desired = [];
for (const id of targetIds) {
  const caps = capsFor(id);
  if (!caps) fail(`kapabilitas untuk "${id}" tidak ada di catalog.json maupun EXTRA`);
  desired.push({
    id,
    name: TEMPORARY ? caps.name + TEMP_SUFFIX : caps.name,
    vision: caps.vision,
    contextWindow: caps.contextWindow,
    maxOutput: Math.min(caps.maxOutput, gatewayCeiling),
  });
}

// ---- bedah settings --------------------------------------------------------

const raw = fs.readFileSync(SETTINGS, 'utf8');

const providerDef = QUOTE + PROVIDER + QUOTE + ':';
const providerAt = raw.indexOf(providerDef);
if (providerAt < 0) fail(`penyedia "${PROVIDER}" tidak ditemukan`);
if (raw.indexOf(providerDef, providerAt + 1) >= 0) {
  fail(`penyedia "${PROVIDER}" muncul lebih dari sekali`);
}

const modelsKey = raw.indexOf(QUOTE + 'available_models' + QUOTE, providerAt);
if (modelsKey < 0) fail('"available_models" tidak ditemukan di penyedia');
const open = raw.indexOf('[', modelsKey);
if (open < 0) fail('array available_models tidak ditemukan');
const close = findMatching(raw, open, '[', ']');
if (close < 0) fail('array available_models tidak tertutup');

const arrayText = raw.slice(open + 1, close);
const objects = splitObjects(arrayText);
const existing = new Map();
for (const text of objects) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('objek model bukan JSON valid: ' + text.slice(0, 80));
  }
  existing.set(parsed.name, { text, parsed });
}

/** EOL mayoritas di dalam array; blok ini tidak memuat komentar, jadi aman
dinormalkan supaya hasil edit tidak menambah EOL campur. */
const NL = (() => {
  const crlf = (arrayText.match(/\r\n/g) ?? []).length;
  const total = (arrayText.match(/\n/g) ?? []).length;
  return crlf * 2 >= total ? '\r\n' : '\n';
})();

const entryText = (m) =>
  '          {' + NL +
  `            "name": ${JSON.stringify(m.id)},` + NL +
  `            "display_name": ${JSON.stringify(m.name)},` + NL +
  `            "max_tokens": ${m.contextWindow},` + NL +
  `            "max_output_tokens": ${m.maxOutput},` + NL +
  '            "capabilities": {' + NL +
  '              "tools": true,' + NL +
  `              "images": ${m.vision},` + NL +
  '              "parallel_tool_calls": true,' + NL +
  '              "prompt_cache_key": false,' + NL +
  '              "chat_completions": true,' + NL +
  '              "interleaved_reasoning": false,' + NL +
  '              "max_tokens_parameter": true' + NL +
  '            }' + NL +
  '          }';

const added = [];
const updated = [];

// Pertahankan urutan lama, perbaiki flag `images` bila meleset dari katalog.
const rebuilt = objects.map((text) => {
  const parsed = JSON.parse(text);
  const caps = capsFor(parsed.name);
  if (!caps) return text;
  const want = caps.vision;
  const current = parsed?.capabilities?.images;
  if (current === want) return text;
  updated.push({ name: parsed.name, from: current, to: want });
  return text.replace(/("images"\s*:\s*)(true|false)/, `$1${want}`);
});

// Tambahkan yang belum ada.
for (const m of desired) {
  if (existing.has(m.id)) continue;
  rebuilt.push(entryText(m));
  added.push(m);
}

const normalizeNeeded = rebuilt.some((text) => text.replace(/\r?\n/g, NL) !== text);

if (added.length === 0 && updated.length === 0 && !normalizeNeeded) {
  console.log('Tidak ada perubahan: semua model target sudah ada dan flag images sudah benar.');
  process.exit(0);
}

const normalized = rebuilt.map((text) => text.replace(/\r?\n/g, NL));
const body = NL + normalized.map((text) => '          ' + text).join(',' + NL) + NL + '        ';
const next = raw.slice(0, open + 1) + body + raw.slice(close);

// ---- validasi penuh sebelum menyentuh disk --------------------------------

let parsed;
try {
  parsed = parseWithComments(next);
} catch (err) {
  fail('hasil edit bukan JSON valid: ' + err.message);
}

const got = parsed?.language_models?.openai_compatible?.[PROVIDER]?.available_models;
if (!Array.isArray(got) || got.length !== rebuilt.length) {
  fail('jumlah model pada hasil parse tidak cocok');
}
if (!next.startsWith('//') || !next.includes('// Zed settings')) {
  fail('komentar kepala settings hilang');
}
{
  const nextArray = next.slice(open + 1, findMatching(next, open, '[', ']'));
  const crlf = (nextArray.match(/\r\n/g) ?? []).length;
  const lf = (nextArray.match(/\n/g) ?? []).length;
  if (crlf !== 0 && crlf !== lf) fail('EOL di dalam array masih campur');
}
const seen = new Set();
for (const m of got) {
  if (seen.has(m.name)) fail('nama model duplikat: ' + m.name);
  seen.add(m.name);
  const caps = capsFor(m.name);
  if (caps && m?.capabilities?.images !== caps.vision) {
    fail(`flag images "${m.name}" tidak sesuai katalog`);
  }
}
for (const m of desired) {
  if (!seen.has(m.id)) fail(`model target tidak masuk hasil: ${m.id}`);
}

console.log('File        :', SETTINGS);
console.log('Ukuran      :', raw.length, '->', next.length, 'byte');
console.log('Entri       :', objects.length, '->', got.length);
console.log('Ditambah    :', added.length);
for (const m of added) {
  console.log(`  + ${m.id}  (${m.contextWindow} ctx, out ${m.maxOutput}, vision ${m.vision})`);
}
console.log('Flag images diperbaiki:', updated.length);
for (const u of updated) console.log(`  ~ ${u.name}: ${u.from} -> ${u.to}`);
if (normalizeNeeded) console.log('EOL array dinormalkan ke', JSON.stringify(NL));

if (!WRITE) {
  console.log('\nMode uji. Jalankan dengan --write untuk menulis.');
  process.exit(0);
}

let backup = SETTINGS + '.bak-ofm-2';
let n = 2;
while (fs.existsSync(backup)) backup = SETTINGS + '.bak-ofm-' + ++n;
fs.copyFileSync(SETTINGS, backup);
fs.writeFileSync(SETTINGS, next, 'utf8');

console.log('\nBackup      :', backup);
console.log('Tertulis    :', fs.statSync(SETTINGS).size, 'byte');
