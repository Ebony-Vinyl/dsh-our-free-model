import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-standalone-'))
const dataDir = path.join(scratch, 'standalone')
const dshHome = path.join(scratch, 'dsh')
fs.mkdirSync(path.join(dshHome, 'our-free-model'), { recursive: true })
const sentinelPath = path.join(dshHome, 'our-free-model', 'settings.json')
const sentinel = JSON.stringify({ forwardKey: 'dsh-only-key', enabled: false, privateMarker: 'do-not-copy' })
fs.writeFileSync(sentinelPath, sentinel)
process.env.DSH_HOME = dshHome

const model = 'mimo-v2.6-flash-free'
const kiloModel = 'nvidia/nemotron-3.5-lightning:free'
let listingCalls = 0
let kiloCalls = 0
let holdListing
let signalListingStarted
let listingStarted
let turns = []
const anonymousRequests = []
let throttleTurns = false
let kiloListing = { data: [{ id: kiloModel, name: 'Test free model', isFree: true }] }
const frames = text => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`,
  'data: [DONE]\n\n',
].join('')
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.url.startsWith('/inference/v1/')) {
      anonymousRequests.push({ method: req.method, headers: req.headers })
      // v2 指纹：上游只认 `opencode/<channel>/<version>/<client>` 这一整串。
      // 旧实现模拟的是「按名字拒掉独立服务的归属 UA」，那条规则属于 v1；
      // v2 反过来 —— 拼接了归属的串不再是 v2 客户端，同样被拒。
      if (req.method === 'POST' && !/^opencode\/[a-z0-9-]+\/\d+\.\d+\.\d+\/[a-z0-9-]+$/i.test(req.headers['user-agent'] ?? '')) {
        res.writeHead(403, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { name: 'FreeTierError', message: 'OpenCode free tier client rejected' } }))
        return
      }
    }
    if (req.method === 'GET' && req.url === '/inference/v1/models') {
      listingCalls++
      signalListingStarted?.()
      const respond = () => {
        if (res.destroyed) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: model }] }))
      }
      if (holdListing) void holdListing.then(respond)
      else respond()
      return
    }
    if (req.method === 'GET' && req.url === '/models') {
      kiloCalls++
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(kiloListing))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    turns.push(body)
    if (throttleTurns) {
      res.writeHead(429, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(frames(body.model === kiloModel ? 'kilo-ok' : 'core-ok'))
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = base
process.env.OUR_FREE_MODEL_KILO_BASE = base

const { startStandalone, resolveStandaloneDataDir } = await import('../packages/standalone/service.mjs')
const { createRuntimeStores } = await import('../src/core/runtime.js')
let failures = 0
let checks = 0
let service
let unhold
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name}: ${error.message}`) }
}
const jsonRequest = (url, body, key, extra = {}) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extra },
  body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
})
async function child(args, env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      cwd: root, env: { ...process.env, ...env }, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    const deadline = setTimeout(() => { proc.kill(); reject(new Error('child timed out')) }, 10000)
    proc.once('error', error => { clearTimeout(deadline); reject(error) })
    proc.once('exit', code => { clearTimeout(deadline); resolve({ code, stdout, stderr }) })
  })
}

