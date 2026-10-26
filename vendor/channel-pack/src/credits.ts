/** 各渠道共用的积分类型、单位与格式化工具。具体网络协议由各渠道注入。 */

/** 签到活动状态（字段名已转为 camelCase）。 */
export interface CheckinStatus {
  /** 活动是否进行中。false 时不应尝试领取 */
  active: boolean
  /** 今日是否已签到 —— 领取判定的权威依据 */
  todayCheckedIn: boolean
  /** 连续签到天数 */
  streakDays: number
  /** 每日可领积分 */
  dailyCredit: number
  /** 今日已领积分 */
  todayCredit: number
  /** 今日是否为连续奖励日 */
  isStreakDay: boolean
  /** 累计已领积分 */
  totalCredits: number
  /** 已签到日期列表（如 ["2026-09-14"]） */
  checkinDates: string[]
  /** 活动名（如「开学季」） */
  activityName: string

  themeName: string
  /** 活动结束时间 */
  endTime: string
  /**
   * 该账号**需要用户先去别处操作**才能参与签到（如未开通活动）。
   *
   * 与 {@link ClaimOutcome} 的同名字段同义 —— 见那里的详细说明。
   */
  actionRequired?: boolean
}

/**
 * 一次领取的结果。
 *
 * ## `actionRequired`：把「需要用户操作」变成**显式语义**，而不是藏在文案里
 *
 * **真实缺陷（用户报障，2026-09-26）**：用本插件经 GitHub 授权**新注册**的
 * Qoder 账号尚未在 Qoder 侧开通每日领取，一键签到只说「当前没有可领取的活动」，
 * 用户不知道该怎么办。后端其实已给出可操作文案，但汇总行只显示计数
 * 「N 个活动未开启」，**用户看不到那条提示**。
 *
 * 修法不仅是在 UI 里多显示一句 message —— 那会让「这条 inactive 需要用户操作」
 * 这一语义**只存在于中文文案里**，前端（纯 JS，无类型检查）只能靠
 * 「有没有 message」去猜。故补一个**显式可选字段**：
 *
 * - 置 `true` 时，调用方应在结果里**单独、醒目地**展示该 message
 *   （它是给用户的行动指引，混在计数行里会被读漏）；
 * - 不置或 `false` 时按普通 `inactive` 处理（如「今天活动暂未开始」）；
 * - **可选**字段，故另外五个 provider（与所有既有调用方）无需改动，
 *   与 `src/trae-credits.ts` 用 `ClaimOutcome & { … }` 追加字段的先例同型。
 *
 * ⚠️ 与 `checkin-all.js`/`channel-pack.js` 的约定：前端判 `actionRequired === true`
 * **而不是**判 message 是否非空、更不是判文案内容 —— 后者会随措辞变化而失效。
 *
 * ## ⚠️ `coversToday`：把「这次的结果算不算**今天这一轮**」变成显式语义
 *
 * **真实缺陷（2026-10-02 审查 PR !33 定位）**：`already-claimed` 这个 kind
 * **天然有歧义** —— 它只说明「服务端认为没有可领的了」，而「没有可领的」在某些
 * 渠道里**不等于**「今天这条已领」。典型是 Qoder：活动**每日 10:00（UTC+8）
 * 才刷新**（服务端原文：「每日 10:00（UTC+8）刷新，领取后 30 天有效」）。
 * 于是上午 9 点那次查询看到的是**昨天**那条 `CLAIMED`，返回
 * `already-claimed`；上层若拿它当「今天已处理」的凭证记档，当天 10 点刷新后
 * 就再也不会去领 —— **每天静默漏掉 100 积分**。
 *
 * 修法不靠给每个渠道配一张「刷新时刻表」（那必然漂移），而是让**产出方自己
 * 回答**「我这条结果覆盖的是不是今天这一轮」：
 * - `coversToday` 缺省视为 `true` ⇒ 绝大多数渠道（每日签到语义）一行不用改；
 * - 观察到的是「刷新前的那一轮」时置 `false`。
 * 于是记账方（`auto-checkin.ts` 的 `shouldMarkToday`）根本不需要知道任何渠道的
 * 日界细节，只要数「有几条能证明今天已被处理」。
 *
 * ⚠️ 判据只能由**看得见该渠道刷新语义的那一层**给出（当前是 `qoder-credits.ts`），
 * 不要在汇总层用猜测补 —— 那正是本缺陷的成因。
 */
