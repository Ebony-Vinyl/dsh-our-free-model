/**
 * Gemini 信封里 `project` 的**探测与缓存**。
 *
 * ## 为什么需要它
 *
 * 信封的 `project` **不是恒为 `aicode-consumers`** —— 那是
 * `loadCodeAssist` 探测为空时的**兜底**。真机对照实验（2026-10-05）证明原版读
 * `loadCodeAssist` 的 `cloudaicompanionProject`：让假上游返回 `CCP-TWO`，
 * 信封里就是 `CCP-TWO`。历次抓包都看到 `aicode-consumers`，只是因为免费档账号的
 * LCA 返回空 project。
 *
 * ## 三级缓存（对齐 `cmdc-pak` 的 `project.go:44-106`）
 *
 * 1. **进程内**（`cache`）—— 同一次运行内不再重复探测；
 * 2. **凭据字段** `cloudaicompanionProject` —— 跨启动的落盘缓存；
 * 3. **现探** —— 前两级都没有才打 `loadCodeAssist`。
 *
 * ## 「探测失败」与「探测成功但为空」必须分开
 *
 * 这是本模块最容易写错的地方，也是原版行为的关键：
 *
 * | 情形 | 处置 |
 * |---|---|
 * | LCA 返回 200，project **非空** | 用探测值 |
 * | LCA 返回 200，project **为空**（免费档常态） | 回落 {@link GEMINI_DEFAULT_PROJECT}，**照常发推理** |
 * | LCA 失败（网络 / 非 2xx / 空响应） | 返回 `error` ⇒ 调用方**不发推理** |
 *
 * 第三行是原版实测行为（2026-10-05 注入 500 验证：原版**不发**
 * `streamGenerateContent`，只在端点间反复重试 LCA + quota）。此前我们探测失败会
 * 返回空串继续发推理，与原版不一致。
 */

import {
  GEMINI_CREDITS_TIMEOUT_MS,
  GEMINI_DEFAULT_PROJECT,
  GEMINI_ENDPOINT_DAILY,
  GEMINI_ENDPOINT_SANDBOX,
  GEMINI_LOAD_CODE_ASSIST_BODY,
  GEMINI_LOAD_CODE_ASSIST_PATH,
  geminiHeaders,
  type GeminiCredential,
} from './gemini.js'

/** 探测结果。`error` 非空表示**探测失败**（不是「探测到空」）。 */
export interface GeminiProjectProbe {
  /** 可用的项目号；探测失败时为空串。 */
  project: string
  /** 非空 = 探测失败 ⇒ 调用方**不发推理**。 */
  error?: string
  /** 本次是否**真的打了** `loadCodeAssist`（命中缓存时为 false）。 */
  probed?: boolean
}

/**
 * 凭据身份（进程内缓存的键）。
 *
 * ⚠️ 用 `email` / `sub` 而不是 `access_token`：后者每次续期都会变，
 * 用它当键会让缓存**每次续期后失效**，白白多打一次 LCA。
 */
export function geminiCredentialIdentity(credential: GeminiCredential): string {
  if (typeof credential.email === 'string' && credential.email !== '') return credential.email
  if (typeof credential.sub === 'string' && credential.sub !== '') return credential.sub
  return credential.access_token
}

/**
 * 从 `loadCodeAssist` 响应里取项目号。
 *
 * 两级：顶层 `cloudaicompanionProject` → `currentTier.cloudaicompanionProject`
 * （逐字对齐 `project.go:129-132` 的取值顺序）。
 */
export function parseGeminiProject(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const raw = payload as Record<string, unknown>
  const top = raw.cloudaicompanionProject
  if (typeof top === 'string' && top !== '') return top
  const tier = raw.currentTier
  if (typeof tier === 'object' && tier !== null) {
    const inner = (tier as Record<string, unknown>).cloudaicompanionProject
    if (typeof inner === 'string' && inner !== '') return inner
  }
  return ''
}

