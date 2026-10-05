/**
 * The lane's own egress: one switchable outlet every upstream request walks out
 * through.
 *
 * Three call sites make the requests the region gate and the per-IP pools see —
 * `postStreamed` and `getJson` in src/http.js, `detectEgress` in src/probe.js —
 * and all three used to be a bare `fetch`. This module keeps them on `fetch`
 * and moves the routing underneath: with an outlet configured, `egressFetch`
 * rewrites the call to a loopback relay it owns, and the relay opens the real
 * connection through the outlet. The call sites keep their bodies, headers,
 * signals and `redirect: 'error'` policy verbatim, so a proxied turn and a
 * direct one differ in exactly one thing: which socket leaves this machine.
 *
 * Two outlet shapes, one dialer:
 *
 *   - `client`   — an http/https/socks5 proxy address that already exists (the
 *                  user's own client, a LAN gateway). The plugin dials it.
 *   - `subscription` — the plugin spawns mihomo (Clash Verge's core, or any
 *                  mihomo/clash binary found on the machine) with a
 *                  proxy-provider pointing at the subscription URL and a
 *                  url-test group that re-measures every node every five
 *                  minutes. The lowest-latency node wins, a 429 in the
 *                  health-check marks the node dead and takes it out of the
 *                  rotation, and the plugin only ever dials the local mixed
 *                  port — it never parses a vless/vmess/trojan URI itself.
 *
 * Why spawn rather than embed: the light route (parse `http(s)/socks5` entries
 * and dial them in-process) cannot express a vless-REALITY subscription at all,
 * and a 108-byte PROXY-style trick cannot either — the protocol work belongs to
 * a purpose-built binary that already does health scoring and group selection.
 * The plugin's job is the seam: config in, local port out, `egressFetch`
 * unchanged between modes.
 *
 * What happens when the outlet itself misbehaves is the other half of the job,
 * and it is a ladder, cheapest rung first. A request that goes through the relay
 * and never reaches response headers is a *strike*: the host hears about every
 * one of them so it can step off the node that just failed, and a fault-marked
 * failure is replayed once over the direct path — a tunnel that never opened
 * cost the gateway nothing, so the replay spends no quota and the turn gets an
 * answer instead of a 502. Three strikes in a row bench the outlet: requests
 * leave direct from then on, and the first answer that comes back through the
 * relay ends the bench. Nothing here covers a response body that dies
 * mid-stream — the adapter already calls that a `STREAM_CUT`, and the retry it
 * leads to is what lands the next strike.
 *
 * Security notes that the settings route relies on:
 *
 *   - The relay binds `127.0.0.1` on an ephemeral port and is deliberately not
 *     an open proxy: every start mints a random key, `egressFetch` presents it,
 *     and any other caller — a neighbouring local process, a rebound page — is
 *     refused before a single dial. A keyed caller still needs an absolute
 *     http(s) target, and nothing else in the process rewrites.
 *   - The managed mihomo's mixed port is passworded (`authentication`) with a
 *     per-start credential the plugin is the only holder of, so the outlet
 *     cannot be borrowed by another process on this machine.
 *   - The subscription URL is a bearer credential: it is written to the mihomo
 *     config file (mode 0600-ish, inside the plugin's own data dir), never
 *     logged, and surfaced to the settings page as a hostname only.
 *   - `mihomoPath` comes from local settings, which the trust fence already
 *     gates the same way it gates every other write; there is no download step
 *     anywhere in this file.
 */
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import http from 'node:http'
import path from 'node:path'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { spawn } from 'node:child_process'

/** The loopback address the relay listens on. Never a routable one. */
const RELAY_HOST = '127.0.0.1'
/** Carries the absolute target URL from `egressFetch` to the relay. */
const TARGET_HEADER = 'x-ofm-egress-target'
/** Carries this start's relay key. Every listen mints one, `egressFetch` is the
 *  only thing that learns it, and a request without it is not the plugin — it
 *  is refused before a single dial, so the loopback port is nobody's open
 *  proxy. Never forwarded upstream: the relay strips it like the target. */
const KEY_HEADER = 'x-ofm-egress-key'
/** One dial (connect, CONNECT response, socks5 handshake, TLS) gets this long. */
const DIAL_TIMEOUT_MS = 10_000
/** A freshly spawned mihomo gets this long to open its mixed port. */
const READY_TIMEOUT_MS = 15_000
/** Schemes a `client` outlet may speak. The subscription path needs none: it
 *  always dials the local mixed port over plain http. */
const CLIENT_SCHEMES = new Set(['http:', 'https:', 'socks5:', 'socks5h:'])
/** Hop-by-hop headers never forwarded across the relay boundary, either
 *  direction. `transfer-encoding` is dropped too: Node re-derives framing from
 *  the stream it is handed, and forwarding a foreign `chunked` marker would
 *  double-frame it. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection'])
/** Marks the relay's own answer to a request the outlet never carried. Only the
 *  relay writes it, and it never survives a real upstream hop: an upstream 502
 *  comes back verbatim, with no marker, because the outlet did carry it. */
const FAULT_HEADER = 'x-ofm-egress-fault'
/** Requests that die before their headers, in a row, before the outlet is
 *  benched. The first strike already asks the host for another node; this is the
 *  point at which betting on the outlet at all stops being worth the wait. */
const LANE_STRIKES = 3
/** The first bench, and the cap its doubling settles under. A benched outlet is
 *  re-tried on the next request after the window, so the cap is also the worst
 *  case delay before a repaired exit is used again. */
const LANE_BYPASS_MS = 60_000
const LANE_BYPASS_MAX_MS = 10 * 60_000
/** The marked failures that mean the gateway never saw the request, so re-sending
 *  it from this machine cannot serve anything twice. `sent` is marked apart from
 *  these for exactly that reason. */
const PRE_SEND_FAULTS = new Set(['tunnel', 'no-outlet'])

/**
 * The live relay, owned by whichever generation started it. Module-level on
 * purpose: `egressFetch` is imported by src/http.js and src/probe.js, which
 * have no handle on the index fiber, and a hot reload swaps this whole module
 * while the old relay's disposer tears the old one down.
 */
let activeRelay = null

/** True when requests will be rewritten onto the relay instead of going out direct. */
export function egressActive() {
  return activeRelay !== null
}

