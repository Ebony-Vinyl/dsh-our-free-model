/**
 * Cline 凭据模型与协议纯函数。
 *
 * 本模块**不做任何 IO**：解析、构造、判定全部是纯函数，便于单测锁死。
 * 网络行为在 `src/cline-oauth.ts`（登录）与 `src/cline-auth.ts`（续期）。
 *
 * ## 与既有 provider 的差异（都踩过或差点踩）
 *
 * 1. **访问令牌带 `workos:` 前缀且不可剥**（见 `clineBearerValue`）；
 * 2. **续期字段是驼峰 `refreshToken` + `grantType`**，不是 OAuth 标准的
 *    `refresh_token` / `grant_type`（见 `clineRefreshBody`）；
 * 3. **注册/续期响应套一层 `{success, data}` 信封**，且字段名是
 *    `accessToken`（驼峰）而非 `access_token`（见 `parseClineTokenPayload`）。
 */

import type { ClineProduct } from './cline-product.js'

/**
 * Cline 凭据（持久化到 `ctx.credentials` 的 JSON）。
 *
 * 字段名沿用 Cline 官方 SDK 的口径（`access` / `refresh` / `expires` /
 * `accountId` / `email` / `metadata`）以便与官方产物对照，但**对外暴露的是
 * 本插件统一的 `access_token` / `refresh_token` / `expire_time` 命名**，
 * 与 `QoderCredential` / `TraeCredential` 等保持一致，避免每个 provider
 * 一套字段名让调用方难以复用。
 */
export interface ClineCredential {
  /**
   * 访问令牌。
   *
   * ⚠️ **必须保留服务端下发的 `workos:` 前缀**（实测：剥掉即 401）。
   * 见 {@link clineBearerValue}。
   */
  access_token: string
  /** 续期令牌。 */
  refresh_token?: string
  /** 访问令牌过期时间（毫秒时间戳）。 */
  expire_time?: number
  /**
   * Cline 账号 id（形如 `usr-01M3BCV4FYCGJKAWD3MJG3DBQM`）。
   *
   * ⚠️ **余额端点必须用它**，不能用 JWT 的 `sub`
   * （`user_01M3BCQ86DV4S9KKBT85X4GKTV`）：实测传 `sub` 返回
   * `400 {"error":"Invalid request format"}`。
   */
  account_id?: string
  /** 账号邮箱（展示用）。 */
  email?: string
  /** 昵称（账号池展示名；取邮箱本地部分或 `userInfo` 里的名字）。 */
  nickname?: string
}

/**
 * 一次 token 交换（注册或续期）的解析结果。
 *
 * 垃圾输入返回空 `accessToken`（而非抛错），由调用方判定失败 ——
 * 与 `parseQoderTokenPayload` 同约定。
 */
export interface ClineTokenPayload {
  accessToken: string
  refreshToken?: string
  /** 过期时间（毫秒时间戳）。 */
  expiresAt?: number
  /** 账号 id（`userInfo.clineUserId`）。 */
  accountId?: string
  /** 邮箱（`userInfo.email`）。 */
  email?: string
  /** 展示名（`userInfo.firstName + lastName`，可能为空白）。 */
  displayName?: string
}

/** 从记录里读第一个非空字符串字段。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return undefined
}

/**
 * 把各种时间形态归一为毫秒时间戳。
 *
 * Cline 的 `expiresAt` 实测是 **ISO 8601 字符串**
 * （源码 `toEpochMs(isoDateTime)` 直接 `Date.parse`，
 * 解析失败会抛 `Invalid expiresAt value`）。但为了对上游格式变更鲁棒，
 * 这里同时接受数字（秒 / 毫秒）。
 */
