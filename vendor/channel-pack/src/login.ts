import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { getRandomValues, randomUUID, randomBytes } from 'node:crypto'
import type { CodeArtsCredential, CodeArtsCredentialResponse, LoginFlowOptions, LoginFlowResult } from './types.js'
import { createDomesticFetch } from './domestic-direct.js'
import {
  CLIENT_ID, REDIRECT_PATH, credentialFromTokenResponse, exchangeAuthorizationCode,
  generateDpopKeyPair, generatePkcePair,
} from './oauth.js'
import type { DpopKeyPair, PkcePair } from './oauth.js'

export const CODEARTS_LOGIN_BASE = 'https://devcloud.cn-north-4.huaweicloud.com/doer/redirect'
export const HUAWEI_AUTH_BASE = 'https://auth.huaweicloud.com/authui/login.html'
export const CREDENTIAL_ENDPOINT = 'https://snap-access.cn-north-4.myhuaweicloud.com/snap-manager/v1/login/ticket'

const PLUGIN_NAME = 'snap_jetbrains'
const PLUGIN_VERSION = '26.3.3'

/** 与重定向流程共享的随机 64 字符小写十六进制密钥。 */
export function generateRandomSecret(): string {
  const bytes = getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 构建 doer/redirect URL 及包裹它的华为认证页面 URL。 */
export function buildLoginUrl(port: number, ticketId: string): { redirectUrl: string; loginUrl: string } {
  const callbackUrl = `http://127.0.0.1:${port}/authentication`
  const redirectUrl = `${CODEARTS_LOGIN_BASE}?IdeaType=jetbrains&auth_callback_url=${encodeURIComponent(callbackUrl)}&plugin-name=${PLUGIN_NAME}&plugin-version=${PLUGIN_VERSION}&ticket_id=${encodeURIComponent(ticketId)}`
  const loginUrl = `${HUAWEI_AUTH_BASE}?service=${encodeURIComponent(redirectUrl)}`
  return { redirectUrl, loginUrl }
}

/** 将一次 ticket 响应归一化为凭据，未完成时返回 null。 */
export function parseCredentialResponse(data: CodeArtsCredentialResponse): CodeArtsCredential | null {
  if (data.credential) {
    const access = data.credential.access ?? ''
    const st = data.credential.securitytoken ?? data.credential.securityToken ?? ''
    if (access && st) {
      return {
        access_key_id: access,
        secret_access_key: data.credential.secret ?? '',
        security_token: st,
        expires_at: data.credential.expires_at ?? data.credential.expiresAt ?? '',
        domain_id: data.domain_id ?? '',
        user_id: data.user_id ?? '',
        user_name: data.user_name ?? '',
      }
    }
  }
  if (data.result) {
    const ak = data.result.accessKeyId ?? ''
    const st = data.result.securityToken ?? ''
    if (ak && st) {
      return {
        access_key_id: ak,
        secret_access_key: data.result.secretAccessKey ?? '',
        security_token: st,
        expires_at: data.result.expiration ?? data.result.expiresAt ?? '',
      }
    }
  }
  return null
}

/** 凭据的过期时间戳（毫秒）；时间戳无法解析时回退为 +24 小时。 */
export function expiresFromCredential(credential: CodeArtsCredential): number {
  if (credential.expires_at) {
    const parsed = Date.parse(credential.expires_at)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now() + 86_400_000
}

/**
 * 轮询 ticket 端点，直到收到完整凭据或尝试
 * 次数耗尽。瞬时失败会被跳过，不会视为致命错误。
 */
export async function pollForCredential(
  ticketId: string,
  secret: string,
  options: { fetcher?: typeof fetch; maxAttempts?: number; pluginName?: string; pluginVersion?: string } = {},
): Promise<CodeArtsCredential> {
  const fetcher = options.fetcher ?? createDomesticFetch()
  const maxAttempts = options.maxAttempts ?? 120
  const pluginName = options.pluginName ?? PLUGIN_NAME
  const pluginVersion = options.pluginVersion ?? PLUGIN_VERSION
  const url = `${CREDENTIAL_ENDPOINT}?ticket_id=${encodeURIComponent(ticketId)}&secret=${encodeURIComponent(secret)}`
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json;charset=UTF-8',
          'plugin-name': pluginName,
          'plugin-version': pluginVersion,
        },
      })
    } catch {
      continue
    }
    if (!response.ok) continue
    let data: CodeArtsCredentialResponse | null
    try {
      data = (await response.json()) as CodeArtsCredentialResponse
    } catch {
      continue
    }
    const credential = data ? parseCredentialResponse(data) : null
    if (credential) return credential
  }
  throw new Error('CodeArts login timed out')
}

