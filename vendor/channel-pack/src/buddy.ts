/**
 * 腾讯 CodeBuddy 认证常量、凭据结构与纯解析逻辑
 *
 * 逆向自 CodeBuddy CN IDE (genie 扩展 v4.11.2) 的 external-link-v2 轮询式登录：
 * - fetchAuthState → POST /v2/plugin/auth/state?platform=ide 获取 state + authUrl
 * - openAuthUrl    → 打开浏览器到 https://www.codebuddy.cn/login/?platform=ide&state=...
 * - loopGetToken   → GET /v2/plugin/auth/token?state=... 轮询获取 token（1s 间隔，5min 超时）
 * - getAccount     → GET /v2/plugin/login/account?state=... 轮询获取账户信息
 * - refreshToken   → POST /v2/plugin/auth/token/refresh 刷新 token
 *
 * 与 CodeArts 的 PKCE OAuth + 本地回调服务器不同，CodeBuddy 采用**轮询式**：
 * 客户端不起本地服务器，而是定期轮询后端 API 检查登录状态。
 *
 * 本模块只放常量与纯函数（无网络、无存储），网络流程见 buddy-oauth.ts。
 */

// ── API 端点常量（逆向自 genie 扩展 product.json + index.js） ──

/** 主 API 端点（product.json endpoint）。 */
export const API_ENDPOINT = 'https://copilot.tencent.com'
/** API 路径前缀（product.json authentication.attributes.prefixPath）。 */
export const PREFIX_PATH = '/plugin'
/** 平台标识（product.json authentication.attributes.platform）。 */
export const PLATFORM = 'ide'
/** 登录网站首页（copilot.tencent.com → www.codebuddy.cn 映射）。 */
export const WEBSITE_HOME = 'https://www.codebuddy.cn'

/** 获取 auth state 端点：POST /v2/plugin/auth/state?platform=ide */
export const AUTH_STATE_PATH = '/v2/plugin/auth/state'
/** 轮询 token 端点：GET /v2/plugin/auth/token?state=... */
export const AUTH_TOKEN_PATH = '/v2/plugin/auth/token'
/** 轮询账户端点：GET /v2/plugin/login/account?state=... */
export const LOGIN_ACCOUNT_PATH = '/v2/plugin/login/account'
/** 刷新 token 端点：POST /v2/plugin/auth/token/refresh */
export const AUTH_REFRESH_PATH = '/v2/plugin/auth/token/refresh'
/** 账户列表端点：GET /v2/plugin/accounts */
export const ACCOUNTS_PATH = '/v2/plugin/accounts'
/** 云端配置端点：GET /v3/config（获取模型列表、agents、productFeatures） */
export const CONFIG_PATH = '/v3/config'

// ── 轮询参数 ──

/** 登录轮询总超时（5 分钟，对齐 IDE 的 5*60*1e3）。 */
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
/** 轮询间隔（1 秒，对齐 IDE 的 setTimeout(o,1e3)）。 */
export const POLL_INTERVAL_MS = 1000
/**
 * auth/state 请求超时（10 秒）。
 *
 * ⚠️ 原为 5 秒（对齐 IDE 的 `timeout:5e3`），实测**不够**：Channel Pack 对
 * WorkBuddy（国际版）点「+ 新建账号」时，本请求发往 `www.workbuddy.ai`，
 * 用 Node 的 `fetch`（undici，与本插件运行时一致）连测 6 次稳定耗时
 * **5860–7525 ms**，即每一次都会撞上 5 秒超时，用户侧表现为
 * 「无法获取 WorkBuddy (国际版) 登录地址（Host 网络请求失败）」。
 * 放宽到 10 秒后覆盖上述区间并留出余量。
 *
 * 该常量由 buddy / workbuddy 共用：放宽只影响「失败时多等 5 秒」，
 * 不会拖慢 CodeBuddy（`copilot.tencent.com` 实测数百毫秒即返回）。
 */
export const STATE_REQUEST_TIMEOUT_MS = 10_000
/** 其余控制面请求超时（token/account/refresh/config）。 */
export const REQUEST_TIMEOUT_MS = 60_000

// ── 错误码（逆向自 IDE catch 分支） ──

/** token 尚未就绪（loopGetToken 中 continue 轮询）。 */
export const CODE_TOKEN_NOT_READY = 11217
/** 账户信息尚未完成（getAccount 中 continue 轮询）。 */
export const CODE_ACCOUNT_NOT_READY = 12151

// ── HTTP Header 常量（逆向自 IDE Jd/jM/qM 定义） ──

export const HTTP_HEADER_DOMAIN = 'X-Domain'
export const HTTP_HEADER_ENTERPRISE_ID = 'X-Enterprise-Id'
export const HTTP_HEADER_TENANT_ID = 'X-Tenant-Id'
export const HTTP_HEADER_NO_AUTHORIZATION = 'X-No-Authorization'
export const HTTP_HEADER_NO_USER_ID = 'X-No-User-Id'
export const HTTP_HEADER_NO_ENTERPRISE_ID = 'X-No-Enterprise-Id'
export const HTTP_HEADER_NO_DEPARTMENT_INFO = 'X-No-Department-Info'
export const HTTP_HEADER_REFRESH_TOKEN = 'X-Refresh-Token'
export const HTTP_HEADER_AUTH_REFRESH_SOURCE = 'X-Auth-Refresh-Source'
export const HTTP_HEADER_PRODUCT = 'X-Product'
export const HTTP_HEADER_PRODUCT_CODE = 'X-Product-Code'

/**
 * User-Agent 标识（对齐 IDE 的 getUserAgent() → CodeBuddyIDE/${platformVersion}）。
 * platformVersion 来自 IDE product.json version 字段（1.106.1），非 genie 版本。
 */
export const BUDDY_USER_AGENT = 'CodeBuddyIDE/1.106.1'
/** X-Product-Code 值（对齐 IDE headers 设置）。 */
export const BUDDY_PRODUCT_CODE = 'codebuddy'
/** X-Product 默认值（deploymentType，对齐 ProductEndpointHttpInterceptor）。 */
export const BUDDY_DEPLOYMENT_TYPE = 'SaaS'
/** 刷新来源标识（对齐 IDE 的 ide-main）。 */
export const AUTH_REFRESH_SOURCE = 'ide-main'

/** API 端点的裸域名（X-Domain 头的值）。 */
export const API_DOMAIN = 'copilot.tencent.com'

// ── 凭据数据结构 ──

/**
 * 持久化的 CodeBuddy 凭据。
 *
 * 对齐 IDE 的 auth 对象结构（accessToken/refreshToken/expiresAt/...）
 * 加上 account 对象（uid/nickname/enterpriseId/type）。除两个令牌外的字段
 * 均为可选，以便稳妥解析来自磁盘的旧版/部分凭据。
 */
export interface BuddyCredential {
  /** 访问令牌（Authorization: Bearer <access_token>）。 */
  access_token: string
  /** 刷新令牌（X-Refresh-Token header）。 */
  refresh_token: string
  /** token 过期时间（原始值，可能为毫秒时间戳或 ISO 字符串）。 */
  expires_at?: string
  /** refresh_token 过期时间。 */
  refresh_expires_at?: string
  /** token 类型（"Bearer"）。 */
  token_type?: string
  /** OAuth scope（通常为空）。 */
  scope?: string
  /** API 域名（"copilot.tencent.com"）。 */
  domain?: string
  /** 用户 ID（account.uid）。 */
  user_id?: string
  /** 用户昵称（account.nickname）。 */
  nickname?: string
  /** 企业 ID（account.enterpriseId，个人版为空）。 */
  enterprise_id?: string
  /** 账户类型（"personal" / "enterprise"）。 */
  account_type?: string
}

/** auth/token 与 auth/token/refresh 响应的令牌数据。 */
export interface BuddyToken {
  accessToken: string
  refreshToken: string
  expiresAt: string
  refreshExpiresAt: string
  tokenType: string
  scope: string
  domain: string
}

/** login/account 响应的账户数据。 */
export interface BuddyAccount {
  uid: string
  nickname: string
  enterpriseId: string
  accountType: string
}

/**
 * 从凭据 expires_at 解析毫秒时间戳（兼容毫秒时间戳 / 秒级时间戳 / ISO 8601）。
 * 无法解析或缺失时返回 undefined。
 *
 * 后备来源（e2e 实证 2026-09-11）：CodeBuddy 的 `/v2/plugin/auth/token`
 * **不返回绝对的 `expiresAt`**，只返回相对的 `expiresIn`。若凭据里的
 * `expires_at` 为空（历史写入或后端变更），回退到解析 access_token 这个
 * JWT 的 `exp` 声明——它同样是权威的过期时刻。
 */
export function credentialExpiresAtMs(credential: BuddyCredential): number | undefined {
  const raw = credential.expires_at
  if (typeof raw === 'string' && raw.length > 0) {
    // 纯数字：视为时间戳。> 1e12 为毫秒，否则为秒。
    if (/^\d+$/.test(raw)) {
      const value = Number(raw)
      return value > 1_000_000_000_000 ? value : value * 1000
    }
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return parsed
  }
  return jwtExpiresAtMs(credential.access_token)
}

