/**
 * Gemini 协议层：DSH 消息 → 上游 `contents`，以及上游 SSE/响应 → DSH `StreamChunk`。
 *
 * ## 为什么单独一个文件
 *
 * 与 `minimax-messages.ts` 同一理由：本层是**纯函数 + 纯翻译**，与网络、凭据、
 * 账号池无关，拆开后可用单测逐字节锁死形状（`tests/unit/gemini-payload.spec.ts`
 * 与 `gemini-stream.spec.ts` 就吃这一层）。
 *
 * 逐点移植自 `cmdc-pak-align-wb/internal/upstream/gemini/translate.go`
 * 与 `stream.go`。**不做**「通用 Gemini 层」抽象 —— 目前只有一个消费者。
 *
 * ## 三条必须保留的上游对齐细节
 *
 * 1. **role 只有 `user` / `model`**（assistant → `model`，其余 → `user`）。
 * 2. **历史里的 thinking 块不回传**，但它的 `thoughtSignature` 要**搬到**
 *    同一消息内后续的 `functionCall` part 上（Gemini 的签名机制要求签名挂在
 *    functionCall 上，而不是独立 thinking part 上）。见 {@link translateGeminiRequest}。
 * 3. **`functionResponse` 的 `name` 必须来自对应 `tool_use` 的 name**（上游按
 *    name 而非 id 配对），故先扫全消息建映射。
 *
 * ## ⚠️ SSE 收尾余量必须按整行再走一遍
 *
 * 与 `consumeMinimaxSse` 同一个真实缺陷（2026-09-29 由单测抓到）：只在
 * `while (!done)` 里按行处理时，**流结束时 buffer 里残留的最后一条事件永远
 * 不会被处理**。真实 SSE 大多以空行结尾（恰好掩盖它），但被截断的流会让携带
 * `finishReason` 与 `usageMetadata` 的末帧被静默丢弃。故 `processFrame` 抽成
 * 嵌套生成器，收尾时把余量按整行再走一遍。
 */

import type {
  ContentBlock,
  FinishReason,
  Message,
  StreamChunk,
  TokenUsage,
  ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { collectHarnessSystem, normalizeHarnessMessages } from './message-shape.js'
import { readWithIdleTimeout, resolveToolPairing } from './sse.js'
import type { GeminiInlineImage, GeminiModelSpec } from './gemini.js'
import {
  deriveGeminiSessionId,
  GEMINI_DEFAULT_PROJECT,
  GEMINI_IDLE_TIMEOUT_MS,
  GEMINI_SESSION_LANE_INFER,
  sanitizeGeminiSchema,
  sortedStringify,
} from './gemini.js'

// ---------------------------------------------------------------------------
// 上游类型（`types.go`）
// ---------------------------------------------------------------------------

/** 一个 `part`。字段名与上游逐字一致。 */
export interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args?: Record<string, unknown> }
  functionResponse?: { name: string; response: Record<string, unknown> }
  inlineData?: { mimeType: string; data: string }
}

/** 一条 `content`（role + parts）。 */
export interface GeminiContent {
  role: string
  parts: GeminiPart[]
}

/** 上游 `usageMetadata`。 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number
  candidatesTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
  cachedContentTokenCount?: number
}

/** 上游响应壳里的 `candidate`。 */
export interface GeminiCandidate {
  content?: { role?: string; parts?: GeminiPart[] }
  finishReason?: string
}

/** 上游 `Response`（信封内层）。 */
export interface GeminiResponse {
  candidates?: GeminiCandidate[]
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  responseId?: string
}

/** 请求信封（`Envelope`）。 */
export interface GeminiEnvelope {
  model: string
  project: string
  request: {
    contents: GeminiContent[]
    systemInstruction?: { role: string; parts: GeminiPart[] }
    tools?: Array<{ functionDeclarations: Array<Record<string, unknown>> }>
    toolConfig?: Record<string, unknown>
    generationConfig?: Record<string, unknown>
    sessionId: string
  }
  requestId: string
  userAgent: string
}

// ---------------------------------------------------------------------------
// 签名
// ---------------------------------------------------------------------------

/** 签名查表回调（命中返回签名）。 */
export type GeminiSignatureLookup = (name: string, argsJson: string) => string | undefined
/** 签名收集回调（上游下发了签名时调用）。 */
export type GeminiSignatureSink = (name: string, argsJson: string, signature: string) => void

