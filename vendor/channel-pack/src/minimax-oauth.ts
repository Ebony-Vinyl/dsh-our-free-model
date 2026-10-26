/**
 * MiniMax Code 的 OAuth **设备码 + PKCE** 登录流程。
 *
 * ## 为什么用设备码而不是本地回调
 *
 * ## ⚠️ 最容易踩的坑：`pending` 是 **HTTP 200**
 *
 * OAuth 标准的设备码轮询用 **400 + `error=authorization_pending`** 表示「还在等」，
 * 而 MiniMax 的账号服务用 **200 + `status=pending`**。
 * 只认标准形态会**立刻抛错**，用户来不及授权。
 * 故**两种形态都必须认**（asar `oauth-client.js:70-114` 也是分开处理的）。
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  MINIMAX,
  MINIMAX_DEVICE_CODE_PATH,
  MINIMAX_OAUTH_TIMEOUT_MS,
  MINIMAX_TOKEN_PATH,
  type MinimaxProduct,
} from './minimax-product.js'
import {
  decodeJwtExpMs,
  decodeJwtSub,
  type MinimaxCredential,
} from './minimax.js'

/** 用户拒绝授权。 */
export class MinimaxLoginCancelledError extends Error {
  constructor(message = '用户取消了 MiniMax 授权') {
    super(message)
    this.name = 'MinimaxLoginCancelledError'
  }
}

/** 设备码过期。 */
export class MinimaxLoginExpiredError extends Error {
  constructor(message = 'MiniMax 设备码已过期，请重新登录') {
    super(message)
    this.name = 'MinimaxLoginExpiredError'
  }
}

/** 设备码授权会话。 */
export interface MinimaxDeviceAuthorization {
  deviceCode: string
  codeVerifier: string
  userCode: string
  verificationUri: string
  /** 含 `user_code` 的完整授权链接（**优先用它**，用户点开即完成）。 */
  verificationUriComplete: string
  expiresInSec: number
  /** ⚠️ 单位是**秒**（asar 里有一处 `/1000` 换算，仅用于 `user_code` 轮询分支）。 */
  intervalSec: number
}

/** 读非空字符串。 */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/** 读正数。 */
function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 构造设备码请求体（PKCE S256）。 */
export function buildMinimaxDeviceCodeBody(
  codeChallenge: string,
  product: MinimaxProduct = MINIMAX,
): URLSearchParams {
  return new URLSearchParams({
    client_id: product.clientId,
    scope: product.scope,
    audience: product.audience,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
}

/** 构造轮询请求体。 */
export function buildMinimaxPollBody(
  auth: MinimaxDeviceAuthorization,
  product: MinimaxProduct = MINIMAX,
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: auth.deviceCode,
    client_id: product.clientId,
    code_verifier: auth.codeVerifier,
  })
}

/** 构造续期请求体。 */
export function buildMinimaxRefreshBody(
  refreshToken: string,
  product: MinimaxProduct = MINIMAX,
): URLSearchParams {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: product.clientId,
    scope: product.scope,
    audience: product.audience,
  })
}

/** 解析设备码响应；形状不对返回 undefined。 */
export function parseMinimaxDeviceAuthorization(
  payload: unknown,
): MinimaxDeviceAuthorization | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined
  const record = payload as Record<string, unknown>
  const deviceCode = nonEmptyString(record.device_code)
  const userCode = nonEmptyString(record.user_code)
  const verificationUri = nonEmptyString(record.verification_uri)
    ?? nonEmptyString(record.verification_url)
  const expiresInSec = positiveNumber(record.expires_in)
  if (deviceCode === undefined || userCode === undefined
    || verificationUri === undefined || expiresInSec === undefined) {
    return undefined
  }
  // ⚠️ interval 单位是**秒**；缺省 5 秒（照 asar 的默认值）
  const intervalSec = positiveNumber(record.interval) ?? 5
  return {
    deviceCode,
    codeVerifier: '',
    userCode,
    verificationUri,
    verificationUriComplete: nonEmptyString(record.verification_uri_complete) ?? verificationUri,
    expiresInSec,
    intervalSec,
  }
}

/**
 * 解析令牌响应（轮询与续期共用）。
 *
 * 硬校验（照 asar `parseTokenGrant`，不满足即抛）：
 * - `access_token` 非空
 * - `refresh_token` 非空（缺失时回退上一个）
 * - `token_type.toLowerCase() === 'bearer'`
 * - `expires_in` 是正数
 * - **`scope` 必须含产品声明的 scope**（默认 `agent.default`）
 */
