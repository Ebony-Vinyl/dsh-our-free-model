import { randomUUID } from 'node:crypto'
import type { FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { OpenAiGatewayError } from './messages.js'
import { normalizeUpstreamFailure, upstreamStatusOrFallback } from './model-errors.js'
import { toOpenAiUsage } from './usage.js'

/**
 * 失败后给出纠错建议的钩子。
 *
 * 只在**出错时**被调用（正常路径零开销），故可以放心在这里去查模型目录。
 * 流式与非流式共用同一个钩子，保证两条路径给出的建议完全一致。
 */
export type SuggestionHook = (message: string) => string | undefined | Promise<string | undefined>

/**
 * 把「你可能是想用 X」拼到错误消息后面。
 *
 * ⚠️ 导出给 `responses.ts` 复用：两个端点的纠错建议必须逐字一致，
 * 否则同一次误填在两个 URL 上会得到不同的提示。
 */
export async function withSuggestion(message: string, suggest: SuggestionHook | undefined): Promise<string> {
  if (suggest === undefined) return message
  try {
    const hint = await suggest(message)
    return typeof hint === 'string' && hint.length > 0 ? `${message}（${hint}）` : message
  } catch {
    // 建议只是锦上添花，取目录失败绝不能盖掉真正的错误消息。
    return message
  }
}

interface ToolState {
  id: string
  name?: string
  arguments: string
}

interface Accumulated {
  content: string
  reasoning: string
  tools: Map<number, ToolState>
  usage?: TokenUsage
  finishReason?: string
}

function finishReason(reason: FinishReason): string {
  switch (reason.kind) {
    case 'stop': return 'stop'
    case 'tool-calls': return 'tool_calls'
    case 'max-tokens': return 'length'
    case 'aborted': return 'error'
    case 'error': return 'error'
  }
}

/**
 * DSH 的用量 → OpenAI Chat Completions 的 `usage`。
 *
 * ⚠️ 口径转换全部在 `usage.ts` 里（两个端点共用一份判断，见该文件头）。
 * 这里只负责**改字段名**：`inputTokens`（已含缓存）→ `prompt_tokens`。
 */
function usageJson(usage: TokenUsage): Record<string, unknown> {
  const normalized = toOpenAiUsage(usage)
  return {
    prompt_tokens: normalized.inputTokens,
    completion_tokens: normalized.outputTokens,
    total_tokens: normalized.totalTokens,
    // 官方明细：`cached_tokens` 是 `prompt_tokens` 的**子集**（见 `usage.ts`）。
    prompt_tokens_details: { cached_tokens: normalized.cachedTokens },
    ...normalized.reasoningTokens === undefined
      ? {}
      : {
          reasoning_tokens: normalized.reasoningTokens,
          completion_tokens_details: { reasoning_tokens: normalized.reasoningTokens },
        },
    // 私有兼容字段（见上方注释）：只在真有缓存命中时才发，避免凭空多出 0。
    ...normalized.cachedTokens > 0 ? { prompt_cache_hit_tokens: normalized.cachedTokens } : {},
  }
}

function line(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`
}

function baseChunk(id: string, model: string, delta: Record<string, unknown>, finish?: string): Record<string, unknown> {
  return {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  }
}

function failureMessage(reason: Extract<FinishReason, { kind: 'error' | 'aborted' }>): string {
  return reason.failure.message || `DSH model request ${reason.kind}`
}

function consumeChunk(state: Accumulated, chunk: StreamChunk): Record<string, unknown> | undefined {
  switch (chunk.type) {
    case 'text-delta':
      state.content += chunk.text
      return { delta: { content: chunk.text } }
    case 'reasoning-delta':
      state.reasoning += chunk.text
      return { delta: { reasoning_content: chunk.text } }
    case 'tool-call-delta': {
      let tool = state.tools.get(chunk.index)
      if (!tool) {
        tool = { id: String(chunk.id), arguments: '' }
        state.tools.set(chunk.index, tool)
      }
      tool.id = String(chunk.id || tool.id)
      if (chunk.name !== undefined) tool.name = chunk.name
      tool.arguments += chunk.argumentsDelta
      return {
        delta: {
          tool_calls: [{
            index: chunk.index,
            id: tool.id,
            type: 'function',
            function: {
              ...tool.name === undefined ? {} : { name: tool.name },
              arguments: chunk.argumentsDelta,
            },
          }],
        },
      }
    }
    case 'usage':
      state.usage = chunk.usage
      return undefined
    case 'finish':
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        // ⚠️ 把上游自带的状态码一并带出来（`LlmError` 把它放在 `failure.status`）：
        // 少了它，下游只能退化成 502，模型名写错这种确定性失败会被客户端白重试。
        return {
          error: {
            message: failureMessage(chunk.reason),
            type: 'server_error',
            code: chunk.reason.failure.code,
            status: chunk.reason.failure.status,
          },
        }
      }
      state.finishReason = finishReason(chunk.reason)
      return { delta: {}, finish_reason: state.finishReason }
    case 'block-start':
    case 'block-end':
      return undefined
  }
}

export async function* toOpenAiSse(
  chunks: AsyncIterable<StreamChunk>,
  requestId = `chatcmpl-${randomUUID()}`,
  model: string,
  suggest?: SuggestionHook,
): AsyncIterable<string> {
  const state: Accumulated = { content: '', reasoning: '', tools: new Map() }
  try {
    for await (const chunk of chunks) {
      const event = consumeChunk(state, chunk)
      if (event === undefined) continue
      if ('error' in event) {
        const error = event.error as { message?: unknown; type?: unknown; code?: unknown; status?: unknown }
        const message = typeof error.message === 'string' ? error.message : 'upstream error'
        // 上游「模型不存在」以 502 离开网关时会被客户端当成可重试故障重试，
        // 但它是确定性失败 —— 翻成 404 让客户端提示用户改配置。
        const normalized = normalizeUpstreamFailure({
          // 上游自带状态码（如 gemini 拒绝未知模型名时的 404）优先，否则才退化成 502。

          // 原样透出会让「额度用尽」在客户端眼里读成成功。另两处出口已有同一门禁。
          status: upstreamStatusOrFallback(error.status),
          type: typeof error.type === 'string' ? error.type : 'server_error',
          code: typeof error.code === 'string' ? error.code : 'upstream_error',
          message,
        })
        yield line({
          id: requestId,
          object: 'chat.completion.chunk',
          model,
          choices: [],
          error: {
            message: await withSuggestion(message, suggest),
            type: normalized.type,
            code: normalized.code,
            // 流已发出 200，状态码改不了；把该有的 404 放进 status 字段供客户端读。
            status: normalized.status,
          },
        })
        yield 'data: [DONE]\n\n'
        return
      }
      if ('finish_reason' in event) {
        yield line({ ...baseChunk(requestId, model, event.delta as Record<string, unknown>, event.finish_reason as string) })
      } else {
        yield line(baseChunk(requestId, model, event.delta as Record<string, unknown>))
      }
    }
    if (state.finishReason === undefined) {
      yield line({ id: requestId, object: 'chat.completion.chunk', model, choices: [], error: { message: 'upstream stream ended before finish', type: 'server_error', code: 'incomplete_stream' } })
      yield 'data: [DONE]\n\n'
      return
    }
    if (state.usage !== undefined) {
      yield line({ id: requestId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: usageJson(state.usage) })
    }
    yield 'data: [DONE]\n\n'
  } catch (error) {
    const converted = failureToOpenAiError(error)
    yield line({ id: requestId, object: 'chat.completion.chunk', model, choices: [], error: converted.body.error })
    yield 'data: [DONE]\n\n'
  }
}

export async function collectOpenAiCompletion(
  chunks: AsyncIterable<StreamChunk>,
  requestId = `chatcmpl-${randomUUID()}`,
  model: string,
  suggest?: SuggestionHook,
): Promise<Record<string, unknown>> {
  const state: Accumulated = { content: '', reasoning: '', tools: new Map() }
  try {
    for await (const chunk of chunks) {
      const event = consumeChunk(state, chunk)
      if (event?.error) {
        const detail = event.error as Record<string, unknown>
        throw new OpenAiGatewayError(
          String(detail.message),
          // 上游自带状态码优先（模型名不存在 = 404），否则才当可重试的服务端故障。
          upstreamStatusOrFallback(detail.status),
          'server_error',
          String(detail.code ?? 'upstream_error'),
        )
      }
    }
    if (state.finishReason === undefined) {
      throw new OpenAiGatewayError('upstream stream ended before finish', 502, 'server_error', 'incomplete_stream')
    }
  } catch (error) {
    const converted = failureToOpenAiError(error)
    const message = String(converted.body.error.message)
    // 同 toOpenAiSse：把上游「模型不存在」翻成 404，避免客户端把它当可重试故障。
    const normalized = normalizeUpstreamFailure({
      status: converted.status,
      type: String(converted.body.error.type),
      code: String(converted.body.error.code ?? 'upstream_error'),
      message,
    })
    throw new OpenAiGatewayError(await withSuggestion(message, suggest), normalized.status, normalized.type, normalized.code)
  }
  const toolCalls = [...state.tools.entries()].sort(([a], [b]) => a - b).map(([, tool]) => ({
    id: tool.id,
    type: 'function',
    function: { name: tool.name ?? '', arguments: tool.arguments },
  }))
  const message: Record<string, unknown> = {
    role: 'assistant',
    content: state.content || null,
    ...state.reasoning.length === 0 ? {} : { reasoning_content: state.reasoning },
    ...toolCalls.length === 0 ? {} : { tool_calls: toolCalls },
  }
  return {
    id: requestId,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message, finish_reason: state.finishReason }],
    ...state.usage === undefined ? {} : { usage: usageJson(state.usage) },
  }
}

export function failureToOpenAiError(error: unknown): { status: number; body: { error: Record<string, unknown> } } {
  if (error instanceof OpenAiGatewayError) {
    return { status: error.status, body: { error: { message: error.message, type: error.type, code: error.code } } }
  }
  // ⚠️ `LlmError` 的 `status` **不是顶层属性**（实测 `'status' in e === false`），
  // 它只落在 `e.failure.status`（`@deepseek-ai/dsh-llm` 的 `LlmFailure`）。
  // 只读顶层等于没读 —— 上游声明的 404 会一路退化成 502 并被客户端反复重试。
  const value = error as
    | { code?: unknown; status?: unknown; failure?: { status?: unknown }; message?: unknown }
    | undefined
  const raw = typeof value?.status === 'number' ? value.status : value?.failure?.status
  const status = upstreamStatusOrFallback(raw)
  return {
    status,
    body: { error: {
      message: typeof value?.message === 'string' ? value.message : 'DSH model request failed',
      type: 'server_error',
      code: typeof value?.code === 'string' ? value.code : 'upstream_error',
    } },
  }
}