/**
 * 参数规范化：按键名升序的紧凑 JSON。
 *
 * ⚠️ 签名键 = `SigKey("tool:"+name, canonicalArgs)`，故**两侧必须用同一个
 * 规范化**——回填时若用不同序列化算出不同的键，签名永远查不中（表现为
 * 「每轮都要去签重试」）。
 */
export function canonicalArgs(args: unknown): string {
  if (args === undefined || args === null) return '{}'
  if (typeof args !== 'object' || Array.isArray(args)) return sortedStringify(args)
  return sortedStringify(args)
}

// ---------------------------------------------------------------------------
// 请求翻译
// ---------------------------------------------------------------------------

/** {@link translateGeminiRequest} 的入参。 */
export interface TranslateGeminiRequestOptions {
  modelId: string
  spec: GeminiModelSpec
  messages: readonly Message[]
  system?: string
  tools?: readonly ToolSchema[]
  toolChoice?: unknown
  temperature?: number
  maxTokens?: number
  /**
   * 覆盖信封里的 `sessionId`。
   *
   * ⚠️ 缺省时走**内容派生**（`project` + 首条 user 文本 + `sessionLane`），
   * 不是常量 —— 见 `deriveGeminiSessionId`。要复刻历史抓包才显式钉住。
   */
  sessionId?: string
  /** 会话派生标签（推理 / 冒烟），缺省 {@link GEMINI_SESSION_LANE_INFER}。 */
  sessionLane?: string
  /**
   * 取该**基础 sessionId 的当前代数**（会话升代自愈用）。
   *
   * ⚠️ 只有未显式传 `sessionId` 时才参与。返回值 ≤ 0 表示不升代。
   * 见 `deriveGeminiSessionId` 的 `generation` 段。
   */
  sessionGeneration?: (baseSessionId: string) => number
  project?: string
  requestId: string
  /** 已内联的图片（attachmentId → base64）。缺失时遇图**抛错**。 */
  images?: ReadonlyMap<string, GeminiInlineImage>
  /** 签名查表（回填 functionCall 的 `thoughtSignature`）。 */
  lookupSignature?: GeminiSignatureLookup
}

/**
 * 取信封里**第一条 user 消息的首个文本 part**（sessionId 派生的输入之一）。
 *
 * ⚠️ 实测口径（2026-10-05 对照实验，6 个样本全部自洽）：只有 `contents[0]`
 * 参与，且只看其中的文本 part —— `["AAA"]` 与 `["AAA","ZZZ"]` 同值、
 * `["ZZZ","AAA"]` 与 `["ZZZ"]` 同值（后续文本不进哈希）。
 */
export function geminiFirstUserText(contents: readonly GeminiContent[]): string {
  for (const content of contents) {
    if (content.role !== '' && content.role !== 'user') continue
    for (const part of content.parts) {
      if (typeof part.text === 'string' && part.text !== '') return part.text
    }
  }
  return ''
}

/**
 * 把 DSH 请求翻译成上游信封。
 *
 * ⚠️ 返回的是**字母序已排好的普通对象**；序列化必须走
 * `marshalAlphabetical`（`gemini.ts`），否则与上游看到的字节不同。
 */
