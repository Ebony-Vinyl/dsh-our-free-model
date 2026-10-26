/**
 * Cline 限流（429 / 402）的**时长与话术**：标记该写多长、该对用户说什么。
 *
 * ## 为什么必须单独一个模块（真实缺陷，2026-10-03 用户报障两次）
 *
 * 用户第一次报障：「倒计时结束了我再去连为什么还是失败了，显示要 60 分钟后？」
 * 我们据此改用服务端给的 `retry-after` 响应头 —— 但用户第二次报障：
 * **还是 60 分钟**。
 *
 * 直连取证（`probe-cline-live.mjs`，2026-10-03 23:10）：
 *
 * ```
 * POST /api/v1/chat/completions   {"model":"cline-free/deepseek-v4.1-flash"}
 * → HTTP 429
 *   no-retry: true                     ← 没有任何 retry-after 头
 *   x-request-id: JvXBMYgDCJKhLXnaJOXdzCnouwNjqVlJ
 *   {"error":{"code":"INFERENCE_CAP_ERROR",
 *     "message":"Error 429: Daily free limit reached on model
 *                deepseek/deepseek-v4.1-flash. Try again in 19h 39m"}}
 * ```
 *
 * ⇒ **Cline 不给 `retry-after` 头，也不给绝对时刻**，它把等待时长写在
 * **人类可读的英文句子**里（`Try again in 19h 39m`）。`parseRateLimitError`
 * 只认「将在 / reset at + 绝对时刻 + 时区」两种句式，故这里**必然**解析失败、
 * 退回 1 小时的快照兜底 —— 而真实等待是 **19 小时 39 分**（当日免费额度）。
 * 用户等满 1 小时再试，当然还是被拒；而且每失败一次就**从当下**重新计一小时，
 * 于是「永远 60 分钟」可以无限循环。
 *
 * ⚠️ 这里的 `Daily free limit` 还带一层**语义**差异，不能只当「等多久」：
 * 它是**按天结算的免费额度**（该账号的 `cline-free/*` 通道），等下去才会恢复。
 * 坏了的是「用户以为等 1 小时就好」，故话术必须把「是什么 + 何时恢复 + 现在能做什么」
 * 三件事分开说（见 {@link clineExhaustedAdvice}）。
 *
 * ⚠️⚠️ **别把 `cline-pass/*` 当成「换个通道立刻就能用」的出路**：它是**订阅**通道，
 * 不是「有余额就能用」。实测同一个账号（`balance: 500000`，有余额）请求
 * `cline-pass/deepseek-v4.1-flash` 回 **403 `ENTITLEMENT_ERROR`**
 * （`the user is not subscribed to required model plan`），额度端点
 * `/api/v1/users/me/plan/usage-limits` 也是 `404 no plan history found for user`
 * —— 有余额但**没有订阅计划**。完整报文见本文件 {@link clineExhaustedAdvice} 的注释，
 * 那里的「⚠️ 不要建议改用 cline-pass」才是结论，本段曾与之矛盾（凭直觉推荐了一个
 * 没验证过的动作，用户照做只会再撞一次墙）。
 *
 * 1. `retry-after` 响应头（秒数或 HTTP 日期）—— 有就是最权威；
 * 2. 报文里的 `Try again in 19h 39m`（本模块新增）；
 * 3. `parseRateLimitError` 的通用句式（绝对时刻 + 时区）；
 * 4. 都没有才退到 {@link RATE_LIMIT_FALLBACK_MS} 的**快照式**兜底。
 */

import { formatResetIn, parseRateLimitError, RATE_LIMIT_FALLBACK_MS } from './rate-limit.js'
import { retryAfterMsFromResponse } from './retry-after.js'

/** 一次 429 / 402 报文里能读出来的东西。 */
export interface ClineRateLimitHint {
  /**
   * 服务端要求的等待时长（毫秒）。
   *
   * `undefined` = 报文里**没有**时长（此时才会退到快照兜底）；
   * `0` 是合法值（`Try again in 0s` = 立即解除），故判空一律用 `=== undefined`。
   */
  waitMs?: number
  /**
   * 是否**按天结算的免费额度**用尽（`Daily free limit reached`）。
   *
   * ⚠️ 判据取自**服务端文案**而非错误码：实测码是 `INFERENCE_CAP_ERROR`
   * （「推理上限」），它既可能是按天的免费额度、也可能是别的上限；
   * 而文案明确写了 `Daily free limit`。码值留给 {@link ClineRateLimitHint.code}
   * 只作排障线索。
   */
  dailyFree: boolean
  /** 网关业务码（如 `INFERENCE_CAP_ERROR`）；仅作排障线索。 */
  code?: string
  /** 上游原始文案（已剥掉 JSON 外壳）；供错误消息原样引用。 */
  message?: string
}

/**
 * 「还要等多久」的句式：`Try again in 19h 39m`。
 *
 * 捕获到句末/分号为止 —— 后面可能还跟着别的说明（`Try again in 5m after
 * upgrading your plan`），多抓会把无关数字算进时长。
 */
const CLINE_WAIT_PATTERN = /try again in\s+([^.;\n]*)/i

