/**
 * MiniMax **Anthropic Messages** 协议层：请求体构造 + SSE 消费。
 *
 * ## 为什么单独一个文件
 *
 * 本 provider 是本插件**唯一**使用 Anthropic Messages 协议族的成员
 *（其余九个都是 OpenAI 兼容族或各自的自定义协议），故**不复用**
 * `openai-compat.ts`（那是 OpenAI 形状，硬套会把 `tools`/`tool_calls`/
 * `input_json_delta` 全部翻译错）。
 *
 * ⚠️ 但也**不做**「通用 Anthropic 层」的抽象 —— 目前只有一个消费者，
 * 抽象会凭空多一层间接（Qoder 的教训是「同族第二个产品出现时再抽」）。
 *
 * ## 实测确认的协议事实（2026-09-29，真实请求）
 *
 * 端点 `POST {apiHost}/mavis/api/v1/llm/v1/messages`，`stream: true`：
 *
 * | 事件 | 用途 |
 * |---|---|
 * | `message_start` | `usage.input_tokens`、`cache_read_input_tokens` |
 * | `ping` | 保活（**必须忽略**） |
 * | `content_block_start` | `content_block.type` ∈ `thinking` / `text` / `tool_use` |
 * | `content_block_delta` | `thinking_delta` / `text_delta` / `signature_delta` / `input_json_delta` |
 * | `content_block_stop` | 该块结束 |
 * | `message_delta` | `stop_reason`、`usage.output_tokens`（含 `thinking_tokens`） |
 * | `message_stop` | 结束 |
 * | `error` | `{type:'error', error:{type,message}}` |
 *
 * ⚠️ **`signature_delta` 必须忽略**（那是 thinking 块的签名，不是正文）；
 * 把它当文本会往回答里注入一串十六进制。
 *
 * ⚠️ **`thinking` 块要映射成 `reasoning` 块**（DSH 的 `ReasoningBlock`），
 * 否则思考内容会污染正文。
 *
 * ## ⚠️ 思考档位：`effort` 的两种下发形态（实测）
 *
 * - `MiniMax-M3.1-Flash-Preview`：**必须** `thinking.type='adaptive'`；
 *   传 `disabled` 会被服务端拒：
 *   `400 invalid_request_error ... requires adaptive thinking; thinking.type="disabled"
 *   (including reasoning.effort=none) is not allowed (2013)`。
 *   档位通过 **`output_config.effort`** 下发（客户端 `requestPatch` 同款）。
 * - M3 / M2.7 / M2.7-highspeed：**不传 `thinking` 即接受**（实测 200），
 *   且服务端**默认就会思考**（M2.7 实测 `thinking_tokens: 250`）。
 *   它们没有 `effort_options`，故不发 `output_config`。
 *
 * ⚠️ **所以「不发 thinking」是安全默认**（实测 200），
 * 不要为了「显式关闭」而发 `disabled` —— 那对 M3.1 是**硬 400**。
 *
 * ## ⚠️ 图片（2026-09-29 真机实测通过）
 *
 * Anthropic 形状的 `image` 块 + `source.base64`，**裸 base64**（无 data: 前缀）。
 * 实测 M3.1 / M3 都能正确识图（自造 40x40 纯红 PNG → 模型答「红色」）。
 * ⚠️ OpenAI 的 `image_url` 形状被服务端**明确拒绝**（见 `serializeMinimaxMessages`）。
 * ⚠️ 内联由调用方完成（适配器读附件服务），本文件保持**纯函数**。
 */

