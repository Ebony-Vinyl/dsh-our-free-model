/**
 * captcha **载体链**：内部载体（DSH Desktop 的 webview guest 产的 param）优先，
 * 外挂 chromium 兜底。三级 = ①供给槽 ②有界等待 ③chromium。
 *
 * ## 为什么必须「当次回退」而不是「把失败抛给用户」
 * 内部载体的 param 能不能被上游接受**尚未在真实校验窗口验证过**：普通即时推理
 * 连续 6 个采样点上游都不校验这个头（实测记录见
 * `docs/superpowers/specs/2026-10-01-zcode-captcha-lazy-mint-design.md` 9.2 节，
 * 该文件不入库，本地留档）⇒ 「内部 param 能过」目前只是 guest 侧的自检结论
 * （4/4 产出 `certifyId` + `securityToken=128`、零滑块），**不是**上游接受性的证据。
 * 所以不能拿用户的请求去赌一个未验证假设：被 `3007` 拒的**当次**就必须用 chromium
 * 重产重发，在同一发请求内解决，外面完全看不出来。
 * 上游那侧的「3007 → 本轮补产重发」分支本来就在（`src/zcode-adapter.ts` 的
 * 「③ ★ captcha 被拒（3007）」那一段），本文件只是把「补产」从
 * 「必然走 chromium」换成「chromium 之外的第二个来源也试过」。
 *
 * ## 为什么要「累计 N 次就禁用」
 * 每次赌错都要多付一次上游往返 + 一段有界等待。若这台机器就是不行（旧版桌面壳、
 * 载体页被 CSP/网络拦、guest partition 状态异常），反复赌只会持续亏 ——
 * 方向同 `src/captcha-backoff.ts` 文件头引的那句「继续请求不会让信誉恢复，只会更糟」。
 *
 * ⚠ **这个计数器与 `CaptchaBackoff` 的失败计数是两回事，不要合并**：
 * backoff 数的是「**本机产出失败**」（SDK `F001`/超时/降级产物），并明确写了
 * 「mint 成功但上游回 `3007`」归因不清 ⇒ **不计数**（见该文件「本实现的两个关键设计」
 * 第 2 条）。这里数的恰恰是那一类「产出成功但被上游拒」，而且**只数内部载体的**，
 * 所以它必须独立存在：既不该被 backoff 冷却掉（那会把一条没问题的 chromium 链路
 * 一起关进冷却），也不该被 backoff 的成功清零（内部载体不行这件事不因
 * chromium 能用而消失）。
 *
 * ## 两条不改动的既有护栏
 * 1. `mintWithChromium` 就是既有的 `ZcodeAuth.mintCaptcha`（`src/zcode-auth.ts`），
 *    它内部自带退避闸门（`this.captchaBackoff.remainingMs()`）与串行队列
 *    （`this.captchaQueue`）⇒ 本文件**原样透传、不吞异常**：闸门要如实回它的
 *    「冷却中」，这里替它兜住就等于把冷却护栏拆了。
 * 2. 时效判定不在这里做第二遍：槽的 `takeFreshParam` 是唯一那道闸
 *    （见 `src/captcha-supply.ts` 同名函数的注释），本文件不碰 `PARAM_MAX_AGE_MS`。
 *
 * ## web 版
 * 拿不到 `dshDesktop.browser` ⇒ 供给槽永远空、需求位也没人置起 ⇒ 走的是
 * 「不等待、直接 chromium」那条最快分支，与引入本文件之前**逐字一致**。
 * 若连这一跳的开销都不想要，开关是 `DSH_ZCODE_INTERNAL_CARRIER=0`
 * （由 Task 4 的接线处读取后决定要不要构造本类）。
 */
import {
  captchaDemand,
  captchaSupplyStats,
  DEFAULT_CARRIER_WAIT_MS,
  takeFreshParam,
  waitForFreshParam,
} from './captcha-supply.js'

