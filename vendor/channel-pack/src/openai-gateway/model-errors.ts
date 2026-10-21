/**
 * 上游「模型不存在」类错误的翻译（纯逻辑，无 IO）。
 *
 * ## 为什么是翻译而不是预检拦截
 *
 * `design.md:76` 明确要求「隐藏模型不出现在 /v1/models，但显式请求仍交给 DSH
 * 路由处理」—— 有些 provider 支持目录之外的模型（远端新上线、被用户用黑名单
 * 隐藏的）。网关若在发请求前拿 `listModels` 做白名单拦截，会把这类**合法**请求
 * 一起挡掉。
 *
 * 所以网关不预判：照常发起请求，只把上游返回的「模型不存在」翻译成对客户端
 * 更准确的状态码。
 *
 * ## 为什么要翻
 *
 * 未翻译时这类错误以 502 离开网关（`collectOpenAiCompletion` 把流内错误统一
 * 包成 502）。而 502 在 OpenAI 客户端眼里是「服务端故障」→ **会被自动重试**，
 * 但「模型名不存在」是确定性失败，重试只是白耗额度。翻成 404 + invalid_request
 * 之后，客户端会把它当成配置错误提示用户。
 */

/**
 * ⚠️ 最后两条是**本插件自己的措辞**（`gemini.ts` / `gemini-adapter.ts` 的
 * 「模型 "X" 不在本 provider 目录中（仅支持 …）」）。把自家文案写进通用判据表
 * 是刻意的取舍：那条错误虽已自带 `status: 404`（走 `failureToOpenAiError`），
 * 但只有在这里命中，`type` 才会从硬编码的 `server_error` 变成
 * `invalid_request_error`、`code` 变成 `model_not_found`，并触发「你是不是想用 X」。
 */
const MISSING_MODEL_PATTERNS: readonly RegExp[] = [
  /model\s+is\s+not\s+registered/i,
  /model\s+not\s+registered/i,
  /unknown\s+model/i,
  /model\s+not\s+found/i,
  /no\s+such\s+model/i,
  /model\s+does\s+not\s+exist/i,
  /invalid\s+model/i,
  /模型不存在/,
  /不在本\s*provider\s*目录中/i,
]

/**
 * 上游消息是否表示「模型不存在」。
 */
export function looksLikeMissingModel(message: string): boolean {
  if (typeof message !== 'string' || message.length === 0) return false
  return MISSING_MODEL_PATTERNS.some((pattern) => pattern.test(message))
}

/**
 * 没有可用状态码时的兜底值。
 *
 * 502 而非 500：它在 OpenAI 客户端眼里明确是「服务端故障」⇒ **可重试**，
 * 而 500 有时被当成「请求本身有问题」而不重试。
 */
export const GATEWAY_FALLBACK_STATUS = 502

/**
 * 把上游自带的状态码收敛成「可作为错误码透出」的值。
 *
 * ## ⚠️ 为什么必须有这个门禁（三处出口，缺一不可）
 *
 * 门禁是 `400 ≤ status ≤ 599`。**上下界都必要**：
 *
 * ⚠️ 5xx 会**原样透出**（不归 502），这是刻意的：上游的 500/503/504 本就可重试，
 * 原样透出比统一改成 502 更准。把「5xx 也不穿透」当修复会把 503 降级成 4xx 语义，
 * 让本该重试的故障失去重试机会。
 */
export function upstreamStatusOrFallback(status: unknown): number {
  return typeof status === 'number' && status >= 400 && status <= 599
    ? status
    : GATEWAY_FALLBACK_STATUS
}

/**
 * 把上游失败归一化成对客户端更准确的状态码。
 *
 * 非模型类失败**原样返回** —— 宁可保持 502 让客户端重试，也不要把它误标成
 * 404 而让真正需要重试的故障失去重试机会。
 */
export function normalizeUpstreamFailure(failure: {
  status: number
  type: string
  code: string
  message: string
}): { status: number; type: string; code: string } {
  if (!looksLikeMissingModel(failure.message)) {
    return { status: failure.status, type: failure.type, code: failure.code }
  }
  return { status: 404, type: 'invalid_request_error', code: 'model_not_found' }
}

/**
 * 找出用户大概是手滑打错的目录条目，用于给出纠错建议。
 *
 * ## 两级匹配，第二级是必需的
 *
 * @param requested 用户实际提交的完整 ID
 * @param catalog 目录里的完整 ID 列表
 * @returns 建议改成的正确 ID；没有把握时不返回
 */
export function findCaseInsensitiveSuggestion(
  requested: string,
  catalog: readonly string[],
): string | undefined {
  if (typeof requested !== 'string' || requested.length === 0) return undefined
  if (catalog.length === 0) return undefined
  // 精确命中 ⇒ 没有拼写问题，不该给建议。
  if (catalog.includes(requested)) return undefined

  const lower = requested.toLowerCase()
  // 第一级：仅大小写不同。
  for (const id of catalog) {
    if (id.toLowerCase() === lower) return id
  }
  // 第二级：用户少打了结尾（实测的 GLM-5.3 → glm-5.3-flash 就靠这一级）。
  const candidates = catalog.filter((id) => id.toLowerCase().startsWith(lower))
  return candidates.length === 1 ? candidates[0] : undefined
}
