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
import assert from 'node:assert/strict'

import { startChanRelay, chanGatewayCredential, chanGatewayHome, chanGatewayPort, chanGatewayEnabled } from '../src/chan-relay.js'

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
const gateway = http.createServer((req, res) => {
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
const gatewayPort = await listen(gateway)

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
