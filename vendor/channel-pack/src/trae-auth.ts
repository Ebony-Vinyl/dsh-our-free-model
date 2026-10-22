/**
 * TRAE（字节跳动 TRAE IDE）认证服务。
 *
 * 1. **续期是用 ExchangeToken（轮换 refreshToken）**，不是直接换新的 access_token。
 *    ExchangeToken 返回新 token + 新 refreshToken，旧 refreshToken 即刻失效。
 * 2. **凭据必须保留 machine_id / device_id**：续期时只改 token/expiresAt，
 *    这两个设备指纹字段**完全不动**。
 * 3. **GetUserInfo 用于登录后的默认凭据回填**，与续期无关。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  TRAE_BATCH_MODELS_PATH,
  TRAE_EXCHANGE_PATH,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_USER_INFO_PATH,
  applyTraeRefresh,
  isTraeExpired,
  isTraeRefreshable,
  parseTraeBatchModelList,
  parseTraeExchangeResponse,
  parseTraeUserInfoResponse,
  traeCredentialExpiresAtMs,
  traeDisplayNickname,
  traeOAuthHeaders,
  traeSOLOHeaders,
  withTraePhone,
  type TraeCredential,
  type TraeRemoteModel,
} from './trae.js'
import { jwtExpiresAtMs } from './credential-expiry.js'
import { TRAE, type TraeProduct } from './trae-product.js'
import {
  buildTraeLoginURL,
  exchangeTraeCallback,
  runTraeLoginFlow,
  startTraeLoginFlow,
  type TraeLoginFlowOptions,
} from './trae-oauth.js'
import { classifyTraeError, isTraeTerminalError } from './trae-errors.js'
import { RefreshScheduler } from './refresh.js'
import { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * TRAE 凭据 → 账号池有效期所需的提取器（`refreshAll` 与按需续期共用一份）。
 */
const TRAE_EXPIRY_ACCESSORS: ExpiryAccessors<TraeCredential> = {
  expiresAtOf: traeCredentialExpiresAtMs,
  refreshableOf: isTraeRefreshable,
  identityOf: (credential) => credential.access_token ?? '',
}

/**
 * TRAE 的默认凭据 ref。
 */
export const TRAE_CREDENTIAL_REF = 'TRAE_ACCESS_TOKEN'

/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果。 */
export interface TraeLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface TraeLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 存储的凭据是否可通过刷新令牌静默续期。 */
  refreshable: boolean
  /** 最近一次刷新失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    traeAuth: TraeAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): TraeCredential | undefined {
  try {
    const parsed = JSON.parse(value) as TraeCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** `TraeAuth` 的构造选项。 */
export interface TraeAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link TRAE}。 */
  product?: TraeProduct
  /** 服务名覆盖（默认由产品 id 派生为 `traeAuth`）。 */
  serviceName?: string
}

/**
 * TRAE 认证服务：回调登录 + ExchangeToken 续期。
 */
