/**
 * Cline 认证服务。
 *
 * 结构与 `src/qoder-auth.ts` / `src/lobsterai-auth.ts` **刻意保持一致**：
 * 同样的 `RefreshScheduler` 续期语义、同样的登出竞态保护、同样的
 * `refreshAll(pool)` 批量续期。这是本插件已被五个产品验证过的模式，
 * 复用它可以减少一类「某个 provider 的续期行为与众不同」的意外。
 *
 * 与 Qoder 侧的实质差异只有两处：
 *
 * 1. **登录是 WorkOS 设备码**（`api.workos.com`），而非 Qoder 自己的
 *    `device/selectAccounts`（见 `src/cline-oauth.ts`）；
 * 2. **续期请求体是驼峰 `{refreshToken, grantType}`**，不是
 *    `{refresh_token, machine_id}`（见 `clineRefreshBody`）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  CLINE_HTTP_TIMEOUT_MS,
  runClineLoginFlow,
  startClineLoginFlow,
  type ClineLoginFlowOptions,
  type ClineLoginFlowResult,
} from './cline-oauth.js'
import {
  applyClineRefresh,
  isClineExpired,
  isClineRefreshable,
  parseClineTokenPayload,
  clineCredentialExpiresAtMs,
  clineRefreshBody,
  type ClineCredential,
} from './cline.js'
import {
  CLINE,
  CLINE_REFRESH_PATH,
  type ClineProduct,
} from './cline-product.js'
import { RefreshScheduler } from './refresh.js'
import { AccountPool } from './account-pool.js'
import {
  refreshAccountWithReconcile,
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * Cline 凭据 → 账号池有效期所需的提取器（`refreshAll` 与按需续期共用一份）。
 */
const CLINE_EXPIRY_ACCESSORS: ExpiryAccessors<ClineCredential> = {
  expiresAtOf: clineCredentialExpiresAtMs,
  refreshableOf: isClineRefreshable,
  identityOf: (credential) => credential.access_token ?? '',
}

/**
 * Cline 的默认凭据 ref。
 *
 * 等价于 `CLINE.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `CLINE.defaultCredentialRef`。
 */
export const CLINE_CREDENTIAL_REF = 'CLINE_ACCESS_TOKEN'

/**
 * 续期被后端判定为终态（refresh_token 失效）时抛出的错误。
 *
 * 与其它 provider 的同名类**刻意是各自独立的类**：
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据，正是因为这些类跨模块 identity 不同。
 * 故这里也必须保证 `name` 恰为 `RefreshTokenExpiredError`。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果。 */
export interface ClineLoginResult {
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
  /** 设备码流程的用户码（UI 可提示用户输入）。 */
  userCode?: string
}

/** 用于配置界面的只读登录状态。 */
export interface ClineLoginStatus {
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
    /**
     * Cline 的认证服务实例。
     */
    clineAuth: ClineAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): ClineCredential | undefined {
  try {
    const parsed = JSON.parse(value) as ClineCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** `ClineAuth` 的构造选项。 */
export interface ClineAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link CLINE}。 */
  product?: ClineProduct
  /** 服务名覆盖（默认由产品 id 派生为 `clineAuth`）。 */
  serviceName?: string
}

/**
 * Cline 认证服务：WorkOS 设备码登录 + refresh_token 静默续期。
 */
