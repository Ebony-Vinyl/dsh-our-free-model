/**
 * Real-machine verification of the extension marketplace, against the live
 * signed registry.
 *
 * `scripts/extensions-test.mjs` proves the platform against a loopback fixture:
 * a fixture agrees with whatever the code already believes. This harness asks
 * the one question a fixture cannot answer — does the marketplace work against
 * the real `Ebony-Vinyl/ofm-extensions` registry, on this machine, right now:
 *
 *   - the live registry refresh walks the real mirrors (raw → jsDelivr → proxy)
 *     and the pinned Ed25519 key verifies the real signature;
 *   - a channel extension downloads from the real mirror, passes the digest
 *     check, starts in its sandbox and merges its models into the catalog;
 *   - an enhancement installs disabled, enables, receives a saved config value
 *     across a real restart, and uninstalls clean;
 *   - the marketplace state (installed rows, registry flags, model counts) reads
 *     back coherently after every mutation.
 *
 * No chat turns are spent: every check is listing, install and config traffic.
 * The registry mirror list is the only external touch.
 *
 * Run: node scripts/extensions-live-verify.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'
// The keyless producers stay pinned shut: this run exercises the marketplace,
// not the free lanes, and nothing here should reach a model gateway.
process.env.OUR_FREE_MODEL_BASE = process.env.OUR_FREE_MODEL_BASE ?? 'http://127.0.0.1:1'
process.env.OUR_FREE_MODEL_KILO_BASE = process.env.OUR_FREE_MODEL_KILO_BASE ?? 'http://127.0.0.1:2'

// Imported dynamically, not statically: ESM hoists every `import` above the
// statements in this file, so a static import would let the helper run — and
// pin its closed-loopback registry — before the two assignments above.
const { callRoute, fakeContext, until } = await import('./lib/fake-kernel.mjs')

// The helper pins an unset OFM_EXTENSIONS_REGISTRY to a dead loopback port so
// offline suites never reach GitHub. This is the live run — that pin is the one
// thing it must undo, and the runtime re-reads the variable on every refresh.
delete process.env.OFM_EXTENSIONS_REGISTRY

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)?.slice(0, 300)}\n       expected ${JSON.stringify(expected)?.slice(0, 300)}`}`)
}
const section = title => console.log(`\n=== ${title} ===`)

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-ext-live-'))
process.env.DSH_HOME = home

const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'timer'], onRegister: route => routes.push(route) })
apply(ctx, {})
const api = () => routes.find(route => route.kind === 'prefix')?.handler
await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })
const call = (method, url, body) => callRoute(api(), method, url, body)
const read = payload => payload.json ?? JSON.parse(payload.raw ?? '{}')

section('1. the live signed registry loads through the real mirrors')
{
  const payload = read(await call('GET', '/extensions', undefined))
  check('the registry loads (signature verified against the pinned key)', payload.registry === null || payload.registry === undefined ? false : true, true)
  const ids = (payload.registry?.plugins ?? []).map(plugin => plugin.id)
  console.log(`     index: ${ids.join(', ')}`)
  check('the index carries at least the two built-in channels', ids.includes('kilo-free') && ids.includes('openai-compatible'), true)
}

section('2. a channel installs from the live mirror and joins the catalog')
{
  const install = read(await call('POST', '/extensions/install', { id: 'kilo-free' }))
  const record = install.record
  check('the install record is ready', record === undefined ? false : [record.id, record.enabled, record.state], ['kilo-free', true, 'ready'])
  const view = read(await call('GET', '/extensions', undefined))
  const registryRow = view.registry?.plugins?.find(plugin => plugin.id === 'kilo-free')
  check('the registry row flips to installed with no pending update', registryRow === undefined ? false : [registryRow.installed, registryRow.updateAvailable, registryRow.enabled], [true, false, true])
  const summary = read(await call('GET', '/summary', undefined))
  const kiloRows = (summary.catalog ?? []).filter(row => row.channel === 'extension')
  check('the extension channel contributes models to the catalog', kiloRows.length > 0, true)
  console.log(`     catalog rows from extensions: ${kiloRows.length} (ids like ${kiloRows.slice(0, 3).map(row => row.id).join(', ')})`)
}

section('3. an enhancement installs disabled, enables, and survives a config restart')
{
  const install = read(await call('POST', '/extensions/install', { id: 'param-override' }))
  const record = install.record
  check('the enhancement installs disabled by default', record === undefined ? false : [record.enabled, record.state], [false, 'stopped'])

  const enabled = read(await call('POST', '/extensions/toggle', { id: 'param-override', enabled: true }))
  check('the toggle enables and starts it', enabled.record === undefined ? false : [enabled.record.enabled, enabled.record.state], [true, 'ready'])

  const saved = read(await call('POST', '/extensions/config', { id: 'param-override', values: { maxTokens: 4096 } }))
  check('the saved config reads back', saved.record?.values?.maxTokens, 4096)
  check('the config restart left it ready', saved.record?.state, 'ready')

  const view = read(await call('GET', '/extensions', undefined))
  const row = view.registry?.plugins?.find(plugin => plugin.id === 'param-override')
  check('the registry row reflects enabled state', row === undefined ? false : [row.installed, row.enabled], [true, true])
}

section('4. uninstall tears both down and the state reads clean')
{
  const after = read(await call('POST', '/extensions/uninstall', { id: 'param-override' }))
  check('the enhancement is gone from the installed rows', (after.installed ?? []).some(row => row.id === 'param-override'), false)
  const kiloGone = read(await call('POST', '/extensions/uninstall', { id: 'kilo-free' }))
  check('the channel is gone too', (kiloGone.installed ?? []).length, 0)
  const view = read(await call('GET', '/extensions', undefined))
  const row = view.registry?.plugins?.find(plugin => plugin.id === 'kilo-free')
  check('its registry row offers Install again', row === undefined ? false : [row.installed, row.updateAvailable], [false, false])
}

for (const dispose of ctx.__disposers ?? []) { try { dispose() } catch { /* teardown is best effort */ } }
try { fs.rmSync(home, { recursive: true, force: true }) } catch { /* a locked temp dir is the OS's problem */ }

console.log('')
if (failures === 0) console.log('all live extension checks passed')
else { console.log(`${failures} live check(s) failed`); process.exit(1) }
