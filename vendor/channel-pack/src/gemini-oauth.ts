/**
 * Gemini (Cloud Code) 的 Google OAuth 授权流程。
 *
 * ## ⚠️ 三条上游硬约束（原版 oauth.go 实测踩过）
 *
 * 1. **token 端点强制校验客户端身份**：只发 `client_id` 会回
 *    `invalid_request: client_secret is missing`，症状是「浏览器显示授权成功，
 *    但面板里账号一直不出现」。所以 `exchange` / `refresh` 的表单**必须**带
 *    `client_secret`。
 * 2. **必须「先监听、再拼 URL」**：端口被占时会回退到别的端口，若先拼 URL
 *    就会 `redirect_uri_mismatch`。
 * 3. **`state` 必须校验**：回调里 `state` 不匹配一律 400 拒绝（防伪造回调）。
 *
 * ## 回调地址
 *
 * `http://localhost:<port>/oauth-callback` —— Google 对原生应用的 loopback
 * 重定向（RFC 8252）允许**任意端口**，所以动态端口是合法的。
 * 同时监听 `127.0.0.1` 与 `[::1]`：浏览器常把 `localhost` 解析成 IPv6。
 */

import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import type { GeminiCredential } from './gemini.js'

export const GEMINI_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GEMINI_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
export const GEMINI_USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v2/userinfo'
export const GEMINI_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke'

/** 上游 Cloud Code 客户端的公开 client（env 可覆盖，用于自建凭据的场景）。 */
export const GEMINI_DEFAULT_CLIENT_ID =
  '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com'
export const GEMINI_DEFAULT_CLIENT_SECRET = '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'

/** 回调路径（与 client 注册值逐字一致，改了就 redirect_uri_mismatch）。 */
export const GEMINI_CALLBACK_PATH = '/oauth-callback'

/** 重定向 URI 里的主机名。⚠️ 必须是 `localhost` 而不是 `127.0.0.1`。 */
const GEMINI_REDIRECT_HOST = 'localhost'

/** 端口被占用时的兜底端口；默认走动态端口（0），与原版一致。 */
export const GEMINI_DEFAULT_CALLBACK_PORT = 8845

/**
 * 授权流程总预算。
 *
 * ⚠️ 用 **6 分钟**而不是照 `login.ts` 的 180 秒：原版 `oauth.go` 的
 * `authFlowTimeout` 就是 6 分钟 —— Google 账号常带二次验证，3 分钟会把
 * 正常用户掐掉（面板亮「授权失败」，其实人家只是慢）。
 */
export const GEMINI_AUTH_FLOW_TIMEOUT_MS = 360_000

/** 六项 scope 逐字照抄（`cloud-platform` 必需，后两项是 Cloud Code 自己的通道）。 */
export const GEMINI_SCOPES: readonly string[] = [
  'openid',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
]

/** 用户在浏览器里点了「取消」/拒绝授权。 */
export class GeminiLoginCancelledError extends Error {
  constructor(message = 'Google 授权已取消') {
    super(message)
    this.name = 'GeminiLoginCancelledError'
  }
}

/** 授权窗口超时（没人来点）。 */
export class GeminiLoginExpiredError extends Error {
  constructor(message = 'Google 授权超时，请重新发起') {
    super(message)
    this.name = 'GeminiLoginExpiredError'
  }
}

/** 生效的 client id（env 优先）。 */
export function geminiClientId(): string {
  const fromEnv = process.env.CMDC_PAK_GOOGLE_CLIENT_ID?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : GEMINI_DEFAULT_CLIENT_ID
}

/** 生效的 client secret（env 优先）。 */
export function geminiClientSecret(): string {
  const fromEnv = process.env.CMDC_PAK_GOOGLE_CLIENT_SECRET?.trim()
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : GEMINI_DEFAULT_CLIENT_SECRET
}

/** 一次授权流程的固定参数。 */
export interface GeminiAuthFlow {
  state: string
  redirectUri: string
}

