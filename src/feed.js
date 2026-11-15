/**
 * The remote announcement feed, plus the feedback form that reports against it.
 *
 * The repository owner publishes announcements by editing one JSON document in
 * the plugin's own GitHub repository — no server, no deploy step. Every running
 * installation re-reads it on boot, on a fixed poll, and on demand, so pushing
 * to `main` is the whole act of publishing.
 *
 * Sources are tried in order and the fetch is fail-open in both directions: a
 * network failure keeps serving the last cached copy, and a malformed feed is
 * rejected as a whole rather than half-applied (an announcement that renders
 * wrong is worse than one that arrives late).
 *
 * This module is transport and validation only. What a user has acknowledged
 * and what has already raised a toast is state the caller owns, so that a feed
 * refresh never rewrites acknowledgement history.
 *
 * The feedback client lives here instead of in a module of its own because the
 * signed release set is pinned at the 80-file ceiling that older upgraders
 * enforce (`MAX_FILES` in the 1.3.1 / 2.5.9 readers): adding a shipped file
 * would make the release un-installable for every user still on those versions.
 * It has the same shape as the feed — one remote endpoint, fail-soft, validated
 * on the way in and out — so folding it in costs nothing but this paragraph.
 *
 * @module src/feed.js
 */

import fs from 'node:fs'
import path from 'node:path'

const REPO = 'Ebony-Vinyl/dsh-our-free-model'

/**
 * Feed locations, in preference order.
 *
 * `raw.githubusercontent.com` is first because it is the repository's own bytes,
 * with no third-party cache in front of it. jsDelivr is the fallback for the
 * networks where raw is TLS-interfered (measured: the connection dies with an
 * unverifiable certificate) and the edge serves the same content there. The
 * repository's default branch is `main`; there is no `master` fallback because
 * GitHub answers that ref with HTTP 422. A minute-
 * resolution cache-buster is appended to jsDelivr URLs at fetch time so an
 * owner's push is never served stale from the CDN (its default cache holds up
 * to 12 hours).
 */
export const DEFAULT_FEED_SOURCES = [
  `https://raw.githubusercontent.com/${REPO}/main/feed/announcements.json`,
  `https://cdn.jsdelivr.net/gh/${REPO}@main/feed/announcements.json`,
  // A raw.githubusercontent.com proxy, for the networks where both origins above
  // are slow or intermittently unreachable (see the note on the updater's
  // DEFAULT_MANIFEST_SOURCES). The feed is a plain read with no signature of its
  // own — the client sanitizes every item it renders — so this leg only has to
  // return the same bytes; the cache-buster below keeps a proxy's edge from
  // serving a stale copy.
  `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/main/feed/announcements.json`,
]

/** jsDelivr's edge caches per full URL; a minute-stamp keeps every poll fresh. */
export function bustCdnCache(url, now = Date.now()) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.jsdelivr.net')) {
      parsed.searchParams.set('ofm', Math.floor(now / 60_000).toString())
      return parsed.href
    }
  } catch { /* leave malformed URLs untouched; fetch will report them */ }
  return url
}

export const LEVELS = new Set(['info', 'update', 'warn', 'urgent'])
const MAX_FEED_BYTES = 512 * 1024
const MAX_HTML_BYTES = 96 * 1024
const MAX_ITEMS = 100

/**
 * Validate one raw feed document into the shape the rest of the plugin consumes.
 *
 * @param {unknown} payload - the parsed JSON document
 * @param {number} [now]
 * @returns {{announcements: Array<object>}}
 * @throws {Error} when the document is not a feed at all
 */
export function parseFeed(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('feed document must be a JSON object')
  }
  const rows = payload.announcements
  if (!Array.isArray(rows)) throw new Error('feed document must carry an announcements array')
  const seen = new Set()
  const announcements = []
  for (const row of rows.slice(0, MAX_ITEMS)) {
    const item = parseItem(row, now)
    if (item === undefined) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    announcements.push(item)
  }
  return { announcements: sortItems(announcements) }
}

