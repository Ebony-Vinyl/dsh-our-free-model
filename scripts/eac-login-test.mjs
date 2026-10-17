/** Offline regressions for the Host delivery path and actual login hook. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createEacLoginPoller } from '../src/eac-login.js'
import { readEacUser, writeEacUser } from '../src/eac-user.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-login-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = scratch
const link = 'x'.repeat(32)
const token = 'test-user-token-never-visible-in-the-browser'
const credential = { mode: 'worker', base: 'https://gateway.invalid/eac/v1' }
const ok = (extra = {}) => new Response(JSON.stringify({ status: 'ok', token, login: 'octocat', ...extra }))
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const flush = () => new Promise(resolve => setImmediate(resolve))
try {
  let polls = 0, acks = 0, writes = 0
  const held = deferred()
  const host = createEacLoginPoller({ credentialOf: () => credential, readUser: readEacUser,
    writeUser: value => { writes++; return writeEacUser(value) }, onSaved() {},
    fetch: async (url, init) => {
      if (url.includes('/auth/ack?')) {
        acks++; assert.equal(init.headers['x-ofm-user'], token)
        assert.equal(readEacUser()?.token, token, 'ACK must follow a readable atomic save')
        return new Response('{}')
      }
      polls++; assert.ok(url.endsWith('&retain=1')); await held.promise
      return ok({ ackRequired: true })
    },
  })
  const first = host.poll(link), concurrent = host.poll(link)
  assert.equal(first, concurrent, 'concurrent requests share the same collector')
  held.resolve()
  const answer = await first
  assert.deepEqual(answer, { status: 'ok', login: 'octocat' })
  assert.equal(JSON.stringify(answer).includes(token), false)
  assert.deepEqual([polls, acks, writes], [1, 1, 1])
  assert.deepEqual(await host.poll(link), answer, 'lost local response can be retried after ACK')
  assert.equal(polls, 1)
  console.log('ok  Host: save/read precedes ACK; concurrent collection and local-response retry; no browser token')

  let canWrite = false, saved = null, acknowledgements = 0
  const storageFailure = createEacLoginPoller({ credentialOf: () => credential, readUser: () => saved,
    writeUser: value => canWrite ? (saved = value) : null, onSaved() {},
    fetch: async url => {
      if (url.includes('/auth/ack?')) { acknowledgements++; return new Response('{}') }
      return ok({ ackRequired: true })
    },
  })
  assert.deepEqual(await storageFailure.poll(link), { error: 'not-writable' })
  assert.equal(acknowledgements, 0)
  canWrite = true
  assert.equal((await storageFailure.poll(link)).status, 'ok')
  assert.equal(acknowledgements, 1)
  console.log('ok  Host: failed local persistence does not ACK; retry succeeds')

  let oldAcks = 0
  const legacy = createEacLoginPoller({ credentialOf: () => credential, readUser: () => saved,
    writeUser: value => (saved = value), onSaved() {},
    fetch: async url => { if (url.includes('/ack?')) oldAcks++; return ok() },
  })
  assert.equal((await legacy.poll(link)).status, 'ok'); assert.equal(oldAcks, 0)
  const ackFailure = createEacLoginPoller({ credentialOf: () => credential, readUser: () => saved,
    writeUser: value => (saved = value), onSaved() {},
    fetch: async url => { if (url.includes('/ack?')) throw Error('offline'); return ok({ ackRequired: true }) },
  })
  assert.equal((await ackFailure.poll(link)).status, 'ok')
  console.log('ok  Host: old gateway compatibility and failed ACK preserve saved login')

  for (const [response, error] of [[new Response('<html>private response</html>', { status: 520 }), 'gateway-http-520'], [new Response('invalid JSON'), 'malformed'], [new Response('{"status":"ok"}'), 'malformed']]) {
    const bad = createEacLoginPoller({ credentialOf: () => credential, fetch: async () => response,
      readUser: () => null, writeUser: () => { assert.fail('unexpected write') }, onSaved() {} })
    assert.deepEqual(await bad.poll(link), { error })
  }
  const expired = createEacLoginPoller({ credentialOf: () => credential, fetch: async () => new Response('{"status":"expired"}'),
    readUser: () => null, writeUser: () => assert.fail('expired login must not save a token'), onSaved() {} })
  assert.deepEqual(await expired.poll(link), { status: 'expired' })
  const late = deferred()
  const cancelled = createEacLoginPoller({ credentialOf: () => credential, fetch: async () => { await late.promise; return ok() },
    readUser: () => null, writeUser: () => assert.fail('late response must not log the user back in'), onSaved() {} })
  const request = cancelled.poll(link)
  cancelled.reset(); late.resolve()
  assert.deepEqual(await request, { error: 'cancelled' })
  console.log('ok  Host: HTTP and malformed errors are safe; logout invalidates in-flight collection')

  let registered = false, cancelSaved = null, cancelAcks = 0
  const delivering = deferred()
  let aborted = false
  const scoped = createEacLoginPoller({ credentialOf: () => credential, readUser: () => cancelSaved,
    writeUser: value => (cancelSaved = value), onSaved() {}, fetch: async (url, init) => {
      if (url.includes('/auth/github/start?')) { registered = true; return new Response(null, { status: 302 }) }
      if (url.includes('/auth/ack?')) { cancelAcks++; return new Response('{}') }
      init.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      await delivering.promise // Deliberately ignore abort to test the late-write fence too.
      return ok({ ackRequired: true })
    },
  })
  assert.deepEqual(await scoped.prepare(link), { ok: true })
  assert.equal(registered, true, 'Host registers the link before opening a browser')
  const pendingCollection = scoped.poll(link)
  assert.deepEqual(scoped.cancel(link), { ok: true })
  delivering.resolve()
  assert.deepEqual(await pendingCollection, { error: 'cancelled' })
  assert.equal(aborted, true)
  assert.equal(cancelSaved, null); assert.equal(cancelAcks, 0)
  assert.deepEqual(await scoped.poll(link), { error: 'cancelled' }, 'a delayed browser poll cannot revive the cancelled link')
  const newLink = 'n'.repeat(32)
  assert.equal((await scoped.poll(newLink)).status, 'ok', 'cancelling one link does not prevent a new sign-in')
  assert.deepEqual(scoped.cancel(newLink), { status: 'ok', login: 'octocat' }, 'a completed atomic save is reported as completed, never as a cancelled login')
  console.log('ok  Host: registration precedes browser start; link cancellation aborts/fences collection without affecting another link')
} finally {
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  fs.rmSync(scratch, { recursive: true, force: true })
}

// Small stateful React/timer stand-in: execute the real hook and effects, with
// controllable completion of HTTP calls. No real browser or external network.
let clock = 100_000, nextTimer = 0, bundle, active
const timers = new Map(), storage = new Map()
const setTimer = (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id }
const clearTimer = id => timers.delete(id)
const firePoll = () => {
  const entry = [...timers].find(([, value]) => value.delay === 2500)
  assert.ok(entry, 'next serial poll is scheduled')
  timers.delete(entry[0]); return entry[1].callback()
}
const depsEqual = (left, right) => left?.length === right?.length && left.every((value, index) => value === right[index])
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }), Fragment: 'fragment',
  useState(initial) {
    const i = active.index++
    if (!(i in active.slots)) active.slots[i] = typeof initial === 'function' ? initial() : initial
    const owner = active
    return [owner.slots[i], value => { owner.slots[i] = typeof value === 'function' ? value(owner.slots[i]) : value }]
  },
  useRef(value) { const i = active.index++; return active.slots[i] ??= { current: value } },
  useCallback(callback, deps) {
    const i = active.index++, previous = active.slots[i]
    if (previous && depsEqual(previous.deps, deps)) return previous.value
    active.slots[i] = { deps, value: callback }; return callback
  },
  useEffect(callback, deps) {
    const i = active.index++, previous = active.slots[i]
    if (previous && depsEqual(previous.deps, deps)) return
    previous?.cleanup?.(); active.slots[i] = { deps, effect: true, cleanup: callback() }
  },
  useMemo: factory => factory(),
}
const messages = { 'eac.pollFailed': 'retry {reason}', 'eac.saveFailed': 'check DSH_HOME permissions', 'eac.done': 'done @{login}' }
const t = key => messages[key] ?? key
let pollCalls = 0, startCalls = 0, reloads = 0, cancelCalls = 0, opened = true
let pollResult = () => new Response('{"error":"gateway-http-520"}', { status: 502 })
let cancelResult = () => new Response('{"ok":true}')
const fetch = async url => {
  if (url.includes('/login/start')) { startCalls++; return new Response(JSON.stringify({ link, url: `https://gateway.invalid/eac/auth/github/start?link=${link}`, opened })) }
  if (url.includes('/login/cancel')) { cancelCalls++; return cancelResult() }
  if (url.includes('/login/poll')) { pollCalls++; return pollResult() }
  return new Response('{"available":true,"authorized":true,"login":"octocat"}')
}
class ClockDate extends Date { static now() { return clock } }
new Function('window', 'document', 'fetch', 'sessionStorage', 'setTimeout', 'clearTimeout', 'Date', fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(
  { __ModuleLoader__: { load: record => { bundle = record } } }, { baseURI: 'http://localhost/' }, fetch,
  { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, setTimer, clearTimer, ClockDate)
const { useEacLogin, EacAuth } = bundle.factory(() => react).__test
const onAuth = () => {}
const mount = () => {
  const owner = { slots: [], index: 0 }
  return {
    render() { active = owner; owner.index = 0; return useEacLogin({ t: key => t(key), summary: { reload: () => { reloads++ } }, onAuth }) },
    unmount() { owner.slots.filter(value => value?.effect).forEach(value => value.cleanup?.()) },
  }
}
let page = mount(), login = page.render()
await login.login(); login = page.render()
await login.login(); assert.equal(startCalls, 1, 'pending login cannot be replaced accidentally')
assert.equal(storage.size, 1)
assert.equal([...storage.values()][0].includes(token), false)
await firePoll(); login = page.render()
assert.equal(login.notice, 'retry HTTP 520')
assert.ok(login.pending)
console.log('ok  UI: HTTP 520 is visible, retries continue and duplicate start is blocked')

page.unmount(); page = mount(); login = page.render()
assert.equal(login.pending.link, link, 'reopening settings restores the same login')
const slow = deferred(); pollResult = () => slow.promise
const running = firePoll(); await flush()
clock += 10_000
assert.equal([...timers.values()].filter(value => value.delay === 2500).length, 0, 'no overlap while the request is unresolved')
// A rerender with a freshly wrapped translator must not reset the poll timer.
login = page.render()
assert.equal([...timers.values()].filter(value => value.delay === 2500).length, 0)
slow.resolve(new Response('{"error":"not-writable"}', { status: 502 })); await running
login = page.render(); assert.equal(login.notice, 'check DSH_HOME permissions')
pollResult = () => new Response('{"status":"ok","login":"octocat"}')
await firePoll(); login = page.render(); await flush()
assert.equal(login.pending, null); assert.equal(login.notice, 'done @octocat')
assert.equal(storage.size, 0); assert.equal(reloads, 1)
console.log('ok  UI: remount resumes; polling stays serial across slow responses/rerenders; persistence error and success are visible')

await login.login(); login = page.render(); await login.cancel(); login = page.render()
assert.equal(login.pending, null); assert.equal(storage.size, 0)
assert.equal(cancelCalls, 1, 'cancellation reaches the Host rather than only clearing the page')
await login.login(); login = page.render(); clock += 10 * 60_000
await firePoll(); login = page.render()
assert.equal(login.pending, null); assert.equal(login.notice, 'eac.expired'); assert.equal(storage.size, 0)
await login.login(); login = page.render()
pollResult = () => new Response('{"status":"expired"}')
await firePoll(); login = page.render()
assert.equal(login.pending, null); assert.equal(login.notice, 'eac.sessionExpired'); assert.equal(storage.size, 0)
page.unmount()
const pendingTree = EacAuth({ t, auth: { available: true }, eacLogin: { ...login, pending: { link, url: 'https://gateway.invalid/auth' } } })
const pendingLinks = []
const collectLinks = node => { if (!node || typeof node !== 'object') return; if (node.type === 'a') pendingLinks.push(node); for (const child of node.children ?? []) { if (Array.isArray(child)) child.forEach(collectLinks); else collectLinks(child) } }
collectLinks(pendingTree)
assert.ok(pendingLinks.some(node => node.props.href === 'https://gateway.invalid/auth' && node.props.target === '_blank'), '等待授权面板必须提供可点击的授权链接')
const tree = EacAuth({ t, auth: { available: true, unverified: true }, eacLogin: { ...login, pending: null } })
assert.ok(JSON.stringify(tree).includes('eac.pillUnknown'))
assert.equal(JSON.stringify(tree).includes('eac.pillCompat'), false)
console.log('ok  UI: cancel/expiry clear saved links; unknown enforcement is not labeled as compatibility')
// The real hook calls the real Host collector while a response is deliberately
// late. No user file or remote credential is used by this integration fixture.
let localLogin = null, lateAcks = 0
const delayedLogin = deferred()
const collector = createEacLoginPoller({ credentialOf: () => credential, readUser: () => localLogin,
  writeUser: value => (localLogin = value), onSaved() {}, fetch: async url => {
    if (url.includes('/auth/ack?')) { lateAcks++; return new Response('{}') }
    await delayedLogin.promise
    return ok({ ackRequired: true })
  },
})
pollResult = async () => new Response(JSON.stringify(await collector.poll(link)))
cancelResult = () => new Response(JSON.stringify(collector.cancel(link)))
page = mount(); login = page.render(); await login.login(); login = page.render()
const collecting = firePoll(); await flush()
await login.cancel(); login = page.render()
delayedLogin.resolve(); await collecting
assert.equal(localLogin, null); assert.equal(lateAcks, 0)
assert.equal(login.pending, null); assert.equal(storage.size, 0)
page.unmount()
console.log('ok  UI + Host: cancelling during collection prevents both the late save and the ACK')

// Keep waiting on a manual start and surface a failed cancellation instead of
// pretending it succeeded. A retry is allowed after the Host becomes reachable.
opened = false
pollResult = () => new Response('{"status":"pending"}')
cancelResult = () => { throw Error('Host offline') }
page = mount(); login = page.render(); await login.login(); login = page.render()
assert.equal(login.notice, 'eac.openManually')
await firePoll(); login = page.render(); assert.ok(login.pending)
await login.cancel(); login = page.render()
assert.ok(login.pending); assert.equal(login.notice, 'eac.cancelFailed')
cancelResult = () => new Response('{"ok":true}')
await login.cancel(); login = page.render(); assert.equal(login.pending, null)
page.unmount()
console.log('ok  UI: manual sign-in keeps its waiting link; failed cancellation retains a recoverable session')

page = mount(); login = page.render(); await login.login(); login = page.render()
cancelResult = () => { throw Error('cancellation response lost after Host accepted it') }
await login.cancel(); login = page.render(); assert.ok(login.pending)
pollResult = () => new Response('{"error":"cancelled"}', { status: 502 })
await firePoll(); login = page.render()
assert.equal(login.pending, null); assert.equal(storage.size, 0)
page.unmount()

page = mount(); login = page.render(); await login.login(); login = page.render()
cancelResult = () => new Response('{"status":"ok","login":"octocat"}')
const previousReloads = reloads
await login.cancel(); login = page.render()
assert.equal(login.pending, null); assert.equal(login.notice, 'done @octocat')
assert.equal(reloads, previousReloads + 1)
page.unmount()
console.log('ok  UI: lost cancellation acknowledgement converges; already committed login is reported honestly')

// Exercise the actual registered Host endpoints too, including the browser
// ordering. All outbound IO and the browser launcher are replaced for this
// fixture; the temporary home never shares real authorization or credentials.
{
  const { default: childProcess } = await import('node:child_process')
  const { syncBuiltinESMExports } = await import('node:module')
  const { EventEmitter } = await import('node:events')
  const { lane } = await import('../src/eac.js')
  const { callRoute, fakeContext, until } = await import('./lib/fake-kernel.mjs')
  const previous = { home: process.env.DSH_HOME, upstream: process.env.OUR_FREE_MODEL_BASE, fetch: globalThis.fetch, spawn: childProcess.spawn, laneFetch: lane.fetch }
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-login-routes-'))
  const order = [], routeDelivery = deferred()
  let ctx
  process.env.DSH_HOME = home
  process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:9'
  globalThis.fetch = async () => new Response('{"data":[]}')
  childProcess.spawn = () => { order.push('browser'); return Object.assign(new EventEmitter(), { unref() {} }) }
  syncBuiltinESMExports()
  lane.fetch = async url => {
    if (url.includes('/auth/github/start?')) { order.push('registered'); return new Response(null, { status: 302 }) }
    if (url.includes('/auth/poll?')) { await routeDelivery.promise; return ok({ ackRequired: true }) }
    return new Response('{"data":[]}')
  }
  try {
    const { apply, inject } = await import('../index.js')
    const routes = []
    ctx = fakeContext({ inject, profileContext: { name: 'desktop', home }, onRegister: route => routes.push(route) })
    apply(ctx, {})
    await until(() => routes.some(route => route.kind === 'prefix'), { what: 'EAC Host API' })
    const handler = routes.find(route => route.kind === 'prefix').handler
    const started = await callRoute(handler, 'POST', '/api/our-free-model/eac/login/start')
    assert.equal(started.status, 200); assert.equal(started.json.opened, true)
    assert.deepEqual(order, ['registered', 'browser'], 'Host registers the link before launching the system browser')
    const actualLink = started.json.link
    const collecting = callRoute(handler, 'GET', `/api/our-free-model/eac/login/poll?link=${actualLink}`)
    await flush()
    const cancelled = await callRoute(handler, 'POST', `/api/our-free-model/eac/login/cancel?link=${actualLink}`)
    assert.deepEqual(cancelled, { status: 200, json: { ok: true } })
    routeDelivery.resolve()
    assert.deepEqual(await collecting, { status: 502, json: { error: 'cancelled' } })
    assert.equal(readEacUser(), null, 'the actual Host cancel route prevents local persistence')
    assert.equal((await callRoute(handler, 'POST', '/api/our-free-model/eac/login/cancel?link=bad')).status, 400)
    console.log('ok  Host routes: pre-registration precedes browser launch; real cancellation endpoint blocks a late token')
  } finally {
    routeDelivery.resolve()
    for (const dispose of [...(ctx?.__disposers ?? [])].reverse()) await dispose()
    await flush()
    globalThis.fetch = previous.fetch; lane.fetch = previous.laneFetch
    childProcess.spawn = previous.spawn; syncBuiltinESMExports()
    if (previous.home === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous.home
    if (previous.upstream === undefined) delete process.env.OUR_FREE_MODEL_BASE
    else process.env.OUR_FREE_MODEL_BASE = previous.upstream
    fs.rmSync(home, { recursive: true, force: true })
  }
}
console.log('eac-login-test: all checks passed')
