/**
 * ZCode 免费额度通道的 **Anthropic Messages 协议层**。
 *
 * ## 为什么需要单独一层（不能复用 `openai-compat.ts`）
 *
 * ZCode 免费通道**只认 Anthropic Messages 格式**（实测：`zcode-plan` 下
 * 的 `openai` / 裸 `v1/chat/completions` 路径一律 `404 page not found`，只有
 * `/api/v1/zcode-plan/anthropic/v1/messages` 存在——在索要验证的窗口里无 captcha
 * 时它回 `3007` 而不是 404；上游不要验证的那些窗口里它会直接 200（见 README 的
 * ZCode 章节实测表），但**端点存在**这条结论两种形态都支持）。
 *
 * 而 `openai-compat.ts` 的 `serializeMessages()` 产出的是 **OpenAI 形态**
 * （`tool_calls` / `tool_call_id` / `tools[].function`）—— 喂给 Anthropic
 * 端点必 400。故需要一个转换层：
 *
 * ```
 * DSH Message[]  ──serializeMessages──▶  OpenAI 形态
 *                        │
 *                        └──本文件─▶ Anthropic Messages 形态（system 块数组 + tools[].input_schema）
 *
 * Anthropic SSE ──本文件──▶ StreamChunk（block-start / text-delta / tool-call-delta / block-end）
 * ```
 *
 * ## Anthropic Messages 的关键形态差异（都是实测/规范确认的坑）
 *
 * | 维度 | OpenAI | Anthropic |
 * |---|---|---|
 * | system | `messages[0].role='system'` | **顶层 `system` 字段**（块数组） |
 * | 工具声明 | `tools[].function.{name,description,parameters}` | **`tools[].{name,description,input_schema}`**（扁平） |
 * | 工具调用（assistant） | `tool_calls:[{id,function:{name,arguments}}]`（字符串 JSON） | **`content:[{type:'tool_use',id,name,input}]`**（**对象**，非字符串） |
 * | 工具结果 | `{role:'tool',tool_call_id,content}` | **`{role:'user',content:[{type:'tool_result',tool_use_id,content}]}`** |
 * | SSE 结束 | `data: [DONE]` | `message_stop` 事件（**无** `[DONE]`） |
 * | 思考 | `delta.reasoning_content` | **`content_block_delta` 的 `thinking_delta`** |
 *
 * ⚠ 两个最容易踩的：`tool_use.input` 是**对象**（不是 JSON 字符串）；
 * 工具结果必须包成 `role:'user'` 里的 `tool_result` 块（不是独立的 `tool` 角色）。
 */

import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import { readWithIdleTimeout } from './sse.js'

/** Anthropic 内容块（本实现用到的子集）。 */
export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
    type: 'tool_result'
    tool_use_id: string
    content: string | Array<Record<string, unknown>>
    is_error?: boolean
  }

/** Anthropic 消息。 */
export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicBlock[]
}

/** Anthropic 工具声明（**扁平**，不是 OpenAI 的嵌套 `function`）。 */
export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

/** 把 JSON 字符串安全解析成对象（Anthropic 要对象，不要字符串）。 */
export function parseToolArguments(raw: unknown): unknown {
  if (raw === undefined || raw === null) return {}
  if (typeof raw === 'object') return raw
  if (typeof raw !== 'string') return {}
  const trimmed = raw.trim()
  if (trimmed.length === 0) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    /**
     * ⚠ **不补 `{}`** —— 与 `openai-compat.ts` 的同款约定：残缺参数应当
     * 让 harness 报 schema 错误并重试，而不是被静默当成「无参数调用」
     * （那会让工具收到空参数并可能做出破坏性动作）。
     * 这里返回一个哨兵对象，由调用方决定如何报错。
     */
    return { __zcodeUnparsableArguments: trimmed }
  }
}

