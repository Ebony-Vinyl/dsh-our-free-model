/**
 * Offline checks for the channels' gateway relay (src/chan-relay.js).
 *
 * The relay is a security boundary — it holds the pack's gateway credential
 * and decides who may reach it — so these checks drive it against a stub
 * upstream the way an attacker and a legitimate client would:
 * wrong key, no key, loop attempts, off-switch, and the credential lookup.
 *
 * Run: node scripts/chan-relay-test.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import assert from 'node:assert/strict'

import { foldDeveloperRole, startChanRelay, chanGatewayCredential, chanGatewayHome, chanGatewayPort, chanGatewayEnabled } from '../src/chan-relay.js'

const checks = []
const check = (name, got, want) => {
  try {
    assert.deepEqual(got, want)
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}`)
    checks.push(`       got: ${JSON.stringify(got)}`)
    checks.push(`      want: ${JSON.stringify(want)}`)
    process.exitCode = 1
  }
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))

// ── the stub "gateway": answers only with its own credential attached ────────
let seenAuthorization = ''
let seenHopHeader = undefined
const seenRequests = []
const gateway = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    seenRequests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) })
    seenAuthorization = String(req.headers.authorization ?? '')
    seenHopHeader = req.headers['x-ofm-chan-relay-hop']
    if (req.headers.authorization !== 'Bearer gw-secret') {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"object":"list","data":[{"id":"deepseek-v4.1-flash"}]}')
  })
})
const gatewayPort = await listen(gateway)
const lastSeen = () => seenRequests.at(-1)

// The relay under test.
const relay = await startChanRelay({
  config: () => ({
    enabled: true,
    host: '127.0.0.1',
    port: 0,
    lanKey: 'relay-key',
    gatewayHost: '127.0.0.1',
    gatewayPort,
    gatewayKey: 'gw-secret',
  }),
  log: () => {},
})
check('the relay binds a port of its own', relay.port > 0 && relay.port !== gatewayPort, true)

const call = (path, headers = {}, method = 'GET') => fetch(`http://127.0.0.1:${relay.port}${path}`, {
  method,
  headers,
  // Nothing here sends a body, but Node refuses to pipe a GET with one anyway.
}).catch(error => ({ fetchError: String(error?.cause?.code ?? error) }))

/**
 * Drive the relay with a raw request so exact bytes, framing and headers can
 * be inspected at the stub gateway. An error after the response has begun
 * still resolves with the status, which is what the over-limit case needs.
 */
const request = (port, { method = 'GET', route = '/', headers = {}, body } = {}) => new Promise(resolve => {
  let settled = false
  let status = null
  let responseHeaders = null
  const chunks = []
  const finish = value => {
    if (settled) return
    settled = true
    resolve(value)
  }
  const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, res => {
    status = res.statusCode
    responseHeaders = res.headers
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => finish({ status, headers: responseHeaders, body: Buffer.concat(chunks) }))
    res.on('error', error => finish({ status, headers: responseHeaders, body: Buffer.concat(chunks), error }))
  })
  req.on('error', error => finish({ status, headers: responseHeaders, body: Buffer.concat(chunks), error }))
  // Write before ending so the client really streams (chunked framing), the
  // way an SDK uploads a body; a bare end(buffer) lets Node add content-length.
  const payload = body === undefined ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  if (payload === null || payload.length === 0) req.end()
  else if (payload.length === 1) req.end(payload)
  else {
    req.write(payload.subarray(0, 1))
    req.end(payload.subarray(1))
  }
})

let response = await call('/v1/models')
check('a caller with no key is refused', response.status, 401)
response = await call('/v1/models', { authorization: 'Bearer wrong-key' })
check('a caller with the wrong key is refused', response.status, 401)
response = await call('/v1/models', { 'x-api-key': 'relay-key' })
check('the key is accepted as x-api-key too', response.status, 200)
response = await call('/v1/models', { authorization: 'Bearer relay-key' })
check('the relay key reaches the gateway', response.status, 200)
check('and the gateway saw its own credential, never the relay key', seenAuthorization, 'Bearer gw-secret')
const body = await response.json()
check('the forwarded answer arrives intact', body?.data?.[0]?.id, 'deepseek-v4.1-flash')
check('the hop marker rode along (loop protection armed upstream)', seenHopHeader, '1')

