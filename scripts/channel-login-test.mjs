import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ChannelCard,')
const settle = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function nodes(tree, out = []) {
  if (Array.isArray(tree)) tree.forEach(child => nodes(child, out))
  else if (tree && typeof tree === 'object') { out.push(tree); nodes(tree.children, out) }
  return out
}

/** Run real hooks with dependency tracking and a clock that never starts real timers. */
function harness({ open = () => null, fetch: request = async () => ({ opened: true }), storage = new Map() } = {}) {
  const cells = [], cleanups = new Map(), intervals = new Map(), timeouts = new Map()
  let cursor = 0, effects = [], record, id = 0, now = 0, disposed = false, lateWrites = 0
  const same = (a, b) => a !== undefined && b !== undefined && a.length === b.length && a.every((value, i) => Object.is(value, b[i]))
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => {
        if (disposed) lateWrites++
        cells[index] = typeof value === 'function' ? value(cells[index]) : value
      }]
    },
    useRef(value) { return cells[cursor++] ??= { current: value } },
    useMemo(fn, deps) {
      const index = cursor++
      if (!same(cells[index]?.deps, deps)) cells[index] = { deps, value: fn() }
      return cells[index].value
    },
    useCallback(fn, deps) { return react.useMemo(() => fn, deps) },
    useEffect(fn, deps) {
      const index = cursor++
      if (!same(cells[index], deps)) { cells[index] = deps; effects.push({ index, fn }) }
    },
  }
  const window = {
    __ModuleLoader__: { load: value => { record = value } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    open, addEventListener() {}, removeEventListener() {},
  }
  new Function('window', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', source)(
    window,
    async (...args) => ({ ok: true, text: async () => JSON.stringify(await request(...args)) }),
    (fn, ms) => { intervals.set(++id, { fn, ms, at: now + ms }); return id },
    key => intervals.delete(key),
    (fn, ms) => { timeouts.set(++id, { fn, ms, at: now + ms }); return id },
    key => timeouts.delete(key),
  )
  const api = record.factory(() => react).__test
  return {
    api, window, intervals, timeouts,
    render(fn) {
      cursor = 0; effects = []
      const result = fn()
      for (const { index, fn: setup } of effects) {
        cleanups.get(index)?.()
        cleanups.set(index, setup())
      }
      return result
    },
    tick() { for (const timer of [...intervals.values()]) timer.fn() },
    advance(ms) {
      const until = now + ms
      while (true) {
        const next = [...intervals, ...timeouts].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (!next) break
        const [key, timer] = next
        now = timer.at
        if (intervals.has(key)) timer.at += timer.ms
        else timeouts.delete(key)
        timer.fn()
      }
      now = until
    },
    unmount() { disposed = true; for (const cleanup of cleanups.values()) cleanup?.(); cleanups.clear() },
    get lateWrites() { return lateWrites },
  }
}

function mount(provider, options = {}) {
  const app = harness(options), calls = [], errors = []
  const rpc = async (method, payload) => {
    calls.push({ method, payload })
    if (method === 'account.create') return options.create?.(payload) ?? { accountId: 'fixture-account' }
    if (method === 'credits.balances') return options.balance?.() ?? { accounts: [] }
    return { accounts: [] }
  }
  const props = {
    channel: { id: provider, name: provider }, status: { accounts: { total: 0, enabled: 0 } },
    rpc, t: key => app.api.DICT.en[key], onChanged() {}, onError: (_channel, error) => errors.push(error.message),
  }
  const renderHooks = app.render
  const render = () => renderHooks(() => app.api.ChannelCard(props))
  const button = label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label))
  render()
  return Object.assign(app, {
    calls, errors, props, render, button,
    add: () => button('Add account').props.onClick(),
    loginCalls: () => calls.filter(call => call.method === 'account.create'),
    manualUrl: () => nodes(render()).find(node => node.type === 'a' && node.props.target === '_blank')?.props.href,
  })
}
const URL_FIXTURE = 'https://example.invalid/authorize?client_id=fixture&state=two&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback'
function makePopup() {
  const tab = {
    closed: false, opener: 'fixture-opener', closes: 0, navigations: [],
    close() { this.closed = true; this.closes++ },
    location: { replace(url) { tab.navigations.push(url) } },
  }
  return tab
}