/** 从 OpenAI 形态的消息里取文本（`content` 可能是字符串或块数组）。 */
function toText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (record.type === 'input_text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}

/**
 * 把 OpenAI 形态的 image 块转成 Anthropic 的 `image` 块。
 *
 * ## 形态依据（逆向官方 agent `resources/glm/zcode.cjs`）
 *
 * 官方 Anthropic 路径的原文：
 *
 * ```js
 * case "file":
 *   if (Dt.mediaType.startsWith("image/"))
 *     $e.push({
 *       type: "image",
 *       source: { type: "base64",
 *                 media_type: Dt.mediaType === "image/*" ? "image/jpeg" : Dt.mediaType,
 *                 data: g2(Dt.data) },
 *       cache_control: cn,
 *     })
 * ```
 *
 * 其中 `g2(e)` 是 `e instanceof Uint8Array ? q3(e) : e` —— 即
 * **已经是字符串就原样用**（我们这边拿到的是 base64 字符串，直接透传）。
 *
 * ⚠ **`media_type === 'image/*'` 归一为 `image/jpeg`** —— 这是官方的
 * 兜底：上游只认具体 mime，收到通配符会拒。照抄这个分支，
 * 否则用 `image/*` 表示「任意图」的客户端会全员失败。
 */
function toImageBlock(block: Record<string, unknown>): AnthropicBlock | undefined {
  const imageUrl = block.image_url
  const url = typeof imageUrl === 'string'
    ? imageUrl
    : typeof imageUrl === 'object' && imageUrl !== null
      ? (imageUrl as { url?: unknown }).url
      : undefined
  if (typeof url !== 'string') return undefined
  const match = /^data:([^;]+);base64,(.*)$/.exec(url)
  if (match === null) return undefined
  const rawMediaType = match[1] ?? 'image/png'
  // ⚠ 与官方一致：通配符归一为 image/jpeg（上游只认具体 mime）。
  const mediaType = rawMediaType === 'image/*' ? 'image/jpeg' : rawMediaType
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: match[2] ?? '' },
  }
}

/**
 * 把 OpenAI 形态的消息序列转成 Anthropic Messages 形态。
 *
 * ## 转换规则（逐条对应上表的差异）
 *
 * 1. `role: 'system'` 的消息**抽出来**（Anthropic 用顶层 `system` 字段）——
 *    由 `splitSystemMessages()` 做，本函数只处理 user/assistant/tool。
 * 2. `role: 'tool'` → 包成 `role:'user'` 的 `tool_result` 块。
 *    连续多个 tool 结果会**合并到同一条 user 消息**（Anthropic 允许，
 *    且比发多条 user 消息更贴近官方形态）。
 * 3. assistant 的 `tool_calls` → `content:[{type:'tool_use',…}]`，
 *    `arguments`（字符串）→ `input`（**对象**）。
 * 4. assistant 的文本与 tool_use 可在同一条消息里共存。
 */
export function toAnthropicMessages(
  wire: readonly Record<string, unknown>[],
): AnthropicMessage[] {
  const out: AnthropicMessage[] = []

  /** 把 tool 结果合并进最后一条 user 消息（若可行）。 */
  const pushToolResult = (block: AnthropicBlock): void => {
    const last = out[out.length - 1]
    if (last !== undefined && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push(block)
      return
    }
    out.push({ role: 'user', content: [block] })
  }

  for (const message of wire) {
    const role = message.role

    if (role === 'tool') {
      const toolUseId = typeof message.tool_call_id === 'string' ? message.tool_call_id : ''
      if (toolUseId.length === 0) continue // 孤儿工具结果：丢弃（Anthropic 会 400）
      pushToolResult({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: toText(message.content),
      })
      continue
    }

    if (role === 'assistant') {
      const blocks: AnthropicBlock[] = []
      const text = toText(message.content)
      if (text.length > 0) blocks.push({ type: 'text', text })
      const toolCalls = message.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
          if (typeof call !== 'object' || call === null) continue
          const record = call as Record<string, unknown>
          const fn = record.function
          const name = typeof fn === 'object' && fn !== null
            ? (fn as { name?: unknown }).name
            : undefined
          if (typeof name !== 'string' || name.length === 0) continue
          const rawArgs = typeof fn === 'object' && fn !== null
            ? (fn as { arguments?: unknown }).arguments
            : undefined
          blocks.push({
            type: 'tool_use',
            id: typeof record.id === 'string' && record.id.length > 0 ? record.id : `call_${out.length}`,
            name,
            input: parseToolArguments(rawArgs),
          })
        }
      }
      if (blocks.length === 0) continue // 空 assistant 消息会让上游 400
      out.push({ role: 'assistant', content: blocks })
      continue
    }

    // user（含多模态）
    const content = message.content
    if (typeof content === 'string') {
      if (content.length > 0) out.push({ role: 'user', content })
      continue
    }
    if (!Array.isArray(content)) continue
    const blocks: AnthropicBlock[] = []
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const record = block as Record<string, unknown>
      if (record.type === 'text' && typeof record.text === 'string') {
        blocks.push({ type: 'text', text: record.text })
        continue
      }
      if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image') {
        const image = toImageBlock(
          record.type === 'input_image' && typeof record.image_url === 'string'
            ? { image_url: record.image_url }
            : record,
        )
        if (image !== undefined) blocks.push(image)
      }
    }
    if (blocks.length === 0) continue
    out.push({ role: 'user', content: blocks })
  }

  return out
}

