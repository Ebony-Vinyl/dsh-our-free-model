/**
 * Native Gemini wire for the local harness gateway. Text/thoughts stream as
 * deltas; only a function call's JSON is held until it becomes executable.
 * REST references: ai.google.dev/api/{generate-content,tokens,models} and
 * .references/magpie/internal/gateway/{gemini.go,gateway.go}.
 */
import crypto from 'node:crypto'
import { foldAnthropicOutcome, countTokens } from './anthropic.js'
import { forwardFailure } from './failure.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const invalid = message => { throw Object.assign(new Error(message), { statusCode: 400 }) }
const upstreamError = message => { throw Object.assign(new Error(message), { statusCode: 502 }) }
const MAX_PENDING_BYTES = 1024 * 1024
const methods = ['generateContent', 'streamGenerateContent', 'countTokens']

function fields(value, allowed, label) {
  if (!object(value)) invalid(`${label} must be an object`)
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(`${label} contains unsupported fields`)
}

/** Keep /v1/models reserved for the existing OpenAI discovery contract. */
export function geminiRoute(path) {
  if (path === '/v1beta/models') return { method: 'list' }
  const match = /^\/(?:v1beta|v1)\/models\/(.+)$/.exec(path)
  if (!match) return null
  const at = match[1].lastIndexOf(':')
  const method = at < 0 ? 'get' : match[1].slice(at + 1)
  let model
  try { model = decodeURIComponent(at < 0 ? match[1] : match[1].slice(0, at)) }
  catch { invalid('model path is not valid percent encoding') }
  if (!model || /[\u0000-\u001f\u007f]/.test(model)) invalid('model path is invalid')
  return { method, model }
}

export function geminiError(res, code, message) {
  const status = {
    400: 'INVALID_ARGUMENT', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED',
    404: 'NOT_FOUND', 405: 'UNIMPLEMENTED', 413: 'RESOURCE_EXHAUSTED',
    429: 'RESOURCE_EXHAUSTED', 499: 'CANCELLED', 500: 'INTERNAL',
    502: 'UNAVAILABLE', 503: 'UNAVAILABLE', 504: 'DEADLINE_EXCEEDED',
  }[code] ?? 'UNKNOWN'
  const payload = { error: { code, message: String(message), status } }
  if (res.destroyed || res.writableEnded) return
  if (res.headersSent) {
    res.end(`data: ${JSON.stringify(payload)}\n\n`)
  } else {
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    res.end(JSON.stringify(payload))
  }
}

function image(part) {
  const inline = part.inlineData
  const file = part.fileData
  const data = inline ?? file
  fields(data, inline ? ['mimeType', 'data'] : ['mimeType', 'fileUri'], 'image data')
  if (typeof data.mimeType !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(data.mimeType)) invalid('only image media is supported')
  let url
  if (inline) {
    if (typeof data.data !== 'string' || !data.data || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)) invalid('inlineData.data must be base64')
    url = `data:${data.mimeType};base64,${data.data}`
  } else {
    try {
      const parsed = new URL(data.fileUri)
      if (!['http:', 'https:'].includes(parsed.protocol)) invalid('fileData requires an HTTP(S) image URI')
      url = parsed.href
    } catch { invalid('fileData requires an HTTP(S) image URI') }
  }
  return {
    type: 'image',
    attachment: { attachmentId: inline ? url : `url:${url.slice(0, 64)}`, url, mediaType: data.mimeType, bytes: 0, width: 0, height: 0 },
  }
}

function schema(value) {
  // Gemini Schema.type uses uppercase enum values; harness tools use JSON Schema.
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'type' && typeof child === 'string') return [key, child.toLowerCase()]
    if (['properties', '$defs', 'definitions', 'patternProperties'].includes(key) && object(child)) {
      return [key, Object.fromEntries(Object.entries(child).map(([name, nested]) => [name, schema(nested)]))]
    }
    if (['anyOf', 'allOf', 'oneOf', 'prefixItems'].includes(key) && Array.isArray(child)) return [key, child.map(schema)]
    if (['items', 'additionalProperties', 'not', 'contains'].includes(key)) return [key, schema(child)]
    // Defaults, enum members and examples are data, not nested schemas.
    return [key, child]
  }))
}

