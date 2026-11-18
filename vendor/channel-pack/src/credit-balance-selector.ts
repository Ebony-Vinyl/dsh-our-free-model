/**
 * 积分余额缓存 + 临期分档选号器（TRAE / Qoder / Qodercn 三实例共用）。
 *
 * ## 它解决什么
 *
 * 选号若每次都实时查各账号余额，N 个账号就是 N 次网络往返；不查则回到
 * 「不看余额、烧错号」的现状。本模块以 **TTL 缓存** 摊平查询成本，把
 * `credit-routing-rank.ts` 的档位用于「从候选中挑一个」。
 *
 * ## 与 `loomy-balance-selector.ts` 的差异（刻意不共用）
 *
 * | | Loomy | 本模块 |
 * |---|---|---|
 * | 失败语义 | 锁定态下「查不到」要**报错**（区分 exhausted/unknown） | **失败开放**：查不到就 `pick` 返回 undefined，调用方退回现行为 |
 * | 判定输入 | 服务端两类余额字段 | `CreditBalance.packages`（含 deductionEndTime） |
 * | 阻断能力 | 有（永久积分锁） | **无** —— 只重排，不拦截任何请求 |
 *
 * 不阻断的理由：Loomy 的阻断根因是「今日额度耗尽后服务端**静默**继续扣
 * 永久积分」，不拦就烧钱；TRAE（4008）与 Qoder（110/额度 4xx）都会
 * **显式报错**，既有反应式换号（`modelRateLimits` + 适配器轮换）已经
 * 兜住了正确性。本调度是「别浪费临期积分」的优化层 —— 数据不确切时
 * **整体退回现行为**，最坏等于引入本调度之前的样子（与 token-saver
 * 管线同一「失败开放」原则）。
 *
 * ## 缓存（对齐 Loomy 的实测教训）
 *
 * - 成功 60s：同轮对话内多次选号几乎零重复开销；
 * - **失败只缓存 5s**：失败是瞬时状态，缓存满 60s 会让一次网络抖动
 *   伪装成「全部没分」整整一分钟（Loomy 的真实用户报障，见
 *   `loomy-balance-selector.ts` 的记录）；
 * - 按账号 id 存，账号增删不串味；停用/启用不经缓存（由 AccountPool
 *   的 enabled 过滤实时决定）。
 *
 * ## 并发
 *
 * `pick` 对候选 `Promise.all` 并发查询（账号数通常个位数）。余额是独立
 * 于签到的只读接口；签到路径的「逐号顺序防风控」约定（`trae-credits.ts`
 * 文件头）不被本模块触碰。
 */

import type { CreditBalance } from './credits.js'
import { creditExpiringWindowDays } from './credit-expiry-window.js'
import { creditTierOf, rankCreditAccounts, CREDIT_TIER, type CreditAccountSignal, type CreditTier } from './credit-routing-rank.js'

/** 余额缓存 TTL（毫秒），对齐 Loomy 实测选型。 */
export const CREDIT_BALANCE_CACHE_TTL_MS = 60_000

/** **失败**结果的缓存 TTL（毫秒）——比成功短一个数量级（见文件头）。 */
export const CREDIT_BALANCE_ERROR_CACHE_TTL_MS = 5_000

/** 一条待选账号（调用方从账号池取出，已按 enabled / 限流过滤）。 */
export interface CreditCandidateAccount {
  id: string
  credentialRef: string
}

/** 选中结果：账号 + 档位 + 余额（日志与诊断用）。 */
export interface CreditPickResult {
  account: CreditCandidateAccount
  tier: CreditTier
  balance: CreditBalance | undefined
}

/** 选号依赖（便于单测注入）。 */
export interface CreditSelectionDeps {
  /** 解析某账号的凭据；返回 undefined 或抛错都视为「该账号余额未知」。 */
  resolveCredential: (credentialRef: string) => Promise<unknown>
  /** 用凭据查一次余额；返回 null/undefined 或抛错 = 查询失败。 */
  fetchBalance: (credential: unknown) => Promise<CreditBalance | null | undefined>
  /** 当前时间（测试注入）。 */
  now?: () => number
  /** 临期窗口天数（测试注入；缺省读 `creditExpiringWindowDays()`）。 */
  windowDays?: number
  /** 成功 TTL 覆盖（测试注入）。 */
  ttlMs?: number
  /** 失败 TTL 覆盖（测试注入）。 */
  errorTtlMs?: number
}