/**
 * 时长 token：`19h` / `39m` / `45s` / `1 hour` / `5 minutes`。
 *
 * ⚠️ 尾部 `(?![a-z])` 不可去掉：没有它，`2 minutes` 里的 `m` 也会命中
 * （`minutes?` 与 `m` 两个分支都能匹配），同一段被算两次 → 时长翻倍。
 */
const CLINE_DURATION_TOKEN = /(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi

/** `Daily free limit reached` 一类文案标记（小写比对）。 */
const CLINE_DAILY_FREE_MARKERS: readonly string[] = [
  'daily free limit',
  'free daily limit',
  'daily limit reached',
]

/**
 * 从报文里取出文案与业务码。
 *
 * ⚠️ **必须同时认三种外壳**：Cline 实测是 `{error:{code,message}}`，但网关 / CDN
 * 可能给 `{error:"…"}`（字符串）、`{message:"…"}`，甚至**非 JSON 的纯文本**
 * （HTML 错误页）。只认一种就会在别的形态下静默丢掉整条信息。
 */
function readClineErrorBody(body: string): { message: string; code?: string } {
  const trimmed = body.trim()
  if (trimmed.length === 0) return { message: '' }
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>
    const raw = data.error
    if (typeof raw === 'string' && raw.length > 0) return { message: raw }
    if (typeof raw === 'object' && raw !== null) {
      const nested = raw as Record<string, unknown>
      const message = typeof nested.message === 'string' ? nested.message : ''
      const code = typeof nested.code === 'string' && nested.code.length > 0 ? nested.code : undefined
      if (message.length > 0) return { message, ...code === undefined ? {} : { code } }
    }
    for (const key of ['message', 'msg'] as const) {
      const value = data[key]
      if (typeof value === 'string' && value.length > 0) return { message: value }
    }
    return { message: '' }
  } catch {
    // 非 JSON（纯文本 / HTML 错误页）：整段当文案，后面的句式解析照样能跑。
    return { message: trimmed }
  }
}

/**
 * 把 `19h 39m` 这样的时长串换成毫秒；没有任何 token 时返回 `undefined`。
 *
 * 各 token **累加**（`1h 30m` = 90 分钟）。⚠️ 不设上限：服务端说的就是它自己的
 * 结算窗口，替它裁剪只会又造出一个「以为等到了、其实没好」的倒计时。
 */
export function parseClineWaitMs(text: string): number | undefined {
  let totalMs = 0
  let matched = false
  // `lastIndex` 是 RegExp 上的可变状态：共享常量必须每次重置，否则第二次调用的
  // 起点停在上一次的末尾，命中结果随调用次数漂移（单测最容易暴露）。
  CLINE_DURATION_TOKEN.lastIndex = 0
  for (const match of text.matchAll(CLINE_DURATION_TOKEN)) {
    const value = Number(match[1])
    if (!Number.isFinite(value)) continue
    const unit = match[2].toLowerCase()
    // 三个分支的首字母互不重叠（h / m / s），故按首字母判单位即可。
    const scale = unit.startsWith('h') ? 3_600_000 : unit.startsWith('m') ? 60_000 : 1_000
    totalMs += value * scale
    matched = true
  }
  return matched ? totalMs : undefined
}

/**
 * 解析 429 / 402 报文里的等待时长与语义。
 *
 * 对任意输入都不抛错（报文可能根本不是 JSON），最差返回 `{dailyFree:false}`。
 */
export function parseClineRateLimitHint(body: string): ClineRateLimitHint {
  const { message, code } = readClineErrorBody(body)
  const waitMatch = CLINE_WAIT_PATTERN.exec(message)
  const waitMs = waitMatch === null ? undefined : parseClineWaitMs(waitMatch[1])
  const lower = message.toLowerCase()
  const dailyFree = CLINE_DAILY_FREE_MARKERS.some((marker) => lower.includes(marker))
  return {
    ...waitMs === undefined ? {} : { waitMs },
    dailyFree,
    ...code === undefined ? {} : { code },
    ...message === '' ? {} : { message },
  }
}

/**
 * 本次限流**服务端要求等多久**（毫秒），拿不到时才兜底。
 */
export function clineRateLimitResetAt(
  response: Response,
  body: string,
  model: string,
): number {
  const headerMs = retryAfterMsFromResponse(response.headers)
  // ⚠️ `0` 是合法值（「立即解除」），必须用 `=== undefined` 判空。
  if (headerMs !== undefined) return Date.now() + headerMs
  const hint = parseClineRateLimitHint(body)
  if (hint.waitMs !== undefined) return Date.now() + hint.waitMs
  return parseRateLimitError(body, model, response.status)?.resetTimeMs
    ?? Date.now() + RATE_LIMIT_FALLBACK_MS
}

/**
 * 该失败是否应**记为模型的限流标记**（让 UI 亮出「限额重置」徽章）。
 *
 * ⚠️ **只有 429**：徽章的含义必须是「受限，某时刻后可能自动解禁」。
 * **402（额度耗尽）没有「多久后重置」可言** —— 记成一个倒计时会让用户
 * 白等（而正确动作是去充值）。这与 `recordsLobsteraiRateLimit` 的约定一致：
 * **不写徽章 ≠ 不换号**，402 仍然会换号重试（别的账号可能有余额）。
 */