{
  const pending = deferred(), tab = makePopup(), opens = []
  const app = mount('zcode', {
    open: (...args) => { opens.push(args); return tab },
    create: () => pending.promise,
    fetch: () => assert.fail('reserved popup must not also launch through the host'),
  })
  const click = app.button('Add account').props.onClick
  const login = click()
  void click()
  assert.deepEqual(opens, [['about:blank', '_blank']])
  assert.equal(tab.opener, null)
  assert.equal(app.loginCalls().length, 1, 'duplicate clicks must not create duplicate login accounts')
  assert.equal(app.button('z.ai international').props.disabled, true)
  pending.resolve({ accountId: 'fixture-account', loginUrl: URL_FIXTURE })
  await login
  assert.deepEqual(tab.navigations, [URL_FIXTURE])
  assert.equal(app.manualUrl(), URL_FIXTURE)
  app.unmount()
  assert.equal(tab.closes, 0, 'a navigated authorization tab belongs to the user')
}
for (const mode of ['blocked', 'closed', 'navigation-failed', 'host-failed', 'host-threw', 'fallback-threw']) {
  const tab = makePopup(), opens = [], requests = []
  if (mode === 'closed') tab.closed = true
  if (mode === 'navigation-failed') tab.location.replace = () => { throw new Error('fixture navigation failure') }
  const app = mount('buddy', {
    create: () => ({ accountId: 'fixture-account', loginUrl: URL_FIXTURE }),
    open: (...args) => {
      opens.push(args)
      if (args[0] === 'about:blank') return ['closed', 'navigation-failed'].includes(mode) ? tab : null
      if (mode === 'fallback-threw') throw new Error('fixture popup failure')
      return null
    },
    fetch: (path, options) => {
      requests.push({ path, options })
      if (mode === 'host-threw') throw new Error('fixture host unavailable')
      return { opened: !['host-failed', 'fallback-threw'].includes(mode) }
    },
  })
  await app.add()
  assert.equal(requests.length, 1, mode)
  assert.match(requests[0].path, /\/open-external$/)
  assert.deepEqual(JSON.parse(requests[0].options.body), { url: URL_FIXTURE })
  assert.equal(app.manualUrl(), URL_FIXTURE, `${mode} must retain the manual authorization URL`)
  if (['host-failed', 'host-threw', 'fallback-threw'].includes(mode)) {
    assert.deepEqual(opens.at(-1), [URL_FIXTURE, '_blank', 'noopener'])
  } else assert.equal(opens.length, 1, 'successful host launch must not open a duplicate')
  if (mode === 'navigation-failed') assert.equal(tab.closes, 1)
  app.unmount()
}
for (const answer of [{ accountId: 'fixture-account' }, {}, new Error('fixture create failure')]) {
  const tab = makePopup()
  const app = mount('buddy', {
    open: () => tab,
    create: () => { if (answer instanceof Error) throw answer; return answer },
  })
  await app.add()
  assert.equal(tab.closes, 1, 'no authorization URL or failed creation must close the placeholder')
  assert.equal(app.manualUrl(), undefined)
  assert.equal(app.button('Add account').props.disabled, false)
  app.unmount()
}
for (const url of ['javascript:alert(1)', 'https://user:password@example.invalid/', 'https://', `${URL_FIXTURE}${'a'.repeat(2048)}`]) {
  const tab = makePopup()
  const app = mount('buddy', {
    open: () => tab,
    create: () => ({ accountId: 'fixture-account', loginUrl: url }),
    fetch: () => assert.fail('invalid login URL reached the host'),
  })
  await app.add()
  assert.equal(tab.closes, 1)
  assert.deepEqual(tab.navigations, [])
  assert.equal(app.manualUrl(), undefined)
  assert.equal(app.errors.length, 1)
  app.unmount()
}
{
  const pending = deferred(), tab = makePopup()
  const app = mount('zcode', { open: () => tab, create: () => pending.promise })
  const login = app.add()
  app.props.rpc = async () => ({ accounts: [], accountId: 'replacement-account' })
  app.render()
  assert.equal(tab.closes, 1, 'transport replacement must release the old placeholder')
  assert.equal(app.button('Add account').props.disabled, false)
  pending.resolve({ accountId: 'fixture-account', loginUrl: URL_FIXTURE })
  await login
  assert.deepEqual(tab.navigations, [])
  assert.equal(app.manualUrl(), undefined, 'an abandoned transport must not revive its login')
  app.unmount()
}
{
  const pending = deferred(), tab = makePopup()
  const app = mount('buddy', { open: () => tab, create: () => pending.promise, fetch: () => assert.fail('unmounted login opened a browser') })
  const login = app.add()
  await settle()
  app.unmount()
  assert.equal(tab.closes, 1)
  pending.resolve({ accountId: 'fixture-account', loginUrl: URL_FIXTURE })
  await login
  assert.equal(app.lateWrites, 0)
  assert.deepEqual(tab.navigations, [])
}
console.log('ok  login click reservation, duplicate suppression, host/browser fallback, manual URL and popup cleanup')