/** Validated, normalised single announcement; `undefined` for rows that fail. */
function parseItem(row, now) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '' || id.length > 128) return undefined
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, 200) : ''
  if (title === '') return undefined
  const html = typeof row.html === 'string' ? row.html : ''
  if (html.length > MAX_HTML_BYTES) return undefined
  const createdAt = timestamp(row.createdAt) ?? 0
  const expiresAt = timestamp(row.expiresAt)
  if (expiresAt !== undefined && expiresAt <= now) return undefined
  const level = LEVELS.has(row.level) ? row.level : 'info'
  let link
  if (row.link !== null && typeof row.link === 'object' && typeof row.link.url === 'string'
    && /^https?:\/\//i.test(row.link.url)) {
    link = { url: row.link.url, label: typeof row.link.label === 'string' ? row.link.label.slice(0, 100) : '' }
  }
  // `holdSeconds` asks the client to keep the modal's close control locked for
  // a few seconds so the body is actually read (0/absent closes immediately).
  // The ceiling keeps an owner from writing "hold for a week".
  const holdSeconds = row.holdSeconds
  const hold = Number.isInteger(holdSeconds) && holdSeconds >= 0 && holdSeconds <= 30 ? holdSeconds : 0
  return {
    id,
    title,
    level,
    html,
    createdAt,
    ...expiresAt === undefined ? {} : { expiresAt },
    ...row.pinned === true ? { pinned: true } : {},
    ...link === undefined ? {} : { link },
    ...(hold > 0 ? { holdSeconds: hold } : {}),
  }
}

function timestamp(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Pinned first, then newest first; a stable order keeps the UI calm between polls. */
export function sortItems(items) {
  const stamp = item => (typeof item.createdAt === 'number' ? item.createdAt : Date.parse(item.createdAt) || 0)
  return [...items].sort((a, b) => {
    if ((b.pinned === true ? 1 : 0) !== (a.pinned === true ? 1 : 0)) return (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)
    return stamp(b) - stamp(a)
  })
}

/**
 * Fetch the feed, trying each source in turn.
 *
 * @param {string[]} sources
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{feed: object, source: string}>}
 */
export async function fetchFeed(sources, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const failures = []
  for (const source of sources) {
    if (typeof source !== 'string' || source === '') continue
    try {
      const response = await fetchImpl(bustCdnCache(source), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      })
      if (!response.ok) { failures.push(`${source} -> HTTP ${response.status}`); continue }
      const text = await response.text()
      if (text.length > MAX_FEED_BYTES) { failures.push(`${source} -> feed too large`); continue }
      const feed = parseFeed(JSON.parse(text))
      return { feed, source }
    } catch (error) {
      failures.push(`${source} -> ${error?.message ?? error}`)
    }
  }
  throw new Error(`no feed source answered (${failures.join('; ')})`)
}

/**
 * The poll loop's state: last good copy on disk, known ids for arrival
 * detection, and the bookkeeping the settings page reads.
 */
export class AnnouncementFeed {  /**
   * @param {object} deps
   * @param {() => {feedUrl?: string}} deps.settings
   * @param {string} deps.cacheFile - where the last good feed is kept
   * @param {(items: Array<object>) => void} [deps.onArrival] - items first seen in this poll
   * @param {(message: string) => void} [deps.log]
   */
  constructor({ settings, cacheFile, onArrival, log = () => {}, defaultSources = DEFAULT_FEED_SOURCES }) {
    this.deps = { settings, cacheFile, onArrival, log, defaultSources }
    this.cache = { at: 0, source: '', announcements: [] }
    this.error = ''
    this.polling = null
    this.knownIds = new Set()
  }

  /** Read the cached copy from disk; fresh installs start empty and stay silent on first poll. */
  load(disk = this.readDisk()) {
    let rememberedIds = []
    try {
      const parsed = JSON.parse(disk ?? '')
      const feed = parseFeed(parsed)
      this.cache = { at: Number(parsed.fetchedAt) || 0, source: String(parsed.source ?? ''), announcements: feed.announcements }
      if (Array.isArray(parsed.knownIds)) {
        rememberedIds = parsed.knownIds.filter(id => typeof id === 'string' && id.length > 0 && id.length <= 160)
      }
    } catch {
      this.cache = { at: 0, source: '', announcements: [] }
    }
    this.knownIds = new Set([
      ...this.cache.announcements.map(item => item.id),
      ...rememberedIds,
    ])
    return this.cache
  }

  readDisk() {
    try { return fs.readFileSync(this.deps.cacheFile, 'utf8') } catch { return '' }
  }

