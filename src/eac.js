/**
 * Outbound wire for the co-paid lane.
 *
 * Two lane modes, decided by the credential the sealed store hands over:
 *
 * - `direct` — one bearer credential, straight to the relay.
 * - `worker` — a signing gateway in front of the relay carries the real
 *   credential in its own environment; requests here carry no secret at all,
 *   only an HMAC-SHA256 signature over `timestamp \n METHOD \n path \n
 *   sha256(body)` under the seal's shared signing secret, plus the timestamp
 *   for the gateway's replay window. A seal extracted from this package is
 *   therefore an indirect entry the gateway can revoke (rotate its accepted
 *   secrets), not the credential itself.
 *
 * The credential material arrives per call from `src/vault.js` and lives only
 * inside the call frame that builds the headers; nothing here logs it, caches
 * it, or names it in an error. Every failure is classified into the same
 * harness-neutral codes the free lane uses, with the endpoint and every secret
 * absent from every message.
 *
 * Like the free lane, every request leaves through `egressFetch` — `fetch`
 * unless the user configured an exit proxy, in which case the EAC lane is
 * proxied too.
 *
 * @module src/eac.js
 */

import crypto from 'node:crypto'
import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, readHead, readSse, replayStream, sniffBody } from './http.js'
import { egressFetch } from './proxy.js'

const LISTING_TIMEOUT_MS = 15000
const TURN_TIMEOUT_MS = 300000

/**
 * The signing headers for one gateway request. Exported for the offline suite,
 * which pins the exact wire format the gateway validates.
 *
 * @param {string} signingSecret - shared HMAC key from the seal
 * @param {{ method: string, path: string, body?: string }} parts - uppercase method, URL pathname, raw body ('' when none)
 * @param {number} [now] - wall clock, injectable for tests
 * @returns {{ 'x-ofm-timestamp': string, 'x-ofm-signature': string }}
 */
export function signSealedRequest(signingSecret, { method, path, body = '' }, now = Date.now()) {
  const timestamp = String(Math.trunc(now))
  const bodyHash = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  const mac = crypto.createHmac('sha256', signingSecret)
    .update(`${timestamp}\n${method.toUpperCase()}\n${path}\n${bodyHash}`, 'utf8')
    .digest('hex')
  return { 'x-ofm-timestamp': timestamp, 'x-ofm-signature': mac }
}

/** Wire headers for one request, per lane mode. The signed path is the full
 * URL pathname — exactly what the gateway recomputes from its own request. */
function headersFor(credential, method, fullUrl, body) {
  const headers = {
    'content-type': 'application/json',
    'accept': method === 'POST' ? 'text/event-stream' : 'application/json',
    'user-agent': 'dsh-our-free-model',
  }
  if (credential.mode === 'worker') {
    const path = new URL(fullUrl).pathname
    return { ...headers, ...signSealedRequest(credential.signingSecret, { method, path, body }) }
  }
  return { ...headers, 'authorization': `Bearer ${credential.apiKey}` }
}

/** A proxy in front of the relay answers hard failures with a whole HTML error
 * page — Cloudflare's 524 origin-timeout page being the common one. Pasting it
 * into the harness buries the one useful fact (the status) under markup, so an
 * unparseable body that is HTML reduces to one readable line. */
function errorPageMessage(text, status) {
  const head = String(text ?? '')
  if (/^\s*<(!doctype|html)/i.test(head)) return `the gateway's front proxy answered HTTP ${status} with an HTML error page`
  return head.slice(0, 300) || `HTTP ${status}`
}

/** One listing round: `GET {base}/models`. Returns the parsed JSON document. */
export async function fetchSealedListing(credential, { signal, timeoutMs = LISTING_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  const listingUrl = `${credential.base}/models`
  try {
    const response = await egressFetch(listingUrl, { headers: headersFor(credential, 'GET', listingUrl, ''), redirect: 'error', signal: controller.signal })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: errorPageMessage(text, response.status) } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    return payload
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('model listing timed out', CODE.timeout)
    throw new UpstreamError(`model listing failed: ${error?.message ?? error}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onCallerAbort)
  }
}

/**
 * POST one turn and stream back decoded SSE `data:` payloads.
 *
 * Mirrors the free lane's poster byte-for byte in discipline — body-shape sniff
 * before believing the Content-Type, head replay so no token is buffered — and
 * drops everything the free lane needs that this relay does not: session
 * fingerprints, request ids, the pooled-credential UA.
 */
export async function postSealedStreamed({ credential, body, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  const bodyText = JSON.stringify(body)
  const turnUrl = `${credential.base}/chat/completions`
  let response
  try {
    response = await egressFetch(turnUrl, {
      method: 'POST',
      headers: headersFor(credential, 'POST', turnUrl, bodyText),
      body: bodyText,
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request failed: ${error?.message ?? error}`, CODE.transport)
  }

  // `Retry-After` is seconds on the wire and milliseconds in the classified
  // failure — the free lane's poster converts before classifying, so does this.
  const retrySeconds = Number(response.headers.get('retry-after'))
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: errorPageMessage(text, response.status) } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const head = await readHead(response.body, 4096, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }

  // A relay that answered a stream request with one JSON document: fold the
  // whole answer into a single payload for the reader, as the free lane does.
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
  if (payload.error) throw classifyFailure(response.status, payload)
  onData(JSON.stringify(payload))
  return { status: response.status }
}
