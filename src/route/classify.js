/** Classify external failures into retry scope and bounded cooldown policy.
 * @module src/route/classify.js
 */
export const FAILURE_KIND = Object.freeze(Object.fromEntries([
  'invalid_request', 'context_window', 'auth', 'permission', 'billing', 'rate_limit',
  'overloaded', 'timeout', 'upstream', 'unavailable', 'aborted', 'unknown',
].map(name => [name.toUpperCase(), name])))
export const FAILURE_SCOPE = Object.freeze(Object.fromEntries(['request', 'account', 'provider', 'transient'].map(name => [name.toUpperCase(), name])))
export const COOLDOWN_LONG_MS = 120000
export const COOLDOWN_SHORT_MS = 5000
export const TRANSIENT_COOLDOWN_MS = 30000
export const MAX_PROVIDER_COOLDOWN_MS = 1800000
export const BACKOFF_BASE_MS = 2000
export const BACKOFF_MAX_MS = 300000
export const BACKOFF_MAX_LEVEL = 15

export function backoffFor(level) {
  const exponent = Number.isFinite(level) ? Math.min(14, Math.max(0, Math.floor(level) - 1)) : 0
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** exponent)
}

// A negative duration selects exponential backoff; fixed policy is stored once.
function policy(kind, scope, duration, retryable = duration < 0) {
  return { kind, scope, retryable, ...(duration < 0 ? { backoff: true } : { cooldownMs: duration }) }
}
const accountAuth = policy('auth', 'account', COOLDOWN_LONG_MS)
const accountPermission = policy('permission', 'account', COOLDOWN_LONG_MS)
const accountRate = policy('rate_limit', 'account', -1)
const providerCapacity = policy('overloaded', 'provider', -1)
const missingModel = policy('unavailable', 'account', COOLDOWN_LONG_MS)
const transientServer = policy('upstream', 'transient', TRANSIENT_COOLDOWN_MS, true)

const ERROR_RULES = [
  ...[
    ['no credentials', accountAuth],
    ['request not allowed', policy('permission', 'account', COOLDOWN_SHORT_MS)],
    ['improperly formed request', policy('invalid_request', 'account', COOLDOWN_LONG_MS)],
    ['rate limit', accountRate], ['too many requests', accountRate], ['quota exceeded', accountRate],
    ['capacity', providerCapacity], ['overloaded', providerCapacity],
  ].map(([text, rule]) => ({ text, ...rule })),
  ...[
    [401, accountAuth], [402, policy('billing', 'account', COOLDOWN_LONG_MS)],
    [403, accountPermission], [404, missingModel], [429, accountRate],
  ].map(([status, rule]) => ({ status, ...rule })),
]
const CODE_VERDICTS = Object.fromEntries([
  [['aborted'], policy('aborted', 'request', 0)],
  [['timeout'], policy('timeout', 'transient', TRANSIENT_COOLDOWN_MS, true)],
  [['transport'], policy('unavailable', 'transient', TRANSIENT_COOLDOWN_MS, true)],
  [['server', 'stream_cut', 'empty_response'], transientServer],
  [['client_error'], policy('invalid_request', 'request', 0)],
  [['invalid_credential', 'invalid_api_key', 'unauthorized'], accountAuth],
  [['permission_denied', 'forbidden'], accountPermission],
  [['rate_limit'], accountRate],
  [['region_blocked', 'lane_locked'], policy('unavailable', 'provider', 0)],
  [['authorization_required'], policy('auth', 'provider', 0)],
].flatMap(([codes, rule]) => codes.map(code => [code, rule])))
const CONTEXT_WINDOW_CODES = ['context_length_exceeded', 'model_context_window_exceeded']
const CONTEXT_WINDOW_MARKERS = ['context_length_exceeded', 'maximum context length', 'context window exceeded', 'exceeds the context window', 'prompt is too long']
const MARKER_RULES = [
  ['rate_limit', accountRate], ['resourceexhausted', providerCapacity],
  ['resource exhausted', providerCapacity], ['resource_exhausted', providerCapacity],
  ['limit reached', providerCapacity], ['internal_server_error', transientServer],
  ['internal server error', transientServer], ['model_not_found', missingModel],
].map(([marker, rule]) => ({ marker, ...rule }))
const OVERLOAD_STATUSES = [502, 503, 504, 529]

function verdictOf(kind, scope, { retryable = false, cooldownMs = 0, cooldownLevel = 0, rule = 'default' } = {}) {
  return { kind, scope, retryable: retryable === true, cooldownMs, cooldownLevel, rule }
}

function backoffOf(kind, scope, level, rule) {
  const next = Math.min(BACKOFF_MAX_LEVEL, Math.max(0, level) + 1)
  return verdictOf(kind, scope, { retryable: true, cooldownMs: backoffFor(next), cooldownLevel: next, rule })
}

function normalizeLevel(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

function normalizeStatus(value) {
  return Number.isInteger(value) ? value : typeof value === 'string' && /^\d{1,3}$/.test(value.trim()) ? Number(value) : undefined
}

// Error envelopes are external data and can include non-JSON values.
function bodyTextOf(value) {
  if (value == null) return ''
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value)
  try { return JSON.stringify(value) ?? '' } catch { return '' }
}

function failureText(message, body, code) {
  return [bodyTextOf(message), typeof code === 'string' ? code : '', bodyTextOf(body)].filter(Boolean).join(' ').toLowerCase()
}