try {
  await check('default data path ignores DSH_HOME', () => {
    assert.equal(resolveStandaloneDataDir({ DSH_HOME: dshHome }, scratch), path.join(scratch, '.our-free-model'))
    assert.equal(resolveStandaloneDataDir({ OFM_HOME: dataDir, DSH_HOME: dshHome }, scratch), dataDir)
  })
  await check('different runtimes own independent settings and statistics', () => {
    const first = createRuntimeStores({ dataDir: path.join(scratch, 'one') })
    const second = createRuntimeStores({ dataDir: path.join(scratch, 'two') })
    try {
      first.settings.get().forward.port = 12345
      first.stats.get().days.privateDay = { total: 1 }
      assert.notEqual(second.settings.get().forward.port, 12345)
      assert.equal(second.stats.get().days.privateDay, undefined)
    } finally { first.dispose(); second.dispose() }
  })
  await check('routable binds and invalid ports fail before creating data', async () => {
    const invalidDir = path.join(scratch, 'invalid')
    await assert.rejects(startStandalone({ dataDir: invalidDir, host: '0.0.0.0' }), /loopback/)
    await assert.rejects(startStandalone({ dataDir: invalidDir, port: -1 }), /port/)
    await assert.rejects(startStandalone({ dataDir: invalidDir, port: 65536 }), /port/)
    assert.equal(fs.existsSync(invalidDir), false)
  })
  await check('退出时保留已被替换的其他锁，不清理无法确认归属的文件', async () => {
    const directory = path.join(scratch, 'replaced-lock')
    const isolated = await startStandalone({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} } })
    const lockFile = path.join(directory, 'service.lock')
    const replacement = JSON.stringify({ pid: process.pid, product: 'our-free-model-standalone', token: 'another-owner' })
    fs.unlinkSync(lockFile)
    fs.writeFileSync(lockFile, replacement)
    await isolated.close()
    assert.equal(fs.readFileSync(lockFile, 'utf8'), replacement)
  })
  await check('启动中途失败会同时释放文件锁与进程互斥端点，修复配置后可重启', async () => {
    const directory = path.join(scratch, 'failed-boot')
    const settingsFile = path.join(directory, 'settings.json')
    fs.mkdirSync(settingsFile, { recursive: true })
    await assert.rejects(startStandalone({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} } }), /persist/)
    assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false)
    fs.rmdirSync(settingsFile)
    const recovered = await startStandalone({ dataDir: directory, port: 0, refresh: false, logger: { warn() {} } })
    await recovered.close()
  })
  if (process.platform === 'win32' || process.platform === 'linux') {
    await check('没有权限检查进程时保留锁，不把 EPERM 当成进程退出', async () => {
      const directory = path.join(scratch, 'permission-lock')
      const lockFile = path.join(directory, 'service.lock')
      fs.mkdirSync(directory)
      const original = JSON.stringify({ pid: process.pid, product: 'our-free-model-standalone' })
      fs.writeFileSync(lockFile, original)
      const nativeKill = process.kill
      process.kill = () => { throw Object.assign(new Error('permission denied'), { code: 'EPERM' }) }
      try {
        await assert.rejects(startStandalone({ dataDir: directory, port: 0, refresh: false }), { code: 'EEXIST' })
        assert.equal(fs.readFileSync(lockFile, 'utf8'), original)
      } finally { process.kill = nativeKill }
    })
  }
  await check('the listener starts while its upstream listing is held', async () => {
    holdListing = new Promise(resolve => { unhold = resolve })
    listingStarted = new Promise(resolve => { signalListingStarted = resolve })
    service = await startStandalone({ dataDir, port: 0, logger: { warn() {} } })
    const response = await fetch(`${service.url}/health`, { signal: AbortSignal.timeout(5000) })
    const health = await response.json()
    assert.equal(response.status, 200)
    assert.equal(health.product, 'standalone')
    assert.equal(health.capabilities.eac, true)
    assert.equal(health.capabilities.accountChannels, true)
    await listingStarted
    assert.equal(kiloCalls, 0)
  })
  if (!service) throw new Error('standalone did not start')
  const key = JSON.parse(fs.readFileSync(service.keyFile)).forwardKey
  await check('standalone generates its own API key without copying DSH data', () => {
    assert.match(key, /^ofm-/)
    assert.notEqual(key, 'dsh-only-key')
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).privateMarker, undefined)
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel)
  })
  await check('another instance cannot write the same data directory', async () => {
    await assert.rejects(startStandalone({ dataDir, port: 0, refresh: false }), { code: 'EEXIST' })
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, key)
  })
  await check('model list requires the standalone key and rejects the DSH key', async () => {
    assert.equal((await fetch(`${service.url}/v1/models`)).status, 401)
    assert.equal((await fetch(`${service.url}/v1/models`, { headers: { authorization: 'Bearer dsh-only-key' } })).status, 401)
    const response = await fetch(`${service.url}/v1/models`, { headers: { authorization: `Bearer ${key}` } })
    assert.equal(response.status, 200)
    assert.ok((await response.json()).data.length > 0)
  })
  await check('concurrent catalog refreshes coalesce with the boot round', async () => {
    const extra = service.runtime.refreshCatalog({ probe: false })
    assert.equal(listingCalls, 1)
    unhold()
    holdListing = undefined
    await Promise.all([service.ready, extra])
    assert.equal(listingCalls, 1)
    assert.equal(kiloCalls, 1)
    assert.equal(turns.length, 0, 'default startup must not spend availability probe requests')
    assert.deepEqual(service.runtime.catalog.map(entry => entry.id), [model, kiloModel])
  })
  await check('a probe request is not swallowed by an in-flight listing-only refresh', async () => {
    holdListing = new Promise(resolve => { unhold = resolve })
    listingStarted = new Promise(resolve => { signalListingStarted = resolve })
    const before = listingCalls
    const listingOnly = service.runtime.refreshCatalog({ probe: false })
    await listingStarted
    const probed = service.runtime.refreshCatalog({ probe: true })
    unhold()
    holdListing = undefined
    await Promise.all([listingOnly, probed])
    assert.equal(listingCalls, before + 2)
    assert.equal(turns.length, 1, 'only the anonymous model should be probed')
    assert.equal(service.runtime.catalog.find(row => row.channel === 'kilo')?.id, kiloModel)
  })
  await check('non-streaming Chat Completions uses the shared core', async () => {
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model, messages: [{ role: 'user', content: 'hello' }],
    }, key)
    const body = await response.json()
    assert.equal(response.status, 200)
    assert.equal(body.choices[0].message.content, 'core-ok')
    assert.equal(body.usage.prompt_tokens, 11)
    assert.equal(body.usage.completion_tokens, 7)
  })
  await check('streaming completions preserve deltas, usage and terminal frames', async () => {
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model, messages: [{ role: 'user', content: 'hello' }], stream: true,
    }, key)
    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /core-ok/)
    assert.match(body, /completion_tokens/)
    assert.match(body, /\[DONE\]/)
  })
  await check('Responses requests and the Kilo lane also run independently', async () => {
    const responses = await jsonRequest(`${service.url}/v1/responses`, { model, input: 'hello' }, key)
    const body = await responses.json()
    assert.equal(responses.status, 200)
    assert.ok(JSON.stringify(body.output).includes('core-ok'))
    const kilo = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model: kiloModel, messages: [{ role: 'user', content: 'hello' }],
    }, key)
    assert.equal(kilo.status, 200)
    assert.equal((await kilo.json()).choices[0].message.content, 'kilo-ok')
  })
  await check('独立服务的目录、探测和推理都带 v2 客户端指纹', () => {
    assert.ok(anonymousRequests.some(req => req.method === 'GET'))
    assert.ok(anonymousRequests.filter(req => req.method === 'POST').length >= 4)
    for (const req of anonymousRequests) {
      assert.equal(req.headers['user-agent'], 'opencode/latest/2.0.26/cli')
    }
  })
  await check('unknown models are refused before spending an upstream call', async () => {
    const before = turns.length
    const response = await jsonRequest(`${service.url}/v1/chat/completions`, {
      model: 'missing-model', messages: [{ role: 'user', content: 'hello' }],
    }, key)
    assert.equal(response.status, 404)
    assert.equal(turns.length, before)
  })
  await check('statistics persist and repeated shutdown releases the listener and lock', async () => {
    assert.equal(service.runtime.state().settings.forwardKey, key)
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), true)
    await Promise.all([service.close(), service.close()])
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
    const stats = JSON.parse(fs.readFileSync(path.join(dataDir, 'stats.json')))
    assert.ok(stats.requests >= 4)
    await assert.rejects(fetch(`${service.url}/health`))
    await assert.rejects(service.runtime.complete({ model, openAi: {} }), { statusCode: 503 })
  })
  await check('restart reuses only its own cached catalog, key and port', async () => {
    const calls = listingCalls
    const previousPort = service.port
    service = await startStandalone({ dataDir, refresh: false, logger: { warn() {} } })
    assert.equal(service.port, previousPort)
    assert.equal(JSON.parse(fs.readFileSync(service.keyFile)).forwardKey, key)
    assert.deepEqual(service.runtime.catalog.map(entry => entry.id), [model, kiloModel])
    assert.equal(listingCalls, calls)
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), sentinel)
  })
  await check('an empty Kilo pool clears its cached models and stops routing them', async () => {
    kiloListing = { data: [] }
    await service.runtime.refreshCatalog({ probe: false })
    assert.deepEqual(service.runtime.catalog.map(entry => entry.id), [model])
    await assert.rejects(service.runtime.complete({ model: kiloModel, openAi: {} }), { statusCode: 404 })
  })
  await check('stopping during a listing prevents late writes and more channel requests', async () => {
    holdListing = new Promise(resolve => { unhold = resolve })
    listingStarted = new Promise(resolve => { signalListingStarted = resolve })
    const before = kiloCalls
    const pending = service.runtime.refreshCatalog()
    await listingStarted
    await service.close()
    // 正常退出会刷出上一轮尚未落盘的缓存；只检查退出后没有迟到写入。
    const catalogBefore = fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8')
    unhold()
    holdListing = undefined
    await pending
    assert.equal(kiloCalls, before)
    assert.equal(fs.readFileSync(path.join(dataDir, 'catalog.json'), 'utf8'), catalogBefore)
    const calls = listingCalls
    await service.runtime.refreshCatalog()
    assert.equal(listingCalls, calls)
  })
  await check('自动探测已禁用：--probe 与周期刷新都不发探测，手动探测仍可用', async () => {
    const nativeTimeout = globalThis.setTimeout
    const nativeNow = Date.now
    const started = nativeNow()
    let elapsed = 0
    let periodic
    let onScheduled
    let probeService
    const warnings = []
    // 捕获真实周期任务并推进时钟，避免测试等待数十分钟。
    globalThis.setTimeout = (callback, ms, ...args) => {
      const handle = nativeTimeout(callback, ms, ...args)
      if (ms === 15 * 60_000) {
        periodic = { callback, args, handle }
        onScheduled?.()
      }
      return handle
    }
    Date.now = () => started + elapsed
    throttleTurns = true
    const runPeriod = async () => {
      assert.ok(periodic, '服务应安排下一轮周期任务')
      elapsed += 15 * 60_000
      clearTimeout(periodic.handle)
      let deadline
      const scheduled = new Promise((resolve, reject) => {
        onScheduled = resolve
        deadline = nativeTimeout(() => reject(new Error('周期刷新未完成')), 5000)
      })
      periodic.callback(...periodic.args)
      try { await scheduled } finally { clearTimeout(deadline); onScheduled = undefined }
    }
    try {
      const before = turns.length
      probeService = await startStandalone({
        dataDir: path.join(scratch, 'probe-disabled'), port: 0, probe: true,
        logger: { warn: message => warnings.push(message) },
      })
      await probeService.ready
      assert.equal(turns.length, before, '启动不得探测匿名模型')
      const listingsBefore = listingCalls
      await runPeriod()
      assert.equal(listingCalls, listingsBefore + 1, '周期刷新仍更新模型清单')
      assert.equal(turns.length, before, '周期刷新不得探测')
      await probeService.runtime.refreshCatalog({ probe: true, force: true })
      assert.equal(turns.length, before + 1, '显式手动探测仍可用')
      await runPeriod()
      assert.equal(turns.length, before + 1, '下一轮周期仍不得探测')
    } finally {
      await probeService?.close()
      globalThis.setTimeout = nativeTimeout
      Date.now = nativeNow
      throttleTurns = false
    }
  })
  await check('a separate process boots with plugin and DSH imports forbidden', async () => {
    const result = await child([
      '--experimental-loader', './scripts/lib/standalone-isolation-loader.mjs',
      '--input-type=module', '--eval',
      `import { startStandalone } from './packages/standalone/service.mjs';
       const service = await startStandalone({ port: 0, refresh: false });
       try {
         const response = await fetch(service.url + '/health');
         if ((await response.json()).product !== 'standalone') throw new Error('wrong product');
         if (globalThis[Symbol.for('our-free-model.generation')] !== undefined) throw new Error('plugin loaded');
         console.log('standalone-only');
       } finally { await service.close() }`,
    ], { OFM_HOME: path.join(scratch, 'isolated-child') })
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /standalone-only/)
  })
  await check('CLI help and invalid arguments do not start a service', async () => {
    const help = await child(['packages/standalone/cli.mjs', '--help'])
    assert.equal(help.code, 0)
    assert.match(help.stdout, /--data-dir/)
    for (const flag of ['--unknown', '--port', '--port=-1']) {
      assert.notEqual((await child(['packages/standalone/cli.mjs', flag])).code, 0)
    }
    assert.notEqual((await child(['packages/standalone/cli.mjs', '--port', '65536'])).code, 0)
  })
} finally {
  unhold?.()
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const target = fs.realpathSync(scratch)
  assert.ok(target.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`\nstandalone: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
