/**
 * OpenAI 兼容协议层的共享实现：消息序列化 + SSE 消费 + 错误归类。
 *
 * ## 为什么单独成模块
 *
 * 因此本模块把这部分抽出来给 **qoder 适配器**使用。
 *
 * ## 本模块承载的实测教训（逐条都有真实缺陷背景）
 */

import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  createBlankReasoningSuppressor,
  createReasoningLoopDetector,
  hasUsableToolName,
  isProseTruncatedByStopString,
  isReasoningLoopGuardEnabled,
  isTruncatedArguments,
  normalizeToolArguments,
  readWithIdleTimeout,
  reasoningLoopFailure,
  resolveEmptyResponseReason,
  resolveToolPairing,
  splitThinkTaggedContent,
  stripBareThinkCloseTagIfEnabled,
  stripCourseLeakFromHistoryContent,
  stripCourseLeakIfEnabled,
} from './sse.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { isBillingBusinessCode, looksLikeBillingError, parseQueueError, queueDelayMs, ModelQueuedError, throwIfModelQueued } from './model-queue.js'

/** 将消息内容载荷展平为纯文本字符串。 */
export function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

export const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

/**
 * 把 harness 内容块转成 OpenAI 多模态 parts。
 *
 * 图片必须转成 `{type:'image_url', image_url:{url}}` —— 这是服务端**唯一**接受的
 * 形态：`{type:'image'}` 与裸 base64 字符串都返回 HTTP 500。
 *
 * 返回 `undefined` 表示「无图」；只要出现过图片块就一定返回数组（即便字节
 * 解析失败也留 `[image unavailable]` 占位符），以免图片被静默吞掉。
 *
 * 与 {@link collectImages} 对称地**递归**处理 `tool-result` 内层：收集侧是任意
 * 深度，序列化侧若只走一层，深层图片会被收进 refs 却在序列化时静默丢弃。
 */
export function userContentParts(
  content: readonly unknown[],
  imageUrls: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> | undefined {
  const parts: Array<Record<string, unknown>> = []
  let hasImage = false
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as {
      type?: unknown
      text?: unknown
      attachment?: { attachmentId?: unknown }
      content?: unknown
    }
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text.length > 0) parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'image') {
      hasImage = true
      const url = block.attachment?.attachmentId === undefined
        ? undefined
        : imageUrls.get(String(block.attachment.attachmentId))
      // 解析不到字节时留占位文本，而不是静默吞掉整张图。
      parts.push(url === undefined
        ? { type: 'text', text: '[image unavailable]' }
        : { type: 'image_url', image_url: { url } })
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) {
      const inner = userContentParts(block.content, imageUrls)
      if (inner !== undefined) {
        hasImage = true
        parts.push(...inner)
      } else {
        // 内层无图：保留其文本，避免内容丢失。
        const text = contentToText(block.content)
        if (text.length > 0) parts.push({ type: 'text', text })
      }
    }
  }
  return hasImage && parts.length > 0 ? parts : undefined
}

/** 收集消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
export function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void {
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue
    const block = raw as { type?: unknown; attachment?: { attachmentId?: unknown }; content?: unknown }
    if (block.type === 'image' && typeof block.attachment?.attachmentId === 'string') {
      refs.set(block.attachment.attachmentId, block.attachment)
      continue
    }
    if (block.type === 'tool-result' && Array.isArray(block.content)) collectImages(block.content, refs)
  }
}

/**
 * 将 harness 对话消息序列化为 OpenAI chat-completions 传输格式。
 *
 * 保留的**通用协议要求**：
 * - 孤儿工具调用清理（见 `resolveToolPairing` 的说明，后端会 400）；
 * - 正文为空且有 `tool_calls` 时 `content` 必须为 `null`（OpenAI 规范）；
 * - 工具结果内嵌图片不能留在 `role:'tool'` 消息里（该角色 content 只能是
 *   字符串，且必须紧跟其 assistant tool_call，中间插消息会 400），
 *   故提升为其后的独立 user 消息。
 *
 * 图片：`imageUrls` 为 `undefined` 表示整个请求没有图片；非 undefined
 * （**含空 Map**）时把 user 消息升级为多模态 parts。空 Map 不能降级为
 * undefined —— 那会让「图片存在但字节读取失败」的 `[image unavailable]`
 * 占位符也被跳过，图片静默消失。
 *
 * ⚠️ 入口先做 **DSH 0.1.7 消息形状归一化**（见 `message-shape.ts`）：0.1.7 把工具
 * 结果改为一等 `role:'tool'` 消息，若不归一化，下面的 `type === 'tool-result'`
 * 判据恒不命中 → 工具调用被 `resolveToolPairing` 整体剔除。
 */
export function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const normalized = normalizeHarnessMessages(messages)
  const wire: Array<Record<string, unknown>> = []
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  for (const message of normalized) {
    if (message.role === 'assistant') {
      // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
      // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
      // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
      const content = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : [],
      )
      const toolCalls = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
        .map((block) => ({
          id: String(block.id),
          type: 'function' as const,
          function: { name: String(block.name), arguments: normalizeToolArguments(String(block.arguments)) },
        }))
      const reasoning = content
        .filter((block): block is { type: string; text: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'reasoning')
        .map((block) => String(block.text))
        .join('')
      const text = contentToText(content)
      if (text.trim().length === 0 && toolCalls.length === 0) continue
      // 挂起的工具结果图片必须在 assistant 之前发出，否则会漂到这条
      // assistant 之后，与产生它们的工具调用脱节。
      flushToolImages()
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null（OpenAI 规范）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中，展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)
    // 工具结果之外的常规内容（含顶层图片）。
    const regular = content.filter((block) =>
      !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result'))
    const parts = imageUrls === undefined ? undefined : userContentParts(regular, imageUrls)
    if (parts !== undefined) {
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.trim().length > 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 的结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      // 内嵌图片挂起到其后的 user 消息；文本留在 tool 消息里。
      let resultText = '(no output)'
      if (imageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, imageUrls)
        if (resultParts !== undefined) {
          pendingToolImages.push(...resultParts.filter((part) => part.type !== 'text'))
          const joined = resultParts
            .filter((part) => part.type === 'text')
            .map((part) => String(part.text))
            .join('')
          if (joined.length > 0) resultText = joined
        } else {
          resultText = contentToText(result.content) || '(no output)'
        }
      } else {
        resultText = contentToText(result.content) || '(no output)'
      }
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: resultText,
      })
    }
  }
  flushToolImages()
  return wire
}

