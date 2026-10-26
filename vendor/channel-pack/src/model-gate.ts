/**
 * 上游请求**闸门**：串行化 + 按模型最小间隔。
 *
 * ## 吸收自哪里
 *
 * `dsh-free-glm/patches/zcodeBridgeServer.ts` 的 `runSerialized()`（L1404-1419）、
 * `waitModelGap()` / `markDispatch()`（L1389-1401）与 `MODEL_GAP_MS`（L1381-1384）。
 *
 * ## 为什么需要（那边的实测依据）
 *
 * ZCode 免费通道的 `429` 有**两种语义完全不同的**形态：
 *
 * ```json
 * {"code":3009,"msg":"model concurrency limit exceeded"}   ← 并发配额，等一下就能过
 * {"code":1005,"msg":"exceed quota limit"}                 ← 额度用尽，等到明天
 * ```
 *
 * 而**并发配额**与「还剩多少 token」无关（那边实测撞 429 时 token 还剩 299.4 万）。
 * 它按**模型**分别计量 —— 同一账号下：
 *
 * ```
 * GLM-5.3-Flash  605 次 200    0 次限流      ← 从未撞过
 * GLM-5.3         74 次 200   21 次重试     6 次最终 429
 * ```
 *
 * ⇒ 两条措施（缺一不可）：
 * 1. **串行闸门**：同一时刻只允许一个上游请求在飞（并发发起必然浪费一个配额）。
 * 2. **按模型的最小间隔**：串行只保证「不重叠」，**不保证有间隔** ——
 *    连续放行的两次调用可能只隔几十毫秒，仍会撞并发窗口。
 *
 * ## 与 `model-queue.ts` 的分工（别混淆）
 *
 * | 文件 | 管什么 | 触发者 |
 * |---|---|---|
 * | `model-queue.ts` | **服务端指定的**排队时长（`10605` 的 `retryAfterSeconds`） | 上游把请求**判为排队** |
 * | 本文件 | **客户端自保**的发车节流（并发与间隔） | 我们自己，防患于未然 |
 *
 * 两者互补：闸门降低撞 429 的概率，排队逻辑处理「已经撞上」的情况。
 *
 * ## ⚠ 闸门**只包 fetch**，不包 captcha
 *
 * 这是那边的一个真实教训（`sendUpstream()` 上方 ③）：第一版把 mint 与 fetch
 * 一起放进闸门，`mintMs` 从 200-500ms 暴涨到 **2500-3100ms** ——
 * 因为 mint 本身要几百毫秒到几秒，被串行后变成「排在 N 个人后面再 mint」。
 *
 * ⇒ captcha 产出**在闸门外**（可并发），只有**发往上游的那一下**进闸门。
 * 本类的 `run()` 因此只接受「一次 fetch」这样的短任务。
 */

import { setTimeout as sleepTimer } from 'node:timers/promises'

/** 闸门构造参数。 */
export interface ModelGateOptions {
  /**
   * 是否启用串行闸门。
   *
   * 关掉后 `run()` 直接执行任务 —— 保留这个开关是为了「能一键回到
   * 引入闸门之前的行为」（排障时用，避免怀疑是闸门本身导致的怪现象）。
   */
  serialize?: boolean
  /**
   * 按模型的最小发车间隔（毫秒）。键为**小写模型 id**。
   *
   * 未命中的键用 {@link ModelGateOptions.defaultGapMs}（默认 0 = 不额外等待）。
   */
  gaps?: Readonly<Record<string, number>>
  /** 未在 `gaps` 中列出的模型的最小间隔（默认 0）。 */
  defaultGapMs?: number
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
  /** 等待实现（注入以便单测毫秒级完成）。 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/** 中断时抛出的错误（调用方据 `name` 识别，避免误当成业务失败）。 */
export class GateAbortedError extends Error {
  constructor() {
    super('zcode: 等待上游闸门期间请求已取消')
    this.name = 'GateAbortedError'
  }
}

/**
 * 上游发车闸门（单实例 = 单 provider 全局）。
 *
 * 有状态：持有「对话尾巴」与「每模型上次发车时刻」。适配器持有一个实例即可，
 * **不要**每次请求新建（那样串行化与间隔都不会生效）。
 */
export class ModelGate {
  private readonly serialize: boolean
  private readonly gaps: Readonly<Record<string, number>>
  private readonly defaultGapMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>

