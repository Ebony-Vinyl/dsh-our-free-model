/**
 * Qoder 协议的类型与纯函数。
 *
 * 全部逻辑都是**可单测的纯计算**（PKCE、URL、凭据形状、续期载荷），
 * 与网络 I/O 分离 —— 这样协议细节能被单测直接覆盖，不需要 mock fetch。
 *
 * 协议依据：`docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 */

import { createHash, randomUUID, randomBytes } from 'node:crypto'
import type { QoderProduct } from './qoder-product.js'

/** 单次 HTTP 请求超时（毫秒）。 */
export const QODER_REQUEST_TIMEOUT_MS = 30_000
/** 登录等待总超时（毫秒）。源码 `L_a = 3e5`（5 分钟）。 */
export const QODER_LOGIN_TIMEOUT_MS = 300_000
/** 轮询间隔（毫秒）。源码 `Djr = 1e3`。 */
export const QODER_POLL_INTERVAL_MS = 1_000
/** 轮询连续网络失败上限。源码 `H_a = 3`；本实现放宽到 5 以容忍抖动。 */
export const QODER_POLL_MAX_FAILURES = 5

/** 授权页路径（挂 `authBase`）。 */
export const QODER_DEVICE_SELECT_PATH = '/device/selectAccounts'
/** 轮询取 token 路径（挂 `openApiBase`）。 */
export const QODER_POLL_PATH = '/api/v1/deviceToken/poll'
/** 续期路径（挂 `openApiBase`）。 */
export const QODER_REFRESH_PATH = '/api/v1/deviceToken/refresh'
/** 用户信息路径（挂 `openApiBase`）。 */
export const QODER_USERINFO_PATH = '/api/v1/userinfo'
/** 推理路径（挂 `inferBase`）。 */
export const QODER_CHAT_PATH = '/model/v1/chat/completions'

/**
 * PKCE 字符集。
 *
 * 源码 `Y_a()` 从 66 个字符里取模选取。这里用 RFC 7636 的 unreserved 集合
 * （`ALPHA / DIGIT / "-" / "." / "_" / "~"`，共 66 个），与之一致。
 */
const PKCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'

/** 一次 PKCE 生成的结果。 */
export interface QoderPkce {
  /** 明文 verifier（轮询时提交）。 */
  verifier: string
  /** `base64url(sha256(verifier))`，**无 padding**。 */
  challenge: string
}

/**
 * 生成 PKCE verifier / challenge。
 *
 * verifier 长度取 43..128（源码 `43 + floor(86*random)`），
 * challenge 用 `base64url(sha256(verifier))` 且**去掉 padding**
 * —— 带 `=` 会让服务端校验失败。
 */
export function createQoderPkce(): QoderPkce {
  const length = 43 + Math.floor(86 * Math.random())
  const bytes = randomBytes(length)
  let verifier = ''
  for (let i = 0; i < length; i++) {
    verifier += PKCE_ALPHABET[bytes[i]! % PKCE_ALPHABET.length]
  }
  const challenge = createHash('sha256').update(verifier).digest()
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return { verifier, challenge }
}

/**
 * 一次设备登录会话。
 *
 * `machineId` 由**本插件生成并随凭据持久化**，不是硬件指纹。
 *
 * 为什么不复制 Qoder 的硬件指纹逻辑：它依赖 `@napi-rs` 原生模块取
 * SMBIOS UUID 再 `sha256("{salt}:{platform}:{uuid}")`，属设备指纹且不可移植。
 * 本插件改为随机 UUID 并持久化，续期时原样回传。风险见设计文档 §8。
 */
export interface QoderDeviceSession {
  pkce: QoderPkce
  /** 一次性随机串（UUID）。 */
  nonce: string
  /** 设备标识（本插件生成的随机 UUID，需持久化）。 */
  machineId: string
}

/** 生成一次性设备登录会话。 */
export function createQoderDeviceSession(machineId?: string): QoderDeviceSession {
  return {
    pkce: createQoderPkce(),
    nonce: randomUUID(),
    machineId: machineId ?? randomUUID(),
  }
}