export function translateGeminiRequest(options: TranslateGeminiRequestOptions): GeminiEnvelope {
  // ⚠️ 步骤 1：归一化「一等 tool 消息」形状（0.1.7+ 的 `role:'tool'` + 顶层
  // `toolCallId`）。漏掉会让 `tool-result` 判定恒不命中，工具结果被当成普通
  // 用户文本下发 —— 模型看不到工具输出，表现为提前结束或循环思考。
  const normalized = normalizeHarnessMessages(
    options.messages as unknown as readonly { role: string; content?: unknown }[],
  ) as unknown as readonly Message[]

  // ⚠️ 步骤 2：剔除无法配对的 tool_use / tool_result（孤儿块上游同样 400）。
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  // ⚠️ 步骤 3：先扫全消息建 `tool_use.id → name` 映射。上游的
  // `functionResponse` 只认 name（没有 id 字段），故回填时必须靠这张表。
  const toolNames = new Map<string, string>()
  for (const message of normalized) {
    for (const block of message.content) {
      if (block.type === 'tool-call') toolNames.set(String(block.id), block.name)
    }
  }

  const contents: GeminiContent[] = []
  for (const message of normalized) {
    // System text is collected into systemInstruction, never a user turn.
    // `developer`（只承载工具增删元数据）由归一化层一并丢弃。
    if (message.role === 'system') continue

    const role = message.role === 'assistant' ? 'model' : 'user'
    const parts: GeminiPart[] = []

    for (const block of message.content) {
      if (block.type === 'tool-call') {
        if (!keepCallIds.has(String(block.id))) continue
        const args = parseToolArguments(block.arguments)
        const argsJson = canonicalArgs(args)
        // ⚠️ 签名只能从**本地缓存**查（DSH 的 `ReasoningBlock` 只有 text，
        // 不携带签名 —— 所以签名必须靠 `gemini-sigstore.ts` 落盘持久化）。
        // 查不到就**不带签名发**：上游会拒（`IsSignatureError` 命中），
        // 适配器据此走「去签重试一次」路径。
        const signature = options.lookupSignature?.(block.name, argsJson)
        const part: GeminiPart = { functionCall: { name: block.name, args } }
        if (signature !== undefined && signature !== '') part.thoughtSignature = signature
        parts.push(part)
        continue
      }

      if (block.type === 'tool-result') {
        if (!keepResultIds.has(String(block.toolCallId))) continue
        const name = toolNames.get(String(block.toolCallId)) ?? ''
        // ⚠️ name 为空时**整块丢弃**：上游的 functionResponse 以 name 配对，
        // 空 name 会 400。丢了顶多少一轮工具上下文，不会打死整轮。
        if (name === '') continue
        const response: Record<string, unknown> = {
          content: toolResultText(block.content),
        }
        if (block.isError === true) response.error = true
        parts.push({ functionResponse: { name, response } })
        continue
      }

      if (block.type === 'image') {
        const ref = block.attachment as { attachmentId?: unknown } | undefined
        const attachmentId = typeof ref?.attachmentId === 'string' ? ref.attachmentId : undefined
        const inline = attachmentId === undefined ? undefined : options.images?.get(attachmentId)
        if (inline === undefined) {
          // ⚠️ **显式抛错，不静默丢弃**：静默丢弃会让用户以为图片被模型看到了。
          throw new Error('gemini: 图片未能内联（附件服务不可用或读取失败），拒绝发出缺少图片的请求')
        }
        parts.push({ inlineData: { mimeType: inline.mediaType, data: inline.data } })
        continue
      }

      if (block.type === 'text') {
        if (block.text === '') continue
        parts.push({ text: block.text })
        continue
      }

      if (block.type === 'reasoning') {
        // 历史 reasoning 与 thinking 同处理：不回传正文（见上）。
        continue
      }
    }

    if (parts.length === 0) continue
    contents.push({ role, parts })
  }

  // ⚠️ 空 contents 必须抛错：发空请求上游会 400，且错误信息与「工具配对失败」
  // 完全无关，排查成本极高。
  if (contents.length === 0) throw new Error('gemini: messages 里没有可用内容')

  const project = options.project ?? GEMINI_DEFAULT_PROJECT
  // ⚠️ sessionId **不是常量**：缺省按 (project, 首条 user 文本, lane) 派生。
  // 写成固定值会让所有用户、所有对话共用一个会话 —— 上游的会话归并与
  // thoughtSignature 回填都挂在它上面（见 `deriveGeminiSessionId` 注释）。
  //
  // 两段式：先算 **base**（不含代数），再把 base 交给回调取当前代数。这样
  // 「升代」只需在回调侧计数，信封层保持纯函数。
  let sessionId = options.sessionId
  if (sessionId === undefined) {
    const base = deriveGeminiSessionId(
      project,
      geminiFirstUserText(contents),
      options.sessionLane ?? GEMINI_SESSION_LANE_INFER,
    )
    const generation = options.sessionGeneration?.(base) ?? 0
    sessionId = generation > 0
      ? deriveGeminiSessionId(
        project,
        geminiFirstUserText(contents),
        options.sessionLane ?? GEMINI_SESSION_LANE_INFER,
        generation,
      )
      : base
  }

  const request: GeminiEnvelope['request'] = {
    contents,
    generationConfig: buildGenerationConfig(options.spec, options.maxTokens, options.temperature),
    sessionId,
  }

  const systemText = [...new Set([options.system, collectHarnessSystem(normalized)]
    .filter((text): text is string => typeof text === 'string' && text !== ''))].join('\n\n')
  if (systemText !== '') {
    request.systemInstruction = { role: 'system', parts: [{ text: systemText }] }
  }

  if (options.tools !== undefined && options.tools.length > 0) {
    request.tools = [{
      functionDeclarations: options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        // ⚠️ 清洗后的 schema（见 `sanitizeGeminiSchema`）：白名单外的键会让上游 400。
        parameters: sanitizeParameters(tool.parameters),
      })),
    }]
  }

  const toolConfig = buildToolConfig(options.toolChoice, options.tools)
  if (toolConfig !== undefined) request.toolConfig = toolConfig

  return {
    model: options.spec.upstream,
    project: options.project ?? GEMINI_DEFAULT_PROJECT,
    request,
    requestId: options.requestId,
    userAgent: 'antigravity',
  }
}

