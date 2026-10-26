/**
 * Raccoon Work 认证服务。
 *
 * ## 与其余 provider 的差异
 *
 * | 维度 | raccoon | 对照 |
 * |---|---|---|
 * | 登录 | 微信扫码 + 短信（本地页承载） | Loomy 同型 |
 * | 续期 | **有** `refresh_token` 轮换 | Loomy 没有（恒 false） |
 * | 凭据过期 | JWT `exp` 本地解码 | 比 Loomy 的「登录时刻 + 14 天推算」更准 |
 *
 * ## 两条硬约束（来自 AGENTS.md 的真实缺陷）
 *
 * 1. **`refreshAll` 只按 `refreshable` 过滤，绝不看 `enabled`** ——
 *    停用只影响账号池的自动选号，与「凭据是否需要保持新鲜」无关。
 *    早期按 `enabled` 过滤导致两个停用账号的 refresh_token 被放到失效。
 * 2. **`refreshAccountCredential(refName)` 只读写传入的 ref** ——
 *    账号卡片要刷的是 `RACCOON_ACCOUNT_XXX`，而 `refresh()` 读写默认单凭据 ref。
 *    错配的后果是「刷了另一个凭据」（本插件在 Cline 上踩过同类坑）。
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { AccountPool } from './account-pool.js'
import type { ClaimOutcome, CreditBalance } from './credits.js'
import {
  isRaccoonExpired,
  isRaccoonRefreshable,
  raccoonCredentialExpiresAtMs,
  raccoonDisplayName,
  decodeJwtExpMs,
  type RaccoonCredential,
  type RaccoonModelMeta,
} from './raccoon.js'
import {
  claimRaccoonLoginReward,
  fetchRaccoonCreditBalance,
  fetchRaccoonOnboardingStatus,
} from './raccoon-credits.js'
import {
  fetchRaccoonUserInfo,
  refreshRaccoonCredential,
} from './raccoon-oauth.js'
import { RACCOON, raccoonSupportsImage, type RaccoonProduct } from './raccoon-product.js'
import {
  startRaccoonLoginFlow,
  type StartedRaccoonLoginFlow,
} from './raccoon-login-page.js'
import {
  syncAccountExpiry,
  type ExpiryAccessors,
} from './expiry-sync.js'

/**
 * Raccoon 凭据 → 账号池有效期的提取器。
 *
 * 本 provider 是这套回写的**原产地**：早期它是唯一漏掉回写的实现（用户报障后
 * 修好），现把那份逻辑抽到 `src/expiry-sync.ts` 供九个 provider 共用 ——
 * 留两份必然漂移，故这里改为调用共享实现。
 */
const RACCOON_EXPIRY_ACCESSORS: ExpiryAccessors<RaccoonCredential> = {
  expiresAtOf: raccoonCredentialExpiresAtMs,
  refreshableOf: isRaccoonRefreshable,
  identityOf: (credential) => credential.access_token ?? '',
}

/** 默认凭据 ref 名称（与 `RaccoonProduct.defaultCredentialRef` 一致）。 */
export const RACCOON_CREDENTIAL_REF = 'RACCOON_ACCESS_TOKEN'

/**
 * 续期令牌失效。
 *
 * 单独一个类而不是 `Error`：调用方据此区分「需要重新登录」（终态）
 * 与「暂时性失败」（可重试），分别决定 UI 文案与是否继续重试。
 */
export class RefreshTokenExpiredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RefreshTokenExpiredError'
  }
}

/** 登录/续期后的结果（与 `LoomyLoginResult` 同构）。 */
export interface RaccoonLoginResult {
  /** 已存储的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 凭据值存储所用的凭据引用。 */
  ref: CredentialRef
  /** 是否可续期（取决于是否存在 refresh_token）。 */
  refreshable: boolean
}

/** 只读登录状态。 */
export interface RaccoonLoginStatus {
  configured: boolean
  source?: string
  expiresAt?: number
  refreshable: boolean
  refreshError?: string
}

/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}

/** `RaccoonAuth` 的构造选项。 */
export interface RaccoonAuthOptions {
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品配置；默认 {@link RACCOON}。 */
  product?: RaccoonProduct
  /** 服务名覆盖（默认由产品 id 派生为 `raccoonAuth`）。 */
  serviceName?: string
}