/**
 * 从 JWT 的 payload 读取 `exp`（秒）并换算为毫秒；非 JWT 或解析失败返回 undefined。
 * 仅做 base64url 解码，不验签——该值只用于展示与续期调度。
 */
export function jwtExpiresAtMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown }
    return typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 JWT payload 读取 `nickname`（CodeBuddy 的 login/account 响应不含昵称，
 * 昵称只在 access_token 的声明里）。解析失败返回空串。
 */
export function jwtNickname(token: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const nickname = payload.nickname ?? payload.preferred_username ?? payload.name
    return typeof nickname === 'string' ? stripControlChars(nickname) : ''
  } catch {
    return ''
  }
}

/** 凭据是否已过期；无法解析过期时间时不判定过期（对齐 Rust is_expired）。 */
export function isExpired(credential: BuddyCredential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/** 凭据是否携带可静默续期的 refresh_token。 */
export function isRefreshable(credential: BuddyCredential): boolean {
  return credential.refresh_token.length > 0
}

/**
 * 构造基础请求头（X-Domain + User-Agent + 可选企业头）。
 *
 * ⚠️ `X-Domain` 用 `||` 而非 `??`：本函数是「凭据级」基础头，调用方
 * `buddy-oauth.ts`（`refreshToken` / `fetchModels`）随后会按当前产品覆盖 domain
 * 与 UA，故它只需把**空串**兜回默认域名，不承担「以产品为准」的判定。
 * 凭据的 domain 经 `parseTokenData` → `readStringField` 读取，**字段缺失时是
 * 空串而不是 undefined** —— 用 `??` 会让 X-Domain 以空值发出（真实缺陷，已用
 * 单测复现）。判定与 `src/credits.ts` 的 `checkinHeaders` 保持同一方向。
 */
export function credentialRequestHeaders(credential: BuddyCredential): Record<string, string> {
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: credential.domain || API_DOMAIN,
    'User-Agent': BUDDY_USER_AGENT,
  }
  if (credential.enterprise_id !== undefined && credential.enterprise_id.length > 0) {
    headers[HTTP_HEADER_ENTERPRISE_ID] = credential.enterprise_id
    headers[HTTP_HEADER_TENANT_ID] = credential.enterprise_id
  }
  return headers
}

/** 构造带 Bearer 令牌的认证请求头。 */
export function credentialAuthHeaders(credential: BuddyCredential): Record<string, string> {
  return {
    ...credentialRequestHeaders(credential),
    Authorization: `Bearer ${credential.access_token}`,
  }
}

/**
 * 从 JSON 安全读取字符串字段（兼容后端把时间戳返回为数字）。
 *
 * 会剔除 CR/LF 等控制字符：CodeBuddy 的 `scope` 字段有时返回多行文本
 * （如 "profile\n    offline_access\n    email"）。这些换行会被凭据的
 * JSON 字符串原样携带，并在落盘到 YAML（`.credentials.yaml`）时被当作
 * 多行标量，破坏 JSON 结构 —— 重新读取时 `JSON.parse` 失败，表现为
 * 有效期/昵称等字段"丢失"（实际是整个凭据无法解析）。
 */
function readStringField(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string') return stripControlChars(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/** 去掉字符串中的控制字符（含 CR/LF/Tab），并把连续空白折叠为单个空格。 */
function stripControlChars(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** 从 JSON 读取数值字段（兼容后端返回数字型字符串）。 */
function readNumberField(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return undefined
}

/**
 * 若令牌本身未携带绝对 `expiresAt`，则用相对秒数（`expiresIn`）换算为绝对毫秒时间戳。
 * 换算基准取 access_token 的 JWT `exp`（优先，权威）或当前时刻。
 */
function absoluteExpiryMs(
  record: Record<string, unknown>,
  absoluteKey: string,
  relativeKey: string,
  accessToken: string,
): string {
  const absolute = readStringField(record, absoluteKey)
  if (absolute.length > 0) {
    // 归一化为毫秒时间戳字符串，交由 credentialExpiresAtMs 统一解析。
    const asNumber = /^\d+$/.test(absolute) ? Number(absolute) : Date.parse(absolute)
    if (Number.isFinite(asNumber)) {
      const ms = asNumber > 1_000_000_000_000 ? asNumber : asNumber * 1000
      return String(ms)
    }
    return absolute
  }
  const relativeSeconds = readNumberField(record, relativeKey)
  if (relativeSeconds === undefined) {
    // 无相对值：交给 JWT exp 兜底（access_token 的 exp 即权威过期时刻）。
    return absoluteKey === 'expiresAt' ? '' : ''
  }
  // 基准：access_token 的签发时刻（iat）优先，缺失时用当前时刻。
  const baseMs = jwtIssuedAtMs(accessToken) ?? Date.now()
  return String(baseMs + relativeSeconds * 1000)
}

/** 从 JWT payload 读取 `iat`（秒）并换算为毫秒。 */
function jwtIssuedAtMs(token: string): number | undefined {
  if (typeof token !== 'string' || token.length === 0) return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { iat?: unknown }
    return typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat * 1000 : undefined
  } catch {
    return undefined
  }
}

/**
 * 从 JSON 解析令牌数据（兼容 camelCase 字段名与数字型时间戳）。
 *
 * e2e 实证（2026-09-11）：`/v2/plugin/auth/token` 实际只返回
 * `expiresIn` / `refreshExpiresIn`（相对秒数），**没有** `expiresAt` /
 * `refreshExpiresAt`。因此这里在绝对字段缺失时用相对秒数换算，
 * 否则凭据的 `expires_at` 会一直是空串（UI 显示"有效期未知"）。
 */
export function parseTokenData(data: unknown): BuddyToken {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const tokenType = readStringField(record, 'tokenType')
  const accessToken = readStringField(record, 'accessToken')
  return {
    accessToken,
    refreshToken: readStringField(record, 'refreshToken'),
    expiresAt: absoluteExpiryMs(record, 'expiresAt', 'expiresIn', accessToken),
    refreshExpiresAt: absoluteExpiryMs(record, 'refreshExpiresAt', 'refreshExpiresIn', accessToken),
    tokenType: tokenType.length > 0 ? tokenType : 'Bearer',
    scope: readStringField(record, 'scope'),
    domain: readStringField(record, 'domain'),
  }
}

/**
 * 从 JSON 解析账户数据。
 *
 * `login/account` 响应不含 `nickname`（e2e 实证：只有 uid/nickname 之外的
 * 字段都为空），昵称实际在 access_token 的 JWT 声明里；调用方通过
 * `buildCredential` 时传入 token 以便回填。
 */
export function parseAccountData(data: unknown): BuddyAccount {
  const record = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>
  const accountType = readStringField(record, 'type')
  return {
    uid: readStringField(record, 'uid'),
    nickname: readStringField(record, 'nickname'),
    enterpriseId: readStringField(record, 'enterpriseId'),
    accountType: accountType.length > 0 ? accountType : 'personal',
  }
}

/**
 * 组合令牌与账户数据为可持久化的凭据。
 *
 * 昵称回填顺序（e2e 实证 2026-09-11：`login/account` 的 `nickname` 常为空，
 * 真正的昵称只在 access_token 的 JWT 声明里）：
 * account.nickname → JWT.nickname → JWT.preferred_username。
 * 过期时间同理：token.expiresAt 为空时由 credentialExpiresAtMs 从 JWT exp 兜底。
 */
export function buildCredential(token: BuddyToken, account: BuddyAccount): BuddyCredential {
  const nickname = account.nickname.length > 0 ? account.nickname : jwtNickname(token.accessToken)
  return {
    access_token: token.accessToken,
    refresh_token: token.refreshToken,
    expires_at: token.expiresAt,
    refresh_expires_at: token.refreshExpiresAt,
    token_type: token.tokenType,
    scope: token.scope,
    domain: token.domain,
    user_id: account.uid.length > 0 ? account.uid : jwtSubject(token.accessToken),
    nickname,
    enterprise_id: account.enterpriseId,
    account_type: account.accountType,
  }
}

/** 从 JWT payload 读取 `sub`（用户 id）；解析失败返回空串。 */
function jwtSubject(token: string): string {
  if (typeof token !== 'string' || token.length === 0) return ''
  const parts = token.split('.')
  if (parts.length < 2) return ''
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    return typeof payload.sub === 'string' ? payload.sub : ''
  } catch {
    return ''
  }
}

// ── 模型列表 ──

/** 已知模型 ID → 展示名（/v3/config 不返回展示名，本地兜底映射）。 */
const MODEL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'DeepSeek V4 Flash',
  'deepseek-v4-pro': 'DeepSeek V4 Pro',
  'hy4-preview': 'Hy4 Preview',
  'hy4-preview-x': 'Hy4 Preview X',
  'hy3': 'Hy3',
  'hy3-x': 'Hy3 X',
  'glm-5.3': 'GLM-5.3',
  'glm-5.3-flash': 'GLM-5.3 Flash',
  'glm-5.2': 'GLM-5.2',
  'glm-5.1': 'GLM-5.1',
  'glm-5v-turbo': 'GLM-5V Turbo',
  'kimi-k3-1': 'Kimi K3-1',
  'kimi-k2.7': 'Kimi K2.7',
  'kimi-k2.6': 'Kimi K2.6',
  'minimax-m3': 'MiniMax M3',
}

