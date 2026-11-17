/**
 * LAN relay for the absorbed channels' OpenAI gateway.
 *
 * The vendored channel pack serves every 白嫖 provider through one
 * OpenAI-compatible gateway, but it always binds the loopback — a deliberate
 * upstream choice this plugin keeps. What the settings page promises in
 * exchange is a relay of our own: a second listener, bound wherever the user
 * points it, that forwards to that loopback gateway under *this plugin's* key.
 *
 * The split of keys is the whole security model:
 * - callers authenticate with `settings.chanGateway.relay.key` (this plugin
 *   generates, shows and rotates it);
 * - the pack's gateway key never leaves the host process — it is read from the
 *   gateway's own credential file (or its env override) only to be attached to
 *   the forwarded hop, and is never served to any client of this relay;
 * - a hop marker refuses request loops (a relay pointed at its own port).
 *
 * Path allowlist mirrors what the gateway itself serves; anything else is a
 * 404 before a single byte is forwarded.
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { keyMatches } from './forward.js'

/** Request loop breaker: present on hops this relay already forwarded once. */
const HOP_HEADER = 'x-ofm-chan-relay-hop'

/** Cap for a body this relay will buffer to fold a developer role. */
const RELAY_BODY_LIMIT = 16 * 1024 * 1024

/** The gateway's own surface — nothing else is forwarded. */
const FORWARDED_PATHS = new Set([
  '/v1/models',
  '/v1/chat/completions',
  '/v1/responses',
  '/v1/reasoning-efforts',
])

const corsHeaders = () => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-api-key',
})

/**
 * The chat converter inside the vendored gateway accepts only
 * `system` / `user` / `assistant` / `tool`, and answers anything else with
 * `400 unsupported message role` before a model is ever called. OpenAI defines
 * the system prompt of a reasoning model as the `developer` role, so clients
 * based on the OpenAI SDK send exactly that. The gateway's Responses lane
 * already folds `developer` into `system`; its Chat lane never did.
 *
 * Folding at this door keeps the vendored upstream byte-identical while making
 * every Chat Completions client work. The plugin already treats the two roles
 * as one everywhere else it converts messages (`src/messages.js`,
 * `src/anthropic.js`, `src/token-saver.js`).
 *
 * Returns `{ payload, folded }` when the body changed, or `null` when it must
 * be forwarded untouched: not JSON, no `developer` message, or a shape this
 * fold cannot prove safe to rewrite. A relay that mangles a request is worse
 * than one that lets the upstream error stand.
 */
export function foldDeveloperRole(payload) {
  const buffer = Buffer.isBuffer(payload)
    ? payload
    : typeof payload === 'string' ? Buffer.from(payload, 'utf8') : null
  if (buffer === null) return null
  // Cheap pre-check: a JSON body carrying a developer role either contains the
  // word in the clear or spells part of it with a `\u` escape, so the common
  // case never pays for a parse. Missing it means forwarding untouched,
  // exactly as before this fold existed.
  if (buffer.indexOf('developer') === -1 && buffer.indexOf('\\u') === -1) return null
  let body
  try { body = JSON.parse(buffer.toString('utf8')) } catch { return null }
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) return null
  let folded = 0
  const messages = body.messages.map(message => {
    if (message !== null && typeof message === 'object' && !Array.isArray(message) && message.role === 'developer') {
      folded += 1
      return { ...message, role: 'system' }
    }
    return message
  })
  if (folded === 0) return null
  // Reuse the parsed object so its key order survives; values in every other
  // field are already exactly what the caller sent.
  body.messages = messages
  return { payload: Buffer.from(JSON.stringify(body), 'utf8'), folded }
}

