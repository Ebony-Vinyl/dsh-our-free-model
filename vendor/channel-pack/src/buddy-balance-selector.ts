/**
 * CodeBuddy / WorkBuddy 账号余额缓存 + 按「积分何时作废」优先的选号。
 *
 * ## 它解决什么
 *
 * 两个 buddy 的账号池里，一个号常同时持有多种资源包（实测 WorkBuddy 每个号都有
 * 「Bonus Pack（14 天到期）」+「Free Plan Subscription（扣费截止 8 年后）」），
 * 而**服务端扣哪个包不由我们决定**。插件能做的是决定**用哪个号**：
 *
 * - 优先用「还有 15 天内到期积分」的号（那部分再不用就作废）；
 * - 只剩永久积分的号排最后；
 * - **锁定永久积分**时，只剩永久积分的号**等同于不可用**（与 Loomy 同语义）。
 *
 * 分档判据见 `buddy-balance-rank.ts`（为什么是 15 天、为什么用 `DeductionEndTime`）。
 *
 * ## 与 Loomy 那份（`loomy-balance-selector.ts`）的关系
 *
 * 同构：同样的 60 秒 TTL、同样的并发查余额、同样的「查询失败不抛错、归入最后
 * 一档」。差异只在余额的来源 —— Loomy 读服务端给的两个字段，这里读
 * `get-user-resource` 的包列表并按到期时间现算。
 *
 * ## 缓存**原料**、绝不冻结分类（本文件最重要的一条）
 *
 * 每次选号都实时查所有账号会显著变慢（N 个账号 = N 次网络往返，且该端点的响应
 * 实测可达数百 KB —— 一个账号可能有 105 个资源包）。故缓存 `get-user-resource`
 * 的原始 `CreditBalance`，TTL 60 秒。
 *
 * ⚠️ 但 TTL 的**唯一职责是抑制网络请求**，不能顺手把算好的两桶也缓存住：
 * 「临时 / 永久」是**当前时刻的函数**（`DeductionEndTime - now` 与 15 天比较），
 * 而宿主长期开着、时间只向前流 —— 一笔距到期 15.02 天的余额，在用户什么都不做的
 * 两分钟里就越过了线。若分类被缓存，选号会继续按「永久」处理一笔其实马上要作废的
 * 积分（锁定时更糟：本该可用的号被判成不可用）。所以 `balanceOf` 命中缓存也
 * **每次重新分桶**（窗口 env 也每次重读）。
 *
 * ℹ️ Loomy 那份（`loomy-balance-selector.ts`）缓存的是服务端给的**两个数字**，
 * 里面不含「按 now 现算」的成分，所以它没有这个问题 —— 不是漏改。
 */

import type { BuddyCredential } from './buddy.js'
import type { BuddyProduct } from './product.js'
import { fetchCreditBalance, type CreditBalance } from './credits.js'
import {
  buddyExpiringWindowDays,
  buddyBalanceTier,
  buddyTierUsable,
  rankBuddyAccountsByBalance,
  splitBuddyCreditsByExpiry,
  type BuddyAccountBalance,
  type BuddyBalanceTier,
  type BuddyCreditSplit,
  type BuddyTierOptions,
} from './buddy-balance-rank.js'

/** 余额缓存 TTL（毫秒），与 Loomy 同值。 */
export const BUDDY_BALANCE_CACHE_TTL_MS = 60_000

/**
 * **失败**结果的缓存 TTL（毫秒）—— 比成功短一个数量级。
 *
 * 与 Loomy 那份同一修复（用户报障 2026-09-29）：失败条目归入 `none` 档，
 * 锁定时被判「不可用」，于是**一次网络抖动**会让整池在 60 秒内全部不可用，
 * 用户被告知「额度已用尽」而实际号里都有钱。失败是瞬时状态，
 * 不该被当成一个持续一分钟的事实。
 */
export const BUDDY_BALANCE_ERROR_CACHE_TTL_MS = 5_000

/** 单个账号的余额（含查询失败标记）。 */
export interface BuddyAccountBalanceEntry extends BuddyAccountBalance {
  /** 查询是否成功；false 时两个余额字段均为 undefined。 */
  ok: boolean
  /** 查询失败原因（诊断用）。 */
  error?: string
  /** 分到的档位（查询后即刻算出，供日志与 UI 直接读取）。 */
  tier?: BuddyBalanceTier
  /** 原始拆分结果（展示「15 天内到期 X · 永久 Y」用）。 */
  split?: BuddyCreditSplit
}

/** 一条待选账号（调用方从账号池取出）。 */
export interface BuddyCandidateAccount {
  id: string
  credentialRef: string
}

