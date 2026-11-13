/**
 * SCNet 认证服务。
 *
 * ## 与 Loomy 的关键差异：**可以静默续期**
 *
 * Loomy 没有 refresh 端点（`isLoomyRefreshable` 恒 `false`），到期只能重新短信
 * 登录。SCNet 不一样：登录拿到的平台 Cookie（`jsessionid` + `Token`）通常能活
 * 数天到数周，只要它还在，`refresh()` 就能**重新换一份 `sk-` Key** —— 用户不必
 * 重新收短信。
 *
 * 因此：
 * - `isScnetRefreshable()` 的判据是「凭据里还有非空 `Token` Cookie」；
 * - `refresh()` 先 `current-user-info` 验活、再 `createActivityApiKey` 换 Key；
 * - Cookie 真的失效（平台 401）时才抛 {@link ScnetRefreshExpiredError}，让 UI 明确
 *   提示「重新登录」，不假装成功。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `scnetAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 *
 * @module scnet-auth
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'
import {
  SCNET_KEY_TTL_MS,
  isScnetExpired,
  isScnetRefreshable,
  normalizeScnetCookies,
  scnetApiKeyOf,
  scnetCredentialExpiresAtMs,
  type ScnetCredential,
} from './scnet.js'
import { SCNET, type ScnetProduct } from './scnet-product.js'
import { ensureApiKey, resolveSession, scnetPlatformLogout } from './scnet-platform.js'
import { startScnetLoginFlow, type ScnetLoginResult, type StartedScnetLoginFlow } from './scnet-login-page.js'

/**
 * 平台会话已失效（且**无法静默续期**）时抛出的错误。
 *
 * ⚠️ `name` 必须恰为 `RefreshTokenExpiredError` —— `src/refresh.ts` 的
 * `isRefreshTokenExpired` 用 `error.name` 而非 `instanceof` 作判据（这些类跨模块
 * identity 不同）。
 */
export class ScnetRefreshExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 一次成功登录的结果（与其余渠道的 `XxxLoginResult` 同形）。 */
export interface ScnetLoginPersistResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（读不到时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 是否可静默续期（有平台 Cookie 即可）。 */
  refreshable: boolean
}

/** 配置界面需要的只读登录状态。 */
export interface ScnetLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

/** `ScnetAuth` 的构造选项。 */
export interface ScnetAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link SCNET}。 */
  product?: ScnetProduct
  /** 服务名覆盖（默认由产品 id 派生为 `scnetAuth`）。 */
  serviceName?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** SCNet 的认证服务实例（provider id 为 `scnet-ofm`，服务名同派生）。 */
    'scnet-ofmAuth': ScnetAuth
  }
}