/** Whether this hop must be buffered and rewritten instead of streamed. */
function shouldFoldRequest(method, routePath, headers) {
  if (method !== 'POST' || routePath !== '/v1/chat/completions') return false
  const contentType = String(headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase()
  if (contentType !== 'application/json') return false
  // A compressed body would have to be decoded here to be rewritten; leave
  // those bytes alone rather than forward a corrupt stream.
  const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase()
  return encoding === '' || encoding === 'identity'
}

class RequestBodyTooLargeError extends Error {
  constructor(limit) {
    super(`request body is too large (limit ${limit} bytes)`)
    this.name = 'RequestBodyTooLargeError'
  }
}

/**
 * Read a request body under the same cap the gateway applies to one. The
 * caller still owes the client a response, so this never destroys the socket
 * itself; over-limit bytes are drained and discarded, and the caller answers
 * 413 with `Connection: close`.
 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    req.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > limit) {
        settle(reject, new RequestBodyTooLargeError(limit))
        return
      }
      chunks.push(chunk)
    })
    req.on('error', error => settle(reject, error))
    req.on('end', () => settle(resolve, Buffer.concat(chunks)))
    // A client that disappears mid-upload must not leave this promise pending.
    req.on('close', () => {
      if (!req.complete) settle(reject, new Error('the request body ended before it was complete'))
    })
  })
}

function openAiError(res, status, code, message, extra = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra })
  res.end(JSON.stringify({ error: { message, type: code, code } }))
}

/** Match the vendored resolveChannelPackHome order, without moving OFM's data. */
export function chanGatewayHome({ profileContext, env = process.env } = {}) {
  const override = String(env.DSH_CHANNEL_PACK_STATE_DIR ?? '').trim()
  if (override !== '') return override
  if (typeof profileContext?.home === 'string' && profileContext.home.length > 0) return profileContext.home
  const envHome = String(env.DSH_HOME ?? '').trim()
  return envHome || path.join(homedir(), '.dsh')
}

/**
 * The gateway's API-key env override outranks its credential file. An absent
 * key returns null so the relay fails closed with 503. Explicit home is kept
 * as a test/embedding seam; normal callers pass the current profileContext.
 */
export function chanGatewayCredential({ home, profileContext, env = process.env }) {
  const fromEnv = String(env.DSH_OPENAI_GATEWAY_API_KEY ?? '').trim()
  if (fromEnv !== '') return { key: fromEnv, fromEnv: true, path: null }
  const directory = path.join(home ?? chanGatewayHome({ profileContext, env }), 'openai-gateway')
  const file = path.join(directory, 'api-key')
  try {
    const stored = fs.readFileSync(file, 'utf8').trim()
    if (stored !== '') return { key: stored, fromEnv: false, path: file }
  } catch { /* never generated yet */ }
  return null
}

/** The gateway's port, env-overridable the same way the gateway reads it. */
export function chanGatewayPort(env = process.env) {
  const raw = String(env.DSH_OPENAI_GATEWAY_PORT ?? '').trim()
  if (raw === '') return 8326
  const port = Number.parseInt(raw, 10)
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 8326
}

/**
 * The gateway's own switch. Same normalization rule as the gateway: only an
 * explicit false-y string disables, because `parseInt('0') || 1`-style parses
 * are how switches end up that cannot be turned off.
 */
export function chanGatewayEnabled(env = process.env) {
  const raw = String(env.DSH_OPENAI_GATEWAY_ENABLED ?? '').trim().toLowerCase()
  if (raw === '') return true
  return raw !== '0' && raw !== 'false' && raw !== 'off' && raw !== 'no'
}

/**
 * Bind the relay. `config()` is read per request, so a settings save applies
 * without a rebind (except host/port, which the caller rebinds for).
 * `requestBodyLimit` is a test seam for the 413 path; production callers keep
 * the 16 MiB default.
 */
export async function startChanRelay({ config, log = () => {}, requestBodyLimit = RELAY_BODY_LIMIT }) {
  const bodyLimit = Number.isFinite(requestBodyLimit) && requestBodyLimit > 0
    ? Math.trunc(requestBodyLimit)
    : RELAY_BODY_LIMIT
  const server = http.createServer((req, res) => {
    void relay(req, res).catch(error => {
      log(`relay request failed: ${error?.message ?? error}`)
      if (!res.headersSent) openAiError(res, 502, 'server_error', String(error?.message ?? error))
      else res.end()
    })
  })

  async function relay(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/\/+$/, '') || '/'
    // A browser cannot put a key on a preflight, and answering one spends nothing.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders())
      res.end()
      return
    }
    const settings = config()
    if (!settings.enabled) {
      openAiError(res, 503, 'service_unavailable', 'the channel-gateway relay is switched off in Our Free Model settings')
      return
    }
    if (!keyMatches(bearerOf(req), settings.lanKey)) {
      openAiError(res, 401, 'invalid_request_error', 'missing or invalid relay key')
      return
    }
    if (req.headers[HOP_HEADER] !== undefined) {
      openAiError(res, 508, 'server_error', 'the relay would be dialing itself — give it a port of its own')
      return
    }
    if (!FORWARDED_PATHS.has(routePath)) {
      openAiError(res, 404, 'not_found_error', `no route for ${req.method} ${routePath}`)
      return
    }
    if (typeof settings.gatewayKey !== 'string' || settings.gatewayKey === '') {
      openAiError(res, 503, 'service_unavailable', 'the channel gateway has no credential yet — open it once from the gateway page, then retry')
      return
    }
    const headers = { ...req.headers }
    delete headers.host
    delete headers.connection
    delete headers['x-api-key']
    // The caller's relay key stops at this door; the gateway only ever sees
    // the key that belongs to this machine.
    headers.authorization = `Bearer ${settings.gatewayKey}`
    headers[HOP_HEADER] = '1'

    // The Chat Completions fold (see foldDeveloperRole): only this one route
    // is buffered, and every other request keeps streaming through untouched.
    let buffered = null
    if (shouldFoldRequest(req.method, routePath, req.headers)) {
      try {
        buffered = await readBody(req, bodyLimit)
      } catch (error) {
        // Drain whatever is still arriving so the answer can flush; the
        // `Connection: close` below ends the socket instead of reusing it.
        req.resume()
        if (res.destroyed) {
          return
        }
        if (error instanceof RequestBodyTooLargeError) {
          openAiError(res, 413, 'invalid_request_error', error.message, { connection: 'close' })
        } else {
          openAiError(res, 400, 'invalid_request_error', 'could not read the request body', { connection: 'close' })
        }
        return
      }
      // The buffered length is now known, so framing is stated once, exactly.
      headers['content-length'] = String(buffered.length)
      delete headers['transfer-encoding']
      const folded = foldDeveloperRole(buffered)
      if (folded !== null) {
        buffered = folded.payload
        headers['content-length'] = String(buffered.length)
        log(`folded ${folded.folded} developer message(s) to system role for ${req.method} ${routePath}`)
      }
    }

    const target = http.request({
      host: settings.gatewayHost || '127.0.0.1',
      port: settings.gatewayPort,
      method: req.method,
      path: `${routePath}${url.search}`,
      headers,
    })
    target.on('response', upstream => {
      const relayed = { ...upstream.headers }
      delete relayed.connection
      delete relayed['keep-alive']
      delete relayed['transfer-encoding']
      res.writeHead(upstream.statusCode ?? 502, relayed)
      upstream.pipe(res)
    })
    target.on('error', error => {
      log(`upstream failed: ${error?.message ?? error}`)
      if (!res.headersSent) openAiError(res, 502, 'server_error', 'the channel gateway did not answer (is it enabled?)')
      else res.end()
    })
    // A caller that walks away takes its upstream request with it.
    res.once('close', () => {
      if (!res.writableEnded) target.destroy()
    })
    // A buffered body replaces the stream: it has already been read out of
    // `req`, so piping it again would hang the upstream on an empty body.
    if (buffered !== null) {
      target.end(buffered)
      return
    }
    req.pipe(target)
  }

  function bearerOf(req) {
    const header = String(req.headers.authorization ?? '')
    return header.startsWith('Bearer ') ? header.slice(7).trim() : String(req.headers['x-api-key'] ?? '')
  }

  // The bind comes from the caller's snapshot of the settings: a changed
  // host/port is applied by closing and starting again (see the plugin's
  // sync), while everything else is read per request through `config()`.
  const boot = config()
  const host = String(boot.host ?? '').trim() || '127.0.0.1'
  const wantedPort = Number.isFinite(Number(boot.port)) && Number(boot.port) > 0 ? Math.trunc(Number(boot.port)) : 0
  const address = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(wantedPort, host, () => resolve(server.address()))
  })
  return {
    host: address?.address ?? host,
    port: address?.port ?? 0,
    async close() { await new Promise(resolve => server.close(resolve)) },
  }
}