/**
 * 锁定状态下「无可用账号」的原因。
 *
 * ⚠️ 两者**必须分开报**（与 Loomy 那份同一修复）：混成一句「额度都已用尽」
 * 会让一次网络抖动伪装成"钱花完了"，用户于是去解锁、或白等到明天 ——
 * 而号其实有钱。
 */
export type BuddyNoAccountReason =
  /** 所有候选都查到了余额，且可用那类积分确实都是 0。 */
  | { kind: 'exhausted' }
  /** 至少一个候选**查询失败**，无法判定它是否真的没额度。 */
  | { kind: 'unknown'; errors: string[] }

/** 选号结果：选中，或「为什么没选中」。 */
export type BuddySelectionResult
  = { ok: true; account: BuddyCandidateAccount; balance: BuddyAccountBalanceEntry }
  | { ok: false; reason: BuddyNoAccountReason }

/** 选号依赖（便于单测注入）。 */
export interface BuddySelectionDeps {
  product: BuddyProduct
  /** 解析某账号的凭据；返回 undefined 表示不可用。 */
  resolveCredential: (credentialRef: string) => Promise<BuddyCredential | undefined>
  /** 查询余额（默认真实的 `fetchCreditBalance`，单测注入桩）。 */
  fetchBalance?: (
    credential: BuddyCredential,
    product: BuddyProduct,
  ) => Promise<CreditBalance | null>
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 当前时间（测试用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  ttlMs?: number
  /** **失败**结果的 TTL 覆盖（测试用）。 */
  errorTtlMs?: number
  /** 「临时积分」窗口覆盖（测试用）。 */
  windowMs?: number
}

/**
 * 一次余额查询的**原料**（缓存这个，而不是缓存分类结果）。
 *
 * 之所以能整份留着 `CreditBalance` 复用：「临时 / 永久」只依赖
 * `packages[].remaining` / `active` / `deductionEndTime` 三个字段 + 当前时刻，
 * 而这三样都在这份原料里 —— 重算分类不需要再打网络。
 */
type BalanceSource =
  | { ok: true; balance: CreditBalance }
  | { ok: false; error: string }

/** 一个账号的缓存条目：`at` 是**网络请求时刻**（只用于 TTL），不含任何计算结果。 */
interface CacheEntry {
  at: number
  source: BalanceSource
}

/**
 * 余额缓存 + 选号器。
 *
 * 生命周期与 provider 的适配器注册一致（**CodeBuddy 与 WorkBuddy 各一个实例**），
 * 故不存在两站缓存互相串味的可能。
 */
export class BuddyBalanceSelector {
  private readonly cache = new Map<string, CacheEntry>()

  constructor(private readonly deps: BuddySelectionDeps) {}

  /** 清空缓存（凭据变化、手动刷新余额、领取积分后调用）。 */
  invalidate(accountId?: string): void {
    if (accountId === undefined) this.cache.clear()
    else this.cache.delete(accountId)
  }

  /**
   * 当前生效的「临时积分」窗口（毫秒）。
   *
   * ⚠️ **每次调用都重新解析环境变量**，不能缓存：窗口可被用户随时改，
   * 而提示文案与选号判据必须取同一个值 —— 缓存会让两者在不同时刻分裂。
   */
  private windowMs(): number {
    return this.deps.windowMs ?? buddyExpiringWindowDays() * 24 * 60 * 60 * 1000
  }

  /**
   * 查一个账号的余额分类（**缓存原料、每次现算**）。
   *
   * ⚠️ TTL 只用于抑制**网络请求**，绝不能拿来冻结分类：「临时 / 永久」是
   * **当前时刻的函数** —— 一笔距到期 15.2 天的余额，什么都没人操作，
   * 过 30 分钟就成了临时积分。所以这里缓存的是 `get-user-resource` 的原始
   * `CreditBalance`，命中缓存也重新分桶（并重新读一次窗口 env）。
   * 宿主是长期开着的，时间只会向前流动。
   *
   * ⚠️ **查询失败不抛错**：返回 `ok: false` 的条目，由分档逻辑归入最后一档 ——
   * 让「一个号查不到」不至于让整个选号失败（凭据过期是最常见的失败原因，
   * 此时应继续用别的号，而不是把错误抛给用户）。
   *
   * ⚠️ **失败结果的 TTL 短一个数量级**（与 Loomy 那份同一修复，见
   * `BUDDY_BALANCE_ERROR_CACHE_TTL_MS`）：把一次抖动缓存满 60 秒，会让
   * 「查不到」伪装成「额度用尽」整整一分钟。
   */
  async balanceOf(account: BuddyCandidateAccount): Promise<BuddyAccountBalanceEntry> {
    const now = this.deps.now?.() ?? Date.now()
    const cached = this.cache.get(account.id)
    if (cached !== undefined) {
      const ttl = cached.source.ok
        ? (this.deps.ttlMs ?? BUDDY_BALANCE_CACHE_TTL_MS)
        : (this.deps.errorTtlMs ?? BUDDY_BALANCE_ERROR_CACHE_TTL_MS)
      if (now - cached.at < ttl) {
        return this.classify(account.id, cached.source, now)
      }
    }

    const source = await this.fetchSource(account)
    this.cache.set(account.id, { at: now, source })
    return this.classify(account.id, source, now)
  }

