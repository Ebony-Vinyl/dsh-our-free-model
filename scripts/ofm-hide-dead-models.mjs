#!/usr/bin/env node
// Menyembunyikan model mati dari daftar /v1/models.
//
// KEEP berisi id yang sudah diverifikasi merespons 200 lewat gateway. Id lain
// yang masih diiklankan akan ditambahkan ke hiddenModelIds.
//
// PENTING: /v1/models hanya memuat model yang SUDAH lolos filter, jadi listing
// itu tidak boleh dipakai sebagai satu-satunya sumber. Daftar sembunyi yang ada
// di settings ikut digabung, supaya id yang sudah tersembunyi tidak pernah
// hilang hanya karena ia tidak muncul di listing.
//
// Penyembunyian ini reversibel: katalog tidak diubah, jadi cukup buang id dari
// hiddenModelIds (lihat ofm-unhide-alive.mjs) untuk memunculkannya lagi.
//
// Pemakaian:
//   node scripts/ofm-hide-dead-models.mjs            # dry-run
//   node scripts/ofm-hide-dead-models.mjs --write    # terapkan
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const KEEP = [
  // Lane utama (gratis, tanpa channel)
  'nvidia/nemotron-3.5-super-vl:free',
  'nvidia/nemotron-3.5-lightning:free',
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'poolside/laguna-s-2.1:free',
  'poolside/laguna-xs-2.1:free',
  'liquid/lfm-2.5-2.6b:free',
  'stealth/glyph-cluster',
  'reflection/beam-free',
  'xingchen-agi/xing4.0-29b-a4b:free',
  'dots-studio/dots-3-note-preview:free',
  'cohere/north-mini-code:free',
  'kilo-auto/free',
  // Channel relay
  'open_router/cohere/north-mini-code:free',
  'open_router/dots-studio/dots-3-note-preview:free',
  'open_router/nvidia/nemotron-3.5-lightning:free',
  'open_router/xingchen-agi/xing4.0-29b-a4b:free',
  'openrouter/free',
  'gemini/gemini-3.8-flash',
]

const DATA_DIR = process.env.OFM_DATA_DIR || path.join(os.homedir(), '.our-free-model')
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json')
const write = process.argv.includes('--write')

const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
const key = settings.forwardKey
if (typeof key !== 'string' || key === '') {
  throw new Error(`forwardKey tidak ditemukan di ${SETTINGS_PATH}`)
}
const base = `http://127.0.0.1:${Number(settings.standalonePort) || 18900}`

async function listModels() {
  const res = await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
  if (!res.ok) throw new Error(`GET /v1/models -> HTTP ${res.status}`)
  const body = await res.json()
  return (Array.isArray(body.data) ? body.data : []).map(row => row.id)
}

const advertised = await listModels()
const existingHidden = Array.isArray(settings.hiddenModelIds) ? settings.hiddenModelIds : []

// Gabungan: id yang tampil sekarang + id yang sudah tersembunyi. Tanpa langkah
// ini, id tersembunyi yang tidak muncul di listing akan terhapus dari daftar.
const universe = [...new Set([...advertised, ...existingHidden])]
const hidden = universe.filter(id => !KEEP.includes(id)).sort()
const shown = universe.filter(id => KEEP.includes(id))
const missing = KEEP.filter(id => !advertised.includes(id))
const added = hidden.filter(id => !existingHidden.includes(id))
const removed = existingHidden.filter(id => !hidden.includes(id))

console.log(`model diiklankan   : ${advertised.length}`)
console.log(`tersembunyi sekarang: ${existingHidden.length}`)
console.log(`dipertahankan      : ${shown.length}`)
console.log(`akan tersembunyi   : ${hidden.length}`)
if (added.length > 0) console.log(`  + baru disembunyikan: ${added.join(', ')}`)
if (removed.length > 0) console.log(`  - dilepas           : ${removed.join(', ')}`)
if (missing.length > 0) console.log(`PERINGATAN: id KEEP tidak sedang diiklankan -> ${missing.join(', ')}`)

if (!write) {
  console.log('\n(dry-run) tambahkan --write untuk menerapkan')
  process.exit(0)
}

// Pengaman: daftar kosong padahal sebelumnya ada isinya berarti listing dan
// settings tidak sinkron. Jangan menulis apa pun.
if (hidden.length === 0 && existingHidden.length > 0) {
  throw new Error('hasil kosong padahal ada id tersembunyi sebelumnya; dibatalkan')
}

const res = await fetch(`${base}/api/management/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
  body: JSON.stringify({ hiddenModelIds: hidden }),
})
if (!res.ok) {
  throw new Error(`POST /api/management/settings -> HTTP ${res.status} ${await res.text()}`)
}

const after = await listModels()
console.log(`\nsesudah: ${after.length} model`)
console.log(after.join('\n'))
