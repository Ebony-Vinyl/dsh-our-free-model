/**
 * MiniMax Code 签到与积分余额。
 *
 * ## 端点（asar UI chunk 直读，实测通过）
 *
 * ```
 * GET  {host}/minimax-cloud/api/v1/signin/status?timezone_id=<IANA>
 * POST {host}/minimax-cloud/api/v1/signin/claim?timezone_id=<IANA>   body {}
 * GET  {host}/minimax-cloud/api/v1/credit/details
 * ```
 *
 * ## ⚠️ 四个必须记住的点
 *
 * 1. **`timezone_id` 是 query 参数且必填**。实测四种组合：query 生效、
 *    请求头无效、都不带报 `invalid timezone_id`、非法时区名也报错。
 * 2. **业务码在 `base_resp.status_code`**（不是 `code`），且 `invalid timezone_id`
 *    也是 **HTTP 200** —— 只看 HTTP 状态码会把它当成成功。
 * 3. **`points` 是总数，`bonus_points` 是其中的「额外」部分，不得相加**。
 *    实测第 1 天 `points: 800`、`bonus_points: 400`，截图按钮就是「签到得 800」
 *    + 右上角「额外 400」角标。相加会**虚高一倍**。
 * 4. **「今日已领」判据是 `is_today && status === 3`**，**不能**用
 *    「没有 Claimable」反推（与 Qoder「领取成功后列表仍非空」同型教训）。
 */

import {
  MINIMAX,
  MINIMAX_CREDIT_DETAILS_PATH,
  MINIMAX_REQUEST_TIMEOUT_MS,
  MINIMAX_SIGNIN_CLAIM_PATH,
  MINIMAX_SIGNIN_STATUS_PATH,
  type MinimaxProduct,
} from './minimax-product.js'
import { minimaxHeaders, type MinimaxCredential } from './minimax.js'
import { roundCredits, type CheckinStatus, type ClaimOutcome, type CreditBalance } from './credits.js'

/** 单日状态（asar `SigninDayStatus`）。 */
export const MINIMAX_SIGNIN_STATUS = Object.freeze({
  Upcoming: 1,
  Claimable: 2,
  Claimed: 3,
  Disabled: 4,
})

/** 领取结果（asar `SigninClaimResult`）。 */
export const MINIMAX_CLAIM_RESULT = Object.freeze({
  Claimed: 1,
  AlreadyClaimed: 2,
})

/** 面板场景（asar `SigninPanelScene`）。 */
export const MINIMAX_PANEL_SCENE = Object.freeze({
  Unknown: 0,
  First: 1,
  Active: 2,
  Completed: 3,
  Broken: 4,
})

/**
 * 常量表的**成员值数组**（供 `includes` 做成员合法性校验）。
 *
 * ⚠️ **不能直接写 `Object.values(MINIMAX_SIGNIN_STATUS).includes(x)`** ——
 * 因为字面量被 `Object.freeze` 收窄成 `1|2|3|4`，`Object.values` 的类型随之
 * 变成字面量联合数组，而 `x` 是 `number`，`tsc` 会报
 * `TS2345: Argument of type 'number' is not assignable to parameter of type '1|2|3|4'`
 * （实测。运行时都对，**只有类型不过**——`pnpm typecheck` 是硬门禁，必须修）。
 * 显式标注 `readonly number[]` 即可拓宽元素类型，判据与运行时行为**完全不变**。
 */
const MINIMAX_SIGNIN_STATUS_VALUES: readonly number[] = Object.values(MINIMAX_SIGNIN_STATUS)
const MINIMAX_PANEL_SCENE_VALUES: readonly number[] = Object.values(MINIMAX_PANEL_SCENE)

/** 归一后的单日条目。 */
export interface MinimaxSigninDay {
  dayNo: number
  points: number
  bonusPoints: number
  status: number
  isToday: boolean
}

/** 归一后的面板。 */
export interface MinimaxSigninPanel {
  scene: number
  days: readonly MinimaxSigninDay[]
}

