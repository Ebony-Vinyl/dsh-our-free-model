/**
 * captcha param 的**预取池**。
 *
 * ## 吸收自哪里
 *
 * `dsh-free-glm/patches/zcodeBridgeServer.ts` 的 `captchaPool` / `prefetchCaptcha()`
 * / `takePooledCaptcha()`（该文件 L957-1042）。它的实测数据与结论：
 *
 * | 生成后经过 | 使用结果 |
 * |---|---|
 * | 0 / 10 / 30 / 60 秒 | ✅ 可用 |
 * | 120 秒 | ❌ 3007 |
 *
 * ⇒ **有效期在 60-120 秒之间**；「一次性」只指「用一次就作废」，
 * **不指「必须立刻用」**。故可以提前产好、放在池里等下一次请求。
 *
 * ## 为什么值得做（本项目的具体收益）
 *
 * `zcode-captcha.ts` 当时的实测成本：页面空闲 < 8 秒时复用约 **0.5 秒**，
 * 空闲更久（当时记录为「实测 15 秒必 `F001`」）要**新建页面约 3.7 秒**。
 * ⚠ 括号里那条**已被 2026-10-01 的变量分离复测推翻**（`F001` 与空闲时长没有稳定
 * 因果，见 `zcode-captcha.ts` 的 `mint()` 第 2 节），现行策略是「复用优先、失败才换页」
 * ⇒ 常态下现产约 0.4–0.5 秒，本池的相对收益比当初估计的小（池默认仍关闭）。
 *
 * 而 agent 多步循环里两次请求的间隔通常**大于 8 秒**（模型思考 + 工具执行），
 * 也就是说现产路径几乎每步都付 3.7 秒。预取把这段成本从**关键路径**挪到
 * **后台**：上一轮请求结束时就开始产下一个 param，下一轮到达时已在池里。
 *
 * ## ⚠ 与「材料复用」的区别（别混淆，两者语义相反）
 *
 * - **不可以**缓存/复用**已经用过**的 param —— 在索要验证的窗口里上游会回 `3007`
 *   （历史上它确实这样拒过；「某些窗口不校验这个头」不等于「复用旧 param 安全」，
 *   故 `take()` 取走即从池中移除，绝不放回）。
 * - **可以**预产**尚未使用**的 param 并短暂保存 —— 这正是本池做的事。
 *
 * ## TTL 取 30 秒的理由（比 dsh-free-glm 的 45 秒更保守）
 *
 * 那边实测「60 秒仍有效」。本项目**没有**复测过这个窗口，而两个实现的
 * captcha 产出路径不同（它走壳内 renderer，本项目走普通 Chromium CDP）。
 * 取 30 秒 = 双倍余量；宁可偶尔多产一次（约 0.5-3.7 秒，且发生在后台），
 * 也不要让用户吃到 `3007`（那是一次可见的失败）。
 * 实测下来若确认无 3007，可用 `DSH_ZCODE_CAPTCHA_POOL_TTL_MS` 放宽。
 *
 * ## 关闭方式
 *
 * `DSH_ZCODE_CAPTCHA_POOL=0` → `take()` 退化为「每次都现产」，
 * 行为与引入本池之前**逐字一致**（关掉不是另一套逻辑，而是同一条路径）。
 */

/** `take()` / `prefetch()` 需要的依赖（全部可注入，便于单测零网络零额度）。 */
export interface CaptchaPoolOptions {
  /**
   * 真正的产出函数（生产环境由 `ZcodeAuth.mintCaptcha` 提供）。
   *
   * ⚠ 它必须**每次都产新的** param —— 池不负责去重，复用由上游拒绝。
   */
  mint: (options?: { signal?: AbortSignal }) => Promise<string>
  /** 池内 param 的最长存放时间（毫秒）。 */
  ttlMs?: number
  /** 是否启用预取（false 时 `take()` 直接现产、`prefetch()` 是空操作）。 */
  enabled?: boolean
  /** 取当前时刻（注入以便单测控制 TTL 边界）。 */
  now?: () => number
  /** 预取失败的告警出口（预取失败**不影响**主流程，故只记日志）。 */
  onWarn?: (message: string) => void
  /**
   * 可选的合法性校验（生产环境传 `validateCaptchaParam` 的 ok 判定）。
   *
   * 池里的 param 在**入池时**就被校验过；取出时再校验一次是防「池里存了
   * 一个降级产物」——那种 param 在索要验证的窗口里发出去必然 `3007`，宁可在本地丢掉重产。
   */
  validate?: (param: string) => boolean
}

