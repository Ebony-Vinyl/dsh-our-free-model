/**
 * 内部载体 → server 的 **param 供给槽**（进程内，最多放 1 个）。
 *
 * ## 为什么需要它（而不是「server 同步问 client 要」）
 * 现有通道只有 `connection.fetch`，而本仓库只见过它的两种消息：入站判断
 * `message.type !== 'client-request'` 与出站组装 `{ type: 'server-response', … }`
 * （均在 `src/channel-pack-rpc.ts`）⇒ 通道是 **client → server 单向**的
 * ⇒ server 在推理热路径上**无法**同步要求 GUI 现产一个 param。
 * 于是改成：GUI 在 server 标记「现在需要」（`captchaDemand`）时产一个放进槽里，
 * server 取；取不到就**有界等待**一小会儿，再退回外挂 chromium。
 *
 * ## 三条互相拉扯的约束（本文件的每个分支都对应一条）
 * 1. **一次性**：param 用一次就废（复用必 `3007`）⇒ 取走即清；
 * 2. **时效未知**：从没实测过「产出后多久发会被拒」⇒ 只能保守丢弃
 *    （`PARAM_MAX_AGE_MS`）。⚠ 这是**未实测的保守值**，量法见 `takeFreshParam` 注释；
 *    ⚠ **时效判定只此一处** —— 入口取货与被唤醒取货都走 `takeFreshParam`，
 *    没有任何一条通路能把 param 绕过这道闸交出去（见 `putSuppliedParam` 的「唤醒≠交付」）；
 * 3. **绝不挂死**：`zcode-captcha.ts` 出过「无超时的等待把整轮钉住、点停止也没反应」
 *    的真实缺陷（2026-09-29，见该文件「等待必须**有界且可取消**」那条注释）
 *    ⇒ 等待必须带超时且可中断。
 *
 * ## 与「预取池」的区别（别混淆，那条默认关闭是有理由的）
 * 预取池（`src/captcha-pool.ts`）是**提前**产：打开后「每个请求 = 现产 1 个 + 后台
 * 预取 1 个」，翻倍消耗设备的验证配额（阿里云按同设备每小时 150 次限流），
 * 故其 `CAPTCHA_POOL_DEFAULT_ENABLED` 已翻转为 `false`；
 * 这里的槽**只在 server 置起需求位时**才被填 ⇒ 上游不索要验证的窗口里一次都不产。
 *
 * ## ★ 依赖方向（评审 I1 引入，先确认过再动的）
 * 本文件为了收货口的**质量闸**引入了 `validateCaptchaParam`（`./zcode-captcha.js`），
 * 方向是 supply → captcha。**无环**：`src/zcode-captcha.ts` 只 import node 内置模块
 * （`node:child_process` / `node:fs` / `node:net` / `node:os` / `node:path`），
 * 不反向依赖本文件 —— 评审要求「若造成循环依赖先报告再动」，实测无环，故直接接上。
 * ⚠ 反过来说：**不许**为了「让 zcode-captcha 知道供给槽」而在本文件之外新建反向 import，
 * 那会把这条单向依赖变成环。
 */
import { validateCaptchaParam } from './zcode-captcha.js'

/**
 * 供给 param 的可接受年龄上界（毫秒）。⚠ **未实测的保守值**，见文件约束 2。
 *
 * ⚠ 年龄按「server 收到这条贡献的时刻」起算（见 `SupplySlot.atMs`），而真实年龄还要
 * 再加上 client 产出 → 回传的那一跳 ⇒ 这里算出来的年龄被**系统性低估**。
 * ⇒ 这个常量只能往**小**里留余量（≈ 上游真实时效 − 一跳延迟），
 * 不要因为「少算了一段」就把它放大 —— 放大的结果就是把真实超龄的 param 发出去。
 * 真实时效量出来后回填（量法见 `takeFreshParam`）。
 */
export const PARAM_MAX_AGE_MS = 20_000

/** 有界等待的默认上限（毫秒）——与 client 的贡献心跳同量级。 */
export const DEFAULT_CARRIER_WAIT_MS = 1_500

