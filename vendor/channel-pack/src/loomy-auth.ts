/**
 * Loomy 认证服务。
 *
 * ## 与其余 7 个 provider 的**根本差异：不能续期**
 *
 * 其余 6 个都有 refresh_token 或等价的静默续期机制，`refreshAll()` 会真的
 * 换新凭据。Loomy **没有任何 refresh 端点** —— `session` 是登录时向服务端
 * 声明 `expire: 1209600`（14 天）得来的，到期只能**重新短信登录**。
 *
 * 因此：
 * - `isLoomyRefreshable()` 恒 `false`（诚实标记）；
 * - `refresh()` / `refreshAccountCredential()` 只做**有效性探测**
 *   （调一次轻量只读端点），失效时抛 `RefreshTokenExpiredError` 让 UI
 *   显示「凭证过期，请重新登录」，**不假装续期成功**；
 * - `refreshAll()` 只探测**已过期**的账号（避免每 30 分钟白发请求）。
 *
 * ## 服务名
 *
 * 由产品 id 派生为 `loomyAuth`（cordis 的 `Service` 同名二次注册会抛错，
 * 故每个 provider 各占一个服务名）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  credentialExpiresAtMs,
  isLoomyExpired,
  parseLoomyEnvelope,
  type LoomyCredential,
} from './loomy.js'
import { LOOMY, type LoomyProduct } from './loomy-product.js'
import { LOOMY_SESSION_TTL_SECONDS, loginLoomyBySmsCode, sendLoomySmsCode } from './loomy-oauth.js'
import {
  startLoomyWechatLoginFlow,
  type StartedLoomyWechatLoginFlow,
} from './loomy-wechat-login.js'
import { claimLoomyDailyQuota, fetchLoomyCreditBalance, fetchLoomyCreditDetail } from './loomy-credits.js'
import {
  claimAllLoomyOnboardingTasks,
  fetchLoomyOnboardingTasks,
} from './loomy-onboarding.js'
import { AccountPool } from './account-pool.js'
import { syncAccountExpiry, type ExpiryAccessors } from './expiry-sync.js'

/**
 * Loomy 凭据 → 账号池有效期的提取器。
 *
 * ⚠️ **刻意不提供 `refreshableOf`**：`isLoomyRefreshable` 恒为 `false`
 * （服务端没有任何 refresh 端点，这是「诚实标记」而非凭据状态），若让共享
 * 实现据此回写 `refreshable`，会把账号池改成与该产品实际行为不符的状态。
 * Loomy 这里只需要同步 `expiresAt`。
 */
const LOOMY_EXPIRY_ACCESSORS: ExpiryAccessors<LoomyCredential> = {
  expiresAtOf: credentialExpiresAtMs,
  identityOf: (credential) => credential.access_token ?? '',
}

/**
 * Loomy 的默认凭据 ref。
 *
 * 等价于 `LOOMY.defaultCredentialRef`，保留此导出仅为兼容既有导入方；
 * 新代码请用 `LOOMY.defaultCredentialRef`。
 */
export const LOOMY_CREDENTIAL_REF = 'LOOMY_ACCESS_TOKEN'

/**
 * 凭据已被判定失效（且**无法续期**）时抛出的错误。
 *
 * ⚠️ `name` 必须恰为 `RefreshTokenExpiredError` ——
 * `src/refresh.ts:21-25` 的 `isRefreshTokenExpired` 用 `error.name` 而非
 * `instanceof` 作判据（这些类跨模块 identity 不同）。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/**
 * 凭据探测**暂时无法判定**（网络错误 / HTTP 5xx / 非 JSON / 408 / 429）。
 *
 * ⚠️ 这不是「凭据已失效」：把它当成 `RefreshTokenExpiredError` 会让一次上游
 * 抖动直接要求用户重新短信登录；把它当成普通 `Error` 又会让宿主把整轮聊天
 * 归为 `UNKNOWN` 且不重试（issue #752）。
 *
 * 故这里给一个**明确的可重试错误**：`code` 取宿主认识的 `TRANSPORT`，
 * 同时保留专用 `name` 供调用方精确捕获。正常聊天路径由 `index.ts` 的
 * Loomy refresh 回调捕获它并返回已有凭据，让真正的 chat 请求去面对上游；
 * 万一它逃到宿主，也会因为 `TRANSPORT` 进入常规重试白名单。
 */
