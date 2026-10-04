/**
 * The co-paid lane: seal, gate, and wire, offline.
 *
 * Four layers are pinned here, each because its failure would be silent in
 * production:
 *
 * 1. **The seal opens where it should and nowhere else.** The shipped seal must
 *    decrypt (shape checks only — the plaintext never appears in this suite),
 *    tampered bytes and wrong shards must fail closed, and the host gate must
 *    admit exactly the two desktop shells and refuse everything else,
 *    including a lone forged signal.
 * 2. **No readable credential ships.** Every file the package publishes is
 *    scanned for key and endpoint shapes; the minting tool must be ignored by
 *    git; the scan needles are assembled at runtime so this file never
 *    matches itself.
 * 3. **The adapter's sealed branch fails locked, streams unlocked.** A locked
 *    host yields one non-retryable turn failure; an unlocked one reaches a
 *    local stand-in relay with the bearer header, streams DeepSeek-style
 *    reasoning frames through the harness chunk protocol, and accounts usage.
 * 4. **The roster exists only where the gate opens.** A full boot of the Host
 *    half with the Tauri shell's signals simulated lists the sealed models on
 *    the main route; the same boot without them lists none.
 *
 * Local network only: the "relay" is a loopback HTTP server. The real lane is
 * never contacted, and the free lane's quota is not spent.
 *
 * Run: node scripts/vault-test.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const repo = fileURLToPath(new URL('..', import.meta.url))

// The lane's wire module reads UPSTREAM_BASE once for the free lane; the sealed
// lane has its own base from the seal. Import order matters for the boot blocks.
process.env.OUR_FREE_MODEL_BASE ??= 'http://127.0.0.1:9'
const { detectSealedHost, unlockSealedLane, openSeal, openSealWith, deriveSealKey, SEAL_AAD, IV_BYTES, TAG_BYTES } = await import('../src/vault.js')
const { buildEacCatalog, eacDisplayName, isEacEntry, EAC_CHANNEL } = await import('../src/catalog.js')
const { FreeModelAdapter } = await import('../src/adapter.js')
const { signSealedRequest, fetchSealedListing, postSealedStreamed } = await import('../src/eac.js')
const gateway = await import('../worker/worker.js')
const { createGatewayServer, resetAnalytics } = await import('../worker/gateway-node.mjs')

// ── 1. the seal and the gate ─────────────────────────────────────────────────
{
  const opened = openSeal()
  check('the shipped seal opens', opened !== null, true)
  check('its endpoint is an https URL with a path', opened !== null && opened.base.startsWith('https://') && new URL(opened.base).pathname.length > 1, true)
  check('its mode is one the runtime understands', opened !== null && ['direct', 'worker'].includes(opened?.mode ?? ''), true)
  check('its credential matches its mode shape', opened !== null
    && (opened.mode === 'direct' ? /^[\w-]{20,}$/.test(opened.apiKey)
      : opened.mode === 'worker' && opened.signingSecret.length >= 32), true)

  const plainWeb = detectSealedHost({ env: {}, execPath: '/usr/bin/node', argv: ['node', 'bin.js', 'web', '--port', '3099'] })
  check('the gate refuses a plain web host', plainWeb, null)
  const partialAio = detectSealedHost({
    env: { DSH_HOME: '/home/u/AppData/Roaming/com.deepseek.dsh.desktop.aio/releases/6.9.3/dsh-home' },
    execPath: '/usr/local/bin/node',
    argv: ['node', 'bin.js', 'web'],
  })
  check('the gate refuses one Tauri signal alone (home path only)', partialAio, null)
  const bareHarness = detectSealedHost({ env: {}, profileName: 'desktop' })
  check('the gate admits the desktop profile name alone (kernel-authoritative, Electron scrubs the env marker)', bareHarness, 'harness')
  const aio = detectSealedHost({
    env: { DSH_HOME: 'C:/Users/u/AppData/Roaming/com.deepseek.dsh.desktop.aio/releases/6.9.3/dsh-home' },
    execPath: 'D:/DSHEAC AIO/resources/node/node.exe',
    argv: ['node', 'bin.js', 'web', '--host', '127.0.0.1', '--port', '57543', '--profile', 'web-desktop'],
  })
  check('the gate admits the Tauri shell on the full signal trio', aio, 'aio')
  const unlockedHere = unlockSealedLane({ profileName: undefined })
  check('unlock returns nothing on this (unapproved) test host', unlockedHere, null)
}

{
  // A full mint → open round trip with throwaway shards, then every tamper the
  // suite can think of must land on null — including the two failure modes that
  // matter most in practice: a swapped shard file and a flipped payload byte.
  const shards = [crypto.randomBytes(24), crypto.randomBytes(24), crypto.randomBytes(24)]
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveSealKey(shards), iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(SEAL_AAD, 'utf8'))
  const plaintext = Buffer.from(JSON.stringify({ v: 1, m: 'eac', u: 'https://lane.example/v1', k: 'sk-roundtrip-credential-0001' }), 'utf8')
  const packed = Buffer.concat([iv, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()])

  const opened = openSealWith(shards, packed)
  check('a fresh mint opens with the exact credential', opened, { mode: 'direct', base: 'https://lane.example/v1', apiKey: 'sk-roundtrip-credential-0001' })

  const wrongShards = [...shards]
  wrongShards[2] = crypto.randomBytes(24)
  check('a foreign third shard fails closed', openSealWith(wrongShards, packed), null)

  const tampered = Buffer.from(packed)
  tampered[tampered.length - TAG_BYTES - 1] ^= 0x01
  check('a flipped ciphertext byte fails closed', openSealWith(shards, tampered), null)

  const tamperedTag = Buffer.from(packed)
  tamperedTag[tamperedTag.length - 1] ^= 0x01
  check('a flipped auth tag fails closed', openSealWith(shards, tamperedTag), null)

  const shortShard = [shards[0], Buffer.from('tiny'), shards[2]]
  check('an undersized shard fails closed', openSealWith(shortShard, packed), null)

  const truncated = packed.subarray(0, IV_BYTES + TAG_BYTES - 3)
  check('a truncated payload fails closed', openSealWith(shards, truncated), null)
}

// ── 2. nothing readable ships ────────────────────────────────────────────────
{
  const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const files = []
  const collect = relative => {
    const absolute = path.join(repo, relative)
    if (!fs.existsSync(absolute)) return
    if (fs.statSync(absolute).isDirectory()) {
      for (const name of fs.readdirSync(absolute)) collect(path.join(relative, name))
      return
    }
    files.push(relative)
  }
  for (const entry of pkg.files) collect(entry)
  // The gateway directory ships in the repository too (deployment config and
  // its guide), so it is held to the same no-readable-material rule.
  collect('worker')

  // Assembled at runtime so this source file never contains (and can never be
  // found by) the shapes it scans for.
  const needles = {
    'a key prefix with payload': 'sk-' + 'x'.repeat(4),
    'the lane host fragment': ['dtyg', '123'].join(''),
    'the lane host suffix': ['dpd', 'ns'].join(''),
    'a bearer prefix with payload': 'Bearer ' + 'sk',
  }
  for (const relative of files) {
    const text = fs.readFileSync(path.join(repo, relative), 'utf8')
    for (const [name, needle] of Object.entries(needles)) {
      check(`${relative} carries no ${name}`, text.includes(needle), false)
    }
  }

  const { execFileSync } = await import('node:child_process')
  let mintIgnored = false
  try {
    execFileSync('git', ['check-ignore', '--quiet', 'scripts/eac-vault-mint.mjs'], { cwd: repo })
    mintIgnored = true
  } catch { /* not ignored */ }
  check('the minting tool is git-ignored (plaintext stays out of the repo)', mintIgnored, true)
}

