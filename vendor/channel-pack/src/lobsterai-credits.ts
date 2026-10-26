/**
 * LobsterAI（有道龙虾）每日签到与积分余额。
 *
 * ## 协议（三步，来源 `lobsterai2api/sigin.py:51-67`）
 *
 * ```
 * 0) 版本号（必填参数）：GET {clientVersionApi} → data.value.version
 * 1) 查活动槽位  GET  /api/client-activities/slot?placement=…&clientVersion=…
 * 2) 查活动上下文 GET  /api/client-activities/{activityCode}/context?configRevision=…
 * 3) 签到        POST /api/client-activities/{activityCode}/actions/check_in
 * ```
 *
 * ## 幂等
 */

import { randomUUID } from 'node:crypto'
import { LOBSTERAI_REQUEST_TIMEOUT_MS, parseLobsteraiEnvelope } from './lobsterai.js'
import { lobsteraiAuthHeaders, type LobsteraiCredential } from './lobsterai.js'
import type { LobsteraiProduct } from './lobsterai-product.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 活动槽位查询端点。 */
export const LOBSTERAI_ACTIVITY_SLOT_PATH = '/api/client-activities/slot'
/** 活动上下文查询端点（需拼 activityCode）。 */
export const LOBSTERAI_ACTIVITY_CONTEXT_PATH = '/api/client-activities'
/** 积分余额端点。 */
export const LOBSTERAI_PROFILE_SUMMARY_PATH = '/api/user/profile-summary'

/**
 * 槽位查询的三个固定 query 参数（**照抄 `sigin.py:52-53`**）。
 *
 * 这些值是用真实客户端观察到的：`placement=desktop_sidebar` 声明「桌面端侧边栏」
 * 这一投放位，`containerApiVersion=2` 是容器协议版本，`platform=win32` 是
 * **伪装客户端形态** —— 即使本插件跑在 macOS/Linux 上也照发 win32，
 * 它与运行环境无关，改了可能拿不到活动。
 */
export const LOBSTERAI_SLOT_PLACEMENT = 'desktop_sidebar'
export const LOBSTERAI_SLOT_CONTAINER_API_VERSION = '2'
export const LOBSTERAI_SLOT_PLATFORM = 'win32'

/** 活动槽位（`slot` 接口的 `data`）。 */
export interface LobsteraiActivitySlot {
  /** 槽位状态；只有 `'available'` 时才应继续。 */
  slotState: string
  /** 活动编码；缺失时无法继续。 */
  activityCode: string
  /** 配置修订号；后续两步都要回传。 */
  configRevision: number
}

/** 活动上下文（`context` 接口的 `data`）。 */
export interface LobsteraiActivityContext {
  /** 今天是否已领取。 */
  claimedToday: boolean
  /** 可用动作列表；不含 `'check_in'` 时不应尝试签到。 */
  actions: string[]
}

/** 一次请求的解析结果（与 `credits.ts` 的 `PostResult` 同构）。 */
type PostResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string }

/** 响应体可解析为对象、但缺少必要字段时的统一失败说明。 */
const UNPARSABLE_RESPONSE_MESSAGE = '请求失败或响应无法解析'

/**
 * 发起一次带认证的请求并解析 JSON。
 *
 * 网络失败时**保留原始错误消息**（含 timeout / socket hang up），
 * 不吞掉诊断信息 —— 这是 `credits.ts` 里已验证的做法。
 */
/**
 * 发起一次带认证的请求并解析 JSON。
 *
 * 网络失败时**保留原始错误消息**（含 timeout / socket hang up），
 * 不吞掉诊断信息 —— 这是 `credits.ts` 里已验证的做法。
 *
 * ⚠️ 与 `credits.ts` 的 `postJson` 同款：**不用 `response.json()`**。
 * 凭据失效时服务端可能返回 HTML 错误页，`json()` 抛出的
 * `Unexpected token '<' ...` 对用户毫无意义；先取文本再解析，
 * 非 JSON 时给出带状态码的可读原因。
 */