import type {
  ContentBlock,
  FinishReason,
  Message,
  StreamChunk,
  ToolSchema,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { collectHarnessSystem, normalizeHarnessMessages } from './message-shape.js'
import { resolveToolPairing } from './sse.js'

/**
 * 构造 Anthropic Messages 请求体。
 *
 * ⚠️ 纯函数（不碰网络），便于单测锁死形状 —— 与 `buildQoderInferPayload` 同思路。
 *
 * ⚠️ **`system` 走顶层 `system` 字段**（Anthropic 协议），**不是**一条
 * `{role:'system'}` 消息 —— Anthropic Messages 端点不接受 system 角色消息。
 */
export function buildMinimaxMessagesPayload(options: {
  model: string
  messages: readonly Message[]
  system?: string
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
  stop?: readonly string[]
  /** 已解析的思考档位；`undefined` 表示不发（服务端默认行为）。 */
  effort?: string
  /** 该模型是否**必须** adaptive thinking（只有 M3.1-Flash-Preview 是）。 */
  requiresAdaptiveThinking?: boolean
  /** 已内联的图片（attachmentId → base64）。缺失时遇图**抛错**。 */
  images?: ReadonlyMap<string, MinimaxInlineImage>
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    model: options.model,
    stream: true,
    messages: serializeMinimaxMessages(options.messages, options.images),
  }
  if (options.maxTokens !== undefined) payload.max_tokens = options.maxTokens
  const systemText = [...new Set([options.system, collectHarnessSystem(options.messages)]
    .filter((text): text is string => typeof text === 'string' && text !== ''))].join('\n\n')
  if (systemText !== '') payload.system = systemText
  if (options.temperature !== undefined) payload.temperature = options.temperature
  if (options.stop !== undefined && options.stop.length > 0) payload.stop_sequences = [...options.stop]
  if (options.tools !== undefined && options.tools.length > 0) {
    payload.tools = options.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }))
  }
  // ⚠️ 思考形态，决策表（依据真机实测，见 AGENTS.md 8.1）：
  //
  // | 情形 | 请求体 | 实测行为 |
  // |---|---|---|
  // | `effort === 'none'`（用户选「关闭思考」） | `thinking:{type:'disabled'}` | 0 思考字符 |
  // | `effort === 'on'`（用户选「开启思考」，M3 的 `switchable`） | `thinking:{type:'adaptive'}` | 2785+ 字符 |
  // | 有档位 effort | `thinking:{type:'adaptive'}` + `output_config.effort` | 档位真的改变思考量 |
  // | `requiresAdaptiveThinking`（M3.1，无 effort） | `thinking:{type:'adaptive'}` | 必须，否则 400 |
  // | 其余（M2.7 系，无档位） | **整个不发** | 服务端默认思考（forced_on） |
  //
  // ⚠️⚠️ **M3 不发 `thinking` 时默认「不思考」**（两轮实测各 0 字符），
  // 所以「开启思考」**必须显式发 `adaptive`** —— 这正是 `on` 档存在的理由。
  //
  // ⚠️ `none` / `on` **只对 `switchable` 的模型可达**：`minimaxReasoningInfo`
  // 只给 switchable 追加这两档。故这里不会把 `disabled` 发给 M3.1
  //（那会被硬拒 400）或 M2.7（那会被静默忽略）。
  if (options.effort === 'none') {
    payload.thinking = { type: 'disabled' }
    return payload
  }
  if (options.effort === 'on') {
    payload.thinking = { type: 'adaptive' }
    return payload
  }
  if (options.requiresAdaptiveThinking === true) {
    payload.thinking = { type: 'adaptive' }
    if (options.effort !== undefined) payload.output_config = { effort: options.effort }
  } else if (options.effort !== undefined) {
    payload.thinking = { type: 'adaptive' }
    payload.output_config = { effort: options.effort }
  }
  return payload
}

/** 一条消息里的文本（Anthropic 的 content 可以是字符串或块数组）。 */
function blockText(block: ContentBlock): string {
  if (block.type === 'text') return block.text
  if (block.type === 'reasoning') return block.text
  return ''
}

/** 已内联的图片（attachmentId → base64 与 mediaType）。 */
export interface MinimaxInlineImage {
  mediaType: string
  /** **裸 base64**（不含 `data:` 前缀）—— Anthropic `source.data` 要的就是它。 */
  data: string
}

