/**
 * Cline 积分余额查询。
 *
 * ## 端点（实测 2026-09-25，真实凭据）
 *
 * ```
 * GET {apiBase}/api/v1/users/{userId}/balance
 * Authorization: Bearer workos:<jwt>       ← ⚠️ 前缀必须保留
 * HTTP-Referer / X-Title / X-IS-MULTIROOT / X-CLIENT-TYPE
 *
 * → { "data": { "userId": "usr-01M3BCV4FYCGJKAWD3MJG3DBQM", "balance": 500000 },
 *     "success": true }
 * ```
 *
 * ⚠️ **`userId` 用凭据里的 `account_id`，不是 JWT 的 `sub`**：
 * 实测传 `sub`（`user_01M3BCQ86DV4S9KKBT85X4GKTV`）返回
 * `400 {"error":"Invalid request format"}`。两者形态完全不同
 * （`usr-…` vs `user_…`），极易混用。
 *
 * ⚠️ **`Authorization` 必须原样带 `workos:` 前缀**（见 `src/cline.ts`
 * 的 `clineBearerValue` 注释）：剥掉即 401，且报错文案是
 * "make sure you're using the latest version of Cline" —— 与真实原因
 * 毫不相干，会让人误判成「版本过旧」。
 *
 * ## ⚠️ 余额单位不确定
 *
 * 实测 `balance: 500000`。合理推测是 **micro-USD**（÷100000 → $5.00，
 * 量级），但**没有源码证据** —— `balance` 在 sidecar 里只出现在
 * zod schema（`z.string()`）与 redaction 关键词表中，没有任何换算点。
 *
 * 故这里把换算系数收敛为**单个具名常量** {@link CLINE_BALANCE_SCALE}，
 * 并把原始值一并返回（{@link ClineBalanceResult.rawBalance}），
 * 便于只读 e2e 探针打印核对；若实测不符，改这一个常数即可。
 *
 * ⚠️ **不要用 `/usages` 的 `costUsd` 反推本系数**：实测同账号
 *
 * ```json
 * { "creditsUsed": 0, "costUsd": 1320, "totalTokens": 49,
 *   "aiModelTypeName": "cline-free", "aiModelName": "Deepseek-v4.1-Flash" }
 * ```
 *
 * 按本系数（1e-5）解释，1320 会是 $0.0132 / 49 token ≈ **$269 / 1M token**，
 * 对一个 flash 档模型显然不合理；按 1e-8 解释则约 $0.27 / 1M，才与档位吻合。
 * 说明两个字段**口径不同**，不可互推。
 *
 * ## 签到：**不存在**
 *
 * 对整个 sidecar 做字符串扫描，`checkin` / `check-in` / `daily` / `campaign`
 * 均无任何 Cline 业务端点命中（`campaign` 的命中是 PostHog 的 UTM 参数与
 * feature-flag 事件属性；`daily` 是 YAML cron 别名与 Blob 导出频率枚举）。
 */

import { roundCredits, type CreditBalance, type CreditPackage } from './credits.js'
import { clineAuthHeaders, type ClineCredential } from './cline.js'
import type { ClineProduct } from './cline-product.js'

/** 单次余额请求超时（毫秒；对齐源码 `DEFAULT_TIMEOUT_MS3 = 30000`）。 */
export const CLINE_CREDITS_TIMEOUT_MS = 30_000

/**
 * 原始 `balance` 到「积分」的换算系数。
 *
 * ⚠️ **这是全模块唯一的不确定点**。实测 `balance: 500000`；
 * 按 1e-5 USD 解释则 ÷100000 = **$5.00** —— 与 Cline 公开的新账号赠额
 * 量级一致，这是选取本值的依据（独立锚点，不是从 `costUsd` 推的，
 * 理由见模块头注释）。
 *
 * 若核对后发现单位不同，**只改这个常数**，不要在别处再写换算。
 *
 * 注意 `CreditBalance.total` 的口径是「积分/额度」而非「美元」，
 * 这里保留原始数值本身（不做美元换算）以免与其它 provider 的
 * 展示口径混淆 —— 系数仅用于把 1e-5 单位还原为「元」量级。
 */
export const CLINE_BALANCE_SCALE = 100_000