/** 构造 `generationConfig`。 */
function buildGenerationConfig(
  spec: GeminiModelSpec,
  maxTokens: number | undefined,
  temperature: number | undefined,
): Record<string, unknown> {
  const config: Record<string, unknown> = { maxOutputTokens: maxTokens ?? 64_000 }
  // ⚠️ `includeThoughts` **恒 true**（「关闭思考」是假关：关掉照样思考照样计费）。
  const thinkingConfig: Record<string, unknown> = { includeThoughts: spec.includeThoughts }
  // ⚠️ tiered 档**只带 includeThoughts**，不发 thinkingBudget（预算交给上游自适应）。
  if (spec.thinkingBudget >= 0) thinkingConfig.thinkingBudget = spec.thinkingBudget
  config.thinkingConfig = thinkingConfig
  if (temperature !== undefined) config.temperature = temperature
  return config
}

/** `tool_choice` → 上游 `toolConfig`。 */
function buildToolConfig(
  toolChoice: unknown,
  tools: readonly ToolSchema[] | undefined,
): Record<string, unknown> | undefined {
  if (tools === undefined || tools.length === 0) return undefined
  const mode = resolveToolChoiceMode(toolChoice)
  const config: Record<string, unknown> = { functionCallingConfig: { mode } }
  if (mode === 'ANY') {
    const name = resolveToolChoiceName(toolChoice)
    if (name !== undefined) {
      ;(config.functionCallingConfig as Record<string, unknown>).allowedFunctionNames = [name]
    }
  }
  return config
}

function resolveToolChoiceMode(toolChoice: unknown): 'AUTO' | 'NONE' | 'ANY' {
  if (toolChoice === 'none') return 'NONE'
  if (toolChoice === 'any' || toolChoice === 'required') return 'ANY'
  if (typeof toolChoice === 'object' && toolChoice !== null) {
    const type = (toolChoice as { type?: unknown }).type
    if (type === 'none') return 'NONE'
    if (type === 'any') return 'ANY'
    if (type === 'tool') return 'ANY'
  }
  return 'AUTO'
}

function resolveToolChoiceName(toolChoice: unknown): string | undefined {
  if (typeof toolChoice !== 'object' || toolChoice === null) return undefined
  const raw = toolChoice as { name?: unknown; tool?: unknown }
  if (typeof raw.name === 'string' && raw.name !== '') return raw.name
  if (typeof raw.tool === 'object' && raw.tool !== null) {
    const name = (raw.tool as { name?: unknown }).name
    if (typeof name === 'string' && name !== '') return name
  }
  return undefined
}

/** 工具参数 schema 清洗（薄包装，便于单测直接测本函数）。 */
function sanitizeParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  return sanitizeGeminiSchema(parameters)
}

/** 解析工具参数 JSON；失败/非对象时退化为 `{}`（**不编造参数**）。 */
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

/** 工具结果的内容块 → 纯文本（上游 `functionResponse.response.content` 只吃文本）。 */
function toolResultText(blocks: readonly ContentBlock[]): string {
  const out: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') out.push(block.text)
    else if (block.type === 'reasoning') out.push(block.text)
  }
  return out.join('\n')
}

// ---------------------------------------------------------------------------
// 响应翻译（非流式）
// ---------------------------------------------------------------------------

/** {@link translateGeminiResponse} 的入参。 */
export interface TranslateGeminiResponseOptions {
  response: GeminiResponse
  /** 签名收集（上游下发了签名时调用）。 */
  onSignature?: GeminiSignatureSink
}

