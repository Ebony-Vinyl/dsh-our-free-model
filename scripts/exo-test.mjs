/**
 * EAC's locally dispatched exo route, with no real account or upstream traffic.
 *
 * Authorization uses the existing sealed-lane fetch seam. Generation uses a
 * loopback HTTP server so cancellation, fragmented UTF-8 and request identity
 * are tested on the actual transport. DSH_HOME is an isolated scratch home.
 *
 * Run: node scripts/exo-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

let failures = 0
let checks = 0
async function test(name, run) {
  checks += 1
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}: ${error?.stack ?? error}`)
  }
}

const previousHome = process.env.DSH_HOME
const previousBase = process.env.OUR_FREE_MODEL_BASE
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-exo-'))
process.env.DSH_HOME = home

const sse = payload => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`
const content = (id, text) => ({ id, choices: [{ index: 0, delta: { content: text } }] })
const finish = id => ({ id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
let scene
const sockets = new Set()
const server = http.createServer((req, res) => {
  const current = scene
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const row = { path: req.url, headers: req.headers, body: JSON.parse(bodyText), bodyText, closed: false }
    current.seen.push(row)
    res.on('close', () => { row.closed = true })
    current.answer(req, res, current.seen.length, row)
  })
})
server.on('connection', socket => {
  sockets.add(socket)
  socket.on('close', () => sockets.delete(socket))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`

const { postExoStreamed } = await import('../src/exo.js')
const { authorizeSealedUser, lane, laneUser } = await import('../src/eac.js')
const { CODE } = await import('../src/http.js')
const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')
const { EAC_EXO_MODEL_ID, buildEacExoCatalog, buildEacCatalog, isExoEntry, isEacEntry } = await import('../src/catalog.js')
const { mintRequestId, sessionForConversation, REQUEST_RE } = await import('../src/upstream.js')

function setScene(answer) {
  scene = { seen: [], answer }
  return scene
}
function answerSse(res, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.end(text)
}
function validAnswer(req, res) {
  answerSse(res, sse(content('msg_allowed', '本机回答')) + sse(finish('msg_allowed')) + sse('[DONE]'))
}
async function until(predicate, what, timeoutMs = 1000) {
  const end = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}
async function post(options = {}) {
  const data = []
  let error
  const previousFetch = lane.fetch
  lane.fetch = null
  try {
    await postExoStreamed({
      body: { model: 'exo-free', messages: [{ role: 'user', content: 'hi' }], stream: true },
      session: sessionForConversation('exo-transport-test'),
      requestId: mintRequestId(),
      headerMs: 500,
      sniffMs: 500,
      idleMs: 500,
      onData: value => data.push(value),
      ...options,
    })
  } catch (caught) {
    error = caught
  } finally {
    lane.fetch = previousFetch
  }
  return { data, error }
}

const credential = {
  mode: 'worker',
  base: 'https://sealed.invalid/eac/v1',
  signingSecret: 'exo-test-sealed-signing-secret',
}
const userToken = 'exo-test-private-user-token'
let authPayload = { configured: true, authorized: true, starred: true }
let authFailure
let authStatus = 200
let authCalls = []
function resetAuth() {
  authPayload = { configured: true, authorized: true, starred: true }
  authFailure = undefined
  authStatus = 200
  authCalls = []
  laneUser.token = userToken
  lane.fetch = async (url, init) => {
    if (String(url).startsWith(process.env.OUR_FREE_MODEL_BASE + '/')) return fetch(url, init)
    authCalls.push({ url, init })
    assert.equal(String(url), 'https://sealed.invalid/eac/auth/status', 'exo must never use sealed generation')
    if (authFailure) throw authFailure
    return new Response(JSON.stringify(authPayload), { status: authStatus, headers: { 'content-type': 'application/json' } })
  }
}

function makeAdapter(settings = {}) {
  const usage = []
  const turns = []
  const rows = buildEacExoCatalog(['exo-free'])
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: rows,
      membership: { [ROUTE_MAIN]: rows.map(row => row.id) },
      settings: { enabled: true, defaultMaxTokens: 4096, ...settings },
      attributionUserAgent: 'exo-offline-test/1.0',
    }),
    sealedCredential: () => credential,
    recordUsage: row => usage.push(row),
    recordTurn: row => turns.push(row),
    warn() {},
  })
  return { adapter, usage, turns }
}
async function runAdapter(adapter, options = {}) {
  const chunks = []
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN,
    model: EAC_EXO_MODEL_ID,
    sessionId: 'exo-adapter-conversation',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...options,
  })) chunks.push(chunk)
  return { chunks, reason: chunks.find(chunk => chunk.type === 'finish')?.reason }
}

try {
  await test('catalog exposes the exact EAC ID and local transport', async () => {
    assert.equal(EAC_EXO_MODEL_ID, 'EAC-claude opus 5.5')
    const rows = buildEacExoCatalog(['exo-free', 'exo-free'])
    assert.equal(rows.length, 1)
    assert.deepEqual(buildEacExoCatalog([]), [])
    assert.equal(rows[0].id, EAC_EXO_MODEL_ID)
    assert.equal(rows[0].channel, 'eac')
    assert.equal(rows[0].transport, 'exo-local')
    assert.equal(isEacEntry(rows[0]), true)
    assert.equal(isExoEntry(rows[0]), true)
    assert.equal(isExoEntry(buildEacCatalog(['deepseek-ai/deepseek-v4.1-flash'])[0]), false)
    const { adapter } = makeAdapter()
    const listed = await adapter.listModels(ROUTE_MAIN)
    assert.equal(listed[0].id, EAC_EXO_MODEL_ID)
    assert.equal((await adapter.resolveModel(ROUTE_MAIN, EAC_EXO_MODEL_ID)).id, EAC_EXO_MODEL_ID)
  })

  for (const [name, payload, token, failure, expected] of [
    ['not logged in', undefined, null, undefined, CODE.authorization],
    ['not starred', { configured: true, authorized: false, starred: false }, userToken, undefined, CODE.authorization],
    ['authorization network failure', undefined, userToken, new Error('stub authorization offline'), 'EAC_AUTH_UNAVAILABLE'],
    ['forged status without authorized', { configured: true, starred: true }, userToken, undefined, 'EAC_AUTH_UNAVAILABLE'],
    ['forged status without starred', { configured: true, authorized: true }, userToken, undefined, 'EAC_AUTH_UNAVAILABLE'],
    ['unconfigured status', { configured: false, authorized: true, starred: true }, userToken, undefined, 'EAC_AUTH_UNAVAILABLE'],
  ]) {
    await test(`${name} refuses before any generation request`, async () => {
      resetAuth()
      laneUser.token = token
      if (payload !== undefined) authPayload = payload
      authFailure = failure
      const current = setScene(validAnswer)
      const { adapter, usage, turns } = makeAdapter()
      const { reason } = await runAdapter(adapter)
      assert.equal(reason?.kind, 'error')
      assert.equal(reason?.failure?.code, expected)
      assert.equal(current.seen.length, 0)
      assert.equal(turns.length, 1)
      assert.equal(turns[0].ok, false)
      assert.equal(usage.length, 1)
      assert.equal(usage[0].ok, false)
      assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(reason.failure.code), false)
      if (token === null) assert.equal(authCalls.length, 0)
    })
  }

  await test('authorization checks the worker gate and rejects non-2xx status', async () => {
    resetAuth()
    await assert.rejects(() => authorizeSealedUser({ mode: 'direct', base: credential.base, apiKey: 'never-sent' }),
      error => !['TRANSPORT', 'SERVER'].includes(error.code))
    authStatus = 500
    await assert.rejects(() => authorizeSealedUser(credential), error => error.code === 'EAC_AUTH_UNAVAILABLE')
  })

  await test('authorization refuses a malformed JSON answer without echoing secrets', async () => {
    resetAuth()
    lane.fetch = async () => new Response(`not json ${userToken} ${credential.base}`)
    await assert.rejects(() => authorizeSealedUser(credential), error => {
      assert.equal(error.code, 'EAC_AUTH_UNAVAILABLE')
      assert.equal(error.message.includes(userToken), false)
      assert.equal(error.message.includes(credential.base), false)
      return true
    })
  })

  await test('authorization body deadline cancels a response that never finishes', async () => {
    resetAuth()
    let cancelled = false
    lane.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from('{"configured":true,')) },
      cancel() { cancelled = true },
    }))
    await assert.rejects(() => authorizeSealedUser(credential, { timeoutMs: 30 }),
      error => error.code === 'EAC_AUTH_UNAVAILABLE')
    await until(() => cancelled, 'authorization body cancellation')
  })

  await test('authorization bounds a response that exceeds its 16 KiB limit', async () => {
    resetAuth()
    let cancelled = false
    lane.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(17 * 1024, 32)) },
      cancel() { cancelled = true },
    }))
    await assert.rejects(() => authorizeSealedUser(credential),
      error => error.code === 'EAC_AUTH_UNAVAILABLE')
    await until(() => cancelled, 'oversized authorization cancellation')
  })

  await test('authorization cancellation is ABORTED even when its body ignores the signal', async () => {
    resetAuth()
    const controller = new AbortController()
    let reading = false
    let cancelled = false
    lane.fetch = async () => new Response(new ReadableStream({
      pull() { reading = true },
      cancel() { cancelled = true },
    }))
    const pending = authorizeSealedUser(credential, { signal: controller.signal })
    await until(() => reading, 'authorization read')
    controller.abort(new Error('user cancelled authorization'))
    await assert.rejects(() => pending, error => error.code === CODE.aborted)
    await until(() => cancelled, 'cancelled authorization body')
  })

  await test('authorization headers time out even when the fetch seam ignores abort', async () => {
    resetAuth()
    lane.fetch = async () => new Promise(() => {})
    await assert.rejects(() => authorizeSealedUser(credential, { timeoutMs: 30 }),
      error => error.code === 'EAC_AUTH_UNAVAILABLE')
  })

  await test('msg_ head buffers incomplete payload and replays every original frame', async () => {
    const raw = '{ "id": "msg_buffered", "choices": [{"index":0,"delta":{"content":"首字"}}] }'
    let release
    const held = new Promise(resolve => { release = resolve })
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const prefix = ': heartbeat\n\nevent: chunk\n'
      const split = raw.indexOf('buffered')
      res.write(prefix + `data: ${raw.slice(0, split)}`)
      void held.then(() => res.end(raw.slice(split) + '\n\n' + sse(finish('msg_buffered')) + sse('[DONE]')))
    })
    const got = []
    const pending = post({ onData: value => got.push(value) })
    await until(() => current.seen.length === 1, 'the buffered request')
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.deepEqual(got, [])
    release()
    const outcome = await pending
    assert.equal(outcome.error, undefined)
    assert.deepEqual(got, [raw, JSON.stringify(finish('msg_buffered'))])
    assert.equal(current.seen.length, 1)
  })

  await test('resp_ attempts cancel rejected connections, rotate request IDs and preserve session', async () => {
    const current = setScene((req, res, attempt) => {
      if (attempt === 3) return validAnswer(req, res)
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(content(`resp_rejected_${attempt}`, 'MUST_NOT_LEAK')))
    })
    const outcome = await post()
    assert.equal(outcome.error, undefined)
    assert.equal(current.seen.length, 3)
    assert.equal(outcome.data.some(value => value.includes('MUST_NOT_LEAK')), false)
    const ids = current.seen.map(row => row.headers['x-opencode-request'])
    assert.equal(new Set(ids).size, 3)
    assert.equal(ids.every(id => REQUEST_RE.test(id)), true)
    assert.equal(new Set(current.seen.map(row => row.headers['x-opencode-session'])).size, 1)
    await until(() => current.seen.slice(0, 2).every(row => row.closed), 'rejected connection cancellation')
  })

  await test('four resp_ attempts exhaust without handing off rejected data', async () => {
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(content('resp_rejected', 'never accepted')))
    })
    const outcome = await post()
    assert.ok(outcome.error)
    assert.deepEqual(outcome.data, [])
    assert.equal(current.seen.length, 4)
    assert.equal(new Set(current.seen.map(row => row.headers['x-opencode-request'])).size, 4)
    await until(() => current.seen.every(row => row.closed), 'all exhausted connections to cancel')
  })

  await test('attempt count cannot raise the four-request ceiling', async () => {
    const current = setScene(validAnswer)
    const outcome = await post({ attempts: 5 })
    assert.equal(outcome.error?.code, 'EXO_INVALID_OPTIONS')
    assert.equal(current.seen.length, 0)
  })

  await test('already-aborted generation makes no upstream request', async () => {
    const current = setScene(validAnswer)
    const outcome = await post({ signal: AbortSignal.abort() })
    assert.equal(outcome.error?.code, CODE.aborted)
    assert.equal(current.seen.length, 0)
  })

  await test('id-less prelude payloads stay buffered and replay in order only after msg_', async () => {
    const prelude = JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' } }] })
    const accepted = JSON.stringify(content('msg_late', 'accepted'))
    setScene((req, res) => answerSse(res, sse(prelude) + sse(accepted) + sse('[DONE]')))
    const outcome = await post()
    assert.equal(outcome.error, undefined)
    assert.deepEqual(outcome.data, [prelude, accepted])
  })

  await test('resp_ rejection also discards every earlier id-less payload', async () => {
    const current = setScene((req, res, attempt) => {
      if (attempt === 2) return validAnswer(req, res)
      answerSse(res, sse({ choices: [{ delta: { content: 'BUFFERED_MUST_NOT_LEAK' } }] })
        + sse(content('resp_late', 'REJECTED_MUST_NOT_LEAK')))
    })
    const outcome = await post()
    assert.equal(outcome.error, undefined)
    assert.equal(current.seen.length, 2)
    assert.equal(outcome.data.some(value => value.includes('MUST_NOT_LEAK')), false)
  })

  for (const [name, text] of [
    ['unknown id prefix', sse(content('chatcmpl_unknown', 'refused'))],
    ['missing first id', sse({ choices: [{ delta: { content: 'refused' } }] })],
    ['non-SSE JSON', JSON.stringify(content('msg_json', 'refused'))],
    ['non-SSE HTML', '<html>refused</html>'],
    ['empty body', ''],
    ['stream error before first id', sse({ error: { message: 'upstream failed' } })],
  ]) {
    await test(`${name} fails once without emitting any payload`, async () => {
      const current = setScene((req, res) => answerSse(res, text))
      const outcome = await post()
      assert.ok(outcome.error)
      assert.deepEqual(outcome.data, [])
      assert.equal(current.seen.length, 1)
    })
  }

  for (const status of [403, 426, 429, 500]) {
    await test(`HTTP ${status} is surfaced without selection retries`, async () => {
      const current = setScene((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '3' })
        res.end(JSON.stringify({ error: { message: `stub ${status}` } }))
      })
      const outcome = await post()
      assert.equal(outcome.error?.status, status)
      assert.deepEqual(outcome.data, [])
      assert.equal(current.seen.length, 1)
      if (status === 429) {
        assert.equal(outcome.error.code, CODE.quota)
        assert.equal(outcome.error.providerRetryAfterMs, 3000)
      }
    })
  }

  for (const status of [402, 503]) {
    await test(`Console endpoint refusal at HTTP ${status} is distinct and never rerouted`, async () => {
      const message = 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.'
      const current = setScene((req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'server_error', message } }))
      })
      const outcome = await post()
      assert.equal(outcome.error?.code, 'EXO_UPSTREAM_UNAVAILABLE')
      assert.equal(outcome.error?.status, status)
      assert.equal(outcome.error?.type, 'server_error')
      assert.ok(outcome.error.message.includes(`HTTP ${status}`))
      assert.ok(outcome.error.message.includes('尚未收到后端响应 ID'))
      assert.ok(outcome.error.message.includes(message), 'preserve the original diagnostic')
      assert.deepEqual(outcome.data, [])
      assert.equal(current.seen.length, 1)
    })
  }

  await test('similar error text on 403 remains a credential refusal', async () => {
    const current = setScene((req, res) => {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'FreeTierError',
        message: 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.' } }))
    })
    const outcome = await post()
    assert.equal(outcome.error?.code, CODE.credential)
    assert.equal(outcome.error?.status, 403)
    assert.equal(current.seen.length, 1)
    assert.deepEqual(outcome.data, [])
  })

  await test('other 503 errors retain normal classification', async () => {
    const current = setScene((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'stub temporarily busy' } }))
    })
    const outcome = await post()
    assert.equal(outcome.error?.code, CODE.server)
    assert.equal(outcome.error?.message, 'stub temporarily busy')
    assert.equal(current.seen.length, 1)
    assert.deepEqual(outcome.data, [])
  })

  await test('UTF-8 split inside the first id-bearing frame preserves Chinese text', async () => {
    const frame = Buffer.from(sse(content('msg_utf8', '中文不能丢')) + sse(finish('msg_utf8')))
    const split = frame.indexOf(Buffer.from('中')) + 1
    setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(frame.subarray(0, split))
      setTimeout(() => res.end(frame.subarray(split)), 5)
    })
    const outcome = await post()
    assert.equal(outcome.error, undefined)
    assert.equal(JSON.parse(outcome.data[0]).choices[0].delta.content, '中文不能丢')
    assert.equal(outcome.data.some(value => value.includes('\uFFFD')), false)
  })

  await test('multiline SSE data and split CRLF preserve one original JSON payload', async () => {
    const raw = '{\n"id":"msg_multiline",\n"choices":[{"delta":{"content":"joined"}}]\n}'
    const frame = raw.split('\n').map(line => `data: ${line}\r\n`).join('') + '\r\n'
    const split = frame.indexOf('\r') + 1
    setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(frame.slice(0, split))
      setTimeout(() => res.end(frame.slice(split)), 5)
    })
    const outcome = await post()
    assert.equal(outcome.error, undefined)
    assert.deepEqual(outcome.data, [raw])
  })

  await test('caller cancellation before the first payload closes the request without retry', async () => {
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': still waiting\n\n')
    })
    const controller = new AbortController()
    const pending = post({ signal: controller.signal })
    await until(() => current.seen.length === 1, 'the cancellable request')
    controller.abort(new Error('user stopped'))
    const outcome = await pending
    assert.equal(outcome.error?.code, CODE.aborted)
    assert.deepEqual(outcome.data, [])
    assert.equal(current.seen.length, 1)
    await until(() => current.seen[0].closed, 'aborted connection closure')
  })

  await test('initial head timeout cancels a held stream without selection retry', async () => {
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': no id yet\n\n')
    })
    const outcome = await post({ sniffMs: 30 })
    assert.equal(outcome.error?.code, 'EXO_SNIFF_TIMEOUT')
    assert.deepEqual(outcome.data, [])
    assert.equal(current.seen.length, 1)
    await until(() => current.seen[0].closed, 'timed out connection closure')
  })

  await test('response header timeout closes a request without selection retry', async () => {
    const current = setScene(() => {})
    const outcome = await post({ headerMs: 30 })
    assert.equal(outcome.error?.code, 'EXO_HEADER_TIMEOUT')
    assert.equal(current.seen.length, 1)
    assert.deepEqual(outcome.data, [])
    await until(() => current.seen[0].closed, 'header timeout connection closure')
  })

  await test('first-ID byte limit stops an unbounded prefix without selection retry', async () => {
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': ' + 'waiting'.repeat(100) + '\n\n')
    })
    const outcome = await post({ maxSniffBytes: 64 })
    assert.equal(outcome.error?.code, 'EXO_SNIFF_TOO_LARGE')
    assert.equal(current.seen.length, 1)
    assert.deepEqual(outcome.data, [])
    await until(() => current.seen[0].closed, 'oversized first-ID connection closure')
  })

  await test('accepted stream idle timeout keeps delivered output and never retries', async () => {
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(content('msg_idle', 'already delivered')))
    })
    const outcome = await post({ idleMs: 30 })
    assert.equal(outcome.error?.code, 'EXO_STREAM_IDLE_TIMEOUT')
    assert.equal(outcome.data.length, 1)
    assert.equal(JSON.parse(outcome.data[0]).choices[0].delta.content, 'already delivered')
    assert.equal(current.seen.length, 1)
    await until(() => current.seen[0].closed, 'accepted idle connection closure')
  })

  await test('accepted stream cancellation keeps first payload and never retries', async () => {
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse(content('msg_cancel', 'already delivered')))
    })
    const controller = new AbortController()
    const data = []
    const outcome = await post({
      signal: controller.signal,
      onData(value) { data.push(value); controller.abort() },
    })
    assert.equal(outcome.error?.code, CODE.aborted)
    assert.equal(data.length, 1)
    assert.equal(current.seen.length, 1)
    await until(() => current.seen[0].closed, 'accepted aborted connection closure')
  })

  await test('real adapter maps alias, checks auth each turn and keeps credentials off upstream', async () => {
    resetAuth()
    const current = setScene(validAnswer)
    const { adapter, usage, turns } = makeAdapter()
    const outcome = await runAdapter(adapter)
    assert.equal(outcome.reason?.kind, 'stop')
    assert.equal(outcome.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), '本机回答')
    assert.equal(current.seen.length, 1)
    const wire = current.seen[0]
    assert.equal(wire.path, '/zen/v1/chat/completions')
    assert.equal(wire.body.model, 'exo-free')
    assert.equal(wire.headers.authorization, 'Bearer public')
    for (const key of ['x-ofm-user', 'x-ofm-signature', 'x-ofm-timestamp']) assert.equal(wire.headers[key], undefined)
    const raw = JSON.stringify(wire)
    assert.equal(raw.includes(userToken), false)
    assert.equal(raw.includes(credential.signingSecret), false)
    assert.equal(raw.includes(credential.base), false)
    assert.equal(authCalls.length, 1)
    assert.equal(authCalls[0].init.headers['x-ofm-user'], userToken)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].model, EAC_EXO_MODEL_ID)
    assert.equal(usage[0].ok, true)
    assert.equal(turns[0].ok, true)
    authPayload = { configured: true, authorized: false, starred: false }
    const revoked = await runAdapter(adapter)
    assert.equal(revoked.reason?.failure?.code, CODE.authorization)
    assert.equal(current.seen.length, 1)
    assert.equal(authCalls.length, 2)
    assert.equal(usage.at(-1).ok, false)
    assert.equal(turns.at(-1).ok, false)
  })

  await test('real adapter fingerprints tools and translates names back to caller spelling', async () => {
    resetAuth()
    const current = setScene((req, res) => {
      const frame = {
        id: 'msg_tool',
        choices: [{ index: 0, delta: { tool_calls: [{
          index: 0, id: 'call_exo', type: 'function',
          function: { name: 'bash', arguments: '{"command":"pwd"}' },
        }] } }],
      }
      const ended = { id: 'msg_tool', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      answerSse(res, sse(frame) + sse(ended))
    })
    const { adapter } = makeAdapter()
    const outcome = await runAdapter(adapter, {
      tools: [{ type: 'function', function: {
        name: 'pwsh', description: 'run a shell command',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
      } }],
    })
    assert.equal(outcome.reason?.kind, 'tool-calls')
    assert.deepEqual(outcome.chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call')
      .map(chunk => chunk.block.name), ['pwsh'])
    const names = current.seen[0].body.tools.map(tool => tool.function.name)
    for (const name of ['bash', 'glob', 'grep', 'read']) assert.ok(names.includes(name))
    assert.equal(names.includes('pwsh'), false)
  })

  await test('adapter HTTP error is counted once and cannot trigger harness retries', async () => {
    resetAuth()
    const current = setScene((req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'stub upstream failed' } }))
    })
    const { adapter, usage, turns } = makeAdapter()
    const outcome = await runAdapter(adapter)
    assert.equal(outcome.reason?.kind, 'error')
    assert.equal(outcome.reason?.failure?.code, 'EXO_REQUEST_FAILED')
    assert.equal(outcome.reason?.failure?.status, 500)
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(outcome.reason.failure.code), false)
    assert.equal(current.seen.length, 1)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].ok, false)
    assert.equal(usage[0].model, EAC_EXO_MODEL_ID)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].ok, false)
  })

  await test('adapter preserves the upstream-unavailable diagnosis after authorization', async () => {
    resetAuth()
    const message = 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.'
    const current = setScene((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'server_error', message } }))
    })
    const { adapter, usage, turns } = makeAdapter()
    const outcome = await runAdapter(adapter)
    assert.equal(outcome.reason?.kind, 'error')
    assert.equal(outcome.reason?.failure?.code, 'EXO_UPSTREAM_UNAVAILABLE')
    assert.equal(outcome.reason?.failure?.status, 503)
    assert.ok(outcome.reason.failure.message.includes(message))
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(outcome.reason.failure.code), false)
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.reason)), outcome.reason)
    assert.equal(authCalls.length, 1)
    assert.equal(current.seen.length, 1)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].ok, false)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].ok, false)
  })

  await test('accepted ID and stop without content is a non-retryable empty response', async () => {
    resetAuth()
    const current = setScene((req, res) => answerSse(res, sse(finish('msg_empty')) + sse('[DONE]')))
    const { adapter, usage, turns } = makeAdapter()
    const outcome = await runAdapter(adapter)
    assert.equal(outcome.reason?.kind, 'error')
    assert.equal(outcome.reason?.failure?.code, 'EXO_EMPTY_RESPONSE')
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(outcome.reason.failure.code), false)
    assert.equal(current.seen.length, 1)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].ok, false)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].ok, false)
  })

  await test('accepted stream failure is recorded once and never enters adapter recovery', async () => {
    resetAuth()
    const current = setScene((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(sse({ id: 'msg_cut', choices: [{ index: 0, delta: { reasoning_content: 'partial reasoning' } }] }))
      setTimeout(() => res.destroy(), 10)
    })
    const { adapter, usage, turns } = makeAdapter({ streamRecovery: { enabled: true } })
    const outcome = await runAdapter(adapter)
    assert.equal(outcome.reason?.kind, 'error')
    assert.equal(current.seen.length, 1)
    assert.equal(authCalls.length, 1)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].ok, false)
    assert.equal(turns.length, 1)
    assert.equal(turns[0].ok, false)
    assert.equal(turns[0].recovered, false)
  })

  await test('accepted reasoning followed by graceful EOF never triggers continuation', async () => {
    resetAuth()
    const current = setScene((req, res) => answerSse(res,
      sse({ id: 'msg_eof', choices: [{ index: 0, delta: { reasoning_content: 'unfinished reasoning' } }] })))
    const { adapter, usage, turns } = makeAdapter({ streamRecovery: { enabled: true } })
    const outcome = await runAdapter(adapter)
    assert.equal(outcome.reason?.kind, 'error')
    assert.equal(outcome.reason?.failure?.code, 'EXO_STREAM_ERROR')
    assert.equal(adapter.providerRetryPolicy().retryableCodes.includes(outcome.reason.failure.code), false)
    assert.equal(current.seen.length, 1)
    assert.equal(authCalls.length, 1)
    assert.equal(usage.length, 1)
    assert.equal(usage[0].ok, false)
    assert.equal(turns[0].recovered, false)
  })
} finally {
  lane.fetch = null
  laneUser.token = undefined
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => server.close(resolve))
  fs.rmSync(home, { recursive: true, force: true })
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  if (previousBase === undefined) delete process.env.OUR_FREE_MODEL_BASE
  else process.env.OUR_FREE_MODEL_BASE = previousBase
}

console.log(`\nexo-test: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures === 0 ? 0 : 1
