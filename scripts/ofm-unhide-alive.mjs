#!/usr/bin/env node
// Mengeluarkan id tertentu dari hiddenModelIds lewat API manajemen.
//
// Berbeda dari ofm-hide-dead-models.mjs yang membaca /v1/models (sudah
// tersaring sehingga id tersembunyi tidak terlihat), skrip ini menyunting
// daftar sembunyi secara bedah: hanya id yang disebut yang dilepas.
//
// Pemakaian:
//   node scripts/ofm-unhide-alive.mjs <id> [<id> ...]            # dry-run
//   node scripts/ofm-unhide-alive.mjs --write <id> [<id> ...]
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = process.env.OFM_DATA_DIR || path.join(os.homedir(), '.our-free-model')
const SETTINGS_PATH = path.join(DATA_DIR, 'settings.json')
const write = process.argv.includes('--write')
const ids = process.argv.slice(2).filter(arg => arg !== '--write')

if (ids.length === 0) {
  console.error('pemakaian: node scripts/ofm-unhide-alive.mjs [--write] <id> [<id> ...]')
  process.exit(1)
}

const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'))
const key = settings.forwardKey
if (typeof key !== 'string' || key === '') {
  throw new Error(`forwardKey tidak ditemukan di ${SETTINGS_PATH}`)
}
const base = `http://127.0.0.1:${Number(settings.standalonePort) || 18900}`
const auth = { authorization: `Bearer ${key}` }

const before = Array.isArray(settings.hiddenModelIds) ? settings.hiddenModelIds : []
const next = before.filter(id => !ids.includes(id))
const released = before.filter(id => ids.includes(id))
const absent = ids.filter(id => !before.includes(id))

console.log(`tersembunyi sebelum : ${before.length}`)
console.log(`dilepas             : ${released.length} -> ${released.join(', ') || '(tidak ada)'}`)
if (absent.length > 0) console.log(`tidak ada di daftar  : ${absent.join(', ')}`)
console.log(`tersembunyi sesudah : ${next.length}`)

if (!write) {
  console.log('\n(dry-run) tambahkan --write untuk menerapkan')
  process.exit(0)
}

const res = await fetch(`${base}/api/management/settings`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ hiddenModelIds: next }),
})
if (!res.ok) {
  throw new Error(`POST /api/management/settings -> HTTP ${res.status} ${await res.text()}`)
}

const listed = await fetch(`${base}/v1/models`, { headers: auth })
const body = await listed.json()
const visible = (Array.isArray(body.data) ? body.data : []).map(row => row.id)
console.log(`\nmodel diiklankan sekarang: ${visible.length}`)
console.log(visible.join('\n'))
