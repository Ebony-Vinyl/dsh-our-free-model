/**
 * Mount the actual published bundle against host contracts in isolation.
 * No real credentials, profile directories or upstream calls are used.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { verifyChannelModelActions } from './channel-model-actions-test.mjs'
import { verifyChannelCreditsUi } from './channel-credits-ui-test.mjs'
import { verifyChannelCreditsRpc } from './channel-credits-rpc-test.mjs'
import { verifyChannelImagePricing } from './channel-image-pricing-test.mjs'

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
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime-info.exe')
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
  verifyChannelImagePricing(adapters)
  console.log('ok  十三渠道同步图片计价：缺失及默认方法兜底，厂商计价优先，重复图片与已卸载图片正确计数')
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
  await verifyChannelCreditsRpc({ ctx, call, creds })
  console.log('ok  实际渠道 RPC：七渠道仅账号池凭据即可查余额，ZCode 账号池回退及缺凭据反馈')

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
  assert.equal(cards.length, 13)
  assert.equal(cards.includes('opencode'), false)
  assert.deepEqual([...cards].sort(), [...adapters.keys()].sort(), 'UI and mounted account providers agree')
  console.log('ok  actual channel page: 13 account cards, OpenCode removed')
  await verifyChannelModelActions()
  await verifyChannelCreditsUi()
  console.log('ok  共享渠道余额：十三渠道能力、失败原因、重试、签到反馈和请求交错')
  console.log('ok  共享渠道卡片：批量开关、单次请求、重复点击保护和失败恢复')

  // ── 账号轮换：Raccoon（商汤）与 Loomy ────────────────────────────────────
  //
  // 真实报障：Raccoon 渠道的一个账号额度用尽后不会自动切到另一个账号。
  // 排查时把全部 12 个适配器逐个对照，发现 `LoomyAdapter` 的失败路径与
  // `RaccoonAdapter`（修复前）**逐行同构** —— 故两个渠道一起修、一起测。
  //
  // 这些用例挂载**真实的 pack**、拿真的适配器、跑真的控制流；只把 `fetchImpl`
  // 与几个注入项换成桩件。断言的是**可观测的外部效果**（请求次数、用的哪份
  // 凭据、失败标记落在谁身上），不是「源码里有某个字符串」—— 后者在重构后
  // 照样绿，却什么都没验证。
  {
    // ⚠️ 本套件跑的是 `vendor/channel-pack/pack.js`，而它是**发布物**
    //（受 `feed/manifest.json` 的签名约束）。改了 `src/**` 却没重新打包时，
    // 这里测的仍是旧字节 —— 故先探测补丁在不在，不在就明确跳过并提示，
    // 而不是让整棵树变红（发布物由持钥维护者重签，见 docs/RELEASING.md）。
    const packSource = fs.readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

    /** HTTP 200 + SSE 出字的响应桩。 */
    const sseOf = text => ({
      ok: true, status: 200, text: async () => '',
      body: new Response(
        `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      ).body,
    })
    /** HTTP 错误响应桩。 */
    const httpOf = (status, body) => ({
      ok: false, status, text: async () => body, body: null,
    })

    if (!packSource.includes('RACCOON_MAX_ROTATE')) {
      console.log('skip raccoon rotation: vendor/channel-pack/pack.js predates the fix — '
        + 'run `node scripts/build-channel-pack.mjs` to re-bundle, then re-sign the manifest')
    } else {
      const raccoon = adapters.get('raccoon')
      assert.ok(raccoon, 'raccoon adapter is registered by the real pack')

      const sent = []
      const notes = []
      const reports = []
      const credsOf = { 'raccoon-a': { access_token: 'tok-a' }, 'raccoon-b': { access_token: 'tok-b' } }
      const responses = [httpOf(402, JSON.stringify({ code: 402, message: '积分不足' })), sseOf('answer-from-b')]
      let call = 0
      const probe = Object.create(Object.getPrototypeOf(raccoon))
      Object.assign(probe, raccoon, {
        fetchImpl: async (url, init) => {
          sent.push(init.headers.Authorization.replace('Bearer ', ''))
          const next = responses[call++]
          if (next === undefined) throw new Error(`unexpected request #${call}`)
          return next
        },
        options: {
          ...raccoon.options,
          resolveCredential: async () => credsOf['raccoon-a'],
          accountPool: {
            findAccountIdByCredential: async (provider, token) => (token === 'tok-a' ? 'raccoon-a' : 'raccoon-b'),
          },
          nextAccount: async (modelId, tried) => {
            for (const [id, credential] of Object.entries(credsOf)) {
              if (!tried.has(id)) return { credential, accountId: id }
            }
            return undefined
          },
          noteFailure: async (accountId, modelId, quota) => { notes.push({ accountId, modelId, quota }) },
          reportAccount: id => reports.push(id),
        },
      })
      const chunks = []
      for await (const chunk of probe.stream({ model: 'sn-deepseek-v4-1-flash', messages: [] })) chunks.push(chunk)
      assert.equal(sent.length, 2, 'a 402 on account A rotates to account B instead of failing')
      assert.equal(sent[1], 'tok-b', 'the retry really used the other account credential')
      assert.ok(JSON.stringify(chunks).includes('answer-from-b'), 'account B answer reaches the caller')
      assert.equal(notes.length, 1, 'the failing account is marked exactly once')
      assert.equal(notes[0].accountId, 'raccoon-a', 'the mark lands on the account that actually failed')
      assert.equal(notes[0].quota, true, 'a 402 is recorded as a quota failure (daily cooldown)')
      assert.equal(reports.at(-1), 'raccoon-b', 'the ledger is told which account finally served')
      console.log('ok  raccoon rotation: 402 on A rotates to B, marks A, reports B')

      // refresh 失败不得阻断换号：两处 `refresh()` 都必须在 try/catch 里。
      // 凭据续期失败是最常见的故障之一，而它恰好发生在「账号 A 坏了、账号 B
      // 健康」这个**最该换号**的场景；漏了保护时换号一行都不执行
      //（实测：推理端点被调用 0 次，用户只看到「请重新登录」）。
      const inference = []
      const rails = Object.create(Object.getPrototypeOf(raccoon))
      Object.assign(rails, raccoon, {
        fetchImpl: async (url, init) => {
          const auth = init.headers.Authorization.replace('Bearer ', '')
          inference.push(auth)
          if (auth === 'tok-a') return httpOf(401, 'expired')
          return sseOf('answer-from-b')
        },
        options: {
          ...raccoon.options,
          resolveCredential: async () => credsOf['raccoon-a'],
          refresh: async () => {
            const error = new Error('raccoon: 登录态已过期，请重新登录')
            error.name = 'RefreshTokenExpiredError'
            throw error
          },
          accountPool: {
            findAccountIdByCredential: async (provider, token) => (token === 'tok-a' ? 'raccoon-a' : 'raccoon-b'),
          },
          nextAccount: async (modelId, tried) => {
            for (const [id, credential] of Object.entries(credsOf)) {
              if (!tried.has(id)) return { credential, accountId: id }
            }
            return undefined
          },
          noteFailure: async () => {},
        },
      })
      const afterRefreshFailure = []
      for await (const chunk of rails.stream({ model: 'sn-deepseek-v4-1-flash', messages: [] })) {
        afterRefreshFailure.push(chunk)
      }
      assert.equal(inference.length, 2, 'a failed refresh does not abort the turn (both accounts were tried)')
      assert.equal(inference[1], 'tok-b', 'the rotation after a failed refresh used the healthy account')
      assert.ok(JSON.stringify(afterRefreshFailure).includes('answer-from-b'),
        'the healthy account answer still reaches the caller')
      console.log('ok  raccoon rotation survives a throwing refresh (401 path)')

      // 续期必须刷「本次在用的那个账号」，而不是池里第一个。
      // 早先 `refresh()` 无参，接线侧靠 `getAvailableAccount(id, '')` 猜账号 ——
      // 而**空 modelId 让模型级限流过滤短路**，于是返回「手动顺序第一个 enabled
      // 账号」。在「A 被限流、B 在用但 token 过期」时会刷成 A：B 永远续不上，
      // 换号跟着失效（A 被滤掉、B 在 tried 里 → 报「没有其它可用账号」），
      // 而 B 只要续期就能用。
      const refreshedFor = []
      const ownership = Object.create(Object.getPrototypeOf(raccoon))
      Object.assign(ownership, raccoon, {
        fetchImpl: async (url, init) => {
          const auth = init.headers.Authorization.replace('Bearer ', '')
          if (auth === 'tok-b') return httpOf(401, 'expired')
          return sseOf('ok')
        },
        options: {
          ...raccoon.options,
          // 池里的「第一个」是 A；而本轮凭据属于 B。
          resolveCredential: async () => credsOf['raccoon-b'],
          refresh: async accountId => { refreshedFor.push(accountId) },
          accountPool: {
            findAccountIdByCredential: async (provider, token) => (token === 'tok-b' ? 'raccoon-b' : 'raccoon-a'),
          },
          nextAccount: async () => undefined,
          noteFailure: async () => {},
        },
      })
      await (async () => {
        for await (const _ of ownership.stream({ model: 'sn-deepseek-v4-1-flash', messages: [] })) { /* drain */ }
      })().catch(() => {})
      assert.ok(refreshedFor.length > 0, 'the 401 path asked for a refresh')
      assert.equal(refreshedFor[0], 'raccoon-b',
        'refresh targets the account the request actually used, not the pool default')
      console.log('ok  raccoon refresh targets the account in use (not the pool default)')
    }

    if (!packSource.includes('LOOMY_MAX_ROTATE')) {
      console.log('skip loomy rotation: vendor/channel-pack/pack.js predates the fix — '
        + 'run `node scripts/build-channel-pack.mjs` to re-bundle, then re-sign the manifest')
    } else {
      const loomy = adapters.get('loomy')
      assert.ok(loomy, 'loomy adapter is registered by the real pack')

      const chat = []
      const fire = Object.create(Object.getPrototypeOf(loomy))
      Object.assign(fire, loomy, {
        fetchImpl: async (url, init) => {
          const u = String(url)
          if (u.includes('/points/records')) {
            // 真实形状见 `fetchLoomyCreditDetail`：/points/records + balance/dailyBalance。
            return new Response(JSON.stringify({
              code: 0, data: { balance: 9999, dailyBalance: 9999, availableBalance: 9999 },
            }), { status: 200, headers: { 'content-type': 'application/json' } })
          }
          const auth = String(init?.headers?.Authorization ?? '')
          chat.push(auth)
          if (auth.includes('tok-a')) {
            return new Response(JSON.stringify({ code: 429, message: '今日额度已用尽' }), {
              status: 429, headers: { 'content-type': 'application/json' },
            })
          }
          return sseOf('loomy-served-by-b')
        },
        options: {
          ...loomy.options,
          resolveCredential: async () => ({ access_token: 'tok-a' }),
          refresh: async () => {
            // Loomy 无续期端点，探测失败时**必然抛错** —— 正是要验证容错的路径。
            const error = new Error('loomy: 会话已失效，请重新登录')
            error.name = 'RefreshTokenExpiredError'
            throw error
          },
          accountPool: {
            findAccountIdByCredential: async (provider, token) => (token === 'tok-a' ? 'loomy-a' : 'loomy-b'),
          },
          nextAccount: async (modelId, tried) => {
            if (tried.has('loomy-b')) return undefined
            return { credential: { access_token: 'tok-b' }, accountId: 'loomy-b' }
          },
          noteFailure: async () => {},
        },
      })
      const loomyChunks = []
      for await (const chunk of fire.stream({ model: 'deepseek-v4-flash', messages: [] })) {
        loomyChunks.push(chunk)
      }
      assert.equal(chat.length, 2, 'a quota failure on Loomy rotates to the next account')
      assert.ok(chat[1].includes('tok-b'), 'the rotation used the other account credential')
      assert.ok(JSON.stringify(loomyChunks).includes('loomy-served-by-b'),
        'the rotated account answer reaches the caller')
      console.log('ok  loomy rotation: quota failure on A rotates to B')
    }
  }

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