/**
 * `fetch`, through the outlet when one is running and straight out when not.
 *
 * The rewrite is deliberately boring: same method, same body, same signal, plus
 * the target and this start's key in headers, and the path replaced by the
 * origin-form the loopback relay serves. Call sites keep `redirect: 'error'` in
 * `init`, so a 3xx is a response, never a second hop that would dodge the outlet.
 *
 * Two failures land here and they are not the same thing:
 *
 *   - `fetch` rejects: the relay itself is unreachable. Counted as a strike
 *     (the local listener is the outlet's own front door) and rethrown.
 *   - The relay answers its own fault-marked 502: the outlet did not carry the
 *     request. Counted, and then replayed once over the direct path — but only
 *     for the faults that mean the gateway never saw the request, so that a turn
 *     which would otherwise die on a dead exit gets an answer from this
 *     machine's own address without anything being served twice.
 *
 * …and a third that deliberately gets none of that: an outlet that answered the
 * CONNECT with an authority verdict (401/403/407) is misconfigured, not unlucky,
 * and failing over from it would be the plugin deciding on its own to send the
 * owner's traffic out of the address they built the outlet to avoid.
 */
export async function egressFetch(url, init) {
  const relay = activeRelay
  if (relay === null) return fetch(url, init)
  const target = new URL(String(url))
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`the egress relay only carries http(s) targets, got "${target.protocol}"`)
  }
  // Benched: the outlet has not been carrying traffic, so it is not asked again
  // until its window closes. Without this every turn would pay a dial timeout
  // first, which is the "不切换直连" the caller can actually feel.
  if (laneBenched(relay)) {
    relay.faults.direct += 1
    return fetch(url, init)
  }
  const headers = new Headers(init?.headers ?? {})
  headers.set(TARGET_HEADER, target.href)
  headers.set(KEY_HEADER, relay.key)
  let response
  try {
    response = await fetch(`http://${RELAY_HOST}:${relay.port}${target.pathname}${target.search}`, { ...init, headers })
  } catch (error) {
    laneFault(relay, error, init)
    throw error
  }
  const fault = response.headers.get(FAULT_HEADER)
  if (fault === null) {
    laneHealthy(relay)
    return response
  }
  // The outlet refused us on its own terms — a credential it demands and this
  // plugin does not hold. No strike, no other node, no direct replay: the config
  // is wrong, and quietly routing the owner's traffic out of the address they
  // configured it to avoid would be a worse answer than the 502. The failure
  // reaches the caller, which is where a misconfiguration belongs.
  if (fault === 'refused') return response
  laneFault(relay, new Error(`the outlet did not carry the request (${fault})`), init)
  // Everything is counted as a strike — a node that eats the request and then
  // dies is exactly the exit this ladder exists for — but only a failure that
  // landed before the request was handed to the tunnel is re-sent: once it had
  // been written out, the gateway may have served it, and the free lane charging
  // for one turn twice is worse than the 502 the caller is handed instead.
  if (!PRE_SEND_FAULTS.has(fault) || !replayable(init?.body)) return response
  // The answer being thrown away is this relay's own local stub, with a tunnel
  // socket already destroyed behind it. Nothing is owed to it, and leaving the
  // body unread would keep its connection counted until the process wanted it
  // back.
  void response.body?.cancel?.().catch(() => {})
  relay.faults.direct += 1
  relay.log(`egress lane: the outlet did not carry this request (${fault}); replaying it direct`)
  return fetch(url, init)
}

/**
 * Whether a second attempt can re-send this body verbatim. A stream was already
 * consumed by the first attempt, and half of it would be worse than the failure
 * it is meant to paper over; every string, buffer and absent body replays.
 */
function replayable(body) {
  return body === undefined || body === null
    || typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array
}

/** True while the outlet is sitting out and requests leave direct instead. */
function laneBenched(relay) {
  return relay.faults.benchUntil > Date.now()
}

/**
 * A response through the relay — any status, an upstream 5xx included — proves
 * the outlet carried the request, which clears the whole ladder: the strikes,
 * the bench and the doubling. Only a real state change is worth a log line. An
 * upstream 502 has no fault marker, so it lands here rather than in the ladder:
 * the outlet did its job and the gateway refused.
 */
function laneHealthy(relay) {
  const faults = relay.faults
  const recovering = faults.open === true
  if (!recovering && faults.strikes === 0) return
  faults.strikes = 0
  faults.open = false
  faults.benched = 0
  faults.benchUntil = 0
  faults.direct = 0
  faults.reason = ''
  faults.at = Date.now()
  if (!recovering) return
  relay.log('egress lane: the outlet answers again; back on the relay')
  relay.onLane?.({ ...egressLaneOf(relay), transition: 'relay' })
}

/**
 * One request that never got an answer through the outlet.
 *
 * The host hears about every strike — one bad node is worth stepping off long
 * before the outlet as a whole is written off — and the bench opens once they
 * pile up. A bench already open is reopened by the very next failure: the
 * request that was let back in *is* the probe, and a probe that fails is an
 * answer. The window doubles on each reopen, so an outlet that stays dead is
 * re-tried at a settling rate instead of on every turn, and a repaired one is
 * picked up within the cap.
 */
function laneFault(relay, error, init) {
  // A caller that walked away learned nothing about the outlet. The harness
  // aborts turns routinely, and not one of those aborts says the exit is down.
  if (init?.signal?.aborted === true || error?.name === 'AbortError') return
  const faults = relay.faults
  faults.strikes += 1
  faults.reason = String(error?.message ?? error)
  faults.at = Date.now()
  try {
    relay.onFault?.(error)
  } catch { /* a diagnostics callback cannot reroute a request */ }
  if (faults.open === false && faults.strikes < relay.policy.strikes) return
  faults.open = true
  faults.benched += 1
  faults.strikes = 0
  const window = Math.min(relay.policy.bypassMs * 2 ** (faults.benched - 1), relay.policy.bypassMaxMs)
  faults.benchUntil = Date.now() + window
  relay.log(`egress lane: ${faults.reason}; going direct for ${Math.round(window / 1000)}s`)
  relay.onLane?.({ ...egressLaneOf(relay), transition: 'bench' })
}

/**
 * Which path requests are on right now.
 *
 * `relay` while the outlet carries them, `strained` after a strike or two,
 * `direct` while it is benched, `probing` on the request that is allowed back in
 * to test it, and `off` when nothing is running. The bench is the same reading
 * the settings page shows, so the panel never claims the outlet is carrying
 * traffic while it is not.
 */
export function egressLane() {
  return egressLaneOf(activeRelay)
}