/** 解析凭据 JSON；形状不对返回 undefined（不抛错）。 */
export function parseRaccoonCredential(value: string): RaccoonCredential | undefined {
  try {
    const parsed = JSON.parse(value) as RaccoonCredential
    return typeof parsed === 'object' && parsed !== null && typeof parsed.access_token === 'string'
      ? parsed
      : undefined
  } catch {
    return undefined
  }
}

/** 把远端模型条目归一（含展示名）。 */
function normalizeRemoteModel(entry: Record<string, unknown>): RaccoonRemoteModel | undefined {
  const id = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (id.length === 0) return undefined
  // 远端 visible 缺省视为可见（保守：不因字段缺失而隐藏模型）
  if (entry.visible === false) return undefined

  const params = typeof entry.params === 'object' && entry.params !== null
    ? entry.params as Record<string, unknown>
    : {}
  const description = typeof entry.description === 'string' && entry.description.length > 0
    ? entry.description
    : id
  const effective = typeof entry.billing_effective_multiplier === 'number'
    ? entry.billing_effective_multiplier
    : Number.NaN
  const base = typeof entry.billing_multiplier === 'number' ? entry.billing_multiplier : Number.NaN
  const rawStatus = typeof entry.billing_status === 'string' ? entry.billing_status : ''
  const status: RaccoonModelMeta['status'] = rawStatus === 'discount' || rawStatus === 'limited_free'
    ? rawStatus
    : 'normal'
  const statusNote = typeof entry.billing_status_note === 'string' ? entry.billing_status_note : ''

  const meta: RaccoonModelMeta = {
    id,
    description,
    effectiveMultiplier: effective,
    baseMultiplier: base,
    status,
    statusNote,
  }

  const readPositiveInt = (value: unknown): number => {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0
  }
  const tags = Array.isArray(entry.tags)
    ? entry.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase())
    : []

  return {
    id,
    name: raccoonDisplayName(meta),
    contextWindow: readPositiveInt(params.context_window ?? entry.context_window),
    maxTokens: readPositiveInt(params.max_tokens),
    // ⚠️ **不能只看 tags**：`vision` 是客户端「Raccoon-Auto 选模」的偏好标签，
    // 不是服务端能力契约（远端根本没有模态字段，已穷举证实）。`tags` 不含
    // `vision` 的 `sn-deepseek-v4-1-flash` 实测能看图（5/5 读对随机数字），
    // 只认 tags 会让它被 DSH 投影成文本占位符 —— 图片根本发不出去。
    // 证据与取舍见 `raccoon-product.ts` 的 RACCOON_IMAGE_CAPABILITY_OVERRIDES。
    supportsImage: raccoonSupportsImage(id, tags),
  }
}

/**
 * Raccoon Work 认证服务。
 *
 * 登录走**本地页承载**的扫码/短信双路径（见 `raccoon-login-page.ts`），
 * 续期走 `refresh_token` 轮换（与 Loomy 不同）。
 */
export class RaccoonAuth extends Service {
  /** 本实例所属的产品配置。 */
  readonly product: RaccoonProduct
  /** 本实例默认读写的凭据 ref 名称。 */
  readonly credentialRefName: string

  /** 最近一次续期失败的原因（供 `status()` 暴露给 UI）。 */
  private lastRefreshError: string | undefined

  constructor(ctx: Context, private readonly options: RaccoonAuthOptions = {}) {
    const product = options.product ?? RACCOON
    super(ctx, options.serviceName ?? `${product.id}Auth`)
    this.product = product
    this.credentialRefName = this.product.defaultCredentialRef
  }

  /** 注入的 fetch（测试用）；默认为全局 fetch。 */
  private get fetchImpl(): typeof fetch {
    return this.options.fetcher ?? fetch
  }

  /**
   * 启动登录（微信扫码 + 短信双路径）。
   *
   * 起本地服务器承载弹窗页，**立即返回 `loginUrl`** —— 与其余 provider 的
   * 「两步式」契约一致（`window.open` 只在用户手势窗口内有效，
   * 不能等流程跑完再返回）。
   */
  async startLogin(): Promise<StartedRaccoonLoginFlow> {
    return startRaccoonLoginFlow({
      product: this.product,
      ...this.options.fetcher === undefined ? {} : { fetcher: this.options.fetcher },
    })
  }

