/**
 * Raccoon Work 积分（余额 + 一次性登录奖励）。
 *
 * ## ⚠️ 三个来源的语义（关键）
 *
 * | 来源 | 金额 | 触发方式 | 本模块 |
 * |---|---|---|---|
 * | 新人注册礼包 | 3000 | 注册时服务端自动发放 | 不涉及（用户注册即有） |
 * | 桌面端登录奖励 | 3000 | `POST …/login/points/grant` | ✅ `claimRaccoonLoginReward` |
 * | 每日积分发放 | 300 | **服务端按日自动发放，无端点** | ❌ 不实现 |
 *
 * ⚠️ **每日 300 没有签到端点** —— 实测该账号 13:30 注册、13:31 就收到
 * `daily_grant` 账单（`biz_type: 'daily_grant'`）。故**不能**把它实现成
 * 签到按钮：不存在可调用的端点，按钮必然失败。
 *
 * ⚠️ **登录奖励是幂等一次性的**（已领过返回 `granted:false`），
 * 语义与 Loomy 的新手任务同构，故登记为 `onboardingTasks` 而**不是**
 * `dailyCheckin` —— 后者会让用户以为每天都真的加了额度。
 *
 * ## 只读优先
 *
 * 余额查询用 `GET /points/v1/balance`（**只读**）。在「打开面板」这类
 * 高频路径上**绝不**触碰写端点（Loomy 的 `first-login` 就踩过这个坑：
 * 打开面板即意外触发签到）。
 */

import {
  RACCOON_POINTS_PREFIX,
  RACCOON_DESKTOP_PREFIX,
  RACCOON_REQUEST_TIMEOUT_MS,
  raccoonHeaders,
  type RaccoonCredential,
} from './raccoon.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import type { ClaimOutcome, CreditBalance, CreditPackage } from './credits.js'

/** 登录奖励的默认额度（服务端未在 popup 里给出时兜底）。 */
export const RACCOON_LOGIN_REWARD_POINTS = 3000

/** 登录奖励在账单里的 `event_name`（用于判定是否已领）。 */
export const RACCOON_LOGIN_REWARD_EVENT_NAME = '桌面端登录奖励'

/** 业务响应信封。 */
interface Envelope {
  ok: boolean
  code: number
  message: string
  data: Record<string, unknown> | undefined
}

/** 解析信封；`code === 0` 为成功。 */
function parseEnvelope(payload: unknown, status: number): Envelope {
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const code = typeof record.code === 'number' ? record.code : (status >= 400 ? status : 0)
  const message = typeof record.message === 'string' && record.message.length > 0
    ? record.message
    : (typeof record.details === 'string' ? record.details : '')
  const data = typeof record.data === 'object' && record.data !== null && !Array.isArray(record.data)
    ? record.data as Record<string, unknown>
    : undefined
  return { ok: code === 0, code, message, data }
}

/** 读成有限数字；非法返回 undefined（**不编造 0**）。 */
function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * 发一次业务请求并拆信封。
 *
 * ⚠️ 不抛错 —— 调用方按 `ok` 分支处理。积分查询/领取属「尽力而为」，
 * 批量操作时单个账号失败不应中断其余账号。
 */
async function requestJson(
  url: string,
  credential: RaccoonCredential,
  product: RaccoonProduct,
  init: { method: string; body?: string },
  fetcher: typeof fetch,
): Promise<Envelope> {
  try {
    const response = await fetcher(url, {
      method: init.method,
      headers: raccoonHeaders(credential, {
        platform: product.clientPlatform,
        version: product.clientVersion,
      }),
      ...init.body === undefined ? {} : { body: init.body },
      signal: AbortSignal.timeout(RACCOON_REQUEST_TIMEOUT_MS),
    })
    const parsed: unknown = await response.json()
    return parseEnvelope(parsed, response.status)
  } catch (error) {
    return {
      ok: false,
      code: -1,
      message: error instanceof Error ? error.message : String(error),
      data: undefined,
    }
  }
}

/** 构造一个资源包条目。 */
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
 * 查询积分余额（映射成既有的 `CreditBalance` 形状）。
 *
 * ⚠️ 各池**分开作 package**，让用户看出「注册礼包 / 每日 / 充值」是独立来源
 * —— 它们的有效期与回补规则都不同（每日积分每日刷新、充值积分长期有效）。
 *
 * @returns 查不到时返回 `null`（卡片显示原因，**不是** 0）。
 */