/**
 * 把 DSH 消息序列化为 Anthropic Messages 形状。
 *
 * ⚠️ **两个必须保留的东西**（Qoder 在那里踩过**三个同型缺陷**，
 * 这次一开始就做对）：
 *
 * 1. **assistant 的 `tool-call` 块 → `tool_use` 块**（带 `id` / `name` / `input`）；
 * 2. **`tool-result` 块 → `user` 消息里的 `tool_result` 块**（带 `tool_use_id`）。
 *    Anthropic 协议**没有 `role:'tool'`** —— 工具结果必须作为 user 消息的
 *    `tool_result` 内容块回传。丢掉它模型会反复重调同一工具或编造结果。
 *
 * ⚠️ **`input` 要解析成对象**（Anthropic 收 JSON 对象，不是字符串）；
 * 解析失败退化为 `{}` —— **不编造参数**，但也不能因此丢掉整条 tool_use
 * （丢了会让后续 `tool_result` 变成孤儿块，服务端 400）。
 *
 * ⚠️ **图片走 Anthropic 的 `image` 块**（2026-09-29 真机实测）：
 * ```json
 * { "type": "image",
 *   "source": { "type": "base64", "media_type": "image/png", "data": "<裸base64>" } }
 * ```
 * ⚠️ **不是** OpenAI 的 `{type:'image_url', image_url:{url:'data:...'}}` ——
 * 实测该形状被**明确拒绝**：
 * `400 ... messages.0.content.0: unsupported content type 'image_url' (2013)`。
 * ⚠️ `data` 是**裸 base64**（不带 `data:image/png;base64,` 前缀）。
 * ⚠️ 实测图片可与 `thinking:{type:'adaptive'}` 共存、`text` 在 `image` 前后均可。
 *
 * ⚠️ 图片**必须**由调用方先内联好（`images` 映射）：本函数是**纯函数**，
 * 不允许触碰附件服务（与 `buildQoderTools` 同思路，便于单测锁死形状）。
 * 调用方没内联成功时**不静默丢图** —— 那会让用户以为图片被模型看到了。
 */
