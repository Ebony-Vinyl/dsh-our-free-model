/**
 * 本机网关的 **OpenAI Responses API** 出口（`POST /v1/responses`）。
 *
 * ## 为什么要有它
 *
 * 网关最初只有 `/v1/chat/completions`。而新一代客户端（Codex CLI、以及各家
 * 「只认 Responses」的 agent）**不发** `messages` / `max_tokens`，而是发
 * `input` / `instructions` / `max_output_tokens`，并且只解析 Responses 的
 * SSE 事件（`response.output_text.delta` / `response.output_item.done` /
 * `response.completed`）。协议外壳不同，往里塞 Chat Completions 是塞不进的。
 *
 * ⚠️ **两个端点同时可用，不做「格式开关」**（用户 2026-10-03 明确要求）：
 * 客户端用哪套协议由它自己请求的 URL 决定。做成互斥开关只会让「另一个协议的
 * 客户端在切换后突然失效」，而网关这边本来就没有任何互斥的理由 ——
 * 两者共用同一份 provider 路由、账号池与图片入站。
 *
 * ## 与 `/v1/chat/completions` 的**有意差异**（改这个文件前先读）
 *
 * ## 明确**接受但不生效**的字段
 *
 * `store` / `include` / `prompt_cache_key` / `metadata` / `user` /
 * `truncation` / `service_tier` / `safety_identifier` / `parallel_tool_calls`：
 * 网关是**无状态转发**，既没有可存储的响应（`GET /v1/responses/{id}` 一律 404），
 * 也没有跨请求缓存通道，故这些字段接受并忽略。
 *
 * ⚠️ 但**语义会变**的字段绝不静默忽略 —— 那种「用户以为设置生效了」的失败在
 * 本仓库是被明令禁止的（见 `messages.ts` 的 `normalizeReasoningEffort` 同款
 * 教训）。故 `previous_response_id` / `background` / `text.format`（结构化输出）/
 * `top_p`（非 1 时）一律**明确报 400**。
 *
 * ## 工具：能表达的就摊平，表达不了的就丢弃并记日志（**不是报错**）
 *
 * Codex 0.142+ 用私有的 Responses 扩展声明工具：`{type:'namespace', …}` 分组
 * 容器、`{type:'custom'}` 自由文法工具、`{type:'tool_search'}` 延迟加载检索。
 * 这批形状在第三方网关上普遍翻车（ollama / llama.cpp / xAI 都有对应 issue），
 * 也正是本文件第一版**报错**的地方 —— 用户看到的是一句
 * `tool type namespace is not supported`，代价却是**整轮对话不可用**。
 *
 * 现在的口径（与 sub2api / cc-switch 的成熟做法一致）：
 * - `namespace` 里的 **function 子工具摊平**成 `<namespace>__<child>`
 *   （见 {@link flatNamespaceToolName}），响应侧再把 `function_call` 还原成
 *   `{name, namespace}`（见 {@link responsesNamespaceToolMap}）；
 * - `custom` / `tool_search` / `web_search` 等**无法**用 DSH 的 `ToolSchema`
 *   表达的类型：丢弃 + warning（调用方通过 `onDrop` 接），**绝不让请求失败**。
 */

import { createHash, randomUUID } from 'node:crypto'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, Message, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { DEFAULT_IMAGE_LIMITS, type AttachmentBridge, type ImageLimits } from './images.js'
import {
  OpenAiGatewayError,
  convertTools,
  createGatewayMessage,
  gatewaySource,
  parseModelRoute,
  partsFromContent,
  textFromContent,
  tokenValue,
} from './messages.js'
import { normalizeUpstreamFailure } from './model-errors.js'
import { failureToOpenAiError, withSuggestion, type SuggestionHook } from './stream.js'
import { toOpenAiUsage } from './usage.js'

/** 请求体形状（只声明我们用到的字段；其余原样忽略）。 */
export interface OpenAiResponsesRequest {
  model?: unknown
  input?: unknown
  instructions?: unknown
  stream?: unknown
  temperature?: unknown
  top_p?: unknown
  max_output_tokens?: unknown
  tools?: unknown
  tool_choice?: unknown
  reasoning?: unknown
  text?: unknown
  previous_response_id?: unknown
  background?: unknown
  parallel_tool_calls?: unknown
  metadata?: unknown
  truncation?: unknown
  user?: unknown
  store?: unknown
  [key: string]: unknown
}

const UNSUPPORTED = 'unsupported_parameter' as const

