#!/usr/bin/env node
/**
 * OFM 反馈服务 —— 插件内提交问题与许愿。
 *
 * 为什么是独立服务而不是塞进网关：反馈和付费/计费通道没有任何共享状态，
 * 独立进程崩了不影响推理，也不会因为网关发版而被一起重启。
 *
 * 为什么用 GitHub device flow 而不是网页回调：
 * 插件跑在用户自己的机器上，没有可注册的回调地址；device flow 只要用户
 * 在一个码页上输入六位码，不需要任何 localhost 监听端口，也不需要为每个
 * 用户环境登记 redirect_uri。代价是 GitHub OAuth App 需要勾选
 * "Enable Device Flow" —— 这是唯一一项需要人工在 GitHub 后台完成的设置。
 *
 * 存储：一个 JSON 文件，按 UTC 日期分目录。不做数据库 —— 反馈量级用不上，
 * 而且纯文件让备份就是 cp。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'

const PORT = Number(process.env.PORT ?? 4319)
const HOST = process.env.HOST ?? '127.0.0.1'
const DATA_DIR = process.env.FEEDBACK_DATA_DIR ?? path.join(process.cwd(), 'data')
const CLIENT_ID = String(process.env.GITHUB_CLIENT_ID ?? '').trim()
// 只读身份，不碰仓库 —— 反馈不需要任何写权限。
const SCOPE = 'read:user'
const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const TOKEN_URL = 'https://github.com/login/oauth/access_token'
const USER_URL = 'https://api.github.com/user'
const SESSION_TTL = 20 * 60_000
const MAX_BODY = 32 * 1024
const KINDS = new Set(['bug', 'wish'])
const MAX_TITLE = 120
const MAX_BODY_TEXT = 8000

/**
 * `/api/auth/start` 每发起一次就消耗一次 GitHub 的 device-code 配额，而这个配额
 * 是按 OAuth App（也就是全体用户共用的 client_id）计的：一个匿名循环就能让所有人
 * 都登不上。所以这里按 IP 做固定窗口限速，并把同时存活的会话数封顶。
 */
const START_PER_IP_PER_HOUR = 10
const MAX_LIVE_SESSIONS = 200
/** 已登录用户的提交也限速，避免一个账号把落盘目录写满。 */
const SUBMIT_PER_USER_PER_HOUR = 20

const sessions = new Map()
const issued = new Map()
const startHits = new Map()
const submitHits = new Map()

/** 固定窗口计数：返回 true 表示这次放行。 */
function allow(bucket, key, limit, windowMs) {
  const now = Date.now()
  const row = bucket.get(key)
  if (!row || row.reset <= now) {
    bucket.set(key, { count: 1, reset: now + windowMs })
    return true
  }
  if (row.count >= limit) return false
  row.count += 1
  return true
}

const clientIpOf = req => String(req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '')
  .split(',')[0].trim()

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('too-large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch { reject(new Error('bad-json')) }
    })
    req.on('error', reject)
  })
}

/** 只放行 GitHub 的 https 接口；device flow 与取用户信息都不该走别的域。 */
async function github(url, init) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: 'application/json', 'user-agent': 'ofm-feedback', ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  })
  const body = await response.json().catch(() => null)
  return { response, body }
}

function prune() {
  const now = Date.now()
  for (const [key, value] of sessions) if (value.exp < now) sessions.delete(key)
  for (const [key, value] of issued) if (value.exp < now) issued.delete(key)
}

