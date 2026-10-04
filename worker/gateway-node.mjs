#!/usr/bin/env node
/**
 * Node host for the EAC gateway — the self-hosted form of worker/worker.js
 * (宝塔/PM2/systemd 都跑这个文件；Cloudflare 部署则直接用 worker.js)。
 *
 * The validation core is the SAME module Cloudflare runs: this shim only
 * adapts Node's HTTP server to the Web `fetch(request, env, ctx)` contract,
 * so a signed request is validated identically on either host. On top of that
 * the shim adds the self-hosted-only layers:
 *
 * - per-IP concurrency limit on chat turns (in-flight counter — this process
 *   is the single point of truth);
 * - per-IP analytics (requests, tokens parsed from relayed usage frames,
 *   refusals, concurrency peaks, model mix) persisted to a stats file and
 *   rendered as a dashboard;
 * - an admin dashboard + JSON feed under `{mount}/stats`, token-gated.
 *
 * Configuration — environment variables, or a sibling `.env` file
 * (`KEY=VALUE` lines, `#` comments; real env vars win over `.env`):
 *
 *   UPSTREAM_URL         the relay base, https (or http to a loopback host)
 *   UPSTREAM_API_KEY     the relay credential — lives HERE only
 *   SIGNING_SECRETS      comma-separated accepted signing secrets
 *   MODELS               optional comma-separated model allowlist
 *   CLOCK_SKEW_SECONDS   optional replay window (default 600)
 *   MAX_BODY_BYTES       optional request body cap (default 8 MiB)
 *   SSE_PRELUDE_SECONDS  optional. Flush an SSE head plus keepalive comment
 *                        frames the moment a chat turn is admitted, so front
 *                        proxies (Cloudflare's ~100s origin timeout, nginx's
 *                        60s default read timeout) measure an already-started
 *                        response instead of the model's thinking time. A relay
 *                        refusal arriving after the head is carried in-stream
 *                        as an error frame. Default 15, 0 = off.
 *   HOST                 bind address, default 127.0.0.1 — keep it behind a
 *                        reverse proxy (Nginx); binding a public interface
 *                        would also make the X-Forwarded-For IP below spoofable
 *   PORT                 default 17788
 *   RATE_LIMIT_PER_MINUTE  per-IP fixed-window limit, default 60, 0 = off
 *   RATE_LIMIT_PER_DAY   per-IP per-day cap, default 1000, 0 = off
 *   CONCURRENCY_PER_IP   per-IP in-flight chat turns, default 20, 0 = off
 *   ADMIN_TOKEN          token for the /stats dashboard; unset = dashboard off
 *   STATS_PATH           stats file, default ./stats.json next to this script
 *   MOUNT_PREFIX         optional sub-path mount (e.g. "/eac" serving the lane
 *                        at /eac/v1/... and the dashboard at /eac/stats)
 *   LOG_SALT             optional salt for the IP hash in log lines (default:
 *                        derived from the accepted secrets)
 *
 * Run: node gateway-node.mjs   (starts listening; Ctrl-C stops)
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import gateway from './worker.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Fill unset variables from a sibling `.env`, if present. */
function loadDotEnv(target) {
  const file = path.join(here, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '')
    if (target[key] === undefined || target[key] === '') target[key] = value
  }
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// ── per-IP analytics ─────────────────────────────────────────────────────────
// Numbers only: IPs are stored as a salted hash (stable within a secret
// rotation, non-reversible from a leaked stats file). Pruned to 30 days and
// 500 addresses; flushed every 30s and on shutdown.

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const KEEP_DAYS = 30
const KEEP_IPS = 500

function dayKey(ts) { return new Date(ts).toISOString().slice(0, 10) }
function hourKey(ts) { return new Date(ts).toISOString().slice(0, 13) }

function freshIpRow(ts) {
  return { first: ts, last: ts, req: 0, in: 0, out: 0, rej: 0, conc: 0, concMax: 0, models: {}, hours: {} }
}