function unsupported(message: string): OpenAiGatewayError {
  return new OpenAiGatewayError(message, 400, UNSUPPORTED, UNSUPPORTED)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * 工具名归一化：**trim + 拒绝空名**。
 *
 * ⚠️ 全仓库**唯一**的工具名入口。工具名在三个地方各算一遍：
 * 请求侧摊平（{@link flattenResponsesTools}）、响应侧还原表
 * （{@link responsesNamespaceToolMap}）、历史回放（{@link toMessages}）。
 * 三处曾经用三套不同的清洗口径 —— 摊平侧 `String(child.name ?? '')`（不 trim、
 * 空名照样拼成 `ns____`），还原侧 `nonEmptyString(...)?.trim()`，历史侧又只做
 * 非空判定 —— 于是子工具名带首尾空格时**发给上游的名字与还原表的键对不上**，
 * 客户端收到一个自己没声明过的工具名（正是 {@link flatNamespaceToolName} 注释里
 * 要防的故障）；空名则凭空多出一个幽灵工具，永远还原不回来。
 *
 * ⇒ 这里**必须 trim**：trim 与不 trim 指向两个不同的工具名，而 trim 后的那个
 * 才与客户端在 `tools` 里声明的语义一致。
 */
function normalizeToolName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * 取出 `reasoning.effort` 的**原始请求值**，交给
 * {@link import('./messages.js').normalizeReasoningEffort} 归一化。
 *
 * ⚠️ 这里只做**形状**校验，不做档位判定：档位是否被该模型支持要看
 * `resolveModelInfo()` 的结果，那是 server 层的事（与 Chat 路径同一分工）。
 * 返回 `undefined` 表示「用户没给」—— `normalizeReasoningEffort` 的三态契约
 * 依赖这个区分。
 */
export function responsesReasoningEffort(body: OpenAiResponsesRequest): unknown {
  const reasoning = body.reasoning
  if (reasoning === undefined || reasoning === null) return undefined
  if (!isObject(reasoning)) throw new OpenAiGatewayError('reasoning must be an object')
  return reasoning.effort
}

/**
 * 取出并校验 `max_output_tokens`（Responses 版的 `max_tokens`）。
 *
 * ⚠️ `null` 按「没给」处理：SDK 把「未设置」序列化成 `null` 是常见形态，
 * 为此回 400 只会让用户莫名其妙。
 */
export function responsesMaxOutputTokens(body: OpenAiResponsesRequest): number | undefined {
  const value = body.max_output_tokens
  if (value === undefined || value === null) return undefined
  return tokenValue(value, 'max_output_tokens')
}

/**
 * Responses 的内容块 → Chat 形状的内容块。
 *
 * ## 为什么要先转成 Chat 形状
 *
 * 图片入站（`partsFromContent` → 附件服务）、纯文本提取（`textFromContent`）
 * 在 Chat 路径上已被实测与单测覆盖。「两套协议各写一份」必然漂移，而漂移的
 * 症状是「图片在 Chat 端能收、在 Responses 端报错」这类极难归因的差异。
 * 故这里只做**外壳改写**，真正的转换逻辑全部复用。
 *
 * 对应关系（官方文档的字段名差异，语义相同）：
 * - `input_text` / `output_text` / `text` → `text`
 * - `input_image.image_url` → `image_url.url`
 * - `refusal` → `text`（拒答文本对 DSH 就是一段 assistant 文本，丢弃才是错的）
 */
function chatPartsFromResponses(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return content
  if (!Array.isArray(content)) {
    throw new OpenAiGatewayError('content must be a string or an array of content parts')
  }
  return content.map((raw) => {
    if (!isObject(raw)) throw new OpenAiGatewayError('content contains an invalid part')
    if (raw.type === 'input_text' || raw.type === 'output_text' || raw.type === 'text') {
      if (typeof raw.text !== 'string') {
        throw new OpenAiGatewayError(`${String(raw.type)} part requires a string text`)
      }
      return { type: 'text', text: raw.text }
    }
    if (raw.type === 'refusal') {
      return { type: 'text', text: typeof raw.refusal === 'string' ? raw.refusal : '' }
    }
    if (raw.type === 'input_image') {
      // ⚠️ `file_id` 形态无法支持：那是 OpenAI 侧的文件资源，网关拿不到它的字节。
      // 明确报错而不是当成空图片 —— 静默丢图会让用户以为模型看到了图。
      if (typeof raw.image_url !== 'string') {
        throw unsupported('input_image 只支持内联的 image_url（base64 data URL）；file_id 形态拿不到图片字节')
      }
      return { type: 'image_url', image_url: { url: raw.image_url } }
    }
    throw new OpenAiGatewayError(`content part type ${String(raw.type)} is not supported`)
  })
}

/**
 * namespace 子工具的**扁平名**。
 *
 * Codex 0.142+ 用它私有的 Responses 扩展声明 MCP / 插件工具：
 * `{type:'namespace', name:'mcp__files__', tools:[{type:'function', name:'read', …}]}`
 * —— namespace 只是一个**分组容器**，真正能被模型调用的仍是里面的 function。
 * 而 DSH 的工具表是**扁平**的（`ToolSchema = {name, description, parameters}`），
 * 故必须把它摊平成 `<namespace>__<child>`。
 *
 * ⚠️ **必须确定性**：请求侧摊平（{@link toChatTools}）与响应侧还原
 * （{@link responsesNamespaceToolMap}）各自独立算这个名字，两边算法不一致就会
 * 「上游按 A 名字调用、网关却按 B 名字还原」，客户端配不上任何工具。故只有这一份实现。
 * ⚠️ 命名法 `namespace__child` 与 Codex 自己（PR #29602「Flatten namespace tools
 * for providers without wrappers」）以及各家代理（sub2api、cc-switch）一致。
 * ⚠️ 超过 64 字符时截断 + 8 位 sha256 后缀：OpenAI 兼容端点的 function name
 * 上限普遍是 64，纯截断会让长名字之间互相碰撞（碰撞的两条用例在 cc-switch 里
 * 是直接报错的，这里靠后缀避免）。
 */
export function flatNamespaceToolName(namespace: string, name: string): string {
  const flat = `${namespace}__${name}`
  if (flat.length <= 64) return flat
  const digest = createHash('sha256').update(flat).digest('hex').slice(0, 8)
  return `${flat.slice(0, 55)}_${digest}`
}

/**
 * 从请求体算出「扁平名 → `{namespace, name}`」的还原表。
 *
 * ⚠️ 与摊平**同源**：两者都走 {@link flattenResponsesTools} 这**一次遍历**。
 * 早先这里是独立重算的，于是两边的清洗口径一旦不同就会漂移（见
 * {@link normalizeToolName} 的注释）；现在连「谁占了哪个名字」的判定也是同一份，
 * 不会出现「顶层工具占了名字、子工具被丢弃，还原表却仍把它映射回 namespace」。
 * 不靠跨函数状态传递：响应侧要还原 `function_call` 的名字，而它拿到的只有请求体，
 * 重算一遍比让 server 把 map 一路穿进来更不容易漏（cc-switch 的成熟实现也是这个思路）。
 */
export function responsesNamespaceToolMap(
  body: OpenAiResponsesRequest,
): Map<string, { namespace: string; name: string }> {
  return flattenResponsesTools(body.tools).nsMap
}

/** 摊平后仍无法表达、因而被丢弃的工具（供调用方记日志）。 */
export interface DroppedTool {
  type: string
  name?: string
}

/**
 * Responses 的工具定义 → Chat 形状。
 *
 * - **`function`**：扁平（Responses 原生）与嵌套（Chat 形状）两种写法都认
 *   （有些客户端会把 Chat 的 tools 原样发过来，为此报 400 毫无收益）。
 * - **`namespace`**：把里面的 function 子工具**摊平**成顶层 function
 *   （见 {@link flatNamespaceToolName}）。⚠️ 包括标了 `defer_loading: true` 的
 *   子工具 —— 那套「延迟加载 + 用 `tool_search` 搜出来」的机制我们表达不了，
 *   直接给模型反而不会丢工具（cc-switch / sub2api 同样如此处理）。
 * - **其余类型**（`custom` / `tool_search` / `web_search` / `file_search` /
 *   `computer_use` / `mcp` …）：**丢弃并通过 `onDrop` 报告**，
 *   但**绝不让整轮请求失败**。
 *
 * ## 为什么这里从「一律报错」改成「丢弃 + 上报」（真实报障，2026-10-03）
 *
 * Codex App 接网关后整轮对话直接失败：
 * `tool type namespace is not supported（网关只提供 function 工具）`。
 * 用户看到的是「连不上」，而根因只是**一个工具类型不认识** —— 报错的代价是
 * 整个会话不可用，收益却只是「让用户知道某个工具没被转发」。两者不对等。
 * 而 `custom`（自由文法工具，如 Codex 的 `apply_patch`）与 `tool_search`
 * 确实**无法**用 `ToolSchema` 表达，丢弃后 Codex 仍有 `shell` 等 function 工具
 * 可用；把这些也变成致命错误，等于让「Codex 能不能用网关」取决于它这一版
 * 恰好带了哪些运行时工具。
 */
function toChatTools(raw: unknown, onDrop?: (tool: DroppedTool) => void): unknown {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new OpenAiGatewayError('tools must be an array')
  return flattenResponsesTools(raw, onDrop).tools
}

/** 摊平后的一个 function 工具（Chat 形状）。 */
interface FlatTool {
  type: 'function'
  function: { name: string; description: unknown; parameters: unknown }
}

/**
 * `tools` 数组 → 摊平后的 function 列表 **+** 还原表（**一次遍历同时产出**）。
 *
 * 之所以合在一起而不是两个函数各算一遍：`name` 的清洗、namespace 的摊平、
 * 「谁占了哪个名字」这三件事只要有一处各算各的，两侧就会漂移，而漂移的症状是
 * 「上游按 A 名字调用、网关按 B 名字还原」—— 客户端配不上任何工具，模型却以为
 * 调通了（见 {@link flatNamespaceToolName} 与 {@link normalizeToolName}）。
 *
 * **名字占用是「先来先到」**：顶层 function 与摊平后的子工具共用一个命名空间，
 * 后到的同名者被**丢弃并记日志**（不能报 400 —— 那会让整个会话不可用，而丢一个
 * 重复声明的工具代价小得多）。⚠️ 还原表必须与「实际发出去的那批」同进同退：
 * 若顶层工具占了名字而子工具被丢弃，还原表却仍把它映射回 `{namespace, name}`，
 * 上游对那个顶层工具的调用就会被**误报成另一个工具**（静默误路由）。
 */
function flattenResponsesTools(
  raw: unknown,
  onDrop?: (tool: DroppedTool) => void,
): { tools: FlatTool[]; nsMap: Map<string, { namespace: string; name: string }> } {
  const tools: FlatTool[] = []
  const nsMap = new Map<string, { namespace: string; name: string }>()
  if (!Array.isArray(raw)) return { tools, nsMap }
  const used = new Set<string>()

  for (const value of raw) {
    if (!isObject(value)) throw new OpenAiGatewayError('tool must be an object')
    if (value.type === 'namespace') {
      const namespace = normalizeToolName(value.name)
      if (namespace === undefined) {
        throw new OpenAiGatewayError('namespace tool requires a non-empty name')
      }
      const children = value.tools
      if (!Array.isArray(children)) {
        throw new OpenAiGatewayError('namespace tool requires a tools array')
      }
      for (const child of children) {
        if (!isObject(child)) throw new OpenAiGatewayError('namespace child tool must be an object')
        if (child.type !== 'function') {
          // namespace 里的非 function 子工具（如 `custom`）同样表达不了。
          onDrop?.({ type: String(child.type), name: nonEmptyString(child.name) })
          continue
        }
        const name = normalizeToolName(child.name)
        if (name === undefined) {
          // ⚠️ **不能**把空名照样摊平：`flatNamespaceToolName(ns, '')` 会拼出
          // `ns____` 这样的幽灵名，绕过 `push` 的非空校验发给上游，而还原表因
          // 「空名跳过」永远配不上它 ⇒ 模型能调一个客户端没声明过的工具。
          onDrop?.({ type: 'function', name: undefined })
          continue
        }
        const flat = flatNamespaceToolName(namespace, name)
        if (used.has(flat)) {
          onDrop?.({ type: 'function', name: flat })
          continue
        }
        used.add(flat)
        nsMap.set(flat, { namespace, name })
        tools.push({ type: 'function', function: { name: flat, description: child.description, parameters: child.parameters } })
      }
      continue
    }
    if (value.type !== 'function') {
      onDrop?.({ type: String(value.type), name: nonEmptyString(value.name) })
      continue
    }
    const flat = isObject(value.function) ? value.function : value
    const name = normalizeToolName(flat.name)
    if (name === undefined) throw new OpenAiGatewayError('function tool requires a non-empty name')
    if (used.has(name)) {
      onDrop?.({ type: 'function', name })
      continue
    }
    used.add(name)
    tools.push({ type: 'function', function: { name, description: flat.description, parameters: flat.parameters } })
  }
  return { tools, nsMap }
}

/**
 * `function_call_output.output` 可能是字符串，也可能是内容块数组。
 *
 * ⚠️ **必须支持图片**（2026-10-04 修，真实报障）：Codex 的 `view_image` 工具把
 * 读到的图直接放进 `output`（`[{type:'input_image',image_url:'data:…'}]`）。
 * 早先这里走 `textFromContent`，它对图片**直接抛错** ⇒ 用户一让模型看图，
 * 整轮对话就 400「tool 消息的内容不能包含图片」，且坏报文落进历史后被**每次重放**，
 * 换 provider 才能恢复（会话证据：ordinal 2736/2738 的 `view_image` 结果，
 * 紧随其后的 2748 就是该错误）。
 *
 * 图片与 user 消息走**同一份**入站实现（附件服务落盘 → `ImageBlock`），
 * 故这里复用 `partsFromContent`，不另写一套。
 */
async function outputParts(
  value: unknown,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
): Promise<Message['content']> {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (value === undefined || value === null) return [{ type: 'text', text: '' }]
  if (!Array.isArray(value)) {
    throw new OpenAiGatewayError('function_call_output.output must be a string or an array of content parts')
  }
  return partsFromContent(chatPartsFromResponses(value), bridge, limits)
}

function assistantItemSource(provider: string, model: string): Message['source'] {
  return { kind: 'model', provider, model }
}

/**
 * 把 Responses 的 `input` 转成 DSH 的消息数组。
 *
 * ## 连续 assistant 项**必须合并**（与 Chat 路径的形态对齐）
 *
 * Responses 把「助手说了一句话」和「助手发起工具调用」拆成**两个 item**
 * （`message` 与 `function_call`），而 Chat 把它们放在**同一条** assistant 消息里
 * （`content` + `tool_calls`）。若照 item 一一映射，**每一个用过工具的会话**都会
 * 给上游留下「连续两条 assistant 消息」的历史 —— 而 Anthropic 系适配器要求
 * user/assistant 交替，这类历史会被上游拒绝或行为异常。
 * 故这里把连续的 assistant 内容块合并进同一条消息（文本 + 工具调用）。
 */
async function toMessages(
  input: unknown,
  provider: string,
  model: string,
  bridge: AttachmentBridge | undefined,
  limits: ImageLimits,
): Promise<Message[]> {
  const messages: Message[] = []
  const pushAssistant = (blocks: ContentBlock[]): void => {
    if (blocks.length === 0) return
    const last = messages[messages.length - 1]
    if (last !== undefined && last.role === 'assistant') {
      last.content.push(...blocks)
      return
    }
    messages.push(createGatewayMessage('assistant', blocks, assistantItemSource(provider, model)))
  }

  const list = typeof input === 'string'
    ? [{ type: 'message', role: 'user', content: input }]
    : input
  if (typeof input !== 'string' && (!Array.isArray(input) || input.length === 0)) {
    throw new OpenAiGatewayError('input must be a non-empty string or array of items')
  }

  for (const raw of list as unknown[]) {
    if (!isObject(raw)) throw new OpenAiGatewayError('input entries must be objects')
    const type = raw.type
    // `type` 缺省时按 EasyInputMessage 处理（`{role, content}`），官方允许这种简写。
    if (type === undefined || type === 'message') {
      const content = chatPartsFromResponses(raw.content)
      if (raw.role === 'user') {
        messages.push(createGatewayMessage('user', await partsFromContent(content, bridge, limits), { kind: 'user' }))
        continue
      }
      if (raw.role === 'assistant') {
        const text = textFromContent(content)
        pushAssistant(text.length > 0 ? [{ type: 'text', text }] : [])
        continue
      }
      if (raw.role === 'system' || raw.role === 'developer') {
        messages.push(createGatewayMessage('system', [{
          type: 'text',
          text: textFromContent(content),
        }], gatewaySource()))
        continue
      }
      throw new OpenAiGatewayError(`unsupported message role: ${String(raw.role)}`)
    }
    if (type === 'function_call') {
      // `call_id` 才是与 `function_call_output` 配对的那个 id；`id`（fc_…）
      // 只是 item 身份。两者都可能出现，优先 `call_id`，缺了才退回 `id`。
      const callId = nonEmptyString(raw.call_id) ?? nonEmptyString(raw.id)
      // ⚠️ 用 {@link normalizeToolName} 而非 `nonEmptyString`：历史里的名字必须与
      // `tools` 侧**逐字符**一致，否则上游会认为模型调用了一个它没见过的工具。
      // 早先这里不 trim，而还原表 trim、摊平侧也不 trim，三处两两不等。
      const bare = normalizeToolName(raw.name)
      // 带 `namespace` 的历史调用要换回**摊平名**：工具是以 `ns__child` 声明给
      // 上游的，历史里若还留着 `namespace: ns / name: child`，上游会认为模型
      // 调用了一个它从没见过的工具（与 Qoder 那条「工具历史必须与 tools 同形」
      // 的教训同型）。
      const namespace = normalizeToolName(raw.namespace)
      const name = bare !== undefined && namespace !== undefined
        ? flatNamespaceToolName(namespace, bare)
        : bare
      if (callId === undefined || name === undefined || typeof raw.arguments !== 'string') {
        throw new OpenAiGatewayError('function_call requires call_id, name and string arguments')
      }
      pushAssistant([{ type: 'tool-call', id: callId as never, name, arguments: raw.arguments }])
      continue
    }
    if (type === 'function_call_output') {
      const callId = nonEmptyString(raw.call_id)
      if (callId === undefined) throw new OpenAiGatewayError('function_call_output requires call_id')
      messages.push(createGatewayMessage('user', [{
        type: 'tool-result',
        toolCallId: callId as never,
        content: await outputParts(raw.output, bridge, limits),
      }], { kind: 'tool', callId: callId as never }))
      continue
    }
    if (type === 'reasoning') {
      // Responses 的 `reasoning` item 带着上游加密的 `encrypted_content`，
      // 网关解不开，也没有可回放的明文，所以这里仍然丢弃。
      // Chat Completions 不一样：客户端带回的是明文 `reasoning_content`，
      // 那条在 `messages.ts` 里会进 `{ type: 'reasoning' }` 再交给适配器回传。
      continue
    }
    if (type === 'item_reference') {
      throw unsupported('item_reference 需要服务端保存过该 item；本网关无状态，无法解析引用')
    }
    throw unsupported(`input item type ${String(type)} is not supported`)
  }
  if (messages.length === 0) throw new OpenAiGatewayError('input contains no usable message')
  return messages
}

/** 校验那些「语义会变、故不能静默忽略」的字段。 */
function assertSupported(body: OpenAiResponsesRequest): void {
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw unsupported(
      'previous_response_id 不被支持：本网关无状态，不保存历史响应。'
      + '请把完整 input 一起发过来（会话状态由客户端自己维护）。',
    )
  }
  if (body.background === true) {
    throw unsupported('background 不被支持：本网关只做同步转发')
  }
  const text = body.text
  if (text !== undefined && text !== null) {
    if (!isObject(text)) throw new OpenAiGatewayError('text must be an object')
    const format = text.format
    if (format !== undefined && format !== null) {
      if (!isObject(format)) throw new OpenAiGatewayError('text.format must be an object')
      const kind = format.type
      // ⚠️ **缺 `type` 也要报错**，不能当「没设格式」放行：本文件的响应固定回
      // `text: { format: { type: 'text' } }`（见 responseJson），客户端于是认定拿到的
      // 是纯文本。而 `{format: {name, schema}}`（漏了 type 的结构化输出请求）一旦被
      // 静默放行，用户会拿到**不合规的 JSON**却毫无察觉 —— 与本文件「语义会变的
      // 字段绝不静默忽略」的原则直接冲突（`background` / `top_p≠1` 都是这么处理的）。
      if (kind !== 'text') {
        throw unsupported(
          `text.format ${JSON.stringify(kind === undefined ? format : String(kind))} 不被支持：`
          + 'DSH 的模型请求没有结构化输出（response_format）通道。'
          + '网关不假装按 schema 约束 —— 那会让客户端以为拿到的是合规 JSON。',
        )
      }
    }
  }
  // DSH 的 `GenerateOptions` 没有 topP（见 `@deepseek-ai/dsh-llm` 的 types）。
  // `top_p: 1` 是默认值、等价于不设置，故放行；其余值明确报错而不是静默丢弃。
  if (body.top_p !== undefined && body.top_p !== null && body.top_p !== 1) {
    throw unsupported('top_p 不被支持：DSH 的模型请求只暴露 temperature')
  }
}

