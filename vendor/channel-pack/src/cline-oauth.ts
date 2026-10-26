/**
 * Cline 登录流程（**WorkOS 设备码轮询**）。
 *
 * ## 与其它 provider 的差异
 *
 * Cline 官方桌面端在 prod 下走的就是设备码分支
 * （源码 `loginClineOAuth` → `useWorkOSDeviceAuth ?? true`），
 * 与「本地回调 + 端口 48801-48811」那条分支并存。本插件只实现前者：
 * 不起监听端口，也就没有端口占用与回调伪造问题。
 *
 * ## 三步协议（全部实测，2026-09-25）
 *
 * ```
 * 1) POST {workOsBase}/user_management/authorize/device
 *      Content-Type: application/x-www-form-urlencoded
 *      body: client_id=<workOsClientId>
 *   → { device_code, user_code, verification_uri, verification_uri_complete,
 *       expires_in, interval }
 *
 * 2) 轮询 POST {workOsBase}/user_management/authenticate
 *      body: grant_type=urn:ietf:params:oauth:grant-type:device_code
 *            &device_code=<device_code>&client_id=<workOsClientId>
 *   → 200 { access_token, refresh_token, token_type }
 *   → 错误体 { error: "authorization_pending" | "slow_down" | … }
 *
 * 3) POST {apiBase}/api/v1/auth/register
 *      Content-Type: application/json
 *      body: { accessToken, refreshToken }
 *   → { success: true, data: { accessToken, refreshToken, expiresAt,
 *                              tokenType, userInfo: { clineUserId, email, … } } }
 * ```
 *
 * ⚠️ **`authorization_pending` 不是错误**，必须继续轮询 —— 它与 Qoder 的
 * 「404 表示用户尚未完成授权」是同一类语义，但**判据形态完全不同**
 * （Qoder 看 HTTP 状态码，Cline 看响应体的 `error` 字段且状态码可能非 2xx）。
 * 早期若按状态码判失败，会把「用户还没点授权」误报成登录失败。
 *
 * ⚠️ **`slow_down` 必须真的退避**（源码 `intervalSeconds += 1`），
 * 否则会被 WorkOS 持续限流。
 *
 * ## 两步式的必要性
 *
 * 故提供 {@link startClineLoginFlow} 立即返回 URL，由前端先开窗再等结果。
 */

import {
  buildClineCredential,
  isClineRefreshable,
  parseClineTokenPayload,
  clineCredentialExpiresAtMs,
  type ClineCredential,
} from './cline.js'
import {
  CLINE_DEVICE_AUTHENTICATE_PATH,
  CLINE_DEVICE_AUTHORIZATION_PATH,
  CLINE_REGISTER_PATH,
  type ClineProduct,
} from './cline-product.js'

/** 在浏览器中打开 URL；永不抛出。 */
export type OpenBrowser = (url: string) => void | Promise<void>

/** 单次 HTTP 请求超时（毫秒；对齐源码 `DEFAULT_HTTP_TIMEOUT_MS`）。 */
export const CLINE_HTTP_TIMEOUT_MS = 30_000

/** 设备码默认有效期（毫秒；对齐源码 `DEFAULT_DEVICE_AUTH_EXPIRES_IN_SECONDS = 300`）。 */
export const CLINE_DEVICE_AUTH_EXPIRES_MS = 300_000

/** 设备码默认轮询间隔（毫秒；对齐源码 `DEFAULT_DEVICE_AUTH_INTERVAL_SECONDS = 5`）。 */
export const CLINE_DEVICE_AUTH_INTERVAL_MS = 5_000

/** 连续网络失败多少次后放弃轮询。 */
export const CLINE_POLL_MAX_FAILURES = 5

/** WorkOS 设备码授权响应（已归一化）。 */
export interface ClineDeviceAuthorization {
  deviceCode: string
  userCode: string
  verificationUri: string
  /** 带 `user_code` 的完整 URL（有则优先用它，用户少一步输入）。 */
  verificationUriComplete?: string
  expiresInMs: number
  intervalMs: number
}

/** 一次登录流程的结果。 */
export interface ClineLoginFlowResult {
  /** 已序列化的 `ClineCredential` JSON 字符串（直接存入 ctx.credentials）。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
  /** 设备码流程里的用户码（供 UI 提示「在浏览器里输入 XXXX」）。 */
  userCode?: string
}