export function serializeMinimaxMessages(
  messages: readonly Message[],
  images?: ReadonlyMap<string, MinimaxInlineImage>,
): Array<Record<string, unknown>> {
  // ⚠️⚠️ 步骤 1：归一化「一等 tool 消息」形状（**本 provider 曾因此整轮 400**）。
  //
  // harness 把工具结果作为**独立的 `role:'tool'` 消息**下发（`toolCallId` 在
  // **顶层**），而**没有** `tool-result` 内容块 —— 于是下面
  // `block.type === 'tool-result'` 的判据恒不命中（`normalizeHarnessMessages`
  // 会把它降级回「user 消息内嵌 tool-result 块」的旧形状）。
  //
  // ⚠️ **别被版本号误导**（2026-10-01 实测纠正）：这套形状自 dsh 0.1.7 引入，
  // 但 **0.2.0-rc.2 仍然如此** —— 全量会话日志 34,659 条 tool/result 无一例外
  // 都是 `role:'tool'` + 顶层 `toolCallId`，`developer` 消息也仍在。
  // 判据是**形状**（`message.role === 'tool'`）而非版本号（`message-shape.ts`
  // 开头即写明「探测用形状而非版本号」）—— 升级 dsh 不会让这个归一化失效。
  //
  // 漏掉这一步的真实后果（2026-10-01 会话 `session-871fdf61` 报障）：
  // `400 invalid_request_error ... tool call result does not follow tool call (2013)`。
  // ⚠️ 旧形状输入是**零成本透传**（连数组身份都不变），故既有行为逐字节不变。
  //
  // ⚠️ 入参签名保持 `readonly Message[]`（对外纯函数 API 不变），但归一化层吃的
  // 是**宽松**的 `{role; content?}[]` —— `Message` 没有索引签名，直接传会报 TS2352。

  // 入参声明成宽松结构来规避；本函数是对外导出的纯函数，改签名会波及调用方，
  // 故在此做一次**单向放宽**（内容原样透传，归一化不改数据）。
  const normalized = normalizeHarnessMessages(
    messages as unknown as readonly { role: string; content?: unknown }[],
  ) as unknown as readonly Message[]

  // ⚠️ 步骤 2：剔除无法配对的 tool_use / tool_result（与五个既有适配器同口径）。
  //
  // Anthropic 与 OpenAI 一样拒绝孤儿：没有 tool_result 的 tool_use、指向不存在
  // tool_use 的 tool_result，都会被服务端拒。共用 `resolveToolPairing` 是为了
  // **一个口径**——它在内部也会先做同一套形状归一化，且已处理「空 name 的
  // tool-call 无条件 400」这个既有教训。
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  const out: Array<Record<string, unknown>> = []
  /**
   * ⚠️ 待发的 assistant 消息（等它的工具结果到齐后**成对**提交）。
   *
   * Anthropic 协议要求：同批 `tool_result` 必须**合并进紧跟 assistant(tool_use)
   * 的那一条 user 消息**。harness 把**每个**工具调用落成**一条独立**的 tool 消息
   * （真实会话 `session-871fdf61` 一次 tool_use 批次对应 1~3 条），逐条下发会产出
   * **多条连续 user 消息** ⇒ 第二条前面是 user 而非 assistant ⇒ 2013。
   *
   * ⚠️⚠️ **不得跨 assistant 边界累积**（真实缺陷，第一版实现的错误）：
   * 那样会变成 `assistant A / assistant B / user(A+B 的结果)`，
   * A 的结果前面是 B 的 assistant ⇒ **同样** 2013。
   */
  let pendingAssistant: Record<string, unknown> | undefined
  let pendingToolResults: Array<Record<string, unknown>> = []
  /**
   * 把「待发 assistant + 已累积的工具结果」**成对**提交。
   *
   * ⚠️ 结果为空时**仍要提交 assistant** —— 那是模型只回了正文的历史消息。
   * ⚠️ 提交后 assistant 置空：它的结果已经配对完毕，不会再累积更多。
   */
  const commitPending = (): void => {
    if (pendingAssistant === undefined && pendingToolResults.length === 0) return
    if (pendingAssistant !== undefined) out.push(pendingAssistant)
    if (pendingToolResults.length > 0) {
      out.push({ role: 'user', content: pendingToolResults })
      pendingToolResults = []
    }
    pendingAssistant = undefined
  }

  for (const message of normalized) {
    // System text is collected into payload.system, never a user turn.
    // ⚠️ `developer`（只承载工具增删元数据的角色）由归一化层一并丢弃。
    if (message.role === 'system') continue

    const content: Array<Record<string, unknown>> = []
    /** 本条消息的**全部**块数（用于判定「纯工具结果消息」）。 */
    let blocks = 0
    for (const block of message.content) {
      blocks++
      if (block.type === 'tool-call') {
        // ⚠️ 孤儿/空名调用不产出 tool_use（否则下游 tool_result 变孤儿 → 400）。
        if (!keepCallIds.has(String(block.id))) continue
        content.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          // ⚠️ 解析成对象；失败退化 `{}`（不编造参数，也不丢块）
          input: parseToolArguments(block.arguments),
        })
        continue
      }
      if (block.type === 'tool-result') {
        // ⚠️ 孤儿结果不下发（服务端同样 400）。
        if (!keepResultIds.has(String(block.toolCallId))) continue
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          // ⚠️ 工具结果内的图片也要内联（否则「工具返回截图」的场景会丢图）。
          content: serializeToolResultContent(block.content, images),
          ...(block.isError === true ? { is_error: true } : {}),
        })
        continue
      }
      if (block.type === 'image') {
        const ref = block.attachment as { attachmentId?: unknown } | undefined
        const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : undefined
        const inline = attachmentId === undefined ? undefined : images?.get(attachmentId)
        if (inline === undefined) {
          // ⚠️ **显式抛错，不静默丢弃**：静默丢弃会让用户以为图片被模型看到了
          //（与「图片能力未实现时抛错」同一原则）。
          throw new Error(
            'minimax: 图片未能内联（附件服务不可用或读取失败），'
            + '拒绝发出缺少图片的请求',
          )
        }
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: inline.mediaType,
            data: inline.data,
          },
        })
        continue
      }
      const text = blockText(block)
      if (text === '') continue
      if (message.role === 'assistant' && block.type === 'reasoning') {
        // ⚠️ 历史里的 reasoning **不回传**：Anthropic 要求 thinking 块带签名
        //（`signature`），而我们不持久化签名 ⇒ 回传无签名 thinking 会被拒。
        // 丢弃思考历史是安全的（它不影响正确答案），且与官方客户端行为一致
        //（客户端只在同一轮内回传带签名的 thinking）。
        continue
      }
      content.push({ type: 'text', text })
    }

    // ⚠️⚠️ **成对提交即配对关系（真实缺陷，2026-10-01 由真实会话重放定位）**。
    //
    // Anthropic 要求：`tool_result` 必须**紧跟产生它的那一条** assistant(tool_use)。
    // harness 侧形态是「一条 assistant（带 N 个 tool_use）+ N 条独立 tool 消息」。
    // 三种错误形态都会报 2013：
    //   ① 逐条下发 → N 条连续 user，第二条前面是 user；
    //   ② assistant 立即下发、结果攒到下一轮 → `assistant A / assistant B / user(A+B 结果)`；
    //   ③ 纯 reasoning 的空 assistant 被丢弃 → 其后结果失去锚点。
    //
    // ⇒ **assistant 与它的结果一起提交**：assistant 先进待发区，遇到它的结果
    // （或任何非工具消息）时，才把「assistant + 累积结果」成对 push。
    // 这样既合并了同批（不产生连续 user），也不跨 assistant 边界。
    const isPureToolMessage = message.role !== 'assistant'
      && content.length === 0
      && blocks > 0
    if (isPureToolMessage) continue

    if (message.role === 'assistant') {
      // ⚠️⚠️ 上一批若还没发出（assistant A 的结果已到齐但 A 本身待发），
      // 先把 A + A 的结果成对发出，再把当前 assistant 转入待发区。
      commitPending()
      if (content.length === 0) continue
      pendingAssistant = { role: 'assistant', content }
      continue
    }
    // user 消息：先把待发的 assistant 连同已累积的结果成对发出，再发正文。
    commitPending()
    if (content.length > 0) out.push({ role: 'user', content })
  }
  // ⚠️ 收尾：末尾的待发 assistant 与结果都要提交（否则留下无结果的 tool_use → 2013）。
  commitPending()
  return out
}

