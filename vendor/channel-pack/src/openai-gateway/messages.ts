import { randomUUID } from 'node:crypto'
import { createToolResultMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message, ToolSchema } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_IMAGE_LIMITS,
  parseImageDataUrl,
  toImageBlock,
  type AttachmentBridge,
  type ImageLimits,
} from './images.js'
import { isThinkingOffEffort, translateReasoningEffort } from '../reasoning-ladder.js'

export class OpenAiGatewayError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly type = 'invalid_request_error',
    readonly code = 'invalid_request',
  ) {
    super(message)
    this.name = 'OpenAiGatewayError'
  }
}

export interface OpenAiToolCall {
  id?: unknown
  type?: unknown
  function?: { name?: unknown; arguments?: unknown }
}

export interface OpenAiChatMessage {
  role?: unknown
  content?: unknown
  tool_calls?: unknown
  tool_call_id?: unknown
  /** DeepSeek / Qoder 思考回传。思考模式的工具轮次缺了它，上游会 400。 */
  reasoning_content?: unknown
  /** Cline 等客户端用的另一个思考字段名。 */
  reasoning?: unknown
}

/**
 * 档位归一化时发生的一件**用户看不出来**的事，交给调用方记日志。
 *
 * ⚠️ 必须能被记下来：翻译是**有意**的降级（客户端表达不出模型的私有 id），
 * 但没有日志的话，「用户选了 ultra、实际只跑 high」这件事事后无从解释。
 */
export interface ReasoningEffortNotice {
  /** 客户端要的档位（原样）。 */
  requested: string
  /** `translated` = 就近落到模型声明的一档；`unexpressible` = 模型没有这一族 → 不下发。 */
  outcome: 'translated' | 'unexpressible'
  /** 实际下发的 id（`unexpressible` 时缺省）。 */
  applied?: string
}

export interface OpenAiChatRequest {
  model?: unknown
  messages?: unknown
  stream?: unknown
  temperature?: unknown
  max_tokens?: unknown
  max_completion_tokens?: unknown
  stop?: unknown
  reasoning_effort?: unknown
  tools?: unknown
  tool_choice?: unknown
}

export function normalizeMaxTokens(value: number | undefined, provider: string, model: string): number | undefined {
  if (value === undefined) return undefined
  return value
}
/**
 * 把 OpenAI 的 `reasoning_effort` 归一化成本模型**真正支持**的档位。
 *
 * ## 「未声明」与「不支持」必须区别对待
 *
 * 实机报障：ZCode 经网关调 `lobsterai/MiniMax-M3.1-Flash-Preview` 报
 * `provider "lobsterai" model "..." does not support reasoning effort "high"`。
 * 该模型没有 `thinkingConfig` ⇒ 适配器不声明 reasoning ⇒ `supported` 为空。
 * 初版在这里**原样透传**了 `high`，于是 DSH 侧校验拒绝，整轮请求失败。
 *
 * 正确处理是**不下发**该参数：模型没有这组档位，硬塞一个只会换来错误，
 * 而「静默按模型默认走」至少不会让用户的整轮对话失败。
 * （与本仓库「不参与模型请求、不伪造 provider 行为」的既有约定一致。）
 *
 * ## 第二类失败：客户端只认识通用档位名，模型用的是私有 id
 *
 * 各 provider 的档位 id 是**上游 wire 值**：TRAE 是 `light`/`high`/`extra_high`、
 * LobsterAI 是 `off`/`high`/`xhigh`（界面上叫 Max）、Cline 是 `…`/`max`（界面上叫
 * Extra）、Raccoon 是 `on`/`off`。而走 OpenAI 协议的客户端**只有固定 8 档词汇**
 * （Codex 与为它生成模型目录的 CC Switch 都是 `none…ultra`），它**表达不出**
 * 那些私有值 —— 用户照着 DSH 界面上的名字填，`max` 撞 `xhigh`、`xhigh` 撞 `max`，
 * 换来的是一句 400 和**整轮对话不可用**，而两端都看不出为什么。
 *
 * 这正是本仓库已经吃过一次的教训（工具类型不认识就让整轮失败，见 `responses.ts`
 * 文件头）：**拒绝的收益（让用户知道某档没生效）远小于代价（整轮不可用，
 * 且用户无从修复 —— 客户端根本没有能表达私有 id 的写法）**。
 * 故改为**翻译**：见 {@link translateReasoningEffort}，按强度序就近落到模型声明的
 * 同族档位上，并把这件事通过 `onNotice` 交给调用方记日志。
 *
 * ⚠️ 但**完全不认识的值仍然 400**（例如拼错的 `banana`）：那不是「名字不通用」，
 * 是调用方写错了。静默翻译会让拼写错误变成「档位悄悄不生效」。
 *
 * ## 返回值是**三态**，不可混用
 *
 * - `string`：归一化后的档位，下发它；
 * - `undefined`：**用户没传** `reasoning_effort`；
 * - `null`：**用户传了，但本模型不适用** → 明确不下发。
 *
 * ⚠️ `null` 与 `undefined` 必须分开：`toGenerateOptions` 以 `!== undefined`
 * 判定「调用方是否给了值」。若这里用 `undefined` 表示「不下发」，它会被当成
 * 「没给」而回退读 `body.reasoning_effort` —— 归一化的结论被原样抵消，
 * 于是报障原句又回来了。**这是本缺陷第二轮的复发形态**（首轮是原样透传，
 * 二轮是「修好了却被下游回退吃掉」）。
 */