export class LoomyProbeUnavailableError extends Error {
  /** 宿主可重试错误码（`DEFAULT_RETRYABLE_CODES` 含 `TRANSPORT`）。 */
  readonly code = 'TRANSPORT'
  /** 语义标记：这是可重试的瞬时故障，不是凭据终态。 */
  readonly retryable = true

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'LoomyProbeUnavailableError'
  }
}

/**
 * 探测瞬时失败的重试间隔（毫秒）。
 *
 * 3 次尝试、两次退避（200ms / 600ms），总等待 800ms —— 比一次正常请求还短，
 * 不会把聊天拖成分钟级；更长的退避留给宿主对 chat 请求自己的重试策略。
 */
const LOOMY_PROBE_RETRY_DELAYS_MS = [200, 600] as const

/** 单次探测的判定结果。 */
type LoomyProbeOutcome =
  | { kind: 'ok' }
  | { kind: 'expired'; message: string }
  | { kind: 'transient'; message: string }
  | { kind: 'fatal'; message: string }

/** 一次成功登录的结果。 */
export interface LoomyLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 恒为 `false`（Loomy 无续期机制）。 */
  refreshable: boolean
}

/** 用于配置界面的只读登录状态。 */
export interface LoomyLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  /** 恒为 `false`（Loomy 无续期机制）。 */
  refreshable: boolean
  /** 最近一次探测失败的原因（如有）。 */
  refreshError?: string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Loomy 的认证服务实例。 */
    loomyAuth: LoomyAuth
  }
}

/** 从存储值解析凭据 JSON；解析失败返回 undefined。 */
function parseCredential(value: string): LoomyCredential | undefined {
  try {
    const parsed = JSON.parse(value) as LoomyCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** `LoomyAuth` 的构造选项。 */
export interface LoomyAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link LOOMY}。 */
  product?: LoomyProduct
  /** 服务名覆盖（默认由产品 id 派生为 `loomyAuth`）。 */
  serviceName?: string
}

/**
 * Loomy 认证服务：短信验证码登录 + **有效性探测**（非续期）。
 */