/** 非流式响应 → DSH 的块列表 + 结束原因 + 用量。 */
export interface TranslatedGeminiResponse {
  blocks: ContentBlock[]
  reason: FinishReason
  usage: Partial<TokenUsage>
}

/** 把上游非流式响应翻成 DSH 形状。 */
export function translateGeminiResponse(
  options: TranslateGeminiResponseOptions,
): TranslatedGeminiResponse {
  const candidate = options.response.candidates?.[0]
  const blocks: ContentBlock[] = []
  let toolCalls = 0
  for (const part of candidate?.content?.parts ?? []) {
    if (part.functionCall !== undefined) {
      const args = part.functionCall.args ?? {}
      const argsJson = canonicalArgs(args)
      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
        options.onSignature?.(part.functionCall.name, argsJson, part.thoughtSignature)
      }
      blocks.push({
        type: 'tool-call',
        id: ToolCallId(newToolCallId(toolCalls)),
        name: part.functionCall.name,
        arguments: argsJson,
      })
      toolCalls++
      continue
    }
    if (typeof part.text !== 'string' || part.text === '') continue
    if (part.thought === true) {
      blocks.push({ type: 'reasoning', text: part.text })
      continue
    }
    blocks.push({ type: 'text', text: part.text })
  }
  return {
    blocks,
    reason: mapGeminiFinish(candidate?.finishReason, toolCalls),
    usage: readGeminiUsage(options.response.usageMetadata),
  }
}

/**
 * 上游 `finishReason` → DSH 的 {@link FinishReason}。
 *
 * ⚠️ 未知/缺失一律 `stop`：不能编造成 `error`（那会让 harness 重试一个其实
 * 成功的响应）。有工具调用时以 `tool-calls` 为准。
 */
export function mapGeminiFinish(reason: unknown, toolCalls: number): FinishReason {
  if (toolCalls > 0) return { kind: 'tool-calls' }
  const text = typeof reason === 'string' ? reason.toUpperCase() : ''
  if (text === 'MAX_TOKENS') return { kind: 'max-tokens' }
  if (text === 'STOP' || text === 'STOP_SEQUENCE' || text === 'FINISH_REASON_UNSPECIFIED') {
    return { kind: 'stop' }
  }
  return { kind: 'stop' }
}

/**
 * 上游 `usageMetadata` → DSH 的 {@link TokenUsage}。
 *
 * ⚠️ DSH 的计数**互斥**：`inputTokens` 只含**未缓存**输入，缓存走
 * `cacheReadTokens`（计费输入 = 两者之和）。上游的 `promptTokenCount` 是
 * **含缓存**的总量，故要减掉 `cachedContentTokenCount` —— 否则缓存命中的
 * 那部分会被**双重计费**。
 * ⚠️ `thoughtsTokenCount` 是 output 的**子集**，映射到 `reasoningTokens`，
 * **不加**到 `outputTokens` 上。
 */
export function readGeminiUsage(raw: GeminiUsageMetadata | undefined): Partial<TokenUsage> {
  if (raw === undefined || raw === null) return {}
  const out: Partial<TokenUsage> = {}
  const prompt = nonNegativeInt(raw.promptTokenCount)
  const cached = nonNegativeInt(raw.cachedContentTokenCount) ?? 0
  if (prompt !== undefined) out.inputTokens = Math.max(0, prompt - cached)
  const candidates = nonNegativeInt(raw.candidatesTokenCount)
  if (candidates !== undefined) out.outputTokens = candidates
  if (cached > 0) out.cacheReadTokens = cached
  const total = nonNegativeInt(raw.totalTokenCount)
  if (total !== undefined) out.totalTokens = total
  const thoughts = nonNegativeInt(raw.thoughtsTokenCount)
  if (thoughts !== undefined) out.reasoningTokens = thoughts
  return out
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined
}

/** 为流式工具调用生成 id（上游不提供，本地生成稳定可读的形式）。 */
function newToolCallId(index: number): string {
  return `gemini_tool_${Date.now().toString(36)}_${index}`
}

// ---------------------------------------------------------------------------
// SSE 消费
// ---------------------------------------------------------------------------

