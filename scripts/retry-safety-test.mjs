/**
 * The failure vocabulary, end to end: what each real shape costs the caller, and
 * whether the harness is allowed to retry it.
 *
 * Two things are checked per case. The first is the one the durable session log
 * enforces: the harness writes `finish.reason.failure` straight into an
 * `llm/retry` event, and that append rejects Error instances, non-finite numbers
 * and explicit `undefined` fields — a rejected append aborts the whole turn
 * instead of letting the harness back off, so a malformed failure is strictly
 * worse than a sparse one.
 *
 * The second is the code itself, and the retry policy read against it. This suite
 * used to prove neither: it called the adapter with `model:
 * "our-free-model/test-model-free"`, and `baseModelId` strips a *label*, not a
 * route, so every case — including "transport failure" and "aborted signal" —
 * returned the up-front "does not serve" error without a request leaving the
 * process. Four labelled cases, one code, and nothing said about retryability:
 * which is the property that decides whether a turn the user cancelled gets sent
 * to the gateway again.
 *
 * Run: node scripts/retry-safety-test.mjs
 */
import { chatFrames, stubUpstream } from './lib/fake-kernel.mjs'

/** How many requests this model has been asked for: 1 on the first. */
const attempts = new Map()
const tries = model => {
  attempts.set(model, (attempts.get(model) ?? 0) + 1)
  return attempts.get(model)
}

const stub = await stubUpstream({
  answer: model => {
    if (model === 'socket-model-free') return { socket: true }
    if (model === 'region-model-free') {
      // A refusal that arrives *inside* an open stream: the header said 200, so
      // nothing but the frame itself can say what happened.
      return { pieces: ['data: {"type":"error","error":{"type":"RegionError","message":"This model is not available in your country."}}\n\n'] }
    }
    if (model === 'quota-model-free') {
      return { pieces: ['data: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Try again later."}}\n\n'] }
    }
    if (model === 'quota-once-model-free' || model === 'quota-always-model-free') {
      // The live shape of a refusal, measured through the forward port: the
      // gateway answers the request itself with a 502 whose message is the lane's
      // own words, and no stream ever opens.
      const refused = { status: 502, body: JSON.stringify({ error: { type: 'server_error', message: 'Error from provider (Console): Rate limit exceeded. Please try again later.' } }) }
      if (model === 'quota-always-model-free' || tries(model) === 1) return refused
      return { body: chatFrames('fine') }
    }
    if (model === 'quota-late-model-free') {
      // Refused only once the stream has already carried text to the caller.
      return { pieces: [
        'data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n',
        'data: {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Try again later."}}\n\n',
      ] }
    }
    if (model === 'slow-model-free') {
      // Content, and then nothing: the turn is open, text has been handed to the
      // caller, and this is where a cancellation has to land.
      return { pieces: ['data: {"choices":[{"index":0,"delta":{"content":"partial"}}]}\n\n'], holdMs: 700 }
    }
    if (model === 'refusal-model-free') {
      // A request the gateway refuses before any stream opens: 4xx is the
      // request's own fault, and re-sending the identical body reproduces it.
      return { status: 400, body: JSON.stringify({ error: { type: 'invalid_request_error', message: 'messages: an assistant message with no content precedes tool calls.' } }) }
    }
    return { body: chatFrames('fine') }
  },
})
// Set before the adapter module reads it: UPSTREAM_BASE is captured at import time.
process.env.OUR_FREE_MODEL_BASE = stub.base
const { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } = await import('../src/adapter.js')
const { CODE } = await import('../src/http.js')

/**
 * Mirrors `snapshotJsonValue` from @deepseek-ai/dsh-util-values: a value survives
 * only if every leaf is a JSON primitive, a plain object or an array.
 */
function isLosslessJson(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) return value.every(item => isLosslessJson(item, seen))
  if (typeof value !== 'object' || value === undefined) return false
  if (seen.has(value)) return false
  seen.add(value)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.values(value).every(item => isLosslessJson(item, seen))
}

const MODELS = ['test-model-free', 'socket-model-free', 'region-model-free', 'quota-model-free', 'slow-model-free', 'refusal-model-free', 'quota-once-model-free', 'quota-always-model-free', 'quota-late-model-free']
const CATALOG = MODELS.map(id => ({
  id, name: `Test ${id}`, availability: 'available',
  vision: false, reasoning: true, contextWindow: 128000, maxOutput: 8192,
}))

const STATE = () => ({
  catalog: CATALOG,
  membership: { [ROUTE_MAIN]: MODELS, [ROUTE_REGION]: [] },
  settings: { enabled: true, defaultMaxTokens: 4096 },
  attributionUserAgent: 'test/1.0',
})