/** 构造授权 URL（参数顺序无关紧要，Google 不校验）。 */
export function buildGeminiAuthUrl(flow: GeminiAuthFlow): string {
  const query = new URLSearchParams({
    client_id: geminiClientId(),
    response_type: 'code',
    redirect_uri: flow.redirectUri,
    scope: GEMINI_SCOPES.join(' '),
    state: flow.state,
    access_type: 'offline',
    include_granted_scopes: 'true',
    prompt: 'consent',
  })
  return `${GEMINI_AUTH_ENDPOINT}?${query.toString()}`
}

/** 一次令牌端点响应的解析结果。 */
export interface GeminiTokenGrant {
  access_token: string
  refresh_token?: string
  token_type: string
  expires_in: number
  scope?: string
  /**
   * OIDC `id_token`。授权 URL 带 `openid` scope，故令牌端点**必然**返回它 ——
   * 身份从这里解，不再依赖 userinfo 那次可静默失败的跨域请求。
   */
  id_token?: string
}

/**
 * 账号身份。
 *
 * `sub` 是 OIDC 的稳定标识（邮箱可改、`sub` 不变）；`email` 只用于展示。
 */
export interface GeminiUserInfo {
  sub?: string
  email?: string
}

/**
 * 解析令牌端点的 JSON。
 *
 * 三种失败形态都要给**能定位问题**的文案（原版口径）：
 * 解析不了 / `error` 字段 / 缺 `access_token`。
 */
export function parseGeminiTokenGrant(payload: unknown, previousRefreshToken?: string): GeminiTokenGrant {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('令牌端点返回无法解析（非 JSON 对象）')
  }
  const record = payload as Record<string, unknown>
  const errorCode = typeof record.error === 'string' ? record.error : ''
  if (errorCode !== '') {
    const description = typeof record.error_description === 'string' ? record.error_description : ''
    throw new Error(description === '' ? errorCode : `${errorCode}: ${description}`)
  }
  const accessToken = typeof record.access_token === 'string' ? record.access_token : ''
  if (accessToken === '') throw new Error('令牌端点未返回 access_token')

  const rawRefresh = typeof record.refresh_token === 'string' ? record.refresh_token : ''
  const refreshToken = rawRefresh !== '' ? rawRefresh : previousRefreshToken
  const rawTokenType = typeof record.token_type === 'string' ? record.token_type : ''
  const expiresIn = typeof record.expires_in === 'number' && Number.isFinite(record.expires_in) && record.expires_in > 0
    ? Math.floor(record.expires_in)
    : 3600

  const grant: GeminiTokenGrant = {
    access_token: accessToken,
    token_type: rawTokenType === '' ? 'Bearer' : rawTokenType,
    expires_in: expiresIn,
  }
  if (refreshToken !== undefined && refreshToken !== '') grant.refresh_token = refreshToken
  const scope = typeof record.scope === 'string' ? record.scope : ''
  if (scope !== '') grant.scope = scope
  const idToken = typeof record.id_token === 'string' ? record.id_token : ''
  if (idToken !== '') grant.id_token = idToken
  return grant
}

/**
 * 从 `id_token` 解出身份（`sub` / `email`）。
 */
export function geminiIdentityFromIdToken(idToken: string): GeminiUserInfo {
  if (typeof idToken !== 'string' || idToken === '') return {}
  const parts = idToken.split('.')
  if (parts.length < 2) return {}
  let payload: unknown
  try {
    payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8'))
  } catch {
    return {}
  }
  if (typeof payload !== 'object' || payload === null) return {}
  const record = payload as Record<string, unknown>
  const out: GeminiUserInfo = {}
  if (typeof record.sub === 'string' && record.sub !== '') out.sub = record.sub
  if (typeof record.email === 'string' && record.email !== '') out.email = record.email
  return out
}

/** 由 `expires_in`（秒）算出 RFC3339 过期时刻。 */
export function geminiExpiryFrom(expiresIn: number, nowMs = Date.now()): string {
  const seconds = expiresIn > 0 ? expiresIn : 3600
  return new Date(nowMs + seconds * 1000).toISOString()
}