export function parseClineTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 10 位视为秒，13 位视为毫秒
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 解析注册 / 续期响应。
 *
 * 两处响应**同构**（源码 `registerWorkOSTokens` 与 `refreshClineToken` 都过
 * `toClineCredentials`）：
 *
 * ```json
 * { "success": true,
 *   "data": { "accessToken": "workos:eyJ…", "refreshToken": "tmgEeM…",
 *             "expiresAt": "2026-09-25T05:23:47.000Z", "tokenType": "Bearer",
 *             "userInfo": { "clineUserId": "usr-…", "email": "…",
 *                           "firstName": "", "lastName": "" } } }
 * ```
 *
 * ⚠️ **判据是 `success && data.accessToken`**（源码 `requireClineTokenResponse`），
 * 不是裸 `accessToken`。只看裸字段会把失败信封当成成功。
 *
 * ⚠️ 兼容裸响应（无 `data` 信封）：若上游某天直接返回
 * `{accessToken, refreshToken}`，这里仍能解析。
 */
export function parseClineTokenPayload(value: unknown): ClineTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { accessToken: '' }
  }
  const envelope = value as Record<string, unknown>
  // 优先取 `data` 信封；没有则把顶层当载荷（兼容裸响应）。
  const inner = typeof envelope.data === 'object' && envelope.data !== null && !Array.isArray(envelope.data)
    ? envelope.data as Record<string, unknown>
    : envelope

  // ⚠️ 字段名是**驼峰** `accessToken`；同时接受下划线形态以对上游变更鲁棒。
  const accessToken = readString(inner, ['accessToken', 'access_token']) ?? ''
  const refreshToken = readString(inner, ['refreshToken', 'refresh_token'])
  const expiresAt = parseClineTimestamp(inner.expiresAt ?? inner.expires_at ?? inner.expire_time)

  const userInfo = typeof inner.userInfo === 'object' && inner.userInfo !== null && !Array.isArray(inner.userInfo)
    ? inner.userInfo as Record<string, unknown>
    : undefined
  const accountId = userInfo === undefined
    ? readString(inner, ['accountId', 'account_id'])
    : readString(userInfo, ['clineUserId', 'accountId']) ?? readString(inner, ['accountId', 'account_id'])
  const email = userInfo === undefined
    ? readString(inner, ['email'])
    : readString(userInfo, ['email']) ?? readString(inner, ['email'])
  const firstName = userInfo === undefined ? undefined : readString(userInfo, ['firstName'])
  const lastName = userInfo === undefined ? undefined : readString(userInfo, ['lastName'])
  const displayName = [firstName, lastName].filter((part): part is string => part !== undefined).join(' ').trim()

  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...accountId === undefined ? {} : { accountId },
    ...email === undefined ? {} : { email },
    ...displayName.length === 0 ? {} : { displayName },
  }
}

/**
 * 确保访问令牌带产品前缀。
 *
 * ⚠️ **这是本 provider 最容易踩的坑**：源码 `resolveApiKey` 原样使用存储值，
 * 而 Cline 磁盘上存的就是 `workos:eyJ…`；前缀只在**解码 JWT** 时被剥掉
 * （`decodeJwtPayload(token.replace(/^workos:/, ""))`），
 * **从不出现在请求头构造里**。
 *
 * 实测（同一凭据）：
 * - `Bearer workos:eyJ…` → `/api/v1/users/me` **200**
 * - `Bearer eyJ…`（剥掉前缀）→ **401**
 *   文案 "make sure you're using the latest version of Cline" —— 与真实原因
 *   毫不相干，剥前缀会让人误判成「版本过旧」。
 *
 * 实现为**幂等补齐**而非强制加前缀：服务端确实下发带前缀的值
 * （源码 `toClineCredentials` 直接 `access = responseData.accessToken`，
 * 而官方存储值带前缀），所以正常路径下 `startsWith` 即命中；
 * 补前缀分支是为了对「上游某天改回不带前缀」这一变更保持鲁棒。
 */
export function clineBearerValue(accessToken: string, product: ClineProduct): string {
  const token = accessToken.trim()
  if (token.length === 0) return ''
  return token.startsWith(product.tokenPrefix) ? token : `${product.tokenPrefix}${token}`
}