export class ClineAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: ClineProduct

  /** 本实例默认读写的凭据 ref 名称（`CLINE_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string

  private readonly scheduler = new RefreshScheduler(
    () => this.refresh(),
    (error) => {
      if (error instanceof RefreshTokenExpiredError) {
        // 失效：停止重试，并向 status() 暴露 refreshable: false 与重新登录提示。
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

  constructor(ctx: Context, private readonly options: ClineAuthOptions = {}) {
    const product = options.product ?? CLINE
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /** 标记 refresh_token 已失效：停止重试，并向 status() 暴露 refreshable: false。 */
  private markRefreshTokenInvalid(): void {
    this.refreshTokenInvalid = true
    this.lastRefreshError = 'refresh_token 已失效，请重新登录'
  }

  /**
   * 运行完整登录流程并持久化凭据。
   *
   * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池
   * （Channel Pack 的「+ 新建账号」路径）。
   */
  async login(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<ClineLoginFlowOptions> = {},
  ): Promise<ClineLoginResult> {
    this.active = true
    const flow = await runClineLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      ...flowOptions,
    })
    return this.persistLogin(flow, flowOptions)
  }

  /**
   * **两步式登录**：立即返回登录 URL，由调用方先打开窗口。
   *
   * 调用方拿到 `loginUrl` 后应当**立即** `window.open`，再 await `result`。
   */
  async startLogin(
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } & Partial<ClineLoginFlowOptions> = {},
  ): Promise<{ loginUrl: string; userCode?: string; result: Promise<ClineLoginResult>; close: () => Promise<void> }> {
    this.active = true
    const started = await startClineLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
      ...flowOptions,
    })
    const result = started.result.then((flow) => this.persistLogin(flow, flowOptions))
    // 与 startClineLoginFlow 同理：结果可能早于调用方 await 而落定，
    // 先挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
    result.catch(() => {})
    return {
      loginUrl: started.loginUrl,
      ...started.userCode === undefined ? {} : { userCode: started.userCode },
      result,
      close: started.close,
    }
  }

  /**
   * 持久化一次登录结果：写凭据、重置失效状态、武装续期、按需登记账号池。
   *
   * 抽成独立方法供 {@link login} 与 {@link startLogin} 共用 ——
   * 两条路径的差别只在「何时返回 loginUrl」，落库逻辑必须完全一致。
   */
  private async persistLogin(
    flow: ClineLoginFlowResult,
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<ClineLoginResult> {
    const ref = flowOptions.refName ? credentialRef(flowOptions.refName) : credentialRef(this.credentialRefName)
    await this.ctx.credentials.set(ref, flow.access)
    this.refreshTokenInvalid = false
    this.lastRefreshError = undefined
    this.scheduleRefresh()
    const credential = parseCredential(flow.access)
    // 多账号：accountId 提供时自动注册到 pool
    if (flowOptions.accountId !== undefined && flowOptions.pool !== undefined) {
      await flowOptions.pool.addAccount({
        id: flowOptions.accountId,
        provider: this.product.id,
        nickname: credential?.nickname !== undefined && credential.nickname.length > 0
          ? credential.nickname
          : flowOptions.accountId,
        enabled: true,
        credentialRef: flowOptions.refName ?? this.credentialRefName,
        createdAt: Date.now(),
        expiresAt: credential ? clineCredentialExpiresAtMs(credential) : undefined,
        refreshable: credential !== undefined && isClineRefreshable(credential),
      })
    }
    return {
      access: flow.access,
      expires: flow.expires,
      ref,
      loginUrl: flow.loginUrl,
      refreshable: flow.refreshable,
      ...flow.userCode === undefined ? {} : { userCode: flow.userCode },
    }
  }

  /** 报告凭据是否已配置、过期时间、是否可刷新以及最近刷新错误。 */
  async status(): Promise<ClineLoginStatus> {
    const ref = credentialRef(this.credentialRefName)
    const info = await this.ctx.credentials.describe(ref)
    if (!info.configured) return { configured: false, refreshable: false }
    let expiresAt: number | undefined
    let refreshable = false
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved) {
      const credential = parseCredential(resolved.value)
      if (credential) {
        expiresAt = clineCredentialExpiresAtMs(credential)
        refreshable = isClineRefreshable(credential) && !this.refreshTokenInvalid
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
   * 静默续期：`refresh_token` 换新令牌。
   *
   * 终态判定：
   * - HTTP 401/403、或响应缺 token → 抛 {@link RefreshTokenExpiredError}，
   *   让调度器停止续期；
   * - 其余错误（网络抖动、5xx、429）→ 抛普通 Error，走调度器的可重试路径。
   */
  async refresh(): Promise<void> {
    const ref = credentialRef(this.credentialRefName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('未配置凭据，请先登录')
    const credential = parseCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isClineRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    try {
      const refreshed = await this.refreshCredential(credential)
      // 登出竞态保护：在途刷新期间已 logout()/stop() 时，跳过凭据回写与调度武装，
      // 避免已登出的凭据被在途刷新复活。
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
   * 按凭据 ref 续期**指定账号**的凭据。
   *
   * 与 {@link refresh} 的区别（与 `QoderAuth.refreshAccountCredential` 同因）：
   * `refresh()` 读写本实例的默认单凭据 ref（`CLINE_ACCESS_TOKEN`），
   * 而 Channel Pack 账号卡片对应的是 `CLINE_ACCOUNT_XXX` ——
   * 用 `refresh()` 刷账号池里的账号，实际刷的是另一个凭据。
   *
   * 同样**不触碰** `refreshTokenInvalid` / `lastRefreshError` / 调度器：
   * 那些状态属于单凭据路径，被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ **必须回写账号池的 `expiresAt`**（issue !IKIRTT 的真实缺陷）：
   * UI 账号卡片读的正是池里的值。早期七个 provider 都只 `credentials.set`，
   * 于是调用 `account.refresh` 后凭据确实续好了，界面却**一直显示「已过期」**，
   * 且「重测」按钮的 refresh 是刻意的 no-op —— 等于没有任何自救手段。
   * 只有 raccoon 记得回写，故它是当时唯一能自愈的面板。
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
    if (!isClineRefreshable(credential)) {
      throw new RefreshTokenExpiredError('无 refresh_token，请重新登录')
    }
    const refreshed = await this.refreshCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(refreshed))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: refreshed,
      accessors: CLINE_EXPIRY_ACCESSORS,
      accountId,
      tag: '[cline]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 对一份凭据执行一次续期并返回新凭据（不触碰存储）。
   *
   * 抽出来供 `refresh()` / `refreshAccountCredential()` / `refreshAll()`
   * 共用，避免三处各写一遍「发请求 → 判终态 → 合并字段」而逐渐分叉。
   */
  private async refreshCredential(credential: ClineCredential): Promise<ClineCredential> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.product.apiBase}${CLINE_REFRESH_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...this.product.clientHeaders,
        },
        // ⚠️ 字段名是驼峰 `refreshToken` / `grantType`（见 clineRefreshBody）。
        body: JSON.stringify(clineRefreshBody(credential)),
        signal: AbortSignal.timeout(CLINE_HTTP_TIMEOUT_MS),
      })
    } catch (error) {
      // 传输层失败：**不能**判为终态 —— 网络抖动不该让用户重新登录。
      // 用普通 Error 让 RefreshScheduler 安排重试。
      throw new Error(`Cline 续期网络失败：${error instanceof Error ? error.message : String(error)}`)
    }

    if (response.status === 401 || response.status === 403) {
      throw new RefreshTokenExpiredError(`Cline 续期被拒绝（HTTP ${response.status}），请重新登录`)
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      throw new Error(`Cline 续期响应不是 JSON（HTTP ${response.status}）`)
    }

    if (!response.ok) {
      // 非 401/403 的失败（5xx、429…）属可重试，交给调度器。
      const detail = JSON.stringify(parsed).slice(0, 200)
      throw new Error(`Cline 续期失败（HTTP ${response.status}）：${detail}`)
    }

    const payload = parseClineTokenPayload(parsed)
    if (payload.accessToken.length === 0) {
      // 拿到 200 却没有 token：视为无法续期（需重新登录），
      // 而不是当成可重试的瞬时故障。
      throw new RefreshTokenExpiredError('续期响应缺少访问令牌，请重新登录')
    }
    return applyClineRefresh(credential, payload, this.product)
  }

  /**
   * 批量续期本产品的所有账号。
   *
   * ⚠️ **lead-time 过滤**（issue !IKIRTT）：早先这里是**无条件全量续期** ——
   * 定时器每 30 分钟就把每个账号的 refresh_token 轮换一次，与「凭据还剩 719 小时」
   * 无关。现复用单凭据时代 `REFRESH_LEAD_MS` 的语义：**距过期不足 1 小时才刷**。
   * 跳过续期的账号仍会做一次**有效期对账**（见 `refreshAccountWithReconcile`），
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
        if (!credential || !isClineRefreshable(credential)) {
          await pool.updateAccount(entry.id, { refreshable: false })
          continue
        }
        await refreshAccountWithReconcile({
          pool,
          provider: this.product.id,
          tag: '[cline]',
          accountId: entry.id,
          credential,
          accessors: CLINE_EXPIRY_ACCESSORS,
          current: entry,
          refresh: (c) => this.refreshCredential(c),
          save: (c) => this.ctx.credentials.set(ref, JSON.stringify(c)),
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          try {
            await pool.updateAccount(entry.id, { refreshable: false })
          } catch {
            // 忽略 updateAccount 本身的错误
          }
          this.ctx.logger?.warn?.(
            `[cline] 账号 ${entry.id} 的 refresh_token 已失效，已标记为不可续期（需重新登录）`,
          )
        } else {
          // 非终态失败（网络抖动、5xx、429…）：**必须留下日志**。
          // 静默失败会让账号在 UI 上仍显示「可续期」却永远刷不动，无从排查。
          this.ctx.logger?.warn?.(
            `[cline] 账号 ${entry.id} 续期失败（将按调度器策略重试）: `
            + `${error instanceof Error ? error.message : String(error)}`,
          )
        }
        // 单账号失败不中断循环
      }
    }
  }

  /** 移除已存储的凭据并停止任何待处理的刷新。 */
  async logout(): Promise<void> {
    // 先置 inactive，再清凭据：在途刷新完成后不得回写/重新武装调度。
    this.active = false
    this.scheduler.stop()
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
  }

  /** 停止刷新调度（不清理凭据）。 */
  stop(): void {
    this.active = false
    this.scheduler.stop()
  }

  /** 启动时若已有可刷新凭据则安排续期（由 apply 调用）。 */
  scheduleRefresh(): void {
    void this.ctx.credentials.resolve(credentialRef(this.credentialRefName)).then((resolved) => {
      if (!resolved) return
      const credential = parseCredential(resolved.value)
      if (!credential || !isClineRefreshable(credential)) return
      const expiresAt = clineCredentialExpiresAtMs(credential)
      if (expiresAt !== undefined) this.scheduler.arm(expiresAt)
    })
  }

  /** 从存储重载凭据，返回是否已过期（供 UI 判断是否需要提示重新登录）。 */
  async checkExpired(): Promise<boolean> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return true
    const credential = parseCredential(resolved.value)
    return credential === undefined ? true : isClineExpired(credential)
  }

  /**
   * 解析本实例默认凭据 ref 下的凭据；不可用时返回 undefined。
   *
   * 供 e2e 探针与 `account-probe` 使用。
   */
  async resolveStoredCredential(): Promise<ClineCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    if (!resolved) return undefined
    return parseCredential(resolved.value)
  }
}
