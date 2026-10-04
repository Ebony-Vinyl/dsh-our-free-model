/**
 * EAC co-paid lane gateway — Cloudflare Worker (single file, no dependencies).
 *
 * Sits in front of the upstream relay. The plugin ships no relay credential:
 * its sealed store carries THIS gateway's URL plus a shared signing secret,
 * and every request arrives signed —
 *
 *     x-ofm-timestamp:  <unix ms>
 *     x-ofm-signature:  hex(HMAC-SHA256(secret, ts \n METHOD \n path \n sha256(body)))
 *
 * — which this Worker verifies (replay window, constant-time compare, any of
 * the accepted secrets) before forwarding with the real credential, which lives
 * only here, in the Worker's environment. A seal extracted from the plugin is
 * therefore an indirect entry that revoking SIGNING_SECRETS kills instantly,
 * not the relay key.
 *
 * Environment:
 *   UPSTREAM_URL        secret. The relay base, e.g. https://relay.example/v1
 *   UPSTREAM_API_KEY    secret. The relay credential, forwarded as Bearer.
 *   SIGNING_SECRETS     secret. Comma-separated; all are accepted, so rotation
 *                       is: append the new one → deploy → ship a plugin release
 *                       sealed with it → drop the old one → deploy.
 *   MODELS              var (optional). Comma-separated allowlist of model ids
 *                       for /chat/completions; empty accepts everything.
 *   MOUNT_PREFIX        var (optional). Serve under a sub-path of an existing
 *                       site (e.g. "/eac" so the lane sits at /eac/v1/... on a
 *                       domain the relay already uses). The signature always
 *                       covers the FULL pathname the client sent, prefix
 *                       included; the prefix is stripped only for routing and
 *                       forwarding. Empty (default) serves at the root.
 *   CLOCK_SKEW_SECONDS  var (optional). Replay window, default 600.
 *   MAX_BODY_BYTES      var (optional). Request body cap, default 8 MiB.
 *   RATE_LIMITER        optional ratelimit binding; when present, per-IP.
 *
 * Responses never mention the upstream. Logs carry path/status/duration only.
 *
 * Deploy: see worker/README.md (dashboard paste or `wrangler deploy`).
 */

const JSON_ERROR = (status, message) =>
  new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })

const PASS_HEADERS = ['content-type', 'retry-after']

/** The relay must be https — except a loopback relay, which is how the suite
 * (and a self-hosted dev rig) drives this same handler without TLS — and its
 * base must carry the /v1 the route suffixes hang off. A base without /v1
 * would forward /models to the relay's front page and answer HTML for the
 * lane, so it is refused at configure time instead. */
function relayUrl(raw) {
  const cleaned = String(raw ?? '').replace(/\/+$/, '')
  if (!/\/v1$/.test(cleaned)) return null
  const url = new URL(cleaned)
  if (url.protocol === 'https:') return url
  if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return url
  return null
}

function bytesToHex(buffer) {
  const view = new Uint8Array(buffer)
  let out = ''
  for (const byte of view) out += byte.toString(16).padStart(2, '0')
  return out
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const encoder = new TextEncoder()

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(message))
  return bytesToHex(mac)
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(text))
  return bytesToHex(digest)
}

/** The routes the lane actually speaks; everything else is a 404, not a relay. */
const ROUTES = {
  'GET /v1/models': { upstream: '/models', body: false },
  'POST /v1/chat/completions': { upstream: '/chat/completions', body: true },
}