/** 池中的一项。 */
interface PooledParam {
  readonly param: string
  readonly atMs: number
}

/**
 * 预取池（**容量恒为 1**）。
 *
 * 为什么不做队列：captcha 的消费方是「一次推理请求 → 一个 param」，
 * 请求是串行到达的多步循环；池深 1 已能覆盖「上一轮结束时备好下一轮」。
 * 池深更大只会让更早产出的 param 更接近 TTL 边界，收益为负。
 */
export class CaptchaPool {
  private readonly mint: CaptchaPoolOptions['mint']
  private readonly ttlMs: number
  private readonly enabled: boolean
  private readonly now: () => number
  private readonly onWarn: ((message: string) => void) | undefined
  private readonly validate: ((param: string) => boolean) | undefined

  private pooled: PooledParam | undefined
  /** 在飞的预取（用于去重：同一时刻只允许一个后台预取）。 */
  private inflight: Promise<void> | undefined

  constructor(options: CaptchaPoolOptions) {
    this.mint = options.mint
    this.ttlMs = options.ttlMs ?? DEFAULT_CAPTCHA_POOL_TTL_MS
    this.enabled = options.enabled ?? true
    this.now = options.now ?? (() => Date.now())
    this.onWarn = options.onWarn
    this.validate = options.validate
  }

  /**
   * 池当前是否有**可用**（未过期且合法）的 param —— 仅供诊断与单测。
   *
   * ⚠ 必须是**只读**的：早期把 `hasFresh()` 实现成「调一次 `takeFresh()` 看结果」，
   * 而 `takeFresh()` 会清空池 —— 于是「看一眼」就把预取好的 param 丢掉了，
   * 预取池在诊断代码路过时**静默失效**（写单测时实测到了：
   * `hasFresh()` 之后 `take()` 拿到的是现产物而不是池里的那个）。
   */
  hasFresh(): boolean {
    return this.peekFresh() !== undefined
  }

  /** 在飞的预取数量（0 或 1）—— 仅供诊断与单测。 */
  inflightCount(): number {
    return this.inflight === undefined ? 0 : 1
  }

  /** 清空池（关停时调用）。不取消在飞的预取 —— 它完成后会被 `stop()` 之后忽略。 */
  clear(): void {
    this.pooled = undefined
  }

  /**
   * 取一个 param 用于**本次请求**。
   *
   * 三条路径（顺序即优先级）：
   * 1. **池命中**（未过期、合法）→ 取走，并立刻在后台补下一个。
   * 2. **池空 / 已过期** → **现产**，产完同样触发一次补池。
   * 3. 未启用预取 → 直接现产（与旧行为一致）。
   *
   * ⚠ **第 2 条里的「产完触发补池」是必需的**，不是锦上添花：
   * 少了它，首次请求现产之后池永远是空的，之后每次都走现产 ——
   * 这个优化就形同虚设。`dsh-free-glm` 把这条写成了实现陷阱记录
   * （`takePooledCaptcha()` 的「池空也补一次」注释）。
   */
  async take(options: { signal?: AbortSignal } = {}): Promise<string> {
    if (!this.enabled) return await this.mint(options)

    const pooled = this.takeFresh()
    if (pooled !== undefined) {
      // 刚消耗掉池里那一个 —— 立刻备下一个（不 await，不阻塞本次请求）。
      this.prefetch()
      return pooled.param
    }

    const fresh = await this.mint(options)
    this.prefetch()
    return fresh
  }

  /**
   * 后台预取一个 param 入池（**不阻塞调用方、失败不抛**）。
   *
   * 去重：已有在飞的预取时直接返回 —— 否则每轮请求都会叠加一个预取，
   * 白耗 captcha 配额（且它们的产物只有一个能入池）。
   */
  prefetch(): void {
    if (!this.enabled) return
    if (this.inflight !== undefined) return
    // 池里已有可用项：不必再产（它的产出也无处安放）。
    if (this.pooled !== undefined && this.now() - this.pooled.atMs < this.ttlMs) return

    const task = (async (): Promise<void> => {
      try {
        const param = await this.mint()
        if (this.validate !== undefined && !this.validate(param)) {
          this.onWarn?.('zcode: captcha 预取产出了不可用的 param（已丢弃，下次请求现产）')
          return
        }
        /**
         * ⚠ 只有池**仍然是空**时才入池：预取在飞期间可能已有请求现产过，
         * 且此刻再覆盖会让「刚产出的」被丢掉（无害，但白花一次）。
         */
        const current = this.pooled
        if (current === undefined || this.now() - current.atMs >= this.ttlMs) {
          this.pooled = { param, atMs: this.now() }
        }
      } catch (error) {
        // 预取失败**绝不影响**主流程：下一次请求会自己现产一个。
        this.onWarn?.(
          `zcode: captcha 预取失败（不影响请求，下次现产）：${error instanceof Error ? error.message : String(error)}`,
        )
      } finally {
        this.inflight = undefined
      }
    })()
    this.inflight = task
  }