/**
 * 取本机 IANA 时区名。
 *
 * 客户端就是这么取的（asar UI chunk 模块 39504）：
 * `Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"`。
 *
 * ⚠️ **与 Qoder 的口径不同**：Qoder 的额度标记**写死 UTC+8**（服务端按 UTC+8
 * 结算），而 MiniMax 的签到按**客户端上报的时区**结算。不得互相套用。
 */
export function resolveMinimaxTimezoneId(
  resolve: () => string = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  try {
    const zone = resolve()
    return typeof zone === 'string' && zone.trim().length > 0 ? zone.trim() : 'UTC'
  } catch {
    return 'UTC'
  }
}

/** 读有限数字；非法返回 undefined。 */
function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 解析**金额**：同时接受数字与字符串形态。
 *
 * ⚠️ 实测余额端点返回的是**字符串**（`remaining_amount: "800.00"`），
 * 而 `finiteNumber` 只认 `number` —— 用它会把 800 静默算成 0。
 * 上游既然用字符串规避浮点，我们就不该假设它哪天不变。
 *
 * 非有限 / 无法解析 ⇒ `undefined`（**不编造 0**，由调用方决定语义）。
 */
function looseAmount(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  // ⚠️ `Number('')` 是 0，会把「空字符串」误读成「0 积分」—— 先挡掉空串。
  if (trimmed === '') return undefined
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 解析签到面板（**完整复刻** asar `validateSigninPanel`）。
 *
 * 硬约束（不满足即返回 undefined，**不编造**）：
 * - `days` **恰好 7 条**
 * - 每条 `day_no` 是 1..7 整数且**无重复**
 * - `points` 非负有限；`bonus_points` 可选但非负有限
 * - `is_today` 是 **boolean**
 * - `status` ∈ {1,2,3,4}
 * - **最多 1 条 `Claimable`**、**最多 1 条 `is_today`**
 * - `scene` ∈ {0,1,2,3,4}
 */
export function parseMinimaxSigninPanel(data: unknown): MinimaxSigninPanel | undefined {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined
  const record = data as Record<string, unknown>
  const scene = finiteNumber(record.scene)
  if (scene === undefined || !MINIMAX_PANEL_SCENE_VALUES.includes(scene)) return undefined

  const rawDays = record.days
  if (!Array.isArray(rawDays) || rawDays.length !== 7) return undefined

  const days: MinimaxSigninDay[] = []
  const seen = new Set<number>()
  let claimable = 0
  let today = 0
  for (const raw of rawDays) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
    const day = raw as Record<string, unknown>
    const dayNo = finiteNumber(day.day_no)
    const points = finiteNumber(day.points)
    const status = finiteNumber(day.status)
    const bonusRaw = day.bonus_points
    const bonusPoints = bonusRaw === undefined ? 0 : finiteNumber(bonusRaw)
    if (dayNo === undefined || !Number.isInteger(dayNo) || dayNo < 1 || dayNo > 7) return undefined
    if (seen.has(dayNo)) return undefined
    if (points === undefined || points < 0) return undefined
    if (bonusPoints === undefined || bonusPoints < 0) return undefined
    if (typeof day.is_today !== 'boolean') return undefined
    if (status === undefined || !MINIMAX_SIGNIN_STATUS_VALUES.includes(status)) {
      return undefined
    }
    seen.add(dayNo)
    if (status === MINIMAX_SIGNIN_STATUS.Claimable) claimable++
    if (day.is_today) today++
    days.push({ dayNo, points, bonusPoints, status, isToday: day.is_today })
  }
  // ⚠️ 最多 1 条可领、最多 1 条今日（asar 的硬约束）
  if (claimable > 1 || today > 1) return undefined
  return { scene, days }
}

/**
 * 把面板映射成 DSH 的 {@link CheckinStatus}。
 *
 * ⚠️ **`dailyCredit = points`**（800），**不是** `points + bonus_points`（1200）。
 * 见文件头注释第 3 点。
 *
 * ⚠️ **`active` 恒 `true`** —— 拿到响应即 true，不按「有可领项」判。
 * 否则会把「今天已领」误报成「签到活动未开启」（Qoder 同型缺陷）。
 */