/**
 * 构造浏览器授权 URL。
 *
 * 形态（源码 `startDeviceFlow`）：
 * `{authBase}/device/selectAccounts?challenge&challenge_method=S256&nonce&machine_id&client_id`
 *
 * ⚠️ `client_id` 必须用 **`product.clientId`（= 源码 `J_a`，prod 用）**。
 * 源码是 `client_id: i ? J_a : G_a`，而调用点传的第 4 参 `i` 是
 * `isProd()` —— prod 为 `true`，故 **prod 用 `J_a`**。
 * 用成 `G_a`（非 prod 的）会让服务端在授权回调阶段拒绝，
 * 页面报「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」（真实缺陷）。
 */
export function buildQoderAuthUrl(session: QoderDeviceSession, product: QoderProduct): string {
  const query = new URLSearchParams({
    challenge: session.pkce.challenge,
    challenge_method: 'S256',
    nonce: session.nonce,
    machine_id: session.machineId,
    client_id: product.clientId,
  })
  return `${product.authBase}${QODER_DEVICE_SELECT_PATH}?${query.toString()}`
}

/**
 * 构造轮询 URL。
 *
 * ⚠️ 挂 **`openApiBase`**（`openapi.qoder.sh`），不是 `authBase`。
 * 实测：`qoder.com` 的该路径返回 401，而 `openapi.qoder.sh` 返回 404
 * （= 无待授权会话，应继续轮询）。写错 host 会让登录永远失败。
 */
export function buildQoderPollUrl(session: QoderDeviceSession, product: QoderProduct): string {
  const query = new URLSearchParams({
    nonce: session.nonce,
    verifier: session.pkce.verifier,
    challenge_method: 'S256',
  })
  return `${product.openApiBase}${QODER_POLL_PATH}?${query.toString()}`
}

/**
 * 凭据。
 *
 * `security_oauth_token` 与 `access_token` **双写同值**：Qoder 的取用顺序是
 * `security_oauth_token ?? access_token`（源码 `a6e()`），双写可兼容两种路径。
 *
 * `machine_id` **必须持久化**：续期请求体需要它，且它参与服务端的设备绑定。
 */
export interface QoderCredential {
  security_oauth_token: string
  access_token: string
  refresh_token?: string
  /** 访问令牌过期时间（毫秒时间戳）。 */
  expire_time?: number
  /** refresh_token 过期时间（毫秒时间戳）。 */
  refresh_token_expire_time?: number
  /** 本插件生成并持久化的设备标识。 */
  machine_id: string
  /**
   * 用户 id（设备码响应里的 `user_id`）。
   *
   * ⚠️ **加密推理必需**：`generate_runtime_auth_fields` 用它派生
   * `encrypt_user_info`；缺了它会挂起或失败（实测）。
   * 源码 `buildUserInfoFromDeviceToken` 读的就是 `A.user_id`。
   */
  uid?: string
  /** 展示用昵称（设备码响应的 `user_name`，或后续 userinfo）。 */
  nickname?: string
}

/** 从 token 响应解析出的规范化载荷。 */
export interface QoderTokenPayload {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  refreshTokenExpiresAt?: number
  /** 用户 id（`user_id`）。加密推理需要。 */
  uid?: string
  /** 用户名（`user_name`）。 */
  userName?: string
}

