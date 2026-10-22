/**
 * Cline **订阅额度**（官方额度窗口）。
 *
 * 与 `src/cline-credits.ts`（余额）分开成模块：余额是「还剩多少钱」，
 * 订阅额度是「这几个时间窗各用掉了百分之几」，两者端点、形状、失败语义
 * 都不同，混在一个文件里会让各自的判据互相干扰。
 *
 * ⚠️ **请求记录不在这里** —— 它是 `src/cline-request-log.ts` 的**本地流水**
 * （本插件自己发出的每笔推理请求，含延迟与首块时间；参考实现
 * `github.com/codeOct/dsh-cline-pass` 的请求记录部分同源）。网关的
 * `/users/{id}/usages` 记的是**该账号在官方所有渠道**的消费流水：
 * 没有延迟/首块时间、语义是「官方账单」而非「本插件发出的请求」，
 * 故不采用（表格字段也对不齐参考实现）。
 *
 * ## 端点（参考 `github.com/codeOct/dsh-cline-pass` 的额度管理实现）
 *
 * ```
 * GET {apiBase}/api/v1/users/me/plan/usage-limits
 *   → { success: true, data: { limits: [{ type, percentUsed, resetsAt }] } }
 *      type ∈ five_hour | weekly | monthly          ← 订阅额度窗口
 * ```
 *
 * ## ⚠️ 实测踩过的坑（2026-09-29 已实发核对，不要重新踩）
 *
 * 1. **`resetsAt` 是 ISO 字符串且带纳秒精度**（9 位小数，如
 *    `2026-09-29T15:41:02.244817775Z`）—— 不要按毫秒去 `new Date()`，
 *    也不要截断小数（会掩盖上游改动）。
 * 2. **用量为 0 的窗口 `resetsAt` 是空串** —— 客户端据此不渲染那一行。
 * 3. **额度端点用字面量 `users/me`**，由网关按 Bearer 令牌判定账号，
 *    不依赖凭据里的 `account_id`；请求记录端点才需要 `account_id`（`usr-…`）。
 *
 * ## 失败一律「作为数据上报」，不抛错
 *
 * 额度是**附加信息**：面板上的账号管理、模型开关、登录等功能不依赖它。
 * 因此读取失败必须降级成一条可读原因（含 HTTP 状态与响应体摘要），
 * 而不是让整个面板挂掉 —— 与 `fetchClineCreditBalance` 同约定。
 *
 * ## ⚠️ 不把「查不到」显示成 0
 *
 * `percentUsed: 0` 是「这个窗口一点没用」的合法语义。查询失败必须以
 * `ok: false` + `error` 表达，由调用方显示原因 —— 把失败渲染成 0% 会让用户
 * 以为自己额度充足（与其余 provider「查不到不显示成 0」的约定一致）。
 */

import { clineAuthHeaders, type ClineCredential } from './cline.js'
import type { ClineProduct } from './cline-product.js'

/** 单次额度请求超时（毫秒；与余额同档）。 */
export const CLINE_QUOTA_TIMEOUT_MS = 30_000

/**
 * 订阅额度窗口端点。
 *
 * ⚠️ 路径段是 `users/me`（**字面量 `me`**，不是账号 id）—— 由网关按 Bearer
 * 令牌自行判定账号。故本端点**不要求**凭据里有 `account_id`，这让
 * 「凭据缺 account_id」的账号也仍能看到额度。
 */
export const CLINE_USAGE_LIMITS_PATH = '/api/v1/users/me/plan/usage-limits'

/** 一个额度窗口。 */
export interface ClineQuotaWindow {
  /** 窗口类型：`five_hour` / `weekly` / `monthly`（网关新增的类型原样透传）。 */
  type: string
  /** 已用百分比（网关原值，0–100 之外的值也如实透传，不在解析层夹取）。 */
  percentUsed: number
  /** 窗口重置时刻（**ISO 字符串**，可能为空串）。 */
  resetsAt: string
}

/** 额度查询结果。 */
export interface ClineQuotaResult {
  ok: boolean
  windows: ClineQuotaWindow[]
  /** 失败原因；成功但网关附带文案时也可能有值。 */
  error?: string
}