async function requestJson(
  url: string,
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  fetcher: typeof fetch,
  init: { method: 'GET' | 'POST'; body?: string } = { method: 'GET' },
): Promise<PostResult> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: lobsteraiAuthHeaders(credential, product),
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(LOBSTERAI_REQUEST_TIMEOUT_MS),
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, message: describeNonJsonResponse(response.status, text) }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, message: UNPARSABLE_RESPONSE_MESSAGE }
    }
    return { ok: true, body: parsed as Record<string, unknown> }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** 把「响应不是 JSON」整理成可读原因（与 `credits.ts` 同款）。 */
function describeNonJsonResponse(status: number, text: string): string {
  if (status === 401 || status === 403) {
    return `凭据已失效（HTTP ${status}），请重新登录该账号`
  }
  const snippet = text.trim().slice(0, 80).replace(/\s+/g, ' ')
  return `服务端返回了非 JSON 响应（HTTP ${status}）：${snippet}`
}

/** 从 JSON 安全读取布尔值。 */
function readBool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

/** 从 JSON 安全读取数字（兼容字符串形态）。 */
function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value)
  return 0
}

/** 从 JSON 安全读取非空数组。 */
function readActions(source: Record<string, unknown>, key: string): string[] {
  const value = source[key]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

/**
 * 查询当前活动槽位。
 *
 * 返回 `null` 表示查询失败（网络/信封/结构问题），与「无可用活动」
 * （返回 `slotState !== 'available'` 的对象）**严格区分** —— 前者是异常、
 * 后者是正常业务状态，UI 文案不同。
 */
export async function fetchLobsteraiActivitySlot(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  clientVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<LobsteraiActivitySlot | null> {
  const query = new URLSearchParams({
    placement: LOBSTERAI_SLOT_PLACEMENT,
    clientVersion,
    containerApiVersion: LOBSTERAI_SLOT_CONTAINER_API_VERSION,
    platform: LOBSTERAI_SLOT_PLATFORM,
  })
  const result = await requestJson(
    `${product.apiBase}${LOBSTERAI_ACTIVITY_SLOT_PATH}?${query.toString()}`,
    credential, product, fetcher,
  )
  if (!result.ok) return null
  const envelope = parseLobsteraiEnvelope(result.body)
  if (!envelope.ok) return null
  const activity = typeof envelope.data.activity === 'object' && envelope.data.activity !== null
    ? envelope.data.activity as Record<string, unknown>
    : {}
  const activityCode = typeof activity.activityCode === 'string' ? activity.activityCode : ''
  return {
    slotState: typeof envelope.data.slotState === 'string' ? envelope.data.slotState : '',
    activityCode,
    configRevision: readNumber(activity, 'configRevision'),
  }
}

/**
 * 查询活动上下文（今天领了没、有哪些可用动作）。
 *
 * 返回 `null` 表示查询失败。
 */
export async function fetchLobsteraiActivityContext(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  slot: LobsteraiActivitySlot,
  fetcher: typeof fetch = fetch,
): Promise<LobsteraiActivityContext | null> {
  const query = new URLSearchParams({ configRevision: String(slot.configRevision) })
  const url = `${product.apiBase}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/context?${query.toString()}`
  const result = await requestJson(url, credential, product, fetcher)
  if (!result.ok) return null
  const envelope = parseLobsteraiEnvelope(result.body)
  if (!envelope.ok) return null
  const state = typeof envelope.data.state === 'object' && envelope.data.state !== null
    ? envelope.data.state as Record<string, unknown>
    : {}
  return {
    claimedToday: readBool(state, 'claimedToday'),
    actions: readActions(envelope.data, 'actions'),
  }
}

/**
 * 执行每日签到领取。
 *
 * 完整三步流程，返回与 `credits.ts` 同构的 {@link ClaimOutcome}
 * 判别联合 —— 这样 `computeClaimSummary` 与 Channel Pack 的结果摘要 UI 无需改动。
 *
 * 判定顺序（把「业务正常状态」与「真失败」严格分开）：
 * 1. 槽位查询失败 → `failed`；
 * 2. `slotState !== 'available'` 或无 activityCode → `inactive`；
 * 3. 上下文查询失败 → `failed`；
 * 4. `claimedToday` → `already-claimed`；
 * 5. `actions` 不含 `check_in` → `inactive`；
 * 6. 领取请求失败 / 信封异常 → `failed`；
 * 7. 成功 → `claimed`（积分取三级回退链）。
 */
export async function claimLobsteraiDailyCheckin(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  clientVersion: string,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const slot = await fetchLobsteraiActivitySlot(credential, product, clientVersion, fetcher)
  if (slot === null) {
    return { kind: 'failed', code: -1, message: '活动槽位查询失败' }
  }
  if (slot.slotState !== 'available' || slot.activityCode.length === 0) {
    return { kind: 'inactive', message: `无可用活动（slotState=${slot.slotState}）` }
  }

  const context = await fetchLobsteraiActivityContext(credential, product, slot, fetcher)
  if (context === null) {
    return { kind: 'failed', code: -1, message: '活动上下文查询失败' }
  }
  if (context.claimedToday) {
    return { kind: 'already-claimed', message: '今天已签到' }
  }
  if (!context.actions.includes('check_in')) {
    // 活动存在但当前不可签到（未开始 / 已结束 / 无资格）。
    // 与「今天已领」区分开：前者用户无需动作，后者也只是提示。
    return { kind: 'inactive', message: '当前不可签到' }
  }

  const url = `${product.apiBase}${LOBSTERAI_ACTIVITY_CONTEXT_PATH}/${encodeURIComponent(slot.activityCode)}/actions/check_in`
  const result = await requestJson(url, credential, product, fetcher, {
    method: 'POST',
    body: JSON.stringify({
      configRevision: slot.configRevision,
      // 客户端幂等键（对齐 sigin.py:63 的 uuid4）：服务端据此去重。
      idempotencyKey: randomUUID(),
      payload: {},
    }),
  })
  if (!result.ok) {
    return { kind: 'failed', code: -1, message: result.message }
  }
  const envelope = parseLobsteraiEnvelope(result.body)
  if (!envelope.ok) {
    return { kind: 'failed', code: envelope.code, message: envelope.message }
  }
  // 积分字段三级回退（对齐 sigin.py:65-66）：
  // creditsGranted → rewardCredits → credits。不同活动/版本用不同字段名。
  const bodyResult = typeof envelope.data.result === 'object' && envelope.data.result !== null
    ? envelope.data.result as Record<string, unknown>
    : {}
  const credit = ['creditsGranted', 'rewardCredits', 'credits']
    .map((key) => bodyResult[key])
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value)) ?? 0
  const message = typeof bodyResult.message === 'string' ? bodyResult.message : ''
  return {
    kind: 'claimed',
    credit,

    streakDays: 0,
    isStreakDay: false,
    ...message.length > 0 ? { delayedMessage: message } : {},
  }
}