/** Normalize external error codes once, preserving envelope priority. */
function failureCodes(code, body) {
  while (typeof body === 'string') {
    try { body = JSON.parse(body) } catch { break }
  }
  const candidates = [code]
  if (body !== null && typeof body === 'object') {
    candidates.push(body.code, body.type)
    if (body.error !== null && typeof body.error === 'object' && !Array.isArray(body.error)) candidates.push(body.error.code, body.error.type)
  }
  const codes = new Set()
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.trim()) codes.add(candidate.trim().toLowerCase())
  return [...codes]
}

function contextWindowVerdict(codes, text) {
  if (codes.some(code => CONTEXT_WINDOW_CODES.includes(code)) || CONTEXT_WINDOW_MARKERS.some(marker => text.includes(marker))) {
    return verdictOf('context_window', 'request', { rule: 'context-window' })
  }
  return null
}

// Build stable indexes once; text rules retain their declared priority.
const textRules = ERROR_RULES.filter(rule => rule.text !== undefined)
const statusRules = new Map(ERROR_RULES.filter(rule => rule.status !== undefined).map(rule => [rule.status, rule]))

function selectedVerdict(selected, level, label) {
  if (!selected) return null
  return selected.backoff === true
    ? backoffOf(selected.kind, selected.scope, level, label)
    : verdictOf(selected.kind, selected.scope, { retryable: selected.retryable, cooldownMs: selected.cooldownMs, rule: label })
}

function textRuleVerdict(text, level) {
  for (const rule of textRules) if (text.includes(rule.text)) return selectedVerdict(rule, level, `text:${rule.text}`)
  return null
}

function codeVerdict(codes, level) {
  for (const code of codes) {
    const selected = Object.hasOwn(CODE_VERDICTS, code) ? CODE_VERDICTS[code] : undefined
    if (selected) return selectedVerdict(selected, level, `code:${code}`)
  }
  return null
}

function statusRuleVerdict(status, level) {
  return selectedVerdict(statusRules.get(status), level, `status:${status}`)
}

function markerVerdict(text, level) {
  for (const rule of MARKER_RULES) if (text.includes(rule.marker)) return selectedVerdict(rule, level, `marker:${rule.marker}`)
  return null
}

/** Status fallback applies only after the more specific error rules. */
function statusLayerVerdict(status) {
  const label = `status:${status}`
  if (status === 408 || status === 425 || (status >= 500 && status <= 599)) {
    const kind = status === 408 ? 'timeout' : OVERLOAD_STATUSES.includes(status) ? 'overloaded' : 'upstream'
    return verdictOf(kind, 'transient', { retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS, rule: label })
  }
  return status >= 400 && status < 500 ? verdictOf('invalid_request', 'request', { rule: label }) : null
}

export function cooldownVerdict({ status, message, backoffLevel = 0 } = {}) {
  status = normalizeStatus(status)
  const level = normalizeLevel(backoffLevel)
  const verdict = textRuleVerdict(failureText(message), level) ?? statusRuleVerdict(status, level)
  if (verdict) return { shouldFallback: true, cooldownMs: verdict.cooldownMs, cooldownLevel: verdict.cooldownLevel, matched: verdict.rule }
  const requestError = status >= 400 && status < 500
  return { shouldFallback: !requestError, cooldownMs: requestError ? 0 : TRANSIENT_COOLDOWN_MS, cooldownLevel: 0, matched: requestError ? `request:${status}` : 'transient' }
}

export function classifyFailure({ status, code, message, body, retryAfterMs, backoffLevel = 0 } = {}) {
  status = normalizeStatus(status)
  const level = normalizeLevel(backoffLevel), text = failureText(message, body, code)
  const codes = failureCodes(code, body)
  const verdict = contextWindowVerdict(codes, text)
    ?? textRuleVerdict(text, level) ?? codeVerdict(codes, level)
    ?? statusRuleVerdict(status, level) ?? markerVerdict(text, level)
    ?? statusLayerVerdict(status)
    ?? verdictOf('unknown', 'transient', { retryable: true, cooldownMs: TRANSIENT_COOLDOWN_MS, rule: 'transient' })
  if (Number.isFinite(retryAfterMs) && Math.trunc(retryAfterMs) > 0 && verdict.retryable && verdict.cooldownMs > 0) {
    verdict.cooldownMs = Math.min(Math.trunc(retryAfterMs), MAX_PROVIDER_COOLDOWN_MS)
    verdict.rule += '+provider-reset'
  }
  if (status !== undefined) verdict.status = status
  return verdict
}

export function shouldAdvance(verdict) {
  return verdict !== null && typeof verdict === 'object' && (verdict.retryable === true || verdict.cooldownMs > 0)
}

function humanCooldown(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0s'
  if (ms < 1000) return `${Math.round(ms)}ms`
  let seconds = Math.round(ms / 1000)
  const parts = []
  for (const [unit, divisor] of [['h', 3600], ['m', 60], ['s', 1]]) {
    const amount = Math.floor(seconds / divisor)
    seconds %= divisor
    if (amount || (divisor === 1 && !parts.length)) parts.push(`${amount}${unit}`)
  }
  return parts.join(' ')
}

export function describeVerdict(verdict) {
  if (!verdict || typeof verdict !== 'object') return 'unknown/unknown · no cooldown · via none'
  let text = `${verdict.kind ?? 'unknown'}/${verdict.scope ?? 'unknown'} · `
  text += verdict.cooldownMs > 0 ? `cooldown ${humanCooldown(verdict.cooldownMs)}` : 'no cooldown'
  if (verdict.cooldownLevel > 0) text += ` · backoff level ${verdict.cooldownLevel}`
  if (Number.isInteger(verdict.status)) text += ` · HTTP ${verdict.status}`
  return text + ` · via ${typeof verdict.rule === 'string' && verdict.rule ? verdict.rule : 'none'}`
}
