/**
 * Outbound wire for the LLM7 keyless lane.
 *
 * LLM7 (https://llm7.io) publishes an OpenAI-compatible gateway whose `turbo`
 * slice (`usage_based_only:false`) answers without a real account. Anonymous
 * callers authenticate with the body field `api_key: "unused"`; a token minted
 * at dash.llm7.io raises the per-IP concurrency budget and can be injected via
 * `OUR_FREE_MODEL_LLM7_KEY` instead of the `unused` sentinel. The free pool
 * allows one in-flight request per source IP, so this is a low-volume lane for
 * throwaway work, not secrets.
 *
 * The roster is a static seed (see `src/catalog.js`) of the `turbo` models the
 * gateway listed on 2026-10-30. `minimax-m2.7` is deliberately absent because
 * the upstream advertises `stream:false` for it, which the streaming discipline
 * below cannot honour honestly.
 *
 * @module src/llm7.js
 */

import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, readHead, readSse, replayStream, sniffBody, transportCause } from './http.js'
import { egressFetch } from './egress.js'

const TURN_TIMEOUT_MS = 300000

/** Overridable for the offline suite and the live probes, like the other lanes. */
export const LLM7_BASE = (process.env.OUR_FREE_MODEL_LLM7_BASE ?? 'https://api.llm7.io/v1').replace(/\/+$/, '')
const LLM7_API_KEY = process.env.OUR_FREE_MODEL_LLM7_KEY ?? 'unused'

function llm7Fetch(url, init) {
  return egressFetch(url, init)
}

/**
 * Classify one refusal. LLM7 speaks the stock OpenAI error envelope
 * (`{ error: { message, type, code } }`), so the shared classifier gets the
 * parsed document unchanged.
 */
function classifyRefusal(status, text, retryAfterMs) {
  let payload
  try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${status}` } } }
  return classifyFailure(status, payload, retryAfterMs)
}

/**
 * POST one turn and stream back decoded SSE `data:` payloads.
 *
 * Mirrors the Kilo poster byte-for-byte, except the catalog id's `llm7/` prefix
 * is stripped before the model leaves this machine and the anonymous `api_key`
 * field is folded into the body. The head-bytes discipline is identical: the
 * body is sniffed before its Content-Type is believed, the head is replayed so
 * no token is buffered, and an idle stream dies at `timeoutMs`.
 */
export async function postLlm7Streamed({ body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  const outbound = {
    ...body,
    model: String(body?.model ?? '').replace(/^llm7\//, ''),
    api_key: LLM7_API_KEY,
  }
  const bodyText = JSON.stringify(outbound)
  let response
  try {
    response = await llm7Fetch(`${LLM7_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'dsh-our-free-model' },
      body: bodyText,
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  }

  const retrySeconds = Number(response.headers.get('retry-after'))
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyRefusal(response.status, text, setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, 4096, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }

  // A JSON answer to a streamed request: fold it into one payload for the reader.
  let text = head.text
  if (!head.done) {
    try {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) text += head.decoder.decode(row.value, { stream: true })
      }
    } catch (error) {
      await head.reader.cancel().catch(() => {})
      throw classifyStreamFailure(error, signal)
    }
  }
  text += head.decoder.decode()
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`unexpected non-stream response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload.error) throw classifyRefusal(response.status, text, setRetry)
  onData(JSON.stringify(payload))
  return { status: response.status }
}