/** 构造凭据（把 token 载荷与产品配置合成持久化形态）。 */
export function buildClineCredential(
  payload: ClineTokenPayload,
  product: ClineProduct,
  fallback: { accountId?: string; email?: string } = {},
): ClineCredential {
  const accountId = payload.accountId ?? fallback.accountId
  const email = payload.email ?? fallback.email
  // 昵称优先用邮箱（唯一且稳定），其次显示名，最后账号 id。
  const nickname = email ?? (payload.displayName !== undefined && payload.displayName.length > 0
    ? payload.displayName
    : accountId)
  return {
    access_token: clineBearerValue(payload.accessToken, product),
    ...payload.refreshToken === undefined ? {} : { refresh_token: payload.refreshToken },
    ...payload.expiresAt === undefined ? {} : { expire_time: payload.expiresAt },
    ...accountId === undefined ? {} : { account_id: accountId },
    ...email === undefined ? {} : { email },
    ...nickname === undefined ? {} : { nickname },
  }
}

/**
 * 把一次续期结果合并回既有凭据。
 *
 * **保留** `account_id` / `email` / `nickname`：它们不在续期响应里
 * （续期响应带 `userInfo`，但实测字段可能缺省），丢了会让账号卡片
 * 失去展示名与余额查询所需的账号 id。
 */
export function applyClineRefresh(
  credential: ClineCredential,
  payload: ClineTokenPayload,
  product: ClineProduct,
): ClineCredential {
  const next: ClineCredential = {
    ...credential,
    access_token: clineBearerValue(payload.accessToken, product),
  }
  if (payload.refreshToken !== undefined) next.refresh_token = payload.refreshToken
  if (payload.expiresAt !== undefined) next.expire_time = payload.expiresAt
  if (payload.accountId !== undefined) next.account_id = payload.accountId
  if (payload.email !== undefined) next.email = payload.email
  return next
}

/** 凭据的访问令牌过期时间（毫秒）；未知时 undefined。 */
export function clineCredentialExpiresAtMs(credential: ClineCredential): number | undefined {
  return credential.expire_time
}

/**
 * 是否可静默续期。
 *
 * 判据是「有 refresh_token」，与过期与否无关 —— 未过期但无 refresh_token
 * 的凭据同样无法续期。
 */
export function isClineRefreshable(credential: ClineCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/** 访问令牌是否已过期。无过期时间时保守视为未过期（交给服务端 401 判定）。 */
export function isClineExpired(credential: ClineCredential, nowMs: number = Date.now()): boolean {
  const expiresAt = clineCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= nowMs
}

/**
 * 续期请求体。
 *
 * ⚠️ **字段名是驼峰 `refreshToken` 与 `grantType`**，不是 OAuth 标准的
 * `refresh_token` / `grant_type`。源码 `refreshClineToken`：
 *
 * ```js
 * body: JSON.stringify({ refreshToken: current.refresh, grantType: "refresh_token" })
 * ```
 *
 * 两者都是**必填**；写错字段名服务端不会明确报「缺字段」，
 * 而是回一个泛化的认证失败，极难定位。
 */
export function clineRefreshBody(credential: ClineCredential): Record<string, string> {
  return {
    refreshToken: credential.refresh_token ?? '',
    grantType: 'refresh_token',
  }
}

/**
 * 推理与账号端点的请求头。
 *
 * ⚠️ `Authorization` 用的是**带前缀**的令牌值（见 `clineBearerValue`），
 * 且必须叠加产品的客户端标识头。
 */
export function clineHeaders(
  credential: ClineCredential,
  product: ClineProduct,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const bearer = clineBearerValue(credential.access_token, product)
  return {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
    ...product.clientHeaders,
    ...extra,
  }
}

/**
 * 仅凭「原始令牌字符串」构造鉴权头。
 *
 * 供余额查询等**只拿到凭据 JSON 里某一字段**的场景复用；与
 * {@link clineHeaders} 同源（都经 `clineBearerValue`），避免两处漂移。
 */
export function clineAuthHeaders(
  accessToken: string,
  product: ClineProduct,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return {
    Authorization: `Bearer ${clineBearerValue(accessToken, product)}`,
    Accept: 'application/json',
    ...product.clientHeaders,
    ...extra,
  }
}