  /**
   * 把原料按**当前时刻**分成两桶并定档。
   *
   * 单独成函数就是为了「原料只查一次、分类随时间重算」这件事结构上无法被绕过。
   */
  private classify(
    id: string,
    source: BalanceSource,
    now: number,
  ): BuddyAccountBalanceEntry {
    if (source.ok !== true) return failedEntry(id, source.error)
    const windowMs = this.windowMs()
    const split = splitBuddyCreditsByExpiry(source.balance, now, windowMs)
    if (split === undefined) return failedEntry(id, '余额响应无法解析出积分池')
    const entry: BuddyAccountBalanceEntry = {
      id,
      ok: true,
      expiringBalance: split.expiring,
      permanentBalance: split.permanent,
      split,
    }
    entry.tier = buddyBalanceTier(entry, { now, windowMs })
    return entry
  }

  /** 发一次请求取原料（不做任何分类）。 */
  private async fetchSource(account: BuddyCandidateAccount): Promise<BalanceSource> {
    let credential: BuddyCredential | undefined
    try {
      credential = await this.deps.resolveCredential(account.credentialRef)
    } catch (error) {
      return { ok: false, error: `读取凭据失败：${error instanceof Error ? error.message : String(error)}` }
    }
    if (credential === undefined) {
      return { ok: false, error: '凭据未配置或已失效' }
    }

    let balance: CreditBalance | null
    try {
      balance = await (this.deps.fetchBalance
        ?? ((cred, product) => fetchCreditBalance(cred, product, this.deps.fetcher ?? fetch)))(
        credential, this.deps.product,
      )
    } catch (error) {
      return { ok: false, error: `余额查询异常：${error instanceof Error ? error.message : String(error)}` }
    }
    if (balance === null) {
      return { ok: false, error: '余额查询失败（凭据失效或响应异常）' }
    }
    return { ok: true, balance }
  }

  /**
   * 从候选账号中按「快到期优先」选一个。
   *
   * 排序规则见 `rankBuddyAccountsByBalance`：
   * 有快到期积分 → 只剩永久 → 无余额/查不到。**档内保持传入顺序**（= 手动顺序）。
   *
   * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：只剩永久积分的账号落入
   * `none` 档（不可用）。若**全部候选都不可用**，返回 `ok: false` 并带上原因 ——
   * 调用方据此报明确错误，而不是硬着头皮消耗永久积分。
   *
   * ⚠️ **解锁时不改变既有行为**：所有候选余额都是 0 仍返回第一个候选，
   * 让上游去报真正的失败原因（凭据、限流、余额），错误信息更准确。
   *
   * @param candidates - 已按 `enabled` 与模型限流过滤过的候选（顺序即手动优先级）。
   * @param options - `allowPermanent` 为 false 时禁止消耗永久积分。
   */
  async select(
    candidates: readonly BuddyCandidateAccount[],
    options: BuddyTierOptions = {},
  ): Promise<BuddySelectionResult> {
    if (candidates.length === 0) {
      return { ok: false, reason: { kind: 'exhausted' } }
    }

    // 并发查余额：账号数通常个位数，并发比串行快得多。
    const balances = await Promise.all(candidates.map((c) => this.balanceOf(c)))
    const byId = new Map(candidates.map((c, i) => [c.id, { account: c, balance: balances[i]! }]))

    const ranked = rankBuddyAccountsByBalance(balances, options)
    const first = ranked[0]
    if (first === undefined) {
      return { ok: false, reason: noAccountReason(balances) }
    }

    // ⚠️ 排序只保证「可用的在前」，**不保证第一个可用** —— 未锁定时 none 档
    // 也参与排序（作为兜底），故只在锁定情况下才把「全部不可用」判成无可用账号。
    if (options.allowPermanent === false && !buddyTierUsable(buddyBalanceTier(first, options))) {
      return { ok: false, reason: noAccountReason(balances) }
    }

    const picked = byId.get(first.id)
    if (picked === undefined) return { ok: false, reason: { kind: 'exhausted' } }
    return { ok: true, account: picked.account, balance: picked.balance }
  }
}

