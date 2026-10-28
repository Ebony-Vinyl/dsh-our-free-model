/**
 * A client that walks away must give its concurrency slot back — offline.
 *
 * The gateway holds a per-IP (and per-account) slot for the whole life of a chat
 * turn. Two windows in that life are long and were uncovered (#680):
 *
 * 1. **admission** — the rate limiters are `await`ed before any slot is taken;
 * 2. **upstream wait** — `await gateway.fetch(...)` lasts until the relay sends
 *    its headers, which for a busy relay is exactly when a caller gives up.
 *
 * The `close` listener used to be installed only *after* that second await, so a
 * disconnect in either window left the slot held forever: `/pool` kept reporting
 * the request in flight and every later turn from that IP was refused with 429
 * until the process restarted. The same omission meant the relay connection was
 * never torn down, so the gateway paid for an answer nobody would read.
 *
 * The relay here holds its headers on demand, which is the cheapest way to sit
 * inside that second window. Everything is loopback: no network, no quota.
 *
 * Run: node scripts/gateway-disconnect-test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

let checks = 0
let failures = 0
const check = (name, ok, detail = '') => {
  checks++
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === '' ? '' : ` — ${detail}`}`)
}

process.env.OUR_FREE_MODEL_BASE ??= 'http://127.0.0.1:9'
const { createGatewayServer } = await import('../worker/gateway-node.mjs')
const { signSealedRequest } = await import('../src/eac.js')

const SIGNING = 'gateway-disconnect-signing-secret-0123456789'
const MODEL = 'deepseek-ai/deepseek-v4.1-flash'
const CHAT_PATH = '/eac/v1/chat/completions'

// ── the relay: holds its headers on demand, and notices when we hang up ──────
const relay = { mode: 'hold', held: 0, aborted: 0 }
const relayServer = http.createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: MODEL }] }))
    }
    if (!req.url.endsWith('/chat/completions')) {
      res.writeHead(404)
      return res.end('not found')
    }
    if (relay.mode === 'hold') {
      relay.held += 1
      // Deliberately nothing: no head, no body. The gateway is parked on
      // `await fetch(...)`, which is the window under test.
      // The gateway's abort reaches this side as a socket close. `req.on('close')`
      // is useless here — it fires as soon as the request body is consumed, so it
      // would report a teardown that never happened.
      req.socket?.on('close', () => { relay.aborted += 1 })
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'cmpl', model: MODEL, choices: [{ delta: { content: 'OK' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
})
await new Promise(resolve => relayServer.listen(0, '127.0.0.1', resolve))
const relayPort = relayServer.address().port

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-disconnect-'))
const server = createGatewayServer({
  UPSTREAM_URL: `http://127.0.0.1:${relayPort}/v1`,
  UPSTREAM_API_KEY: 'sk-relay-test',
  SIGNING_SECRETS: SIGNING,
  MOUNT_PREFIX: '/eac',
  POOL_SIZE: '10',
  USER_STORE_PATH: path.join(dir, 'users.json'),
  STATS_PATH: path.join(dir, 'stats.json'),
  RATE_LIMIT_PER_MINUTE: '0',
  RATE_LIMIT_PER_DAY: '0',
  CONCURRENCY_PER_IP: '1',
  SSE_PRELUDE_SECONDS: '15',
  LOG_SALT: 'disconnect-test-salt',
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/eac`

const chatBody = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true })
const headers = {
  'content-type': 'application/json',
  accept: 'text/event-stream',
  ...signSealedRequest(SIGNING, { method: 'POST', path: CHAT_PATH, body: chatBody }),
}

const pool = async () => (await (await fetch(`${base}/pool`)).json())
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Wait until the pool reports no request in flight, or give up. */
async function drained(timeoutMs) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if ((await pool()).inflight === 0) return Date.now() - started
    await sleep(25)
  }
  return null
}

try {
  // ── 1. the window the old code did not cover ──────────────────────────────
  const ac = new AbortController()
  const live = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: chatBody, signal: ac.signal })
  check('the turn is admitted and the prelude opens', live.status === 200, `got ${live.status}`)

  // Read exactly up to the prelude frame: at that point the core has called
  // `onUpstreamPending` and is parked on the relay's headers.
  const reader = live.body.getReader()
  let prelude = ''
  while (!prelude.includes('channel open')) {
    const { value, done } = await reader.read()
    if (done) break
    prelude += new TextDecoder().decode(value)
  }
  check('the prelude arrives while the relay is still holding headers', prelude.includes('channel open'), JSON.stringify(prelude.slice(0, 80)))

  // The prelude is written just before the core calls the relay, so give that
  // call a moment to land before asserting on it.
  const parkedAt = Date.now()
  while (relay.held === 0 && Date.now() - parkedAt < 2000) await sleep(10)
  check('the relay really is parked (request arrived, no head sent)', relay.held === 1, `held=${relay.held}`)
  check('and the slot is held while the relay thinks', (await pool()).inflight === 1)

  ac.abort()
  try { await reader.cancel() } catch { /* the client is the one aborting */ }

  const freedAfter = await drained(3000)
  check('a disconnect while waiting on the relay releases the slot (#680)', freedAfter !== null, 'the pool still reports inflight > 0 after 3s')

  // The relay connection must go with it: an abandoned upstream keeps billing
  // capacity even once our own bookkeeping is correct.
  const abortedAt = Date.now()
  while (relay.aborted === 0 && Date.now() - abortedAt < 3000) await sleep(25)
  check('and the abandoned relay connection is torn down', relay.aborted >= 1, `relay saw ${relay.aborted} closes`)

  // ── 2. the slot is genuinely usable again ─────────────────────────────────
  relay.mode = 'fast'
  const next = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: chatBody })
  const nextText = await next.text()
  check('the next turn from the same IP is served, not refused with 429', next.status === 200 && nextText.includes('OK'), `status ${next.status}`)
  check('and the pool drains after a normal turn too', (await drained(3000)) !== null)

  // ── 3. a disconnect during admission never takes a slot ───────────────────
  // With the relay fast, the turn completes before anyone can hang up — so this
  // one only pins that an aborted request cannot leave a counter behind.
  relay.mode = 'hold'
  const ac2 = new AbortController()
  const second = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: chatBody, signal: ac2.signal })
  const reader2 = second.body.getReader()
  let prelude2 = ''
  while (!prelude2.includes('channel open')) {
    const { value, done } = await reader2.read()
    if (done) break
    prelude2 += new TextDecoder().decode(value)
  }
  ac2.abort()
  try { await reader2.cancel() } catch { /* expected */ }
  check('a second disconnect drains just as cleanly', (await drained(3000)) !== null)
} finally {
  // Aborted requests leave half-open sockets behind; without this the close
  // callback never fires and the suite hangs instead of reporting.
  const closed = new Promise(resolve => server.close(resolve))
  server.closeAllConnections?.()
  await closed
  const relayClosed = new Promise(resolve => relayServer.close(resolve))
  relayServer.closeAllConnections?.()
  await relayClosed
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures === 0 ? 'ok' : 'FAIL'} ${checks - failures}/${checks} checks passed`)
process.exit(failures === 0 ? 0 : 1)
