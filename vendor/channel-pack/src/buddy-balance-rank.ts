/**
 * CodeBuddy / WorkBuddy 账号按「积分何时作废」分档排序（负载均衡 + 永久积分锁定）。
 *
 * ## 它与 Loomy 那份（`loomy-balance-rank.ts`）的关系
 *
 * **同构但判据不同**，故刻意不共用实现：
 *
 * | | Loomy | 两个 buddy |
 * |---|---|---|
 * | 临时积分 | `dailyBalance` —— 服务端**直接给了一个字段** | 需要**自己算**：遍历资源包，取 `DeductionEndTime` 距今 **< 15 天** 的那几包余额之和 |
 * | 永久积分 | `balance`（注册奖励 + 新手任务，不过期） | 其余资源包（`DeductionEndTime` ≥ 15 天或未下发）的余额之和 |
 * | 到期节奏 | **当日**到期，明天重新发放 | **14 天 / 30 天 / 365 天**到期，没有「每天一笔」的概念 |
 *
 * ⚠️ 把两者压成一份代码需要把「什么叫临时」参数化成一个回调 —— 那会让本文件
 * 唯一有价值的东西（**15 天这条线是怎么来的**）从注释里消失，收益不抵损失。
 * 新增同族 provider 时优先扩本文件，不要再开第三份。
 *
 * ## 为什么用 `DeductionEndTime` 而不是 `CycleEndTime`（实测 2026-09-29）
 *
 * 两站真实账号的资源包形状：
 *
 * | 包 | `DeductionEndTime` 距今 | `CycleEndTime` 距今 | 归入 |
 * |---|---|---|---|
 * | WorkBuddy「Bonus Pack」 | 9 天 | 9 天 | **临时** |
 * | WorkBuddy「Free Plan Subscription」 | 3008 天 | **2 天** | **永久** |
 * | CodeBuddy「个人体验版」 | 3008 天 | 已过期 | 永久（本周期已无余额） |
 * | CodeBuddy「拉新权益包 / 国内运营裂变包」 | 17～208 天 | 同左 | ≥15 天者永久、<15 天者临时 |
 *
 * 套餐包的**计量周期**虽短（月度），但扣费截止在 8 年后 —— 取 `CycleEndTime`
 * 会把每月刷新的套餐判成「马上作废」，锁定永久积分就形同虚设。
 * 有效包的 `ExpiredTime` 一律是空串（它只在包真正失效后才回填），没有区分力。
 *
 * ## 策略（用户指定）
 *
 * | 档位 | 判据 | 含义 |
 * |---|---|---|
 * | 1 | `expiring > 0` | 有 **15 天内到期**的积分 —— 再不用就作废，优先消耗 |
 * | 2 | `permanent > 0` | 只剩「永久」积分（≥ 15 天后才到期） |
 * | 3 | 其余（含**查询失败**） | 无可用余额 |
 *
 * ⚠️ **档内保持传入顺序**（= 用户在 Channel Pack 拖拽的手动顺序），**不重排** ——
 * 与 `AccountPool.getAvailableAccount` 的既有语义一致。
 *
 * ⚠️ **查询失败归入最后一档**：宁可把请求发给能确认余额的号（与 Loomy 同规）。
 *
 * ⚠️ 本模块是**纯函数**，不碰网络与凭据 —— 余额由调用方查好后传入。
 */

import type { CreditBalance } from './buddy-credits.js'

/**
 * 「临时积分」的时间窗口：距扣费截止不足 **15 天**的积分算临时（会很快作废），
 * 其余算永久。用户 2026-09-29 定的判据。
 *
 * ⚠️ 这条线同时决定了**锁定永久积分**后哪些账号仍可用：只有 15 天内到期那部分
 * 积分可被消耗，故实测里「裂变包全部还有 17 天以上」的账号在锁定期间
 * **等同于无可用账号**（不是缺陷，正是该判据的直接推论）。
 */
export const BUDDY_EXPIRING_WINDOW_DAYS = 15

/** 由天数换算的毫秒窗口（导出供单测按同一口径构造时间戳）。 */
export const BUDDY_EXPIRING_WINDOW_MS = BUDDY_EXPIRING_WINDOW_DAYS * 24 * 60 * 60 * 1000