const preferenceKey = 'ofm:zcode:login-provider'
for (const value of [undefined, 'corrupt', 'zai']) {
  const storage = new Map(value === undefined ? [] : [[preferenceKey, value]])
  const app = mount('zcode', { storage })
  const expected = value === 'zai' ? 'zai' : 'bigmodel'
  await app.add()
  assert.equal(app.loginCalls()[0].payload.zcodeProvider, expected)
  app.button('z.ai international').props.onClick()
  await app.add()
  assert.equal(app.loginCalls()[1].payload.zcodeProvider, 'zai')
  app.unmount()
  const restored = mount('zcode', { storage })
  await restored.add()
  assert.equal(restored.loginCalls()[0].payload.zcodeProvider, 'zai')
  restored.unmount()
}
for (const broken of ['getter', 'methods', 'missing']) {
  const app = mount('zcode')
  if (broken === 'getter') Object.defineProperty(app.window, 'localStorage', { get() { throw new Error('fixture denied storage') } })
  else app.window.localStorage = broken === 'missing' ? undefined
    : { getItem() { throw new Error('fixture denied read') }, setItem() { throw new Error('fixture denied write') } }
  // Mount a new component state with storage already unavailable.
  app.unmount()
  const fresh = harness()
  Object.defineProperty(fresh.window, 'localStorage', { get: () => app.window.localStorage })
  const calls = []
  const props = { ...app.props, rpc: async (method, payload) => {
    if (method === 'account.create') calls.push(payload)
    return { accountId: 'fixture-account', accounts: [] }
  } }
  const render = () => fresh.render(() => fresh.api.ChannelCard(props))
  const button = label => nodes(render()).find(node => node.type === 'button' && node.children.includes(label))
  await button('Add account').props.onClick()
  assert.equal(calls[0].zcodeProvider, 'bigmodel')
  button('z.ai international').props.onClick()
  await button('Add account').props.onClick()
  assert.equal(calls[1].zcodeProvider, 'zai', 'denied storage must not prevent this-session selection')
  fresh.unmount()
}
{
  const app = mount('buddy')
  assert.equal(app.button('z.ai international'), undefined)
  await app.add()
  assert.deepEqual(app.loginCalls()[0].payload, { provider: 'buddy' })
  app.unmount()
}
console.log('ok  ZCode defaults, persistence, corrupt and inaccessible storage, and provider-only payloads')

{
  const old = deferred()
  const app = mount('qoder', { balance: () => old.promise })
  app.props.rpc = async () => ({ accounts: [{ accountId: 'fixture-account', balance: { total: 456 } }] })
  app.render()
  await settle()
  assert.ok(JSON.stringify(app.render()).includes('456'))
  old.resolve({ accounts: [{ accountId: 'fixture-account', balance: { total: 789 } }] })
  await settle()
  assert.ok(!JSON.stringify(app.render()).includes('789'), 'old-transport balances must not replace the new reading')
  app.unmount()
}

