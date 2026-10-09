/**
 * 腾讯 CodeBuddy 认证网络流程（external-link-v2 轮询式）
 *
 * 对齐 IDE genie 扩展的 NativeAuthBridgeService，流程为
 * fetchAuthState → 打开浏览器 → 轮询 token → 轮询 account，
 * 另有 refreshToken 静默续期与 fetchModels 远端模型拉取。
 *
 * 所有网络调用都接受注入的 fetcher，便于测试与复用；浏览器打开器同理。
 */

import {
  AUTH_REFRESH_SOURCE,
  AUTH_REFRESH_PATH,
  AUTH_STATE_PATH,
  AUTH_TOKEN_PATH,
  BUDDY_DEPLOYMENT_TYPE,
  CODE_ACCOUNT_NOT_READY,
  CODE_TOKEN_NOT_READY,
  CONFIG_PATH,
  HTTP_HEADER_AUTH_REFRESH_SOURCE,
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_NO_AUTHORIZATION,
  HTTP_HEADER_NO_DEPARTMENT_INFO,
  HTTP_HEADER_NO_ENTERPRISE_ID,
  HTTP_HEADER_NO_USER_ID,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  HTTP_HEADER_REFRESH_TOKEN,
  LOGIN_ACCOUNT_PATH,
  LOGIN_TIMEOUT_MS,
  POLL_INTERVAL_MS,
  REQUEST_TIMEOUT_MS,
  STATE_REQUEST_TIMEOUT_MS,
  buildCredential,
  credentialAuthHeaders,
  credentialExpiresAtMs,
  credentialRequestHeaders,
  isRefreshable,
  parseAccountData,
  parseModelTiers,
  parseModelsFromConfig,
  parsePromotions,
  parseTokenData,
} from './buddy.js'
import type { BuddyAccount, BuddyCredential, BuddyRemoteModel, BuddyToken } from './buddy.js'
import { CODEBUDDY, type BuddyProduct } from './product.js'

/** 在浏览器中打开登录 URL；永不抛出（失败时打印 URL 供手动打开）。 */
export type OpenBrowser = (url: string) => void