response = await call('/v1/chat/completions', { authorization: 'Bearer relay-key' }, 'POST')
check('chat completions is on the allowlist', response.status, 200)
response = await call('/v1/responses', { authorization: 'Bearer relay-key' }, 'POST')
check('the responses API is on the allowlist', response.status, 200)
response = await call('/admin/whatever', { authorization: 'Bearer relay-key' })
check('a non-model path is 404 before anything is forwarded', response.status, 404)
response = await call('/v1/models', { authorization: 'Bearer relay-key', 'x-ofm-chan-relay-hop': '1' })
check('a request that already hopped once is refused', response.status, 508)

// ── the Chat Completions developer-role fold ────────────────────────────────
const jsonHeaders = { authorization: 'Bearer relay-key', 'content-type': 'application/json' }

// Pure-function edges first: these are the shapes the relay must forward as-is.
check('foldDeveloperRole leaves non-JSON alone',
  foldDeveloperRole(Buffer.from('developer but not json')), null)
check('foldDeveloperRole leaves a non-array messages field alone',
  foldDeveloperRole(Buffer.from('{"messages":{"role":"developer"}}')), null)
check('foldDeveloperRole leaves a body without developer alone',
  foldDeveloperRole(Buffer.from('{"messages":[{"role":"user","content":"hi"}]}')), null)
check('foldDeveloperRole leaves the word developer in content alone',
  foldDeveloperRole(Buffer.from('{"messages":[{"role":"user","content":"developer"}]}')), null)
const escapedRole = foldDeveloperRole(Buffer.from('{"messages":[{"role":"develop\\u0065r","content":"x"}]}'))
check('foldDeveloperRole still finds an escaped developer role', escapedRole?.folded, 1)
check('and folds the escaped role to system',
  escapedRole === null ? null : JSON.parse(escapedRole.payload.toString('utf8')).messages[0].role, 'system')

const chatBody = JSON.stringify({
  model: 'deepseek-v4.1-flash',
  messages: [
    { role: 'developer', content: 'answer as terse as possible', name: 'policy' },
    { role: 'user', content: '你好，世界' },
    { role: 'assistant', content: 'hello' },
  ],
  temperature: 0.2,
  stream: false,
}, null, 2)
response = await request(relay.port, { method: 'POST', route: '/v1/chat/completions', headers: jsonHeaders, body: chatBody })
check('a chat body with developer is accepted', response.status, 200)
let forwarded = lastSeen()
let forwardedJson = JSON.parse(forwarded.body.toString('utf8'))
check('developer is folded to system', forwardedJson.messages.map(message => message.role), ['system', 'user', 'assistant'])
check('the folded message keeps its other fields', forwardedJson.messages[0],
  { role: 'system', content: 'answer as terse as possible', name: 'policy' })
check('unrelated top-level fields survive',
  { model: forwardedJson.model, temperature: forwardedJson.temperature, stream: forwardedJson.stream },
  { model: 'deepseek-v4.1-flash', temperature: 0.2, stream: false })
check('the rewritten body is framed by content-length', forwarded.headers['content-length'], String(forwarded.body.length))
check('and no transfer-encoding reaches upstream', forwarded.headers['transfer-encoding'], undefined)

response = await request(relay.port, {
  method: 'POST',
  route: '/v1/chat/completions',
  headers: { ...jsonHeaders, 'content-type': 'application/json; charset=utf-8', 'content-encoding': 'Identity' },
  body: chatBody,
})
check('identity encoding still allows the fold',
  JSON.parse(lastSeen().body.toString('utf8')).messages[0].role, 'system')

const exactBytes = Buffer.from('{\n  "model": "m",\n  "messages": [ {"role": "system", "content": "keep  spaces"}, {"role":"user","content":"你好"} ]\n}\n', 'utf8')
response = await request(relay.port, { method: 'POST', route: '/v1/chat/completions', headers: jsonHeaders, body: exactBytes })
check('a body without developer is accepted', response.status, 200)
forwarded = lastSeen()
check('a body without developer is forwarded byte for byte', Buffer.compare(forwarded.body, exactBytes), 0)
check('its buffered length is restated exactly', forwarded.headers['content-length'], String(exactBytes.length))