/**
 * Responses 请求 → DSH `GenerateOptions`。
 *
 * @param reasoningEffortOverride 网关归一化后的档位（三态，见
 *   `messages.ts` 的 `normalizeReasoningEffort`）。
 * @param maxTokensOverride 已归一化的输出预算（`normalizeMaxTokens` 的结果）。
 * @param onDrop 无法表达、已被丢弃的工具类型（调用方据此记一条 warning ——
 *   丢弃是**有意**的降级，不能连日志都没有）。
 */
export async function toResponsesGenerateOptions(
  body: OpenAiResponsesRequest,
  signal: AbortSignal,
  reasoningEffortOverride?: string | null,
  maxTokensOverride?: number,
  images: { bridge?: AttachmentBridge; limits?: ImageLimits } = {},
  onDrop?: (tool: DroppedTool) => void,
): Promise<GenerateOptions> {
  assertSupported(body)
  const { provider, model } = parseModelRoute(body.model)
  const limits = images.limits ?? DEFAULT_IMAGE_LIMITS

  // 工具选择：与 Chat 路径同一口径 —— DSH 只能表达 auto / none。
  // ⚠️ `{type:'namespace', name}`（「只在这个 namespace 里选」）按 cc-switch /
  // sub2api 的成熟做法**降级成 auto**，而不是回 400：降级后模型仍能从已摊平的
  // 工具里挑，语义损失可接受；回 400 则会让 Codex 的整轮对话直接失败。
  const requestedChoice = body.tool_choice
  const toolChoice = isObject(requestedChoice) && requestedChoice.type === 'namespace'
    ? 'auto'
    : requestedChoice
  if (toolChoice !== undefined && toolChoice !== 'auto' && toolChoice !== 'none') {
    throw new OpenAiGatewayError('only tool_choice auto and none are supported')
  }
  const tools = convertTools(toChatTools(body.tools, onDrop))
  if (toolChoice === 'none' && tools !== undefined && tools.length > 0) {
    throw unsupported('tool_choice none with tools cannot be represented by DSH')
  }
  const temperature = body.temperature === undefined ? undefined
    : typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature
      : (() => { throw new OpenAiGatewayError('temperature must be a finite number') })()

  const messages: Message[] = []
  if (body.instructions !== undefined && body.instructions !== null) {
    if (typeof body.instructions !== 'string') {
      throw new OpenAiGatewayError('instructions must be a string')
    }
    // 与 Chat 路径的 `system` 消息**同一种构造**（同样的 plugin source），
    // 否则同一份提示词在两个端点上的来源标记不同，排查时会误导。
    messages.push(createGatewayMessage('system', [{
      type: 'text',
      text: body.instructions,
    }], gatewaySource()))
  }
  messages.push(...await toMessages(body.input, provider, model, images.bridge, limits))

  // ⚠️ 判据是 `== null`（同时排除 undefined 与 null）：`null` = 明确不下发。
  const reasoningEffort = reasoningEffortOverride
  const maxTokens = maxTokensOverride ?? responsesMaxOutputTokens(body)
  return {
    provider,
    model,
    messages,
    ...tools === undefined ? {} : { tools },
    ...maxTokens === undefined ? {} : { maxTokens },
    ...temperature === undefined ? {} : { temperature },
    ...reasoningEffort == null ? {} : { reasoningEffort: ReasoningEffortId(reasoningEffort) },
    signal,
  }
}