{
  const app = harness(), calls = []
  let context = {}
  const read = () => app.render(() => app.api.useChannelRpc(context))
  let state = read()
  assert.equal(state.available, false)
  assert.equal(app.intervals.size, 1)
  app.advance(60000)
  const connection = label => {
    const rpc = { async call(_path, _pack, request) {
      assert.equal(this, rpc)
      calls.push({ label, method: request.method })
      return { ok: true, value: label }
    } }
    return { rpc }
  }
  const first = connection('first'), second = connection('second')
  context.connection = first
  app.tick()
  state = read()
  assert.equal(state.available, true, 'readiness must recover beyond the old 20-second cutoff')
  const stable = state.rpc
  for (let i = 0; i < 10; i++) {
    context = { connection: first }
    app.tick()
    assert.equal(read().rpc, stable, 'context wrapper churn must not invalidate data loaders')
  }
  assert.equal(calls.length, 0, 'readiness checks must not make network calls')
  context.connection = second
  assert.equal(await stable('fixture.latest', {}), 'second', 'even an old callback must resolve the latest connection')
  app.tick()
  state = read()
  assert.notEqual(state.rpc, stable, 'actual replacement must invalidate existing dependent readers')
  context = {}
  read()
  app.tick()
  state = read()
  assert.equal(state.available, false)
  await assert.rejects(state.rpc('fixture.missing', {}), /no-connection/)
  context = { get connection() { throw new Error('service not provided') }, get: () => second }
  read()
  app.tick()
  state = read()
  assert.equal(state.available, true)
  assert.equal(await state.rpc('fixture.getter', {}), 'second')
  const prior = state.rpc
  second.rpc.call = async () => ({ ok: false, error: { message: 'fixture RPC error' } })
  app.tick()
  state = read()
  assert.notEqual(state.rpc, prior, 'in-place call replacement must also invalidate dependent readers')
  await assert.rejects(state.rpc('fixture.error', {}), /fixture RPC error/)
  second.rpc.call = async () => ({ bare: true })
  assert.deepEqual(await state.rpc('fixture.bare', {}), { bare: true })
  second.rpc.call = (_path, _pack, _request, signal) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fixture aborted')), { once: true })
  })
  const timed = state.rpc('fixture.timeout', {}, 77)
  const rejection = assert.rejects(timed, /fixture aborted/)
  app.advance(77)
  await rejection
  const queued = [...app.intervals.values()][0].fn
  app.unmount()
  queued()
  assert.equal(app.intervals.size, 0)
  assert.equal(app.timeouts.size, 0)
  assert.equal(app.lateWrites, 0)
}
console.log('ok  stable RPC identity, late readiness, latest transport, loss/recovery, envelopes and unmount cleanup')

for (const startedOnLatest of [true, false]) {
  const pending = deferred(), tab = makePopup(), calls = []
  const app = harness({ open: () => tab, fetch: () => assert.fail('reserved login must not use the host fallback') })
  const connection = label => ({ rpc: { async call(_path, _pack, request) {
    if (request.method === 'account.create') { calls.push(label); return { ok: true, value: await pending.promise } }
    return { ok: true, value: { accounts: [] } }
  } } })
  const context = { connection: connection('old') }
  const latest = connection('new')
  const props = { channel: { id: 'buddy', name: 'buddy' }, status: { accounts: { total: 0, enabled: 0 } },
    t: key => app.api.DICT.en[key], onChanged() {}, onError: (_channel, error) => assert.fail(error.message) }
  const render = () => app.render(() => {
    const { rpc } = app.api.useChannelRpc(context)
    return app.api.ChannelCard({ ...props, rpc })
  })
  render()
  if (startedOnLatest) context.connection = latest
  const login = nodes(render()).find(node => node.type === 'button' && node.children.includes('Add account')).props.onClick()
  if (startedOnLatest) {
    app.advance(500)
    render()
    assert.equal(tab.closed, false, 'the readiness tick must retain a login that already used the new transport')
  } else context.connection = latest
  pending.resolve({ accountId: 'fixture-account', loginUrl: URL_FIXTURE })
  await login
  assert.deepEqual(calls, [startedOnLatest ? 'new' : 'old'])
  assert.deepEqual(tab.navigations, startedOnLatest ? [URL_FIXTURE] : [], 'old transport results are fenced before the readiness tick too')
  if (!startedOnLatest) assert.equal(tab.closed, true)
  app.unmount()
}
console.log('ok  login ownership follows the dispatched transport across the readiness window')