/** 读字符串字段（容忍非字符串与缺失）。 */
function readString(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * 把时间值解析成毫秒时间戳。
 *
 * 兼容 ISO 字符串与数字（秒或毫秒）。无法解析时返回 undefined
 * —— **绝不填 0**：「没有过期时间」与「1970 年过期」是两回事。
 */
function readTimestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // 10 位视为秒，13 位视为毫秒
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 解析 token 响应。
 *
 * 登录响应用 `token`，续期响应用 `device_token` —— 两者字段名不同，
 * 故都接受。垃圾输入返回空 `accessToken`（而非抛错），由调用方判定失败。
 */
export function parseQoderTokenPayload(value: unknown): QoderTokenPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { accessToken: '' }
  }
  const source = value as Record<string, unknown>
  const accessToken = readString(source, ['token', 'device_token', 'access_token']) ?? ''
  const refreshToken = readString(source, ['refresh_token', 'refreshToken'])
  const expiresAt = readTimestamp(source.expires_at ?? source.expiresAt)
  const refreshTokenExpiresAt = readTimestamp(
    source.refresh_token_expires_at ?? source.refreshTokenExpiresAt,
  )
  // ⚠️ 设备码响应带 `user_id` / `user_name`（源码 `buildUserInfoFromDeviceToken`
  // 读的就是这两个），而**加密推理需要 uid**（见 QoderCredential.uid）。
  // 早期漏读它们，导致只能走公开端点。
  const uid = readString(source, ['user_id', 'userId'])
  const userName = readString(source, ['user_name', 'userName'])
  return {
    accessToken,
    ...refreshToken === undefined ? {} : { refreshToken },
    ...expiresAt === undefined ? {} : { expiresAt },
    ...refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt },
    ...uid === undefined ? {} : { uid },
    ...userName === undefined ? {} : { userName },
  }
}

/** 构造凭据。 */
export function buildQoderCredential(
  payload: QoderTokenPayload,
  extra: { machineId: string; nickname?: string },
): QoderCredential {
  // 昵称优先取显式传入（如 userinfo），否则回退设备码响应的 user_name。
  const nickname = extra.nickname !== undefined && extra.nickname.length > 0
    ? extra.nickname
    : payload.userName
  return {
    security_oauth_token: payload.accessToken,
    access_token: payload.accessToken,
    ...payload.refreshToken === undefined ? {} : { refresh_token: payload.refreshToken },
    ...payload.expiresAt === undefined ? {} : { expire_time: payload.expiresAt },
    ...payload.refreshTokenExpiresAt === undefined
      ? {} : { refresh_token_expire_time: payload.refreshTokenExpiresAt },
    machine_id: extra.machineId,
    ...payload.uid === undefined ? {} : { uid: payload.uid },
    ...nickname === undefined || nickname.length === 0
      ? {} : { nickname },
  }
}

/** 凭据的访问令牌过期时间（毫秒）；未知时 undefined。 */
export function qoderCredentialExpiresAtMs(credential: QoderCredential): number | undefined {
  return credential.expire_time}

/**
 * 是否可静默续期。
 *
 * 判据是「有 refresh_token」，与过期与否无关 —— 未过期但无 refresh_token
 * 的凭据同样无法续期。
 */
export function isQoderRefreshable(credential: QoderCredential): boolean {
  return typeof credential.refresh_token === 'string' && credential.refresh_token.length > 0
}

/** 访问令牌是否已过期。无过期时间时保守视为未过期（交给服务端 401 判定）。 */
export function isQoderExpired(credential: QoderCredential, nowMs: number = Date.now()): boolean {
  const expiresAt = qoderCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= nowMs
}

/**
 * 续期请求体。
 *
 * 源码的 `getMachineIdentityRequestFields` 会在两个字段都存在时才带上，
 * 且 `machine_token` 来自 UMID 子系统（本插件没有）—— 故只发
 * `refresh_token` 与 `machine_id`。
 */
export function qoderRefreshBody(credential: QoderCredential): Record<string, string> {
  return {
    refresh_token: credential.refresh_token ?? '',
    machine_id: credential.machine_id,
  }
}

/** 取 Bearer 令牌（`security_oauth_token` 优先，与源码一致）。 */
export function qoderBearerToken(credential: QoderCredential): string {
  const token = credential.security_oauth_token
  if (typeof token === 'string' && token.length > 0) return token
  return typeof credential.access_token === 'string' ? credential.access_token : ''
}

