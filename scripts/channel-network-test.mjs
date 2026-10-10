/** 渠道代理与真实 OAuth 生命周期回归；只使用隔离凭据、本机服务器和请求替身。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier.startsWith('@deepseek-ai/') ? { url: kernel, shortCircuit: true } : next(specifier, context)
} })
const packAt = process.argv.indexOf('--pack')
const pack = await import(packAt >= 0 ? pathToFileURL(path.resolve(process.argv[packAt + 1])).href : '../vendor/channel-pack/pack.js')
const savedFetch = globalThis.fetch
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
const windows = server => `ProxyEnable    REG_DWORD    0x1\nProxyServer    REG_SZ    ${server}\nProxyOverride    REG_SZ    *.internal;<local>;127.*`
let checks = 0
async function check(name, run) { await run(); checks++; console.log(`ok  ${name}`) }

try {
  if (!process.argv.includes('--oauth-only')) {
    const { createChannelFetch, parseWindowsProxy, channelProxyBypassed } = pack
    await check('Windows 手动代理、按协议代理和例外规则', async () => {
      assert.equal(parseWindowsProxy('ProxyEnable REG_DWORD 0x0\nProxyServer REG_SZ proxy:80'), undefined)
      assert.equal(parseWindowsProxy('AutoConfigURL REG_SZ https://example.invalid/proxy.pac'), undefined)
      assert.equal(parseWindowsProxy(windows('127.0.0.1:7890')).server, '127.0.0.1:7890')
      for (const [url, pattern, win, expected] of [
        ['https://www.googleapis.com', '.googleapis.com', false, true],
        ['https://www.googleapis.com', 'googleapis.com:80', false, false],
        ['https://notgoogleapis.com', '.googleapis.com', false, false],
        ['https://www.googleapis.com', '*', false, true],
        ['https://a.internal', '*.internal', true, true],
        ['http://intranet', '<local>', true, true],
        ['https://accounts.google.com', '<local>', true, false],
      ]) assert.equal(channelProxyBypassed(new URL(url), pattern, win), expected, `${url} / ${pattern}`)
    })
    await check('代理优先级、系统配置缓存、本机旁路及逐请求参数保留', async () => {
      const seen = [], created = [], closed = []
      let outlet = true, reads = 0
      const env = { HTTPS_PROXY: 'http://environment.invalid:7890' }
      const network = createChannelFetch({
        environment: env, platform: 'win32',
        readSystemProxy: async () => { reads++; return windows('http=system-http.invalid:80;https=system-https.invalid:443') },
        outlet: { active: () => outlet, fetch: async (url, init) => { seen.push({ route: 'outlet', url, init }); return new Response('outlet') } },
        fetchImpl: async (url, init) => { seen.push({ route: 'fetch', url, init }); return new Response('ok') },
        dispatcherFor: proxy => { created.push(proxy.url); return { destroy: async () => { closed.push(proxy.url) } } },
      })
      try {
        const signal = new AbortController().signal
        const init = { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: 'grant_type=fixture', signal }
        await network.fetch('https://oauth2.googleapis.com/token', init)
        assert.equal(seen.at(-1).route, 'outlet')
        assert.equal(seen.at(-1).init.signal, signal)
        assert.equal(seen.at(-1).init.body, init.body)
        assert.equal(seen.at(-1).init.headers.authorization, init.headers.authorization)
        assert.equal(reads, 0)
        outlet = false
        await network.fetch('https://oauth2.googleapis.com/token', init)
        assert.deepEqual(created, ['http://environment.invalid:7890'])
        assert.equal(seen.at(-1).init.signal, signal)
        assert.equal(reads, 0)
        env.NO_PROXY = '.googleapis.com'
        await network.fetch('https://oauth2.googleapis.com/token')
        assert.equal(seen.at(-1).init?.dispatcher, undefined)
        assert.equal(reads, 0, '环境例外不应退回系统代理')
        delete env.HTTPS_PROXY
        delete env.NO_PROXY
        await network.fetch('https://oauth2.googleapis.com/token')
        await network.fetch('http://accounts.google.com/token')
        assert.deepEqual(created.slice(1), ['http://system-https.invalid:443', 'http://system-http.invalid:80'])
        await network.fetch('https://a.internal/token')
        assert.equal(seen.at(-1).init?.dispatcher, undefined)
        assert.equal(reads, 1)
        outlet = true
        for (const url of ['http://localhost:1234', 'http://127.0.0.1:1234', 'http://[::1]:1234']) {
          await network.fetch(url)
          assert.equal(seen.at(-1).route, 'fetch')
          assert.equal(seen.at(-1).init?.dispatcher, undefined)
        }
      } finally { await network.close() }
      assert.equal(closed.length, created.length)
      await assert.rejects(network.fetch('https://oauth2.googleapis.com/token'), /已停止/)
    })
    await check('网络原因保留、凭据脱敏、失败不直连回退和取消', async () => {
      let calls = 0
      const network = createChannelFetch({
        environment: { HTTPS_PROXY: 'http://proxy-user:proxy-password@proxy.invalid:7890' },
        fetchImpl: async () => { calls++; throw new TypeError('secret-token', { cause: Object.assign(new Error('proxy-password'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }) },
        dispatcherFor: () => ({ destroy: async () => {} }),
      })
      try {
        await assert.rejects(network.fetch('https://oauth2.googleapis.com/token'), error => {
          assert.match(error.message, /环境代理.*UND_ERR_CONNECT_TIMEOUT/)
          assert.doesNotMatch(error.message, /secret-token|proxy-password|proxy-user/)
          return true
        })
        assert.equal(calls, 1)
        const controller = new AbortController()
        controller.abort()
        await assert.rejects(network.fetch('https://oauth2.googleapis.com/token', { signal: controller.signal }), { name: 'AbortError' })
        assert.equal(calls, 1)
      } finally { await network.close() }
    })
    await check('真实 HTTP 代理传递 POST、请求头和响应，不解析目标 DNS', async () => {
      const sockets = new Set(), forwarded = [], requests = []
      const target = http.createServer(async (req, res) => {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        requests.push({ method: req.method, authorization: req.headers.authorization, body: Buffer.concat(chunks).toString() })
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ access_token: 'fixture-token' }))
      })
      const targetPort = await listen(target)
      const proxy = http.createServer((req, res) => {
        forwarded.push(req.url)
        const upstream = http.request({ hostname: '127.0.0.1', port: targetPort, path: new URL(req.url).pathname, method: req.method, headers: req.headers }, reply => {
          res.writeHead(reply.statusCode, reply.headers)
          reply.pipe(res)
        })
        upstream.on('error', () => res.destroy())
        req.pipe(upstream)
      })
      proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
      const proxyPort = await listen(proxy)
      const network = createChannelFetch({ environment: {}, platform: 'win32', readSystemProxy: async () => windows(`127.0.0.1:${proxyPort}`) })
      try {
        const response = await network.fetch('http://oauth-fixture.invalid/token', {
          method: 'POST', headers: { authorization: 'Bearer fixture-auth' }, body: 'code=fixture-code', signal: AbortSignal.timeout(3000),
        })
        assert.equal((await response.json()).access_token, 'fixture-token')
        assert.deepEqual(forwarded, ['http://oauth-fixture.invalid/token'])
        assert.deepEqual(requests, [{ method: 'POST', authorization: 'Bearer fixture-auth', body: 'code=fixture-code' }])
      } finally {
        await network.close()
        for (const socket of sockets) socket.destroy()
        await Promise.all([new Promise(resolve => target.close(resolve)), new Promise(resolve => proxy.close(resolve))])
      }
    })
  }

  const products = [pack]
  if (packAt < 0) products.push(await import('../packages/standalone/channels/business.mjs'))
  for (const [productIndex, product] of products.entries()) await check(`${productIndex === 0 ? '插件' : '独立端'}实际渠道包：OAuth 落定、续期、项目探测与推理共用代理`, async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-network-'))
    const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'all_proxy', 'DSH_HOME', 'DSH_CHANNEL_PACK_STATE_DIR', 'DSH_OPENAI_GATEWAY_ENABLED', 'QODER_RUNTIME_INFO', 'QODER_MACHINE_TOKEN_PATH']
    const savedEnv = Object.fromEntries(keys.map(key => [key, process.env[key]]))
    for (const key of keys) delete process.env[key]
    process.env.HTTPS_PROXY = 'http://fixture-proxy.invalid:7890'
    process.env.DSH_HOME = scratch
    process.env.DSH_CHANNEL_PACK_STATE_DIR = scratch
    process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
    process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime.exe')
    process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'missing-token.json')
    const creds = new Map(), routes = [], dispose = [], seen = [], warnings = [], adapters = new Map()
    let transportCode
    const ctx = {
      profileContext: { home: scratch },
      platform: { channelHome: scratch },
      credentials: {
        resolve: async ref => creds.has(ref) ? { value: creds.get(ref) } : undefined,
        describe: async () => undefined,
        set: async (ref, value) => { creds.set(ref, value) }, unset: async ref => { creds.delete(ref) },
      },
      logger: { info() {}, warn: message => warnings.push(message), error() {} },
      llm: { registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) }, listProviders: () => [] },
      connection: { fetch: { register: route => routes.push(route) } },
      get(name) { return this[name] }, provide(name, value) { this[name] = value },
      effect(body) { const cleanup = body(); if (typeof cleanup === 'function') dispose.push(cleanup) },
      inject(names, body) { if (names.every(name => this[name] !== undefined)) body(this) }, emit() {},
    }
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://oauth2.googleapis.com/token' || url === 'https://www.googleapis.com/oauth2/v2/userinfo') {
        if (!init?.dispatcher) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture direct connection blocked'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) })
        if (transportCode) throw new TypeError('fetch failed', { cause: Object.assign(new Error('fixture network failure'), { code: transportCode }) })
        seen.push({ url, body: init.body })
        return Response.json(url.includes('/token') ? { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: 3600, token_type: 'Bearer' } : { id: 'fixture-sub', email: 'fixture@example.invalid' })
      }
      if (url.includes(':loadCodeAssist') || url.includes(':streamGenerateContent')) {
        assert.ok(init?.dispatcher, 'Gemini 项目探测与推理必须携带代理')
        seen.push({ url, body: init.body })
        if (url.includes(':loadCodeAssist')) return Response.json({ cloudaicompanionProject: 'fixture-project' })
        return new Response(`data: ${JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'gemini-proxy-ok' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      }
      if (url === 'https://api.cline.bot/api/v1/auth/refresh' || url === 'https://api.workos.com/user_management/authorize/device') {
        assert.ok(init?.dispatcher, 'Cline 登录与续期必须携带代理')
        seen.push({ url, body: init.body })
        return Response.json(url.includes('/refresh')
          ? { success: true, data: { accessToken: 'workos:fixture-new', refreshToken: 'fixture-refresh', expiresAt: new Date(Date.now() + 3600000).toISOString() } }
          : { device_code: 'fixture-device', user_code: 'FIXTURE', verification_uri: 'https://example.invalid/login', expires_in: 300, interval: 5 })
      }
      throw new Error('离线测试禁止外部请求')
    }
    try {
      product.apply(ctx, { disableOpencode: true })
      const route = routes.find(row => row.path === '/api/channel-pack')
      const rpc = async (method, payload) => {
        const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'network-test', method: 'channel-pack', payload: { method, payload } }),
        }))
        const body = (await response.json()).result
        assert.equal(body.ok, true, JSON.stringify(body.error))
        return body.value
      }
      const started = await rpc('account.create', { provider: 'gemini' })
      const auth = new URL(started.loginUrl)
      const callback = new URL(auth.searchParams.get('redirect_uri'))
      callback.searchParams.set('state', auth.searchParams.get('state'))
      callback.searchParams.set('code', 'fixture-code')
      assert.equal((await savedFetch(callback)).status, 200)
      let result
      for (let i = 0; i < 100; i++) {
        result = await rpc('login.poll', { accountId: started.accountId, provider: 'gemini' })
        if (result.done) break
        await new Promise(resolve => setTimeout(resolve, 10))
      }
      assert.equal(result.success, true, `授权未落定：${JSON.stringify(result)}`)
      const account = ctx.accountPool.listAccountsByProvider('gemini').find(row => row.id === started.accountId)
      assert.ok(account)
      const credential = JSON.parse(creds.get(account.credentialRef))
      assert.equal(credential.access_token, 'fixture-access')
      assert.equal(credential.email, 'fixture@example.invalid')
      await ctx.geminiAuth.refreshAccountCredential(account.credentialRef, ctx.accountPool, account.id)
      assert.equal(seen.filter(row => row.url.includes('/token')).length, 2)
      assert.match(seen.at(-1).body, /grant_type=refresh_token/)
      assert.equal(warnings.some(row => row.includes('background gemini login failed')), false)
      const adapter = adapters.get('gemini')
      const model = adapter.listAllModels()[0].id
      const chunks = []
      for await (const chunk of adapter.stream({ provider: 'gemini', model, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })) chunks.push(chunk)
      assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'gemini-proxy-ok'))
      assert.ok(seen.some(row => row.url.includes(':loadCodeAssist')))
      assert.ok(seen.some(row => row.url.includes(':streamGenerateContent')))
      creds.set('CLINE_FIXTURE', JSON.stringify({ access_token: 'workos:fixture-old', refresh_token: 'fixture-refresh', expire_time: Date.now() + 60000 }))
      await ctx.clineAuth.refreshAccountCredential('CLINE_FIXTURE')
      assert.equal(JSON.parse(creds.get('CLINE_FIXTURE')).access_token, 'workos:fixture-new')
      const clineLogin = await ctx.clineAuth.startLogin()
      assert.equal(clineLogin.loginUrl, 'https://example.invalid/login')
      await clineLogin.close()
      await clineLogin.result.catch(() => {})
      transportCode = 'CERT_HAS_EXPIRED'
      const savedCredential = creds.get(account.credentialRef)
      await assert.rejects(ctx.geminiAuth.refreshAccountCredential(account.credentialRef), error => {
        assert.equal(error.name, 'ChannelNetworkError', '网络证书问题不能废弃账号 refresh_token')
        assert.match(error.message, /CERT_HAS_EXPIRED/)
        return true
      })
      assert.equal(creds.get(account.credentialRef), savedCredential)
    } finally {
      for (const cleanup of dispose.reverse()) await cleanup()
      globalThis.fetch = savedFetch
      for (const key of keys) {
        if (savedEnv[key] === undefined) delete process.env[key]
        else process.env[key] = savedEnv[key]
      }
      fs.rmSync(scratch, { recursive: true, force: true })
    }
  })
  console.log(`channel-network: ${checks}/${checks} 项通过`)
} finally {
  globalThis.fetch = savedFetch
  hooks.deregister()
}
