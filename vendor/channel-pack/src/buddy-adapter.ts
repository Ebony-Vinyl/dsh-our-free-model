/**
 * buddy (腾讯 CodeBuddy) LlmAdapter
 *
 * 使用标准 OpenAI Chat Completions 协议 + Bearer access_token 鉴权。
 * 认证由 buddy-auth.ts 服务完成（external-link-v2 轮询式登录 + refresh_token 续期）。
 *
 * 端点：https://copilot.tencent.com/v2/chat/completions
 * 模型列表：静态默认（对齐 /v3/config craft agent models）+ 登录后的动态拉取
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  isContextWindowExceededError,
  LlmAdapter, LlmError,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { settingsNamespaceFor } from './settings-compat.js'
import {
  RATE_LIMIT_FALLBACK_MS,
  isModelSaturationError,
  isRateLimited,
  parseRateLimitError,
} from './llm-adapter.js'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  HTTP_HEADER_DOMAIN,
  HTTP_HEADER_PRODUCT,
  HTTP_HEADER_PRODUCT_CODE,
  credentialExpiresAtMs,
  formatCreditsRate,
  promotionView,
} from './buddy.js'
import type { BuddyCredential, BuddyRemoteModel, PromotionBadge } from './buddy.js'
import { CODEBUDDY, resolveUserAgent, type BuddyFallbackModel, type BuddyProduct } from './product.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isProseTruncatedByStopString, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, reasoningLoopFailure, resolveEmptyResponseReason, resolveToolPairing, splitThinkTaggedContent, stripBareThinkCloseTagIfEnabled, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'

/**
 * CodeBuddy（中国版）的 chat completions 基址。
 *
 * 仅供既有导入方（如 e2e 探针）使用；适配器实例实际请求的基址是
 * `` `${this.product.endpoint}/v2` `` —— 国际版 WorkBuddy 的域名不同
 * （www.workbuddy.ai），故不能再用本常量拼接请求 URL。
 */
export const CHAT_API_BASE = 'https://copilot.tencent.com/v2'

/**
 * 是否为 DeepSeek 系模型（前缀匹配，不区分大小写）。
 *
 * 对齐 workbuddy2api-panel `thinking.go` 的 `isDeepSeekModel` 判定口径与
 * 官方客户端 `thinkingFormat:"deepseek"` 标记：deepseek 系模型「开思考」
 * 必须显式带 `thinking:{type:"enabled"}` + `reasoning_effort` 档位，缺任一
 * 上游都按不思考应答（`reasoning_content` 为空/缺失）。glm/kimi 等其他模型
 * 走各自 thinkingFormat（默认开或 `enable_thinking`），不需要此开关。
 */
function isDeepSeekModel(model: string): boolean {
  return /^deepseek/i.test(model.trim())
}
/**
 * CodeBuddy 的 provider 路由名（历史常量，保留导出以兼容既有导入方）。
 *
 * 注意：适配器实例实际使用的路由名是 `product.id`（`this.product.id`），
 * 本常量只表示 CodeBuddy 那一份取值，不再代表所有产品。
 */
export const PROVIDER = 'buddy'

/** 静态默认模型（对齐 /v3/config 返回的 craft agent models；动态拉取失败时的兜底）。 */
const DEFAULT_MODELS: readonly string[] = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3-1',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
]

/** 默认模型（deepseek-v4-flash，对齐 IDE 默认）。 */
export const DEFAULT_MODEL = 'deepseek-v4-flash'

/**
 * 模型上下文窗口（对齐 Rust BuddyProvider::context_limit 的静态 fallback 表；
 * 权威来源是 /v3/config data.models[].maxInputTokens，由 fetchRemoteModels
 * 动态拉取后经 resolveRemoteContextWindow 优先采用，此表仅作远端不可用时的兜底）。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['deepseek-v4-flash', 1_000_000],
  ['deepseek-v4-pro', 1_000_000],
  ['hy4-preview', 1_000_000],
  ['hy4-preview-x', 1_000_000],
  ['hy3', 192_000],
  ['hy3-x', 192_000],
  ['glm-5.3', 1_000_000],
  ['glm-5.3-flash', 1_000_000],
  ['glm-5.2', 1_000_000],
  ['glm-5.1', 200_000],
  ['glm-5v-turbo', 200_000],
  ['kimi-k3-1', 1_000_000],
  ['kimi-k2.7', 256_000],
  ['kimi-k2.6', 256_000],
  ['minimax-m3', 512_000],
])

/**
 * 模型是否接受图片输入（远端 /v3/config `supportsImages` 不可用时的兜底）。
 *
 * 权威来源是远端下发的 `supportsImages`；此表只在远端未下发该字段时使用。
 * 实测（2026-09 /v3/config）craft agent 的对话模型全部 supportsImages=true，
 * 故这里列出全部对话模型，非对话模型（codewise-* 等）不在此表内。
 */
const IMAGE_MODELS: ReadonlySet<string> = new Set([
  'deepseek-v4-flash',
  'deepseek-v4.1-flash',
  'deepseek-v4.1-flash-sg',
  'deepseek-v4-pro',
  'hy4-preview',
  'hy4-preview-f',
  'hy4-preview-x',
  'hy3',
  'hy3-x',
  'glm-5.3',
  'glm-5.3-flash',
  'glm-5.2',
  'glm-5.1',
  'glm-5v-turbo',
  'kimi-k3',
  'kimi-k3-1',
  'kimi-k2.8-preview',
  'kimi-k2.7',
  'kimi-k2.6',
  'minimax-m3',
])

/**
 * 各模型可选的思考等级（远端 `reasoning.supportedEfforts` 不可用时的兜底）。
 *
 * 只列出**可枚举**等级的模型；仅有固定默认 effort 的模型（glm-5.1/kimi-*）
 * 不在此表内，即不向用户暴露等级选择器。
 */
const REASONING_EFFORTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['deepseek-v4-flash', ['low', 'high', 'max']],
  ['deepseek-v4.1-flash', ['low', 'high', 'max']],
  ['deepseek-v4-pro', ['low', 'high', 'xhigh']],
  ['hy4-preview', ['high']],
  ['hy4-preview-x', ['high']],
  ['hy3', ['low', 'high']],
  ['hy3-x', ['low', 'high']],
  ['glm-5.3', ['low', 'high', 'max']],
  ['glm-5.3-flash', ['low', 'high', 'max']],
  ['glm-5.2', ['high', 'xhigh']],
])

/** 思考等级 id → 展示名（对齐 DeepSeek 官方 provider 的命名）。 */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
}

export interface BuddyAdapterOptions {
  credentialRef: CredentialRef
  /** 前缀缓存会话标识（prompt_cache_key）；未提供时随机生成一个。 */
  sessionId?: string
  /** 从凭据存储解析凭据。 */
  resolveCredential: (modelId?: string) => Promise<BuddyCredential | undefined>
  /** 静默续期凭据。 */
  refresh: () => Promise<void>
  /** 动态拉取远端模型列表（含上下文窗口与能力，若远端下发）；失败时调用方回退到静态列表。 */
  fetchRemoteModels?: () => Promise<BuddyRemoteModel[]>
  /**
   * 读取一张图片的原始字节（图片输入必需）。
   *
   * 由调用方桥接 `ctx.attachments.readImage(ref)`。**失败必须抛错**：
   * 未提供本回调时适配器会报 UNSUPPORTED_CONTENT；提供了但读不到字节时
   * 也必须抛错（不要返回 undefined），否则图片会被静默丢弃、线上请求
   * 退化成纯文本，而用户看不到任何原因。
   *
   * 返回类型刻意不含 `undefined`——早期契约允许返回 undefined 表示
   * 「读不到」，调用方据此 `continue`，正是静默丢图的源头。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string }>
  /**
   * 读取一张图片的**请求版本**（按目标尺寸缩放后的字节），用于替代裸原图。
   *
   * ⚠️ 与 {@link readImage} 的错误契约**刻意相反**：本回调**不可用时必须返回
   * `undefined`**（而不是抛错），因为缩放是一项优化 —— 附件服务未装、版本过旧
   * 没有 `readImageRequest`、或后端拒绝投影（`ATTACHMENT_PROJECTION_UNSUPPORTED`）
   * 时，正确行为是**发原图**，而不是把一次本来能成功的请求打死。
   * 桥接实现见 `src/index.ts` 的 `makeReadImageRequest`。
   *
   * 背景（issue !IKITT9）：原先恒发原图，36 张 1721×997 的截图就顶穿网关
   * 「单次请求图片视觉 token ≈100,000」的上限，此后该会话每一轮都失败。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  fetchImpl?: typeof fetch
  /** 多账号池（用于限流时切换账号） */
  accountPool?: AccountPool
  /**
   * 产品配置；默认为 CodeBuddy。
   *
   * 决定请求身份标识（X-Product-Code / User-Agent）、模型元数据的 provider
   * 字段、providerInfo 的展示名，以及 registerBuddyLlm 注册的路由名。
   * 两个内置产品（CodeBuddy / WorkBuddy）共用同一后端与协议，
   * 差异全部由本配置承载。
   */
  product?: BuddyProduct
}

/** 将消息内容载荷展平为纯文本字符串。 */
function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block): block is { type: string; text: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text')
    .map((block) => String(block.text))
    .join('')
}

/**
 * 将 harness 对话消息序列化为 CodeBuddy chat-completions 的传输格式。
 *
 * 与 openai_chat/codearts 适配器一致：assistant 的 `tool-call` 块转为
 * `tool_calls`，`reasoning` 块折叠为 `reasoning_content`，user 消息中搭载的
 * 工具结果展开为独立的 `{role: 'tool'}` 消息。
 *
 * 两点 CodeBuddy 特有要求（对齐 Rust buddy.rs）：
 * - assistant 消息**始终**携带 `reasoning_content` 字段（推理模型缺失会 400）
 *   ——与 codearts 的 deepseek-v4 校验一致；
 * - 正文为空且带 tool_calls 时 `content` 必须为 `null`（对齐 openai_chat.rs）。
 */
/** 工具结果内嵌图片的载体文本（与官方 deepseek 适配器同名同义）。 */
const TOOL_RESULT_IMAGE_TEXT = 'Attached image(s) from tool result:'