export async function fetchRaccoonCreditBalance(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<CreditBalance | null> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/balance`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) return null

  const available = readNumber(envelope.data.available_points)
  // `available_points` 是核心字段：没有它就说明响应形状不对，不编造数字。
  if (available === undefined) return null

  const packages: CreditPackage[] = []
  const reward = readNumber(envelope.data.reward_points)
  const daily = readNumber(envelope.data.daily_points)
  const topup = readNumber(envelope.data.topup_points)
  const monthly = readNumber(envelope.data.monthly_points)
  if (reward !== undefined) packages.push(makePackage('奖励积分', reward))
  if (daily !== undefined) packages.push(makePackage('每日积分', daily))
  if (monthly !== undefined && monthly > 0) packages.push(makePackage('会员积分', monthly))
  if (topup !== undefined) packages.push(makePackage('充值积分', topup))

  return {
    total: available,
    // 极端情形（服务端只给 total 不给分项）也要有至少一个包，否则 UI 空列表
    packages: packages.length > 0 ? packages : [makePackage('可用积分', available)],
    expiredTotal: 0,
  }
}

/**
 * 领取「桌面端登录奖励」（一次性，幂等）。
 *
 * ⚠️ **不是每日签到**：实测该端点是幂等一次性的（已领过返回 `granted:false`
 * 且账单里能看到上一次的记录）。映射到 `onboardingTasks` 能力。
 *
 * ⚠️ 需要 `X-Client-Platform` 头（值见 `product.clientPlatform`）——
 * 它标识「来自桌面端」，缺了会被拒。见 `raccoonHeaders`。
 *
 * 本函数**不抛错**（失败也返回 `failed`），保证批量领取不会因单个账号中断。
 */
export async function claimRaccoonLoginReward(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<ClaimOutcome> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_DESKTOP_PREFIX}/login/points/grant`,
    credential,
    product,
    { method: 'POST' },
    fetcher,
  )

  if (!envelope.ok) {
    return {
      kind: 'failed',
      code: envelope.code,
      message: envelope.message.length > 0 ? envelope.message : '领取登录奖励失败',
    }
  }

  // ⚠️ 幂等判据是 `granted`（重复领取同样返回 HTTP 200 + `granted:false`），
  // 故映射成 `already-claimed` 而**不是** `claimed` ——
  // 后者会让用户以为每天都真的加了额度。
  if (envelope.data?.granted !== true) {
    return {
      kind: 'already-claimed',
      message: '该账号已领取过桌面端登录奖励（每号一次）',
    }
  }

  const popup = typeof envelope.data.popup === 'object' && envelope.data.popup !== null
    ? envelope.data.popup as Record<string, unknown>
    : undefined
  const points = readNumber(popup?.points) ?? RACCOON_LOGIN_REWARD_POINTS
  return { kind: 'claimed', credit: points, streakDays: 0, isStreakDay: false }
}

/**
 * 查询「桌面端登录奖励」是否已领（供 `onboarding.status` 用）。
 *
 * 判据：`GET /points/v1/bills` 里是否已有
 * `biz_type === 'reward_grant'` 且 `event_name === '桌面端登录奖励'` 的记录。
 *
 * ⚠️ **不能靠 `balance` 推断** —— 余额是多个来源（注册礼包/每日/充值）的
 * 合计，无法区分某一项是否已领。
 * ⚠️ **不能只按 `biz_type === 'reward_grant'` 判定** —— 「新人注册礼包」
 * 也是 `reward_grant`，把它算作登录奖励会让新用户一开始就显示「已领取」。
 * ⚠️ **服务端没有单独的奖励状态端点**（实测），故只能查账单明细。
 * ⚠️ 查询失败时保守返回 `claimed: false` —— 宁可让用户多点一次
 * （服务端幂等，无害），也不要误报「已领」而让他真的错过。
 */
export async function fetchRaccoonOnboardingStatus(
  product: RaccoonProduct,
  credential: RaccoonCredential,
  fetcher: typeof fetch = fetch,
): Promise<{ claimed: boolean; points: number }> {
  const envelope = await requestJson(
    `${product.apiBase}${RACCOON_POINTS_PREFIX}/bills?paging.limit=50&paging.offset=0`,
    credential,
    product,
    { method: 'GET' },
    fetcher,
  )
  if (!envelope.ok || envelope.data === undefined) {
    return { claimed: false, points: RACCOON_LOGIN_REWARD_POINTS }
  }

  const items = Array.isArray(envelope.data.items) ? envelope.data.items : []
  let claimed = false
  let points = RACCOON_LOGIN_REWARD_POINTS
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (item.biz_type !== 'reward_grant') continue
    if (item.event_name !== RACCOON_LOGIN_REWARD_EVENT_NAME) continue
    claimed = true
    const billPoints = readNumber(item.points)
    if (billPoints !== undefined && billPoints > 0) points = billPoints
    break
  }
  return { claimed, points }
}

/** 默认产品配置下的便捷包装（供 `RaccoonAuth` 调用）。 */
export const raccoonCreditsForDefaultProduct = {
  fetchBalance: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonCreditBalance(RACCOON, credential, fetcher),
  claimLoginReward: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    claimRaccoonLoginReward(RACCOON, credential, fetcher),
  fetchOnboardingStatus: (credential: RaccoonCredential, fetcher?: typeof fetch) =>
    fetchRaccoonOnboardingStatus(RACCOON, credential, fetcher),
}