/** Translate only settings that the shared completion contract can honor. */
export function fromGeminiRequest(body, model) {
  fields(body, ['model', 'contents', 'systemInstruction', 'tools', 'toolConfig', 'generationConfig'], 'request')
  if (body.model !== undefined && body.model !== model && body.model !== `models/${model}`) invalid('body model conflicts with path model')
  if (!Array.isArray(body.contents) || body.contents.length === 0) invalid('contents must be a non-empty array')
  const messages = []
  if (body.systemInstruction !== undefined) {
    fields(body.systemInstruction, ['role', 'parts'], 'systemInstruction')
    if (!Array.isArray(body.systemInstruction.parts) || !body.systemInstruction.parts.length) invalid('systemInstruction.parts must be non-empty')
    const content = body.systemInstruction.parts.map(part => {
      fields(part, ['text'], 'systemInstruction part')
      if (typeof part.text !== 'string') invalid('systemInstruction only supports text')
      return { type: 'text', text: part.text }
    })
    messages.push({ role: 'system', content })
  }
  const pending = []
  const ids = new Set()
  for (const row of body.contents) {
    fields(row, ['role', 'parts'], 'content')
    const role = row.role ?? 'user'
    if (!['user', 'model'].includes(role)) invalid('content role must be user or model')
    if (!Array.isArray(row.parts) || !row.parts.length) invalid('content.parts must be non-empty')
    let content = []
    const flush = () => {
      if (!content.length) return
      messages.push({
        role: role === 'model' ? 'assistant' : 'user', content,
        ...(role === 'model' ? { source: { kind: 'model', provider: 'our-free-model', model } } : {}),
      })
      content = []
    }
    for (const part of row.parts) {
      fields(part, ['text', 'thought', 'inlineData', 'fileData', 'functionCall', 'functionResponse'], 'part')
      const kinds = ['text', 'inlineData', 'fileData', 'functionCall', 'functionResponse'].filter(key => part[key] !== undefined)
      if (kinds.length !== 1) invalid('part must contain exactly one supported data field')
      if (part.thought !== undefined && (typeof part.thought !== 'boolean' || kinds[0] !== 'text' || role !== 'model')) invalid('thought is only supported on model text')
      if (kinds[0] === 'text') {
        if (typeof part.text !== 'string') invalid('part.text must be a string')
        content.push({ type: part.thought ? 'reasoning' : 'text', text: part.text })
      } else if (part.inlineData !== undefined || part.fileData !== undefined) {
        content.push(image(part))
      } else if (part.functionCall !== undefined) {
        if (role !== 'model') invalid('functionCall requires model role')
        const call = part.functionCall
        fields(call, ['id', 'name', 'args'], 'functionCall')
        if (typeof call.name !== 'string' || !call.name || (call.args !== undefined && !object(call.args))) invalid('functionCall requires a name and object args')
        const id = call.id ?? `gemini_call_${ids.size}`
        if (typeof id !== 'string' || !id || ids.has(id)) invalid('functionCall id must be a unique non-empty string')
        ids.add(id)
        pending.push({ id, name: call.name })
        content.push({ type: 'tool-call', id, name: call.name, arguments: JSON.stringify(call.args ?? {}) })
      } else {
        if (role !== 'user') invalid('functionResponse requires user role')
        const response = part.functionResponse
        fields(response, ['id', 'name', 'response', 'parts'], 'functionResponse')
        if (typeof response.name !== 'string' || !object(response.response)) invalid('functionResponse requires a name and object response')
        const at = pending.findIndex(call => call.name === response.name && (response.id === undefined || call.id === response.id))
        if (at < 0) invalid('functionResponse has no matching functionCall')
        const [call] = pending.splice(at, 1)
        const blocks = [{ type: 'text', text: JSON.stringify(response.response) }]
        if (response.parts !== undefined) {
          if (!Array.isArray(response.parts)) invalid('functionResponse.parts must be an array')
          for (const media of response.parts) {
            fields(media, ['inlineData', 'fileData'], 'functionResponse image')
            if ((media.inlineData !== undefined) === (media.fileData !== undefined)) invalid('functionResponse part requires one image')
            blocks.push(image(media))
          }
        }
        flush()
        messages.push({
          role: 'tool', toolCallId: call.id, source: { kind: 'tool', callId: call.id }, content: blocks,
          ...(response.response.error !== undefined ? { isError: true } : {}),
        })
      }
    }
    flush()
  }
  let tools = []
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) invalid('tools must be an array')
    for (const group of body.tools) {
      fields(group, ['functionDeclarations'], 'tool')
      if (!Array.isArray(group.functionDeclarations)) invalid('only functionDeclarations tools are supported')
      for (const tool of group.functionDeclarations) {
        fields(tool, ['name', 'description', 'parameters', 'parametersJsonSchema'], 'function declaration')
        if (typeof tool.name !== 'string' || !tool.name || tools.some(other => other.name === tool.name)) invalid('function names must be unique non-empty strings')
        if (tool.description !== undefined && typeof tool.description !== 'string') invalid('function description must be a string')
        if (tool.parameters !== undefined && tool.parametersJsonSchema !== undefined) invalid('use one function parameter schema')
        const parameters = tool.parametersJsonSchema ?? tool.parameters ?? { type: 'object', properties: {} }
        if (!object(parameters)) invalid('function parameter schema must be an object')
        tools.push({ name: tool.name, description: tool.description ?? '', parameters: tool.parametersJsonSchema ? parameters : schema(parameters) })
      }
    }
  }
  if (body.toolConfig !== undefined) {
    fields(body.toolConfig, ['functionCallingConfig'], 'toolConfig')
    const config = body.toolConfig.functionCallingConfig
    if (config !== undefined) {
      fields(config, ['mode'], 'functionCallingConfig')
      if (config.mode === 'NONE') tools = []
      else if (config.mode !== undefined && config.mode !== 'AUTO') invalid('only AUTO and NONE function calling modes are supported')
    }
  }
  const request = { model, messages, tools }
  if (body.generationConfig !== undefined) {
    const config = body.generationConfig
    fields(config, ['maxOutputTokens', 'temperature', 'candidateCount', 'responseMimeType', 'thinkingConfig'], 'generationConfig')
    if (config.candidateCount !== undefined && config.candidateCount !== 1) invalid('only one candidate is supported')
    if (config.responseMimeType !== undefined && config.responseMimeType !== 'text/plain') invalid('structured response MIME types are unsupported')
    if (config.maxOutputTokens !== undefined) {
      if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens <= 0) invalid('maxOutputTokens must be a positive integer')
      request.maxTokens = config.maxOutputTokens
    }
    if (config.temperature !== undefined) {
      if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) invalid('temperature must be between 0 and 2')
      request.temperature = config.temperature
    }
    if (config.thinkingConfig !== undefined) {
      const thinking = config.thinkingConfig
      fields(thinking, ['thinkingBudget', 'thinkingLevel', 'includeThoughts'], 'thinkingConfig')
      if (thinking.includeThoughts !== undefined && typeof thinking.includeThoughts !== 'boolean') invalid('includeThoughts must be boolean')
      if (thinking.thinkingLevel !== undefined && thinking.thinkingBudget !== undefined) invalid('use one thinking level or budget')
      if (thinking.thinkingLevel !== undefined) {
        const effort = { MINIMAL: 'light', LOW: 'light', MEDIUM: 'balanced', HIGH: 'deep' }[String(thinking.thinkingLevel).toUpperCase()]
        if (!effort) invalid('unsupported thinkingLevel')
        request.reasoningEffort = effort
      } else if (thinking.thinkingBudget !== undefined) {
        const budget = thinking.thinkingBudget
        if (!Number.isSafeInteger(budget) || budget < -1) invalid('thinkingBudget must be an integer >= -1')
        request.reasoningEffort = budget === 0 ? 'disabled' : budget === -1 ? 'balanced' : budget >= 16384 ? 'deep' : budget >= 4096 ? 'balanced' : 'light'
      }
    }
  }
  return request
}

