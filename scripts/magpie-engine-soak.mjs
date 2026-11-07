/**
 * Real-machine acceptance: the rebuilt engine must leave every real agent
 * file alone (the 2026-11-07 ZCode wipe).
 *
 * What it does, on this machine, with the real vendored binary:
 *   1. snapshots the wired ZCode files the user actually runs on
 *      (config.json + provider_config.json, wherever dataBaseDir points);
 *   2. boots the engine exactly the way the plugin does (a scratch data dir,
 *      the wrapper's own boot path);
 *   3. holds the run past the startup-sync window the incident showed
 *      (55–70 s), then tears the engine down;
 *   4. asserts the ZCode files are byte-for-byte what they were, and that the
 *      engine's private agent-home exists.
 *
 * No DSH restart needed: the engine is booted the same way the plugin boots
 * it, and the files it must not touch are the user's real ones.
 *
 * Run: node scripts/magpie-engine-soak.mjs
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const homeMarker = path.join(os.homedir(), '.zcode', 'v2', 'setting.json')
// The user may have moved ZCode's data dir (dataBaseDir in the marker).
let zcodeDir = path.join(os.homedir(), '.zcode', 'v2')
try {
  const marker = JSON.parse(fs.readFileSync(homeMarker, 'utf8'))
  if (typeof marker?.dataBaseDir === 'string' && marker.dataBaseDir !== '') {
    zcodeDir = path.join(marker.dataBaseDir, '.zcode', 'v2')
  }
} catch { /* no marker — the default home stands */ }

const files = [
  path.join(zcodeDir, 'config.json'),
  path.join(zcodeDir, 'provider_config.json'),
]

const snapshot = new Map()
for (const file of files) {
  try {
    snapshot.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    snapshot.set(file, null) // absent before and after, or absent throughout
  }
}
console.log(`soak: watching ${snapshot.size} ZCode file(s) under ${zcodeDir}`)

const { createMagpieEngine } = await import(pathToFileURL(path.join(root, 'src', 'magpie-engine.js')).href)
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-engine-soak-'))
const engine = createMagpieEngine({ dataDir, logger: { info: (...a) => console.log('engine:', ...a), warn: (...a) => console.log('engine-warn:', ...a) } })
const status = await engine.start()
if (status.state !== 'ready') throw new Error(`the engine did not start: ${status.state} ${status.error ?? ''}`)
console.log(`soak: engine ready (gateway ${engine.gateway().url ?? ''}) — holding 80 s past the startup-sync window`)

await new Promise(resolve => setTimeout(resolve, 80_000))
await engine.close()

let failures = 0
for (const [file, before] of snapshot) {
  let after
  try { after = createHash('sha256').update(fs.readFileSync(file)).digest('hex') } catch (error) { after = error.code === 'ENOENT' ? null : 'unreadable' }
  const ok = after === before
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${path.basename(file)} ${ok ? 'unchanged' : `changed (was ${before}, now ${after})`}`)
}
const agentHome = path.join(dataDir, 'magpie', 'agent-home')
const homeOk = fs.existsSync(agentHome)
if (!homeOk) failures += 1
console.log(`${homeOk ? 'ok  ' : 'FAIL'} the engine's private agent-home exists (${agentHome})`)

try { fs.rmSync(dataDir, { recursive: true, force: true }) } catch { /* a locked temp dir is the OS's problem */ }
console.log('')
if (failures === 0) console.log('all soak checks passed — the engine left every real agent file untouched')
else { console.log(`${failures} soak check(s) failed`); process.exit(1) }