/** 内部载体的 param 被上游拒到第几次就本次运行停用（阈值取自 spec 9.3）。 */
export const CARRIER_REJECT_DISABLE_THRESHOLD = 3

/** 一次产出的结果：param 加上**它从哪来** —— 回退决策与归因都靠这个标记。 */
export interface CarrierOutcome {
  param: string
  source: 'internal' | 'chromium'
}

export interface CaptchaCarrierDeps {
  /** 外挂 chromium 产出一个新鲜 param（既有链路：含退避闸门与串行队列）。 */
  mintWithChromium: (options?: { signal?: AbortSignal }) => Promise<string>
  /** 等内部载体贡献的上限（毫秒）。默认与 client 贡献心跳同量级，取自供给槽模块。 */
  waitMs?: number
  /** 时钟（注入以便单测推进 param 年龄）。 */
  now?: () => number
  /** 诊断日志。 */
  log?: (message: string) => void
}

export class CaptchaCarrier {
  private readonly mintWithChromium: (options?: { signal?: AbortSignal }) => Promise<string>
  private readonly waitMs: number
  private readonly nowImpl: () => number
  private readonly log: ((message: string) => void) | undefined
  /** 内部载体的 param 被上游拒的累计次数（达到阈值即禁用，见文件头）。 */
  private rejections = 0
  private disabled = false
  private readonly counters = { internalUsed: 0, chromiumUsed: 0 }

  constructor(deps: CaptchaCarrierDeps) {
    this.mintWithChromium = deps.mintWithChromium
    this.waitMs = deps.waitMs ?? DEFAULT_CARRIER_WAIT_MS
    this.nowImpl = deps.now ?? (() => Date.now())
    this.log = deps.log
  }

  /** 内部载体是否已被本次运行禁用（禁用后连槽里有货也不用，见 `mint`）。 */
  internalDisabled(): boolean {
    return this.disabled
  }

  /**
   * 产出一个 param：内部优先，等不到即 chromium。
   *
   * 三条出口（顺序即优先级）：
   * 1. **槽里已有新鲜 param** → 立刻用。⚠ 这条**不看需求位**：client 既然已经产出了，
   *    再为了「统一走等待」把它留在槽里过期，等于白烧一份配额；
   * 2. **需求位为真**（`captchaDemand`，语义同 `src/captcha-requirement.ts` 的
   *    「上游要验证」）→ 有界等一次贡献，等到就用；
   * 3. 其余一律 chromium，**不白等** —— 需求位为假时每条消息都等 `waitMs`
   *    会把「上游不校验时零成本」这个收益整个赔回去。
   *
   * ⚠ 禁用之后必须**既不等也不取槽**：`waitForFreshParam` 被唤醒时自己会去
   * `takeFreshParam`，所以「只把入口那条 take 短路掉」是不够的 —— 漏掉这一层短路，
   * 内部 param 仍会从等待那条路溜出去，而它正是被上游拒过 3 次的那类东西。
   */
  async mint(options: { signal?: AbortSignal } = {}): Promise<CarrierOutcome> {
    if (!this.disabled) {
      const ready = takeFreshParam(this.nowImpl())
      if (ready !== undefined) {
        this.counters.internalUsed += 1
        return { param: ready, source: 'internal' }
      }
      if (captchaDemand()) {
        // ⚠ 第一个实参是**时钟函数**本身，不是 `this.nowImpl()`：
        // `waitForFreshParam(now, maxWaitMs, …)` 要在超时与被唤醒时各读一次时钟。
        // 任务书这里写成了调用结果（数字），而它给的 8 条用例**测不出来** ——
        // 那几条都没置起需求位，永远走不到这一行。补的网在
        // `tests/unit/zcode-captcha-carrier.spec.ts` 里「需求位开」的那两条用例。
        const waited = await waitForFreshParam(this.nowImpl, this.waitMs, options)
        if (waited !== undefined) {
          this.counters.internalUsed += 1
          return { param: waited, source: 'internal' }
        }
      }
    }
    return await this.mintByChromium(options)
  }