/** 把令牌授予结果并成一条凭据（保留已有的 sub/email/project）。 */
export function credentialFromGeminiGrant(
  grant: GeminiTokenGrant,
  previous: Partial<GeminiCredential> = {},
  nowMs = Date.now(),
): GeminiCredential {
  const credential: GeminiCredential = {
    access_token: grant.access_token,
    token_type: grant.token_type,
    expires_in: grant.expires_in,
    expiry: geminiExpiryFrom(grant.expires_in, nowMs),
  }
  const refreshToken = grant.refresh_token ?? previous.refresh_token
  if (refreshToken !== undefined && refreshToken !== '') credential.refresh_token = refreshToken
  const scope = grant.scope ?? previous.scope
  if (scope !== undefined && scope !== '') credential.scope = scope
  // 身份优先取 `id_token`（与 `access_token` 同一次响应自带，零额外请求、
  // 无失败面），退到既有凭据 —— 后者覆盖「续期响应不带 id_token」的形态。
  const identity = grant.id_token === undefined ? {} : geminiIdentityFromIdToken(grant.id_token)
  const sub = identity.sub ?? previous.sub
  if (sub !== undefined && sub !== '') credential.sub = sub
  const email = identity.email ?? previous.email
  if (email !== undefined && email !== '') credential.email = email
  if (previous.cloudaicompanionProject !== undefined && previous.cloudaicompanionProject !== '') {
    credential.cloudaicompanionProject = previous.cloudaicompanionProject
  }
  return credential
}

/**
 * POST 表单。
 *
 * ⚠️ **刻意不设 `User-Agent`**：上游的 `antigravity` 伪装只用在 Cloud Code 的
 * 推理/配额端点；令牌与 userinfo 端点是标准 Google OAuth，原版抓包看到的就是
 * Go 默认 UA。加伪装反而多一个可疑特征。
 */
async function postGeminiForm(
  endpoint: string,
  form: Record<string, string>,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<unknown> {
  const body = new URLSearchParams(form).toString()
  const init: RequestInit = {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  }
  if (signal !== undefined) init.signal = signal
  const response = await fetcher(endpoint, init)
  const text = await response.text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error(`令牌端点返回无法解析（HTTP ${response.status}）`)
  }
  if (!response.ok) {
    const record = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
    const code = typeof record.error === 'string' ? record.error : `HTTP ${response.status}`
    const description = typeof record.error_description === 'string' ? record.error_description : ''
    throw new Error(description === '' ? code : `${code}: ${description}`)
  }
  return parsed
}