function egressLaneOf(relay) {
  if (relay === null) {
    return { state: 'off', strikes: 0, benched: 0, benchUntil: 0, direct: 0, reason: '', at: 0 }
  }
  const faults = relay.faults
  return {
    state: laneBenched(relay) ? 'direct' : faults.open ? 'probing' : faults.strikes > 0 ? 'strained' : 'relay',
    strikes: faults.strikes,
    benched: faults.benched,
    benchUntil: faults.benchUntil,
    direct: faults.direct,
    reason: faults.reason,
    at: faults.at,
  }
}

/**
 * Start the relay for the current settings; throws with a message the settings
 * page can show when the configuration cannot run.
 *
 * Mirrors `startForwardServer`'s contract: the caller (`syncEgress`) owns the
 * idempotence — close the old one first — and this function only builds the
 * new one or fails.
 */
export async function startEgressRelay({ config, dataDir, log = () => {}, onDead, onFault, onLane, policy }) {
  const cfg = { mode: 'subscription', url: '', mihomoPath: '', ...config() }
  const mode = cfg.mode === 'client' ? 'client' : 'subscription'
  const url = String(cfg.url ?? '').trim()
  if (url === '') throw new Error('the egress outlet is enabled but empty — paste a proxy address or a subscription link')
  // Minted per start, not per process: a key that leaked from a previous relay
  // must not open this one. Lives in the handle only, and is never written down.
  const key = randomBytes(16).toString('hex')
  let child = null
  let managed = null
  let outlet
  if (mode === 'client') {
    const parsed = new URL(url)
    if (!CLIENT_SCHEMES.has(parsed.protocol)) {
      throw new Error(`unsupported proxy scheme "${parsed.protocol}" — use http, https, socks5 or socks5h`)
    }
    outlet = { kind: 'url', url: parsed }
  } else {
    const binary = findMihomoBinary(cfg.mihomoPath)
    const dir = path.join(dataDir, 'egress')
    fs.mkdirSync(dir, { recursive: true })
    const mixedPort = await freePort()
    const apiPort = await freePort()
    const secret = randomBytes(16).toString('hex')
    // The mixed port is passworded for the same reason the relay is keyed: an
    // outlet any local process can borrow is an outlet that will be borrowed.
    // Only this module's dialer ever learns this credential — it rides in the
    // outlet URL below, never in the rendered config the user can read.
    const outletAuth = `ofm:${randomBytes(12).toString('hex')}`
    const configPath = path.join(dir, 'mihomo.yaml')
    fs.writeFileSync(configPath, renderMihomoConfig({
      subscription: url,
      mixedPort,
      apiPort,
      secret,
      auth: outletAuth,
      logFile: path.join(dir, 'mihomo.log'),
    }), { mode: 0o600 })
    child = spawn(binary, ['-d', dir, '-f', configPath], { windowsHide: true, stdio: 'ignore' })
    let spawnError = null
    let exited = null
    child.on('error', error => { spawnError = error })
    child.on('exit', (code, signal) => { if (exited === null && spawnError === null) exited = `mihomo exited (${signal ?? code})` })
    // The provider URL is fetched by mihomo itself on startup, so readiness is
    // "the mixed port answers", not "the subscription parsed" — a bad link
    // still opens the port and then reports zero nodes through the API, which
    // the first health-check surfaces as a dead group rather than a hang here.
    try {
      await waitForPort(RELAY_HOST, mixedPort, READY_TIMEOUT_MS, () => {
        if (spawnError !== null) throw new Error(`mihomo could not start (${spawnError.message})`)
        if (exited !== null) throw new Error(`${exited} — see ${path.join(dir, 'mihomo.log')}`)
      })
    } catch (error) {
      // Nothing owns this child yet — the handle that would kill it is not built
      // until the listener is up — so a start that fails here has to reap it
      // itself, or a wedged mihomo outlives the attempt holding the mixed port.
      await killChild(child)
      throw error
    }
    log(`managed mihomo on ${RELAY_HOST}:${mixedPort} (controller ${RELAY_HOST}:${apiPort})`)
    outlet = { kind: 'url', url: new URL(`http://${outletAuth}@${RELAY_HOST}:${mixedPort}`) }
    managed = { mixedPort, apiPort, secret, dir }
  }

  const sockets = new Set()
  const server = http.createServer(relayRequest)
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, RELAY_HOST, () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    // The listener is what turns `child` into an owned handle; without it the
    // started mihomo would outlive the failed start holding its ports.
    await killChild(child)
    throw error
  }
  const port = server.address().port
  const handle = {
    port,
    key,
    mode,
    url,
    outlet,
    managed,
    child,
    log,
    /** Set when the managed child dies after startup; the settings page shows it. */
    dead: '',
    /**
     * The outlet's own health, as seen from the requests it actually carried:
     * consecutive failures that never reached response headers, how many times
     * that has benched it, until when requests are going direct, and how many
     * took that path. Cleared wholesale by the first answer that comes back
     * through the relay (see `laneHealthy`).
     */
    faults: { strikes: 0, open: false, benched: 0, benchUntil: 0, direct: 0, reason: '', at: 0 },
    /** The ladder's thresholds. The host may tune them; the defaults are the policy. */
    policy: { strikes: LANE_STRIKES, bypassMs: LANE_BYPASS_MS, bypassMaxMs: LANE_BYPASS_MAX_MS, ...policy },
    /** Told about every strike, so the host can step off the failing node. */
    onFault,
    /** Told when the lane changes path, so the exit reading follows it. */
    onLane,
    close: async () => {
      if (activeRelay === handle) activeRelay = null
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      await killChild(child)
    },
  }
  if (child !== null) {
    child.on('exit', () => {
      handle.dead = 'the managed mihomo process exited'
      log(`${handle.dead}; a restart has been scheduled`)
      // A dead managed mihomo otherwise stays dead until the user touches the
      // settings page: every upstream request would hard-fail through the
      // relay's closed dial port. The owner decides the retry policy (backoff,
      // give-up) — this only reports the death once, on the way down.
      try { onDead?.() } catch { /* a diagnostics callback cannot resurrect or worsen the relay */ }
    })
  }
  activeRelay = handle
  return handle
}

