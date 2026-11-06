/**
 * The free lane's quota discipline (issues #708/#767):
 *
 * 1. one real 429 opens the breaker with the upstream's `Retry-After`;
 * 2. while it is open, further turns are refused locally — the wall sees no
 *    second request, whatever model or session the caller picks;
 * 3. the manual probe refuses for the same reason instead of spending the
 *    next window;
 * 4. the "exit changed" clear reopens the lane exactly once;
 * 5. a real success clears a stale breaker and records passive availability;
 * 6. the client gate (403 FreeTierError) locks the lane without a window.
 *
 * Everything runs against a loopback fixture; no live traffic.
 * Run: node scripts/free-lane-quota-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

/** One fixture upstream with scripted POST responses and a request counter. */
function startFixture() {
  const turns = []
  const script = []
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', chunk => { raw += chunk })
    req.on('end', () => {
      const step = script.shift() ?? { status: 500 }
      turns.push({ path: req.url, headers: req.headers, body: JSON.parse(raw || '{}') })
      if (step.sse === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'PONG' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`)
        return
      }
      res.writeHead(step.status, { 'content-type': 'application/json', ...(step.headers ?? {}) })
      res.end(JSON.stringify(step.body ?? { error: { message: 'fixture' } }))
    })
  })
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({ server, turns, script, port: server.address().port }))
  })
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-quota-'))
process.env.OUR_FREE_MODEL_BASE = '' // replaced after the fixture binds
process.env.OUR_FREE_MODEL_KILO_BASE = 'http://127.0.0.1:1'

const { server, turns, script, port } = await startFixture()
process.env.OUR_FREE_MODEL_BASE = `http://127.0.0.1:${port}`

const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')
const { CODE } = await import('../src/http.js')

const stores = createRuntimeStores({ dataDir, logger: { warn: () => {} } })
const runtime = createModelRuntime({
  ...stores,
  logger: { warn: () => {}, info: () => {} },
  onTopology: () => {},
})
const adapter = runtime.adapter
const entry = runtime.catalog.find(row => row.id === 'deepseek-v4.1-flash-free')
assert.ok(entry, 'the fallback roster carries the DeepSeek free model')

const turn = () => {
  const chunks = []
  const stream = adapter.stream({
    model: entry.id,
    messages: [{ role: 'user', content: 'ping' }],
    sessionId: 'quota:probe',
  }, entry, runtime.state())
  return (async () => {
    try {
      for await (const chunk of stream) chunks.push(chunk)
    } catch (error) {
      // The gate refusals throw; upstream failures surface as a finish event.
      return { ok: false, code: error?.code, failure: error, message: String(error?.message ?? error) }
    }
    const failed = chunks.find(chunk => chunk.type === 'finish' && chunk.reason?.kind === 'error')
    if (failed) {
      const failure = failed.reason.failure ?? {}
      return { ok: false, code: failure.code, failure, message: String(failure.message ?? '') }
    }
    return { ok: true, chunks }
  })()
}

console.log('=== 1. one real 429 opens the breaker with the upstream window ===')
{
  script.push({ status: 429, headers: { 'retry-after': '120' }, body: { type: 'error', error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go' } } })
  const first = await turn()
  check('the turn fails with the quota code', [first.ok, first.code], [false, CODE.quota])
  check('exactly one request reached the wall', turns.length, 1)
  const lane = stores.availability.get().lane
  check('the breaker is open', [lane?.state, typeof lane?.retryAt], ['quota', 'number'])
  check('the window honours Retry-After', lane.retryAt > Date.now() + 110_000 && lane.retryAt <= Date.now() + 121_000, true)
  check('the refused model reads throttled', stores.availability.get().results[entry.id]?.state, 'throttled')
}

console.log('\n=== 2. further turns are refused locally; the wall sees nothing ===')
{
  const before = turns.length
  const second = await turn()
  check('the second turn is refused with quota', [second.ok, second.code, second.failure?.laneQuota], [false, CODE.quota, true])
  check('the message names the reset', /retry after/i.test(second.message), true)
  check('the wall received no second request', turns.length, before)
  const third = await turn()
  check('a different session is refused too (per-IP window)', [third.ok, turns.length], [false, before])
}

console.log('\n=== 3. the manual probe refuses while the window is open ===')
{
  const outcome = await runtime.refreshAvailability(true)
  check('the probe is skipped with the window named', [outcome.skipped, Number.isFinite(outcome.retryAt), turns.length], ['quota', true, turns.length])
}

console.log('\n=== 4. clearing the breaker reopens the lane exactly once ===')
{
  check('the clear reports that it cleared', runtime.clearLaneBreaker(), true)
  check('a second clear is a no-op', runtime.clearLaneBreaker(), false)
  check('the gate is open again', runtime.laneGate().ok, true)
}

console.log('\n=== 5. a real success clears stale state and records passive availability ===')
{
  script.push({ sse: true })
  const good = await turn()
  check('the turn answers', good.ok, true)
  const row = stores.availability.get().results[entry.id]
  check('the model reads available from live traffic', [row?.state, row?.source], ['available', 'passive'])
  check('the breaker stays clear', stores.availability.get().lane?.state ?? 'ok', 'ok')
}

console.log('\n=== 6. the client gate locks the lane without a window ===')
{
  script.push({ status: 403, body: { type: 'error', error: { type: 'FreeTierError', message: "OpenCode's free tier can only be used from within OpenCode" } } })
  const locked = await turn()
  check('the turn fails with the lane-lock code', [locked.ok, locked.code], [false, CODE.laneLocked])
  check('the breaker reads locked', stores.availability.get().lane?.state, 'locked')
  const before = turns.length
  const again = await turn()
  check('the next turn is refused locally', [again.ok, again.code, again.failure?.laneState], [false, CODE.quota, 'locked'])
  check('the wall saw no retry', turns.length, before)
  runtime.clearLaneBreaker()
}

server.close()
stores.dispose()
fs.rmSync(dataDir, { recursive: true, force: true })

console.log(failures === 0 ? '\nall free-lane quota checks passed' : `\n${failures} free-lane quota check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