export interface ClaimOutcomeCommon {
  /**
   * 本次结果是否**覆盖「今天」这一轮**（缺省 `true`）。
   *
   * 置 `false` 表示「看到的是刷新前/上一轮的痕迹」，据此**不得**认定今天
   * 已处理（见上方缺陷说明）。
   */
  coversToday?: boolean
}

export type ClaimOutcome =
  | (ClaimOutcomeCommon & {
      kind: 'claimed'
      credit: number
      streakDays: number
      isStreakDay: boolean
      delayedMessage?: string
      /**
       * ★ `credit` 的单位（2026-10-03 新增）。
       *
       * ⚠ **缺省按「积分」处理** ⇒ 其余 provider 行为逐字不变。
       *   ZCode 下发 `unit_type: "token"`（实测），1 亿 token 若按积分显示
       *   就是错的 ⇒ 它显式传 `unit: token`。
       *   展示侧用 `formatUnits(credit, unit)` / `unitLabel(unit)`。
       */
      unit?: 'token' | 'credit'
    })
  | (ClaimOutcomeCommon & { kind: 'already-claimed'; message: string })
  | (ClaimOutcomeCommon & { kind: 'inactive'; message: string; actionRequired?: boolean })
  | (ClaimOutcomeCommon & { kind: 'failed'; code: number; message: string })

/**
 * 积分资源包（`get-user-resource` 响应里 `Accounts[]` 的一项）。
 *
 * ## 一个账号为什么有多个包
 *
 * ## 两个 "Remain" 字段的口径差异（关键）
 *
 * 响应里同时有两个剩余值，**含义完全不同**：
 *
 * | 字段                     | 含义                     | 实测（体验版包） |
 * |--------------------------|--------------------------|------------------|
 * | `CapacityRemain`         | 该包的**终身**剩余       | 500              |
 * | `CycleCapacityRemain`    | 该包**本计费周期**剩余   | 0                |
 *
 * IDE 顶部的 "Credits Balance" 用的是**周期口径**（`CycleCapacityRemain`）：
 * 实测该账号终身口径求和为 655.67，而 IDE 显示 155.67 —— 差额 500 正是那个
 * 「终身还剩 500、但本周期已一分不剩」的体验版包。用错字段会让数字凭空多出
 * 一大截，且用户无从核对。
 */
export interface CreditPackage {

  name: string
  /** 额度单位（'credit' / 'credits'） */
  unit: string
  /** 本计费周期剩余额度（IDE 展示口径，精确值含小数） */
  remaining: number
  /** 本计费周期总额度（精确值） */
  total: number
  /** 本计费周期已用额度（精确值） */
  used: number
  /**
   * 该包是否仍然有效。
   *
   * 判定：服务端 `Status !== 3`（实测 3 = 已过期）且未过 `ExpiredTime`。
   * 失效包仍会出现在 `Accounts[]` 里（额度可能非 0），UI 需要能区分出来，
   * 否则用户会以为那些额度还能用。
   */
  active: boolean
  /** 计量周期开始时间（服务端本地时间字符串，可能为空） */
  cycleStartTime: string
  /** 计量周期结束时间（服务端本地时间字符串，可能为空） */
  cycleEndTime: string
  /** 该包自身的失效时间（可能为空 = 无固定失效时间） */
  expiredTime: string
  /**
   * 该包的**扣费截止时间**（毫秒时间戳；实测缺失或 0 = 服务端未下发）。
   *
   * ⚠️ **这才是「这批积分什么时候作废」的字段**，与 `expiredTime` 不是一回事：
   * 实测（2026-09-29，两站各取真实账号）有效包的 `ExpiredTime` **一律为空串**，
   * 它只在包**真正失效之后**由服务端回填（此时 `Status` 已变 3、余额已归零）；
   * 而 `DeductionEndTime` 在包还有效时就有值，且两站的实测分布差距极大：
   *
   * ⇒ 判「会不会近期作废」**只能用本字段**：套餐（订阅）包的周期虽短，
   * 扣费截止却在 8 年后，取 `CycleEndTime` 会把每月刷新的套餐误判成快作废。
   *
   * ⚠️ 可选字段：其余 provider 的余额解析器（loomy / qoder / trae / …）不产出它，
   * 依赖方必须把 `undefined` 当作「到期时间未知」而不是「已过期」。
   */
  deductionEndTime?: number
}