/** {@link startClineLoginFlow} 接受的选项。 */
export interface ClineLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 打开登录 URL 的方式；默认用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 登录等待总超时（毫秒）；默认取设备码响应的 `expires_in`。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）；默认取设备码响应的 `interval`。 */
  pollIntervalMs?: number
  /** 外部取消信号。 */
  signal?: AbortSignal
  /** 产品配置。 */
  product: ClineProduct
}

/** 睡眠（可被 signal 中断）。 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('登录已取消'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('登录已取消'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 是否已取消。
 *
 * 抽成函数而非内联 `signal?.aborted === true`：TS 的控制流分析会把
 * 「循环开头检查过、为假才进入 try」这一事实带进 catch 块，从而认定
 * catch 里的同一个比较**恒为假**（报 TS2367 no overlap）。
 * 但运行时 signal 完全可能在 `await` 期间被 abort —— 用函数调用切断
 * 这条收窄路径，既让类型检查通过，也保留了「await 后重新确认」的正确语义。
 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true
}

/** 本模块自身抛出的确定性错误前缀（用于与网络错误区分）。 */
const SERVER_ERROR_PREFIX = '登录服务返回异常'

/** 把秒归一为毫秒；非法值回退到默认。 */
function toMs(value: unknown, fallbackMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallbackMs
  return Math.floor(value) * 1000
}

/**
 * 请求设备码授权。
 *
 * 实测响应字段：`device_code` / `user_code` / `verification_uri` /
 * `verification_uri_complete` / `expires_in` / `interval`。
 * 缺 `device_code` / `user_code` / `verification_uri` 任一即视为无效响应
 * （源码同样三字段齐备才通过）。
 */