for (const completion of ['before-tick', 'after-tick', 'rejection', 'unmount']) {
  const stale = deferred(), calls = []
  const app = harness()
  const connection = (label, status) => ({ rpc: { async call(_path, _pack, request) {
    if (request.method === 'provider.status') { calls.push(label); return { ok: true, value: await status() } }
    return { ok: true, value: { autoCheckin: { enabled: false } } }
  } } })
  const context = { connection: connection('old', () => stale.promise) }
  const value = count => ({ statuses: { buddy: { accounts: { total: count, enabled: count } } } })
  const t = Object.assign(key => app.api.DICT.en[key] ?? key, { locale: 'en' })
  const render = () => app.render(() => app.api.ChannelsPage({ ctx: context, t, summary: { channels: { state: 'ready' } } }))
  const count = () => nodes(render()).find(node => node.type === app.api.ChannelCard && node.props.channel.id === 'buddy').props.status?.accounts?.enabled
  render()
  await settle()
  if (completion === 'unmount') {
    app.unmount()
    stale.resolve(value(9))
    await settle()
    assert.equal(app.lateWrites, 0)
    continue
  }
  context.connection = connection('new', () => value(1))
  if (completion === 'before-tick') {
    stale.resolve(value(9))
    await settle()
    assert.equal(count(), undefined, 'a stale completion cannot publish during the detection window')
  }
  app.advance(500)
  render()
  await settle()
  assert.equal(count(), 1)
  if (completion === 'rejection') stale.reject(new Error('old connection failed'))
  else stale.resolve(value(9))
  await settle()
  assert.equal(count(), 1, 'old account counts cannot replace the fresh reading')
  app.advance(4000)
  await settle()
  assert.deepEqual(calls, ['old', 'new'], 'an obsolete failure must not schedule another status request')
  app.unmount()
  assert.equal(app.timeouts.size, 0)
}
console.log('ok  status generations fence old completions, retries and unmounts')

for (const firstCompletesFirst of [true, false]) {
  const first = deferred(), second = deferred()
  let reads = 0
  const app = harness()
  const context = { connection: { rpc: { async call(_path, _pack, request) {
    if (request.method === 'provider.status') return { ok: true, value: await (++reads === 1 ? first.promise : second.promise) }
    return { ok: true, value: { autoCheckin: { enabled: false } } }
  } } } }
  const t = Object.assign(key => app.api.DICT.en[key] ?? key, { locale: 'en' })
  const render = () => app.render(() => app.api.ChannelsPage({ ctx: context, t, summary: { channels: { state: 'ready' } } }))
  const count = () => nodes(render()).find(node => node.type === app.api.ChannelCard && node.props.channel.id === 'buddy').props.status?.accounts?.enabled
  const value = enabled => ({ statuses: { buddy: { accounts: { total: enabled, enabled } } } })
  render()
  app.advance(45000)
  assert.equal(reads, 2)
  if (firstCompletesFirst) {
    first.resolve(value(1))
    await settle()
    assert.equal(count(), 1, 'a later poll must not starve a slow valid response on the same transport')
    second.resolve(value(2))
  } else {
    second.resolve(value(2))
    await settle()
    assert.equal(count(), 2)
    first.resolve(value(1))
  }
  await settle()
  assert.equal(count(), 2, 'an older completion cannot overwrite a newer published result')
  app.unmount()
  assert.equal(app.timeouts.size, 0)
}
console.log('ok  slow same-transport status requests still publish while polling overlaps')
