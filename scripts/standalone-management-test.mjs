import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { verifyLoginLaunchers, verifyLoginTerminal } from './standalone-login-terminal-test.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-management-'))
const dataDir = path.join(scratch, 'data')
const model = 'mimo-v2.6-flash-free'
const kilo = 'nvidia/nemotron-3.5-lightning:free'
let calls = 0
let failedListing = ''
let emptyFreeListing = false
let holdNextCall = false
let notifyCall
let notifyClosed
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET') {
      const source = req.url === '/models' ? 'kilo' : 'free'
      if (failedListing === source) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: '模拟清单刷新失败' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: source === 'kilo'
        ? [{ id: kilo, isFree: true, name: '测试免费模型' }]
        : emptyFreeListing ? [] : [{ id: model }] }))
    } else {
      calls++
      if (holdNextCall) {
        holdNextCall = false
        res.once('close', () => notifyClosed())
        notifyCall()
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end([
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'OK' } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''))
    }
  })
})
upstream.listen(0, '127.0.0.1')
await once(upstream, 'listening')
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base
const { startStandalone } = await import('../packages/standalone/service.mjs')
let service
let cookie
let key
let failures = 0
let checks = 0
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.stack}`) }
}
const getKey = () => JSON.parse(fs.readFileSync(service.keyFile, 'utf8')).forwardKey
const request = async (route, { body, cookie: cookieValue = cookie, headers = {}, method } = {}) => {
  if (headers.host) {
    // fetch 会自行设置 Host；用真实 HTTP 请求验证恶意 Host，不误测客户端归一化。
    return new Promise((resolve, reject) => {
      const raw = http.request(service.url + route, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { cookie: cookieValue ?? '', 'content-type': 'application/json', ...headers },
      }, res => {
        res.resume()
        res.on('end', () => resolve({ status: res.statusCode }))
      })
      raw.once('error', reject)
      raw.end(body === undefined ? undefined : JSON.stringify(body))
    })
  }
  const response = await fetch(service.url + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...cookieValue ? { cookie: cookieValue } : {},
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      connection: 'close',
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  return response
}
const login = async body => {
  const response = await request('/api/management/session', { body, cookie: '' })
  assert.equal(response.status, 200)
  const setCookie = response.headers.get('set-cookie')
  assert.match(setCookie, /HttpOnly/)
  assert.match(setCookie, /SameSite=Strict/)
  assert.match(setCookie, /Path=\/api\/management/)
  return setCookie.split(';')[0]
}

try {
  await check('macOS 与 Windows 固定启动器安全引用路径，令牌只经 stdin 复制', verifyLoginLaunchers)
  await check('本机取令牌入口限制来源与参数，拒绝并发且不泄露密钥或创建会话', verifyLoginTerminal)
  service = await startStandalone({ dataDir, port: 0, refresh: false, logger: { warn() {} } })
  key = getKey()
  await check('页面资源本地提供且不包含密钥，健康接口仍兼容', async () => {
    const page = await request('/', { cookie: '' })
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/)
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer')
    const body = await page.text()
    assert.match(body, /本地控制台/)
    assert.match(page.headers.get('content-security-policy'), /script-src 'self';/)
    const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)]
    assert.ok(scripts.length > 0)
    assert.ok(scripts.every(([, attributes, content]) => /\bsrc=/.test(attributes) && !content.trim()),
      '管理页脚本必须通过同源外部资源加载，不能依赖被 CSP 禁止的内联脚本')
    const platform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
    assert.ok(body.includes(`data-login-platform="${platform}"`))
    assert.ok(!body.includes(key))
    const manifest = JSON.parse(fs.readFileSync(new URL('../packages/standalone/web/assets.json', import.meta.url), 'utf8'))
    assert.ok(manifest.includes('app.js') && manifest.includes('app.css'))
    assert.ok(manifest.some(name => /^channels-.+\.js$/.test(name)))
    for (const asset of manifest) {
      const response = await request(`/assets/${asset}`, { cookie: '' })
      assert.equal(response.status, 200, asset)
      assert.match(response.headers.get('content-type'), asset.endsWith('.css') ? /text\/css/ : /javascript/)
      assert.ok(!(await response.text()).includes(key), asset)
      assert.equal((await request(`/assets/${asset}`, { method: 'HEAD' })).status, 200)
      assert.equal((await request(`/assets/${asset}`, { method: 'POST' })).status, 405)
    }
    for (const route of ['/assets/settings.json', '/assets/assets.json', '/assets/unknown.js', '/frontend/app.tsx', '/assets/%2e%2e%2fservice.mjs']) {
      assert.equal((await request(route, { cookie: '', headers: { authorization: `Bearer ${key}` } })).status, 404, route)
    }
    const health = await (await request('/health')).json()
    assert.equal(health.product, 'standalone')
    assert.equal(health.capabilities.webUi, true)
  })
  await check('所有管理数据和操作要求登录，OPTIONS 不放行跨域', async () => {
    for (const route of ['summary', 'stats', 'key']) assert.equal((await request(`/api/management/${route}`, { cookie: '' })).status, 401)
    for (const route of ['settings', 'key/rotate', 'models/refresh', 'models/test']) {
      assert.equal((await request(`/api/management/${route}`, { body: {}, cookie: '' })).status, 401)
    }
    const response = await request('/api/management/settings', { cookie: '', method: 'OPTIONS' })
    assert.equal(response.status, 401)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  await check('一次性链接只兑换一次，错误凭证不消耗有效凭证', async () => {
    const bootstrapToken = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
    assert.ok(bootstrapToken)
    assert.ok(!service.managementUrl.includes(key))
    assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken: 'wrong' } })).status, 401)
    cookie = await login({ bootstrapToken })
    assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken } })).status, 401)
    const secondCookie = await login({ key })
    assert.notEqual(cookie, secondCookie)
  })
  await check('摘要与统计不泄露密钥，管理会话不能调用推理接口', async () => {
    const response = await request('/api/management/summary')
    assert.equal(response.status, 200)
    const summary = await response.json()
    assert.equal(summary.dataDir, dataDir)
    assert.equal(summary.automaticRefresh, false)
    assert.equal(summary.networkMode, 'live')
    assert.equal(summary.capabilities.eac, true)
    assert.ok(!JSON.stringify(summary).includes(key))
    const stats = await (await request('/api/management/stats')).json()
    assert.equal(stats.requests, 0)
    assert.ok(!JSON.stringify(stats).includes(key))
    assert.equal((await request('/v1/models')).status, 401)
    assert.equal((await request('/api/management/summary', { cookie: '', headers: { authorization: `Bearer ${key}` } })).status, 200)
  })
  await check('同源防护覆盖登录、读取和写入，拒绝伪造 Host 及插件来源', async () => {
    for (const headers of [
      { origin: 'https://evil.example' },
      { origin: 'http://127.0.0.1:1' },
      { referer: 'http://evil.example/' },
      { referer: 'dsh-app://app' },
      { 'sec-fetch-site': 'cross-site' },
      { host: 'evil.example' },
    ]) {
      assert.equal((await request('/api/management/summary', { headers })).status, 403, JSON.stringify(headers))
      assert.equal((await request('/api/management/settings', { headers, body: { enabled: false } })).status, 403)
      assert.equal((await request('/api/management/session', { headers, body: { key } })).status, 403)
    }
    const response = await request('/api/management/settings', { body: {}, headers: { origin: service.url, referer: `${service.url}/` } })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
  })
  await check('设置严格校验字段类型范围和请求体，不发生部分保存', async () => {
    for (const body of [
      null, [], { enabled: 'false' }, { enabled: false, unknown: 1 },
      { forwardKey: 'injected' }, { standalonePort: 80 }, { defaultMaxTokens: 0 },
      { defaultMaxTokens: 131073 }, { probeIntervalMinutes: 0 },
      { probeIntervalMinutes: 1441 }, { probeIntervalMinutes: '15' },
      { standaloneProbe: {} }, { enabled: false, probeIntervalMinutes: 0 },
      { hideFreeModels: 'true' }, { hideEacModels: 1 }, { hiddenModelIds: null },
      { hiddenModelIds: [1] }, { hiddenModelIds: [''] }, { hiddenModelIds: [' x'] },
      { hiddenModelIds: ['x\n'] }, { hiddenModelIds: ['x'.repeat(301)] },
      { hiddenModelIds: Array(1001).fill('model') },
      { enabled: false, hiddenModelIds: [false] },
    ]) assert.equal((await request('/api/management/settings', { body })).status, 400)
    assert.equal(getKey(), key)
    assert.equal(service.runtime.state().settings.enabled, true)
    const malformed = await fetch(service.url + '/api/management/settings', {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{',
    })
    assert.equal(malformed.status, 400)
    assert.equal((await request('/api/management/settings', { body: {}, headers: { 'content-type': 'text/plain' } })).status, 415)
    assert.equal((await request('/api/management/settings', { body: { huge: 'x'.repeat(17000) } })).status, 413)
  })
  await check('设置保存后立即落盘，推理暂停时管理页面可恢复服务', async () => {
    const patch = { enabled: false, exposeRegionModels: false, streamRecovery: false, standaloneProbe: true, defaultMaxTokens: 8192, probeIntervalMinutes: 12 }
    assert.equal((await request('/api/management/settings', { body: patch })).status, 200)
    const saved = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    for (const [name, value] of Object.entries(patch)) assert.equal(saved[name], value)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 503)
    assert.equal((await request('/')).status, 200)
    assert.equal((await request('/api/management/summary')).status, 200)
    const before = calls
    assert.equal((await request('/api/management/models/test', { body: { model } })).status, 503)
    assert.equal(calls, before)
    assert.equal((await request('/api/management/settings', { body: { enabled: true } })).status, 200)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 200)
  })
  await check('持久化失败不谎报成功且保留原配置与密钥', async () => {
    const nativeRename = fs.renameSync
    fs.renameSync = (source, target) => {
      if (target === service.keyFile) throw Object.assign(new Error('模拟磁盘不可写'), { code: 'EACCES' })
      return nativeRename(source, target)
    }
    try {
      assert.equal((await request('/api/management/settings', { body: { enabled: false } })).status, 500)
      assert.equal(service.runtime.state().settings.enabled, true)
      assert.equal((await request('/api/management/key/rotate', { body: { confirm: true } })).status, 500)
      assert.equal(service.runtime.state().settings.forwardKey, key)
      assert.equal(getKey(), key)
    } finally { fs.renameSync = nativeRename }
    assert.equal((await request('/api/management/settings', { body: { enabled: true } })).status, 200)
  })
  await check('刷新不默认推理，主动探测和单模型测试执行核心并写入统计', async () => {
    const before = calls
    assert.equal((await request('/api/management/models/refresh', { body: {} })).status, 200)
    assert.equal(calls, before)
    const models = (await (await request('/api/management/summary')).json()).catalog
    assert.deepEqual(models.map(row => row.id), [model, kilo])
    assert.equal((await request('/api/management/models/refresh', { body: { probe: true } })).status, 200)
    assert.equal(calls, before + 1)
    assert.equal((await request('/api/management/models/refresh', { body: { probe: 'yes' } })).status, 400)
    const tested = await request('/api/management/models/test', { body: { model } })
    assert.equal(tested.status, 200)
    const testResult = await tested.json()
    assert.equal(testResult.text, 'OK')
    assert.equal(testResult.persisted, true)
    const measured = (await (await request('/api/management/summary')).json()).catalog.find(row => row.id === model)
    assert.equal(measured.availabilitySource, 'manual')
    assert.equal(measured.availability, 'available')
    assert.equal(measured.ttftMs, testResult.ttftMs)
    assert.equal(measured.latencyMs, testResult.totalMs)
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'))
    assert.equal(saved.manualResults[model].ttftMs, testResult.ttftMs)
    assert.equal(calls, before + 2)
    assert.equal((await request('/api/management/models/test', { body: { model: 'missing' } })).status, 404)
    assert.equal(calls, before + 2)
    const stats = await (await request('/api/management/stats')).json()
    assert.equal(stats.requests, 1)
    assert.equal(stats.turns, 1)
    assert.equal(stats.grand.input, 11)
    assert.equal(stats.grand.output, 7)
  })
  await check('刷新逐来源报告失败与保留的行数，恢复后不残留失败状态', async () => {
    const before = calls
    const refresh = async () => {
      const response = await request('/api/management/models/refresh', { body: {} })
      assert.equal(response.status, 200)
      const result = await response.json()
      assert.deepEqual(result.catalog.map(row => row.id), [model, kilo])
      assert.equal(result.dataDir, dataDir)
      assert.ok(!JSON.stringify(result).includes(key))
      return result.sources
    }
    try {
      for (const source of ['free', 'kilo']) {
        failedListing = source
        const sources = await refresh()
        assert.deepEqual(sources[source], { ok: false, count: 1 })
        assert.deepEqual(sources[source === 'free' ? 'kilo' : 'free'], { ok: true, count: 1 })
        assert.deepEqual(sources.sealed, { ok: true, count: 0, skipped: true })
      }
      failedListing = ''
      emptyFreeListing = true
      assert.deepEqual((await refresh()).free, { ok: false, count: 1 })
      emptyFreeListing = false
      const sources = await refresh()
      assert.deepEqual(sources.free, { ok: true, count: 1 })
      assert.deepEqual(sources.kilo, { ok: true, count: 1 })
      assert.equal(calls, before, '清单失败不能触发推理或探测')
    } finally { failedListing = ''; emptyFreeListing = false }
  })
  await check('账号渠道刷新逐供应商返回失败、行数和恢复结果', async () => {
    const channelDir = path.join(scratch, 'channel-refresh')
    fs.mkdirSync(channelDir, { recursive: true })
    const fixtureFile = path.join(channelDir, 'refresh-fixture.json')
    const fixture = {
      trae: { models: [{ id: 'fixture-trae', name: 'TRAE 测试模型' }] },
      qodercn: { models: [{ id: 'fixture-qoder', name: 'Qoder 测试模型' }] },
    }
    const save = () => fs.writeFileSync(fixtureFile, JSON.stringify(fixture))
    save()
    const argv = [...process.execArgv]
    let instance
    try {
      process.execArgv.push('--import', new URL('./lib/standalone-refresh-fixture.mjs', import.meta.url).href)
      instance = await startStandalone({ dataDir: channelDir, port: 0, refresh: false, logger: { warn() {} } })
      await instance.ready
      const forwardKey = JSON.parse(fs.readFileSync(instance.keyFile, 'utf8')).forwardKey
      for (const failed of [false, true, false]) {
        fixture.trae.fail = failed
        save()
        const response = await fetch(instance.url + '/api/management/models/refresh', {
          method: 'POST', headers: { authorization: `Bearer ${forwardKey}`, 'content-type': 'application/json' },
          body: '{}', signal: AbortSignal.timeout(10000),
        })
        assert.equal(response.status, 200)
        const result = await response.json()
        assert.deepEqual(result.sources.trae, { ok: !failed, count: failed ? 0 : 1 })
        assert.deepEqual(result.sources.qodercn, { ok: true, count: 1 })
        assert.deepEqual(result.sources.free, { ok: true, count: 1 })
        assert.equal(result.catalog.filter(row => row.channel === 'trae').length, failed ? 0 : 1)
        assert.equal(JSON.stringify(result).includes('fixture-private-token'), false)
      }
      const listing = instance.channels.refresh()
      const report = instance.channels.refresh({ report: true })
      assert.ok(Array.isArray(await listing), '既有渠道调用仍返回模型数组')
      assert.deepEqual((await report).sources.trae, { ok: true, count: 1 })
    } finally {
      process.execArgv.splice(0, process.execArgv.length, ...argv)
      await instance?.close()
    }
  })
  await check('EAC 清单成功或失败前授权已切换时，返回跳过且不覆盖当前目录', async () => {
    const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')
    const { lane } = await import('../src/eac.js')
    const stores = createRuntimeStores({ dataDir: path.join(scratch, 'sealed-refresh'), logger: { warn() {} } })
    stores.catalogStore.update({ sealIds: ['fixture-cached'] })
    let credential = { mode: 'direct', base, apiKey: 'fixture-sealed-key', userToken: 'fixture-old-user' }
    const runtime = createModelRuntime({ ...stores, sealedCredential: () => credential, logger: { warn() {} } })
    const cached = runtime.catalog.filter(row => row.channel === 'eac').map(row => row.id)
    const originalFetch = lane.fetch
    try {
      assert.equal(cached.length, 1)
      for (const failed of [false, true]) {
        credential = { ...credential, userToken: 'fixture-old-user' }
        lane.fetch = async () => {
          credential = { ...credential, userToken: 'fixture-new-user' }
          return new Response(JSON.stringify(failed ? { error: { message: 'refused' } } : { data: [{ id: 'fixture-stale' }] }), { status: failed ? 401 : 200 })
        }
        const result = await runtime.refreshCatalog({ report: true })
        assert.deepEqual(result.sources.sealed, { ok: false, count: 1, skipped: true })
        assert.deepEqual(runtime.catalog.filter(row => row.channel === 'eac').map(row => row.id), cached)
        assert.equal(JSON.stringify(result.sources).includes('fixture-old-user'), false)
        assert.equal(JSON.stringify(result.sources).includes('fixture-new-user'), false)
      }
    } finally {
      lane.fetch = originalFetch
      runtime.dispose()
      stores.dispose()
    }
  })
  await check('取消单模型测试会关闭真实上游请求且管理会话仍可使用', async () => {
    const started = new Promise(resolve => { notifyCall = resolve })
    const closed = new Promise(resolve => { notifyClosed = resolve })
    const controller = new AbortController()
    const before = calls
    holdNextCall = true
    const pending = fetch(`${service.url}/api/management/models/test`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ model }), signal: controller.signal,
    })
    const cancelled = pending.then(() => null, error => error)
    const deadline = AbortSignal.timeout(5000)
    const wait = promise => Promise.race([promise, new Promise((_, reject) => {
      deadline.addEventListener('abort', () => reject(new Error('取消测试未在五秒内关闭上游')), { once: true })
    })])
    try {
      await wait(started)
      controller.abort()
      assert.equal((await cancelled)?.name, 'AbortError')
      await wait(closed)
      assert.equal(calls, before + 1)
      assert.equal((await request('/api/management/summary')).status, 200)
    } finally { controller.abort(); holdNextCall = false }
  })
  await check('模型隐藏只过滤公开清单，保留管理入口和历史调用并持久化', async () => {
    const listing = async () => (await (await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).json()).data
    assert.equal((await request('/api/management/settings', { body: { hiddenModelIds: [model, model] } })).status, 200)
    assert.deepEqual((await listing()).map(row => row.id), [kilo])
    const summary = await (await request('/api/management/summary')).json()
    assert.deepEqual(summary.settings.hiddenModelIds, [model])
    assert.equal(summary.catalog.find(row => row.id === model).hiddenByUser, true)
    assert.equal(summary.catalog.find(row => row.id === model).routable, false)
    assert.equal(JSON.stringify(summary).includes(key), false)
    assert.equal((await request('/api/management/models/test', { body: { model } })).status, 200,
      'hidden history ids remain callable')
    assert.equal((await request('/api/management/settings', { body: { hiddenModelIds: [], hideFreeModels: true, hideEacModels: true } })).status, 200)
    assert.deepEqual(await listing(), [])
    assert.equal((await (await request('/api/management/summary')).json()).catalog.length, 2)
    const hiddenSettings = { hiddenModelIds: [model], hideFreeModels: false, hideEacModels: true }
    assert.equal((await request('/api/management/settings', { body: hiddenSettings })).status, 200)
    const stored = JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
    for (const [name, value] of Object.entries(hiddenSettings)) assert.deepEqual(stored[name], value)
  })
  await check('轮换要求确认，旧密钥与其他会话失效，当前管理会话保留', async () => {
    const other = await login({ key })
    assert.equal((await request('/api/management/key/rotate', { body: {} })).status, 400)
    const rotated = await request('/api/management/key/rotate', { body: { confirm: true } })
    assert.equal(rotated.status, 200)
    const nextKey = (await rotated.json()).key
    assert.notEqual(nextKey, key)
    assert.equal(getKey(), nextKey)
    assert.equal((await request('/api/management/summary', { cookie: other })).status, 401)
    assert.equal((await request('/api/management/summary')).status, 200)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).status, 401)
    assert.equal((await request('/v1/models', { headers: { authorization: `Bearer ${nextKey}` } })).status, 200)
    assert.equal((await request('/api/management/session', { cookie: '', body: { key } })).status, 401)
    key = nextKey
  })
  await check('会话到期和登出后不能读管理数据', async () => {
    const nativeNow = Date.now
    const started = nativeNow()
    try {
      Date.now = () => started + 8 * 60 * 60_000 + 1000
      assert.equal((await request('/api/management/summary')).status, 401)
    } finally { Date.now = nativeNow }
    cookie = await login({ key })
    const response = await request('/api/management/logout', { body: {} })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('set-cookie'), /Max-Age=0/)
    assert.equal((await request('/api/management/summary')).status, 401)
    cookie = await login({ key })
  })
  await check('重启保留设置与密钥但清除会话，新的登录链接独立生成', async () => {
    const oldUrl = service.managementUrl
    const previousPort = service.port
    await service.close()
    service = await startStandalone({ dataDir, refresh: false, logger: { warn() {} } })
    assert.equal(service.port, previousPort)
    assert.equal(getKey(), key)
    assert.notEqual(service.managementUrl, oldUrl)
    assert.equal(service.runtime.state().settings.defaultMaxTokens, 8192)
    assert.equal(service.runtime.state().settings.standaloneProbe, true)
    assert.deepEqual(service.runtime.state().settings.hiddenModelIds, [model])
    assert.equal(service.runtime.state().settings.hideEacModels, true)
    assert.equal(service.runtime.state().settings.hideFreeModels, false)
    assert.equal((await request('/api/management/summary')).status, 401)
    const token = new URLSearchParams(new URL(service.managementUrl).hash.slice(1)).get('login')
    const nativeNow = Date.now
    const started = nativeNow()
    try {
      Date.now = () => started + 10 * 60_000 + 1000
      assert.equal((await request('/api/management/session', { cookie: '', body: { bootstrapToken: token } })).status, 401)
    } finally { Date.now = nativeNow }
    cookie = await login({ key })
    const visible = await (await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).json()
    assert.equal(visible.data.some(row => row.id === model), false)
    assert.equal((await request('/api/management/settings', { body: { hiddenModelIds: [], hideEacModels: false } })).status, 200)
    assert.equal((await (await request('/v1/models', { headers: { authorization: `Bearer ${key}` } })).json()).data.some(row => row.id === model), true)
  })
  await check('设置变更重新安排周期任务且 --no-refresh 保持无自动请求', async () => {
    const nativeTimeout = globalThis.setTimeout
    let scheduled
    globalThis.setTimeout = (callback, delay, ...args) => {
      const handle = nativeTimeout(callback, delay, ...args)
      if ([12, 5].some(minutes => minutes * 60_000 === delay)) scheduled = { handle, delay }
      return handle
    }
    try {
      const before = calls
      assert.equal((await request('/api/management/settings', { body: { probeIntervalMinutes: 5 } })).status, 200)
      assert.equal(scheduled, undefined)
      assert.equal(calls, before)
      await service.close()
      service = await startStandalone({ dataDir, refresh: true, logger: { warn() {} } })
      await service.ready
      cookie = await login({ key })
      assert.equal(scheduled.delay, 5 * 60_000)
      const oldHandle = scheduled.handle
      assert.equal((await request('/api/management/settings', { body: { probeIntervalMinutes: 12, standaloneProbe: false } })).status, 200)
      assert.equal(scheduled.delay, 12 * 60_000)
      assert.equal(oldHandle._destroyed, true)
    } finally {
      globalThis.setTimeout = nativeTimeout
    }
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const cleanupTarget = fs.realpathSync(scratch)
  assert.ok(cleanupTarget.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(cleanupTarget, { recursive: true, force: true })
}
console.log(`\nstandalone-management: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