const analytics = {
  state: { ips: {}, hourly: {}, days: {} },
  dirty: false,
  load(file) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (parsed && typeof parsed === 'object' && parsed.ips && parsed.hourly && parsed.days) this.state = parsed
    } catch { /* fresh start */ }
    this.prune()
  },
  prune() {
    const cutoffHour = hourKey(Date.now() - KEEP_DAYS * DAY_MS)
    for (const day of Object.keys(this.state.days)) if (day < cutoffHour.slice(0, 10)) delete this.state.days[day]
    for (const hour of Object.keys(this.state.hourly)) if (hour < cutoffHour) delete this.state.hourly[hour]
    const rows = Object.entries(this.state.ips)
    if (rows.length > KEEP_IPS) {
      for (const [hash, row] of rows.sort((a, b) => a[1].last - b[1].last).slice(0, rows.length - KEEP_IPS)) delete this.state.ips[hash]
    }
    for (const row of Object.values(this.state.ips)) {
      for (const hour of Object.keys(row.hours ?? {})) if (hour < hourKey(Date.now() - 3 * DAY_MS)) delete row.hours[hour]
    }
  },
  ipHash(ip, salt) {
    return crypto.createHash('sha256').update(salt + ip, 'utf8').digest('hex').slice(0, 12)
  },
  record({ hash, chat, status, tokensIn, tokensOut, model, rejected }) {
    const now = Date.now()
    const row = this.state.ips[hash] ?? (this.state.ips[hash] = freshIpRow(now))
    row.last = now
    row.req += 1
    if (rejected === true) row.rej += 1
    row.in += tokensIn ?? 0
    row.out += tokensOut ?? 0
    const hk = hourKey(now)
    row.hours[hk] = (row.hours[hk] ?? 0) + 1
    if (model) row.models[model] = (row.models[model] ?? 0) + 1
    this.state.hourly[hk] = (this.state.hourly[hk] ?? 0) + 1
    const dk = dayKey(now)
    const day = this.state.days[dk] ?? (this.state.days[dk] = { req: 0, in: 0, out: 0 })
    day.req += 1
    day.in += tokensIn ?? 0
    day.out += tokensOut ?? 0
    this.dirty = true
  },
  concurrency(hash, current, peak) {
    const now = Date.now()
    const row = this.state.ips[hash] ?? (this.state.ips[hash] = freshIpRow(now))
    if (current !== undefined) row.conc = current
    if (peak !== undefined && peak > (row.concMax ?? 0)) row.concMax = peak
  },
  flush(file) {
    if (!this.dirty) return
    this.prune()
    try {
      const temp = file + '.' + process.pid + '.tmp'
      fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 })
      fs.renameSync(temp, file)
      this.dirty = false
    } catch (error) {
      console.log(JSON.stringify({ lane: 'eac-node', fault: 'stats flush failed: ' + String(error?.message ?? error).slice(0, 100) }))
    }
  },
  /** Test seam: the analytics module is a process-wide singleton. */
  reset() { this.state = { ips: {}, hourly: {}, days: {} }; this.dirty = false },
  snapshot() {
    const now = Date.now()
    const hourNow = hourKey(now)
    const hourAgo = new Date(now - HOUR_MS).toISOString().slice(0, 13)
    const dayNow = dayKey(now)
    const ips = Object.entries(this.state.ips).map(([hash, row]) => ({
      hash,
      req: row.req,
      today: row.hours[hourNow] ?? 0,
      in: row.in,
      out: row.out,
      rej: row.rej,
      conc: row.conc ?? 0,
      concMax: row.concMax ?? 0,
      freq1h: Object.entries(row.hours ?? {}).filter(([h]) => h >= hourAgo).reduce((sum, [, n]) => sum + n, 0),
      models: row.models ?? {},
      first: row.first,
      last: row.last,
    })).sort((a, b) => b.req - a.req)
    const hourly = Object.entries(this.state.hourly).sort(([a], [b]) => a < b ? -1 : 1).slice(-168)
    const days = Object.entries(this.state.days).sort(([a], [b]) => a < b ? -1 : 1).slice(-30)
    const models = {}
    for (const row of Object.values(this.state.ips)) for (const [m, n] of Object.entries(row.models ?? {})) models[m] = (models[m] ?? 0) + n
    return {
      generatedAt: now,
      day: dayNow,
      totals: { ips: ips.length, req: ips.reduce((s, r) => s + r.req, 0), in: ips.reduce((s, r) => s + r.in, 0), out: ips.reduce((s, r) => s + r.out, 0) },
      ips,
      hourly,
      days,
      models,
    }
  },
}