export function parseMinimaxTokenGrant(
  payload: unknown,
  previousRefreshToken?: string,
  product: MinimaxProduct = MINIMAX,
): MinimaxCredential {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error('MiniMax 令牌响应不是对象')
  }
  const record = payload as Record<string, unknown>
  const accessToken = nonEmptyString(record.access_token)
  const refreshToken = nonEmptyString(record.refresh_token) ?? previousRefreshToken
  const tokenType = nonEmptyString(record.token_type)
  const expiresInSec = positiveNumber(record.expires_in)
  if (accessToken === undefined) throw new Error('MiniMax 令牌响应缺少 access_token')
  if (refreshToken === undefined) throw new Error('MiniMax 令牌响应缺少 refresh_token')
  if (tokenType === undefined || tokenType.toLowerCase() !== 'bearer') {
    throw new Error('MiniMax 令牌响应的 token_type 不是 Bearer')
  }
  if (expiresInSec === undefined) throw new Error('MiniMax 令牌响应缺少 expires_in')

  const rawScope = record.scope
  const scope = typeof rawScope === 'string' ? rawScope : ''
  // ⚠️ 客户端权威实现要求 scope 含 agent.default；不含即视为无效凭据
  if (!scope.split(/\s+/u).filter(Boolean).includes(product.scope)) {
    throw new Error(`MiniMax 令牌响应的 scope 不含 ${product.scope}`)
  }

  // ⚠️ **过期时间以 `expires_in` 为准，不能指望从 token 里解** ——
  // 实测 access_token **不是 JWT**（`mmoat_` 前缀、60 字符、0 个点）。
  // 若这里改成「优先解 JWT」并在解不出时**不写** `expires_at`，
  // 过期时间会彻底丢失、账号永远显示「未知」。
  const expiresAt = Date.now() + expiresInSec * 1000
  // JWT 路径仅作兜底兼容（上游将来改发 JWT 时用），当前恒不命中。
  const fromJwt = decodeJwtExpMs(accessToken)
  const accountId = decodeJwtSub(accessToken)

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: 'Bearer',
    expires_at: String(fromJwt ?? expiresAt),
    scope,
    ...accountId === undefined ? {} : { account_id: accountId },
  }
}

/** 生成 PKCE code_verifier / code_challenge。 */
export function createMinimaxPkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = randomBytes(32).toString('base64url')
  const codeChallenge = createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
  return { codeVerifier, codeChallenge }
}

/** 申请设备码。 */
export async function startMinimaxDeviceAuthorization(
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
): Promise<MinimaxDeviceAuthorization> {
  const pkce = createMinimaxPkce()
  const response = await fetcher(`${product.accountHost}${MINIMAX_DEVICE_CODE_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: buildMinimaxDeviceCodeBody(pkce.codeChallenge, product),
    signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new Error(`MiniMax 设备码申请失败（HTTP ${response.status}）`)
  }
  const parsed = parseMinimaxDeviceAuthorization(await response.json().catch(() => undefined))
  if (parsed === undefined) throw new Error('MiniMax 设备码响应无法解析')
  return { ...parsed, codeVerifier: pkce.codeVerifier }
}

/** 轮询选项。 */
export interface PollMinimaxOptions {
  fetcher?: typeof fetch
  /** 可注入的 sleep（测试用）。 */
  sleep?: (ms: number) => Promise<void>
  /** 可注入的时钟（测试用）。 */
  now?: () => number
  signal?: AbortSignal
  product?: MinimaxProduct
}

/**
 * 轮询直到拿到令牌。
 *
 * ⚠️ **两种「还在等」的形态都要认**（见文件头注释）。
 */
export async function pollMinimaxDeviceToken(
  auth: MinimaxDeviceAuthorization,
  options: PollMinimaxOptions = {},
): Promise<MinimaxCredential> {
  const fetcher = options.fetcher ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? Date.now
  const product = options.product ?? MINIMAX
  const deadline = now() + auth.expiresInSec * 1000
  let intervalMs = auth.intervalSec * 1000

  while (now() < deadline) {
    options.signal?.throwIfAborted()
    const response = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: buildMinimaxPollBody(auth, product),
      signal: options.signal ?? AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
    })
    const body: unknown = await response.json().catch(() => undefined)
    const record = typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : {}
    const status = nonEmptyString(record.status)
    const error = nonEmptyString(record.error)

    // ⚠️ 形态一：HTTP 200 + status
    if (response.ok && status === 'pending') {
      await sleep(intervalMs)
      continue
    }
    if (response.ok && status === 'slow_down') {
      intervalMs += 5000
      await sleep(intervalMs)
      continue
    }
    if (response.ok && (status === 'denied' || status === 'access_denied')) {
      throw new MinimaxLoginCancelledError()
    }
    if (response.ok && (status === 'expired' || status === 'expired_token')) {
      throw new MinimaxLoginExpiredError()
    }
    // ⚠️ 形态二：非 200 + error（OAuth 标准形态）
    if (error === 'authorization_pending') {
      await sleep(intervalMs)
      continue
    }
    if (error === 'slow_down') {
      intervalMs += 5000
      await sleep(intervalMs)
      continue
    }
    if (response.ok) return parseMinimaxTokenGrant(body, undefined, product)
    throw new Error(`MiniMax 授权失败：${error ?? `HTTP ${response.status}`}`)
  }
  throw new MinimaxLoginExpiredError()
}

/** 续期。 */
export async function refreshMinimaxCredential(
  refreshToken: string,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
): Promise<MinimaxCredential> {
  const response = await fetcher(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: buildMinimaxRefreshBody(refreshToken, product),
    signal: AbortSignal.timeout(MINIMAX_OAUTH_TIMEOUT_MS),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const record = typeof body === 'object' && body !== null
      ? body as Record<string, unknown>
      : {}
    const error = nonEmptyString(record.error) ?? `HTTP ${response.status}`
    throw new Error(`MiniMax 续期失败：${error}`)
  }
  return parseMinimaxTokenGrant(body, refreshToken, product)
}