export function normalizeReasoningEffort(
  requested: unknown,
  modelInfo: unknown,
  provider?: string,
  model?: string,
  onNotice?: (notice: ReasoningEffortNotice) => void,
): string | null | undefined {
  if (requested === undefined) return undefined
  const value = String(requested)
  const record = modelInfo as { reasoning?: { efforts?: readonly { id?: unknown }[] } } | undefined
  const declared = (record?.reasoning?.efforts ?? [])
    .map((effort) => String((effort as { id?: unknown } | undefined)?.id))
  // 模型未声明档位（declared 为空）：明确**不下发**，而不是原样透传。
  // modelInfo 为 undefined 也走这里 —— 那不是「没有限制」，是「不知道」。
  if (declared.length === 0) return null
  const result = translateReasoningEffort(value, declared)
  if (result.kind === 'exact') return result.effort
  if (result.kind === 'mapped') {
    onNotice?.({ requested: value, outcome: 'translated', applied: result.effort })
    return result.effort
  }
  if (result.kind === 'unexpressible') {
    onNotice?.({ requested: value, outcome: 'unexpressible' })
    return null
  }
  // 既没被声明、也不在强度序里 —— 调用方写错了。报错要顺带把**可用档位**说清，
  // 否则用户只能靠试。
  throw new OpenAiGatewayError(
    `reasoning effort ${JSON.stringify(value)} is not supported by the selected DSH model`
    + `（该模型可用的档位：${declared.join(', ')}）`,
    400,
    'unsupported_parameter',
    'unsupported_reasoning_effort',
  )
}

/**
 * 把 OpenAI 的 `content` 转成 DSH 的内容块数组。
 *
 * ⚠️ 图片走 `image_url` → 附件 → `ImageBlock`（见 `./images.ts`），**异步**。
 * 附件服务缺失时（`bridge` 为 undefined）必须抛错而不是静默丢图：静默丢弃会让
 * 用户以为模型看到了图，而答案其实是基于文本生成的。
 *
 * ⚠️ 本函数同时被 `/v1/responses` 复用（`responses.ts` 把 Responses 的内容块
 * 转成 Chat 形状后调它）—— **图片入站只有这一份实现**，两套协议各写一份必然
 * 漂移成「Chat 端能收图、Responses 端报错」。
 */
export async function partsFromContent(
  content: unknown,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
): Promise<Message['content']> {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (content === null || content === undefined) return []
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('message.content must be a string or an array of content parts')
  }
  const blocks: NonNullable<Message['content']> = []
  const used = { count: 0, bytes: 0 }
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      throw new OpenAiGatewayError('message.content contains an invalid part')
    }
    const item = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } }
    if (item.type === 'text' && typeof item.text === 'string') {
      blocks.push({ type: 'text', text: item.text })
      continue
    }
    if (item.type === 'image_url') {
      if (bridge === undefined) {
        throw new OpenAiGatewayError(
          '当前 profile 未装载附件服务（@deepseek-ai/dsh-attachment-local），无法接收图片。',
          400,
          'unsupported_content',
          'unsupported_content',
        )
      }
      try {
        blocks.push(await toImageBlock(item.image_url?.url, bridge, limits, used))
      } catch (error) {
        // 转成 OpenAI 风格错误，让客户端能识别是「内容问题」而非服务端故障。
        throw new OpenAiGatewayError(
          error instanceof Error ? error.message : String(error),
          400,
          'unsupported_content',
          'unsupported_content',
        )
      }
      used.count += 1
      // 字节数按解析后的实际值累计，用于整条消息的总量限制。
      const parsed = parseImageDataUrl(item.image_url?.url)
      used.bytes += parsed?.data.length ?? 0
      continue
    }
    throw new OpenAiGatewayError('message.content contains an unsupported part')
  }
  return blocks
}