/**
 * One proxied request: open the tunnel, hand the socket to a one-shot agent,
 * pipe both directions.
 *
 * The dial is awaited before the outgoing request is built because the
 * agent's `createConnection` override is synchronous — the same seam the LAN
 * relay uses to stamp a PROXY v1 line, proven against this http stack. Both
 * bodies and the SSE response stream through as bytes; nothing is buffered
 * beyond Node's own flow control, so a streaming turn keeps its chunk cadence.
 */
function relayRequest(req, res) {
  const key = String(req.headers[KEY_HEADER] ?? '')
  delete req.headers[KEY_HEADER]
  if (!sameSecret(key, activeRelay?.key ?? '')) {
    // Not the plugin: a neighbouring local process, a page that guessed the
    // port, a fetch left over from a previous generation. Refused before any
    // dial happens, and the caller learns nothing about the outlet.
    activeRelay?.log?.('relay: refused a caller without this start’s key')
    sendLocal(res, 403, 'the egress relay answers its own plugin only')
    return
  }
  const targetHeader = req.headers[TARGET_HEADER]
  delete req.headers[TARGET_HEADER]
  let upstream
  try {
    upstream = new URL(String(targetHeader ?? ''))
  } catch {
    sendLocal(res, 400, `the egress relay needs a full ${TARGET_HEADER} target URL`)
    return
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    sendLocal(res, 400, `the egress relay carries http(s) targets only, got "${upstream.protocol}"`)
    return
  }
  const outlet = activeRelayOutlet()
  // Host only, never the href: query strings routinely carry credentials
  // (Gemini's ?key=… being the canonical case), and this line runs per request.
  activeRelay?.log?.(`relay: ${req.method} → ${upstream.protocol}//${upstream.host} (outlet ${outlet === null ? 'none' : 'ok'})`)
  if (outlet === null) {
    sendLocal(res, 502, 'the egress relay is not running', { [FAULT_HEADER]: 'no-outlet' })
    return
  }
  // Whether the request has been handed to the tunnel. Until it has, a failure
  // cost the gateway nothing; after it, the request may have been served.
  let sent = false
  void (async () => {
    const socket = await openTunnel(upstream, outlet)
    const agent = new http.Agent({ keepAlive: false })
    agent.createConnection = () => socket
    const headers = { ...req.headers, host: upstream.host }
    delete headers['transfer-encoding']
    const outgoing = http.request({
      method: req.method,
      path: `${upstream.pathname}${upstream.search}`,
      headers,
      agent,
    })
    outgoing.on('response', upstreamRes => {
      const responseHeaders = {}
      for (const [name, value] of Object.entries(upstreamRes.headers)) {
        if (!HOP_BY_HOP.has(name)) responseHeaders[name] = value
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders)
      activeRelay?.log?.(`relay: response ${upstreamRes.statusCode} for ${upstream.host} started`)
      upstreamRes.on('error', error => {
        activeRelay?.log?.(`egress relay: upstream body for ${upstream.host} failed: ${error?.message ?? error}`)
        res.destroy()
      })
      upstreamRes.pipe(res)
    })
    outgoing.on('error', error => {
      activeRelay?.log?.(`egress relay: tunnel to ${upstream.host} failed: ${error?.message ?? error}`)
      failOnce(res, error, sent ? 'sent' : 'tunnel')
    })
    // A client abort (the harness aborts a dead turn) must tear the upstream
    // side down too, or the socket idles until the outlet times it out. On a
    // completed response only the one-shot tunnel socket goes: destroying the
    // client connection while its body is still in flight reads as a reset to
    // fetch(). The per-request tunnel is never reused (keepAlive: false).
    res.on('close', () => {
      outgoing.destroy()
      socket.destroy()
      if (!res.writableFinished) {
        activeRelay?.log?.(`relay: response for ${upstream.host} closed before finish (writableEnded=${res.writableEnded})`)
        try { res.destroy() } catch { /* already gone */ }
      }
    })
    req.on('error', () => { outgoing.destroy() })
    sent = true
    req.pipe(outgoing)
  })().catch(error => {
    activeRelay?.log?.(`egress relay: ${upstream.host} failed: ${error?.message ?? error}`)
    failOnce(res, error, sent ? 'sent' : 'tunnel')
  })
}

/** The outlet the running relay dials; `null` between generations. */
function activeRelayOutlet() {
  return activeRelay?.outlet ?? null
}

/** The relay is loopback-only: a non-2xx here is a local misconfiguration, answered as JSON like every other local refusal. */
function sendLocal(res, status, message, extra) {
  if (res.headersSent) { activeRelay?.log?.(`relay: sendLocal(${status}) after headers, destroying`); res.destroy(); return }
  const body = JSON.stringify({ error: message })
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extra,
  })
  res.end(body)
}

/** Last-word failure: 502 before headers, a dead socket after. */
function failOnce(res, error, fault) {
  if (res.headersSent) { res.destroy(); return }
  // Marked as the outlet's own failure: `egressFetch` reads the marker, not the
  // status, to tell apart a request the outlet could not carry (a strike, and
  // worth a direct replay when nothing was written out yet) from an upstream 502
  // relayed verbatim (the outlet did its job). Without it a dead exit would look
  // like a healthy one answering 502.
  //
  // Three kinds are marked apart: an outlet that refused us on its own terms is
  // not a node to fail over from; a tunnel that never opened cost the gateway
  // nothing and can be retried from here; one that died after the request had
  // been handed to it may have been served, so it is counted but never re-sent.
  const marked = error?.refusal === undefined ? fault : 'refused'
  const detail = marked === 'sent' ? 'after the request was sent' : 'before the request went out'
  sendLocal(res, 502, `egress tunnel failed ${detail}: ${error?.message ?? error}`, { [FAULT_HEADER]: marked })
}

/**
 * Connect to `upstream` through `outlet` and return a socket ready for plain
 * http framing — already TLS-wrapped when the target is https.
 */
async function openTunnel(upstream, outlet) {
  const isTls = upstream.protocol === 'https:'
  const host = upstream.hostname
  const port = Number(upstream.port) || (isTls ? 443 : 80)
  let socket
  if (outlet.kind === 'url') {
    const proxy = outlet.url
    if (proxy.protocol === 'http:' || proxy.protocol === 'https:') socket = await httpConnect(proxy, host, port)
    else if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks5h:') socket = await socks5Connect(proxy, host, port, proxy.protocol === 'socks5h:')
    else throw new Error(`unsupported proxy scheme "${proxy.protocol}"`)
  } else {
    socket = await netConnect(host, port)
  }
  if (!isTls) return socket
  return await withTimeout(new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket,
      // An IP literal has no name to assert; the lane's hosts are names.
      servername: net.isIP(host) === 0 ? host : undefined,
      ALPNProtocols: ['http/1.1'],
    })
    secured.once('secureConnect', () => resolve(secured))
    secured.once('error', error => { secured.destroy(); reject(error) })
  }), DIAL_TIMEOUT_MS, 'target TLS handshake', socket)
}