function usageMetadata(usage = {}) {
  const prompt = usage.inputTokens ?? usage.prompt_tokens ?? usage.input_tokens ?? 0
  const cached = usage.cacheReadTokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
  const output = usage.outputTokens ?? usage.completion_tokens ?? usage.output_tokens ?? 0
  const thoughts = usage.reasoningTokens ?? usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens ?? 0
  const input = usage.inputTokens === undefined ? prompt : prompt + cached
  return {
    promptTokenCount: input, candidatesTokenCount: Math.max(0, output - thoughts),
    totalTokenCount: input + output, thoughtsTokenCount: thoughts, cachedContentTokenCount: cached,
  }
}

function functionPart(call, declared, truncated = false) {
  if (!declared.has(call.name)) upstreamError('model called a function that was not declared')
  let args
  try { args = typeof call.arguments === 'string' ? JSON.parse(call.arguments || '{}') : call.arguments ?? {} }
  catch {
    if (truncated) return null
    upstreamError('model returned invalid function arguments')
  }
  if (!object(args)) upstreamError('model returned non-object function arguments')
  return { functionCall: { ...(call.id ? { id: call.id } : {}), name: call.name, args } }
}

function estimate(request) {
  return countTokens({
    messages: request.messages.map(row => ({
      content: row.content.map(block => block.type === 'tool-call'
        ? { type: 'tool_use', name: block.name, input: JSON.parse(block.arguments) }
        : block.type === 'reasoning' ? { type: 'thinking', thinking: block.text } : block),
    })),
    tools: request.tools.map(tool => ({ ...tool, input_schema: tool.parameters })),
  }).input_tokens
}