/** 账号的积分余额汇总。 */
export interface CreditBalance {
  /**
   * 当前可用总余额（各**有效**包的本周期剩余之和）。
   *
   * 这个口径与 IDE 顶部的 "Credits Balance" 一致，用户可直接核对。
   *
   * 刻意不用服务端的 `TotalDosage`：它是**终身口径**且取整（实测同一响应里
   * TotalDosage=655 而 IDE 显示 155.67），既口径不对又有截断误差。
   */
  total: number
  /** 各资源包明细（含已失效的，由 `active` 区分） */
  packages: CreditPackage[]
  /**
   * 已失效包里的剩余额度合计。
   *
   * 单独给出而不是并进 `total`：这些额度服务端仍会返回，但实际不可用于扣费。
   * UI 可以据此提示「另有 N 已失效」，既不误导也不丢信息。
   */
  expiredTotal: number
}

/**
 * 把额度规整为两位小数。
 *
 * 用 `Math.round(v * 100) / 100` 而不是 `toFixed` 后 parse：后者对
 * 负数与极大值的行为不一致，且返回字符串会污染数值类型。这里只处理
 * 服务端下发的正数额度，乘法取整足够且结果仍是 number。
 *
 * 导出供其它 provider 复用（`qoder-credits.ts`）：多包相加的浮点尾数噪声
 * 是所有 provider 的共同问题，各写一份必然分叉。
 */
export function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * 把单位串归一到**展示口径**，返回 `'token'` 或 `'credit'`。
 *
 * ## 为什么需要它（真实缺陷，2026-10-03）
 *
 * 根因不在「多账号没法合计」，而在**服务端把同一个单位拼成两种写法**（实测逐包
 * 原值）：账号 `…01CC739A` 的包是 `CapacityUnit: 'credit'`（Bonus Pack 241.78）
 * 与 `'credits'`（Free Plan Subscription 100），账号 `…297957E1` 的是 `'credits'`。
 * 客户端的折叠态按**原始字符串**分组 ⇒ `credit` 与 `credits` 各成一组 ⇒ 两个
 * 账号落进两个分组，各自渲染一次「积分」标签。
 *
 * ⚠️ 口径：**分组键必须与展示名同源**。凡是展示层会显示成「积分」的单位串，就必须
 * 落进同一个分组。故分组前一律走本函数，`token` 与积分**不互相折算**（分两组）。
 *
 * ⚠️ 与客户端 `plugin-src/client/credits-format.js` 的 `normalizeUnit`
 * **必须逐字等价**：宿主算套餐读数、客户端算余额分组，两边不一致就会出现
 * 「套餐按一个单位、余额按另一个单位」的自相矛盾。一致性由
 * `tests/unit/usage-badge-client.spec.ts` 逐项比对锁死。
 *
 * ⚠️ **不要用它改写 `CreditPackage.unit`**：那里要保留服务端原值（设置页的逐包
 * 明细、`badgePlanFor` 的包名匹配都依赖它）。归一化只发生在「当分组键/展示名用」
 * 的那一步。
 */
export function normalizeCreditUnit(unit: string): 'token' | 'credit' {
  return unit === 'token' ? 'token' : 'credit'
}

/** 领取额度的单位（与 {@link normalizeCreditUnit} 同域）。 */
export type ClaimUnit = 'token' | 'credit'

/**
 * 把任意值归一到 {@link ClaimUnit}（缺省 `credit`）。
 *
 * ⚠️ 存在的理由：`ClaimOutcome.unit` 是**可选**字段，且要面对 RPC 传来的
 * 未知值。直接用 `normalizeCreditUnit` 要求调用方先做 `typeof` 判断，
 * 每个消费点各写一遍必然漂移。
 */
export function claimUnitOf(unit: unknown): ClaimUnit {
  return normalizeCreditUnit(typeof unit === 'string' ? unit : '')
}

