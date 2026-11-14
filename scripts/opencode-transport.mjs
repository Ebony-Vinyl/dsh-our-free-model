/**
 * Bun transport sidecar for the OpenCode free lane (scripts/opencode-transport.mjs).
 *
 * The free lane's upstream distinguishes the *client TLS/HTTP stack*, not only
 * the headers: the same body, session, credential and egress IP answered 200
 * through Bun's `fetch` and 429 FreeUsageLimitError through Node/undici and
 * curl, within the same minute (measured 2026-11-14; 9router issue #65 added
 * the same hop for the same reason). OFM's gateway runs on Node, so its
 * free-lane requests are forwarded through this sidecar — a loopback-only Bun
 * `serve` that re-issues them with Bun's own stack — while every other lane
 * keeps using Node's `egressFetch` directly.
 *
 * Contract (with `src/transport.js`, which spawns this file):
 * - argv[1] is the per-process token; requests without it are refused.
 * - `POST /forward?…` with the `x-ofm-url` header naming the upstream URL
 *   forwards method, headers and body verbatim and relays the upstream status,
 *   headers and (streaming) body back unchanged — `Retry-After` included.
 * - The first stdout line is `{"port":N}`; the parent waits for it before use.
 * - `OPENCODE_TRANSPORT=off` (read by the parent) skips the spawn entirely.
 */

const token = process.argv[2]
if (typeof token !== 'string' || token === '') {
  console.error('[ofm-transport] missing per-process token')
  process.exit(1)
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== '/forward') return new Response('not found', { status: 404 })
    if (request.headers.get('x-ofm-token') !== token) return new Response('forbidden', { status: 403 })
    const target = request.headers.get('x-ofm-url') ?? url.searchParams.get('url')
    if (target === null || target === '') return new Response('missing x-ofm-url', { status: 400 })

    const headers = new Headers(request.headers)
    // The loopback hop's own framing must not reach the upstream: Bun reframes
    // the body, and `host` names the sidecar, not the gateway.
    for (const name of ['x-ofm-token', 'x-ofm-url', 'host', 'content-length']) headers.delete(name)

    let upstream
    try {
      upstream = await fetch(target, { method: request.method, headers, body: request.body, redirect: 'error' })
    } catch (error) {
      return new Response(JSON.stringify({ error: { message: `ofm-transport: upstream fetch failed: ${error?.message ?? error}` } }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(upstream.body, { status: upstream.status, headers: upstream.headers })
  },
})

console.log(JSON.stringify({ port: server.port }))
