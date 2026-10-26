/** 在凭据过期前提前这么长时间触发刷新（1 小时；对齐真实插件的 36e5）。 */
export const REFRESH_LEAD_MS = 3_600_000
/** 普通刷新失败后的重试间隔（10 分钟；对齐 RENEW_TOKEN_INTERVAL_WHEN_LAST_TIME_FAILED）。 */
export const REFRESH_RETRY_MS = 600_000
/** 异常网络（fetch failed 等）后的重试间隔（1 分钟；对齐 …_BY_ABNORMAL_NETWORK）。 */
export const REFRESH_ABNORMAL_NETWORK_RETRY_MS = 60_000

/** 判定是否为「异常网络」类错误（对齐真实插件的 isAbnormalNetwork）。 */
function isAbnormalNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /fetch failed|ENOTFOUND|ECONNREFUSED|proxy|unresolved host|getaddrinfo/i.test(message)
}

/**
 * 判定 refresh_token 是否已失效（终态：停止调度并提示重新登录）。
 */
function isRefreshTokenExpired(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (error.name === 'RefreshTokenExpiredError') return true
  return /refresh[_ ]?token/i.test(error.message)
}

/**
 * 计算首次刷新触发前的毫秒数（对齐真实插件 getFirstRefreshTime）：
 * - 无有效过期时间或距过期 ≤1h → 0（立即刷新）；
 * - 否则触发点 = now + 1h，再叠加 0-59 秒随机偏移。
 */
export function computeFirstRefreshDelayMs(expiresAtMs: number, nowMs = Date.now()): number {
  if (!Number.isFinite(expiresAtMs)) return 0
  const leadTrigger = nowMs + REFRESH_LEAD_MS
  if (leadTrigger >= expiresAtMs) return 0
  const trigger = new Date(leadTrigger)
  trigger.setSeconds(Math.floor(60 * Math.random()))
  const delay = trigger.getTime() - nowMs
  return delay > 0 ? delay : 0
}

/** 静默刷新调度器：一次触发 + 失败重试（失效则停止）。 */
export class RefreshScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private pending = false
  /** 调度代号：stop()/arm() 都会推进它，用于让在途 run() 放弃失败后的重试武装。 */
  private generation = 0

  constructor(
    private readonly refresh: () => Promise<void>,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** 为在 `expiresAtMs` 过期的凭据安排下次刷新；`nowMs` 仅供测试注入。 */
  arm(expiresAtMs: number, nowMs = Date.now()): void {
    // 先推进代号：使任何在途 run() 的失败路径放弃重试，并隔离旧定时器。
    this.generation++
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    const delay = computeFirstRefreshDelayMs(expiresAtMs, nowMs)
    this.timer = setTimeout(() => {
      void this.run()
    }, delay)
    this.timer.unref?.()
  }

  /** 取消任何待处理的刷新（并让在途 run() 失败后不再重试）。 */
  stop(): void {
    // 先推进代号：登出场景下取消在途刷新失败后的重试武装。
    this.generation++
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 立即执行一次刷新（供启动时已处于到期窗口内的凭据使用）。 */
  async refreshOnce(): Promise<void> {
    this.stop()
    await this.run()
  }

  private async run(): Promise<void> {
    if (this.pending) return
    this.pending = true
    const generation = this.generation
    try {
      await this.refresh()
    } catch (error) {
      this.onError(error)
      if (generation !== this.generation) {
        // 在途期间被 stop()/arm() 打断：放弃本次失败后的重试，避免登出后调度器复活。
        return
      }
      if (isRefreshTokenExpired(error)) {
        // refresh_token 已失效（终态）：停止调度，提示重新登录。
        return
      }
      // 在途期间可能已新 arm()（this.timer 已指向新定时器 T2）：先清除，避免覆盖后 T2 沦为孤儿定时器。
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
      }
      const retry = isAbnormalNetworkError(error) ? REFRESH_ABNORMAL_NETWORK_RETRY_MS : REFRESH_RETRY_MS
      this.timer = setTimeout(() => {
        void this.run()
      }, retry)
      this.timer.unref?.()
    } finally {
      this.pending = false
    }
  }
}
