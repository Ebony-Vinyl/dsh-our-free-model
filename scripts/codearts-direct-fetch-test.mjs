/** CodeArts 离线传输回归：凭据和 TLS 身份均为公开测试夹具，只连接本机。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { createHash, createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// 公开的本地夹具私钥，仅用于测试服务器，绝不用于生产身份。
const tlsFixture = {
  "key": "-----BEGIN PRIVATE KEY-----\nMIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCncP/kV+5nNEw7\ngvqzy4Ufney+MypKWCBWXP33gACDXJo7KzG55D+8qkoyOy8qBqKVNj6NyX2igfpK\nxutX3E/NyBjVZh1abA7w6skwY6kyuoAMaGvY5o25xtFPFgJdRaivsmjf3ZE4kv/2\n5CjE+RM2q3GZk52rCeO3C9fc/45jlZeJw8Th3VOG0XH8GDlreCRSUn3NB0t5knzT\nrRhK5trw6mDSBQddrIMg507HlJoLOABRkkVjmIA6RRIDDPr7R6Koycoq4F+piUt9\n/mie+RibsUYklmELQQXXjq3j0eAY0jiulAnX2ok9WlwI6y4kubunN1xhxBfyNYXh\npWC6EigrAgMBAAECggEAKfEEKA5eiTtwXPfSFHdGQUUtp/bpAPZSI0/nzbciacUo\nXOnU6tthm8CMFUj952kCEJ4lzR5LeglUyKZLDRcCZmlYzxtk/uFSXMZy3swX9b0B\nlhoR6aLWnVJP25+HuBVay6fE3U6CsckglJdSHwTE60zGh9GSDOXNRGyTBah94jOO\nOBlgFlLy/OzbEyOQ0lNAiXSAhW+6w1LbONYTML4xK6nhXphL/faVN+gOChqtEx6H\nKfQWknEfyqe9P3SUgx+FxpjB9dW+TQW5uKom3hOMpNk1KutzIH73cLEyyGamfa+s\n8pc/TxHzFO1QeNLrXgfvRMlcI1ZaiHMHvh4aJJ7dAQKBgQDjCv6UyMxjwPyNy0CE\nLMkZ0PDkEze/qiKfujKQXh7ufAsbeOrts8FHfZFQC+KWK3dsfelKHPVbYIg0YKty\nYeP8reJXlohRfzaq6ypWokBew5mLJVoHB2cEZ1cFzheUTzNHw6hS7+ZWX2aAuI/h\n36QpEMjYWfUJSymlRYneO+m3RwKBgQC8zAAx2WSgreF95AOPegEWCMm9wAttEpfO\n8ckwfTorrdaVjxhwJaMS/bO4FmHPQuCark6mVvwvZVjv/G0y5W19dq9sXRTfNrxQ\nwS1nMTTQ6vbjWow55CF981OMPUDM968+OzLLxEED2fRFgrSO3/rqt3t52hvwusu/\n595AFHlB/QKBgDa9et3yf9z5NasWOyrjBWV1C+9hdsp+QbTTFsfZ+Yk0XRU1lSbU\ndSBAdR2gj/P27Oc6gFm/G6T5ZD2EpTGByo8seWr2v00u58ZTxrR2kCCI9mcnDUqu\njTbxl3it1N+MLOf7k4TTlGx0uekFFqO14QWJp3MKVVr1RUg0uOXc+h+XAoGBAJ6c\nuLEolXzUeHP+YutgMZdkbLDorfDFxRpMUZ1WJ8/YbUYbAQn+5MEouZs32pZ49h+d\nv1/KBnZ/K7f7F3bB/zl/w6NDlCxvXMhvcwiV82xtalvZj6N3QJgDHDbeoxlQIT8k\nFunQCFsG+kyHoc/C5pfY7HiTwBN/q3uffj3RtYm1AoGBAJMQ9boCcQD5whg2+9W7\nTQIlRS49zTrdBWZ6yI/jBqTIRmgztUv8ueAU2mjOzmkpSJAbiTOtDNSoL0CVLSMH\n3lkPei56gHgnc3T1nAqVlse70bOjyB3lAO/o3M3D4fjG1EuGy5EHO2DCGfdmZYFi\nbkOQScujAyx7xD0AbbBFhyPK\n-----END PRIVATE KEY-----\n",
  "cert": "-----BEGIN CERTIFICATE-----\nMIIDqjCCApKgAwIBAgIUdd7nih6w1inLAljOQ6DNB4lfH3kwDQYJKoZIhvcNAQEL\nBQAwJzElMCMGA1UEAwwcb2ZtLWNvZGVhcnRzLW9mZmxpbmUtZml4dHVyZTAeFw0y\nNjEwMjAwNzE1MjFaFw0zNjEwMTcwNzE1MjFaMCcxJTAjBgNVBAMMHG9mbS1jb2Rl\nYXJ0cy1vZmZsaW5lLWZpeHR1cmUwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK\nAoIBAQCncP/kV+5nNEw7gvqzy4Ufney+MypKWCBWXP33gACDXJo7KzG55D+8qkoy\nOy8qBqKVNj6NyX2igfpKxutX3E/NyBjVZh1abA7w6skwY6kyuoAMaGvY5o25xtFP\nFgJdRaivsmjf3ZE4kv/25CjE+RM2q3GZk52rCeO3C9fc/45jlZeJw8Th3VOG0XH8\nGDlreCRSUn3NB0t5knzTrRhK5trw6mDSBQddrIMg507HlJoLOABRkkVjmIA6RRID\nDPr7R6Koycoq4F+piUt9/mie+RibsUYklmELQQXXjq3j0eAY0jiulAnX2ok9WlwI\n6y4kubunN1xhxBfyNYXhpWC6EigrAgMBAAGjgc0wgcowHQYDVR0OBBYEFPk8FK8w\nryLAGx0RRXCDLjKL2zAeMB8GA1UdIwQYMBaAFPk8FK8wryLAGx0RRXCDLjKL2zAe\nMA8GA1UdEwEB/wQFMAMBAf8wdwYDVR0RBHAwboIJbG9jYWxob3N0hwR/AAABgg9m\naXh0dXJlLmludmFsaWSCKHNuYXAtYWNjZXNzLmNuLW5vcnRoLTQubXlodWF3ZWlj\nbG91ZC5jb22CIG9wZW5ndy5kZXZlbG9wZXIuaHVhd2VpY2xvdWQuY29tMA0GCSqG\nSIb3DQEBCwUAA4IBAQBq9J9D3d3H0G0/aVIMM8F8NAgv06YE3jW44Fttx8idwiuM\n9iECT2FuLg8CLs8EKkUcD/vQ2XOqHibxUutRzPwuqsO/OuFhdwgpzUEfOSjPsqZB\n4q8xHXDqTzfLTwXBSzRdthxyA6ULRmFYG+BC6hVtVaoi3x3wvpiNW/9j66lsiGb5\nEIqDGkP7IBngCY3MuC3/biqo+n66f+I9NLcdsLsVv20HlvbR0lEFWfIKug4ArGPX\n1YB/O8vgQRDwfxvCcXGeCHzjbTdYLf1KQOOzb715sW/pg3Js3kgTqnjw6ESccvsa\noBohwILo8iMvHs90NNf3NzYmwP0By3bf721x1L6v\n-----END CERTIFICATE-----\n"
}
if (!process.argv.includes('--trusted-fixture')) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-codearts-'))
  const ca = path.join(scratch, 'ca.pem')
  fs.writeFileSync(ca, tlsFixture.cert)
  // Node 启动时读取附加 CA：仅该测试子进程信任夹具，TLS 校验始终开启。
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--trusted-fixture'], {
    stdio: 'inherit', windowsHide: true,
    env: { ...process.env, NODE_EXTRA_CA_CERTS: ca, CODEARTS_MODELS_CACHE_DIR: scratch,
      DSH_CHANNEL_PACK_STATE_DIR: scratch, DSH_HOME: scratch },
  })
  try { process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)) }) }
  finally { fs.rmSync(scratch, { recursive: true, force: true }) }
} else {
  await verify()
  // 沿用既有离线测试入口，让常规回归同时覆盖真实插件的多上下文 RPC 接线。
  await import('./codearts-rpc-context-test.mjs')
}

async function verify() {
  const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
  const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
  const ts = (await import('typescript')).default
  const llm = 'data:text/javascript,' + encodeURIComponent(`export * from ${JSON.stringify(kernel)}
    export class LlmError extends Error { constructor(message, code, options) { super(message, options); this.code = code; this.status = options?.status } }`)
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === '@deepseek-ai/dsh-llm') return { url: llm, shortCircuit: true }
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
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: fileURLToPath(url),
        }).outputText,
      }
      return next(url, context)
    },
  })
  const { createDirectFetch, directFetch, directLane, attachDirectFetch, closeDirectFetch } = await import('../vendor/channel-pack/src/direct-fetch.ts')
  const { CodeArtsAdapter } = await import('../vendor/channel-pack/src/llm-adapter.ts')
  const { fetchCodeArtsRemoteModels } = await import('../vendor/channel-pack/src/models.ts')
  const { fetchCodeArtsAccountInfoDetailed } = await import('../vendor/channel-pack/src/codearts-credits.ts')
  const { CodeArtsAuth } = await import('../vendor/channel-pack/src/service.ts')
  const { Agent, MockAgent, setGlobalDispatcher, getGlobalDispatcher } = await import('undici')
  const credential = { access_key_id: 'FIXTUREAK', secret_access_key: 'FIXTURESECRET', security_token: 'FIXTURETOKEN', expires_at: new Date(Date.now() + 3600000).toISOString() }
  const defaults = { credentialRef: 'FIXTURE', resolveCredential: async () => credential, refresh: async () => {} }
  const options = { model: 'deepseek-v4.1-flash', messages: [{ role: 'user', content: [{ type: 'text', text: '中文签名 hello' }] }] }
  const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
  const savedFetch = globalThis.fetch, sockets = new Set(), servers = [], transports = [], releases = [], seen = [], proxyCalls = []
  const waiters = new Map()
  let nextError, globalCalls = 0, activeNetwork, checks = 0
  const frame = { choices: [{ delta: { content: 'fixture-ok' }, finish_reason: 'stop' }] }
  const sse = value => 'data: ' + JSON.stringify(value) + '\n\ndata: [DONE]\n\n'
  const watch = server => {
    servers.push(server)
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    return server
  }
  const listen = async server => { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) }); return server.address().port }
  const transport = settings => { const value = createDirectFetch({ environment: {}, platform: 'linux', ...settings }); transports.push(value); return value }
  const bind = network => { activeNetwork = network; releases.push(attachDirectFetch(network.fetch)) }
  const waitFor = name => new Promise(resolve => { waiters.set(name, resolve) })
  const check = async (name, run) => {
    let timer
    try {
      await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(name + ': timed out')), 5000) })])
      checks++; console.log('ok  ' + name)
    } finally { clearTimeout(timer) }
  }
  const hash = body => createHash('sha256').update(body).digest('hex')
  // 服务端依据实际收到的字节及 SignedHeaders 独立验签，不调用生产签名函数。
  function validSignature(req, body) {
    const match = /^SDK-HMAC-SHA256 Access=FIXTUREAK,SignedHeaders=([^,]+),Signature=([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')
    if (!match || hash(body) !== req.headers['x-sdk-content-sha256']) return false
    const names = match[1].split(';'), url = new URL(req.url, 'https://' + req.headers.host)
    if (names.join(';') !== [...new Set(names)].sort().join(';')) return false
    const canonical = [req.method, url.pathname.replace(/\/?$/, '/'), url.search.slice(1), names.map(name => name + ':' + (req.headers[name] ?? '')).join('\n'), '', match[1], hash(body)].join('\n')
    const expected = createHmac('sha256', credential.secret_access_key).update('SDK-HMAC-SHA256\n' + req.headers['x-sdk-date'] + '\n' + hash(canonical)).digest('hex')
    return expected === match[2] && req.headers['x-security-token'] === credential.security_token
  }
  async function serve(req, res) {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    if (req.url.startsWith('/hold')) { waiters.get('hold')?.(); return }
    if (req.url.startsWith('/stream')) { res.once('close', () => waiters.get('streamClosed')?.()); res.writeHead(200); res.write('first'); return }
    if (req.url.startsWith('/plain')) { res.end(body.length ? body : 'plain'); return }
    const valid = validSignature(req, body)
    seen.push({ valid, body: body.toString(), headers: req.headers, method: req.method, url: req.url })
    if (!valid) { res.writeHead(401); res.end(JSON.stringify({ error_code: 'APIG.0301', error_msg: 'verify ak sk signature fail' })); return }
    if (req.url.endsWith('/chat/completions')) {
      res.setHeader('content-type', 'text/event-stream')
      res.end(sse(nextError === undefined ? frame : { error_code: nextError, error_msg: 'benefit not found' })); nextError = undefined
    } else if (req.url.includes('/gateway/config')) res.end(JSON.stringify({ result: { models: [{ model_id: 'fixture-model', model_name: 'fixture' }] } }))
    else if (req.url.includes('/model/builtin')) res.end(JSON.stringify({ builtinModels: [{ model_id: 'fixture-builtin', model_name: 'fixture' }] }))
    else res.end(JSON.stringify({ package: { is_credit_package: true, package_name_cn: '隔离套餐' }, metrics: {} }))
  }
  const handler = (req, res) => { void serve(req, res).catch(error => res.destroy(error)) }
  const targetPort = await listen(watch(https.createServer(tlsFixture, handler)))
  const plainPort = await listen(watch(http.createServer(handler)))
  function proxy(secure) {
    const handler = (req, res) => {
      proxyCalls.push({ secure, method: req.method, url: req.url })
      const url = new URL(req.url)
      assert.equal(url.hostname, 'fixture.invalid')
      const upstream = http.request({ hostname: '127.0.0.1', port: plainPort, path: url.pathname, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res)
      })
      upstream.on('error', error => res.destroy(error)); req.pipe(upstream)
    }
    const server = watch(secure ? https.createServer(tlsFixture, handler) : http.createServer(handler))
    server.on('connect', (req, client, head) => {
      proxyCalls.push({ secure, method: 'CONNECT', url: req.url })
      assert.ok(['snap-access.cn-north-4.myhuaweicloud.com:443', 'opengw.developer.huaweicloud.com:443', 'fixture.invalid:443'].includes(req.url), 'CONNECT only targets local fixtures')
      const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head.length) upstream.write(head)
        client.pipe(upstream); upstream.pipe(client)
      })
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream))
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy()); client.on('close', () => upstream.destroy())
    })
    return server
  }
  const httpProxyPort = await listen(proxy(false)), httpsProxyPort = await listen(proxy(true))
  const httpProxy = 'http://127.0.0.1:' + httpProxyPort, httpsProxy = 'https://localhost:' + httpsProxyPort
  try {
    bind(transport({ environment: { HTTPS_PROXY: httpProxy } }))
    globalThis.fetch = (input, init) => {
      globalCalls++
      const body = init?.body ? JSON.stringify({ ...JSON.parse(init.body), injected_by_plugin: true }) : undefined
      return activeNetwork.fetch(input, { ...init, body })
    }
    await check('联装冲突可复现：全局 fetch 改写 body 后本地网关拒绝签名', async () => {
      const start = seen.length
      await assert.rejects(collect(new CodeArtsAdapter({ ...defaults, fetchImpl: (...args) => globalThis.fetch(...args) }).stream(options)))
      const chats = seen.slice(start).filter(row => row.method === 'POST')
      assert.ok(chats.length > 0); assert.ok(chats.every(row => !row.valid && JSON.parse(row.body).injected_by_plugin))
    })
    await check('默认聊天绕过全局 fetch，实际 TLS 请求体与 HMAC 签名一致', async () => {
      const before = globalCalls, start = seen.length
      const chunks = await collect(new CodeArtsAdapter(defaults).stream(options))
      assert.equal(globalCalls, before); assert.equal(seen.length, start + 1); assert.equal(seen.at(-1).valid, true)
      assert.ok(seen.at(-1).body.includes('中文签名')); assert.ok(chunks.some(row => row.type === 'block-end' && row.block?.text === 'fixture-ok'))
    })
    await check('模型目录、积分及认证服务的默认签名 GET 同样经过专用传输', async () => {
      const before = globalCalls, start = seen.length
      assert.deepEqual((await fetchCodeArtsRemoteModels(credential)).map(row => row.id), ['fixture-model', 'fixture-builtin'])
      const account = await fetchCodeArtsAccountInfoDetailed(credential)
      assert.equal(account.ok, true); assert.equal(account.info.packageName, '隔离套餐')
      const ctx = { provide() {}, credentials: { resolve: async () => ({ value: JSON.stringify(credential) }) } }
      const service = new CodeArtsAuth(ctx)
      assert.equal((await service.refreshModels({ listAccountsByProvider: () => [{ credentialRef: 'FIXTURE' }] })).length, 2); service.stop()
      assert.equal(globalCalls, before); assert.equal(seen.length, start + 5); assert.ok(seen.slice(start).every(row => row.valid && row.method === 'GET'))
    })
    await check('显式 fetchImpl/fetcher 保留优先级，离线测试入口仍有效', async () => {
      let calls = 0
      await collect(new CodeArtsAdapter({ ...defaults, fetchImpl: async () => { calls++; return new Response(sse(frame)) } }).stream(options))
      const result = await fetchCodeArtsAccountInfoDetailed(credential, async () => { calls++; return Response.json({ package: { package_name_cn: '注入套餐' } }) })
      assert.equal(result.info.packageName, '注入套餐'); assert.equal(calls, 2)
      const saved = directLane.fetch
      try {
        directLane.fetch = async () => new Response('seam')
        assert.equal(await (await directFetch('https://never-dial.invalid/')).text(), 'seam')
        assert.equal(await (await transport({ fetchImpl: async () => new Response('explicit') }).fetch('https://never-dial.invalid/')).text(), 'explicit')
      } finally { directLane.fetch = saved }
    })
    await check('完整及字符串/数字 4004 仅摘 benefit 头重试一次，重签名仍有效', async () => {
      for (const code of ['4004', 4004, 'InferHub.4004.200']) {
        const start = seen.length; nextError = code
        await collect(new CodeArtsAdapter(defaults).stream(options))
        assert.equal(seen.length, start + 2); assert.equal(seen[start].headers.maas_type, 'benefit'); assert.equal(seen[start + 1].headers.maas_type, undefined)
        assert.equal(seen[start].body, seen[start + 1].body); assert.ok(seen.slice(start).every(row => row.valid))
      }
      for (const [model, code] of [[options.model, '14004'], ['GLM-5.2', '4004']]) {
        const start = seen.length; nextError = code
        await assert.rejects(collect(new CodeArtsAdapter(defaults).stream({ ...options, model }))); assert.equal(seen.slice(start).filter(row => row.method === 'POST').length, 1)
      }
    })
    await check('Windows HTTPS 系统代理及 HTTPS_PROXY 真实经过代理并保持签名', async () => {
      let reads = 0
      bind(transport({ platform: 'win32', readSystemProxy: async () => {
        reads++; return 'ProxyEnable REG_DWORD 0x1\nProxyServer REG_SZ http=127.0.0.1:9;https=127.0.0.1:' + httpProxyPort + '\nProxyOverride REG_SZ <local>;*.internal'
      } }))
      await collect(new CodeArtsAdapter(defaults).stream(options)); await collect(new CodeArtsAdapter(defaults).stream(options)); assert.equal(reads, 1)
      const start = proxyCalls.length
      bind(transport({ environment: { HTTPS_PROXY: httpsProxy } })); await collect(new CodeArtsAdapter(defaults).stream(options))
      assert.ok(proxyCalls.slice(start).some(row => row.secure && row.method === 'CONNECT')); assert.equal(seen.at(-1).valid, true)
    })
    await check('NO_PROXY、loopback 及显式 dispatcher 保留既有选择与资源所有权', async () => {
      const start = proxyCalls.length, url = 'http://127.0.0.1:' + plainPort + '/plain'
      const network = transport({ environment: { HTTP_PROXY: httpProxy } })
      assert.equal(await (await network.fetch(url)).text(), 'plain')
      const bypass = transport({ environment: { HTTP_PROXY: httpProxy, NO_PROXY: '*' }, fetchImpl: async (_url, init) => {
        assert.equal(init.dispatcher, undefined); return new Response('bypass')
      } })
      assert.equal(await (await bypass.fetch('http://fixture.invalid/plain')).text(), 'bypass')
      const dispatcher = new Agent()
      try { assert.equal(await (await network.fetch(url, { dispatcher })).text(), 'plain'); await network.close(); assert.equal(dispatcher.destroyed, false) }
      finally { await dispatcher.destroy() }
      assert.equal(proxyCalls.length, start)
    })
    await check('插件出口优先且使用隔离 send；旧出口缺接口时禁止绕过', async () => {
      const before = globalCalls, start = proxyCalls.length
      let calls = 0
      const network = transport({ environment: { HTTPS_PROXY: 'http://127.0.0.1:9' }, outlet: {
        active: () => true, fetch: async () => { throw new Error('unsafe outlet') },
        fetchSigned: (_input, init, send) => { calls++; assert.equal(init.redirect, 'error'); return send('http://127.0.0.1:' + plainPort + '/plain', { ...init, method: 'POST', body: 'selected outlet' }) },
      } })
      assert.equal(await (await network.fetch('https://fixture.invalid/')).text(), 'selected outlet'); assert.equal(calls, 1)
      assert.equal(globalCalls, before); assert.equal(proxyCalls.length, start)
      const legacy = transport({ outlet: { active: () => true, fetch: async () => { throw new Error('unsafe outlet') } } })
      await assert.rejects(legacy.fetch('https://fixture.invalid/'), error => /尚未接入签名传输/.test(error.cause?.message)); assert.equal(proxyCalls.length, start)
    })
    await check('预先取消、在途取消、超时、响应流取消及 Node Request 均生效', async () => {
      const network = transport(), url = 'http://127.0.0.1:' + plainPort
      const pre = new AbortController(), reason = new Error('fixture cancel'); pre.abort(reason)
      await assert.rejects(network.fetch(url + '/plain', { signal: pre.signal }), error => error === reason)
      const reached = waitFor('hold'), controller = new AbortController(), pending = network.fetch(url + '/hold', { signal: controller.signal })
      const rejected = assert.rejects(pending, error => error === reason)
      await reached; controller.abort(reason); await rejected
      await assert.rejects(network.fetch(url + '/hold', { signal: AbortSignal.timeout(80) }), { name: 'TimeoutError' })
      const streaming = new AbortController(), response = await network.fetch(url + '/stream', { signal: streaming.signal }), reader = response.body.getReader()
      assert.equal(new TextDecoder().decode((await reader.read()).value), 'first')
      const stopped = assert.rejects(reader.read(), { name: 'AbortError' }); streaming.abort(); await stopped
      assert.equal(await (await network.fetch(new Request(url + '/plain', { method: 'POST', body: 'native Request body' }))).text(), 'native Request body')
    })
    await check('关闭取消代理响应流、销毁自有连接，重复关闭安全且拒绝新请求', async () => {
      const streamClosed = waitFor('streamClosed')
      const network = transport({ environment: { HTTPS_PROXY: httpProxy } }), response = await network.fetch('https://fixture.invalid/stream'), reader = response.body.getReader()
      await reader.read(); const stopped = assert.rejects(reader.read(), { name: 'AbortError' })
      const closing = network.close(); assert.equal(network.close(), closing); await closing; await stopped; await streamClosed
      await assert.rejects(network.fetch('https://fixture.invalid/plain'), { name: 'AbortError' })
    })
    await check('独立 Agent 不受 undici 全局 dispatcher 改写影响', async () => {
      const original = getGlobalDispatcher(), blocked = new MockAgent(); blocked.disableNetConnect(); setGlobalDispatcher(blocked)
      try { assert.equal(await (await transport().fetch('http://127.0.0.1:' + plainPort + '/plain')).text(), 'plain') }
      finally { setGlobalDispatcher(original); await blocked.close() }
    })
    await check('旧挂载延迟卸载及重复卸载不会清除新挂载', async () => {
      const detachA = attachDirectFetch(async () => new Response('A')), detachB = attachDirectFetch(async () => new Response('B'))
      detachA(); assert.equal(await (await directFetch('http://fixture.invalid/')).text(), 'B'); detachB(); detachB()
      const shared = async () => new Response('shared')
      const first = attachDirectFetch(shared), second = attachDirectFetch(shared)
      first(); assert.equal(await (await directFetch('http://fixture.invalid/')).text(), 'shared'); second()
    })
    console.log('codearts-direct-fetch: ' + checks + ' checks passed (local fixtures only)')
  } finally {
    globalThis.fetch = savedFetch
    for (const release of releases.reverse()) release()
    await Promise.allSettled(transports.map(network => network.close())); await closeDirectFetch()
    for (const socket of sockets) socket.destroy()
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve)))); hooks.deregister()
  }
}