/**
 * 使用平台默认打开器打开 URL；永不抛出异常。
 *
 * ⚠️ **「永不抛出」必须靠 `'error'` 监听器兑现**（真实缺陷，2026-10-03）。
 *
 * `spawn` 的失败（`ENOENT` / `EACCES`）是以**异步 `'error'` 事件**上报的，
 * 外层 `try/catch` **接不住**它。而 `ChildProcess` 是 EventEmitter ——
 * `'error'` 没有监听器时会被 `throw` 成**未捕获异常**。
 *
 * POSIX 上这很容易踩：无桌面环境的 `open`（macOS）/ `xdg-open`（Linux）
 * 常常不存在 ⇒ `ENOENT` ⇒ **直接把宿主进程带走**。
 * （Windows 的 `cmd` 恒存在，所以只在 POSIX 上暴露 —— 典型的「本地测不出来」。）
 *
 * ⚠️ 用 `child.unref()` + 监听器，不能只 `unref` 就完事：前者让父进程
 * 不因它挂起，后者补上缺失的监听器，二者缺一不可。
 */
export function openBrowser(url: string): void {
  const warn = (error: unknown): void => {
    console.error('[codearts-auth] failed to open browser; open manually:', url, error)
  }
  const win = process.platform === 'win32'
  if (win) {
    // Windows 下 cmd /c start 会把 URL 中每个 '&' 当作命令分隔符，导致参数被截断
    // （浏览器只收到 '?theme=2'）。必须把整个 URL 加引号作为单个参数传给 cmd，
    // 并用 windowsVerbatimArguments 关闭 Node 的二次转义。start 的窗口标题参数
    // 必须显式传 '""'——空字符串参数会被 Node 丢弃，start 会把 URL 当成标题。
    const args = ['/c', 'start', '""', `"${url}"`]
    try {
      const child = spawn('cmd', args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: true })
      child.on('error', warn)
      child.unref()
      return
    } catch (error) {
      warn(error)
      return
    }
  }
  const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' })
    child.on('error', warn)
    child.unref()
  } catch (error) {
    warn(error)
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
}

function pickToken(params: URLSearchParams): string {
  return params.get('token')
    ?? params.get('access_token')
    ?? params.get('accessToken')
    ?? params.get('authCode')
    ?? ''
}

/** 浏览器重定向的本地回调服务器；当某个分支完成时 resolve `result`。 */
export function startCallbackServer(
  ticketId: string,
  secret: string,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== '/authentication' && !url.pathname.startsWith('/authentication')) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    const params = url.searchParams
    const directToken = pickToken(params)
    if (directToken) {
      response.writeHead(200, CORS_HEADERS).end()
      resolveResult({ access: directToken, expires: Date.now() + 86_400_000, loginUrl: '' })
      return
    }
    const fingerprint = params.get('fingerprint')
    if (fingerprint) {
      try {
        const decoded = Buffer.from(fingerprint, 'base64').toString()
        const fpToken = pickToken(new URL(decoded).searchParams)
        if (fpToken) {
          response.writeHead(200, CORS_HEADERS).end()
          resolveResult({ access: fpToken, expires: Date.now() + 86_400_000, loginUrl: '' })
          return
        }
      } catch {
        /* fingerprint 格式错误：继续到 400 */
      }
    }
    const callbackSecret = params.get('secret')
    if (callbackSecret) {
      response.writeHead(200, CORS_HEADERS).end()
      void pollForCredential(ticketId, callbackSecret, options).then(
        (credential) => resolveResult({
          access: JSON.stringify(credential),
          expires: expiresFromCredential(credential),
          loginUrl: '',
        }),
        (error) => rejectResult(error),
      )
      return
    }
    response.writeHead(400).end('Missing token or secret')
  })

  return new Promise((resolveStart, rejectStart) => {
    server.on('error', (error) => rejectStart(error))
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveStart({ port, server, result })
    })
  })
}

/** 运行完整的浏览器登录流程，返回已存储的凭据值。 */
export async function runLoginFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const ticketId = randomUUID()
  const secret = generateRandomSecret()
  const { port, server, result } = await startCallbackServer(ticketId, secret, options)
  const { loginUrl } = buildLoginUrl(port, ticketId)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(loginUrl)
    const outcome = await result
    return { ...outcome, loginUrl }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** 新式 IAM OAuth 的 portal 授权端点（对齐真实插件的 getPortalHost + /authorize）。 */