  /** 串行闸门的尾巴：每个新任务接在上一个之后。 */
  private tail: Promise<void> = Promise.resolve()
  /** 排队深度（仅用于诊断）。 */
  private depth = 0
  /** 每个模型上次**发车**时刻。 */
  private readonly lastDispatchAt = new Map<string, number>()

  constructor(options: ModelGateOptions = {}) {
    this.serialize = options.serialize ?? true
    this.gaps = options.gaps ?? {}
    this.defaultGapMs = options.defaultGapMs ?? 0
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? defaultSleep
  }

  /** 当前排队中的任务数（诊断用）。 */
  queueDepth(): number {
    return this.depth
  }

  /**
   * 在闸门下执行 `task()`：**排到队尾 → 等够该模型的最小间隔 → 发车 → 执行**。
   *
   * @param modelKey - 节流键（模型 id；本方法内部会 `toLowerCase()`）。
   * @param task - 要执行的短任务（**只应是那一次 fetch**，见文件头注释）。
   * @param options.signal - 调用方中断信号；等待期间中断会抛 {@link GateAbortedError}。
   */
  async run<T>(
    modelKey: string,
    task: () => Promise<T>,
    options: { signal?: AbortSignal } = {},
  ): Promise<T> {
    if (!this.serialize) {
      await this.waitGap(modelKey, options.signal)
      this.markDispatch(modelKey)
      return await task()
    }

    const key = modelKey.toLowerCase()
    this.depth += 1
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })

    try {
      await this.awaitWithSignal(previous, options.signal)
      await this.waitGap(key, options.signal)
      this.markDispatch(key)
      return await task()
    } finally {
      this.depth -= 1
      release()
    }
  }

  /**
   * 等够这个模型的最小间隔。
   *
   * 语义是「距上次**发车**至少 `gapMs`」，而不是固定节拍 ——
   * 请求本身耗时 1-9 秒，固定节拍会与请求时长打架（那边的注释原话）。
   */
  private async waitGap(modelKey: string, signal?: AbortSignal): Promise<void> {
    const gap = this.gaps[modelKey] ?? this.defaultGapMs
    if (gap <= 0) return
    const last = this.lastDispatchAt.get(modelKey)
    if (last === undefined) return
    const wait = gap - (this.now() - last)
    if (wait <= 0) return
    await this.sleep(wait, signal)
  }

  /** 记下本次发车时刻（供下一次算间隔）。 */
  private markDispatch(modelKey: string): void {
    this.lastDispatchAt.set(modelKey, this.now())
  }

  /**
   * 等待一个已存在的 promise，但**响应该调用方的中断**。
   *
   * ⚠ 不加这一层，前面某个请求挂住（例如上游静默直到超时）会让后面
   * 所有请求一起卡在 `await previous` 上 —— 而「等待期间的中断必须生效」
   * 正是本项目在流读取那次踩过的同一类坑（见 `AGENTS.md` 的 zcode 章节）。
   */
  private async awaitWithSignal(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
    if (signal === undefined) {
      await promise
      return
    }
    if (signal.aborted) throw new GateAbortedError()
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new GateAbortedError())
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

/** 默认 sleep（可被 signal 中断）。 */
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  try {
    await sleepTimer(ms, undefined, signal === undefined ? {} : { signal })
  } catch (error) {
    // `timers/promises` 在中断时抛 AbortError —— 统一成本模块的错误类型，
    // 免得调用方要去分辨两种中断来源。
    if (signal?.aborted === true) throw new GateAbortedError()
    throw error as Error
  }
}
