/**
 * Regression coverage for issue #761: the hot-reload toast must be ack'd on the
 * server, not only in the browser's origin-scoped localStorage.
 *
 * The suite pins three behaviours:
 *   1. a POST ack persists `reloadNoticeSeen`, and /meta reports it;
 *   2. a new origin with no localStorage does not replay an acknowledged notice;
 *   3. a genuinely new `reloadedAt` still shows once, then stops after its ack.
 *   4. a failed ack is retried from the same origin without another toast.
 * It also boots the plugin once with a legacy settings file and pins the
 * generation-1 adoption rule from index.js.
 *
 * Run: node scripts/reload-notice-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'
import { JsonStore, SETTINGS_INITIAL } from '../src/store.js'

let checks = 0
const ok = name => { checks += 1; console.log(`ok ${checks} ${name}`) }

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-reload-notice-'))
process.env.DSH_HOME = scratch

// fake-kernel pins the network to closed loopback ports before this import, so
// even the full boot below cannot reach the real gateway.
const { apply, inject, createApiRoutes } = await import('../index.js')

function loadClientTest() {
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  let record
  const window = { __ModuleLoader__: { load: value => { record = value } } }
  const document = {
    createElement: () => ({ setAttribute() {}, style: {}, remove() {} }),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
    execCommand: () => true,
  }
  const navigator = { language: 'zh-CN' }
  new Function('window', 'document', 'navigator', source)(window, document, navigator)
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'fragment',
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: factory => factory(),
    useRef: () => ({ current: null }),
    useCallback: fn => fn,
  }
  return record.factory(name => {
    if (name === 'react') return react
    if (name === 'react-dom') return { createPortal: (children, container) => ({ type: 'portal', children, container }) }
    throw new Error(`unexpected client dependency: ${name}`)
  }).__test
}

const { reloadNoticePlan, announceReloadNotice } = loadClientTest()
assert.equal(typeof reloadNoticePlan, 'function')
assert.equal(typeof announceReloadNotice, 'function')

assert.equal(SETTINGS_INITIAL.reloadNoticeSeen, 0)
ok('settings default acknowledges nothing')

// ── ack route + client decision ─────────────────────────────────────────────
const dataDir = path.join(scratch, 'api')
fs.mkdirSync(dataDir, { recursive: true })
const settingsFile = path.join(dataDir, 'settings.json')
const firstAt = 1_700_000_000_000
fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, enabled: true, reloadedAt: firstAt, reloadCount: 2 }))
const settings = new JsonStore(settingsFile, structuredClone(SETTINGS_INITIAL))
const handler = createApiRoutes({
  settings,
  meta: () => ({
    version: 'test',
    generation: 1,
    reloadedAt: settings.get().reloadedAt ?? 0,
    reloadCount: settings.get().reloadCount ?? 0,
    reloadNoticeSeen: settings.get().reloadNoticeSeen ?? 0,
  }),
  announcements: { view: () => ({ items: [], unread: 0, fetchedAt: 0, source: '', error: '' }) },
  update: { status: () => ({}) },
})
const route = (method, suffix, body) => callRoute(handler, method, `/api/our-free-model${suffix}`, body)
const meta = async () => (await route('GET', '/meta')).json

const legacyMeta = await meta()
assert.deepEqual([legacyMeta.reloadedAt, legacyMeta.reloadNoticeSeen], [firstAt, 0])

const firstView = { shows: 0, remembers: [], acks: [], status: 0 }
const first = await announceReloadNotice(legacyMeta, '', {
  show: () => { firstView.shows += 1 },
  remember: at => { firstView.remembers.push(at) },
  ack: async at => {
    firstView.acks.push(at)
    firstView.status = (await route('POST', '/reload-notice/ack', { at })).status
  },
})
assert.deepEqual(first, { at: firstAt, show: true, shown: true })
assert.deepEqual([firstView.shows, firstView.remembers, firstView.acks, firstView.status], [1, [firstAt], [firstAt], 200])
assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).reloadNoticeSeen, firstAt)
const acknowledged = await meta()
assert.equal(acknowledged.reloadNoticeSeen, firstAt)
const reopened = { shows: 0, acks: 0 }
const second = await announceReloadNotice(acknowledged, '', {
  show: () => { reopened.shows += 1 },
  remember: () => {},
  ack: async () => { reopened.acks += 1 },
})
assert.deepEqual(second, { at: firstAt, show: false, shown: false })
assert.deepEqual([reopened.shows, reopened.acks], [0, 0], 'a different origin with no localStorage must not replay an acknowledged notice')
assert.equal(reloadNoticePlan(acknowledged, null).show, false)
assert.equal(reloadNoticePlan(acknowledged, String(firstAt)).show, false)
ok('showing acknowledges on the server, and a new origin stays quiet')

for (const body of [{}, { at: String(firstAt) }, { at: 0 }, { at: firstAt + 1 }, { at: 1.5 }]) {
  assert.equal((await route('POST', '/reload-notice/ack', body)).status, 400, JSON.stringify(body))
}
assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).reloadNoticeSeen, firstAt, 'a rejected ack never writes')
ok('ack validates at and refuses another generation\'s timestamp')

const nextAt = firstAt + 5_000
settings.update({ reloadedAt: nextAt, reloadCount: 3 })
settings.flush()
const freshMeta = await meta()
assert.equal(freshMeta.reloadNoticeSeen, firstAt)
const shown = reloadNoticePlan(freshMeta, '')
assert.deepEqual(shown, { at: nextAt, show: true }, 'a genuinely new reload is announced in a fresh origin')
assert.equal(reloadNoticePlan(freshMeta, String(nextAt)).show, false, 'localStorage remains a same-origin fast path')
const cachedView = { shows: 0, acks: 0 }
const cached = await announceReloadNotice(freshMeta, String(nextAt), {
  show: () => { cachedView.shows += 1 },
  remember: () => {},
  ack: async () => { cachedView.acks += 1 },
})
assert.deepEqual(cached, { at: nextAt, show: false, shown: false })
assert.deepEqual([cachedView.shows, cachedView.acks], [0, 1], 'the cache suppresses the toast but must not suppress a missing server ack')
const freshView = { shows: 0, acks: [], status: 0 }
const fresh = await announceReloadNotice(freshMeta, '', {
  show: () => { freshView.shows += 1 },
  remember: () => {},
  ack: async at => {
    freshView.acks.push(at)
    freshView.status = (await route('POST', '/reload-notice/ack', { at })).status
  },
})
assert.deepEqual(fresh, { at: nextAt, show: true, shown: true })
assert.deepEqual([freshView.shows, freshView.acks, freshView.status], [1, [nextAt], 200])
const repeated = { shows: 0, acks: 0 }
const third = await announceReloadNotice(await meta(), '', {
  show: () => { repeated.shows += 1 },
  remember: () => {},
  ack: async () => { repeated.acks += 1 },
})
assert.deepEqual(third, { at: nextAt, show: false, shown: false })
assert.deepEqual([repeated.shows, repeated.acks], [0, 0], 'the new notice is not repeated after its own ack')
ok('a truly new reload appears once and is then acknowledged')

const retryAt = nextAt + 5_000
settings.update({ reloadedAt: retryAt, reloadCount: 4 })
settings.flush()
let cachedAt = ''
let retryShows = 0
let ackAttempts = 0
const retryCallbacks = {
  show: () => { retryShows += 1 },
  remember: at => { cachedAt = String(at) },
  ack: async at => {
    ackAttempts += 1
    if (ackAttempts === 1) throw new Error('temporary acknowledgement failure')
    assert.equal((await route('POST', '/reload-notice/ack', { at })).status, 200)
  },
}
const failedAck = await announceReloadNotice(await meta(), cachedAt, retryCallbacks)
assert.deepEqual(failedAck, { at: retryAt, show: true, shown: true })
assert.equal(cachedAt, String(retryAt), 'the first toast is cached even if its ack fails')
assert.equal((await meta()).reloadNoticeSeen, nextAt, 'a failed ack does not mark the server notice as seen')
const retriedAck = await announceReloadNotice(await meta(), cachedAt, retryCallbacks)
assert.deepEqual(retriedAck, { at: retryAt, show: false, shown: false })
assert.deepEqual([retryShows, ackAttempts], [1, 2], 'same-origin retry acknowledges without another toast')
assert.equal((await meta()).reloadNoticeSeen, retryAt)
assert.equal(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).reloadNoticeSeen, retryAt, 'the retried ack persists')
const newOrigin = await announceReloadNotice(await meta(), '', retryCallbacks)
assert.deepEqual(newOrigin, { at: retryAt, show: false, shown: false })
assert.deepEqual([retryShows, ackAttempts], [1, 2], 'a new origin neither replays nor re-acknowledges the confirmed notice')
ok('a failed ack retries from the cache and prevents replay in a new origin')

settings.dispose()

// ── generation-1 adoption of a pre-#761 settings file ───────────────────────
const home = path.join(scratch, 'boot')
process.env.DSH_HOME = home
const bootDir = path.join(home, 'our-free-model')
fs.mkdirSync(bootDir, { recursive: true })
const bootFile = path.join(bootDir, 'settings.json')
const oldAt = 1_700_000_100_000
fs.writeFileSync(bootFile, JSON.stringify({ version: 1, enabled: true, reloadedAt: oldAt, reloadCount: 4 }))

const routes = []
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer'], onRegister: entry => routes.push(entry) })
apply(ctx, { distribution: 'managed' })

const adopted = JSON.parse(fs.readFileSync(bootFile, 'utf8'))
assert.equal(adopted.reloadNoticeSeen, oldAt, 'generation 1 adopts the legacy reloadedAt')
assert.equal(adopted.reloadedAt, oldAt, 'adoption leaves the old timestamp in place')
assert.equal(adopted.reloadCount, 4)

try {
  const api = () => routes.find(entry => entry.kind === 'prefix')?.handler
  await until(() => api() !== undefined, { what: 'the settings API', timeoutMs: 5_000 })
  const bootMeta = (await callRoute(api(), 'GET', '/api/our-free-model/meta')).json
  assert.equal(bootMeta.reloadNoticeSeen, oldAt)
  assert.equal(reloadNoticePlan(bootMeta, '').show, false, 'a process restart must not replay a stale legacy notice')
  assert.equal((await callRoute(api(), 'POST', '/api/our-free-model/reload-notice/ack', { at: oldAt })).status, 200)
  ok('generation 1 adopts a legacy reloadedAt and /meta reports it')
} finally {
  for (const dispose of ctx.__disposers.splice(0).reverse()) {
    try { dispose() } catch { /* teardown must not fail the suite */ }
  }
}

fs.rmSync(scratch, { recursive: true, force: true })
console.log(`\n${checks} reload-notice checks passed`)