/** 把 OpenAI 形态的工具表转成 Anthropic 的扁平 `input_schema` 形态。 */
export function toAnthropicTools(
  tools: readonly { name: string; description?: string; parameters?: Record<string, unknown> }[],
): AnthropicTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...tool.description !== undefined && tool.description.length > 0
      ? { description: tool.description }
      : {},
    input_schema: tool.parameters ?? { type: 'object', properties: {} },
  }))
}

/** Anthropic SSE 事件的名字（用于快速分派）。 */
export type AnthropicSseEvent =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error'

/** 解析一行 `event:` / `data:` 对。 */
export interface SseFrame {
  event?: string
  data: string
}

/**
 * 把原始 SSE 文本流切成帧。
 *
 * ⚠ Anthropic 的 SSE 与 OpenAI **同构**（`event:` + `data:` 行、空行分隔），
 * 但**没有 `data: [DONE]`** —— 结束靠 `message_stop` 事件。
 * 故不能复用 `consumeOpenAiSse`（它找 `[DONE]`）。
 *
 * ## `idleTimeoutMs`：**空闲超时**（不是整轮墙钟）—— 真实缺陷 IKJOVB
 *
 * 旧实现（本函数的 `reader.read()` 裸调用）配合 `zcode-adapter.ts` 那个
 * **整轮 180s 墙钟**定时器，导致「模型一旦长时间大思考就必然超时」
 * （用户报障：雷霆大思考 → 3 分钟被截断 → 直接重试 → 又大思考 → 又被截断）。
 *
 * 官方 ZCode 的做法（`resources/glm/zcode.cjs` minify 产物还原）是
 * **空闲超时**，逐字对齐如下：
 *
 * ```js
 * YV = 6e5                                  // modelStream.idleTimeoutMs = 600_000ms
 * RRs = 3e4                                 // 每次重试 +30s
 * gzr = (baseTimeoutMs, retryNumber) => baseTimeoutMs + retryNumber * RRs
 * async function readNextWithStreamIdleTimeout(it, { timeoutMs }) {
 *   return Promise.race([ it.next(), idleTimer(timeoutMs), abortPromise ])
 * }
 * ```
 *
 * 即：**每收到一帧就重新计时**，只有「连续 N ms 一个字节都没有」才判死；
 * 总时长（哪怕十几分钟）本身**不**构成超时。官方**没有**保活、没有 ack、
 * 也**没有**对思考帧的特判 —— `thinking_delta` 与普通帧走同一个循环。
 *
 * ⚠ 不传（或传 ≤0）时退化为**无空闲超时**，保持旧行为 —— 由上层
 * `zcode-adapter.ts` 的整轮墙钟兜底。
 */