/** Factory injects the gateway's bounded reader and existing response helpers. */
export function geminiEndpoint({ readBody, json, modelRows, route, url }) {
  return async (req, res, complete) => {
    // Provider errors can contain a URL. Redact every presented credential,
    // including its percent-encoded spelling, and never pass errors to logging.
    const secrets = [url.searchParams.get('key'), req.headers['x-goog-api-key'], req.headers['x-api-key'], req.headers.authorization?.replace(/^Bearer\s+/i, '')]
      .filter(value => typeof value === 'string' && value)
    const safeMessage = value => {
      let text = String(value ?? 'gateway request failed')
      for (const secret of secrets) for (const spelling of [secret, encodeURIComponent(secret)]) text = text.split(spelling).join('[redacted]')
      return text.slice(0, 1024)
    }
    try {
      if (route.method === 'list' || route.method === 'get') {
        if (req.method !== 'GET') { geminiError(res, 405, 'model discovery requires GET'); return }
        const rows = modelRows().map(row => ({
          name: `models/${row.id}`, displayName: row.id,
          supportedGenerationMethods: methods,
          ...(row.context_window ? { inputTokenLimit: row.context_window } : {}),
        }))
        if (route.method === 'get') {
          const row = rows.find(row => row.name === `models/${route.model}`)
          if (!row) { geminiError(res, 404, 'model not found'); return }
          json(res, 200, row)
        } else {
          const pageSize = url.searchParams.get('pageSize')
          const pageToken = url.searchParams.get('pageToken') ?? '0'
          if ((pageSize !== null && (!/^\d+$/.test(pageSize) || Number(pageSize) < 1)) || !/^\d+$/.test(pageToken)) invalid('invalid model pagination')
          const size = pageSize === null ? 50 : Math.min(1000, Number(pageSize))
          const start = Number(pageToken)
          if (!Number.isSafeInteger(start)) invalid('invalid model pagination')
          json(res, 200, { models: rows.slice(start, start + size), ...(start + size < rows.length ? { nextPageToken: String(start + size) } : {}) })
        }
        return
      }
      if (!methods.includes(route.method)) { geminiError(res, 404, 'unknown Gemini method'); return }
      if (req.method !== 'POST') { geminiError(res, 405, 'generation and token counting require POST'); return }
      const stream = route.method === 'streamGenerateContent'
      if (stream && url.searchParams.get('alt') !== 'sse') invalid('streamGenerateContent requires alt=sse')
      let body = await readBody(req)
      if (route.method === 'countTokens' && body.generateContentRequest !== undefined) {
        fields(body, ['generateContentRequest', 'model'], 'countTokens request')
        if (body.model !== undefined && body.model !== route.model && body.model !== `models/${route.model}`) invalid('body model conflicts with path model')
        body = body.generateContentRequest
      }
      const request = fromGeminiRequest(body, route.model)
      if (route.method === 'countTokens') {
        res.setHeader('x-ofm-token-count-estimated', 'true')
        json(res, 200, { totalTokens: estimate(request) })
        return
      }
      const identity = { modelVersion: route.model, responseId: `gemini-${crypto.randomBytes(12).toString('hex')}` }
      const response = (parts, extra = {}, usage) => ({
        candidates: [{ index: 0, content: { role: 'model', parts }, ...extra }], ...identity,
        ...(usage === undefined ? {} : { usageMetadata: usageMetadata(usage) }),
      })
      const declared = new Set(request.tools.map(tool => tool.name))
      const thoughts = body.generationConfig?.thinkingConfig?.includeThoughts !== false
      const folded = { text: '', thinking: '', toolCalls: [], truncated: false }
      const slots = new Map()
      const sentIds = new Set()
      const sentSignatures = new Map()
      const signature = part => crypto.createHash('sha256').update(JSON.stringify([part.functionCall.name, part.functionCall.args])).digest('hex')
      let pendingBytes = 0
      let usage
      let truncated = false
      let sawText = false
      let sawThought = false
      let chunkFailure
      let renderError
      if (stream) res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
        'access-control-allow-origin': '*', 'x-accel-buffering': 'no',
      })
      const send = payload => {
        if (res.destroyed || res.writableEnded) return
        if (res.writableLength > MAX_PENDING_BYTES) upstreamError('stream client is too slow')
        res.write(`data: ${JSON.stringify(payload)}\n\n`)
      }
      const flushCall = (key, call, allowIncomplete = false) => {
        if ((!slots.has(key) && slots.size >= 1024) || Buffer.byteLength(JSON.stringify(call)) > MAX_PENDING_BYTES) upstreamError('pending function calls exceed stream limit')
        const part = functionPart(call, declared, allowIncomplete || truncated)
        if (!part) return
        send(response([part]))
        sentIds.add(call.id || `slot:${key}`)
        const hash = signature(part)
        sentSignatures.set(hash, (sentSignatures.get(hash) ?? 0) + 1)
        const slot = slots.get(key)
        if (slot) pendingBytes -= Buffer.byteLength(slot.arguments)
        slots.set(key, { sent: true })
      }
      const result = await complete(request, chunk => {
        if (res.destroyed || renderError) return
        try {
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'block-end' && chunk.block && !['text', 'reasoning', 'tool-call'].includes(chunk.block.type)) upstreamError('model returned an unsupported output block')
          if (!stream) { foldAnthropicOutcome(folded, chunk); return }
          switch (chunk.type) {
            case 'text-delta':
            case 'reasoning-delta':
              if (chunk.text) {
                if (chunk.type === 'text-delta') sawText = true
                else sawThought = true
              }
              if (chunk.text && (chunk.type === 'text-delta' || thoughts)) send(response([{ text: chunk.text, ...(chunk.type === 'reasoning-delta' ? { thought: true } : {}) }]))
              break
            case 'tool-call-delta': {
              const slot = slots.get(chunk.index) ?? { id: '', name: '', arguments: '' }
              if (slot.sent) break
              if (chunk.id) slot.id = chunk.id
              if (chunk.name) slot.name = chunk.name
              const delta = chunk.argumentsDelta ?? ''
              pendingBytes += Buffer.byteLength(delta)
              if (pendingBytes > MAX_PENDING_BYTES || (!slots.has(chunk.index) && slots.size >= 1024)) upstreamError('pending function calls exceed stream limit')
              slot.arguments += delta
              slots.set(chunk.index, slot)
              break
            }
            case 'block-end':
              if (chunk.block?.type === 'tool-call' && !slots.get(chunk.index)?.sent) {
                const slot = slots.get(chunk.index)
                const call = { ...slot, ...chunk.block, id: chunk.block.id || slot?.id, name: chunk.block.name || slot?.name }
                pendingBytes += Buffer.byteLength(call.arguments ?? '') - Buffer.byteLength(slot?.arguments ?? '')
                if (pendingBytes > MAX_PENDING_BYTES || (!slot && slots.size >= 1024)) upstreamError('pending function calls exceed stream limit')
                slots.set(chunk.index, call)
                // A max-token finish may follow a partial block-end. Hold the
                // broken call until that finish distinguishes truncation from
                // invalid JSON on an otherwise completed turn.
                flushCall(chunk.index, call, true)
              }
              break
            case 'usage': usage = chunk.usage; break
            case 'finish':
              truncated = chunk.reason?.kind === 'max-tokens'
              if (['error', 'aborted'].includes(chunk.reason?.kind)) chunkFailure = {
                error: chunk.reason.failure?.message ?? 'generation aborted',
                failure: chunk.reason.failure ?? { code: 'ABORTED' },
              }
              break
            default: break
          }
        } catch (error) {
          renderError = error
          // The shared wrapper releases the adapter iterator and returns a
          // failed outcome when the rendering callback throws.
          throw error
        }
      })
      if (res.destroyed) return
      if (renderError) throw renderError
      const failed = result?.error !== undefined ? result : chunkFailure ?? (folded.error !== undefined ? folded : undefined)
      if (failed) {
        const failure = forwardFailure(failed)
        if (!res.headersSent && failure.retryAfterMs !== undefined) res.setHeader('retry-after', String(Math.ceil(failure.retryAfterMs / 1000)))
        geminiError(res, failure.status, safeMessage(failure.error.message))
        return
      }
      truncated ||= result?.truncated === true || folded.truncated
      const finish = { finishReason: truncated ? 'MAX_TOKENS' : 'STOP' }
      if (stream) {
        if (!sawThought && thoughts && result?.thinking) send(response([{ text: result.thinking, thought: true }]))
        if (!sawText && result?.text) send(response([{ text: result.text }]))
        for (const [key, slot] of slots) {
          if (slot.sent) continue
          flushCall(key, slot)
        }
        // Some adapters only publish calls in their final outcome.
        for (const call of result?.toolCalls ?? []) {
          const part = functionPart(call, declared, truncated)
          if (!part) continue
          const hash = signature(part)
          const count = sentSignatures.get(hash) ?? 0
          if (count) sentSignatures.set(hash, count - 1)
          if (sentIds.has(call.id || `slot:${call.slot}`)) continue
          if (!call.id && call.slot === undefined && count) continue
          send(response([part]))
        }
        send(response([], finish, usage ?? result?.usage ?? {}))
        res.end()
      } else {
        const text = folded.text || result?.text || ''
        const thinking = folded.thinking || result?.thinking || ''
        const parts = [
          ...(thinking && thoughts ? [{ text: thinking, thought: true }] : []),
          ...(text ? [{ text }] : []),
        ]
        for (const call of folded.toolCalls.length ? folded.toolCalls : result?.toolCalls ?? []) {
          const part = functionPart(call, declared, truncated)
          if (part) parts.push(part)
        }
        json(res, 200, response(parts, finish, usage ?? result?.usage ?? folded.usage ?? {}))
      }
    } catch (error) {
      const code = Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500
      geminiError(res, code, safeMessage(error?.message))
    }
  }
}