export const PORTAL_AUTHORIZE_BASE = 'https://codearts.huaweicloud.com/portal/authorize'
/** portal 登录结果页（登录完成后重定向目标，对齐真实插件回调处理器的 login_succeed 页）。 */
export const PORTAL_LOGIN_BASE = 'https://codearts.huaweicloud.com/portal/login'

/** 构建 portal 登录结果页 URL（真实插件在回调成功后 307 重定向到此页）。 */
export function buildPortalLoginResultUrl(succeeded: boolean): string {
  return `${PORTAL_LOGIN_BASE}?login_succeed=${succeeded}&uri_scheme=${CLIENT_ID}&locale=${OAUTH_LOCALE}`
}
/** portal 期望的插件名（逆向常量，硬编码）。 */
export const LOGIN_PLUGIN_NAME = 'snap_AIIDE'
/** portal 期望的插件版本（逆向常量，硬编码为真实扩展版本，勿用本包版本）。 */
export const LOGIN_PLUGIN_VERSION = '5.2.0'
/** 主题色 kind（对齐 IDE 的 activeColorTheme.kind：2 = Dark）。 */
export const OAUTH_THEME = '2'
/** 界面语言（对齐 env.language）。 */
export const OAUTH_LOCALE = 'zh-cn'

/** 构建新式 IAM OAuth 的 portal 授权 URL（参数完全对齐真实插件 buildLoginUrl）。 */
export function buildOAuthLoginUrl(port: number, pkce: PkcePair, ticketId: string): string {
  return `${PORTAL_AUTHORIZE_BASE}?theme=${OAUTH_THEME}&locale=${OAUTH_LOCALE}`
    + `&uri_scheme=${CLIENT_ID}&client_id=${CLIENT_ID}&port=${port}`
    // code_challenge_method 对齐真实插件 PKCEGenerator.CODE_CHALLENGE_METHOD = "SHA-256"
    // （非 RFC 标准缩写 S256；portal 以此识别 OAuth 授权，错值会回退旧 ticket 流程）。
    + `&code_challenge=${pkce.codeChallenge}&code_challenge_method=SHA-256`
    // 注意：真实插件 URL 不含 auth_callback_url——portal 仅凭 port 参数构造回调。
    // 多余的 auth_callback_url 会被 portal 视为异常并回退旧流程，切勿添加。
    + `&ticket_id=${ticketId}&plugin-name=${LOGIN_PLUGIN_NAME}&plugin-version=${LOGIN_PLUGIN_VERSION}`
}