  /** True when the poll has never succeeded on this installation. */
  get neverFetched() { return this.cache.at === 0 }

  /** Sources for this installation: the owner's override first, then the defaults.
   *
   * The override must be https and carry no embedded credentials — a plaintext
   * URL would hand any local writer of settings.json a whisper network to the
   * LAN. Loopback http stays allowed: those requests never leave the machine,
   * which keeps a locally-hosted mirror (and the test suites) legitimate. The
   * update channel deliberately does not read this field at all (see
   * src/updater.js). */
  sources() {
    const override = typeof this.deps.settings()?.feedUrl === 'string' ? this.deps.settings().feedUrl.trim() : ''
    const defaults = this.deps.defaultSources
    if (override === '') return defaults
    const expanded = override.includes('{repo}') ? override.replace('{repo}', REPO) : override
    let parsed = null
    try { parsed = new URL(expanded) } catch { parsed = null }
    // URL.hostname keeps brackets on IPv6 (`[::1]`); everything loopback never
    // leaves the machine, so plain http stays acceptable there.
    const host = (parsed?.hostname ?? '').toLowerCase()
    const loopback = host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.')
    const acceptable = parsed !== null && parsed.username === '' && parsed.password === ''
      && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
    if (!acceptable) {
      this.deps.log?.('our-free-model: ignoring feedUrl override — it must be an https URL (loopback http is allowed) without credentials')
      return defaults
    }
    return [expanded, ...defaults]
  }

  /**
   * One poll. Concurrent calls share a single in-flight request. A good copy
   * is persisted to the cache file the moment it is validated.
   * @returns {Promise<{arrived: Array<object>, total: number, source: string}>}
   */
  poll() {
    if (this.polling !== null) return this.polling
    this.polling = (async () => {
      try {
        const { feed, source } = await fetchFeed(this.sources())
        const hadCache = !this.neverFetched
        const previousIds = new Set(this.knownIds)
        this.cache = { at: Date.now(), source, announcements: feed.announcements }
        // Mirrors may serve an older subset; seeing an id again is not arrival.
        this.knownIds = new Set([...previousIds, ...feed.announcements.map(item => item.id)])
        this.error = ''
        const arrived = hadCache && this.deps.onArrival !== undefined
          ? feed.announcements.filter(item => !previousIds.has(item.id))
          : []
        for (const item of arrived) this.deps.log?.(`our-free-model: announcement arrived "${item.title}"`)
        if (arrived.length > 0) this.deps.onArrival?.(arrived)
        this.persist()
        return { arrived, total: feed.announcements.length, source }
      } catch (error) {
        this.error = String(error?.message ?? error)
        this.deps.log?.(`our-free-model: feed poll failed (${this.error})`)
        return { arrived: [], total: this.cache.announcements.length, source: this.cache.source }
      } finally {
        this.polling = null
      }
    })()
    return this.polling
  }

