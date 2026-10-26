import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-standalone-lan-'))
const dataDir = path.join(scratch, 'data')
const model = 'mimo-v2.6-flash-free'
let calls = 0
let streamGate
let notifyUpstreamClosed
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const upstream = http.createServer((req, res) => {
  req.resume()
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.url === '/models' ? [] : [{ id: model }] }))
      return
    }
    calls++
    res.once('close', () => notifyUpstreamClosed?.())
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame({ choices: [{ index: 0, delta: { content: 'LAN OK' } }] }))
    const finish = () => res.end(frame({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 3 },
    }) + 'data: [DONE]\n\n')
    if (streamGate) void streamGate.then(finish)
    else finish()
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = upstreamUrl
process.env.OUR_FREE_MODEL_KILO_BASE = upstreamUrl
const { startLanRelay } = await import('../src/forward.js')
const { startStandalone } = await import('../packages/standalone/service.mjs')
const relayStarts = []
const startRelay = async ({ config, ...options }) => {
  assert.equal(config().host, '0.0.0.0')
  const relay = await startLanRelay({ ...options, config: () => ({ ...config(), host: '127.0.0.1' }) })
  assert.equal(relay.server.address().address, '127.0.0.1')
  relayStarts.push(relay)
  return relay
}
const options = { dataDir, port: 0, refresh: false, logger: { warn() {} }, startRelay }
let service
let localKey
let lanKey
let cookie
let failures = 0
let checks = 0
const blockers = new Set()
const readSettings = () => JSON.parse(fs.readFileSync(service.keyFile, 'utf8'))
const request = async (base, route, { body, key, headers = {}, method } = {}) => {
  const response = await fetch(base + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      connection: 'close',
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...key ? { authorization: `Bearer ${key}` } : {},
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, value, headers: response.headers, text }
}
const management = (route, options = {}) => request(service.url, `/api/management${route}`, { key: localKey, ...options })
const settings = async patch => {
  const response = await management('/settings', { body: patch })
  assert.equal(response.status, 200, response.text)
  return response.value
}
const lanUrl = () => `http://127.0.0.1:${service.lan.port}`
const lanRequest = (route, options = {}) => request(lanUrl(), route, { key: lanKey, ...options })
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.stack}`) }
}
async function assertPortReleased(port, host = '127.0.0.1') {
  const server = net.createServer()
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve) }) }
  finally { await new Promise(resolve => server.close(resolve)) }
}
async function occupyPort() {
  const server = net.createServer(socket => socket.destroy())
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  blockers.add(server)
  return server
}
async function releaseBlocker(server) {
  await new Promise(resolve => server.close(resolve))
  blockers.delete(server)
}

try {
  await check('invalid programmatic LAN options fail before creating data', async () => {
    const invalid = path.join(scratch, 'invalid')
    for (const input of [{ lanEnabled: 'true' }, { lanPort: -1 }, { lanPort: 65536 }, { lanPort: 1.5 }]) {
      await assert.rejects(startStandalone({ ...options, dataDir: invalid, ...input }), TypeError)
    }
    assert.equal(fs.existsSync(invalid), false)
  })
  service = await startStandalone(options)
  await service.ready
  localKey = readSettings().forwardKey
  await service.runtime.refreshCatalog({ probe: false })
  await check('fresh service keeps LAN off and management on IPv4 loopback', async () => {
    assert.equal(service.lan.enabled, false)
    assert.equal(service.lan.running, false)
    assert.equal(service.lan.port, null)
    assert.equal(relayStarts.length, 0)
    assert.equal(readSettings().standaloneLanEnabled, false)
    const summary = await management('/summary')
    assert.equal(summary.status, 200)
    assert.equal(summary.value.settings.standaloneLanPort, 0)
    assert.equal(summary.value.capabilities.lan, true)
    assert.equal((await management('/lan/key')).value.key, '')
    const login = await management('/session', { key: '', body: { key: localKey } })
    assert.equal(login.status, 200)
    cookie = login.headers.get('set-cookie').split(';')[0]
  })
  await check('LAN settings and key endpoints require local management authentication', async () => {
    for (const route of ['/lan/key', '/summary']) {
      assert.equal((await management(route, { key: '' })).status, 401)
    }
    assert.equal((await management('/lan/key/rotate', { key: '', body: { confirm: true } })).status, 401)
    assert.equal((await management('/settings', { key: '', body: { standaloneLanEnabled: true } })).status, 401)
  })
  await check('unknown, malicious and malformed LAN fields are rejected atomically', async () => {
    await settings({ standaloneLanEnabled: false })
    const before = fs.readFileSync(service.keyFile, 'utf8')
    for (const body of [
      { standaloneLanEnabled: 'true' }, { standaloneLanEnabled: 1 }, { standaloneLanEnabled: null },
      ...[-1, 65536, 1.5, '18901', null, {}, []].map(standaloneLanPort => ({ standaloneLanPort })),
      { standaloneLanHost: '0.0.0.0' }, { targetPort: service.port }, { targetHost: 'evil.example' },
      { standaloneLanKey: 'injected' }, { forwardKey: 'injected' }, { localKey },
      { standaloneLanEnabled: true, unknown: true },
      JSON.parse('{"standaloneLanEnabled":true,"__proto__":{"polluted":true}}'),
      { standaloneLanEnabled: true, constructor: { prototype: { polluted: true } } },
      { standaloneLanEnabled: true, standaloneLanPort: -1 },
    ]) assert.equal((await management('/settings', { body })).status, 400)
    assert.equal(fs.readFileSync(service.keyFile, 'utf8'), before)
    assert.equal({}.polluted, undefined)
    assert.equal(relayStarts.length, 0)
    for (const body of [{}, { confirm: false }, { confirm: 'true' }, { confirm: true, key: 'injected' }]) {
      assert.equal((await management('/lan/key/rotate', { body })).status, 400)
    }
  })
  await check('enabling starts the shared relay with its own durable key and actual port', async () => {
    const result = await settings({ standaloneLanEnabled: true, standaloneLanPort: 0 })
    assert.equal(result.lan.running, true)
    assert.equal(result.lan.requestedPort, 0)
    assert.ok(result.lan.port > 0)
    assert.equal(result.lan.host, '127.0.0.1')
    lanKey = (await management('/lan/key')).value.key
    assert.ok(lanKey && lanKey !== localKey)
    assert.equal(readSettings().standaloneLanKey, lanKey)
    assert.equal(readSettings().standaloneLanPort, 0)
    assert.equal(readSettings().forwardKey, localKey)
    assert.equal(relayStarts.at(-1).server.address().address, '127.0.0.1')
  })
  await check('LAN refuses missing/wrong/local keys and cannot log into local management', async () => {
    for (const key of ['', 'wrong', localKey]) {
      assert.equal((await lanRequest('/v1/models', { key })).status, 401)
    }
    assert.equal((await lanRequest('/health', { key: '' })).status, 401)
    assert.equal((await lanRequest('/v1/models', { key: '', headers: { 'x-api-key': lanKey } })).status, 200)
    assert.equal((await management('/summary', { key: lanKey })).status, 401)
    assert.equal((await management('/session', { key: '', body: { key: lanKey } })).status, 401)
  })
  await check('relay rejects UI, health, assets and every management path even with management credentials', async () => {
    for (const route of [
      '/', '/health', '/assets/app.js', '/settings.json', '/v1/embeddings',
      '/api/management', '/api/management/summary', '/api/management/key',
      '/api/management/lan/key', '/api/management/session', '/api/management/settings',
      '/v1/../api/management/key', '/v1/%2e%2e/api/management/key',
      '/v1/%2f..%2fapi/management/key',
    ]) {
      const response = await lanRequest(route, { headers: { cookie } })
      assert.equal(response.status, 404, route)
      assert.ok(!response.text.includes(localKey), route)
      assert.equal(response.headers.get('set-cookie'), null, route)
    }
    assert.equal((await lanRequest('/api/management/settings', { body: { enabled: false } })).status, 404)
    const preflight = await lanRequest('/api/management/key', { key: '', method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.text, '')
    assert.equal(readSettings().enabled, true)
  })
  await check('summary, health and model responses do not disclose either key', async () => {
    for (const response of [await management('/summary'), await request(service.url, '/health'), await lanRequest('/v1/models')]) {
      assert.equal(response.status, 200)
      assert.ok(!response.text.includes(localKey))
      assert.ok(!response.text.includes(lanKey))
    }
    assert.ok((await lanRequest('/models')).value.data.some(row => row.id === model))
  })
  await check('Chat and Responses use the real inference runtime through the relay', async () => {
    const before = calls
    const chat = await lanRequest('/v1/chat/completions', { body: { model, messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(chat.status, 200)
    assert.equal(chat.value.choices[0].message.content, 'LAN OK')
    const responses = await lanRequest('/v1/responses', { body: { model, input: 'ping' } })
    assert.equal(responses.status, 200)
    assert.ok(JSON.stringify(responses.value.output).includes('LAN OK'))
    const counted = await lanRequest('/v1/messages/count_tokens', { body: { model, messages: [{ role: 'user', content: 'ping' }] } })
    assert.equal(counted.status, 200)
    assert.ok(counted.value.input_tokens > 0)
    assert.equal(calls, before + 2)
  })
  await check('SSE is delivered before upstream finishes, without buffering the stream', async () => {
    let finish
    streamGate = new Promise(resolve => { finish = resolve })
    try {
      const response = await fetch(lanUrl() + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${lanKey}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(10000),
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      const reader = response.body.getReader()
      let start = ''
      while (!start.includes('LAN OK')) {
        const first = await reader.read()
        assert.equal(first.done, false)
        start += Buffer.from(first.value).toString()
      }
      assert.match(start, /LAN OK/)
      assert.ok(!start.includes('[DONE]'))
      finish()
      let tail = ''
      for (;;) {
        const next = await reader.read()
        if (next.done) break
        tail += Buffer.from(next.value).toString()
      }
      assert.match(tail, /\[DONE\]/)
    } finally { finish(); streamGate = undefined }
  })
  await check('cancelling a relay stream closes the real upstream request', async () => {
    let finish
    let response
    streamGate = new Promise(resolve => { finish = resolve })
    const closed = new Promise(resolve => { notifyUpstreamClosed = resolve })
    try {
      response = await fetch(lanUrl() + '/v1/chat/completions', {
        method: 'POST', headers: { authorization: `Bearer ${lanKey}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(10000),
      })
      const reader = response.body.getReader()
      let received = ''
      while (!received.includes('LAN OK')) {
        const next = await reader.read()
        assert.equal(next.done, false)
        received += Buffer.from(next.value).toString()
      }
      await reader.cancel()
      let deadline
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error('upstream cancellation timed out')), 2000)
        })])
      } finally { clearTimeout(deadline) }
      assert.equal((await management('/summary')).status, 200)
    } finally { finish(); streamGate = undefined; notifyUpstreamClosed = undefined }
  })
  await check('applying automatic port again keeps the same live relay', async () => {
    const previous = service.lan.port
    const count = relayStarts.length
    await settings({ standaloneLanEnabled: true, standaloneLanPort: 0 })
    assert.equal(service.lan.port, previous)
    assert.equal(relayStarts.length, count)
    assert.equal(readSettings().standaloneLanPort, 0)
  })
  await check('LAN key rotation invalidates the old key immediately and preserves local management', async () => {
    const previous = lanKey
    const response = await management('/lan/key/rotate', { key: '', headers: { cookie }, body: { confirm: true } })
    assert.equal(response.status, 200)
    lanKey = response.value.key
    assert.notEqual(lanKey, previous)
    assert.equal(readSettings().forwardKey, localKey)
    assert.equal((await lanRequest('/v1/models', { key: previous })).status, 401)
    assert.equal((await lanRequest('/v1/models')).status, 200)
    assert.equal((await management('/summary', { key: '', headers: { cookie } })).status, 200)
  })
  await check('local key rotation keeps LAN clients working without sharing the local key', async () => {
    const previous = localKey
    const response = await management('/key/rotate', { key: '', headers: { cookie }, body: { confirm: true } })
    assert.equal(response.status, 200)
    localKey = response.value.key
    assert.notEqual(localKey, previous)
    assert.equal((await management('/summary', { key: previous })).status, 401)
    assert.equal((await lanRequest('/v1/models')).status, 200)
    assert.equal((await lanRequest('/v1/models', { key: localKey })).status, 401)
    assert.equal(readSettings().standaloneLanKey, lanKey)
  })
  await check('disable closes the LAN port, retains the key, and re-enable restores access', async () => {
    const previousPort = service.lan.port
    await settings({ standaloneLanEnabled: false })
    assert.equal(service.lan.running, false)
    assert.equal(service.lan.port, null)
    await assertPortReleased(previousPort)
    assert.equal((await management('/lan/key')).value.key, lanKey)
    await settings({ standaloneLanEnabled: true })
    assert.equal((await lanRequest('/v1/models')).status, 200)
    assert.equal(readSettings().standaloneLanKey, lanKey)
  })
  await check('master switch immediately releases LAN and can be restored through loopback management', async () => {
    const previousPort = service.lan.port
    await settings({ enabled: false })
    assert.equal(service.lan.enabled, true)
    assert.equal(service.lan.running, false)
    await assertPortReleased(previousPort)
    assert.equal((await management('/summary')).status, 200)
    assert.equal((await request(service.url, '/v1/models', { key: localKey })).status, 503)
    await settings({ enabled: true })
    assert.equal((await lanRequest('/v1/models')).status, 200)
    const port = service.lan.port
    assert.equal((await management('/channels/rpc', { body: { method: 'gateway.setEnabled', payload: { enabled: false } } })).status, 200)
    assert.equal(service.lan.running, false)
    await assertPortReleased(port)
    assert.equal((await management('/channels/rpc', { body: { method: 'gateway.setEnabled', payload: { enabled: true } } })).status, 200)
    assert.equal((await lanRequest('/v1/models')).status, 200)
  })
  await check('occupied requested port reports an error and retries without replacing the saved port', async () => {
    const blocker = await occupyPort()
    const wanted = blocker.address().port
    const oldPort = service.lan.port
    const result = await settings({ standaloneLanPort: wanted })
    assert.equal(result.lan.requestedPort, wanted)
    assert.equal(result.lan.port, null)
    assert.equal(result.lan.running, false)
    assert.match(result.lan.error, /EADDRINUSE/)
    assert.equal(readSettings().standaloneLanPort, wanted)
    await assertPortReleased(oldPort)
    await releaseBlocker(blocker)
    await settings({ standaloneLanPort: wanted })
    assert.equal(service.lan.port, wanted)
    assert.equal(service.lan.error, null)
    assert.equal((await lanRequest('/v1/models')).status, 200)
  })
  await check('disk failure preserves live settings and keys without claiming success', async () => {
    const nativeRename = fs.renameSync
    const port = service.lan.port
    fs.renameSync = (source, target) => {
      if (target === service.keyFile) throw Object.assign(new Error('fixture: read only'), { code: 'EACCES' })
      return nativeRename(source, target)
    }
    try {
      assert.equal((await management('/settings', { body: { standaloneLanEnabled: false } })).status, 500)
      assert.equal(service.lan.port, port)
      assert.equal(service.lan.enabled, true)
      assert.equal((await management('/lan/key/rotate', { body: { confirm: true } })).status, 500)
      assert.equal((await management('/lan/key')).value.key, lanKey)
      assert.equal((await lanRequest('/v1/models')).status, 200)
    } finally { fs.renameSync = nativeRename }
    await settings({ standaloneLanEnabled: true })
  })
  await check('normal shutdown releases both ports and restart preserves LAN intent and key', async () => {
    const lanPort = service.lan.port
    const localPort = service.port
    const oldCookie = cookie
    await Promise.all([service.close(), service.close()])
    await assertPortReleased(lanPort)
    await assertPortReleased(localPort)
    assert.equal(fs.existsSync(path.join(dataDir, 'service.lock')), false)
    service = await startStandalone(options)
    await service.ready
    assert.equal(service.lan.running, true)
    assert.equal(service.lan.port, lanPort)
    assert.equal(readSettings().standaloneLanKey, lanKey)
    assert.equal(readSettings().forwardKey, localKey)
    assert.equal((await management('/summary', { key: '', headers: { cookie: oldCookie } })).status, 401)
    assert.equal((await lanRequest('/v1/models')).status, 200)
  })
  await check('concurrent LAN changes serialize and the final disable leaves no listener', async () => {
    const responses = await Promise.all([
      management('/settings', { body: { standaloneLanPort: 0 } }),
      management('/settings', { body: { standaloneLanEnabled: true } }),
    ])
    assert.ok(responses.every(response => response.status === 200))
    await settings({ standaloneLanEnabled: false })
    for (const relay of relayStarts) assert.equal(relay.server.listening, false)
    assert.equal(readSettings().standaloneLanKey, lanKey)
  })
  await check('explicit startup disable persists and setting a LAN port alone does not enable it', async () => {
    await service.close()
    service = await startStandalone({ ...options, lanEnabled: false, lanPort: 0 })
    assert.equal(service.lan.enabled, false)
    await service.close()
    service = await startStandalone({ ...options, lanPort: 0 })
    assert.equal(service.lan.enabled, false)
    assert.equal(service.lan.running, false)
    assert.equal(readSettings().standaloneLanKey, lanKey)
  })
  await check('IPv6 loopback management uses an inference-only IPv4 relay target', async () => {
    let ipv6
    const startCount = relayStarts.length
    try {
      ipv6 = await startStandalone({ ...options, dataDir: path.join(scratch, 'ipv6'), host: '::1', lanEnabled: true })
      await ipv6.ready
      assert.match(ipv6.url, /^http:\/\/\[::1\]:/)
      const saved = JSON.parse(fs.readFileSync(ipv6.keyFile, 'utf8'))
      assert.equal((await request(ipv6.url, '/api/management/summary', { key: saved.forwardKey })).status, 200)
      const relay = relayStarts[startCount]
      assert.ok(relay)
      assert.equal((await request(`http://127.0.0.1:${ipv6.lan.port}`, '/v1/models', { key: saved.standaloneLanKey })).status, 200)
      assert.equal((await request(`http://127.0.0.1:${ipv6.lan.port}`, '/api/management/key', { key: saved.standaloneLanKey })).status, 404)
    } finally { await ipv6?.close() }
  })
  await check('a persisted LAN key equal to the local key is replaced before any relay starts', async () => {
    const directory = path.join(scratch, 'key-collision')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
      forwardKey: 'fixture-local-only', standaloneLanKey: 'fixture-local-only',
      standaloneLanEnabled: true, standaloneLanPort: 0,
    }))
    let isolated
    try {
      isolated = await startStandalone({ ...options, dataDir: directory })
      await isolated.ready
      const saved = JSON.parse(fs.readFileSync(isolated.keyFile, 'utf8'))
      assert.equal(saved.forwardKey, 'fixture-local-only')
      assert.notEqual(saved.standaloneLanKey, saved.forwardKey)
      const base = `http://127.0.0.1:${isolated.lan.port}`
      assert.equal((await request(base, '/v1/models', { key: saved.forwardKey })).status, 401)
      assert.equal((await request(base, '/v1/models', { key: saved.standaloneLanKey })).status, 200)
    } finally { await isolated?.close() }
  })
  await check('shutdown during an in-flight relay start releases the late listener and data lock', async () => {
    let entered
    let resume
    let isolated
    let pending
    let lateRelay
    const starting = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { resume = resolve })
    const directory = path.join(scratch, 'closing-relay')
    try {
      isolated = await startStandalone({
        ...options, dataDir: directory,
        startRelay: async input => {
          entered()
          await gate
          lateRelay = await startRelay(input)
          return lateRelay
        },
      })
      await isolated.ready
      const saved = JSON.parse(fs.readFileSync(isolated.keyFile, 'utf8'))
      pending = request(isolated.url, '/api/management/settings', {
        key: saved.forwardKey, body: { standaloneLanEnabled: true },
      }).catch(() => undefined)
      await starting
      const closed = isolated.close()
      resume()
      await closed
      await pending
      assert.ok(lateRelay)
      assert.equal(lateRelay.server.listening, false)
      await assertPortReleased(lateRelay.port)
      assert.equal(fs.existsSync(path.join(directory, 'service.lock')), false)
    } finally { resume(); await isolated?.close(); await pending }
  })
  await check('CLI handles opt-in, opt-out and port persistence without exposing credentials', async () => {
    const source = fs.readFileSync(new URL('../packages/standalone/cli.mjs', import.meta.url), 'utf8')
      .replace(/^#![^\n]*\n/, '').replace(/^import .+\r?\n/gm, '')
    for (const [flags, expected] of [
      [[], {}],
      [['--lan', '--lan-port', '18901'], { lanEnabled: true, lanPort: 18901 }],
      [['--no-lan', '--lan-port', '0'], { lanEnabled: false, lanPort: 0 }],
      [['--lan-port', '18901'], { lanPort: 18901 }],
    ]) {
      let received
      let output = ''
      vm.runInNewContext(source, {
        path,
        startStandalone: async value => {
          received = value
          return { product: 'fixture', version: 'fixture', url: 'http://127.0.0.1:1', managementUrl: 'http://127.0.0.1:1/#login=fixture', keyFile: 'fixture/settings.json', lan: {} }
        },
        process: { argv: ['node', 'cli.mjs', ...flags], once() {}, stdout: { write: text => { output += text } }, stderr: { write: text => { output += text } } },
      })
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(JSON.parse(JSON.stringify(received)), expected)
      assert.ok(!output.includes(localKey) && !output.includes(lanKey))
    }
    for (const value of ['-1', '65536', '1.5', 'abc']) {
      const child = spawnSync(process.execPath, ['packages/standalone/cli.mjs', '--lan-port', value], {
        cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 10000,
      })
      assert.equal(child.status, 1)
    }
    const hostFlag = spawnSync(process.execPath, ['packages/standalone/cli.mjs', '--host', '0.0.0.0'], {
      cwd: new URL('..', import.meta.url), encoding: 'utf8', windowsHide: true, timeout: 10000,
    })
    assert.equal(hostFlag.status, 1)
  })
} finally {
  await service?.close()
  for (const relay of relayStarts) await relay.close()
  for (const server of blockers) await releaseBlocker(server)
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const target = fs.realpathSync(scratch)
  const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep
  assert.ok(target.startsWith(tempRoot) && path.basename(target).startsWith('ofm-standalone-lan-'))
  fs.rmSync(target, { recursive: true, force: true })
}
console.log(`standalone-lan: ${checks - failures}/${checks} checks passed; all relay binds used 127.0.0.1`)
process.exitCode = failures ? 1 : 0