/** {@link consumeGeminiSse} 的入参。 */
export interface ConsumeGeminiSseOptions {
  /** SSE 字节流（`response.body`）。 */
  body: ReadableStream<Uint8Array>
  signal?: AbortSignal
  /** 签名收集（thought / functionCall part 上带签名时调用）。 */
  onSignature?: GeminiSignatureSink
  /**
   * 空闲超时（毫秒）。缺省用 {@link GEMINI_IDLE_TIMEOUT_MS}。
   *
   * ⚠️ **必须主动掐**：上游在生成大 functionCall 参数期间可能长时间不 flush
   * 任何字节，裸 `reader.read()` 会**无限期挂起** —— 适配器的 generator
   * 永不返回，harness 当前步骤既不出结果也不报错（见 `src/sse.ts:1-10`）。
   */
  idleTimeoutMs?: number
  /** 首 token 单独的超时（缺省同 `idleTimeoutMs`）。 */
  firstTokenTimeoutMs?: number
}

/** 当前打开的块状态。 */
interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  toolId?: string
  toolName?: string
}

/**
 * 消费上游 SSE，产出 DSH 的 {@link StreamChunk}。
 *
 * ⚠️ 上游每帧是 `{"response":{...}}` **或**裸 `Response`，且**只有
 * `candidates` 非空才算内容帧** —— 纯 `usageMetadata` 的收尾帧要继续读
 * （原版 `SSEReader.Event()` 的口径）。
 * ⚠️ `data: [DONE]` 结束。
 * ⚠️ 用量取「见过的**最大** `totalTokenCount` 的那一份」—— 上游会在多个帧里
 * 重复播报 usage，早期帧的数字偏小。
 */