/** 安全读取 Error.message。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/** 从错误体提取可读 detail 文本。 */
export function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    // ⚠️ `error` 也要认：Cline 的部分错误体是 `{error: "<文案>", success: false}`
    //（如地域限制 `{"error":"access forbidden: … is not available in your region"}`），
    // 且它可能是**字符串**也可能是嵌套对象 —— 只认 code/message/msg 会把
    // 整个 JSON 原样返回，用户看到一坨不可读的裸 JSON。
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as Record<string, unknown>).message
      : data.error
    const parts = [
      typeof data.code === 'number' || typeof data.code === 'string' ? `code=${String(data.code)}` : undefined,
      typeof data.message === 'string' ? data.message : undefined,
      typeof data.msg === 'string' ? data.msg : undefined,
      typeof nested === 'string' ? nested : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/** 将 HTTP 状态码映射为 harness 错误码。 */
export function httpErrorCode(status: number): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * **模型排队**（Qoder 业务码 `10605`）—— 从 SSE 错误帧里透出来的专用错误。
 *
 * ## 为什么需要它（真实缺陷，用户报障 2026-09-27）
 *
 * Qoder 的排队错误有**两种**下发形态，第一版修复只覆盖了第一种：
 *
 * | 形态 | 第一版 | 说明 |
 * |---|---|---|
 * | HTTP **403** + 排队 JSON | ✅ 已覆盖 | 在适配器的 HTTP 状态分支里识别 |
 * | HTTP **200** + **SSE 内嵌** `{code:"10605",…}` | ❌ **漏掉** | 走 `consumeOpenAiSse`，被一律归为 `SERVER` 抛出 |
 *
 * 真实症状：`失败原因：qoder: {"code":"10605",…} (403)` + harness 以
 * `500/1000/2000/4000/8000`（约 15.5 秒）重试 5 次 —— 而服务端要求等 30 秒，
 * 于是**永远等不到**。
 *
 * ⚠️ 该模块是**共享**的（qoder 适配器在用），故这里只**认码并透出信息**，
 * 不在此处等待 —— 等待策略属于各 provider（只有 qoder 有排队语义）。
 * 消费方捕获本类后自行按 `retryAfterMs` 内部重试。
 *
 * ⚠️ `code` 故意用 `'QUEUE'`（**不是** `SERVER`）：harness 的
 * `DEFAULT_RETRYABLE_CODES` 不含 `QUEUE`，这样万一没人捕获，它会**直接失败**
 * 并把「排队」这一语义暴露给用户，而不是被 harness 当作 `SERVER` 静默快重试。
 */
export { ModelQueuedError } from './model-queue.js'

/**
 * 判断是否为传输级错误（可重试的 TRANSPORT）。
 *
 * 半开连接与 TCP 重置都会以这些特征出现。
 */
export function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/** {@link consumeOpenAiSse} 的选项。 */
export interface ConsumeOpenAiSseOptions {
  /** provider 标签，仅用于错误消息前缀（如 `qoder`）。 */
  label: string
  /** 等待首 token 的空闲超时（毫秒）。 */
  firstTokenTimeoutMs: number
  /** 两次 chunk 之间的空闲超时（毫秒）。 */
  chunkTimeoutMs: number
  /**
   * 本次请求的输出额度（token），用于死循环错误文案里的「还剩多少」。
   *
   * ⚠️ **可选，且拿不到时绝不编造数字**（与 `maxOutputTokens` 的口径一致）：
   * 文案会退化成「额度没有占满，可以直接继续」而不给具体数值。
   */
  maxTokens?: number
  /**
   * 每解析成功一帧就回调一次（**旁路观测**，不得影响流本身）。
   *
   * Cline 用它取网关下发的路由元数据（真正服务这笔请求的上游渠道），
   * 见 `src/cline-routing.ts`。做成回调查而不是把字段塞进 `StreamChunk`：
   * 那是**展示用的旁路信息**，不该污染 DSH 的 chunk 契约（也不该被
   * 其它复用本消费器的 provider 无意中看到）。
   *
   * ⚠️ 回调**抛错会被吞掉**：观测失败绝不能把一次正常推理打死。
   */
  onFrame?: (data: Record<string, unknown>) => void
  /** 将 wire 侧规范化的工具名还原为调用方名称。 */
  restoreToolName?: (name: string) => string
  /** Provider-specific quota errors, including HTTP 200 error envelopes. */
  isQuotaError?: (data: Record<string, unknown>) => boolean
}

/**
 * 诊断用原始文本上限（字符）。
 *
 * 只用于「响应根本不是 SSE」时的错误消息 —— 必须带原文片段，
 * 否则用户看到的又是一次没有原因的失败。
 */
const RAW_SNIPPET_LIMIT = 400

/**
 * 消费 OpenAI 兼容的 SSE 响应并产出 `StreamChunk`。
 *
 * 三处兼容处理（都来自实测）：
 * 1. **容忍 `data:` 后无空格** —— 靠 `line.slice(5).trim()` 天然兼容两种形态；
 * 2. `reasoning_content` 单独成块；
 * 3. `tool_calls` 按 `index` 合并（首片带 id/name，后续只带 arguments 片段）。
 *
 * 另外两条防坑规则（见模块头注释）：
 * - `function.name` 只允许非空覆盖；
 * - `finish_reason` 映射：`length` / 中途断流 / 参数残缺一律归为 `max-tokens`。
 */
export async function* consumeOpenAiSse(
  response: Response,
  options: { signal?: AbortSignal },
  config: ConsumeOpenAiSseOptions,
): AsyncIterable<StreamChunk> {
  const { label } = config
  const restoreToolName = config.restoreToolName ?? ((name: string) => name)
  if (!response.body) throw new LlmError(`${label}: empty model response body`, 'EMPTY_RESPONSE')

  const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
  let nextIndex = 0
  /**
   * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
   * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
   */
  const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
  let loopDetected = false
  /**
   * **正文**死循环检测（**独立实例**，见 `createReasoningLoopDetector`）。
   *
   * ## 真实缺陷（用户报障，2026-09-25）
   *
   * ## ⚠️ 为什么必须与 `loopGuard` **分成两个实例**
   *
   * 判据看的是**尾部 3000 字符窗口**的行去重率。两条通道的文本若混进同一
   * 窗口，「持续体量」与「去重率」都会被另一条通道的内容稀释 —— 于是
   * 两条通道各自都不再达标，守卫**双双失效**。反之，共用一个 `cutAt` 也会让
   * 一条通道的截断点错切另一条通道。
   *
   * ## ⚠️ 与思考守卫的**语义差异**（最关键）
   *
   * 思考死循环时模型**不产出工具调用**，故命中即可 `reader.cancel()` 止损。
   * 但正文循环**不一样**：实测三段的 wire 帧顺序恒为
   * `text-chunks(循环) → tool-call-chunks → block-end → finish: tool-calls`
   * —— **工具调用在循环正文之后才到达**，且调用有效、任务能继续。
   * 若在正文命中时 `cancel()`，会把这些调用**整块丢掉**，把「能继续的任务」
   * 变成「什么都不做就结束」，比循环本身更糟。
   *
   * 故正文守卫**只截断文本、不中止上游、不丢工具调用**，也**不**改写
   * `finish` 的 reason（调用仍要被执行）。
   */
  const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
  let proseLoopDetected = false
  // ⚠️ 此处**曾有** `proseHasThinkTag` 门禁变量，2026-09-27 **删除**。
  // 它逐帧匹配标签来决定收尾是否切分，而标签**必然跨帧**（上游可切成任意片段），
  // 实测二分帧时 7/11 种切法漏判 → 标签落盘泄漏。现改为收尾**无条件**调用
  // `splitThinkTaggedContent`（无标签时返回 undefined，普通响应逐字节不变）。
  // 详见收尾处的说明。
  /**
   * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
   * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
   *
   * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
   * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
   * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
   */
  const suppressor = createBlankReasoningSuppressor()
  const proseSuppressor = createBlankReasoningSuppressor()
  const toolCalls = new Map<number, {
    index: number
    text: string
    callId?: string
    name?: string
    /** 是否已发过 `block-start`（名字可用的那一刻才发，见下方 tool_calls 分支）。 */
    announced: boolean
  }>()
  const toolOrder: number[] = []
  const toolIds = new Map<number, string>()
  let buffer = ''
  let streamEnded = false
  let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
  /**
   * 是否已通过 `delta.content` 收到过正文。
   *
   * 用途：一旦为 true，就不再采纳 `message.content` 这条兼容回退路径，
   * 避免两种下发形态同时出现时把内容重复拼接。
   */
  let gotAnyContent = false
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let firstTokenReceived = false
  /**
   * 是否**至少解析过一帧 `data:`**（含 `[DONE]`）。
   *
   * 用途：区分「这是一个 SSE 流，只是没发完」与「这根本不是 SSE」
   * （网关直接回了一段 JSON 错误体）。后者若被静默忽略，就又是一次
   * 「没有任何报错就中断」——真实缺陷。
   */
  let sawDataFrame = false
  /**
   * 已读到的原始文本片段（**仅用于诊断**，上限 {@link RAW_SNIPPET_LIMIT} 字符）。
   *
   * 非 SSE 响应时把它拼进错误消息，否则用户只能看到一个没有原因的失败。
   */
  let rawSnippet = ''
  let rawJson = ''

  try {
    for (;;) {
      if (streamEnded) break
      let result
      try {
        const timeoutMs = firstTokenReceived ? config.chunkTimeoutMs : config.firstTokenTimeoutMs
        const phase = firstTokenReceived ? 'chunk' : 'first-token'
        result = await readWithIdleTimeout(reader, timeoutMs, label, options.signal, phase)
        if (!result.done) firstTokenReceived = true
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (error instanceof LlmError) throw error
        if (isTransportError(error)) {
          throw new LlmError(`${label}: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
        }
        throw error
      }
      if (result.done) break
      const decoded = decoder.decode(result.value, { stream: true })
      if (!sawDataFrame && config.isQuotaError !== undefined && rawJson.length < 65_536) {
        rawJson = (rawJson + decoded).slice(0, 65_536)
      }
      if (rawSnippet.length < RAW_SNIPPET_LIMIT) {
        rawSnippet = (rawSnippet + decoded).slice(0, RAW_SNIPPET_LIMIT)
      }
      buffer += decoded
      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith('data:')) continue
        sawDataFrame = true
        // 兼容 "data: {...}" 与 "data:{...}"（部分上游实测无空格）。
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          streamEnded = true
          break
        }
        let data: {
          error?: { message?: string }
          /**
           * Qoder 风格的**顶层**错误字段。
           *
           * ⚠️ 实测（2026-09-19）Qoder 的错误帧**不是** OpenAI 的
           * `{error:{message}}` 形态，而是：
           * ```
           * event: error
           * data: {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\"",
           *        "request_id":"...","type":"invalid_model_error"}
           * ```
           * 只判 `data.error` 会让整帧被当成「无内容」静默丢弃，
           * 用户看到「没回复就终止」（真实缺陷）。
           */
          code?: string | number
          message?: string
          type?: string
          request_id?: string
          /**
           * 网关错误帧的**状态码字段**（实测形态）。
           *
           * ⚠️ 这类帧**既没有 `code`、也没有 `error`、更没有 `choices`**，
           * 早期解析器会**整帧丢弃** → 表现为「干净地停止、无任何报错」。
           * 见 `docs/qoder-encryption-notes.md` §4。
           */
          statusCodeValue?: number
          /** 网关错误帧常带的调用栈（同样是「这是错误帧」的判据）。 */
          stackTrace?: unknown
          choices?: Array<{
            delta?: {
              content?: string | null
              reasoning_content?: string | null
              /**
               * 思考增量的**另一种字段名**（Cline 用这个）。
               */
              reasoning?: string | null
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            /** 有的上游把完整消息放在 message 而非 delta。 */
            message?: { content?: string | null }
            finish_reason?: string
          }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
            prompt_cache_hit_tokens?: number
          }
        }
        try {
          data = JSON.parse(payload)
        } catch {
          continue
        }
        throwIfModelQueued(data)
        // 旁路观测（如 Cline 的网关路由元数据）：失败绝不影响这次推理。
        if (config.onFrame !== undefined) {
          try {
            config.onFrame(data)
          } catch {
            // 观测是尽力而为，吞掉异常（见选项注释）。
          }
        }
        if (data.choices === undefined && config.isQuotaError?.(data)) {
          throw new LlmError(`${label}: ${errorDetail(payload)}`, 'QUOTA_EXCEEDED')
        }
        if (data.error !== undefined) {
          throw new LlmError(`${label}: ${data.error.message ?? 'unknown error'}`, 'SERVER')
        }
        // Qoder 风格错误：顶层 code/message/type（且无 choices）。
        // 判据要求**同时**出现 code 与 message，避免把正常帧里恰好叫
        // message 的字段误判成错误。
        if (
          data.choices === undefined
          && data.code !== undefined
          && typeof data.message === 'string'
        ) {
          // ⚠️ **排队识别：绝不能拿顶层 `code` 当门禁**（真实缺陷，用户报障
          // 2026-09-27 的**第三次**回归）。
          //
          // 实测帧（用户贴出的后缀 `(403/model_error)` 反推所得）：
          // ```json
          // { "code": 403,
          //   "message": "{\"code\":\"10605\",\"message\":\"{\\\"isQueued\\\":…}\"}",
          //   "type": "model_error" }
          // ```
          // **顶层 `code` 是 403，业务码 `10605` 在 `message` 里再嵌一层。**
          // 上一版写成 `if (isQueueBusinessCode(data.code))` —— 拿 403 比 10605
          // **必然不命中**，于是又落到 `SERVER`（这就是「修了两次仍失败」的原因）。
          //
          // 正确处理：**直接尝试解析 `message`**。`parseQueueError` 自身会递归
          // 遍历 `data`/`result`/`message`/`body` 并解析字符串，命中 `10605`
          // **或**出现排队标志即返回信息 —— 嵌套几层都能穿透。
          const queueInfo = parseQueueError(data.message)
          if (queueInfo !== undefined) {
            const retryAfterMs = queueDelayMs(queueInfo)
            throw new ModelQueuedError(
              `${label}: ${data.message}`,
              {
                queueInfo: { ...queueInfo },
                ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
              },
            )
          }
          // ⚠️ **额度用尽必须归为不可重试**（真实缺陷，用户报障 2026-09-27）：
          // 帧形如 `{code:110, message:"Billing daily count exceeded",
          // type:"model_error"}`，原先落到下面的 `SERVER` —— 而 `SERVER` **在**
          // harness 的 `DEFAULT_RETRYABLE_CODES` 里，于是「今日额度已用尽」这种
          // **确定性**错误被**白重试 5 次**（≈15.5 秒，用户看到 `重试延迟：7220毫秒`）。
          //
          // 客户端权威映射（obf 产物）：`billing_error` → `permission`（不重试），
          // 与 `rate_limit` → `rate_limited`（可重试）**明确分开**。
          // 故这里抛 `QUOTA_EXCEEDED`（harness 不将其列入可重试集合）。
          if (isBillingBusinessCode(data.code) || looksLikeBillingError(data.message)) {
            throw new LlmError(
              `${label}: ${data.message}`,
              'QUOTA_EXCEEDED',
              { ...(typeof data.code === 'number' ? { status: data.code } : {}) },
            )
          }
          const detail = [String(data.code), data.type].filter(Boolean).join('/')
          throw new LlmError(
            `${label}: ${data.message}${detail.length > 0 ? ` (${detail})` : ''}`,
            'SERVER',
          )
        }
        // ⚠️ **网关形态的错误帧**：既没有 `code`、也没有 `error`、也没有 `choices`，
        // 只带 `statusCodeValue` / `stackTrace` + `message`。
        // 早期解析器对这种帧**全部条件都不命中** → 整帧丢弃 → 流照常结束 →
        // 报 `{kind:'stop'}`，UI 表现为「没有任何报错就中断」（真实缺陷，
        // 与顶层 code/message 那条同源）。判据必须**显式覆盖**这一形态。
        //
        // ⚠️ **另有一条来自信封剥离的变体**：`unwrapQoderEnvelopeStream` 把
        // 内层错误统一转成 `{code?, message, type:'model_error'}`，此时
        // `statusCodeValue` 已被信封吃掉 —— 若只判 `statusCodeValue >= 400`，
        // **整帧会被静默丢弃**。故把 `type === 'model_error'` 也算作错误判据
        //（真实缺陷：网关形态的排队错误因此既不被识别、连报错都没有）。
        if (data.choices === undefined && typeof data.message === 'string') {
          const status = typeof data.statusCodeValue === 'number' ? data.statusCodeValue : undefined
          const looksLikeError = (status !== undefined && status >= 400)
            || data.stackTrace !== undefined
            || data.type === 'model_error'
          if (looksLikeError) {
            // ⚠️ **这一形态也可能是排队**（实测内层
            // `{statusCodeValue:403, message:"{…isQueued…}"}`，或信封剥离后的
            // `{message:"{…}", type:'model_error'}`）—— 都**没有顶层 `code`**，
            // 故必须靠 `message` 里的排队字段识别。
            const queueInfo = parseQueueError(data.message)
            if (queueInfo !== undefined) {
              const retryAfterMs = queueDelayMs(queueInfo)
              throw new ModelQueuedError(
                `${label}: ${data.message}`,
                {
                  queueInfo: { ...queueInfo },
                  ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
                },
              )
            }
            // ⚠️ 额度用尽同样要归为**不可重试**（与上面那条分支一致 ——
            // 两处判据必须同源，否则会重演「只修了一条通道」的缺陷）。
            if (looksLikeBillingError(data.message)) {
              throw new LlmError(`${label}: ${data.message}`, 'QUOTA_EXCEEDED', {
                ...(status === undefined ? {} : { status }),
              })
            }
            const suffix = status === undefined ? '' : ` (status=${status})`
            throw new LlmError(`${label}: ${data.message}${suffix}`, 'SERVER', {
              ...(status === undefined ? {} : { status }),
            })
          }
        }
        const choice = data.choices?.[0]
        const delta = choice?.delta
        if (typeof choice?.finish_reason === 'string') {
          finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
        }
        // `message.content` 只是**兼容回退**：它与 delta 是互斥的两种下发形态，
        // 不能同时采纳（无守卫的 `??` 会把两段都拼进去）。
        //
        // 注意 `typeof === 'string'` 而非 `!== undefined`：真实线上形态里
        // 一个模型要么走 content、要么走 reasoning_content，**另一侧恒为
        // `null`**。只判 undefined 会让 `.length` 在 null 上崩溃。
        const deltaContent = delta?.content
        const rawTextDelta = typeof deltaContent === 'string' && deltaContent.length > 0
          ? deltaContent
          : (!gotAnyContent && typeof choice?.message?.content === 'string' ? choice.message.content : undefined)
        if (typeof deltaContent === 'string' && deltaContent.length > 0) gotAnyContent = true
        const textDelta = rawTextDelta === undefined ? undefined : proseSuppressor.feed(rawTextDelta)
        if (textDelta !== undefined && textDelta.length > 0) {
          let block = blocks.find(candidate => candidate.kind === 'text')
          if (block === undefined) {
            block = { index: nextIndex++, kind: 'text', text: '' }
            blocks.push(block)
            yield { type: 'block-start', index: block.index, blockType: 'text' }
          }
          // 正文死循环守卫（见 `proseLoopGuard` 注释）。
          //
          // ⚠️ 与思考守卫的关键差异：命中后**只停止累积与发射**，**绝不**
          // `reader.cancel()`、**绝不**改 finish reason —— 实测正文循环的
          // 工具调用在循环正文**之后**到达且有效，中止上游会把它们整块丢掉。
          //
          // ⚠️ 本块仍要发 `block-end`（内容为截断后的前缀），否则
          // `BlockAssembler` 会拿全部已流出的 delta 组装出完整循环正文 ——
          // 截断必须靠收尾的权威覆盖落地（见 `block-end` 段）。
          if (proseLoopGuard !== undefined) {
            if (proseLoopGuard.observe(textDelta)) proseLoopDetected = true
          }
          // ⚠️ **不要在这里逐帧探测 think 标签**（2026-09-27 移除）。
          //
          // 历史实现用一个 `proseHasThinkTag` 布尔量当**门禁**，逐帧判
          // `textDelta.includes('</think>')`，命中才在收尾调切分。
          // 该门禁**在跨帧时必然漏判**：标签会被上游切成任意片段
          // （`思考<` + `/think>正文`、`思考</thi` + `nk>正文` …），
          // 实测（`scripts/probe-think-flag-split.mjs`）裸闭标签二分帧时
          // **7/11 种切法漏判** → 收尾不切分 → 标签原样落盘泄漏。
          // 这与本变量注释里自己写明的「标签可能跨帧到达，必须缓冲到收尾」
          // **自相矛盾** —— 门禁本身就是那个不该存在的逐帧判定。
          //
          // 现改为**收尾无条件调用** `splitThinkTaggedContent`：
          // 它无闭标签时返回 `undefined`，调用方走原路径，
          // 故普通响应仍**逐字节不变**（功能等价，只是多一次字符串扫描）。
          if (!proseLoopDetected) {
            block.text += textDelta
            yield { type: 'text-delta', index: block.index, text: textDelta }
          }
        }
        // 同样必须用 `typeof === 'string'`：reasoning_content 也会显式返回 null。
        //

        // **Cline 用 `reasoning`**（实测 SSE 形如
        // `{"delta":{"reasoning":"The","reasoning_details":[…]}}`）。
        // 只认前者会让 Cline 的思考内容被静默丢弃 —— 用户看到「模型不思考」，
        // 且 reasoning 档位切换看似无效（真实风险，见 cline-provider-design.md §2.5）。
        // 用 `??` 合并而非分别处理：同一帧只会出现其中一个，且两者语义相同。
        const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
        if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
          // 死循环守卫：命中后**不再累积、不再发射**该增量。
          // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
          // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
          // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
          // 若在此处直接 `break`，本 chunk 剩余的行会被整块跳过。
          //
          // ⚠️ 也**不能用 `continue`**（审查发现，已独立复现）：`continue` 跳过的是
          // 本帧**剩余全部**处理，而 `usage` 与 `tool_calls` 都在 reasoning 分支
          // **之后** —— 于是「reasoning + usage 同帧」时 usage 被静默丢弃
          // （token 记账缺失）。实测：混合帧收到 **0 个** usage chunk，而对照组
          // （未命中）为 **1 个**。
          // 可达性：扫描 281 会话 / **27949 个 attempt**，reasoning 帧与 usage 帧
          // 时间戳完全相同的次数为 **0**（相差 ≤2ms 也为 0）—— 真实流量中不可达，
          // 但修复成本为零，故仍按正确写法实现。
          if (loopGuard !== undefined) {
            if (loopGuard.observe(reasoningDelta)) loopDetected = true
          }
          if (!loopDetected) {
            // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
            // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释与 `blank-reasoning.spec.ts`）。
            const emit = suppressor.feed(reasoningDelta)
            if (emit !== undefined) {
              let block = blocks.find(candidate => candidate.kind === 'reasoning')
              if (block === undefined) {
                block = { index: nextIndex++, kind: 'reasoning', text: '' }
                blocks.push(block)
                yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
              }
              // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本，
              // 用 `+=` 会把已发过的部分再写一遍（双写）。
              block.text = suppressor.text()
              yield { type: 'reasoning-delta', index: block.index, text: emit }
            }
          }
        }
        for (const call of delta?.tool_calls ?? []) {
          const wireIndex = call.index ?? 0
          if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
          const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
          let block = toolCalls.get(wireIndex)
          if (block === undefined) {
            block = { index: nextIndex++, text: '', callId, announced: false }
            toolCalls.set(wireIndex, block)
          }
          block.callId = callId
          // 只允许非空名字覆盖：后续分片带空串 "" 会清空首个分片解析出的工具名，
          // 表现为 `unknown tool ""`。
          if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
            block.name = call.function.name
          }
          const fragment = call.function?.arguments ?? ''
          block.text += fragment
          // ⚠️ **名称为空前不发射任何 chunk**（2026-09-23 定位，用户报障）。
          //
          // 早期在这里**立即** `yield block-start` + `tool-call-delta`，名字稍后
          // 才到。可 qoder 偶发一个**永远不带 name** 的 tool-call 分片
          // （实测 seq=693：`{index:2, id:'call_25e9…', args:[""]}`）——
          // 于是 `BlockAssembler` 为它建了一个 partial，收尾时组装出
          // `{type:'tool-call', name:''}`。这条空名字块被 harness 执行成

          // 请求原样重放 → **HTTP 400 code 11133**，整条会话报废。
          //
          // 注意：**只跳过收尾的 `block-end` 是不够的** —— 上游
          // `BlockAssembler.assemble()` 对没有 `block-end` 的 partial 同样会
          // 组装出 `name: partial.toolCallName ?? ''`。必须让该块**一个 chunk
          // 都不产出**，assembler 才会彻底看不见它。
          //
          // 名字一旦可用就把**已累积的全部参数**一次性补发，后续分片增量发送：
          // 正常形态（首片即带 name）与旧行为完全一致。
          if (!block.announced) {
            if (!hasUsableToolName(block.name)) continue
            block.announced = true
            toolOrder.push(block.index)
            yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(callId),
              name: restoreToolName(block.name!),
              argumentsDelta: block.text,
            }
            continue
          }
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(callId),
            ...block.name !== undefined ? { name: restoreToolName(block.name) } : {},
            argumentsDelta: fragment,
          }
        }
        if (data.usage) {
          const promptTokens = data.usage.prompt_tokens ?? 0
          // 缓存命中字段有多处来源，取首个有值的。
          const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
            ?? data.usage.prompt_cache_hit_tokens
            ?? 0
          const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
          yield {
            type: 'usage',
            usage: {
              // inputTokens 只计**未命中缓存**的部分，命中部分单列
              // cacheReadTokens，否则缓存命中率显示会偏大。
              inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
              outputTokens: data.usage.completion_tokens ?? 0,
              ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
              ...reasoningTokens !== undefined && reasoningTokens > 0 ? { reasoningTokens } : {},
            },
          }
        }
      }
      // ★ 止损（终审 C1）：命中死循环后**中止上游**，否则 128000 token 照烧。
      // 原实现只跳过下行累积/发射，`for (;;)` 仍把流读到底 —— 实测上游
      // 200 帧被读 200 帧（守卫在 ~2304 字符即命中，99.5% 的额度仍被消耗）。
      //
      // ⚠️ 位置：内层行循环**之后**、外层 `for (;;)` 末尾 —— 同一 chunk 里已到达
      // 的 `usage` / `[DONE]` 因此仍会被处理，但命中后**立即**退出，不再读下一块。
      //
      // ⚠️ 只 cancel **reader**，绝不 abort `options.signal`：后者是调用方信号，
      // abort 会被上层报成「用户取消」而非**标记为不完整**的 `max-tokens`
      // （DSH 在 `max-tokens` 时**不自动重试**，由用户/上层决定是否继续）。
      // ⚠️ `.catch(() => {})` 不可省：连接已断时 `cancel()` 会抛错，不吞掉会把
      // 「正常止损」变成一次失败。
      if (loopDetected) {
        await reader.cancel().catch(() => {})
        break
      }
    }
  } finally {
    // releaseLock 不会终止上游，必须先取消响应再允许换号重发。
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  /**
   * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
   *
   * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
   * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
   * 或被清洗成空串的块。用 `blocks.length` 会让「零块响应」被误判成「有块」，
   * 于是静默结束的缺陷原样保留。
   *
   * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
   */
  let blockCount = 0
  /**
   * 本步**最终发出的正文**（`block-end` 的权威文本），供 finish 归类判定
   * 「是否被上游停止串截断」（见 `isProseTruncatedByStopString`）。
   *
   * ⚠️ 必须取**清洗后**的值：`stripBareThinkCloseTag` 可能把纯标签块清成空串，
   * 那种块**不会发射**，也就不是「被截断的正文」。
   */
  let emittedProse = ''
  // 按创建顺序关闭每个块
  const textBlock = blocks.find(block => block.kind === 'text')
  for (const index of toolOrder) {
    const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
    // `toolOrder` 只收「名字已可用」的块（见 tool_calls 分支），故此处名字必然
    // 可用；断言而非回退成 `?? ''` —— 回退会把空名字块写进会话，正是本次
    // 修复要根除的那条污染路径。
    //
    // ⚠️ 就当前实现而言本行是**不可达的防御**（`toolOrder` 的 push 已在
    // `hasUsableToolName` 守卫内，且 `block.name` 之后只被非空值覆盖）——
    // 已用变异测试证实把 `blockCount += 1` 移到本行**之前**结果不变。
    // 保留它是为「将来有人放宽 `toolOrder` 的入口条件」兜底；**不要**以为
    // 它此刻在承担判定职责。
    if (!hasUsableToolName(block.name)) continue
    blockCount += 1
    yield {
      type: 'block-end',
      index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.callId ?? ''),
        name: restoreToolName(block.name!),
        // 仅把「无参数工具下发的空分片」补成 {}；**残缺参数保持原样**，
        // 由 max-tokens 判定触发重试 —— 把残缺 JSON 补成 {} 会伪造出
        // 合法外观，让 harness 报 missing required property 而非重试。
        arguments: isTruncatedArguments(block.text)
          ? block.text
          : normalizeToolArguments(block.text),
      },
    }
  }
  if (textBlock !== undefined) {
    // ── think 标签归位（见 `splitThinkTaggedContent`）──
    //
    // ⚠️ **必须无条件调用，不得加「先探测有没有标签」的门禁**（2026-09-27 修）。
    // 标签会**跨帧**到达（`</think:61` + `24c78e>`，甚至 `思考<` + `/think>正文`），
    // 任何逐帧探测都会漏判 —— 实测二分帧时裸闭标签 **7/11 种切法漏判**，
    // 漏了就不切分、标签原样落盘泄漏给用户。
    //
    // 无标签时 `splitThinkTaggedContent` 返回 `undefined`，此处整段跳过，
    // 故普通响应**逐字节不变**（只是多一次字符串扫描，代价可忽略）。
    //
    // 归位语义：标签**前**的内心独白 → 既有 reasoning 块（或新建一个），
    // 标签**后**的真正文 → 本 text 块。覆盖配对/hex/裸三种形态。
    let textOut = textBlock.text
    {
      const split = splitThinkTaggedContent(textBlock.text)
      if (split !== undefined) {
        // 思考段并入既有 reasoning 块（实测有 3 步两者同时存在），
        // 保证不丢内容；顺序与到达顺序一致。
        //
        // ⚠️ **必须同时喂 `suppressor`**：收尾段以 `suppressor.text()` 为思考块
        // 的**权威**（见下方 reasoning 段注释），只改 `blocks` 里的条目不会
        // 影响落块内容 —— 这是本次实现踩过的坑（测试直接暴露）。
        if (split.reasoning !== '') {
          const existing = blocks.find(candidate => candidate.kind === 'reasoning')
          if (existing === undefined) {
            blocks.push({ index: nextIndex++, kind: 'reasoning', text: split.reasoning })
          } else {
            existing.text += split.reasoning
          }
          suppressor.feed(split.reasoning)
        }
        textOut = split.text
      }
    }
    // ── 残留标签**兜底剥离**（见 `stripBareThinkCloseTag`）──
    //
    // ⚠️ **默认关闭**（`DSH_THINK_LEAK_STRIP=1` 才启用）。用户决定（2026-09-27）：
    // > 暂时不需要泄露过滤……**加了过滤可能有思考解析失败但是被过滤我们发现不了。**
    // 即：兜底会**掩盖解析层的失败**。当前阶段要让泄漏**如实呈现**，
    // 才能观测「解析是否真的做对了」；确需应急再打开。
    //
    // ⚠️ **必须放在切分之后**（顺序不可颠倒）：切分负责「解析」，
    // 本行只兜底删掉切分没处理的**纯标签块**（无正文可解析的那种）。
    // 判据只认纯标签块 → 含正文的块原样返回，故模型**讨论**标签的正文不受影响。
    textOut = stripBareThinkCloseTagIfEnabled(textOut)
    // 正文死循环截断：只保留循环前的干净前缀（与思考守卫同一机制 ——
    // `block-end` 的 block 是**权威覆盖**，见 scripts/verify-blockend-override.ts）。
    //
    // ⚠️ 与思考守卫不同，这里**不改 finish reason**：实测正文循环的
    // 工具调用在循环之后到达且有效，调用必须照常执行。
    const truncatedText = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
      ? textOut.slice(0, proseLoopGuard.cutAt)
      : textOut
    // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
    const cleanedText = stripCourseLeakIfEnabled(truncatedText)
    // ⚠️ 归位后正文可能为空串（实测 seq=34768 形态：标签前 8845 字符、
    // 标签后仅 13 字符）。此时**不发射空 text 块** —— 空块会污染会话，
    // 且 DSH 的 `EMPTY_RESPONSE` 契约禁止产出空内容块。
    // 但**思考段已归位**，故本响应仍有内容产出，不会被误判为零块。
    if (cleanedText.trim() !== '') {
      blockCount += 1
      emittedProse = cleanedText
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: cleanedText } }
    } else {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: '' } }
    }
  }
  const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
  // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考块（helper 未转正时不会建块，
  // 但兜底仍按整块 trim 判定）不得被当成「有 reasoning 产出」。
  if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
    // 命中死循环时只保留循环前的干净前缀（`cutAt`）。
    // 实测 `BlockAssembler` 的 `block-end` 是**权威覆盖**：即便前面已 yield
    // 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
    //
    // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
    // `reasoningBlock.text` —— 两处累积口径若不一致（例如 `+=` 双写），
    // 以 helper 为准才能保证落块内容与 wire 一致。
    const suppressedReasoning = suppressor.text()
    const reasoningText = loopDetected && loopGuard?.cutAt !== undefined
      ? suppressedReasoning.slice(0, loopGuard.cutAt)
      : suppressedReasoning
    const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText)
    if (cleanedReasoning !== '') {
      blockCount += 1
      yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: cleanedReasoning } }
    }
  }
  // 三种「不完整」都必须报告 max-tokens 而非 tool-calls：
  // - 'length'：被 max_tokens 显式截断；
  // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
  // - 参数无法解析：分片丢失（并行工具调用时偶发）。
  // 报告 tool-calls 会让 harness 执行缺参调用并报 schema 错误，
  // 模型收到莫名错误后陷入重试循环；报告 max-tokens 则丢弃并重试。
  const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
  const incompleteTools = finishReason === undefined && toolOrder.length > 0
  /**
   * 是否丢弃过**名称不可用**的 tool-call 块（见上方 tool_calls 分支）。
   *
   * 丢弃它们是对的（它们无法执行，且留着会污染会话），但**不能让这一步
   * 静默地以 `stop` 结束** —— 那正是 AGENTS.md 记录的「没有任何报错就中断」
   * 那一类现象：模型本意要调工具，harness 却认为它「正常答完了」。
   * 故与截断同策：报 `max-tokens`（不完整、可重试），让 harness 重跑该步。
   */
  const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced)

  // ⚠️ **「根本没有任何 `data:` 帧」必须先判**：这不是「SSE 流没发完」，
  // 而是「响应压根不是 SSE」（网关/错误页直接回了一段 JSON）。
  // 若与下面的截断判定混在一起，用户只会看到一个没有原因的失败。
  if (!sawDataFrame) {
    let data: unknown
    try { data = JSON.parse(rawJson) } catch {}
    throwIfModelQueued(data)
    if (typeof data === 'object' && data !== null && !Array.isArray(data)
      && config.isQuotaError?.(data as Record<string, unknown>)) {
      throw new LlmError(`${label}: ${errorDetail(rawJson)}`, 'QUOTA_EXCEEDED')
    }
    const snippet = rawSnippet.trim()
    if (snippet.length > 0) {
      throw new LlmError(
        `${label}: 响应不是 SSE（没有任何 data: 帧），原文片段：${snippet}`,
        'SERVER',
      )
    }
    // 空响应体：连接建立后立刻结束，属不完整 → 交由下面的 max-tokens 处理。
  }

  /**
   * 连接是否**被掐断**：既没有显式 `finish_reason`，也没有收到 `[DONE]`。
   *
   * ⚠️ 这是「**没有任何报错就中断**」的根治点（用户报障，2026-09-23）。
   * 旧判定把「未收到 finish_reason」与「有工具调用」绑在一起：
   *
   * ```ts
   * finishReason === undefined && toolOrder.length > 0
   * ```
   *
   * 于是**断在正文/即将调用工具时被静默接受** —— 直接报 `{kind:'stop'}`，
   * 而 `stop` 的含义是「模型正常答完」。harness 认为本轮已完成，
   * 任务就此中断且没有任何报错。
   *
   * 判据必须是「**连接结束的方式**」：
   * - 收到 `[DONE]`（`streamEnded`）或显式 `finish_reason` → 上游宣告结束，合法；
   * - **两者都没有** → 连接被掐断 → 报 `max-tokens`（不完整、可重试）。
   *
   * 真实会话证据：某步骤的 chunk 流只有
   * `block-start → text-chunks → usage → block-end → finish{kind:'stop'}`，
   * 正文以冒号「：」结尾（模型正要调工具），全程无 tool-call 分片，
   * `outputTokens=319` 远未触上限 —— 典型的「断在即将调用工具处」。
   */
  const truncatedStream = finishReason === undefined && !streamEnded

  /**
   * 正文是否被**上游停止串**掐断（见 `isProseTruncatedByStopString`）。
   *
   * ⚠️ **用户报障的真实缺陷**（2026-09-27）：「正文引用 `</think>` 导致对话中断」。
   * 上游把 `</think>` 当停止串，模型在正文里写它（哪怕包在反引号里）就会被掐断，
   * 但服务端仍报 `finish_reason:"stop"` —— 我们据此判「模型正常答完」，
   * harness 认为本轮已完成 → **没有任何报错就停住**（与 AGENTS.md 记的
   * 「静默中断」同一类）。
   *
   * 判据收紧为**三条同时成立**，避免误伤正常回答：
   *   1. 上游报 `stop`（`length` / 中途断流已被上面的分支覆盖，不必重复）；
   *   2. **本步没有可执行的工具调用** —— 有工具调用说明模型是「写完就去调工具」，
   *      正文以反引号收尾只是碰巧（实测判据 B 的 3 个命中全都是无工具调用的收尾步）；
   *   3. 正文止于**未闭合的行内代码**（反引号奇数且以反引号收尾）。
   *
   * 报 `max-tokens`（不完整、可重试）而非 `stop`：DSH 收到 `max-tokens` 会
   * 结束本轮并提示用户，**不会**把半句话当成完整答复 —— 用户可据此继续。
   * ⚠️ 不可报 `tool-calls`：本步没有工具调用，报它会让 harness 空执行。
   */
  const proseCutByStopString = finishReason === 'stop'
    && toolOrder.length === 0
    && isProseTruncatedByStopString(emittedProse)

  /**
   * 本次思考死循环是否**是唯一的产出**（无正文、无工具调用）。
   *
   * ⚠️ 这层门禁**不可省** —— 用户的要求正是「**如果只是**陷入思考循环的出错，
   * 就要给出有分辨力的错误提示」：
   *
   * | 命中时的产出 | 报什么 | 为什么 |
   * |---|---|---|
   * | **只有思考**（实测 25/25 例都是这种）| `error` + `REASONING_LOOP` | 可见内容为零，报 error 不丢东西，且文案有分辨力 |
   * | 还有正文或工具调用 | `max-tokens`（保持原行为）| error 路径**不落 `assistant/message`**，会把用户可见内容整块丢掉 |
   *
   * 后一行的代价已实测（`scripts/probe-error-finish-content-loss.mjs`）：
   * `finish=error` 的步**确实不落 message**（219 会话里 222 例），
   * 故有可见产出时**绝不能**走 error —— 那会把「文案误导」换成「内容消失」，更糟。
   */
  const reasoningLoopIsSoleOutput = loopDetected
    && emittedProse === ''
    && toolOrder.length === 0

  const reason = reasoningLoopIsSoleOutput
    // 思考死循环：报**有分辨力的 error**（见 REASONING_LOOP_CODE 的长注释）。
    //
    // ⚠️ **不能报 max-tokens**（真实缺陷，Gitee !IKIZNK）：UI 对 max-tokens 只有
    // 一句固定文案「已达到输出 token 上限 / 发送"继续"可让模型接着输出」，
    // 把「检测到死循环」误导成「额度用满」，且建议的「继续」往往立刻再次循环
    // （实测 25 例全部由用户手动补「继续」，其中 2 次用户自己诊断出「陷入思考循环」）。
    ? { kind: 'error' as const, failure: reasoningLoopFailure(
        loopGuard?.diagnostics,
        config.maxTokens,
        'reasoning',
      ) }
    // 循环命中但**另有可见产出**：只能报 max-tokens（保住内容），
    // 不能报 error（会丢内容）。见上面 `reasoningLoopIsSoleOutput` 的表格。
    : loopDetected
      ? { kind: 'max-tokens' as const }
    : finishReason === 'length'
    || incompleteTools
    || truncatedStream
    || argsTruncated
    || proseCutByStopString
    // 丢弃了无名 tool-call、且**没有**任何可用调用留下来时，本步否则会以
    // `stop` 收场 —— 模型本意要调工具、harness 却认为「正常答完了」，
    // 又是一次无报错中断。报 max-tokens 让它重试。
    //
    // 若同批还有可用调用（`toolOrder.length > 0`），则照常报 `tool-calls`：
    // 那几个调用与无名块各自独立，没理由因一个坏块把它们一起作废
    // （实测线上形态正是「一个无名 + 一个合法 pwsh」）。
    || (droppedUnnamedCalls && toolOrder.length === 0)
    ? { kind: 'max-tokens' as const }
    : finishReason === 'tool_calls' || toolOrder.length > 0
      ? { kind: 'tool-calls' as const }
      : { kind: 'stop' as const }
  // 零内容块响应（例如本次只收到过那个被压制的空白 reasoning）否则会以
  // `stop` 收场 —— 那是 DSH `EMPTY_RESPONSE` 契约明令禁止的静默结束。
  // ⚠️ 传入的是**上面已算好的** `reason`：`loopDetected` / `length` /
  // 无名 tool-call 等既存判据全在里面，helper 只在 `kind === 'stop'` 时才改写，
  // 故天然不冲突。
  yield { type: 'finish', reason: resolveEmptyResponseReason(reason, blockCount) }
}