interface SupplySlot {
  param: string
  /**
   * **server 收到这条贡献的时刻**（由 `putSuppliedParam` 的调用方打进），不是产出时刻。
   *
   * ⚠ 别写成「param 产出时刻」—— 它比产出**晚了一个 client → server 的跳数**
   * （GUI 里 guest 产完 → RPC 排队 → server 落槽），所以算出来的年龄被**低估**。
   * 我们仍选这个口径，因为它只用 server 自己的时钟，不引入跨端时钟漂移：
   * client 时钟快/慢或 NTP 跳变都会把时效闸整个弄废（快了永不判过期、
   * 慢了一投放就过期 ⇒ 内部载体静默永不可用，且日志看着像「client 没产」）。
   * ⚠ 正因为已知偏低，`PARAM_MAX_AGE_MS` 这个**未实测的保守值更要留足余量**。
   */
  atMs: number
  /**
   * 这一发是不是**交互式验证**产物（SDK 被降级成滑块/拼图，评审 I2）。
   *
   * ⚠ 这是内部载体**唯一**的设备信誉预警通路：chromium 那条腿在
   *   `ZcodeAuth.captchaPoolInstance()` 里已经会 `warn`，而内部载体这段此前
   *   **只打进 client 的控制台**，host 侧一个字都看不到（等于没有预警）。
   *   标记跟着 param 一起存，取走即随 param 一起消失（`pendingInteractive`）。
   */
  interactive: boolean
}

let slot: SupplySlot | undefined
let demand = false
const stats = { supplied: 0, used: 0, stale: 0, waitTimeouts: 0, interactive: 0 }

/**
 * 等待者队列（有界等待 ⇒ 谁先到谁拿）。
 *
 * ⚠ 回调是**无参的唤醒信号**，不是 `(param) => void` 的投递口：
 * param 一律由被唤醒者自己去 `takeFreshParam` 取，时效闸因此只有一处。
 */
const waiters: Array<() => void> = []

/**
 * client 回传一个 param 落槽，并**唤醒**队首等待者（唤醒不等于交付）。
 *
 * ⚠ **不合格一律不收**（评审 I1，2026-10-02）：判据直接用
 *   `validateCaptchaParam`（`./zcode-captcha.js`），**与 chromium 腿同一份**。
 *   此前这里只判「非空」，于是 SDK 被降级时那串约 76 字符的垃圾 param 能一路进槽、
 *   被取走、发到上游 —— 领取端点**始终**索要验证（`400/3007`），那发必然失败，
 *   白扣一次设备级验证配额（阿里云同设备每小时 150 次）。
 *   ⚠ 判据只有这一份：本地再写一份长度/字段判据必然与 `zcode-captcha.ts` 漂移
 *   （本仓库反复吃过同型缺陷）。
 *
 * @param arrivedAtMs **server 侧**的到达时刻。调用方（`src/channel-pack-rpc.ts` 的贡献
 *   入口）传 `Date.now()` 即可；⚠ 不要传 client 带回来的时间戳（跨端时钟漂移会弄废
 *   时效闸，见 `SupplySlot.atMs`）。参数存在只为让单测能注入时钟。
 * @param options.interactive 这一发是不是被降级成了交互式验证（评审 I2，见 `SupplySlot`）。
 * @returns 是否被接受（调用方据此决定要不要重试贡献）。
 */
export function putSuppliedParam(
  param: string,
  arrivedAtMs: number,
  options: { interactive?: boolean } = {},
): boolean {
  if (typeof param !== 'string' || param.trim().length === 0) return false
  if (!validateCaptchaParam(param).ok) return false
  const interactive = options.interactive === true
  // 槽内只留最新的一个：囤多个 param 会白耗配额，且旧的更可能过期。
  slot = { param: param.trim(), atMs: arrivedAtMs, interactive }
  stats.supplied += 1
  if (interactive) stats.interactive += 1
  // 评审缺陷 1：这里曾写 `waiter?.(slot.param)` 把 param **无条件**递给等待者，
  // 而等待侧不再查年龄 ⇒ client 回传慢于 `PARAM_MAX_AGE_MS` 时过期 param 照样被发出去。
  // 现在只叫它一声，让它自己去取货。
  waiters[0]?.()
  return true
}

