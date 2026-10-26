/**
 * **串行队列**：保证「同一时刻只有一个任务在跑」，其余排队。
 *
 * ## 为什么需要（对齐官方 ZCode 的护栏，2026-10-01）
 *
 * 官方闭源版 `app.asar` 的渲染层产物里，captcha 产出**被一个全局 promise 链
 * 串起来**（`out/renderer/assets/styles-*.js`，5.8MB）：
 *
 * ```js
 * let wnn = Promise.resolve()
 * async function jnn(e, t, n) {
 *   const r = wnn, i = …
 *   wnn = r.then(() => a)        // ← 接在上一个之后
 *   try { … await t() } finally { i() }
 * }
 * // 日志：`[captcha] zcode-plan verification queue slot acquired`
 * ```
 *
 * 也就是说：**官方每请求产一个 captcha，但严格串行**——同一刻只有一个在产。
 *
 * ## 我们缺它的后果（实测证据）
 *
 * `session-eced01ed` 里额度耗尽后连续 12 次失败、每次重试都重新 mint 一个
 * captcha（6 请求 × 2 turn）。而 DSH 会并发发请求（主回复 + 标题生成 + 压缩），
 * 每个都独立 mint —— 叠加阿里云的「**同设备每小时 150 次**」默认阈值
 *（官方文档 Q21 与自定义策略页确认），撞上限是**大概率**而非偶然。
 *
 * ## 与 `model-gate.ts` 的关系
 *
 * `ModelGate` 内部已经有一份同样的「尾巴指针」逻辑（用于上游发车间隔）。
 * 本类把它抽成**可复用的原语**，供 captcha 侧使用 —— 两处的语义相同
 * （先来先服务、失败也要放行下一个），但**互不阻塞**（上游请求排队时不该
 * 卡住 captcha 产出，反之亦然）。
 */

/** 中断时抛出的错误（调用方据类型识别，避免误当成业务失败）。 */
export class QueueAbortedError extends Error {
  constructor(message = '等待队列期间请求已取消') {
    super(message)
    this.name = 'QueueAbortedError'
  }
}

/** 队列统计（诊断用）。 */
export interface SerialQueueStats {
  /** 当前排队中的任务数（不含正在跑的）。 */
  pending: number
  /** 累计执行过的任务数。 */
  completed: number
}

/** 构造选项。 */
export interface SerialQueueOptions {
  /** 是否启用串行（false = 直接执行，用于一键回到引入前行为）。 */
  enabled?: boolean
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
}

/**
 * 先来先服务的串行队列（**公平**：按调用顺序，不是按完成顺序抢）。
 *
 * ⚠ **失败也必须放行下一个**：`run()` 的 `finally` 无条件释放尾巴。
 * 少了它，一个失败的任务会把整条队列**永久焊死** —— 这与本仓库
 * captcha 侧那次 `pageBusy` 死锁（`AGENTS.md` 记过）是同一类缺陷。
 */
export class SerialQueue {
  private readonly enabled: boolean
  private tail: Promise<void> = Promise.resolve()
  private pending = 0
  private completed = 0

  constructor(options: SerialQueueOptions = {}) {
    this.enabled = options.enabled ?? true
  }

  /** 队列统计。 */
  stats(): SerialQueueStats {
    return { pending: this.pending, completed: this.completed }
  }

  /**
   * 排到队尾并在轮到自己时执行 `task()`。
   *
   * @param task - 要串行执行的任务。
   * @param options.signal - 调用方中断信号；**等待期间**中断会抛
   *   {@link QueueAbortedError}（不执行任务）。
   */
  async run<T>(task: () => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    if (!this.enabled) return await task()

    this.pending += 1
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await this.awaitWithSignal(previous, options.signal)
      return await task()
    } finally {
      this.pending -= 1
      this.completed += 1
      release()
    }
  }

  /**
   * 等待前一个任务，但**响应当前调用方的中断**。
   *
   * ⚠ 不加这一层，前面某个 mint 挂住（例如浏览器僵死直到超时）会让**后面
   * 全部**一起干等 —— 而「等待期间的中断必须生效」正是本项目在流读取与
   * `ModelGate` 两处都踩过的同一类坑。
   */
  private async awaitWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await promise
      return
    }
    if (signal.aborted) throw new QueueAbortedError()
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new QueueAbortedError())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void promise.then(
        () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort)
          reject(error as Error)
        },
      )
    })
  }
}
