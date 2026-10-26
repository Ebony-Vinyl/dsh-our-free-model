/**
 * Qoder 加密推理端点的**响应解包**。
 *
 * ## 为什么需要
 *
 * 加密端点 `agent_chat_generation` 的响应是 SSE，但每帧多一层信封：
 *
 * ```
 * data:{"headers":{...},"body":"{\"choices\":[{\"delta\":{\"content\":\"Q\"}}]}","statusCodeValue":200,"statusCode":"OK"}
 *                               ↑ 这里才是标准 OpenAI chunk（JSON 字符串）
 * ```
 *
 * ⚠️ **内层 `body` 并未加密** —— 只有**请求**体需要 WASM 加密。
 * 因此这里只做「剥信封」，不涉及任何解密。
 *
 * 剥完后就是标准的 OpenAI SSE，可直接交给 `consumeOpenAiSse`。
 *
 * ## 错误形态
 *
 * 失败时内层 `body` 是业务错误 JSON（`[FAIL]node:... msg:...`），
 * 必须**抛出**而不是当成无内容 —— 否则会重演「静默停止」那个缺陷。
 *
 * ⚠️ **转发时必须保留 `code` 字段**（真实缺陷，用户报障 2026-09-27）：
 * 旧实现把内层 `{code, message}` 降级重组为 `{error:{message:"… (code)"}}`，
 * 把 `code` 拼成文案后缀并**丢掉字段** —— 于是下游
 * `consumeOpenAiSse` 的排队识别（依赖顶层 `code === '10605'`）**永远不命中**，
 * 排队错误被归为 `SERVER`，harness 用 500…8000ms 快退避重试 5 次
 * （共约 15.5 秒），而服务端要求等 30 秒 —— **永远等不到**。
 * 现在改为保真转发 `{code, message, type}`。
 */
import { LlmError } from '@deepseek-ai/dsh-llm'

/** 信封里的单帧结构。 */
interface QoderEnvelope {
  headers?: Record<string, unknown>
  body?: unknown
  statusCodeValue?: number
  statusCode?: string
}

/** 从信封 JSON 文本里取出内层 OpenAI 帧文本；无法识别时返回 null。 */
function innerTextOf(payload: string): string | null {
  let envelope: QoderEnvelope
  try {
    envelope = JSON.parse(payload) as QoderEnvelope
  } catch {
    return null
  }
  // 不是信封（缺 body 字段）→ 视为已经是标准帧
  if (envelope.body === undefined) return null
  return typeof envelope.body === 'string' ? envelope.body : JSON.stringify(envelope.body)
}

/** 内层帧的**结构分类**（不再靠 `includes('"choices"')` 嗅探）。 */
type InnerKind =
  /** 正常 chunk：有 `choices` 数组或 `usage`。 */
  | 'chunk'
  /** 业务错误：显式带 `code` / `message` / `error` / `statusCodeValue` / `type`。 */
  | 'error'
  /** 心跳/空帧：无任何可消费内容（`null`、空串、`{}`、裸标量）。 */
  | 'heartbeat'

/**
 * 按 **JSON 结构**给内层帧分类。
 *
 * ⚠️ 旧实现是**字符串嗅探**（`!inner.includes('"choices"')` 即判业务错误），
 * 有两个方向相反的缺陷：
 *   ① `body: null` 经 `JSON.stringify` 变成 `'null'` → 「不含 choices」
 *      → **心跳帧被当成业务错误** ⇒ 模型正常回完内容却报失败（issue IKJOZ8）；
 *   ② 错误文案里恰好含 `"choices"` 的帧会被当正常帧**静默透传**。
 */
function classifyInner(inner: string): InnerKind {
  const trimmed = inner.trim()
  if (trimmed.length === 0) return 'heartbeat'
  // ⚠️ 保留旧的子串语义（含 `[DONE]` 即视为正常帧），避免回归
  if (trimmed.includes('[DONE]')) return 'chunk'
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    // 解析不了的原文：按业务错误处理（保持旧行为，如纯文本错误体）
    return 'error'
  }
  // ⚠️ `typeof null === 'object'` —— 必须**先**判 null，否则下面会把它
  // 当成普通对象、落到「无任何错误字段 ⇒ heartbeat」，而空对象同理。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'heartbeat'
  }
  const obj = parsed as Record<string, unknown>
  // ⚠️ `choices: []` 也算正常帧（`stream_options.include_usage` 的末帧形态）
  if (Array.isArray(obj.choices) || obj.usage !== undefined) return 'chunk'
  if (
    obj.code !== undefined
    || obj.message !== undefined
    || obj.error !== undefined
    || obj.statusCodeValue !== undefined
    || obj.type !== undefined
  ) {
    return 'error'
  }
  return 'heartbeat'
}