  /**
   * 把登录结果落盘成凭据。
   *
   * 与 `startLogin` 分开：流程编排（本地服务器 + 轮询 + 表单）在
   * `raccoon-login-page.ts` 里，本方法只负责「补全用户信息 + 写凭据 +
   * 静默领取一次性登录奖励」。
   */
  async persistLogin(
    credential: RaccoonCredential,
    flowOptions: { refName?: string } = {},
  ): Promise<RaccoonLoginResult> {
    const refName = flowOptions.refName ?? this.credentialRefName

    // 尽力补全用户信息（id / 昵称 / 身份 / 手机号）：失败不影响登录。
    let enriched: RaccoonCredential = credential
    if (
      credential.nickname === undefined
      || credential.user_id === undefined
      || credential.phone === undefined
    ) {
      const info = await fetchRaccoonUserInfo(this.product, credential, this.fetchImpl)
      enriched = {
        ...credential,
        ...info.userId !== undefined && credential.user_id === undefined ? { user_id: info.userId } : {},
        ...info.nickname !== undefined && credential.nickname === undefined ? { nickname: info.nickname } : {},
        ...info.officeIdentity !== undefined && credential.office_identity === undefined
          ? { office_identity: info.officeIdentity } : {},
        // ⚠️ 手机号专门为**多账号消歧**而存：远端的 `name` 是自动生成的默认名
        //（实测 `RaccoonAva`），微信扫码不回传微信昵称，故多个账号会重名。
        ...info.phone !== undefined && credential.phone === undefined ? { phone: info.phone } : {},
      }
    }

    const ref = credentialRef(refName)
    await this.ctx.credentials.set(ref, JSON.stringify(enriched))
    this.lastRefreshError = undefined

    // 尽力领取**一次性**登录奖励（3000 分）。幂等：已领过返回 granted:false。
    // 失败不影响登录成功 —— 登录已经完成了，不能因为积分接口抖动而报错。
    try {
      await claimRaccoonLoginReward(this.product, enriched, this.fetchImpl)
    } catch (error) {
      this.ctx.logger?.warn?.(
        `[raccoon] 登录后领取登录奖励失败（不影响登录）：${error instanceof Error ? error.message : String(error)}`,
      )
    }

    return {
      access: JSON.stringify(enriched),
      expires: decodeJwtExpMs(enriched.access_token) ?? 0,
      ref,
      refreshable: isRaccoonRefreshable(enriched),
    }
  }