/** 模型 ID → 人类可读显示名称；未知模型回退为 ID 本身。 */
export function displayNameForModel(id: string): string {
  return MODEL_DISPLAY_NAMES[id] ?? id
}

/** /v3/config 解析出的单个模型：id、展示名与远端声明的能力。 */
export interface BuddyRemoteModel {
  id: string
  name: string
  /** 上下文窗口（data.models[].maxInputTokens，模型自身配置）；远端未下发时缺省。 */
  contextWindow?: number
  /**
   * 单次请求输出上限（data.models[].maxOutputTokens）。
   *
   * ⚠️ 这是**必须消费**的权威字段，不是仅供参考的元数据：适配器早期把它只当
   * 「过滤补全模型」的判据（见 isChatModel），却从不下发到请求体，导致所有
   * buddy / workbuddy 模型都退化成网关默认输出上限（实测 32000），大文件写入
   * 与长回答会被截断成 `finish_reason: 'length'`。
   *
   * 实测（2026-09-19）各端点取值不完全一致：
   * - 中国版 scoped `/console/enterprises/personal/models` → deepseek-v4.1-flash = 128000
   * - 中国版 `/v3/config` → deepseek-v4.1-flash = 131072
   * - 国际版 `/v3/config` → deepseek-v4.1-flash = 128000
   * 与 `maxInputTokens` 同策略：采信实际命中的那个端点，不做跨端点取大。
   */
  maxOutputTokens?: number
  /** 是否接受图片输入（data.models[].supportsImages）。 */
  supportsImages?: boolean
  /**
   * 计费倍率（`data.models[].credits`）。
   *
   * 真实形态是**字符串**且格式不固定：`"x0.29"` / `"x0.03 credits"` / `""`（空）。
   * 归一化后存**纯文本**（如 `"x0.29"`），不存数字——因为它只是展示用，
   * 且带 ` credits` 后缀与空串两种退化形态，转数字会引入无谓的解析失败分支。
   * 远端未下发或解析不出时缺省。
   */
  creditsRate?: string
  /**
   * 促销后的实际倍率（`data.modelPromotions.discount.discountedCredits`）。
   *
   * 与 `creditsRate` 是**同族但独立**的两个字段：促销是全局活动（按模型 id
   * 索引），活动结束后服务端会把它改成 `"0x"` 或移除。存在且非 `0x` 时才带上。
   */
  discountedCreditsRate?: string
  /**
   * 促销常驻标注（时段窗口 + 窗口内价格 + 活动截止日），例如
   * 「错峰时段23:00-08:00·限免·至11月1日」「错峰时段09:00-12:00/14:00-18:00·
   * 非高峰x0.11」。由 `parsePromotions` 依据调度数据生成，挂在 `description`
   * （DSH 的 `/model` 弹窗副行），窗口外也常驻显示。
   *
   * ⚠️ 词序是「先时段、后价格、再截止日」：只写「限免」而不先说清时段，
   * 读起来像**任何时候都免费**，与模型名上的「(常时)」互相打架（用户报障）。
   * 价格词只在窗口内为免费时是「限免」，否则是窗口外错峰价「非高峰x…」。
   *
   * ⚠️ 注意：长标注**不再**拼进 `name`——composer 的模型切换菜单只渲染
   * `name`（见 qoderDisplayName 的同款约束），把长句塞进名字会把选择器
   * 撑得很长。模型名只保留「当前倍率 (状态)」短后缀。
   */
  promotionNote?: string
  /**
   * 匹配到的促销**原始记录**（用于 `listModels` 展示时按当前时刻重算倍率与
   * 状态，避免 config 拉取时刻的促销判定被冻结进模型名）。详见 buddy-adapter
   * 的 displaySuffix：`promotionActiveNow` 据此判断此刻是否生效。
   */
  promotion?: Record<string, unknown>
  /**
   * 命中的**会员档位**原始记录（`/v3/config` 的 `modelTiers[]`，见 `parseModelTiers`）。
   *
   * ⚠️ 与 `promotion` 是**两套独立来源**：促销在 `modelPromotions`、档位在
   * `modelTiers`，同一模型可以只有其中一个、也可以两个都有（如 `glm-5.3` 有档位
   * 无促销）。故不能合并成一个字段 —— 合并后就分不清"这条有价格吗"。
   */
  modelTier?: Record<string, unknown>
  /** 可选思考等级（data.models[].reasoning.supportedEfforts）；无等级可选的模型缺省。 */
  reasoningEfforts?: string[]
  /** 默认思考等级（data.models[].reasoning.defaultEffort）。 */
  defaultReasoningEffort?: string
  /**
   * 是否被**某个 agent 引用**（即服务端声明「该模型可在对话里选择」）。
   *
   * ⚠️ 用途：`reconcileWithFallback` 是**白名单式重建**，不在产品兜底表里的
   * id 会被丢弃。而两个端点下发的 id 集合不同 —— 实测 `hy4-preview-f`
   * （新用户限时免费变体）**只由 `/v3/config` 下发**且**被 craft/ask/plan 引用**，
   * 却不在兜底表里，于是被丢弃，用户看不到那个免费变体。
   *
   * 故用本标志把「服务端说可选」的模型保留下来；未声明的内部别名
   * （如 `default`）不会被误留。
   */
  agentReferenced?: boolean
}

/**
 * 归一化 `data.models[].credits` 为可展示的倍率文本。
 *
 * 真实形态（2026-09-19 实测，**字符串**而非数字）：
 * - `"x0.29"` / `"x1.62"` —— 常态（**x 在前**）
 * - `"x0.03 credits"` —— 早期 scoped 端点会带 ` credits` 后缀
 * - `""` / 字段缺失 —— 无倍率信息（如 `auto` / `codewise-*`）
 *
 * 返回 `"x0.29"` 这类**纯展示文本**（统一成 `x` 前缀，与官方 UI 一致）。
 * 解析不出时返回 undefined，**不回退成 `x1`**：编造倍率比不显示更糟。
 */
export function normalizeCreditsRate(value: unknown): string | undefined {
  return normalizeRate(value, /^(?:x(\d+(?:\.\d+)?))\b/i, /^(\d+(?:\.\d+)?)x\b/i)
}

/**
 * 归一化 `modelPromotions[].discount.discountedCredits`。
 *
 * ⚠️ 与 {@link normalizeCreditsRate} **形态相反**：实测促销值是 `"0.50x"`
 * （**x 在后**），而模型的 `credits` 是 `"x0.29"`（x 在前）。两者是同一后端
 * 的两套写法，不能共用一个正则 —— 早期版本只认前缀，导致**促销价全部解析
 * 失败且静默丢失**（单测直接暴露了这一点）。
 *
 * 另有一种已结束占位值 `"0x"`，归一化后是 `x0`，由调用方排除。
 */
export function normalizeDiscountedRate(value: unknown): string | undefined {
  return normalizeRate(value, /^(?:x(\d+(?:\.\d+)?))\b/i, /^(\d+(?:\.\d+)?)x\b/i)
}

/**
 * 倍率文本的共用解析：先试前缀写法，再试后缀写法，统一输出 `x<数字>`。
 *
 * 两种写法都接受（而非按调用方区分），是为了对上游格式变更更鲁棒：
 * 实测已经出现过同一后端两套写法共存的情况，若将来它们互换，本函数仍正确。
 */
function normalizeRate(value: unknown, prefixed: RegExp, suffixed: RegExp): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  // 去掉可能存在的单位后缀（如 "x0.03 credits"）。
  const head = text.split(/\s+/)[0] ?? ''
  const match = prefixed.exec(head) ?? suffixed.exec(head)
  return match?.[1] !== undefined ? `x${match[1]}` : undefined
}

/** `modelPromotions[].schedule`（活动时段）。 */
interface PromotionSchedule {
  /** 每日时段（可多条），`HH:MM` 形式（实测小时**可能不补零**，如 `7:50`）。 */
  daily?: readonly { start?: unknown; end?: unknown }[]
  /** IANA 时区（实测 `Asia/Shanghai`）。 */
  timezone?: unknown
  /** 生效起点（ISO 字符串，仅部分活动带）。 */
  validFrom?: unknown
  /** 生效终点（ISO 字符串，仅部分活动带）。 */
  validUntil?: unknown
}

/** 解析 `HH:MM`（容忍不补零）为当日分钟数；非法返回 undefined。 */
function parseHHMM(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (m === null) return undefined
  const h = Number(m[1])
  const min = Number(m[2])
  return h < 24 && min < 60 ? h * 60 + min : undefined
}

/**
 * 取指定时区「当前墙上时间」的当日分钟数。
 *
 * 用 `Intl` 而非手算 UTC 偏移：活动时区由服务端下发（实测 `Asia/Shanghai`），
 * 硬编码 +8 在其它时区的活动上会算错。
 */