/**
 * 把信封 SSE 转成标准 OpenAI SSE。
 *
 * 逐帧处理 `data:` 行；非 `data:` 行（如 `event:finish`）原样保留，
 * `[DONE]` 原样传递。
 */
export function unwrapQoderEnvelopePayload(payload: string): string | null {
  const inner = innerTextOf(payload)
  if (inner === null) return null
  return inner
}

/**
 * 把 Qoder 信封 SSE 流转成标准 OpenAI SSE 流。
 *
 * @param response 原始响应（`body` 必须是可读流）。
 * @returns 新的 `Response`，其 body 为标准 OpenAI SSE 文本流。
 */
export function unwrapQoderEnvelopeStream(response: Response, label: string): Response {
  const upstream = response.body
  if (upstream === null) {
    throw new LlmError(`${label}: 响应没有 body`, 'SERVER')
  }

  const decoder = new TextDecoder('utf-8')
  const encoder = new TextEncoder()
  let buffer = ''

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)

        if (line === '' ) {
          controller.enqueue(encoder.encode('\n'))
          continue
        }
        if (!line.startsWith('data:')) {
          // 保留 event: 等行（`event: error` 对诊断有价值）
          controller.enqueue(encoder.encode(`${line}\n`))
          continue
        }

        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          controller.enqueue(encoder.encode('data: [DONE]\n'))
          continue
        }

        const inner = innerTextOf(payload)
        if (inner === null) {
          // 不是信封 → 原样透传（容错：万一服务端某天直接回标准帧）
          controller.enqueue(encoder.encode(`data: ${payload}\n`))
          continue
        }

        // 心跳帧（`body: null` / 空串 / `{}`）→ **整帧跳过**（issue IKJOZ8）。
        // 旧实现用「不含 `"choices"` 即业务错误」判它，会把上游的保活帧
        // 打成 `{message:"null", type:"model_error"}` ⇒ 模型正常回完内容
        // 却抛 `SERVER`（且 `SERVER` 可重试，白重发 5 次整轮对话）。
        if (classifyInner(inner) === 'heartbeat') continue

        // 业务错误：**按 JSON 结构**判定（不再嗅探 `"choices"` 子串）。
        // `classifyInner` 已把 `choices: []` / `usage`-only / `null` / `{}` 判为
        // 正常或心跳，绝不会落到这里；只有显式带 `code`/`message`/`error`/
        // `statusCodeValue`/`type`（或压根不是 JSON）的帧才算业务错误。
        if (classifyInner(inner) === 'error') {
          let code: unknown
          let message = inner
          try {
            const parsed = JSON.parse(inner) as { code?: unknown; message?: unknown }
            if (parsed.code !== undefined) code = parsed.code
            if (typeof parsed.message === 'string') message = parsed.message
          } catch { /* 保持原文 */ }
          // ⚠️ **`code` 必须保持为独立字段，且 `message` 不得被拼后缀**
          //（真实缺陷，用户报障 2026-09-27）：旧实现产出
          // `{error:{message:"… (10605)"}}` —— 既**丢掉 `code` 字段**，
          // 又把后缀拼进 `message`。两个后果都很隐蔽：
          //   ① `consumeOpenAiSse` 的排队识别依赖顶层 `code === '10605'`，
          //      丢字段 → **永远不命中** → 排队被归为 `SERVER`，harness 以
          //      500…8000ms 快退避重试 5 次（共约 15.5 秒），而服务端要求等
          //      30 秒，**永远等不到**；
          //   ② 后缀污染了 `message` 里那段**内层 JSON 字符串**，使下游
          //      `parseQueueError` 无法二次解析 → 拿不到 `retryAfterSeconds`，
          //      只能退回 1 秒兜底退避（写单测时实测到了这一点）。
          // 故这里**保真转发**：`code` 独立、`message` 原样。
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({
              ...(code === undefined ? {} : { code }),
              message,
              type: 'model_error',
            })}\n`),
          )
          continue
        }

        controller.enqueue(encoder.encode(`data: ${inner}\n`))
      }
    },
    flush(controller) {
      const rest = buffer.trim()
      if (rest.length > 0) {
        const inner = rest.startsWith('data:') ? innerTextOf(rest.slice(5).trim()) : null
        // ⚠️ 心跳帧必须**丢弃**，不能原样透传（issue IKJOZ8 的 P6）：
        // 透传后是 `data: null` → 消费器 `JSON.parse('null')` 得到 `null`
        // → 读 `.error` 抛**未包装的 TypeError**，绕过全部错误归类。
        if (inner !== null && classifyInner(inner) !== 'heartbeat') {
          controller.enqueue(encoder.encode(`data: ${inner}\n`))
        }
      }
    },
  })

  return new Response(upstream.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}