export function minimaxPanelToCheckinStatus(panel: MinimaxSigninPanel): CheckinStatus {
  const today = panel.days.find((day) => day.isToday)
  const claimedToday = today !== undefined && today.status === MINIMAX_SIGNIN_STATUS.Claimed
  // 连续天数：从今日起向前数连续 Claimed
  const sorted = [...panel.days].sort((a, b) => a.dayNo - b.dayNo)
  const todayIndex = sorted.findIndex((day) => day.isToday)
  let streakDays = 0
  if (todayIndex >= 0) {
    let index = sorted[todayIndex]?.status === MINIMAX_SIGNIN_STATUS.Claimed
      ? todayIndex
      : sorted[todayIndex]?.status === MINIMAX_SIGNIN_STATUS.Claimable
        ? todayIndex - 1
        : -1
    for (; index >= 0; index -= 1) {
      if (sorted[index]?.status !== MINIMAX_SIGNIN_STATUS.Claimed) break
      streakDays += 1
    }
  }
  const claimable = panel.days.find((day) => day.status === MINIMAX_SIGNIN_STATUS.Claimable)
  const target = today ?? claimable
  return {
    active: true,
    todayCheckedIn: claimedToday,
    streakDays,
    // ⚠️ points 就是总数，不相加 bonus_points
    dailyCredit: target?.points ?? 0,
    todayCredit: claimedToday ? (today?.points ?? 0) : 0,
    // ⚠️⚠️ **本字段当前不可判读，且几乎恒为 `true`**（2026-09-29 实测发现，
    // **未修复** —— 因为缺权威语义依据，不擅自改）。
    //
    // 实测本机 7 天面板：`bonus_points` 是 **800 档日 400 / 2000 档日 1000**，
    // **七天全都有值**。故 `bonusPoints > 0` 恒真，不携带任何信息 ——
    // 与 `credit/details` 那个 `total_count` 误读（见 `fetchMinimaxCreditBalance`）
    // 是**同一类缺陷形态**：拿一个「在已知样本上恰好符合预期」的字段当判据。
    //
    // 危害**目前为零**：`isStreakDay` 在 RPC（`computeClaimSummary` 只用
    // `credit`）与 Channel Pack UI 上**都没有消费者**（已全仓检索确认）。
    // 但语义仍是错的：`bonus_points` 看起来是「该日的额外奖励数额」，
    // **不是**「今天是连续奖励日」的布尔标志。
    //
    // 客户端权威实现（`.minimax-forensics/shared-dist/daily-signin.js`）里
    // **根本没有 `isStreakDay` 这个概念** —— 它只有 `getCurrentSigninStreak()`
    //（与我们的 `streakDays` 逐行一致）。故无法从客户端反推正确判据。
    // ⚠️ 要改先拿到 `bonus_points` 的权威语义（或真实「非连续日」样本），
    // **不要**凭猜测把它改成别的表达式。
    isStreakDay: (target?.bonusPoints ?? 0) > 0,
    totalCredits: 0,
    checkinDates: [],
    activityName: '',
    themeName: '',
    endTime: '',
  }
}

/** 一次请求的结果。 */
type EnvelopeResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; code: number; message: string }

/**
 * 取出业务载荷。
 *
 * ⚠️ **两个端点的响应形状不同，实测确认，不能一刀切**：
 * - `signin/status`、`signin/claim` 是**信封**：业务字段在 `data` 下；
 * - `credit/details` 是**平铺的**：`total_count` 与 `base_resp` **同级**
 *   （实测 `{ total_count: 0, base_resp: {...} }`，**没有** `data` 键）。
 *
 * 故这里「有 `data` 对象就用它，否则用顶层」—— 若强行只认 `data`，
 * 余额接口会把一个**合法响应**判成「响应缺少 data 字段」，
 * 于是「余额为 0」被报成查询失败（正是本任务要避免的那种误报）。
 */
function unwrapEnvelopeData(payload: Record<string, unknown>): Record<string, unknown> {
  const nested = payload.data
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? nested as Record<string, unknown>
    : payload
}