function zonedMinutes(now: Date, timeZone: unknown): number | undefined {
  const zone = typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'Asia/Shanghai'
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(now)
    const h = Number(parts.find((p) => p.type === 'hour')?.value)
    const m = Number(parts.find((p) => p.type === 'minute')?.value)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : undefined
  } catch {
    // 时区字符串非法（上游改了格式）时返回 undefined，由调用方按「不误杀」处理。
    return undefined
  }
}

/** 活动是否带任何时间窗口（每日时段或有效期）。 */
export function hasTimeWindow(schedule: PromotionSchedule): boolean {
  return (Array.isArray(schedule.daily) && schedule.daily.length > 0)
    || schedule.validFrom !== undefined || schedule.validUntil !== undefined
}

/**
 * 活动在 `now` 是否生效。
 *
 * ⚠️ **必须本地推算，不能只看 `enabled`**：`enabled: true` 只表示活动启用，
 * 是否**此刻**打折由 `schedule` 决定。实测 `glm-5.2` 有两条互补活动
 * （夜间 `23:00–7:50` 带 `0.50x` 折扣、白天 `7:50–23:00` 只带角标），
 * 不看时段就会**全天**显示夜间折扣价（用户按折扣价预期、实际被按原价计费）。
 */
export function promotionActiveNow(item: Record<string, unknown>, now: Date): boolean {
  const raw = item.schedule
  if (typeof raw !== 'object' || raw === null) return true
  const schedule = raw as PromotionSchedule

  const from = typeof schedule.validFrom === 'string' ? Date.parse(schedule.validFrom) : Number.NaN
  const until = typeof schedule.validUntil === 'string' ? Date.parse(schedule.validUntil) : Number.NaN
  if (Number.isFinite(from) && now.getTime() < from) return false
  if (Number.isFinite(until) && now.getTime() >= until) return false

  if (!Array.isArray(schedule.daily) || schedule.daily.length === 0) return true
  const minutes = zonedMinutes(now, schedule.timezone)
  // 时区不可解析时不误杀：宁可多显示一次折扣，也不要让活动凭空消失。
  if (minutes === undefined) return true
  return schedule.daily.some((slot) => {
    if (typeof slot !== 'object' || slot === null) return false
    const start = parseHHMM(slot.start)
    const end = parseHHMM(slot.end)
    if (start === undefined || end === undefined) return false
    // 支持跨零点（如 23:00–7:50）。
    return start <= end ? minutes >= start && minutes < end : minutes >= start || minutes < end
  })
}

/**
 * 从 `/v3/config` 的 `modelTiers` 提取「模型 id → **会员档位标注**」。
 *
 * ## 为什么这是**第二套**数据、不能并进 `parsePromotions`
 *
 * 上游把「折扣/免费活动」与「会员调度优先级」放在**两个顶层键**里，字段结构
 * 完全不同（实测 `acc-product-config-v3.json`）：
 *
 * ```json
 * { "id": "tier-standard-2026q3", "enabled": true, "tier": "standard",
 *   "requiredUserType": "standard", "priority": 20, "trackKey": "model_tier_standard",
 *   "badge": { "label": "订阅优先" },
 *   "hover": { "textZh": "资源紧张，旗舰版及高级版会员享优先调度。",
 *              "action": { "labelZh": "去升级", "type": "upgrade" } },
 *   "modelIds": ["glm-5.3", "glm-5.3-flash", "kimi-k2.8-preview"] }
 * ```
 *
 * 它**没有** `discount` / `schedule` / `kind`，多了 `tier` / `requiredUserType` /
 * `trackKey`。截图里 GLM-5.3 挂的「订阅优先」就是它 —— 此前整类标注从未被读取。
 *
 * ⚠️ 档位标注**不是折扣**：不该带价格，也不该参与「限免/错峰」状态词判定，
 * 否则会把一个"资源调度优先级"说成"打折"。故这里产出的是独立记录，由
 * `promotionView` 分支处理（见其 `tier` 相关注释）。
 */
export function parseModelTiers(
  record: Record<string, unknown>,
  now: Date = new Date(),
): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>()
  const chosen = new Map<string, number>()
  const tiers = record.modelTiers
  if (!Array.isArray(tiers)) return result
  for (const item of tiers) {
    if (typeof item !== 'object' || item === null) continue
    const tier = item as Record<string, unknown>
    if (tier.enabled === false) continue
    // 档位也可能带日期/时段范围（上游当前这条没有，但结构上允许）。
    if (!inDateWindow(tier, now)) continue
    const modelIds = tier.modelIds
    if (!Array.isArray(modelIds)) continue
    const priority = priorityOf(tier)
    for (const id of modelIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      const previous = chosen.get(id)
      if (previous !== undefined && previous > priority) continue
      chosen.set(id, priority)
      result.set(id, tier)
    }
  }
  return result
}

/**
 * 从 `data.modelPromotions` 提取「模型 id → **此刻生效的**促销价」映射。
 *
 * 真实结构（**数组**，不是对象；每项按 `modelIds` 关联，不是全局）：
 * ```json
 * [{ "kind": "discount", "enabled": true, "priority": 100,
 *    "discount": { "discountedCredits": "0.50x", "displayMode": "strikethrough", "factor": 0.5 },
 *    "badge": { "color": "#1E90FF", "label": "夜间折扣" },
 *    "schedule": { "daily": [{ "start": "23:00", "end": "7:50" }], "timezone": "Asia/Shanghai" },
 *    "modelIds": ["glm-5.2"] }]
 * ```
 *
 * 四个必须处理的退化情形：
 * - **时段未到 / 已过**（`schedule`）—— 跳过，见 {@link promotionActiveNow}；
 * - **有效期已过**（`validFrom`/`validUntil`，如 `hy3` 的限时免费）—— 跳过；
 * - `enabled: false` —— 已停用，跳过；
 * - 同一模型命中多条 —— 取 `priority` 最高者。
 *
 * ⚠️ **`factor: 0` 是「免费」而非「活动已结束」**：实测 `hy4-preview` 的夜间活动
 * 是 `{discountedCredits: "0x", displayMode: "replace", factor: 0}` —— 它**真的免费**。
 * 早期实现把 `0x` 当哨兵丢弃，于是「夜间免费」永远不显示（用户报障
 * 「hy4 preview 夜间 0，现在显示 0.29」）。**真正的「已结束」由有效期表达**。
 * 作为防御：**无任何时间窗口**的 `factor: 0` 仍按「已结束占位」跳过 ——
 * 免费额度必然是限时的，没有窗口的 `0x` 更可能是遗留占位。
 */
/**
 * 只看活动日期范围（validFrom/validUntil），忽略每日时段窗口。
 * 用于决定一条促销是否「在其活动期内」——活动期内即使当前不在每日时段
 * 窗口，也给出常驻标注（错峰价 / 活动截止日），对标 Qoder 的「22点后x0.2」。
 */
function inDateWindow(promotion: Record<string, unknown>, now: Date): boolean {
  const schedule = promotion.schedule
  if (typeof schedule !== 'object' || schedule === null) return true
  const s = schedule as PromotionSchedule
  const from = typeof s.validFrom === 'string' ? Date.parse(s.validFrom) : Number.NaN
  const until = typeof s.validUntil === 'string' ? Date.parse(s.validUntil) : Number.NaN
  if (Number.isFinite(from) && now.getTime() < from) return false
  if (Number.isFinite(until) && now.getTime() >= until) return false
  return true
}

/** 把 ISO 日期（YYYY-MM-DD）格式化为「M月D日」用于截止日标注。 */
function parseDisplayDate(iso: unknown): string | undefined {
  if (typeof iso !== 'string') return undefined
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(iso)
  if (m === null) return undefined
  return `${Number(m[2])}月${Number(m[3])}日`
}

/**
 * 为一条促销生成常驻标注文案，例如：
 *   factor:0 + 夜间窗口 + 截止日 →「错峰时段23:00-08:00·限免·至11月1日」
 *   折扣 + 工作日时段           →「错峰时段09:00-12:00/14:00-18:00·非高峰x0.11」
 *
 * 词序固定为**时段 → 价格 → 截止日**：价格只在窗口内成立，先说时段才不会
 * 被读成「任何时候都免费」（模型名上的「(常时)」正是「现在窗口外」）。
 * `active` 为 false 时（当前不在每日时段窗口）额外把错峰价带上，让用户
 * 在窗口外也能看见「到点后能便宜到多少」，与 Qoder 常驻标注同款体验。
 */