export default {
  async fetch(request, env, ctx) {
    const started = Date.now()
    const url = new URL(request.url)
    // Mount prefix (e.g. "/eac"): the signature covers the full pathname the
    // client signed — prefix included, since that is what new URL(base +
    // '/models').pathname produced on its side — and only routing/forwarding
    // look past the prefix. An empty prefix serves at the root as before.
    const prefix = String(env.MOUNT_PREFIX ?? '').replace(/\/+$/, '')
    let routePath = url.pathname
    if (prefix !== '') {
      if (routePath === prefix) return JSON_ERROR(404, 'not found')
      if (!routePath.startsWith(prefix + '/')) return JSON_ERROR(404, 'not found')
      routePath = routePath.slice(prefix.length)
    }
    const route = ROUTES[`${request.method} ${routePath}`]
    try {
      if (route === undefined) return JSON_ERROR(404, 'not found')

      const skew = Number.parseInt(env.CLOCK_SKEW_SECONDS ?? '600', 10) || 600
      const maxBody = Number.parseInt(env.MAX_BODY_BYTES ?? '8388608', 10) || 8388608
      const body = route.body === true ? await request.text() : ''
      if (body.length > maxBody) return JSON_ERROR(413, 'request body too large')

      const secrets = String(env.SIGNING_SECRETS ?? '').split(',').map(s => s.trim()).filter(s => s.length >= 32)
      if (secrets.length === 0) return JSON_ERROR(500, 'gateway is not configured')

      const timestamp = request.headers.get('x-ofm-timestamp') ?? ''
      const signature = request.headers.get('x-ofm-signature') ?? ''
      const ts = Number.parseInt(timestamp, 10)
      if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > skew * 1000) {
        return JSON_ERROR(401, 'request signature rejected')
      }
      const expectedMessage = `${timestamp}\n${request.method}\n${url.pathname}\n${await sha256Hex(body)}`
      let admitted = false
      for (const secret of secrets) {
        if (timingSafeEqual(signature, await hmacHex(secret, expectedMessage))) { admitted = true; break }
      }
      if (!admitted) return JSON_ERROR(401, 'request signature rejected')

      if (route.body === true && String(env.MODELS ?? '').trim() !== '') {
        const allowed = String(env.MODELS).split(',').map(s => s.trim()).filter(Boolean)
        let requested = ''
        try { requested = String(JSON.parse(body).model ?? '') } catch { /* a malformed body is the caller's error downstream */ }
        if (!allowed.includes(requested)) return JSON_ERROR(403, 'model is not available on this lane')
      }

      if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === 'function') {
        const ip = request.headers.get('cf-connecting-ip') ?? 'unknown'
        const verdict = await env.RATE_LIMITER.limit({ key: ip })
        if (verdict.success === false) return JSON_ERROR(429, 'too many requests; retry later')
      }

      // Validate the relay BASE (it must end in /v1 — a base without it would
      // forward /models into the relay's front page and answer HTML for the
      // lane), then append the route suffix onto the validated base. Appending
      // first and validating the result would be wrong: /v1/models never ends
      // in /v1.
      const base = relayUrl(String(env.UPSTREAM_URL ?? ''))
      if (base === null) return JSON_ERROR(500, 'gateway is not configured')
      const upstream = new URL(base.origin + base.pathname.replace(/\/+$/, '') + route.upstream)
      // A reasoning model can hold the relay's first byte for minutes, and a
      // proxy in front of this gateway (Cloudflare's ~100s origin timeout,
      // nginx's 60s default) would kill the lane before the answer starts.
      // The self-hosted host implements this hook by flushing an SSE head plus
      // keepalive comments the moment admission passes, so the response has
      // already begun while the upstream thinks; the Worker host cannot flush
      // early and leaves the hook unset. Chat turns only — listings are fast.
      if (route.body === true) ctx?.onUpstreamPending?.()
      const relayed = await fetch(upstream, {
        method: request.method,
        headers: {
          'content-type': 'application/json',
          'accept': request.headers.get('accept') ?? (route.body === true ? 'text/event-stream' : 'application/json'),
          'authorization': `Bearer ${env.UPSTREAM_API_KEY ?? ''}`,
          'user-agent': 'dsh-our-free-model-gateway',
        },
        body: route.body === true ? body : undefined,
      })
      const headers = new Headers({ 'cache-control': 'no-store' })
      for (const name of PASS_HEADERS) {
        const value = relayed.headers.get(name)
        if (value !== null) headers.set(name, value)
      }
      console.log(JSON.stringify({ lane: 'eac', path: url.pathname, status: relayed.status, ms: Date.now() - started }))
      return new Response(relayed.body, { status: relayed.status, headers })
    } catch (error) {
      console.log(JSON.stringify({ lane: 'eac', path: url.pathname, status: 500, ms: Date.now() - started, fault: String(error?.message ?? error).slice(0, 120) }))
      return JSON_ERROR(500, 'gateway request failed')
    }
  },
}
