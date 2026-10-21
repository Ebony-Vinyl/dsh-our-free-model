import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  attributionHeaders, CONTEXT_WINDOW_EXCEEDED_CODE, isContextWindowExceededError,
  isQuotaExceededError, LlmAdapter, LlmError, QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { nextUtc8DayStartMs } from './model-queue.js'
import { isCodeArtsBenefitModel } from './models.js'
import { normalizeHarnessMessages } from './message-shape.js'
import { directFetch } from './direct-fetch.js'
import { signRequestHuawei } from './sign.js'
import { createBlankReasoningSuppressor, createReasoningLoopDetector, hasUsableToolName, isReasoningLoopGuardEnabled, isTruncatedArguments, normalizeToolArguments, readWithIdleTimeout, reasoningLoopFailure, resolveEmptyResponseReason, resolveToolPairing, stripCourseLeakFromHistoryContent, stripCourseLeakIfEnabled } from './sse.js'
import type { CodeArtsCredential } from './types.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import { reportLedgerAccount } from './token-ledger.js'

export const CHAT_API_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v2'
export const PROVIDER = 'codearts'
/**
 * 「该账号没有 benefit（免费额度）包」的稳定失败码。
 *
 * CodeArts 对**积分制**账户（体验版等，没有 benefit 免费额度包）会以
 * HTTP 200 + SSE `InferHub.4004.200 benefit not found` 拒绝带
 * `maas_type: benefit` 的请求，而同一个模型不带该头可以正常出流（实测
 * 2026-10-01，deepseek-v4.1-flash）。`stream()` 命中该码后去掉该头重试一次。
 */
const BENEFIT_NOT_FOUND_CODE = 'BENEFIT_NOT_FOUND'
/** CodeArts 在账号没有 benefit 包时下发的事件 error_code。 */
const CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE = 'InferHub.4004.200'

// DeepSeek V4（CodeArts Agent 模型列表新增，UI 标注"每日 1000 万免费 Tokens"福利）：
//
// 修正（2026-09-23，对齐 deveco-code-rust fb1b4a2）：早期注释称
// 「deepseek-v4-flash-0731 后端未注册」，该结论**有误** —— 实测它返回 404 的
// 真实原因是**缺少 `maas_type: benefit` 头**；带上该头即成功。带日期后缀与
// 无后缀是后端上两个不同的模型，均有注册，不能互相替代：
//   - deepseek-v4-flash-0731 / deepseek-v4-pro-0813 → benefit 模型（需 maas_type）
//   - deepseek-v4-flash / deepseek-v4-pro（无后缀）  → 非 benefit（带该头会
//     `unsupported model`）
// gateway/config 返回的是 benefit 那组，故下方静态表保留无后缀形态
// （无后缀始终可用，不依赖 benefit 头），而 deepseek-v4.1-flash 只有 benefit 形态。
const DEFAULT_MODELS: readonly string[] = [
  'GLM-5.2', 'GLM-5.1', 'GLM-5',
  'glm-5.3-flash',
  'openpangu-2.0-flash', 'openpangu-2.0-pro',
  'deepseek-v4-flash', 'deepseek-v4-pro',
  'deepseek-v4.1-flash',
]

/**
 * 模型上下文窗口（最大合并请求+响应 token 数）。
 * - GLM-5.2：202752（对齐 CodeArts Agent IDE 模型卡标注）。
 * - glm-5.3-flash：1048576（1M，逆向自 IDE gateway/config，对齐 deveco-code-rust 90aeb17d）。
 * - deepseek-v4-flash / deepseek-v4-pro：1048576（1M，UI 标注）。
 * - deepseek-v4.1-flash：1000000（对齐 IDE 下发的 inferhub-provider 模型配置，
 *   2026-09 kernel 日志；对齐 deveco-code-rust fb1b4a2）。
 * - 其余模型未公开上下文容量，留 undefined 让后端默认裁剪。
 */
const CONTEXT_WINDOWS: ReadonlyMap<string, number> = new Map([
  ['GLM-5.2', 202752],
  ['glm-5.3-flash', 1_048_576],
  ['deepseek-v4-flash', 1048576],
  ['deepseek-v4-pro', 1048576],
  ['deepseek-v4.1-flash', 1_000_000],
])

export interface CodeArtsAdapterOptions {
  credentialRef: CredentialRef
  resolveCredential: () => Promise<CodeArtsCredential | undefined>
  refresh: () => Promise<void>
  /** 动态拉取远端模型列表；失败时调用方回退到静态列表。 */
  fetchRemoteModels?: () => Promise<Array<{ id: string; name: string }>>
  fetchImpl?: typeof fetch
  chatId?: string
  sessionId?: string
  /** 多账号池（用于限流时切换账号） */
  accountPool?: AccountPool
}

/**
 * 将消息内容载荷展平为纯文本字符串。Harness 消息
 * 以 OpenAI 风格的块数组形式携带内容（`[{type:'text',...}]`，且
 * 助手历史可能包含 `{type:'reasoning',...}` 块）；CodeArts
 * 端点会拒绝非 `text` 块类型并返回空流，因此只保留
 * `text` 块并拼接。
 */
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
 * 将 harness 对话消息序列化为 CodeArts chat-completions 的传输
 * 格式。助手的 `tool-call` 块转换为 `tool_calls` 字段；`reasoning`
 * 块折叠为 `reasoning_content` 字段（deepseek-v4 等推理模型的后端
 * 校验要求 assistant 消息必须携带该字段，缺失会报 "Missing
 * `reasoning_content` field"）；工具结果（搭载在 harness 用户消息中）
 * 展开为独立的 `{role: 'tool'}` 消息，使模型能看到其调用的返回值。
 * 其余非文本块（图片）被丢弃，与端点接受的格式一致。
 *
 * ⚠️ 入口先做 **DSH 0.1.7 消息形状归一化**（见 `message-shape.ts`）：0.1.7 把工具
 * 结果改为一等 `role:'tool'` 消息，若不归一化，下面的 `type === 'tool-result'`
 * 判据恒不命中 → 工具调用被 `resolveToolPairing` 整体剔除。
 */
export function serializeMessages(messages: readonly { role: string; content: unknown }[]): Array<Record<string, unknown>> {
  const normalized = normalizeHarnessMessages(messages)
  const wire: Array<Record<string, unknown>> = []
  // 剔除无法配对的工具调用/结果（详见 resolveToolPairing）：孤儿 tool_calls
  // 会让后端对之后每一条消息都返回 400，整个会话永久报废。
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
      wire.push({
        role: 'assistant',
        content: text,
        // 后端（deepseek-v4-flash/pro）校验要求 assistant 消息必须包含
        // reasoning_content 字段：历史里的推理块在上一轮被持久化，回传时
        // 若缺失该字段会直接 400（"Missing `reasoning_content` field"）。
        // 始终携带该字段（无推理时为空串），确保字段存在。
        reasoning_content: reasoning,
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
      })
      continue
    }
    if (message.role === 'system') {
      wire.push({ role: 'system', content: contentToText(message.content) })
      continue
    }
    // user 角色：工具结果搭载在 harness 用户消息中；将每个展开为
    // 独立的 role:'tool' 传输消息，与 deepseek 适配器的行为一致。
    const content = Array.isArray(message.content) ? message.content : []
    const toolResults = content.filter((block): block is { type: string; toolCallId: unknown; content: unknown } =>
      typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool-result')
    // 纯文本 user 消息（字符串 content）需原样传递：contentToText 处理
    // 字符串时直接返回，但这里不能用 `content`（非数组时为 []）——否则
    // 字符串 user 消息会被序列化成空串，模型看不到任务指令。
    const text = contentToText(message.content)
    if (text.trim().length > 0) wire.push({ role: 'user', content: text })
    for (const result of toolResults) {
      // 丢弃孤儿工具结果：没有对应 tool_call 其结果同样会让后端 400。
      if (!keepResultIds.has(String(result.toolCallId))) continue
      wire.push({
        role: 'tool',
        tool_call_id: String(result.toolCallId),
        content: contentToText(result.content) || '(no output)',
      })
    }
  }
  return wire
}

/**
 * 判断模型是否为 deepseek-v4 系列（flash/pro）。
 *
 * deepseek-v4 对标准 OpenAI 格式的 `tool_calls.arguments` 采用一次性打包
 * 生成：模型在生成超大工具参数（如 2000 行 write content）期间 SSE 流
 * 长时间无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），
 * 且后端不会对任何请求头发送心跳保活（实测 2026-08-22：无论是否携带
 * app-id/plugin-name/x-ot-* 等 IDE 头、是否带 `accept: text/event-stream`、
 * `tool_stream`、调整 `max_tokens`，SSE 流均无 `:` 注释行，60s 静默必断）。
 *
 * 但 deepseek-v4 原生支持 DSML 工具调用格式：工具调用直接写入
 * `delta.content`（形如 `<｜DSML｜tool_calls>...`），走与 reasoning 相同的
 * 流式通道。实测（2026-08-22 e2e 探测）：1000 行 write content 的 DSML
 * 流全程最大静默仅 204ms，146s 完整结束；标准 tool_calls 模式 100 行也
 * 会在 17.7s 静默后一次性到达、300 行即 60s 断连。因此对 deepseek-v4
 * 模型将工具 schema 注入 system 消息、请求体不发送 `tools` 字段，让模型
 * 以 DSML 流式输出工具调用，从根上规避网关空闲断连。
 */
function isDeepseekV4Model(model: string): boolean {
  return /^deepseek-v4-(flash|pro)$/.test(model)
}

/**
 * 工具名匹配大参数写文件类工具（content/arguments 可能达到数万 token）。
 * 仅用于对非 deepseek-v4 模型的 DSML 模式降级判定（当前全量模式不再使用此列表）。
 */
const DSML_LARGE_PARAM_TOOLS = ['write', 'file_write', 'apply_patch']
/**
 * 判断模型是否应使用 DSML 原生工具调用语法输出。
 *
 * deepseek-v4 模型始终走 DSML 模式（不论工具列表中包含什么工具），原因：
 * - 标准 `tool_calls` 模式要求参数一次性打包生成，SSE 流在生成参数期间长时间
 *   无数据，APIG 网关 ~60s 空闲超时必然掐断连接（`terminated`），且后端不对
 *   任何请求头发送心跳保活；
 * - 除 write/file_write/apply_patch 外，`subagent` 的 `prompt` 参数也可能很长
 *   （包含详细任务描述与上下文），同样面临网关断连风险；
 * - DSML 模式使工具调用通过 `delta.content` 流式输出（全程有数据流），从根上
 *   规避网关空闲断连，实测 1000 行 write content 的 DSML 流全程最大静默仅
 *   204ms，146s 完整结束；
 * - 模型行为统一，避免不同步骤间标准/DSML 模式切换引入的不一致。
 *
 * 非 deepseek-v4 模型（如 openpangu / GLM-5.2 等）使用华为标准 IAM AK/SK 鉴权，
 * 不走 CodeArts Agent APIG 网关，无 60s 空闲断连问题，继续保持标准 tool_calls。
 */
function needsDsmlToolMode(model: string, _toolNames: readonly string[]): boolean {
  return isDeepseekV4Model(model)
}

/**
 * 构造让 deepseek-v4 以原生 DSML 格式调用工具的 system 提示。
 *
 * 适配器不把 `tools` 字段发给后端（否则模型走标准 tool_calls 一次性
 * 打包路径），而是把 OpenAI function schema 以文本注入 system 消息，
 * 并明确要求模型使用 `<｜DSML｜tool_calls>` 语法。`parseDsmlToolCalls`
 * 会把模型输出的 DSML 块解析为结构化 tool-call，harness 无需感知差异。
 */
function buildDsmlSystemPrompt(tools: Array<{
  type: string
  function: { name: string; description?: string; parameters?: unknown }
}>): string {
  const toolJson = JSON.stringify(tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
  })), null, 2)
  return [
    '以下是你可用的工具及其 JSON Schema。当需要调用工具完成任务时，',
    '必须使用原生 DSML 工具调用语法输出，格式如下：',
    '<｜DSML｜tool_calls><｜DSML｜invoke name="工具名"><｜DSML｜parameter name="参数名" string="true">参数值</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>',
    '',
    '规则：',
    '- 工具名必须是下面列表中的 name。',
    '- 每个参数用一个 <｜DSML｜parameter> 标签包裹，参数值放在标签之间。',
    '- 字符串参数加 string="true" 属性；对象/数组/数字/布尔参数不要加该属性。',
    '- 一次可以输出多个 <｜DSML｜invoke> 调用（工具可以并行）。',
    '- 文件内容请一次性完整写入单个 write 调用的 content 参数，不要拆分或省略。',
    '',
    '工具列表（JSON Schema）：',
    toolJson,
  ].join('\n')
}

/**
 * CodeArts 并发排队端点。当后端按账户的会话
 * 并发上限达到时，chat completions 请求会以
 * `TM.00001041`（"并发会话数已达上限"）失败，调用方需轮询
 * 排队状态端点，直到后端再次允许该会话。
 */
export const QUEUE_STATUS_BASE = 'https://snap-access.cn-north-4.myhuaweicloud.com/api/v1/queue/status'

/** 在 CodeArts 队列中等待时的轮询间隔。 */
const QUEUE_RETRY_DELAY_MS = 10_000
/** 轮询上限：180 × 10 秒 = 30 分钟，与 deveco-code 参考实现一致。 */
const QUEUE_MAX_ATTEMPTS = 180

/**
 * SSE 流空闲超时。CodeArts 后端 / APIG 网关对 SSE 连接有 ~60 秒无数据即
 * 断开的策略：当模型生成超长推理或大工具调用参数时，两次 chunk 之间可能
 * 静默数十秒，连接被服务端掐断后 Node undici 的 reader.read() 抛
 * `TypeError: terminated`。该错误非 HarnessError，被 normalizeLlmFailure
 * 归类为 UNKNOWN（不可重试），harness 直接失败。
 * 主动以略小于网关超时的窗口检测空闲：超时则取消 reader 并抛可重试的
 * TIMEOUT，让 harness 重试该步骤（历史已持久化，重试会带相同上下文）。
 *
 * SSE 流超时配置（对齐 CodeArts Agent IDE agentkernelServer 逆向实证：
 * `firstTokenTimeout = 300000` / `chunkTimeout = 600000`）。
 *
 * 历史背景：原实现用单一 `SSE_IDLE_TIMEOUT_MS = 55_000`（55s），对齐
 * APIG 网关 ~60s 空闲断连。但 deepseek-v4-flash 生成大文件 write 工具
 * 调用的 content 参数时，会先输出 file_path 参数然后长时间静默（模型
 * 在内部做长文本生成但不在 SSE 上 flush），实测三次均在 ~55s 处被掐断、
 * 重试后又重复相同模式——55s 对这类"思考型长生成"太短。
 *
 * IDE 的方案是拆成两个超时：
 * - firstTokenTimeout=300s：等第一个 token 的窗口，到点才报错
 * - chunkTimeout=600s：每收到一个 chunk 就重置；两次 chunk 之间超过 10 分钟才报错
 *
 * 两者均可通过环境变量覆盖（毫秒，整数），便于测试用短超时触发 TIMEOUT
 * 路径，或在线上针对特定模型调优。环境变量在每次 stream() 调用时读取，
 * 避免模块顶层常量在 import 时定型、测试运行中设置环境变量不生效。
 */
function resolveFirstTokenTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_FIRST_TOKEN_TIMEOUT_MS ?? '', 10) || 300_000
}
function resolveChunkTimeoutMs(): number {
  return Number.parseInt(process.env.DSH_CODEARTS_SSE_CHUNK_TIMEOUT_MS ?? '', 10) || 600_000
}

/**
 * 判断一个错误是否为 SSE 传输级故障（连接被对端掐断 / socket 重置 /
 * undici 内部 socket 错误），而非业务错误。这类错误可安全重试整个
 * chat 请求，因此映射为可重试的 TRANSPORT code，而非 UNKNOWN。
 */
function isTransportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = error.message.toLowerCase()
  // undici / Node 流在连接被对端关闭时抛 "terminated"
  if (message.includes('terminated')) return true
  // undici socket 错误（UND_ERR_SOCKET / UND_ERR_HEADERS_TIMEOUT 等）
  if (error.name.startsWith('UND_ERR_')) return true
  // fetch 网络层失败
  if (message.includes('fetch failed')) return true
  // TCP 重置 / 对端中断
  if (message.includes('econnreset') || message.includes('epipe') || message.includes('socket hang up')) return true
  return false
}

/**
 * SSE 流内可重试的排队/限流错误信号。CodeArts 后端有时以 HTTP 200 +
 * SSE 内嵌错误的形式返回排队/限流（如 `InferHub.ModelArts.81111.429`
 * TPM 超限），而不是 4xx——适配器把这种响应当成排队处理：延迟后
 * 重新发起整个 chat 请求，与 TM.00001041 行为一致。
 */
class SseQueueRetryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SseQueueRetryError'
    this.code = code
  }
}

/**
 * SSE 流内「额度已用尽」的信号（**不可重试**）。
 *
 * ⚠️ 必须与 {@link SseQueueRetryError} **分开**：排队是「等一会儿就通」，
 * 额度是「等多久都没用」。把它当排队处理正是本次缺陷的表象
 * （静默重试 30 分钟、界面零输出）。
 *
 * 之所以要单独一个类而不是直接抛 `LlmError`：`stream()` 需要在**同一个地方**
 * 完成「标记账号受限 + 切下一个账号 + 如实抛出」三件事，且要能 `continue`
 * 重试循环 —— 这件事只有捕获点的上下文（`credential` / `currentAccountId` /
 * `rateLimitTried`）才做得到。
 */
class SseQuotaExhaustedError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'SseQuotaExhaustedError'
    this.code = code
  }
}

/**
 * 把「距重置还有多久」格式化成中文短句。
 *
 * 用户需求（2026-10-02）：「其它渠道限额到了会提示多少时间后会解除限额，
 * 这个 codearts 的也加上吧」—— 其它渠道（buddy / workbuddy）由**服务端**
 * 在错误文案里给出重置时刻，故 `parseRateLimitError` 能解析；CodeArts 的
 * benefit 额度报文里**没有**任何时间字段（实测 `InferHub.4291.200` 的
 * `details` 只有 requestId / timestamps / modelId / traceId），因此按
 * **UTC+8 自然日**自行推算（见 {@link codeartsQuotaExhaustedMessage}）。
 *
 * @param resetAtMs - 解禁时刻（UTC 毫秒）。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function formatResetIn(resetAtMs: number, nowMs: number = Date.now()): string {
  const diff = resetAtMs - nowMs
  if (diff <= 0) return '即将重置'
  if (diff < 60_000) return '不到 1 分钟'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟`
  // 保留一位小数：额度按自然日结算，剩余时间通常在 1~24 小时之间，
  // 只报整数会让「还有 1 小时」与「还有 1.9 小时」看起来一样。
  return `${Math.round(diff / 360_000) / 10} 小时`
}

/**
 * 额度用尽时给用户看的完整说明（**含解禁时间**，这是用户明确要求的）。
 *
 * ## 为什么按「UTC+8 次日 00:00」推算
 *
 * CodeArts 的 benefit（免费额度）模型（`glm-5.3-flash` / `deepseek-v4.1-flash`）
 * 额度按**自然日**结算（IDE 模型卡标注「每日 1000 万免费 Tokens」），而
 * `InferHub.4291.200` 的报文里**不给重置时刻**。故与 `qoder` / `zcode` 的
 * 额度处理同款：复用 {@link nextUtc8DayStartMs} 取 UTC+8 当日 24:00，
 * **不能**复用 `parseRateLimitError`（它解析不到时间时退回「1 小时后」，
 * 对按日结算的额度会让标记过早失效，用户 1 小时后再撞一次同样的墙）。
 *
 * ⚠️ 措辞对「这是我们的推算」保持诚实：写「预计」，不谎称是服务端给的时间。
 *
 * @param model - 请求的模型 id（用户据此决定换哪个）。
 * @param resetAtMs - 推算出的解禁时刻。
 * @param nowMs - 当前时刻（注入以便单测）。
 */
export function codeartsQuotaExhaustedMessage(
  model: string,
  resetAtMs: number,
  nowMs: number = Date.now(),
): string {
  const when = formatResetIn(resetAtMs, nowMs)
  return (
    `codearts: 模型 ${model} 的免费额度（benefit）已用尽，`
    + `预计 ${when}后重置（按 UTC+8 自然日结算，预计 ${new Date(resetAtMs).toISOString()}）。`
    + '可改用其它模型，或在 Channel Pack 的 CodeArts 面板切换/添加账号。'
  )
}

/** CodeArts 后端返回的一次排队状态响应。 */
export interface CodeArtsQueueStatus {
  readonly status: 'waiting' | 'working' | 'error' | 'queue_full'
  readonly queuePosition: number
  readonly message: string
}

/** 判断 HTTP 错误体是否表示 CodeArts 并发排队限流。 */
function isQueueError(status: number, body: string): boolean {
  return status === 400
    && (body.includes('TM.00001041')
      || /peak\s+usage|try\s+again\s+after|peak\s+hours/i.test(body)
      || /high\s+demand|too\s+many\s+requests/i.test(body))
}

/**
 * 判断 HTTP 错误是否表示凭据已失效、可通过 refresh_token 续期后重试。
 * CodeArts 经华为 APIG 网关鉴权：SecurityToken 过期/无效时网关返回
 * `APIG.0602`（"Invalid token"），HTTP 状态通常是 401，但也观察到 403。
 * 本适配器在入口已按 expires_at 预判过期，但 SecurityToken 可能被后端
 * 提前吊销、或本地时钟与签发端有偏差——此时首次请求会命中本错误。
 * 策略：触发一次静默 refresh，用新 AK/SK/SecurityToken 重试一次；仍失败
 * 才抛 AUTH，避免把可自愈的瞬时鉴权失败暴露给用户。
 */
function isAuthError(status: number, body: string): boolean {
  if (status === 401 || status === 403) return true
  return body.includes('APIG.0602') || /invalid\s+token|token\s+expired|token\s+is\s+invalid/i.test(body)
}

/**
 * 判断 SSE 流内返回的 error_code 是否属于**可重试**的排队/限流错误。
 *
 * CodeArts 以 HTTP 200 + SSE 内嵌 `error_code` 返回这类错误（例如
 * `InferHub.ModelArts.81111.429` TPM 每分钟 token 超限），而不是 4xx——
 * 适配器把它们当成排队处理：延迟后重试整个 chat 请求，与 TM.00001041
 * 行为一致，避免"思考后无输出"。
 *
 * ## ⚠️ 判据必须锚定「429」这个**独立数字**，不能用裸子串（真实缺陷）
 *
 * 原实现写作 `/81111|TPM|429|rate.?limit|…/`，其中 `429` 是**无边界子串**匹配，
 * 于是额度耗尽码 `InferHub.4291.200` 里的 `4291` **命中了 `429` 前缀** ——
 * 被误判成「可重试的排队限流」，进入每 10 秒重试、上限 180 次（30 分钟）的
 * 静默重试循环。
 *
 * 实测（2026-10-02，用户在本机真实凭据上的会话）：
 * ```
 * isSseQueueErrorCode('InferHub.4291.200') === true    ← 误判
 * 匹配到的子串: "429"
 * ```
 * 后果是**界面完全无输出**：`stream()` 在排队期间刻意不产出任何内容块
 * （见下方排队循环的长注释），而它误以为自己"在排队"。实测真实适配器
 * 25 秒内发出 4 次 chat 请求 + 3 次排队探测、**产出 0 个 chunk**，最终由
 * 用户手动中止（会话记录里是 `turn/end aborted` + `stream: []`，**没有任何
 * error 事件** —— 因为错误根本没被抛出）。这正是用户报障的「CodeArts Agent
 * 没反应」。
 *
 * ⇒ 现在 `429` 用 `(^|[^0-9])429([^0-9]|$)` 锚定为独立数字：`…81111.429`（结尾）
 * 与 `429 Too Many Requests`（后接空格）仍命中，而 `4291` 不再命中。
 * 额度耗尽的 `4291` 由 {@link isSseQuotaExhaustedErrorCode} 单独识别。
 *
 * 导出仅供单测直接锁定「`429` 的边界」这一判据本身 —— 若只靠调用点的先后顺序
 * （额度判据排在排队判据之前）来兜住 `4291`，那么把边界改回裸子串时**任何**
 * 端到端用例都不会变红（实测确认过），边界就成了没人守的装饰。
 */
export function isSseQueueErrorCode(code: string): boolean {
  return code === 'TM.00001041'
    || /81111|TPM|(^|[^0-9])429([^0-9]|$)|rate.?limit|too many requests|排队|限流/i.test(code)
}

/**
 * 判断 SSE 流内返回的 error_code 是否表示**额度已用尽**（不可重试）。
 *
 * 实测报文（2026-10-02，真实凭据）：
 * ```
 * HTTP 200  data:{"error_code":"InferHub.4291.200","error_msg":"insufficient quota",
 *                 "details":[…requestId…timestamps…modelId: deepseek-v4.1-flash…traceId…]}
 * ```
 * 同账号的 `deepseek-v4-flash`（非 benefit 通道）仍正常出流 —— 故这是
 * 「该模型 + 该账号的免费额度用尽」，不是账号欠费（同期 `statistics/plugin`
 * 显示积分余额仍有 8499.84）。
 *
 * 与「排队/限流」是**本质不同**的两件事，绝不可合并（同 `qoder` 的
 * `10605` 排队 vs `110` 额度那次教训，见 `AGENTS.md`）：
 *
 * | | 排队/TPM 限流 | 额度用尽 |
 * |---|---|---|
 * | 语义 | **暂时**受阻，等一会儿就通 | **额度真的没了**，重试无意义 |
 * | 处理 | 内部等待后重试 | **立即失败**并如实告知 |
 *
 * 判据用**子串** `4291`（而非全等）是刻意的：该码由服务端下发，本地产物里
 * 没有硬编码（同 `qoder` 的 `110`），若上游改用 `InferHub.4291.xxx` 的其它
 * 尾号表达同一语义，只认全等会漏判。`4291` 与排队族的 `81111` / 独立的
 * `429` 均不冲突。
 *
 * 文案兜底（`insufficient quota`）不可省：万一上游换了码值，序列化后的
 * detail 文本仍能命中 —— 与 `zcode` / `qoder` 的既有做法一致。
 */
export function isSseQuotaExhaustedErrorCode(code: string, message: string): boolean {
  return code.includes('4291') || /insufficient[\s_-]+quota/i.test(message)
}

/** 从错误体提取可分类的 detail 文本（OpenAI 风格 error 或 CodeArts error_code/error_msg）。 */
function errorDetail(body: string): string {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const error = typeof data.error === 'object' && data.error !== null
      ? data.error as Record<string, unknown>
      : undefined
    const parts = [
      typeof error?.code === 'string' ? error.code : undefined,
      typeof error?.type === 'string' ? error.type : undefined,
      typeof error?.message === 'string' ? error.message : undefined,
      typeof data.error_code === 'string' ? data.error_code : undefined,
      typeof data.error_msg === 'string' ? data.error_msg : undefined,
      typeof data.message === 'string' ? data.message : undefined,
    ].filter((value): value is string => value !== undefined)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON 错误体：直接用原文分类。
  }
  return body
}

/**
 * 将 CodeArts 错误响应归一化为 harness 错误码，与 deepseek 适配器的
 * httpErrorCode 词汇一致：400 且命中上下文超限措辞时归为
 * CONTEXT_WINDOW_EXCEEDED（触发 dsh compaction 自动压缩上下文），
 * 而不是不可重试的 HTTP_400，避免长会话在接近窗口上限时直接中断。
 */
function httpErrorCode(status: number, body: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  const detail = errorDetail(body)
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  if (status === 429) return 'RATE_LIMIT'
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
    return 'INVALID_REQUEST'
  }
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** 可中止的休眠；当信号中止时立即 resolve。 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 安全读取 Error.message，避免访问器抛异常。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  try { return String(error) } catch { return 'unknown error' }
}

/**
 * 在空闲超时内读取一个流块（实现见 {@link readWithIdleTimeout}）。
 * 此处用 codearts 标签包一层，保持错误消息前缀与历史行为一致。
 */
function readCodeArtsChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
  phase: 'first-token' | 'chunk' = 'chunk',
): Promise<{ done: boolean; value: Uint8Array | undefined }> {
  return readWithIdleTimeout(reader, timeoutMs, 'codearts', signal, phase)
}