function buildPromotionNote(
  promotion: Record<string, unknown>,
  offPeakRate: string | undefined,
  isFree: boolean,
  active: boolean,
): string | null {
  const schedule = promotion.schedule
  if (typeof schedule !== 'object' || schedule === null) return null
  const s = schedule as PromotionSchedule
  const pieces: string[] = []
  if (Array.isArray(s.daily) && s.daily.length > 0) {
    const slots: string[] = []
    for (const slot of s.daily) {
      if (slot === null || typeof slot !== 'object') continue
      if (typeof slot.start !== 'string' || typeof slot.end !== 'string') continue
      const st = parseHHMM(slot.start)
      const en = parseHHMM(slot.end)
      if (st === undefined || en === undefined) continue
      slots.push(`${slot.start}-${slot.end}`)
    }
    // 「错峰时段」而不是「夜间/每日」：夜间窗口（23:00-08:00 跨零点）与日内
    // 窗口（09:00-12:00）说的是同一件事——便宜只在**这个**时段生效，两个词
    // 拆开写反而让用户以为夜间和日内的活动规则不同。
    if (slots.length > 0) pieces.push(`错峰时段${slots.join('/')}`)
  }
  if (isFree) pieces.push('限免')
  else if (!active && offPeakRate !== undefined && offPeakRate !== 'x0') pieces.push(`非高峰${offPeakRate}`)
  const until = typeof s.validUntil === 'string' ? parseDisplayDate(s.validUntil) : undefined
  if (until !== undefined) pieces.push(`至${until}`)
  return pieces.length > 0 ? pieces.join('·') : null
}

export function parsePromotions(
  record: Record<string, unknown>,
  now: Date = new Date(),
): Map<string, { rate: string | null; note: string | null; promo: Record<string, unknown> }> {
  const result = new Map<string, { rate: string | null; note: string | null; promo: Record<string, unknown> }>()
  /**
   * id → 已写入那条的排序键。
   *
   * ⚠️ 排序键**不是**裸 `priority`：实测 `glm-5.2` / `hy4-preview` 各有两条
   * 互补活动（夜间 `priority:100` 带折扣、白天 `priority:50` 只挂角标，两者的
   * `daily` 互不重叠），只按 priority 取高者会让**白天那半段整条消失**——
   * 而白天那条存在的唯一目的就是在白天显示。故先按「此刻是否生效」分层，
   * 再在层内按 priority 取高者：生效的永远压过不生效的，两条互不重叠时
   * 各自在自己的时段里胜出。
   */
  const chosen = new Map<string, { active: number; priority: number }>()
  const promotions = record.modelPromotions
  if (!Array.isArray(promotions)) return result
  // 按 priority 升序排序后依次写入，使高 priority 覆盖低 priority。
  const sorted = [...promotions].sort((a, b) => priorityOf(a) - priorityOf(b))
  for (const item of sorted) {
    if (typeof item !== 'object' || item === null) continue
    const promotion = item as Record<string, unknown>
    if (promotion.enabled === false) continue
    // 活动日期范围外（含未开始 / 已过期）整条忽略；活动期内即使当前不在
    // 每日时段窗口，也给出常驻标注（见下）。
    if (!inDateWindow(promotion, now)) continue
    // ⚠️ **`discount` 不是必需的**：实测三条活动只带 `badge` 而不带 `discount`
    // （`glm-52-night-discount-daytime-badge-202607`、`ds-discount-daytime-badge-202608`、
    // `hy4-night-discount-daytime-badge-202609`），它们负责「在白天把这个标挂上」，
    // 本就不含价格。早期版本在这里 `continue`，于是白天没有任何促销标记。
    const discount = promotion.discount
    const detail = typeof discount === 'object' && discount !== null
      ? discount as Record<string, unknown>
      : undefined
    const factor = detail !== undefined && typeof detail.factor === 'number' ? detail.factor : undefined
    const rawSchedule = promotion.schedule
    const windowed = typeof rawSchedule === 'object' && rawSchedule !== null
      && hasTimeWindow(rawSchedule as PromotionSchedule)
    const isFree = factor === 0
    const offPeakRate = isFree ? '免费' : normalizeDiscountedRate(detail?.discountedCredits)
    const active = promotionActiveNow(promotion, now)
    const note = detail === undefined ? null : buildPromotionNote(promotion, offPeakRate, isFree, active)
    // 仅当处于每日时段窗口内才把折扣价写进 rate；窗口外保留原价（与历史
    // 行为一致），错峰价由 note 常驻标注。无 `discount` 的活动（纯角标）
    // 永远不带 rate —— 它没有价格可言。
    let rate: string | null = null
    if (detail !== undefined && active) {
      if (isFree) {
        // 免费额度必须限时；无窗口的 `0x` 视为「已结束」占位（保持旧行为）。
        if (!windowed) continue
        rate = '免费'
      } else {
        const r = normalizeDiscountedRate(detail.discountedCredits)
        // 归一化后仍是 `x0` 说明是无 factor 的 `0x` 占位，同样跳过。
        if (r === 'x0' || r === undefined) continue
        rate = r
      }
    }
    const modelIds = promotion.modelIds
    if (!Array.isArray(modelIds)) continue
    const priority = priorityOf(promotion)
    const rank = { active: active ? 1 : 0, priority }
    for (const id of modelIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      const previous = chosen.get(id)
      // 生效的压过不生效的；同为生效（或同为不生效）时再比 priority。
      if (previous !== undefined
        && (previous.active > rank.active
          || (previous.active === rank.active && previous.priority > rank.priority))) continue
      chosen.set(id, rank)
      result.set(id, { rate, note, promo: promotion })
    }
  }
  return result
}

/**
 * 促销徽标的**结构化**数据（独立字段，不走 `description`）。
 *
 * ## 为什么必须是独立字段
 *
 * `description` 是宿主与各适配器共用的通用字段：buddy 往它写促销标注，Cline /
 * lobsterai 却把上游模型介绍（`Mixture-of-Experts architecture…`）原样透传，
 * 于是「字段非空就是促销」的判据会把模型宣传语渲染成促销胶囊（用户报障
 * 「其他供应商出现奇怪的标签」）。促销有自己的一套语义（活动类型、双段价格、
 * 多段时段、展示方式），塞进一个通用字符串字段既表达不了、又必然误伤，
 * 故单独声明 `promo`，由 `model.list` 原样搬运、客户端按结构渲染。
 *
 * ## 字段来源（`/v3/config` 的 `modelPromotions[]`，实测结构）
 *
 * ```json
 * [{ "kind": "discount", "enabled": true, "priority": 100,
 *    "discount": { "discountedCredits": "0.50x", "displayMode": "strikethrough", "factor": 0.5 },
 *    "schedule": { "daily": [{"start":"23:00","end":"08:00"}], "timezone": "Asia/Shanghai",
 *                  "validFrom": "2026-10-01", "validUntil": "2026-11-01" },
 *    "modelIds": ["glm-5.2"] }]
 * ```
 *
 * ⚠️ **`daily` 是数组**：一个活动可以有多段时段（如工作日 `09:00-12:00/14:00-18:00`），
 * 故这里原样保留数组，不压成字符串——压平之后客户端再也无法逐段判断当下是否在
 * 某个窗口内，也就画不出「当前处于第几段」。
 *
 * ⚠️ **价格是两段**：`displayMode: "strikethrough"` 表示上游要求「原价划掉 +
 * 折后价」（`factor` 给倍率、`discountedCredits` 给展示串），`"replace"` 表示
 * 只显示折后价。只留一个数会丢掉原价，用户看不出折扣幅度；只留原价又会按
 * 原价预期、实际被按折后价计费。故 `price` 同时带 `effective` 与 `original`。
 */
export interface PromotionBadge {
  /** 上游活动类型（`kind`），如 `discount`。缺失时不写。 */
  kind?: string
  /** 展示方式：`strikethrough`（原价划掉）或 `replace`（只显示折后价）。 */
  displayMode?: string
  /** 价格两段：`effective` 为生效价、`original` 为原价（有折扣时才给）。 */
  price?: { effective?: string; original?: string }
  /** 每日时段，**保留多段**（`HH:MM` 原样）。无 daily 窗口时不写。 */
  windows?: { start: string; end: string }[]
  /** IANA 时区（实测 `Asia/Shanghai`）。 */
  timezone?: string
  /** 活动生效日期范围（ISO 字符串）。 */
  validFrom?: string
  validUntil?: string
  /** 当前是否处于某段每日窗口内（展示时实时判定，非采集时刻的冻结值）。 */
  active: boolean
  /** 状态词：（限免）/（错峰）/（常时）。 */
  status?: string
  /** 人读长标注，如「错峰时段23:00-08:00·限免·至11月1日」。 */
  note?: string
  /** 命中的活动 `priority`（同模型多活动时取最高者）。 */
  priority?: number
  /** 上游活动 `id`（如 `glm-52-night-discount-202607`）。 */
  id?: string
  /**
   * 上游自带的展示标签（`badge.label`，如「夜间折扣」「限时免费」「订阅优先」）。
   *
   * ⚠️ 这是**权威展示串**：有它时消费端应优先用它，而不是自己拼的状态词——
   * 上游口径（含它自己的不一致）才是用户能在官方 UI 里对上号的东西。
   */
  badgeLabel?: string
  /** 上游短标签（`badge.shortLabel`，如「折扣」），窄容器用。 */
  badgeShortLabel?: string
  /** 上游指定颜色（`badge.color`，如 `#1E90FF` / `#FF0000` / `#009273`）。 */
  badgeColor?: string
  /** 上游显示策略（`badge.display`）：`activeOnly` = 仅活动生效时显示。 */
  badgeDisplay?: string
  /** 上游悬停说明（`hover.textZh`）。 */
  hoverText?: string
  /** 上游悬停动作文案（`hover.action.labelZh`，如「去使用」「去升级」）。 */
  hoverActionLabel?: string
  /**
   * 会员档位（仅 `kind === 'tier'`，来自 `modelTiers`）：`standard` 等。
   *
   * 档位标注**没有**价格与状态词 —— 它表达的是"资源紧张时谁先被调度"，
   * 不是折扣。消费端据此走"只显示标签"的分支。
   */
  tier?: string
  /** 档位要求的会员类型（`modelTiers[].requiredUserType`，如 `standard`）。 */
  requiredUserType?: string
}