export class LoomyAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: LoomyProduct
  /** 本实例默认读写的凭据 ref 名称（`LOOMY_ACCESS_TOKEN`）。 */
  readonly credentialRefName: string

  /**
   * ⚠️ **刻意不使用 `RefreshScheduler`。**
   *
   * 那个调度器的存在意义是「在凭据过期前提前触发续期」
   * （`computeFirstRefreshDelayMs` 会在过期前 1 小时触发）。Loomy **无法续期**，
   * 武装它只会得到「1 小时后触发 → 探测 → 必然抛 RefreshTokenExpiredError
   * → 调度器停止」这一串无意义动作。
   *
   * 健康检查改由 `refreshAll(pool)` 承担 —— 它由 `index.ts` 的 30 分钟
   * 定时器驱动，只探测**已过期**的账号，语义与行为都诚实。
   * 故 `scheduleRefresh()` / `stop()` 是**有意为之的空实现**。
   */
  /** 最近一次探测失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined
  /** 登录会话是否仍活跃；logout()/stop() 置 false。 */
  private active = true

  constructor(ctx: Context, private readonly options: LoomyAuthOptions = {}) {
    const product = options.product ?? LOOMY
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 下发短信验证码。
   *
   * @returns `msgid` —— 提交验证码时必须原样带回。
   */
  async sendSmsCode(phone: string): Promise<string> {
    return sendLoomySmsCode(phone, this.product, this.fetchImpl)
  }

  /**
   * 启动**微信扫码**登录（推荐路径）。
   *
   * 起本地服务器承载弹窗页（内联二维码 + 轮询 + 首次绑手机号表单），
   * 立即返回 `loginUrl` —— 与其余 provider 的「两步式」契约一致
   * （`window.open` 只在用户手势窗口内有效，不能等流程跑完再返回）。
   *
   * ⚠️ 与官方 Electron 实现的关键差异：官方用 `BrowserWindow` 的
   * `will-redirect` 截获微信 code，而回调页实测 404；本实现改为
   * **长轮询**直接拿 code（见 `loomy-wechat.ts`），完全不碰回调页。
   */
  async startWechatLogin(): Promise<StartedLoomyWechatLoginFlow> {
    this.active = true
    return startLoomyWechatLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
  }

  /**
   * 把微信扫码流程的结果落盘成凭据。
   *
   * 与 `loginWithSmsCode` 分开：微信流程的编排（本地服务器 + 轮询 + 绑定表单）
   * 在 `loomy-wechat-login.ts` 里，本方法只负责「写凭据 + 初始化每日额度」。
   */
  async persistWechatLogin(
    login: { session: string; userid: string; phone: string; nickname?: string },
    flowOptions: { refName?: string } = {},
  ): Promise<LoomyLoginResult> {
    const credential = this.buildCredential(
      login.session, login.userid, login.phone, login.nickname,
    )
    const refName = flowOptions.refName ?? this.credentialRefName
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(credential))
    this.lastRefreshError = undefined

    // 尽力初始化每日额度（与官方登录后行为一致；失败不影响登录）。
    try {
      await claimLoomyDailyQuota(credential, this.product, this.fetchImpl)
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[loomy] 微信登录后初始化每日额度失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return {
      access: JSON.stringify(credential),
      expires: credentialExpiresAtMs(credential) ?? 0,
      ref,
      refreshable: false,
    }
  }

  /**
   * 用短信验证码登录并持久化凭据。
   *
   * `accountId` + `pool` 同时提供时，登录成功后自动把账号登记进账号池。
   */
  async loginWithSmsCode(
    phone: string,
    code: string,
    msgid: string,
    flowOptions: { refName?: string; accountId?: string; pool?: AccountPool } = {},
  ): Promise<LoomyLoginResult> {
    this.active = true
    const result = await loginLoomyBySmsCode(phone, code, msgid, this.product, this.fetchImpl)
    const credential = this.buildCredential(result.session, result.userid, phone)
    const refName = flowOptions.refName ?? this.credentialRefName
    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(credential))

    this.lastRefreshError = undefined

    // 尽力调用 first-login 初始化每日额度（与官方登录后行为一致）。
    // ⚠️ 失败**不影响登录**：这只是额度初始化，登录本身已经成功。
    try {
      await claimLoomyDailyQuota(credential, this.product, this.fetchImpl)
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[loomy] 登录后初始化每日额度失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return {
      access: JSON.stringify(credential),
      expires: credentialExpiresAtMs(credential) ?? 0,
      ref,
      // ⚠️ 恒 false：Loomy 无续期机制。
      refreshable: false,
    }
  }

  /**
   * 构造凭据对象。
   *
   * ⚠️ `expires_at` 由**本地**按 14 天推算 —— 服务端响应里不带到期时间戳，
   * 它只接受登录请求里的 `expire` 参数。
   */
  buildCredential(session: string, userid: string, phone: string, nickname?: string): LoomyCredential {
    return {
      access_token: session,
      userid,
      phone,
      ...nickname === undefined || nickname.length === 0 ? {} : { nickname },
      expires_at: String(Date.now() + LOOMY_SESSION_TTL_SECONDS * 1000),
    }
  }

  /** 解析当前单凭据（默认 ref）。 */
  private async resolveDefaultCredential(): Promise<LoomyCredential | undefined> {
    const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
    return resolved === undefined ? undefined : parseCredential(resolved.value)
  }

  /** 只读登录状态。 */
  async status(): Promise<LoomyLoginStatus> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = credentialExpiresAtMs(credential)
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === undefined ? {} : { expiresAt },
      // ⚠️ 恒 false：Loomy 无续期机制。UI 据此显示「过期需重新登录」。
      refreshable: false,
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /**
   * 探测凭据有效性（**不续期**）。
   *
   * ⚠️ 这是与其余 provider 语义上的关键差异：`refresh()` 在那边意味着
   * 「换一份新凭据」，在这里只能是「确认这份凭据还活着」。
   * 失效时抛 `RefreshTokenExpiredError`，让 UI 明确提示重新登录，
   * 而不是静默假装成功。
   *
   * @throws {RefreshTokenExpiredError} 明确的登录失效（业务码 `100002`）。
   * @throws {LoomyProbeUnavailableError} 重试后仍无法判定（网络 / 5xx /
   *   非 JSON / 408 / 429）。调用方**不要**据此要求重新登录；聊天路径应保留
   *   已有凭据，让上游的 chat 请求按它自己的重试策略处理。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new RefreshTokenExpiredError('凭据未配置，请先登录')
    await this.probeCredential(credential)
    this.lastRefreshError = undefined
  }

  /**
   * 探测指定 ref 的凭据有效性（RPC `account.refresh`）。
   *
   * ⚠️ 与 `refresh()` 的区别：`refresh()` 读写默认单凭据 ref，
   * 而账号卡片对应的是 `LOOMY_ACCOUNT_XXX`。用 `refresh()` 刷账号池里的
   * 账号实际刷的是另一个凭据（本插件在 Cline 上踩过同类坑）。
   *
   * ⚠️ **不触碰** `lastRefreshError`：那个状态属于单凭据路径，
   * 被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ 探测成功后**要把凭据的过期时间对账回账号池**（issue !IKIRTT）：
   * UI 卡片读的正是池值。Loomy 虽不能续期（凭据里的 exp 不会变），但池值
   * 可能与凭据实际 exp 不一致（历史写入偏差），对账能让显示恢复正确。
   * 只回写 `expiresAt`，见 `LOOMY_EXPIRY_ACCESSORS` 的说明。
   *
   * @throws {RefreshTokenExpiredError} 明确的登录失效（业务码 `100002`）。
   * @throws {LoomyProbeUnavailableError} 重试后仍无法判定；此时**不**回写
   *   账号池有效期，避免把“没验证到”伪装成“已验证”。
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
    await this.probeCredential(credential)
    await syncAccountExpiry({
      pool,
      provider: this.product.id,
      credential,
      accessors: LOOMY_EXPIRY_ACCESSORS,
      accountId,
      tag: '[loomy]',
      warn: (message) => this.ctx.logger?.warn?.(message),
    })
  }

  /**
   * 用一次轻量只读请求验证凭据是否仍然有效。
   *
   * 选 `GET /points/records?pageSize=1` 的理由：它是最便宜的只读端点
   * （不消耗积分、不产生任何副作用），且认证语义与其它业务端点一致。
   *
   * ## 为什么瞬时失败要重试，且最终不能抛普通 Error（issue #752）
   *
   * 探测端点是普通业务接口：上游 502 会回 HTML、网关超时会直接断连接。
   * 这些**都没有回答“凭据是否有效”**，既不能判失效，也不该让整轮聊天在
   * 取凭据阶段就终止 —— 同一时段的 chat 502 本来会被宿主重试 5 次。
   *
   * 故：
   * - 网络错误 / 5xx / 非 JSON / 408 / 429：短退避重试，仍失败则抛
   *   {@link LoomyProbeUnavailableError}（明确的“未判定”而非“已失效”）；
   * - `100002`：立即抛 {@link RefreshTokenExpiredError}，不重试；
   * - 401/403 或其它确定的业务错误：立即抛普通 Error，照旧失败。
   *
   * @throws {RefreshTokenExpiredError} 收到 `100002`（登录已失效）。
   * @throws {LoomyProbeUnavailableError} 重试后仍无法判定凭据有效性。
   */
  private async probeCredential(credential: LoomyCredential): Promise<void> {
    const attempts = LOOMY_PROBE_RETRY_DELAYS_MS.length + 1
    let lastReason = '未知原因'

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        const delayMs = LOOMY_PROBE_RETRY_DELAYS_MS[attempt - 2]!
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }

      const outcome = await this.probeCredentialOnce(credential)
      if (outcome.kind === 'ok') return
      if (outcome.kind === 'expired') throw new RefreshTokenExpiredError(outcome.message)
      if (outcome.kind === 'fatal') throw new Error(outcome.message)

      lastReason = outcome.message
      if (attempt < attempts) {
        this.ctx.logger?.warn?.(
          `[loomy] 凭据探测第 ${attempt}/${attempts} 次暂时失败（${outcome.message}），`
          + `${LOOMY_PROBE_RETRY_DELAYS_MS[attempt - 1]}ms 后重试`,
        )
      }
    }

    throw new LoomyProbeUnavailableError(
      `Loomy 凭据探测暂时不可用（已尝试 ${attempts} 次）：${lastReason}。`
      + '未判定凭据失效，稍后重试即可。',
    )
  }

  /** 执行单次探测并分类结果（不重试、不抛错）。 */
  private async probeCredentialOnce(credential: LoomyCredential): Promise<LoomyProbeOutcome> {
    let response: Response
    try {
      response = await this.fetchImpl(
        `${this.product.apiBase}/points/records?pageNo=1&pageSize=1&recordType=all`,
        {
          method: 'GET',
          headers: { Accept: 'application/json', token: credential.access_token },
          signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
        },
      )
    } catch (error) {
      // 传输层失败**不能**判为终态 —— 网络抖动不该让用户重新登录。
      return {
        kind: 'transient',
        message: `网络失败：${error instanceof Error ? error.message : String(error)}`,
      }
    }

    const status = response.status
    if (status >= 500 || status === 408 || status === 429) {
      // 网关/限流层没有回答“凭据是否有效”。先释放响应体再重试。
      try { await response.body?.cancel() } catch {}
      return { kind: 'transient', message: `HTTP ${status}` }
    }

    let parsed: unknown
    try {
      parsed = await response.json()
    } catch {
      if (status === 401 || status === 403) {
        // 明确的认证失败：不重试，也不降级成“继续聊天”。
        return { kind: 'fatal', message: `Loomy 凭据探测被拒绝（HTTP ${status}），请重新登录` }
      }
      // 200/4xx 却回 HTML（代理页、登录页）同样无法判定，按瞬时故障处理。
      return { kind: 'transient', message: `响应不是 JSON（HTTP ${status}）` }
    }

    const envelope = parseLoomyEnvelope(parsed)
    if (status === 401 || status === 403) {
      // ⚠️ 只有业务码 100002 才代表登录失效（Loomy 的业务失败恒 HTTP 200，
      // 故 401/403 只可能来自网关/中间层）。HTTP 401 即使 body 自称成功也不能信。
      return envelope.code === LOOMY_AUTH_ERROR_CODE
        ? { kind: 'expired', message: `Loomy 凭证已失效，请重新登录（${envelope.message}）` }
        : { kind: 'fatal', message: `Loomy 凭据探测被拒绝（HTTP ${status}）：${envelope.message}` }
    }

    // 合法 JSON 但缺业务码（数组、`{}`、登录页 JSON）同样没有回答“凭据是否
    // 有效”：按瞬时故障重试，而不是让整轮聊天死在一个无法判定的响应上。
    if (envelope.code.length === 0) {
      return {
        kind: 'transient',
        message: `响应缺少可判定的业务码（HTTP ${status}）：${envelope.message}`,
      }
    }

    if (envelope.ok) return { kind: 'ok' }
    if (envelope.code === LOOMY_AUTH_ERROR_CODE) {
      // ⚠️ Loomy 无法续期：这里只能明确报「需重新登录」，
      // 不能像其余 provider 那样尝试换新凭据。
      return { kind: 'expired', message: `Loomy 凭证已失效，请重新登录（${envelope.message}）` }
    }
    return { kind: 'fatal', message: `Loomy 凭据探测失败：${envelope.message}` }
  }

  /**
   * 批量探测本产品的账号。
   *
   * ⚠️ **只探测已过期的账号**：Loomy 不可续期，对未过期的账号做探测
   * 纯属白费请求（`refreshAll` 每 30 分钟跑一次）。
   *
   * ⚠️ 按 AGENTS.md 约定，过滤**只看过期状态，不看 `enabled`** ——
   * 停用只影响账号池的自动选号，与凭据健康无关。
   *
   * 单账号失败不影响其他账号。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      const ref = credentialRef(entry.credentialRef)
      let credential: LoomyCredential | undefined
      try {
        const resolved = await this.ctx.credentials.resolve(ref)
        if (!resolved) continue
        credential = parseCredential(resolved.value)
      } catch {
        continue
      }
      if (credential === undefined) continue

      // 只探测**已过期**的账号：Loomy 不可续期，未过期的账号无事可做。
      //
      // ⚠️ 但「无事可做」不等于「什么都不做」（issue !IKIRTT）：账号池的
      // `expiresAt` 是 UI 唯一的显示依据，存量账号的池值可能与凭据实际 exp
      // 不一致（早先各路径都不回写）。若这里直接 `continue`，这条不一致就
      // **永远无人更正** —— 于是明明有效的账号一直挂着红字「已过期」。
      if (!isLoomyExpired(credential)) {
        await syncAccountExpiry({
          pool,
          provider: this.product.id,
          credential,
          accessors: LOOMY_EXPIRY_ACCESSORS,
          accountId: entry.id,
          current: entry,
          tag: '[loomy]',
          warn: (message) => this.ctx.logger?.warn?.(message),
        })
        continue
      }

      try {
        await this.probeCredential(credential)
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          this.ctx.logger?.warn?.(
            `[loomy] 账号 ${entry.id} 的凭证已失效（Loomy 无续期端点，需重新登录）`,
          )
        } else if (error instanceof LoomyProbeUnavailableError) {
          // “没验证到”不是“已失效”：定时健康检查只记日志，绝不改账号状态。
          this.ctx.logger?.warn?.(
            `[loomy] 账号 ${entry.id} 凭据探测暂时不可用（未判定失效）：${error.message}`,
          )
        } else {
          // 非终态失败（网络抖动、5xx）也必须留日志：曾经完全静默的实现
          // 让「续期永远失败但 UI 显示可续期」无法排查。
          this.ctx.logger?.warn?.(
            `[loomy] 账号 ${entry.id} 凭证探测失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /** 登出：清除默认单凭据。 */
  async logout(): Promise<void> {
    this.active = false
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
  }

  /**
   * **有意为之的空实现。**
   *
   * 其余 provider 用它武装 `RefreshScheduler`（过期前 1 小时自动续期）。
   * Loomy **无法续期**，武装调度器只会得到一串无意义的「探测 → 必然失败」。
   * 账号健康由 `refreshAll(pool)` 承担（`index.ts` 的 30 分钟定时器驱动）。
   *
   * 保留该方法是**契约要求**：`index.ts` 对全部 provider 统一调用
   * `scheduleRefresh()`，缺了它会以 `is not a function` 崩在启动路径上。
   */
  scheduleRefresh(): void {
    // 故意为空：Loomy 无续期端点。
  }

  /**
   * **有意为之的空实现。**
   *
   * 与 `scheduleRefresh()` 同理：没有调度器需要停止。
   * 保留它是契约要求 —— `index.ts` 的 cleanup 对全部 provider 统一调 `stop()`。
   */
  stop(): void {
    this.active = false
  }

  // ── 业务能力（供 Channel Pack RPC 调用）────────────────────────────────

  /** 查询积分余额（只读，两池映射成 CreditBalance）。 */
  async fetchCreditBalance(credential: LoomyCredential) {
    return fetchLoomyCreditBalance(credential, this.product, this.fetchImpl)
  }

  /** 查询积分两池明细（只读）。 */
  async fetchCreditDetail(credential: LoomyCredential) {
    return fetchLoomyCreditDetail(credential, this.product, this.fetchImpl)
  }

  /** 一键签到：触发每日额度。 */
  async claimDailyQuota(credential: LoomyCredential) {
    return claimLoomyDailyQuota(credential, this.product, this.fetchImpl)
  }

  /** 查询新手任务状态。 */
  async fetchOnboardingTasks(credential: LoomyCredential) {
    return fetchLoomyOnboardingTasks(credential, this.product, this.fetchImpl)
  }

  /** 领取全部新手任务（补差额）。 */
  async claimOnboardingTasks(credential: LoomyCredential) {
    return claimAllLoomyOnboardingTasks(credential, this.product, this.fetchImpl)
  }
}