/**
 * DSML 工具调用格式提取器。
 *
 * 某些模型（如 deepseek-v4）在未通过 `tools` 字段告知工具模式、或工具
 * 模式与模型训练格式不匹配时，会把工具调用以原生 DSML XML 风格直接写入
 * `delta.content`，形如：
 *   `<｜DSML｜tool_calls><｜DSML｜invoke name="bash">
 *    <｜DSML｜parameter name="command" string="true">ls</｜DSML｜parameter>
 *    </｜DSML｜invoke></｜DSML｜tool_calls>`
 * 适配器若原样作为 text-delta 输出，原始 token 会泄漏到 web UI（表现为
 * "dump 出奇怪的一段内容后终止"）。本提取器以流式状态机从 content 增量
 * 中识别完整 DSML 块并解析为结构化 tool-call；非 DSML 文本原样放行，
 * 保持流式输出不阻塞。
 *
 * 同时支持 DeepSeek-V4 Thinking 模式：模型在工具调用前会把推理过程包裹
 * 在 `<thought>...</thought>` 标记中写入 `delta.content`。本提取器把
 * `<thought>` 内容作为 reasoning 增量流式输出（与 `delta.reasoning_content`
 * 行为一致，显示在 web 的 Think 区域而非正文），避免推理文本泄漏到用户
 * 可见区域。参考 DSML 官方介绍：
 * https://blog.csdn.net/gitblog_00855/article/details/152146045
 *
 * 设计要点：
 * - 增量友好：content 可能跨多个 SSE chunk 分片到达，提取器维护内部
 *   缓冲区与多模式状态机（normal / in-thought / in-dsml），仅对已完成
 *   的 DSML 块产出 tool-call；reasoning 增量流式输出；未完成部分保留
 *   到下次 feed；非 DSML/thought 文本立即 flush，避免延迟。
 * - 容错：若缓冲区包含开标签前缀但长时间未闭合，且后续内容不像该标签
 *   （例如只是普通文本里碰巧出现该前缀），在 flush 时把残留作为纯文本
 *   输出，避免吞掉用户可见内容。
 * - 边界：DSML 标签使用全角 `｜`（U+FF5C）而非半角 `|`，与模型实际
 *   输出一致。`<thought>` 为半角普通 XML 标签，与 DSML 官方文档一致。
 */
const DSML_TOOL_CALLS_OPEN = '<｜DSML｜tool_calls>'
const DSML_TOOL_CALLS_CLOSE = '</｜DSML｜tool_calls>'
const DSML_INVOKE_OPEN_PREFIX = '<｜DSML｜invoke'
const DSML_INVOKE_CLOSE = '</｜DSML｜invoke>'
const DSML_PARAM_OPEN_PREFIX = '<｜DSML｜parameter'
const DSML_PARAM_CLOSE = '</｜DSML｜parameter>'
const THOUGHT_OPEN = '<thought>'
const THOUGHT_CLOSE = '</thought>'

/** 解析单个 DSML invoke 块为 { name, arguments }。 */

/**
 * 对标记 string="true" 的参数值做宽松解析：若值恰好是 number/boolean
 * /null 字面量（如 "1304"、"true"、"null"），返回原始类型；若值是合法
 * JSON 数组或对象（如 todo_write 的 todos 被写成 `[{"content":...}]`），
 * 还原为原始类型；否则保持字符串。用于纠正模型对数字/数组/对象参数误标
 * string 的 DSML 输出（如 read 的 offset 被写成 offset="1304"、
 * todo_write 的 todos 被写成 string="true" 的 JSON 数组字符串），使工具
 * schema 校验通过。
 */
function tryParseScalar(value: string): unknown {
  if (value === '') return ''
  const trimmed = value.trim()
  if (trimmed === '') return value
  if (trimmed === 'null') return null
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  // 带引号的 JSON 字符串字面量：deepseek-v4-pro 常把数字/布尔参数值用
  // JSON 字符串编码（如 "840"），即便标记了 string="true" 也只输出引号
  // 包裹的字面量。先 JSON.parse 解码去掉外层引号，再递归尝试标量转换：
  // "840" → 840(number)、"true" → true(boolean)、"hello" → "hello"(string)。
  // 仅当整体是合法 JSON 字符串字面量（"..." 配对）时才解码，避免误伤
  // 含引号的普通文本（如路径中的引号片段）。flash 模型输出纯数字字面量
  // 不带引号，不会进入此分支；pro 模型带引号才命中，故 pro 出错多。
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded = JSON.parse(trimmed) as unknown
      if (typeof decoded === 'string') return tryParseScalar(decoded)
      return decoded
    } catch { /* 非合法 JSON 字符串字面量，按原样处理 */ }
  }
  // 整数 / 浮点数 / 负数：仅当整体匹配数字语法时才转换，避免误伤路径
  // 中的数字片段（如 "v1.2" 不含；"123abc" 不含）。
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number(trimmed)
  // 数组 / 对象：模型常对数组/对象参数（如 todo_write 的 todos）误标
  // string="true"，把 JSON 编码的数组/对象当作字符串输出。若值是合法
  // JSON 数组或对象，还原为原始类型，使工具 schema 校验通过。仅对
  // `[` / `{` 开头尝试 JSON.parse，避免误伤普通字符串（路径、正文等
  // 极少以这两个字符开头且整段恰为合法 JSON）。
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try { return JSON.parse(trimmed) } catch { /* 非合法 JSON，保持字符串 */ }
  }
  return value
}

function parseDsmlInvoke(block: string): { name: string; arguments: string } | undefined {
  // 提取 name="..." 属性
  const nameMatch = /name\s*=\s*"([^"]*)"/.exec(block)
  if (nameMatch === null) return undefined
  const name = nameMatch[1]
  // 提取所有 parameter 子节点，按出现顺序拼装 arguments JSON
  const params: Record<string, unknown> = {}
  let cursor = 0
  for (;;) {
    const openStart = block.indexOf(DSML_PARAM_OPEN_PREFIX, cursor)
    if (openStart === -1) break
    const openEnd = block.indexOf('>', openStart)
    if (openEnd === -1) break
    const openTag = block.slice(openStart, openEnd + 1)
    const paramNameMatch = /name\s*=\s*"([^"]*)"/.exec(openTag)
    if (paramNameMatch === null) { cursor = openEnd + 1; continue }
    const paramName = paramNameMatch[1]
    const closeStart = block.indexOf(DSML_PARAM_CLOSE, openEnd + 1)
    if (closeStart === -1) break
    const value = block.slice(openEnd + 1, closeStart)
    // string="true" 属性标记字符串类型。但模型经常对数字参数（如 read 的
    // offset/limit、write 的 offset）误标 string="true"，把 "1304" 当作字符串
    // 输出，工具 schema 校验报 `"offset" must be a number`。因此即使标记了
    // string，也尝试 JSON 解析：若是 number/boolean/null 字面量则按原始类型
    // 使用，其余（路径、正文等）保持字符串。
    const isString = /string\s*=\s*"true"/.test(openTag)
    if (isString) {
      const parsed = tryParseScalar(value)
      params[paramName] = parsed
    } else {
      // 非 string 参数理论上应是 number/array/object/boolean。但
      // deepseek-v4-pro 有时把数字参数值用 JSON 字符串引号包裹（如 "840"）
      // 且不加 string="true"：JSON.parse('"840"') 得到字符串 "840"，
      // schema 校验仍报 "offset" must be a number。对 JSON.parse 得到的
      // 字符串结果再走一次 tryParseScalar，把数字字面量还原为 number。
      try {
        const parsed = JSON.parse(value)
        params[paramName] = typeof parsed === 'string' ? tryParseScalar(parsed) : parsed
      } catch { params[paramName] = value }
    }
    cursor = closeStart + DSML_PARAM_CLOSE.length
  }
  return { name, arguments: JSON.stringify(params) }
}

/**
 * 从一段已闭合的 DSML tool_calls 块中解析所有 invoke，返回结构化
 * tool-call 列表。返回 undefined 表示解析失败（调用方应回退为纯文本）。
 */
function parseDsmlToolCalls(block: string): Array<{ name: string; arguments: string }> | undefined {
  // block 形如 `<｜DSML｜tool_calls>...invokes...</｜DSML｜tool_calls>`
  let inner = block
  if (inner.startsWith(DSML_TOOL_CALLS_OPEN)) inner = inner.slice(DSML_TOOL_CALLS_OPEN.length)
  if (inner.endsWith(DSML_TOOL_CALLS_CLOSE)) inner = inner.slice(0, inner.length - DSML_TOOL_CALLS_CLOSE.length)
  const calls: Array<{ name: string; arguments: string }> = []
  let cursor = 0
  for (;;) {
    const openStart = inner.indexOf(DSML_INVOKE_OPEN_PREFIX, cursor)
    if (openStart === -1) break
    const openEnd = inner.indexOf('>', openStart)
    if (openEnd === -1) break
    const closeStart = inner.indexOf(DSML_INVOKE_CLOSE, openEnd + 1)
    if (closeStart === -1) break
    const invokeBlock = inner.slice(openStart, closeStart + DSML_INVOKE_CLOSE.length)
    const parsed = parseDsmlInvoke(invokeBlock)
    if (parsed === undefined) return undefined
    calls.push(parsed)
    cursor = closeStart + DSML_INVOKE_CLOSE.length
  }
  return calls
}

/**
 * 计算缓冲区末尾与任一开标签的最长公共前缀长度。用于流式提取器决定
 * 保留多少缓冲区等待下次 feed：若末尾是某开标签的不完整前缀（例如
 * `<tho` 跨 chunk 到达），保留该前缀；否则全部放行，避免短文本被
 * 过度缓冲延迟输出。
 */
function longestOpenPrefixTail(buffer: string, prefixes: readonly string[]): number {
  let keepLen = 0
  const maxCheck = Math.min(buffer.length, Math.max(...prefixes.map(p => p.length)))
  for (let i = 1; i <= maxCheck; i++) {
    const tail = buffer.slice(buffer.length - i)
    if (prefixes.some(p => p.startsWith(tail))) keepLen = i
  }
  return keepLen
}

/**
 * 流式 DSML 提取器。feed() 接收 content delta，返回一个结果对象：
 * - `text`：应作为 text-delta 输出的纯文本（可能为空串）
 * - `reasoning`：应作为 reasoning-delta 输出的推理增量（可能为空串）
 * - `toolCalls`：已完整解析的 DSML tool-call 列表（可能为空数组）
 * flush() 在流结束时调用，把残留缓冲区作为纯文本返回。
 *
 * 状态机三态：
 * - normal：寻找 `<thought>` 或 `<｜DSML｜tool_calls>` 开标签
 * - in-thought：寻找 `</thought>` 闭标签，期间内容作为 reasoning 流式输出
 * - in-dsml：寻找 `</｜DSML｜tool_calls>` 闭标签，完整后解析为 tool-call
 */
class DsmlContentExtractor {
  private buffer = ''
  private state: 'normal' | 'in-thought' | 'in-dsml' = 'normal'

  feed(chunk: string): { text: string; reasoning: string; toolCalls: Array<{ name: string; arguments: string }> } {
    let text = ''
    let reasoning = ''
    const toolCalls: Array<{ name: string; arguments: string }> = []
    this.buffer += chunk
    for (;;) {
      if (this.state === 'normal') {
        // 寻找最早出现的开标签（thought 或 DSML tool_calls）
        const thoughtIdx = this.buffer.indexOf(THOUGHT_OPEN)
        const dsmlIdx = this.buffer.indexOf(DSML_TOOL_CALLS_OPEN)
        let openIdx = -1
        let nextState: 'in-thought' | 'in-dsml' = 'in-thought'
        if (thoughtIdx !== -1 && (dsmlIdx === -1 || thoughtIdx < dsmlIdx)) {
          openIdx = thoughtIdx
          nextState = 'in-thought'
        } else if (dsmlIdx !== -1) {
          openIdx = dsmlIdx
          nextState = 'in-dsml'
        }
        if (openIdx === -1) {
          // 没有完整开标签：但缓冲区末尾可能是任一开标签的不完整前缀
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_OPEN, DSML_TOOL_CALLS_OPEN])
          if (keepLen === 0) {
            text += this.buffer
            this.buffer = ''
          } else if (this.buffer.length > keepLen) {
            text += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          break
        }
        // 放行开标签之前的纯文本
        if (openIdx > 0) text += this.buffer.slice(0, openIdx)
        this.buffer = this.buffer.slice(openIdx)
        // 跳过开标签本身
        const openLen = nextState === 'in-thought' ? THOUGHT_OPEN.length : DSML_TOOL_CALLS_OPEN.length
        this.buffer = this.buffer.slice(openLen)
        this.state = nextState
        continue
      }
      if (this.state === 'in-thought') {
        // 寻找 </thought> 闭标签，期间内容作为 reasoning 流式输出
        const closeIdx = this.buffer.indexOf(THOUGHT_CLOSE)
        if (closeIdx === -1) {
          // 闭标签未到达：放行除可能的不完整闭标签前缀外的内容
          const keepLen = longestOpenPrefixTail(this.buffer, [THOUGHT_CLOSE])
          if (keepLen === 0) {
            reasoning += this.buffer
            this.buffer = ''
          } else if (this.buffer.length > keepLen) {
            reasoning += this.buffer.slice(0, this.buffer.length - keepLen)
            this.buffer = this.buffer.slice(this.buffer.length - keepLen)
          }
          break
        }
        // 放行闭标签之前的推理
        if (closeIdx > 0) reasoning += this.buffer.slice(0, closeIdx)
        this.buffer = this.buffer.slice(closeIdx + THOUGHT_CLOSE.length)
        this.state = 'normal'
        continue
      }
      // state === 'in-dsml'：寻找闭标签，完整块才解析
      const closeIdx = this.buffer.indexOf(DSML_TOOL_CALLS_CLOSE)
      if (closeIdx === -1) {
        // 闭标签未到达，等待更多数据
        break
      }
      const block = this.buffer.slice(0, closeIdx + DSML_TOOL_CALLS_CLOSE.length)
      const parsed = parseDsmlToolCalls(block)
      if (parsed === undefined) {
        // 解析失败：把整个块作为纯文本放行，避免吞内容
        text += block
      } else {
        toolCalls.push(...parsed)
      }
      this.buffer = this.buffer.slice(closeIdx + DSML_TOOL_CALLS_CLOSE.length)
      this.state = 'normal'
      continue
    }
    return { text, reasoning, toolCalls }
  }

  flush(): { text: string; reasoning: string } {
    // 流结束：残留缓冲根据状态决定输出通道
    const remaining = this.buffer
    this.buffer = ''
    if (this.state === 'in-thought') {
      // 不完整的 thought 块：作为 reasoning 放行（避免泄漏到正文）
      this.state = 'normal'
      return { text: '', reasoning: remaining }
    }
    if (this.state === 'in-dsml') {
      // 不完整的 DSML 块：开标签已在进入 in-dsml 状态时被消耗，需加回
      // 才能保持用户可见内容的完整性（避免 dump 出缺少开标签的残片）。
      this.state = 'normal'
      return { text: DSML_TOOL_CALLS_OPEN + remaining, reasoning: '' }
    }
    // normal 拘留：作为纯文本放行
    this.state = 'normal'
    return { text: remaining, reasoning: '' }
  }
}