const objectMessages = Buffer.from('{"model":"m","messages":{"role":"developer","content":"x"}}')
response = await request(relay.port, { method: 'POST', route: '/v1/chat/completions', headers: jsonHeaders, body: objectMessages })
check('a non-array messages field is accepted', response.status, 200)
forwarded = lastSeen()
check('a non-array messages field is forwarded byte for byte', Buffer.compare(forwarded.body, objectMessages), 0)

const escapedText = Buffer.from(String.raw`{"model":"m","messages":[{"role":"user","content":"\u4f60\u597d"}]}`)
response = await request(relay.port, { method: 'POST', route: '/v1/chat/completions', headers: jsonHeaders, body: escapedText })
check('a body with escapes but no developer is accepted', response.status, 200)
forwarded = lastSeen()
check('and is still forwarded byte for byte', Buffer.compare(forwarded.body, escapedText), 0)

const notJson = Buffer.from('developer but this is not JSON')
response = await request(relay.port, { method: 'POST', route: '/v1/chat/completions', headers: jsonHeaders, body: notJson })
check('a non-JSON chat body is accepted', response.status, 200)
forwarded = lastSeen()
check('a non-JSON chat body is forwarded byte for byte', Buffer.compare(forwarded.body, notJson), 0)

const wrongTypeBody = Buffer.from('{"messages":[{"role":"developer","content":"x"}]}')
response = await request(relay.port, {
  method: 'POST',
  route: '/v1/chat/completions',
  headers: { authorization: 'Bearer relay-key', 'content-type': 'text/plain; charset=utf-8' },
  body: wrongTypeBody,
})
check('a non-JSON content-type is accepted', response.status, 200)
forwarded = lastSeen()
check('a non-JSON content-type is forwarded byte for byte', Buffer.compare(forwarded.body, wrongTypeBody), 0)
check('a non-JSON content-type keeps its streaming framing', forwarded.headers['transfer-encoding'], 'chunked')
check('the developer role survives untouched', JSON.parse(forwarded.body.toString('utf8')).messages[0].role, 'developer')

const responsesBody = Buffer.from('{"model":"m","input":[{"role":"developer","content":"x"}],"messages":[{"role":"developer","content":"y"}]}')
response = await request(relay.port, { method: 'POST', route: '/v1/responses', headers: jsonHeaders, body: responsesBody })
check('the responses API is accepted', response.status, 200)
forwarded = lastSeen()
check('/v1/responses is forwarded byte for byte', Buffer.compare(forwarded.body, responsesBody), 0)
check('/v1/responses keeps its developer role', JSON.parse(forwarded.body.toString('utf8')).messages[0].role, 'developer')
check('/v1/responses keeps its streaming framing', forwarded.headers['transfer-encoding'], 'chunked')

const compressedBody = zlib.gzipSync(Buffer.from('{"messages":[{"role":"developer","content":"x"}]}'))
response = await request(relay.port, {
  method: 'POST',
  route: '/v1/chat/completions',
  headers: { ...jsonHeaders, 'content-encoding': 'gzip' },
  body: compressedBody,
})
check('a compressed chat body is accepted', response.status, 200)
forwarded = lastSeen()
check('a compressed chat body is forwarded byte for byte', Buffer.compare(forwarded.body, compressedBody), 0)
check('a compressed chat body is not rewritten',
  JSON.parse(zlib.gunzipSync(forwarded.body).toString('utf8')).messages[0].role, 'developer')

// A tiny cap keeps the overflow check fast and deterministic; the shipped
// default is 16 MiB, and this exercises the same readBody branch.
const smallRelay = await startChanRelay({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, lanKey: 'relay-key', gatewayHost: '127.0.0.1', gatewayPort, gatewayKey: 'gw-secret' }),
  log: () => {},
  requestBodyLimit: 1024,
})
const seenBeforeOversize = seenRequests.length
response = await request(smallRelay.port, {
  method: 'POST',
  route: '/v1/chat/completions',
  headers: jsonHeaders,
  body: Buffer.alloc(2048, 0x20),
})
check('an over-limit chat body is refused with 413', response.status, 413)
check('the 413 asks for the connection to close', response.headers.connection, 'close')
check('the 413 is an OpenAI-shaped error', JSON.parse(response.body.toString('utf8'))?.error?.code, 'invalid_request_error')
check('an over-limit body never reaches the gateway', seenRequests.length, seenBeforeOversize)
await smallRelay.close()