/** 一次登录流程的结果。 */
export interface BuddyLoginFlowResult {
  /** 已序列化的 BuddyCredential JSON。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 展示给用户的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** runBuddyLoginFlow 接受的选项。 */
export interface BuddyLoginFlowOptions {
  /** 使用的 fetch 实现；默认为全局 fetch。 */
  fetcher?: typeof fetch
  /** 在浏览器中打开登录 URL；默认使用平台打开器。 */
  openBrowser?: OpenBrowser
  /** 轮询总超时（毫秒）；默认为 5 分钟。 */
  timeoutMs?: number
  /** 轮询间隔（毫秒）；默认为 1 秒。 */
  pollIntervalMs?: number
  /** 已有的 auth state（跳过 fetchAuthState，直接使用此 state 轮询 token）。 */
  state?: string
  /** 产品配置；默认为 CodeBuddy。 */
  product?: BuddyProduct
}

/** 从 JSON 响应体读取错误码。 */
function responseCode(body: unknown): number {
  if (typeof body !== 'object' || body === null) return 0
  const code = (body as Record<string, unknown>).code
  return typeof code === 'number' ? code : 0
}

/** 从 JSON 响应体读取 message 字段。 */
function responseMessage(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const message = (body as Record<string, unknown>).message
  return typeof message === 'string' ? message : ''
}

/** 从 JSON 响应体读取 data 字段（null/undefined 视为缺失）。 */
function responseData(body: unknown): unknown {
  if (typeof body !== 'object' || body === null) return undefined
  const data = (body as Record<string, unknown>).data
  return data === null ? undefined : data
}

/** request() 的调用选项。 */
interface RequestOptions {
  fetcher: typeof fetch
  /** 请求超时（毫秒）。 */
  timeoutMs: number
  /** 外部取消信号；与自身超时任一触发即中止。 */
  signal?: AbortSignal
}

/** 发起一次 CodeBuddy 控制面请求，返回 (status, body)。网络失败会抛出。 */
async function request(
  method: 'GET' | 'POST',
  url: string,
  headers: Record<string, string>,
  options: RequestOptions,
): Promise<{ status: number; body: unknown }> {
  const signal = options.signal === undefined
    ? AbortSignal.timeout(options.timeoutMs)
    : AbortSignal.any([AbortSignal.timeout(options.timeoutMs), options.signal])
  let response: Response
  try {
    response = await options.fetcher(url, { method, headers, signal })
  } catch (error) {
    throw new Error(`CodeBuddy ${method} ${url} network error: ${String(error)}`)
  }
  let body: unknown = null
  try {
    body = (await response.json()) as unknown
  } catch {
    body = null
  }
  return { status: response.status, body }
}

/**
 * POST /v2/plugin/auth/state?platform=<product.platform> → 获取 state + authUrl
 * （无需认证）。platform 与 User-Agent 随产品配置变化，默认 CodeBuddy。
 */
export async function fetchAuthState(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  product: BuddyProduct = CODEBUDDY,
): Promise<{ state: string; authUrl: string }> {
  const url = `${product.endpoint}${AUTH_STATE_PATH}?platform=${product.platform}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
    [HTTP_HEADER_NO_USER_ID]: 'true',
    [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
    [HTTP_HEADER_NO_DEPARTMENT_INFO]: 'true',
    'User-Agent': product.userAgent,
  }
  const { status, body } = await request('POST', url, headers, {
    fetcher, timeoutMs: STATE_REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
  })
  if (status !== 200) {
    throw new Error(`auth/state HTTP ${status}: ${responseMessage(body)}`)
  }
  const data = responseData(body)
  if (typeof data !== 'object' || data === null) {
    throw new Error(`auth/state 响应缺少 data 字段: ${JSON.stringify(body)}`)
  }
  const record = data as Record<string, unknown>
  const state = typeof record.state === 'string' ? record.state : ''
  const authUrl = typeof record.authUrl === 'string' ? record.authUrl : ''
  if (state.length === 0) throw new Error('auth/state 响应缺少 state 字段')
  if (authUrl.length === 0) throw new Error('auth/state 响应缺少 authUrl 字段')
  return { state, authUrl }
}

/**
 * GET /v2/plugin/auth/token?state=... 轮询获取 token。
 *
 * 错误码 11217 = token 尚未就绪 → 继续轮询；网络错误同样继续轮询，
 * 不中断登录流程（对齐 Rust loop_get_token）。
 *
 * `options.product` 决定 User-Agent（默认 CodeBuddy）；调用方（登录流程）
 * 必须传入，否则 WorkBuddy 会携带 CodeBuddy 的身份标识。
 */
export async function loopGetToken(
  state: string,
  options: {
    fetcher?: typeof fetch
    timeoutMs?: number
    pollIntervalMs?: number
    signal?: AbortSignal
    /** 产品配置；默认为 CodeBuddy。 */
    product?: BuddyProduct
  } = {},
): Promise<BuddyToken> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product ?? CODEBUDDY
  const url = `${product.endpoint}${AUTH_TOKEN_PATH}?state=${encodeURIComponent(state)}`
  const headers: Record<string, string> = {
    [HTTP_HEADER_NO_AUTHORIZATION]: 'true',
    'User-Agent': product.userAgent,
  }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('获取 token 超时（5 分钟）')
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(interval)
    let result: { status: number; body: unknown }
    try {
      result = await request('GET', url, headers, {
        fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...options.signal !== undefined ? { signal: options.signal } : {},
      })
    } catch {
      // 网络错误：继续轮询（不中断登录流程）
      continue
    }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseTokenData(data)
      // data 为 null，继续轮询
      continue
    }
    const code = responseCode(body)
    if (code === CODE_TOKEN_NOT_READY) continue
    throw new Error(`auth/token HTTP ${status} code=${code}: ${responseMessage(body)}`)
  }
}

/**
 * GET /v2/plugin/login/account?state=... 轮询获取账户信息（需 Bearer token）。
 *
 * 错误码 12151 = 账户信息尚未完成 → 继续轮询。
 *
 * `options.product` 决定 User-Agent（默认 CodeBuddy）。
 */
export async function getAccount(
  state: string,
  token: BuddyToken,
  options: {
    fetcher?: typeof fetch
    timeoutMs?: number
    pollIntervalMs?: number
    signal?: AbortSignal
    /** 产品配置；默认为 CodeBuddy。 */
    product?: BuddyProduct
  } = {},
): Promise<BuddyAccount> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product ?? CODEBUDDY
  const url = `${product.endpoint}${LOGIN_ACCOUNT_PATH}?state=${encodeURIComponent(state)}`
  const headers: Record<string, string> = {
    // ⚠️ `||` 而非裸 `token.domain`：token 由 `parseTokenData` → `readStringField`
    // 产出，该函数在字段缺失/类型不符时返回**空串**（不是 `undefined`），裸用会
    // 让 X-Domain 以空值发出。这与 `buddy-adapter.ts` 的 chat 头、`buddy.ts` 的
    // `credentialRequestHeaders` 是同一形态（PR!19 修了那两处，这是第三处）。
    //
    // 兜底取 `product.apiDomain` 而非常量 `API_DOMAIN`：本请求的 URL 是
    // `` `${product.endpoint}${LOGIN_ACCOUNT_PATH}` ``，X-Domain 必须与产品端点一致。
    //
    // ⚠️ **非空时仍以服务端下发的 `token.domain` 为准**（故不写成产品优先）：
    // 这里是登录流程，该值是服务端**本次刚下发**的权威值，不是跨产品迁移后
    // 会过期的历史快照 —— 与 adapter 那处的方向差异是有意的，差异只在「兜底值
    // 取谁」，判据一致（空串必回退）。回归用例见 `tests/unit/buddy-oauth.spec.ts`
    // 的「token.domain 为空串时…」与「token.domain 非空时…」两条。
    [HTTP_HEADER_DOMAIN]: token.domain || product.apiDomain,
    Authorization: `Bearer ${token.accessToken}`,
    [HTTP_HEADER_NO_USER_ID]: 'true',
    [HTTP_HEADER_NO_ENTERPRISE_ID]: 'true',
    'User-Agent': (options.product ?? CODEBUDDY).userAgent,
  }
  const deadline = Date.now() + (options.timeoutMs ?? LOGIN_TIMEOUT_MS)
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS
  for (;;) {
    if (Date.now() >= deadline) throw new Error('获取账户信息超时（5 分钟）')
    if (options.signal?.aborted) throw new Error('登录已取消')
    await sleep(interval)
    let result: { status: number; body: unknown }
    try {
      result = await request('GET', url, headers, {
        fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...options.signal !== undefined ? { signal: options.signal } : {},
      })
    } catch {
      continue
    }
    const { status, body } = result
    if (status === 200) {
      const data = responseData(body)
      if (data !== undefined) return parseAccountData(data)
      continue
    }
    const code = responseCode(body)
    if (code === CODE_ACCOUNT_NOT_READY) continue
    throw new Error(`login/account HTTP ${status} code=${code}: ${responseMessage(body)}`)
  }
}

/**
 * POST /v2/plugin/auth/token/refresh 静默续期。
 *
 * 通过 X-Refresh-Token 头提交 refresh_token；成功时返回新令牌数据。
 * refresh_token 被后端判定失效（401/403 或 message 含 expired/invalid）时抛
 * {@link RefreshTokenExpiredError}，调用方据此停止续期并提示重新登录。
 *
 * `product` 放在参数列表**末尾**（默认 CodeBuddy），既让 WorkBuddy 携带
 * 自己的 User-Agent，又不破坏既有的位置参数调用点。
 */
export async function refreshToken(
  credential: BuddyCredential,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  product: BuddyProduct = CODEBUDDY,
): Promise<BuddyToken> {
  if (!isRefreshable(credential)) {
    throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
  }
  const url = `${product.endpoint}${AUTH_REFRESH_PATH}`
  const headers: Record<string, string> = {
    ...credentialRequestHeaders(credential),
    // credentialRequestHeaders 走的是 CodeBuddy 的 UA/域名常量，这里按产品覆盖，
    // 否则 WorkBuddy 续期时会以 CodeBuddy 的身份标识发请求。
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    'User-Agent': product.userAgent,
    Authorization: `Bearer ${credential.access_token}`,
    [HTTP_HEADER_REFRESH_TOKEN]: credential.refresh_token,
    [HTTP_HEADER_AUTH_REFRESH_SOURCE]: AUTH_REFRESH_SOURCE,
  }
  const { status, body } = await request('POST', url, headers, {
    fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
  })
  if (status !== 200) {
    const code = responseCode(body)
    const message = responseMessage(body)
    // 终态判定：HTTP 401/403、后端错误码 401/403，或 message 明确为
    // expired/invalid —— 都视为 refresh_token 已失效（停止调度、提示重新登录），
    // 避免每次刷新失败都被当作可重试错误而无限重试。
    const expired = status === 401 || status === 403
      || code === 401 || code === 403
      || message.includes('expired') || message.includes('invalid')
    if (expired) {
      throw new RefreshTokenExpiredError(message.length > 0 ? message : `HTTP ${status}`)
    }
    throw new Error(`刷新 token HTTP ${status} code=${code}: ${message}`)
  }
  const data = responseData(body)
  if (data === undefined) throw new Error('刷新 token 响应缺少 data 字段')
  return parseTokenData(data)
}

/** refresh_token 已失效/被拒绝时抛出的错误；调度器据此停止续期。 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/**
 * GET /v3/config → 获取远端模型列表（craft agent 的 models）。
 *
 * 失败时返回空数组（调用方回退到内置列表）。
 *
 * `product` 放在参数列表**末尾**（默认 CodeBuddy）：它决定 X-Product-Code
 * 与 User-Agent 两个身份标识。**必须**由调用方传入，否则 WorkBuddy 会发出
 * `X-Product-Code: codebuddy` 的请求。
 */
export async function fetchModels(
  credential: BuddyCredential,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  product: BuddyProduct = CODEBUDDY,
): Promise<BuddyRemoteModel[]> {
  if (credential.access_token.length === 0) return []
  const headers: Record<string, string> = {
    ...credentialAuthHeaders(credential),
    // credentialAuthHeaders 内置 CodeBuddy 的 UA/域名，这里按产品覆盖。
    [HTTP_HEADER_DOMAIN]: product.apiDomain,
    'User-Agent': product.userAgent,
    // X-Product 是**部署类型**（SaaS），CodeBuddy 与 WorkBuddy 共用同一取值，
    // 故保持常量；随产品变化的是 X-Product-Code。
    [HTTP_HEADER_PRODUCT]: BUDDY_DEPLOYMENT_TYPE,
    [HTTP_HEADER_PRODUCT_CODE]: product.productCode,
  }

  // 第一优先：企业模型端点（/console/enterprises/{scope}/models）。
  //
  // 这条路径才是 IDE 与 Web 版实际使用的模型来源 —— 它对个人账号用字面量
  // `personal` 作为 {scope}，返回**完整的模型元数据**（maxInputTokens、
  // reasoning.supportedEfforts、credits 等）以及各 agent 引用的模型清单，
  // 其中包含 /v3/config 完全没有的模型（如 gpt-5.6-sol / gpt-6-astra）。
  //
  // 注意：该端点的授权作用域可能比 CLI token 更严（实测同一 token 有时
  // 返回 500 或空列表），故失败时回退到 /v3/config，仍失败则由调用方回退
  // 静态目录。三层回退保证任何一层可用都能给出模型列表。
  const scoped = await requestScopedModels(credential, headers, fetcher, signal, product)
  if (scoped !== undefined) {
    // ⚠️ **两个端点下发的模型 id 集合不同，必须取并集。**
    //
    // 实测（2026-09-21，账号 3C656A62）：
    //   scoped    → `hy4-preview`、`hy4-preview-x`（30 个模型）
    //   /v3/config→ **`hy4-preview-f`**（22 个模型）
    // 而「限时免费」促销的 `modelIds` 只写着 `["hy4-preview-f"]`
    // —— 挂在我们**没有采用**的那个 id 上。
    //
    // 早期实现只返回 scoped，于是该促销永远对不上，界面显示 `x0.29`
    // 而 IDE 显示免费（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）。
    //
    // 故这里补取 `/v3/config` 并**合并两个端点的模型**（同 id 以 scoped 为准，
    // 它带更完整的元数据），同时取其促销表。任何失败都不影响模型列表 ——
    // 促销与补充模型都只是增强。
    const config = await requestConfig(headers, fetcher, signal, product)
    const merged = mergeRemoteModels(scoped, config.models)
    // 档位（`modelTiers`）与促销（`modelPromotions`）是两个独立来源，任一为空
    // 也要把另一个并进去 —— 早期这里只看 promotions，于是"只有档位标注"的模型
    // （如 glm-5.3 的「订阅优先」）整条被跳过。
    return config.promotions.size === 0 && config.tiers.size === 0
      ? merged
      : applyPromotions(merged, config.promotions, config.tiers)
  }

  // 第二优先：/v3/config（结果同样是 data.models / data.agents 结构）
  const url = `${product.endpoint}${CONFIG_PATH}`
  try {
    const { status, body } = await request('GET', url, headers, {
      fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
    })
    if (status !== 200) return []
    return parseModelsFromConfig(body)
  } catch {
    return []
  }
}

/**
 * 按 id 合并两个端点的模型列表。
 *
 * 同名 id 以 **`primary`（scoped 端点）为准** —— 它带更完整的元数据，
 * 且与既有策略一致（「采信实际命中的那个端点，不做跨端点取大」）。
 * `extra` 里 primary 没有的 id **追加在后**，从而既保留主目录的顺序与权威性，
 * 又不会丢掉只在另一个端点下发的变体（如 `hy4-preview-f`）。
 */
function mergeRemoteModels(
  primary: readonly BuddyRemoteModel[],
  extra: readonly BuddyRemoteModel[],
): BuddyRemoteModel[] {
  const known = new Set(primary.map((model) => model.id))
  return [...primary, ...extra.filter((model) => !known.has(model.id))]
}

/** `/v3/config` 的解析结果：模型 + 促销表。 */
interface BuddyConfigSnapshot {
  models: BuddyRemoteModel[]
  promotions: Map<string, { rate: string | null; note: string | null; promo: Record<string, unknown> }>
  /** 「模型 id → 会员档位记录」，来自 `modelTiers`（与促销是两套独立来源）。 */
  tiers: Map<string, Record<string, unknown>>
}

/**
 * 取 `/v3/config` 的模型、促销表与档位表。
 *
 * 只用于给 scoped 端点补「另一套 id 的模型」与促销信息（该端点两者都不全）。
 * 任何失败都返回空快照 —— 它们是展示增强，不该让整个模型列表失败。
 */
async function requestConfig(
  headers: Record<string, string>,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  product: BuddyProduct,
): Promise<BuddyConfigSnapshot> {
  const empty: BuddyConfigSnapshot = { models: [], promotions: new Map(), tiers: new Map() }
  try {
    const { status, body } = await request('GET', `${product.endpoint}${CONFIG_PATH}`, headers, {
      fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
    })
    if (status !== 200 || typeof body !== 'object' || body === null) return empty
    const data = (body as Record<string, unknown>).data
    if (typeof data !== 'object' || data === null) return empty
    return {
      models: parseModelsFromConfig(body),
      promotions: parsePromotions(data as Record<string, unknown>),
      tiers: parseModelTiers(data as Record<string, unknown>),
    }
  } catch {
    return empty
  }
}

/** 把促销表与档位表并入模型列表（补 `discountedCreditsRate`、`promotionNote`、原始 `promotion` 与 `modelTier`）。 */
function applyPromotions(
  models: BuddyRemoteModel[],
  promotions: Map<string, { rate: string | null; note: string | null; promo: Record<string, unknown> }>,
  tiers: Map<string, Record<string, unknown>> = new Map(),
): BuddyRemoteModel[] {
  return models.map((model) => {
    const tier = tiers.get(model.id)
    const promo = promotions.get(model.id)
    if (promo === undefined && tier === undefined) return model
    const next: BuddyRemoteModel = { ...model }
    if (tier !== undefined) next.modelTier = tier
    if (promo !== undefined) {
      if (promo.rate !== null) next.discountedCreditsRate = promo.rate
      if (promo.note !== null) next.promotionNote = promo.note
      next.promotion = promo.promo
    }
    return next
  })
}

/** 企业模型端点的 scope 段：个人账号用字面量 `personal`。 */
export const ENTERPRISE_MODELS_SCOPE = 'personal'

/**
 * 请求企业模型端点。成功且解析出模型时返回列表；
 * 端点不存在 / 无权限 / 返回空 / 解析不出模型时返回 undefined（交给上层回退）。
 */
async function requestScopedModels(
  credential: BuddyCredential,
  headers: Record<string, string>,
  fetcher: typeof fetch,
  signal: AbortSignal | undefined,
  product: BuddyProduct,
): Promise<BuddyRemoteModel[] | undefined> {
  const url = `${product.endpoint}/console/enterprises/${ENTERPRISE_MODELS_SCOPE}/models`
  try {
    const { status, body } = await request('GET', url, headers, {
      fetcher, timeoutMs: REQUEST_TIMEOUT_MS, ...signal !== undefined ? { signal } : {},
    })
    if (status !== 200) return undefined
    const models = parseModelsFromConfig(body)
    // 空列表视为「该端点不可用于本账号」，让上层回退到 /v3/config，
    // 避免因为一次空响应就把模型选择器清空。
    return models.length > 0 ? models : undefined
  } catch {
    return undefined
  }
}

/** 等待指定的毫秒数。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.()
  })
}

/** 默认的平台浏览器打开器（延迟 import 以复用 CodeArts 的实现）。 */
async function defaultOpenBrowser(url: string): Promise<void> {
  const { openBrowser } = await import('./login.js')
  openBrowser(url)
}

/**
 * 按产品配置装饰登录 URL。
 *
 * WorkBuddy（appendSessionParams 为 true）需要额外携带 `version` 与
 * `loginSessionId`：前者为产品版本号，后者为客户端生成的 UUID，仅用于
 * 服务端日志追踪（实测无校验语义，故每次登录生成新值均可）。
 * 其余产品原样返回。
 *
 * 注意：只追加参数，不得重建 URL —— platform/state/路径全部来自服务端
 * auth/state 下发的 authUrl。
 */
export function decorateLoginUrl(authUrl: string, product: BuddyProduct): string {
  if (!product.appendSessionParams) return authUrl
  try {
    const url = new URL(authUrl)
    if (product.pluginVersion !== undefined && product.pluginVersion.length > 0) {
      url.searchParams.set('version', product.pluginVersion)
    }
    url.searchParams.set('loginSessionId', crypto.randomUUID())
    return url.toString()
  } catch {
    // authUrl 非法时原样返回，交由后续流程报错
    return authUrl
  }
}

/**
 * 完整登录流程：fetchAuthState → 打开浏览器 → 轮询 token → 轮询 account。
 *
 * 当 options.state 已提供时，跳过 fetchAuthState（用于 RPC 场景：
 * 由调用方先获取 state+authUrl 返回给客户端弹窗，后台用同一 state 轮询）。
 *
 * 返回序列化后的凭据 JSON；持久化由调用方（BuddyAuth 服务）负责，
 * 与 CodeArts 的 runOAuthFlow 保持一致的分层。
 */
export async function runBuddyLoginFlow(options: BuddyLoginFlowOptions = {}): Promise<BuddyLoginFlowResult> {
  const fetcher = options.fetcher ?? fetch
  const open = options.openBrowser ?? defaultOpenBrowser
  const product = options.product ?? CODEBUDDY

  let state: string
  let authUrl: string
  if (options.state) {
    state = options.state
    authUrl = ''
  } else {
    // 用产品配置取 state（platform 随产品变化）
    const result = await fetchAuthState(fetcher, undefined, product)
    state = result.state
    authUrl = result.authUrl
    // WorkBuddy 的登录 URL 需要追加 version 与 loginSessionId；
    // platform/state/路径全部由服务端下发的 authUrl 决定，不得重新拼接。
    const decorated = decorateLoginUrl(authUrl, product)
    await open(decorated)
    authUrl = decorated
  }

  const pollOptions = {
    fetcher,
    ...options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {},
    ...options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {},
    // 轮询 token / 账户两步同样带产品身份标识，否则 WorkBuddy 登录会以
    // CodeBuddy 的 UA 发请求。
    product,
  }
  const token = await loopGetToken(state, pollOptions)
  const account = await getAccount(state, token, pollOptions)
  const credential = buildCredential(token, account)
  return {
    access: JSON.stringify(credential),
    // 对齐 Rust 的 expires_at_ms(...).unwrap_or(0)：无法解析时报告 0。
    expires: credentialExpiresAtMs(credential) ?? 0,
    loginUrl: authUrl,
    refreshable: isRefreshable(credential),
  }
}