export class TraeAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: TraeProduct

  /** 本实例默认读写的凭据 ref 名称（`TRAE_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        this.markRefreshTokenInvalid()
        return
      }
      this.lastRefreshError = error instanceof Error ? error.message : String(error)
    },
  )
  /** refresh_token 已被后端判定失效；登录/刷新成功时重置。 */
  private refreshTokenInvalid = false
  private lastRefreshError: string | undefined
  /** 登录会话是否仍处于活跃状态；logout()/stop() 置 false，防止在途刷新回写已登出凭据。 */
  private active = true

  /**
   * 模型目录缓存（含**空结果**）与拉取时刻。
   *
   * ⚠️ 为什么需要它：适配器的 `ensureRemoteModels` 是**只缓存非空结果**的
   * （全仓库四个适配器同一模式）—— 拉到空数组时 `remoteModels` 保持 undefined，
   * 于是**下一次** `listModels` / `resolveModel` 会再拉一次。
   *
   * 「未登录 TRAE」恰好就是恒空的情形：用户每打开一次模型选择器、每次
   * 解析模型都发起一次真实 HTTP 请求。用户报障的日志刷屏
   * （同一行 `fetchModels: calling …` 重复数十次）正是这么来的。
   *
   * 故这里**连同空结果一起缓存**，并给一个短 TTL（登录后 30s 内即可自愈，
   * 不需要用户重启宿主）。缓存的是「这次拉取的结果」，与是否有凭据无关 ——
   * 无凭据时直接返回空并缓存，避免重复走一遍凭据解析。
   */
  private modelsCache: { models: TraeRemoteModel[]; at: number } | undefined

  /** 模型目录缓存有效期（毫秒）。短 TTL：新登录的账号最多 30s 后可见。 */
  private static readonly MODELS_CACHE_TTL_MS = 30_000

  constructor(ctx: Context, private readonly options: TraeAuthOptions = {}) {
    const product = options.product ?? TRAE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /**
   * 运行完整登录流程并持久化凭据。
   */
  async login(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<TraeLoginFlowOptions> = {},
  ): Promise<TraeLoginResult> {
    this.active = true
    const flow = await runTraeLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      ...flowOptions,
    })
    return this.persistLogin(flow, flowOptions)
  }

  /**
   * 两步式登录：起回调服务器并立即返回 loginUrl。
   */
  async startLogin(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<TraeLoginFlowOptions> = {},
  ): Promise<{ loginUrl: string; result: Promise<TraeLoginResult>; close: () => Promise<void> }> {
    this.active = true
    const started = await startTraeLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      ...flowOptions,
    })
    const result = started.result.then((flow) => this.persistLogin(flow, flowOptions))
    result.catch(() => {})
    return { loginUrl: started.loginUrl, result, close: started.close }
  }

  /**
   * 持久化一次登录结果。
   */
  private async persistLogin(
    flow: { access: string; expires: number; loginUrl: string; refreshable: boolean },
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<TraeLoginResult> {
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName)
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    // 新凭据落地 → 作废模型缓存，让新登录的账号立刻能列出模型
    // （否则未登录期间缓存的空结果会挡住最长 30s）。
    this.modelsCache = undefined
    this.scheduleRefresh()
    const credential = parseCredential(flow.access)
    if (flowOptions.accountId !== undefined && flowOptions.pool !== undefined) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        // ⚠️ 用 `traeDisplayNickname`（手机号优先）而非直接取 `nickname`：
        // 服务端的 ScreenName 是**按 uid 自动生成的默认名**，多账号无法区分。
        // 见该函数的说明（用户报障 2026-09-27）。
        nickname: traeDisplayNickname(credential, flowOptions.accountId),
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? traeCredentialExpiresAtMs(credential) : undefined,
        refreshable: credential !== undefined && isTraeRefreshable(credential),
      })
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: flow.refreshable,
    }
  }

  /** 报告凭据状态。 */
  async status(): Promise<TraeLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        expiresAt = traeCredentialExpiresAtMs(credential)
        refreshable = isTraeRefreshable(credential) && !this.refreshTokenInvalid
      }
    }
    return {
      configured: true,
      source: info.source,
      expiresAt,
      refreshable,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 静默续期：ExchangeToken 换新。
   *
   * 终态判定：
   * - HTTP 401/403、或响应体命中 session-dead 标记 → 抛 RefreshTokenExpiredError
   * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走可重试路径
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isTraeRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      const refreshed = await this.refreshCredential(credential)
      if (!this.active) return
      await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
      this.refreshTokenInvalid = false
      this.lastRefreshError = undefined
      this.scheduleRefresh()
    } catch (error) {
      if (error instanceof RefreshTokenExpiredError) this.markRefreshTokenInvalid()
      throw error
    }
  }

  /**
   * 按凭据 ref 续期指定账号的凭据。
   *
   * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
   * UI 账号卡片的「有效期」读的正是池里的值，而不是凭据里 access_token 的真实
   * 过期时间。早期这里只 `credentials.set`，于是调用 `account.refresh` 后凭据确实续好了、
   * 界面却**一直显示「已过期」**，且没有任何自救手段（「重测」按钮的 refresh
   * 是刻意的 no-op）。TRAE 用 ExchangeToken 轮换 refreshToken，不回写还会让
   * 池里的 `refreshable` 与实际凭据脱节。
   *
   * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
   * @param accountId 账号 id。**调用方已知时请显式传入** ——
   *   否则只能按凭据内容反查（代价高，且反查会跳过已停用账号）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isTraeRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: refreshed,
      accessors: TRAE_EXPIRY_ACCESSORS,
      accountId,
      tag: '[trae]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
   */
  private async refreshCredential(credential: TraeCredential): Promise<TraeCredential> {
    const host = credential.api_host ?? this.product.oauthHost
    const exchangeBody = {
      ClientID: this.product.clientId,
      RefreshToken: credential.refresh_token,
      ClientSecret: '-',
      UserID: '',
    }
    let response: Response
    try {
      response = await this.fetchImpl(`${host}${TRAE_EXCHANGE_PATH}`, {
        method: 'POST',
        headers: traeOAuthHeaders(this.product),
        body: JSON.stringify(exchangeBody),
        signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      // 传输层失败：不能判为终态 —— 网络抖动不该让用户重新登录。
      throw new Error(`TRAE 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
    }

    // 取文本再尝试解析（**不要**直接用 response.json()）：
    // 凭据失效时网关会返回 **HTML 错误页**而不是 JSON，`json()` 抛出的
    // `Unexpected token '<'` 对用户毫无意义，也看不出真正原因是凭据过期。
    const text = await response.text().catch(() => '')
    let parsed: Record<string, unknown> | undefined
    try {
      const candidate = JSON.parse(text) as unknown
      if (typeof candidate === 'object' && candidate !== null) {
        parsed = candidate as Record<string, unknown>
      }
    } catch {
      // 非 JSON：多半是网关 HTML 错误页（凭据失效的典型表现）。
      parsed = undefined
    }

    const exchange = parsed === undefined ? undefined : parseTraeExchangeResponse(parsed)
    if (exchange === undefined || exchange.accessToken.length === 0) {
      const kind = classifyTraeError(response.status, text)
      // 终态判定（三条独立依据，任一成立即需重新登录）：
      // - HTTP 401/403（状态码最权威）；
      // - 分类为 session-dead；
      // - 拿到了 2xx、响应体也是 JSON，却**没有** accessToken ——
      //   对齐 Go 的 `refresh_failed: no token in response — re-login required`
      //   与 `LobsteraiAuth.refreshCredential` 的同款处理：这不是瞬时故障，
      //   重试一万次也不会有 token，必须让调度器停下来并提示重新登录。
      const noTokenInSuccessResponse = response.ok && parsed !== undefined
      if (response.status === 401 || response.status === 403
        || isTraeTerminalError(kind) || noTokenInSuccessResponse) {
        throw new RefreshTokenExpiredError('TRAE refresh_token 已失效，请重新登录')
      }
      throw new Error(`TRAE 续期失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
    }
    return applyTraeRefresh(credential, exchange)
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * **包含已停用账号**（只按 `refreshable` 过滤）。
   *
   * ⚠️ **lead-time 过滤**（issue !IKIRTT）：早先这里是**无条件全量续期** ——
   * 定时器每 30 分钟就把每个账号的 refreshToken 轮换一次，与「凭据还剩多久」
   * 无关。现复用单凭据时代 `REFRESH_LEAD_MS` 的语义：**距过期不足 1 小时才刷**。
   * 跳过的账号仍会做一次**有效期对账**（见 `refreshAccountWithReconcile`），
   * 因为「不刷」与「不回写池值」正是 UI 假过期的两个来源，必须分开处理。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      if (!entry.refreshable) continue
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        const credential = parseCredential(resolved.value)
        if (!credential || !isTraeRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: '[trae]',
          accountId: entry.id,
          credential,
          accessors: TRAE_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredential(c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch { /* 静默 */ }
          this.ctx.logger?.warn?.(`[trae] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期`)
        } else {
          this.ctx.logger?.warn?.(
            `[trae] 账号 ${entry.id} 续期失败: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /**
   * 一次性修复**老账号**的展示名：补 `GetUserInfo` 拿脱敏手机号并重算昵称。
   *
   * ## 为什么需要它（真实缺陷，用户报障 2026-09-27）
   *
   * > 用 trae provider 登录后用户名字显示无法区分各个用户，有其他名字昵称或者
   * > 手机尾号之类的信息可以区分吗？
   *
   * 服务端的 `ScreenName` 是**按 uid 自动生成的默认名**（`用户26815487395`
   * 这种），四个账号形态完全一致，一屏列出来认不出谁是谁。
   * `GetUserInfo` 会下发 `NonPlainTextMobile`（脱敏手机号），实测可区分。
   *
   * 光改代码只影响**新登录**的账号，已登录的老账号昵称仍是 ScreenName，
   * 故这里在启动时主动补一次 —— 与 `RaccoonAuth.repairAccountNicknames`
   * 同一模式（同因：服务端下发的名字是默认名）。
   *
   * ## 契约
   *
   * - **幂等**：昵称已是手机号时 `traeDisplayNickname` 会算出同一值，
   *   不触发写入（只在**确实变化**时落盘，否则每次启动都写一次文档）。
   * - **失败不阻塞**：逐账号 catch，任何异常只记 warn。
   * - **只读补字段**：不发续期、不动 token，只补 `phone` 与昵称。
   *
   * @returns 被修复的账号 id 列表（供日志）
   */
  async repairAccountNicknames(pool: AccountPool): Promise<string[]> {
    const repaired: string[] = []
    let entries: Awaited<ReturnType<AccountPool['listAccounts']>>
    try {
      entries = await pool.listAccounts(this.product.id)
    } catch {
      return repaired
    }

    for (const entry of entries) {
      try {
        const ref = credentialRef(entry.credentialRef)
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        let credential = parseCredential(resolved.value)
        if (credential === undefined) continue

        // 缺 phone（且无 email）时补一次 GetUserInfo（只读）。
        if (
          (credential.phone === undefined || credential.phone.length === 0)
          && (credential.email === undefined || credential.email.length === 0)
        ) {
          const info = await this.fetchUserContact(credential)
          // ⚠️ **什么都没拿到就什么都不做**，不要退回去用凭据里的 ScreenName
          // 重算昵称 —— 那会用服务端的默认名覆盖掉用户在 Channel Pack 里手动改过的
          // 昵称（`account.update` 是允许改昵称的），属于无谓且有害的写入。
          if (info === undefined) continue
          credential = withTraePhone(credential, info.phone, info.email)
          await this.ctx.credentials.set(ref, JSON.stringify(credential))
        }

        const target = traeDisplayNickname(credential, entry.id)
        // ⚠️ 只在**确实变化**时写账号池：`updateAccount` 是整体 replace，
        // 每次启动都写会平白落盘一次（同 Raccoon 的处理）。
        if (target !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: target })
          repaired.push(entry.id)
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[trae] 修复账号 ${entry.id} 的显示名失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return repaired
  }

  /**
   * 调 `GetUserInfo` 只取脱敏手机号 / 邮箱。
   *
   * ⚠️ 两者都没有时返回 `undefined` 而**不抛错**：它们只是展示信息，拿不到
   * 不应让启动流程失败（与 `exchangeTraeCallback` 对 GetUserInfo 的容错同原则）。
   * 返回 `undefined` 也让调用方能区分「确实没有」与「拿到了空值」，
   * 从而避免用服务端默认名覆盖用户手动改过的昵称。
   */
  private async fetchUserContact(
    credential: TraeCredential,
  ): Promise<{ phone?: string; email?: string } | undefined> {
    try {
      const host = credential.api_host ?? this.product.oauthHost
      const headers = traeOAuthHeaders(this.product)
      headers['X-Cloudide-Token'] = credential.access_token
      const response = await this.fetchImpl(`${host}${TRAE_USER_INFO_PATH}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: this.product.ideVersion }),
        signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) return undefined
      const parsed = parseTraeUserInfoResponse(await response.json() as Record<string, unknown>)
      if (parsed === undefined) return undefined
      const phone = parsed.phone.length > 0 ? parsed.phone : undefined
      const email = parsed.email.length > 0 ? parsed.email : undefined
      return phone === undefined && email === undefined ? undefined : { phone, email }
    } catch {
      return undefined
    }
  }

  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout(): Promise<void> {
    this.active = false
    this.scheduler.stop()
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    // 凭据已清除 → 作废模型缓存，避免登出后仍短暂列出上一个账号的模型。
    this.modelsCache = undefined
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /** 启动时若已有可刷新凭据则安排续期。 */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return
      const credential = parseCredential(resolved.value)
      if (!credential || !isTraeRefreshable(credential)) return
      const expiresAt = traeCredentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /** 从存储重载凭据，返回是否已过期。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseCredential(resolved.value)
    return credential === undefined ? true : isTraeExpired(credential)
  }

  /**
   * 获取 TRAE 模型列表（`batch_get_detail_param`）。
   *
   * ## 日志约定（与其它 provider 对齐）
   *
   * **成功路径一律不打印**。早期这里用 `console.warn` 打了「calling / got N
   * models」，而本方法在冷启动阶段会被调用多次（每次 `listModels` /
   * `resolveModel` 都可能触发，见 `TraeAdapter.ensureRemoteModels`），
   * 于是整个日志被同一行刷屏 —— 用户报障「fetch 的 log 似乎太多了」。
   *
   * **「没有凭据」不是异常**：未登录 TRAE 的用户每次列模型都会走到这条分支，
   * 打日志只会制造噪声（用户报障「没有账号不需要显示 no credential
   * resolved from store」）。真正需要关注的失败（HTTP 非 2xx、网络异常）
   * 才记录。
   */
  async fetchModels(pool?: AccountPool): Promise<TraeRemoteModel[]> {
    // 命中缓存直接返回（**含空结果**）—— 见 `modelsCache` 的字段注释：
    // 适配器不缓存空结果，没有这一层就会在未登录时反复发真实请求。
    const cached = this.modelsCache
    if (cached !== undefined && Date.now() - cached.at < TraeAuth.MODELS_CACHE_TTL_MS) {
      return cached.models
    }
    const models = await this.fetchModelsUncached(pool)
    this.modelsCache = { models, at: Date.now() }
    return models
  }

  /** 真正发起一次拉取；日志与错误处理见 `fetchModels` 的注释。 */
  private async fetchModelsUncached(pool?: AccountPool): Promise<TraeRemoteModel[]> {
    let credential: TraeCredential | undefined
    if (pool) {
      const available = await pool.getAvailableAccount(this.product.id, '').catch(() => undefined)
      if (available) credential = available.credential as TraeCredential
    }
    if (credential === undefined) {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      if (!resolved) return []
      credential = parseCredential(resolved.value)
      if (credential === undefined) return []
    }
    if (credential.access_token.length === 0) return []

    try {
      // ⚠️ 与 `get_detail_param`（单通道）不同，`batch_get_detail_param`
      // 的真实用途是**一次拉取全部 function 各自一套模型目录**。
      // 真实 CN IDE（Trae CN.exe 3.3.94）传的是全部 22 个 function，
      // 而不是只传几个聊天通道。只传聊天通道会让非聊天通道的条目
      // 在响应里出现位置错乱，甚至被解析器跳过。
      // 对齐真实 IDE 的做法：全部传，解析时只消费我们关心的那几条通道。
      const bodyObj = {
        functions: [
          'ui_builder_v2', 'solo_coder', 'chat_v3', 'solo_builder',
          'builder_v3', 'builder', 'chat', 'inline_chat', 'git_ai',
          'custom_agent_generation', 'utils', 'code_reviewer',
          'code_review_summary', 'solo_agent', 'solo_agent_remote',
          'solo_work_remote', 'solo_agent_lite', 'solo_work_lite',
          'solo_design_lite', 'solo_design_remote', 'multimodal',
          'system_diagnosis',
        ],
        agent_type: '',
        current_config_info: { config_name: '', is_custom_model: false },
        mode_type: 0,
        access_type: 0,
        ab_force_vids: '',
        ab_autotest_advanced_mode: 0,
        show_custom_model: true,
      }
      const url = `${this.product.agentHost}${TRAE_BATCH_MODELS_PATH}`
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: traeSOLOHeaders(credential, this.product, false),
        body: JSON.stringify(bodyObj),
        signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
      })
      if (!response.ok) {
        // 非 2xx 是真实故障（凭据失效 / 上游异常），如实记录一次。
        this.warn(`fetchModels: HTTP ${response.status} ${response.statusText}`)
        return []
      }
      return parseTraeBatchModelList(await response.json() as unknown)
    } catch (e) {
      this.warn(`fetchModels: ${e instanceof Error ? e.message : String(e)}`)
      return []
    }
  }

  /** 记录一条警告（经 `ctx.logger`，**仅失败路径**调用）。 */
  private warn(message: string): void {
    this.ctx.logger?.warn?.(`[trae-auth] ${message}`)
  }
}