/** Pull the last prompt/completion token counts out of relayed body text —
 * works for SSE frames and single-shot JSON without full parsing. The quoted
 * key match keeps `completion_tokens_details` from polluting the count. */
function createUsageScanner() {
  let rem = ''
  let prompt
  let completion
  const scan = text => {
    const p = text.match(/"prompt_tokens"\s*:\s*(\d+)/g)
    const c = text.match(/"completion_tokens"\s*:\s*(\d+)/g)
    if (p) prompt = Number(p[p.length - 1].match(/(\d+)/)[1])
    if (c) completion = Number(c[c.length - 1].match(/(\d+)/)[1])
  }
  return {
    push(text) {
      rem += text
      let idx
      while ((idx = rem.indexOf('\n')) !== -1) { scan(rem.slice(0, idx)); rem = rem.slice(idx + 1) }
    },
    end() { if (rem !== '') scan(rem); rem = '' },
    result: () => ({ prompt: prompt ?? 0, completion: completion ?? 0 }),
  }
}

// ── per-IP limiters (single process = exact counters) ────────────────────────
function buildRateLimiter(perWindow, windowMs) {
  if (!Number.isFinite(perWindow) || perWindow <= 0) return undefined
  const seen = new Map()
  return {
    async limit({ key }) {
      const now = Date.now()
      const row = seen.get(key)
      if (row === undefined || now - row.windowStart >= windowMs) {
        if (seen.size > 10_000) for (const [k, v] of seen) if (now - v.windowStart >= windowMs) seen.delete(k)
        seen.set(key, { windowStart: now, count: 1 })
        return { success: true }
      }
      row.count += 1
      return { success: row.count <= perWindow }
    },
  }
}

/** Test seam: clear the process-wide analytics singleton between suites. */
export function resetAnalytics() { analytics.reset() }

