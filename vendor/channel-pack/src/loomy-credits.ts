/**
 * Loomy 积分：余额查询（只读）与每日额度签到。
 *
 * ## 两个积分池（用户补充确认的机制）
 *
 * Loomy 的积分**分成两个池、分开计算**：
 * - **永久积分**：注册奖励 5000 + 新手任务 10000（`balance`）
 * - **每日赠送池**：每天 5000，**消耗后不回补**（`dailyBalance`）
 *
 * 实测（2026-09-26）：
 * ```
 * balance: 15000        ← 永久
 * dailyBalance: 4992    ← 每日池余额 = dailyQuota(5000) - dailyConsumed(8)
 * availableBalance: 19992  ← 两者之和
 * ```
 *
 * ## 每日额度由 `first-login` 发放
 *
 * 官方在**登录成功后立即调用** `POST /api/v1/points/first-login`
 * （渲染 bundle 的短信登录与微信登录两条路径都调，失败仅 warn）。
 * 响应返回完整账户快照：
 * ```
 * { alreadyProcessed, currentBalance, permanentBalance, dailyBalance,
 *   dailyQuota, dailyConsumed, dailyCycleDate, ... }
 * ```
 *
 * ⚠️ **`dailyQuota` 只在 `first-login` 的响应里**，`points/records` 不返回它。
 * 故未签到时该字段缺省 —— **不要硬编码 5000**（额度可能随活动变化）。
 *
 * ## 读与写严格分离
 *
 * | 动作 | 端点 | 性质 |
 * |---|---|---|
 * | 查余额 | `GET /points/records` | **只读**，无副作用 |
 * | 一键签到 | `POST /points/first-login` | 写，幂等 |
 *
 * 这样「打开面板」不会悄悄触发签到。
 */

import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'
import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  parseLoomyEnvelope,
  type LoomyCredential,
} from './loomy.js'
import type { LoomyProduct } from './loomy-product.js'

/** 「一键签到」的语义说明（供 UI 提示用，避免写成「+5000 积分」）。 */
export const LOOMY_DAILY_QUOTA_DESCRIPTION = '每日赠送额度（消耗后不回补）'

/** 两个积分池的明细。 */
export interface LoomyCreditDetail {
  /** 永久积分（`balance`）。 */
  permanent: number
  /** 每日赠送池余额（`dailyBalance`）。 */
  daily: number
  /** 永久 + 每日（`availableBalance`）。 */
  total: number
  /** 每日额度上限 —— **仅签到后可得**（`first-login` 专有字段）。 */
  dailyQuota?: number
  /** 今日已消耗 —— 仅签到后可得。 */
  dailyConsumed?: number
  /** 每日额度所属业务日（`YYYY-MM-DD`）—— 仅签到后可得。 */
  dailyCycleDate?: string
}

/** 发一次业务请求并拆信封；失败返回结构化错误（余额查询不抛错）。 */
async function tryRequestLoomy<T>(
  credential: LoomyCredential,
  product: LoomyProduct,
  path: string,
  init: { method: string; body?: unknown },
  fetcher: typeof fetch,
): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }> {
  const headers: Record<string, string> = { Accept: 'application/json', token: credential.access_token }
  let payload: string | undefined
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(init.body)
  }

  let response: Response
  try {
    response = await fetcher(`${product.apiBase}${path}`, {
      method: init.method,
      headers,
      ...payload === undefined ? {} : { body: payload },
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, code: 'NETWORK', message: error instanceof Error ? error.message : String(error) }
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return { ok: false, code: `HTTP_${response.status}`, message: `响应不是 JSON（HTTP ${response.status}）` }
  }

  const envelope = parseLoomyEnvelope<T>(parsed)
  if (!envelope.ok) {
    return { ok: false, code: envelope.code, message: envelope.message }
  }
  return { ok: true, data: envelope.data as T }
}