// ── 3. the adapter's sealed branch ───────────────────────────────────────────
{
  // A stand-in relay speaking exactly what the lane speaks: chat SSE with
  // DeepSeek-style `reasoning_content`, the finish token and the usage riding
  // the same final frame, `[DONE]` at the end.
  const seen = []
  const relay = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      seen.push({ path: req.url, authorization: req.headers.authorization, model: body.model, maxTokens: body.max_tokens, stream: body.stream, messages: body.messages })
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'think' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'ing' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ans' } }] })}\n\n`)
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'wer', reasoning_content: '.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 6, completion_tokens_details: { reasoning_tokens: 4 } } })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  relay.unref()
  const relayBase = `http://127.0.0.1:${relay.address().port}`

  const sealedEntry = {
    id: 'deepseek-ai/deepseek-v4.1-flash', name: 'EAC DeepSeek V4.1 Flash', channel: 'eac', wire: 'chat',
    vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000, canDisableThinking: false, regionSensitive: false,
  }
  const state = () => ({ catalog: [sealedEntry], membership: { 'our-free-model': [sealedEntry.id] }, settings: {}, attributionUserAgent: '' })

  const locked = new FreeModelAdapter({ state, sealedCredential: () => null, recordUsage: () => {}, recordTurn: () => {} })
  const lockedChunks = []
  for await (const chunk of locked.stream({ model: sealedEntry.id, messages: [{ role: 'user', content: 'hi' }] }, sealedEntry, state())) lockedChunks.push(chunk)
  const lockedFinish = lockedChunks.find(chunk => chunk.type === 'finish')
  check('a locked host fails its turn non-retryably', lockedFinish?.reason?.failure?.code, 'LANE_LOCKED')
  check('the locked failure names nothing about the lane', (lockedFinish?.reason?.failure?.message ?? '').includes('http'), false)

  const adapter = new FreeModelAdapter({ state, sealedCredential: () => ({ base: relayBase, apiKey: 'sk-relay-credential-0123456789' }), recordUsage: () => {}, recordTurn: () => {} })
  const chunks = []
  for await (const chunk of adapter.stream({ model: sealedEntry.id, messages: [{ role: 'user', content: 'hi' }] }, sealedEntry, state())) chunks.push(chunk)
  const kinds = chunks.map(chunk => chunk.type)
  check('the turn streams reasoning deltas from reasoning_content', kinds.includes('reasoning-delta'), true)
  check('and text deltas', kinds.includes('text-delta'), true)
  const reasoning = chunks.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
  check('the reasoning text arrives in order', reasoning, 'thinking.')
  const text = chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
  check('the answer text arrives whole', text, 'answer')
  const usage = chunks.find(chunk => chunk.type === 'usage')?.usage
  check('usage is accounted with the reasoning split', [usage?.inputTokens, usage?.outputTokens, usage?.reasoningTokens], [9, 6, 4])
  const finish = chunks.find(chunk => chunk.type === 'finish')
  check('the turn finishes clean', finish?.reason?.kind, 'stop')
  check('the relay saw the bearer credential', seen[0]?.authorization, 'Bearer sk-relay-credential-0123456789')
  check('and the raw namespaced model id', seen[0]?.model, 'deepseek-ai/deepseek-v4.1-flash')
  check('and a bounded streaming request', [seen[0]?.stream, typeof seen[0]?.maxTokens === 'number' && seen[0]?.maxTokens > 0], [true, true])
  check('the sealed turn asks for underrun-free reasoning in its system prompt',
    [seen[0]?.messages?.[0]?.role, seen[0]?.messages?.[0]?.content],
    ['system', 'Avoid overthinking: keep your reasoning brief and proportionate to the task.'])
  const withSystem = []
  for await (const chunk of adapter.stream({ model: sealedEntry.id, messages: [{ role: 'user', content: 'hi' }], system: 'Be helpful.' }, sealedEntry, state())) withSystem.push(chunk)
  check('a caller system prompt keeps its text and gains only the hint suffix',
    [seen[1]?.messages?.[0]?.role, String(seen[1]?.messages?.[0]?.content).startsWith('Be helpful.\n\nAvoid overthinking')],
    ['system', true])
  await new Promise(resolve => relay.close(resolve))
}