/** 用授权码换令牌（**必须**带 client_secret，见文件头第 1 条）。 */
export async function exchangeGeminiCode(
  code: string,
  redirectUri: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GeminiTokenGrant> {
  const fetcher = options.fetcher ?? fetch
  const payload = await postGeminiForm(
    GEMINI_TOKEN_ENDPOINT,
    {
      client_id: geminiClientId(),
      client_secret: geminiClientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    },
    fetcher,
    options.signal,
  )
  return parseGeminiTokenGrant(payload)
}

/**
 * 用 refresh_token 续期。
 *
 * ⚠️ Google **偶尔会轮换 refresh_token**：响应里给了新的就必须回写，
 * 否则下一次续期用的是已作废的旧值（表现为「昨天还好好的，今天突然要重新登录」）。
 */
export async function refreshGeminiCredential(
  refreshToken: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<GeminiTokenGrant> {
  if (refreshToken === '') throw new Error('没有 refresh_token，需要重新授权')
  const fetcher = options.fetcher ?? fetch
  const payload = await postGeminiForm(
    GEMINI_TOKEN_ENDPOINT,
    {
      client_id: geminiClientId(),
      client_secret: geminiClientSecret(),
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
    fetcher,
    options.signal,
  )
  return parseGeminiTokenGrant(payload, refreshToken)
}

/**
 * 拉账号身份（`id_token` 缺席时的**兜底**）。
 *
 * ⚠️ 用 `id`（= `sub`）当账号主键：邮箱用户可以随时改，`sub` 不会变。
 * 失败**不抛错**（身份只是展示信息，不该让整个授权失败），但会通过
 * `onFailure` 上报原因 —— 2026-10-03 用户报障「昵称退化成池 id」时这里
 * 静默吞掉了一切异常，导致无从排查。
 */
export async function fetchGeminiUserInfo(
  accessToken: string,
  options: {
    fetcher?: typeof fetch
    signal?: AbortSignal
    /** 失败原因上报口（默认静默，仅供诊断日志）。 */
    onFailure?: (reason: string) => void
  } = {},
): Promise<GeminiUserInfo> {
  const fetcher = options.fetcher ?? fetch
  const init: RequestInit = { headers: { Authorization: `Bearer ${accessToken}` } }
  if (options.signal !== undefined) init.signal = options.signal
  try {
    const response = await fetcher(GEMINI_USERINFO_ENDPOINT, init)
    if (!response.ok) {
      options.onFailure?.(`userinfo 返回 HTTP ${response.status}`)
      return {}
    }
    const payload = (await response.json()) as unknown
    if (typeof payload !== 'object' || payload === null) return {}
    const record = payload as Record<string, unknown>
    const out: GeminiUserInfo = {}
    if (typeof record.id === 'string' && record.id !== '') out.sub = record.id
    if (typeof record.email === 'string' && record.email !== '') out.email = record.email
    return out
  } catch (error) {
    options.onFailure?.(error instanceof Error ? error.message : String(error))
    return {}
  }
}

/** 撤销令牌（退出登录时调用）。失败只记日志，不上抛。 */
export async function revokeGeminiToken(
  token: string,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<void> {
  if (token === '') return
  const fetcher = options.fetcher ?? fetch
  try {
    await postGeminiForm(GEMINI_REVOKE_ENDPOINT, { token }, fetcher, options.signal)
  } catch {
    // 撤销是尽力而为：令牌过期后 revoke 会 400，不值得打断登出。
  }
}

/** 已启动但尚未完成的授权流程。 */
export interface StartedGeminiLoginFlow {
  /** 展示给用户的授权 URL。 */
  loginUrl: string
  /** 用户完成授权后落定的凭据。 */
  result: Promise<GeminiCredential>
  /** 关闭回调服务器；**幂等**。 */
  close: () => Promise<void>
}

/** `startGeminiOAuthFlow` 的选项。 */
export interface GeminiOAuthOptions {
  /** 自定义 fetch（单测注入）。 */
  fetcher?: typeof fetch
  /** 固定回调端口；默认 0 = 动态。 */
  callbackPort?: number
  /** 授权总预算，默认 {@link GEMINI_AUTH_FLOW_TIMEOUT_MS}。 */
  timeoutMs?: number
  /**
   * 身份兜底（userinfo）失败时的上报口。
   *
   * ⚠️ 这是 2026-10-03 报障的直接教训：`fetchGeminiUserInfo` 曾把一切异常
   * 静默吞成 `{}`，于是「昵称退化成池 id」在现场**零日志可查**。
   */
  onIdentityFailure?: (reason: string) => void
}

/** 回调成功后展示的页面（原版逐字）。 */
const GEMINI_CALLBACK_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权完成</title><style>body{font:15px/1.7 -apple-system,"Segoe UI",sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0f1115;color:#e6e8eb}.b{text-align:center}.k{font-size:34px;margin-bottom:8px}</style></head><body><div class="b"><div class="k">✓</div><div>授权已完成，可以关闭此页回到面板。</div></div></body></html>`

/** 先占一个空闲端口再释放 —— 用于让 v4/v6 两个监听器落在**同一个**端口上。 */
function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      probe.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('无法分配回调端口'))
      })
    })
  })
}

/**
 * 在指定端口上同时监听 `127.0.0.1` 与 `[::1]`。
 *
 * ⚠️ 必须两个都听：浏览器把 `localhost` 解析成 `::1` 时，只绑 v4 会
 * 「页面打不开 / 授权完没反应」。`[::1]` 失败可以容忍（机器没开 IPv6），
 * 但 `127.0.0.1` 失败就是真失败。
 */