/** 把任意值读成有限数字；非法返回 undefined（不编造 0）。 */
function readNumber(value: unknown): number | undefined {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * 查询两个积分池的明细（**只读**）。
 *
 * ⚠️ 用 `points/records` 而不是 `first-login`：后者是**写**端点，
 * 在「打开面板」这种高频路径上调用会意外触发签到。
 *
 * @returns 查不到（凭据失效 / 响应异常）时返回 `null`，与「余额为 0」严格区分。
 */
export async function fetchLoomyCreditDetail(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyCreditDetail | null> {
  const result = await tryRequestLoomy<Record<string, unknown>>(
    credential, product,
    '/points/records?pageNo=1&pageSize=1&recordType=all',
    { method: 'GET' }, fetcher,
  )
  if (!result.ok) return null

  const permanent = readNumber(result.data?.balance)
  const daily = readNumber(result.data?.dailyBalance)
  const available = readNumber(result.data?.availableBalance)
  // `balance` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (permanent === undefined) return null

  const total = available ?? (permanent + (daily ?? 0))
  return {
    permanent,
    daily: daily ?? 0,
    total,
    dailyQuota: readNumber(result.data?.dailyQuota),
    dailyConsumed: readNumber(result.data?.dailyConsumed),
    dailyCycleDate: typeof result.data?.dailyCycleDate === 'string'
      ? result.data.dailyCycleDate
      : undefined,
  }
}

/** 构造一个资源包条目（两池各一个）。 */
function makePackage(name: string, remaining: number): CreditPackage {
  return {
    name,
    unit: '积分',
    remaining,
    total: remaining,
    used: 0,
    active: true,
    cycleStartTime: '',
    cycleEndTime: '',
    expiredTime: '',
  }
}

/**
 * 查询积分余额（映射成既有的 `CreditBalance` 形状，供 Channel Pack 账号卡片渲染）。
 *
 * ⚠️ **两个池各作一个 package**，让用户看出「永久」与「每日」是分开计算的
 * （用户明确要求的展示方式）。`total` 用 `availableBalance`（两者之和）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchLoomyCreditBalance(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const detail = await fetchLoomyCreditDetail(credential, product, fetcher)
  if (detail === null) return null
  return {
    total: detail.total,
    packages: [
      makePackage('永久积分', detail.permanent),
      makePackage('每日赠送', detail.daily),
    ],
    // 两池都视为有效额度，没有「已失效」概念。
    expiredTotal: 0,
  }
}

/**
 * 一键签到：触发每日赠送额度。
 *
 * ⚠️ **语义是「触发每日额度重置」，不是「+5000 积分」**：
 * `dailyBalance = dailyQuota - dailyConsumed`，消耗后不回补。
 * UI 文案必须准确（见 {@link LOOMY_DAILY_QUOTA_DESCRIPTION}）。
 *
 * ⚠️ 幂等判据是响应体的 `alreadyProcessed`（重复调用同样返回 HTTP 200），
 * 故已处理的情况映射成 `already-claimed` 而**不是** `claimed` ——
 * 后者会让用户以为每天都真的加了额度。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimLoomyDailyQuota(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const result = await tryRequestLoomy<Record<string, unknown>>(
    credential, product, '/points/first-login', { method: 'POST', body: {} }, fetcher,
  )

  if (!result.ok) {
    // 认证失效与其它失败都归为 failed：批量领取的调用方据 kind 计数，
    // 具体原因由 message 携带（100002 的文案已含「请重新登录」）。
    return { kind: 'failed', code: -1, message: result.message }
  }

  const dailyQuota = readNumber(result.data?.dailyQuota)
  const dailyBalance = readNumber(result.data?.dailyBalance)
  const alreadyProcessed = result.data?.alreadyProcessed === true

  if (alreadyProcessed) {
    return {
      kind: 'already-claimed',
      message: dailyQuota === undefined
        ? '今日额度已初始化'
        : `今日额度已初始化（每日 ${dailyBalance ?? 0}/${dailyQuota}）`,
    }
  }

  // 首次处理：`credit` 表示**本次新发放的额度**。服务端不直接给这个差值，
  // 故用 dailyQuota - dailyConsumed 推算；两者都缺时回 0（不编造）。
  const dailyConsumed = readNumber(result.data?.dailyConsumed)
  const granted = dailyQuota !== undefined && dailyConsumed !== undefined
    ? Math.max(0, dailyQuota - dailyConsumed)
    : (dailyQuota ?? 0)

  return { kind: 'claimed', credit: granted, streakDays: 0, isStreakDay: false }
}