/**
 * 发一次请求并拆信封。
 *
 * ⚠️ **业务码在 `base_resp.status_code`**，且 `invalid timezone_id` 也是 HTTP 200
 * —— 只看 HTTP 状态码会把它当成成功。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理（批量领取时单账号失败不应中断其余账号）。
 */
async function requestEnvelope(
  url: string,
  credential: MinimaxCredential,
  init: { method: string; body?: string },
  fetcher: typeof fetch,
): Promise<EnvelopeResult> {
  try {
    // ⚠️ 必须传**真正的 `Headers` 实例**，不能 `{...headers}` 摊平成普通对象 ——
    // 后者会被 fetch 正常接受（看不出问题），但调用方拿到的 `.headers` 不再有
    // `.get()`，任何「断言某个头没被误设」的检查都会崩（写用例时实测到了）。
    const headers = minimaxHeaders(credential)
    if (init.body !== undefined) headers.set('Content-Type', 'application/json')
    const response = await fetcher(url, {
      method: init.method,
      headers,
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(MINIMAX_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      return {
        ok: false,
        code: response.status,
        message: response.status === 401 || response.status === 403
          ? `凭据已失效（HTTP ${response.status}），请重新登录该账号`
          : `服务端返回了非 JSON 响应（HTTP ${response.status}）`,
      }
    }
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, code: -1, message: '响应无法解析' }
    }
    const record = payload as Record<string, unknown>
    const baseResp = typeof record.base_resp === 'object' && record.base_resp !== null
      ? record.base_resp as Record<string, unknown>
      : {}
    const statusCode = finiteNumber(baseResp.status_code)
    const statusMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : ''
    if (statusCode !== undefined && statusCode !== 0) {
      return { ok: false, code: statusCode, message: statusMsg || `业务错误 ${statusCode}` }
    }
    return { ok: true, payload: record }
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 构造带 `timezone_id` 的 URL。 */
function withTimezone(
  base: string,
  path: string,
  timezoneId: string,
): string {
  const url = new URL(`${base}${path}`)
  url.searchParams.set('timezone_id', timezoneId)
  return url.toString()
}

/** 查询签到状态；失败返回 `null`（不抛错）。 */
export async function fetchMinimaxSigninStatus(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
): Promise<CheckinStatus | null> {
  const url = withTimezone(
    product.apiHost,
    MINIMAX_SIGNIN_STATUS_PATH,
    resolveMinimaxTimezoneId(),
  )
  const result = await requestEnvelope(url, credential, { method: 'GET' }, fetcher)
  if (!result.ok) return null
  const panel = parseMinimaxSigninPanel(unwrapEnvelopeData(result.payload))
  return panel === undefined ? null : minimaxPanelToCheckinStatus(panel)
}

/**
 * 领取每日签到。
 *
 * ⚠️ **幂等判据是 `claim_result`**（`1` = 本次真领取，`2` = 已领过），
 * **不是 HTTP 状态码**（重复领取同样 200）。
 *
 * ⚠️ 本函数**不抛错**（失败也返回 `failed`），保证批量领取不因单账号中断。
 */
export async function claimMinimaxDailyCheckin(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
): Promise<ClaimOutcome> {
  const url = withTimezone(
    product.apiHost,
    MINIMAX_SIGNIN_CLAIM_PATH,
    resolveMinimaxTimezoneId(),
  )
  const result = await requestEnvelope(url, credential, { method: 'POST', body: '{}' }, fetcher)
  if (!result.ok) {
    return { kind: 'failed', code: result.code, message: result.message }
  }
  const data = unwrapEnvelopeData(result.payload)
  const claimResult = finiteNumber(data.claim_result)

  // ⚠️ 幂等：重复领取返回 2（AlreadyClaimed）
  if (claimResult === MINIMAX_CLAIM_RESULT.AlreadyClaimed) {
    return { kind: 'already-claimed', message: '今日已签到' }
  }
  if (claimResult !== MINIMAX_CLAIM_RESULT.Claimed) {
    return { kind: 'failed', code: -1, message: '签到响应缺少有效的 claim_result' }
  }
  // ⚠️ credit 取 points（总数，已含 bonus_points）
  const points = finiteNumber(data.points) ?? 0
  const panel = parseMinimaxSigninPanel(data.panel)
  const status = panel === undefined ? undefined : minimaxPanelToCheckinStatus(panel)
  return {
    kind: 'claimed',
    credit: points,
    streakDays: status?.streakDays ?? 0,
    isStreakDay: status?.isStreakDay ?? false,
  }
}

/**
 * 查询积分余额。
 *
 * ## ⚠️ 一个已被生产数据推翻的字段误读（2026-09-29 修复）
 *
 * 初版把 `total_count` 当作**积分余额**。这是**错的** ——
 * `total_count` 是 `details[]` 的**记录条数**。
 *
 * 实测原始响应（本机账号领取 800 积分后）：
 * ```json
 * {"details":[{"remaining_amount":"800.00","consumed_amount":"0.00",
 *              "granted_amount":"800.00","credit_type":2,
 *              "granted_at_ms":1790645562328,"expire_at_ms":1793203200000}],
 *  "total_count":1,"base_resp":{"status_code":0,"status_msg":"ok"}}
 * ```
 * 真实余额是 `remaining_amount`（**800**），而 `total_count` 是 **1**。
 *
 * ⚠️ **为什么初版没被发现**：账号余额为 0 时 `details` **整个字段缺失**、
 * `total_count` 恰好也是 **0** —— 于是「条数 0」与「余额 0」在数值上
 * **偶然重合**，单测那条断言（`total_count: 0` → `total: 0`）因此成了
 * **同义反复**，无法暴露该误读。领取积分后才分叉（条数 1 / 余额 800）。
 *
 * ## 取值口径
 *
 * - **余额 = Σ `details[].remaining_amount`**（各有效包剩余之和，
 *   与既有 `CreditBalance.total` 的口径一致）。
 * - `remaining_amount` 实测是**字符串**（`"800.00"`），故需要宽容解析
 *   （数字与字符串都接受）—— 上游改型不该让余额整块失效。
 * - ⚠️ `details` 缺失/非数组 ⇒ 视为**空数组 ⇒ 余额 0**（「真的为 0」），
 *   **不是**「查询失败」。两者必须区分（`null` 才是失败）。
 * - ⚠️ `base_resp.status_code` 非 0 ⇒ `null`（真失败）。
 *
 * ⚠️ **`expiredTotal` 仍为 0**：`details[]` 里没有区分「本周期有效」的标志
 *（`credit_type` 的语义未实测），故**不凭猜测分类**。`packages` 同理留空 ——
 * 需要时再按实测补充，**不得**用 locale 文案反推字段名。
 */
export async function fetchMinimaxCreditBalance(
  credential: MinimaxCredential,
  fetcher: typeof fetch = fetch,
  product: MinimaxProduct = MINIMAX,
): Promise<CreditBalance | null> {
  const url = `${product.apiHost}${MINIMAX_CREDIT_DETAILS_PATH}`
  const result = await requestEnvelope(url, credential, { method: 'GET' }, fetcher)
  if (!result.ok) return null
  // ⚠️ 余额响应是**平铺**的（`details` / `total_count` 与 `base_resp` 同级，
  // 无 `data`）；`unwrapEnvelopeData` 对这种形状会原样返回顶层。
  const data = unwrapEnvelopeData(result.payload)
  // ⚠️ `base_resp.status_code` 由 `requestEnvelope` 判过，这里只需确认形状：
  // 若连 `details` 与 `total_count` 都没有，说明响应形状不对，不编造 0。
  const details = Array.isArray(data.details) ? data.details : undefined
  if (details === undefined && finiteNumber(data.total_count) === undefined) return null
  // ⚠️ 余额 = 各包 `remaining_amount` 之和；缺失 `details` ⇒ 0（真的为 0）。
  let total = 0
  for (const entry of details ?? []) {
    if (typeof entry !== 'object' || entry === null) continue
    const remaining = looseAmount((entry as Record<string, unknown>).remaining_amount)
    if (remaining !== undefined) total += remaining
  }
  return { total: roundCredits(total), packages: [], expiredTotal: 0 }
}