// ── 3b. the signing gateway (the real worker/worker.js, driven in-process) ───
{
  // The relay stand-in records what the gateway forwarded, so the suite can
  // assert the real credential rode the Worker→relay hop and never the client→
  // gateway one.
  const relaySeen = []
  const relay = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', () => {
      relaySeen.push({ path: req.url, authorization: req.headers.authorization })
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-ai/deepseek-v4.1-flash' }] }))
        return
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'via-gateway' } }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{"error":{"message":"unexpected relay route"}}')
    })
  })
  await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
  relay.unref()

  // A local HTTP shell around the REAL worker module: every request the suite
  // makes crosses the exact fetch() handler Cloudflare will run.
  const GATEWAY_SECRET = 'test-signing-secret-0123456789abcdef'
  const env = {
    UPSTREAM_URL: `http://127.0.0.1:${relay.address().port}/v1`,
    UPSTREAM_API_KEY: 'sk-relay-key-held-only-by-the-gateway',
    SIGNING_SECRETS: GATEWAY_SECRET,
    MODELS: 'deepseek-ai/deepseek-v4.1-flash',
  }
  const fakeCtx = { waitUntil() {}, passThroughOnException() {} }
  const shell = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', async () => {
      const request = new Request(`https://gateway.test${req.url}`, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? Buffer.concat(chunks).toString('utf8') : undefined,
      })
      const response = await gateway.default.fetch(request, env, fakeCtx)
      res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' })
      res.end(await response.text())
    })
  })
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve))
  shell.unref()
  const gatewayBase = `http://127.0.0.1:${shell.address().port}/v1`
  const workerCredential = { mode: 'worker', base: gatewayBase, signingSecret: GATEWAY_SECRET }

  // Seal round trip for the worker shape, and its failure paths. The seal
  // itself must name an https gateway (production shape); the live-through
  // credential below is built by hand so the loopback shell can be plain http.
  const workerShards = [crypto.randomBytes(24), crypto.randomBytes(24), crypto.randomBytes(24)]
  const sealBody = { v: 1, m: 'eac', t: 'worker', u: 'https://gateway.test/v1', s: GATEWAY_SECRET }
  const workerIv = crypto.randomBytes(IV_BYTES)
  const workerCipher = crypto.createCipheriv('aes-256-gcm', deriveSealKey(workerShards), workerIv, { authTagLength: TAG_BYTES })
  workerCipher.setAAD(Buffer.from(SEAL_AAD, 'utf8'))
  const workerPacked = Buffer.concat([workerIv, workerCipher.update(Buffer.from(JSON.stringify(sealBody))), workerCipher.final(), workerCipher.getAuthTag()])
  const workerOpened = openSealWith(workerShards, workerPacked)
  check('a worker-mode seal opens to gateway url + signing secret', workerOpened, { mode: 'worker', base: 'https://gateway.test/v1', signingSecret: GATEWAY_SECRET })
  const shortSecretShards = workerShards
  const shortIv = crypto.randomBytes(IV_BYTES)
  const shortCipher = crypto.createCipheriv('aes-256-gcm', deriveSealKey(shortSecretShards), shortIv, { authTagLength: TAG_BYTES })
  shortCipher.setAAD(Buffer.from(SEAL_AAD, 'utf8'))
  const shortPacked = Buffer.concat([shortIv, shortCipher.update(Buffer.from(JSON.stringify({ ...sealBody, s: 'too-short' }))), shortCipher.final(), shortCipher.getAuthTag()])
  check('a worker seal with an undersized signing secret fails closed', openSealWith(shortSecretShards, shortPacked), null)

  // The signature the client computes is the signature the gateway verifies:
  // re-derive it with an independent implementation of the documented contract.
  const signed = signSealedRequest(GATEWAY_SECRET, { method: 'POST', path: '/v1/chat/completions', body: '{"model":"x"}' }, 1_700_000_000_000)
  const independent = (() => {
    const bodyHash = crypto.createHash('sha256').update('{"model":"x"}', 'utf8').digest('hex')
    return crypto.createHmac('sha256', GATEWAY_SECRET).update(`1700000000000\nPOST\n/v1/chat/completions\n${bodyHash}`, 'utf8').digest('hex')
  })()
  check('signSealedRequest matches the documented wire contract', signed, {
    'x-ofm-timestamp': '1700000000000',
    'x-ofm-signature': independent,
  })

  // Listing + a streamed turn through gateway → relay, via the lane's own
  // outbound module, exactly as the adapter calls it in production.
  const listing = await fetchSealedListing(workerCredential)
  check('the gateway serves the signed listing round', listing?.data?.[0]?.id, 'deepseek-ai/deepseek-v4.1-flash')
  let streamedText = ''
  const turn = await postSealedStreamed({
    credential: workerCredential,
    body: { model: 'deepseek-ai/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
    onData: payload => {
      try { const frame = JSON.parse(payload); const delta = frame.choices?.[0]?.delta; if (typeof delta?.content === 'string') streamedText += delta.content } catch { /* scripted frames only */ }
    },
  })
  check('the gateway relays a signed streaming turn', streamedText, 'via-gateway')
  check('and it completed', turn?.status, 200)
  check('the relay saw only the gateway-held credential', relaySeen[1]?.authorization, 'Bearer sk-relay-key-held-only-by-the-gateway')

  // A proxy in front of the relay answers hard failures with a whole HTML page
  // (Cloudflare's 524 origin-timeout page being the common one). It must reach
  // the user as one readable line, not as pasted markup.
  const htmlProxy = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      res.writeHead(req.url.endsWith('/models') ? 524 : 502, { 'content-type': 'text/html; charset=UTF-8' })
      res.end('<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n<html><head><title>error</title></head><body>error code</body></html>')
    })
  })
  await new Promise(resolve => htmlProxy.listen(0, '127.0.0.1', resolve))
  htmlProxy.unref()
  const htmlCredential = { mode: 'worker', base: `http://127.0.0.1:${htmlProxy.address().port}/v1`, signingSecret: GATEWAY_SECRET }
  const listingFailure = await fetchSealedListing(htmlCredential).then(() => null, error => error)
  check('a proxy HTML error page surfaces as one readable line',
    [listingFailure?.code, listingFailure?.message],
    ['SERVER', "the gateway's front proxy answered HTTP 524 with an HTML error page"])
  const turnFailure = await postSealedStreamed({
    credential: htmlCredential,
    body: { model: 'deepseek-ai/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], stream: true },
    onData: () => {},
  }).then(() => null, error => error)
  check('the same reduction applies to a refused turn',
    [turnFailure?.code, turnFailure?.message],
    ['SERVER', "the gateway's front proxy answered HTTP 502 with an HTML error page"])
  await new Promise(resolve => htmlProxy.close(resolve))

  // Gateway refusals, each against the real handler.
  const callGateway = async (method, path, { secret = GATEWAY_SECRET, ts = Date.now(), body = '' } = {}, gatewayEnv = env) => {
    const headers = { 'x-ofm-timestamp': String(Math.trunc(ts)) }
    if (secret !== null) {
      const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
      headers['x-ofm-signature'] = crypto.createHmac('sha256', secret).update(`${headers['x-ofm-timestamp']}\n${method}\n${path}\n${bodyHash}`, 'utf8').digest('hex')
    }
    const response = await gateway.default.fetch(new Request(`https://gateway.test${path}`, { method, headers, body: method === 'POST' ? body : undefined }), gatewayEnv, fakeCtx)
    return response.status
  }
  const chatBody = JSON.stringify({ model: 'deepseek-ai/deepseek-v4.1-flash', messages: [] })
  check('a stale timestamp is refused', await callGateway('POST', '/v1/chat/completions', { body: chatBody, ts: Date.now() - 11 * 60_000 }), 401)
  check('a bad signature is refused', await callGateway('POST', '/v1/chat/completions', { secret: 'another-signing-secret-wrong-012345', body: chatBody }), 401)
  check('a missing signature is refused', await callGateway('POST', '/v1/chat/completions', { secret: null, body: chatBody }), 401)
  check('an unknown route is refused at the gateway, not relayed', await callGateway('GET', '/v1/embeddings'), 404)
  check('a model outside the allowlist is refused', await callGateway('POST', '/v1/chat/completions', { body: JSON.stringify({ model: 'other-org/other-model' }) }), 403)

  // The prelude hook: the self-hosted host flushes its SSE head through this
  // callback the moment a chat turn is admitted — never for the listing round,
  // never for a refused turn (those must keep their real status).
  let preludeCalls = 0
  const preludeCtx = { waitUntil() {}, passThroughOnException() {}, onUpstreamPending() { preludeCalls += 1 } }
  const post = (path, { ts = Date.now(), body = '' } = {}) => gateway.default.fetch(new Request(`https://gateway.test${path}`, {
    method: 'POST',
    headers: { 'x-ofm-timestamp': String(Math.trunc(ts)), ...signSealedRequest(GATEWAY_SECRET, { method: 'POST', path, body }, ts) },
    body,
  }), env, preludeCtx)
  await post('/v1/chat/completions', { body: chatBody })
  check('the prelude hook fires for an admitted chat turn', preludeCalls, 1)
  await gateway.default.fetch(new Request('https://gateway.test/v1/models', {
    headers: { ...signSealedRequest(GATEWAY_SECRET, { method: 'GET', path: '/v1/models', body: '' }) },
  }), env, preludeCtx)
  check('the prelude hook stays silent for the listing round', preludeCalls, 1)
  await post('/v1/chat/completions', { body: chatBody, ts: Date.now() - 11 * 60_000 })
  check('a refused turn never flushes early', preludeCalls, 1)

  // Sharing a domain the relay already uses: the lane mounts under a sub-path,
  // the signature covers the FULL pathname (prefix included — it is what the
  // client's new URL(base + '/models').pathname produced), and the prefix is
  // stripped only for routing.
  const mounted = { ...env, MOUNT_PREFIX: '/eac' }
  check('a mounted prefix serves the lane under an existing site', await callGateway('GET', '/eac/v1/models', {}, mounted), 200)
  check('the mount prefix is part of the signature (root path goes dark)', await callGateway('GET', '/v1/models', {}, mounted), 404)
  check('a foreign prefix is refused', await callGateway('GET', '/other/v1/models', {}, mounted), 404)

  const tinyEnv = { ...env, MAX_BODY_BYTES: '16' }
  const tinyResponse = await gateway.default.fetch(new Request('https://gateway.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'x-ofm-timestamp': String(Date.now()), 'x-ofm-signature': 'x'.repeat(64) },
    body: chatBody,
  }), tinyEnv, fakeCtx)
  check('an oversized body is refused before any relay work', tinyResponse.status, 413)

  // The drill's own lesson: a relay base without its /v1 would forward turns
  // into the relay's front page and answer HTML for the lane. Refuse it at
  // configure time, even on an otherwise valid signed request.
  const badBase = await gateway.default.fetch(new Request('https://gateway.test/v1/models', {
    headers: { ...signSealedRequest(GATEWAY_SECRET, { method: 'GET', path: '/v1/models', body: '' }), accept: 'application/json' },
  }), { ...env, UPSTREAM_URL: `http://127.0.0.1:${relay.address().port}` }, fakeCtx)
  check('a relay base without /v1 is refused at configure time', badBase.status, 500)

  await new Promise(resolve => shell.close(resolve))
  await new Promise(resolve => relay.close(resolve))

  // The self-hosted form: the same core behind the Node host shim, driven over
  // a real socket exactly like a 宝塔/PM2 deployment would serve it.
  const { createGatewayServer } = await import('../worker/gateway-node.mjs')
  const nodeRelay = http.createServer((req, res) => {
    req.on('data', () => {})
    req.on('end', () => {
      if (req.url !== '/v1/models') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":{"message":"unexpected relay route"}}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'deepseek-ai/deepseek-v4.1-flash' }] }))
    })
  })
  await new Promise(resolve => nodeRelay.listen(0, '127.0.0.1', resolve))
  nodeRelay.unref()
  const nodeEnv = {
    UPSTREAM_URL: `http://127.0.0.1:${nodeRelay.address().port}/v1`,
    UPSTREAM_API_KEY: 'sk-relay-key-held-only-by-the-gateway',
    SIGNING_SECRETS: GATEWAY_SECRET,
    RATE_LIMIT_PER_MINUTE: '2',
  }
  const nodeServer = createGatewayServer(nodeEnv)
  await new Promise(resolve => nodeServer.listen(0, '127.0.0.1', resolve))
  nodeServer.unref()
  const nodeBase = `http://127.0.0.1:${nodeServer.address().port}/v1`

  const nodeCall = async () => {
    const body = ''
    const headers = { ...signSealedRequest(GATEWAY_SECRET, { method: 'GET', path: '/v1/models', body }), accept: 'application/json' }
    return fetch(`${nodeBase}/models`, { headers })
  }
  const nodeOk = await nodeCall()
  check('the node host serves a signed listing', [nodeOk.status, (await nodeOk.json()).data?.[0]?.id], [200, 'deepseek-ai/deepseek-v4.1-flash'])
  const refusals = []
  for (let i = 0; i < 3; i += 1) refusals.push((await nodeCall()).status)
  check('the node host rate-limits per ip past its window', refusals, [200, 429, 429])
  const unsignedNode = await fetch(`${nodeBase}/models`)
  check('the node host refuses unsigned requests like the Worker', unsignedNode.status, 401)
  await new Promise(resolve => nodeServer.close(resolve))
  await new Promise(resolve => nodeRelay.close(resolve))

  // The prelude, end to end through the Node host: a relay that sits on its
  // first byte must not let a front proxy kill the lane (Cloudflare ~100s,
  // nginx 60s default), and a refusal arriving after the head is committed
  // reaches the client in-stream, where the lane's reader classifies it.
  const preludeRelay = http.createServer((req, res) => {
    const chunks = []
    req.on('data', row => chunks.push(row))
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'deepseek-ai/deepseek-v4.1-flash' }] }))
        return
      }
      const refusing = Buffer.concat(chunks).toString('utf8').includes('refusing-model')
      setTimeout(() => {
        if (refusing) {
          res.writeHead(503, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'relay is overloaded' } }))
          return
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'late' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }, refusing ? 300 : 2300)
    })
  })
  await new Promise(resolve => preludeRelay.listen(0, '127.0.0.1', resolve))
  preludeRelay.unref()
  const preludeServer = createGatewayServer({
    UPSTREAM_URL: `http://127.0.0.1:${preludeRelay.address().port}/v1`,
    UPSTREAM_API_KEY: 'sk-relay-key-held-only-by-the-gateway',
    SIGNING_SECRETS: GATEWAY_SECRET,
    RATE_LIMIT_PER_MINUTE: '9999',
    SSE_PRELUDE_SECONDS: '1',
  })
  await new Promise(resolve => preludeServer.listen(0, '127.0.0.1', resolve))
  preludeServer.unref()
  const preludeBase = `http://127.0.0.1:${preludeServer.address().port}/v1`
  const preludeCall = async model => {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: true })
    return fetch(`${preludeBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signSealedRequest(GATEWAY_SECRET, { method: 'POST', path: '/v1/chat/completions', body }) },
      body,
    })
  }
  const preludeStart = Date.now()
  const slowTurn = await preludeCall('deepseek-ai/deepseek-v4.1-flash')
  const headAt = Date.now() - preludeStart
  const slowBody = await slowTurn.text()
  check('the prelude commits the head while the relay still thinks', slowTurn.status, 200)
  check('the committed head arrives long before the slow relay', headAt < 2000, true)
  check('keepalive comments flow and the late frames still land in order',
    [slowBody.includes(': channel open'), slowBody.includes(': keepalive'), slowBody.includes('late'), slowBody.includes('[DONE]')],
    [true, true, true, true])
  const refusedTurn = await preludeCall('refusing-model')
  const refusedBody = await refusedTurn.text()
  check('a relay refusal after the head reaches the client in-stream',
    [refusedTurn.status, refusedBody.includes('"relay is overloaded"')], [200, true])
  await new Promise(resolve => preludeServer.close(resolve))
  await new Promise(resolve => preludeRelay.close(resolve))

  // ── 3c. concurrency gate, analytics, and the admin feed ────────────────────
  {
    const slowRelay = http.createServer((req, res) => {
      const chunks = []
      req.on('data', c => chunks.push(c))
      req.on('end', () => {
        if (req.url === '/v1/models') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ data: [{ id: 'deepseek-ai/deepseek-v4.1-flash' }] }))
          return
        }
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`)
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 9, completion_tokens: 4 } })}\n\n`)
          res.write('data: [DONE]\n\n')
          res.end()
        }, 350)
      })
    })
    await new Promise(resolve => slowRelay.listen(0, '127.0.0.1', resolve))
    slowRelay.unref()
    const statsFile = path.join(os.tmpdir(), 'ofm-vault-stats-' + Date.now() + '.json')
    const concEnv = {
      UPSTREAM_URL: `http://127.0.0.1:${slowRelay.address().port}/v1`,
      UPSTREAM_API_KEY: 'sk-relay-key-held-only-by-the-gateway',
      SIGNING_SECRETS: GATEWAY_SECRET,
      ADMIN_TOKEN: 'test-admin-token-0123456789',
      STATS_PATH: statsFile,
      RATE_LIMIT_PER_MINUTE: '9999',
      RATE_LIMIT_PER_DAY: '9999',
      CONCURRENCY_PER_IP: '2',
    }
    const concServer = createGatewayServer(concEnv)
    await new Promise(resolve => concServer.listen(0, '127.0.0.1', resolve))
    concServer.unref()
    const concBase = `http://127.0.0.1:${concServer.address().port}/v1`

    const badFeed = await fetch(`http://127.0.0.1:${concServer.address().port}/stats-data?t=wrong`)
    check('the stats feed refuses a bad admin token', badFeed.status, 401)
    const noTokenPage = await fetch(`http://127.0.0.1:${concServer.address().port}/stats`)
    check('the dashboard page serves its self-gate without a token', noTokenPage.status, 200)
    const entry = await fetch(`http://127.0.0.1:${concServer.address().port}/entry.js`)
    check('the sidebar entry script is served by the gateway', [entry.status, (await entry.text()).includes('EAC ' + '看板')], [200, true])

    const chatBodyText = JSON.stringify({ model: 'deepseek-ai/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] })
    const signedChat = () => new Request(`${concBase}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...signSealedRequest(GATEWAY_SECRET, { method: 'POST', path: '/v1/chat/completions', body: chatBodyText }) },
      body: chatBodyText,
    })
    resetAnalytics()
    const settled = await Promise.allSettled([
      fetch(signedChat()).then(r => r.status),
      fetch(signedChat()).then(r => r.status),
      fetch(signedChat()).then(r => r.status),
    ])
    const statuses = settled.map(r => r.value ?? String(r.reason)).sort()
    check('the concurrency gate passes two in-flight turns and refuses the third', statuses, [200, 200, 429])
    await new Promise(r => setTimeout(r, 600))

    const feed = await fetch(`http://127.0.0.1:${concServer.address().port}/stats-data?t=${encodeURIComponent('test-admin-token-0123456789')}`)
    const feedJson = await feed.json()
    check('the stats feed answers the right admin token with JSON', feed.status, 200)
    const feedRow = (feedJson.ips ?? [])[0]
    check('analytics counted every request including the refused one', [feedRow?.req, feedRow?.rej], [3, 1])
    check('usage parsed from relayed SSE frames feeds the token totals', [feedRow?.in, feedRow?.out], [18, 8])
    check('the concurrency peak stuck at the gate ceiling', feedRow?.concMax, 2)
    check('the hourly curve recorded the burst', ((feedJson.hourly ?? [])[0]?.[1] ?? 0) >= 3, true)

    const dashboardPage = await fetch(`http://127.0.0.1:${concServer.address().port}/stats?t=${encodeURIComponent('test-admin-token-0123456789')}`)
    const pageText = await dashboardPage.text()
    check('the dashboard page serves the chart container markup', [dashboardPage.status, pageText.includes('请求热力图'), pageText.includes('stats-data')], [200, true, true])

    concServer.close()
    slowRelay.close()
    try { fs.rmSync(statsFile, { force: true }) } catch { /* temp cleanup best effort */ }
  }
}

// ── roster shape ─────────────────────────────────────────────────────────────
{
  const roster = buildEacCatalog([
    'deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3-flash', 'unheard-org/some-model-9',
  ])
  check('every roster row carries the channel tag field', roster.every(entry => entry.channel === EAC_CHANNEL), true)
  check('and the chat wire', roster.every(entry => entry.wire === 'chat'), true)
  check('known ids display as the model name under the channel tag', roster.slice(0, 3).map(entry => entry.name), [
    'EAC DeepSeek V4.1 Flash', 'EAC Kimi K3', 'EAC GLM 5.3 Flash',
  ])
  check('an unknown id still shows its own name, tagged', roster[3].name, 'EAC Some Model 9')
  check('the ids stay the raw namespaced ids', roster[0].id, 'deepseek-ai/deepseek-v4.1-flash')
  check('isEacEntry answers the channel field', [isEacEntry(roster[0]), isEacEntry({ id: 'mimo-v2.6-flash-free' })], [true, false])
  check('display names never leak the org prefix', roster.every(entry => !entry.name.includes('deepseek-ai/') && !entry.name.includes('moonshotai/')), true)
}

// ── effort menus and their wire patches (ZCode declaration shape) ───────────
{
  const { effortsFor, effortPatchFor, budgetFor } = await import('../src/effort.js')
  const roster = buildEacCatalog([
    'deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'moonshotai/kimi-k2.6',
    'openai/gpt-oss-20b', 'z-ai/glm-5.3', 'z-ai/glm-5.3-flash',
  ])
  const byId = id => roster.find(entry => entry.id === id)
  check('the deepseek menu carries the off switch ZCode declares', effortsFor(byId('deepseek-ai/deepseek-v4.1-flash'))?.map(m => m.id), ['disabled', 'low', 'high', 'max'])
  check('the off level maps to reasoning.enabled=false', effortPatchFor('disabled', byId('deepseek-ai/deepseek-v4.1-flash')), { reasoning: { enabled: false } })
  check("a thinking level maps to the model own effort field", effortPatchFor('max', byId('deepseek-ai/deepseek-v4.1-flash')), { reasoning_effort: 'max' })
  check('glm maps to thinking+output_config like ZCode declares', effortPatchFor('low', byId('z-ai/glm-5.3-flash')), { thinking: { type: 'enabled' }, output_config: { effort: 'low' } })
  check('kimi-k3 has no off level, so the menu starts at low', effortsFor(byId('moonshotai/kimi-k3'))?.map(m => m.id), ['low', 'high', 'max'])
  check('a level the model does not declare falls back to its default', effortPatchFor('max', byId('openai/gpt-oss-20b')), { reasoning_effort: 'medium' })
  const { defaultEffortFor } = await import('../src/effort.js')
  check('every sealed model default sits inside its own menu', roster.map(entry => {
    const menu = (effortsFor(entry) ?? []).map(row => row.id)
    return menu.includes(defaultEffortFor(entry))
  }), roster.map(() => true))
  check('a sealed default is never the free lane balanced id', roster.filter(entry => (entry.efforts ?? []).includes('balanced')).length, 0)
  check('the sealed lane budget is not level-gated (capacity, not a ladder)', [
    budgetFor('low', byId('deepseek-ai/deepseek-v4.1-flash'), undefined, 32768),
    budgetFor('max', byId('deepseek-ai/deepseek-v4.1-flash'), undefined, 32768),
  ], [32768, 32768])
  check('a free-lane model still carries the token ladder', effortsFor({ id: 'mimo-v2.6-flash-free', reasoning: true, canDisableThinking: false, maxOutput: 131072 }, undefined, 32768)?.map(m => m.id), ['light', 'balanced', 'deep'])
}

// ── 4. the Host half boots the lane only where the gate opens ────────────────
{
  const { apply, inject } = await import('../index.js')
  const { ROUTE_MAIN } = await import('../src/adapter.js')

  // The listing the seal decrypts to, served by a fetch stand-in so the suite
  // never contacts the real lane. Every other URL refuses, like an offline host.
  const credential = openSeal()
  const rosterIds = ['deepseek-ai/deepseek-v4.1-flash', 'moonshotai/kimi-k3', 'z-ai/glm-5.3']
  const realFetch = globalThis.fetch
  const stubbedFetch = async (url, options) => {
    const text = String(url)
    if (credential !== null && text.startsWith(credential.base)) {
      if (text.endsWith('/models')) {
        return new Response(JSON.stringify({ data: rosterIds.map(id => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response('{"error":{"message":"relay stood down for the suite"}}', { status: 503 })
    }
    void options
    throw new TypeError('fetch failed (offline suite)')
  }

  /** Simulate the Tauri shell's signals around one boot. */
  async function bootWith({ simulateAio }) {
    const previousArgv = [...process.argv]
    const previousExecPath = process.execPath
    const previousHome = process.env.DSH_HOME
    const home = fs.mkdtempSync(path.join(os.tmpdir(), simulateAio ? 'ofm-aio-com.deepseek.dsh.desktop.aio-' : 'ofm-vault-'))
    process.env.DSH_HOME = home
    let aioExecPath = ''
    if (simulateAio) {
      aioExecPath = path.join(home, 'resources', 'node', 'node.exe')
      process.execPath = aioExecPath
      process.argv.push('web-desktop')
    }
    globalThis.fetch = stubbedFetch
    const routes = []
    const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
    apply(ctx, configOf())
    const api = () => routes.find(route => route.kind === 'prefix')?.handler
    try {
      await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 8000 })
      await until(() => {
        const adapter = ctx.__captured.adapters[0]?.adapter
        return adapter !== undefined && adapter.listModels !== undefined
      }, { what: 'the adapter', timeoutMs: 8000 })
      return { ctx, api, home, restore: () => {
        process.argv = previousArgv
        process.execPath = previousExecPath
        process.env.DSH_HOME = previousHome
        globalThis.fetch = realFetch
        for (const disposer of ctx.__disposers.reverse()) {
          try { disposer() } catch { /* teardown best effort */ }
        }
        fs.rmSync(home, { recursive: true, force: true })
      } }
    } catch (error) {
      process.argv = previousArgv
      process.execPath = previousExecPath
      process.env.DSH_HOME = previousHome
      globalThis.fetch = realFetch
      for (const disposer of ctx.__disposers.reverse()) {
        try { disposer() } catch { /* teardown best effort */ }
      }
      fs.rmSync(home, { recursive: true, force: true })
      throw error
    }
  }

  // The boot effect needs a config-free apply; keep the shape offline-test uses.
  const configOf = () => ({})

  {
    const { ctx, api, restore } = await bootWith({ simulateAio: true })
    try {
      const adapter = ctx.__captured.adapters[0]?.adapter
      await until(async () => (await adapter.listModels(ROUTE_MAIN)).some(model => model.id === 'deepseek-ai/deepseek-v4.1-flash'), {
        what: 'the sealed roster arriving', timeoutMs: 10000,
      })
      const models = await adapter.listModels(ROUTE_MAIN)
      const sealed = models.find(model => model.id === 'deepseek-ai/deepseek-v4.1-flash')
      check('the Tauri boot lists the sealed model under the main route', sealed !== undefined, true)
      check('with the model name under the channel tag', sealed?.name, 'EAC DeepSeek V4.1 Flash')
      const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
      const summaryRow = (summary.json.catalog ?? []).find(entry => entry.id === 'moonshotai/kimi-k3')
      check('the settings page row is marked available with the channel field', [summaryRow?.availability, summaryRow?.channel], ['available', 'eac'])
      check('the settings page row carries the tag prefix in its name', summaryRow?.name, 'EAC Kimi K3')
      check('the settings API exposes no credential material anywhere', JSON.stringify(summary.json).includes('sk-'), false)
      const rosterIdsShown = (summary.json.catalog ?? []).filter(entry => entry.channel === 'eac').map(entry => entry.id)
      check('all listed sealed models made the roster', rosterIdsShown.slice().sort(), rosterIds.slice().sort())
    } finally {
      restore()
    }
  }

  {
    const { ctx, api, restore } = await bootWith({ simulateAio: false })
    try {
      const adapter = ctx.__captured.adapters[0]?.adapter
      await until(async () => (await adapter.listModels(ROUTE_MAIN)).length > 0, { what: 'the free roster', timeoutMs: 10000 })
      const models = await adapter.listModels(ROUTE_MAIN)
      check('an unapproved host lists no sealed models', models.some(model => model.id.includes('/') || model.name.startsWith('EAC ')), false)
      const summary = await callRoute(api(), 'GET', '/api/our-free-model/summary')
      check('and its settings page has no sealed rows at all', (summary.json.catalog ?? []).some(entry => entry.channel === 'eac'), false)
    } finally {
      restore()
    }
  }
}

console.log(failures === 0 ? '\nvault-test: all checks passed' : `\nvault-test: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