/**
 * 覆盖窗口的环境变量名。
 *
 * ## 为什么需要这道逃生门（实测 2026-09-29，真实账号）
 *
 * 15 天这条线在两站的效果**差别极大**：
 *
 * | 池 | 实测形状 | 锁定的后果 |
 * |---|---|---|
 * | WorkBuddy 5 个号 | Bonus Pack 250（8～9 天）+ Free Plan 100（3008 天） | 4 个号仍可用，1 个（Bonus Pack 已耗尽）不可用 —— 正是期望效果 |
 * | CodeBuddy 中国版 1 个号 | 裂变包共 10064.6，**距到期最少 17 天** | **立刻「无可用账号」**（17 天 > 15 天 ⇒ 全算永久） |
 *
 * 中国版的包是按 30 天发放的，所以"距到期"天然落在 17～30 天区间 ——
 * 判据本身没错，但这类池想用锁定就得把窗口放宽（如 `DSH_BUDDY_EXPIRING_WINDOW_DAYS=31`，
 * 让"本批包"整体算临时）。
 *
 * ⚠️ 窗口只能由**用户显式**改：默认值必须是用户定的 15 天。
 */
export const DSH_BUDDY_EXPIRING_WINDOW_DAYS = 'DSH_BUDDY_EXPIRING_WINDOW_DAYS'

/**
 * 当前生效的「临时积分」窗口（天）。
 *
 * ⚠️ **不能写成 `parseInt(raw) || 默认值`**：`0` 是合法值（表示「没有临时积分」，
 * 于是锁定期间整池不可用），而 `0` 是 falsy 会被 `||` 静默换成默认值 ——
 * 与 Qoder 排队超时那个坑同型。
 *
 * 非法值（空 / 非数字 / 负数）一律回落到默认窗口，不报错：这是展示与选号的
 * 辅助判据，配置写错不该让插件起不来。
 */
export function buddyExpiringWindowDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DSH_BUDDY_EXPIRING_WINDOW_DAYS]
  if (typeof raw !== 'string' || raw.trim().length === 0) return BUDDY_EXPIRING_WINDOW_DAYS
  const parsed = Number(raw.trim())
  if (!Number.isFinite(parsed) || parsed < 0) return BUDDY_EXPIRING_WINDOW_DAYS
  return parsed
}

/** 当前生效的窗口（毫秒）。 */
export function buddyExpiringWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  return buddyExpiringWindowDays(env) * 24 * 60 * 60 * 1000
}

/** 账号余额档位。数字越小越优先。 */
export const BUDDY_BALANCE_TIER = Object.freeze({
  /** 有 15 天内到期的积分 —— 优先消耗（再不用就作废）。 */
  expiring: 0,
  /** 只剩永久积分（≥ 15 天后到期）。 */
  permanent: 1,
  /** 无余额 / 查询失败。 */
  none: 2,
} as const)

export type BuddyBalanceTier = (typeof BUDDY_BALANCE_TIER)[keyof typeof BUDDY_BALANCE_TIER]

/** 两类余额的拆分结果。 */
export interface BuddyCreditSplit {
  /** 15 天内到期的积分合计（本计费周期口径）。 */
  expiring: number
  /** 其余积分合计（≥ 15 天后到期，或到期时间未知）。 */
  permanent: number
}

/** 参与分档的账号（两个字段缺失表示查询失败）。 */
export interface BuddyAccountBalance {
  id: string
  /** 15 天内到期的积分；`undefined` = 查询失败。 */
  expiringBalance?: number
  /** 永久积分；`undefined` = 查询失败。 */
  permanentBalance?: number
}

/**
 * 把一个账号的积分余额拆成「快到期」与「永久」两桶。
 *
 * ⚠️ **口径是 `remaining`（= `CycleCapacityRemain`，本计费周期剩余）**，与
 * CodeBuddy IDE 顶部的 Credits Balance 一致。用户选定该口径的理由：实测
 * CodeBuddy 体验版套餐的**终身**剩余是 500 而**本周期**剩余是 0 ——
 * 那 500 实际扣不到，算进可用余额会让账号「看起来有钱却用不了」。
 *
 * ⚠️ **`active === false` 的包一律跳过**：失效包的服务端仍会返回余额，
 * 并进任何一桶都会虚增可用额度（`fetchCreditBalance` 的 `total` 同理只算有效包）。
 *
 * ⚠️ **到期时间未知（`deductionEndTime` 缺失 / 非正数）归入永久桶**：
 * 宁可把它当作「不会马上作废」——这是**保守方向**，最坏结果是锁定时少用一个号，
 * 而不是误把长期积分当成快到期烧掉。
 *
 * @param balance - `fetchCreditBalance` 的结果；`null`（查询失败）返回 `undefined`。
 * @param now - 当前时刻（毫秒），注入以便单测断言边界。
 * @param windowMs - 窗口，默认 {@link BUDDY_EXPIRING_WINDOW_MS}。
 * @returns 两桶合计；`balance` 为 null/undefined 时返回 `undefined`（= 查询失败）。
 */