  /** Write the last good copy; a crash mid-poll must not lose the cache. */
  persist() {
    try {
      fs.mkdirSync(path.dirname(this.deps.cacheFile), { recursive: true })
      const temp = `${this.deps.cacheFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ fetchedAt: this.cache.at, source: this.cache.source,
        announcements: this.cache.announcements, knownIds: [...this.knownIds] }))
      fs.renameSync(temp, this.deps.cacheFile)
    } catch (error) {
      this.deps.log?.(`our-free-model: could not persist the feed cache (${error?.message ?? error})`)
    }
  }

  /** Snapshot for the API layer and the first `hello` push. */
  view({ ackedIds = [] } = {}) {
    const acked = ackedIds instanceof Set ? ackedIds : new Set(ackedIds)
    // Annotate each item with its ack state so the client renders unread
    // markers from data instead of guessing.
    // Expired announcements stop rendering the moment they lapse, not whenever
    // the next poll happens to succeed (parseItem only filters on ingest, and
    // an unreachable feed source means no next poll for a long time).
    const now = Date.now()
    const items = this.cache.announcements
      .filter(item => item.expiresAt === undefined || item.expiresAt > now)
      .map(item => ({ ...item, acked: acked.has(item.id) }))
    return {
      items,
      unread: items.filter(item => !item.acked).length,
      fetchedAt: this.cache.at,
      source: this.cache.source,
      error: this.error,
      lastError: this.error,
    }
  }
}

// ── the feedback form ────────────────────────────────────────────────────────
//
// Same reasoning as `packages/standalone/feedback.mjs`, which this mirrors: the
// browser never talks to the collector directly. Two reasons, both load-bearing.
//
//  1. The settings page is served from a loopback origin, so a direct call is
//     blocked by same-origin policy and the page cannot read the answer.
//  2. The login token must stay on this machine (`settings.feedbackAuth`). The
//     page is told *who* is signed in and never receives the token, so a script
//     injected into the page cannot steal a credential that submits as the user.
//
// It is deliberately not shared with `src/eac-login.js`. Both speak device flow,
// but that one is bound to the paid EAC gateway and validates a star; a change
// made for feedback must never be able to break the paid lane.

const FEEDBACK_DEFAULT_BASE = 'https://ourfreemodel.beichenapi.com/feedback'
const FEEDBACK_MAX_TITLE = 120
const FEEDBACK_MAX_DETAIL = 8000
const FEEDBACK_KINDS = new Set(['bug', 'wish'])

const feedbackFail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

/**
 * The collector's base address: origin *and* path, never just the origin.
 *
 * The service is mounted under `/feedback/*` by the reverse proxy, which strips
 * that prefix before forwarding. Keeping the pathname is therefore mandatory;
 * an earlier version returned `parsed.origin` and dropped it, so every request
 * landed on `/api/*` at the panel root and answered 404 — sign-in and submit
 * were both dead while the health check still looked fine.
 *
 * https only, except loopback http, which never leaves the machine and is what
 * lets a local collector (and the test suites) work.
 */
export function feedbackBaseOf(settings) {
  const raw = typeof settings()?.feedbackUrl === 'string' ? settings().feedbackUrl.trim() : ''
  const value = raw || FEEDBACK_DEFAULT_BASE
  let parsed
  try { parsed = new URL(value) } catch { throw feedbackFail(400, '反馈服务器地址无效') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw feedbackFail(400, '反馈服务器必须是 https 地址（本机调试可用 http）')
  }
  if (parsed.username || parsed.password) throw feedbackFail(400, '反馈服务器地址不能包含凭据')
  if (parsed.search || parsed.hash) throw feedbackFail(400, '反馈服务器地址不能带查询串或片段')
  // Trailing slashes dropped; `/api/...` is appended at each call site.
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
}

async function feedbackCall(url, init = {}, fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    })
  } catch { throw feedbackFail(502, '反馈服务器暂时无法连接，请稍后重试') }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    // The server's own short code travels; the response body does not, because
    // a collector may echo request content back in it.
    const code = typeof body?.error === 'string' ? body.error.slice(0, 40) : `HTTP ${response.status}`
    // Two codes the collector returns have a meaning the user can act on, and
    // neither reads as an action in its raw form. `unconfigured` is an operator
    // problem (the collector has no GitHub OAuth App, so device flow can never
    // start), and `device_flow_disabled` is the one setting GitHub only exposes
    // in its own web UI. Saying "错误：unconfigured" to a user hides both.
    if (code === 'unconfigured') {
      throw Object.assign(feedbackFail(502, '反馈服务尚未启用 GitHub 登录，请联系维护者配置后再试'), { upstreamStatus: response.status })
    }
    if (code === 'device_flow_disabled') {
      throw Object.assign(feedbackFail(502, '反馈服务的 GitHub 应用未启用 Device Flow，请联系维护者'), { upstreamStatus: response.status })
    }
    // The upstream status is tagged for the caller: a 401 there means *this*
    // install's feedback token is stale, not that the management session died.
    throw Object.assign(feedbackFail(502, `反馈服务器返回错误：${code}`), { upstreamStatus: response.status })
  }
  return body ?? {}
}

/**
 * @param {object} deps
 * @param {() => {feedbackUrl?: string, feedbackAuth?: object|null}} deps.settings
 * @param {(patch: object) => void} deps.persist - merge into the settings store
 * @param {typeof fetch} [deps.fetch] - injection point for the test suites
 */