/** 工具结果的内容块（图片同样要内联）。 */
function serializeToolResultContent(
  blocks: readonly ContentBlock[],
  images?: ReadonlyMap<string, MinimaxInlineImage>,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const block of blocks) {
    if (block.type === 'image') {
      const ref = block.attachment as { attachmentId?: unknown } | undefined
      const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : undefined
      const inline = attachmentId === undefined ? undefined : images?.get(attachmentId)
      if (inline !== undefined) {
        out.push({
          type: 'image',
          source: { type: 'base64', media_type: inline.mediaType, data: inline.data },
        })
      }
      // ⚠️ 工具结果里的图片读不到时**跳过**（不抛错）：工具结果本身
      //（文本）仍有价值，为一个附件让整轮失败不划算 —— 与「消息体里的图片
      // 读不到就抛错」有意区别对待，因为后者是用户**显式**发送的意图。
      continue
    }
    const text = blockText(block)
    if (text !== '') out.push({ type: 'text', text })
  }
  return out
}

/** 解析工具参数 JSON；失败/H 非对象时退化为 `{}`。 */
function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

/** 把 Anthropic 的 `stop_reason` 映射为 DSH 的 {@link FinishReason}。 */
export function mapMinimaxStopReason(reason: unknown): FinishReason {
  const text = typeof reason === 'string' ? reason : ''
  if (text === 'tool_use') return { kind: 'tool-calls' }
  if (text === 'max_tokens') return { kind: 'max-tokens' }
  if (text === 'refusal') return { kind: 'stop' }
  // ⚠️ 未知/缺失一律 `stop`：不能编造成 `error`（那会让 harness 重试
  // 一个其实成功的响应）。
  return { kind: 'stop' }
}