/** 兼容 OpenAI 格式的 CodeArts 模型适配器，使用华为请求签名。 */
export class CodeArtsAdapter extends LlmAdapter {
  private readonly fetchImpl: typeof fetch
  private readonly chatId: string
  private readonly sessionId: string

  constructor(private readonly options: CodeArtsAdapterOptions) {
    super()
    this.fetchImpl = options.fetchImpl ?? directFetch
    this.chatId = options.chatId ?? crypto.randomUUID().replace(/-/g, '')
    this.sessionId = options.sessionId ?? crypto.randomUUID().replace(/-/g, '')
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 与 BuddyAdapter 同款防御：DSH 校验 `info.id === provider`，且模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部 `provider.toUpperCase()`）。
   * 入参异常时回退到 PROVIDER 常量，避免客户端抛
   * `undefined.toUpperCase is not a function`。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : PROVIDER
    return { id, name: 'CodeArts Agent' }
  }

  /** 动态模型缓存（首次 listModels 成功后填充）。 */
  private remoteModels: Array<{ id: string; name: string }> | undefined

  /**
   * 目录加载闸门：并发去重 + 失败冷却。
   *
   * ⚠ **不能省**：DSH 的 `buildModelCatalog` 对每个 provider `await listModels()`
   * 后再对每个模型 `await resolveModelInfo()`，两处都会走到这里。原实现失败
   * 直接返回（不落缓存）⇒ 一次网络故障被放大成「每模型重试一次」，每次顶着
   * 10s 超时（`src/models.ts:55 FETCH_TIMEOUT_MS`），首屏因此长时间空转。
   */
  private readonly catalogGate = new RemoteCatalogGate()

  /**
   * 懒加载远端模型目录。resolveModel 可能先于 listModels 被调用
   * （如直接进入会话），此时同样触发远端拉取。
   */
  private async ensureRemoteModels(): Promise<void> {
    const fetchRemote = this.options.fetchRemoteModels
    if (this.remoteModels !== undefined || fetchRemote === undefined) return
    await this.catalogGate.run(async () => {
      const models = await fetchRemote()
      // 空目录同样算「没拿到」：既不应落缓存（否则再也拉不回来），
      // 也不应立刻重试（否则每个模型都打一次空请求）。
      if (models.length === 0) return false
      this.remoteModels = models
      return true
    })
  }

