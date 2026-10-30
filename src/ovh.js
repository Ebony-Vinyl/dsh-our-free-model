/**
 * Outbound wire for the OVHcloud AI Endpoints keyless lane.
 *
 * OVHcloud (https://endpoints.ai.cloud.ovh.net) exposes an OpenAI-compatible
 * chat route that answers with no `Authorization` header at all — no key, no
 * account. The cost of that is a hard per-IP rate limit (`x-ratelimit-limit-minute: 2`),
 * so this lane is for a couple of turns a minute, not bulk work. The route must
 * be reached directly; it may not be relayed through another aggregator.
 *
 * The roster is a static seed (see `src/catalog.js`) of the chat models the
 * gateway listed on 2026-10-30. The listing also names embeddings, TTS, image
 * and guard models; those are not chat models, so they are never auto-added —
 * only the seed below reaches the picker.
 *
 * @module src/ovh.js
 */

import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, readHead, readSse, replayStream, sniffBody, transportCause } from './http.js'
import { egressFetch } from './egress.js'

const TURN_TIMEOUT_MS = 300000

/** Overridable for the offline suite and the live probes, like the other lanes. */
export const OVH_BASE = (process.env.OUR_FREE_MODEL_OVH_BASE ?? 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1').replace(/\/+$/, '')

function ovhFetch(url, init) {
  return egressFetch(url, init)
}

/** Classify one refusal. The endpoint speaks the stock OpenAI error envelope. */
function classifyRefusal(status, text, retryAfterMs) {
  let payload
  try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${status}` } } }
  return classifyFailure(status, payload, retryAfterMs)
}

/**
 * POST one turn and stream back decoded SSE `data:` payloads.
 *
 * Same discipline as the Kilo poster. The catalog id's `ovh/` prefix is
 * stripped before the model leaves this machine; no authorization header is
 * ever attached, which is the whole point of this lane.
 */
export async function postOvhStreamed({ body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  const outbound = { ...body, model: String(body?.model ?? '').replace(/^ovh\//, '') }
  const bodyText = JSON.stringify(outbound)
  let response
  try {
    response = await ovhFetch(`${OVH_BASE}/chat/completions`, {
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