export async function* consumeGeminiSse(
  options: ConsumeGeminiSseOptions,
): AsyncGenerator<StreamChunk> {
  const reader = options.body.getReader()
  const decoder = new TextDecoder()
  const idleTimeoutMs = options.idleTimeoutMs ?? GEMINI_IDLE_TIMEOUT_MS
  const firstTokenTimeoutMs = options.firstTokenTimeoutMs ?? idleTimeoutMs
  let buffer = ''
  let block: OpenBlock | undefined
  let nextIndex = 0
  let finishReason: string | undefined
  let sawAnyChunk = false
  /** 用量：保留「最大 totalTokenCount」的那一份。 */
  let usage: Partial<TokenUsage> = {}
  let usageTotal = -1
  let toolCount = 0

  const closeBlock = function* (): Generator<StreamChunk> {
    if (block === undefined) return
    let content: ContentBlock
    if (block.kind === 'text') {
      content = { type: 'text', text: block.text }
    } else if (block.kind === 'reasoning') {
      content = { type: 'reasoning', text: block.text }
    } else {
      content = {
        type: 'tool-call',
        id: ToolCallId(block.toolId ?? ''),
        name: block.toolName ?? '',
        arguments: block.text,
      }
    }
    const index = block.index
    block = undefined
    yield { type: 'block-end', index, block: content }
  }

  const openBlock = function* (kind: OpenBlock['kind']): Generator<StreamChunk> {
    yield* closeBlock()
    const index = nextIndex++
    block = { index, kind, text: '' }
    yield { type: 'block-start', index, blockType: kind }
  }

  /** 处理一帧（一个 SSE 事件）。 */
  const processFrame = async function* (payload: string): AsyncGenerator<StreamChunk> {
    const trimmed = payload.trim()
    if (trimmed === '' || trimmed === '[DONE]') return
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const frame = parsed as Record<string, unknown>
    // ⚠️ 先试信封形态 `{"response":{…}}`，再试裸 `Response`（原版同序）。
    const inner = typeof frame.response === 'object' && frame.response !== null
      ? frame.response as GeminiResponse
      : frame as GeminiResponse

    const candidates = inner.candidates
    if (!Array.isArray(candidates) || candidates.length === 0) {
      // 纯 usageMetadata 帧：只记用量，**不算内容**，继续读。
      noteUsage(inner.usageMetadata)
      return
    }
    noteUsage(inner.usageMetadata)

    const candidate = candidates[0] as GeminiCandidate
    if (typeof candidate.finishReason === 'string' && candidate.finishReason !== '') {
      finishReason = candidate.finishReason
    }
    for (const part of candidate.content?.parts ?? []) {
      if (part.functionCall !== undefined) {
        const args = part.functionCall.args ?? {}
        const argsJson = canonicalArgs(args)
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
          options.onSignature?.(part.functionCall.name, argsJson, part.thoughtSignature)
        }
        // ⚠️ 工具调用**独占一个块**，参数一次性发完再关块（与 minimax 的
        // `emitToolCall` 同口径）：上游的 functionCall 是完整的、不是增量。
        yield* openBlock('tool-call')
        if (block !== undefined) {
          block.toolId = newToolCallId(toolCount)
          block.toolName = part.functionCall.name
          block.text = argsJson
        }
        toolCount++
        sawAnyChunk = true
        if (block !== undefined) {
          yield {
            type: 'tool-call-delta',
            index: block.index,
            id: ToolCallId(block.toolId ?? ''),
            name: part.functionCall.name,
            argumentsDelta: argsJson,
          }
        }
        yield* closeBlock()
        continue
      }

      if (typeof part.text !== 'string' || part.text === '') continue

      if (part.thought === true) {
        // ⚠️ 思考分片上的签名**刻意不存**（原版 `CollectSignatures` 的口径）：
        // Gemini 校验的只有 functionCall 上那一个，纯文本 part 的签名回传时
        // 会被忽略 —— 存了纯属噪音，还会把缓存挤爆。
        if (block?.kind !== 'reasoning') yield* openBlock('reasoning')
        sawAnyChunk = true
        if (block !== undefined) {
          block.text += part.text
          yield { type: 'reasoning-delta', index: block.index, text: part.text }
        }
        continue
      }

      if (block?.kind !== 'text') yield* openBlock('text')
      sawAnyChunk = true
      if (block !== undefined) {
        block.text += part.text
        yield { type: 'text-delta', index: block.index, text: part.text }
      }
    }
  }

  /** 记用量（保留最大 total 的那一份）。 */
  function noteUsage(raw: GeminiUsageMetadata | undefined): void {
    if (raw === undefined || raw === null) return
    const total = nonNegativeInt(raw.totalTokenCount) ?? -1
    if (total < usageTotal) return
    usageTotal = total
    usage = readGeminiUsage(raw)
  }

  try {
    while (true) {
      // ⚠️ 必须走 `readWithIdleTimeout` 而不是裸 `reader.read()`：网关在
      // 生成大 functionCall 参数期间长时间不 flush 时，裸读会无限期挂起，
      // 表现为「发消息后永远转圈」。超时归类为可重试的 TIMEOUT，harness
      // 才能重试该步骤并把控制权交还给用户。
      const { done, value } = await readWithIdleTimeout(
        reader,
        sawAnyChunk ? idleTimeoutMs : firstTokenTimeoutMs,
        'gemini',
        options.signal,
        sawAnyChunk ? 'chunk' : 'first-token',
      )
      if (done) {
        // ⚠️ 收尾：先刷解码器里残留的不完整多字节序列，再把 buffer 余量
        // **按整行**走一遍 —— 否则最后一条事件被丢弃（见文件头）。
        buffer += decoder.decode()
        if (buffer !== '') {
          const tail = buffer.split('\n')
          buffer = ''
          for (const rawLine of tail) {
            const payload = consumeSseLine(rawLine)
            if (payload !== undefined) yield* processFrame(payload)
          }
        }
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const rawLine of lines) {
        const payload = consumeSseLine(rawLine)
        if (payload !== undefined) yield* processFrame(payload)
      }
    }
  } finally {
    reader.releaseLock?.()
  }

  yield* closeBlock()

  // ⚠️ 空响应必须报错：静默结束会让 harness 认为「模型正常回答但没内容」，
  // **不会重试**。
  if (!sawAnyChunk) throw new Error('gemini: 模型未返回任何内容块')

  yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, ...usage } }
  yield { type: 'finish', reason: mapGeminiFinish(finishReason, toolCount) }
}

/**
 * 处理一行 SSE，返回待解析的 `data:` 载荷（不完整时返回 `undefined`）。
 *
 * ⚠️ `:` 开头是**注释行**（心跳），必须跳过 —— 把它当数据会 JSON 解析失败，
 * 若实现成「解析失败即抛错」就会误杀正常流。
 * ⚠️ 上游每帧是**单行** `data:`（实测；不是 Anthropic 那种多行拼接形态），
 * 故这里不做多行累积。
 */
function consumeSseLine(rawLine: string): string | undefined {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
  if (line === '') return undefined
  if (line.startsWith(':')) return undefined
  if (line.startsWith('event:')) return undefined
  if (!line.startsWith('data:')) return undefined
  return line.slice(5).trim()
}