/** {@link resolveGeminiProject} 的入参。 */
export interface ResolveGeminiProjectOptions {
  credential: GeminiCredential
  /** 进程内缓存（键 = {@link geminiCredentialIdentity}）。 */
  cache?: Map<string, string>
  fetcher?: typeof fetch
  timeoutMs?: number
  /**
   * 调用方的取消信号（与 {@link timeoutMs} **取交集**）。
   *
   * ⚠️ 必须支持：否则探测自带的 30 秒超时会把冒烟测试等调用方的更短超时拖长，
   * 用户点「重测」后要多等一截。
   */
  signal?: AbortSignal
  /**
   * 探测端点顺序。
   *
   * ⚠️ **sandbox 优先**：原版 `baseFor(path)` 把 `loadCodeAssistPath` /
   * `retrieveQuotaPath` 这两条路径固定路由到 sandbox（见 `gemini-credits.ts`
   * 的同类注释）。daily 作兜底。
   */
  endpoints?: readonly string[]
}

/**
 * 解析当前凭据可用的项目号（三级缓存）。
 *
 * 探测失败时返回 `{ project: '', error }` —— 调用方据此**不发推理**。
 */
export async function resolveGeminiProject(
  options: ResolveGeminiProjectOptions,
): Promise<GeminiProjectProbe> {
  const cache = options.cache
  const identity = geminiCredentialIdentity(options.credential)

  // 一级：进程内
  const cached = cache?.get(identity)
  if (cached !== undefined && cached !== '') return { project: cached }

  // 二级：凭据字段（跨启动的落盘缓存）
  const fromCredential = options.credential.cloudaicompanionProject
  if (fromCredential !== undefined && fromCredential !== '') {
    cache?.set(identity, fromCredential)
    return { project: fromCredential }
  }

  // 三级：现探
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? GEMINI_CREDITS_TIMEOUT_MS
  const endpoints = options.endpoints ?? [GEMINI_ENDPOINT_SANDBOX, GEMINI_ENDPOINT_DAILY]
  // 自带超时与调用方信号取交集（调用方的更短超时必须能提前打断）。
  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = options.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([options.signal, timeoutSignal])
  let lastError = ''

  for (const endpoint of endpoints) {
    try {
      const response = await fetcher(`${endpoint}${GEMINI_LOAD_CODE_ASSIST_PATH}`, {
        method: 'POST',
        headers: geminiHeaders(options.credential),
        body: GEMINI_LOAD_CODE_ASSIST_BODY,
        signal,
      })
      if (!response.ok) {
        lastError = `loadCodeAssist HTTP ${response.status}`
        continue
      }
      const text = await response.text().catch(() => '')
      if (text === '') {
        lastError = 'loadCodeAssist 返回空响应'
        continue
      }
      const project = parseGeminiProject(JSON.parse(text) as unknown)
      if (project !== '') {
        cache?.set(identity, project)
        return { project, probed: true }
      }
      // ⚠️ 探测**成功但项目号为空** = 免费档常态，**不是失败** ——
      // 回落兜底串继续发推理（原版历次抓包都是这个值）。
      return { project: GEMINI_DEFAULT_PROJECT, probed: true }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }

  return { project: '', error: lastError === '' ? 'loadCodeAssist 探测失败' : lastError }
}

/**
 * 把探测到的项目号**回写凭据**（best-effort 落盘缓存）。
 *
 * ⚠️ 纯缓存：写失败只记日志，**绝不影响推理** —— 写不进去只是下次启动重探一次。
 *
 * ⚠️ 只回写**探测到的非空值**，不回写兜底串：把 `aicode-consumers` 写进凭据会让
 * 后续请求跳过探测，而该账号将来若拿到真实 project 就会被这个陈旧值钉死。
 */
export async function persistGeminiProject(options: {
  credential: GeminiCredential
  project: string
  write: (value: string) => Promise<void>
  logger?: { warn(message: string): void }
}): Promise<void> {
  if (options.project === '' || options.project === GEMINI_DEFAULT_PROJECT) return
  if (options.credential.cloudaicompanionProject === options.project) return
  try {
    await options.write(JSON.stringify({
      ...options.credential,
      cloudaicompanionProject: options.project,
    }))
  } catch (error) {
    options.logger?.warn(`[gemini] 项目号回写凭据失败（不影响推理）: ${String(error)}`)
  }
}