/**
 * 提取纯文本（仅用于需要字符串的场景；带图的 content 走 partsFromContent）。
 *
 * ⚠️ 同样被 `/v1/responses` 复用（`responses.ts` 的 `outputText`）—— 「工具结果
 * 不能带图」这条判据必须两个端点一致。
 */
export function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === null || content === undefined) return ''
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('message.content must be a string or an array of text parts')
  }
  return content.map((part) => {
    if (!part || typeof part !== 'object') {
      throw new OpenAiGatewayError('message.content contains an invalid part')
    }
    const item = part as { type?: unknown; text?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') return item.text
    // ⚠️ 图片由 `partsFromContent` 异步处理（user 消息与 **工具结果**都走它）。
    // 仍会走到这里的只有 assistant / system —— 这两种角色的 content 本就**没有**
    // 图片通道（适配器只声明文本输出），故明确拒绝而不是静默压成空串。
    if (item.type === 'image_url') {
      throw new OpenAiGatewayError(
        'assistant / system 消息的内容不能包含图片（只有 user 消息与工具结果支持图片）',
        400,
        'unsupported_content',
        'unsupported_content',
      )
    }
    throw new OpenAiGatewayError('message.content contains an unsupported part')
  }).join('')
}

/** Produce a fresh V4 source identity for each gateway-owned message (PR #229). */
export function gatewaySource(): Message['source'] {
  return { kind: 'plugin:dsh-openai-gateway' } as Message['source']
}

/**
 * 造一条 DSH 消息。
 *
 * ⚠️ **导出**给 `responses.ts` 用：两个端点造出来的消息必须同形（同样的 id/source
 * 构造），否则同一份历史在两个端点上的来源标记不同，排查时会误导。
 */
export function createGatewayMessage(
  role: Message['role'],
  content: Message['content'],
  source: Message['source'],
): Message {
  return { id: randomUUID() as Message['id'], role, content, source }
}

/**
 * 委托当前宿主构造工具结果：≤0.1.6 使用 user/tool-result 包裹块，
 * 0.1.7+ 使用一等 tool 消息。外部 provider 没有 channel-pack 的兼容层，
 * 固定其中任何一种形状都会让另一代宿主丢失工具应答或拒绝请求。
 * 工厂在两代内核中均存在，同时负责 id、source 与不可变内容。
 */
export function createGatewayToolMessage(
  toolCallId: string,
  content: Message['content'],
  isError?: boolean,
): Message {
  return createToolResultMessage({
    callId: toolCallId as never,
    content,
    isError: isError === true,
  })
}

/**
 * Chat 入站的思考文本。优先 `reasoning_content`，否则认 `reasoning`。
 * 不 trim：`" "` 是 DeepSeek V4 接受的占位，trim 掉就又变成没回传。
 */
function inboundReasoning(value: OpenAiChatMessage): string | undefined {
  const raw = typeof value.reasoning_content === 'string'
    ? value.reasoning_content
    : typeof value.reasoning === 'string'
      ? value.reasoning
      : undefined
  if (raw === undefined || raw.length === 0) return undefined
  return raw
}

function convertToolCalls(raw: unknown): Message['content'] {
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('assistant.tool_calls must be an array')
  return raw.map((value) => {
    if (!value || typeof value !== 'object') throw new OpenAiGatewayError('tool call must be an object')
    const call = value as OpenAiToolCall
    const id = typeof call.id === 'string' && call.id.length > 0 ? call.id : undefined
    const name = typeof call.function?.name === 'string' && call.function.name.length > 0
      ? call.function.name
      : undefined
    const args = typeof call.function?.arguments === 'string' ? call.function.arguments : undefined
    if (!id || !name || args === undefined) throw new OpenAiGatewayError('assistant.tool_calls contains an invalid function call')
    return { type: 'tool-call' as const, id: id as never, name, arguments: args }
  })
}