/** Run the real adapter and return the failure object it yields, if any. */
async function failureFor(model, { state = STATE, signal, abortAfterFirstText } = {}) {
  let regionSignal
  const adapter = new FreeModelAdapter({
    state,
    recordUsage: () => {},
    warn: () => {},
    onRegionBlocked: id => { regionSignal = id },
  })
  // Cancelled from inside the consumer rather than on a wall clock: the point of
  // this case is "text had already been handed over when the user stopped it", and
  // a timer set beside a warm HTTP server only proved that some of the time.
  const own = new AbortController()
  let failure = null
  let kind = null
  let streamed = 0
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    ...signal === undefined && abortAfterFirstText !== true ? {} : { signal: signal ?? own.signal },
  })) {
    if (chunk.type === 'text-delta') {
      streamed++
      if (abortAfterFirstText === true && streamed === 1) own.abort(new Error('user cancelled'))
    }
    if (chunk.type === 'finish') {
      kind = chunk.reason.kind
      failure = chunk.reason.failure ?? null
    }
  }
  return { failure, kind, streamed, regionSignal }
}

const policy = new FreeModelAdapter({ state: STATE, recordUsage: () => {}, warn: () => {} }).providerRetryPolicy()

/**
 * `signal.abort(new Error(...))` rejects fetch with *that* error, whose `name` is
 * `Error` — so a check on the name alone filed a cancelled turn under
 * `TRANSPORT`, which is in `retryableCodes`. The reason the harness cancels with
 * is not part of the contract; the fact that it cancelled is.
 */
const cases = [
  // name, model, fixture, finish kind, code, retryable?, region re-probe?, text delivered?
  ['transport failure', 'socket-model-free', {}, 'error', CODE.transport, true, undefined, false],
  ['aborted before the request', 'test-model-free', { signal: AbortSignal.abort() }, 'aborted', CODE.aborted, false, undefined, false],
  ['aborted mid-stream, with the caller’s own reason', 'slow-model-free', { abortAfterFirstText: true }, 'aborted', CODE.aborted, false, undefined, true],
  ['model not served on this egress', 'no-such-model-free', {}, 'error', CODE.server, true, undefined, false],
  ['plugin switched off mid-call', 'test-model-free', { state: () => ({ ...STATE(), settings: { ...STATE().settings, enabled: false } }) }, 'error', 'CONFIG_DISABLED', false, undefined, false],
  ['a geography refusal inside the stream', 'region-model-free', {}, 'error', CODE.region, false, 'region-model-free', false],
  // Issue #13: the lane's 429 carries a growing retry-after, so the automatic
  // retries turned one quota wall into three. A quota refusal now surfaces to
  // the harness immediately, the same way a geography refusal does.
  ['the free usage limit inside the stream', 'quota-model-free', {}, 'error', CODE.quota, false, undefined, false],
  // A 4xx is the request's own fault: the same body sent again fails the same
  // way, so the backoff scheduler must never be told this code is retryable.
  ['a refusal the retry list must never re-send', 'refusal-model-free', {}, 'error', CODE.client, false, undefined, false],
]

let failed = 0
for (const [name, model, fixture, wantKind, wantCode, wantRetryable, wantRegionFor, wantStreamed] of cases) {
  let outcome
  try {
    outcome = await failureFor(model, fixture)
  } catch (error) {
    console.log(`FAIL  ${name}: stream threw instead of yielding a failure — ${error?.message ?? error}`)
    failed++
    continue
  }
  const { failure, kind, regionSignal, streamed } = outcome
  if (failure === null) {
    console.log(`FAIL  ${name}: no failure on the finish (kind ${kind ?? 'none'})`)
    failed++
    continue
  }
  const undefinedFields = Object.keys(failure).filter(key => failure[key] === undefined)
  const shaped = typeof failure.message === 'string' && failure.message.length > 0
    && typeof failure.code === 'string' && failure.code.length > 0
  const code = failure.code
  const retryable = policy.retryableCodes.includes(code)
  const problems = []
  if (!isLosslessJson(failure)) problems.push('not durable-log safe')
  if (!shaped) problems.push('malformed')
  if (undefinedFields.length > 0) problems.push(`undefined fields [${undefinedFields}]`)
  if (kind !== wantKind) problems.push(`finish kind ${kind}, want ${wantKind}`)
  if (code !== wantCode) problems.push(`code ${code}, want ${wantCode}`)
  if (retryable !== wantRetryable) problems.push(`retryable=${retryable}, want ${wantRetryable}`)
  if (regionSignal !== wantRegionFor) problems.push(`region re-probe ${regionSignal ?? 'did not fire'}, want ${wantRegionFor ?? 'not to fire'}`)
  if ((streamed > 0) !== wantStreamed) problems.push(`text delivered ${streamed}, want ${wantStreamed ? 'some' : 'none'}`)
  if (problems.length === 0) console.log(`ok    ${name}: ${code}${retryable ? ' (retryable)' : ' (never retried)'}`)
  else {
    console.log(`FAIL  ${name}: ${problems.join('; ')} — ${JSON.stringify(failure)}`)
    failed++
  }
}

