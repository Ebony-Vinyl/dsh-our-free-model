/**
 * captcha 产出的**失败退避**（吸收自 `dsh-free-glm` 的 `noteMintFailure`）。
 *
 * ## 为什么必须有（真实缺陷，2026-10-01，来自会话实证）
 *
 * `session-eced01ed`（provider=`zcode`，我方插件）里，额度耗尽后有 **12 次**
 * 空响应失败（6 次请求 × 2 个 turn）——而**每一次重试都重新 mint 了一个 captcha**。
 * 也就是说：在额度已经用完、请求注定失败的情况下，我们白耗了 12 个 captcha 配额。
 *
 * 这有两个后果，第二个更严重：
 *
 * 1. **白等**：harness 的退避 491ms→1087ms→1907ms→3633ms→7256ms ≈ **14.4 秒**，
 *    而这 14.4 秒**不可能成功**（额度当天不会恢复）。
 * 2. ★ **加速信誉恶化**：阿里云 captcha 有**设备信誉**概念，失败会扣信誉。
 *    同一分钟里另一个 session（`session-b0e4eb3f`，provider=`zcode-bridge`）
 *    报的是 `502 Failed to mint auth material` —— 两个插件在同一台设备上
 *    互相抢同一份信誉（证据：两个 session 时间戳相差约 1 分钟）。
 *
 * ## 那边的做法与实测依据
 *
 * `dsh-free-glm/patches/zcodeBridgeServer.ts` 的 `noteMintFailure()` /
 * `mintBackoffRemainingMs()`（L1310-1355）：连续失败达阈值后进入**指数冷却**，
 * 期间**直接返回 503 + `Retry-After`**，而不是继续发起 mint。
 * 那边的注释原话：**「继续请求不会让信誉恢复，只会更糟」**。
 *
 * ## 本实现的两个关键设计
 *
 * ### 1. 阈值 3 次，冷却 1 分钟起步、翻倍、上限 30 分钟
 *
 * 沿用那边的取值（它是在**同一个上游**上实测出来的）。
 *
 * ### 2. 只对「**产出失败**」计数，不对「上游拒绝 param」计数
 *
 * 这是与那边的一个**有意差异**：`mintOnPage` 抛错（SDK `F001` / 超时 /
 * 降级产物）说明**本机产出能力**出了问题，继续试只会更糟 → 计数。
 * 而「mint 成功但上游回 `3007`」说明 param 本身可能没问题（也可能真有问题），
 * 归因不清 → **不计数**（避免把服务端的临时抖动记成我们的信誉问题）。
 *
 * ## 与预取池的关系
 *
 * ⚠ 退避期间**预取也要停**：`zcode-auth.ts` 的 `mintCaptcha` 会在
 * 退避中直接抛错，池的 `prefetch()` 捕获后只记日志 —— 也就是自然不产。
 * 这一点由「池的 mint 回调走同一个 `mintCaptcha`」保证，不需要池自己判断。
 */

/** 退避配置。 */
export interface CaptchaBackoffOptions {
  /** 连续失败多少次后进入冷却（默认 3，沿用那边的实测值）。 */
  threshold?: number
  /** 首次冷却时长（毫秒，默认 60_000）。 */
  baseMs?: number
  /** 冷却上限（毫秒，默认 30 分钟）—— 防止无上限增长到「永久不可用」。 */
  maxMs?: number
  /** 是否启用（默认 true；关闭后行为与引入前逐字一致）。 */
  enabled?: boolean
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
}

/**
 * captcha 产出失败计数器与冷却闸门。
 *
 * 有状态：每个 provider 实例持有一个即可（captcha 的产出能力是**设备级**的，
 * 与账号、模型都无关）。
 */
export class CaptchaBackoff {
  private readonly threshold: number
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly enabled: boolean
  private readonly now: () => number

  /** 连续失败次数（成功即清零）。 */
  private streak = 0
  /** 冷却截止时刻（毫秒；0 = 不在冷却中）。 */
  private untilMs = 0

  constructor(options: CaptchaBackoffOptions = {}) {
    this.threshold = options.threshold ?? 3
    this.baseMs = options.baseMs ?? 60_000
    this.maxMs = options.maxMs ?? 30 * 60_000
    this.enabled = options.enabled ?? true
    this.now = options.now ?? (() => Date.now())
  }

  /** 当前连续失败次数（诊断用）。 */
  failureStreak(): number {
    return this.streak
  }

  /**
   * 还要冷却多久（毫秒）。`0` = 不在冷却中，可以正常发起。
   *
   * ⚠ 到点后**自动清零冷却**（但**不**清 `streak` —— 连续失败次数要保留，
   * 否则一次到点就会让退避重新从 1 分钟起步，达不到「指数」的效果）。
   */
  remainingMs(): number {
    if (!this.enabled) return 0
    const remain = this.untilMs - this.now()
    if (remain <= 0) {
      this.untilMs = 0
      return 0
    }
    return remain
  }

  /** 记一次**产出成功**（清零连续失败与冷却）。 */
  noteSuccess(): void {
    this.streak = 0
    this.untilMs = 0
  }

  /**
   * 记一次**产出失败**；返回本次进入/延长的冷却截止时刻
   * （`0` = 还没到阈值，不需冷却）。
   */
  noteFailure(): number {
    if (!this.enabled) return 0
    this.streak += 1
    if (this.streak < this.threshold) return 0
    /**
     * 指数增长：阈值那次是 `baseMs`，之后每多失败一次翻倍，直到上限。
     *
     * ⚠ 用 `streak - threshold` 而不是 `streak`：否则第 3 次失败就会
     * 直接等到 `base × 8`,首次冷却反而最久（与「起步 1 分钟」的语义相反）。
     */
    const steps = this.streak - this.threshold
    const cooldown = Math.min(this.baseMs * 2 ** steps, this.maxMs)
    this.untilMs = this.now() + cooldown
    return this.untilMs
  }

  /** 清空状态（关停或用户手动重置）。 */
  reset(): void {
    this.streak = 0
    this.untilMs = 0
  }
}

/**
 * 从环境变量解析退避配置（生产入口用；单测直接构造 {@link CaptchaBackoff}）。
 *
 * ⚠ 与 `captchaPoolConfigFromEnv` 同款约定：**只认显式 `0` 为关闭**，
 * 空串/未设置 = 用默认值（而不是「假值即关闭」）。
 */
export function captchaBackoffConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CaptchaBackoffOptions {
  const rawSwitch = env['DSH_ZCODE_CAPTCHA_BACKOFF']
  const enabled = rawSwitch === undefined || rawSwitch.trim().length === 0
    ? true
    : rawSwitch.trim() !== '0'
  return { enabled }
}

/**
 * captcha **产出串行队列**是否启用（对齐官方的全局队列）。
 *
 * ⚠ 与同仓库其它开关一致：**只认显式 `0` 为关闭**。
 * **默认启用** —— 官方就是这么做的（`jnn`/`wnn` 的全局 promise 链），
 * 而并发产出会白耗阿里云的「同设备每小时 150 次」额度。
 */
export function captchaQueueEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['DSH_ZCODE_CAPTCHA_QUEUE']
  return raw === undefined || raw.trim().length === 0 ? true : raw.trim() !== '0'
}

/**
 * captcha **配置缓存**的 TTL（毫秒）。默认 60 秒 —— **取官方同值**
 *（官方 `f3()` 里是 `expiresAt: t + 6e4`）。
 */
export const CAPTCHA_CONFIG_TTL_MS = 60_000