export async function requestClineDeviceAuthorization(
  product: ClineProduct,
  options: { fetcher?: typeof fetch; signal?: AbortSignal } = {},
): Promise<ClineDeviceAuthorization> {
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(`${product.workOsBase}${CLINE_DEVICE_AUTHORIZATION_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: product.workOsClientId }).toString(),
    signal: options.signal ?? AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof payload.error_description === 'string' ? ` - ${payload.error_description}` : ''
    throw new Error(`${SERVER_ERROR_PREFIX}：设备码授权失败（HTTP ${response.status}）${detail}`)
  }
  const deviceCode = typeof payload.device_code === 'string' ? payload.device_code : ''
  const userCode = typeof payload.user_code === 'string' ? payload.user_code : ''
  const verificationUri = typeof payload.verification_uri === 'string' ? payload.verification_uri : ''
  if (deviceCode.length === 0 || userCode.length === 0 || verificationUri.length === 0) {
    throw new Error(`${SERVER_ERROR_PREFIX}：设备码授权响应缺少必要字段`)
  }
  const verificationUriComplete = typeof payload.verification_uri_complete === 'string'
    && payload.verification_uri_complete.length > 0
    ? payload.verification_uri_complete
    : undefined
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...verificationUriComplete === undefined ? {} : { verificationUriComplete },
    expiresInMs: toMs(payload.expires_in, CLINE_DEVICE_AUTH_EXPIRES_MS),
    intervalMs: toMs(payload.interval, CLINE_DEVICE_AUTH_INTERVAL_MS),
  }
}

/**
 * 轮询直到用户完成授权并拿到 WorkOS token。
 *
 * **`authorization_pending` 表示「用户尚未完成授权」，必须继续轮询**
 * （与 Qoder 的「404 表示尚未授权」同型，但判据是响应体的 `error` 字段）。
 *
 * 状态机（对齐源码 `pollWorkOSTokens`）：
 * - `authorization_pending` → 按 interval 继续；
 * - `slow_down` → interval **+1 秒**后继续（必须真退避）；
 * - `access_denied` / `expired_token` / `invalid_grant` → 终态失败；
 * - 其它非 2xx → 终态失败；
 * - 网络失败容忍 {@link CLINE_POLL_MAX_FAILURES} 次连续失败。
 *
 * ⚠️ **`slow_down` 的退避必须累积**：源码是 `intervalSeconds += 1` 而非重置，
 * 用固定间隔会在服务端要求降速后持续被限流。
 */
export async function pollClineWorkOsTokens(
  authorization: ClineDeviceAuthorization,
  options: ClineLoginFlowOptions,
): Promise<{ accessToken: string; refreshToken: string }> {
  const fetcher = options.fetcher ?? fetch
  const deadline = Date.now() + (options.timeoutMs ?? authorization.expiresInMs)
  // ⚠️ 至少 1 秒：服务端可能下发 0 或负数，无节制的轮询会被限流。
  let intervalMs = Math.max(1_000, options.pollIntervalMs ?? authorization.intervalMs)
  let failures = 0

  while (Date.now() <= deadline) {
    if (isAborted(options.signal)) throw new Error('登录已取消')
    try {
      const response = await fetcher(`${options.product.workOsBase}${CLINE_DEVICE_AUTHENTICATE_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: authorization.deviceCode,
          client_id: options.product.workOsClientId,
        }).toString(),
        signal: options.signal ?? AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
      })
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>
      failures = 0

      if (response.ok) {
        const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
        const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : ''
        if (accessToken.length === 0 || refreshToken.length === 0) {
          // 2xx 但缺 token：视为服务端异常（不是「等用户」），避免死循环。
          throw new Error(`${SERVER_ERROR_PREFIX}：WorkOS token 响应缺少必要字段`)
        }
        return { accessToken, refreshToken }
      }

      const errorCode = typeof payload.error === 'string' ? payload.error : ''
      switch (errorCode) {
        case 'authorization_pending': {
          // ⚠️ **不是错误**：用户还没在浏览器里点授权。继续轮询。
          await sleep(intervalMs, options.signal)
          continue
        }
        case 'slow_down': {
          // 服务端要求降速：累积退避 1 秒后继续（源码 `intervalSeconds += 1`）。
          intervalMs += 1_000
          await sleep(intervalMs, options.signal)
          continue
        }
        case 'access_denied':
        case 'expired_token':
        case 'invalid_grant': {
          const detail = typeof payload.error_description === 'string'
            ? payload.error_description
            : 'WorkOS 授权失败'
          throw new Error(`${SERVER_ERROR_PREFIX}：${detail}`)
        }
        default: {
          const detail = typeof payload.error_description === 'string' ? ` - ${payload.error_description}` : ''
          throw new Error(`${SERVER_ERROR_PREFIX}：WorkOS token 轮询失败（HTTP ${response.status}）${detail}`)
        }
      }
    } catch (error) {
      if (isAborted(options.signal)) throw new Error('登录已取消')
      // 本函数自己抛的确定性错误直接冒泡，不计入网络失败次数。
      if (error instanceof Error && error.message.startsWith(SERVER_ERROR_PREFIX)) throw error
      failures += 1
      if (failures >= CLINE_POLL_MAX_FAILURES) {
        throw new Error(
          `无法连接 Cline 登录服务（连续 ${failures} 次失败）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
      await sleep(intervalMs, options.signal)
    }
  }
  throw new Error('登录等待已超时，请重新发起登录')
}

/**
 * 用 WorkOS token 换取 Cline 自己的 token（`/api/v1/auth/register`）。
 *
 * ⚠️ 请求体字段是**驼峰** `accessToken` / `refreshToken`。
 * 响应套 `{success, data}` 信封，解析交给 `parseClineTokenPayload`。
 */
export async function registerClineTokens(
  workOsTokens: { accessToken: string; refreshToken: string },
  options: ClineLoginFlowOptions,
): Promise<unknown> {
  const fetcher = options.fetcher ?? fetch
  const response = await fetcher(`${options.product.apiBase}${CLINE_REGISTER_PATH}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...options.product.clientHeaders,
    },
    body: JSON.stringify({
      accessToken: workOsTokens.accessToken,
      refreshToken: workOsTokens.refreshToken,
    }),
    signal: options.signal ?? AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
  })
  const payload = await response.json().catch(() => ({})) as Record<string, unknown>
  if (!response.ok) {
    const detail = typeof payload.error === 'string' ? ` - ${payload.error}` : ''
    throw new Error(`${SERVER_ERROR_PREFIX}：token 注册失败（HTTP ${response.status}）${detail}`)
  }
  return payload
}