// ───────────────────────── 响应侧 ─────────────────────────

type ResponsesItemKind = 'message' | 'reasoning' | 'function_call'
type ResponsesStatus = 'in_progress' | 'completed' | 'incomplete' | 'failed'

/**
 * 一个输出项（Responses 的 `output[]` 元素）在流式过程中的状态。
 *
 * ⚠️ `override` / `argumentOverride` 是 `block-end` 的**权威覆盖**（见文件头
 * 第 1 条差异）：最终的 `output_text.done` / `output_item.done` /
 * `response.completed` 都必须用它，只有 delta 事件用过程量。
 */
interface ResponsesItemState {
  readonly index: number
  readonly outputIndex: number
  readonly kind: ResponsesItemKind
  readonly id: string
  text: string
  override?: string
  name?: string
  callId?: string
  arguments: string
  argumentOverride?: string
}

interface Accumulated {
  usage?: TokenUsage
  finishReason?: string
  failure?: { code: string; message: string }
}

function hexId(): string {
  return randomUUID().replaceAll('-', '')
}

function itemId(kind: ResponsesItemKind): string {
  if (kind === 'reasoning') return `rs_${hexId()}`
  if (kind === 'function_call') return `fc_${hexId()}`
  return `msg_${hexId()}`
}

function newItem(index: number, outputIndex: number, kind: ResponsesItemKind): ResponsesItemState {
  return { index, outputIndex, kind, id: itemId(kind), text: '', arguments: '' }
}