const DASHBOARD_HTML = () => {
  try { return fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8') } catch { return '<!doctype html><meta charset="utf-8"><title>EAC 网关</title><p>dashboard.html 缺失。</p>' }
}

const ENTRY_JS = () => {
  try { return fs.readFileSync(path.join(here, 'entry.js'), 'utf8') } catch { return '/* entry.js 缺失 */' }
}

/**
 * Build the host server around the shared gateway core. Exported so the
 * offline suite can drive the exact process a deployment would run.
 *
 * @param {object} hostEnv - the environment (see the module note)
 * @returns {http.Server}
 */
export function createGatewayServer(hostEnv = {}) {
  const env = { ...hostEnv }
  loadDotEnv(env)

  const maxBody = Number.parseInt(env.MAX_BODY_BYTES ?? '8388608', 10) || 8388608
  const perMinute = Number.parseInt(env.RATE_LIMIT_PER_MINUTE ?? '60', 10)
  const perDay = Number.parseInt(env.RATE_LIMIT_PER_DAY ?? '1000', 10)
  const concLimit = Number.parseInt(env.CONCURRENCY_PER_IP ?? '20', 10)
  const adminToken = String(env.ADMIN_TOKEN ?? '')
  const preludeSeconds = (() => { const n = Number.parseInt(env.SSE_PRELUDE_SECONDS ?? '15', 10); return Number.isFinite(n) ? n : 15 })()
  const prefix = String(env.MOUNT_PREFIX ?? '').replace(/\/+$/, '')
  const statsPath = env.STATS_PATH || path.join(here, 'stats.json')
  const logSalt = String(env.LOG_SALT ?? '') || String(env.SIGNING_SECRETS ?? '').split(',')[0]?.trim() + '/request-log'

  const limiters = {
    RATE_LIMITER: buildRateLimiter(perMinute, 60_000),
    DAILY_LIMITER: buildRateLimiter(perDay, DAY_MS),
  }
  const inflight = new Map()

  analytics.load(statsPath)

  const clientIpOf = req => {
    const forwarded = req.headers['x-forwarded-for']
    if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0].trim()
    return req.socket?.remoteAddress ?? 'unknown'
  }

  const json = (res, status, payload) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }

  const server = http.createServer((req, res) => {
    const chunks = []
    let size = 0
    let overflow = false
    req.on('data', chunk => {
      size += chunk.length
      if (size > maxBody) { overflow = true; chunks.length = 0; return }
      chunks.push(chunk)
    })
    req.on('end', async () => {
      const url = new URL('http://127.0.0.1' + (req.url ?? '/'))
      const clientIp = clientIpOf(req)
      const ipHash = analytics.ipHash(clientIp, logSalt)

      // Early SSE prelude state, declared before the try so the catch can still
      // finish the response correctly once the head has been committed.
      let earlySent = false
      let keepalive = null
      const stopKeepalive = () => { if (keepalive !== null) { clearInterval(keepalive); keepalive = null } }
      const emitInStreamError = payload => {
        stopKeepalive()
        if (!res.writableEnded && !res.destroyed) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
          res.end()
        }
      }

      // ── admin dashboard + feed (data token-gated; the page self-gates) ────
      if (url.pathname === prefix + '/entry.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=300' })
        return res.end(ENTRY_JS())
      }
      if (url.pathname === prefix + '/stats-data' && adminToken === '') {
        return json(res, 403, { error: 'admin dashboard disabled: ADMIN_TOKEN is not configured' })
      }
      if (url.pathname === prefix + '/stats-data') {
        if (!timingSafeEqual(String(url.searchParams.get('t') ?? req.headers['x-admin-token'] ?? ''), adminToken)) {
          return json(res, 401, { error: 'bad admin token' })
        }
        return json(res, 200, analytics.snapshot())
      }
      if (url.pathname === prefix + '/stats') {
        // The page itself is public: it self-gates on the token (prompted once
        // and remembered in the admin's browser localStorage) before asking
        // for data, which is where the real check lives.
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(DASHBOARD_HTML())
      }

      if (overflow) {
        analytics.record({ hash: ipHash, chat: false, status: 413, tokensIn: 0, tokensOut: 0, model: null, rejected: true })
        return json(res, 413, { error: { message: 'request body too large' } })
      }

      try {
        const bodyText = req.method === 'POST' || req.method === 'PUT' ? Buffer.concat(chunks).toString('utf8') : ''
        const isChat = req.method === 'POST' && url.pathname.endsWith('/chat/completions')
        let model = null
        if (isChat) { try { model = String(JSON.parse(bodyText).model ?? '') || null } catch { /* malformed body is the caller's fault */ } }

        // ── per-IP concurrency gate on chat turns ─────────────────────────
        if (isChat && concLimit > 0) {
          const current = (inflight.get(ipHash) ?? 0) + 1
          if (current > concLimit) {
            analytics.record({ hash: ipHash, chat: true, status: 429, tokensIn: 0, tokensOut: 0, model, rejected: true })
            return json(res, 429, { error: { message: 'concurrency limit reached for this IP (' + concLimit + ' in-flight)' } })
          }
          inflight.set(ipHash, current)
          analytics.concurrency(ipHash, current, current)
        }
        const releaseConc = () => {
          if (!isChat || concLimit <= 0 || concReleased) return
          concReleased = true
          const current = (inflight.get(ipHash) ?? 1) - 1
          if (current <= 0) inflight.delete(ipHash)
          else { inflight.set(ipHash, current); analytics.concurrency(ipHash, current) }
        }

        // The gateway counts rate-limit keys off `cf-connecting-ip`; behind the
        // reverse proxy the client IP arrives on X-Forwarded-For. Trusting that
        // header is safe only while HOST stays loopback (see the module note).
        const headers = new Headers(req.headers)
        if (typeof req.headers['x-forwarded-for'] === 'string' && req.headers['x-forwarded-for'] !== '') {
          headers.set('cf-connecting-ip', req.headers['x-forwarded-for'].split(',')[0].trim())
        }
        const request = new Request('http://127.0.0.1' + (req.url ?? '/'), {
          method: req.method,
          headers,
          body: req.method === 'POST' || req.method === 'PUT' ? bodyText : undefined,
        })
        const response = await gateway.fetch(request, { ...env, RATE_LIMITER: env.RATE_LIMITER ?? limiters.RATE_LIMITER, DAILY_LIMITER: env.DAILY_LIMITER ?? limiters.DAILY_LIMITER }, {
          waitUntil() {},
          passThroughOnException() {},
          // The core calls this once admission has fully passed and it is about
          // to wait on the relay: flush the SSE head now, so a front proxy's
          // origin timeout measures an already-started response instead of the
          // model's thinking time. Keepalive comments keep every layer's idle
          // timers fed until the real frames take over.
          onUpstreamPending: preludeSeconds > 0 ? () => {
            if (earlySent || res.writableEnded || res.destroyed) return
            earlySent = true
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              'x-accel-buffering': 'no',
            })
            res.write(': channel open\n\n')
            keepalive = setInterval(() => {
              if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
            }, preludeSeconds * 1000)
            keepalive.unref?.()
          } : undefined,
        })

        const scanner = createUsageScanner()
        let concReleased = false
        if (!earlySent) {
          res.writeHead(response.status, (() => { const out = {}; response.headers.forEach((v, n) => { out[n] = v }); return out })())
        }
        if (response.body === null) {
          if (earlySent && response.status >= 400) emitInStreamError({ error: { message: `HTTP ${response.status}` } })
          else { stopKeepalive(); res.end() }
          releaseConc()
          analytics.record({ hash: ipHash, chat: isChat, status: response.status, tokensIn: 0, tokensOut: 0, model, rejected: response.status >= 400 })
          return
        }
        if (earlySent && response.status >= 400) {
          // The head is already committed as 200, so the refusal travels the
          // only way left — as an in-stream error frame, which the lane's
          // reader classifies exactly like an error envelope.
          const text = await response.text().catch(() => '')
          let payload
          try { payload = JSON.parse(text) } catch { payload = { error: { message: String(text ?? '').slice(0, 300) || `HTTP ${response.status}` } } }
          analytics.record({ hash: ipHash, chat: isChat, status: response.status, tokensIn: 0, tokensOut: 0, model, rejected: true })
          releaseConc()
          emitInStreamError(payload)
          return
        }
        const upstream = Readable.fromWeb(response.body)
        upstream.on('data', chunk => {
          const text = chunk.toString('utf8')
          res.write(text)
          scanner.push(text)
        })
        upstream.on('end', () => {
          scanner.end()
          stopKeepalive()
          res.end()
          releaseConc()
          const usage = scanner.result()
          analytics.record({ hash: ipHash, chat: isChat, status: response.status, tokensIn: usage.prompt, tokensOut: usage.completion, model, rejected: response.status >= 400 })
        })
        upstream.on('error', () => {
          stopKeepalive()
          releaseConc()
          try { res.destroy() } catch { /* client already gone */ }
        })
        res.on('close', () => { stopKeepalive(); if (!res.writableEnded) releaseConc() })
      } catch (error) {
        analytics.record({ hash: ipHash, chat: req.method === 'POST' && url.pathname.endsWith('/chat/completions'), status: 500, tokensIn: 0, tokensOut: 0, model: null, rejected: true })
        if (earlySent) emitInStreamError({ error: { message: 'gateway request failed' } })
        else {
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ error: { message: 'gateway request failed' } }))
        }
        console.log(JSON.stringify({ lane: 'eac-node', fault: String(error?.message ?? error).slice(0, 160) }))
      }
    })
    req.on('error', () => res.destroy())
  })

  return server
}

// Start only when this file is the executed entry — directly (`node gateway-node.mjs`)
// or under PM2, whose ProcessContainerFork wrapper makes process.argv[1] point at
// the fork instead of this script (pm_exec_path is how PM2 names the real one).
const scriptPath = fileURLToPath(import.meta.url)
const directRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === scriptPath
const pm2Run = typeof process.env.pm_exec_path === 'string' && process.env.pm_exec_path !== ''
  && path.resolve(process.env.pm_exec_path) === scriptPath
if (directRun || pm2Run) {
  const env = { ...process.env }
  loadDotEnv(env)
  const host = env.HOST || '127.0.0.1'
  const port = Number.parseInt(env.PORT ?? '17788', 10) || 17788
  createGatewayServer(env).listen(port, host, () => {
    console.log(`eac gateway listening on ${host}:${port} → ${String(env.UPSTREAM_URL ?? '(UPSTREAM_URL not set)')}`)
  })
  const file = statsFile(env)
  const timer = setInterval(() => analytics.flush(file), 30_000)
  timer.unref?.()
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { analytics.flush(file); process.exit(0) })
}

function statsFile(env) { return env.STATS_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), 'stats.json') }