/**
 * 取一个仍在时效内的 param（**取走即清**，一次性）。
 *
 * ⚠ 本函数是**唯一**的时效闸：`waitForFreshParam` 的入口取货与被唤醒取货都走这里，
 * `used` / `stale` 也只在这一处记账。任何「另开一条交付通路」的写法都会绕过时效判定
 * （评审缺陷 1 就是那条直投 `slot.param` 的旁路）。
 *
 * ⚠ 量 param 真实时效的方法（二期第一件事）：等真出现 `3007` 的那次，
 *   故意用「年龄递增」的 param 各发一次，看从第几秒开始被拒，再回填这个常量。
 *
 * ⚠ 边界取 `>=`（age 恰等于上限即作废），与 `src/captcha-requirement.ts` 的
 *   `until <= now` 同一惯例：时效本来就是未实测的保守值，整点这一毫秒不放宽。
 */
export function takeFreshParam(nowMs: number): string | undefined {
  const current = slot
  if (current === undefined) return undefined
  slot = undefined
  if (nowMs - current.atMs >= PARAM_MAX_AGE_MS) {
    stats.stale += 1
    return undefined
  }
  stats.used += 1
  return current.param
}

/** server 置起「现在可能需要 captcha param」，client 的心跳据此决定要不要产。 */
export function setCaptchaDemand(active: boolean): void {
  demand = active
}

export function captchaDemand(): boolean {
  return demand
}

/**
 * 有界等待一个新鲜 param：先取现成的，没有就等投放，超时/中断一律返回 undefined。
 *
 * ⚠ 三条退出路径都必须存在（挂死过一次的人写的注释）：
 *   ①槽里有 → 直接给；②超时 → 记 `waitTimeouts`；③ abort → 立刻给 undefined。
 *
 * ⚠ 被唤醒后**自己去 `takeFreshParam`**，与入口那条出口共用同一道时效闸：
 * 取到 `undefined`（刚过期被清）就**不出队**，继续等下一次投放直到超时。
 * `used` / `stale` 也只由 `takeFreshParam` 记一处，这里再记一次就是两处真相。
 */
export function waitForFreshParam(
  now: () => number,
  maxWaitMs: number = DEFAULT_CARRIER_WAIT_MS,
  options: { signal?: AbortSignal } = {},
): Promise<string | undefined> {
  const immediate = takeFreshParam(now())
  if (immediate !== undefined) return Promise.resolve(immediate)
  if (options.signal?.aborted === true) return Promise.resolve(undefined)

  return new Promise((resolve) => {
    let settled = false
    const finish = (timedOut: boolean, param?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      const index = waiters.indexOf(onWake)
      if (index >= 0) waiters.splice(index, 1)
      if (timedOut) stats.waitTimeouts += 1
      resolve(param)
    }
    const onWake = (): void => {
      const param = takeFreshParam(now())
      if (param === undefined) return
      finish(false, param)
    }
    const onAbort = (): void => { finish(false) }
    const timer = setTimeout(() => finish(true), maxWaitMs)
    timer.unref?.()
    waiters.push(onWake)
    options.signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 只读快照（新对象；面板/日志用，绝不允许反向写）。
 *
 * ⚠ `pendingInteractive` 说的是「**当前槽里那条**是不是交互式产物」——
 * 它随 `takeFreshParam` 一起归零（一次性），所以它是「下一发要不要警惕」的读数，
 * 与累计计数 `interactive` 是两个维度，别混用。
 */
export function captchaSupplyStats(): typeof stats & { pendingInteractive: boolean } {
  return { ...stats, pendingInteractive: slot?.interactive === true }
}

/** 全量复位（单测用；与 `resetCaptchaRequirementMemory` 配套调用）。 */
export function resetCaptchaSupply(): void {
  slot = undefined
  demand = false
  stats.supplied = 0
  stats.used = 0
  stats.stale = 0
  stats.waitTimeouts = 0
  stats.interactive = 0
  waiters.length = 0
}