/** 文本的权威值：有 block-end 覆盖就用它，否则用 delta 累积值。 */
function finalText(item: ResponsesItemState): string {
  return item.override ?? item.text
}

function finalArguments(item: ResponsesItemState): string {
  return item.argumentOverride ?? item.arguments
}

function kindOfBlock(type: ContentBlock['type']): ResponsesItemKind {
  if (type === 'reasoning') return 'reasoning'
  if (type === 'tool-call') return 'function_call'
  return 'message'
}

function finishReasonOf(reason: FinishReason): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    // aborted / error 不走这里（两者都会先落到 failure 分支）。
    default: return 'error'
  }
}

/** 内容类帧（delta / block-end）写进**输出项**。 */
function applyItemChunk(item: ResponsesItemState, chunk: StreamChunk): void {
  switch (chunk.type) {
    case 'text-delta':
    case 'reasoning-delta':
      item.text += chunk.text
      return
    case 'tool-call-delta':
      // `id` / `name` 只允许**非空**覆盖：分片里偶发空值，覆盖会把已识别的调用打坏。
      if (String(chunk.id).length > 0) item.callId = String(chunk.id)
      if (chunk.name !== undefined) item.name = chunk.name
      item.arguments += chunk.argumentsDelta
      return
    case 'block-end': {
      const block = chunk.block
      if (block.type === 'text' || block.type === 'reasoning') {
        item.override = block.text
        return
      }
      if (block.type === 'tool-call') {
        if (String(block.id).length > 0) item.callId = String(block.id)
        item.name = block.name
        item.argumentOverride = block.arguments
      }
      return
    }
    default:
      return
  }
}

/** 状态类帧（usage / finish）写进**累积状态**。 */
function applyStateChunk(state: Accumulated, chunk: StreamChunk): void {
  if (chunk.type === 'usage') {
    state.usage = chunk.usage
    return
  }
  if (chunk.type !== 'finish') return
  if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
    state.failure = {
      code: chunk.reason.failure.code,
      message: chunk.reason.failure.message || `DSH model request ${chunk.reason.kind}`,
    }
    return
  }
  state.finishReason = finishReasonOf(chunk.reason)
}

/**
 * DSH 的用量 → OpenAI Responses API 的 `usage`。
 *
 * ⚠️ 口径转换全部在 `usage.ts` 里（两个端点共用一份判断）—— **本缺陷就是
 * 因为两端各写一份、且都写错了才发生的**。这里只负责改字段名。
 *
 * ⚠️ `input_tokens` **含缓存命中**（官方口径），命中部分在
 * `input_tokens_details.cached_tokens` 里**单列但仍是它的子集**。
 * 详见 `usage.ts` 文件头的事故记录（用户报障：接入 Codex 后 raccoon 的
 * 上下文占用被少算上百倍）。
 */
function usageJson(usage: TokenUsage): Record<string, unknown> {
  const normalized = toOpenAiUsage(usage)
  return {
    input_tokens: normalized.inputTokens,
    input_tokens_details: { cached_tokens: normalized.cachedTokens },
    output_tokens: normalized.outputTokens,
    output_tokens_details: { reasoning_tokens: normalized.reasoningTokens ?? 0 },
    total_tokens: normalized.totalTokens,
  }
}

/**
 * 把上游返回的**扁平名**还原成客户端认的 `{name, namespace}`。
 *
 * ⚠️ **必须还原**：Codex 的工具注册表是按 `(namespace, name)` 索引的（cc-switch 与
 * sub2api 都把这一步做在响应侧），只回 `mcp__files____read` 这种扁平名它配不上
 * 任何工具 —— 表现为「模型调了工具但客户端说没有这个工具」。没在还原表里
 * （普通顶层工具）就原样返回。
 */