/**
 * ★ 额度数值的**单位感知渲染**（宿主侧，2026-10-04）。
 *
 * ## 为什么宿主也需要格式化（真实缺陷，用户报障）
 *
 * 用户报障原文：
 * > 插件的这个一键签到，Zcode 获得的是 token 数量，但是这里显示成获得积分。
 * > 正文「…ZCode（智谱）+100000000（共 +100000100）」
 * > 应当显示为「…ZCode（智谱）+100Mtoken（共 +100Mtoken, +100积分）」
 *
 * 根因不在某一处文案，而在**汇总把不同量纲加成了一个标量**：
 * `computeClaimSummary` 把 1 亿 token 与 100 积分相加得 `totalCredit`，
 * 单位信息在这一层就丢了；下游无论怎么写都只能标一个「积分」。
 * 故修法是**让单位一路传到渲染层**（`totalByUnit`），而不是在文案里猜。
 *
 * ⚠️ 自动签到的逐渠道文字（`auto-checkin.ts` 的 `describeChannel` /
 * `describeRun`）是**宿主侧产出、落盘后原样展示**的字符串，没有机会交给
 * 客户端格式化 —— 故宿主必须自带一份。这与 `normalizeCreditUnit` 的处境
 * 同因（客户端 bundle 不能 import 宿主代码），一致性由
 * `tests/unit/claim-unit-parity.spec.ts` 逐项锁死。
 *
 * ⚠️ **积分不压缩、token 才压缩**：积分余额的现实量级是 `123456.78`
 * （IDE 顶部就是这个精度），压成 `123.46K` 会让用户无法与官方界面核对；
 * 而 token 动辄上亿，不压缩根本读不出量级。这与客户端
 * `credits-format.js` 的 `formatCredits` / `formatTokens` 口径逐字一致。
 */

/** 积分：整数不带小数位，有小数才保留两位（与客户端 `formatCredits` 一致）。 */
export function formatCreditAmount(value: number): string {
  if (!Number.isFinite(value)) return '?'
  return Number.isInteger(value) ? String(value) : value.toFixed(2)
}

/** token：`>= 1e6` → `94.54M`；`>= 1e3` → `945.39K`；其余取整（与客户端 `formatTokens` 一致）。 */
export function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return '?'
  const abs = Math.abs(value)
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}K`
  return String(Math.round(value))
}

/** 单位的展示名（与客户端 `unitLabel` 一致）。 */
export function claimUnitLabel(unit: ClaimUnit): string {
  return unit === 'token' ? 'Token' : '积分'
}

/**
 * 一个「数值 + 单位」的完整读数，如 `100.00MToken` / `800积分`。
 *
 * ⚠️ **数值与单位之间不留空格**：这是本仓库既有的展示惯例（用量徽标里
 * ZCode 的余额就渲染成 `94.54MToken`，见 `badge-model.js` 的 `readingOf`），
 * 也与用户在本次报障里给出的期望文案 `+100Mtoken` 同形。
 */
export function formatUnitAmount(value: number, unit: ClaimUnit): string {
  const text = unit === 'token' ? formatTokenAmount(value) : formatCreditAmount(value)
  return `${text}${claimUnitLabel(unit)}`
}

/** 按单位分组的合计。**两个键恒存在**（无该单位的领取时为 0）。 */
export type ClaimTotalsByUnit = Record<ClaimUnit, number>

/**
 * 把按单位分组的**领取所得**拼成一段文案：`+100.00MToken, +100积分`。
 *
 * ⚠️ **每个单位各带一个 `+`**（不是整段共用一个）：这是用户报障时给出的
 * 期望文案的形态 —— 原文「应当显示为 `…ZCode（智谱）+100Mtoken
 * （共 +100Mtoken, +100积分）`」。整段共用会渲染成 `+100Mtoken, 100积分`，
 * 第二个单位看起来像「不是本次领到的」。
 *
 * ⚠️ 函数名带 **Gains**：`+` 是「本次获得」的语义，**不要**拿它渲染余额
 * （余额没有 `+`）。这是把 `+` 放进本函数而不是留给调用方拼的理由 ——
 * 一旦调用方各拼各的，两处界面就会漂移（本仓库已有多次先例）。
 *
 * ⚠️ **顺序固定 token → credit**（不是字母序）：用户给的期望文案就是
 * token 在前。顺序固定也让渲染稳定，不因对象键序变化而抖动。
 *
 * ⚠️ 只列**非零**单位：给「本次没有 token 领取」的渠道渲染 `+0Token` 是噪音。
 * 全为零时返回 `null`，调用方据此**整段不渲染**（而不是渲染一个空括号）。
 */
export function formatClaimGains(totals: Partial<ClaimTotalsByUnit> | undefined): string | null {
  if (totals === undefined || totals === null || typeof totals !== 'object') return null
  const parts: string[] = []
  for (const unit of ['token', 'credit'] as const) {
    const value = Number(totals[unit])
    if (!Number.isFinite(value) || value <= 0) continue
    parts.push(`+${formatUnitAmount(value, unit)}`)
  }
  return parts.length === 0 ? null : parts.join(', ')
}
