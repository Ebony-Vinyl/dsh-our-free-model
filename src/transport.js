/**
 * Free-lane transport hop: route the OpenCode upstream calls through a local
 * Bun sidecar so the request leaves this machine with Bun's HTTP stack.
 *
 * Why it exists: the free lane's upstream also fingerprints the *client
 * transport*. Measured 2026-11-14 (9router issue #65, decolua#5218): the same
 * body, session id, credential and egress IP answered 200 through Bun's
 * `fetch` and `429 FreeUsageLimitError` through Node/undici and curl inside the
 * same minute. The wording is the quota's wording, but the refusal is a
 * transport rejection — which is why no amount of fresh sessions, new IPs or
 * Cloudflare WARP egress changed the answer. The lane's own docs
 * (`docs/free-lane-wire.md`) recorded TLS-stack indifference on 2026-10-14; the
 * upstream has since tightened that.
 *
 * Mechanics: {@link laneFetch} lazily spawns `scripts/opencode-transport.mjs`
 * with Bun (`bun` on PATH or `~/.bun/bin/bun.exe`; `OPENCODE_BUN_BIN`
 * overrides), waits for its `{"port":N}` line, and forwards the request to
 * `127.0.0.1:port/forward` with the per-process token. The sidecar re-issues
 * the request with Bun's stack and relays status, headers and streaming body
 * back unchanged, so callers see exactly what a direct fetch would have given
 * them. Any hop failure — Bun missing, the sidecar dying, a refused forward —
 * falls back to the plain {@link egressFetch}, which keeps the gateway working
 * everywhere (worst case: the lane's transport gate answers 429 again).
 * `OPENCODE_TRANSPORT=off` skips the spawn entirely.
 */

import { spawn } from 'node:child_process'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { egressFetch } from './egress.js'

const SIDE_CAR_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'opencode-transport.mjs')
const SPAWN_TIMEOUT_MS = 10000

let sidecar // { port, token, child } once ready; null while unusable; undefined before the first attempt

/** Read one stdout line, racing the process's exit and a hard deadline. */
function firstLine(child) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => { cleanup(); reject(new Error('sidecar did not report a port in time')) }, SPAWN_TIMEOUT_MS)
    const onExit = () => { cleanup(); reject(new Error('sidecar exited before reporting a port')) }
    const onError = error => { cleanup(); reject(error) }
    function cleanup() {
      clearTimeout(timer)
      child.removeListener('exit', onExit)
      child.removeListener('error', onError)
    }
    child.on('exit', onExit)
    child.on('error', onError)
    child.stdout.on('data', chunk => {
      buffer += chunk.toString()
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      cleanup()
      child.stdout.removeAllListeners('data')
      resolve(buffer.slice(0, newline).trim())
    })
  })
}

function bunCandidates() {
  const candidates = []
  if (process.env.OPENCODE_BUN_BIN) candidates.push(process.env.OPENCODE_BUN_BIN)
  // `bun i -g bun` on Windows installs the real binary inside the npm tree and
  // puts only shims on PATH — `spawn('bun')` cannot execute a shim, so the
  // binary's actual location is a candidate of its own.
  candidates.push(path.join(os.homedir(), '.bun', 'bin', 'bun.exe'))
  candidates.push(path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'))
  candidates.push('bun')
  return candidates
}

/** Spawn the sidecar once; cache the outcome, including the failure. */
async function ensureSidecar() {
  if (sidecar !== undefined) return sidecar
  // Read per attempt, not at import: the flag must also stop an in-flight
  // process (the tests toggle it after the module graph has loaded).
  if (process.env.OPENCODE_TRANSPORT === 'off') { sidecar = null; return null }
  sidecar = null
  const token = crypto.randomBytes(24).toString('hex')
  for (const binary of bunCandidates()) {
    let child
    try {
      child = spawn(binary, [SIDE_CAR_SCRIPT, token], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch { continue }
    try {
      const line = await firstLine(child)
      const parsed = JSON.parse(line)
      if (!Number.isInteger(parsed?.port) || parsed.port <= 0) throw new Error(`bad port report: ${line.slice(0, 100)}`)
      child.on('exit', () => { if (sidecar?.child === child) sidecar = undefined })
      // Keep the event loop free to exit: the sidecar is a daemon for the
      // gateway's lifetime, not a handle that pins a short-lived caller
      // (a test that fired one request would otherwise never exit).
      child.unref()
      child.stdout.unref()
      child.stderr.unref()
      sidecar = { port: parsed.port, token, child }
      return sidecar
    } catch (error) {
      try { child.kill() } catch { /* already gone */ }
      // A missing binary surfaces as an `error` event; keep the message for the
      // last candidate so the fallback log says why the hop was skipped.
      lastSkipReason = error?.message ?? String(error)
    }
  }
  lastSkipReason = `no bun candidate worked: ${lastSkipReason}`
  return null
}

let lastSkipReason = 'disabled'

/**
 * POST/GET one request to the free lane, through the Bun hop when available.
 *
 * Mirrors `egressFetch`'s signature exactly, so it is a drop-in for
 * `src/http.js`. The sidecar path ignores egress proxies by design — its
 * purpose is the transport fingerprint, and a relay in the middle would undo
 * it; callers who need egress routing get the direct fetch via the fallback.
 *
 * @param {string} url
 * @param {object} [init] - `method`, `headers`, `body`, `signal`
 * @returns {Promise<Response>}
 */
export async function laneFetch(url, init = {}) {
  const hop = await ensureSidecar()
  if (hop === null) return egressFetch(url, init)
  try {
    const headers = new Headers(init.headers ?? {})
    headers.set('x-ofm-token', hop.token)
    headers.set('x-ofm-url', String(url))
    const response = await fetch(`http://127.0.0.1:${hop.port}/forward`, {
      method: init.method ?? 'GET',
      headers,
      body: init.body,
      signal: init.signal,
      redirect: 'manual',
    })
    // A 502 from the hop itself means its own upstream fetch threw; answer with
    // the direct stack rather than surfacing a synthetic failure.
    if (response.status === 502) return egressFetch(url, init)
    return response
  } catch {
    // Body is a string or Buffer here (the lane always serializes before
    // calling), so the fallback can replay it verbatim.
    return egressFetch(url, init)
  }
}

/** Why the last sidecar attempt was skipped — for diagnostics, not UX. */
export function transportSkipReason() {
  return sidecar === null ? `sidecar unavailable: ${lastSkipReason}` : sidecar === undefined ? `sidecar not yet attempted` : 'sidecar active'
}