  /**
   * 完整模型目录（**不应用用户黑名单**）。
   *
   * 设置页必须渲染被关闭的模型（否则用户无法重新打开），而 `listModels` 会按
   * 黑名单过滤掉它们 —— RPC 层只能凭裸 id 补回，展示名随之丢失
   * （用户报障：「关闭的就没有显示倍率」）。CodeArts 目录虽无倍率，但同样
   * 需要正确的 `name`（否则关闭项显示 `deepseek-v4-flash` 这类裸 id）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? DEFAULT_MODELS.map((id) => ({ id, name: id }))
    // 与 listModels 保持同一套「可见性」过滤（VL 多模态不参与），
    // 唯一区别是不套用户黑名单。
    return source
      .filter((m) => !/-VL-/i.test(m.id) && !/-VL$/i.test(m.id))
      .map((m) => ({ id: m.id, name: m.name }))
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 没有任何已登录账号时返回空数组 → DSH 的 `buildModelCatalog` 把整个
    // provider 分组隐藏（它显式 `.filter(group => group.models.length > 0)`）。
    // ⚠️ 必须返回 `[]` 而**不能抛错**（抛错会被归入 catalog 的 `failures`，
    // 界面上反而多出一条 provider 报错）。
    //
    // ⚠️ **CodeArts 不再有单凭据例外**：早期它额外把固定 ref
    // `CODEARTS_ACCESS_TOKEN` 计入判据（单凭据模式），该模式已随
    // `credentialRef` 回退解析一并移除 —— 六个 provider 现在判据完全一致，
    // 都只看账号池。
    //
    // ⚠️ 门控放在 `ensureRemoteModels()` **之前**：没有已登录账号时连远端目录都
    // 不必拉。
    if (!await providerCatalogVisible(this.options.accountPool, PROVIDER)) return []
    // 必须 await：ensureRemoteModels 是异步的，早期实现用 `void` 丢弃 Promise，
    // 冷缓存时远端目录尚未落地就走静态兜底表，模型选择器会短暂显示错误的
    // 模型集合（Channel Pack 的模型开关也据此渲染，会造成"关掉的模型又冒出来"）。
    await this.ensureRemoteModels()
    const visible = this.listAllModels()
    // 用户在 Channel Pack 关闭的模型（黑名单制：不在表里即默认打开）。
    // 只影响此处对外播报的模型目录，不改变 resolveModel/stream 的路由能力
    // ——与 DSH 对 listModels 的约定一致（目录是建议性的，缺省不构成拒绝）。
    const disabled = this.options.accountPool?.disabledModelsFor(PROVIDER)
    const listed = disabled === undefined || disabled.size === 0
      ? visible
      : visible.filter((m) => !disabled.has(m.id))
    return listed.map((m) => ({ provider: PROVIDER, id: m.id, name: m.name, inputModalities: ['text'] as const }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    await this.ensureRemoteModels()
    const remoteModel = this.remoteModels?.find((m) => m.id === model)
    const name = remoteModel?.name ?? model
    const contextWindow = CONTEXT_WINDOWS.get(model)
    const resolved: LlmResolvedModelInfo = { provider, id: model, name }
    if (contextWindow !== undefined) resolved.context = { contextWindow }
    // 思考开关（实测，2026-09-29）：本网关**唯一**真正生效的思考控制是
    // 顶层 `thinking.type`。`reasoning_effort`（含 low/high/none/minimal）与
    // 嵌套 `reasoning.effort` 都被服务端接受但**完全无效果**（判据为服务端
    // 上报的 reasoning_tokens，落在基线噪声内；`none` 也照常思考）。
    // 故这里只声明「开启 / 关闭」两档，**不**臆造 low/high/max 强度阶梯。
    resolved.reasoning = {
      efforts: [
        { id: ReasoningEffortId('on'), name: '开启' },
        { id: ReasoningEffortId('off'), name: '关闭' },
      ],
      defaultEffort: ReasoningEffortId('on'),
    }
    return resolved
  }

  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: { ...await this.resolveModel(provider, model, signal), inputModalities: ['text'] as const },
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential()
    if (credential === undefined || Date.parse(credential.expires_at) <= Date.now()) {
      await this.options.refresh()
      credential = await this.options.resolveCredential()
    }
    if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
      throw new LlmError('codearts: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    // Track current account id for rate limit tracking
    let currentAccountId = ''
    if (this.options.accountPool && credential?.access_key_id) {
      try {
        currentAccountId = await this.options.accountPool.findAccountIdByCredential(
          'codearts',
          credential.access_key_id,
        )
      } catch (error) {
        console.warn('[codearts] 账号匹配失败（不影响本次请求）:', error)
      }
      // Token 账本（第 2 期）：回报「本笔请求解析出的账号」（空串不回报）。
      if (currentAccountId) reportLedgerAccount(PROVIDER, currentAccountId)
    }

    const messages = serializeMessages(options.messages)
    // harness 的 GenerateOptions.system 是独立的系统提示（如标题生成的
    // systemPrompt、agent 的 persona）。后端 chat/completions 只接受
    // messages 数组里的 system 角色，必须显式插入——否则模型看不到
    // system 指令，只见到 user prompt 本身（实测 2026-08-22：session
    // 标题变成了 "We need to generate a session title..." 的 prompt 回显）。
    if (options.system !== undefined && options.system.length > 0) {
      messages.unshift({ role: 'system', content: options.system })
    }
    // 将 harness 工具模式以 OpenAI function 格式告知模型，
    // 与 deepseek 适配器序列化 GenerateOptions.tools 的方式一致。
    const tools = options.tools?.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }))
    // deepseek-v4 大文件写入修复（详见 isDeepseekV4Model 注释）：标准
    // tool_calls 参数一次性打包生成，SSE 静默 >60s 被网关掐断。仅当工具
    // 列表含大参数写文件类工具（write/file_write/apply_patch）时切换到
    // DSML：不发送 tools 字段、把 schema 注入 system 提示，让模型以
    // DSML 流式输出工具调用，全程有数据流、不触发网关空闲断连。read/
    // bash 等小参数工具保持标准 tool_calls，避免 DSML 带来的额外开销。
    let wireTools = tools
    if (wireTools !== undefined && needsDsmlToolMode(options.model, wireTools.map(tool => tool.function.name))) {
      // DSML 工具说明置于 system 之后、user 之前：与 CodeArts Agent IDE
      // 实际请求体一致（IDE 把工具说明作为 system 消息放在最前）。实证
      // （2026-08-22）：DSML 提示 push 到 messages 末尾时，deepseek-v4
      // 倾向把思考写入 content（正文）而非 reasoning_content；unshift 到
      // user 之前后模型恢复走 reasoning 通道，思考不再泄漏到正文。
      messages.splice(messages.findIndex(m => m.role === 'system') + 1, 0, { role: 'system', content: buildDsmlSystemPrompt(wireTools) })
      wireTools = undefined
    }
    const body = JSON.stringify({
      model: options.model,
      messages,
      stream: true,
      // prompt_cache_key 让服务端启用前缀缓存并在 usage 中返回 cached_tokens，
      // 缺少该字段时缓存命中恒为 0（实测 2026-08-24）。
      prompt_cache_key: this.sessionId,
      // include/reasoning_summary 对齐 Rust 端 CodeArtsExtraFields，
      // 让服务端返回加密 reasoning 内容与摘要。
      include: ['reasoning.encrypted_content'],
      reasoning_summary: 'auto',
      // 思考开关（实测，2026-09-29）：档位「关闭」翻成本网关真正认的字段。
      // ⚠️ 是**顶层** `thinking`，不是 raccoon 那种 `extra_body.thinking` 方言
      // （两者是不同网关的方言，混用会静默无效）。
      // 实测判据：`disabled` → reasoning_tokens 3/3 全为 0、正文仍正确；
      // `enabled` 与不传等价（服务端默认就开着），故「开启」档**不发**该字段。
      ...options.reasoningEffort === 'off' ? { thinking: { type: 'disabled' } } : {},
      // 对齐 CodeArts Agent IDE 请求体（deveco-code 内核日志实证）：
      // tool_stream=true 让后端将超大工具调用参数（如大文件 file_write）
      // 分段流式传输，避免单次 SSE 事件过大导致连接被掐断
      // （error decoding response body）。deepseek-v4 的 DSML 路径不受此
      // 影响，保留该字段与 IDE 对齐。
      tool_stream: true,
      // 输出上限（对齐 deveco-code-rust 参考实现 codearts.rs 的 max_tokens 配置）：
      // 大文件 write 工具参数（如 1000-2000+ 行文档）需要数万 token 的生成空间，
      // 若沿用后端默认输出上限，参数 JSON 会在中途被截断成非法 JSON，harness
      // 工具校验报 `invalid arguments: "arguments" must be an object`。
      // 参考实现 e2e 实测：65536 可用，131072 反而触发空流被后端拒绝；
      // 显式传入的 options.maxTokens 优先，未设置时默认 65536。
      max_tokens: options.maxTokens ?? 65536,
      ...wireTools !== undefined && wireTools.length > 0 ? { tools: wireTools } : {},
    })
    const url = `${CHAT_API_BASE}/chat/completions`

    // CodeArts 按账户限制并发：当会话上限
    // 达到时请求以 TM.00001041 失败（或 SSE 流内返回
    // InferHub.ModelArts.81111.429 等排队/限流错误）。对齐参考实现
    // （deveco-code-rust runner.rs）：排队时不等待状态端点
    // working，而是每 QUEUE_RETRY_DELAY_MS 直接重试 chat 请求，
    // 上限 QUEUE_MAX_ATTEMPTS 次（180 × 10s = 30 分钟）。
    let response: Response
    let queueAttempts = 0
    // 鉴权失败（APIG.0602 / 401 / 403）后已刷新过凭据：避免死循环，
    // 同一次 stream() 调用最多 refresh 一次。
    let authRefreshed = false
    // 该账号不带 benefit 包时去掉 `maas_type: benefit` 头重试一次：
    // 只试一次，避免与真实失败互相掩盖。
    let benefitHeaderDropped = false
    // 因限流已尝试过的账号 id：保证每个账号只试一次，试完才判定"全部受限"。
    const rateLimitTried = new Set<string>()
    if (currentAccountId) rateLimitTried.add(currentAccountId)
    // benefit（免费额度）模型判定在重试循环外先算好：它要读 benefit 集合缓存
    // （`~/.cache/deveco/codearts_benefit_models.json`），不宜每轮重试都做 IO。
    // 集合来自 gateway/config 的模型清单 ∪ 静态兜底（见 isCodeArtsBenefitModel），
    // 使后端新增 benefit 模型时无需改代码即可自动识别。
    const isBenefitModel = isCodeArtsBenefitModel(options.model)
    for (;;) {
      // benefit（免费额度）模型（glm-5.3-flash、deepseek-v4.1-flash 等）后端要求
      // maas_type: benefit 头参与 SDK-HMAC-SHA256 签名，否则返回
      // InferHub.002002009.404 "model is not registered"。
      //
      // 判定必须是**动态**的：早期只硬编码 glm-5.3-flash 一个模型，导致
      // deepseek-v4.1-flash 等其它 benefit 模型调用失败（用户报障：
      // 发消息后报 Insufficient Balance / QUOTA —— 缺该头时后端按非 benefit
      // 通道处理该模型）。实证见 CODEARTS_BENEFIT_FALLBACK 注释。
      const extraSignedHeaders = isBenefitModel && !benefitHeaderDropped ? { maas_type: 'benefit' } : undefined
      const signed = await signRequestHuawei(
        credential.access_key_id,
        credential.secret_access_key,
        credential.security_token,
        'POST',
        url,
        new TextEncoder().encode(body),
        extraSignedHeaders,
      )
      const headers = new Headers(attributionHeaders())
      // 签名 map 中的额外头（如 maas_type）必须随请求发送——它们已参与
      // canonical 计算、包含在 SignedHeaders 列表中，缺失会导致服务端验签失败。
      signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
      headers.set('Content-Type', 'application/json')
      headers.set('Chat-Id', this.chatId)
      headers.set('Session-Id', this.sessionId)
      headers.set('lang', 'en')

      response = await this.fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: options.signal,
      })
      if (response.ok) {
        // 200：消费 SSE 流。CodeArts 有时以 HTTP 200 + SSE 内嵌
        // error_code/error_msg 返回排队/限流（如 InferHub.ModelArts.81111.429
        // TPM 超限），而非 4xx——consumeSse 检测到可重试排队错误时抛
        // SseQueueRetryError，落入下方排队重试逻辑，与 TM.00001041 一致。
        try {
          yield* this.consumeSse(response, options)
          break
        } catch (error) {
          if (error instanceof SseQuotaExhaustedError) {
            // ── 额度用尽（InferHub.4291.200）：标记 + 换号 + 如实报出解禁时间 ──
            //
            // ⚠️ 这块**必须与排队分支分开**，且**不能** `continue` 去重试：
            // 额度是按自然日结算的确定性失败，重试 180 次（30 分钟）也还是同一个
            // 结果，只会让 UI 长期停在「运行中」且零输出 —— 那正是本次报障。
            //
            // 标记时限按 **UTC+8 当日 24:00** 推算（报文里没有时间字段），
            // 与 qoder / zcode 的额度处理同款。标记写进 `modelRateLimits` 后，
            // Channel Pack 的「限额重置 · <模型> · N 小时后」徽章与池的选号
            // （`getAvailableAccount` 会跳过未到期的账号）同时生效。
            const message = codeartsQuotaExhaustedMessage(options.model, nextUtc8DayStartMs())
            // ① 先给**当前**账号记上限流标记（UI 徽章与池的选号都依赖它）。
            if (this.options.accountPool && currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, options.model, nextUtc8DayStartMs(),
              )
              rateLimitTried.add(currentAccountId)
            }
            // ② 取下一个可用账号。
            //
            // ⚠️ 必须传 `tried`：池按用户手动顺序返回候选，**刚失败的账号可能仍排
            // 第一**（当失败类别不写标记时尤甚），不排除就会拿回同一个、命中
            // `tried.has` 而立即放弃切换（换号形同虚设）。
            if (this.options.accountPool) {
              const next = await this.options.accountPool.getAvailableAccount(
                'codearts', options.model, rateLimitTried,
              )
              if (next && !rateLimitTried.has(next.entry.id)) {
                rateLimitTried.add(next.entry.id)
                credential = next.credential as CodeArtsCredential
                currentAccountId = next.entry.id
                authRefreshed = false // 新凭据：重置「已刷新过」标记
                continue // 用下一个账号重试
              }
            }
            // ③ 没有可用账号（或没有账号池）：如实抛出，带上解禁时间。
            throw new LlmError(message, QUOTA_EXCEEDED_CODE, { status: 200 })
          }
          if (error instanceof SseQueueRetryError) {
            // 落入下方排队重试
          } else if (
            error instanceof LlmError
            && error.code === BENEFIT_NOT_FOUND_CODE
            && isBenefitModel
            && !benefitHeaderDropped
          ) {
            // 该账号没有 benefit 包：去掉 maas_type 头重试一次
            benefitHeaderDropped = true
            continue
          } else {
            throw error
          }
        }
      } else {
        const errorText = await response.text().catch(() => '')
        // 鉴权失败（SecurityToken 过期/被吊销/APIG.0602）：刷新一次凭据后
        // 重试整个 chat 请求。入口的 expires_at 预判无法覆盖后端提前吊销
        // 或时钟偏差场景，这里做兜底，避免把可自愈的鉴权失败抛给用户。
        if (isAuthError(response.status, errorText) && !authRefreshed) {
          authRefreshed = true
          await this.options.refresh()
          credential = await this.options.resolveCredential()
          if (credential === undefined || !credential.access_key_id || !credential.secret_access_key || !credential.security_token) {
            throw new LlmError('codearts: credential missing after refresh; log in again', 'MISSING_CREDENTIAL')
          }
          continue
        }
        // 额度用尽（**不可重试**）：与下面「限流/排队」是本质不同的两类。
        //
        // ⚠️ 必须在 `isRateLimited` **之前**判定：`insufficient quota` 这类文案
        // 若被限流判据先接走，就会被当成「重试可自愈」，而它其实是按自然日结算的
        // 确定性失败（同 `qoder` 的 `110` vs `10605` 那次教训）。
        // 实测该码主要走 SSE 通道（HTTP 200），但服务端同样可能以 4xx 下发 ——
        // 两条通道都接，避免哪天改了形态就漏（`AGENTS.md` 的既有铁律）。
        //
        // ⚠️ 判据用整个错误体（`errorDetail` 会拼出 `error_code` + `error_msg`）：
        // 4xx 的报文形态与 SSE 不同，不能指望顶层 `error_code` 字段名一致。
        if (isSseQuotaExhaustedErrorCode(errorDetail(errorText), errorText)) {
          const message = codeartsQuotaExhaustedMessage(options.model, nextUtc8DayStartMs())
          if (this.options.accountPool) {
            if (currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, options.model, nextUtc8DayStartMs(),
              )
              rateLimitTried.add(currentAccountId)
            }
            const next = await this.options.accountPool.getAvailableAccount(
              'codearts', options.model, rateLimitTried,
            )
            if (next && !rateLimitTried.has(next.entry.id)) {
              rateLimitTried.add(next.entry.id)
              credential = next.credential as CodeArtsCredential
              currentAccountId = next.entry.id
              authRefreshed = false
              continue
            }
          }
          throw new LlmError(message, QUOTA_EXCEEDED_CODE, { status: response.status })
        }
        // 限流处理：记录当前账号在该模型上的重置时间，然后切换账号重试
        // （外层 for(;;) 会在拿到新凭据后重新签名发请求）。用 tried 集合
        // 保证每个账号只尝试一次，试完才判定"全部受限"——避免只试一个
        // 就下结论，导致 UI 限流状态与实际判定不一致。
        //
        // ⚠️ 必须把 `response.status` 一并传入：服务端可能返回**空体**的 429，
        // 而只按正文判定时对空体恒为 false → 整段换号逻辑被跳过，本可自愈的
        // 限流被直接抛给用户（见 `isRateLimited` 的说明）。
        if (this.options.accountPool && isRateLimited(errorText, response.status)) {
          // ⚠️ 状态码必须传到 `parseRateLimitError` —— **与上面外层判据同源**。
          // 空体 429 时 `isRateLimited` 因状态码判真而放行进来，但只按正文解析的
          // `parseRateLimitError` 返回 `null`，下面的 `if (parsed)` 会把**整块**
          // （写限流标记 + 换号 + `continue`）一起跳过：既不换号、也不落标记，
          // 最终按原错误抛出 —— 「空体 429 在 CodeArts 上依旧不自愈」。
          // 这正是本补丁要修的缺陷，本处是第三条（也是最后一条）调用点。
          const parsed = parseRateLimitError(errorText, options.model, response.status)
          if (parsed) {
            if (currentAccountId) {
              await this.options.accountPool.updateModelRateLimit(
                currentAccountId, parsed.modelId, parsed.resetTimeMs,
              )
            }
            const next = await this.options.accountPool.getAvailableAccount('codearts', options.model)
            if (next && !rateLimitTried.has(next.entry.id)) {
              rateLimitTried.add(next.entry.id)
              credential = next.credential as CodeArtsCredential
              currentAccountId = next.entry.id
              authRefreshed = false // Reset auth refresh flag for new credential
              continue // Retry request with new credential
            }
            throw new LlmError(
              `codearts: 模型 ${options.model} 所有账号均受限，请稍后再试`,
              'QUOTA_EXCEEDED',
            )
          }
        }
        if (!isQueueError(response.status, errorText)) {
          // 非 TM.00001041 错误也未必没排队：openpangu 等模型的并发限流
          // 错误码/HTTP 状态可能与 GLM 不同，但仍会进入后端队列。先探测
          // 排队状态端点——只有端点确认会话在排队（waiting/queue_full）时
          // 才进入排队流程；端点不可达或未排队（working）则按原错误分类
          // 立即抛出，避免把真错误（如 401/400）拖成 30 分钟超时。
          const probe = await this.queryQueueStatus(credential, options.model, options.signal)
          if (probe === undefined || probe.status === 'working') {
            // 与 deepseek 适配器的 httpErrorCode 词汇保持一致；
            // 400 + 上下文超限措辞归为 CONTEXT_WINDOW_EXCEEDED（触发 compaction）。
            const code = httpErrorCode(response.status, errorText)
            throw new LlmError(`codearts: model request failed with HTTP ${response.status}`, code, { status: response.status })
          }
          // probe.status 为 'waiting' 或 'queue_full' → 落入下方排队流程。
        }
      }
      // TM.00001041 / 状态端点确认排队 / SSE 内排队错误：对齐参考实现
      // 直接重试 chat 请求，每 QUEUE_RETRY_DELAY_MS（10s）一次，上限
      // QUEUE_MAX_ATTEMPTS（180）次，不等待状态端点 working。排队期间
      // 不产出任何内容块（StreamChunk 协议没有独立的瞬态状态通道，
      // 任何 reasoning/text 块都会被 BlockAssembler 组装进 assistant
      // 消息并持久化到会话历史，reasoning 块还会显示在 web 的 Think
      // 区域，且 visible 回退可能把推理文本作为正文回传给模型），因此
      // 保持静默，web 显示 harness 自身的"运行中"状态。每次重试前查询
      // 状态端点：终态（error/queue_full）立即抛错，其余情况
      // （waiting/working/端点不可达）等待后直接重试 chat。
      queueAttempts += 1
      if (queueAttempts > QUEUE_MAX_ATTEMPTS) {
        throw new LlmError('codearts: queue wait timed out after 30 minutes', 'QUEUE')
      }
      if (options.signal?.aborted) throw new LlmError('codearts: request aborted while waiting in queue', 'QUEUE')
      const status = await this.queryQueueStatus(credential, options.model, options.signal)
      if (status?.status === 'error' || status?.status === 'queue_full') {
        throw new LlmError(`codearts: ${status.message || `queue status: ${status.status}`}`, 'QUEUE')
      }
      await delay(QUEUE_RETRY_DELAY_MS, options.signal)
      // 直接重试 chat 请求（外层 for(;;) 循环）
    }
  }

  /**
   * 消费一个 HTTP 200 的 SSE chat 响应并产出 StreamChunk。
   *
   * CodeArts 后端有时以 HTTP 200 + SSE 内嵌错误事件的形式返回排队/限流
   * （如 `InferHub.ModelArts.81111.429` TPM 超限，事件形如
   * `{"text":"[DONE]","error_code":"...","error_msg":"..."}`），而不是
   * 4xx——这类错误若直接当成流结束会被静默吞掉（表现为"思考后无输出"）。
   * 本方法解析每个 SSE 事件的 `error_code`/`error_msg`：可重试的排队/限流
   * 错误抛 {@link SseQueueRetryError} 让外层重试循环按 TM.00001041 同等
   * 处理（10s 间隔重试整个 chat 请求）；不可重试错误抛普通 LlmError。
   */
  private async *consumeSse(
    response: Response,
    options: GenerateOptions,
  ): AsyncIterable<StreamChunk> {
    if (!response.body) throw new LlmError('codearts: empty model response body', 'EMPTY_RESPONSE')
    // 块组装状态：文本 / 推理 / 工具调用各自拥有唯一
    // 索引，与 harness StreamChunk→ContentBlock 契约一致。
    const blocks: Array<{
      index: number
      kind: 'text' | 'reasoning'
      text: string
    }> = []
    let nextIndex = 0
    const toolCalls = new Map<number, {
      index: number
      text: string
      callId?: string
      name?: string
      /** 是否已发过 `block-start`（名字可用的那一刻才发，见下方 tool_calls 分支）。 */
      announced: boolean
    }>()
    const toolOrder: number[] = []
    /**
     * `tool_call` 分片 index → 后端签发的真实 id。
     *
     * ⚠️ **本兜底不可省略**（真实缺陷，2026-09-29 定位）：OpenAI 兼容协议里
     * `id` 只在**首个**分片出现，但实测华为侧偶发**完全不返回 `id`**（或返回空串）。
     * 早期实现直接把 `call.id` 写进 `block.callId`，缺失时落成**空串** id，
     * 于是 assistant 消息里留下 `{type:'tool-call', id:''}`：
     *
     * 1. `tool/call` 带着 `callId:''` 被持久化；
     * 2. 该调用完成后写 `tool/result` 时，DSH 的格式 v4 校验
     *    （`assertV4ToolResultMessage`）要求 `message.toolCallId === source.callId`
     *    且**都非空**，于是抛
     *    `format v4 tool/result at seq N requires toolCallId matching its tool source`；
     * 3. 该轮直接失败，且**会话永久报废** —— 日志停在 `tool/call`，崩溃恢复
     *    (`interruptedTurnClosers`) 按空 callId 合成修补结果时**再次**命中同一校验，
     *    既写不进也修不好。
     *
     * 空 id 同样过不了 `SessionFormatError`（它判 `length === 0`），故判据必须是
     * 「非空字符串」而不是「!== undefined」。
     *
     * 兄弟适配器（`openai-compat.ts` / `buddy-adapter.ts` / `lobsterai-adapter.ts` /
     * `trae-adapter.ts`）**都**有这层 `toolIds` 兜底，只有本文件漏了 —— 这正是
     * 该缺陷只在 `codearts` provider 复现的原因。
     *
     * ⚠️ 兜底 id 用 `call_${wireIndex}` 而非随机值：同一次响应内 index 唯一，
     * 且它必须是**稳定**的 —— 后续分片每片都要得到同一个 id。
     */
    const toolIds = new Map<number, string>()
    let buffer = ''
    let streamEnded = false
    let finishReason: 'stop' | 'tool_calls' | 'length' | undefined
    /**
     * 思考死循环检测（见 `createReasoningLoopDetector`）。命中后丢弃后续
     * reasoning 增量，收尾时发截断后的 block，并让 finish 报 max-tokens。
     *
     * 本适配器有**两处** reasoning 出口，两处都必须喂入同一判据（漏一处
     * 就等于漏一条路径）：① `emitDsmlFeed` 的 `reasoning` 聚合参数；
     * ② `delta.reasoning_content` → `dsmlReasoningExtractor` → `thinking`。
     */
    const loopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let loopDetected = false
    /**
     * **正文**死循环检测（**独立实例**，见 `createReasoningLoopDetector`）。
     *
     * 真实缺陷（用户报障，2026-09-25）：唯一活动 session 出现**正文**循环，
     * 而旧实现只在 reasoning 分支调 `observe` → 正文循环完全看不见。
     *
     * ⚠️ 两个实例不可合并：判据看尾部 3000 字符窗口的行去重率，两条通道
     * 混进同一窗口会互相稀释，使守卫双双失效。
     *
     * ⚠️ 语义差异：实测正文循环的工具调用在循环正文**之后**到达且有效，
     * 故正文守卫**只截断文本**，绝不 `reader.cancel()`、绝不改 finish reason。
     *
     * ⚠️ **本适配器刻意不做 `</think:hex>` 归位**（与其余四个适配器不同）：
     * 实测那 28 处标签**全部出自 `workbuddy`**（`hy4-preview-f` 25 处、
     * `workbuddy/deepseek-v4.1-flash` 3 处），codearts 一条都没有。
     * 更关键的是，本适配器的正文出口带 **`visible` 回退**（正文为空且无工具
     * 调用时用推理文本回填可见区）—— 若在此处把正文归位成空串，回退会立刻
     * 把整段思考**复制回正文**，等于归位失效并放大问题。故此处只加守卫。
     */
    const proseLoopGuard = isReasoningLoopGuardEnabled() ? createReasoningLoopDetector() : undefined
    let proseLoopDetected = false
    /**
     * 纯空白思考抑制器（见 `createBlankReasoningSuppressor`）。与 `blocks` /
     * `loopGuard` 同生命周期：**每个 `stream()` 调用建一个实例**。
     *
     * ⚠️ **本适配器的两个 reasoning 出口必须共用这一个实例**：
     * ① `emitDsmlFeed` 的 `reasoning` 参数、② `delta.reasoning_content` →
     * `thinking`。两处都用 `blocks.find(kind === 'reasoning')` 找**同一个**
     * reasoning 块 —— 若各持一个 helper，第二处就会从空态重新开始累积
     * （明明已有非空白内容却被判为「至今仍空白」），`text()` 也随之错乱。
     *
     * 为什么必须延后建块：`BlockAssembler` 在**没有 `block-end`** 时同样会用
     * `partial.text` 组装出块，故只在出口过滤挡不住空 Think 块 —— 必须从一开始
     * 就不发任何 chunk（与「空名字 tool_call」同型修法）。
     */
    const suppressor = createBlankReasoningSuppressor()
    const proseSuppressor = createBlankReasoningSuppressor()
    // DSML 提取器：从 delta.content 中识别模型以原生 DSML XML 风格
    // 写入的工具调用（deepseek-v4 等模型在工具模式不匹配时会直接
    // 输出 `<｜DSML｜tool_calls>...`），解析为结构化 tool-call，
    // 避免原始 token 泄漏到 web UI。
    // content 与 reasoning_content 两个通道使用各自独立的 DSML 提取器。
    // 早期实现共用单个提取器，但 deepseek-v4 有时在 content 通道输出
    // <thought> 开标签（提取器进入 in-thought 状态）后，把后续推理与
    // DSML 工具调用写到 reasoning_content 通道——共用提取器会把
    // reasoning_content 的 DSML 块当作 thought 内容吞掉，不解析为
    // tool-call，最终残留 DSML 标签经 visible 回退泄漏到正文（实测
    // session-067dcf78 turn1 step13 / turn2 step3）。独立提取器让各
    // 通道状态机互不污染。
    const dsmlContentExtractor = new DsmlContentExtractor()
    const dsmlReasoningExtractor = new DsmlContentExtractor()
    // 分流 DSML 提取结果：正文文本进入 text 块、thought 进入 reasoning
    // 块、解析出的工具调用进入 tool-call 块。
    async function* emitDsmlFeed(
      text: string,
      reasoning: string,
      dsmlCalls: Array<{ name: string; arguments: string }>,
    ): AsyncIterable<StreamChunk> {
      const textDelta = text.length > 0 ? proseSuppressor.feed(text) : undefined
      if (textDelta !== undefined) {
        let block = blocks.find(candidate => candidate.kind === 'text')
        if (block === undefined) {
          block = { index: nextIndex++, kind: 'text', text: '' }
          blocks.push(block)
          yield { type: 'block-start', index: block.index, blockType: 'text' }
        }
        // 正文死循环守卫（见 `proseLoopGuard` 注释）。命中后只停止累积与发射，
        // 绝不 `reader.cancel()`、绝不改 finish reason。
        if (proseLoopGuard !== undefined) {
          if (proseLoopGuard.observe(textDelta)) proseLoopDetected = true
        }
        if (!proseLoopDetected) {
          block.text += textDelta
          yield { type: 'text-delta', index: block.index, text: textDelta }
        }
      }
      if (reasoning.length > 0) {
        // 死循环守卫：命中后不再累积、不再发射。
        //
        // ⚠️ 这里**只跳过发射**：真正的止损（`reader.cancel()` + `break`）在
        // 本 chunk 的行循环**全部处理完之后**、外层 `for (;;)` 末尾执行（见下方
        // ★ 止损块）—— 这样同一 chunk 里已到达的 usage / [DONE] 仍会被处理。
        // 若在此处直接 `break`，本 chunk 剩余的行会被整块跳过。
        // ⚠️ 也**不能用 `continue`**（Task 2 审查发现并已实测复现）：它会
        // 连带跳过**同一帧内**位于本分支之后的处理（`usage` 记账、DSML
        // tool-call 解析），导致 token 统计静默丢失。故用 `if (!loopDetected)`
        // 守卫分支体。
        if (loopGuard !== undefined) {
          if (loopGuard.observe(reasoning)) loopDetected = true
        }
        if (!loopDetected) {
          // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发，
          // 于是既不建块、也不消耗 `nextIndex`（见 helper 注释）。
          const emit = suppressor.feed(reasoning)
          if (emit !== undefined) {
            let block = blocks.find(candidate => candidate.kind === 'reasoning')
            if (block === undefined) {
              block = { index: nextIndex++, kind: 'reasoning', text: '' }
              blocks.push(block)
              yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
            }
            // ⚠️ **整块回写**（赋值，不是 `+=`）：helper 内部已累积全部文本，
            // 用 `+=` 会双写。本适配器两个出口共用同一 helper，故回写值恒为
            // 两处共同累积的完整文本。
            block.text = suppressor.text()
            yield { type: 'reasoning-delta', index: block.index, text: emit }
          }
        }
      }
      for (const call of dsmlCalls) {
        // 与 delta 路径同一条判据：名字不可用的调用**一个 chunk 都不产出**
        // （否则 `BlockAssembler` 会组装出 `name:''` 的块并污染会话，
        // 让下游端点以 400 code 11133 拒绝之后每一次请求）。
        if (!hasUsableToolName(call.name)) continue
        const wireIndex = toolCalls.size
        // DSML 语法没有 provider 签发的 call id，必须生成唯一 id：
        // harness 的 tool/call ↔ tool/result 配对与 web UI 的工具行
        // 渲染都用 callId 作为 key（见 client-runtime 匹配器
        // `tool/call -> id: String(callId)`），空 id 会让同一响应的
        // 多个工具调用（或历史重放）配对冲突，UI 只能回退为泛化的
        // "Tool call" 行而丢失 read/write 专属控件。
        const block = {
          index: nextIndex++,
          text: call.arguments,
          name: call.name,
          callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
          announced: true,
        }
        toolCalls.set(wireIndex, block)
        toolOrder.push(block.index)
        yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
        yield {
          type: 'tool-call-delta',
          index: block.index,
          id: block.callId,
          name: block.name,
          argumentsDelta: call.arguments,
        }
      }
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    // 首 token 与 chunk 间超时分阶段使用（对齐 CodeArts Agent IDE）：
    // 第一次读取用 firstTokenTimeout（5min），收到首 chunk 后切换为
    // chunkTimeout（10min），并在每次成功读取后重置。deepseek-v4-flash
    // 生成大文件 write 的 content 参数时，首 token 后可能长时间静默，
    // 需要远大于网关 60s 的窗口才不会误判可重试 TIMEOUT 而反复重试。
    let firstTokenReceived = false
    try {
      for (;;) {
        if (streamEnded) break
        // CodeArts 网关对 SSE 有 ~60s 空闲超时：模型生成长推理 / 大工具
        // 参数时两次 chunk 间可能静默数十秒，连接被对端掐断后 reader.read()
        // 抛 `TypeError: terminated`（非 HarnessError → UNKNOWN 不可重试 →
        // harness 直接失败）。以略小于网关超时的窗口主动检测空闲：超时则
        // 取消 reader 并抛可重试 TIMEOUT；同时把传输级错误映射为可重试
        // TRANSPORT，让 harness 重试该步骤而非直接失败。
        let done: boolean
        let value: Uint8Array | undefined
        try {
          const timeoutMs = firstTokenReceived ? resolveChunkTimeoutMs() : resolveFirstTokenTimeoutMs()
          const phase = firstTokenReceived ? 'chunk' : 'first-token'
          const result = await readCodeArtsChunk(reader, timeoutMs, options.signal, phase)
          done = result.done
          value = result.value
          if (!done) firstTokenReceived = true
        } catch (error) {
          if (options.signal?.aborted) throw error
          if (error instanceof LlmError) throw error
          if (isTransportError(error)) {
            throw new LlmError(`codearts: sse transport error: ${errorMessage(error)}`, 'TRANSPORT', { cause: error })
          }
          throw error
        }
        if (done) break
        buffer += decoder.decode(value!, { stream: true })
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
            error_code?: string | number
            error_msg?: string
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
            usage?: Record<string, number>
          }
          try {
            data = JSON.parse(payload)
          } catch {
            continue
          }
          // SSE 内嵌错误检测：CodeArts 以 HTTP 200 + error_code/error_msg
          // 返回排队/限流（如 InferHub.ModelArts.81111.429 TPM 超限）。
          if ((typeof data.error_code === 'string' && data.error_code.length > 0) || data.error_code === 4004) {
            const errorCode = String(data.error_code)
            const message = typeof data.error_msg === 'string' && data.error_msg.length > 0
              ? data.error_msg
              : errorCode
            // ⚠️ 顺序不可颠倒：额度耗尽（InferHub.4291.200）必须**先**于排队判据
            // 检查。历史上它们混淆过一次 —— `4291` 被 `429` 的裸子串匹配吃掉，
            // 额度错误因此被当成「可重试的排队」，进入 30 分钟静默重试循环，
            // 界面零输出（用户报障「没反应」的直接原因）。
            // 现在两个判据已互斥（裸 `429` 已锚定为独立数字），这里的先后仍保留：
            // 它把「额度优先」表达成代码结构，防止后续再有人放宽 `429` 判据。
            if (isSseQuotaExhaustedErrorCode(errorCode, message)) {
              throw new SseQuotaExhaustedError(errorCode, message)
            }
            if (isSseQueueErrorCode(errorCode)) {
              throw new SseQueueRetryError(errorCode, message)
            }
            if (errorCode === CODEARTS_BENEFIT_NOT_FOUND_ERROR_CODE || errorCode === '4004') {
              // 账号没有 benefit 包（积分制账户）：交给 stream() 去掉该头重试
              throw new LlmError(`codearts: ${message}`, BENEFIT_NOT_FOUND_CODE, { status: 200 })
            }
            throw new LlmError(`codearts: ${message}`, 'INVALID_REQUEST', { status: 200 })
          }
          const choice = data.choices?.[0]
          const delta = choice?.delta
          if (typeof choice?.finish_reason === 'string') {
            finishReason = choice.finish_reason as 'stop' | 'tool_calls' | 'length'
          }
          if (delta?.content) {
            // 通过 DSML 提取器：纯文本作为 text-delta 放行，
            // <thought> 内容作为 reasoning-delta 放行（显示在 Think 区域），
            // DSML 块解析为结构化 tool-call（与 delta.tool_calls 路径
            // 合并到同一 toolCalls/toolOrder 状态）。
            const { text, reasoning, toolCalls: dsmlCalls } = dsmlContentExtractor.feed(delta.content)
            yield* emitDsmlFeed(text, reasoning, dsmlCalls)
          }
          if (delta?.reasoning_content) {
            // 模型放在 reasoning_content 通道的内容就是思考，必须进入
            // reasoning 块（Think 区域），绝不能作为正文输出。实测
            // （2026-08-22）：deepseek-v4-flash 的 reasoning_content 通常
            // 没有 <thought> 标签，提取器会把整段当作 `text` 返回——若把
            // `text` 发给正文块，思考就泄漏到正文（TUI 显示 The user wants
            // me to... 跑到正文）。因此这里把 `text + reasoning` 合并后
            // 全部作为 reasoning 输出，仅 DSML 工具调用块单独解析执行。
            const { text, reasoning, toolCalls: reasoningDsmlCalls } = dsmlReasoningExtractor.feed(delta.reasoning_content)
            const thinking = text + reasoning
            if (thinking.length > 0) {
              // 死循环守卫：与上面 `emitDsmlFeed` 的 `reasoning` 分支同一判据，
              // 两条出口都要接（漏一处就等于漏一条路径）。
              //
              // ⚠️ 守卫必须**同时包住** `block.text += thinking` 与 `yield`
              // 两行 —— 只拦 yield 的话，累积文本仍含循环内容，收尾的截断
              // 就失效了。这里**只跳过发射**：止损（`reader.cancel()` + `break`）
              // 在本 chunk 行循环处理完之后执行（见下方 ★ 止损块），故同帧的
              // usage 记账不受影响；**也不能用 `continue`**（会连带跳过本帧
              // 之后的 usage 记账）。
              if (loopGuard !== undefined) {
                if (loopGuard.observe(thinking)) loopDetected = true
              }
              if (!loopDetected) {
                // 纯空白思考：`emit === undefined` ⇒ 本片一个 chunk 都不发。
                // ⚠️ 与出口①共用**同一个** `suppressor`：两处落在同一个
                // `blocks.find(kind === 'reasoning')` 块上，各自累积会错乱
                // （出口②会误判「整块迄今仍空白」而丢弃本已有内容的块）。
                const emit = suppressor.feed(thinking)
                if (emit !== undefined) {
                  let block = blocks.find(candidate => candidate.kind === 'reasoning')
                  if (block === undefined) {
                    block = { index: nextIndex++, kind: 'reasoning', text: '' }
                    blocks.push(block)
                    yield { type: 'block-start', index: block.index, blockType: 'reasoning' }
                  }
                  // ⚠️ **整块回写**（赋值，不是 `+=`）。
                  block.text = suppressor.text()
                  yield { type: 'reasoning-delta', index: block.index, text: emit }
                }
              }
            }
            for (const call of reasoningDsmlCalls) {
              // 同 delta 路径：名字不可用者一个 chunk 都不产出（见上）。
              if (!hasUsableToolName(call.name)) continue
              const wireIndex = toolCalls.size
              const block = {
                index: nextIndex++,
                text: call.arguments,
                name: call.name,
                callId: ToolCallId(`dsml-${crypto.randomUUID().replace(/-/g, '')}`),
                announced: true,
              }
              toolCalls.set(wireIndex, block)
              toolOrder.push(block.index)
              yield { type: 'block-start', index: block.index, blockType: 'tool-call' }
              yield {
                type: 'tool-call-delta',
                index: block.index,
                id: block.callId,
                name: block.name,
                argumentsDelta: call.arguments,
              }
            }
          }
          for (const call of delta?.tool_calls ?? []) {
            const wireIndex = call.index ?? 0
            // ⚠️ 只接受**非空** id 并记住它：后续分片可能新一轮又给空串/缺失，
            // 无条件覆盖会把首片拿到的真实 id 抹成空（与 `function.name` 同因）。
            if (typeof call.id === 'string' && call.id.length > 0) toolIds.set(wireIndex, call.id)
            const callId = toolIds.get(wireIndex) ?? `call_${wireIndex}`
            let block = toolCalls.get(wireIndex)
            if (block === undefined) {
              block = { index: nextIndex++, text: '', announced: false }
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
            // ⚠️ **名称为空前不发射任何 chunk**（与 `openai-compat.ts` / `buddy-adapter.ts`
            // 同因同修）。只跳过收尾的 `block-end` 不够 —— `BlockAssembler`
            // 会把没有 block-end 的 partial 也组装成 `name:''`，污染会话后让
            // 腾讯系端点以 400 code 11133 拒绝之后每一次请求。
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
            const cachedTokens = (data.usage as { prompt_tokens_details?: { cached_tokens?: number } }).prompt_tokens_details?.cached_tokens
              ?? (data.usage as { prompt_cache_hit_tokens?: number }).prompt_cache_hit_tokens
              ?? 0
            const cacheWriteTokens = (data.usage as { prompt_tokens_details?: { cache_write_tokens?: number } }).prompt_tokens_details?.cache_write_tokens
            const reasoningTokens = (data.usage as { completion_tokens_details?: { reasoning_tokens?: number } }).completion_tokens_details?.reasoning_tokens
            yield {
              type: 'usage',
              usage: {
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
    // 流结束：分别 flush content 与 reasoning_content 两个独立 DSML 提取器。
    // 若模型输出了不完整的 DSML 块（被 max_tokens 截断或模型异常终止），
    // 残留内容作为纯文本放行，避免吞掉用户可见内容；不完整的 <thought>
    // 块作为 reasoning 放行，避免推理泄漏到正文；同时让 finish_reason='length'
    // 路径生效，触发 harness max-tokens 续写而非执行不完整工具调用。
    // 复用 emitDsmlFeed 把残留 text/reasoning 路由到对应块。
    {
      const f = dsmlContentExtractor.flush()
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, [])
    }
    {
      const f = dsmlReasoningExtractor.flush()
      if (f.text.length > 0 || f.reasoning.length > 0) yield* emitDsmlFeed(f.text, f.reasoning, [])
    }
    // 按创建顺序关闭每个块。GLM 端点偶尔把整个回答作为 reasoning_content
    // 发出且 content 为空：此时正文区为空，回退用推理文本填充可见区。
    // 但若推理中解析出了 DSML 工具调用（deepseek-v4 的 reasoning_content
    // 内嵌工具块），正文由工具调用承担，不再把推理复制为可见文本。
    const textBlock = blocks.find(block => block.kind === 'text')
    const reasoningBlock = blocks.find(block => block.kind === 'reasoning')
    // 命中死循环时只保留循环前的干净前缀（`cutAt`）。`block-end` 是
    // **权威覆盖**（已由 `scripts/verify-blockend-override.ts` 实证）：
    // 即便前面已 yield 了全部重复 delta，这里发截断后的 block 即可，无需撤回。
    //
    // ⚠️ 行首 `course` / `课` 泄漏清洗（`stripCourseLeak`）**在此处一次性完成**：
    // `reasoningText` 同时供 `reasoningHasDsml` 判定、`visible` 回退与
    // reasoning `block-end` 使用，故在此清洗可覆盖全部三处出口，
    // 不会出现「正文干净而 Think 区仍脏」或反之的不一致。
    const reasoningText = stripCourseLeakIfEnabled(
      loopDetected && loopGuard?.cutAt !== undefined
        // ⚠️ 文本以 helper 为权威（`suppressor.text()`），**不用**
        // `reasoningBlock.text` —— 两个出口共用同一 helper，以它为准才能保证
        // 累积口径一致；`reasoningBlock` 仅用于取块 `index`。
        ? suppressor.text().slice(0, loopGuard.cutAt)
        : suppressor.text(),
    )
    // visible 回退：正文为空且无工具调用时，用推理文本填充可见区（GLM 端点
    // 偶尔把整个回答作为 reasoning_content 输出）。但若推理含 DSML 标签
    // （deepseek-v4 在推理中引用 DSML 语法讨论实现方案，非完整工具调用块），
    // 不能复制为正文——DSML 标签泄漏到正文会被模型当用户输入，导致任务
    // 终止或循环（实测 session-a69fa289 turn2 step26：推理仅含 DSML 闭合
    // 标签片段，visible 回退复制到正文后任务终止）。此时正文留空，推理仍
    // 在 Think 区域可见。
    //
    // ⚠️ 回退必须用**截断后**的 `reasoningText`，不能用 `reasoningBlock.text`：
    // 命中死循环时正文恰好为空且无工具调用，用原文会把病态循环全文复制进
    // 正文块并持久化，下次重放又要重新吃一遍（正是本守卫要根除的问题）。
    const reasoningHasDsml = reasoningText.includes('｜DSML｜')
    // ⚠️ 正文出口也必须清洗 —— 不能只清 reasoning。
    //
    // 本适配器的 `visible` 有**两条来源**：正文块，或（正文为空且无工具调用时的）
    // reasoning 回退。初版只对 reasoning 侧调了 `stripCourseLeakIfEnabled`，
    // 正文侧直接取 `textBlock.text` 原值 —— 于是「正文块里带行首泄漏」这一路径
    // 完全没被覆盖，`block-end` 发出去的仍是脏文本（同型缺陷见
    // `buddy-adapter.ts` / `lobsterai-adapter.ts` / `trae-adapter.ts` 的
    // text 出口，那几处均已清洗）。
    //
    // 清洗放在**取值处**而非 `block-end` 处：`visible` 同时供 text `block-end`
    // 与下方回退判定使用，在此清洗可保证两条出口一致（不会出现「正文块干净、
    // 回退脏」或反之）。`reasoningText` 已是清洗后的值，故回退分支无需再清。
    // 正文死循环截断：只保留循环前的干净前缀。
    // ⚠️ **不改 finish reason**：工具调用仍要被执行。
    //
    // ⚠️ 截断必须在 `visible` 回退**之前**应用：否则「正文命中循环 → 截断后为空
    // → 回退又把推理文本复制进正文」会把病态循环原样搬到可见区。
    const truncatedText = proseLoopDetected && proseLoopGuard?.cutAt !== undefined
      ? (textBlock?.text ?? '').slice(0, proseLoopGuard.cutAt)
      : undefined
    const visible = truncatedText !== undefined
      ? stripCourseLeakIfEnabled(truncatedText)
      : textBlock !== undefined && textBlock.text !== ''
        ? stripCourseLeakIfEnabled(textBlock.text)
        // ⚠️ `!loopDetected` 门禁**不可省**：命中思考死循环时若仍做该回退，
        // `visible` 会变成那段**被截断的循环垃圾**，于是下面的
        // `reasoningLoopIsSoleOutput` 判据恒为假 → 永远落回 max-tokens，
        // 「有分辨力的错误提示」在 codearts 这条路径上**静默失效**。
        // 且把循环垃圾回填进正文正是本守卫要根除的问题（见上方注释）。
        : reasoningBlock !== undefined && toolOrder.length === 0 && !reasoningHasDsml && !loopDetected
          ? reasoningText
          : ''
    /**
     * 本次响应**实际会发出的 `block-end` 数量**（＝真正落进 assistant 消息的块数）。
     *
     * ⚠️ **不能写成 `blocks.length`**：`blocks` 里可能留着**不会发出**的条目 ——
     * 纯空白思考块（已被 `suppressor` 压制，连 `block-start` 都没发）、
     * 或被 `cutAt` / `course` 清洗成空串的块。用 `blocks.length` 会把
     * 「零块响应」误判成「有块」，于是静默结束的缺陷原样保留。
     *
     * 故此处**在每个 `block-end` 的发射点自增**，与下面三段发射逻辑逐条对齐。
     * 正文按 visible 判空，包含推理文本回填；仅存在 textBlock 不代表有正文。
     */
    let blockCount = 0
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
          // ⚠️ 判据用 `||`（同时兜 undefined 与空串），**不可**退回成
          // `block.callId ?? ''`：空串 id 会被格式 v4 校验拒绝（它判
          // `length === 0`），落库即等于报废整条会话（见上方 `toolIds` 注释）。
          // 正常路径下 `block.callId` 已在建块时填好，此处仅为最后一道防线。
          id: ToolCallId(block.callId || `call_${index}`),
          name: block.name!,
          // 同上：空分片补 {}，残缺参数保持原样交由截断判定处理。
          arguments: isTruncatedArguments(block.text)
            ? block.text
            : normalizeToolArguments(block.text),
        },
      }
    }
    if (visible.trim() !== '') {
      blockCount += 1
      const index = textBlock?.index ?? nextIndex++
      if (textBlock === undefined) yield { type: 'block-start', index, blockType: 'text' }
      yield { type: 'block-end', index, block: { type: 'text', text: visible } }
    } else if (textBlock !== undefined) {
      yield { type: 'block-end', index: textBlock.index, block: { type: 'text', text: '' } }
    }
    // ⚠️ 判据收紧为 `trim() !== ''`：纯空白思考不得被算作「有 reasoning 产出」。
    // 文本改用上面的 `reasoningText`（源自 `suppressor.text()`，已应用 cutAt
    // 截断与 course 清洗），保证与 `visible` 回退、`reasoningHasDsml` 同一口径。
    if (reasoningBlock !== undefined && reasoningBlock.text.trim() !== '') {
      if (reasoningText !== '') {
        blockCount += 1
        yield { type: 'block-end', index: reasoningBlock.index, block: { type: 'reasoning', text: reasoningText } }
      }
    }
    // finish_reason 映射顺序很关键：'length'（输出被 max_tokens 截断）必须优先于
    // 工具调用检查。若先看 toolOrder.length > 0，截断的工具调用会被报告为
    // 'tool-calls'，harness 将执行其不完整的 JSON 参数（报 INVALID_ARGS），并
    // 把截断参数持久化进会话历史——web 加载历史时 presenter 解析也会失败
    // （"Unterminated string in JSON"）。报告 max-tokens 后，dsh 会丢弃不完整的
    // 工具调用并触发 max-tokens 续写（分批生成），避免脏数据与错误执行。
    //
    // 另：丢弃了无名 tool-call 且没有留下任何可用调用时，同样报 max-tokens 而
    // 非 stop —— 否则模型本意调工具、harness 却认为「正常答完了」，
    // 又是一次无报错中断（与 `openai-compat.ts` 同因同修）。
    const droppedUnnamedCalls = [...toolCalls.values()].some(block => !block.announced)
    /**
     * 思考死循环是否**是唯一的产出**（无可见正文、无工具调用）。
     *
     * ⚠️ 与 `buddy-adapter.ts` / `openai-compat.ts` 同因同修（Gitee !IKIZNK）：
     * 只有该步没有可见产出时才报 `error` —— `error` 路径**不落
     * `assistant/message`**（实测 219 会话里 222 例），有可见内容时报它会把内容
     * 整块丢掉。
     *
     * ⚠️ 判据用 `visible`（＝真正会发出去的正文块文本）而**不是** `textBlock`：
     * 本适配器有「正文为空且无工具调用时用推理文本回填正文」的回退（见下方
     * `visible` 的定义），该回退会让正文块非空 —— 只看 `textBlock` 会误判成
     * 「没有可见产出」，于是报 error 把那块回填文本静默丢掉。
     * 为配合本判据，回退分支也已加上 `!loopDetected` 门禁（见下方注释）。
     */
    const reasoningLoopIsSoleOutput = loopDetected
      && visible === ''
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
        || (droppedUnnamedCalls && toolOrder.length === 0)
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

  /**
   * 查询某个会话的 CodeArts 并发队列状态。该端点
   * 与 chat API 一样使用 AK/SK 签名；GET 不携带请求体，因此无 content-type。
   * @param credential - 用于签名请求的 AK/SK/SecurityToken。
   * @param model - 模型 id，作为 `model` 查询参数回传。
   * @param signal - 状态请求的取消信号。
   * @returns 解析后的排队状态，或当端点不可达
   *   或返回无法识别的载荷时返回 `undefined`。
   */
  private async queryQueueStatus(
    credential: CodeArtsCredential,
    model: string,
    signal?: AbortSignal,
  ): Promise<CodeArtsQueueStatus | undefined> {
    const url = `${QUEUE_STATUS_BASE}?model=${encodeURIComponent(model)}&task_id=${encodeURIComponent(this.sessionId)}`
    const signed = await signRequestHuawei(
      credential.access_key_id,
      credential.secret_access_key,
      credential.security_token,
      'GET',
      url,
      new Uint8Array(),
    )
    const headers = new Headers()
    signed.forEach((value, key) => { if (key !== 'content-type') headers.set(key, value) })
    headers.set('x-snap-traceid', crypto.randomUUID())
    headers.set('Agent-Type', 'INFERHUB_AGENT')
    headers.set('X-Language', 'en')
    let response: Response
    try {
      response = await this.fetchImpl(url, { method: 'GET', headers, signal })
    } catch {
      return undefined
    }
    if (response.status !== 200) return undefined
    let body: Record<string, unknown>
    try {
      body = await response.json() as Record<string, unknown>
    } catch {
      return undefined
    }
    const status = body.status
    if (status !== 'waiting' && status !== 'working' && status !== 'error' && status !== 'queue_full') return undefined
    return {
      status,
      queuePosition: Number(body.queue_position ?? -1),
      message: typeof body.message === 'string' ? body.message : '',
    }
  }
}

/** 在 ctx.llm 上注册 codearts 提供商路由和适配器。 */
export function registerCodeArtsLlm(ctx: Context, options: CodeArtsAdapterOptions): CodeArtsAdapter {
  const adapter = new CodeArtsAdapter(options)
  registerAdapterIdempotent(ctx.llm, [PROVIDER], adapter)
  // 返回实例：Channel Pack「显示列表」需要 `listAllModels()`（不受黑名单影响、
  // 带最终展示名）。`ctx.llm` 不透传自定义方法，须由调用方持有引用。
  return adapter
}

/**
 * CodeBuddy 系（buddy / workbuddy）表示「用量超出频率限制」的业务码。
 *
 * 判据优先用结构化业务码而非文案：**它与语言无关**，且不受服务端改文案影响。
 * 国际版与国内版用的是同一个码（实测均为 6004），只有 msg 文案分中英文。
 */
const RATE_LIMIT_BUSINESS_CODE = 6004

/**
 * 限流文案的**自然语言兜底**判据。
 *
 * 为什么需要兜底：并非所有限流错误都带得上结构化 code —— SSE 流内错误、
 * 网关返回的裸文本、以及 CodeArts（华为云）的中文错误都只有文案可判。
 *
 * ⚠️ **中英文都必须列全**。历史缺陷（用户报障，仅国际版暴露）：此处早期只有
 * 中文词（频率限制 / 使用量已超出 / 频率超出 / 重置），而国际版 WorkBuddy
 * （www.workbuddy.ai）返回的是英文
 * `usage exceeds frequency limit ... your usage will reset at <时间> UTC+8`。
 * 结果 `isRateLimited` 恒为 false → 适配器**跳过整个账号切换分支**，直接抛出
 * 原始 6004 JSON；错误码也因 HTTP 400 退化成 INVALID_REQUEST 而非
 * QUOTA_EXCEEDED。国内版返回中文文案，所以该缺陷只在国际版复现。
 *
 * `too many requests` 是标准 OpenAI 429 措辞，一并纳入。
 */
const RATE_LIMIT_PATTERN =
  /频率限制|频率超出|使用量已超出|重置|rate.?limit|frequency limit|usage exceeds|too many requests/i

/**
 * 腾讯网关「**模型饱和**」业务码（HTTP 429）。
 *
 * ## 它必须与额度限流（6004）分开（真实报障，2026-10-05）
 *
 * 用户第一次用 `buddy/space-bunny` 就报「模型 space-bunny 所有账号均受限」。
 * 直连实测（`scripts/probe-buddy-error-catalog.mjs`）逼出了服务端原话：
 * ```json
 * {"code":14003,"msg":"too many requests",
 *  "displayMsg":{"zh":"模型繁忙，请换模型或稍后重试"},
 *  "displayTips":{"zh":"这个模型当前请求量饱和，与你的网络无关。请换个模型，或稍等一会儿再重试。"},
 *  "actions":["SWITCH_MODEL","SUBMIT_FEEDBACK","RETRY"]}
 * ```
 *
 * ⚠️ **它自己就说明了「这不是账号问题」**（注意 `actions` 里根本没有换号的选项，
 * 只有 `SWITCH_MODEL`）。但 `isRateLimited` 对 **429 无条件返回 true** ⇒
 * 适配器把每个账号都写上「1 小时限流」标记（报文无「将在…重置」，
 * 故取 `RATE_LIMIT_FALLBACK_MS` 兜底）⇒ 4 个独立账号在 20 秒内**全部**被锁
 * ⇒ 用户等到 1 小时也不能用，且**期间连别的模型都受影响**（同一个账号池）。
 *
 * 实测证据（同型缺陷的判据来源）：
 * | 观测 | 结果 |
 * |---|---|
 * | 4 个不同腾讯 uid 的账号 | 20 秒内**全部**被标记 `space-bunny` |
 * | 标记解禁时刻 | 全部等于「写入 + 整 1 小时」= 兜底值，**非**服务端给的时刻 |
 * | 4 MB 输入 | 稳定逼出 `429 / 14003`（46~111 秒才返回） |
 * | 小请求 30 发 | 全 200，但耗时 841ms ~ 216s —— 上游是**时变**背压 |
 *
 * ⇒ 「4 个互不相干的账号同时中招」在账号级限流下无法解释，**只能**是模型级。
 * 与 zcode `3009 model concurrency limit exceeded` 同型（那边结论同样是
 * 「退避重试，**不换号、不标记**」）。
 *
 * ⚠️ **不许把 14003 并进 `RATE_LIMIT_BUSINESS_CODE`**：两者的正确动作相反 ——
 * 6004 是「这个账号在这模型上的额度用完了」（换号有效、必须标记）；
 * 14003 是「这个模型此刻整体饱和」（换号**无益**、**不许**标记）。
 */
export const MODEL_SATURATION_BUSINESS_CODE = 14003

/**
 * 「模型饱和」的**自然语言兜底**判据。
 *
 * 与额度限流同理：码值由服务端下发，本地产物里没有硬编码
 * （实测搜 `14003` 在本仓库源码中零命中才敢新增），上游可能改用别的码值表达
 * 同一语义，故需要文案兜底。
 *
 * ⚠️ **关键词必须窄**：`busy` / `saturated` 这种泛词若不加限定，
 * 模型正文里恰好讨论「服务器繁忙」就会被误判。这里只认腾讯原话里的组合，
 * 且判据本身**要求 HTTP 状态码 ≥ 400**（见 {@link isModelSaturationError}）。
 */
const MODEL_SATURATION_PATTERN = /模型繁忙|请求量饱和|model\s+busy|currently\s+saturated/i

/**
 * 判断一次失败是否为**模型饱和**（上游背压），而非账号级额度限流。
 *
 * ## 为什么这个区分是**行为分叉**而不是措辞问题
 *
 * | | 额度限流 `6004` | 模型饱和 `14003` |
 * |---|---|---|
 * | 语义 | 该**账号**在该模型上额度用完 | 该**模型**此刻整体饱和 |
 * | 换号 | **有效**（别的账号有独立额度） | **无益**（所有账号撞同一堵墙） |
 * | 写限流标记 | **必须**（否则每轮重撞） | **绝对不许**（会把整池锁 1 小时） |
 * | 建议 | 等解禁 / 换账号 | **换模型** / 稍后重试 |
 *
 * 实测 `actions` 字段本身就写着 `SWITCH_MODEL` 而**没有**换号选项 ——
 * 服务端与我们的结论一致。
 *
 * ⚠️ **必须先于 `status === 429` 的无条件判定**：14003 恰恰是 429，
 * 若先判状态码就永远走不到这里（这正是缺陷的成因，见常量注释）。
 *
 * @param status - HTTP 状态码。为 `undefined`（只有文案可判）时仍检查业务码；
 *   但**文案分支要求状态码 ≥ 400** —— 否则一段正常正文里出现「模型繁忙」
 *   就会被判成错误。
 * @param body - 响应体（可能为空串）。
 */
export function isModelSaturationError(status: number | undefined, body: string): boolean {
  // 状态码已知且 < 400 ⇒ 这是正常响应，正文里的字样不算错误。
  if (typeof status === 'number' && status < 400) return false
  if (body.length === 0) return false
  try {
    const code = (JSON.parse(body) as Record<string, unknown>).code
    if (code === MODEL_SATURATION_BUSINESS_CODE
      || code === String(MODEL_SATURATION_BUSINESS_CODE)) return true
  } catch {
    // 非 JSON：交给文案兜底。
  }
  return MODEL_SATURATION_PATTERN.test(body)
}

/**
 * 结构化判定：响应体是可解析 JSON 且 `code` 为该业务码。
 *
 * 不采用「全文包含 6004」的写法：`requestId` 是 UUID，任意数字子串都可能
 * 偶然出现，文本匹配会产生假阳性；这里只认 JSON 顶层的 `code` 字段。
 * 兼容 `"6004"`（字符串）与 `6004`（数字）两种编码。
 */
function hasRateLimitBusinessCode(body: string): boolean {
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const code = data.code
    return code === RATE_LIMIT_BUSINESS_CODE || code === String(RATE_LIMIT_BUSINESS_CODE)
  } catch {
    // 非 JSON：交给文案兜底
    return false
  }
}

/**
 * 判断错误文本是否为频率限制错误。
 *
 * @param body - 响应体（可能为空串）
 * @param status - HTTP 状态码（可选，但**手里有 Response 就必须传**）。为 `429`
 *   时无条件判为限流，即使响应体为空、不含任何可识别文案。
 *
 * ⚠️ **`status` 判据是真实缺陷的修复，不是可选便利**：本函数原先只接收响应体，
 * 而服务端（网关 / CDN / 限流中间件）完全可能返回**空体**的 429 —— 此时
 * `hasRateLimitBusinessCode` 与 `RATE_LIMIT_PATTERN` **双双不命中**，函数返回
 * `false`，于是适配器里整段「记录重置时间 + 切换账号」逻辑被**整体跳过**，
 * 把一个本可自愈的限流直接抛给用户（表现为「账号池里明明还有可用账号，插件却
 * 报错且不换号」）。
 *
 * 判据顺序刻意是「状态码优先」：429 是 HTTP 语义上**唯一**的限流信号，无需也不应
 * 再去猜文案；下面的文案 / 业务码兜底只服务于「状态码不是 429、但正文表达了限流」
 * 的场景（业务码 6004、SSE 流内错误、网关包装过的 200/400）。
 *
 * ⚠️ 反向的约束同样重要：**非 429 绝不能因为「有状态码」就判为限流** ——
 * 404「模型不存在」这类换号无益的错误若被识别成限流，会被吞成「所有账号均受限」，
 * 用户既看不到真实原因、插件还会白试一遍全池账号。
 */
export function isRateLimited(body: string, status?: number): boolean {
  if (status === 429) return true
  return hasRateLimitBusinessCode(body) || RATE_LIMIT_PATTERN.test(body)
}

/**
 * 重置时间的两种句式（中文 / 英文），并**捕获实际时区**而非硬编码 UTC+8。
 *
 * 中文（buddy 国内版）："您的使用量已超出频率限制，将在 2026-09-11 18:08:17 UTC+8 重置"
 * 英文（workbuddy 国际版）："... your usage will reset at 2026-09-17 09:09:36 UTC+8, alternatively, ..."
 *
 * 早期只列了中文句式，导致国际版即使判定为限流也只能走「1 小时后重试」的
 * 兜底，丢掉服务端给出的真实重置时刻（UI 限流徽章因此显示错误时间）。
 */
const RESET_TIME_PATTERN = /(?:将在|reset at)\s+([\d-]+\s+[\d:]+)\s+(UTC[+-]\d+(?::\d+)?)/i

/**
 * 限流文案里解析不出重置时刻时的**兜底时长**（1 小时）。
 *
 * 为什么需要兜底而不是「解析不到就不记标记」：网关 / CDN 返回的 429 常常既没有
 * 重置时间、甚至**没有响应体**，而标记是 UI「限额重置」徽章与「重测 / 重置」
 * 两条人工解禁路径的**唯一**依据 —— 静默跳过记录会让用户既看不到限流、也无从操作。
 *
 * ⚠️ 1 小时是**快照式**兜底（标记可被重测刷新），与 `BUDDY_POLICY_BLOCK_COOLDOWN_MS`
 * 的 30 分钟**语义不同**（那是「安全策略拦截」的本地冷却，报文里根本没有时间字段），
 * 也与 Qoder「按自然日 24:00」不同（那是按日的额度结算）。三者不要合并成一个常量。
 *
 * 导出是给 `buddy-adapter` 用的：它需要在**没拿到可解析体**时也能写出标记，
 * 且必须与这里 `parseRateLimitError` 的兜底**同值**，否则两处口径会漂。
 */
export const RATE_LIMIT_FALLBACK_MS = 3_600_000

/**
 * 从限流错误中提取重置时间；体里没有时间时返回 {@link RATE_LIMIT_FALLBACK_MS} 兜底。
 *
 * @param status - HTTP 状态码（可选）。为 `429` 时即使**体为空、或无任何可识别文案**
 *   也按兜底时长返回一条，避免调用方「识别出限流却没有标记可写」（见
 *   {@link RATE_LIMIT_FALLBACK_MS} 的说明）。
 */
export function parseRateLimitError(
  body: string,
  currentModel: string,
  status?: number,
): { modelId: string; resetTimeMs: number } | null {
  const fallback = (): { modelId: string; resetTimeMs: number } => ({
    modelId: currentModel,
    resetTimeMs: Date.now() + RATE_LIMIT_FALLBACK_MS,
  })
  try {
    const data = JSON.parse(body) as Record<string, unknown>
    const msg = typeof data.msg === 'string' ? data.msg : ''
    const resetMatch = RESET_TIME_PATTERN.exec(msg)
    if (resetMatch) {
      // 用捕获到的真实时区拼接（不再写死 UTC+8），Date.parse 能正确解析该写法。
      const resetMs = Date.parse(`${resetMatch[1]} ${resetMatch[2]}`)
      if (!Number.isNaN(resetMs)) {
        return { modelId: currentModel, resetTimeMs: resetMs }
      }
    }
    // 标准 OpenAI 429 格式，或带业务码但文案无法解析出时间
    if (isRateLimited(body, status)) {
      return fallback()
    }
    return null
  } catch {
    // 非 JSON（空体、纯文本、CDN 的 HTML 错误页）：只剩状态码可判。
    return status === 429 ? fallback() : null
  }
}