/** 余额查询结果。 */
export interface ClineBalanceResult {
  /** 归一化后的余额（已按 {@link CLINE_BALANCE_SCALE} 换算）。 */
  balance: CreditBalance | null
  /** 服务端原始数值（供只读探针核对单位；不参与 UI 展示）。 */
  rawBalance?: number
  /** 失败原因（成功时为 undefined）。 */
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

/**
 * 把原始余额包成既有的 `CreditBalance` 形状。
 *
 * UI 契约（`plugin-src/client/channel-pack.js` 的 `CreditBalanceRow`）要求
 * `{ total, packages, expiredTotal }`。Cline 的余额是**单一数字**，
 * 没有资源包概念，故 `packages` 只放一个汇总条目 —— 这样 tooltip
 * 里仍能显示「余额」一行，而不是空白。
 */
export function toClineCreditBalance(rawBalance: number): CreditBalance {
  const total = roundCredits(rawBalance / CLINE_BALANCE_SCALE)
  const pkg: CreditPackage = {
    name: 'Cline 账户余额',
    unit: 'USD',
    remaining: total,
    total,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
  return { total, packages: [pkg], expiredTotal: 0 }
}

/**
 * 解析余额响应。
 *
 * 判据：`success === true` 且 `data.balance` 为有限数值。
 * ⚠️ 不把「查不到」显示成 0（那是「已用光」的语义）—— 返回 null，
 * 由调用方带上原因（与其余五个 provider 同约定）。
 *
 * ⚠️ **失败形态有两种，必须都认**（真实缺陷）：
 * - `{success:false, error:"…"}`（业务层失败，HTTP 200）；
 * - `{error:"Unauthorized: …"}`（网关层失败，HTTP 401 —— **没有 `success` 字段**）。
 *
 * 早期只判第一种，于是 401 会落到「响应缺少 data 字段」这个**误导性**文案，
 * 而服务端真正给的原因（"Please make sure you're using the latest version of
 * Cline and re-authenticate your Cline account."）被丢掉 —— 那正是排查
 * 鉴权问题唯一有用的线索。
 */
export function parseClineBalanceResponse(value: unknown): { rawBalance?: number; error?: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { error: '响应不是 JSON 对象' }
  }
  const record = value as Record<string, unknown>
  // 先看服务端给的 error 文案：HTTP 401 的响应体没有 `success` 字段，
  // 只在 `error` 里说明原因（见上方注释）。
  const serverError = typeof record.error === 'string' && record.error.trim().length > 0
    ? record.error.trim()
    : undefined
  if (record.success === false || (serverError !== undefined && record.success !== true)) {
    return { error: serverError ?? '服务端返回失败' }
  }
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  if (data === undefined) return { error: '响应缺少 data 字段' }
  const rawBalance = readNumber(data, 'balance')
  if (rawBalance === undefined) return { error: '响应缺少 balance 字段' }
  return { rawBalance }
}

/**
 * 查询单个账号的积分余额。
 *
 * 返回 `null` 表示**查不到**（凭据失效、响应异常等），由调用方决定展示文案；
 * 不抛错 —— 余额查询失败不应让账号卡片整体不可用。
 */
export async function fetchClineCreditBalance(
  credential: ClineCredential,
  product: ClineProduct,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal } = {},
): Promise<ClineBalanceResult> {
  // ⚠️ 必须用 account_id（`usr-…`），不是 JWT 的 sub（`user_…`）。
  const userId = credential.account_id
  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return { balance: null, error: '凭据缺少账号 id，无法查询余额' }
  }
  const url = `${product.apiBase}/api/v1/users/${encodeURIComponent(userId.trim())}/balance`
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'GET',
      headers: clineAuthHeaders(credential.access_token, product),
      signal: options.signal ?? AbortSignal.timeout(CLINE_CREDITS_TIMEOUT_MS),
    })
  } catch (error) {
    return { balance: null, error: `余额查询网络失败：${error instanceof Error ? error.message : String(error)}` }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { balance: null, error: `余额响应不是 JSON（HTTP ${response.status}）` }
  }

  if (!response.ok) {
    const detail = parseClineBalanceResponse(parsed)
    return {
      balance: null,
      error: detail.error !== undefined
        ? `余额查询失败（HTTP ${response.status}）：${detail.error}`
        : `余额查询失败（HTTP ${response.status}）`,
    }
  }

  const result = parseClineBalanceResponse(parsed)
  if (result.rawBalance === undefined) {
    return { balance: null, ...result.error === undefined ? {} : { error: result.error } }
  }
  return {
    balance: toClineCreditBalance(result.rawBalance),
    rawBalance: result.rawBalance,
  }
}