/** `promotionView` 的展示结果：当前生效倍率、状态词、常驻长标注。 */
export interface PromotionView {
  /** 当前生效倍率（促销窗口内取折扣价/免费，否则取原价）。无促销或活动期外为 undefined。 */
  effectiveRate?: string
  /** 状态词：（限免）/（错峰）/（常时）；无促销或活动期外为 undefined。 */
  status?: string
  /** 常驻长标注（活动截止日 + 时段窗口 + 窗口外错峰价），用于 description 副行。 */
  note?: string
  /**
   * 结构化促销徽标（独立字段）。无促销或活动期外为 undefined。
   *
   * ⚠️ 这是**新的**下发行，`note` 保留给历史调用方（`description` 副行）；
   * `model.list` 搬的是本字段，客户端不从 `note` 反推结构。
   */
  badge?: PromotionBadge
}

/**
 * 按 `now` 实时推算某模型的促销展示信息。
 *
 * ⚠️ **必须展示时调用（而非 config 解析时烘焙）**：远端目录是懒加载且只拉一次，
 * 若在 `parsePromotions` 里就把 `discountedCreditsRate` / `promotionNote` 写死，
 * 判定结果会被冻结进模型名与 `isFreeModel`——夜间拉取后白天仍显示「免费」，
 * 既让模型选择器误导，又会让 `isFreeModel` 把付费模型误判成免费、绕过永久积分
 * 的保护锁（见 #155 复盘的「白天显示免费」）。本函数每次调用都按当前时刻重算，
 * 到点自动翻面。
 *
 * 状态词口径：
 * - `限免`：factor:0 且**无每日时段窗口**（活动期内任意时刻免费，如 Hy3）；
 * - `错峰`：当前处于促销每日时段窗口内（含免费或折扣，如 Hy4 夜间免费）；
 * - `常时`：促销在活动期内但当前不在每日时段窗口（原价常驻，到点自动转错峰）。
 * 无促销或活动期外不返回任何信息（模型名退化为仅显示原价）。
 */
export function promotionView(
  model: { creditsRate?: string; promotion?: Record<string, unknown>; modelTier?: Record<string, unknown> },
  now: Date = new Date(),
): PromotionView {
  const promo = model.promotion
  const tier = model.modelTier
  // 档位标注（`modelTiers`）是**独立于促销**的第二套来源：无促销时它照样要出标。
  if (typeof promo !== 'object' || promo === null) {
    return typeof tier === 'object' && tier !== null && tier.enabled !== false && inDateWindow(tier, now)
      ? { badge: buildTierBadge(tier) }
      : {}
  }
  if (promo.enabled === false) return {}
  // 活动日期范围外（未开始 / 已过期）→ 视为无促销，模型名退化为原价。
  if (!inDateWindow(promo, now)) return {}
  // ⚠️ **`discount` 可以缺失**：实测 `glm-5.2` / `hy4-preview` / `deepseek-v4.1-flash`
  // 各有一条「白天挂标」活动只有 `badge` 而没有 `discount`，它的职责只是把标挂上。
  // 早期版本在这里 `return {}`，于是白天这些模型的徽标整条消失（而白天正是它
  // 存在的意义）。缺 `discount` 表示「没有价格」，不是「没有活动」。
  const discount = promo.discount
  const detail = typeof discount === 'object' && discount !== null
    ? discount as Record<string, unknown>
    : undefined
  const factor = detail !== undefined && typeof detail.factor === 'number' ? detail.factor : undefined
  const isFree = factor === 0
  const schedule = promo.schedule
  // 状态词只看「每日时段窗口」：有 daily 窗口的免费促销是「错峰」（仅窗口内免费），
  // 仅日期范围、无 daily 窗口的免费促销是「限免」（活动期内任意时刻免费，如 Hy3）。
  // 注意不能用 hasTimeWindow（它把 validFrom/validUntil 也算作窗口），否则会把
  // 日期范围的限免误判成错峰。
  const hasDaily = typeof schedule === 'object' && schedule !== null
    && Array.isArray(schedule.daily) && schedule.daily.length > 0
  const active = promotionActiveNow(promo, now)
  const offPeakRate = isFree ? '免费' : normalizeDiscountedRate(detail?.discountedCredits)
  // 无价格的活动没有 `note` 可言（那个函数是绕着价格写的），但仍有徽标。
  const note = detail === undefined ? undefined : buildPromotionNote(promo, offPeakRate, isFree, active) ?? undefined
  // 当前生效倍率：促销窗口内取折扣价/免费，否则取原价。无 `discount` 时恒为原价。
  const effectiveRate = detail !== undefined && active
    ? normalizeDiscountedRate(detail.discountedCredits)
    : model.creditsRate
  // 状态词。无 `discount` 的活动不参与状态词判定 —— 它没有折后价，
  // 写「限免/错峰」都是在编造一个不存在的价格。
  let status: string | undefined
  if (detail !== undefined) {
    if (active) {
      status = isFree && !hasDaily ? '限免' : '错峰'
    } else {
      status = '常时'
    }
  }
  const badge = buildPromotionBadge(promo, detail, model.creditsRate, active, status, note)
  return { effectiveRate, status, note, badge }
}

/**
 * 把一条原始促销装配成**结构化**徽标数据（独立字段 `promo` 的取值）。
 *
 * 与 `buildPromotionNote` 的分工：那个函数只产出**一句话**（给人读、也被
 * `/model` 弹窗当 description 副行用）；本函数产出**结构**（给客户端渲染与
 * 逐段判定用，不再要求它去解析字符串）。两者共用同一份原始 `promotion`，
 * 故文案与结构永远同源、不会各说各话。
 *
 * ⚠️ 双段价格只在**真有折扣**时给 `original`：`factor: 0` 的免费活动，
 * 原价就是 `model.creditsRate`（如 `x0.29`），带上它才能画出「x0.29→x0」
 * 的划掉效果；如果上游没给原价（既无 displayMode 也无 creditsRate），
 * 就只给 `effective`，不编造。
 */
function buildPromotionBadge(
  promotion: Record<string, unknown>,
  detail: Record<string, unknown> | undefined,
  creditsRate: string | undefined,
  active: boolean,
  status: string | undefined,
  note: string | undefined,
): PromotionBadge {
  const schedule = (typeof promotion.schedule === 'object' && promotion.schedule !== null
    ? promotion.schedule
    : {}) as PromotionSchedule
  // 时段**逐段保留**（不 join 成字符串）：客户端要能判断"现在处于第几段"。
  const windows: { start: string; end: string }[] = []
  if (Array.isArray(schedule.daily)) {
    for (const slot of schedule.daily) {
      if (slot === null || typeof slot !== 'object') continue
      if (typeof slot.start !== 'string' || typeof slot.end !== 'string') continue
      if (parseHHMM(slot.start) === undefined || parseHHMM(slot.end) === undefined) continue
      windows.push({ start: slot.start, end: slot.end })
    }
  }
  const effective = detail === undefined ? undefined : normalizeDiscountedRate(detail.discountedCredits)
  // ⚠️ 只有**两段价格真的不同**时才给 `original`：`factor: 0` 且原价本就是
  // `x0.00` 的活动（Hy3 这类"活动期内随时免费"）两段同值，带上它会渲染出
  // 「x0.00→x0.00」这种既不表达折扣、又占宽度的胶囊。判据用**值**而不是
  // `factor`：factor 只说明"有活动"，说明不了"原价与折后价不同"。
  const original = detail === undefined ? undefined : creditsRate
  const price = effective === undefined && original === undefined
    ? undefined
    : {
        ...effective === undefined ? {} : { effective },
        ...original !== undefined && original !== effective ? { original } : {},
      }
  const kind = typeof promotion.kind === 'string' && promotion.kind.trim() !== '' ? promotion.kind : undefined
  const displayMode = detail !== undefined && typeof detail.displayMode === 'string' && detail.displayMode.trim() !== ''
    ? detail.displayMode
    : undefined
  const timezone = typeof schedule.timezone === 'string' && schedule.timezone.trim() !== '' ? schedule.timezone : undefined
  const validFrom = typeof schedule.validFrom === 'string' ? schedule.validFrom : undefined
  const validUntil = typeof schedule.validUntil === 'string' ? schedule.validUntil : undefined
  const priority = typeof promotion.priority === 'number' && Number.isFinite(promotion.priority)
    ? promotion.priority
    : undefined
  // 上游自己给的展示标签与悬停说明，**原样透传**（见 PromotionBadge 的 badgeLabel 注释）。
  const upstream = readUpstreamBadge(promotion)
  return {
    ...kind === undefined ? {} : { kind },
    ...displayMode === undefined ? {} : { displayMode },
    ...price === undefined ? {} : { price },
    ...windows.length === 0 ? {} : { windows },
    ...timezone === undefined ? {} : { timezone },
    ...validFrom === undefined ? {} : { validFrom },
    ...validUntil === undefined ? {} : { validUntil },
    active,
    ...status === undefined ? {} : { status },
    ...note === undefined ? {} : { note },
    ...priority === undefined ? {} : { priority },
    ...upstream.id === undefined ? {} : { id: upstream.id },
    ...upstream.label === undefined ? {} : { badgeLabel: upstream.label },
    ...upstream.shortLabel === undefined ? {} : { badgeShortLabel: upstream.shortLabel },
    ...upstream.color === undefined ? {} : { badgeColor: upstream.color },
    ...upstream.display === undefined ? {} : { badgeDisplay: upstream.display },
    ...upstream.hoverText === undefined ? {} : { hoverText: upstream.hoverText },
    ...upstream.actionLabel === undefined ? {} : { hoverActionLabel: upstream.actionLabel },
  }
}