/**
 * 查询账号积分余额。
 *
 * 端点用 `profile-summary` 而非 `quota`（`client.go:282-283` 的注释）：
 * `/api/user/quota` 只显示 `freeCreditsTotal=300`，**不含活动积分**
 * （实测某账号 profile-summary 有 5297.72，quota 只有 300）。
 *
 * 返回 `null` 表示**查不到**（网络/信封问题），与「余额为 0」严格区分 ——
 * 失败时 UI 应显示原因而不是 0。
 *
 * 结构对齐 `credits.ts` 的 {@link CreditBalance}，让 `CreditBalanceRow`
 * 组件能直接复用：`creditItems[]` → `packages[]`，`totalCreditsRemaining` → `total`。
 */
export async function fetchLobsteraiCreditBalance(
  credential: LobsteraiCredential,
  product: LobsteraiProduct,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const result = await requestJson(
    `${product.apiBase}${LOBSTERAI_PROFILE_SUMMARY_PATH}`, credential, product, fetcher,
  )
  if (!result.ok) return null
  const envelope = parseLobsteraiEnvelope(result.body)
  if (!envelope.ok) return null

  const packages: CreditPackage[] = []
  const items = envelope.data.creditItems
  if (Array.isArray(items)) {
    for (const item of items) {
      if (typeof item !== 'object' || item === null) continue
      const record = item as Record<string, unknown>
      const remaining = readNumber(record, 'creditsRemaining')
      const type = typeof record.type === 'string' ? record.type : ''
      const label = typeof record.label === 'string' ? record.label : ''
      const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : ''
      // 到期时间归一化到 deductionEndTime（毫秒时间戳）：
      // LobsterAI 的 expiresAt 实测是 ISO 8601（"2026-10-23T01:21:23"），
      // Date.parse 原生支持；`replace(' ', 'T')` 兼容旧格式（空格分隔）。
      // 归一化后前端 splitCreditsByExpiry / formatPackageTooltip 统一处理，
      // 不需要按 provider 特判。
      const expMs = expiresAt.length > 0
        ? Date.parse(expiresAt.replace(' ', 'T'))
        : Number.NaN
      packages.push({
        // ⚠️ 包名用 `label`（实测"每日登录奖励"）而不是 `type`（"campaign"）：
        // type 是机器分类码，label 才是人看的名字。label 缺失时回退 type，
        // 再回退「积分包」（老用例锁死的形态）。
        name: label.length > 0 ? label : (type.length > 0 ? type : '积分包'),
        unit: 'credit',
        remaining,
        // LobsterAI 只下发剩余量，不区分「周期总额/已用」。
        // 用 remaining 充当 total 会让「剩余/总额」显示成 1:1；
        // 这里如实置 0，UI 的 `formatPackageLine` 对 0 会显示 '?'（不误导）。
        total: 0,
        used: 0,
        // 无 Status 字段可依据：有 expiresAt 且已过期才算失效。
        active: !(expiresAt.length > 0 && Number.isFinite(Date.parse(expiresAt.replace(' ', 'T')))
          && Date.now() >= Date.parse(expiresAt.replace(' ', 'T'))),
        cycleStartTime: '',
        cycleEndTime: '',
        expiredTime: expiresAt,
        ...(Number.isFinite(expMs) ? { deductionEndTime: expMs } : {}),
      })
    }
  }

  // 面值推断（用户期望显示 100/100，而不是 100/0）：服务端**没有**面值字段
  // （实测响应只有 creditsRemaining + expiresAt），但同组包的面值恒定 ——
  // 「每日登录奖励」每天发 100，没用过的包剩余量就等于面值。
  // 取「同组（label/type 相同）有效包的剩余量最大值」当面值：6 个没用过的包
  // max=100 → 全部显示 100/100；被用过的包（92.73）也按同组面值 100 显示
  // 92.73/100。⚠️ 只对有效包推断 —— 失效包可能当初面值不同，宁可显示 ?。
  const faceValueByGroup = new Map<string, number>()
  for (const pkg of packages) {
    if (!pkg.active) continue
    const key = pkg.name
    const cur = faceValueByGroup.get(key) ?? 0
    if (pkg.remaining > cur) faceValueByGroup.set(key, pkg.remaining)
  }
  for (const pkg of packages) {
    const face = faceValueByGroup.get(pkg.name)
    if (face !== undefined && face > 0) {
      pkg.total = roundCredits(face)
      if (pkg.used <= 0) pkg.used = roundCredits(Math.max(0, face - pkg.remaining))
    }
  }

  // 负数一律 clamp 到 0（对齐 Go `client.go:303-308` 的 clamp）：服务端在
  // 超额扣费/计量回滚等异常下可能下发负值，原样透出会让卡片显示「-12.5 积分」，
  // 既无意义又会误导用户以为欠费。
  const total = roundCredits(Math.max(0, readNumber(envelope.data, 'totalCreditsRemaining')))
  // totalCreditsRemaining 为 0 且拿不到明细 → 视为「查不到」而非「余额为 0」：
  // 该字段缺失时 readNumber 返回 0，会把解析失败伪装成 0 积分。
  if (total === 0 && packages.length === 0) return null
  // 失效包的余额同样 clamp：负值计入 expiredTotal 会让「另有 N 已失效」变成负数。
  const expiredTotal = roundCredits(
    packages.reduce((sum, pkg) => sum + (pkg.active ? 0 : Math.max(0, pkg.remaining)), 0),
  )
  return { total, packages, expiredTotal }
}

/**
 * 把额度规整为两位小数。
 *
 * 服务端精确值本身可能带浮点表示（如 55.67000031），多包相加会把尾数噪声
 * 显式化 —— 金额展示到分即可（与 `credits.ts:roundCredits` 同口径）。
 */
function roundCredits(value: number): number {
  return Math.round(value * 100) / 100
}