type CallbackHandler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void

async function listenCallback(
  handler: CallbackHandler,
  preferredPort: number,
): Promise<{ port: number; servers: Server[] }> {
  const attempt = (port: number): Promise<{ port: number; servers: Server[] }> => {
    const primary = createServer(handler)
    return new Promise((resolve, reject) => {
      primary.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE' && port !== 0) {
          // 首选端口被占：换一个空闲端口重试（**不能**先拼 URL，见文件头第 2 条）。
          void pickFreePort().then((next) => resolve(attempt(next)), reject)
          return
        }
        reject(error)
      })
      primary.listen(port, '127.0.0.1', () => {
        const address = primary.address()
        const assigned = typeof address === 'object' && address !== null ? address.port : 0
        const secondary = createServer(handler)
        secondary.once('error', () => {
          // IPv6 监听失败可容忍：`localhost` 解析到 v4 时仍然可用。
          resolve({ port: assigned, servers: [primary] })
        })
        secondary.listen(assigned, '::1', () => {
          resolve({ port: assigned, servers: [primary, secondary] })
        })
      })
    })
  }
  return attempt(preferredPort)
}

/**
 * 启动授权流程并**立即返回** `loginUrl`。
 */
export async function startGeminiOAuthFlow(
  options: GeminiOAuthOptions = {},
): Promise<StartedGeminiLoginFlow> {
  const state = randomBytes(16).toString('hex')
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (error: Error) => void = () => {}
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  const handler: CallbackHandler = (req, res) => {
    const url = new URL(req.url ?? '/', `http://${GEMINI_REDIRECT_HOST}`)
    if (url.pathname !== GEMINI_CALLBACK_PATH) {
      res.writeHead(404).end('Not found')
      return
    }
    const failure = url.searchParams.get('error')
    if (failure !== null && failure !== '') {
      const description = url.searchParams.get('error_description') ?? ''
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(`授权被拒绝: ${failure}`)
      rejectCode(new GeminiLoginCancelledError(description === '' ? failure : `${failure}: ${description}`))
      return
    }
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('state 校验失败')
      rejectCode(new Error('state 校验失败，可能是伪造的回调'))
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('缺少 authorization code')
      rejectCode(new Error('回调缺少 authorization code'))
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(GEMINI_CALLBACK_HTML)
    resolveCode(code)
  }

  const preferred = options.callbackPort ?? 0
  const { port, servers } = await listenCallback(handler, preferred)
  const redirectUri = `http://${GEMINI_REDIRECT_HOST}:${port}${GEMINI_CALLBACK_PATH}`
  const loginUrl = buildGeminiAuthUrl({ state, redirectUri })

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    )
  }

  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? GEMINI_AUTH_FLOW_TIMEOUT_MS

  const result = Promise.race([
    codePromise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new GeminiLoginExpiredError()),
        timeoutMs,
      )
      timer.unref?.()
    }),
  ]).then(async (code) => {
    const grant = await exchangeGeminiCode(code, redirectUri, { fetcher })
    // `credentialFromGeminiGrant` 已从 `id_token` 解出 sub/email（授权 URL 带
    // `openid`，令牌响应必然带 id_token）—— 正常情况下这里**不再发 userinfo**。
    const credential = credentialFromGeminiGrant(grant)
    if (credential.sub !== undefined && credential.email !== undefined) return credential
    // 兜底：id_token 缺席或解不出身份时才补一次 userinfo。
    const user = await fetchGeminiUserInfo(credential.access_token, {
      fetcher,
      onFailure: options.onIdentityFailure,
    })
    if (credential.sub === undefined && user.sub !== undefined) credential.sub = user.sub
    if (credential.email === undefined && user.email !== undefined) credential.email = user.email
    return credential
  })

  // 先挂空处理器：结果可能在调用方 await 之前就落定（用户授权极快或立刻超时），
  // 那一段窗口里 Node 会把它当成未处理拒绝并打印告警。
  result.catch(() => {}).finally(() => { void close() })

  return { loginUrl, result, close }
}