function restoreToolName(
  item: ResponsesItemState,
  nsMap: Map<string, { namespace: string; name: string }> | undefined,
): { name: string; namespace?: string } {
  const name = item.name ?? ''
  const entry = nsMap?.get(name)
  return entry === undefined ? { name } : { name: entry.name, namespace: entry.namespace }
}

function outputItemJson(
  item: ResponsesItemState,
  nsMap?: Map<string, { namespace: string; name: string }>,
): Record<string, unknown> {
  if (item.kind === 'reasoning') {
    const text = finalText(item)
    return {
      id: item.id,
      type: 'reasoning',
      summary: text.length > 0 ? [{ type: 'summary_text', text }] : [],
    }
  }
  if (item.kind === 'function_call') {
    const restored = restoreToolName(item, nsMap)
    return {
      id: item.id,
      type: 'function_call',
      status: 'completed',
      call_id: item.callId ?? '',
      name: restored.name,
      ...restored.namespace === undefined ? {} : { namespace: restored.namespace },
      arguments: finalArguments(item),
    }
  }
  return {
    id: item.id,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: finalText(item), annotations: [], logprobs: [] }],
  }
}

/** 只有真正有产出的项才进 `output[]`（空项会污染客户端的会话历史）。 */
function hasContent(item: ResponsesItemState): boolean {
  if (item.kind === 'function_call') return true
  return finalText(item).length > 0
}

interface ResponseShapeOptions {
  id: string
  model: string
  request: OpenAiResponsesRequest
  status: ResponsesStatus
  output: readonly Record<string, unknown>[]
  usage: Record<string, unknown> | null
  error?: Record<string, unknown> | null
}

/**
 * 组装 Responses 对象。
 *
 * ⚠️ **可空字段一个都不能少**：官方 SDK（openai-node / openai-python）用 schema
 * 解析这个对象，缺字段会直接抛「反序列化失败」，用户看到的是客户端崩了，而根因
 * 只是网关少发了一个 `null`。故这里把所有可空字段显式写成 `null`。
 */
function responseJson(options: ResponseShapeOptions): Record<string, unknown> {
  const request = options.request
  const effort = isObject(request.reasoning) ? request.reasoning.effort ?? null : null
  return {
    id: options.id,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: options.status,
    background: false,
    error: options.error ?? null,
    incomplete_details: options.status === 'incomplete' ? { reason: 'max_output_tokens' } : null,
    instructions: typeof request.instructions === 'string' ? request.instructions : null,
    max_output_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : null,
    model: options.model,
    output: options.output,
    parallel_tool_calls: request.parallel_tool_calls === false ? false : true,
    previous_response_id: null,
    reasoning: { effort, summary: null },
    store: false,
    temperature: typeof request.temperature === 'number' ? request.temperature : null,
    text: { format: { type: 'text' } },
    tool_choice: request.tool_choice ?? 'auto',
    tools: Array.isArray(request.tools) ? request.tools : [],
    top_p: typeof request.top_p === 'number' ? request.top_p : null,
    truncation: typeof request.truncation === 'string' ? request.truncation : 'disabled',
    usage: options.usage,
    user: typeof request.user === 'string' ? request.user : null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  }
}

function statusOf(state: Accumulated): 'completed' | 'incomplete' {
  return state.finishReason === 'length' ? 'incomplete' : 'completed'
}

/**
 * 组装最终的 `output[]`。
 */
function outputOf(
  items: readonly ResponsesItemState[],
  nsMap?: Map<string, { namespace: string; name: string }>,
): Record<string, unknown>[] {
  const output = [...items]
    .sort((a, b) => a.outputIndex - b.outputIndex)
    .filter(hasContent)
    .map(item => outputItemJson(item, nsMap))
  // 空回复：保留一个空 message 项 —— 客户端不认空的 `output[]`。
  if (output.length === 0) output.push(outputItemJson(newItem(-1, 0, 'message')))
  return output
}

/** 上游失败 → 可识别的错误（404 翻译 + 纠错建议），与 Chat 路径同源。 */
async function toUpstreamError(error: unknown, suggest?: SuggestionHook): Promise<OpenAiGatewayError> {
  const converted = failureToOpenAiError(error)
  const message = String(converted.body.error.message)
  const normalized = normalizeUpstreamFailure({
    status: converted.status,
    type: String(converted.body.error.type),
    code: String(converted.body.error.code ?? 'upstream_error'),
    message,
  })
  return new OpenAiGatewayError(await withSuggestion(message, suggest), normalized.status, normalized.type, normalized.code)
}

/**
 * Responses 的 `error.code` 是**枚举**（`server_error` / `rate_limit_exceeded` / …），
 * 官方 SDK 按 Literal 校验。把 DSH 的内部码（`SERVER` / `QUOTA_EXCEEDED` /
 * `incomplete_stream` …）直接塞进去，客户端会在**解析失败事件**时抛校验错误 ——
 * 用户看到的是「客户端崩了」，而真实原因是上游错误。
 *
 * 故 `code` 只放**安全枚举值**，另外三个字段承担诊断信息：
 * - `message`：可读原因（含「你是不是想用 X」的纠错建议）；
 * - `status`：本该返回的 HTTP 状态（流已发 200，状态码改不了；Chat 路径的 SSE
 *   错误帧里也有同名字段，两处口径一致）；
 * - `dsh_code`：DSH 的内部错误码（`model_not_found` / `incomplete_stream` …）。
 *   没有它，流式失败就只剩一句人话，排障时无法与日志对上。
 */
function responsesError(
  converted: { status: number; type: string; code: string; message: string },
): Record<string, unknown> {
  const code = converted.type === 'rate_limit_exceeded' || converted.type === 'rate_limit_error'
    ? 'rate_limit_exceeded'
    : 'server_error'
  return { code, message: converted.message, status: converted.status, dsh_code: converted.code }
}

/**
 * 非流式：把整条流收成一个 Responses 对象。
 *
 * ⚠️ 逐帧判定必须与 {@link toResponsesSse} 保持一致（项的类型由**帧类型**决定、
 * `block-end` 是权威覆盖、`block-start` 负责收尾）。两者共用
 * {@link applyItemChunk} / {@link applyStateChunk}，只有「怎么把项交给调用方」
 * 不同 —— 这里是攒进数组，那里是发 SSE。
 */
