/**
 * The 白嫖 channel lane: the absorbed pack's loopback OpenAI gateway as a
 * routing destination.
 *
 * The vendored channel pack already serves its account channels under its own
 * provider routes, so this module deliberately adds no second public route to
 * those accounts: every row it builds carries the `chan:` prefix and exists
 * only inside the plugin's own catalog, where a fallback chain can reference
 * it. `computeMembership` keeps those ids out of the harness's picker, and the
 * gateway's credential never leaves the host process.
 *
 * The hop is loopback, so it rides `directFetch` (node:http) rather than the
 * egress outlet: a user-configured exit must not carry traffic to 127.0.0.1,
 * and a wrapped global fetch must not see the gateway credential. The gateway
 * itself owns provider routing, reasoning-effort normalization and the
 * `max_tokens` clamp; this lane only addresses a model and streams its SSE
 * frames through untouched.
 *
 * @module src/chan-lane.js
 */

import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, readHead, readSse, replayStream, sniffBody, transportCause } from './http.js'
import { directFetch } from './eac.js'
import { chatFrames } from './aggregate.js'

/** The channel tag every row from this lane carries, like EAC/Kilo/aggregate rows. */
export const CHANNEL_LANE = 'chan'
/** The prefix that keeps gateway rows out of the pack's own provider routes. */
export const CHANNEL_PREFIX = 'chan:'

/**
 * The provider keys the absorbed pack registers (the `modelAdapters` map of
 * `vendor/channel-pack/src/index.ts`). The gateway's listing is a view of the
 * whole kernel — it also names other plugins' providers and this plugin's own
 * free lane — so the lane must keep only the pack's rows: anything else is
 * either somebody else's route advertised a second time, or a `chan:` id that
 * would loop a chain back into this plugin.
 *
 * `opencode` is deliberately absent: the plugin mounts the pack with
 * `disableOpencode`, so its adapter is never registered here.
 */
export const CHANNEL_PACK_PROVIDERS = Object.freeze([
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae',
  'cline', 'loomy', 'raccoon', 'minimax', 'gemini', 'zcode',
])
const CHANNEL_PACK_PROVIDER_SET = new Set(CHANNEL_PACK_PROVIDERS)

const GATEWAY_HOST = '127.0.0.1'
const LISTING_TIMEOUT_MS = 8000
const TURN_TIMEOUT_MS = 300000
const SNIFF_BYTES = 4096
const DEFAULT_CONTEXT_WINDOW = 131072
const DEFAULT_MAX_OUTPUT = 32768

/** `provider/model` -> `chan:provider/model`. */
export function channelCatalogId(provider, model) {
  return `${CHANNEL_PREFIX}${provider}/${model}`
}

/** Split one `provider/model` wire id; the provider key ends at the first `/`. */
function splitRoute(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

/**
 * `chan:provider/model` -> `{ providerId, modelId }`, or null when the id is
 * not one this lane can dial.
 *
 * The split is on the FIRST `/`, the same rule the gateway's own
 * `parseModelRoute` uses — model names are allowed to contain slashes
 * (`cline/anthropic/claude-sonnet-5.5`), so the provider key is only ever the
 * segment before the first one.
 */
export function parseChannelCatalogId(id) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value.startsWith(CHANNEL_PREFIX)) return null
  return splitRoute(value.slice(CHANNEL_PREFIX.length))
}

/** A trimmed non-empty string, or ''. */
function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

/** A positive finite number, or undefined — the catalog's own reading of one.
 *  A fraction below one truncates to zero, which is not a capacity: leave it
 *  undefined so the lane's fallback capacity applies instead of a zero one. */