// ── the switches: disabled relay, missing gateway credential ─────────────────
let disabled = true
const offRelay = await startChanRelay({
  config: () => ({ enabled: !disabled, host: '127.0.0.1', port: 0, lanKey: 'k', gatewayHost: '127.0.0.1', gatewayPort, gatewayKey: 'gw-secret' }),
  log: () => {},
})
response = await call(`/v1/models`.replace(String(relay.port), String(offRelay.port)), { authorization: 'Bearer k' }).catch(() => null)
// The off-switch answers on its own port.
response = await fetch(`http://127.0.0.1:${offRelay.port}/v1/models`, { headers: { authorization: 'Bearer k' } })
check('a switched-off relay answers 503', response.status, 503)
await offRelay.close()

const noKeyRelay = await startChanRelay({
  config: () => ({ enabled: true, host: '127.0.0.1', port: 0, lanKey: 'k', gatewayHost: '127.0.0.1', gatewayPort, gatewayKey: '' }),
  log: () => {},
})
response = await fetch(`http://127.0.0.1:${noKeyRelay.port}/v1/models`, { headers: { authorization: 'Bearer k' } })
check('a relay with no gateway credential fails closed (503), not open', response.status, 503)
await noKeyRelay.close()

await relay.close()
await new Promise(resolve => gateway.close(resolve))

// ── the credential lookup: env outranks the file, both are read fresh ────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-chan-relay-'))
check('no file and no env means no credential', chanGatewayCredential({ home, env: {} }), null)
fs.mkdirSync(path.join(home, 'openai-gateway'))
fs.writeFileSync(path.join(home, 'openai-gateway', 'api-key'), 'file-key\n', 'utf8')
check('the gateway key file is found under the dsh home',
  chanGatewayCredential({ home, env: {} }), { key: 'file-key', fromEnv: false, path: path.join(home, 'openai-gateway', 'api-key') })
check('an env override outranks the file',
  chanGatewayCredential({ home, env: { DSH_OPENAI_GATEWAY_API_KEY: 'env-key' } }), { key: 'env-key', fromEnv: true, path: null })
fs.rmSync(home, { recursive: true, force: true })

const homes = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-channel-homes-'))
try {
  const envHome = path.join(homes, 'env')
  const profileHome = path.join(homes, 'profile')
  const overrideHome = path.join(homes, 'override')
  for (const [directory, key] of [[envHome, 'wrong-profile-key'], [profileHome, 'profile-key'], [overrideHome, 'override-key']]) {
    fs.mkdirSync(path.join(directory, 'openai-gateway'), { recursive: true })
    fs.writeFileSync(path.join(directory, 'openai-gateway', 'api-key'), `${key}\n`)
  }
  const env = { DSH_HOME: envHome }
  check('a missing profileContext falls back to DSH_HOME', chanGatewayHome({ env }), envHome)
  check('profileContext.home outranks a different DSH_HOME',
    chanGatewayCredential({ profileContext: { home: profileHome }, env })?.key, 'profile-key')
  check('the channel state override outranks profileContext.home',
    chanGatewayCredential({ profileContext: { home: profileHome }, env: { ...env, DSH_CHANNEL_PACK_STATE_DIR: ` ${overrideHome} ` } })?.key, 'override-key')
  check('the env API key still outranks all directory sources',
    chanGatewayCredential({ profileContext: { home: profileHome }, env: { ...env, DSH_OPENAI_GATEWAY_API_KEY: 'override-api-key' } })?.key, 'override-api-key')
  check('a profile with no key must not use another home credential',
    chanGatewayCredential({ profileContext: { home: path.join(homes, 'missing') }, env }), null)
} finally {
  fs.rmSync(homes, { recursive: true, force: true })
}

check('the gateway port reads the env override', chanGatewayPort({ DSH_OPENAI_GATEWAY_PORT: '9001' }), 9001)
check('a bad port falls back to the default rather than guessing', chanGatewayPort({ DSH_OPENAI_GATEWAY_PORT: 'not-a-port' }), 8326)
check('the gateway is on unless explicitly disabled', [
  chanGatewayEnabled({}),
  chanGatewayEnabled({ DSH_OPENAI_GATEWAY_ENABLED: '0' }),
  chanGatewayEnabled({ DSH_OPENAI_GATEWAY_ENABLED: 'false' }),
], [true, false, false])

console.log(checks.join('\n'))
console.log(`${checks.filter(l => l.startsWith('ok')).length} check(s) passed`)