export async function collectResponsesResult(
  chunks: AsyncIterable<StreamChunk>,
  responseId: string,
  model: string,
  request: OpenAiResponsesRequest,
  suggest?: SuggestionHook,
): Promise<Record<string, unknown>> {
  const state: Accumulated = {}
  const items: ResponsesItemState[] = []
  const open = new Map<number, ResponsesItemState>()
  /**
   * 已收尾的块索引：**一个块只允许收尾一次**。
   *
   * ⚠️ 少了这道闸门，任何「先被收尾、随后又来一个 `block-end`」的块都会再新建一个
   * 同索引项 —— 同一次工具调用于是发出**两个** `function_call`、共用同一个
   * `call_id`（见 {@link toResponsesSse} 里对用户报障的完整说明）。
   */
  const closed = new Set<number>()
  // 摊平名 → `{namespace, name}`：响应侧要把 `function_call` 还原成客户端认的形态。
  const nsMap = responsesNamespaceToolMap(request)
  let outputIndex = 0
  try {
    for await (const chunk of chunks) {
      // ⚠️ `block-start` 不做事：块之间**可以并行开启**，各自由自己的
      // `block-end` 收尾（理由与后果见 {@link toResponsesSse} 里的同款注释）。
      if (chunk.type === 'block-start') continue
      if (chunk.type === 'block-end') {
        // 一个块只允许收尾一次（与 `BlockAssembler` 的「first close wins」同款）。
        if (closed.has(chunk.index)) continue
        const item = open.get(chunk.index) ?? newItem(chunk.index, outputIndex++, kindOfBlock(chunk.block.type))
        open.delete(chunk.index)
        applyItemChunk(item, chunk)
        closed.add(chunk.index)
        items.push(item)
        continue
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
        // 已收尾的块再来 delta 属于畸形流：忽略，绝不新建项（否则又是重复项）。
        if (closed.has(chunk.index)) continue
        let item = open.get(chunk.index)
        if (item === undefined) {
          item = newItem(chunk.index, outputIndex++, chunk.type === 'text-delta' ? 'message' : chunk.type === 'reasoning-delta' ? 'reasoning' : 'function_call')
          open.set(chunk.index, item)
        }
        applyItemChunk(item, chunk)
        continue
      }
      applyStateChunk(state, chunk)
    }
  } catch (error) {
    throw await toUpstreamError(error, suggest)
  }
  for (const item of open.values()) items.push(item)
  if (state.failure !== undefined) {
    // 上游在流里报错：与 Chat 路径同样翻成可识别的错误（含 404 翻译与纠错建议）。
    throw await toUpstreamError(
      new OpenAiGatewayError(state.failure.message, 502, 'server_error', state.failure.code || 'upstream_error'),
      suggest,
    )
  }
  if (state.finishReason === undefined) {
    throw new OpenAiGatewayError('upstream stream ended before finish', 502, 'server_error', 'incomplete_stream')
  }
  return responseJson({
    id: responseId,
    model,
    request,
    status: statusOf(state),
    output: outputOf(items, nsMap),
    usage: state.usage === undefined ? null : usageJson(state.usage),
  })
}

/**
 * 流式：按 Responses 的事件序列产出 SSE 文本。
 *
 * 事件顺序（与官方一致，客户端按 `output_index` 归位）：
 * `response.created` → `response.in_progress` → 每个输出项的
 * `output_item.added` + 各自的 part/delta/done → `response.completed`
 * （截断时是 `response.incomplete`，失败时是 `response.failed`）。
 *
 * ⚠️ **不发 `data: [DONE]`**：那是 Chat Completions 的收尾约定；Responses 的流
 * 以 `response.completed` / `response.failed` 结束（官方 SDK 依此判定结束）。
 */