/**
 * 单条 OpenAI 消息 → DSH `Message`。
 *
 * ⚠️ **异步**：`user` 消息的 content 可能是多模态数组，图片要经附件服务落盘
 * （`saveImage` 是异步的），故这里整体异步化，由 {@link toGenerateOptions} 串行 await。
 */
async function convertMessage(
  raw: unknown,
  provider: string,
  model: string,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
): Promise<Message> {
  if (!raw || typeof raw !== 'object') throw new OpenAiGatewayError('messages entries must be objects')
  const value = raw as OpenAiChatMessage
  const role = value.role
  if (role === 'system') {
    return createGatewayMessage('system', [{
      type: 'text',
      text: textFromContent(value.content),
    }], gatewaySource())
  }
  if (role === 'user') {
    // ⚠️ user 消息走 parts：图片在这里被真正接收（其它角色不接受图片）。
    return createGatewayMessage('user', await partsFromContent(value.content, bridge, limits), { kind: 'user' })
  }
  if (role === 'assistant') {
    const text = textFromContent(value.content)
    const content: Message['content'] = []
    // 思考模式（DeepSeek V4 等）要求：带 tool_calls 的历史助手消息必须把
    // 当时的 reasoning_content 原样带回。丢掉它，下一跳就是
    // 「The reasoning_content in the thinking mode must be passed back」。
    // 空串不算（上游把空串也当成没回传）；单个空格是客户端用来占位的合法值，保留。
    const reasoning = inboundReasoning(value)
    if (reasoning !== undefined) content.push({ type: 'reasoning', text: reasoning })
    if (text.length > 0) content.push({ type: 'text', text })
    if (value.tool_calls !== undefined) content.push(...convertToolCalls(value.tool_calls))
    return createGatewayMessage('assistant', content, { kind: 'model', provider, model })
  }
  if (role === 'tool') {
    if (typeof value.tool_call_id !== 'string' || value.tool_call_id.length === 0) {
      throw new OpenAiGatewayError('tool messages require tool_call_id')
    }
    // ⚠️ 工具结果的 content **同样支持图片**（2026-10-04 修，真实报障）。
    // 早先这里走 `textFromContent`，而它对 `image_url` 一律抛错 ⇒
    // 「读图类工具」（Codex 的 `view_image`、DSH 的 `read_image`）的结果
    // 让整轮对话 400（用户看到「tool 消息的内容不能包含图片」）。
    // 图片走与 user 消息**同一份**入站实现（附件服务落盘），故这里复用
    // `partsFromContent`；各适配器本就递归消费 `tool-result` 的内嵌图片
    // （见 `trae-adapter.ts` 的 `collectImages` / `userContentParts`）。
    //
    // 形状由当前宿主决定，外部 provider 必须收到与该内核匹配的工具消息。
    return createGatewayToolMessage(
      value.tool_call_id,
      await partsFromContent(value.content, bridge, limits),
    )
  }
  throw new OpenAiGatewayError(`unsupported message role: ${String(role)}`)
}

/**
 * Chat 形状的 tools → DSH 的 ToolSchema。
 *
 * ⚠️ 被 `/v1/responses` 复用：`responses.ts` 先把 Responses 的**扁平**工具定义
 * 改写成 Chat 的嵌套形状，再交给这里做校验。工具 schema 的校验口径只有这一份。
 */
export function convertTools(raw: unknown): ToolSchema[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('tools must be an array')
  return raw.map((value) => {
    if (!value || typeof value !== 'object') throw new OpenAiGatewayError('tool must be an object')
    const tool = value as { type?: unknown; function?: { name?: unknown; description?: unknown; parameters?: unknown } }
    if (tool.type !== 'function' || typeof tool.function?.name !== 'string') {
      throw new OpenAiGatewayError('only function tools are supported')
    }
    const parameters = tool.function.parameters
    if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) {
      throw new OpenAiGatewayError('tool function.parameters must be a JSON object')
    }
    return {
      name: tool.function.name,
      description: typeof tool.function.description === 'string' ? tool.function.description : '',
      parameters: (parameters ?? {}) as Record<string, unknown>,
    }
  })
}

export function parseModelRoute(value: unknown): { provider: string; model: string } {
  if (typeof value !== 'string') throw new OpenAiGatewayError('model must be a string')
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) {
    throw new OpenAiGatewayError('model must use provider/model format')
  }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