  /**
   * **只读**地看池里是否有可用项（不清空）。
   *
   * 判据与 {@link takeFresh} 逐条一致 —— 否则会出现「`hasFresh()` 说有、
   * `take()` 却拿不到」的不一致。
   */
  private peekFresh(): PooledParam | undefined {
    const item = this.pooled
    if (item === undefined) return undefined
    if (this.now() - item.atMs >= this.ttlMs) return undefined
    if (this.validate !== undefined && !this.validate(item.param)) return undefined
    return item
  }

  /**
   * 取出池里**未过期且合法**的一项（取走即清空）。
   *
   * 过期项直接丢弃并返回 `undefined` —— 让调用方走现产，
   * 而不是把一个大概率被上游拒的 param 发出去（那是**一次可见的失败**）。
   */
  private takeFresh(): PooledParam | undefined {
    const item = this.peekFresh()
    if (item === undefined) {
      // 顺手把过期/非法的项丢掉（`peekFresh` 只判不删）。
      this.pooled = undefined
      return undefined
    }
    this.pooled = undefined
    return item
  }
}

/** 池内 param 的默认最长存放时间（毫秒）—— 依据见文件头注释。 */
export const DEFAULT_CAPTCHA_POOL_TTL_MS = 30_000

/**
 * 预取池**默认关闭**（2026-10-01 由「默认开」翻转）。
 *
 * ## 为什么翻转（官方实证 + 实测证据）
 *
 * **① 官方根本没有预取机制。** 闭源版 `app.asar` 渲染层产物里，captcha 是
 * **每请求现产、严格串行**（`jnn`/`wnn` 的全局队列），**没有任何预取或缓存**。
 * `dsh-free-glm` 的池默认也是关的（`ZCODE_CAPTCHA_POOL=1` 才启用，
 * 注释原话「先观察稳定性」）。⇒ 我当初把它做成默认开启，**偏离了两个参照**。
 *
 * **② 它会让我们对 captcha 的消耗翻倍。** 每个请求 = 现产 1 个 + 后台预取 1 个。
 * 而阿里云按**设备维度**限流：官方文档（自定义策略页）的默认阈值是
 * **同设备每小时 150 次**。多步任务每步一次，翻倍后撞上限的概率显著上升。
 *
 * **③ 有实测旁证**：`session-eced01ed`（我方 `zcode`）连续 12 次失败、
 * 每次重试都重新 mint；同一分钟 `session-b0e4eb3f`（`zcode-bridge`）
 * 报 `502 Failed to mint auth material` —— 两个插件抢同一份设备信誉。
 * ⚠ **注意归因强度**：这只能证明「存在跨插件干扰」，**不能**证明预取池是
 * 压垮信誉的那一下。翻转默认值的理由是①②（官方与参照都不这么做），
 * 不是③。
 *
 * ## 想要延迟优化怎么办
 *
 * 显式设 `DSH_ZCODE_CAPTCHA_POOL=1` 打开（实现完整保留、有单测覆盖）。
 * 但**务必先确认你的设备信誉余量**：若刚撞过滑块降级或 `502 mint failed`，
 * 开它只会更糟。
 */
export const CAPTCHA_POOL_DEFAULT_ENABLED = false

/**
 * 从环境变量解析池配置（生产入口用；单测直接构造 {@link CaptchaPool}）。
 *
 * ⚠ 环境变量**只认显式 `0` / `1`**：未设置时用
 * {@link CAPTCHA_POOL_DEFAULT_ENABLED}（当前为 `false`）。
 */
export function captchaPoolConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; ttlMs: number } {
  const rawSwitch = env['DSH_ZCODE_CAPTCHA_POOL']
  const enabled = rawSwitch === undefined || rawSwitch.trim().length === 0
    ? CAPTCHA_POOL_DEFAULT_ENABLED
    : rawSwitch.trim() !== '0'

  const rawTtl = env['DSH_ZCODE_CAPTCHA_POOL_TTL_MS']
  const parsed = rawTtl === undefined ? Number.NaN : Number(rawTtl)
  const ttlMs = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : DEFAULT_CAPTCHA_POOL_TTL_MS
  return { enabled, ttlMs }
}