export async function* toResponsesSse(
  chunks: AsyncIterable<StreamChunk>,
  responseId: string,
  model: string,
  request: OpenAiResponsesRequest,
  suggest?: SuggestionHook,
): AsyncIterable<string> {
  const state: Accumulated = {}
  const items: ResponsesItemState[] = []
  const open = new Map<number, ResponsesItemState>()
  /** 已收尾的块索引：**一个块只允许收尾一次**（理由见下面的 `block-start` 分支）。 */
  const closed = new Set<number>()
  let outputIndex = 0
  let sequence = 0
  // 摊平名 → `{namespace, name}`：`function_call` 事件必须还原成客户端认的形态
  // （Codex 的工具表按 `(namespace, name)` 索引，只给扁平名它配不上任何工具）。
  const nsMap = responsesNamespaceToolMap(request)

  const emit = (type: string, payload: Record<string, unknown>): string =>
    `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`
  const snapshot = (status: ResponsesStatus, usage: Record<string, unknown> | null, error?: Record<string, unknown> | null): Record<string, unknown> =>
    responseJson({ id: responseId, model, request, status, output: status === 'in_progress' ? [] : outputOf(items, nsMap), usage, error })
  const emitStatus = (status: ResponsesStatus, usage: Record<string, unknown> | null, error?: Record<string, unknown> | null): string =>
    emit(`response.${status}`, { response: snapshot(status, usage, error) })

  /** 打开一个输出项，并补齐 `output_item.added` 与相应 part 的 `added`。 */
  const openItem = (index: number, kind: ResponsesItemKind, seed?: { callId?: string; name?: string }): string[] => {
    const item = newItem(index, outputIndex++, kind)
    if (seed?.callId !== undefined) item.callId = seed.callId
    if (seed?.name !== undefined) item.name = seed.name
    open.set(index, item)
    if (kind === 'message') {
      return [
        emit('response.output_item.added', {
          output_index: item.outputIndex,
          item: { id: item.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
        }),
        emit('response.content_part.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        }),
      ]
    }
    if (kind === 'reasoning') {
      return [
        emit('response.output_item.added', {
          output_index: item.outputIndex,
          item: { id: item.id, type: 'reasoning', summary: [] },
        }),
        emit('response.reasoning_summary_part.added', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text: '' },
        }),
      ]
    }
    const restored = restoreToolName(item, nsMap)
    return [emit('response.output_item.added', {
      output_index: item.outputIndex,
      item: {
        id: item.id,
        type: 'function_call',
        status: 'in_progress',
        call_id: item.callId ?? '',
        name: restored.name,
        ...restored.namespace === undefined ? {} : { namespace: restored.namespace },
        arguments: '',
      },
    })]
  }

  /** 收尾一个输出项：发完它的 `done` 事件。 */
  const closeItem = (item: ResponsesItemState): string[] => {
    const events: string[] = []
    if (item.kind === 'message') {
      const text = finalText(item)
      events.push(
        emit('response.output_text.done', {
          item_id: item.id, output_index: item.outputIndex, content_index: 0, text, logprobs: [],
        }),
        emit('response.content_part.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text, annotations: [] },
        }),
      )
    } else if (item.kind === 'reasoning') {
      const text = finalText(item)
      events.push(
        emit('response.reasoning_summary_text.done', {
          item_id: item.id, output_index: item.outputIndex, summary_index: 0, text,
        }),
        emit('response.reasoning_summary_part.done', {
          item_id: item.id,
          output_index: item.outputIndex,
          summary_index: 0,
          part: { type: 'summary_text', text },
        }),
      )
    } else {
      const restored = restoreToolName(item, nsMap)
      events.push(emit('response.function_call_arguments.done', {
        item_id: item.id,
        output_index: item.outputIndex,
        name: restored.name,
        ...restored.namespace === undefined ? {} : { namespace: restored.namespace },
        arguments: finalArguments(item),
      }))
    }
    // `added` 与 `done` 必须成对：客户端按 added 建行、按 done 定稿，
    // 只发 added 会留下一个永远「进行中」的空项。空内容的项由 `outputOf`
    // 挡在 `response.completed` 之外，不必在这里另做一套判据。
    events.push(emit('response.output_item.done', { output_index: item.outputIndex, item: outputItemJson(item, nsMap) }))
    closed.add(item.index)
    items.push(item)
    return events
  }

  const closeAll = (): string[] => {
    const events: string[] = []
    for (const [index, item] of [...open.entries()].sort(([a], [b]) => a - b)) {
      events.push(...closeItem(item))
      open.delete(index)
    }
    return events
  }

  yield emit('response.created', { response: snapshot('in_progress', null) })
  yield emit('response.in_progress', { response: snapshot('in_progress', null) })

  try {
    for await (const chunk of chunks) {
      // ⚠️⚠️ **这里刻意什么都不做**（2026-10-04 修，真实缺陷）。
      //
      // 早先在每个 `block-start` 上 `closeAll()`，理由是「协议要求项按
      // `output_index` 顺序闭合」。那个前提是错的，代价还极大：
      // **并行工具调用会同时开着多个块** —— 上游依次发
      // `block-start[0] tool-call` / `delta[0]` / `block-start[1] tool-call` /
      // `delta[1]`，而全部 `block-end` 要等流末尾才到（各适配器都在收尾循环里

      // 到达时 [0] **在参数只到一半时就被收尾**并从 `open` 删除；等真正的
      // `block-end[0]` 到达，下面的 `block-end` 分支找不到它，就**新建了一个
      // 同索引项** ⇒ 同一次工具调用发出**两个** `function_call`、共用同一个
      // `call_id`。Codex 对此判
      // `tool calls and tool results do not match, please start a new conversation and retry`
      // 并**终止整轮对话**（用户报障 2026-09-04，会话证据见 AGENTS.md「网关弹窗」相邻章节）。
      //
      // 正确语义与 DSH 的权威实现 `BlockAssembler` 一致：**块之间可以并行开启**，
      // 各自由自己的 `block-end` 收尾；到流末尾仍未收尾的才由 `closeAll()` 兜底。
      // 这与「一个块只能收尾一次」（下面的 `closed` 闸门）是一对，缺一条就会重复。
      if (chunk.type === 'block-start') continue
      if (chunk.type === 'block-end') {
        // 一个块只允许收尾一次：已经收尾过的索引直接忽略
        // （与 `BlockAssembler` 的「first close wins」同款）。
        if (closed.has(chunk.index)) continue
        const existing = open.get(chunk.index)
        if (existing !== undefined) {
          applyItemChunk(existing, chunk)
          for (const event of closeItem(existing)) yield event
          open.delete(chunk.index)
          continue
        }
        // 只发了 block-end、没有 delta 的块：直接按块内容补齐一个完整项，
        // 否则这段内容会**整个消失**（Chat 路径就是这么丢的）。
        const block = chunk.block
        const seed = block.type === 'tool-call' ? { callId: String(block.id), name: block.name } : undefined
        for (const event of openItem(chunk.index, kindOfBlock(block.type), seed)) yield event
        const created = open.get(chunk.index)!
        applyItemChunk(created, chunk)
        for (const event of closeItem(created)) yield event
        open.delete(chunk.index)
        continue
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        // 已收尾的块再来 delta 属于畸形流：忽略，绝不新建项（否则又是重复项）。
        if (closed.has(chunk.index)) continue
        if (!open.has(chunk.index)) {
          for (const event of openItem(chunk.index, chunk.type === 'text-delta' ? 'message' : 'reasoning')) yield event
        }
        const item = open.get(chunk.index)!
        applyItemChunk(item, chunk)
        yield chunk.type === 'text-delta'
          ? emit('response.output_text.delta', {
            item_id: item.id, output_index: item.outputIndex, content_index: 0, delta: chunk.text, logprobs: [],
          })
          : emit('response.reasoning_summary_text.delta', {
            item_id: item.id, output_index: item.outputIndex, summary_index: 0, delta: chunk.text,
          })
        continue
      }
      if (chunk.type === 'tool-call-delta') {
        // 同上：已收尾的块不得因散帧再开一个新项。
        if (closed.has(chunk.index)) continue
        if (!open.has(chunk.index)) {
          // `call_id` / `name` 只在这一帧里出现，故 function_call 项**延迟到这时**
          // 才打开 —— `output_item.added` 必须带上它们，否则客户端配不上 call_id。
          //
          // ⚠️ **首帧 `id` 为空时的已知边角**：`call_id: ''` 会原样进
          // `output_item.added`，而该事件发出去就改不了了 ⇒ 严格按 `added` 配对的
          // 客户端会配错。**刻意不在这里做非空校验**：改成「空 id 就不开项」会让
          // `function_call_arguments.delta` 先于任何 item 发出，事件序列反而破；
          // 「空 id 就等下一帧」则要额外攒 pending 帧，收益（一个罕见边角）小于
          // 它引入的序列风险。
          //
          // ✅ 实际上**能自愈**：`applyItemChunk` 只允许非空 id 覆盖，而 DSH 的
          // 组装块（`block-end`）必然带来真实 id，所以 `output_item.done` 与最终
          // `response.output` 里的 `call_id` 是**正确**的 —— 以那两者为准的客户端
          // （含官方 SDK）不受影响。见 tests 里的「首帧空 id 也能被 block-end 修正」。
          for (const event of openItem(chunk.index, 'function_call', {
            callId: String(chunk.id), name: chunk.name,
          })) yield event
        }
        const item = open.get(chunk.index)!
        applyItemChunk(item, chunk)
        yield emit('response.function_call_arguments.delta', {
          item_id: item.id, output_index: item.outputIndex, delta: chunk.argumentsDelta,
        })
        continue
      }
      applyStateChunk(state, chunk)
    }
  } catch (error) {
    const converted = await toUpstreamError(error, suggest)
    for (const event of closeAll()) yield event
    yield emitStatus('failed', null, responsesError(converted))
    return
  }

  if (state.failure !== undefined) {
    const converted = await toUpstreamError(
      new OpenAiGatewayError(state.failure.message, 502, 'server_error', state.failure.code || 'upstream_error'),
      suggest,
    )
    for (const event of closeAll()) yield event
    yield emitStatus('failed', null, responsesError(converted))
    return
  }
  if (state.finishReason === undefined) {
    // 上游没给 finish 就断了：必须让客户端看见失败，而不是「干净地停在半句话上」。
    for (const event of closeAll()) yield event
    yield emitStatus('failed', null, responsesError({
      status: 502, type: 'server_error', code: 'incomplete_stream', message: 'upstream stream ended before finish',
    }))
    return
  }
  for (const event of closeAll()) yield event
  yield emitStatus(statusOf(state), state.usage === undefined ? null : usageJson(state.usage))
}