/** 从存储值解析凭据；解析失败返回 `undefined`。 */
function parseCredential(value: string): ScnetCredential | undefined {
  try {
    const parsed = JSON.parse(value) as ScnetCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.apiKey === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/**
 * SCNet 凭据 → 账号池有效期的提取器。
 *
 * `refreshableOf` 用 `isScnetRefreshable`（有 Cookie 即可续期）：SCNet 的续期能力
 * 取决于凭据形状而不是「产品有没有 refresh 端点」，因此这里**可以**提供它。
 */
const SCNET_EXPIRY_ACCESSORS: ExpiryAccessors<ScnetCredential> = {
  expiresAtOf: (credential) => scnetCredentialExpiresAtMs(credential),
  refreshableOf: (credential) => isScnetRefreshable(credential),
  identityOf: (credential) => credential.apiKey ?? '',
}

/** SCNet 认证服务：短信登录 + 平台 Cookie 续换 Key。 */
export class ScnetAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: ScnetProduct
  /** 本实例默认读写的凭据 ref 名称（`SCNET_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string
  /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined
  /** 登录会话是否仍活跃；`logout()`/`stop()` 置 false。 */
  private active = true
  /** 正在进行的登录流程（用于 `stop()` 时关闭本地登录页）。 */
  private flow: StartedScnetLoginFlow | undefined

  constructor(ctx: Context, private readonly options: ScnetAuthOptions = {}) {
    const product = options.product ?? SCNET
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 启动登录：起本地登录页（手机号 + 图形验证码 + 短信码）。
   *
   * 立即返回 `loginUrl` —— 与其余 provider 的「两步式」契约一致：`window.open`
   * 只在用户手势窗口内有效，不能等流程跑完再返回。
   */
  async startLogin(): Promise<StartedScnetLoginFlow> {
    this.active = true
    await this.closeFlow()
    const flow = await startScnetLoginFlow({
      product: this.product,
      ...(this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher }),
    })
    this.flow = flow
    // 结果落定后清掉引用（避免 stop() 关闭一个已经结束的流程）。
    void flow.result.then(() => { if (this.flow === flow) this.flow = undefined })
      .catch(() => { if (this.flow === flow) this.flow = undefined })
    return flow
  }

  /** 关闭仍在进行的本地登录页。 */
  private async closeFlow(): Promise<void> {
    const flow = this.flow
    this.flow = undefined
    if (flow === undefined) return
    try { await flow.close() } catch { /* 已经关闭 */ }
  }

  /**
   * 把登录结果落盘成凭据。
   *
   * 登录页里已经完成了「Cookie → 会话校验 → 换 Key」，这里只负责写入与形状校验。
   */
  async persistLogin(
    login: ScnetLoginResult,
    flowOptions: { refName?: string } = {},
  ): Promise<ScnetLoginPersistResult> {
    const credential = login.credential
    if (scnetApiKeyOf(credential) === undefined) {
      throw new Error('登录结果里没有可用的模型服务 Key（sk- 开头），请重试')
    }
    const refName = flowOptions.refName ?? this.credentialRefName
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    this.lastRefreshError = undefined
    this.active = true
    return {
      access: JSON.stringify(credential),
      expires: scnetCredentialExpiresAtMs(credential) ?? 0,
      ref,
      refreshable: isScnetRefreshable(credential),
    }
  }

  /** 读默认单凭据 ref 里的凭据。 */
  private async resolveDefaultCredential(): Promise<ScnetCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      if (!resolved) return undefined
      return parseCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /** 配置界面用的只读状态。 */
  async status(): Promise<ScnetLoginStatus> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = scnetCredentialExpiresAtMs(credential)
    return {
      configured: true,
      source: this.credentialRefName,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      refreshable: isScnetRefreshable(credential),
      ...(this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError }),
    }
  }

  /**
   * 续期默认单凭据：Cookie 验活 → 重换 Key → 落盘。
   *
   * @throws {ScnetRefreshExpiredError} 平台会话已失效（只能重新短信登录）。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new ScnetRefreshExpiredError('凭据未配置，请先登录')
    const renewed = await this.renewCredential(credential)
    await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(renewed))
    this.lastRefreshError = undefined
  }

  /**
   * 续期指定 ref 的凭据（RPC `account.refresh`）。
   *
   * ⚠️ 与 `refresh()` 的区别：账号卡片对应的是 `SCNET_ACCOUNT_XXX`，用 `refresh()`
   * 刷账号池里的账号实际刷的是默认单凭据（本插件在 Cline 上踩过同类坑）。
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
    if (credential === undefined) throw new Error('凭据解析失败')
    const renewed = await this.renewCredential(credential)
    await this.ctx.credentials.set(ref, JSON.stringify(renewed))
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential: renewed,
      accessors: SCNET_EXPIRY_ACCESSORS,
      accountId,
      tag: '[scnet]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 用平台 Cookie 重换模型服务 Key。
   *
   * 两条失败路径必须分开：
   * - **平台 401 / 没有 Cookie** → {@link ScnetRefreshExpiredError}（终态，要重登）；
   * - **网络抖动 / 平台 5xx** → 普通 `Error`（可重试，不该让用户重登）。
   */
  private async renewCredential(credential: ScnetCredential): Promise<ScnetCredential> {
    const cookies = normalizeScnetCookies(credential.cookies)
    if (cookies === undefined) {
      throw new ScnetRefreshExpiredError('SCNet 平台会话不存在，请重新登录')
    }
    const session = await resolveSession({ cookies, fetcher: this.fetchImpl, product: this.product })
    if (!session.ok) {
      if (session.reason === 'expired' || session.reason === 'missing-cookies') {
        throw new ScnetRefreshExpiredError(`SCNet 平台会话已失效，请重新登录（${session.reason}）`)
      }
      throw new Error(`SCNet 会话校验失败：${session.message ?? session.reason}`)
    }
    const keyed = await ensureApiKey({
      cookies: session.cookies,
      ...(session.account.userId === undefined ? {} : { accountId: session.account.userId }),
      fetcher: this.fetchImpl,
      product: this.product,
    })
    if (!keyed.ok) {
      if (keyed.reason === 'expired') {
        throw new ScnetRefreshExpiredError('SCNet 平台会话已过期，请重新登录')
      }
      throw new Error(`SCNet 换取模型 Key 失败：${keyed.message ?? keyed.reason}`)
    }
    const now = new Date()
    return {
      ...credential,
      cookies: keyed.cookies,
      apiKey: keyed.apiKey,
      baseUrl: keyed.baseUrl,
      account: { ...credential.account, ...session.account },
      keyedAt: now.toISOString(),
      expiresAt: String(now.getTime() + SCNET_KEY_TTL_MS),
      source: 'web',
    }
  }

  /**
   * 批量续期本产品的账号。
   *
   * ⚠️ 只处理**已过期**的账号（`refreshAll` 每 30 分钟跑一次，对没过期的账号做
   * 一次「验活 + 换 Key」纯属白费请求）。但「无需续期」不等于「什么都不做」：
   * 账号池的 `expiresAt` 是 UI 唯一的显示依据，存量账号可能与凭据不一致，
   * 故仍做一次幂等对账。
   *
   * 按 AGENTS.md 约定，这里**只看过期状态，不看 `enabled`** —— 停用只影响选号，
   * 与凭据健康无关。单账号失败不影响其他账号。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    if (!this.active) return
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      const ref = credentialRef(entry.credentialRef)
      let credential: ScnetCredential | undefined
      try {
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        credential = parseCredential(resolved.value)
      } catch {
        continue
      }
      if (credential === undefined) continue

      if (!isScnetExpired(credential)) {
        await syncAccountExpiry({
          pool,
          provider: this.product.id,
          credential,
          accessors: SCNET_EXPIRY_ACCESSORS,
          accountId: entry.id,
          current: entry,
          tag: '[scnet]',
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
        continue
      }

      try {
        const renewed = await this.renewCredential(credential)
        await this.ctx.credentials.set(ref, JSON.stringify(renewed))
        await syncAccountExpiry({
          pool,
          provider: this.product.id,
          credential: renewed,
          accessors: SCNET_EXPIRY_ACCESSORS,
          accountId: entry.id,
          current: entry,
          tag: '[scnet]',
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
      } catch (error) {
        if (error instanceof ScnetRefreshExpiredError) {
          this.ctx.logger?.warn?.(`[scnet] 账号 ${entry.id} 的平台会话已失效，需重新登录`)
        } else {
          this.ctx.logger?.warn?.(
            `[scnet] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /**
   * 登出：尽力让平台侧会话失效，然后清除默认单凭据。
   *
   * ⚠️ 平台没有「吊销 `sk-` Key」的接口，所以「退出」的语义是**停止使用**，
   * 不是让 Key 在平台失效。UI 文案不可写成「已吊销」。
   */
  async logout(): Promise<void> {
    this.active = false
    await this.closeFlow()
    const credential = await this.resolveDefaultCredential()
    if (credential?.cookies !== undefined) {
      try {
        await scnetPlatformLogout({ cookies: credential.cookies, fetcher: this.fetchImpl, product: this.product })
      } catch { /* 尽力而为 */ }
    }
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
  }

  /**
   * **有意为之的空实现。**
   *
   * `index.ts` 对全部 provider 统一调用 `scheduleRefresh()`，缺了它会以
   * `is not a function` 崩在启动路径上。SCNet 的账号健康由 `refreshAll(pool)`
   * （30 分钟定时器）承担，不需要单个凭据的续期调度器。
   */
  scheduleRefresh(): void {
    // 故意为空：续期由 refreshAll(pool) 统一驱动。
  }

  /** 卸载/停用：关闭登录页并停掉后台续期。 */
  stop(): void {
    this.active = false
    void this.closeFlow()
  }
}