/** 新式 OAuth 的本地回调服务器：收到 code（新流程）或 secret（旧流程回退）后换取凭据并 resolve。 */
export function startOAuthCallbackServer(
  ticketId: string,
  pkce: PkcePair,
  keyPair: DpopKeyPair,
  options: LoginFlowOptions,
): Promise<{ port: number; server: ReturnType<typeof createServer>; result: Promise<LoginFlowResult> }> {
  let resolveResult!: (value: LoginFlowResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoginFlowResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort}`)
    if (url.pathname !== REDIRECT_PATH && !url.pathname.startsWith(REDIRECT_PATH)) {
      response.writeHead(404).end('Not found')
      return
    }
    if (request.method === 'OPTIONS') {
      response.writeHead(204, CORS_HEADERS).end()
      return
    }
    // 旧流程回退：portal 判定 OAuth 授权不可用时以 secret+redirect 回调。
    // 对齐真实插件：立即 307 重定向到 redirect 参数，后台轮询 ticket 端点换取凭据。
    const callbackSecret = url.searchParams.get('secret')
    if (callbackSecret) {
      const redirectTo = url.searchParams.get('redirect') ?? buildPortalLoginResultUrl(true)
      response.writeHead(307, { ...CORS_HEADERS, Location: redirectTo }).end()
      void pollForCredential(ticketId, callbackSecret, {
        ...options,
        pluginName: LOGIN_PLUGIN_NAME,
        pluginVersion: LOGIN_PLUGIN_VERSION,
      }).then(
        (credential) => resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' }),
        (error) => rejectResult(error),
      )
      return
    }
    const code = url.searchParams.get('code')
    if (code) {
      // localPort 在监听中的服务器上必然存在；?? 0 仅用于类型收窄。
      void exchangeAuthorizationCode(code, pkce.codeVerifier, request.socket.localPort ?? 0, keyPair, options.fetcher).then(
        (token) => {
          const credential = credentialFromTokenResponse(token, pkce, keyPair)
          // 对齐真实插件：换取成功后 307 重定向浏览器到 portal 登录结果页。
          response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(true) }).end()
          resolveResult({ access: JSON.stringify(credential), expires: expiresFromCredential(credential), loginUrl: '' })
        },
        (error) => {
          response.writeHead(307, { ...CORS_HEADERS, Location: buildPortalLoginResultUrl(false) }).end()
          rejectResult(error)
        },
      )
      return
    }
    response.writeHead(400).end('Missing authorization code or secret')
  })

  return listenOnCallbackPort(server).then((port) => ({ port, server, result }))
}

/** 新式 OAuth 回调等待预算（浏览器打开 + 用户操作，180 秒）。 */
const OAUTH_CALLBACK_TIMEOUT_MS = 180_000
/** 回调端口下限（对齐真实插件对回调端口的 ≥10000 要求）。 */
const MIN_CALLBACK_PORT = 10_000

/** 启动回调服务器并确保监听端口 ≥10000（真实插件要求，低端口会被 portal 拒绝）。 */
function listenOnCallbackPort(
  server: ReturnType<typeof createServer>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryListen = (port: number) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        const address = server.address()
        const assigned = typeof address === 'object' && address ? address.port : 0
        if (assigned >= MIN_CALLBACK_PORT) {
          resolve(assigned)
          return
        }
        // 端口 < 10000：关闭后用随机 [10000, 65535] 端口重试（对齐真实插件）。
        server.close(() => {
          const retry = Math.floor(Math.random() * (65_536 - MIN_CALLBACK_PORT)) + MIN_CALLBACK_PORT
          tryListen(retry)
        })
      })
    }
    tryListen(0)
  })
}

/**
 * 已启动但尚未完成的 OAuth 登录流程。
 *
 * 拆出这一层是为了支持**两步式登录**（Channel Pack 的「+ 新建账号」）：
 * 调用方先拿到 `loginUrl` 立刻打开窗口，再自行 await `result`。
 *
 * 为什么必须拆：浏览器只在用户点击后的短暂窗口（transient activation，
 * 约 5 秒）内允许 `window.open`。若把「起服务器 → 打开浏览器 → 等用户授权」
 * 整个流程做成一次阻塞调用，调用方拿到 URL 时手势早已过期，`window.open`
 * 会被弹窗拦截器拒绝。
 */
export interface StartedOAuthFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<LoginFlowResult>
  /** 关闭回调服务器；**幂等**，可重复调用。 */
  close: () => Promise<void>
}

/**
 * 启动 OAuth 登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * `result` 已内置超时：两步式路径没有外层 try/finally 兜底，
 * 若超时不在此处生效，回调服务器会一直挂着。
 * 结果一旦落定就自动关闭服务器，避免两步式路径泄漏监听端口。
 */
export async function startOAuthFlow(options: LoginFlowOptions = {}): Promise<StartedOAuthFlow> {
  const ticketId = randomBytes(32).toString('hex')
  const pkce = generatePkcePair()
  const keyPair = await generateDpopKeyPair()
  const { port, server, result } = await startOAuthCallbackServer(ticketId, pkce, keyPair, options)
  const loginUrl = buildOAuthLoginUrl(port, pkce, ticketId)

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const resultWithUrl = Promise.race([
    result,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('CodeArts OAuth login timed out')), OAUTH_CALLBACK_TIMEOUT_MS)
      timer.unref?.()
    }),
  ]).then((outcome) => ({ ...outcome, loginUrl }))

  // 先挂一个空处理器：结果可能在调用方 await 之前就落定（用户授权极快、
  // 或立刻超时），那一段窗口里 Node 会把它当成未处理拒绝并打印告警。
  resultWithUrl.catch(() => {}).finally(() => { void close() })

  return { loginUrl, result: resultWithUrl, close }
}

/**
 * 运行完整的新式 IAM OAuth 登录流程（默认登录方式）。
 *
 * 阻塞语义：打开浏览器并等待用户完成授权后才返回。
 * 需要「立即拿到 URL」的场景（Channel Pack 两步式登录）请用 {@link startOAuthFlow}。
 */
export async function runOAuthFlow(options: LoginFlowOptions = {}): Promise<LoginFlowResult> {
  const started = await startOAuthFlow(options)
  try {
    const opener = options.openBrowser ?? openBrowser
    await opener(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}