/** 推理请求头。 */
export function qoderChatHeaders(
  credential: QoderCredential,
  product: QoderProduct,
  requestId: string,
  sessionId: string,
): Record<string, string> {
  return {
    Authorization: `Bearer ${qoderBearerToken(credential)}`,
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
    'X-Request-ID': requestId,
    'X-Session-ID': sessionId,
    'User-Agent': `${product.userAgentPrefix}/1.0.0`,
  }
}

/**
 * 用续期结果覆盖旧凭据。
 *
 * **保留** `machine_id` / `uid` / `nickname`：它们不在续期响应里，
 * 丢失会让下一次续期缺少设备标识、或让加密推理缺少 uid。
 */
export function applyQoderRefresh(
  credential: QoderCredential,
  payload: QoderTokenPayload,
): QoderCredential {
  const next = buildQoderCredential(payload, {
    machineId: credential.machine_id,
    ...credential.nickname === undefined ? {} : { nickname: credential.nickname },
  })
  // 续期响应若未带新 refresh_token，沿用旧的（避免把可续期凭据变成不可续期）
  if (next.refresh_token === undefined && credential.refresh_token !== undefined) {
    next.refresh_token = credential.refresh_token
  }
  // uid 不在续期响应里，必须保留 —— 加密推理依赖它。
  if (next.uid === undefined && credential.uid !== undefined) {
    next.uid = credential.uid
  }
  return next
}

/**
 * 取用户的展示名（`GET /api/v1/userinfo` 的 `name`）。
 *
 * ## 为什么需要它（真实缺陷，用户报障 2026-09-26）
 *
 * > 另外授权登录后的名字都是 `qoder-xxxx`，无法识别是哪个号，
 * > 应该显示授权的名字
 *
 * 根因：**设备码轮询响应里没有 `user_name`**。`parseQoderTokenPayload` 会读
 * `user_name` / `userName`，`buildQoderCredential` 也会回退到它 —— 但两者都
 * 拿不到值，于是凭据永不带 `nickname`，Channel Pack 便退回显示账号 id
 * （`qoder-c2472fa6` 这类），多账号时无法区分。
 *
 * 实测（2026-09-26）：4 个账号的凭据 `nickname` **全部缺失**，而 userinfo
 * 稳定给出真实名字：
 *
 * | 账号 id | 凭据 nickname | userinfo `name` |
 * |---|---|---|

 *
 * 故**登录成功后必须补一次 userinfo** 才能拿到名字（这是唯一可靠来源）。
 *
 * ⚠️ 失败时返回 `undefined` 而**不抛错**：昵称只是展示信息，拿不到不应让
 * 登录整体失败（与 `toLoginFlowResult` 对过期时间的处理同原则）。
 * 调用方应退回账号 id。
 *
 * @param fetcher 可注入（单测用）
 */
export async function fetchQoderUserNickname(
  credential: QoderCredential,
  product: QoderProduct,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  try {
    const response = await fetcher(`${product.openApiBase}${QODER_USERINFO_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${credential.security_oauth_token || credential.access_token}`,
      },
    })
    if (!response.ok) return undefined
    const body = await response.json()
    if (typeof body !== 'object' || body === null) return undefined
    const name = (body as Record<string, unknown>).name
    if (typeof name !== 'string') return undefined
    const trimmed = name.trim()
    return trimmed.length > 0 ? trimmed : undefined
  } catch {
    return undefined
  }
}

/**
 * 把昵称写进凭据（返回新对象，不改原凭据）。
 *
 * 昵称**写回凭据**而不只写账号条目：账号条目会随 Channel Pack 的账号操作整体
 * 重写，而凭据里存一份才能在续期后（`applyQoderRefresh` 会保留它）
 * 与其它面板（积分、模型）都稳定拿到。
 *
 * 空串与 undefined 均视为「没有昵称」，此时原样返回（不写入空字段）。
 */
export function withQoderNickname(
  credential: QoderCredential,
  nickname: string | undefined,
): QoderCredential {
  if (nickname === undefined || nickname.length === 0) return credential
  return { ...credential, nickname }
}