/**
 * 把一条 `modelTiers` 记录装配成徽标（第二套来源，**不带价格、不带状态词**）。
 *
 * 与 `buildPromotionBadge` 的分工：那个处理的是"折扣/免费"（要双段价格、要
 * 时段窗口、要 active 判定）；本函数处理的是"会员档位"（只有标签与说明）。
 * 两者产出同一个 `PromotionBadge` 形状，是为了让消费端只认一个字段 ——
 * 但档位**不写** `price` / `status` / `displayMode`：它没有价格可言，
 * 写上去就等于把"调度优先级"说成"打折"。
 */
function buildTierBadge(tier: Record<string, unknown>): PromotionBadge {
  const upstream = readUpstreamBadge(tier)
  const tierName = typeof tier.tier === 'string' && tier.tier.trim() !== '' ? tier.tier.trim() : undefined
  const requiredUserType = typeof tier.requiredUserType === 'string' && tier.requiredUserType.trim() !== ''
    ? tier.requiredUserType.trim()
    : undefined
  const priority = typeof tier.priority === 'number' && Number.isFinite(tier.priority) ? tier.priority : undefined
  return {
    kind: 'tier',
    // 档位恒为"生效"（它不是按时段闪断的折扣；要按档位显示与否的是会员身份，
    // 那个判定不在本插件侧），故 active 恒 true。
    active: true,
    ...upstream.id === undefined ? {} : { id: upstream.id },
    ...upstream.label === undefined ? {} : { badgeLabel: upstream.label },
    ...upstream.shortLabel === undefined ? {} : { badgeShortLabel: upstream.shortLabel },
    ...upstream.color === undefined ? {} : { badgeColor: upstream.color },
    ...upstream.display === undefined ? {} : { badgeDisplay: upstream.display },
    ...upstream.hoverText === undefined ? {} : { hoverText: upstream.hoverText },
    ...upstream.actionLabel === undefined ? {} : { hoverActionLabel: upstream.actionLabel },
    ...tierName === undefined ? {} : { tier: tierName },
    ...requiredUserType === undefined ? {} : { requiredUserType },
    ...priority === undefined ? {} : { priority },
  }
}

/**
 * 读取上游自己给的展示标签（`badge` / `hover` / `id`）。
 *
 * ## 为什么必须透传而不是我们自编
 *
 * 上游**已经**为每条活动准备了展示串，而且比我们能推断的更准：
 *
 * ```json
 * { "id": "glm-52-night-discount-202607",
 *   "badge": { "color": "#1E90FF", "label": "夜间折扣" },
 *   "hover": { "textZh": "每晚 23:00—次日 8:00 积分限时立减，错峰用更省",
 *              "action": { "labelZh": "去使用" } } }
 * ```
 *
 * 我们此前只留 `factor` 与 `daily`，然后**自己拼**一个状态词（`限免`/`错峰`）
 * 和一句 note，结果是同一条活动在两处各说各话（用户看到的「错峰时段…限免」
 * 并非上游文案）。上游给什么就显示什么，既省掉一套推断、也不会与官方口径冲突。
 *
 * ⚠️ **上游的标签与说明可能自相矛盾，也照样透传**：实测
 * `ds-discount-daytime-badge-202608`（`deepseek-v4.1-flash` 那条）的 label 是
 * 「夜间折扣」，而 `hover.textZh` 说的是「周一至周五 09:00–12:00、14:00–18:00
 * 属高峰原价，非高峰期积分5折」。纠正它就得编造一套"更正确"的说法，
 * 那比照抄一个已知不一致的官方说法更糟（用户对不上官方 UI 就无从判断）。
 *
 * `badge.display === 'activeOnly'` 表示**仅在活动生效时**显示该标（`hy3` 用它）；
 * 该语义由消费端结合 `active` 判定，这里只搬运。
 */
function readUpstreamBadge(promotion: Record<string, unknown>): {
  id?: string
  label?: string
  shortLabel?: string
  color?: string
  display?: string
  hoverText?: string
  actionLabel?: string
} {
  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  const badge = typeof promotion.badge === 'object' && promotion.badge !== null
    ? promotion.badge as Record<string, unknown>
    : undefined
  const hover = typeof promotion.hover === 'object' && promotion.hover !== null
    ? promotion.hover as Record<string, unknown>
    : undefined
  const action = hover !== undefined && typeof hover.action === 'object' && hover.action !== null
    ? hover.action as Record<string, unknown>
    : undefined
  return {
    id: str(promotion.id),
    label: str(badge?.label),
    shortLabel: str(badge?.shortLabel),
    color: str(badge?.color),
    display: str(badge?.display),
    hoverText: str(hover?.textZh),
    actionLabel: str(action?.labelZh),
  }
}

/** 读取促销项的 priority；缺失或非法时按 0（最低）处理。 */
function priorityOf(item: unknown): number {
  if (typeof item !== 'object' || item === null) return 0
  const priority = (item as Record<string, unknown>).priority
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0
}

/**
 * 组合计费倍率的展示文案：有促销时标出促销价，否则只显示原价。
 *
 * 形态：`"x0.17→x0.50"`；无促销时 `"x0.03"`。
 *
 * 用箭头而非「（促销 x…）」：这段文案会被拼进**模型切换菜单的名字**里
 * （见 buddy-adapter 的 displayNameFor），菜单宽度有限，箭头更短且一眼
 * 看出折扣幅度。
 */
export function formatCreditsRate(
  rate: string | undefined,
  discounted: string | undefined,
): string | undefined {
  if (rate === undefined) return discounted
  return discounted !== undefined ? `${rate}→${discounted}` : rate
}

/**
 * 从 /v3/config 响应解析可用的对话模型。
 *
 * 响应结构：{data: {agents: [{name: "craft", models: ["auto", ...]}, ...],
 *                     models: [{id, name, maxInputTokens, supportsImages, reasoning: {...}}],
 *                     productFeaturesConfig?: {ModelTrialBanner: {banners: [{targetModelId}]}}}}
 *
 * 解析策略（顺序即优先级）：
 * 1. **craft agent 引用的模型** —— 主对话模型，排在最前（中国版由它列出
 *    hy4-preview / glm-5.3 等具体 id）。
 * 2. **data.models 中剩余的可对话模型** —— 国际版的 craft 只引用 5 个抽象别名
 *    （default-model/fast-model/…），其余可用模型（如 o4-mini）只出现在
 *    data.models 里；若只取 craft，这些模型会在选择器中消失。
 * 3. **试用模型**（productFeaturesConfig.ModelTrialBanner）—— 例如国际版的
 *    hy4-preview：它既不在 craft 列表也不在 data.models，仅由试用横幅下发，
 *    但实测可正常调用，故一并加入。
 *
 * 过滤规则：跳过 `auto`（自动选择，非真实模型）、非对话用途的模型
 * （`text-to-image` 标签）与补全/NES 等专用模型（id 前缀 nes- / completion-）。
 * 解析失败时返回空数组，调用方回退内置列表。
 */
