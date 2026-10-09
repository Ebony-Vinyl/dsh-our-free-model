/**
 * Mount the actual published bundle against host contracts in isolation.
 * No real credentials, profile directories or upstream calls are used.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-pack-'))
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
const savedFetch = globalThis.fetch
const fetched = []
globalThis.fetch = async url => {
  fetched.push(String(url))
  throw new Error('external network is disabled in the channel mount test')
}
const dispose = []
const routes = []
const adapters = new Map()
const writes = []
const creds = new Map([['OPENCODE_ACCOUNT_EXISTING', { value: '{"api_key":"test-existing-key"}' }]])
const services = {
  profileContext: { home: scratch },
  credentials: {
    resolve: async ref => creds.get(ref),
    describe: async () => undefined,
    set: async (ref, value) => { writes.push(ref); creds.set(ref, { value }) },
    unset: async ref => { writes.push(ref); creds.delete(ref) },
  },
  llm: {
    registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
    listProviders: () => [...adapters.keys()].map(id => ({ id })),
  },
  connection: { fetch: { register: route => { routes.push(route) } } },
}
const ctx = {
  ...services,
  logger: { info() {}, warn() {}, error() {} },
  get: name => services[name],
  provide(name, service) { services[name] = service; this[name] = service },
  effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') dispose.push(cleanup) },
  inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
  emit() {},
}
const state = {
  accounts: [{
    id: 'opencode-existing', provider: 'opencode', nickname: 'Existing',
    credentialRef: 'OPENCODE_ACCOUNT_EXISTING', enabled: true, refreshable: false, createdAt: 1,
  }],
  disabledModels: {},
}
fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify(state))
try {
  const { apply } = await import('../vendor/channel-pack/pack.js')
  apply(ctx, { disableOpencode: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapters.has('opencode'), false, 'disabled account provider is not registered')
  assert.equal(adapters.size, 13, 'all other account providers remain registered')
  assert.equal(writes.length, 0, 'mount neither creates nor deletes credentials')
  assert.equal(fetched.some(url => url.includes('opencode') || url.includes('models.dev')), false, 'no OpenCode capability/catalog warmup')
  assert.deepEqual(ctx.accountPool.listAccountsByProvider('opencode'), state.accounts, 'historical account data survives')

  const route = routes.find(row => row.path === '/api/channel-pack')
  assert.ok(route, 'real RPC route is registered')
  const call = async (method, payload) => {
    const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'channel-pack', payload: { method, payload } }),
    }))
    return (await response.json()).result
  }
  for (const [method, payload] of [
    ['opencode.addAccount', { apiKey: 'test-key' }],
    ['opencode.addAnonymous', {}],
    ['account.create', { provider: 'opencode' }],
  ]) {
    const result = await call(method, payload)
    assert.equal(result.ok, false, `${method} fails closed`)
    assert.equal(result.error.code, 'provider-disabled')
  }
  assert.equal((await call('account.list', { provider: 'opencode' })).value.accounts.length, 1)
  assert.equal(writes.length, 0, 'rejected RPCs leave credentials untouched')
  console.log('ok  generated pack: 13 providers, no OpenCode registration/warmup, historical data retained, account RPCs refused')

  // A failed browser callback must become a terminal, readable poll result.
  // Before this regression check, the Gemini placeholder was removed and
  // `login.poll` returned `{ done: false }` forever, so the UI could only show
  // its ten-minute timeout even when Google had already rejected the exchange.
  const fetchBeforeGemini = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'fixture token exchange failed' }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    }
    return savedFetch(input, init)
  }
  try {
    const started = (await call('account.create', { provider: 'gemini' })).value
    assert.ok(started.accountId && started.loginUrl)
    const authorization = new URL(started.loginUrl)
    const callback = new URL(authorization.searchParams.get('redirect_uri'))
    callback.searchParams.set('state', authorization.searchParams.get('state'))
    callback.searchParams.set('code', 'fixture-code')
    const callbackResponse = await savedFetch(callback)
    assert.equal(callbackResponse.status, 200)
    await new Promise(resolve => setTimeout(resolve, 50))
    const failed = (await call('login.poll', { accountId: started.accountId, provider: 'gemini' })).value
    assert.deepEqual(failed, { done: true, success: false, error: 'invalid_grant: fixture token exchange failed' })
    console.log('ok  Gemini OAuth failure: login.poll returns a terminal reason instead of waiting forever')
  } finally {
    globalThis.fetch = fetchBeforeGemini
  }

  let bundle
  const window = { __ModuleLoader__: { load: record => { bundle = record } } }
  const react = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'fragment',
    useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect() {},
    useMemo: callback => callback(),
    useRef: () => ({ current: null }),
    useCallback: callback => callback,
  }
  new Function('window', fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'))(window)
  const { ChannelsPage } = bundle.factory(name => {
    assert.equal(name, 'react')
    return react
  }).__test
  const tree = ChannelsPage({ t: key => key, ctx: {}, summary: { channels: { state: 'ready' } } })
  const cards = []
  function visit(node) {
    if (Array.isArray(node)) { node.forEach(visit); return }
    if (node === null || typeof node !== 'object') return
    if (node.props?.channel) cards.push(node.props.channel.id)
    visit(node.children)
  }
  visit(tree)
  assert.equal(cards.length, 13)
  assert.equal(cards.includes('opencode'), false)
  assert.deepEqual([...cards].sort(), [...adapters.keys()].sort(), 'UI and mounted account providers agree')
  console.log('ok  actual channel page: 13 account cards, OpenCode removed')

  // The retained OFM anonymous lane still enumerates and streams without any
  // account, independently of the disabled vendored OpenCode provider.
  globalThis.fetch = savedFetch
  const { stubUpstream, chatFrames } = await import('./lib/fake-kernel.mjs')
  const stub = await stubUpstream({ listing: ['mimo-v2.6-flash-free'], answer: () => ({ body: chatFrames('anonymous-ok') }) })
  try {
    process.env.OUR_FREE_MODEL_BASE = stub.base
    const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
    const { buildCatalog } = await import('../src/catalog.js')
    const model = buildCatalog(['mimo-v2.6-flash-free'])[0]
    const adapter = new FreeModelAdapter({
      state: () => ({
        catalog: [model], membership: { [ROUTE_MAIN]: [model.id] },
        settings: { enabled: true }, attributionUserAgent: 'test/1.0',
      }),
      recordUsage() {}, warn() {},
    })
    assert.ok((await adapter.listModels(ROUTE_MAIN)).some(row => row.id === model.id))
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: ROUTE_MAIN, model: model.id,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    })) chunks.push(chunk)
    assert.ok(JSON.stringify(chunks).includes('anonymous-ok'), 'anonymous response is delivered')
    console.log('ok  retained OFM anonymous lane: model listing and streaming with no account')
  } finally {
    await stub.close()
  }
} finally {
  for (const cleanup of dispose.reverse()) await cleanup()
  globalThis.fetch = savedFetch
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}