function serializeMessages(
  messages: readonly { role: string; content: unknown }[],
  imageUrls?: ReadonlyMap<string, string>,
): Array<Record<string, unknown>> {
  const wire: Array<Record<string, unknown>> = []

  // 工具结果内嵌图片（read_image 等）不能并入 `role:'tool'` 消息：OpenAI 兼容
  // 协议要求每条 tool 消息紧跟其 assistant tool_call，中间插入任何消息都会 400。
  // 故与官方 deepseek 适配器一致：挂起到其后的独立 user 消息统一发出。
  let pendingToolImages: Array<Record<string, unknown>> = []
  const flushToolImages = (): void => {
    if (pendingToolImages.length === 0) return
    wire.push({
      role: 'user',
      content: [{ type: 'text', text: TOOL_RESULT_IMAGE_TEXT }, ...pendingToolImages],
    })
    pendingToolImages = []
  }

  // ── 孤儿工具调用清理（会话续命的关键）──
  // OpenAI 兼容协议要求：带 `tool_calls` 的 assistant 消息，其**每一个**
  // tool_call id 都必须紧跟一条对应的 `role:'tool'` 结果消息；反之，
  // `role:'tool'` 消息也必须有对应的前置 tool_call。缺任一侧，后端都会以
  // 400 拒绝整个请求。
  //
  // 工具执行失败时（参数非法、超时、工具不存在……）harness 会把 assistant
  // 的 tool_calls 持久化进会话历史，却写不回结果消息。这条坏历史随后被
  // **每次请求原样重放**，于是后端对之后每一条用户消息都返回 400——表现为
  // "任务突然中断，此后发送任何内容都没有回复"，整个会话彻底报废。
  //
  // 适配器是最后一道防线：发出请求前把无法配对的 tool_calls 与 tool 结果
  // 一并剔除，让会话自愈。宁可丢失一轮工具上下文，也好过整条会话死亡。
  // ⚠️ 先归一化 DSH 0.1.7 的消息形状（见 `message-shape.ts`）：0.1.7 把工具结果
  // 改为一等 `role:'tool'` 消息，不再有 `tool-result` 块。若不归一化，下面所有
  // 按 `type === 'tool-result'` 的判据恒不命中 → 结果 id 集合为空 →
  // `resolveToolPairing` 把**全部 tool_calls 剔除**，模型看不到自己调用过什么，
  // 表现为「无工具调用即判对话结束」或「陷入循环思考」。
  const normalized = normalizeHarnessMessages(messages)
  const { keepCallIds, keepResultIds } = resolveToolPairing(normalized)

  for (const message of normalized) {
    if (message.role === 'assistant') {
      // 存量自愈：清洗历史里已持久化的行首 `course` / `课` 泄漏
      // （见 `stripCourseLeakFromHistoryContent`）。只清 assistant ——
      // 判据只对模型自己的输出成立，清洗用户输入等于篡改用户的话。
      const content = stripCourseLeakFromHistoryContent(
        message.role,
        Array.isArray(message.content) ? message.content : [],
      )
      const toolCallBlocks = content
        .filter((block): block is { type: string; id: unknown; name: unknown; arguments: unknown } =>
          typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-call')
        .filter(block => keepCallIds.has(String(block.id)))
      const toolCalls = toolCallBlocks.map((block) => ({
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
      // 挂起的工具结果图片必须在 assistant 之前发出（对齐官方适配器）：
      // 否则它们会漂到这条 assistant 之后，与产生它们的工具调用脱节。
      flushToolImages()
      wire.push({
        role: 'assistant',
        // 正文为空且有工具调用时 content 必须为 null（对齐 openai_chat.rs）。
        content: text.length === 0 && toolCalls.length > 0 ? null : text,
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      flushToolImages()
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中；展开为独立的 role:'tool' 消息。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    const text = contentToText(message.content)
    // 工具结果之外的常规内容（含顶层图片）。
    const regular = content.filter((block) =>
      !(typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result'))
    // 含图片时 content 升级为 OpenAI 多模态 parts（CodeBuddy 唯一接受的图片
    // 形态；{type:'image'} 会以 `unsupported content type ... image` 400）。
    //
    // 注意：这里**不能**把「空 Map」也降级为 undefined。`imageUrls` 为 undefined
    // 只发生在整个请求都没有图片时；若图片存在但全部读取失败，map 是**空的**
    // 而非 undefined。降级成 undefined 会让 `[image unavailable]` 占位符也被跳过，
    // 图片静默消失；只有部分失败时（map 非空）才会出现占位符 —— 同一故障两种
    // 表现。保留空 Map 可让 `userContentParts` 统一产出占位符。
    const regularImageUrls = imageUrls
    const parts = regularImageUrls === undefined
      ? undefined
      : userContentParts(regular, regularImageUrls)
    if (parts !== undefined) {
      flushToolImages()
      wire.push({ role: 'user', content: parts })
    } else if (text.length > 0 || toolResults.length === 0) {
      flushToolImages()
      wire.push({ role: 'user', content: text })
    }
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 assistant tool_call 其结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      // 工具结果内嵌的图片（read_image 等）单独收集：文本继续走 `role:'tool'`，
      // 图片挂起到其后的 user 消息 —— 与原实现相比，这里补上了递归分支，
      // 否则图片会被 contentToText 静默丢弃（只留元数据文本）。
      let resultText = '(no output)'
      if (regularImageUrls !== undefined && Array.isArray(result.content)) {
        const resultParts = userContentParts(result.content, regularImageUrls)
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
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 腾讯侧**安全策略拦截**（业务码 11140）判定。
 *
 * ⚠️ 这类拒绝**也回 HTTP 403**，报文实测（2026-09-27，workbuddy /
 * deepseek-v4.1-flash）：
 * ```json
 * {"code":11140,"msg":"request illegal","requestId":"…",
 *  "displayMsg":{"en":"The content did not pass the safety review. …",
 *                "zh":"内容未通过安全审核，请调整后重试。"}}
 * ```
 * 同一报文在 CodeArts 侧还会以 HTTP 200 + SSE 内嵌错误帧的形式出现。
 *
 * ## ⚠️ 服务端称它「内容」问题，实测却是**账号级**的（2026-09-27 修正）
 *
 * 逐账号对照实测：**同一份请求体**（`system` + 两个字）发往池里 7 个账号，
 * 结果 2 个 200、4 个 403/11140、1 个 429 —— 拦截**按账号生效**，与内容无关。
 * 用户侧现象吻合：连「你好」都被拦，且换新会话照样被拦（排除上下文累积）。
 *
 * 因此**不能**把它当成「内容问题，与账号无关」而拒绝换号（早期实现的错误结论）：
 * 那样池里有可用账号也永远用不上，且提示用户「请调整内容」——指错方向。
 * 正确处理与 401/403 认证失败一致：**换号**，全部试完才报错。
 *
 * 判据用三个独立信号（任一命中即可）：业务码、`msg` 措辞、`displayMsg` 文案。
 * 只看状态码无法区分 —— 403 同时覆盖「真认证失败 / 额度 / 权限 / 安全策略」。
 */
function isContentRejection(body: string): boolean {
  if (body.length === 0) return false
  return /"code"\s*:\s*11140/.test(body)
    || /request illegal/i.test(body)
    || /安全审核|safety review/i.test(body)
}

/**
 * 安全策略拦截的**账号冷却时长**（30 分钟）。
 *
 * ## 为什么必须自己定一个时长
 *
 * 服务端**不给解除时间**：11140 的报文里只有 `code` / `msg` / `displayMsg`，
 * 没有任何 reset 字段。因此不能走 `parseRateLimitError` —— 它解析不到时间时
 * 兜底成 1 小时（与限流的真实语义挂钩），把它当作「11140 的时长」属于偷换概念。
 * 这里独立命名一个常量，把「策略拦截的冷却」与「限流的等待」在语义上分开。
 *
 * ## 为什么取 30 分钟
 *
 * - 太短（如 1 分钟）挡不住一个 agent 轮次里的连续重发 —— 那正是用户报障的
 *   「每次都拿最先选中的坏账号去撞」；
 * - 太长则把「其实已恢复」的账号白白锁死（服务端策略可能随时间/额度状态解除）；
 * - 30 分钟也限制了误伤窗口：标记**只随时间到期失效**（`getAvailableAccount`
 *   的判据是 `Date.now() >= resetAt`，见 `src/account-pool.ts:578`），
 *   所以时长直接等于「这个账号在该模型上被藏起来多久」。
 *   ⚠️ 别指望 `sweepExpiredRateLimits` 来清 —— 它在生产代码里**没有任何调用方**
 *   （只有 `account-pool.spec.ts` 用），到期完全靠上面那个时间比较。
 *
 * ⚠️ 与 cline / lobsterai / trae 的 `*_RATE_LIMIT_FALLBACK_MS`（均 1 小时）**不同源**：
 * 那三个是「解析不到限流重置时间」的兜底，本常量是「服务端压根不给时间」的策略拦截冷却。
 * 别把它们合并成一个常量 —— 语义不同，将来调其中一个不该动另一个。
 *
 * ⚠️ UI 副作用（已知取舍）：复用的是 `modelRateLimits`，账号卡片因此显示
 * 「限额重置 · <模型> · 30 分钟后」（`plugin-src/client/channel-pack.js:412-418`），
 * 而不是「安全策略拦截」—— 该结构只有一个 `模型→时刻` 映射，不带原因字段。
 * 换来的是现成的三条解禁路径都能用它：时间到期、Channel Pack「重置」按钮
 * （`clearModelRateLimits`）、「重测」（`account-probe.ts` 真发一条最小消息，
 * 通过才清标记）。
 */
const BUDDY_POLICY_BLOCK_COOLDOWN_MS = 30 * 60_000

/**
 * 安全策略拦截的错误。
 *
 * ## 错误码：`PERMISSION_DENIED`，**绝不能**取 `AUTH`
 *
 * 早期实现先取 `INVALID_REQUEST`（把账号级拦截说成「你的请求有问题」，指错方向），
 * !15 改成了 `AUTH` —— 而 `AUTH` 同样是错的，且错得更彻底：**它会吞掉整条 message**。
 *
 * DSH 聊天 UI 的判据（实测于安装包 `dsh-client-ui-chat/lib/client.js:1229-1234`）：
 * ```js
 * if (code === "QUOTA" || code === "ACCOUNT_QUOTA") return t("message.failure.quota");
 * return code === "AUTH" ? t("message.failure.auth") : message;
 * ```
 * 即 `AUTH` 会把 message 整个替换成固定文案「API 密钥无效」（`displayFailure()`
 * 那里甚至强制 `message: ""`），**本函数精心写的中文说明一个字都到不了用户眼前**。
 * 这与 !16 描述里抱怨的「UI 把用户引向检查密钥，而 7 个 token 实测全部有效」
 * 是同一个来源 —— 而除 `AUTH` / `QUOTA` / `ACCOUNT_QUOTA` 外的码**原样透传 message**，
 * 所以换码之后 !15 的文案才第一次真正生效。
 *
 * ⚠️ 也不能取 `QUOTA` / `ACCOUNT_QUOTA`：除文案错位（「额度已用尽」）外，
 * UI 还会为这两个码额外弹全局额度 Toast。
 *
 * 取 `PERMISSION_DENIED` 与本仓库既有惯例一致 —— `cline-adapter.ts` 的地域限制
 * 分支就用的这个码，并配有专门用例断言「错误码不是 AUTH」（`cline-adapter.spec.ts:479`）。
 * 它同时**不在** harness 的 `DEFAULT_RETRYABLE_CODES`
 * （`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）里：
 * 「这个账号被策略拦了」是确定性结论，交给 harness 白退避 5 次毫无意义 ——
 * 出路是换号（由本适配器的换号循环负责），不是重试同一个账号。
 */
function contentRejectionError(
  productId: string,
  status: number,
  body: string,
  rotated: boolean,
): LlmError {
  // 两条通道的如实描述不同：HTTP 路径试完了全部候选，流内路径只撞到当前账号
  // （那里不重发，避免「已吐了一半再重放」的重复计费与重复执行工具风险）。
  const scope = rotated
    ? `全部账号均被服务端安全策略拦截（HTTP ${status}，已逐个换号重试）`
    : `当前账号被服务端安全策略拦截（HTTP ${status}，流内错误帧下发）`
  return new LlmError(
    `${productId}: ${scope}。该拦截按账号生效（同一请求在其他账号可正常返回），`
    + `请在 Channel Pack 停用或更换被拦账号：${errorDetail(body)}`,
    'PERMISSION_DENIED',
    { status },
  )
}

/**
 * 纯函数：由「现在」算出策略拦截冷却的到期时刻。
 *
 * 单测靠它锁死时长（不必等真实时间流逝），也与 {@link markPolicyBlockedAccount}
 * 分开，避免为了验证一个数字而去 mock 整个账号池。
 */
export function policyBlockResetAtMs(nowMs: number): number {
  return nowMs + BUDDY_POLICY_BLOCK_COOLDOWN_MS
}

/**
 * 把被安全策略拦截的账号在**该模型**上冷却一段时间。
 *
 * ## 为什么必须标记（真实缺陷，2026-09-28）
 *
 * !15 / !16 之后「有可用账号就一定能用上」已经成立，但**每轮都要重撞坏账号**：
 * 候选顺序是用户在 Channel Pack 拖拽定的（`getAvailableAccount` 不再按重置时间重排），
 * 被拦账号若排在前面，每次请求都要先把那几个坏账号各发一遍才轮到可用账号 ——
 * 白烧额度、白等往返，且每轮都一样。实测那个池是「前 4 个被 11140 拦、后 3 个可用」，
 * 于是每次请求固定多发 4 次失败。
 *
 * ## 为什么复用 `modelRateLimits`
 *
 * 它是账号池里**唯一**的「账号 × 模型暂时不可用」载体（`ProviderAccountEntry`
 * 只有 `模型id → 重置时间戳` 这一个映射，没有 reason / 级别字段），复用它的收益：
 * ① `getAvailableAccount` 的过滤天然生效（`account-pool.ts:577-578`）；
 * ② UI 已有徽章与「重测 / 重置」两条人工解禁路径（`account-probe.ts`）。
 * 代价是徽章文案显示为「限额重置」而非「安全策略拦截」—— 已知取舍，见常量注释。
 *
 * **只标该模型**，与 qoder 额度那条（`qoder-adapter.ts` 的 `switchAccountOnQuota`）
 * 同口径：实测只证明「同一模型下按账号生效」，没有跨模型证据，标全部模型会误伤
 * 本可用的组合。
 *
 * ⚠️ 标记失败**只记日志、不上抛**（与 `src/expiry-sync.ts` 的回写惯例一致）：
 * 本次请求的准确错误才是主线，写不进索引不该把它顶替成未知故障。
 */
async function markPolicyBlockedAccount(
  pool: AccountPool | undefined,
  productId: string,
  accountId: string,
  modelId: string,
): Promise<void> {
  if (pool === undefined || accountId.length === 0 || modelId.length === 0) return
  try {
    await pool.updateModelRateLimit(accountId, modelId, policyBlockResetAtMs(Date.now()))
  } catch (error) {
    console.warn(`[${productId}] 安全策略拦截的冷却标记写入失败（不影响本次请求）:`, error)
  }
}

/** 从错误体提取可读 detail 文本。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    // ⚠️ 腾讯系（buddy / workbuddy）用 `msg` + `displayMsg.{zh,en}` 报错，而标准
    // `message` 字段**不存在**。早期实现只读 `error.*` / `data.message`，于是
    // 全部落空、退化成「返回整段 JSON 原文」——实测把 291 字符的原始报文糊在
    // 错误提示里，而服务端早已备好中文说明 `displayMsg.zh`，被白白埋掉。
    const display = typeof data.displayMsg === 'object' && data.displayMsg !== null
      ? data.displayMsg as Record<string, unknown>
      : undefined
    const localized = typeof display?.zh === 'string'
      ? display.zh
      : typeof display?.en === 'string' ? display.en : undefined
    const parts = [
      // 本地化文案最可读，排在最前。
      localized,
      typeof error?.code === 'string' ? error.code : undefined,
      typeof error?.type === 'string' ? error.type : undefined,
      typeof error?.message === 'string' ? error.message : undefined,
      // 腾讯系用 `msg` 而非 `message`。
      typeof data.msg === 'string' ? data.msg : undefined,
      typeof data.message === 'string' ? data.message : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体
  }
  return body
}

/**
 * 将 HTTP 状态码映射为 harness 错误码。
 *
 * 400 需要看**响应体**才能区分「上下文超限」与「普通请求错误」：前者必须归为
 * CONTEXT_WINDOW_EXCEEDED，才能触发 DSH 的 context-overflow 自动压缩恢复
 * （dsh-compaction-basic 监听 `agent/request-error`，只对
 * `failure.code === CONTEXT_WINDOW_EXCEEDED` 的失败压缩上下文并重试）；
 * 若一律标成 INVALID_REQUEST，长会话一旦越过窗口就会直接把裸错误抛给用户。
 *
 * 实测报文（国际版 WorkBuddy，deepseek-v4.1-flash）：
 * ```
 * {"code":11115,"msg":"prompt is too long: 1061554 tokens > 1048576 maximum",
 *  "extError":{"code":"context_length_exceeded","type":"invalid_request_error",...},
 *  "displayMsg":{"en":"The request exceeds the model context limit. ..."}}
 * ```
 * 注意该报文的 `msg` 是「prompt is too long」措辞、`extError.code` 是
 * `context_length_exceeded`，两者都能被 `isContextWindowExceededError` 识别。
 *
 * 与 CodeArts 适配器（llm-adapter.ts 的 httpErrorCode）同一判定口径，但
 * **传入原始 body 而非 errorDetail(body)**：`errorDetail` 在能提取到
 * `error.*` / `message` 时会返回拼接后的短文本，从而丢掉 `extError`、
 * `displayMsg` 等字段——实测「仅 msg 文本」这种输入会被
 * `isContextWindowExceededError` 漏判（其正则要求出现 context/for-the-model
 * 字样），而完整 body 因含 `extError.code = context_length_exceeded` 能稳定命中。
 * 判定看完整报文、展示用归一化文本，两者职责不同。
 */
/**
 * 腾讯网关「请求过大」的另一种措辞：`prompt is too long: 100001 tokens > 100000 maximum`。
 *
 * ⚠️ harness 的 `isContextWindowExceededError` **认不出这句话**（实测其五个分支
 * 都要求出现 `context` / `for this model` / `maximum context` 之类字样，而这句
 * 一个都没有）。报文若同时带 `extError.code = context_length_exceeded` 还能靠
 * 结构化那条命中；**只带 `code`/`msg`/`displayMsg`** 时就漏判。
 * 实测四种报文形态：带 extError ✅ 命中；仅 msg / 仅 msg+displayMsg / 拼给用户的
 * 整行 ❌ 全部漏判 —— 这正是 issue !IKITT9 里「逐字相同的错误一会儿
 * CONTEXT_WINDOW_EXCEEDED、一会儿 INVALID_REQUEST」的成因。
 *
 * ⚠️ 判据必须**同时**要求「prompt is too long」与「N tokens > M」两个特征：
 * 只认前者的宽泛措辞会把别的内容类 400 误判成溢出。
 */
const GATEWAY_PROMPT_TOO_LONG = /\bprompt\s+is\s+too\s+long\b[\s\S]{0,40}?\b\d[\d,]*\s+tokens?\s*>/i

/**
 * 漏判为什么必须修（后果是**不对称**的）：
 *
 * - `INVALID_REQUEST` **不在** harness 的 `DEFAULT_RETRYABLE_CODES`
 *   （`[EMPTY_RESPONSE, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT]`）→ 不重试；
 * - 更关键的是它**不触发溢出压缩**：`dsh-compaction-basic` 的 request-error
 *   listener 第一行就是 `if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE) return next()`
 *   → 连「试一次压缩」的机会都没有，用户直接看到裸错误、会话从此每轮报废。
 *
 * 归成溢出的最坏结果只是一次无效的压缩尝试；归错成 INVALID_REQUEST 的代价是
 * 整个会话不可恢复。方向因此取「宁可多判一次溢出」。
 */
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    // 先判上下文超限，再退回通用 INVALID_REQUEST。
    // 两条判据：harness 的通用分类器 + 本仓库补的网关措辞（见上）。
    if (isContextWindowExceededError(body) || GATEWAY_PROMPT_TOO_LONG.test(body)) {
      return CONTEXT_WINDOW_EXCEEDED_CODE
    }
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/**
 * SSE 流空闲超时。buddy（CodeBuddy）后端对 SSE 连接有空闲断连策略：模型
 * 生成超长推理或大工具调用参数时，两次 chunk 之间可能静默数十秒。原实现
 * 直接 `await reader.read()` 且没有任何超时——连接被服务端掐断后若对端
 * 既不发数据也不关连接（半开连接），read() 会**永久挂起**，generator 永不
 * 返回，harness 当前步骤既不出结果也不报错，会话永久停留在"运行中"：web
 * 端表现为进度停止、发送按钮置灰、后续"继续"指令完全无响应。
 *
 * 主动以略小于后端超时窗口的间隔检测空闲，超时则取消 reader 并抛可重试
 * 的 TIMEOUT，让 harness 重试该步骤并把控制权交还给用户。
 *
 * 分两个阶段，与 codearts 适配器保持一致：
 * - firstTokenTimeout：等待首个 chunk 的窗口（模型排队 / 长思考时较长）；
 * - chunkTimeout：收到首 chunk 后，两次 chunk 之间的最大静默（每次成功
 *   读取后重置）。
 *
 * 两者均可由环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT 路径，
 * 或线上针对特定模型调优。在每次 stream() 调用时读取，避免模块顶层常量
 * 在 import 时定型导致测试中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 120_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_BUDDY_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 120_000
}

/**
 * 模型饱和（`14003`）的**内部重试**次数。
 *
 * ## 为什么饱和要自己重试，而额度限流（6004）不重试
 *
 * 两者的时间尺度完全不同：
 * - **额度限流 6004**：确定性 —— 「这个账号今天/这小时用完了」，重试**必然**再撞，
 *   只能等解禁或换账号；
 * - **模型饱和 14003**：**瞬时**过载，服务端原话就是「模型繁忙，请稍后重试」，
 *   且报文的 `actions` 里自带 `RETRY`。
 *
 * ⚠️ **重试必须留在本账号上**（不换号）：饱和是**模型级**的，池里 4 个独立账号
 * 会撞同一堵墙 —— 实测 4 个不同腾讯 uid 在 20 秒内全部被同一个 14003 拒绝。
 * 换号只会白烧掉「还有额度」的账号，正是本次要修的缺陷。
 */
const BUDDY_SATURATION_MAX_RETRIES = 2

/**
 * 饱和重试的基准间隔（毫秒），按次数**线性**递增（2s → 4s）。
 *
 * ⚠️ 刻意取短：14003 那次失败**自身**就要跑 46~111 秒才返回，
 * 退避再叠长间隔会让 UI 长时间停在「运行中」而无法区分「排队」与「卡死」。
 * 这与 Qoder 排队那条「≥10 秒封顶」的取舍同因。
 */
const BUDDY_SATURATION_BASE_DELAY_MS = 2_000

/**
 * 饱和重试的等待时长（毫秒）。
 *
 * ⚠️ 环境变量**不能**写成 `parseInt(…) || 默认值`：`0` 是合法值
 * （表示「不等」，单测靠它把用例压到毫秒级），而 `0` 是 falsy 会被 `||`
 * 静默换成 2000 —— 与 `QODER_QUEUE_MAX_DELAY_MS` 那次踩过的坑同型。
 */
function buddySaturationDelayMs(attempt: number): number {
  const raw = process.env.DSH_BUDDY_SATURATION_DELAY_MS
  const base = raw === undefined || raw === '' ? BUDDY_SATURATION_BASE_DELAY_MS : Number(raw)
  const resolved = Number.isFinite(base) && base >= 0 ? base : BUDDY_SATURATION_BASE_DELAY_MS
  return resolved * (attempt + 1)
}

/** 等待指定毫秒数（可被单测用 `DSH_BUDDY_SATURATION_DELAY_MS=0` 短路）。 */
function sleepMs(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 判断是否为传输级错误。 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  if (message.includes('terminated')) return true
  if (error.name.startsWith('UND_ERR_')) return true
  if (message.includes('fetch failed')) return true
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * 把 user 消息内容块转为 OpenAI 多模态 parts；无图片时返回 undefined，
 * 让调用方保持原有的纯字符串路径（无图请求的线上格式不变，避免破坏前缀缓存）。
 *
 * `tool-result` 分支为**递归**，与 `collectImages()` 的递归深度保持一致：
 * 二者若不对称，出现在深层工具结果里的图片会被 collectImages 收进 refs、
 * 却因这里只走一层而在序列化阶段被静默丢弃（连 `[image unavailable]`
 * 占位符都没有）。实测 harness 目前只产生一层嵌套，但既然收集侧已经是
 * 任意深度，序列化侧就必须同样递归，否则是一处埋着的静默丢图。
 */
function userContentParts(
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
      // 递归取内层 parts：内层只要出现图片，hasImage 即为真，
      // 从而让整条消息升级为多模态形态。
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

/** 收集 user 消息中的图片附件引用（含工具结果内嵌图片），按 attachmentId 去重。 */
function collectImages(content: readonly unknown[], refs: Map<string, unknown>): void {
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

/** buddy (腾讯 CodeBuddy 系) 模型适配器。使用 Bearer access_token 鉴权。 */
export class BuddyAdapter extends LlmAdapter {
  /** 本适配器所属的产品配置（默认 CodeBuddy）。 */
  private readonly product: BuddyProduct
  private readonly fetchImpl: typeof fetch
  /**
   * 前缀缓存会话标识（prompt_cache_key）。同一会话内所有请求复用同一 key，
   * 服务端据此把相同前缀的 KV 缓存跨请求复用；缺失时缓存命中恒为 0。
   */
  private readonly sessionId: string
  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: BuddyRemoteModel[] | undefined
  /**
   * 目录加载闸门：并发去重 + 失败/空结果冷却。
   * 依据见 `src/remote-catalog-gate.ts`（首屏「加载模型巨长」的实测归因）。
   */
  private readonly catalogGate = new RemoteCatalogGate()
  /** 远端下发的模型元数据（id → 能力），listModels/resolveModel/stream 共用。 */
  private remoteMeta: ReadonlyMap<string, BuddyRemoteModel> = new Map()
  /** 远端下发的模型上下文窗口（/v3/config data.models[].maxInputTokens）。 */
  private remoteContextWindows: ReadonlyMap<string, number> = new Map()
  /**
   * 产品级兜底模型索引（`product.fallbackModels` 的 id → 条目）。
   * 远端缺失时补位；构造时一次性建立，只读。
   */
  private readonly productFallbackIndex: ReadonlyMap<string, BuddyFallbackModel>
  /** 产品级兜底上下文窗口（构造时从 fallbackModels 提取）。 */
  private readonly productFallbackContextWindows: ReadonlyMap<string, number>

  constructor(private readonly options: BuddyAdapterOptions) {
    super()
    // 默认 CodeBuddy，保证既有行为完全不变。
    this.product = options.product ?? CODEBUDDY
    this.fetchImpl = options.fetchImpl ?? fetch
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
    const fallback = this.product.fallbackModels ?? []
    this.productFallbackIndex = new Map(fallback.map((model) => [model.id, model]))
    this.productFallbackContextWindows = new Map(
      fallback
        .filter((model) => model.contextWindow !== undefined)
        .map((model) => [model.id, model.contextWindow as number]),
    )
  }

  /**
   * 该模型此刻是否**免费**（消耗 0 积分）。
   *
   * ## 为什么需要它
   *
   * `pickBuddyCredential`（`src/index.ts`）只问「锁没锁 + 有没有临期积分」，
   * 从不问「这个模型要不要钱」。于是免费模型也会被「锁定永久积分 + 无临期积分」
   * 这道门拦下，报出「没有可用账号……已锁定永久积分，而所有账号的『N 天内到期』
   * 积分都已用尽」，而它**一分积分都不需要** —— 用户看到的是
   * 「账号明明有余额却失败」的矛盾错误（真实报障）。
   *
   * 免费模型既不消耗临时积分也不消耗永久积分，故它与「锁定」要保护的
   * 目标（别把永久积分烧掉）无关，不该受该门约束。
   *
   * ## 判据（任一成立即免费，与展示层口径一致）
   *
   * 1. `creditsRate === 'x0'` —— 服务端 `credits: "0x"` / `"x0"`；
   * 2. `discountedCreditsRate === 'x0'` —— 促销价打到 0；
   * 3. 两者 === `'免费'` —— 促销 `factor: 0` 时 `parsePromotions` 直接写入的
   *    **中文串**（不是 `x0`，这条最容易漏，见 `src/buddy.ts` 的 `rate = '免费'`）。
   *
   * ⚠️ **只在确定免费时返回 true**：字段缺失、解析失败、未知模型一律 false。
   * 把付费模型误判成免费会绕开锁定，**真烧掉永久积分且不可撤回** ——
   * 因此这里取「保守方向」：宁可让免费模型多走一次余额门，
   * 也不放过任何无法确认的情形。
   *
   * ⚠️ 远端目录是懒加载的（`ensureRemoteModels()`），必须先 await：
   * 调用点虽在 `prepareCall` 之后（目录通常已就绪），但「直接进会话」等路径
   * 可能尚未拉取，漏掉这一步补丁会**静默失效**（退回被拦截的行为）。
   *
   * @param modelId - 模型 id。
   * @returns true 仅当能确认该模型消耗 0 积分。
   */
  async isFreeModel(modelId: string | undefined): Promise<boolean> {
    if (typeof modelId !== 'string' || modelId.length === 0) return false
    await this.ensureRemoteModels()
    // ⚠️ 兜底表（`BuddyFallbackModel`）**没有**倍率字段 —— 它是编译期快照，
    // 价格会变，故刻意不写死（见 `reconcileWithFallback` 的说明）。
    // 因此这里只信远端 `remoteMeta`；查不到即视为「无法确认免费」。
    const meta = this.remoteMeta.get(modelId)
    if (meta === undefined) return false
    const isZeroRate = (rate: string | undefined): boolean => rate === 'x0' || rate === '免费'
    // ⚠️ 实时重算：promotionView 按**当前时刻**判定促销是否生效，
    // 取代冻结在 `discountedCreditsRate` 的 config 拉取时刻值——否则夜间拉取后
    // 白天仍把付费模型误判成免费，绕过永久积分保护锁（真烧掉积分且不可撤回）。
    const view = promotionView(meta, new Date())
    return isZeroRate(meta.creditsRate) || isZeroRate(view.effectiveRate)
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * DSH 会强制校验 `info.id === provider` 且 `info.name` 为非空字符串；
   * 模型设置页还会用该 id 计算 `deriveKeyRef(provider)`（内部调用
   * `provider.toUpperCase()`）。因此这里对入参做防御性归一化：
   * 一旦 `provider` 不是字符串（例如上游传入了 undefined），
   * 直接回退到本适配器所属产品的 id，避免
   * `undefined.toUpperCase is not a function` 在客户端炸开。
   *
   * 展示名同样来自产品配置：CodeBuddy 为 'CodeBuddy (腾讯)'，
   * WorkBuddy 为 'WorkBuddy'。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 模型列表：优先使用 /v3/config 动态拉取的远端列表，否则回退静态默认。
   * 动态拉取失败时静默回退（与 Rust fetch_models 的 Vec::new() 语义一致）。
   */
  /**
   * 懒加载远端模型目录（仅拉取一次）。listModels 与 resolveModel 共用：
   * resolveModel 可能先于 listModels 被调用（如直接进入会话），此时同样
   * 触发一次远端拉取，保证 /v3/config 的 maxInputTokens 能生效。
   */
  /**
   * 按产品的像素预算派生一张图片的**请求版本**。
   *
   * 判据与回退都在共享的 `projectRequestImage` 里（raccoon 用的是同一份 ——
   * 两个适配器各写一遍正是本仓库反复出缺陷的形态）。返回 `undefined`
   * 表示本次发原图，四种正常情形见该函数的注释。
   *
   * ⚠️ 预算取 `product.imagePixelBudget`，未配置时用
   * `DEFAULT_IMAGE_PIXEL_BUDGET`（640,000 px ≈ 1,037 视觉 token）。
   */
  private async projectRequestImage(
    ref: unknown,
  ): Promise<{ data: Uint8Array; mediaType: string } | undefined> {
    return projectRequestImage(ref, {
      readImageRequest: this.options.readImageRequest,
      pixelBudget: this.product.imagePixelBudget,
    })
  }

  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    if (this.remoteModels !== undefined || fetchRemote === undefined) return
    // 闸门：并发去重 + 失败/空结果冷却（详见 src/remote-catalog-gate.ts 的
    // 实测依据）。Buddy 的目录端点超时上限 60s，失败不冷却会让首屏在
    // 「每个模型重试一次」的放大下长时间空转。
    await this.catalogGate.run(async () => {
      const models = await fetchRemote()
      if (models.length === 0) return false
      // /v3/config data.models[] 是权威来源（对齐 Rust TUI buddy_context_limits
      // 注入逻辑）：远端下发的上下文窗口优先于静态 fallback 表；
      // 能力字段（supportsImages / reasoning.supportedEfforts）同理。
      const reconciled = this.reconcileWithFallback(models)
      this.remoteModels = reconciled
      this.remoteMeta = new Map(reconciled.map((model) => [model.id, model]))
      this.remoteContextWindows = new Map(
        reconciled
          .filter((model) => model.contextWindow !== undefined)
          .map((model) => [model.id, model.contextWindow as number]),
      )
      return true
    })
  }

  /**
   * 用产品兜底表校正远端结果。
   *
   * 为什么需要校正：服务端按**认证上下文**决定返回哪些模型，插件的 CLI
   * token 拿到的集合可能是残缺甚至错的 —— 实测 WorkBuddy 国际版的 CLI token
   * 只拿到 13 个内部别名（含实际不可用的 `o4-mini`），而 IDE 用的是 20 个
   * （含全部 GPT 系列）。此时若直接采信远端，模型选择器会缺掉用户真正要用的模型。
   *
   * 有产品兜底表时以它为准：
   * - 只保留兜底表里声明的 id（远端多出来的别名/内部模型被丢弃）；
   * - 兜底表声明但远端缺失的模型补进来（用兜底表的元数据）；
   * - ⚠️ **例外：被 agent 引用的模型即使不在兜底表也保留**（见下）。
   *
   * ⚠️ **为什么需要那个例外**：两个端点下发的 id 集合**不同**，而兜底表是
   * 编译期快照、只覆盖其中一套。实测（2026-09-21）`hy4-preview-f`
   * —— 新用户限时免费变体 —— **只由 `/v3/config` 下发**，且被
   * `craft`/`ask`/`plan` 三个 agent 引用（即服务端声明「对话里可选」），
   * 但**不在兜底表**里。白名单重建会把它丢掉，于是用户看不到那个免费变体，
   * 而 IDE 里能看到（用户报障「hy4 preview 现在 ide 是免费我们还是 0.29」）。
   *
   * 判据用 `agentReferenced`（服务端自己的「可选」信号）而非猜测 id 后缀 ——
   * 后缀规则不统一（`-f` / `-x` / `-sg` / `-ioa` 含义各异），猜错会放进
   * 不可用的模型。未标记的内部别名（如 `default`）不会被误留。
   */
  private reconcileWithFallback(models: readonly BuddyRemoteModel[]): BuddyRemoteModel[] {
    const fallback = this.product.fallbackModels
    if (fallback === undefined || fallback.length === 0) return [...models]
    const remoteById = new Map(models.map((model) => [model.id, model]))
    const reconciled = fallback.map((entry) => {
      const remote = remoteById.get(entry.id)
      // 远端元数据优先（更权威），缺失的字段用兜底表补齐
      return {
        id: entry.id,
        name: remote?.name ?? entry.name,
        ...entry.contextWindow !== undefined || remote?.contextWindow !== undefined
          ? { contextWindow: remote?.contextWindow ?? entry.contextWindow }
          : {},
        // 输出上限同样「远端优先、兜底补位」：远端不下发时兜底表给保守值，
        // 两边都没有则留 undefined（不编造，见 resolveModel 的说明）。
        ...entry.maxOutputTokens !== undefined || remote?.maxOutputTokens !== undefined
          ? { maxOutputTokens: remote?.maxOutputTokens ?? entry.maxOutputTokens }
          : {},
        ...entry.supportsImages !== undefined || remote?.supportsImages !== undefined
          ? { supportsImages: remote?.supportsImages ?? entry.supportsImages }
          : {},
        ...entry.reasoningEfforts !== undefined || remote?.reasoningEfforts !== undefined
          ? { reasoningEfforts: [...(remote?.reasoningEfforts ?? entry.reasoningEfforts ?? [])] }
          : {},
        ...entry.defaultReasoningEffort !== undefined || remote?.defaultReasoningEffort !== undefined
          ? { defaultReasoningEffort: remote?.defaultReasoningEffort ?? entry.defaultReasoningEffort }
          : {},
        // 计费倍率只可能来自远端（兜底表是编译期快照，价格会变，不写死）。
        // 注意本函数是**白名单式重建**：不在这里显式搬运的字段会被静默丢弃，
        // 新增远端字段时必须同步加一行，否则 listModels 看不到它。
        ...remote?.creditsRate !== undefined ? { creditsRate: remote.creditsRate } : {},
        ...remote?.discountedCreditsRate !== undefined
          ? { discountedCreditsRate: remote.discountedCreditsRate }
          : {},
        ...remote?.promotionNote !== undefined ? { promotionNote: remote.promotionNote } : {},
        // 原始促销记录：用于 listModels / isFreeModel 按当前时刻实时重算倍率
        // 与状态（避免 config 拉取时刻的判定被冻结，见 promotionView）。
        ...remote?.promotion !== undefined ? { promotion: remote.promotion } : {},
      }
    })
    // ⚠️ 追加「被 agent 引用但不在兜底表」的模型（见本方法注释的例外说明）。
    //
    // 放在**末尾**：兜底表里的模型保持原有顺序与权威性，补充的变体排在后面，
    // 不打乱用户已熟悉的列表顺序。
    const known = new Set(reconciled.map((model) => model.id))
    for (const model of models) {
      if (model.agentReferenced !== true || known.has(model.id)) continue
      known.add(model.id)
      reconciled.push({ ...model })
    }
    return reconciled
  }

  /**
   * 远端能力字段被实测证伪、需要强制覆盖为「支持图片」的模型。
   *
   * 为什么需要它：上游两个模型端点对同一模型的能力声明会互相矛盾。
   * 实测 `glm-5.1`（2026-09）：
   * - scoped 端点 `/console/enterprises/personal/models` → `supportsImages: false`
   * - `/v3/config` → `supportsImages: true`
   * - 真实请求（纯红图 + 问颜色）→ 答出「红色」，**确实能看到图片**
   *
   * 由于 `fetchModels` 优先采用 scoped 端点，若不覆盖，`glm-5.1` 会被判成
   * 纯文本，用户贴图时直接吃 host 的 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝
   * （前端文案「当前模型不支持图片」），而图片根本到不了上游。
   *
   * 为什么用显式白名单而不是「兜底表 true 优先」这类通用规则：通用规则会让
   * 兜底表永久压过远端，一旦某模型真的下线或能力变更，用户会被放行后被上游
   * 400 拒绝 —— 错误更晚、更难懂。白名单只覆盖已实测确认的个案，新增条目
   * 必须先有真实请求证据。
   */
  private static readonly IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = new Set([
    // scoped 端点误报 false，实测能看图。
    'glm-5.1',
  ])

  /**
   * 模型接受的输入模态：远端 supportsImages 优先，静态表兜底；
   * {@link IMAGE_CAPABILITY_OVERRIDES} 中的模型强制为支持图片。
   */
  private inputModalitiesFor(model: string): readonly ('text' | 'image')[] {
    const supportsImages = BuddyAdapter.IMAGE_CAPABILITY_OVERRIDES.has(model)
      || (this.remoteMeta.get(model)?.supportsImages
        ?? this.productFallbackMeta.get(model)?.supportsImages
        ?? IMAGE_MODELS.has(model))
    return supportsImages ? ['text', 'image'] : ['text']
  }

  /** 模型可选的思考等级：远端 supportedEfforts 优先，产品兜底表次之，通用静态表最后。 */
  private effortsFor(model: string): readonly string[] {
    return this.remoteMeta.get(model)?.reasoningEfforts
      ?? this.productFallbackMeta.get(model)?.reasoningEfforts
      ?? REASONING_EFFORTS.get(model)
      ?? []
  }

  /**
   * 模型声明的默认思考等级（远端 `reasoning.defaultEffort` 优先，产品兜底表次之）。
   *
   * 用途：composer 未选档位时补 `reasoning_effort`（deepseek 系不带档位 = 不思考）。
   * 若声明值不在该模型的支持档内（远端数据不一致）则视为未声明，由调用方回退。
   */
  private defaultEffortFor(model: string): string | undefined {
    const declared = this.remoteMeta.get(model)?.defaultReasoningEffort
      ?? this.productFallbackMeta.get(model)?.defaultReasoningEffort
    return declared !== undefined && this.effortsFor(model).includes(declared) ? declared : undefined
  }

  /**
   * 产品级兜底模型目录（`product.fallbackModels`）。
   *
   * 用于远端不可用或远端未覆盖到该模型时。与 `remoteMeta` 分开存放，
   * 使远端一旦可用就自动优先，而产品兜底只在缺失时补位。
   */
  private get productFallbackMeta(): ReadonlyMap<string, BuddyFallbackModel> {
    return this.productFallbackIndex
  }

  /**
   * 完整模型目录（**不应用用户黑名单**），含最终展示名（倍率 + 同名消歧）。
   *
   * 设置页（Channel Pack「显示列表」）必须把**被关闭的**模型也渲染出来，否则用户
   * 无法重新打开；而 `listModels` 会按黑名单过滤掉它们，RPC 层只能凭黑名单的
   * key（裸 id）补回 —— 那条路径拿不到展示名，只能退化成裸 id，**倍率随之丢失**
   * （用户报障：「关闭的就没有显示倍率」）。
   *
   * ⚠️ 同名消歧必须基于**未过滤**的全量集合：`displayNameFor(model, source)`
   * 而非 `listed`。用过滤后的集合会让「关掉其中一个同名模型」改变另一个的
   * 变体标记，名字随开关跳变。
   */
  listAllModels(): readonly { id: string; name: string; promo?: PromotionBadge }[] {
    const source = this.remoteModels ?? this.staticFallbackModels()
    // ⚠️ 促销徽标走**独立字段** `promo`（不再是 `description`）：设置页的行由
    // `model.list` 拼出，那里会把这个字段原样搬给客户端。`description` 是宿主与
    // 各适配器共用的通用字段（Cline / lobsterai 用它下发模型介绍），拿它当促销
    // 判据会把宣传语画成促销胶囊（用户报障「其他供应商出现奇怪的标签」）。
    // `promotionView` 是**展示时实时**重算的（见其注释），故这里不会把夜间
    // 判定冻结进目录。
    return source.map((model) => {
      const badge = promotionView(model).badge
      return {
        id: model.id,
        name: displayNameFor(model, source),
        ...(badge === undefined ? {} : { promo: badge }),
      }
    })
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
    // 不必拉。返回空数组 → DSH 的 `buildModelCatalog` 把整个 provider 分组隐藏。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []
    await this.ensureRemoteModels()
    const source = this.remoteModels ?? this.staticFallbackModels()
    // 用户在 Channel Pack 关闭的模型（黑名单制：不在表里即默认打开）。
    // 按本适配器的产品 id 取表，CodeBuddy 与 WorkBuddy 的开关互不影响。
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? source
      : source.filter((model) => !disabled.has(model.id))
    return listed.map((model) => {
      const view = promotionView(model)
      return {
        provider: this.product.id,
        id: model.id,
        name: displayNameFor(model, listed),
        // `description` 仍下发：DSH 的 `/model` 弹窗副行读的就是它，这是**给人
        // 读的那句话**，与结构化徽标（`promo`）同源不同用，两者都要有。
        ...(view.note !== undefined && view.note.length > 0 ? { description: view.note } : {}),
        // 结构化促销（独立字段）：设置页据此画胶囊，不解析字符串。
        ...(view.badge === undefined ? {} : { promo: view.badge }),
        inputModalities: this.inputModalitiesFor(model.id),
      }
    })
  }

  /**
   * 静态兜底模型目录：优先用产品自带的 `fallbackModels`，否则用通用默认表。
   *
   * 产品兜底表存在的原因：模型池由服务端按认证上下文下发，插件的 CLI
   * token 未必能取到完整集合（实测 WorkBuddy 国际版经 CLI token 只能拿到
   * 13 个别名，拿不到 GPT 系列）。产品兜底表提供该产品权威的完整清单。
   */
  private staticFallbackModels(): readonly { id: string; name: string }[] {
    const productModels = this.product.fallbackModels
    if (productModels !== undefined && productModels.length > 0) {
      return productModels.map((model) => ({ id: model.id, name: model.name }))
    }
    return DEFAULT_MODELS.map((id) => ({ id, name: id }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    // 三级查找：远端 maxInputTokens → 产品兜底表 → 通用静态表
    // （对齐 Rust context_limit_for_model 的两级查找，多一层产品级）。
    const contextWindow = this.remoteContextWindows.get(model)
      ?? this.productFallbackContextWindows.get(model)
      ?? CONTEXT_WINDOWS.get(model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: this.remoteMeta.get(model)?.name ?? this.productFallbackIndex.get(model)?.name ?? model,
      inputModalities: this.inputModalitiesFor(model),
    }
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    // 单次输出上限：远端 maxOutputTokens（实测 deepseek-v4.1-flash = 128000）
    // 优先，产品兜底表次之。
    //
    // **为什么必须声明**：DSH 在 `resolveCallWithInfo` 里只在调用方未显式给值时
    // 用 `defaultMaxTokens` 兜底，适配器不声明就等于把这个值永久交给网关默认
    // （实测网关默认仅 32000 —— 见远端 `auto` 模型的 maxOutputTokens）。结果是
    // 大文件写入 / 长回答在 32000 处被截断成 finish_reason:'length'，UI 报
    // 「已达到输出 token 上限」。这与 codearts 适配器显式发 max_tokens 的做法
    // （llm-adapter.ts）本应一致。
    //
    // 远端与兜底表都没有该模型的值时**保持 undefined**，交给网关默认值：
    // 编造一个偏大的值会让服务端 400 拒绝（参考 codearts 131072 被拒的实测），
    // 偏小则无谓截断用户输出。
    const maxOutputTokens = positiveMaxTokens(
      this.remoteMeta.get(model)?.maxOutputTokens ?? this.productFallbackMeta.get(model)?.maxOutputTokens,
    )
    if (maxOutputTokens !== undefined) resolved.defaultMaxTokens = maxOutputTokens
    // 思考等级：这是"思考强度"选择器出现在模型选择里的唯一入口——composer
    // 读取 resolveModel().reasoning。无等级可选的模型不声明该字段，UI 显示
    // "当前模型未提供推理等级"。
    const efforts = this.effortsFor(model)
    if (efforts.length > 0) {
      const remoteDefault = this.remoteMeta.get(model)?.defaultReasoningEffort
        ?? this.productFallbackIndex.get(model)?.defaultReasoningEffort
      resolved.reasoning = {
        efforts: efforts.map((id) => ({
          id: ReasoningEffortId(id),
          name: EFFORT_NAMES[id] ?? id,
        })),
        ...remoteDefault !== undefined && efforts.includes(remoteDefault)
          ? { defaultEffort: ReasoningEffortId(remoteDefault) }
          : {},
      }
    }
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 LlmRuntime.prepareCall() 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * （0.1.0-rc.6）的 LlmAdapter 基类尚未提供该方法，缺少时会在每轮请求
   * 开始时抛 `registration.adapter.prepareCall is not a function`。这里把
   * 模型解析与分发绑定到同一个适配器实例（与 CodeArtsAdapter 同款 shim）。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 1. 获取凭据（过期则先静默续期）
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isCredentialExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError(
        // ⚠️ 文案里**不能**再提 `/buddy-login` —— 该斜杠命令已随单凭据模式一并移除
        // （AGENTS.md「不注册任何斜杠命令」），入口在 Channel Pack 设置页。
        `${this.product.id}: no usable credential; log in from the Channel Pack panel first`,
        'MISSING_CREDENTIAL',
      )
    }

    // Track current account for rate limit switching
    let currentAccountId = ''
    if (this.options.accountPool && credential) {
      try {
        // provider 实参必须是本适配器所属产品的 id（buddy / workbuddy）：
        // AccountPool 先按 entry.provider !== provider 过滤账号，写死 'buddy'
        // 时 WorkBuddy 账号（provider='workbuddy'）永远匹配不到，限流时间
        // 无法归属账号，UI 也永不显示限流标记。
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          this.product.id,
          credential.access_token,
        )
        if (currentAccountId === '') {
          // 账号池里没有匹配该凭据的账号（例如用的是回退的单凭据），
          // 此时限流无法归属到具体账号，也就无法在 UI 上显示标记。
          console.warn(`[${this.product.id}] 当前凭据未匹配到账号池条目，限流记录将被跳过`)
        }
        // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
        if (currentAccountId !== '') reportLedgerAccount(this.product.id, currentAccountId)
      } catch (error) {
        console.warn(`[${this.product.id}] 账号匹配失败（不影响本次请求）:`, error)
      }
    }

    // 能力判定（图片 / 思考强度）必须有远端目录在手：两者都以 /v3/config
    // 下发值为权威，而该拉取是懒加载的。缺了这一步，远端显式 false 会被
    // 静态兜底表覆盖，合法的思考等级也会被误判为不支持而丢弃。
    await this.ensureRemoteModels()

    // 2. 序列化消息
    // 图片：读原始字节并以内联 data URL 发出——这是 CodeBuddy 唯一接受的
    // 图片形态（{type:'image'} 会被服务端 400 拒绝）。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(options.model).includes('image')) {
        throw new LlmError(`${this.product.id}: model "${options.model}" does not accept image input.`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(`${this.product.id}: image input requires the attachment service.`, 'UNSUPPORTED_CONTENT')
      }
      imageUrls = new Map()
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**（按像素预算缩放），拿到就用它；拿不到才发原图。
        // 这一步是本 issue 的正题：原图直发让 36 张截图顶穿网关的图片 token
        // 上限（≈100,000），此后每轮都失败且压缩救不回来。
        const projected = await this.projectRequestImage(ref)
        if (projected !== undefined) {
          imageUrls.set(id, `data:${projected.mediaType};base64,${Buffer.from(projected.data).toString('base64')}`)
          continue
        }
        let image: { data: Uint8Array; mediaType: string } | undefined
        try {
          image = await this.options.readImage(ref)
        } catch (error) {
          // 读取抛错必须冒泡成明确的 LlmError：早先这里会把异常吞掉，
          // 最终表现为「图片凭空消失、模型答非所问」，排查成本极高。
          throw new LlmError(
            `${this.product.id}: 读取图片附件失败（${id}）：${errorMessage(error)}`,
            'UNSUPPORTED_CONTENT',
            { cause: error as Error },
          )
        }
        if (image === undefined) {
          // 契约要求：读不到字节时报错，绝不静默丢弃整张图。
          // 返回 undefined 的典型成因是附件服务未就绪或对象已被清理；
          // 若此处 continue，线上请求会退化成纯文本，用户只看到模型
          // 「看不到图」而没有任何错误提示。
          throw new LlmError(
            `${this.product.id}: 图片附件读取不到内容（${id}）；附件服务可能未就绪，或该对象已不存在。`,
            'UNSUPPORTED_CONTENT',
          )
        }
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }
    const messages = serializeMessages(options.messages, imageUrls)
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))

    // 3. 构造请求体
    const bodyObj: Record<string, unknown> = {
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回缓存命中，
      // 缺少该字段时命中恒为 0（与 codearts 同款修复，见 llm-adapter.ts）。
      // 实证（2026 实测 deepseek-v4-flash，同一段 8k token 前缀）：
      //   不带该字段 → prompt_tokens=8027, prompt_cache_hit_tokens=0,    credit=0.34
      //   带该字段   → prompt_tokens=8027, prompt_cache_hit_tokens=7808, credit=0.02
      // 仅此一个字段的差异，费用差约 17 倍。同 key 重复请求稳定命中同一前缀。
      prompt_cache_key: this.sessionId,
    }
    if (tools !== undefined && tools.length > 0) bodyObj.tools = tools
    if (options.temperature !== undefined) bodyObj.temperature = options.temperature
    if (options.stop !== undefined && options.stop.length > 0) bodyObj.stop = options.stop
    // 单次请求输出上限。此前**完全没有**下发该字段，导致上限由网关默认值决定
    // （实测仅 32000），大文件写入会在中途被截断成 `finish_reason:'length'`，
    // UI 报「已达到输出 token 上限」，且本地无从调整。
    //
    // 取值优先级：调用方显式给的 options.maxTokens（DSH 会先注入 resolveModel
    // 声明的 defaultMaxTokens）→ 远端 maxOutputTokens → 产品兜底表。
    // 三者皆无则不发该字段，保持网关默认（不编造，理由见 resolveModel）。
    const maxTokens = positiveMaxTokens(
      options.maxTokens
        ?? this.remoteMeta.get(options.model)?.maxOutputTokens
        ?? this.productFallbackMeta.get(options.model)?.maxOutputTokens,
    )
    if (maxTokens !== undefined) bodyObj.max_tokens = maxTokens
    // DeepSeek 思维链开关（逆向官方 codebuddy.js，对齐 workbuddy2api-panel
    // thinking.go）。**实测关键结论（2026-09，直连三站点对照）**：
    //   - 裸请求（无 reasoning_effort、无 thinking）→ reasoning_content 恒为 0；
    //   - 仅带 reasoning_effort:high → 返回思考（148~250 字符）；
    //   - 仅带 thinking:{type:'enabled'} → 仍为 0（该字段单独无效）；
    //   - 两者都带 → 返回思考。
    // 即 **reasoning_effort 是真正的开关**，thinking 字段单独不生效（保留它是
    // 为对齐官方客户端出站形态，并覆盖未来后端按它判定的情形）。
    // 三站点（workbuddy 国际/中国 UA、codebuddy）行为一致 → endpoint/UA 无关。
    const deepseek = isDeepSeekModel(options.model)
    if (deepseek) {
      bodyObj.thinking = { type: 'enabled' }
    }
    // 思考强度：composer 选中的等级透传为 `reasoning_effort`（实测
    // low/high/max 会显著改变返回的 reasoning_content 长度，服务端真实生效）。
    // 只在该模型确实支持该等级时才发，否则服务端会因非法参数 400。
    const efforts = this.effortsFor(options.model)
    if (options.reasoningEffort !== undefined && efforts.includes(options.reasoningEffort)) {
      bodyObj.reasoning_effort = options.reasoningEffort
    } else if (deepseek && efforts.length > 0) {
      // composer 未选档位（历史请求可能 `adapterDefaults: undefined`）或所选
      // 档位不被支持时，必须补一个档位——否则请求体里只剩 thinking，上游仍按
      // 不思考应答（实测）。回退顺序：声明默认档 → high（对齐官方客户端
      // REASONING_SUPPLEMENTS.defaultEffort 与 thinking.go 的兜底）→ 最低支持档
      // （绝不臆造模型未声明的档位，否则服务端 400）。
      bodyObj.reasoning_effort = this.defaultEffortFor(options.model)
        ?? (efforts.includes('high') ? 'high' : efforts[0])
    }
    const body = JSON.stringify(bodyObj)

    // 4. 发送请求（401/403 时刷新当前账号一次，仍失败则换号重试）
    let response = await this.send(credential, body, options)
    if (!response.ok && (response.status === 401 || response.status === 403)) {
      // ⚠️ 腾讯侧的安全策略拦截（`code:11140`）**也回 HTTP 403**。实测确认它是
      // **账号级**拦截（同一请求体在池里 7 个账号上「2 通 4 拦 1 限流」），因此
      // 处理方式与认证失败一致：**刷新 → 换号 → 全部试完才报错**。
      //
      // 早期实现把它当成「内容问题、与账号无关」而**拒绝换号**并直接抛
      // `INVALID_REQUEST`，后果（2026-09-27 用户实测）：池里有可用账号也永远
      // 用不上，每次都拿最先选中的坏账号去撞，且提示「请调整内容后重试」——
      // 把用户引向改内容，而真正该做的是换号／停用坏账号。
      //
      // 判据必须在认证分支内联判定而非提前 return：坏账号可能排在任何位置，
      // 必须让它和 401/403 一样进入下面的换号循环。
      const rejectedBody = await response.clone().text().catch(() => '')
      const contentRejected = isContentRejection(rejectedBody)
      if (contentRejected) {
        // 记诊断日志（便于在插件日志里区分「换号」与「被策略拦下」），**不中断**换号，
        // 同时把这个账号在该模型上冷却 —— 否则它下次仍排第一，每轮都要重撞一遍。
        console.warn(
          `[${this.product.id}] 账号 ${currentAccountId || '(current)'} 被安全策略拦截`
          + `（HTTP ${response.status}，code 11140），继续换号：${errorDetail(rejectedBody).slice(0, 200)}`,
        )
        await markPolicyBlockedAccount(
          this.options.accountPool, this.product.id, currentAccountId, options.model,
        )
      }
      // ⚠️ 真实缺陷（2026-09-26，用户报障「账号池里明明有 3~4 个账号没被限流，
      // 却报『未配置凭据，请先登录』」）。早期实现在这里刷新一次就 `return`：
      //
      // ① **不换号** —— 池首账号被服务端拒绝（401/403）时，池里其余可用账号
      //    一个都用不上。轮换逻辑（下一段）只覆盖 `isRateLimited` 的 429 类，
      //    而 401/403 在这里就返回了。
      // ② **刷新失败直接冒泡** —— 刷新接线一旦指向单凭据 ref（见 `src/index.ts`
      //    的 createPoolRefresh 注释），抛出的「未配置凭据，请先登录」与真实原因
      //    毫无关系：账号池凭据完好，只是刷错了 ref。
      // ③ **下一轮必然复现** —— 刷新抛错前没有写回任何凭据，池首账号不变，
      //    于是「中断后继续 goal」永远撞同一条死路（自锁）。
      //
      // 现在的次序：刷新当前账号 → 重试 → 仍认证失败则按池顺序换号，
      // 全部换完才报 AUTH。
      const authStatus = response.status
      // 已尝试过的账号：换号时必须排除，否则会拿回刚失败的那个原地打转。
      const triedAuth = new Set<string>()
      if (currentAccountId !== '') triedAuth.add(currentAccountId)
      let refreshedCredential: BuddyCredential | undefined
      try {
        await this.options.refresh()
        refreshedCredential = await this.options.resolveCredential(options.model)
      } catch (error) {
        // 刷新失败**不致命**：换号仍有机会，单个账号故障不该让整轮陪葬。
        console.warn(`[${this.product.id}] 刷新当前账号凭据失败，改用换号重试：${String(error)}`)
      }
      if (refreshedCredential !== undefined && refreshedCredential.access_token.length > 0) {
        credential = refreshedCredential
        response = await this.send(credential, body, options)
        if (response.ok) {
          yield* this.consumeSse(response, options, currentAccountId)
          return
        }
      }
      let rotated = false
      /** 换号过程中是否撞到过安全策略拦截（用于最后的报错口径）。 */
      let sawContentRejection = contentRejected
      /**
       * **最后一次**撞到的拦截与其响应体：报错时的 HTTP 状态与文案都取它。
       *
       * 早先这里直接用 `authStatus`（**首发**的状态码）—— 而首发是 401、
       * 换号后才吃到 11140/403 的组合下，报出来的「HTTP 401」与实际被拦的
       * 那一次对不上，排查时会把人引向「token 过期」。
       */
      let rejectionStatus = contentRejected ? authStatus : 0
      let rejectionBody = contentRejected ? rejectedBody : ''
      if ((response.status === 401 || response.status === 403) && this.options.accountPool !== undefined) {
        for (;;) {
          // modelId 参与过滤：正在限流期的账号不会被选中（与限流换号同语义）。
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id, options.model, triedAuth,
          )
          if (!next || triedAuth.has(next.entry.id)) break
          triedAuth.add(next.entry.id)
          rotated = true
          credential = next.credential as BuddyCredential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId)
            return
          }
          // ⚠️ 安全策略拦截（11140）同样继续换号 —— 它按账号生效，换号是唯一出路。
          // 必须**先于**「仅 401/403 才继续」的判据检查，否则会被当成普通 403
          // 之外的错误而 break，退回到「只试一个账号」的老问题。
          const rotatedBody = await response.clone().text().catch(() => '')
          if (isContentRejection(rotatedBody)) {
            sawContentRejection = true
            rejectionStatus = response.status
            rejectionBody = rotatedBody
            // 刚换到就是这个账号被拦：同样要冷却，否则下一轮它还是第一候选。
            await markPolicyBlockedAccount(
              this.options.accountPool, this.product.id, currentAccountId, options.model,
            )
          }
          // 只有认证类失败（含安全策略拦截）才继续换号；
          // 429/5xx/400 交给下面的既有分类逻辑。
          if (response.status !== 401 && response.status !== 403) break
        }
      }
      // 刷新既没产出凭据、也没换到别的账号：保留原有的可诊断报错。
      if (refreshedCredential === undefined && !rotated) {
        // ⚠️ **必须先排除安全策略拦截**（补修，2026-09-28）：这条早退只看
        // 「续期失败 + 没换到号」，而**单账号池**恰恰必然满足它 —— 于是真实原因是
        // 11140（该账号被服务端策略拦下）时，报出来的却是
        // 「credential expired and refresh failed」+ `AUTH`，UI 只显示
        // 「API 密钥无效」，把用户引向重新登录（而实测 token 全部有效）。
        // 与 !15 / !16 已统一的口径一致：拦截就是拦截，别冒充认证失败。
        if (sawContentRejection) {
          throw contentRejectionError(
            this.product.id,
            rejectionStatus === 0 ? authStatus : rejectionStatus,
            rejectionBody.length === 0 ? rejectedBody : rejectionBody,
            true,
          )
        }
        throw new LlmError(`${this.product.id}: credential expired and refresh failed`, 'AUTH', { status: authStatus })
      }
      if (response.status === 401 || response.status === 403) {
        // ⚠️ **必须带上响应体**（真实缺陷，我自己引入的回归，2026-09-27）：
        // 换号耗尽后若只报「所有账号均认证失败」，就把服务端真正说的原因丢掉了 ——
        // 而 403 在腾讯侧**并不等于认证失败**（额度耗尽 / 模型无权限 / 安全策略
        // 都可能回 403）。实测（2026-09-27 10:26）workbuddy 连续三轮报
        // 「所有账号均认证失败（HTTP 403）」，而随后逐账号复验发现 5 个 token
        // 全部有效（请求能进业务层、只因缺 system 提示回 400）—— 即那 403 并非
        // 登录问题。没有响应体就完全无从判断，只能靠猜。
        const detail = await response.text().catch(() => '')
        // 换号途中撞上的安全策略拦截：报专门的提示（指向账号，而非内容）。
        if (sawContentRejection || isContentRejection(detail)) {
          // 状态与响应体都取**最后一次拦截**（没有就退回首发的那一份 `detail`），
          // 免得「首发 401 + 途中 403/11140」报出一个对不上的 HTTP 401。
          throw contentRejectionError(
            this.product.id,
            rejectionStatus === 0 ? authStatus : rejectionStatus,
            rejectionBody.length === 0 ? detail : rejectionBody,
            true,
          )
        }
        throw new LlmError(
          `${this.product.id}: 所有账号均被拒绝`
          + `（HTTP ${authStatus}${authStatus === 401 ? '，请在 Channel Pack 重新登录' : ''}）：${errorDetail(detail)}`,
          httpErrorCode(authStatus, detail),
          { status: authStatus },
        )
      }
      // 换号途中遇到非认证类错误 → 落到下面的限流换号 / 错误码归类逻辑。
    }
    if (!response.ok) {
      let errorText = await response.text().catch(() => '')
      // ⚠️⚠️ **模型饱和必须**先于**限流分支判定**（真实缺陷，2026-10-05）
      //
      // `14003 model busy` **也是 HTTP 429**，而 `isRateLimited` 对 429
      // **无条件返回 true** —— 若先走下面的限流分支，就会给每个账号写一条
      // **1 小时**限流标记（报文里没有「将在…重置」，故取 `RATE_LIMIT_FALLBACK_MS`
      // 兜底），把**整池**锁死。
      //
      // 用户报障正是这个：第一次用 `buddy/space-bunny` 就报
      // 「模型 space-bunny 所有账号均受限」。
      //
      // 实测四条证据（`scripts/probe-buddy-*.mjs`，2026-10-05）：
      // | 观测 | 结果 |
      // |---|---|
      // | 4 个**不同腾讯 uid** 的账号 | 20 秒内**全部**被写 `space-bunny` 标记 |
      // | 标记解禁时刻 | 全 = 「写入 + 整 1 小时」= **兜底值**，非服务端给的 |
      // | 4 MB 输入 | 稳定逼出 `429/14003`，报文自称「模型繁忙，请换模型」 |
      // | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s（上游**时变**背压） |
      //
      // 4 个互不相干的账号同时中招，账号级限流**无法解释** ⇒ 只能是模型级。
      // 服务端报文自己就写着 `actions:["SWITCH_MODEL",…]`（**没有**换号选项）。
      //
      // ⚠️ 故正确动作是：**留在本账号退避重试**，绝不换号、绝不写标记 ——
      // 与 zcode `3009` 并发限流的处置同型（那边注释：换账号也一样撞，
      // 白白标记掉一个可用账号）。
      if (isModelSaturationError(response.status, errorText)) {
        for (let attempt = 0; attempt < BUDDY_SATURATION_MAX_RETRIES; attempt += 1) {
          const waitMs = buddySaturationDelayMs(attempt)
          console.warn(
            `[${this.product.id}] 模型 ${options.model} 请求量饱和（上游 14003 model busy），`
            + `${waitMs}ms 后**在本账号**重试（第 ${attempt + 1}/${BUDDY_SATURATION_MAX_RETRIES} 次）`
            + `—— 不换号、不写限流标记：饱和是模型级，池里其它账号会撞同一堵墙`,
          )
          await sleepMs(waitMs)
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId)
            return
          }
          errorText = await response.text().catch(() => '')
          // 重试后若已**不是**饱和（如变成额度限流 / 认证失败），
          // 立刻停手交给下面的既有分类逻辑 —— 那些语义各有各的正确动作。
          if (!isModelSaturationError(response.status, errorText)) break
        }
        // 退避重试用尽仍是饱和：如实报「模型繁忙」并给**唯一有效**的动作
        // （换模型），而不是伪造成「账号额度受限」（那会让用户白等 1 小时）。
        if (isModelSaturationError(response.status, errorText)) {
          throw new LlmError(
            `${this.product.id}: 模型 ${options.model} 当前请求量饱和`
            + `（上游 14003 model busy，报文原文：「模型繁忙，请换模型或稍后重试」），`
            + `已重试 ${BUDDY_SATURATION_MAX_RETRIES} 次仍未通过。`
            + `此为该**模型**整体繁忙，并非账号额度问题 —— 换账号无效，`
            + `请改用其它模型，或稍后重试（无需重新登录）。`,
            'RATE_LIMIT',
            { status: response.status },
          )
        }
      }
      // 限流处理：把当前账号在该模型上的重置时间记录下来，然后逐个尝试
      // 其余可用账号。每个失败账号都会被记录，只有真正试完全部候选才报
      // "所有账号均受限"——避免只试一个就下结论（那会让 UI 显示的限流
      // 状态与实际判定不一致）。
      // ⚠️ 必须把 `response.status` 一并传入：服务端可能返回**空体**的 429，
      // 而只按正文判定时对空体恒为 false → 整段换号逻辑被跳过，本可自愈的限流
      // 被直接抛给用户（表现为「池里明明还有可用账号，插件却报错且不换号」）。
      if (this.options.accountPool && isRateLimited(errorText, response.status)) {
        const tried = new Set<string>()
        if (currentAccountId) tried.add(currentAccountId)

        // ⚠️ 限流换号途中同样会撞上安全策略拦截（11140，HTTP 403）—— 它按账号
        // 生效、与限流无关，但**必须继续换号**而不是中断。
        //
        // 真实缺陷（用户报障 2026-09-28「本轮运行失败 · API 密钥无效」）：早期
        // 实现在这里遇到非限流错误就**直接抛**。而池里 7 个 workbuddy 账号中
        // 前 4 个恰是被 11140 拦截的坏账号、后 3 个可用，于是换号在第 1 个坏
        // 账号处就中断，后面 3 个可用账号**永远试不到**（实测复刻：中断于
        // #1，若不中断则 #4 即成功）。错误码取 `httpErrorCode(403)` = `AUTH`，
        // UI 把它渲染成「API 密钥无效」，把用户引向检查密钥 —— 而 7 个 token
        // 实测全部有效（2027-09 才过期），真实原因完全丢失。
        //
        // 这与认证路径（上面的 401/403 分支）必须保持同一语义：坏账号可能排在
        // 任何位置，安全策略拦截和认证失败一样只是「这个账号不可用」。
        let sawContentRejection = false
        let contentRejectionStatus = 0
        let contentRejectionBody = ''
        /**
         * 已经写过限流标记的账号：避免同一个账号被重复记账（换号途中可能取回它）。
         * 标记是「账号 × 模型」的快照，写两次没有意义，日志也会重复。
         */
        const rateLimitMarked = new Set<string>()

        for (;;) {
          // 先给**当前**账号记限流标记（UI 据「限额重置」徽章展示；它也是
          // 「重测 / 重置」两条人工解禁路径的唯一依据）。
          //
          // ⚠️ 判据从「解析出重置时间」改为 `isRateLimited(errorText, response.status)`：
          // 空体 429 根本没有 `msg` 可解析（`parseRateLimitError` 给兜底时长，
          // 不需要在这里区分），而**只要判为限流就必须留下标记** —— 否则用户
          // 既看不到限流徽章、也无法手动解禁。真实缺陷复现：空体 429 时旧写法
          // 连标记都不写（`recorded` 为空），而换号却发生了。
          //
          // ⚠️ `parseRateLimitError` 仍然优先：它能把**服务端声明的**真实重置
          // 时刻抠出来（有就绝不用兜底的 1 小时）。换号后 `errorText` 可能是
          // 11140 等非限流体 —— 那种情况下面①的分支会先 continue，走不到这里。
          if (currentAccountId !== '' && isRateLimited(errorText, response.status)
            && !rateLimitMarked.has(currentAccountId)) {
            rateLimitMarked.add(currentAccountId)
            const parsed = parseRateLimitError(errorText, options.model, response.status)
            await this.options.accountPool.updateModelRateLimit(
              currentAccountId,
              parsed?.modelId ?? options.model,
              parsed?.resetTimeMs ?? Date.now() + RATE_LIMIT_FALLBACK_MS,
            )
          }
          // 取下一个未尝试过的可用账号（同样按本产品 id 过滤，否则 WorkBuddy
          // 永远取不到候选账号，限流后无法自动切换）。
          //
          // 必须把 `tried` 传给池：见 `AccountPool.getAvailableAccount` 的说明 ——
          // 池按「重置时间最早到期」排序，刚失败的账号可能仍排第一，
          // 不排除就会拿回同一个、命中下面的 `tried.has` 而立即 break。
          const next = await this.options.accountPool.getAvailableAccount(
            this.product.id, options.model, tried,
          )
          if (!next || tried.has(next.entry.id)) break
          tried.add(next.entry.id)
          credential = next.credential as BuddyCredential
          currentAccountId = next.entry.id
          response = await this.send(credential, body, options)
          if (response.ok) {
            yield* this.consumeSse(response, options, currentAccountId)
            return
          }
          errorText = await response.text().catch(() => '')
          // ① 安全策略拦截（11140）：按账号生效，继续换号（与认证路径同语义）。
          //    判据必须**先于**下面的「非限流即抛」，否则会退回「只试一个账号」。
          if (isContentRejection(errorText)) {
            sawContentRejection = true
            contentRejectionStatus = response.status
            contentRejectionBody = errorText
            console.warn(
              `[${this.product.id}] 账号 ${currentAccountId || '(current)'} 被安全策略拦截`
              + `（HTTP ${response.status}，code 11140），继续换号：${errorDetail(errorText).slice(0, 200)}`,
            )
            // 与认证路径同一实现：被拦的账号在**该模型**上冷却一段时间。
            //
            // ⚠️ 这里**不能**用上面的 `updateModelRateLimit` 记账分支 —— 那个写的是
            // 服务端给的限流重置时刻；11140 报文里**没有**时间，`parseRateLimitError`
            // 会返回 `null`，走它的兜底等于把「策略拦截」冒充成「限流」。
            await markPolicyBlockedAccount(
              this.options.accountPool, this.product.id, currentAccountId, options.model,
            )
            continue
          }
          // ② 认证类失败：该账号凭据不可用，与路径 A 一致继续换号。
          if (response.status === 401 || response.status === 403) continue
          // ③ 其余非限流错误：请求本身有问题，换号无益，按原错误分类抛出。
          //    ⚠️ 同样必须传状态码：否则空体 429 会被当成「非限流」而在换号
          //    途中**中断**，池里其余可用账号一个都试不到。
          if (!isRateLimited(errorText, response.status)) {
            // 新账号失败但不是限流：按原错误分类抛出，不要再吞成"均受限"
            throw new LlmError(`${this.product.id}: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status })
          }
          // ④ 仍是限流 → 继续下一轮（重置时间已在上方记录）。
        }
        // 全部候选试完：若途中撞过安全策略拦截，报专门的提示（指向账号而非内容）。
        if (sawContentRejection) {
          throw contentRejectionError(
            this.product.id, contentRejectionStatus || 403, contentRejectionBody, true,
          )
        }
        throw new LlmError(`${this.product.id}: 模型 ${options.model} 所有账号均受限，请稍后再试`, 'QUOTA_EXCEEDED')
      }
      throw new LlmError(`${this.product.id}: ${errorDetail(errorText)}`, httpErrorCode(response.status, errorText), { status: response.status })
    }

    // 5. 消费 SSE 流
    yield* this.consumeSse(response, options, currentAccountId)
  }

  /** 发起一次 chat 请求；网络失败映射为可重试的 TRANSPORT 错误。 */
  private async send(
    credential: BuddyCredential,
    body: string,
    options: GenerateOptions,
  ): Promise<Response> {
    const headers = new Headers(attributionHeaders())
    headers.set('Authorization', `Bearer ${credential.access_token}`)
    headers.set('Accept', 'text/event-stream')
    headers.set('Content-Type', 'application/json')
    // ⚠️ 顺序与空值语义都不能改（真实缺陷，两个子问题都出在这一行）：
    // ① **以产品配置为准**，而不是优先用凭据里的 `credential.domain`。凭据的
    //    domain 是「登录时站点」的快照；产品改造后（早期 workbuddy 指向
    //    copilot.tencent.com，现为 www.workbuddy.ai）旧凭据里仍是过期值。本请求的
    //    baseURL 取自 `product.endpoint`，X-Domain 必须与之一致，否则身份标识与
    //    目的地址自相矛盾。`src/credits.ts` 的 `checkinHeaders` 早已按此理由实现
    //    （见其文档注释），此处原先与它相反 —— 同一账号的聊天与积分请求会声明
    //    **不同的** X-Domain，属两处实现漂移。
    // ② 必须用 `||` 而非 `??`：domain 经 `readStringField` 读取，字段缺失时返回
    //    **空串**（不是 undefined），`??` 对空串不生效，X-Domain 会以空值发出
    //    （已用单测复现：`''` 未回退到 `copilot.tencent.com`）。
    // 末位 `|| ''` 只为满足 Headers.set 的非空类型要求：产品与凭据都为空属配置
    // 错误，此时发出空值比编造一个域名更诚实。
    headers.set(HTTP_HEADER_DOMAIN, this.product.apiDomain || credential.domain || '')
    headers.set(HTTP_HEADER_PRODUCT_CODE, this.product.productCode)
    // 用量归属头族：后台「使用端」列按这组头归因，缺任一个都会显示为 `-`。
    // 注意 X-Product 是**归属名**（产品名），不是部署类型 —— 历史实现发成
    // `SaaS` 导致后台归因不到产品。
    headers.set('X-Agent-Purpose', 'conversation')
    headers.set('X-IDE-Name', this.product.attributionName)
    headers.set('X-IDE-Type', this.product.attributionName)
    headers.set('X-IDE-Version', this.product.clientVersion)
    headers.set(HTTP_HEADER_PRODUCT, this.product.attributionName)
    // User-Agent 按模型族分档：不同模型线归属不同客户端形态，后台据此分列。
    // 必须用 set 覆盖（attributionHeaders() 注入的框架 UA 键为小写，
    // 但 Headers 键大小写不敏感，set 能正常覆盖）。
    headers.set('User-Agent', resolveUserAgent(this.product, options.model))
    try {
      return await this.fetchImpl(`${this.product.endpoint}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (isTransportError(error)) {
        throw new LlmError(`${this.product.id}: transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
      }
      throw error
    }
  }

  /**
   * 消费 SSE 响应并产出 StreamChunk。
   *
   * CodeBuddy 返回标准 OpenAI SSE：`delta.content` 为正文、
   * `delta.reasoning_content` 为思考、`delta.tool_calls` 为工具调用。
   * 流式工具调用仅首个分片携带真实 id（chatcmpl-tool-xxx），后续参数分片
   * 只有 index——按 index 缓存 id 保证同一工具的所有分片 id 一致。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
    /**
     * 本次请求实际使用的账号 id（`''` 表示凭据没匹配到池条目）。
     *
     * 只用于流内安全策略拦截的冷却标记 —— 见 {@link isContentRejection}。
     */
    policyBlockedAccountId: string,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError(`${this.product.id}: empty model response body`, 'EMPTY_RESPONSE')

    const blocks: Array<{ index: number; kind: 'text' | 'reasoning'; text: string }> = []
    let nextIndex = 0
    /**
     * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
     * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
     *
     * 本路径正是用户实际报障的那条（`workbuddy/deepseek-v4.1-flash` 报
     * 「已达到输出 token 上限」）：`reasoning_tokens` 计入 `completion_tokens`，
     * 思考陷入病态重复就把 128000 额度烧光、正文零产出。
     */
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let loopDetected = false
    /**
     * **正文**死循环检测（**独立实例**）。本路径正是用户实际报障的那条
     * （`lilishop-go` 会话 / `workbuddy/hy4-preview-f`）：该模型把思考写进
     * `content` 通道，正文出现真循环（去重率 0.0412），而旧实现只在
     * reasoning 分支调 `observe` → 正文循环**完全看不见**。
     *
     * ⚠️ 必须与 `loopGuard` **分成两个实例**：判据看的是尾部 3000 字符窗口的
     * 行去重率，两条通道混进同一窗口会互相稀释，使守卫**双双失效**。
     *
     * ⚠️ 与思考守卫的**语义差异**：实测正文循环的 wire 顺序恒为
     * `text-chunks(循环) → tool-call-chunks → finish: tool-calls` —— 工具调用
     * 在循环正文**之后**到达且有效。故正文守卫**只截断文本**，
     * **绝不 `reader.cancel()`、绝不改 finish reason**，否则会把有效调用
     * 整块丢掉（比循环本身更糟）。
     */
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let proseLoopDetected = false
    // ⚠️ 此处**曾有** `proseHasThinkTag` 门禁变量，2026-09-27 **删除**。
    // 它逐帧匹配标签来决定收尾是否切分，而标签**必然跨帧**（上游可切成任意片段），
    // 实测二分帧时 7/11 种切法漏判 → 标签落盘泄漏。现改为收尾**无条件**调用
    // `splitThinkTaggedContent`（无标签时返回 undefined，普通响应逐字节不变）。
    /**
     * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
     * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
     *
     * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
     * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
     * 就不发任何 chunk。本路径正是用户实际报障的那条
     * （`workbuddy/deepseek-v4.1-flash` 偶发只输出一个空格当思考，
     * 实测 2233 次、`usage.reasoningTokens = 1`）。
     */
    const suppressor = createBlankReasoningSuppressor()
    const toolCalls = new Map<number, {
      index: number
      text: string
      callId?: string
      name?: string
      /** 是否已发过 `block-start`（名字可用的那一刻才发，见下方 tool_calls 分支）。 */
      announced: boolean
    }>()
    const toolOrder: number[] = []
    // tool_call index → 后端签发的真实 id。缺失时回退 call_{index}，
    // 保证 Start/Delta 使用同一 id。
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // 首 token 与 chunk 间超时分阶段使用：第一次读取用 firstTokenTimeout，
    // 收到首 chunk 后切换为 chunkTimeout 并在每次成功读取后重置。没有这层
    // 保护时，半开的 SSE 连接会让 read() 永久挂起，会话卡死在"运行中"。
    let firstTokenReceived = false

    try {
      for (;;) {
        if (streamEnded) break
        let result
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          result = await readWithIdleTimeout(reader, timeoutMs, 'buddy', options.signal, phase)
          if (!result.done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`${this.product.id}: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error as Error })
          }
          throw error
        }
        if (result.done) break
        buffer += decoder.decode(result.value, { stream: true })
        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).trim()
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') {
            streamEnded = true
            break
          }
          let data: {
            error?: { message?: string }
            choices?: Array<{
              delta?: {
                content?: string
                reasoning_content?: string
                tool_calls?: Array<{
                  index?: number
                  id?: string
                  function?: { name?: string; arguments?: string }
                }>
              }
              finish_reason?: string
            }>
            usage?: {
              prompt_tokens?: number
              completion_tokens?: number
              /** 缓存命中的 prompt token 数（与 prompt_cache_hit_tokens 同值）。 */
              prompt_tokens_details?: {
                cached_tokens?: number
                cache_write_tokens?: number
              }
              completion_tokens_details?: { reasoning_tokens?: number }
              prompt_cache_hit_tokens?: number
              prompt_cache_miss_tokens?: number
              /** 费用权重（非 token 数）。 */
              credit?: number
            }
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          // ⚠️ **流内**的安全策略拦截（HTTP 200 + SSE 内嵌 11140 帧）。
          //
          // ## 原状：整帧被**静默丢掉**
          //
          // 下面的帧类型里**根本没有** `code` / `msg` 字段（只有 `error` /
          // `choices` / `usage`），而这类报文恰好是**顶层** `{code,msg,displayMsg}`、
          // 没有 `error`、没有 `choices` —— 于是它一路走到循环末尾，既没内容也没报错，
          // UI 表现成「干净地停止、无任何失败」（与 qoder 的 10605、TRAE 的流内错误
          // 同型；`isContentRejection` 的注释也记着「同一报文在 CodeArts 侧就以
          // HTTP 200 + 内嵌错误帧的形式出现」）。
          //
          // ## 判据必须**窄**：只认「没有 choices 的帧」
          //
          // 正文里出现「安全审核」「request illegal」甚至字面 `11140` 都是常态
          // （模型在讨论审核策略时就会说这几个词），而**有效内容帧一定带 choices**；
          // 加上这一层门禁，才不会因为一句正文把整个回答误判成拦截。
          // 复用 `isContentRejection(payload)` 而非另写一套：与 HTTP 层**同一判据**，
          // 两处各写一套正是 trae 那次缺陷的成因。
          if (data.choices === undefined && isContentRejection(payload)) {
            // 按定下的口径：**标记 + 如实报错**，本轮不重发（流内重发需要
            // 「尚未产出内容」的判据 + 外层循环，是 trae 3823133 那种结构改造）。
            // 账号标了冷却，下一轮选号就会绕开它，不再反复重撞。
            await markPolicyBlockedAccount(
              this.options.accountPool, this.product.id, policyBlockedAccountId, options.model,
            )
            throw contentRejectionError(this.product.id, 200, payload, false)
          }
          if (data.error !== undefined) {
            throw new LlmError(`${this.product.id}: ${data.error.message ?? 'unknown error'}`, 'SERVER')
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            let block = blocks.find(candidate => candidate.kind === 'text')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'text', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'text' }
            }
            // 正文死循环守卫（见 `proseLoopGuard` 注释）。
            //
            // ⚠️ 命中后**只停止累积与发射**，绝不 `reader.cancel()`、绝不改
            // finish reason —— 工具调用在循环正文之后到达且有效（实测）。
            // 截断靠收尾的 `block-end` 权威覆盖落地（见文件末尾 text 段）。
            if (proseLoopGuard !== undefined) {
              if (proseLoopGuard.observe(delta.content)) proseLoopDetected = true
            }
            // ⚠️ **不要在这里逐帧探测 think 标签**（2026-09-27 移除）。
            // 逐帧探测在跨帧时必然漏判（标签可被切成任意片段，实测二分帧时
            // 7/11 种切法漏判）→ 收尾不切分 → 标签落盘泄漏。
            // 现改为收尾**无条件**调用 `splitThinkTaggedContent`
            // （无标签时返回 undefined，普通响应逐字节不变）。
            if (!proseLoopDetected) {
              block.text += delta.content
              yield { type: 'text-delta', index: block.index, text: delta.content }
            }
          }
          if (delta?.reasoning_content) {
            // 死循环守卫：命中后不再累积、不再发射。
            //
            // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
            // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
            // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
            //
            // ⚠️ 也**不能用 `continue`**（Task 2 审查发现，已独立复现）：它会
            // 连带跳过本帧位于 reasoning 分支**之后**的 `usage` 与 `tool_calls`
            // —— 「reasoning + usage 同帧」时 usage 被静默丢弃（token 记账
            // 缺失）。故用 `if (!loopDetected)` 守卫分支体。
            if (loopGuard !== undefined) {
              if (loopGuard.observe(delta.reasoning_content)) loopDetected = true
            }
            if (!loopDetected) {
              // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
              // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
              const emit = suppressor.feed(delta.reasoning_content)
              if (emit !== undefined) {
                let block = blocks.find(candidate => candidate.kind === 'reasoning')
                if (block === undefined) {
                  block = { index: nextIndex++, kind: 'reasoning', text: '' }
                  blocks.push(block)
                  yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
                }
                // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本。
                block.text = suppressor.text()
                yield { type: 'reasoning-delta', index: block.index, text: emit }
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            if (typeof call.id === 'string' && call.id.length > 0) {
              toolIds.set(wireIndex, call.id)
            }
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', callId, announced: false }
              toolCalls.set(wireIndex, block)
            }
            block.callId = callId
            // 后续参数分片会带上空的 function.name（""），它不是 undefined，
            // 直接覆盖会把首个分片解析出的真实工具名清空，导致
            // `unknown tool ""`。只有非空名字才允许更新。
            if (typeof call.function?.name === 'string' && call.function.name.length > 0) {
              block.name = call.function.name
            }
            const fragment = call.function?.arguments ?? ''
            block.text += fragment
            // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` 同因同修，
            // 见该文件内的详细说明）。只跳过收尾的 `block-end` 不够 ——
            // `BlockAssembler` 会把没有 block-end 的 partial 也组装成
            // `name:''`，污染会话后让 workbuddy 以 400 code 11133 拒绝每次请求。
            if (!block.announced) {
              if (!hasUsableToolName(block.name)) continue
              block.announced = true
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: ToolCallId(callId),
                name: block.name!,
                argumentsDelta: block.text,
              }
              continue
            }
            yield {
              type: 'tool-call-delta',
              index: block.index,
              id: ToolCallId(callId),
              ...block.name !== undefined ? { name: block.name } : {},
              argumentsDelta: fragment,
            }
          }
          if (data.usage) {
            const promptTokens = data.usage.prompt_tokens ?? 0
            // 后端在六处回传缓存信息，其中 cached_tokens 同时出现在
            // prompt_tokens_details 与 completion_tokens_details 里，但后者
            // **恒为 0**（实测）——只认 prompt_tokens_details，误取会永远读到 0。
            const cachedTokens = data.usage.prompt_tokens_details?.cached_tokens
              ?? data.usage.prompt_cache_hit_tokens
              ?? 0
            const cacheWriteTokens = data.usage.prompt_tokens_details?.cache_write_tokens
            const reasoningTokens = data.usage.completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
                // 与 codearts 一致：inputTokens 只计**未命中缓存**的部分，
                // 命中部分单列 cacheReadTokens，否则缓存命中率显示会偏大。
                inputTokens: cachedTokens > 0 ? promptTokens - cachedTokens : promptTokens,
                outputTokens: data.usage.completion_tokens ?? 0,
                ...cachedTokens > 0 ? { cacheReadTokens: cachedTokens } : {},
                ...cacheWriteTokens !== undefined && cacheWriteTokens > 0 ? { cacheWriteTokens } : {},
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
      reader.releaseLock()
    }

    /**
     * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
     *
     * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
     * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
     * 或被清洗成空串的块。用 `blocks.length` 会把「零块响应」误判成「有块」，
     * 于是静默结束的缺陷原样保留。
     *
     * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
     */
    let blockCount = 0
    /**
     * 本步**最终发出的正文**（`block-end` 的权威文本），供 finish 归类判定
     * 「是否被上游停止串截断」（见 `isProseTruncatedByStopString`）。
     */
    let emittedProse = ''
    // 按创建顺序关闭每个块
    const textBlock = blocks.find(block => block.kind === 'text')
    for (const index of toolOrder) {
      const block = [...toolCalls.values()].find(candidate => candidate.index === index)!
      // `toolOrder` 只收「名字已可用」的块，故此处名字必然可用；不回退成
      // `?? ''` —— 那会把空名字块写进会话，正是本次修复要根除的污染路径。
      if (!hasUsableToolName(block.name)) continue
      blockCount += 1
      yield {
        type: 'block-end',
        index,
        block: {
          type: 'tool-call',
          id: ToolCallId(block.callId ?? ''),
          name: block.name!,
          // 仅把"无参数工具下发的空分片"补成 {}；**残缺参数保持原样**，
          // 由 max-tokens 判定触发重试。切勿把残缺 JSON 也补成 {}——那会
          // 伪造出合法外观，让 harness 报 `missing required property` 而
          // 非重试，掩盖真正的分片丢失。
          arguments: isTruncatedArguments(block.text)
            ? block.text
            : normalizeToolArguments(block.text),
        },
      }
    }
    if (textBlock !== undefined) {
      // ── think 标签归位（见 `splitThinkTaggedContent`）──
      // 标签**前**的内心独白 → reasoning 块；标签**后**的真正文 → 本 text 块。
      // 无标签时**逐字节不变**。
      //
      // ⚠️ **必须无条件调用，不得加「先探测有没有标签」的门禁**（2026-09-27 修）：
      // 标签会**跨帧**到达，任何逐帧探测都会漏判（实测二分帧 7/11 漏），
      // 漏了就不切分、标签原样泄漏。无标签时本函数返回 undefined，故普通响应
      // 逐字节不变（仅多一次字符串扫描）。
      let textOut = textBlock.text
      {
        const split = splitThinkTaggedContent(textBlock.text)
        if (split !== undefined) {
          // ⚠️ **必须同时喂 `suppressor`**：收尾以 `suppressor.text()` 为
          // reasoning 块的权威，只改 `blocks` 条目不生效。
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
      // 即兜底会**掩盖解析层的失败**；当前要让泄漏如实呈现以便观测。
      //
      // ⚠️ **必须在切分之后**：切分负责「解析」，本行只兜底纯标签块。
      //
      // ⚠️ **必须在 hex 切分之后**（顺序不可颠倒）：若放在切分之前，
      // `思考</think:6124c78e></think>` 这类「hex 后跟裸标签」的形态会漏 ——
      // 切分把裸标签留在正文侧，直接泄漏进 UI（审计实测到的真实缺陷）。
      // 放在末尾同时覆盖两种形态：切分产物再剥一次、纯裸标签块（无 hex）也在此剥离。
      textOut = stripBareThinkCloseTagIfEnabled(textOut)
      // 正文死循环截断：只保留循环前的干净前缀（与思考守卫同一覆盖机制）。
      // ⚠️ **不改 finish reason**：工具调用仍要被执行。
      const truncated = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
        ? textOut.slice(0, proseLoopGuard.cutAt)
        : textOut
      // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
      const cleaned = stripCourseLeakIfEnabled(truncated)
      // ⚠️ 归位后正文可能为空串（实测 seq=34768 形态）—— 空块会污染会话，
      // 且 DSH 的 `EMPTY_RESPONSE` 契约禁止产出空内容块。思考段已归位，
      // 故本响应仍有产出，不会被误判为零块。
      if (cleaned !== '') {
        blockCount += 1
        emittedProse = cleaned
        yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: cleaned } }
      }
    }
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
    if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
      // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
      // **权威覆盖**（已由 `scripts/verify-blockend-override.ts` 实证）：
      // 即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
      //
      // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
      // `reasoningBlock.text` —— 两者累积口径若不一致，以 helper 为准才能
      // 保证落块内容与 wire 一致。
      const suppressedReasoning = suppressor.text()
      const reasoningText = loopDetected && loopGuard?.cutAt !== undefined
        ? suppressedReasoning.slice(0, loopGuard.cutAt)
        : suppressedReasoning
      // 行首 `course` / `课` 泄漏 token 清洗（见 `stripCourseLeak`）。
      const cleanedReasoning = stripCourseLeakIfEnabled(reasoningText)
      if (cleanedReasoning !== '') {
        blockCount += 1
        yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: cleanedReasoning } }
      }
    }
    // 三种"不完整"都必须报告 max-tokens 而非 tool-calls，否则 harness 会
    // 执行残缺调用、报 INVALID_ARGS，并把脏参数持久化进会话历史：
    // - 'length'：模型输出被 max_tokens 显式截断；
    // - 未收到 finish_reason：连接被中途掐断，参数必然是半截 JSON；
    // - 参数分片丢失：后端并行下发多个工具调用时偶发丢分片（实测
    //   session-23851745 turn1 step4，两个并行 `read` 都丢了 `{"file_path": "…`
    //   前缀）。此时报告 tool-calls 会让 harness 执行缺参调用，报
    //   `missing required property "file_path"`，模型收到莫名其妙的参数错误
    //   并陷入重试循环。判定为截断后 dsh 丢弃残缺调用并重试，实测一次即恢复。
    const argsTruncated = [...toolCalls.values()].some(block => isTruncatedArguments(block.text))
    /**
     * 是否丢弃过**名称不可用**的 tool-call 块（见上方 tool_calls 分支）。
     *
     * 丢弃是对的（无名调用无法执行、留着会污染会话），但不能让它**静默地以
     * `stop` 结束** —— 那正是 AGENTS.md 记录的「没有任何报错就中断」：
     * 模型本意要调工具，harness 却认为它「正常答完了」。故报 max-tokens
     * （不完整、可重试）。同批若还有可用调用，则照常报 tool-calls。
     */
    const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced)
    /**
     * 正文是否被**上游停止串**掐断（见 `isProseTruncatedByStopString`）。
     *
     * 上游把 `</think>` 当停止串：模型在正文里写它（哪怕包在反引号里）就会被
     * 掐断，但仍报 `finish_reason:"stop"` —— 我们据此判「正常答完」会让本轮
     * **没有任何报错就停住**。判据三条同时成立：上游报 `stop`、本步无可用工具
     * 调用、正文止于未闭合的行内代码。
     */
    const proseCutByStopString = finishReason === 'stop'
      && toolOrder.length === 0
      && isProseTruncatedByStopString(emittedProse)
    /**
     * 思考死循环是否**是唯一的产出**（无正文、无工具调用）。
     *
     * ⚠️ 这层门禁**不可省** —— 用户要求（Gitee !IKIZNK）：「**如果只是**陷入
     * 思考循环的出错，就要给出有分辨力的错误提示」。只有该步没有任何可见产出时
     * 才报 `error`：`error` 路径**不落 `assistant/message`**（实测 219 会话里
     * 222 例），有正文/工具调用时报它会把用户可见内容整块丢掉。
     * 实测守卫命中的 25 例**全部**只有思考，故正常路径都走 error。
     */
    const reasoningLoopIsSoleOutput = loopDetected
      && emittedProse === ''
      && toolOrder.length === 0
    const reason = reasoningLoopIsSoleOutput
      // 思考死循环且无可见产出：报**有分辨力的 error**（见 REASONING_LOOP_CODE）。
      // ⚠️ 不能报 max-tokens —— UI 对它的固定文案是「已达到输出 token 上限」，
      // 把「检测到死循环」误导成「额度用满」（真实缺陷，Gitee !IKIZNK）。
      ? { kind: 'error' as const, failure: reasoningLoopFailure(
          loopGuard?.diagnostics,
          options.maxTokens,
          'reasoning',
        ) }
      // 循环命中但另有可见产出：只能报 max-tokens（保住内容），不能报 error。
      : loopDetected
        ? { kind: 'max-tokens' as const }
      : finishReason === 'length'
        || finishReason === undefined && toolOrder.length > 0
        || argsTruncated
        || proseCutByStopString
        || droppedUnnamedCalls && toolOrder.length === 0
        ? { kind: 'max-tokens' as const }
        : finishReason === 'tool_calls' || toolOrder.length > 0
          ? { kind: 'tool-calls' as const }
          : { kind: 'stop' as const }
    // 零内容块响应（例如本次只收到过那个被压制的空白 reasoning）否则会以
    // `stop` 收场 —— 那是 DSH `EMPTY_RESPONSE` 契约明令禁止的静默结束。
    // ⚠️ 传入的是**上面已算好的** `reason`（含 loopDetected / length /
    // 无名 tool-call 等全部既存判据）；helper 只在 `kind === 'stop'` 时改写。
    yield { type: 'finish', reason: resolveEmptyResponseReason(reason, blockCount) }
  }
}

/** 凭据是否已过期；无法解析过期时间时不判定过期（与 Rust is_expired 一致）。 */
function isCredentialExpired(credential: BuddyCredential): boolean {
  const expiresAt = credentialExpiresAtMs(credential)
  return expiresAt === undefined ? false : Date.now() >= expiresAt
}

/**
 * 生成模型选择器里显示的名字，承载**两类**信息：计费倍率与同名消歧。
 *
 * ⚠️ **必须写进 `name` 而不是 `description`**：composer 的模型切换菜单只渲染
 * `name`（见 ModelSelect 的 `children: model.name`），`description` 仅用于
 * `/model` 弹窗。用户报障「消耗倍率没有显示在切换模型列表的后面」正是因为
 * 早期版本放在了 `description`。
 *
 * 安全性：`name` **纯属展示** —— DSH 的选择与持久化只用 `id`
 * （见 `selectionOf` 返回 `model: model.id`），故在名字里附加价格不会污染会话。
 *
 * 形如 `Deepseek-V4.1-Flash · x0.03`；有促销时 `· x0.29 (常时)` /
 * `· x0 (错峰)` / `· x0.00 (限免)`——倍率与状态词按**当前时刻实时**推算、
 * 显示在同一行短后缀里，长标注（活动截止日 + 时段窗口）改放 `description`
 * 副行（见 listModels 与 promotionView）。同名撞车时再加变体标记。
 */
function displayNameFor(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): string {
  const suffix = displaySuffix(model, all)
  return suffix.length > 0 ? `${model.name} · ${suffix}` : model.name
}

/** 组装展示名的后缀部分：倍率 + 状态词 + 同名变体标记。 */
function displaySuffix(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): string {
  const parts: string[] = []
  // 倍率与状态词按**当前时刻实时**推算（promotionView 内部用 new Date()），
  // 不再把 config 拉取时刻的判定冻结进模型名——避免「大白天显示免费」。
  // 长标注（活动截止日 + 时段窗口 + 窗口外错峰价）移到 listModels 的
  // `description` 副行，不在模型名里塞长句。
  const view = promotionView(model)
  const rate = view.effectiveRate ?? model.creditsRate
  if (rate !== undefined) parts.push(rate)
  if (view.status !== undefined) parts.push(`(${view.status})`)
  // 同名消歧：只在**确实撞车**时追加，避免影响其它模型。
  const variant = variantLabelFor(model, all)
  if (variant.length > 0) parts.push(variant)
  return parts.join(' ')
}

/**
 * 判断该模型是否需要变体标记，需要时返回标记文本。
 *
 * 远端会给**不同 id 配同一个 name**（实测 `deepseek-v4.1-flash` /
 * `deepseek-v4.1-flash-sg` 都是 "Deepseek-V4.1-Flash"；`hy3`/`hy3-x` 都是
 * "Hy3"），而选择器按 name 展示 → 出现无法区分的重复条目。
 *
 * 用**公共前缀**切分而非硬编码 `-sg`：撞车组随服务端上新变化（本次实测三组
 * 里只有一组带 `-sg`）；也不用「取 id 最后一段」（会把 `gpt-5.6-sol` 的
 * `sol` 当变体）。公共前缀只在撞车时才计算，不影响其它模型。
 */
function variantLabelFor(model: BuddyRemoteModel, all: readonly BuddyRemoteModel[]): string {
  const group = all.filter((candidate) => candidate.name === model.name)
  if (group.length <= 1) return ''
  const prefix = commonPrefix(group.map((candidate) => candidate.id))
  const variant = model.id.slice(prefix.length).replace(/^-+/, '')
  return variant.toUpperCase()
}

/** 求一组字符串的公共前缀（逐字符比较）。 */
function commonPrefix(values: readonly string[]): string {
  if (values.length === 0) return ''
  let prefix = values[0]!
  for (const value of values.slice(1)) {
    let i = 0
    while (i < prefix.length && i < value.length && prefix[i] === value[i]) i++
    prefix = prefix.slice(0, i)
    if (prefix.length === 0) break
  }
  return prefix
}

/**
 * 把候选输出上限规整为「可安全下发的正整数」，否则返回 undefined。
 *
 * 为什么必须过滤：DSH 的 `LlmRuntime.resolveModelInfoFor` 对适配器声明的
 * `defaultMaxTokens` 有硬校验 —— 非安全整数或 ≤0 会直接抛
 * `adapter returned invalid default maxTokens`（INVALID_MODEL_MAX_TOKENS），
 * 整轮对话起不来。远端是外部输入，`0` / 负数 / `NaN` 都可能出现，
 * 不能在适配器里假设它合法。
 */
function positiveMaxTokens(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * 在 ctx.llm 上注册 CodeBuddy 系产品的 provider 路由与适配器。
 *
 * 路由名与展示名由产品配置驱动：CodeBuddy 得到 `buddy`，WorkBuddy 得到 `workbuddy`。
 *
 * ⚠️ 刻意**不**调用 `ctx.llm.registerConfigurableProviders`（即不向「设置 → 模型 →
 * 提供商」声明配置行）：账号、模型开关与模型目录都由 Channel Pack 设置页管理，声明只会
 * 在该页留下无人使用的行。原因、依据与恢复方式见 `llm-register-compat.ts` 模块头。
 */
export function registerBuddyLlm(ctx: Context, options: BuddyAdapterOptions): BuddyAdapter {
  const product = options.product ?? CODEBUDDY
  const adapter = new BuddyAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  // 返回实例：Channel Pack「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名/倍率）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}
