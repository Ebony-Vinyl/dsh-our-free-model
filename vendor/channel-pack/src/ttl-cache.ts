/**
 * 带 **TTL** 与**在飞去重**的小缓存。
 *
 * ## 为什么需要（对齐官方 ZCode，2026-10-01）
 *
 * 官方闭源版渲染层产物里的 `f3()`（`out/renderer/assets/styles-*.js`）：
 *
 * ```js
 * let u3 = null, d3 = null
 * async function f3(e) {
 *   const t = Date.now()
 *   if (u3 && u3.expiresAt > t) return u3.value      // ← 命中缓存
 *   if (d3) return d3                                // ← 在飞去重
 *   d3 = (async () => { … u3 = { value: n ?? null, expiresAt: t + 6e4 } … })()
 *         .finally(() => { d3 = null })
 *   return d3
 * }
 * ```
 *
 * 两个语义都对得上我们的需求：
 * - **TTL 60 秒**（`t + 6e4`）：captcha **配置**（region/prefix/sceneId）极少变，
 *   但也不该永久缓存 —— 服务端改动后要能自愈。
 * - **在飞去重**：并发请求只发一次底层调用。
 *
 * ## 与 `index.ts` 现有实现的关键差异（真实缺陷）
 *
 * 现状是 `zcodeCaptchaConfigPromise ??= (async () => …)()` —— 那是**永久缓存**：
 * 赋过一次就**再也不刷新**。后果是服务端换 `sceneId`／灰度切换后，进程必须
 * 重启才能跟上；而若第一次拉取恰好失败（网络抖动），`??=` 会把**失败结果**
 * 也一起记住（下面 `fetchZcodeCaptchaConfig` 失败返回 `undefined`，
 * 而调用方回退到兜底值 —— 那个兜底值同样会被永久固化）。
 */

/** 构造选项。 */
export interface TtlCacheOptions<T> {
  /** 缓存有效期（毫秒）。`ttlFor` 省略时，每个值都用它。 */
  ttlMs: number
  /** 真正的加载函数（**失败**应抛错；返回值可为 `undefined` 表示「无结果」）。 */
  load: () => Promise<T>
  /**
   * 按**结果**决定这一条自己的有效期（毫秒）；省略时一律用 `ttlMs`。
   *
   * ⚠️ 返回值非法（非有限数 / 负数）时**回落到 `ttlMs`**，不抛错也不当成 0：
   * 当成 0 会让这个缓存变成「永不命中」，把上游请求量悄悄放大一个数量级。
   */
  ttlFor?: (value: T) => number
  /** 取当前时刻（注入以便单测）。 */
  now?: () => number
}

/** 缓存项。`ttlMs` 是**写入时**按 `ttlFor` 定下的、这一条自己的有效期。 */
interface Entry<T> {
  value: T
  atMs: number
  ttlMs: number
}

/**
 * 单个值的 TTL 缓存 + 在飞去重。
 *
 * ⚠ **失败不缓存**：`load()` 抛错时清掉在飞标记并**向上抛** ——
 * 让调用方自己决定回退（例如 captcha 配置回退到兜底值），
 * 而**不要把失败固化**（那正是现状 `??=` 的缺陷）。
 */
export class TtlCache<T> {
  private entry: Entry<T> | undefined
  private inflight: Promise<T> | undefined
  private readonly ttlMs: number
  private readonly ttlFor: ((value: T) => number) | undefined
  private readonly load: () => Promise<T>
  private readonly now: () => number

  constructor(options: TtlCacheOptions<T>) {
    this.ttlMs = options.ttlMs
    this.ttlFor = options.ttlFor
    this.load = options.load
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * 取缓存值；过期则重新加载。
   *
   * @param options.force - 强制绕过缓存重新加载（用于「服务端拒绝后刷新配置」）。
   */
  async get(options: { force?: boolean } = {}): Promise<T> {
    if (options.force !== true) {
      const hit = this.peek()
      if (hit !== undefined) return hit.value
    }
    // 在飞去重：并发调用共用同一次 load（官方 `d3` 的同款语义）。
    if (this.inflight !== undefined) return await this.inflight

    const task = (async (): Promise<T> => {
      const value = await this.load()
      this.write(value)
      return value
    })()
    this.inflight = task
    try {
      return await task
    } finally {
      // ⚠ 无条件清在飞标记 —— 抛错时也要清，否则下一次永远复用一个已 rejected 的 promise。
      this.inflight = undefined
    }
  }

  /**
   * 只看缓存（**不触发加载**）。过期返回 `undefined` 并顺手丢弃。
   *
   * 诊断与单测用；`get()` 内部也走它，避免两处 TTL 判据漂移。
   */
  peek(): Entry<T> | undefined {
    const entry = this.entry
    if (entry === undefined) return undefined
    // ⚠ 用**这一条自己的** ttlMs（写入时由 `ttlFor` 定下），不是构造参数 ——
    // 否则「成功缓存久 / 失败缓存短」会在读取这一侧被构造参数覆盖掉。
    if (this.now() - entry.atMs >= entry.ttlMs) {
      this.entry = undefined
      return undefined
    }
    return entry
  }

  /** 写入一个已知值（例如从别处拿到的新配置，避免下一次白加载）。 */
  set(value: T): void {
    this.write(value)
  }

  /** 写入缓存项：有效期在**这一刻**定下（见 `TtlCacheOptions.ttlFor`）。 */
  private write(value: T): void {
    this.entry = { value, atMs: this.now(), ttlMs: this.effectiveTtl(value) }
  }

  /** 这一条该缓存多久；`ttlFor` 缺省或返回非法值时用构造参数。 */
  private effectiveTtl(value: T): number {
    if (this.ttlFor === undefined) return this.ttlMs
    const ttl = this.ttlFor(value)
    return Number.isFinite(ttl) && ttl >= 0 ? ttl : this.ttlMs
  }

  /** 清空（关停时调用）。 */
  clear(): void {
    this.entry = undefined
    this.inflight = undefined
  }
}