/** Plain TCP with the dial budget applied. */
function netConnect(host, port) {
  return withTimeout(new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  }), DIAL_TIMEOUT_MS, 'tcp connect')
}

/**
 * HTTP CONNECT through an http(s) proxy — including the local mixed port a
 * managed mihomo opens, which speaks CONNECT like any other proxy.
 */
async function httpConnect(proxy, targetHost, targetPort) {
  let socket = await netConnect(proxy.hostname, Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80))
  try {
    if (proxy.protocol === 'https:') {
      socket = await withTimeout(new Promise((resolve, reject) => {
        const secured = tls.connect({ socket, servername: net.isIP(proxy.hostname) === 0 ? proxy.hostname : undefined })
        secured.once('secureConnect', () => resolve(secured))
        secured.once('error', error => { secured.destroy(); reject(error) })
      }), DIAL_TIMEOUT_MS, 'proxy TLS handshake', socket)
    }
    const auth = proxy.username === '' ? '' : `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n`
    socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${auth}\r\n`)
    const { rest } = await readUntil(socket, DIAL_TIMEOUT_MS, 'CONNECT response', buffer => {
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return null
      const head = buffer.subarray(0, end).toString('latin1')
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(head)
      if (match === null) throw new Error(`the proxy answered "${head.split('\r\n')[0] ?? ''}" to CONNECT`)
      if (Number(match[1]) < 200 || Number(match[1]) >= 300) {
        // A status here is a verdict about this plugin, not a bad moment: an
        // outlet that wants credentials it was not given refuses every request
        // it will ever see, and stepping around it to the direct path would send
        // the owner's traffic out of the very address they routed away from.
        // Tagged so the lane hands it back as a failure instead of failing over
        // (see `egressFetch`); anything that is not an authority verdict — a
        // closed socket, a timeout, a 5xx from the outlet's own dialer — is the
        // transient kind the ladder exists for.
        const status = Number(match[1])
        const refusal = new Error(`the proxy refused CONNECT with ${status}`)
        if (status === 401 || status === 403 || status === 407) refusal.refusal = status
        throw refusal
      }
      return end + 4
    })
    if (rest.length > 0) socket.unshift(rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/**
 * SOCKS5 CONNECT (RFC 1928, optional RFC 1929 credentials).
 *
 * `socks5h` sends the hostname and lets the proxy resolve it — the airport
 * exit must see the name, not this machine's DNS answer. Plain `socks5`
 * resolves locally first, per the scheme's definition.
 */
async function socks5Connect(proxy, targetHost, targetPort, resolveAtProxy) {
  const socket = await netConnect(proxy.hostname, Number(proxy.port) || 1080)
  try {
    const withAuth = proxy.username !== ''
    socket.write(Buffer.from(withAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]))
    // Each stage consumes exactly the bytes of its message (parsed from
    // `head`) and pushes any bytes past the mark back — a coalesced TCP read
    // must not swallow the next stage.
    const greeting = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 greeting', buffer => (buffer.length < 2 ? null : 2 + buffer[1]))
    if (greeting.rest.length > 0) socket.unshift(greeting.rest)
    if (greeting.head[0] !== 0x05) throw new Error(`the socks5 proxy answered version ${greeting.head[0] ?? 'nothing'}`)
    const selected = greeting.head[1]
    if (selected === 0x02) {
      if (!withAuth) throw new Error('the socks5 proxy demands credentials this outlet does not have')
      const user = Buffer.from(decodeURIComponent(proxy.username), 'utf8')
      const pass = Buffer.from(decodeURIComponent(proxy.password), 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, user.length]), user, Buffer.from([pass.length]), pass]))
      const auth = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 auth', buffer => (buffer.length >= 2 ? 2 : null))
      if (auth.rest.length > 0) socket.unshift(auth.rest)
      if (auth.head[0] !== 0x01 || auth.head[1] !== 0x00) throw new Error('the socks5 proxy rejected the credentials')
    } else if (selected !== 0x00) {
      throw new Error(`the socks5 proxy selected method ${selected}, expected 0 (none) or 2 (user/pass)`)
    }
    let address
    if (resolveAtProxy) {
      // RFC 1928: atyp 3 is [1-byte length][domain], unlike the raw IP forms.
      address = { type: 0x03, bytes: Buffer.concat([Buffer.from([Buffer.byteLength(targetHost)]), Buffer.from(targetHost, 'utf8')]) }
    } else {
      address = encodeAddress(await lookup(targetHost))
    }
    const request = Buffer.concat([
      Buffer.from([0x05, 0x01, 0x00, address.type]),
      address.bytes,
      Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff]),
    ])
    socket.write(request)
    const reply = await readUntil(socket, DIAL_TIMEOUT_MS, 'socks5 connect reply', buffer => {
      if (buffer.length < 4) return null
      if (buffer[0] !== 0x05) throw new Error(`the socks5 reply started with ${buffer[0]}`)
      if (buffer[1] !== 0x00) throw new Error(`the socks5 proxy refused the connection (code ${buffer[1]})`)
      const atyp = buffer[3]
      if (atyp === 0x01) return buffer.length >= 10 ? 10 : null
      if (atyp === 0x04) return buffer.length >= 22 ? 22 : null
      if (atyp === 0x03) {
        if (buffer.length < 5) return null
        const full = 4 + 1 + buffer[4] + 2
        return buffer.length >= full ? full : null
      }
      throw new Error(`the socks5 reply used unknown address type ${atyp}`)
    })
    if (reply.rest.length > 0) socket.unshift(reply.rest)
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** DNS answer → SOCKS5 address block (type byte + encoded bytes). */
function encodeAddress(resolved) {
  if (resolved.family !== 6) {
    return { type: 0x01, bytes: Buffer.from(resolved.address.split('.').map(part => Number(part) & 0xff)) }
  }
  // Expand the `::` run before splitting: a compressed literal has empty
  // groups in the middle that must be counted, not parsed.
  const [head, tail, ...extra] = resolved.address.split('::')
  if (extra.length > 0) throw new Error(`unexpected IPv6 literal "${resolved.address}"`)
  const headGroups = head === '' ? [] : head.split(':')
  const tailGroups = tail === undefined || tail === '' ? [] : tail.split(':')
  const groups = tail === undefined
    ? headGroups
    : [...headGroups, ...Array(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0'), ...tailGroups]
  const bytes = Buffer.alloc(16)
  groups.forEach((group, index) => {
    const value = Number.parseInt(group, 16)
    bytes[index * 2] = (value >> 8) & 0xff
    bytes[index * 2 + 1] = value & 0xff
  })
  return { type: 0x04, bytes }
}

/**
 * Accumulate socket bytes until `matcher` is happy; resolve with the bytes
 * past the mark so the caller can push them back with `unshift`.
 */
function readUntil(socket, timeoutMs, what, matcher) {
  return withTimeout(new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    const onData = chunk => {
      chunks.push(chunk)
      size += chunk.length
      const buffer = Buffer.concat(chunks, size)
      let mark
      try {
        mark = matcher(buffer)
      } catch (error) {
        cleanup()
        reject(error)
        return
      }
      if (mark === null) {
        if (size > 16 * 1024) {
          cleanup()
          reject(new Error(`the proxy sent more than 16KB without finishing the ${what}`))
        }
        return
      }
      cleanup()
      resolve({ head: buffer.subarray(0, mark), rest: buffer.subarray(mark) })
    }
    const onError = error => { cleanup(); reject(error) }
    const onClose = () => { cleanup(); reject(new Error(`the proxy closed during the ${what}`)) }
    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }
    socket.on('data', onData)
    socket.on('error', onError)
    socket.on('close', onClose)
    // The socket was paused until now (connect-stage listeners only), so the
    // first byte arrives after this switch and nothing is lost in between.
    socket.resume()
  }), timeoutMs, what, socket)
}

/** Reject after `ms`, tearing the socket down so nothing leaks half-open. */
function withTimeout(promise, ms, what, socket) {
  let timer
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        socket?.destroy?.()
        reject(new Error(`timed out after ${ms}ms: ${what}`))
      }, ms)
      timer.unref?.()
    }),
  ])
}

/** A free loopback port. Small bind/close race is acceptable — a collision surfaces as a clean startup error, not a corrupt state. */
async function freePort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, RELAY_HOST, resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Poll a TCP port until it answers or the budget runs out; `check` rethrows why early. */
async function waitForPort(host, port, timeoutMs, check) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    check?.()
    const open = await new Promise(resolve => {
      const socket = net.connect({ host, port })
      const settle = ok => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(ok)
      }
      socket.once('connect', () => settle(true))
      socket.once('error', () => settle(false))
    })
    if (open) return
    if (Date.now() > deadline) throw new Error(`the port ${host}:${port} never opened within ${timeoutMs}ms`)
    await new Promise(resolve => { const t = setTimeout(resolve, 250); t.unref?.() })
  }
}

/**
 * Stop a spawned outlet child: ask nicely, then insist. Shared by `close()` and
 * by a failed start — a mihomo that never opened its port still holds it, and
 * once the attempt has given up nothing else can reach that child.
 */
async function killChild(proc) {
  if (proc === null || proc.exitCode !== null || proc.signalCode !== null) return
  proc.removeAllListeners('exit')
  try { proc.kill() } catch { /* already gone */ }
  await new Promise(resolve => {
    const timer = setTimeout(resolve, 3_000)
    proc.once('exit', () => { clearTimeout(timer); resolve() })
  })
  if (proc.exitCode === null && proc.signalCode === null) {
    try { proc.kill('SIGKILL') } catch { /* already gone */ }
  }
}

/** Constant-time relay-key comparison; the length check keeps `timingSafeEqual` from throwing. */
function sameSecret(given, expected) {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(String(expected ?? ''))
  return a.length >= 16 && a.length === b.length && timingSafeEqual(a, b)
}

/**
 * The mihomo configuration this plugin runs: subscription as a proxy-provider,
 * a url-test group that re-measures on an interval, and MATCH routed through
 * it — so every connection the plugin makes leaves via the freshest
 * lowest-latency node without the plugin choosing one itself.
 *
 * `expected-status: 204` sits on the provider's health-check: the target is
 * gstatic's `generate_204`, so a 429 (or any error page) marks the node dead
 * and url-test excludes it. That is the 429-penalty half of the health score,
 * delegated to the component that already measures every node anyway.
 *
 * The group re-measures on a one-minute clock rather than the five it used to:
 * that clock is the *only* re-ranking that happens without this plugin noticing
 * anything, and five minutes of a node that went from 200 ms to 4 s is five
 * minutes of a slow exit. `tolerance: 50` still holds the ranking still unless a
 * candidate is meaningfully better, so the shorter clock does not turn into
 * churn. The provider's own health-check stays on the slower clock: it decides
 * liveness, not rank.
 *
 * `auth` (when the caller supplies one) password-protects the mixed port, the
 * same way the relay key protects the loopback port in front of it: a listener
 * every local process can borrow is a listener that will be borrowed.
 */
export function renderMihomoConfig({ subscription, mixedPort, apiPort, secret, auth, logFile }) {
  return [
    '# Managed by dsh-our-free-model. Edits are overwritten on the next sync.',
    `mixed-port: ${mixedPort}`,
    // The outlet serves this plugin alone: a private loopback listener with no
    // LAN exposure, no system proxy and no TUN — only `egressFetch` reroutes.
    'bind-address: 127.0.0.1',
    'allow-lan: false',
    ...(auth === undefined ? [] : [
      'authentication:',
      `  - ${JSON.stringify(auth)}`,
    ]),
    'mode: rule',
    'log-level: warning',
    ...(logFile === undefined ? [] : [`log-file: ${JSON.stringify(logFile)}`]),
    `external-controller: ${RELAY_HOST}:${apiPort}`,
    `secret: ${JSON.stringify(secret)}`,
    'dns:',
    '  enable: false',
    'proxy-providers:',
    '  egress:',
    '    type: http',
    `    url: ${JSON.stringify(subscription)}`,
    '    interval: 86400',
    '    path: ./egress-provider.yaml',
    '    health-check:',
    '      enable: true',
    '      url: "http://www.gstatic.com/generate_204"',
    '      interval: 300',
    '      timeout: 5000',
    '      expected-status: 204',
    'proxy-groups:',
    '  - name: ofm-outlet',
    '    type: url-test',
    '    use:',
    '      - egress',
    '    url: "http://www.gstatic.com/generate_204"',
    '    interval: 60',
    '    tolerance: 50',
    'rules:',
    '  - MATCH,ofm-outlet',
    '',
  ].join('\n')
}

/**
 * Locate a mihomo-family binary: the explicit setting first, then PATH, then
 * the install directories of the clients that are actually common (Clash
 * Verge ships `verge-mihomo.exe` beside its GUI). No downloads here — a missing
 * binary is an error the settings page can explain, not a silent fetch.
 */
export function findMihomoBinary(explicit) {
  const given = String(explicit ?? '').trim()
  if (given !== '') {
    if (!fs.existsSync(given)) throw new Error(`the mihomo path "${given}" does not exist`)
    return given
  }
  const windows = process.platform === 'win32'
  const names = windows
    ? ['mihomo.exe', 'verge-mihomo.exe', 'verge-mihomo-alpha.exe', 'clash-meta.exe', 'clash.exe']
    : ['mihomo', 'clash-meta', 'clash']
  const dirs = []
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.trim() !== '') dirs.push(entry)
  }
  const roots = windows
    ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], path.join(process.env.LOCALAPPDATA ?? '', 'Programs')]
        .filter(Boolean)
        .flatMap(root => [path.join(root, 'Clash Verge'), path.join(root, 'clash-verge'), path.join(root, 'mihomo')])
    : ['/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', path.join(process.env.HOME ?? '', '.local/bin')]
  for (const dir of [...dirs, ...roots]) {
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* not there; next */ }
    }
  }
  throw new Error('no mihomo binary found — set its path in the egress settings (Clash Verge installs one, or get it from MetaCubeX/mihomo)')
}

/** Hostname of a URL, for display: the path of a subscription link is its credential. */
export function outletLabel(url) {
  try {
    const parsed = new URL(String(url))
    return `${parsed.protocol}//${parsed.host}`
  } catch {
    return ''
  }
}