/** 解析 `usage` 字段（`message_start` 与 `message_delta` 各带一半）。 */
export function readMinimaxUsage(raw: unknown): Partial<TokenUsage> {
  if (typeof raw !== 'object' || raw === null) return {}
  const u = raw as Record<string, unknown>
  const out: Partial<TokenUsage> = {}
  const input = nonNegativeInt(u.input_tokens)
  if (input !== undefined) out.inputTokens = input
  const output = nonNegativeInt(u.output_tokens)
  if (output !== undefined) out.outputTokens = output
  const cacheRead = nonNegativeInt(u.cache_read_input_tokens)
  if (cacheRead !== undefined) out.cacheReadTokens = cacheRead
  const cacheWrite = nonNegativeInt(u.cache_creation_input_tokens)
  if (cacheWrite !== undefined) out.cacheWriteTokens = cacheWrite
  // ⚠️ `output_tokens_details.thinking_tokens` 是**output 的子集**，
  // 故映射到 `reasoningTokens`（不是加到 outputTokens 上）。
  const details = u.output_tokens_details
  if (typeof details === 'object' && details !== null) {
    const thinking = nonNegativeInt((details as Record<string, unknown>).thinking_tokens)
    if (thinking !== undefined) out.reasoningTokens = thinking
  }
  return out
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

/** {@link consumeMinimaxSse} 的入参。 */
export interface ConsumeMinimaxSseOptions {
  /** SSE 字节流（`response.body`）。 */
  body: ReadableStream<Uint8Array>
  /** 外部中止信号。 */
  signal?: AbortSignal
}

/**
 * 消费 Anthropic Messages SSE，产出 DSH 的 {@link StreamChunk}。
 *
 * ⚠️ **错误必须抛错**，不能静默结束 —— 服务端用 `event: error` 下发错误
 * （实测形状 `{type:'error', error:{type,message}}`），
 * 早期 Qoder 因为只认 OpenAI 的 `{error:{message}}`，把错误帧当「正常结束、
 * 无内容」，UI 表现为「干净地停止、无任何报错」。
 *
 * ⚠️ 块的 `index` 直接用**服务端下发的 `index`**（不自己计数）：
 * 服务端从 0 开始为每个 content block 分配，重排会与 `block-end` 对不上。
 */
export async function* consumeMinimaxSse(
  options: ConsumeMinimaxSseOptions,
): AsyncGenerator<StreamChunk> {
  const reader = options.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  /** 最近一个 `event:` 行（帧自带 `type` 时不用它）。 */
  let eventName = ''
  /** 每个 index 的累积状态（`block-end` 要交出完整块）。 */
  const blocks = new Map<number, {
    type: 'text' | 'reasoning' | 'tool-call'
    text: string
    toolId?: string
    toolName?: string
    toolArgs: string
  }>()
  let stopReason: unknown
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let sawAnyChunk = false

  /**
   * 处理一行 SSE。
   *
   * ⚠️ **抽成嵌套生成器是有原因的**（真实缺陷，2026-09-29 由单测抓到）：
   * 原实现只在 `while (!done)` 里按行处理，而**流结束时 `buffer` 里残留的
   * 最后一条事件永远不会被处理**。真实 SSE 大多以空行结尾（恰好掩盖了它），
   * 但**被截断的流**（连接提前关闭）会让最后那条 `message_delta`
   * —— 正是携带 `stop_reason` 与 `usage` 的那一帧 —— 被静默丢弃：
   * 于是 `max_tokens` 被误报成 `stop`、`usage` 永远是 0。
   * 抽出本函数后，收尾时把余量**按整行再走一遍**同一套逻辑。
   */
  const processLine = async function* (rawLine: string): AsyncGenerator<StreamChunk> {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    // ⚠️ 空行是 SSE 的**事件终止符** ⇒ 重置 `eventName`。
    // 不重置会让上一条事件的 `event:` 名残留到下一个 `data:` 上
    //（`eventName` 现在提到循环外，因为收尾时要复用同一套逻辑）。
    if (line === '') {
      eventName = ''
      return
    }
    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim()
      return
    }
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as Record<string, unknown>
    // ⚠️ 帧自带 `type`，优先用它（`event:` 行可能缺失或被代理吞掉）。
    const type = typeof frame.type === 'string' ? frame.type : eventName

    if (type === 'error') {
      const error = frame.error
      const message = typeof error === 'object' && error !== null
        ? String((error as Record<string, unknown>).message ?? '未知错误')
        : '未知错误'
      throw new Error(`minimax: 流内错误：${message}`)
    }
    if (type === 'message_start') {
      const message = frame.message
      if (typeof message === 'object' && message !== null) {
        usage = { ...usage, ...readMinimaxUsage((message as Record<string, unknown>).usage) }
      }
      return
    }
    if (type === 'content_block_start') {
      const index = nonNegativeInt(frame.index) ?? 0
      const block = frame.content_block
      if (typeof block !== 'object' || block === null) return
      const b = block as Record<string, unknown>
      const kind = b.type
      if (kind === 'thinking') {
        blocks.set(index, { type: 'reasoning', text: '', toolArgs: '' })
        sawAnyChunk = true
        yield { type: 'block-start', index, blockType: 'reasoning' }
      } else if (kind === 'text') {
        blocks.set(index, { type: 'text', text: '', toolArgs: '' })
        sawAnyChunk = true
        yield { type: 'block-start', index, blockType: 'text' }
      } else if (kind === 'tool_use') {
        const id = typeof b.id === 'string' ? b.id : ''
        const name = typeof b.name === 'string' ? b.name : ''
        blocks.set(index, { type: 'tool-call', text: '', toolId: id, toolName: name, toolArgs: '' })
        sawAnyChunk = true
        yield { type: 'block-start', index, blockType: 'tool-call' }
      }
      return
    }
    if (type === 'content_block_delta') {
      const index = nonNegativeInt(frame.index) ?? 0
      const delta = frame.delta
      if (typeof delta !== 'object' || delta === null) return
      const d = delta as Record<string, unknown>
      const state = blocks.get(index)
      if (d.type === 'text_delta' && typeof d.text === 'string') {
        if (state !== undefined) state.text += d.text
        yield { type: 'text-delta', index, text: d.text }
      } else if (d.type === 'thinking_delta' && typeof d.thinking === 'string') {
        if (state !== undefined) state.text += d.thinking
        yield { type: 'reasoning-delta', index, text: d.thinking }
      } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
        if (state !== undefined) state.toolArgs += d.partial_json
        yield {
          type: 'tool-call-delta',
          index,
          id: ToolCallId(state?.toolId ?? ''),
          argumentsDelta: d.partial_json,
        }
      }
      // ⚠️ `signature_delta` 刻意**不处理**：它是 thinking 块的签名，
      // 不是正文。当初把它当文本会往回答里注入一串十六进制。
      return
    }
    if (type === 'content_block_stop') {
      const index = nonNegativeInt(frame.index) ?? 0
      const state = blocks.get(index)
      if (state === undefined) return
      let block: ContentBlock
      if (state.type === 'text') {
        block = { type: 'text', text: state.text }
      } else if (state.type === 'reasoning') {
        block = { type: 'reasoning', text: state.text }
      } else {
        block = {
          type: 'tool-call',
          id: ToolCallId(state.toolId ?? ''),
          name: state.toolName ?? '',
          arguments: state.toolArgs,
        }
      }
      blocks.delete(index)
      yield { type: 'block-end', index, block }
      return
    }
    if (type === 'message_delta') {
      const delta = frame.delta
      if (typeof delta === 'object' && delta !== null) {
        stopReason = (delta as Record<string, unknown>).stop_reason
      }
      usage = { ...usage, ...readMinimaxUsage(frame.usage) }
      return
    }
    // `message_stop` / `ping` / 未知帧：忽略。
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        // ⚠️ 收尾：先刷出解码器里可能残留的不完整多字节序列，
        // 再把 buffer 余量**按整行**走一遍 —— 否则最后一条事件被丢弃
        //（这正是上面 `processLine` 注释记录的那个真实缺陷）。
        buffer += decoder.decode()
        if (buffer !== '') {
          const tail = buffer.split('\n')
          buffer = ''
          for (const rawLine of tail) yield* processLine(rawLine)
        }
        break
      }
      buffer += decoder.decode(value, { stream: true })
      // SSE 以空行分隔事件；按行处理，末尾不成行的部分留在 buffer 里。
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) yield* processLine(rawLine)
    }
  } finally {
    reader.releaseLock?.()
  }

  // ⚠️ 空响应必须报错：静默结束会让 harness 认为「模型正常回答但没内容」，

  if (!sawAnyChunk) {
    throw new Error('minimax: 模型未返回任何内容块')
  }
  yield { type: 'usage', usage }
  yield { type: 'finish', reason: mapMinimaxStopReason(stopReason) }
}
