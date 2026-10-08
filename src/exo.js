/**
 * Local exo-free transport. The first payload ID is a routing signal, not a
 * verification of a model's identity. Authorization and tools belong to the
 * caller; this module sends only the existing public gateway fingerprint.
 */
import { directFetch } from './eac.js'
import { CODE, UpstreamError, classifyFailure, transportCause } from './http.js'
import { UPSTREAM_BASE, gatewayHeaders, mintRequestId, truncateSession } from './upstream.js'

const PATH = '/zen/v1/chat/completions'
const MAX_SNIFF_BYTES = 256 * 1024
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_ERROR_BYTES = 16 * 1024

function failure(code, message) {
  return new UpstreamError(`exo-free: ${message}`, code)
}

function aborted() {
  return new UpstreamError('request aborted', CODE.aborted)
}

/**
 * SSE frames may span HTTP chunks, CRLF pairs and UTF-8 characters. Dispatch
 * complete events, joining multiple data lines as required by the SSE format.
 */
class Frames {
  constructor(emit, maxFrameBytes) {
    this.emit = emit
    this.maxFrameBytes = maxFrameBytes
    this.decoder = new TextDecoder()
    this.text = ''
    this.textBytes = 0
    this.frameBytes = 0
    this.data = []
    this.sse = false
    this.stopped = false
  }

  push(bytes, end = false) {
    const text = end ? this.decoder.decode() : this.decoder.decode(bytes, { stream: true })
    this.text += text
    this.textBytes += Buffer.byteLength(text, 'utf8')
    while (!this.stopped) {
      const index = this.text.search(/[\r\n]/)
      if (index < 0) break
      if (!end && this.text[index] === '\r' && index === this.text.length - 1) break
      const line = this.text.slice(0, index)
      const width = this.text.slice(index, index + 2) === '\r\n' ? 2 : 1
      this.text = this.text.slice(index + width)
      const lineBytes = Buffer.byteLength(line, 'utf8') + width
      this.textBytes -= lineBytes
      this.frameBytes += lineBytes
      this.checkSize()
      this.line(line)
    }
    if (!this.stopped) this.checkSize(this.textBytes)
    if (end && !this.stopped) {
      if (this.text !== '') this.line(this.text)
      this.text = ''
      this.textBytes = 0
      this.line('')
    }
  }

  checkSize(pendingBytes = 0) {
    if (this.frameBytes + pendingBytes > this.maxFrameBytes) {
      throw failure('EXO_FRAME_TOO_LARGE', 'SSE frame limit exceeded')
    }
  }

  line(line) {
    if (line === '') {
      const payload = this.data.join('\n')
      this.data = []
      this.frameBytes = 0
      if (payload !== '') this.stopped = this.emit(payload) === false
      return
    }
    if (!this.sse) {
      if (!/^(?::|data(?::|$)|event(?::|$)|id(?::|$)|retry(?::|$))/.test(line)) {
        throw failure('EXO_NON_SSE', 'upstream returned a non-SSE body')
      }
      this.sse = true
    }
    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') this.data.push(value)
    if (field === 'event' && value === 'error') {
      throw failure('EXO_STREAM_ERROR', 'upstream returned a stream error')
    }
  }
}

/**
 * Race every pending operation with an actual watchdog and abort. A transport
 * stub or pending reader can ignore cancellation, so teardown must not await it.
 */
async function bounded(operation, controller, timeoutMs, code, message) {
  if (controller.signal.aborted) throw controller.signal.reason
  let timer
  let onAbort
  const halted = new Promise((_, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => controller.abort(failure(code, message)), timeoutMs)
    timer.unref?.()
  })
  const pending = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw controller.signal.reason
    return operation()
  })
  try {
    return await Promise.race([pending, halted])
  } finally {
    clearTimeout(timer)
    controller.signal.removeEventListener('abort', onAbort)
    pending.catch(() => {})
  }
}

