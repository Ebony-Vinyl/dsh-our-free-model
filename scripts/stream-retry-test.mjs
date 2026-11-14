/**
 * A connection that drops *before the answer starts* is retried once.
 *
 * Measured on this install: a `POST /v1/chat/completions` for a working model
 * answered `502 STREAM_CUT` ("read ECONNRESET") while the identical request
 * answered 200 a second later. The read failed inside `readHead`, i.e. before a
 * single byte reached the caller, so re-sending it duplicates nothing — yet the
 * turn was reported as broken and the model looked unavailable to the probe.
 *
 * The other half matters more: a retry is only safe *there*. Once a payload has
 * been handed over, re-sending would duplicate text or a tool call, and a quota
 * wall must never be re-sent at all (issue #13: each re-send spends the window
 * the verdict is measured in).
 *
 * Run: node scripts/stream-retry-test.mjs
 */
import http from 'node:http'
import { chatFrames } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

const scripts = new Map()
const hits = new Map()
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', row => chunks.push(row))
  req.on('end', () => {
    let body = {}
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { /* scripted */ }
    const model = body.model
    hits.set(model, (hits.get(model) ?? 0) + 1)
    const script = scripts.get(model)
    const attempt = hits.get(model)
    const plan = typeof script === 'function' ? script(attempt) : script
    if (plan.reset === true) {
      // The status line goes out, then the socket dies before the body: the
      // shape the gateway actually produced (`ECONNRESET` while sniffing the
      // first frames). Destroying the socket *before* a status line is a
      // different failure that undici retries by itself, which would count a
      // send the lane never made.
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders?.()
      // One byte, then the socket dies. The byte is what makes this the failure
      // the lane has to handle rather than an undici-level reconnect: the body
      // has started, so the read is inside `readHead` (nothing handed over yet)
      // when `ECONNRESET` arrives.
      res.write(Buffer.from('d'))
      setTimeout(() => req.socket.destroy(), 5).unref?.()
      return
    }
    if (plan.cutMidBody === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.flushHeaders?.()
      res.write(Buffer.from(plan.partial))
      setTimeout(() => req.socket.destroy(), 5).unref?.()
      return
    }
    res.writeHead(plan.status ?? 200, { 'content-type': plan.contentType ?? 'text/event-stream' })
    res.end(Buffer.from(plan.body ?? chatFrames('pulih')))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
server.unref()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${server.address().port}`
// A retry is only useful if it is fast enough that nobody notices it; the
// production pause is 700 ms and this test waits it out rather than mocking it.
const { CODE, postStreamed, STREAM_ATTEMPTS } = await import('../src/http.js')

async function ask(model) {
  const payloads = []
  const warnings = []
  const started = Date.now()
  try {
    await postStreamed({
      path: '/zen/v1/chat/completions',
      body: { model, messages: [{ role: 'user', content: 'hi' }], stream: true },
      session: 'ses_test', onData: payload => payloads.push(payload), warn: line => warnings.push(line),
    })
    return { payloads, warnings, elapsed: Date.now() - started }
  } catch (error) {
    return { error, payloads, warnings, elapsed: Date.now() - started }
  }
}
const framesOf = payloads => payloads
  .map(raw => { try { return JSON.parse(raw).choices?.[0]?.delta?.content ?? '' } catch { return '' } })
  .join('')

// ── the reported case: dies before the first byte, then answers ─────────────
scripts.set('flaky-free', attempt => attempt === 1 ? { reset: true } : {})
const flaky = await ask('flaky-free')
check('a connection that drops before the answer is sent again', hits.get('flaky-free'), 2)
check('and the turn succeeds instead of failing', flaky.error?.message ?? 'none', 'none')
check('with the answer intact', framesOf(flaky.payloads), 'pulih')
check('and the retry is announced in the log', flaky.warnings.some(line => /sending it once more/.test(line)), true)
check('the pause between sends is the documented one', flaky.elapsed >= 700, true)

// ── one retry, not a loop ───────────────────────────────────────────────────
scripts.set('dead-free', () => ({ reset: true }))
const dead = await ask('dead-free')
check('a connection that never comes back is tried twice, no more', hits.get('dead-free'), STREAM_ATTEMPTS)
check('and reports a transport failure', dead.error?.code, CODE.transport)
check('only once per attempt', dead.warnings.length, 1)

// ── after the first byte the caller already has it: no re-send ──────────────
scripts.set('half-free', () => ({ cutMidBody: true, partial: `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'teks' } }] })}\n\n` }))
const half = await ask('half-free')
check('a stream cut after the first byte is not re-sent', hits.get('half-free'), 1)
check('and the failure is reported, not swallowed', typeof half.error?.code, 'string')

// ── a quota wall is a verdict, not a transient fault ───────────────────────
scripts.set('quota-free', () => ({
  status: 429,
  contentType: 'application/json',
  body: JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go' } }),
}))
const quota = await ask('quota-free')
check('a 429 is never re-sent', hits.get('quota-free'), 1)
check('and stays a RATE_LIMIT', quota.error?.code, CODE.quota)

// ── the lane lock is likewise final ────────────────────────────────────────
scripts.set('locked-free', () => ({
  status: 403,
  contentType: 'application/json',
  body: JSON.stringify({ error: { type: 'permission_error', code: 'LANE_LOCKED', message: "OpenCode's free tier can only be used from within OpenCode." } }),
}))
const locked = await ask('locked-free')
check('a 403 lane lock is never re-sent', hits.get('locked-free'), 1)
check('and keeps its own code', locked.error?.code, CODE.laneLocked)

// ── a server fault is not our connection: the host owns that retry ─────────
scripts.set('broken-free', () => ({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { type: 'server_error', message: 'boom' } }) }))
check('a 5xx is not re-sent here', (await ask('broken-free'), hits.get('broken-free')), 1)

// ── a single JSON body (not SSE) survives the same drop ────────────────────
scripts.set('json-free', attempt => attempt === 1 ? { reset: true } : { contentType: 'application/json', body: JSON.stringify({ id: 'x', choices: [{ index: 0, message: { role: 'assistant', content: 'halo' } }] }) })
const single = await ask('json-free')
check('a buffered JSON answer is retried the same way', hits.get('json-free'), 2)
check('and arrives as one payload', single.payloads.length, 1)
check('carrying the answer', JSON.parse(single.payloads[0] ?? '{}').choices?.[0]?.message?.content, 'halo')

server.close()
console.log(`\n${failures === 0 ? 'semua lolos' : `${failures} check gagal`}`)
process.exit(failures === 0 ? 0 : 1)