  /**
   * 带着上一次的产出去撞过上游、结果被 `3007` 拒 ⇒ **当次**改用 chromium 重产。
   *
   * 本方法**不向外抛失败**：赌错是我们的事，用户看到的应该只是一次稍慢的成功。
   *
   * @param outcome - 上一次 `mint()` 的结果。来源是 `chromium` 时**不记拒绝**
   *   （那是 param 自身过期/降级，与内部载体无关，见文件头的归因纪律）。
   */
  async mintWithFallbackAfterRejection(
    outcome: CarrierOutcome,
    options: { signal?: AbortSignal } = {},
  ): Promise<CarrierOutcome> {
    if (outcome.source !== 'internal') {
      this.log?.('zcode: chromium 的 param 也被拒（3007）⇒ 按既有逻辑换新 param 重试')
      return await this.mintByChromium(options)
    }
    this.noteInternalRejection()
    return await this.mintByChromium(options)
  }

  /**
   * 记一次「内部载体的 param 被上游拒」，并在到阈值时**本次运行禁用**内部载体。
   *
   * ## 为什么单独暴露（评审 C4）
   * 领取路径（`ZcodeAuth.claimDailyWith`）也要记同一笔账，但它重发时走的是
   * **注入链**（`channel-pack-rpc.ts` 注入的那条），不是本类里那条 chromium 腿 ——
   * 用 `mintWithFallbackAfterRejection` 会顺手多产一个没人用的 param。
   * ⇒ 把「记账 + 阈值禁用」这段（也就是本文件头「累计 N 次就禁用」那套语义）
   * 抽成这个方法，两个调用点共用**同一份**阈值判断，不会漂移成两处真相。
   */
  noteInternalRejection(): void {
    this.rejections += 1
    this.log?.(
      `zcode: 内部载体的 param 被上游拒（第 ${String(this.rejections)} 次）`
      + ' ⇒ 当次改用 chromium 重产',
    )
    if (!this.disabled && this.rejections >= CARRIER_REJECT_DISABLE_THRESHOLD) {
      this.disabled = true
      this.log?.(
        `zcode: 内部载体累计被拒 ${String(this.rejections)} 次 ⇒ 本次运行禁用内部载体，`
        + '只走 chromium（排查：载体页是否被 CSP/网络拦、guest 的 location.origin 是否正常）',
      )
    }
  }

  /**
   * 观测：本链路的取舍计数 + 供给槽统计（面板与日志用，与 `zcode-auth.ts` 的 stats 同处）。
   *
   * ⚠ 槽那份快照里有 `interactive` / `pendingInteractive`（评审 I2）：内部载体被 SDK
   *   降级成**交互式验证**是这台机器设备信誉变差的**唯一**预警（chromium 那条腿
   *   已经会 `warn`，内部载体这段此前只打进 client 控制台，host 侧看不到）。
   *   `pendingInteractive` 说「**当前槽里那条**是不是交互式产物」—— 取走即归零。
   */
  stats(): {
    internalUsed: number
    chromiumUsed: number
    internalRejected: number
    disabledAfter: number
    supply: ReturnType<typeof captchaSupplyStats>
  } {
    return {
      internalUsed: this.counters.internalUsed,
      chromiumUsed: this.counters.chromiumUsed,
      internalRejected: this.rejections,
      disabledAfter: CARRIER_REJECT_DISABLE_THRESHOLD,
      supply: captchaSupplyStats(),
    }
  }

  /** chromium 产出并记账。**唯一**出口，异常原样上抛（退避闸门的语义要保住）。 */
  private async mintByChromium(options: { signal?: AbortSignal }): Promise<CarrierOutcome> {
    this.counters.chromiumUsed += 1
    return { param: await this.mintWithChromium(options), source: 'chromium' }
  }
}