export function recordsClineRateLimit(status: number, _body: string): boolean {
  return status === 429
}

/**
 * 全部账号都不可用时给用户的**行动建议**。
 *
 * ⚠️ 429 / 402 / 「当日免费额度」三种情形的动作**完全不同**，合并成一句
 * 「请稍后再试」会让用户白等：
 *
 * | 形态 | 正确动作 | 依据 |
 * |---|---|---|
 * | 402 `Insufficient credits` | 去 app.cline.bot 充值 | Cline 官方错误码表 |
 * | 429 `Daily free limit reached` | **等没用**（按天结算），改用同一账号的**另一个免费模型** | 报文原文 + 实测 |
 * | 429 其它 | 等一会儿 / 换账号 | 官方文档 `Rate limit exceeded` |
 *
 * 后两类都由 429 下发，**只能靠文案区分** —— 这正是 cline/cline#10139
 * （`WAIT vs STOP not distinguished`）那类缺陷的同一个坑。
 *
 * 1. **识别出语义就不再复述原文**（免费额度 / 402 两种都识别得出来）：我们的文案
 *    已把「是什么 + 何时恢复 + 现在能做什么」说全，原文只在**没识别出语义**时才附上；
 * 2. **不用 markdown**：`**加粗**` 在 harness 的错误气泡里**原样显示星号**
 *    （用户截图里就是 `**当日免费额度**`），这里只能写纯文本；
 * 3. 目标长度 ≈ 130 字符以内，单测有上限锁（改文案时别把它撑回去）。
 *
 * ⚠️ **不要建议「改用 `cline-pass/*` 付费通道」**：那是**订阅**通道，不是「有余额就能用」。
 * 实测（2026-10-03 23:20，同一个账号）：
 *
 * ```
 * POST /api/v1/chat/completions  model=cline-pass/deepseek-v4.1-flash
 * → HTTP 403 {"error":{"code":"ENTITLEMENT_ERROR",
 *              "message":"Error 403: the user is not subscribed to required model plan"}}
 * ```
 *
 * 该账号的额度端点（`/api/v1/users/me/plan/usage-limits`）也是 `404 no plan history
 * found for user` —— 它有余额（`balance: 500000`）但**没有订阅计划**。第一版建议正是
 * 这么写的，属于「凭直觉推荐了一个没验证过的动作」，用户照做只会再撞一次墙。
 *
 * ⚠️ 写这条注释时踩到的坑：把加粗标记直接接在路径前面（星号紧跟斜杠）会**提前闭合**
 * 块注释 —— 那两个字符本身就是结束符，于是后面的字符串被当成代码，编译器报
 * `TS1160: Unterminated template literal`，指针还指向文件末尾。强调路径就只加反引号。
 *
 * 而**免费额度是按模型单独计**的（同一时刻实测）：
 *
 * | 模型 | 结果 |
 * |---|---|
 * | `cline-free/deepseek-v4.1-flash` | 429 `Daily free limit reached … Try again in 19h 29m` |
 * | `cline-free/mimo-v2.6-flash` | **200**（正常出字） |
 * | `cline-free/muse-spark-1.3-contributor` | **200** |
 *
 * ⇒ 立刻可用的动作是「换**另一个** `cline-free/*` 模型」或别的 provider / 账号。
 *
 * @param hint - 由 {@link parseClineRateLimitHint} 解析出的语义；缺省时按最保守的
 *   「等一会儿」处理。
 * @param resetAtMs - 已知的解禁时刻（写进文案，让用户不必再猜）。
 */
export function clineExhaustedAdvice(
  status: number,
  hint?: ClineRateLimitHint,
  resetAtMs?: number,
): string {
  if (status === 402) {
    return '额度已用尽（HTTP 402 Insufficient credits）—— 等待不会恢复，'
      + '请到 app.cline.bot 充值，或改用其它 provider'
  }
  if (status === 429 && hint?.dailyFree === true) {
    // 只留三件事：是什么、何时能再试、现在改用什么。**不再复述上游英文原文**
    // （见上方「长度也是需求」），也不再写「盯着它等没用」那类解释性从句 ——
    // 「预计 N 小时后重置」本身已经说了「等不到头」。
    const when = resetAtMs === undefined
      ? ''
      : `，预计 ${formatResetIn(resetAtMs)}后重置（${new Date(resetAtMs).toLocaleString('zh-CN')}）`
    return `当日免费额度已用尽（HTTP 429）${when}`
      + '；额度按天结算、按模型单独计 —— 可先改用其它免费模型'
  }
  if (status === 429) {
    // ⚠️ 只有**没识别出语义**时才附上游原文（上面两种已识别，复述只会重复）。
    const detail = hint?.message === undefined || hint.message.length === 0 ? '' : `：${hint.message}`
    return `限流（HTTP 429${detail}）—— 稍后重试，或改用其它 provider / 账号`
  }
  return '请稍后再试，或改用其它 provider / 账号'
}