/**
 * What the outlet is carrying traffic on right now, straight from mihomo's own
 * controller: the node its url-test picked and the delay that won it the rank.
 *
 * Returns `null` for a `client` outlet (there is no controller to ask) or while
 * url-test has not settled on a node yet. A controller that cannot answer at all
 * throws: the caller keeps its last reading rather than reporting a bare outlet.
 */
export async function readOutletSelection(relay, { timeoutMs = 4000 } = {}) {
  const managed = relay?.managed
  if (managed === null || managed === undefined) return null
  const group = await controllerJson(managed, '/proxies/ofm-outlet', timeoutMs)
  const node = typeof group?.now === 'string' ? group.now : ''
  if (node === '') return null
  // The winner's own reading is the number url-test ranked on. Nodes that came
  // from the provider are not addressable as `/proxies/<name>` (mihomo answers
  // 404 for those), so the delay is read out of the provider's own table; the
  // group's history is the last fallback, and in some builds it stays empty.
  const provider = await controllerJson(managed, '/providers/proxies/egress', timeoutMs).catch(() => null)
  const ranked = Array.isArray(provider?.proxies) ? provider.proxies.find(item => item?.name === node) : undefined
  return { node, delayMs: lastDelay(ranked) ?? lastDelay(group) ?? 0 }
}