/**
 * 判定「为什么没有可用账号」：区分**真的用尽**与**查不到**。
 *
 * 只要有任何一个候选是查询失败，就不能断言"额度都已用尽"—— 我们对它的余额
 * 其实一无所知。混报会让用户去解锁或白等一天，而号其实有钱。
 */
function noAccountReason(balances: readonly BuddyAccountBalanceEntry[]): BuddyNoAccountReason {
  const errors = balances.filter(b => !b.ok).map(b => b.error ?? '未知原因')
  return errors.length > 0 ? { kind: 'unknown', errors } : { kind: 'exhausted' }
}

/** 构造一个「查询失败」的余额条目。 */
function failedEntry(id: string, error: string): BuddyAccountBalanceEntry {
  return { id, ok: false, error }
}

/**
 * 选号 + 取凭据的完整编排（供 `src/index.ts` 的两个 buddy provider 调用）。
 *
 * ## 为什么需要这一层
 *
 * `select()` 只保证「档位最优」，**不保证那个账号的凭据能解析出来**。凭据损坏 /
 * 未配置时必须换下一个候选，否则一次抖动就会让请求失败。而循环放在池里做不了
 * （池不知道余额），放在适配器里又会让两个 provider 各写一遍 —— 故收敛成本函数。
 *
 * ⚠️ **锁定与未锁定的收尾不同**（这是本函数的全部复杂度来源）：
 * - 锁定：候选耗尽即 `kind: 'locked'`，调用方**必须报错**，绝不能退回
 *   `getAvailableAccount` —— 那会绕过锁定、照样消耗永久积分，使锁定形同虚设。
 * - 未锁定：候选耗尽（通常是凭据都坏了）时返回 `kind: 'exhausted'` 并带上
 *   `tried`，调用方据此把同一批账号传给 `getAvailableAccount` 的排除集合，
 *   从而**继续尝试池里的其余账号**（既有行为）。
 *
 * @param selector - 该 provider 专属的选号器（缓存不能跨站共用）。
 * @param candidates - 已按 `enabled` + 模型限流过滤的候选。
 * @param options - 锁定标志与凭据解析器。
 */
export async function pickBuddyAccount<TCredential = BuddyCredential>(
  selector: BuddyBalanceSelector,
  candidates: readonly BuddyCandidateAccount[],
  options: {
    /** 是否允许消耗永久积分（= 未锁定）。 */
    allowPermanent: boolean
    /** 按凭据 ref 取凭据；undefined 表示该账号不可用。 */
    resolveCredential: (credentialRef: string) => Promise<TCredential | undefined>
    /** 分档选项透传（测试注入时间用）。 */
    tierOptions?: BuddyTierOptions
  },
): Promise<
  | {
    kind: 'account'
    account: BuddyCandidateAccount
    balance: BuddyAccountBalanceEntry
    credential: TCredential
    /** 本次因为**凭据不可解析**而被跳过的账号（选中项不在其中）。 */
    tried: ReadonlySet<string>
  }
  | {
    kind: 'locked' | 'exhausted'
    tried: ReadonlySet<string>
    /**
     * 锁定判「无可用账号」的具体原因（`exhausted` 时没有这个信息可言）。
     * ⚠️ 调用方必须据它区分「真的用尽」与「查不到」再报错。
     */
    reason?: BuddyNoAccountReason
  }
> {
  const tried = new Set<string>()
  const allowPermanent = options.allowPermanent !== false
  let reason: BuddyNoAccountReason | undefined
  // 循环上界取候选数：每次迭代至少排除一个账号，故必然终止。
  for (let remaining = candidates; remaining.length > 0;) {
    const picked = await selector.select(
      remaining,
      { ...options.tierOptions, allowPermanent },
    )
    if (!picked.ok) {
      reason = picked.reason
      break
    }
    const credential = await options.resolveCredential(picked.account.credentialRef)
    if (credential !== undefined) {
      return { kind: 'account', account: picked.account, balance: picked.balance, credential, tried }
    }
    tried.add(picked.account.id)
    remaining = remaining.filter(c => c.id !== picked.account.id)
  }
  // 锁定时的「无可用账号」是**用户要的确定性结果**，与凭据无关；
  // 未锁定时的失败只可能是凭据问题，交给调用方继续走池的兜底。
  return { kind: allowPermanent ? 'exhausted' : 'locked', tried, ...reason ? { reason } : {} }
}
