import http from 'node:http'
import { Readable } from 'node:stream'

function responseBody(incoming, signal) {
  const reader = Readable.toWeb(incoming).getReader()
  let cleanup = () => {}
  // Keep abort attached until consumption ends, even after the socket closes.
  return new ReadableStream({
    start(controller) {
      const abort = () => {
        controller.error(signal.reason)
        cleanup()
        void reader.cancel(signal.reason).catch(() => {})
      }
      cleanup = () => signal.removeEventListener('abort', abort)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) { controller.close(); cleanup() }
        else controller.enqueue(value)
      } catch (error) { controller.error(error); cleanup() }
    },
    async cancel(reason) { cleanup(); await reader.cancel(reason) },
  }, { highWaterMark: 0 })
}

/** Private engine traffic must not use the host's replaceable fetch or proxy. */
export function loopbackFetch(url, options = {}) {
  const target = new URL(url)
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password) {
    return Promise.reject(new TypeError('Engine transport requires an HTTP loopback URL'))
  }
  const input = new Request(target, { ...options, duplex: 'half' })
  if (input.signal.aborted) return Promise.reject(input.signal.reason)
  return new Promise((resolve, reject) => {
    const headers = Object.fromEntries(input.headers)
    headers['accept-encoding'] = 'identity'
    const outgoing = http.request(target, {
      method: input.method, headers, signal: input.signal, agent: false,
    }, incoming => {
      if (input.redirect === 'error' && [301, 302, 303, 307, 308].includes(incoming.statusCode)) {
        incoming.destroy()
        reject(new TypeError('Engine transport does not follow redirects'))
        return
      }
      const headers = new Headers()
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1])
      }
      const empty = input.method === 'HEAD' || [204, 205, 304].includes(incoming.statusCode)
      if (empty) incoming.resume()
      resolve(new Response(empty ? null : responseBody(incoming, input.signal), {
        status: incoming.statusCode, statusText: incoming.statusMessage, headers,
      }))
    })
    outgoing.once('error', reject)
    if (input.body) {
      const body = Readable.fromWeb(input.body)
      body.once('error', error => outgoing.destroy(error))
      outgoing.once('close', () => body.destroy())
      body.pipe(outgoing)
    } else outgoing.end()
  })
}