/** 把凭据包成一次登录流程的结果。 */
function toLoginFlowResult(
  credential: ClineCredential,
  loginUrl: string,
  userCode: string | undefined,
): ClineLoginFlowResult {
  return {
    access: JSON.stringify(credential),
    // 与其它 provider 一致：无法解析过期时间时报 0，而不是抛错 ——
    // 凭据本身可用（只是有效期未知），不该因展示层缺失而登录失败。
    expires: clineCredentialExpiresAtMs(credential) ?? 0,
    loginUrl,
    refreshable: isClineRefreshable(credential),
    ...userCode === undefined ? {} : { userCode },
  }
}

async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./open-browser.js')
  openBrowser(url)
}

/** 已启动但尚未完成的登录流程（两步式登录用）。 */
export interface StartedClineLoginFlow {
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 设备码流程的用户码（UI 可提示用户输入）。 */
  userCode?: string
  /** 用户完成授权（或超时/失败）后落定的结果。 */
  result: Promise<ClineLoginFlowResult>
  /** 取消登录（中止轮询）；**幂等**。 */
  close: () => Promise<void>
}

/**
 * 启动登录流程并**立即返回**登录 URL（不打开浏览器、不等用户）。
 *
 * 设备码流程天然是「先拿 URL → 打开 → 后台轮询」，故无需起服务器，
 * 也没有端口可泄漏。`close()` 通过 abort 取消轮询。
 *
 * ⚠️ 设备码授权请求本身是**网络调用**，必须先 await 它拿到 URL 才能返回 ——
 * 但那只是一次快速的 POST，不涉及用户等待，仍能满足「立即返回 URL」
 * 对浏览器手势窗口的要求（与 Qoder 的纯本地 URL 构造略有不同，
 * 故这里把超时压到 {@link CLINE_HTTP_TIMEOUT_MS}）。
 */
export async function startClineLoginFlow(
  options: ClineLoginFlowOptions,
): Promise<StartedClineLoginFlow> {
  const controller = new AbortController()
  const signal = options.signal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, options.signal])

  const authorization = await requestClineDeviceAuthorization(options.product, {
    ...options.fetcher === undefined ? {} : { fetcher: options.fetcher },
    signal,
  })
  // 有 `verification_uri_complete` 时优先用它：用户不必再手输 user_code。
  const loginUrl = authorization.verificationUriComplete ?? authorization.verificationUri

  const result = (async (): Promise<ClineLoginFlowResult> => {
    const workOsTokens = await pollClineWorkOsTokens(authorization, { ...options, signal })
    const registered = await registerClineTokens(workOsTokens, { ...options, signal })
    const payload = parseClineTokenPayload(registered)
    if (payload.accessToken.length === 0) {
      throw new Error('登录响应缺少访问令牌')
    }
    // ⚠️ 注册响应里的 `accessToken` **自带 `workos:` 前缀**（源码
    // `toClineCredentials` 直接 `access = responseData.accessToken`，
    // 而官方磁盘存储值带前缀）。`buildClineCredential` 内部会幂等补齐，
    // 故这里无论服务端是否带前缀都能得到正确形态。
    const credential = buildClineCredential(payload, options.product)
    return toLoginFlowResult(credential, loginUrl, authorization.userCode)
  })()
  // 这个 Promise 是手工创建的、要过一会儿才交给调用方消费，
  // 期间可能已被 reject（如轮询立刻失败）。先挂空处理器避免
  // Node 报「未处理的拒绝」，不影响后续消费者拿到同一拒绝原因。
  result.catch(() => {})

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    controller.abort()
  }

  return {
    loginUrl,
    ...authorization.userCode.length === 0 ? {} : { userCode: authorization.userCode },
    result,
    close,
  }
}

/**
 * 运行完整登录流程：打开授权页 → 轮询 → 返回凭据。
 *
 * 阻塞语义：等用户完成授权后才返回。需要「立即拿到 URL」的场景
 * （Channel Pack 两步式登录）请用 {@link startClineLoginFlow}。
 */
export async function runClineLoginFlow(
  options: ClineLoginFlowOptions,
): Promise<ClineLoginFlowResult> {
  const open: OpenBrowser = options.openBrowser ?? defaultOpenBrowser
  const started = await startClineLoginFlow(options)
  try {
    await open(started.loginUrl)
    return await started.result
  } finally {
    await started.close()
  }
}
