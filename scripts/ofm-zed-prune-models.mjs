#!/usr/bin/env node
/**
 * Membersihkan daftar `available_models` milik penyedia "Our-Free-Local"
 * di settings Zed tanpa mengubah byte lain (komentar //, EOL, indentasi).
 *
 * Hanya entri yang benar-benar hidup yang dipertahankan:
 *   - id berawalan `open_router/` (lane agregat)
 *   - id pada allowlist yang sudah diuji 200 + tool_calls
 *
 * Pemakaian:
 *   node scripts/ofm-zed-prune-models.mjs            # uji (dry-run)
 *   node scripts/ofm-zed-prune-models.mjs --write    # tulis + backup
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SETTINGS = path.join(
  os.homedir(),
  'AppData',
  'Roaming',
  'Zed',
  'settings.json'
);

const PROVIDER = 'Our-Free-Local';
const KEEP_PREFIX = 'open_router/';
const KEEP_EXACT = new Set([
  'openrouter/free',
  'gemini/gemini-3.8-flash',
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
  // Model OpenCode yang dipulihkan sementara (kuota free tier bisa habis).
  // Dicabut dari sini bila probe ulang membuktikan mati.
  'big-pickle',
  'deepseek-v4.1-flash-free',
  'glm-5.3-flash-free',
]);
const WRITE = process.argv.includes('--write');

const BACKSLASH = String.fromCharCode(92);
const QUOTE = String.fromCharCode(34);

function fail(msg) {
  console.error('GAGAL:', msg);
  process.exit(1);
}

/** Cari indeks ']' yang berpasangan dengan '[' di `open`. */
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
    const ch = arrayText[i];
    if (ch === '{') {
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

function nameOf(objectText) {
  try {
    return JSON.parse(objectText).name;
  } catch {
    fail('objek model bukan JSON valid: ' + objectText.slice(0, 80));
  }
}

function keep(name) {
  return name.startsWith(KEEP_PREFIX) || KEEP_EXACT.has(name);
}

const raw = fs.readFileSync(SETTINGS, 'utf8');

const providerDef = QUOTE + PROVIDER + QUOTE + ':';
const providerAt = raw.indexOf(providerDef);
if (providerAt < 0) fail(`penyedia "${PROVIDER}" tidak ditemukan`);
if (raw.indexOf(providerDef, providerAt + 1) >= 0) {
  fail(`penyedia "${PROVIDER}" muncul lebih dari sekali`);
}

const modelsKey = raw.indexOf('"available_models"', providerAt);
if (modelsKey < 0) fail('"available_models" tidak ditemukan di penyedia');
const open = raw.indexOf('[', modelsKey);
if (open < 0) fail('array available_models tidak ditemukan');
const close = findMatching(raw, open, '[', ']');
if (close < 0) fail('array available_models tidak tertutup');

const arrayText = raw.slice(open + 1, close);
const objects = splitObjects(arrayText);
const names = objects.map(nameOf);
const kept = [];
const removed = [];

for (let i = 0; i < objects.length; i++) {
  (keep(names[i]) ? kept : removed).push({ name: names[i], text: objects[i] });
}

const rebuilt =
  '\n' +
  kept.map((o) => '          ' + o.text).join(',\n') +
  '\n        ';

const next = raw.slice(0, open + 1) + rebuilt + raw.slice(close);

// Validasi penuh sebelum menyentuh disk.
let parsed;
try {
  parsed = parseWithComments(next);
} catch (err) {
  fail('hasil edit bukan JSON valid: ' + err.message);
}
const got = parsed?.language_models?.openai_compatible?.[PROVIDER]?.available_models;
if (!Array.isArray(got) || got.length !== kept.length) {
  fail('jumlah model pada hasil parse tidak cocok');
}

const headerIntact = next.startsWith('//') && next.includes('// Zed settings');
if (!headerIntact) fail('komentar kepala settings hilang');

console.log('File        :', SETTINGS);
console.log('Ukuran      :', raw.length, '->', next.length, 'byte');
console.log('Entri       :', objects.length, '->', kept.length);
console.log('Dihapus     :', removed.length);
for (const r of removed) console.log('  - hapus   :', r.name);
console.log('Dipertahankan:');
for (const k of kept) console.log('  + simpan  :', k.name);

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
