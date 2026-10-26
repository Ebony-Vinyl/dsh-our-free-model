/**
 * The router's failure vocabulary, checked against the two sources it was
 * ported from (9router's ERROR_RULES and FCC's failure_policy).
 *
 * This suite pins numbers, not just kinds. The cooldown table is an operational
 * contract — 2 minutes for a dead credential, 5 seconds for a refusal that
 * clears on a token refresh, exponential backoff for rate limits, a 30 second
 * transient default, and *no* cooldown for a request-scoped 4xx — and a port
 * that quietly rounded those to the nearest kind would look green while
 * changing how long real accounts sit out. So every text rule and every status
 * rule of 9router's ERROR_RULES is asserted with the exact milliseconds it
 * produces, every status/marker mapping of the FCC policy is asserted with its
 * kind, scope and retryability, and the two are checked to agree on the one
 * object both callers read.
 *
 * Everything here is pure: no network, no timers, no clock.
 *
 * Run: node scripts/route-test.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import {
  FAILURE_KIND, FAILURE_SCOPE, backoffFor, classifyFailure, cooldownVerdict, describeVerdict, shouldAdvance,
} from '../src/route/classify.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── the ported ERROR_RULES table: text rules ─────────────────────────────────
// Each row: [phrase, cooldownMs, cooldownLevel]. The backoff rows read level 1
// (the first hit) at 2 s — the source's getQuotaCooldown(1) — and the fixed
// rows report level 0 because they never read or advance a level.
const TEXT_RULES = [
  ['no credentials', 120000, 0],
  ['request not allowed', 5000, 0],
  ['improperly formed request', 120000, 0],
  ['rate limit', 2000, 1],
  ['too many requests', 2000, 1],
  ['quota exceeded', 2000, 1],
  ['capacity', 2000, 1],
  ['overloaded', 2000, 1],
]
for (const [phrase, cooldownMs, cooldownLevel] of TEXT_RULES) {
  check(`text rule "${phrase}" benches for exactly ${cooldownMs}ms`, () => {
    const verdict = cooldownVerdict({ message: `Upstream answered: ${phrase.toUpperCase()}` })
    assert.equal(verdict.shouldFallback, true)
    assert.equal(verdict.cooldownMs, cooldownMs)
    assert.equal(verdict.cooldownLevel, cooldownLevel)
  })
}

check('a text rule matches as a substring, case-insensitively, in JSON stringified messages', () => {
  assert.equal(cooldownVerdict({ message: 'upstream said TOO MANY REQUESTS, back off' }).cooldownMs, 2000)
  assert.equal(cooldownVerdict({ message: { error: 'too many requests' } }).cooldownMs, 2000)
  assert.equal(cooldownVerdict({ message: 'no credentials for model x' }).matched, 'text:no credentials')
})

// ── the ported ERROR_RULES table: status rules ───────────────────────────────
const STATUS_RULES = [
  [401, 120000, 0],
  [402, 120000, 0],
  [403, 120000, 0],
  [404, 120000, 0],
  [429, 2000, 1],
]
for (const [status, cooldownMs, cooldownLevel] of STATUS_RULES) {
  check(`status rule ${status} benches for exactly ${cooldownMs}ms`, () => {
    const verdict = cooldownVerdict({ status, message: '' })
    assert.equal(verdict.shouldFallback, true)
    assert.equal(verdict.cooldownMs, cooldownMs)
    assert.equal(verdict.cooldownLevel, cooldownLevel)
    assert.equal(verdict.matched, `status:${status}`)
  })
}

check('text rules win over status rules, in table order', () => {
  // The source's loop checks every text rule before every status rule: a 429
  // whose body says "no credentials" is a credential problem, not a rate limit.
  const credentials = cooldownVerdict({ status: 429, message: 'no credentials' })
  assert.equal(credentials.cooldownMs, 120000)
  assert.equal(credentials.cooldownLevel, 0)
  assert.equal(credentials.matched, 'text:no credentials')
  // A 400 whose wording says rate limit is a rate limit, not request-scoped.
  const limited = cooldownVerdict({ status: 400, message: 'rate limit exceeded' })
  assert.equal(limited.shouldFallback, true)
  assert.equal(limited.cooldownMs, 2000)
  // A 404 whose wording says capacity is provider pressure, not a dead route.
  assert.equal(cooldownVerdict({ status: 404, message: 'at capacity' }).cooldownMs, 2000)
})

check('backoff escalates from the account level and clamps at level 15', () => {
  assert.equal(cooldownVerdict({ status: 429, backoffLevel: 0 }).cooldownMs, 2000)
  assert.equal(cooldownVerdict({ status: 429, backoffLevel: 1 }).cooldownMs, 4000)
  assert.equal(cooldownVerdict({ status: 429, backoffLevel: 3 }).cooldownMs, 16000)
  const clamped = cooldownVerdict({ status: 429, backoffLevel: 20 })
  assert.equal(clamped.cooldownLevel, 15)
  assert.equal(clamped.cooldownMs, 300000)
})

check('an unmatched 4xx is request-scoped and does not cool the account', () => {
  const verdict = cooldownVerdict({ status: 400, message: 'unknown parameter: temperature' })
  assert.equal(verdict.shouldFallback, false)
  assert.equal(verdict.cooldownMs, 0)
  assert.equal(verdict.cooldownLevel, 0)
  assert.equal(verdict.matched, 'request:400')
  // The carve-out names exactly the statuses the rules above already own.
  assert.equal(cooldownVerdict({ status: 418, message: '' }).shouldFallback, false)
})

check('an unmatched 5xx and an error with no status get the 30s transient default', () => {
  const server = cooldownVerdict({ status: 503, message: 'upstream exploded' })
  assert.equal(server.shouldFallback, true)
  assert.equal(server.cooldownMs, 30000)
  assert.equal(server.matched, 'transient')
  assert.equal(cooldownVerdict({ message: 'something odd happened' }).cooldownMs, 30000)
})

// ── backoff arithmetic ───────────────────────────────────────────────────────
check('backoffFor is 2000 * 2^(level-1), capped at 300s, max level 15', () => {
  assert.equal(backoffFor(0), 2000, 'level 0 clamps to the base, as the source Math.max(0, level-1) does')
  assert.equal(backoffFor(1), 2000)
  assert.equal(backoffFor(2), 4000)
  assert.equal(backoffFor(3), 8000)
  assert.equal(backoffFor(4), 16000)
  assert.equal(backoffFor(5), 32000)
  assert.equal(backoffFor(8), 256000)
  assert.equal(backoffFor(9), 300000, 'the 512s step is already past the 300s cap')
  assert.equal(backoffFor(15), 300000)
})

check('backoffFor clamps levels above 15 instead of growing without bound', () => {
  assert.equal(backoffFor(16), 300000)
  assert.equal(backoffFor(99), 300000)
  assert.equal(backoffFor(Number.MAX_SAFE_INTEGER), 300000)
  assert.equal(backoffFor(Number.NaN), 2000)
  assert.equal(backoffFor(-3), 2000)
})

check('backoffFor is monotonic and never exceeds the cap', () => {
  let previous = 0
  for (let level = 0; level <= 40; level += 1) {
    const value = backoffFor(level)
    assert.ok(value >= previous, `level ${level} went backwards: ${value} < ${previous}`)
    assert.ok(value <= 300000, `level ${level} exceeded the cap: ${value}`)
    previous = value
  }
})

// ── the merged classification: kind + cooldown + scope in one object ─────────
// [label, input, {kind, scope, cooldownMs, retryable}]
const CLASSIFICATION_CASES = [
  ['401 status', { status: 401 }, { kind: 'auth', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['402 status', { status: 402 }, { kind: 'billing', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['403 status', { status: 403 }, { kind: 'permission', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['404 status', { status: 404 }, { kind: 'unavailable', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['429 status', { status: 429 }, { kind: 'rate_limit', scope: 'account', cooldownMs: 2000, retryable: true }],
  ['429 as a string status', { status: '429' }, { kind: 'rate_limit', scope: 'account', cooldownMs: 2000, retryable: true }],
  ['"no credentials" wording on a 503', { status: 503, message: 'no credentials configured for this model' },
    { kind: 'auth', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['"request not allowed" wording', { status: 403, message: 'Request not allowed' },
    { kind: 'permission', scope: 'account', cooldownMs: 5000, retryable: false }],
  ['"improperly formed request" wording on a 400', { status: 400, message: 'improperly formed request' },
    { kind: 'invalid_request', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['"rate limit" wording on a 503', { status: 503, message: 'rate limit exceeded' },
    { kind: 'rate_limit', scope: 'account', cooldownMs: 2000, retryable: true }],
  ['"too many requests" wording', { status: 429, message: 'Too Many Requests' },
    { kind: 'rate_limit', scope: 'account', cooldownMs: 2000, retryable: true }],
  ['"quota exceeded" wording', { status: 429, message: 'quota exceeded for this account' },
    { kind: 'rate_limit', scope: 'account', cooldownMs: 2000, retryable: true }],
  ['"overloaded" wording on a 500', { status: 500, message: 'model is overloaded' },
    { kind: 'overloaded', scope: 'provider', cooldownMs: 2000, retryable: true }],
  ['"capacity" wording on a 529', { status: 529, message: 'at capacity' },
    { kind: 'overloaded', scope: 'provider', cooldownMs: 2000, retryable: true }],
  ['unmatched 400', { status: 400, message: 'unknown parameter: temperature' },
    { kind: 'invalid_request', scope: 'request', cooldownMs: 0, retryable: false }],
  ['unmatched 422', { status: 422 }, { kind: 'invalid_request', scope: 'request', cooldownMs: 0, retryable: false }],
  ['413 request too large', { status: 413 }, { kind: 'invalid_request', scope: 'request', cooldownMs: 0, retryable: false }],
  ['408 timing trouble', { status: 408 }, { kind: 'timeout', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['500', { status: 500 }, { kind: 'upstream', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['502', { status: 502 }, { kind: 'overloaded', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['503', { status: 503 }, { kind: 'overloaded', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['504', { status: 504 }, { kind: 'overloaded', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['529', { status: 529 }, { kind: 'overloaded', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['599', { status: 599 }, { kind: 'upstream', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['no status and no marker', {}, { kind: 'unknown', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['project TIMEOUT code', { code: 'TIMEOUT' }, { kind: 'timeout', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['project TRANSPORT code', { code: 'TRANSPORT' }, { kind: 'unavailable', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['project ABORTED code', { code: 'ABORTED' }, { kind: 'aborted', scope: 'request', cooldownMs: 0, retryable: false }],
  ['project SERVER code', { code: 'SERVER' }, { kind: 'upstream', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['project EMPTY_RESPONSE code', { code: 'EMPTY_RESPONSE' }, { kind: 'upstream', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['project CLIENT_ERROR code', { code: 'CLIENT_ERROR' }, { kind: 'invalid_request', scope: 'request', cooldownMs: 0, retryable: false }],
  ['project INVALID_CREDENTIAL code', { code: 'INVALID_CREDENTIAL' }, { kind: 'auth', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['project RATE_LIMIT code', { code: 'RATE_LIMIT' }, { kind: 'rate_limit', scope: 'account', cooldownMs: 2000, retryable: true }],
  ['project REGION_BLOCKED code', { code: 'REGION_BLOCKED' }, { kind: 'unavailable', scope: 'provider', cooldownMs: 0, retryable: false }],
  ['project AUTHORIZATION_REQUIRED code', { code: 'AUTHORIZATION_REQUIRED' }, { kind: 'auth', scope: 'provider', cooldownMs: 0, retryable: false }],
  ['provider invalid_api_key code outranks the status', { status: 500, code: 'invalid_api_key' },
    { kind: 'auth', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['provider permission_denied code', { status: 500, code: 'permission_denied' },
    { kind: 'permission', scope: 'account', cooldownMs: 120000, retryable: false }],
  ['FCC marker resource_exhausted', { status: 503, message: 'RESOURCE_EXHAUSTED' },
    { kind: 'overloaded', scope: 'provider', cooldownMs: 2000, retryable: true }],
  ['FCC marker limit reached', { message: 'monthly limit reached' },
    { kind: 'overloaded', scope: 'provider', cooldownMs: 2000, retryable: true }],
  ['FCC marker internal server error', { message: 'internal server error' },
    { kind: 'upstream', scope: 'transient', cooldownMs: 30000, retryable: true }],
  ['FCC marker model_not_found in the body', { body: { error: { code: 'model_not_found' } } },
    { kind: 'unavailable', scope: 'account', cooldownMs: 120000, retryable: false }],
]
for (const [label, input, expected] of CLASSIFICATION_CASES) {
  check(`classify: ${label} → ${expected.kind}/${expected.scope}/${expected.cooldownMs}ms`, () => {
    const verdict = classifyFailure(input)
    assert.equal(verdict.kind, expected.kind)
    assert.equal(verdict.scope, expected.scope)
    assert.equal(verdict.cooldownMs, expected.cooldownMs)
    assert.equal(verdict.retryable, expected.retryable)
  })
}

check('the merged verdict carries both vocabularies at once', () => {
  const verdict = classifyFailure({ status: 429, message: 'rate limit exceeded', backoffLevel: 1 })
  assert.equal(verdict.kind, FAILURE_KIND.RATE_LIMIT)
  assert.equal(verdict.scope, FAILURE_SCOPE.ACCOUNT)
  assert.equal(verdict.retryable, true)
  assert.equal(verdict.cooldownMs, 4000, 'the legacy cooldown name is the 9router value')
  assert.equal(verdict.cooldownLevel, 2)
  assert.equal(verdict.status, 429)
  assert.match(verdict.rule, /text:rate limit/)
})

// ── context window: FCC's first, non-retryable kind ──────────────────────────
check('context_length_exceeded in a 400 body is CONTEXT_WINDOW, non-retryable, request-scoped', () => {
  const verdict = classifyFailure({
    status: 400,
    message: 'This model\'s maximum context length is 128000 tokens',
    body: { error: { code: 'context_length_exceeded', message: 'too long' } },
  })
  assert.equal(verdict.kind, FAILURE_KIND.CONTEXT_WINDOW)
  assert.equal(verdict.retryable, false)
  assert.equal(verdict.cooldownMs, 0)
  assert.equal(verdict.cooldownLevel, 0)
  assert.equal(verdict.scope, FAILURE_SCOPE.REQUEST)
  assert.equal(shouldAdvance(verdict), false, 'an identical body must not be replayed across the chain')
})

check('a context-window discriminator is recognized as a code, a type and a finish reason', () => {
  assert.equal(classifyFailure({ status: 400, code: 'context_length_exceeded' }).kind, FAILURE_KIND.CONTEXT_WINDOW)
  assert.equal(classifyFailure({ status: 400, body: { error: { type: 'context_length_exceeded' } } }).kind, FAILURE_KIND.CONTEXT_WINDOW)
  assert.equal(classifyFailure({ code: 'model_context_window_exceeded' }).kind, FAILURE_KIND.CONTEXT_WINDOW)
  assert.equal(classifyFailure({ message: 'prompt is too long: 250000 tokens > 200000 maximum' }).kind, FAILURE_KIND.CONTEXT_WINDOW)
  // It outranks a rate-limit status, exactly as the FCC policy checks it first.
  assert.equal(classifyFailure({ status: 429, body: { error: { code: 'context_length_exceeded' } } }).kind, FAILURE_KIND.CONTEXT_WINDOW)
})

check('a context-window failure is not swallowed by the unmatched-4xx carve-out', () => {
  const verdict = classifyFailure({ status: 400, body: { error: { code: 'context_length_exceeded' } } })
  assert.notEqual(verdict.kind, FAILURE_KIND.INVALID_REQUEST)
  assert.notEqual(verdict.scope, FAILURE_SCOPE.ACCOUNT)
})

// ── provider-reported resets ─────────────────────────────────────────────────
check('a provider-reported reset replaces the backoff and is clamped to 30 minutes', () => {
  const sixHours = classifyFailure({ status: 429, message: 'rate limit', retryAfterMs: 6 * 60 * 60 * 1000 })
  assert.equal(sixHours.cooldownMs, 1800000)
  assert.equal(sixHours.kind, FAILURE_KIND.RATE_LIMIT)
  assert.match(sixHours.rule, /provider-reset/)
  const soon = classifyFailure({ status: 429, message: 'rate limit', retryAfterMs: 3000 })
  assert.equal(soon.cooldownMs, 3000)
  const absent = classifyFailure({ status: 429, message: 'rate limit', retryAfterMs: 0 })
  assert.equal(absent.cooldownMs, 2000, 'no reported reset falls back to the rule')
  assert.equal(classifyFailure({ status: 429, message: 'rate limit', retryAfterMs: -5 }).cooldownMs, 2000)
})

check('a provider reset cannot extend a request-scoped or credential verdict', () => {
  assert.equal(classifyFailure({ status: 400, message: 'bad parameter', retryAfterMs: 60000 }).cooldownMs, 0)
  assert.equal(classifyFailure({ status: 401, retryAfterMs: 60000 }).cooldownMs, 120000)
})

// ── advance policy and the log line ──────────────────────────────────────────
check('shouldAdvance rotates for unhealthy candidates and holds for request faults', () => {
  assert.equal(shouldAdvance(classifyFailure({ status: 429 })), true)
  assert.equal(shouldAdvance(classifyFailure({ status: 401 })), true, 'a dead credential must move the router on')
  assert.equal(shouldAdvance(classifyFailure({ status: 500 })), true)
  assert.equal(shouldAdvance(classifyFailure({ status: 403, message: 'request not allowed' })), true)
  assert.equal(shouldAdvance(classifyFailure({ status: 400, message: 'bad parameter' })), false)
  assert.equal(shouldAdvance(classifyFailure({ code: 'ABORTED' })), false)
  assert.equal(shouldAdvance(classifyFailure({ status: 400, body: { error: { code: 'context_length_exceeded' } } })), false)
  assert.equal(shouldAdvance(null), false)
  assert.equal(shouldAdvance({}), false)
})

check('describeVerdict prints kind, scope, cooldown and status in one line', () => {
  const line = describeVerdict(classifyFailure({ status: 429, message: 'rate limit exceeded' }))
  assert.equal(typeof line, 'string')
  assert.match(line, /rate_limit\/account/)
  assert.match(line, /cooldown 2s/)
  assert.match(line, /backoff level 1/)
  assert.match(line, /HTTP 429/)
  assert.match(describeVerdict(classifyFailure({ status: 400, message: 'bad parameter' })), /no cooldown/)
  assert.match(describeVerdict(null), /unknown/)
})
// ── the module stays dependency-free ─────────────────────────────────────────
// The port is meant to be droppable into any lane, so an import of another
// module (or a package) is a contract break, not a style question.
check('classify.js is dependency-free ESM', () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const source = fs.readFileSync(path.join(here, '../src/route/classify.js'), 'utf8')
  const imports = source.split('\n').filter(line => /^\s*import\s/.test(line) || /\brequire\s*\(/.test(line))
  assert.deepEqual(imports, [], 'classify.js must not import anything')
  assert.ok(!source.includes('@deepseek-ai/'), 'classify.js must not name a kernel module')
  assert.ok(/@module src\/route\//.test(source), 'classify.js must carry its @module docblock')
})

if (failures > 0) console.error(`route-test: ${failures} failure(s)`)
else console.log('route-test: the failure table, the cooldown contract and the advance policy agree')
process.exitCode = failures > 0 ? 1 : 0