export function createFeedback({ settings, persist, fetch: fetchImpl = fetch }) {
  const call = (url, init) => feedbackCall(url, init, fetchImpl)
  const token = () => {
    const value = settings()?.feedbackAuth
    return value !== null && typeof value === 'object' && typeof value.token === 'string' && value.token !== '' ? value : null
  }
  return {
    /** Current sign-in state. The token itself never leaves this process. */
    status() {
      const value = token()
      return value === null ? { signedIn: false, login: '' } : { signedIn: true, login: String(value.login ?? '') }
    },
    /** Begin device flow: the user code and verification URL go to the page; the token is collected by `poll`. */
    async start() {
      const body = await call(`${feedbackBaseOf(settings)}/api/auth/start`, { method: 'POST' })
      if (typeof body.session !== 'string' || typeof body.userCode !== 'string') {
        throw feedbackFail(502, '反馈服务器返回了无法识别的登录响应')
      }
      return {
        session: body.session,
        userCode: body.userCode,
        verifyUrl: typeof body.verifyUrl === 'string' ? body.verifyUrl : 'https://github.com/login/device',
        expiresIn: Number(body.expiresIn) || 900,
      }
    },
    /** Poll the authorization; on success the token is written to this machine's settings. */
    async poll({ session } = {}) {
      if (typeof session !== 'string' || session === '' || session.length > 200) throw feedbackFail(400, '登录会话无效')
      const body = await call(`${feedbackBaseOf(settings)}/api/auth/poll`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }),
      })
      if (body.status === 'ok') {
        if (typeof body.token !== 'string' || body.token === '') throw feedbackFail(502, '反馈服务器未返回登录令牌')
        persist({ feedbackAuth: { token: body.token, login: String(body.login ?? ''), at: Date.now() } })
        return { status: 'ok', login: String(body.login ?? '') }
      }
      if (body.status === 'pending') return { status: 'pending' }
      if (body.status === 'expired') return { status: 'expired' }
      if (body.status === 'denied') return { status: 'denied', error: String(body.error ?? '') }
      throw feedbackFail(502, '反馈服务器返回了无法识别的登录状态')
    },
    /** Sign out locally only. The collector's token expires on its own; there is no remote revoke to call. */
    signOut() {
      persist({ feedbackAuth: null })
      return { signedIn: false, login: '' }
    },
    /** Submit one report. Anonymous reports are refused: an unreachable reporter cannot be followed up. */
    async submit(patch) {
      const auth = token()
      if (auth === null) throw feedbackFail(401, '请先用 GitHub 登录再提交反馈')
      const kind = typeof patch?.kind === 'string' ? patch.kind : ''
      const title = typeof patch?.title === 'string' ? patch.title.trim() : ''
      const detail = typeof patch?.detail === 'string' ? patch.detail.trim() : ''
      if (!FEEDBACK_KINDS.has(kind)) throw feedbackFail(400, '请选择反馈类型')
      if (title === '') throw feedbackFail(400, '请填写标题')
      if (title.length > FEEDBACK_MAX_TITLE) throw feedbackFail(400, `标题不能超过 ${FEEDBACK_MAX_TITLE} 字`)
      if (detail === '') throw feedbackFail(400, '请描述你遇到的问题或想要的功能')
      if (detail.length > FEEDBACK_MAX_DETAIL) throw feedbackFail(400, `描述不能超过 ${FEEDBACK_MAX_DETAIL} 字`)
      let body
      try {
        body = await call(`${feedbackBaseOf(settings)}/api/feedback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({
            kind, title, detail,
            version: String(patch?.version ?? '').slice(0, 64),
            platform: String(patch?.platform ?? '').slice(0, 64),
            page: String(patch?.page ?? '').slice(0, 64),
          }),
        })
      } catch (error) {
        // The collector no longer recognizes this token (it restarted and lost
        // its in-memory sessions, or the 7-day window lapsed). Clear the local
        // copy so the page falls back to "signed out" and the next click starts
        // a fresh device flow, instead of leaving a submit button that can only
        // ever fail.
        if (error?.upstreamStatus === 401) {
          persist({ feedbackAuth: null })
          throw feedbackFail(401, '反馈登录已失效，请重新用 GitHub 登录。')
        }
        throw error
      }
      // No id means it was not stored: a proxy's 200 HTML error page lands here
      // too, and returning an empty receipt would clear the user's text while
      // handing them nothing to follow up with.
      if (typeof body.id !== 'string' || body.id === '') throw feedbackFail(502, '反馈服务器没有返回单号，请稍后重试')
      return { id: body.id }
    },
  }
}
