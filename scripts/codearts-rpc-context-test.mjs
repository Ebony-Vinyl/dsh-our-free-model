/** 直接挂载源码并调用真实 RPC；签名请求只通过两个本机模拟出口发送。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const ts = (await import('typescript')).default
const llmKernel = 'data:text/javascript,' + encodeURIComponent(
  'export * from ' + JSON.stringify(kernel) + ';' +
  'export class LlmError extends Error { constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status } }',
)
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-llm') return { url: llmKernel, shortCircuit: true }
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: fileURLToPath(url),
      }).outputText,
    }
    return next(url, context)
  },
})
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-codearts-rpc-context-'))
const savedEnvironment = new Map(['DSH_CHANNEL_PACK_STATE_DIR', 'DSH_HOME', 'DSH_OPENAI_GATEWAY_ENABLED', 'CODEARTS_MODELS_CACHE_DIR', 'QODER_MACHINE_TOKEN_PATH', 'QODER_RUNTIME_INFO'].map(key => [key, process.env[key]]))
delete process.env.DSH_CHANNEL_PACK_STATE_DIR
process.env.DSH_HOME = scratch
process.env.CODEARTS_MODELS_CACHE_DIR = scratch
process.env.DSH_OPENAI_GATEWAY_ENABLED = '0'
process.env.QODER_MACHINE_TOKEN_PATH = path.join(scratch, 'missing-machine-token.json')
process.env.QODER_RUNTIME_INFO = path.join(scratch, 'missing-runtime.exe')
const savedFetch = globalThis.fetch
let globalCalls = 0, defaultCalls = 0, checks = 0
const sockets = new Set(), lanes = [], hosts = [], releases = [], networks = []
const hash = value => createHash('sha256').update(value).digest('hex')
const snapHost = 'snap-access.cn-north-4.myhuaweicloud.com'
const infoPath = '/snap-manager/v1/statistics/plugin'
const deliveryPath = '/v1/ops/delivery'
const claimPath = '/v1/ops/claim'
const confirmPath = '/v1/ops/confirm'
const info = balance => ({ package: { is_credit_package: true }, metrics: [
  { name: 'usageTotalPackageCredit', package_credit_amount: balance, package_credit_remain: balance, package_credit_used: 0 },
] })
const timeout = async (pending, name) => {
  let timer
  try { return await Promise.race([pending, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ': timed out')), 5000) })]) }
  finally { clearTimeout(timer) }
}
const check = async (name, run) => { await timeout(run(), name); checks++; console.log('ok  ' + name) }

// 独立验证实际收到的签名字节。转发仅更换连接地址，签名中的 host 仍为原上游。
function verifySignature(req, body, credential) {
  const match = /^SDK-HMAC-SHA256 Access=([^,]+),SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')
  if (!match || match[1] !== credential.access_key_id || hash(body) !== req.headers['x-sdk-content-sha256']) return false
  const names = match[2].split(';'), url = new URL(req.url, 'https://' + snapHost)
  if (names.join(';') !== [...new Set(names)].sort().join(';')) return false
  const canonical = [req.method, url.pathname.replace(/\/?$/, '/'), url.search.slice(1),
    names.map(name => name + ':' + (name === 'host' ? snapHost : req.headers[name] ?? '')).join('\n'), '', match[2], hash(body)].join('\n')
  const expected = createHmac('sha256', credential.secret_access_key)
    .update('SDK-HMAC-SHA256\n' + req.headers['x-sdk-date'] + '\n' + hash(canonical)).digest('hex')
  return expected === match[3] && req.headers['x-security-token'] === credential.security_token
}

async function createLane(id, balance) {
  const credential = {
    access_key_id: 'FIXTURE_AK_' + id, secret_access_key: 'FIXTURE_SECRET_' + id,
    security_token: 'FIXTURE_TOKEN_' + id, expires_at: new Date(Date.now() + 3600000).toISOString(),
  }
  const lane = { id, balance, credential, seen: [], sent: [], hold: undefined }
  const server = http.createServer((req, res) => { void (async () => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks), pathname = new URL(req.url, 'https://' + snapHost).pathname
    const valid = verifySignature(req, body, credential)
    lane.seen.push({ pathname, valid, body: body.toString(), method: req.method })
    res.setHeader('content-type', 'application/json')
    if (!valid) { res.writeHead(401); res.end(JSON.stringify({ error_msg: 'wrong context or signature' })); return }
    if (lane.hold?.pathname === pathname) {
      res.once('close', lane.hold.closed)
      lane.hold.reached()
      return
    }
    if (pathname === infoPath) res.end(JSON.stringify(info(balance)))
    else if (pathname === deliveryPath) res.end(JSON.stringify({ code: 0, data: { items: [
      { campaignId: id, type: 'USER_LOGIN', claimable: true, status: 'AVAILABLE', benefitAmount: balance },
    ] } }))
    else if (pathname === claimPath || pathname === confirmPath) {
      const request = JSON.parse(body)
      assert.equal(request.campaignId, id)
      assert.equal(req.method, 'POST')
      if (pathname === claimPath) assert.equal(request.channel, 'IDE')
      res.end(JSON.stringify({ code: 0, data: { id: 'benefit-' + id, benefitAmount: balance } }))
    } else throw new Error('unexpected fixture path: ' + req.url)
  })().catch(error => { lane.failure = error; res.destroy(error) }) })
  lane.server = server
  lanes.push(lane)
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  lane.outlet = {
    active: () => true,
    fetch: async () => { throw new Error('ordinary outlet must not send signed requests') },
    fetchSigned(input, init, send) {
      const target = new URL(String(input))
      assert.equal(target.origin, 'https://' + snapHost, 'only signed fixture upstream requests are allowed')
      assert.equal(init.redirect, 'error')
      assert.ok(init.signal instanceof AbortSignal, 'upstream timeout/cancellation signal is retained')
      lane.sent.push({ pathname: target.pathname, signal: init.signal })
      return send('http://127.0.0.1:' + server.address().port + target.pathname + target.search, init)
    },
  }
  lane.arm = pathname => {
    let reached, closed
    const waiting = new Promise(resolve => { reached = resolve })
    const disconnected = new Promise(resolve => { closed = resolve })
    lane.hold = { pathname, reached, closed }
    return { waiting, disconnected }
  }
  return lane
}

function createHost(id) {
  const home = path.join(scratch, id), routes = [], disposers = [], creds = new Map(), adapters = new Map()
  fs.mkdirSync(path.join(home, 'channel-pack'), { recursive: true })
  fs.writeFileSync(path.join(home, 'channel-pack/auto-checkin.json'), JSON.stringify({ enabled: false }))
  const services = {
    profileContext: { home },
    credentials: {
      resolve: async ref => creds.get(ref), describe: async () => undefined,
      set: async (ref, value) => { creds.set(ref, { value }) }, unset: async ref => { creds.delete(ref) },
    },
    llm: {
      registerAdapter(providers, adapter) { for (const provider of providers) adapters.set(provider, adapter) },
      listProviders: () => [...adapters.keys()].map(provider => ({ id: provider })),
    },
    connection: { fetch: { register: route => { routes.push(route) } } },
  }
  const ctx = {
    ...services, logger: { info() {}, warn() {}, error() {} },
    get: name => services[name],
    provide(name, service) { services[name] = service; this[name] = service },
    effect(callback) { const cleanup = callback(); if (typeof cleanup === 'function') disposers.push(cleanup) },
    inject(names, callback) { if (names.every(name => services[name] !== undefined)) callback(this) },
    emit() {},
  }
  const host = {
    id, ctx, routes, creds,
    dispose() { for (const cleanup of disposers.splice(0).reverse()) cleanup() },
    async call(method, payload = { provider: 'codearts' }, signal, route = routes.find(row => row.path === '/api/channel-pack')) {
      assert.ok(route, 'real RPC endpoint registered')
      const response = await route.fetch(new Request('http://localhost/api/channel-pack', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal,
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture-' + id, method: 'channel-pack', payload: { method, payload } }),
      }))
      assert.equal(response.status, 200)
      return (await response.json()).result
    },
  }
  hosts.push(host)
  return host
}

async function expectBalance(host, balance, route) {
  const result = await host.call('credits.balances', undefined, undefined, route)
  assert.equal(result.ok, true)
  assert.equal(result.value.accounts.length, 1)
  assert.equal(result.value.accounts[0].balance?.total, balance, JSON.stringify(result))
}
async function expectClaim(host, credit, route) {
  const result = await host.call('credits.claimAll', undefined, undefined, route)
  assert.equal(result.ok, true)
  assert.equal(result.value.results.length, 1)
  assert.equal(result.value.results[0].outcome.kind, 'claimed', JSON.stringify(result))
  assert.equal(result.value.results[0].outcome.credit, credit)
}

try {
  globalThis.fetch = async () => { globalCalls++; throw new Error('global fetch must remain isolated') }
  const { apply } = await import('../vendor/channel-pack/src/index.ts')
  const { registerChannelPackRpc } = await import('../vendor/channel-pack/src/channel-pack-rpc.ts')
  const { attachDirectFetch, createDirectFetch } = await import('../vendor/channel-pack/src/direct-fetch.ts')
  const a = await createLane('A', 111), b = await createLane('B', 222)
  const first = createHost('first'), second = createHost('second')
  apply(first.ctx, { disableOpencode: true, outlet: a.outlet })
  apply(second.ctx, { disableOpencode: true, outlet: b.outlet })
  await new Promise(resolve => setImmediate(resolve))
  for (const [host, lane] of [[first, a], [second, b]]) {
    const ref = 'FIXTURE_RPC_' + lane.id
    host.creds.set(ref, { value: JSON.stringify(lane.credential) })
    await host.ctx.accountPool.addAccount({
      id: 'fixture-' + lane.id, provider: 'codearts', nickname: lane.id,
      credentialRef: ref, enabled: false, refreshable: false, createdAt: 1,
    })
  }
  await check('两个真实插件 RPC 保留末尾配置及 provider 位置参数', async () => {
    for (const host of [first, second]) {
      const disabled = await host.call('opencode.addAnonymous', {})
      assert.equal(disabled.error.code, 'provider-disabled')
      assert.ok(host.ctx.geminiAuth && host.ctx.zcodeAuth)
    }
  })
  await check('并发查询积分与完整签到流程分别走所属出口且独立验签通过', async () => {
    await Promise.all([expectBalance(first, a.balance), expectBalance(second, b.balance)])
    await Promise.all([expectClaim(first, a.balance), expectClaim(second, b.balance)])
    for (const lane of [a, b]) {
      assert.deepEqual(lane.seen.map(row => row.pathname), [infoPath, infoPath, deliveryPath, claimPath, confirmPath])
      assert.ok(lane.seen.every(row => row.valid))
    }
  })
  releases.push(attachDirectFetch(async () => { defaultCalls++; throw new Error('latest global lane must not handle context RPC') }))
  await check('后挂载的全局默认出口不能劫持任一上下文', async () => {
    await Promise.all([expectBalance(first, a.balance), expectClaim(first, a.balance), expectBalance(second, b.balance), expectClaim(second, b.balance)])
    assert.equal(defaultCalls, 0)
    assert.equal(globalCalls, 0)
  })
  await check('旧的位置参数调用省略新增配置时仍可使用默认签名出口', async () => {
    const network = createDirectFetch({ outlet: a.outlet, environment: {}, platform: 'linux' })
    networks.push(network)
    const detach = attachDirectFetch(network.fetch)
    try {
      const offset = first.routes.length
      const auths = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini'].map(provider => first.ctx[provider + 'Auth'])
      registerChannelPackRpc(first.ctx, first.ctx.accountPool, ...auths)
      const route = first.routes.slice(offset).find(row => row.path === '/api/channel-pack')
      assert.ok(route)
      await expectBalance(first, a.balance, route)
      await expectClaim(first, a.balance, route)
      assert.equal(defaultCalls, 0)
    } finally { detach(); await network.close() }
  })
  await check('预先取消的积分与签到 RPC 不向任何出口发送请求', async () => {
    const before = a.sent.length + b.sent.length
    for (const method of ['credits.balances', 'credits.claimAll']) {
      const controller = new AbortController(); controller.abort(new DOMException('fixture RPC cancelled', 'AbortError'))
      const result = await first.call(method, undefined, controller.signal)
      if (method === 'credits.balances') assert.match(result.value.accounts[0].error, /fixture RPC cancelled/)
      else assert.equal(result.value.results[0].outcome.kind, 'failed')
    }
    assert.equal(a.sent.length + b.sent.length, before)
  })
  await check('在途取消关闭对应积分/活动请求并阻止后续领取，其它上下文仍可用', async () => {
    for (const [method, pathname] of [['credits.balances', infoPath], ['credits.claimAll', deliveryPath]]) {
      const hold = a.arm(pathname), controller = new AbortController(), before = a.seen.length
      try {
        const pending = first.call(method, undefined, controller.signal)
        await timeout(hold.waiting, 'upstream reached')
        const sent = a.sent.at(-1)
        assert.equal(sent.signal.aborted, false)
        controller.abort(new DOMException('fixture RPC cancelled', 'AbortError'))
        const result = await timeout(pending, 'cancelled RPC')
        assert.equal(sent.signal.aborted, true)
        await timeout(hold.disconnected, 'upstream disconnected')
        if (method === 'credits.balances') assert.match(result.value.accounts[0].error, /fixture RPC cancelled/)
        else {
          assert.equal(result.value.results[0].outcome.kind, 'failed')
          assert.deepEqual(a.seen.slice(before).map(row => row.pathname), [infoPath, deliveryPath])
        }
      } finally { a.hold = undefined }
      await expectBalance(second, b.balance)
    }
  })
  await check('卸载旧上下文取消其在途请求并拒绝新请求，另一个上下文积分/签到正常', async () => {
    const hold = a.arm(infoPath)
    const pending = first.call('credits.balances')
    await timeout(hold.waiting, 'dispose upstream reached')
    first.dispose()
    const stopped = await timeout(pending, 'disposed RPC')
    assert.match(stopped.value.accounts[0].error, /签名传输已停止/)
    await timeout(hold.disconnected, 'disposed upstream disconnected')
    a.hold = undefined
    const before = a.sent.length
    const rejected = await first.call('credits.balances')
    assert.match(rejected.value.accounts[0].error, /签名传输已停止/)
    assert.equal(a.sent.length, before)
    await expectBalance(second, b.balance)
    await expectClaim(second, b.balance)
  })
  assert.equal(globalCalls, 0)
  assert.equal(defaultCalls, 0)
  for (const lane of lanes) { assert.equal(lane.failure, undefined); assert.ok(lane.seen.every(row => row.valid)) }
  console.log('codearts-rpc-context: ' + checks + ' checks passed (real apply/RPC, local fixtures only)')
} finally {
  for (const host of hosts.reverse()) host.dispose()
  for (const release of releases.reverse()) release()
  await Promise.allSettled(networks.map(network => network.close()))
  for (const socket of sockets) socket.destroy()
  await Promise.all(lanes.map(lane => new Promise(resolve => lane.server.close(resolve))))
  globalThis.fetch = savedFetch
  for (const [key, value] of savedEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  hooks.deregister()
  // scratch 来自 mkdtemp；只清理本测试自己创建且已确认位于临时目录内的目录。
  assert.equal(path.dirname(scratch), path.resolve(os.tmpdir()))
  fs.rmSync(scratch, { recursive: true, force: true })
}
