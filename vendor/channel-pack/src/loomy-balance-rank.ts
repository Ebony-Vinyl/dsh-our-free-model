/**
 * Loomy 账号按余额分档排序（负载均衡策略）。
 *
 * ## 为什么需要它（真实缺陷）
 *
 * **实测 2026-09-26**：Loomy 的今日赠送额度（每天 5000）耗尽后，
 * 服务端会**继续扣永久积分且不报错** —— 「耗尽」不是错误，而是**静默降级**。
 *
 * 而本插件既有的「限流 → 换号」机制（`getAvailableAccount` 按
 * `modelRateLimits` 排除账号）只在服务端**返回限流错误**时触发。
 * Loomy 不返回这种错误，故该机制对它**完全无效**：
 * 会一直消耗同一个号，直到它彻底没分（用户报障）。
 *
 * ## 策略（用户指定）
 *
 * | 档位 | 判据 | 含义 |
 * |---|---|---|
 * | 1 | `dailyBalance > 0` | 有今日赠送额度（每天 5000，**优先用**） |
 * | 2 | `permanentBalance > 0` | 只剩永久积分 |
 * | 3 | 其余（含**查询失败**） | 无可用余额 |
 *
 * ⚠️ **档内保持传入顺序**（= 用户在 Channel Pack 拖拽的手动顺序），**不重排** ——
 * 与 `getAvailableAccount` 的既有语义一致（用户明确要求）。
 *
 * ⚠️ **查询失败归入最后一档**（用户明确要求，不是第一档）：
 * 宁可把请求发给能确认余额的号。
 *
 * ⚠️ 本模块是**纯函数**，不碰网络与凭据 —— 余额由调用方查好后传入。
 */

/** 账号余额档位。数字越小越优先。 */
export const LOOMY_BALANCE_TIER = Object.freeze({
  /** 有今日赠送额度（`dailyBalance > 0`）—— 优先消耗它（每天刷新、不用会浪费）。 */
  daily: 0,
  /** 只剩永久积分（`permanentBalance > 0`）。 */
  permanent: 1,
  /** 无余额 / 查询失败。 */
  none: 2,
} as const)

export type LoomyBalanceTier = (typeof LOOMY_BALANCE_TIER)[keyof typeof LOOMY_BALANCE_TIER]

/** 参与分档的账号（余额字段缺失表示查询失败）。 */
export interface LoomyAccountBalance {
  id: string
  /** 今日赠送额度余额；`undefined` = 查询失败。 */
  dailyBalance?: number
  /** 永久积分余额；`undefined` = 查询失败。 */
  permanentBalance?: number
}

/**
 * 分档选项。
 *
 * ## `allowPermanent`（锁定永久积分）
 *
 * 用户可把永久积分「锁住」，只允许消耗每日赠送额度。关闭时：
 *
 * - 有今日额度 → `daily` 档（照常可用）
 * - 其余（含**只剩永久积分**、查询失败）→ `none` 档
 *
 * ⚠️ **这不是「把 permanent 档降级」，而是「永久积分不参与选号」**：
 * 只剩永久积分的账号在锁定期间**等同于不可用**，这正是用户要的语义
 * （「锁定后没有临时积分后找可用账号就是没有可用账号」）。
 */
export interface LoomyTierOptions {
  /** 是否允许消耗永久积分。默认 `true`（解锁）。 */
  allowPermanent?: boolean
}

/**
 * 判定单个账号的档位。
 *
 * ⚠️ **`daily > 0` 优先于 `permanent > 0`**：今日额度每天刷新、不用会浪费，
 * 而永久积分不会过期。故只要今日还有余额就一定先用它。
 *
 * ⚠️ **锁定永久积分时（`allowPermanent: false`）**：永久积分不参与判定 ——
 * 只剩永久积分的账号直接落入 `none`（不可用），而不是降到 `permanent` 档。
 */
export function loomyBalanceTier(
  balance: {
    dailyBalance?: number
    permanentBalance?: number
  },
  options: LoomyTierOptions = {},
): LoomyBalanceTier {
  const daily = positiveNumber(balance.dailyBalance)
  if (daily > 0) return LOOMY_BALANCE_TIER.daily
  if (options.allowPermanent === false) return LOOMY_BALANCE_TIER.none
  const permanent = positiveNumber(balance.permanentBalance)
  if (permanent > 0) return LOOMY_BALANCE_TIER.permanent
  return LOOMY_BALANCE_TIER.none
}

/**
 * 该档位是否「可用」（可承载请求）。
 *
 * `none` 档不可用 —— 调用方据此判断「真的没有可用账号」并报明确错误。
 */
export function loomyTierUsable(tier: LoomyBalanceTier): boolean {
  return tier !== LOOMY_BALANCE_TIER.none
}

/**
 * 把余额归一化为安全正数；非法值（`NaN` / 负数 / `undefined`）归 0。
 *
 * ⚠️ 远端是外部输入：脏数据（`-1` / `NaN`）若直接参与比较，
 * `-1 > 0` 为假是对的，但 `NaN > 0` 也为假 —— 这里显式归一，
 * 让「查不到」与「真的为 0」在**排序**上等价（都进最后一档），
 * 但调用方可据 `undefined` 与 `0` 区分二者用于诊断。
 */
function positiveNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 按档位排序账号（**稳定排序**：档内保持传入顺序）。
 *
 * 用「装饰 - 排序 - 解装饰」而不是直接 `sort` 比较档位：`Array.prototype.sort`
 * 在 V8 里虽已稳定，但显式带原始下标可让意图自明、且不受引擎实现影响。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项（`allowPermanent` = 是否允许消耗永久积分）。
 * @returns **新数组**（不修改入参）。
 */
export function rankLoomyAccountsByBalance<T extends LoomyAccountBalance>(
  accounts: readonly T[],
  options: LoomyTierOptions = {},
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: loomyBalanceTier(account, options) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}