// A quota refusal has one consumer beyond the caller: the host half. "Rate limit
// exceeded" is a per-IP verdict, and the outlet's own health check cannot see it
// (gstatic keeps answering 204 through a node the lane just rate-limited), so
// the plugin is the component that has to re-measure the outlet and step off
// that exit. The hook has to fire on that code alone — a transport failure or a
// geography refusal must never move the exit.
const quotaHits = []
async function driveForHooks(model) {
  const adapter = new FreeModelAdapter({
    state: STATE,
    recordUsage: () => {},
    warn: () => {},
    onQuotaHit: id => quotaHits.push(id),
  })
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) void chunk
}
await driveForHooks('quota-model-free')
await driveForHooks('region-model-free')
await driveForHooks('socket-model-free')
const quotaHookOk = quotaHits.length === 1 && quotaHits[0] === 'quota-model-free'
console.log(`${quotaHookOk ? 'ok   ' : 'FAIL '} a quota refusal alone reaches the exit-rotation hook: ${JSON.stringify(quotaHits)}`)

// A refusal is the one failure the exit can answer for: the lane rate-limits the
// address it sees, so the host half moves the outlet and says whether it really
// moved. When it did, the turn is worth one more try on the fresh exit instead of
// being handed back to the user as an error they did not cause. The bounds matter
// as much as the retry — one per turn, never after text has reached the caller, and
// never without a move, because re-sending into the exit that just refused is the
// loop the retry policy keeps out.
async function driveQuota(model, onQuotaHit) {
  const rows = []
  const adapter = new FreeModelAdapter({
    state: STATE,
    recordUsage: row => rows.push(row),
    warn: () => {},
    onQuotaHit,
  })
  const before = stub.requests.length
  let kind = null
  let failure = null
  for await (const chunk of adapter.stream({
    provider: ROUTE_MAIN,
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    if (chunk.type === 'finish') {
      kind = chunk.reason.kind
      failure = chunk.reason.failure ?? null
    }
  }
  return { kind, failure, rows, attempts: stub.requests.length - before }
}

const moved = []
const once = await driveQuota('quota-once-model-free', id => { moved.push(id); return true })
const onceOk = once.attempts === 2 && once.kind === 'stop' && once.failure === null
  && moved.length === 1
  && once.rows.length === 2 && once.rows[0].ok === false && once.rows[0].refusal === true && once.rows[1].ok === true
console.log(`${onceOk ? 'ok   ' : 'FAIL '} a refused turn is re-sent once the exit moved: ${JSON.stringify({ attempts: once.attempts, kind: once.kind, rows: once.rows.map(row => (row.ok ? 'ok' : row.refusal === true ? 'refused' : 'failed')) })}`)

const stuck = await driveQuota('quota-always-model-free', () => true)
const stuckOk = stuck.attempts === 2 && stuck.failure?.code === CODE.quota
console.log(`${stuckOk ? 'ok   ' : 'FAIL '} a second refusal ends the turn instead of walking the outlet: attempts=${stuck.attempts} code=${stuck.failure?.code}`)

const kept = await driveQuota('quota-always-model-free', () => false)
const keptOk = kept.attempts === 1 && kept.failure?.code === CODE.quota
console.log(`${keptOk ? 'ok   ' : 'FAIL '} a refusal the outlet could not step off is not re-sent: attempts=${kept.attempts}`)

const late = await driveQuota('quota-late-model-free', () => true)
const lateOk = late.attempts === 1 && late.failure?.code === CODE.quota
console.log(`${lateOk ? 'ok   ' : 'FAIL '} a refusal after text reached the caller is not re-sent: attempts=${late.attempts}`)

// The provider policy is consumed verbatim by the kernel's backoff scheduler,
// which reads these fields off the top level. A nested `backoff` makes the
// scheduled delay NaN, and the durable session log rejects NaN outright.
const exponential = Math.min(policy.initialDelayMs * 2 ** 0, policy.maxDelayMs)
const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * 0.5
const firstDelay = Math.min(exponential * jitter, policy.maxDelayMs)
const policyShapeOk = isLosslessJson({ ...policy, retryableCodes: [...policy.retryableCodes] })
  && Number.isFinite(firstDelay) && firstDelay > 0
console.log(`${policyShapeOk ? 'ok   ' : 'FAIL '} retry policy schedules a finite delay: firstDelay=${Number.isFinite(firstDelay) ? Math.round(firstDelay) : 'NaN'}ms`)

// `ABORTED` is absent from the retryable list by decision, and nothing else in
// the repository would say so if it were added back: the code is correct at the
// transport layer on its own, and the policy that consumes it lives 200 lines
// away in another module.
const abortedNeverRetried = !policy.retryableCodes.includes(CODE.aborted)
  && !policy.retryableCodes.includes('CONFIG_DISABLED')
console.log(`${abortedNeverRetried ? 'ok   ' : 'FAIL '} a cancelled turn is not in the retryable set: [${policy.retryableCodes}]`)

// The round trip above reaches the failure classifier with an HTTP status, but
// so does every plain non-2xx response in the request layer — the classifier is
// where 4xx has to leave the retry vocabulary. 5xx and the capacity statuses
// (408/425) stay SERVER: those are the gateway's own trouble and a re-send can
// answer differently.
const { classifyFailure } = await import('../src/http.js')
const classify = (status, message, type) => classifyFailure(status, { error: { ...(type === undefined ? {} : { type }), message } }, () => {})
const refused = classify(400, 'messages: an assistant message with no content precedes tool calls.', 'invalid_request_error')
const clientOk = refused.code === 'CLIENT_ERROR' && !policy.retryableCodes.includes(refused.code)
  && classify(404, 'No such model: no-such-model-free').code === 'CLIENT_ERROR'
  && classify(422, 'unprocessable entity: messages[3].tool_calls is malformed').code === 'CLIENT_ERROR'
  && classify(500, 'Internal server error').code === CODE.server
  && classify(408, 'upstream timed out').code === CODE.server
  && classify(425, 'upstream sent nothing').code === CODE.server
  && policy.retryableCodes.includes(CODE.server)
console.log(`${clientOk ? 'ok   ' : 'FAIL '} a 4xx is CLIENT_ERROR and never retried, 5xx/408/425 stay SERVER: ${JSON.stringify({ code: refused.code, retryable: policy.retryableCodes.includes(refused.code) })}`)

// The same rule covers the usage event the harness appends after a turn, and the
// OpenAI `usage` object has no required details block: reading `cached_tokens`
// off an absent one made `inputTokens` NaN on every call from a gateway that
// omits the optional field.
const { mapUsage } = await import('../src/stream.js')
const bare = mapUsage({ prompt_tokens: 11, completion_tokens: 7 })
const usageOk = isLosslessJson(bare) && bare?.inputTokens === 11 && bare?.outputTokens === 7
  && bare.totalTokens === 18 && !('cacheReadTokens' in bare)
console.log(`${usageOk ? 'ok   ' : 'FAIL '} a usage object with no details block stays finite: ${JSON.stringify(bare)}`)

const cached = mapUsage({ prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 12 } })
const cachedOk = cached.inputTokens === 8 && cached.cacheReadTokens === 12 && cached.totalTokens === 25
console.log(`${cachedOk ? 'ok   ' : 'FAIL '} a cache hit is taken out of the disjoint input count: ${JSON.stringify(cached)}`)

// The held connection from the mid-stream abort is still open. Windows' libuv
// asserts if the process tears down a handle that is mid-close, so let the
// scripted answer finish and the sockets retire before exiting.
await new Promise(resolve => setTimeout(resolve, 900))
await stub.close()

const ok = failed === 0 && policyShapeOk && usageOk && cachedOk && abortedNeverRetried && clientOk && quotaHookOk
  && onceOk && stuckOk && keptOk && lateOk
console.log(ok
  ? `\nretry-safety: all ${cases.length} failure shapes are classified, retried correctly, and durable-log safe`
  : `\nretry-safety: ${failed + (policyShapeOk ? 0 : 1) + (usageOk ? 0 : 1) + (cachedOk ? 0 : 1) + (abortedNeverRetried ? 0 : 1) + (clientOk ? 0 : 1) + (quotaHookOk ? 0 : 1) + (onceOk ? 0 : 1) + (stuckOk ? 0 : 1) + (keptOk ? 0 : 1) + (lateOk ? 0 : 1)} failure(s)`)
process.exit(ok ? 0 : 1)