/** 一个账号的缓存条目（value 为 undefined 表示上次查询失败）。 */
interface CacheEntry {
  at: number
  value: CreditBalance | undefined
}

/**
 * 余额缓存 + 分档选号器。
 *
 * 生命周期与宿主挂载一致（每 provider 一个实例），不共享全局状态、
 * 不跨 provider 串味。
 */
export class CreditBalanceSelector {
  private readonly cache = new Map<string, CacheEntry>()
  private readonly deps: CreditSelectionDeps

  constructor(deps: CreditSelectionDeps) {
    this.deps = deps
  }

  /** 清空缓存（单账号 or 全部；为手动刷新等将来接线留口）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /** 查一个账号的余额（带双 TTL 缓存）。查询失败返回 undefined，不抛错。 */
  async balanceOf(account: CreditCandidateAccount): Promise<CreditBalance | undefined> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cache.get(account.id)
    if (cached !== undefined) {
      // 成功与失败用不同 TTL —— 失败结论过期得快得多。
      const ttl = cached.value !== undefined
        ? (this.deps.ttlMs ?? CREDIT_BALANCE_CACHE_TTL_MS)
        : (this.deps.errorTtlMs ?? CREDIT_BALANCE_ERROR_CACHE_TTL_MS)
      if (now - cached.at < ttl) return cached.value
    }
    const value = await this.fetchBalance(account)
    this.cache.set(account.id, { at: now, value })
    return value
  }

  /** 真正解析凭据并查一次余额；任何一步失败都归为「未知」。 */
  private async fetchBalance(account: CreditCandidateAccount): Promise<CreditBalance | undefined> {
    let credential: unknown
    try {
      credential = await this.deps.resolveCredential(account.credentialRef)
    } catch {
      return undefined
    }
    if (credential === undefined || credential === null) return undefined
    try {
      return (await this.deps.fetchBalance(credential)) ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 从候选账号中按「临期优先」挑一个。
   *
   * - tier 0/1 的账号参与挑选，档内保持传入顺序（手动优先级）；
   * - **没有 tier<2 的候选时返回 undefined** —— 调用方据此退回既有
   *   选号路径（`getAvailableAccount` / 单凭据兜底），本选号器绝不
   *   报「没分」、绝不拦截请求；
   * - `excludeAccountIds` 与既有轮换约定一致：请求级换号时逐个排除
   *   已试账号，防 A/B 空转（`qoder-adapter.ts` 的实测注释）。
   */
  async pick(
    candidates: readonly CreditCandidateAccount[],
    excludeAccountIds?: ReadonlySet<string>,
  ): Promise<CreditPickResult | undefined> {
    const pool = excludeAccountIds === undefined
      ? candidates
      : candidates.filter(account => !excludeAccountIds.has(account.id))
    if (pool.length === 0) return undefined

    // 并发查余额：账号数通常个位数，并发比串行快得多（Loomy 同款）。
    const balances = await Promise.all(pool.map(account => this.balanceOf(account)))
    const signals: (CreditAccountSignal & { index: number })[] = pool.map((account, index) => ({
      id: account.id,
      index,
      balance: balances[index],
    }))
    // 窗口与当前时刻：测试可注入；缺省读环境约定（15 天，见
    // credit-expiry-window.ts），与余额展示的临期口径同源 —— 调度与
    // 展示用两个窗口会让「界面说临期、调度却不优先」自相矛盾。
    const windowDays = this.deps.windowDays ?? creditExpiringWindowDays()
    const now = this.deps.now?.() ?? Date.now()
    const ranked = rankCreditAccounts(signals, { windowDays, now })
    const best = ranked[0]
    if (best === undefined) return undefined
    const tier = creditTierOf(best, { windowDays, now })
    // zero / unknown 档不选出：调用方退回既有选号路径（失败开放）。
    if (tier === CREDIT_TIER.zero || tier === CREDIT_TIER.unknown) return undefined
    const index = (best as { index: number }).index
    return { account: pool[index]!, tier, balance: balances[index] }
  }
}