  /** 只读登录状态。 */
  async status(): Promise<RaccoonLoginStatus> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) return { configured: false, refreshable: false }
    const expiresAt = decodeJwtExpMs(credential.access_token)
    return {
      configured: true,
      source: this.credentialRefName,
      ...expiresAt === undefined ? {} : { expiresAt },
      refreshable: isRaccoonRefreshable(credential),
      ...this.lastRefreshError === undefined ? {} : { refreshError: this.lastRefreshError },
    }
  }

  /** 解析默认 ref 的凭据。 */
  private async resolveDefaultCredential(): Promise<RaccoonCredential | undefined> {
    try {
      const resolved = await this.ctx.credentials.resolve(credentialRef(this.credentialRefName))
      return resolved === undefined ? undefined : parseRaccoonCredential(resolved.value)
    } catch {
      return undefined
    }
  }

  /**
   * 续期默认单凭据。
   *
   * @throws {RefreshTokenExpiredError} refresh_token 失效（需重新登录）。
   */
  async refresh(): Promise<void> {
    const credential = await this.resolveDefaultCredential()
    if (credential === undefined) throw new RefreshTokenExpiredError('凭据未配置，请先登录')
    if (!isRaccoonRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      const next = await refreshRaccoonCredential(this.product, credential, this.fetchImpl)
      await this.ctx.credentials.set(credentialRef(this.credentialRefName), JSON.stringify(next))
      this.lastRefreshError = undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastRefreshError = message
      if (message.includes('重新登录')) throw new RefreshTokenExpiredError(message)
      throw error
    }
  }

  /**
   * 续期**指定 ref**（RPC `account.refresh` / 定时器）。
   *
   * ⚠️ 只读写传入的 ref，**不碰**默认单凭据 ref —— 账号池里的是
   * `RACCOON_ACCOUNT_XXX`，用 `refresh()` 会刷错凭据。
   * ⚠️ **不触碰** `lastRefreshError`：那属于单凭据路径，
   * 被多账号操作污染会让 UI 显示错误的失效提示。
   *
   * ⚠️ **必须把新过期时间写回账号池**（真实缺陷，用户报障）：
   * 只更新凭据、不更新账号池，会让 Channel Pack 一直显示「已过期」——
   * 因为 UI 读的是账号池的 `expiresAt`，而它停留在续期前的旧值。
   * 实测该账号的 JWT `exp` 已是 15:09（有效），账号池却是 12:02（已过期），
   * **相差 3.1 小时**，UI 显示「已过期」但发消息完全正常。
   *
   * @param pool 账号池；提供时会把新 `expiresAt` / `refreshable` 写回。
   * @param accountId 账号 id。**调用方已知时请显式传入** ——
   *   否则只能按凭据内容反查（`findAccountIdByCredential` 遍历账号、
   *   逐个解析凭据比对，代价高且需要账号池具备凭据访问能力）。
   */
  async refreshAccountCredential(
    refName: string,
    pool?: AccountPool,
    accountId?: string,
  ): Promise<void> {
    const ref = credentialRef(refName)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (!resolved) throw new Error('凭据未配置')
    const credential = parseRaccoonCredential(resolved.value)
    if (!credential) throw new Error('凭据解析失败')
    if (!isRaccoonRefreshable(credential)) {
      throw new RefreshTokenExpiredError('凭据缺少 refresh_token，请重新登录')
    }
    try {
      const next = await refreshRaccoonCredential(this.product, credential, this.fetchImpl)
      await this.ctx.credentials.set(ref, JSON.stringify(next))
      await syncAccountExpiry({
        pool,
        provider: this.product.id,
        credential: next,
        accessors: RACCOON_EXPIRY_ACCESSORS,
        accountId,
        tag: '[raccoon]',
        warn: (message) => this.ctx.logger?.warn?.(message),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('重新登录')) throw new RefreshTokenExpiredError(message)
      throw error
    }
  }

  /**
   * 说明：原先这里有一份私有的 `syncAccountExpiry`（把续期后的过期时间写回
   * 账号池，失败只记日志不上抛）。它已被抽到 `src/expiry-sync.ts` 成为九个
   * provider 共用的实现 —— 三条硬规矩（失败不反噬、优先用调用方的 accountId、
   * 反查要传**凭据内容**而非 ref 名）都随之外移并记在那份文件的注释里。
   */

  /**
   * 批量续期本产品的账号。
   *
   * ⚠️ **只按 `refreshable` 过滤，不看 `enabled`**：停用只影响账号池的
   * 自动选号，与「凭据是否需要保持新鲜」无关。早期按 `enabled` 过滤导致
   * 两个停用账号的 refresh_token 在停用期间被放到失效（真实缺陷，见 AGENTS.md）。
   *
   * 单账号失败不影响其他账号（且**必须留日志**：曾完全静默的实现
   * 让「续期永远失败但 UI 显示可续期」无法排查）。
   */
  async refreshAll(pool: AccountPool): Promise<void> {
    const accounts = await pool.listAccounts(this.product.id)
    for (const entry of accounts) {
      // ⚠️ 判据只看 refreshable
      if (!entry.refreshable) continue

      const resolved = await this.ctx.credentials.resolve(credentialRef(entry.credentialRef))
      if (!resolved) continue
      const credential = parseRaccoonCredential(resolved.value)
      if (credential === undefined) continue

      // ⚠️ **凭据仍在有效期内时也要校正账号池的 `expiresAt`**（真实缺陷的完整修法）：
      //
      // 早期版本续期后不回写账号池，于是账号池停留在旧值（已过期），
      // 而 UI 读的正是账号池 → 一直显示「已过期」但功能完全正常。
      // 修复「续期时回写」之后，**存量账号**仍然是坏的：它们的凭据
      // 早已续期成功（JWT exp 在未来），故这里的判据为 false、
      // 这条 `continue` 会**永远跳过它们** —— 账号池的值再也无人更正。
      //
      // 故这里主动比对：凭据的过期时间与账号池记录**不一致**时以凭据为准回写。
      // 判据用「不一致」而不是「账号池已过期」：后者会漏掉「账号池值偏小但
      // 尚未过期」的情形（同样会让 UI 显示错误的剩余时间）。
      //
      // 判据沿用本 provider 原有的「**已过期**才刷」（不是共享的 1 小时 lead）：
      // raccoon 的 access_token 寿命约 3 小时，30 分钟的定时器足以覆盖，
      // 提前 1 小时刷只会多打请求 —— lead-time 过滤的目的恰恰是**减少**无谓请求。
      if (!isRaccoonExpired(credential)) {
        const actual = raccoonCredentialExpiresAtMs(credential)
        // 容忍 1 秒误差（毫秒时间戳来自 JWT 的秒级 exp，换算后可能有舍入）
        if (actual !== undefined && Math.abs((entry.expiresAt ?? 0) - actual) > 1000) {
          try {
            await pool.updateAccount(entry.id, { expiresAt: actual })
            this.ctx.logger?.info?.(
              `[raccoon] 已校正账号 ${entry.id} 的有效期显示`
              + `（账号池 ${entry.expiresAt === undefined ? '无' : new Date(entry.expiresAt).toISOString()}`
              + ` → ${new Date(actual).toISOString()}）`,
            )
          } catch (error) {
            this.ctx.logger?.warn?.(
              `[raccoon] 校正账号 ${entry.id} 的有效期失败（不影响使用）：`
              + `${error instanceof Error ? error.message : String(error)}`,
            )
          }
        }
        continue
      }

      try {
        // ⚠️ 必须传 `pool` + `entry.id`：否则续期后不回写 `expiresAt`，
        // UI 会一直显示「已过期」（真实缺陷，见方法注释）。
        await this.refreshAccountCredential(entry.credentialRef, pool, entry.id)
      } catch (error) {
        if (error instanceof RefreshTokenExpiredError) {
          this.ctx.logger?.warn?.(`[raccoon] 账号 ${entry.id} 的 refresh_token 已失效，需重新登录`)
        } else {
          this.ctx.logger?.warn?.(
            `[raccoon] 账号 ${entry.id} 续期失败：${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    }
  }

  /** 登出：清除默认单凭据。 */
  async logout(): Promise<void> {
    await this.ctx.credentials.unset(credentialRef(this.credentialRefName))
    this.lastRefreshError = undefined
  }

  /**
   * 拉取远端模型目录。
   *
   * ⚠️ 失败时返回**空数组**：适配器据此回退兜底表。
   * 让模型目录失败不抛错，是为了不让整个 provider 在模型选择器里报错。
   */
  async fetchModels(pool?: AccountPool): Promise<RaccoonRemoteModel[]> {
    const credential = await this.resolveForFetchModels(pool)
    if (credential === undefined) return []

    try {
      const response = await this.fetchImpl(
        `${this.product.apiBase}${this.product.llmApiPrefix}/model_catalog`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${credential.access_token}`,
            'X-Org-Code': credential.office_identity ?? '',
            'X-Raccoon-Language': 'zh',
          },
          signal: AbortSignal.timeout(20_000),
        },
      )
      if (!response.ok) return []
      const payload = await response.json() as unknown
      return parseRaccoonModelCatalog(payload)
    } catch {
      return []
    }
  }

  /** 取一个可用凭据（先账号池，再默认 ref）。 */
  private async resolveForFetchModels(pool?: AccountPool): Promise<RaccoonCredential | undefined> {
    if (pool !== undefined) {
      try {
        // ⚠️ 返回类型是 `| null`（不是 undefined）—— 判空必须用 `!= null` 或显式 null。
        const available = await pool.getAvailableAccount(this.product.id, '')
        if (available !== null && available !== undefined) {
          const credential = available.credential as unknown as RaccoonCredential
          if (typeof credential?.access_token === 'string') return credential
        }
      } catch {
        // 落到默认 ref
      }
    }
    return this.resolveDefaultCredential()
  }

  /** 查询积分余额（供 Channel Pack 账号卡片）。 */
  async fetchCreditBalance(credential: RaccoonCredential): Promise<CreditBalance | null> {
    return fetchRaccoonCreditBalance(this.product, credential, this.fetchImpl)
  }

  /** 领取一次性登录奖励。 */
  async claimLoginReward(credential: RaccoonCredential): Promise<ClaimOutcome> {
    return claimRaccoonLoginReward(this.product, credential, this.fetchImpl)
  }

  /** 查询一次性登录奖励是否已领。 */
  async fetchOnboardingStatus(
    credential: RaccoonCredential,
  ): Promise<{ claimed: boolean; points: number }> {
    return fetchRaccoonOnboardingStatus(this.product, credential, this.fetchImpl)
  }

  /**
   * 一次性修复**老账号**的昵称与凭据字段（启动时调用）。
   *
   * ## 为什么需要它
   *
   * 早期实现有两处不足，导致**已登录的账号不会自动更正**：
   *
   * 1. 账号昵称直接用了服务端的 `name`（实测 `RaccoonAva` —— 它是服务端
   *    **自动生成的默认名**，注册第二个账号时会重名、无法区分）；
   * 2. 凭据里**没有存 `phone`**（后来才发现 `user_info.phone` 可用于消歧）。
   *
   * 光改代码只影响**新登录**的账号，老账号的昵称/凭据仍是旧值。
   * 故这里主动补一次：读凭据 → 缺 `phone` 就拉一次 `user_info` 补上 →
   * 用 `buildRaccoonNickname` 重算昵称并写回账号池。
   *
   * ## 语义约束
   *
   * - **幂等**：昵称已是目标形态时不写（避免每次启动都落盘）。
   * - **失败不阻塞启动**：单个账号失败只记日志，抛错由调用方 catch。
   * - **不发写请求**：只调只读的 `user_info`，不碰积分领取端点。
   * - `buildNickname` 由调用方注入（它依赖 `channel-pack-rpc` 里的纯函数，
   *   而那个模块依赖本模块 —— 注入避免循环依赖）。
   *
   * @returns 被修复的账号 id 列表（供日志）。
   */
  async repairAccountNicknames(
    pool: import('./account-pool.js').AccountPool,
    buildNickname: (
      credential: Pick<RaccoonCredential, 'nickname' | 'phone' | 'user_id'>,
      fallbackId: string,
    ) => string,
  ): Promise<string[]> {
    const repaired: string[] = []
    let entries: Awaited<ReturnType<typeof pool.listAccounts>>
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
        const credential = parseRaccoonCredential(resolved.value)
        if (credential === undefined) continue

        // 缺 phone（或 user_id/nickname）时补一次 user_info（只读）。
        let next = credential
        if (credential.phone === undefined || credential.user_id === undefined) {
          const info = await fetchRaccoonUserInfo(this.product, credential, this.fetchImpl)
          const patched: RaccoonCredential = {
            ...credential,
            ...info.phone !== undefined && credential.phone === undefined ? { phone: info.phone } : {},
            ...info.userId !== undefined && credential.user_id === undefined ? { user_id: info.userId } : {},
            ...info.nickname !== undefined && credential.nickname === undefined
              ? { nickname: info.nickname } : {},
            ...info.officeIdentity !== undefined && credential.office_identity === undefined
              ? { office_identity: info.officeIdentity } : {},
          }
          const changed = JSON.stringify(patched) !== JSON.stringify(credential)
          if (changed) {
            await this.ctx.credentials.set(ref, JSON.stringify(patched))
            next = patched
          }
        }

        const target = buildNickname(next, entry.id)
        // ⚠️ 只在**确实变化**时写账号池：否则每次启动都落盘一次
        //（`updateAccount` 是整体 replace，会触发一次文档写）。
        if (target !== entry.nickname) {
          await pool.updateAccount(entry.id, { nickname: target })
          repaired.push(entry.id)
        }
      } catch (error) {
        this.ctx.logger?.warn?.(
          `[raccoon] 修复账号 ${entry.id} 的昵称失败（不影响使用）：`
          + `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
    return repaired
  }
}

/**
 * 解析 `GET /model_catalog` 响应。
 *
 * 只取 `categories[].type === 'chat'` 的那个分类（实测只有一个），
 * 过滤 `visible === false`，并用 `raccoonDisplayName` 生成含倍率的展示名。
 */
export function parseRaccoonModelCatalog(payload: unknown): RaccoonRemoteModel[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return []
  const root = payload as Record<string, unknown>
  if (root.code !== 0) return []
  const data = typeof root.data === 'object' && root.data !== null && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : undefined
  if (data === undefined) return []

  const categories = Array.isArray(data.categories) ? data.categories : []
  const chat = categories.find((c) => {
    return typeof c === 'object' && c !== null && !Array.isArray(c)
      && (c as Record<string, unknown>).type === 'chat'
  })
  if (chat === undefined) return []

  const models = Array.isArray((chat as Record<string, unknown>).models)
    ? (chat as Record<string, unknown>).models as unknown[]
    : []

  const seen = new Set<string>()
  const out: RaccoonRemoteModel[] = []
  for (const raw of models) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const model = normalizeRemoteModel(raw as Record<string, unknown>)
    if (model === undefined || seen.has(model.id)) continue
    seen.add(model.id)
    out.push(model)
  }
  return out
}
