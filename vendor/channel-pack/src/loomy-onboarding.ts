/**
 * Loomy 新手任务（合计 10000 积分）。
 *
 * ## ⚠️ 服务端不校验前置行为（决定性实测）
 *
 * 原因：完成条件全部在**客户端本地判定**（源码 `onboarding-service.js`
 * 的注释与单测都表明服务端只做「幂等置位 + 加分」）。故本实现是
 * **纯 API 直领**，一个模型 token 都不花。
 *
 * ## 端点
 *
 * ```
 * GET  /api/v1/onboarding/tasks            → { tasks:{8key:bool}, earned, total }
 * POST /api/v1/onboarding/tasks/complete   body { key } → { alreadyCompleted, balance }
 * ```
 *
 * ⚠️ 上报 body **只有 `key`** —— 无设备指纹、无版本号、无渠道号
 * （`OnboardingService` 的构造参数里根本没有 `getDeviceId`，
 * 对比 `PointsService` 是有的）。
 * ⚠️ 幂等判据是响应体的 `alreadyCompleted`，**不是** HTTP 码、**不是** `code`。
 * ⚠️ **不采信服务端 `earned`**，按本地 `LOOMY_TASK_POINTS` 现算 ——
 * 官方自己也这么做（`onboarding-service.js:177-183` 明说不信任）。
 */

import {
  LOOMY_AUTH_ERROR_CODE,
  LOOMY_REQUEST_TIMEOUT_MS,
  parseLoomyEnvelope,
  type LoomyCredential,
} from './loomy.js'
import type { LoomyProduct } from './loomy-product.js'

/**
 * 任务 key → 积分。
 *
 * 来源：Loomy 客户端 `electron/onboarding-service.js:18-27` 的 `TASK_POINTS`
 * （其单测 `:33-37` 断言各项之和 === 10000）。
 * 顺序即执行顺序。
 */
export const LOOMY_TASK_POINTS: Readonly<Record<string, number>> = Object.freeze({
  first_message: 500,
  pick_skill: 1000,
  generate_ppt: 1500,
  set_schedule: 1000,
  install_skill: 1500,
  configure_remote: 1000,
  create_soul: 1500,
  share_soul: 2000,
})

/** 任务 key → 中文标题（客户端 `GE` 注册表里的 `title`）。 */
export const LOOMY_TASK_TITLES: Readonly<Record<string, string>> = Object.freeze({
  first_message: '发送你的第一条消息',
  pick_skill: '试试选择一个技能',
  generate_ppt: '生成第一份 PPT',
  set_schedule: '设置定时任务',
  install_skill: '在技能广场安装一个技能',
  configure_remote: '配置远程控制',
  create_soul: '创建你的第一个搭子',
  share_soul: '把搭子分享给朋友',
})

/** 任务积分合计（10000）。 */
export const LOOMY_ONBOARDING_TOTAL = 10_000

/** 新手任务状态。 */
export interface LoomyOnboardingState {
  /** 8 个 key 的完成状态（缺失的补 false）。 */
  tasks: Record<string, boolean>
  /** **本地现算**的已领积分（不采信服务端）。 */
  earned: number
  /** 总分（10000）。 */
  total: number
}

/** 一次「领取全部新手任务」的结果。 */
export interface LoomyOnboardingResult {
  /** 本次真正处理（含幂等重放）的 key 与积分。 */
  claimed: { key: string; points: number }[]
  /** 此前已完成、本次跳过（**未发请求**）的 key。 */
  skipped: string[]
  /** 领取后本地现算的累计已领。 */
  earned: number
  total: number
}

/** 按本地表现算已领积分；未知 key 忽略。 */
export function computeLoomyEarned(tasks: Record<string, boolean>): number {
  return Object.keys(LOOMY_TASK_POINTS)
    .reduce((sum, key) => (tasks[key] === true ? sum + LOOMY_TASK_POINTS[key]! : sum), 0)
}