function store(kind, entry) {
  const day = new Date().toISOString().slice(0, 10)
  const dir = path.join(DATA_DIR, day)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`
  const file = path.join(dir, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify({ id, at: new Date().toISOString(), kind, ...entry }, null, 2) + '\n', { mode: 0o600 })
  return id
}

const text = value => typeof value === 'string' ? value.trim() : ''

/**
 * 浏览器发起的跨站请求检查。
 *
 * 这个服务没有 CORS 头，所以别的站点读不到响应 —— 但一个"简单 POST"不需要预检，
 * 任何页面都能触发它。`/api/auth/start` 每次触发都消耗共享配额，因此这里对带
 * Origin 的请求做同源校验。不带 Origin 的请求（curl、插件服务端代理）放行：
 * 那不是浏览器，没有"用户在某个页面上"这回事。
 */
const ALLOWED_ORIGINS = String(process.env.FEEDBACK_ALLOWED_ORIGINS ?? '')
  .split(',').map(value => value.trim()).filter(Boolean)

function crossSite(req) {
  const origin = String(req.headers.origin ?? '').trim()
  if (origin === '') return false
  if (ALLOWED_ORIGINS.includes(origin)) return false
  // 同源请求的 Origin 与 Host 一致；反代下 Host 是外部域名，故用 sec-fetch-site
  // 作为第二判据，避免因为反代改写 Host 而误拒合法页面。
  const site = String(req.headers['sec-fetch-site'] ?? '').trim()
  if (site === 'same-origin' || site === 'same-site' || site === 'none') return false
  let host
  try { host = new URL(origin).host } catch { return true }
  return host !== String(req.headers.host ?? '')
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = url.pathname.replace(/\/+$/, '') || '/'
  try {
    if (req.method === 'GET' && route === '/api/health') {
      return json(res, 200, { ok: true, configured: CLIENT_ID !== '' })
    }

    if (crossSite(req)) return json(res, 403, { error: 'cross-site' })

    // 发起登录：向 GitHub 要一对 device/user code。
    if (req.method === 'POST' && route === '/api/auth/start') {
      if (!CLIENT_ID) return json(res, 503, { error: 'unconfigured' })
      // 限速要在打 GitHub 之前：这个接口的成本全在外部配额上。
      if (!allow(startHits, clientIpOf(req), START_PER_IP_PER_HOUR, 3600_000)) {
        return json(res, 429, { error: 'rate-limited' })
      }
      prune()
      if (sessions.size >= MAX_LIVE_SESSIONS) return json(res, 429, { error: 'busy' })
      const { response, body } = await github(DEVICE_CODE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: SCOPE }).toString(),
      })
      if (!response.ok || typeof body?.device_code !== 'string') {
        // device flow 未启用时 GitHub 会明确说 device_flow_disabled —— 把它透出去，
        // 否则运维只能看到"登录失败"四个字。
        return json(res, 502, { error: typeof body?.error === 'string' ? body.error : 'github-unavailable' })
      }
      const session = crypto.randomBytes(24).toString('base64url')
      sessions.set(session, {
        deviceCode: body.device_code, exp: Date.now() + SESSION_TTL,
        interval: Math.max(5, Number(body.interval) || 5), nextAt: 0,
      })
      prune()
      return json(res, 200, {
        session, userCode: body.user_code,
        verifyUrl: typeof body.verification_uri === 'string' ? body.verification_uri : 'https://github.com/login/device',
        expiresIn: Number(body.expires_in) || 900,
      })
    }

    // 轮询：pending 就返回 pending，成功后发一个本服务的令牌。
    if (req.method === 'POST' && route === '/api/auth/poll') {
      const body = await readBody(req)
      // 一个 JSON `null` 会原样解析成 null（而不是 {}），访问 .session 会抛
      // TypeError 变成 500。请求体形状不对是客户端的问题，回 400 更准确。
      if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad-json' })
      const session = typeof body.session === 'string' ? sessions.get(body.session) : undefined
      if (!session) return json(res, 200, { status: 'expired' })
      if (session.exp < Date.now()) { sessions.delete(body.session); return json(res, 200, { status: 'expired' }) }
      if (Date.now() < session.nextAt) return json(res, 200, { status: 'pending' })
      const { response, body: grant } = await github(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: CLIENT_ID, device_code: session.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      })
      if (grant?.error === 'authorization_pending') {
        session.nextAt = Date.now() + session.interval * 1000
        return json(res, 200, { status: 'pending' })
      }
      if (grant?.error === 'slow_down') {
        session.interval += 5
        session.nextAt = Date.now() + session.interval * 1000
        return json(res, 200, { status: 'pending' })
      }
      if (grant?.error === 'expired_token') { sessions.delete(body.session); return json(res, 200, { status: 'expired' }) }
      if (!response.ok || typeof grant?.access_token !== 'string') {
        return json(res, 200, { status: 'denied', error: typeof grant?.error === 'string' ? grant.error : 'github-error' })
      }
      const { body: user } = await github(USER_URL, { headers: { authorization: `Bearer ${grant.access_token}` } })
      if (!Number.isFinite(user?.id)) return json(res, 200, { status: 'denied', error: 'profile' })
      sessions.delete(body.session)
      const token = crypto.randomBytes(32).toString('base64url')
      issued.set(token, {
        exp: Date.now() + 7 * 24 * 3600_000,
        githubId: String(user.id), login: String(user.login ?? ''),
      })
      return json(res, 200, { status: 'ok', token, login: String(user.login ?? '') })
    }

    // 提交反馈：必须带登录令牌。匿名提交一律拒绝 —— 没有身份的问题单无法回访。
    if (req.method === 'POST' && route === '/api/feedback') {
      const body = await readBody(req)
      if (body === null || typeof body !== 'object') return json(res, 400, { error: 'bad-json' })
      const authorization = String(req.headers.authorization ?? '')
      const token = /^Bearer (.+)$/i.exec(authorization)?.[1]
      const identity = token ? issued.get(token) : undefined
      if (!identity || identity.exp < Date.now()) return json(res, 401, { error: 'unauthorized' })
      // 落盘写入也要限速：一个账号循环提交会把磁盘写满，而且这类噪声会淹没真实反馈。
      if (!allow(submitHits, identity.githubId, SUBMIT_PER_USER_PER_HOUR, 3600_000)) {
        return json(res, 429, { error: 'rate-limited' })
      }
      const kind = text(body.kind)
      const title = text(body.title)
      const detail = text(body.detail)
      if (!KINDS.has(kind)) return json(res, 400, { error: 'kind' })
      if (!title || title.length > MAX_TITLE) return json(res, 400, { error: 'title' })
      if (!detail || detail.length > MAX_BODY_TEXT) return json(res, 400, { error: 'detail' })
      const id = store(kind, {
        github: { id: identity.githubId, login: identity.login },
        title, detail,
        version: text(body.version).slice(0, 64),
        platform: text(body.platform).slice(0, 64),
        page: text(body.page).slice(0, 64),
      })
      return json(res, 200, { id })
    }

    return json(res, 404, { error: 'not-found' })
  } catch (error) {
    if (error?.message === 'too-large') return json(res, 413, { error: 'too-large' })
    if (error?.message === 'bad-json') return json(res, 400, { error: 'bad-json' })
    process.stderr.write(`feedback: ${error?.message ?? error}\n`)
    return json(res, 500, { error: 'internal' })
  }
})

server.listen({ host: HOST, port: PORT }, () => {
  process.stdout.write(`ofm-feedback listening on ${HOST}:${PORT}${CLIENT_ID ? '' : ' (GITHUB_CLIENT_ID unset: login disabled)'}\n`)
})

// 端口被占用时给运维一句能读的话，而不是一段未处理的 'error' 事件栈。
server.on('error', error => {
  const detail = error?.code === 'EADDRINUSE' ? `port ${PORT} is already in use` : String(error?.message ?? error)
  process.stderr.write(`ofm-feedback cannot listen on ${HOST}:${PORT}: ${detail}\n`)
  process.exit(1)
})