function number(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const whole = Math.trunc(value)
  return whole > 0 ? whole : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * One gateway listing row -> one catalog row, or null when the row names no
 * dialable id.
 *
 * `reasoning` is true for every row: the entry's flag only decides whether the
 * free lane's token-budget ladder applies, and the gateway normalizes any
 * `reasoning_effort` itself. No declared effort menu travels with the row —
 * the plugin must not patch this lane's body with an effort field the gateway
 * would rather translate from the caller's own spelling.
 */
function entryOf(row) {
  if (!isRecord(row)) return null
  const wireId = text(row.id)
  const route = wireId === '' ? null : splitRoute(wireId)
  if (route === null) return null
  const contextWindow = number(row.context_window) ?? DEFAULT_CONTEXT_WINDOW
  return {
    id: channelCatalogId(route.providerId, route.modelId),
    name: text(row.name) || route.modelId,
    channel: CHANNEL_LANE,
    providerId: route.providerId,
    modelId: route.modelId,
    wire: 'chat',
    vision: Array.isArray(row.input) && row.input.includes('image'),
    reasoning: true,
    contextWindow,
    maxOutput: Math.min(number(row.max_tokens) ?? DEFAULT_MAX_OUTPUT, contextWindow),
    source: 'gateway',
  }
}

/**
 * Build the lane's catalog rows from one gateway listing (`GET /v1/models`).
 * Only the pack's own providers pass (see `CHANNEL_PACK_PROVIDERS`); a row
 * that does not name a `provider/model` id is skipped, and a repeated id
 * keeps its first row — the same discipline `buildKiloCatalog` applies.
 */
export function buildChannelCatalog(rows) {
  const seen = new Set()
  const entries = []
  for (const row of Array.isArray(rows) ? rows : []) {
    const entry = entryOf(row)
    if (entry === null || !CHANNEL_PACK_PROVIDER_SET.has(entry.providerId) || seen.has(entry.id)) continue
    seen.add(entry.id)
    entries.push(entry)
  }
  return entries
}

/** Is this catalog row from the 白嫖 channel lane? */
export function isChannelEntry(entry) {
  return entry?.channel === CHANNEL_LANE
}

/**
 * One listing round: `GET http://127.0.0.1:<port>/v1/models` under the
 * gateway's own key. Returns the listing's `data` rows; throws on non-200.
 */
export async function fetchChannelListing({ port, key, signal, timeoutMs = LISTING_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await directFetch(`http://${GATEWAY_HOST}:${port}/v1/models`, {
      headers: { accept: 'application/json', authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    const body = await response.text()
    let payload
    try { payload = JSON.parse(body) } catch { payload = { error: { message: text(body).slice(0, 300) || `HTTP ${response.status}` } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    if (!Array.isArray(payload?.data)) {
      throw new UpstreamError('the channel gateway listing was not an OpenAI model list', CODE.server, { status: response.status })
    }
    return payload.data
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('the channel gateway listing timed out', CODE.timeout)
    throw new UpstreamError(`channel gateway listing failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}

/**
 * POST one streaming chat turn to the gateway and push raw SSE `data:`
 * payloads to `onData`. Resolves when the stream ends.
 *
 * Mirrors `postAggregateStreamed`'s contract: the body is posted as given —
 * except that `model` is rewritten to the bare `<providerId>/<modelId>` the
 * gateway routes on and `stream:true` is forced, because a caller that forgot
 * the flag would collect the gateway's whole-answer JSON instead of frames —
 * the response's shape, not its Content-Type, decides how it is read, and the
 * caller's signal is the only deadline owner besides the shared readers' idle
 * budget. The gateway already speaks the chat wire, so its frames pass through
 * untouched.
 *
 * @param {object} options
 * @param {number} options.port - the gateway's loopback port
 * @param {string} options.key - the gateway's own credential (never echoed)
 * @param {string} options.providerId - the row's provider key
 * @param {string} options.modelId - the provider-internal model name
 * @param {object|string} options.body - the request body the caller built
 * @param {AbortSignal} [options.signal]
 * @param {(payload: string) => void} options.onData - one `data:` payload, in order
 * @param {number} [options.timeoutMs] - idle budget handed to the shared readers
 * @returns {Promise<{status:number}>}
 */
export async function postChannelStreamed({ port, key, providerId, modelId, body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  const request = typeof body === 'string' ? JSON.parse(body) : { ...body }
  request.model = `${providerId}/${modelId}`
  request.stream = true
  const bodyText = JSON.stringify(request)
  let response
  try {
    response = await directFetch(`http://${GATEWAY_HOST}:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${key}` },
      body: bodyText,
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request to the channel gateway failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  }

  const retrySeconds = Number(response.headers.get('retry-after'))
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const refusal = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(refusal) } catch { payload = { error: { message: text(refusal).slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, SNIFF_BYTES, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    // Raw payloads, straight through: the wire's own decoder reads them, so
    // nothing is rewritten between the gateway and the harness.
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }

  // A gateway that answered a stream request with one JSON document: fold the
  // whole answer in and emit the frames a chat-wire decoder reads. Handing the
  // document itself to the reader would leave `choices[0].message` unread —
  // the decoder only consumes `choices[0].delta` — and the turn would finish
  // with zero visible text.
  let rawText = head.text
  if (!head.done) {
    try {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) rawText += head.decoder.decode(row.value, { stream: true })
      }
    } catch (error) {
      await head.reader.cancel().catch(() => {})
      throw classifyStreamFailure(error, signal)
    }
  }
  rawText += head.decoder.decode()
  let payload
  try { payload = JSON.parse(rawText) } catch {
    throw new UpstreamError(`unexpected non-stream response: ${text(rawText).slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload?.error !== undefined || payload?.type === 'error') throw classifyFailure(response.status, payload, setRetry)
  for (const frame of chatFrames(payload, request.model)) onData(frame)
  return { status: response.status }
}