/** 从响应里读数值型字段（同时接受数字与数字字符串）。 */
function readNumber(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 从响应里读非空字符串字段。 */
function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** 网关自己的一句话解释（`error` 可能是字符串或 `{message}`）。 */
function firstMessage(envelope: unknown): string {
  if (typeof envelope !== 'object' || envelope === null) return ''
  const record = envelope as Record<string, unknown>
  if (typeof record.error === 'string' && record.error.trim().length > 0) return record.error.trim()
  if (typeof record.message === 'string' && record.message.trim().length > 0) return record.message.trim()
  const nested = record.error
  if (typeof nested === 'object' && nested !== null) {
    const inner = (nested as Record<string, unknown>).message
    if (typeof inner === 'string' && inner.trim().length > 0) return inner.trim()
  }
  return ''
}

/**
 * 解包 `{ success, data }` 信封。
 *
 * ⚠️ **信封不是契约**：同族的余额端点实测有两种失败形态
 * （业务层 `{success:false,error}` / 网关层 `{error}` **没有 `success`**），
 * 故这里只在**确实有 `data` 对象**时取它，否则把顶层当作载荷本身 ——
 * 这样网关某天直接回数组/裸对象时仍能解析。
 */
function unwrapData(envelope: unknown): Record<string, unknown> | undefined {
  if (typeof envelope !== 'object' || envelope === null) return undefined
  const record = envelope as Record<string, unknown>
  const data = record.data
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return data as Record<string, unknown>
  }
  return record
}

/**
 * 解析订阅额度响应。
 *
 * ⚠️ **窗口列表按网关给的原序透传，不映射到固定形状**：网关将来新增窗口
 * （例如 `daily`）时，面板多一行即可，**不需要**为它发一个插件版本。
 * 这正是把 `type` 当字符串而非联合类型的原因。
 *
 * ⚠️ **`percentUsed` 不做夹取**：网关若给 120（超额），如实透传 ——
 * 夹到 100 会把「已超限」显示成「刚好用完」，那正是最该看见的信息。
 */
export function parseClineUsageLimits(value: unknown): { windows: ClineQuotaWindow[]; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { windows: [], error: '响应不是 JSON 对象' }
  }
  const record = value as Record<string, unknown>
  // 失败形态优先：`success:false` 或带 `error` 且未声明成功。
  const serverError = firstMessage(record)
  if (record.success === false || (serverError !== '' && record.success !== true)) {
    return { windows: [], error: serverError !== '' ? serverError : '服务端返回失败' }
  }
  const payload = unwrapData(record)
  if (payload === undefined) return { windows: [], error: '响应缺少 data 字段' }
  const raw = payload.limits
  if (!Array.isArray(raw)) return { windows: [], error: '响应缺少 limits 字段' }
  const windows: ClineQuotaWindow[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue
    const entry = item as Record<string, unknown>
    const type = readString(entry, 'type')
    // 没有 type 的行无法归属到任何窗口，丢弃比显示一行"未知窗口"更有用。
    if (type === undefined) continue
    windows.push({
      type,
      percentUsed: readNumber(entry, 'percentUsed') ?? 0,
      // ⚠️ `resetsAt` 是 ISO 字符串。若网关某天回数字时间戳，也不要在这里
      // 猜单位（秒/毫秒），原样转成字符串交由展示层判定 —— 猜错会显示
      // 1970 年或 5 万年后的时间，比不显示更难排查。
      resetsAt: readString(entry, 'resetsAt') ?? '',
    })
  }
  return { windows, error: serverError === '' ? undefined : serverError }
}

/**
 * 读取单个账号的**订阅额度窗口**。
 *
 * 失败作为数据返回（`ok:false` + `error`），不抛错。
 */
export async function fetchClineUsageLimits(
  credential: ClineCredential,
  product: ClineProduct,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ClineQuotaResult> {
  const refusal = { ok: false, windows: [], error: '额度端点不可用' }
  const url = `${product.apiBase}${CLINE_USAGE_LIMITS_PATH}`
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: clineAuthHeaders(credential.access_token, product),
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? CLINE_QUOTA_TIMEOUT_MS),
    })
  } catch (error) {
    return { ...refusal, error: `额度查询网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let text = ''
  try {
    text = await response.text()
  } catch (error) {
    return { ...refusal, error: `额度响应读取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  let parsed: unknown = null
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = null
    }
  }
  if (parsed === null) {
    // ⚠️ 网关出错时可能回 HTML（`Unexpected token '<'` 那类），把前缀带上
    // 才有线索 —— 本仓库已有过一次「HTML 错误页被当成 JSON 解析失败」的报障。
    return { ...refusal, error: `额度响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 120)}` }
  }
  if (!response.ok) {
    const detail = firstMessage(parsed)
    return {
      ...refusal,
      error: `额度查询失败（HTTP ${response.status}）${detail === '' ? '' : `：${detail}`}`,
    }
  }
  const result = parseClineUsageLimits(parsed)
  if (result.error !== undefined && result.windows.length === 0) {
    return { ok: false, windows: [], error: result.error }
  }
  return { ok: true, windows: result.windows, ...result.error === undefined ? {} : { error: result.error } }
}