export function parseModelsFromConfig(body: unknown): BuddyRemoteModel[] {
  if (typeof body !== 'object' || body === null) return []
  const data = (body as Record<string, unknown>).data
  if (typeof data !== 'object' || data === null) return []
  const record = data as Record<string, unknown>

  // data.models: id → 远端声明的模型元数据
  const metaById = new Map<string, Record<string, unknown>>()
  if (Array.isArray(record.models)) {
    for (const model of record.models as unknown[]) {
      if (typeof model !== 'object' || model === null) continue
      const entry = model as Record<string, unknown>
      if (typeof entry.id === 'string') metaById.set(entry.id, entry)
    }
  }

  // 促销折扣是**独立于 data.models 的全局活动表**，故先解析成 id → 促销价映射，
  // 再在 push 时按 id 关联（见 parsePromotions 的注释）。
  const promotions = parsePromotions(record)

  // 收集**全部** agent 引用的 id（含 craft/ask/plan/cli）。
  // 用于给模型打 `agentReferenced` 标记 —— 适配器的 `reconcileWithFallback`
  // 是白名单式重建，不在产品兜底表里的 id 会被丢弃，而两个端点下发的 id
  // 集合不同（实测 `hy4-preview-f` 只在 /v3/config 里且被 agent 引用），
  // 该标记让「服务端说可选」的模型得以保留。
  const agentReferencedIds = new Set<string>()
  if (Array.isArray(record.agents)) {
    for (const agent of record.agents as unknown[]) {
      if (typeof agent !== 'object' || agent === null) continue
      const models = (agent as Record<string, unknown>).models
      if (!Array.isArray(models)) continue
      for (const model of models) if (typeof model === 'string') agentReferencedIds.add(model)
    }
  }

  const parsed: BuddyRemoteModel[] = []
  const seen = new Set<string>()
  const push = (id: string): void => {
    if (isAutoSelectAlias(id) || seen.has(id) || !isChatModel(id, metaById.get(id))) return
    seen.add(id)
    const meta = metaById.get(id)
    // 显示名优先用服务端下发的 name（如 `GPT-5.6-Sol`、`GLM-5.3`）；
    // 静态表只在服务端未给 name 时兜底 —— 新模型不在静态表里，
    // 而静态表对老模型的叫法可能已过时（如 kimi-k2.6 旧名 Kimi K2.6）。
    const remoteName = typeof meta?.name === 'string' && meta.name.length > 0 ? meta.name : undefined
    const rate = normalizeCreditsRate(meta?.credits)
    const discounted = promotions.get(id)
    parsed.push({
      id,
      name: remoteName ?? displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== undefined ? { creditsRate: rate } : {},
      ...discounted !== undefined && discounted.rate !== null ? { discountedCreditsRate: discounted.rate } : {},
      ...discounted !== undefined && discounted.note !== null ? { promotionNote: discounted.note } : {},
      ...discounted !== undefined ? { promotion: discounted.promo } : {},
      ...agentReferencedIds.has(id) ? { agentReferenced: true } : {},
    })
  }

  // 1. 主对话 agent 引用的模型优先。
  //
  // 两个端点用不同的 agent 名承载「输入框可选的模型」：
  // - 企业模型端点（/console/enterprises/{scope}/models）用 `cli`；
  // - /v3/config 用 `craft`。
  // 取先出现的那个（两者不会同时存在）。
  for (const agentName of PREFERRED_AGENT_NAMES) {
    let found = false
    const agents = record.agents
    if (!Array.isArray(agents)) break
    for (const agent of agents) {
      if (typeof agent !== 'object' || agent === null) continue
      const agentRecord = agent as Record<string, unknown>
      if (agentRecord.name !== agentName) continue
      if (Array.isArray(agentRecord.models)) {
        for (const model of agentRecord.models) {
          if (typeof model === 'string') push(model)
        }
      }
      found = true
      break
    }
    if (found) break
  }

  // 2. 补齐 data.models 里其余可对话模型（含企业端点独有的模型）
  for (const id of metaById.keys()) push(id)

  // 3. 追加试用模型（试用横幅下发的 targetModelId）
  for (const id of trialModelIds(record)) {
    if (isAutoSelectAlias(id) || seen.has(id)) continue
    seen.add(id)
    const meta = metaById.get(id)
    const rate = normalizeCreditsRate(meta?.credits)
    const discounted = promotions.get(id)
    parsed.push({
      id,
      name: displayNameForModel(id),
      ...parseModelMeta(meta),
      ...rate !== undefined ? { creditsRate: rate } : {},
      ...discounted !== undefined && discounted.rate !== null ? { discountedCreditsRate: discounted.rate } : {},
      ...discounted !== undefined && discounted.note !== null ? { promotionNote: discounted.note } : {},
      ...discounted !== undefined ? { promotion: discounted.promo } : {},
      // 试用横幅本身就是「服务端推荐可用」的信号，与 agent 引用同义。
      agentReferenced: true,
    })
  }

  return parsed
}

/**
 * 承载「可选对话模型」清单的 agent 名，按优先级排列。
 *
 * - `cli`：企业模型端点（/console/enterprises/{scope}/models）使用；
 * - `craft`：/v3/config 使用。
 */
const PREFERRED_AGENT_NAMES = ['cli', 'craft'] as const

/** 从 productFeaturesConfig.ModelTrialBanner 提取试用模型 id。 */
function trialModelIds(data: Record<string, unknown>): string[] {
  const features = data.productFeaturesConfig
  if (typeof features !== 'object' || features === null) return []
  const banner = (features as Record<string, unknown>).ModelTrialBanner
  if (typeof banner !== 'object' || banner === null) return []
  const banners = (banner as Record<string, unknown>).banners
  if (!Array.isArray(banners)) return []
  const ids: string[] = []
  for (const item of banners) {
    if (typeof item !== 'object' || item === null) continue
    const target = (item as Record<string, unknown>).targetModelId
    if (typeof target === 'string' && target.length > 0) ids.push(target)
  }
  return ids
}

/**
 * 判断 data.models 中的条目是否为「可供用户选择的对话模型」。
 *
 * 排除三类非对话/不可用模型（判定依据来自真实的 /v3/config 响应与调用实测）：
 * - 补全/NES 专用模型：id 以 `nes-` / `completion-` 开头，或带 `supportsExtra`
 *   标记（codewise-completions / codewise-rewrite / codewise-jump），或
 *   `codewise-` 前缀（codewise-default-model-v2 实测返回
 *   `code 11102 model service info not found`，即后端未开放）；
 * - 输出上限过小的模型（≤256 tokens 的都是补全用途，对话模型普遍 ≥24000）；
 * - 带 `text-to-image` 标签的生成式模型（如 hunyuan-image-alpha）。
 *
 * 这些模型列进选择器会让用户选了之后报错，故一律过滤。
 */
/**
 * 是否为「自动选择」类的内部别名，不应出现在模型选择器里。
 *
 * 实测（2026-09-21）企业模型端点同时下发两个：
 * - `auto`（展示名 `Auto`）—— 老牌别名，早期只过滤了它；
 * - **`default`（展示名 `Default`）** —— 同类别名，**未被任何 agent 引用**。
 *
 * 两者都不是真实模型（服务端自行挑一个后端），列出来会让用户误以为可选。
 * 国际版还有 `default-model` / `fast-model` 等抽象别名，但那些**被 craft agent
 * 引用**（是官方推荐的入口），故只按这两个字面量过滤，不做前缀匹配 ——
 * 前缀匹配会误伤 `default-model`。
 */
function isAutoSelectAlias(id: string): boolean {
  return id === 'auto' || id === 'default'
}

function isChatModel(id: string, meta: Record<string, unknown> | undefined): boolean {  if (id.startsWith('nes-') || id.startsWith('completion-') || id.startsWith('codewise-')) return false
  if (meta?.supportsExtra === true) return false
  const maxOutput = meta?.maxOutputTokens
  if (typeof maxOutput === 'number' && maxOutput > 0 && maxOutput <= 256) return false
  const tags = meta?.tags
  if (Array.isArray(tags) && tags.some((tag) => tag === 'text-to-image')) return false
  return true
}

/**
 * 提取单个 data.models[] 条目的上下文窗口与对话能力。
 *
 * 上下文窗口只保留正数（与 Rust 端一致）。能力字段只在远端**显式**下发时保留：
 * 缺失即 undefined，交由适配器的静态兜底表决定，而不是猜成 false。
 */
function parseModelMeta(record: Record<string, unknown> | undefined): Omit<BuddyRemoteModel, 'id' | 'name'> {
  if (record === undefined) return {}
  const meta: Omit<BuddyRemoteModel, 'id' | 'name'> = {}
  const limit = record.maxInputTokens
  if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) meta.contextWindow = limit
  // 单次输出上限：与上下文窗口同样「只保留正数」，缺失即 undefined
  // （不猜默认值——猜错会要么截断用户输出、要么被服务端 400 拒绝）。
  const maxOutput = record.maxOutputTokens
  if (typeof maxOutput === 'number' && Number.isFinite(maxOutput) && maxOutput > 0) {
    meta.maxOutputTokens = maxOutput
  }
  if (typeof record.supportsImages === 'boolean') meta.supportsImages = record.supportsImages
  const reasoning = record.reasoning
  if (typeof reasoning === 'object' && reasoning !== null) {
    const fields = reasoning as Record<string, unknown>
    // supportedEfforts 是**可枚举**的等级列表，只在模型真正支持多等级时下发；
    // 只有单一默认 effort 的模型（glm-5.1/kimi-*）此处缺省，不暴露等级选择器。
    if (Array.isArray(fields.supportedEfforts)) {
      const efforts = fields.supportedEfforts.filter((e): e is string => typeof e === 'string' && e.length > 0)
      if (efforts.length > 0) meta.reasoningEfforts = efforts
    }
    if (typeof fields.defaultEffort === 'string' && fields.defaultEffort.length > 0) {
      meta.defaultReasoningEffort = fields.defaultEffort
    }
  }
  return meta
}