/**
 * 正整数字段的校验（`max_tokens` / `max_completion_tokens` / `max_output_tokens`）。
 *
 * ⚠️ 被 `/v1/responses` 复用（`responsesMaxOutputTokens`），三个字段的判据必须
 * 完全一致，否则「同一个数字在 Chat 端合法、在 Responses 端报错」会被当成缺陷。
 */
export function tokenValue(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new OpenAiGatewayError(`${name} must be a positive integer`)
  }
  return value
}

/**
 * @param reasoningEffortOverride 网关归一化后的档位。**三态**：
 * - `string`：用它；
 * - `null`：**明确不下发**（模型未声明思考档位，硬塞只会让 DSH 侧报
 *   `UNSUPPORTED_REASONING_EFFORT`）；
 * - `undefined`：调用方没给 → 回退读 `body.reasoning_effort`（直连调用的老行为）。
 * @param images 图片入站依赖。`bridge` 为 undefined 时收到图片会明确报错而非
 *   静默丢图；`limits` 缺省用附件服务的实测默认值。
 *
 * ⚠️ **本函数是异步的**（图片要经附件服务落盘）。若外部有同步调用方需注意。
 */
export async function toGenerateOptions(
  body: OpenAiChatRequest,
  signal: AbortSignal,
  reasoningEffortOverride?: string | null,
  maxTokensOverride?: number,
  images: { bridge?: AttachmentBridge; limits?: ImageLimits } = {},
): Promise<GenerateOptions> {
  const { provider, model } = parseModelRoute(body.model)
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new OpenAiGatewayError('messages must be a non-empty array')
  }
  if (body.tool_choice !== undefined && body.tool_choice !== 'auto' && body.tool_choice !== 'none') {
    throw new OpenAiGatewayError('only tool_choice auto and none are supported')
  }
  const maxTokens = maxTokensOverride ?? (body.max_completion_tokens !== undefined
    ? tokenValue(body.max_completion_tokens, 'max_completion_tokens')
    : tokenValue(body.max_tokens, 'max_tokens'))
  const stop = body.stop === undefined
    ? undefined
    : typeof body.stop === 'string' ? [body.stop]
      : Array.isArray(body.stop) && body.stop.every(item => typeof item === 'string') ? body.stop
        : (() => { throw new OpenAiGatewayError('stop must be a string or string array') })()
  const temperature = body.temperature === undefined ? undefined
    : typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature
      : (() => { throw new OpenAiGatewayError('temperature must be a finite number') })()

  const tools = convertTools(body.tools)
  if (body.tool_choice === 'none' && tools !== undefined && tools.length > 0) {
    throw new OpenAiGatewayError('tool_choice none with tools cannot be represented by DSH', 400, 'unsupported_parameter', 'unsupported_parameter')
  }
  // ⚠️ 这里用 `!== undefined` 而**不是** `??`：三态必须区分开。
  // - `undefined`：调用方没给（未传）→ 回退到 body 里的值（直连调用的老行为）；
  // - `null`：调用方**明确决定不下发**（模型未声明思考档位）→ 必须原样保留，
  //   否则 `??` 会把它当成「没给」而从 body 捞回原值，让归一化的结论被抵消 ——
  //   实测正是这样：归一化返回 undefined 后，body 里的 'high' 又被塞回请求，
  //   DSH 侧继续抛 UNSUPPORTED_REASONING_EFFORT。
  const reasoningEffort = reasoningEffortOverride !== undefined
    ? reasoningEffortOverride
    : (body.reasoning_effort === undefined ? undefined : String(body.reasoning_effort))
  const limits = images.limits ?? DEFAULT_IMAGE_LIMITS
  // ⚠️ **串行**而非 Promise.all：多张图会并发打附件服务，串行既让限额累计
  // 判定准确（`used` 是逐张累加的），也避免一次性压垮附件服务的并发额度。
  const messages: Message[] = []
  for (const message of body.messages) {
    messages.push(await convertMessage(message, provider, model, images.bridge, limits))
  }
  return {
    provider,
    model,
    messages,
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...temperature === undefined ? {} : { temperature },
    ...stop === undefined ? {} : { stop },
    // ⚠️ 判据是 `== null`（同时排除 undefined 与 null）：`null` = 明确不下发，
    // 两者都不能写进请求。写成 `=== undefined` 会把 null 塞进
    // `ReasoningEffortId(null)`，等于又发了一个非法档位。
    ...reasoningEffort == null ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    signal,
  }
}
