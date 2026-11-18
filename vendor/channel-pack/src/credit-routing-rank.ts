/**
 * 积分路由分档：按「临期优先」对账号余额判档的**纯函数**。
 *
 * ## 它解决什么
 *
 * TRAE（每月登录赠送 500 与签到包，条目级 `expire_time`）与 Qoder（领取
 * 积分「30 天有效」）的积分**到期即焚**。而账号池的既有选号
 * （`AccountPool.getAvailableAccount`）只看 `enabled` 与 `modelRateLimits`，
 * 完全不看余额 —— 「A 号的 150 分明天作废、B 号的月底才作废」时仍按手动
 * 顺序先烧 B，临期积分在沉默中浪费。
 *
 * 本模块在选号**之前**按余额分档，把消耗导向「即将作废」的账号。
 *
 * ## 与 `loomy-balance-rank.ts` 的关系
 *
 * 结构同源（装饰-排序-解装饰的稳定排序），但判据不同，刻意不共用实现：
 *
 * - Loomy 分档依据是**两类余额**（今日赠送 / 永久），档位是负载均衡语义；
 * - 本处分档依据是**到期时间**（临期 / 常规），档位是「避免作废」语义；
 * - 两者的共同点只有「档内保持传入顺序 = 用户手动拖拽顺序」与「查询失败
 *   单独成档、绝不与归零混淆」。把两套判据塞进一个函数会让每次修改都
 *   伤到另一家（`modelRateLimits` 注释里的同款理由）。
 *
 * ## 档位表（数字越小越优先）
 *
 * | 档 | 判据 | 语义 |
 * |---|---|---|
 * | expiring (0) | 存在有效包 `remaining>0` 且 `deductionEndTime ≤ now+窗` | 先用，避免作废 |
 * | usable (1) | 有效包 remaining 合计 > 0，无临期包 | 正常候选 |
 * | zero (2) | 查询**成功**且全部有效包归零 | 排最后 |
 * | unknown (3) | 查询失败 / 凭据读不出 | 排最后；**绝不**当作 0 积分判定 |
 *
 * ## 边界判据
 *
 * - `deductionEndTime` **缺失** = 到期时间未知 → 不算临期（不是「永久」，
 *   是「不知道」；Qoder 套餐额度就是这个形态）。宁可漏掉一次「先烧临期」
 *   的机会，也不把未知当已知。
 * - 已过期（`deductionEndTime < now`）但仍有 remaining 的包**算临期**：
 *   服务端可能尚未清零，烧掉是唯一回收方式。
 * - `active === false` 的包不参与任何判定（失效包里的剩余额度不可用于
 *   扣费，`credits.ts` 的既有口径）。
 * - 顶层 `total` 不作判据：以**逐包**明细为准，防止服务端口径漂移
 *   （`credits.ts` 注释已记录 total 截断误差的实测）。
 *
 * 本模块是纯函数，不碰网络与凭据 —— 余额由调用方查好后传入。
 */

import type { CreditBalance } from './credits.js'

/** 账号积分档位。数字越小越优先。 */
export const CREDIT_TIER = Object.freeze({
  /** 有即将作废的有效积分 —— 优先消耗（本调度的核心价值）。 */
  expiring: 0,
  /** 有常规积分（到期未知或在窗外）。 */
  usable: 1,
  /** 查询成功且余额归零。 */
  zero: 2,
  /** 查询失败 / 余额未知 —— 与归零严格区分。 */
  unknown: 3,
} as const)

export type CreditTier = (typeof CREDIT_TIER)[keyof typeof CREDIT_TIER]

/** 参与分档的账号（`balance` 缺失表示查询失败）。 */
export interface CreditAccountSignal {
  id: string
  /** 余额；`undefined` = 查询失败（不是归零）。 */
  balance?: CreditBalance
}

/** 分档选项。 */
export interface CreditTierOptions {
  /** 临期窗口（天）；来自 `creditExpiringWindowDays()`，测试可注入。 */
  windowDays: number
  /** 当前时刻（毫秒），测试注入。 */
  now: number
}

/** 一天的毫秒数。 */
const DAY_MS = 86_400_000

/**
 * 把包剩余归一化为安全非负数；非法值（`NaN` / 负数 / `undefined`）归 0。
 *
 * 远端是外部输入：`NaN` 直接参与比较恒为 false，会绕过 `> 0` 判定，
 * 显式归 0 让「脏数据」与「真的为 0」在档位上等价（`loomy-balance-rank.ts`
 * 的同款防御）。
 */
function nonNegative(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/**
 * 判定单个账号的积分档位。
 *
 * ⚠️ **判据只看 `packages` 明细，不看顶层 `total`**：逐包判能天然剔除
 * 失效包并感知到期时间，total 做不到。
 */
export function creditTierOf(signal: CreditAccountSignal, options: CreditTierOptions): CreditTier {
  const balance = signal.balance
  if (balance === undefined) return CREDIT_TIER.unknown
  // 只看有效包；失效包（active === false）的剩余不可用于扣费。
  const packages = Array.isArray(balance.packages) ? balance.packages.filter(p => p.active) : []
  let hasRemaining = false
  for (const item of packages) {
    const remaining = nonNegative(item.remaining)
    if (remaining <= 0) continue
    hasRemaining = true
    const end = item.deductionEndTime
    // deductionEndTime 缺失 = 到期未知，不算临期（见文件头边界判据）。
    if (typeof end === 'number' && Number.isFinite(end) && end <= options.now + options.windowDays * DAY_MS) {
      return CREDIT_TIER.expiring
    }
  }
  return hasRemaining ? CREDIT_TIER.usable : CREDIT_TIER.zero
}

/**
 * 按档位排序账号（**稳定排序**：档内保持传入顺序 = 手动拖拽顺序）。
 *
 * 装饰-排序-解装饰而非直接 `sort` 比较档位：显式带原始下标让意图自明、
 * 不受引擎实现影响（与 `rankLoomyAccountsByBalance` 同款）。
 *
 * @param accounts - 待排序账号（顺序即手动优先级）。
 * @param options - 分档选项。
 * @returns **新数组**（不修改入参）。
 */
export function rankCreditAccounts<T extends CreditAccountSignal>(
  accounts: readonly T[],
  options: CreditTierOptions,
): T[] {
  return accounts
    .map((account, index) => ({ account, index, tier: creditTierOf(account, options) }))
    .sort((a, b) => (a.tier - b.tier) || (a.index - b.index))
    .map((entry) => entry.account)
}