/**
 * POST one authorized turn, buffering payloads until its first nonempty string
 * ID. Only resp_ selections start another HTTP request, at most four total,
 * with a new request ID and the same session. Accepted output is never resent.
 *
 * onData receives the same JSON payload strings as the other lane posters.
 * headerMs/sniffMs/idleMs, maxSniffBytes and maxFrameBytes are test seams.
 * @returns {Promise<{status:number, headers:object}>}
 */
export async function postExoStreamed({
  body, session, requestId, attributionUserAgent, signal, onData, attempts = 4,
  headerMs = 20000, sniffMs = 15000, idleMs = 120000, maxSniffBytes = MAX_SNIFF_BYTES,
  maxFrameBytes = MAX_FRAME_BYTES,
}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 4) {
    throw failure('EXO_INVALID_OPTIONS', 'attempts must be an integer between 1 and 4')
  }
  for (const value of [headerMs, sniffMs, idleMs, maxSniffBytes, maxFrameBytes]) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw failure('EXO_INVALID_OPTIONS', 'timeouts and buffer size must be positive integers')
    }
  }
  if (maxSniffBytes > MAX_SNIFF_BYTES || maxFrameBytes > MAX_FRAME_BYTES || typeof onData !== 'function') {
    throw failure('EXO_INVALID_OPTIONS', 'invalid buffer size or payload callback')
  }
  if (signal?.aborted) throw aborted()
  const bodyText = JSON.stringify({ ...body, model: 'exo-free', stream: true })
  const stableSession = truncateSession(session)

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw aborted()
    const controller = new AbortController()
    const onAbort = () => controller.abort(aborted())
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    let reader
    let accepted = false
    let rejected = false
    let completed = false
    let buffered = []
    try {
      const headers = gatewayHeaders({
        session: stableSession,
        requestId: attempt === 0 ? requestId || mintRequestId() : mintRequestId(),
        stream: true,
      })
      headers['accept-encoding'] = 'identity'
      if (typeof attributionUserAgent === 'string' && attributionUserAgent !== '') {
        headers['user-agent'] = attributionUserAgent.includes('opencode/')
          ? attributionUserAgent : `${attributionUserAgent} ${headers['user-agent']}`
      }
      const response = await bounded(() => directFetch(`${UPSTREAM_BASE}${PATH}`, {
        method: 'POST', headers, body: bodyText, signal: controller.signal,
      }), controller, headerMs, 'EXO_HEADER_TIMEOUT', 'response headers timed out')

      // HTTP refusals are classified as usual and never enter prefix selection.
      if (!response.ok) {
        let text = ''
        try {
          if (response.body) {
            reader = response.body.getReader()
            const decoder = new TextDecoder()
            const deadline = Date.now() + sniffMs
            let size = 0
            while (size < MAX_ERROR_BYTES) {
              if (Date.now() >= deadline) break
              const row = await bounded(() => reader.read(), controller,
                Math.max(1, deadline - Date.now()), 'EXO_SNIFF_TIMEOUT', 'error response timed out')
              if (row.done) break
              if (row.value === undefined) continue
              const bytes = row.value.subarray(0, MAX_ERROR_BYTES - size)
              size += bytes.byteLength
              text += decoder.decode(bytes, { stream: true })
            }
            text += decoder.decode()
          }
        } catch {
          // Status remains authoritative when the error body stalls or breaks.
          if (signal?.aborted) throw aborted()
        }
        let payload
        try { payload = JSON.parse(text) } catch {
          payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } }
        }
        const seconds = Number(response.headers.get('retry-after'))
        const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
        const error = classifyFailure(response.status, payload, retryAfterMs)
        // Zen prefixes the Console provider's error and preserves its status.
        // This exact refusal has appeared as both 402 and 503; neither contains
        // a backend ID, so it cannot be resolved by the resp_ selection loop.
        if ((response.status === 402 || response.status === 503)
          && /^(?:Error from provider \(Console\): )?Upstream request failed: Endpoint is unavailable\.$/.test(error.message)) {
          throw new UpstreamError(
            `exo-free 上游生成端点暂不可用（HTTP ${response.status}），尚未收到后端响应 ID。请稍后重试。上游错误：${error.message}`,
            'EXO_UPSTREAM_UNAVAILABLE', { status: response.status, type: error.type })
        }
        throw error
      }
      if (!response.body) throw failure('EXO_MISSING_ID', 'upstream returned no stream')
      const encoding = response.headers.get('content-encoding')
      if (encoding && String(encoding).toLowerCase() !== 'identity') {
        throw failure('EXO_NON_SSE', 'upstream returned an encoded stream')
      }
      reader = response.body.getReader()
      const deadline = Date.now() + sniffMs
      let size = 0
      const frames = new Frames(payload => {
        if (controller.signal.aborted) throw controller.signal.reason
        if (payload === '[DONE]') {
          if (!accepted) throw failure('EXO_MISSING_ID', 'stream ended before a payload ID')
          completed = true
          return false
        }
        let object
        try { object = JSON.parse(payload) } catch {
          throw failure('EXO_INVALID_SSE', 'stream payload is not valid JSON')
        }
        if (object?.error) throw failure('EXO_STREAM_ERROR', 'upstream returned a stream error')
        if (!accepted) {
          buffered.push(payload)
          if (typeof object?.id !== 'string' || object.id === '') return
          if (object.id.startsWith('resp_')) {
            rejected = true
            return false
          }
          if (!object.id.startsWith('msg_')) {
            throw failure('EXO_BACKEND_UNKNOWN', 'first payload ID has an unknown prefix')
          }
          accepted = true
          for (const held of buffered) {
            if (controller.signal.aborted) throw controller.signal.reason
            onData(held)
          }
          buffered = []
          return
        }
        onData(payload)
      }, maxFrameBytes)

      while (!rejected && !completed) {
        if (!accepted && Date.now() >= deadline) {
          throw failure('EXO_SNIFF_TIMEOUT', 'first payload ID timed out')
        }
        const row = await bounded(() => reader.read(), controller,
          accepted ? idleMs : Math.max(1, deadline - Date.now()),
          accepted ? 'EXO_STREAM_IDLE_TIMEOUT' : 'EXO_SNIFF_TIMEOUT',
          accepted ? 'stream idle timeout' : 'first payload ID timed out')
        if (row.done) {
          frames.push(undefined, true)
          if (!accepted && !rejected) {
            throw failure(frames.sse ? 'EXO_MISSING_ID' : 'EXO_NON_SSE',
              'stream ended before a payload ID')
          }
          break
        }
        if (row.value === undefined) continue
        if (!accepted) {
          if (Date.now() >= deadline) throw failure('EXO_SNIFF_TIMEOUT', 'first payload ID timed out')
          size += row.value.byteLength
          if (size > maxSniffBytes) throw failure('EXO_SNIFF_TOO_LARGE', 'first-ID buffer limit exceeded')
        }
        frames.push(row.value)
      }
      if (controller.signal.aborted) throw controller.signal.reason
      if (!rejected) return { status: response.status, headers: response.headers }
      if (attempt + 1 === attempts) {
        throw failure('EXO_BACKEND_UNAVAILABLE', 'no accepted backend in the allowed attempts')
      }
    } catch (error) {
      if (signal?.aborted) throw aborted()
      if (error instanceof UpstreamError) throw error
      // A broken accepted stream must not feed the harness's retryable codes.
      throw failure(accepted ? 'EXO_STREAM_ERROR' : 'EXO_TRANSPORT',
        `upstream request failed: ${error?.message ?? error}${transportCause(error)}`)
    } finally {
      buffered = []
      controller.abort()
      if (reader) {
        try { void Promise.resolve(reader.cancel()).catch(() => {}) } catch { /* closed */ }
        try { reader.releaseLock() } catch { /* pending read is unwinding */ }
      }
      signal?.removeEventListener('abort', onAbort)
    }
  }
}
