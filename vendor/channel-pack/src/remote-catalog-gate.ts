/**
 * 远端模型目录的加载闸门：并发去重 + 失败冷却。
 *
 * ## 为什么需要它（实测，2026-10-01）
 *
 * DSH 宿主的 `buildModelCatalog` 会对**每个** provider `await listModels()`，
 * 再对**每个模型** `await resolveModelInfo()`。适配器里的 `resolveModel`
 * 同样会触发目录拉取，于是「目录没拿到」这件事会被放大成
 * **一次请求 × 每个模型**：
 *
 * - 拉取失败时原实现直接 `catch {}` 返回，`remoteModels` 保持 `undefined`
 *   ⇒ 下一次 `listModels` / `resolveModel` **再拉一次**；
 * - 返回空目录时同样不落缓存 ⇒ 同上。
 *
 * 另有并发维度：`listModels` 与 `resolveModel` 会被 DSH **并发**调用
 * （`Promise.all`），不去重会打出多份重复请求。
 * `src/cline-adapter.ts:243` 早先已单独处理过这一条，本模块把它抽成共用件。
 *
 * ## 三道语义
 *
 * 1. **命中缓存**：调用方自己判 `remoteModels !== undefined` 后直接返回，
 *    不进本闸门（保持既有「成功即永久缓存」的行为）。
 * 2. **并发去重**：同一次加载的多个调用共享同一个 Promise。
 * 3. **失败/空结果冷却**：`run` 返回 `false` 表示这次没拿到目录，
 *    在 `cooldownMs` 内不再重试。
 *
 * ⚠ 冷却只影响**拉取时机**，不影响兜底目录：调用方在冷却期间照旧回落到
 * 静态表，界面不会因此少模型。
 */

/** 失败 / 空结果后的默认冷却时长。 */
export const REMOTE_CATALOG_COOLDOWN_MS = 30_000

export interface RemoteCatalogGateOptions {
  /** 冷却毫秒数，默认 {@link REMOTE_CATALOG_COOLDOWN_MS}。 */
  cooldownMs?: number
  /** 时钟注入（测试用），默认 `Date.now`。 */
  now?: () => number
}

export class RemoteCatalogGate {
  private inFlight: Promise<boolean> | undefined
  private retryAt: number | undefined
  private readonly cooldownMs: number
  private readonly now: () => number

  constructor(options: RemoteCatalogGateOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? REMOTE_CATALOG_COOLDOWN_MS
    this.now = options.now ?? Date.now
  }

  /**
   * 是否处于「上次没拿到目录」的冷却窗口内。
   *
   * ⚠ `retryAt` 是用**墙钟**算的，系统时间被回拨时 `now() < retryAt` 会
   * 把冷却**拉长**（回拨一天就是事实上的永久卡死）。故这里只认「剩余量
   * 不超过一个冷却周期」的窗口 —— 回拨造成的超长窗口一律按已到期处理。
   */
  cooling(): boolean {
    if (this.retryAt === undefined) return false
    const now = this.now()
    return now < this.retryAt && this.retryAt - now <= this.cooldownMs
  }

  /**
   * 至多发起一次加载。
   *
   * - 冷却中：**不调用** `run`，直接返回。
   * - 已有在飞的加载：等它，不重复调用 `run`。
   * - 否则调用 `run`；返回 `false`（或抛错）即进入冷却。
   *
   * @param run 执行实际拉取，并在成功时自行落缓存；返回是否拿到了非空目录。
   */
  async run(run: () => Promise<boolean>): Promise<void> {
    if (this.inFlight !== undefined) {
      await this.inFlight
      return
    }
    if (this.cooling()) return
    // ⚠ **不能**写成 `this.inFlight = (async () => { … finally { this.inFlight = undefined } })()`：
    // 若 `run()` **同步抛错**，那个 IIFE 会在任何 `await` 之前整段同步跑完
    // （catch → finally 把 `inFlight` 置回 `undefined`），**然后**外层赋值又把
    // `undefined` 覆盖成一个**已 settle** 的 Promise。此后 `:73` 的
    // `inFlight !== undefined` 永远先命中 ⇒ 该 provider 永久不再重拉，
    // 冷却到期也救不回。
    // ⇒ 先把任务落成局部量、await 之后再清，并只清「仍是自己那一个」。
    const task = (async (): Promise<boolean> => {
      try {
        return await run()
      } catch {
        // 拉取自身抛错与「返回空目录」同等对待：都没拿到目录。
        return false
      }
    })()
    this.inFlight = task
    try {
      const got = await task
      this.retryAt = got ? undefined : this.now() + this.cooldownMs
    } finally {
      if (this.inFlight === task) this.inFlight = undefined
    }
  }

  /** 清掉冷却窗口（例如用户显式触发刷新）。 */
  reset(): void {
    this.retryAt = undefined
  }
}