export async function* iterateSseFrames(
  body: ReadableStream<Uint8Array>,
  options: {
    signal?: AbortSignal
    /**
     * 空闲超时（毫秒）：连续这么久没读到任何字节就抛错。**每帧续期**，
     * 所以总时长可以远超该值。缺省 / ≤0 ⇒ 不启用。
     */
    idleTimeoutMs?: number
    /** 空闲超时的标签（错误消息前缀用），缺省 'zcode'。 */
    label?: string
  } = {},
): AsyncIterable<SseFrame> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const signal = options.signal
  const idleTimeoutMs = options.idleTimeoutMs ?? 0
  const label = options.label ?? 'zcode'
  let buffer = ''
  /**
   * ★★ **中断必须在「读挂起」时也生效**（真实缺陷，2026-09-29）。
   *
   * 只在循环顶部检查 `signal.aborted` 是**不够的**：一旦上游建立了连接却不吐
   * 数据（智谱免费通道首字节实测有 20 秒以上长尾，也会整段静默），
   * `await reader.read()` 就永远挂着 —— 而它**不会被 abort 唤醒**。
   *
   * 症状（用户报障，本机三次实测）：UI 永远停在「深度求索中，用时 5分27秒…」，
   * 模型既不输出推理也不输出正文，**「停止」按钮点了没反应**，只能重启宿主。
   * 会话日志里的收尾事件 `step/end` + `turn/end{kind:'interrupted'}` 与
   * `step/start` **同一毫秒** —— 那是 `dsh-session` 的 `openTurnClosers()`
   * repair 时合成的（「复用最后一个真实事件的时间戳」），
   * 真相是这个 turn **从未结束**。
   *
   * ⇒ 故在 abort 时**主动 `reader.cancel()`**：取消底层流会让挂起的 `read()`
   * 立刻以 `{ done: true }` 收尾。这是唯一能唤醒它的手段。
   */
  const onAbort = (): void => {
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (;;) {
      // 兜底：cancel 未生效（或 signal 在 read 之前就已 abort）时也能退出。
      if (signal?.aborted === true) break
      /**
       * ★ 空闲超时**每帧续期**（IKJOVB）：`readWithIdleTimeout` 每次调用都新建
       * 一个计时器，只覆盖「这一帧的等待」。因此「持续吐思考帧 10 分钟」不会被
       * 误判超时，而「整段静默」仍会在 `idleTimeoutMs` 后落定。
       *
       * ⚠ 这里**不能**改回裸 `reader.read()`：那会让长思考重新被上层整轮墙钟
       * 砍断（本 issue 的原始形态）。
       */
      const { done, value } = idleTimeoutMs > 0
        ? await readWithIdleTimeout(reader, idleTimeoutMs, label, signal)
        : await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      // SSE 以空行分隔事件（兼容 \n\n 与 \r\n\r\n）。
      for (;;) {
        const boundary = findFrameBoundary(buffer)
        if (boundary === undefined) break
        const rawFrame = buffer.slice(0, boundary.start)
        buffer = buffer.slice(boundary.end)
        const frame = parseFrame(rawFrame)
        if (frame !== undefined) yield frame
      }
    }
    // 收尾：可能还有最后一个未以空行结束的帧。
    const tail = parseFrame(buffer)
    if (tail !== undefined) yield tail
  } finally {
    signal?.removeEventListener('abort', onAbort)
    /**
     * ⚠ 必须**先 `cancel()` 再 `releaseLock()`**（同型缺陷，参照
     * `dsh-free-glm` 的 `adapter.ts`）：`releaseLock()` **不关闭底层流**，
     * 只解除 reader 的占用 ⇒ 上游连接会一直挂着、继续生成并**白扣额度**。
     * 流已正常读完时 `cancel()` 是 no-op，故无条件调用是安全的。
     */
    try {
      await reader.cancel()
    } catch {
      /* 流可能已关闭或已被取消 —— 不影响主流程 */
    }
    reader.releaseLock()
  }
}

/**
 * 找到**最早**的空行分隔符（兼容 CRLF）。
 *
 * ⚠ 不能先查 `\n\n` 再查 `\r\n\r\n` —— 在 CRLF 流里 `\r\n\r\n` 同时
 * 也包含一个 `\n\n`（第 2-3 字节），先查 LF 会切在错误位置
 * （把 `\r` 留在下一帧开头）。故必须取两者中**更早**的那个。
 */
function findFrameBoundary(buffer: string): { start: number; end: number } | undefined {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1 && crlf === -1) return undefined
  if (crlf === -1) return { start: lf, end: lf + 2 }
  if (lf === -1) return { start: crlf, end: crlf + 4 }
  return crlf < lf ? { start: crlf, end: crlf + 4 } : { start: lf, end: lf + 2 }
}

/** 解析一个 SSE 帧的原始文本。 */
export function parseFrame(raw: string): SseFrame | undefined {
  const lines = raw.split(/\r?\n/)
  let event: string | undefined
  const dataLines: string[] = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0 && event === undefined) return undefined
  return { event, data: dataLines.join('\n') }
}