function lastDelay(proxy) {
  const history = proxy?.history
  if (!Array.isArray(history) || history.length === 0) return undefined
  const delay = history[history.length - 1]?.delay
  return typeof delay === 'number' && delay > 0 ? delay : undefined
}

/**
 * The address block a rate limiter is counting in.
 *
 * A refusal is a verdict on the address the lane saw, not on the node that
 * carried the request. Measured on a live outlet: every node presenting
 * 5.34.220.113-117 — five adjacent addresses of one allocation — was answered
 * `Rate limit exceeded`, while 23.185.208.66, 155.254.104.158, 188.253.124.12
 * and 188.253.116.228 carried the same request fine, several of them slower
 * than every refused node. So a rotation that remembers only names walks that
 * one block node by node, one cooldown at a time, and the lane stays refused
 * throughout — which is the report this exists to answer.
 *
 * Best effort by design: an address this cannot group returns `''`, and callers
 * read that as "no grouping information" — never as "this one is blocked".
 *
 * @param {unknown} address
 * @returns {string} `a.b.c.0/24`, or `xxxx:xxxx:xxxx::/48`, or `''`
 */
export function addressBlock(address) {
  const text = typeof address === 'string' ? address.trim() : ''
  if (text === '') return ''
  if (text.includes(':')) {
    const parts = text.split(':')
    // Everything past a `::` is a gap, not an octet: only the groups the address
    // states before it can be turned into a prefix.
    const gap = parts.indexOf('')
    const groups = gap === -1 ? parts : parts.slice(0, gap)
    if (groups.length < 3 || groups.some(group => !/^[0-9a-f]{1,4}$/i.test(group))) return ''
    return `${groups.slice(0, 3).join(':')}::/48`
  }
  const octets = text.split('.')
  if (octets.length !== 4) return ''
  if (octets.some(octet => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return ''
  return `${octets.slice(0, 3).join('.')}.0/24`
}

/**
 * Rank the outlet's nodes the way a rotation wants them: measured and reachable,
 * not already blamed by name, and not sitting on an address block the lane has
 * already refused.
 *
 * `addressOf` is the caller's memory of which address each node presents. A node
 * it has never measured has no answer, stays in the list, and gets verified
 * after the switch instead — an unknown node is worth one attempt, a known
 * refused address is worth none.
 *
 * @param {{proxies?: unknown[], avoid?: string[]|Set<string>, avoidBlocks?: string[]|Set<string>,
 *   addressOf?: (name: string) => string}} [options]
 * @returns {{name: string, delayMs: number}[]} fastest first
 */
export function rankOutletCandidates({ proxies, avoid = [], avoidBlocks = [], addressOf = () => '' } = {}) {
  const avoided = avoid instanceof Set ? avoid : new Set(avoid)
  const blamed = avoidBlocks instanceof Set ? avoidBlocks : new Set(avoidBlocks)
  return (Array.isArray(proxies) ? proxies : [])
    .map(proxy => ({ name: typeof proxy?.name === 'string' ? proxy.name : '', delayMs: lastDelay(proxy) ?? 0 }))
    // A node with no positive delay is one the health-check could not reach; it
    // is not a candidate however short the list is.
    .filter(row => row.name !== '' && row.delayMs > 0 && !avoided.has(row.name))
    .filter(row => {
      const block = addressBlock(addressOf(row.name) ?? '')
      return block === '' || !blamed.has(block)
    })
    .sort((a, b) => a.delayMs - b.delayMs)
}

/**
 * Make the outlet re-measure every node, and step off the one that just answered
 * a quota refusal.
 *
 * The provider and the url-test group both re-measure on their own 300 s clock,
 * and a per-address rate limit is invisible to that clock: gstatic still answers
 * 204 through the node the lane just refused, so its latency — and its rank — do
 * not move, and url-test hands back the same exit. The plugin is the only
 * component that sees the refusal, so it is the one that has to force the
 * measurement and then pick an exit the lane has not just refused.
 *
 * Best effort by design: a `client` outlet has no controller to ask, and a
 * controller that will not answer leaves the outlet exactly as it was. A
 * rotation is an optimization, never a health requirement.
 *
 * @param {{managed?: {apiPort: number, secret: string}|null}} relay
 * @param {{avoid?: string[], avoidBlocks?: string[], addressOf?: (name: string) => string, timeoutMs?: number}} [options]
 *   `avoid` names the exits not to come back to: the one that just refused, and
 *   any that refused inside the caller's cooldown window. `avoidBlocks` names
 *   the address blocks that are out for the same reason.
 * @returns {Promise<{node: string, delayMs: number, previous: string, switched: boolean, candidates: number}|null>}
 *   `null` when there is no controller, nothing measured, or no usable exit
 *   outside `avoid` — in which case the outlet is left as it was.
 */
export async function refreshOutletExit(relay, { avoid = [], avoidBlocks = [], addressOf, timeoutMs = 4000 } = {}) {
  const managed = relay?.managed
  if (managed === null || managed === undefined) return null
  // The provider's own health-check is the "measure every node now" call. The
  // group's `/delay` would re-rank the nodes the group already holds, which is
  // the ranking that put the refused exit on top in the first place.
  await controllerJson(managed, '/providers/proxies/egress/healthcheck', timeoutMs).catch(() => null)
  const group = await controllerJson(managed, '/proxies/ofm-outlet', timeoutMs).catch(() => null)
  const previous = typeof group?.now === 'string' ? group.now : ''
  const provider = await controllerJson(managed, '/providers/proxies/egress', timeoutMs).catch(() => null)
  const ranked = rankOutletCandidates({ proxies: provider?.proxies, avoid, avoidBlocks, addressOf })
  const best = ranked[0]
  if (best === undefined) return null
  if (best.name === previous) return { node: best.name, delayMs: best.delayMs, previous, switched: false, candidates: ranked.length }
  await controllerJson(managed, '/proxies/ofm-outlet', timeoutMs, { method: 'PUT', body: { name: best.name } })
  return { node: best.name, delayMs: best.delayMs, previous, switched: true, candidates: ranked.length }
}

/**
 * Move the outlet off a blamed address, and check what it landed on.
 *
 * mihomo reports the switch as done the moment it accepts the PUT, but the lane
 * counts the address behind the node, and one subscription's nodes are full of
 * exits that share one. So a landing the caller cannot verify — an address it
 * has never measured — is believed, and a landing back inside the blamed block
 * is stepped off again, up to `hops` times, before the rotation gives up and
 * says so instead of reporting a move that changed nothing.
 *
 * @param {{managed?: {apiPort: number, secret: string}|null}} relay
 * @param {{avoid?: string[], blame?: string, hops?: number,
 *   addressOf?: (name: string) => string, measure?: (node: string) => string|Promise<string>,
 *   onHop?: (node: string, address: string) => void}} [options]
 *   `blame` is the refused block (from {@link addressBlock}); `measure` reports
 *   the address the outlet presents now, or `''` when that cannot be trusted;
 *   `onHop` is how the caller keeps its memory of a landing it must not reuse.
 * @returns {Promise<{rotation: {node: string, delayMs: number, previous: string, switched: boolean, candidates: number}|null,
 *   hops: number, blocked: {node: string, address: string}[]}>}
 *   `rotation` is `null` when nothing outside the blamed address could be
 *   reached, and `hops` counts the switches it performed.
 */
export async function stepOffBlamedAddress(relay, { avoid = [], blame = '', hops = 3, addressOf, measure = () => '', onHop } = {}) {
  const names = avoid.filter(name => typeof name === 'string' && name !== '')
  const blocked = []
  const attempts = Math.max(1, hops)
  for (let hop = 0; hop < attempts; hop += 1) {
    const rotation = await refreshOutletExit(relay, {
      avoid: names,
      // With nothing blamed there is nothing to skip, and nothing to verify
      // either: the caller asked for a plain "step off this node".
      avoidBlocks: blame === '' ? [] : [blame],
      addressOf,
    })
    if (rotation === null) return { rotation: null, hops: hop, blocked }
    // The node already carrying traffic is the only one measured: there is
    // nothing to step onto, and nothing to check.
    if (!rotation.switched) return { rotation, hops: hop, blocked }
    names.push(rotation.node)
    if (blame === '') return { rotation, hops: hop + 1, blocked }
    const landed = await measure(rotation.node)
    const block = addressBlock(landed)
    if (block === '' || block !== blame) return { rotation, hops: hop + 1, blocked }
    blocked.push({ node: rotation.node, address: landed })
    onHop?.(rotation.node, landed)
  }
  return { rotation: null, hops: attempts, blocked }
}

function controllerJson(managed, path, timeoutMs, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = http.request(
      {
        host: RELAY_HOST,
        port: managed.apiPort,
        path,
        method,
        headers: {
          authorization: `Bearer ${managed.secret}`,
          ...payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        },
        timeout: timeoutMs,
      },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => {
          // mihomo answers a switch and a forced health-check with 204 and no
          // body, and the readings with 200 and JSON: anything else is a
          // controller the caller must not read a verdict out of.
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`mihomo controller ${method} ${path} answered ${response.statusCode}`))
            return
          }
          if (body === '') {
            resolve(null)
            return
          }
          try {
            resolve(JSON.parse(body))
          } catch {
            reject(new Error(`mihomo controller ${method} ${path} sent unparsable JSON`))
          }
        })
      },
    )
    request.on('timeout', () => request.destroy(new Error(`mihomo controller ${method} ${path} timed out`)))
    request.on('error', reject)
    request.end(payload)
  })
}