export function splitBuddyCreditsByExpiry(
  balance: CreditBalance | null | undefined,
  now: number = Date.now(),
  windowMs: number = BUDDY_EXPIRING_WINDOW_MS,
): BuddyCreditSplit | undefined {
  if (balance === null || balance === undefined) return undefined
  let expiring = 0
  let permanent = 0
  for (const pkg of balance.packages) {
    if (pkg.active !== true) continue
    const remaining = positiveOrZero(pkg.remaining)
    if (remaining <= 0) continue
    const endTime = pkg.deductionEndTime
    const known = typeof endTime === 'number' && Number.isFinite(endTime) && endTime > 0
    if (known && endTime - now < windowMs) expiring += remaining
    else permanent += remaining
  }
  return { expiring, permanent }
}

/** 分档选项。 */
export interface BuddyTierOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
  /** 当前时刻（毫秒），测试注入用。 */
  now?: number
  /** 窗口覆盖（测试用）。 */
  windowMs?: number
}

/**
 * 判定单个账号的档位。
 *
 * ⚠️ **`expiring > 0` 优先于 `permanent > 0`**：快到期不用就作废，永久积分短期
 * 内还在。故只要还有 15 天内到期的余额就一定先用它。
 *
 * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：永久积分不参与判定 ——
 * 只剩永久积分的账号直接落入 `none`（不可用），而不是降到 `permanent` 档。
 */
export function buddyBalanceTier(
  balance: { expiringBalance?: number; permanentBalance?: number },
  options: BuddyTierOptions = {},
): BuddyBalanceTier {
  if (positiveOrZero(balance.expiringBalance) > 0) return BUDDY_BALANCE_TIER.expiring
  if (options.allowPermanent === false) return BUDDY_BALANCE_TIER.none
  if (positiveOrZero(balance.permanentBalance) > 0) return BUDDY_BALANCE_TIER.permanent
  return BUDDY_BALANCE_TIER.none
}

/**
 * 该档位是否「可用」（可承载请求）。
 *
 * `none` 档不可用 —— 调用方据此判断「真的没有可用账号」并报明确错误。
 */
export function buddyTierUsable(tier: BuddyBalanceTier): boolean {
  return tier !== BUDDY_BALANCE_TIER.none
}

/** 把任意值归一化为安全正数；非法值（`NaN` / 负数 / `undefined`）归 0。 */
function positiveOrZero(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 按档位排序账号（**稳定排序**：档内保持传入顺序）。
 *
 * 与 `rankLoomyAccountsByBalance` 同款「装饰 - 排序 - 解装饰」写法：显式带
 * 原始下标可让「档内不重排」这一约定自明，且不受引擎实现影响。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项（`allowPermanent` = 是否允许消耗永久积分）。
 * @returns **新数组**（不修改入参）。
 */
export function rankBuddyAccountsByBalance<T extends BuddyAccountBalance>(
  accounts: readonly T[],
  options: BuddyTierOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: buddyBalanceTier(account, options) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}

/**
 * 把一次拆分结果格式化成一行摘要（供日志与账号卡片提示使用）。
 *
 * ⚠️ 两个桶都为 0 时返回「无可用积分」而不是「临时 0 / 永久 0」——
 * 用户读后者需要自己推断，前者一眼可见。
 */
export function describeBuddyCreditSplit(
  split: BuddyCreditSplit | undefined,
  windowDays: number = BUDDY_EXPIRING_WINDOW_DAYS,
): string {
  if (split === undefined) return '余额查询失败'
  const expiring = roundCreditsInline(split.expiring)
  const permanent = roundCreditsInline(split.permanent)
  if (expiring <= 0 && permanent <= 0) return '无可用积分'
  return `${windowDays} 天内到期 ${expiring} · 永久 ${permanent}`
}

/** 展示用规整：两位小数（服务端精确值带浮点尾数噪声）。 */
function roundCreditsInline(value: number): number {
  return Math.round(value * 100) / 100
}