/**
 * 把 Anthropic SSE 流转换成 DSH 的 `StreamChunk` 流。
 *
 * ## 事件映射
 *
 * | Anthropic 事件 | 产出 |
 * |---|---|
 * | `content_block_start`（`text`） | `block-start`（blockType `text`） |
 * | `content_block_start`（`thinking`） | `block-start`（blockType `reasoning`） |
 * | `content_block_start`（`tool_use`） | 记录 id/name（等 `input_json_delta`） |
 * | `content_block_delta`（`text_delta`） | `text-delta` |
 * | `content_block_delta`（`thinking_delta`） | `reasoning-delta` |
 * | `content_block_delta`（`input_json_delta`） | `tool-call-delta` |
 * | `content_block_stop` | `block-end` |
 * | `error` | 抛 `LlmError` |
 *
 * ⚠ `error` 事件**必须抛错**（`AGENTS.md` 记过 Qoder 的同型缺陷：
 * 错误被静默当成「正常结束、无内容」，UI 表现为「干净地停止、无任何报错」）。
 */
export async function* consumeAnthropicSse(
  body: ReadableStream<Uint8Array>,
  options: {
    label: string
    model: string
    signal?: AbortSignal
    /**
     * 空闲超时（毫秒），透传给 {@link iterateSseFrames}。
     * ⚠ 每帧续期，故它管的是「静默多久算死」，**不是**整轮时长上限
     * （真实缺陷 IKJOVB）。缺省 ⇒ 不启用。
     */
    idleTimeoutMs?: number
  },
): AsyncIterable<StreamChunk> {
  /**
   * ## 为什么**先缓冲再发射**（而不是边收边发）
   *
   * DSH 的 `StreamChunk` 契约里，`block-end` **必须携带完整的 `block`**
   * （见 dsh-llm 的 `ContentBlock`）—— 它不是一个「结束标记」，
   * 而是「这一块的最终内容」。所以正文/思考必须以**整块**形式在
   * `block-end` 里给出，而 `*-delta` 只是增量预览。
   *
   * 这与 `openai-compat.ts` 的 `consumeOpenAiSse` 完全同构
   * （那边也是 `blocks[]` 缓冲 + 收尾统一 `block-end`）。
   */
  const blocks: Array<{
    index: number
    kind: 'text' | 'reasoning' | 'tool-call'
    text: string
    callId: string
    name: string
    argumentsRaw: string
  }> = []
  const blockByIndex = new Map<number, (typeof blocks)[number]>()
  /** tool_use 的 id/name 在 `content_block_start` 里给，先记下来。 */
  const toolMeta = new Map<number, { id: string; name: string }>()
  /** 已发过 `block-start` 的 index（tool-call 延后到内容出现）。 */
  const started = new Set<number>()
  let sawAny = false

  /**
   * ★ usage 累计（`message_start` 给 input，`message_delta` 给 output）。
   *
   * ⚠ 用「有值才覆盖」而非直接赋值：两处事件各自只带一部分字段，
   * 直接赋值会让后到的 `message_delta`（无 input_tokens）把先前读到的
   * input 冲成 `undefined`。
   */
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let cacheReadTokens: number | undefined
  let cacheWriteTokens: number | undefined
  /** `message_delta.delta.stop_reason`（Anthropic 的结束原因）。 */
  let stopReasonSeen: string | undefined

  /** 从一段 usage 对象里挑出已知字段（有值才记）。 */
  const collectUsage = (usage: unknown): void => {
    if (typeof usage !== 'object' || usage === null) return
    const u = usage as Record<string, unknown>
    const num = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) ? v : undefined
    inputTokens = num(u.input_tokens) ?? inputTokens
    outputTokens = num(u.output_tokens) ?? outputTokens
    /**
     * ⚠ **缓存口径必须分清**（与 `openai-compat.ts` 同款约定）：
     * `cache_read_input_tokens` 是**命中缓存**的部分，
     * `cache_creation_input_tokens` 是**写入缓存**的部分。
     * 它们**不计入** `inputTokens`，否则缓存命中率会显示偏大
     * （Anthropic 的 `input_tokens` 本身就只含未命中部分）。
     */
    cacheReadTokens = num(u.cache_read_input_tokens) ?? cacheReadTokens
    cacheWriteTokens = num(u.cache_creation_input_tokens) ?? cacheWriteTokens
  }

  const ensureBlock = (
    index: number,
    kind: 'text' | 'reasoning' | 'tool-call',
  ): (typeof blocks)[number] => {
    const existing = blockByIndex.get(index)
    if (existing !== undefined) return existing
    const meta = toolMeta.get(index)
    const block = {
      index,
      kind,
      text: '',
      callId: meta?.id ?? `call_${index}`,
      name: meta?.name ?? '',
      argumentsRaw: '',
    }
    blocks.push(block)
    blockByIndex.set(index, block)
    return block
  }

  // ⚠ 必须把 signal 透传下去：中断/超时要能在「读挂起」时唤醒（见 `iterateSseFrames`）。
  for await (const frame of iterateSseFrames(body, {
    signal: options.signal,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    label: options.label,
  })) {
    const eventName = frame.event
    if (frame.data.length === 0) continue

    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(frame.data) as Record<string, unknown>
    } catch {
      continue // 非 JSON 帧（ping 等）忽略。
    }

    /**
     * ⚠ **错误必须抛**。
     *
     * `AGENTS.md` 记过同型缺陷：Qoder 的错误帧被静默当成「正常结束、
     * 无内容」，UI 表现为「干净地停止、无任何报错」。
     * Anthropic 的错误既可能在 `event: error` 行，也可能在 `payload.type`。
     */
    if (eventName === 'error' || payload.type === 'error') {
      const error = payload.error
      const message = typeof error === 'object' && error !== null
        ? (error as { message?: unknown }).message
        : undefined
      const type = typeof error === 'object' && error !== null
        ? (error as { type?: unknown }).type
        : undefined
      throw new LlmError(
        `${options.label}: ${typeof message === 'string' ? message : JSON.stringify(payload).slice(0, 300)}`,
        // overloaded 是暂时性的，值得重试；其余按服务端错误处理。
        type === 'overloaded_error' ? 'RATE_LIMIT' : 'SERVER',
      )
    }

    const type = typeof payload.type === 'string' ? payload.type : eventName
    /** Anthropic 的事件里 `index` 标识内容块；缺省当作第 0 块。 */
    const index: number = typeof payload.index === 'number' ? payload.index : 0

    if (type === 'content_block_start') {
      const block = payload.content_block
      const blockType = typeof block === 'object' && block !== null
        ? (block as { type?: unknown }).type
        : undefined
      if (blockType === 'tool_use') {
        const record = block as { id?: unknown; name?: unknown }
        toolMeta.set(index, {
          id: typeof record.id === 'string' ? record.id : `call_${index}`,
          name: typeof record.name === 'string' ? record.name : '',
        })
        /**
         * ⚠ tool-call 的 `block-start` **延后**到它有名字或参数时再发 ——
         * 否则会产出一个「空 tool-call 块」，DSH 侧会因缺 `name` 而不可用。
         */
      } else if (blockType === 'thinking' || blockType === 'redacted_thinking') {
        ensureBlock(index, 'reasoning')
        started.add(index)
        yield { type: 'block-start', index, blockType: 'reasoning' }
      } else {
        ensureBlock(index, 'text')
        started.add(index)
        yield { type: 'block-start', index, blockType: 'text' }
      }
      continue
    }

    if (type === 'content_block_delta') {
      const delta = payload.delta
      if (typeof delta !== 'object' || delta === null) continue
      const record = delta as Record<string, unknown>
      const deltaType = record.type

      if (deltaType === 'text_delta' && typeof record.text === 'string') {
        const block = ensureBlock(index, 'text')
        block.text += record.text
        if (record.text.length > 0) sawAny = true
        yield { type: 'text-delta', index, text: record.text }
        continue
      }
      if (deltaType === 'thinking_delta' && typeof record.thinking === 'string') {
        const block = ensureBlock(index, 'reasoning')
        block.text += record.thinking
        if (record.thinking.length > 0) sawAny = true
        yield { type: 'reasoning-delta', index, text: record.thinking }
        continue
      }
      if (deltaType === 'input_json_delta') {
        const partial = typeof record.partial_json === 'string' ? record.partial_json : ''
        const block = ensureBlock(index, 'tool-call')
        // name 可能只在 start 里给过 —— 补进块（tool-call-delta 的 name 可选）。
        if (block.name.length === 0) {
          const meta = toolMeta.get(index)
          if (meta !== undefined) {
            block.callId = meta.id
            block.name = meta.name
          }
        }
        block.argumentsRaw += partial
        if (!started.has(index)) {
          started.add(index)
          yield { type: 'block-start', index, blockType: 'tool-call' }
        }
        if (partial.length > 0) sawAny = true
        yield {
          type: 'tool-call-delta',
          index,
          id: ToolCallId(block.callId),
          ...block.name.length > 0 ? { name: block.name } : {},
          argumentsDelta: partial,
        }
        continue
      }
      continue
    }

    /**
     * ★ **`message_start` 与 `message_delta` 携带 usage** —— 必须收集。
     *
     * ⚠ 早期这里写着「message_start / message_delta 都不需要即时产出」，
     * **那是错的**（用户报障：对话下方只显示「x 轮 y 步」，
     * 没有 tps / token 用量 / 缓存命中 / 上下文占用）。
     *
     * DSH 的 `StreamChunk` 有 `{type:'usage'}` 与 `{type:'finish'}` 两个成员，
     * UI 那些指标全靠它们。Anthropic 把 usage **分两处**下发：
     *
     * | 事件 | 携带 |
     * |---|---|
     * | `message_start` | `message.usage.{input_tokens, cache_read_input_tokens, cache_creation_input_tokens}` |
     * | `message_delta` | `usage.output_tokens` + `delta.stop_reason` |
     *
     * ⇒ 只读其中一处都会缺字段（早读没有 output、晚读没有 input）。
     */
    if (type === 'message_start') {
      const message = payload.message
      if (typeof message === 'object' && message !== null) {
        const usage = (message as { usage?: unknown }).usage
        collectUsage(usage)
      }
      continue
    }

    if (type === 'message_delta') {
      collectUsage(payload.usage)
      const delta = payload.delta
      if (typeof delta === 'object' && delta !== null) {
        const stopReason = (delta as { stop_reason?: unknown }).stop_reason
        if (typeof stopReason === 'string' && stopReason.length > 0) {
          stopReasonSeen = stopReason
        }
      }
      continue
    }

    // content_block_stop / message_stop / ping 不需要即时产出 ——
    // 收尾统一发射 block-end（见函数头说明）。
  }

  /**
   * ⚠ **空响应必须显式报错**。
   *
   * 对**完全没有任何内容**的 200 响应抛 `EMPTY_RESPONSE`（**在** harness 的
   * 可重试集合里）—— 而不是让用户看到一个无声的空回复。
   * 这正是不依赖 `[DONE]` 的 SSE 最容易漏的一环（OpenAI 侧有 `[DONE]`
   * 可以做锚点，Anthropic 侧没有）。
   *
   * ## ⚠ 这里**只管「测到空」**，不管「为什么空」
   *
   * 空响应有**成因完全不同**的两类，而它们的**处置相反**：
   *
   * | 成因 | 耗时 | 处置 |
   * |---|---|---|
   * | 额度用尽 / 该模型无权益（请求根本没送达模型） | **150-200ms** | 换账号 / 换模型，**别重试** |
   * | 链路卡住（上游静默直到超时） | ≈ 整轮超时 | 可重试 |
   *
   * 而**本层拿不到耗时上下文**（它不知道自己是被谁调的、已经跑了多久），
   * 故它给的是**通用**文案与可重试的 `EMPTY_RESPONSE` —— 这是**刻意**的：
   * 分类交给**适配器**（`zcode-adapter.ts` 持有 `consumeStartedAt`，
   * 用 {@link isFastEntitlementMiss} 判快慢后改写文案与错误码）。
   *
   * ⚠ 反之若在这里就武断地报「额度用尽」，那**慢回空**那条路径就会被误报，
   * 把用户引向「换账号」（而它其实该重试）。
   */
  if (!sawAny) {
    throw new LlmError(
      `${options.label}: 模型返回了空响应（无任何 text / thinking / tool 内容）`,
      'EMPTY_RESPONSE',
    )
  }

  /**
   * 收尾统一发射 `block-end`（带**完整内容**）。
   *
   * ⚠ 空块**不发** —— 空块会污染会话，且 DSH 的 `EMPTY_RESPONSE` 契约
   * 禁止产出空内容块（与 `openai-compat.ts` 的同款处理）。
   *
   * ⚠ 工具块还要求 `name` 非空：缺名字的 tool-call 在 DSH 侧不可用
   * （那边有 `hasUsableToolName` 守卫）。
   */
  for (const block of blocks) {
    if (block.kind === 'text') {
      if (block.text === '') continue
      yield { type: 'block-end', index: block.index, block: { type: 'text', text: block.text } }
      continue
    }
    if (block.kind === 'reasoning') {
      if (block.text.trim() === '') continue
      yield { type: 'block-end', index: block.index, block: { type: 'reasoning', text: block.text } }
      continue
    }
    if (block.name.length === 0) continue
    /**
     * ⚠ `ToolCallBlock.arguments` 是**原始 JSON 字符串**（不是对象）——
     * 与 Anthropic wire 上的 `tool_use.input`（对象）相反。
     * 故这里把累积的 `argumentsRaw` 原样给出去，**不做补全**：
     * 残缺 JSON 保持原样，让 harness 报 schema 错误并重试，
     * 而不是被静默当成「无参数调用」（与 `openai-compat.ts` 同款约定）。
     *
     * ⚠ 唯一的例外：**完全空**的参数补成 `{}` —— 工具确实可以无参数，
     * 而空串不是合法 JSON（会被 harness 判为解析失败）。
     */
    const args = block.argumentsRaw.trim() === '' ? '{}' : block.argumentsRaw
    yield {
      type: 'block-end',
      index: block.index,
      block: {
        type: 'tool-call',
        id: ToolCallId(block.callId),
        name: block.name,
        arguments: args,
      },
    }
  }

  /**
   * ★ 发射 usage —— **UI 的 tps / token 用量 / 缓存命中 / 上下文占用全靠它**。
   *
   * ⚠ 早期这里什么都不发（用户报障：对话下方只有「x 轮 y 步」，
   * 没有后面的指标）。`StreamChunk` 的 `usage` 成员就是给这个用的。
   *
   * ⚠ 只在**至少拿到一个数**时才发：全 `undefined` 的 usage 会让 UI
   * 显示 0 而不是「无数据」—— 那比不发更误导。
   *
   * ⚠ `inputTokens` / `outputTokens` 是 `TokenUsage` 的**必填**字段，
   * 故缺失时用 0 兜底；但只要有任一字段有值就发（部分数据好过没有）。
   */
  if (inputTokens !== undefined || outputTokens !== undefined ||
      cacheReadTokens !== undefined || cacheWriteTokens !== undefined) {
    const usage: TokenUsage = {
      inputTokens: inputTokens ?? 0,
      outputTokens: outputTokens ?? 0,
      // totalTokens 只在两半都有值时才给（否则给出的是残缺总数）。
      ...inputTokens !== undefined && outputTokens !== undefined
        ? { totalTokens: inputTokens + outputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) }
        : {},
      ...cacheReadTokens !== undefined ? { cacheReadTokens } : {},
      ...cacheWriteTokens !== undefined ? { cacheWriteTokens } : {},
    }
    yield { type: 'usage', usage }
  }

  /**
   * ★ 发射 finish —— 告诉 harness 本轮**为什么结束**。
   *
   * ⚠ 与 usage 同理，早期完全不发。缺了它 DSH 只能靠「流结束」推断，
   * 无法区分「答完了」/「被 max_tokens 截断」/「去调工具了」。
   *
   * 映射（Anthropic → DSH 的 `FinishReason`）：
   *
   * | Anthropic `stop_reason` | DSH |
   * |---|---|
   * | `end_turn` / `stop_sequence` / 缺失 | `stop` |
   * | `max_tokens` | `max-tokens` |
   * | `tool_use` | `tool-calls` |
   *
   * ⚠ **有工具调用时必须报 `tool-calls`**（不论上游说什么）：
   * 那是 harness 决定「继续执行工具」的依据；报成 `stop` 会让循环停下来，
   * 用户看到「模型说要调工具但什么都没发生」。
   */
  const reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' } =
    stopReasonSeen === 'max_tokens'
      ? { kind: 'max-tokens' }
      : stopReasonSeen === 'tool_use' || blocks.some((b) => b.kind === 'tool-call' && b.name.length > 0)
        ? { kind: 'tool-calls' }
        : { kind: 'stop' }
  yield { type: 'finish', reason }
}

/** 从 Anthropic 非流式响应里取可见文本（探活与日志用）。 */
export function extractAnthropicText(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const content = (payload as { content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
  }
  return parts.join('')
}
