/**
 * Mount the published bundle or --source TypeScript against isolated host contracts.
 * No real credentials, profile directories or upstream calls are used.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { verifyChannelModelActions } from './channel-model-actions-test.mjs'
import { verifyChannelCreditsUi } from './channel-credits-ui-test.mjs'
import { verifyChannelCreditsRpc } from './channel-credits-rpc-test.mjs'
import { verifyChannelImagePricing } from './channel-image-pricing-test.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-pack-'))
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const sourceMode = process.argv.includes('--source')
const ts = sourceMode ? (await import('typescript')).default : undefined
const RealContext = sourceMode ? (await import('@deepseek-ai/cordis')).Context : undefined
const RealBlockAssembler = sourceMode ? (await import('@deepseek-ai/dsh-llm')).BlockAssembler : undefined
const realLlmInvariant = sourceMode ? await import('@deepseek-ai/dsh-llm/invariant') : undefined
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const llmKernel = `data:text/javascript,${encodeURIComponent(`
export * from ${JSON.stringify(kernel)}
export class LlmError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status }
}
let nextMessage = 0
export function createUserMessage(value) { return { id: 'fixture-message-' + ++nextMessage, ...value } }
`)}`
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llmKernel, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (sourceMode && context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (sourceMode && url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      let source = fs.readFileSync(fileURLToPath(url), 'utf8')
      const name = url.slice(sourceRoot.length)
      if (['lobsterai-adapter.ts'].includes(name)) source += '\nexport { serializeMessages }\n'
      if (name === 'trae-adapter.ts') source += '\nexport { serializeTraeMessages as serializeMessages }\n'
      return { format: 'module', source: ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: fileURLToPath(url),
      }).outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})
process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
process.env.DSH_HOME = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime-info.exe')
const savedFetch = globalThis.fetch
const fetched = []
let auditFetch
const offlineFetch = async (url, init) => {
  if (auditFetch) return auditFetch(url, init)
  if (sourceMode && globalThis.fetch !== offlineFetch) return globalThis.fetch(url, init)
  fetched.push(String(url))
  throw new Error('external network is disabled in the channel mount test')
}
globalThis.fetch = offlineFetch
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
const unsupportedAccounts = ['unsupported-alpha', 'unsupported-beta'].map(provider => ({
  id: `${provider}-existing`, provider, nickname: 'Historical', enabled: true, refreshable: true,
  credentialRef: `${provider.toUpperCase()}_ACCOUNT_EXISTING`, createdAt: 1, expiresAt: 1,
}))
const unsupportedCredentials = unsupportedAccounts.map(entry => [entry.credentialRef, { value: JSON.stringify({
  access_token: 'fixture-unsupported', refresh_token: 'fixture-refresh', domain: 'unsupported.invalid', expires_at: '1',
}) }])
for (const [ref, value] of unsupportedCredentials) creds.set(ref, value)
const state = {
  accounts: [{
    id: 'opencode-existing', provider: 'opencode', nickname: 'Existing',
    credentialRef: 'OPENCODE_ACCOUNT_EXISTING', enabled: true, refreshable: false, createdAt: 1,
  }, ...unsupportedAccounts],
  disabledModels: {},
}
fs.mkdirSync(path.join(scratch, 'channel-pack'))
fs.writeFileSync(path.join(scratch, 'channel-pack/state.json'), JSON.stringify(state))
try {
  const pack = await import(sourceMode ? '../vendor/channel-pack/src/index.ts' : '../vendor/channel-pack/pack.js')
  const { apply } = pack
  apply(ctx, { disableOpencode: true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(adapters.has('opencode'), false, 'disabled account provider is not registered')
  assert.equal(adapters.size, 10, 'all other account providers remain registered')
  verifyChannelImagePricing(adapters)
  console.log('ok  十渠道同步图片计价：缺失及默认方法兜底，厂商计价优先，重复图片与已卸载图片正确计数')
  assert.equal(writes.length, 0, 'mount neither creates nor deletes credentials')
  assert.equal(fetched.some(url => url.includes('opencode') || url.includes('models.dev')), false, 'no OpenCode capability/catalog warmup')
  assert.deepEqual(ctx.accountPool.listAccountsByProvider('opencode'), state.accounts.filter(entry => entry.provider === 'opencode'), 'historical account data survives')

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
  const beforeUnsupportedFetch = fetched.length
  for (const entry of unsupportedAccounts) {
    assert.equal(adapters.has(entry.provider), false, 'unsupported provider is never registered')
    assert.equal(ctx[`${entry.provider}Auth`], undefined, 'unsupported auth service is never mounted')
    for (const [method, payload] of [
      ...['account.create', 'account.list', 'credits.status', 'credits.balances', 'credits.claimAll', 'model.list', 'provider.setEnabled', 'credits.permanentLock'].map(method => [method, { provider: entry.provider }]),
      ...['account.refresh', 'account.test', 'account.retest', 'account.reset', 'account.update', 'account.delete', 'login.poll'].map(method => [method, { accountId: entry.id }]),
      ['account.refresh', { provider: 'cline', accountId: entry.id }],
    ]) {
      const result = await call(method, payload)
      assert.equal(result.ok, false, `${entry.provider} ${method}: fails closed`)
      assert.equal(result.error.code, 'provider-unsupported')
    }
    assert.deepEqual(ctx.accountPool.findAccount(entry.id), entry, 'unsupported account remains intact')
    assert.deepEqual(creds.get(entry.credentialRef), unsupportedCredentials.find(([ref]) => ref === entry.credentialRef)[1])
  }
  assert.equal(writes.length, 0, 'unsupported requests neither write nor delete credentials')
  assert.equal(fetched.length, beforeUnsupportedFetch, 'unsupported requests never contact upstream')
  // A supported channel proves that the automatic run really executed, rather
  // than asserting an empty state after a skipped/failed run.
  await ctx.accountPool.addAccount({ id: 'automatic-loomy', provider: 'loomy', nickname: 'Auto fixture', enabled: true, refreshable: false, credentialRef: 'AUTO_LOOMY_FIXTURE', createdAt: 1 })
  creds.set('AUTO_LOOMY_FIXTURE', { value: '{"token":"fixture"}' })
  const savedClaim = ctx.loomyAuth.claimDailyQuota
  let automaticClaims = 0
  ctx.loomyAuth.claimDailyQuota = async () => { automaticClaims++; return { kind: 'claimed', credit: 1, streakDays: 1, isStreakDay: false } }
  await call('usage.autoCheckin', { enabled: true })
  let automatic
  for (let n = 0; n < 100; n++) {
    automatic = (await call('usage.autoCheckin', {})).value.autoCheckin
    if (!automatic.running && automatic.ranToday) break
    await new Promise(resolve => setImmediate(resolve))
  }
  assert.equal(automatic.ranToday, true, 'automatic check-in actually completed')
  assert.equal(automatic.running, false)
  assert.equal(automatic.channels.some(entry => ['unsupported-alpha', 'unsupported-beta'].includes(entry.provider)), false, 'unsupported accounts are not automatic check-in candidates')
  assert.equal(fetched.length, beforeUnsupportedFetch, 'automatic check-in sends no unsupported upstream request')
  assert.equal(automaticClaims, 1, 'supported channel actually signed in')
  assert.equal(writes.length, 0, 'startup and automatic check-in preserve all historical credentials')
  ctx.loomyAuth.claimDailyQuota = savedClaim
  await ctx.accountPool.removeAccount('automatic-loomy')
  creds.delete('AUTO_LOOMY_FIXTURE')
  console.log(`ok  ${sourceMode ? 'source modules' : 'generated pack'}: 10 providers, no OpenCode registration/warmup, historical data retained, account RPCs refused`)
  if (sourceMode) await verifySourceRegressions({ ctx, adapters, call, creds })
  await verifyChannelCreditsRpc({ ctx, call, creds })
  console.log('ok  实际渠道 RPC：七渠道仅账号池凭据即可查余额，ZCode 账号池回退及缺凭据反馈')

  // A failed browser callback must become a terminal, readable poll result.
  // Before this regression check, the Gemini placeholder was removed and
  // `login.poll` returned `{ done: false }` forever, so the UI could only show
  // its ten-minute timeout even when Google had already rejected the exchange.
  const fetchBeforeGemini = globalThis.fetch
  let releaseToken, tokenEntered
  const tokenGate = new Promise(resolve => { releaseToken = resolve })
  const tokenStarted = new Promise(resolve => { tokenEntered = resolve })
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith('https://oauth2.googleapis.com/token')) {
      tokenEntered()
      await tokenGate
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
    await Promise.race([
      tokenStarted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('fixture token exchange did not start')), 5000).unref()),
    ])
    assert.deepEqual((await call('login.poll', { accountId: started.accountId, provider: 'gemini' })).value, { done: false },
      'callback HTTP 200 precedes asynchronous token settlement')
    releaseToken()
    let failed
    for (let i = 0; i < 100; i++) {
      failed = (await call('login.poll', { accountId: started.accountId, provider: 'gemini' })).value
      if (failed.done) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    assert.deepEqual(failed, { done: true, success: false, error: 'invalid_grant: fixture token exchange failed' })
    console.log('ok  Gemini OAuth: callback 200 stays pending until token settlement, then poll returns terminal failure')
  } finally {
    releaseToken()
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
    if (name === 'react') return react
    if (name === 'react-dom') {
      return { createPortal: (children, container) => ({ type: 'portal', children, container }) }
    }
    throw new Error(`the browser half may only require react or react-dom; it asked for "${name}"`)
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
  assert.equal(cards.length, 10)
  for (const provider of ['opencode', 'unsupported-alpha', 'unsupported-beta']) assert.equal(cards.includes(provider), false)
  assert.deepEqual([...cards].sort(), [...adapters.keys()].sort(), 'UI and mounted account providers agree')
  console.log('ok  actual channel page: 10 account cards, OpenCode and unsupported providers removed')
  await verifyChannelModelActions()
  await verifyChannelCreditsUi()
  console.log('ok  共享渠道余额：十渠道能力、失败原因、重试、签到反馈和请求交错')
  console.log('ok  共享渠道卡片：批量开关、单次请求、重复点击保护和失败恢复')

  // The retained OFM anonymous lane still enumerates and streams without any
  // account, independently of the disabled vendored OpenCode provider.
  if (!process.argv.includes('--channels-only')) {
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
  }
} finally {
  for (const cleanup of dispose.reverse()) await cleanup()
  globalThis.fetch = savedFetch
  hooks.deregister()
  fs.rmSync(scratch, { recursive: true, force: true })
}

async function verifySourceRegressions({ ctx, adapters, call, creds }) {
  const { verifyChannelPrFixes } = await import('./channel-pr-fixes-test.mjs')
  await verifyChannelPrFixes()
  await verifyLoopResumeEvents()
  // 目录 `efforts` 的键序不是强度序（`dfmodel` 实测是 high/max/low），
  // 官方客户端还会按强度稳定排序；这条回归保证下发给 DSH 的档位序也是强度序。
  {
    const { verifyQoderEffortOrder } = await import('./qoder-effort-order-test.mjs')
    const { qoderEffortsFor, sortEffortsByStrength } = await import('../vendor/channel-pack/src/qoder-adapter.ts')
    verifyQoderEffortOrder(qoderEffortsFor, sortEffortsByStrength)
    console.log('ok  qoder effort order: 档位按强度序下发（关闭思考在最左、max 在最右），未登记 id 排末尾且保持原序')
  }
  let hostValidate
  await realLlmInvariant.apply({ invariants: { register(_name, install) {
    install({ on(name, callback) { if (name === 'llm/stream') hostValidate = callback } },
      message => { throw new Error(message) })
  } } })
  const validate = stream => hostValidate({}, () => stream)
  const assemble = chunks => {
    const assembler = new RealBlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    return assembler.blocks()
  }
  const collect = async iterable => { const out = []; for await (const item of iterable) out.push(item); return out }
  const frame = (delta, finish_reason = 'stop') => ({ choices: [{ delta, finish_reason }] })
  const sse = (...frames) => new Response(frames.map(row => `data: ${JSON.stringify(row)}\n\n`).join('') + 'data: [DONE]\n\n')
  const options = { model: 'fixture-model', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }
  const shared = await import('../vendor/channel-pack/src/openai-compat.ts')
  for (const [file, provider] of [
    ['openai-compat', 'shared'], ['lobsterai-adapter', 'lobsterai'],
    ['trae-adapter', 'trae'],
  ]) {
    const module = await import(new URL(`../vendor/channel-pack/src/${file}.ts`, import.meta.url))
    const serialize = module.serializeMessages
    const history = [
      { role: 'user', content: [{ type: 'text', text: 'task' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'interrupted thinking' }] },
      { role: 'assistant', content: [{ type: 'text', text: ' \n ' }] },
      { role: 'user', content: [] },
      { role: 'user', content: [{ type: 'text', text: ' \n ' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'result' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
    ]
    const before = JSON.stringify(history)
    const wire = serialize(history)
    assert.deepEqual(wire.map(row => row.role), ['user', 'assistant', 'tool', 'user'], provider)
    assert.equal(wire[1].tool_calls[0].function.name, 'read')
    assert.equal(wire[2].tool_call_id, 'call-1')
    assert.equal(wire[2].content, 'result')
    assert.equal(JSON.stringify(history), before, 'history is projected without mutating user data')
    const poison = serialize([
      { role: 'assistant', content: [{ type: 'tool-call', id: 'poison', name: '', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'poison', content: [{ type: 'text', text: 'unknown tool' }] },
      history[0],
    ])
    assert.deepEqual(poison.map(row => row.role), ['user'], `${provider}: old unnamed calls are not replayed`)
    {
      const image = serialize([{ role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'image-1' } }] }], new Map())
      assert.ok(JSON.stringify(image).includes('[image unavailable]'), provider)
      const images = ['image-1', 'image-2']
      const parallel = [
        { role: 'assistant', content: images.map(id => ({ type: 'tool-call', id, name: 'read_image', arguments: '{}' })) },
        ...images.map(id => ({
          role: 'tool', toolCallId: id, content: [{ type: 'image', attachment: { attachmentId: id } }],
        })),
      ]
      const imageUrls = new Map(images.map(id => [id, `data:image/png;base64,${id}`]))
      for (const messages of [parallel, [parallel[0], ...parallel.slice(1).map(row => ({
        role: 'user', content: [{ type: 'tool-result', toolCallId: row.toolCallId, content: row.content }],
      }))]]) {
        const projected = serialize(messages, imageUrls)
        assert.deepEqual(projected.map(row => row.role), ['assistant', 'tool', 'tool', 'user'], provider)
        assert.equal(projected.at(-1).content.filter(part => part.type === 'image_url').length, 2)
      }
    }
    const consume = response => validate(provider === 'shared'
      ? shared.consumeOpenAiSse(response, {}, { label: 'fixture', firstTokenTimeoutMs: 1000, chunkTimeoutMs: 1000 })
      : adapters.get(provider).consumeSse(response, options, ''))
    const response = (...data) => provider !== 'trae' ? sse(...data) : new Response(
      data.map(row => `event: output\ndata: ${JSON.stringify({
        response: row.choices[0].delta.content,
        reasoning_content: row.choices[0].delta.reasoning_content,
        tool_calls: row.choices[0].delta.tool_calls,
      })}\n\n`).join('') + `event: done\ndata: ${JSON.stringify({ finish_reason: data.at(-1).choices[0].finish_reason })}\n\n`,
    )
    for (const text of ['  ', '\n', '\n\n', '\t \r\n']) {
      const chunks = await collect(consume(response(frame({ content: text }))))
      assert.equal(chunks.at(-1).reason.kind, 'error', `${provider}: blank stop must fail`)
      assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE')
      assert.equal(chunks.some(row => row.type === 'block-end' && row.block.type === 'text'), false)
      assert.deepEqual(assemble(chunks), [], `${provider}: assembler cannot retain whitespace partials`)
    }
    const visible = await collect(consume(response(frame({ content: '  ok\n' }))))
    assert.equal(visible.at(-1).reason.kind, 'stop')
    assert.ok(visible.some(row => row.type === 'block-end' && row.block.text === '  ok\n'))
    assert.equal((await collect(consume(response(frame({ content: ' ' }, 'length'))))).at(-1).reason.kind, 'max-tokens')
    const tools = await collect(consume(response(frame({ tool_calls: [
      { index: 0, id: 'call-1', function: { name: 'read', arguments: '{}' } },
    ] }, 'tool_calls'))))
    assert.equal(tools.at(-1).reason.kind, 'tool-calls', `${provider}: tools remain valid`)
    const callDelta = { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'read', arguments: '{}' } }] }
    for (const rows of [
      [frame({ content: ' \n', ...callDelta }, 'tool_calls')],
      [frame({ content: ' \n' }, null), frame(callDelta, 'tool_calls')],
    ]) {
      const chunks = await collect(consume(response(...rows)))
      assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
      assert.deepEqual(assemble(chunks).map(block => block.type), ['tool-call'], `${provider}: whitespace plus tools leaves no text block`)
    }
    const thinking = await collect(consume(response(frame({ content: ' \n', reasoning_content: 'thinking' }))))
    const thinkingBlocks = assemble(thinking)
    assert.ok(thinkingBlocks.some(block => block.type === 'reasoning' && block.text === 'thinking'))
    assert.equal(thinkingBlocks.some(block => block.type === 'text' && block.text.trim() === ''), false)
    const splitProse = await collect(consume(response(frame({ content: ' \n' }, null), frame({ content: 'answer' }))))
    assert.equal(assemble(splitProse).find(block => block.type === 'text').text, ' \nanswer')
    console.log(`ok  source ${provider}: real host invariant/assembler, whitespace stop/tools/reasoning and preserved prose`)
  }

  const { RaccoonAdapter } = await import('../vendor/channel-pack/src/raccoon-adapter.ts')
  const { LoomyAdapter } = await import('../vendor/channel-pack/src/loomy-adapter.ts')
  const { nextUtc8DayStartMs } = await import('../vendor/channel-pack/src/model-queue.ts')
  const credential = token => ({ access_token: token, refresh_token: `refresh-${token}` })
  for (const [provider, Adapter] of [['raccoon', RaccoonAdapter], ['loomy', LoomyAdapter]]) {
  for (const kind of ['http', 'business', 'nested', 'json-quota', 'json-long-quota', 'json-nonquota', 'all', 'partial', 'server', 'abort', 'limit']) {
    const marked = [], sent = [], selected = []
    const controller = new AbortController()
    const adapter = new Adapter({
      credentialRef: 'FIXTURE',
      resolveCredential: async () => credential('a'),
      refresh: async () => { throw new Error('unexpected refresh') },
      accountPool: {
        findAccountIdByCredential: async () => 'a',
        updateModelRateLimit: async (...args) => marked.push(args),
      },
      nextAccount: async (_model, tried) => {
        selected.push([...tried])
        const next = (kind === 'all' ? ['a', 'b'] : ['a', 'b', 'c', 'd']).find(id => !tried.has(id))
        return next ? { accountId: next, credential: credential(next) } : undefined
      },
      fetchImpl: async (_url, init) => {
        const token = new Headers(init.headers).get('authorization').slice(7)
        sent.push(token)
        if (kind === 'abort') { controller.abort(); throw new DOMException('aborted', 'AbortError') }
        if (kind === 'server') return new Response('temporary failure', { status: 503 })
        if (kind === 'json-nonquota') return Response.json({ code: 500, message: 'temporary upstream failure' })
        if (kind === 'partial') return sse(frame({ content: 'partial' }, null), { code: 402, message: '积分不足' })
        if (kind === 'all' || kind === 'limit' || token === 'a') {
          if (kind === 'business') return sse({ code: 402, message: '积分不足' })
          if (kind === 'nested') return sse({ error: { message: '余额不足' } })
          if (kind === 'json-quota' || kind === 'json-long-quota') {
            return Response.json({
              code: 402, padding: kind === 'json-long-quota' ? 'x'.repeat(2000) : '', message: '积分不足',
            })
          }
          return new Response(JSON.stringify({ code: 402, message: '积分不足' }), { status: 402 })
        }
        return sse(frame({ content: 'rotated-ok' }))
      },
    })
    const chunks = []
    let failure
    try { for await (const chunk of adapter.stream({ ...options, signal: controller.signal })) chunks.push(chunk) }
    catch (error) { failure = error }
    if (['http', 'business', 'nested', 'json-quota', 'json-long-quota'].includes(kind)) {
      assert.equal(failure, undefined)
      assert.deepEqual(sent, ['a', 'b'])
      assert.deepEqual(marked.map(row => row[0]), ['a'])
      assert.ok(chunks.some(row => row.type === 'text-delta' && row.text === 'rotated-ok'))
    } else if (kind === 'all' || kind === 'limit') {
      assert.equal(failure.code, 'QUOTA_EXCEEDED')
      const expected = kind === 'all' ? ['a', 'b'] : ['a', 'b', 'c']
      assert.deepEqual(sent, expected, 'rotation stops at pool exhaustion or three attempts')
      assert.deepEqual(marked.map(row => row[0]), expected)
    } else {
      assert.ok(failure)
      assert.equal(sent.length, 1)
      assert.equal(selected.length, 0, 'partial output, transport and abort do not replay')
      if (kind !== 'partial') assert.equal(marked.length, 0, 'non-quota errors do not lock accounts')
    }
    for (const row of marked) {
      assert.equal(row[1], options.model)
      assert.equal(row[2], nextUtc8DayStartMs())
    }
  }
  console.log(`ok  source ${provider}: HTTP/SSE quota rotation, attribution, bounded retries, no replay after output/abort/5xx`)
  }

  const originalFetch = globalThis.fetch
  const added = []
  try {
    for (const provider of ['raccoon', 'qoder', 'qodercn', 'loomy']) {
      for (const id of ['a', 'b']) {
        const accountId = `audit-${provider}-${id}`, ref = `AUDIT_${provider}_${id}`
        added.push({ accountId, ref })
        creds.set(ref, { value: JSON.stringify(credential(id)) })
        await ctx.accountPool.addAccount({
          id: accountId, provider, nickname: id, credentialRef: ref, enabled: true, refreshable: true, createdAt: 1,
          modelRateLimits: { [options.model]: Date.now() + 3600000 },
        })
      }
      await assert.rejects(collect(adapters.get(provider).stream({ ...options, provider })), error => {
        assert.equal(error.code, 'QUOTA_EXCEEDED')
        assert.match(error.message, /无需重新登录/)
        return true
      })
    }
    await ctx.accountPool.clearModelRateLimits('audit-raccoon-b')
    const refreshes = [], sends = []
    auditFetch = async (input, init) => {
      const url = String(input)
      if (url.endsWith('/refresh')) {
        refreshes.push(JSON.parse(init.body).refresh_token)
        return Response.json({ code: 0, data: { access_token: 'b-new', refresh_token: 'refresh-b-new' } })
      }
      if (url.endsWith('/chat/completions')) {
        const auth = init.headers.Authorization
        sends.push(auth)
        return auth === 'Bearer b-new' ? sse(frame({ content: 'refreshed-ok' })) : new Response('{}', { status: 401 })
      }
      throw new Error(`unexpected offline request: ${url}`)
    }
    const chunks = await collect(adapters.get('raccoon').stream({ ...options, provider: 'raccoon' }))
    assert.deepEqual(refreshes, ['refresh-b'], 'refresh uses the actual model-filtered account')
    assert.deepEqual(sends, ['Bearer b', 'Bearer b-new'])
    assert.ok(chunks.some(row => row.type === 'text-delta' && row.text === 'refreshed-ok'))
    assert.equal(JSON.parse(creds.get('AUDIT_raccoon_a').value).access_token, 'a')
    creds.set('AUDIT_raccoon_b', { value: JSON.stringify({ ...credential('b'), expires_at: String(Date.now() - 1000) }) })
    refreshes.length = 0
    sends.length = 0
    await collect(adapters.get('raccoon').stream({ ...options, provider: 'raccoon' }))
    assert.deepEqual(refreshes, ['refresh-b'], 'expired credentials refresh B before sending')
    assert.deepEqual(sends, ['Bearer b-new'])
    console.log('ok  source wiring: qoder/qodercn/raccoon/loomy quota is not missing credentials; expiry and 401 refresh target B')
    await ctx.accountPool.clearModelRateLimits('audit-loomy-a')
    await ctx.accountPool.clearModelRateLimits('audit-loomy-b')
    await ctx.accountPool.setPermanentLocked('loomy', true)
    const loomySends = []
    auditFetch = async (input, init) => {
      const url = String(input)
      const token = new Headers(init?.headers).get('token')
      if (url.includes('/points/records')) {
        return Response.json({ code: '000000', data: {
          balance: token === 'b' ? 100 : 0, dailyBalance: token === 'a' ? 100 : 0, availableBalance: 100,
        } })
      }
      if (url.endsWith('/models')) return Response.json({ code: '000000', data: [] })
      if (url.endsWith('/chat/completions')) {
        loomySends.push(token)
        return token === 'a' ? new Response('{"message":"积分不足"}', { status: 402 }) : sse(frame({ content: 'loomy-ok' }))
      }
      throw new Error(`unexpected offline request: ${url}`)
    }
    await assert.rejects(collect(adapters.get('loomy').stream({ ...options, provider: 'loomy' })), { code: 'QUOTA_EXCEEDED' })
    assert.deepEqual(loomySends, ['a'], 'rotation must not consume locked permanent credits on B')
    await ctx.accountPool.setPermanentLocked('loomy', false)
    await collect(adapters.get('loomy').stream({ ...options, provider: 'loomy' }))
    assert.deepEqual(loomySends, ['a', 'b'], 'unlocked B remains usable while A is limited')
    console.log('ok  source loomy wiring: rotation preserves permanent-credit locks and model cooldowns')
  } finally {
    auditFetch = undefined
    globalThis.fetch = originalFetch
    await ctx.accountPool.setPermanentLocked('loomy', false)
    for (const { accountId, ref } of added) { await ctx.accountPool.removeAccount(accountId); creds.delete(ref) }
  }
}

async function verifyLoopResumeEvents() {
  const { installLoopResume } = await import('../vendor/channel-pack/src/loop-recovery.ts')
  const savedFlag = process.env.DSH_REASONING_LOOP_AUTO_RESUME
  const savedMax = process.env.DSH_REASONING_LOOP_AUTO_RESUME_MAX
  process.env.DSH_REASONING_LOOP_AUTO_RESUME = '1'
  process.env.DSH_REASONING_LOOP_AUTO_RESUME_MAX = '2'
  const flush = () => new Promise(resolve => queueMicrotask(resolve))
  try {
    for (const order of ['plugin-first', 'host-first']) {
      for (const action of ['resume-stop', 'input', 'pending-inbox', 'queued-next-turn', 'queued-next-step', 'modern-empty',
        'abort', 'abort-before-idle', 'completed', 'other-error', 'new-turn',
        'discarded', 'canceled-splice', 'agent-dispose', 'scope-dispose', 'replaced-agent', 'budget']) {
        const ctx = new RealContext()
        const statuses = [], delivered = []
        let withoutInitiator = 0
        ctx.provide('agents', { withoutInitiator(run) { withoutInitiator++; return run() } })
        ctx.on('api-session/status', (_id, running) => statuses.push(running))
        const forward = () => ctx.on('agent/status', ({ agent, status }) => ctx.emit('api-session/status', agent.id, status === 'running'))
        if (order === 'host-first') forward()
        const fiber = ctx.plugin(scope => installLoopResume(scope))
        await new Promise(resolve => setImmediate(resolve))
        if (order === 'plugin-first') forward()
        const makeAgent = () => {
          const agent = {
            id: 'fixture-loop-agent', session: { id: 'fixture-loop-agent' }, status: 'running',
            inbox: { hasPending: false },
            followup(message) {
              assert.equal(agent.status, 'idle')
              delivered.push({ agent, message })
              ctx.emit('agent/inbox/inserted', { agent, message })
              ctx.emit('session/event', agent.session, { type: 'turn/start', data: { turn: delivered.length + 1 } })
              agent.status = 'running'
              ctx.emit('agent/status', { agent, status: 'running' })
            },
            cancel() {
              ctx.emit('session/event', agent.session, { type: 'agent/inbox/spliced', data: { outcome: 'canceled' } })
              ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } } })
              agent.status = 'idle'
              ctx.emit('agent/status', { agent, status: 'idle' })
            },
          }
          return agent
        }
        const agent = makeAgent()
        const failAndIdle = target => {
          target.status = 'running'
          ctx.emit('agent/error', { agent: target, error: { code: 'REASONING_LOOP' }, turn: 1, step: 1 })
          ctx.emit('session/event', target.session, {
            type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'REASONING_LOOP' } } },
          })
          if (action === 'abort-before-idle') {
            ctx.emit('session/event', target.session, {
              type: 'turn/end', data: { reason: { kind: 'aborted', reason: { kind: 'user' } } },
            })
          }
          target.status = 'idle'
          ctx.emit('agent/status', { agent: target, status: 'idle' })
        }
        try {
          failAndIdle(agent)
          assert.equal(delivered.length, 0, 'followup never reenters synchronous idle dispatch')
          if (action === 'input') {
            agent.inbox.hasPending = true
            ctx.emit('agent/inbox/inserted', { agent, message: { id: 'human-input' } })
          } else if (action === 'pending-inbox') agent.inbox.hasPending = true
          else if (action === 'queued-next-turn') agent.inbox = { nextTurn: [{ id: 'human-turn' }], nextStep: [] }
          else if (action === 'queued-next-step') agent.inbox = { nextTurn: [], nextStep: [{ id: 'human-step' }] }
          else if (action === 'modern-empty') agent.inbox = { nextTurn: [], nextStep: [] }
          else if (action === 'abort') agent.cancel()
          else if (action === 'completed') ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          else if (action === 'other-error') ctx.emit('agent/error', { agent, error: { code: 'TRANSPORT' } })
          else if (action === 'new-turn') {
            agent.status = 'running'
            ctx.emit('agent/status', { agent, status: 'running' })
            agent.status = 'idle'
            ctx.emit('agent/status', { agent, status: 'idle' })
          } else if (action === 'discarded') ctx.emit('agent/inbox/discarded', { agent, message: { id: 'discarded' } })
          else if (action === 'canceled-splice') ctx.emit('session/event', agent.session, { type: 'agent/inbox/spliced', data: { outcome: 'canceled' } })
          else if (action === 'agent-dispose') {
            ctx.emit('agent/disposed', { agent })
            failAndIdle(agent)
          } else if (action === 'scope-dispose') {
            await fiber.dispose()
          } else if (action === 'replaced-agent') {
            ctx.emit('agent/disposed', { agent })
            const replacement = makeAgent()
            failAndIdle(replacement)
            ctx.emit('agent/inbox/inserted', { agent, message: { id: 'stale-old-agent-input' } })
            ctx.emit('session/event', agent.session, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
          }
          await flush()
          if (action === 'resume-stop' || action === 'budget' || action === 'replaced-agent' || action === 'modern-empty') {
            assert.equal(delivered.length, 1, `${order}/${action}`)
            assert.deepEqual(statuses.slice(-2), [false, true], 'host sees idle then running, never stale idle last')
            assert.equal(withoutInitiator, 1)
            if (action === 'replaced-agent') assert.notEqual(delivered[0].agent, agent)
            if (action === 'resume-stop') {
              agent.cancel()
              await flush()
              assert.equal(delivered.length, 1, 'user stop does not restart recovery')
              assert.equal(statuses.at(-1), false)
            } else if (action === 'budget') {
              failAndIdle(agent)
              await flush()
              assert.equal(delivered.length, 2)
              failAndIdle(agent)
              await flush()
              assert.equal(delivered.length, 2, 'self-inserted messages preserve the consecutive budget')
            }
          } else assert.equal(delivered.length, 0, `${order}/${action}: terminal/input/disposal invalidates queued recovery`)
        } finally {
          await fiber.dispose()
        }
      }
    }
    console.log('ok  source loop recovery: real Cordis listener ordering, user stop, terminal events, new turns, disposal and replacement')
  } finally {
    if (savedFlag === undefined) delete process.env.DSH_REASONING_LOOP_AUTO_RESUME
    else process.env.DSH_REASONING_LOOP_AUTO_RESUME = savedFlag
    if (savedMax === undefined) delete process.env.DSH_REASONING_LOOP_AUTO_RESUME_MAX
    else process.env.DSH_REASONING_LOOP_AUTO_RESUME_MAX = savedMax
  }
}