/** 把服务端下发的 tasks 按本地表归一（缺的补 false、多余的忽略）。 */
function normalizeTasks(raw: unknown): Record<string, boolean> {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {}
  const normalized: Record<string, boolean> = {}
  for (const key of Object.keys(LOOMY_TASK_POINTS)) {
    normalized[key] = source[key] === true
  }
  return normalized
}

/** 发一次业务请求并拆信封；`100002` 抛认证错误（**不重试**）。 */
async function requestLoomy<T>(
  credential: LoomyCredential,
  product: LoomyProduct,
  path: string,
  init: { method: string; body?: unknown },
  fetcher: typeof fetch,
): Promise<T> {
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
    throw new Error(`loomy: 请求失败（${path}）：${error instanceof Error ? error.message : String(error)}`)
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`loomy: 响应不是 JSON（${path}，HTTP ${response.status}）`)
  }

  const envelope = parseLoomyEnvelope<T>(parsed)
  if (!envelope.ok) {
    if (envelope.code === LOOMY_AUTH_ERROR_CODE) {
      // 认证失效：**必须抛出**让上层停止后续任务请求并提示重新登录。
      throw new Error(`loomy: ${envelope.message}`)
    }
    throw new Error(`loomy: ${envelope.message}`)
  }
  return envelope.data as T
}

/**
 * 查询新手任务状态。
 *
 * `earned` 按本地表现算 —— 服务端回传的 `earned` 只是参考，
 * 且历史上出现过与本地表不一致的情况。
 */
export async function fetchLoomyOnboardingTasks(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyOnboardingState> {
  const data = await requestLoomy<{ tasks?: unknown; total?: unknown }>(
    credential, product, '/onboarding/tasks', { method: 'GET' }, fetcher,
  )
  const tasks = normalizeTasks(data?.tasks)
  return {
    tasks,
    earned: computeLoomyEarned(tasks),
    total: Number.isFinite(Number(data?.total)) ? Number(data?.total) : LOOMY_ONBOARDING_TOTAL,
  }
}

/**
 * 完成（领取）单个新手任务。
 *
 * ⚠️ 幂等：重复调用返回 `alreadyCompleted: true`，**视为成功**。
 */
export async function completeLoomyTask(
  credential: LoomyCredential,
  key: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<{ alreadyCompleted: boolean; balance: number }> {
  if (!(key in LOOMY_TASK_POINTS)) {
    // 与官方客户端一致：未知 key 本地就拦掉，不发必然失败的请求。
    throw new Error(`loomy: 未知的 task key: ${key}`)
  }
  const data = await requestLoomy<{ alreadyCompleted?: unknown; balance?: unknown }>(
    credential, product, '/onboarding/tasks/complete', { method: 'POST', body: { key } }, fetcher,
  )
  return {
    alreadyCompleted: data?.alreadyCompleted === true,
    balance: Number.isFinite(Number(data?.balance)) ? Number(data?.balance) : 0,
  }
}

/**
 * 领取全部新手任务（补差额）。
 *
 * **串行**逐个完成（官方客户端也用 `Set` 去重、串行）；已完成的**跳过不发请求**。
 * 任一任务收到 `100002` 时**立即抛出**，不再对后续任务发请求
 * （否则会产生一串必然失败的请求）。
 */
export async function claimAllLoomyOnboardingTasks(
  credential: LoomyCredential,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyOnboardingResult> {
  const state = await fetchLoomyOnboardingTasks(credential, product, fetcher)
  const claimed: { key: string; points: number }[] = []
  const skipped: string[] = []
  // 按本地表顺序执行（= 官方注册表顺序）
  const nextTasks = { ...state.tasks }

  for (const key of Object.keys(LOOMY_TASK_POINTS)) {
    if (state.tasks[key] === true) {
      skipped.push(key)
      continue
    }
    await completeLoomyTask(credential, key, product, fetcher)
    // 无论服务端回 alreadyCompleted 与否，都记为已领（幂等重放同样算成功）。
    claimed.push({ key, points: LOOMY_TASK_POINTS[key]! })
    nextTasks[key] = true
  }

  return {
    claimed,
    skipped,
    earned: computeLoomyEarned(nextTasks),
    total: state.total,
  }
}
