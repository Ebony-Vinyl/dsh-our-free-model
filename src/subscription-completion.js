import crypto from 'node:crypto'
import { fromOpenAiMessages, foldForwardOutcome } from './core/completion.js'
import { toChatMessages, toClaudeMessages, toResponseInput, toToolDefs, repairToolPairing } from './messages.js'
import { readStream, finishReason } from './stream.js'
import { readSse } from './http.js'
import { recordUsage, recordTurn } from './store.js'

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
const failure = (code, message, statusCode = 502) => Object.assign(new Error(message), { code, statusCode })

function safeError(error, signal, timedOut) {
  if (timedOut) return failure('TIMEOUT', 'Subscription completion timed out', 504)
  if (signal?.aborted) return failure('ABORTED', 'Subscription completion aborted', 499)
  const messages = {
    AUTH_REQUIRED: 'Subscription credentials require re-import',
    TIMEOUT: 'Subscription completion timed out',
    ABORTED: 'Subscription completion aborted',
    DISABLED: 'Subscription account disabled', NOT_FOUND: 'Subscription model not found',
    INVALID_INPUT: 'Invalid subscription completion request',
    STORAGE_ERROR: 'Cannot persist private subscription storage',
    RATE_LIMIT: 'Subscription provider rate limit reached',
    INVALID_RESPONSE: 'Invalid subscription provider response',
    TRUNCATED_STREAM: 'Subscription provider stream ended before completion',
    NETWORK_ERROR: 'Subscription provider request failed',
    PROVIDER_ERROR: 'Subscription provider rejected the completion',
    CONTENT_BLOCKED: 'Subscription provider blocked the completion',
  }
  const code = Object.hasOwn(messages, error?.code) ? error.code : 'PROVIDER_ERROR'
  return failure(code, messages[code], ({
    AUTH_REQUIRED: 401, TIMEOUT: 504, ABORTED: 499, DISABLED: 409, NOT_FOUND: 404, INVALID_INPUT: 400, RATE_LIMIT: 429, STORAGE_ERROR: 500,
  })[code] ?? 502)
}

function toolsOf(request) {
  return Array.isArray(request.tools) ? request.tools : Array.isArray(request.openAi?.tools) ? request.openAi.tools : []
}

function toolChoice(value, wire) {
  if (value === undefined) return {}
  const name = value?.function?.name ?? value?.name
  if (!['auto', 'none', 'required', 'any'].includes(value) && typeof name !== 'string') {
    throw failure('INVALID_INPUT', 'Invalid tool choice', 400)
  }
  if (wire === 'gemini-code-assist') {
    return { toolConfig: { functionCallingConfig: {
      mode: typeof name === 'string' || value === 'required' || value === 'any' ? 'ANY'
        : value === 'none' ? 'NONE' : 'AUTO',
      ...(typeof name === 'string' ? { allowedFunctionNames: [name] } : {}),
    } } }
  }
  if (wire === 'messages') {
    return { tool_choice: typeof name === 'string' ? { type: 'tool', name }
      : { type: value === 'required' || value === 'any' ? 'any' : value } }
  }
  return { tool_choice: typeof name === 'string'
    ? wire === 'responses' ? { type: 'function', name } : { type: 'function', function: { name } }
    : value === 'any' ? 'required' : value }
}

function geminiRequest(messages, tools, maxTokens, temperature, signatures, resolveImage) {
  // Reuse the shared message projection, including pairing repair and images.
  const chat = toChatMessages(messages, resolveImage)
  const system = []
  const contents = []
  const names = new Map()
  for (const message of chat) {
    if (message.role === 'system' || message.role === 'developer') { system.push({ text: message.content }); continue }
    const parts = []
    if (message.role === 'tool') {
      let output
      try { output = JSON.parse(message.content) } catch { output = { output: message.content } }
      if (!object(output)) output = { output }
      parts.push({ functionResponse: {
        id: message.tool_call_id, name: names.get(message.tool_call_id) ?? 'tool', response: output,
      } })
    } else {
      for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
        if (block.type === 'text') parts.push({ text: block.text })
        if (block.type === 'image_url') {
          const uri = block.image_url?.url
          const data = typeof uri === 'string' ? /^data:([^;,]+);base64,(.+)$/.exec(uri) : null
          if (data) parts.push({ inlineData: { mimeType: data[1], data: data[2] } })
          else if (typeof uri === 'string') parts.push({ fileData: { mimeType: 'image/png', fileUri: uri } })
        }
      }
      for (const call of message.tool_calls ?? []) {
        names.set(call.id, call.function.name)
        let args
        try { args = JSON.parse(call.function.arguments || '{}') }
        catch { throw failure('INVALID_INPUT', 'Invalid tool call arguments', 400) }
        parts.push({
          functionCall: { id: call.id, name: call.function.name, args },
          thoughtSignature: signatures.get(call.id) ?? 'skip_thought_signature_validator',
        })
      }
    }
    if (!parts.length) continue
    const role = message.role === 'assistant' ? 'model' : 'user'
    const last = contents.at(-1)
    if (last?.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }
  return {
    contents,
    ...(system.length ? { systemInstruction: { parts: system } } : {}),
    ...(tools.length ? { tools: [{ functionDeclarations: toToolDefs(tools, 'flat').map(tool => ({
      name: tool.name, description: tool.description, parametersJsonSchema: tool.parameters,
    })) }] } : {}),
    generationConfig: {
      ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
      ...(temperature === undefined ? {} : { temperature }),
    },
  }
}

function payloadFor(config, request, signatures, resolveImage) {
  const raw = object(request.openAi) ? request.openAi : {}
  let messages = Array.isArray(request.messages) ? request.messages : fromOpenAiMessages(raw, request.responses === true, request.model)
  if (typeof raw.instructions === 'string' && raw.instructions) {
    messages = [{ role: 'system', content: [{ type: 'text', text: raw.instructions }] }, ...messages]
  }
  messages = repairToolPairing(messages)
  const tools = toolsOf(request)
  const maxTokens = request.maxTokens ?? raw.max_tokens ?? raw.max_completion_tokens ?? raw.max_output_tokens
  const temperature = request.temperature ?? raw.temperature
  if (maxTokens !== undefined && (!Number.isSafeInteger(maxTokens) || maxTokens < 1)
    || temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0)) {
    throw failure('INVALID_INPUT', 'Invalid generation settings', 400)
  }
  const choice = toolChoice(request.toolChoice ?? raw.tool_choice, config.wire)
  if (config.wire === 'gemini-code-assist') {
    return {
      model: config.model, project: config.project ?? '',
      user_prompt_id: crypto.randomUUID(),
      request: { ...geminiRequest(messages, tools, maxTokens, temperature, signatures, resolveImage), ...choice },
    }
  }
  if (config.wire === 'responses') {
    const system = messages.filter(row => row.role === 'system' || row.role === 'developer')
    const instructions = system.map(row => typeof row.content === 'string' ? row.content
      : row.content.filter(part => part.type === 'text').map(part => part.text).join('\n')).join('\n\n')
    return {
      model: config.model, stream: true, store: false,
      instructions: instructions || 'You are a helpful assistant.',
      input: toResponseInput(config.provider === 'codex'
        ? messages.filter(row => row.role !== 'system' && row.role !== 'developer') : messages, resolveImage),
      ...(tools.length ? { tools: toToolDefs(tools, 'flat') } : {}), ...choice,
      // Codex's ChatGPT backend rejects max_output_tokens and temperature.
      ...(config.provider === 'codex' || maxTokens === undefined ? {} : { max_output_tokens: maxTokens }),
      ...(config.provider === 'codex' || temperature === undefined ? {} : { temperature }),
      ...(typeof (request.reasoningEffort ?? raw.reasoning_effort) === 'string'
        ? { reasoning: { effort: request.reasoningEffort ?? raw.reasoning_effort } } : {}),
    }
  }
  if (config.wire === 'messages') {
    const shaped = toClaudeMessages(messages, resolveImage)
    return {
      model: config.model, stream: true, max_tokens: maxTokens ?? 8192, messages: shaped.messages,
      ...(shaped.system ? { system: shaped.system } : {}),
      ...(tools.length ? { tools: toToolDefs(tools, 'claude') } : {}), ...choice,
      ...(temperature === undefined ? {} : { temperature }),
    }
  }
  return {
    model: config.model, stream: true, stream_options: { include_usage: true },
    messages: toChatMessages(messages, resolveImage),
    ...(tools.length ? { tools: toToolDefs(tools, 'chat') } : {}), ...choice,
    ...(maxTokens === undefined ? {} : { max_tokens: maxTokens }),
    ...(temperature === undefined ? {} : { temperature }),
    ...(typeof (request.reasoningEffort ?? raw.reasoning_effort) === 'string'
      ? { reasoning_effort: request.reasoningEffort ?? raw.reasoning_effort } : {}),
  }
}

function translateGemini(raw, signatures, counters) {
  const envelope = JSON.parse(raw)
  const payload = envelope.response ?? envelope
  if (payload.error || envelope.error) throw failure('PROVIDER_ERROR', 'Provider stream failed')
  if (payload.promptFeedback?.blockReason) throw failure('CONTENT_BLOCKED', 'Provider blocked completion')
  const output = []
  for (const candidate of payload.candidates ?? []) {
    if (candidate.index !== undefined && candidate.index !== 0) continue
    for (const part of candidate.content?.parts ?? []) {
      if (typeof part.text === 'string') {
        output.push({ choices: [{ delta: { [part.thought ? 'reasoning_content' : 'content']: part.text } }] })
      }
      if (object(part.functionCall)) {
        const call = part.functionCall
        const id = typeof call.id === 'string' && call.id ? call.id : `call_${crypto.randomUUID()}`
        if (typeof part.thoughtSignature === 'string') {
          signatures.set(id, part.thoughtSignature)
          if (signatures.size > 512) signatures.delete(signatures.keys().next().value)
        }
        output.push({ choices: [{ delta: { tool_calls: [{
          index: counters.tools++, id, type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        }] } }] })
      }
    }
    if (candidate.finishReason) {
      if (!['STOP', 'MAX_TOKENS', 'FINISH_REASON_UNSPECIFIED'].includes(candidate.finishReason)) {
        throw failure('CONTENT_BLOCKED', 'Provider blocked completion')
      }
      output.push({ choices: [{ delta: {}, finish_reason: candidate.finishReason === 'MAX_TOKENS' ? 'length'
        : counters.tools > 0 ? 'tool_calls' : 'stop' }] })
    }
  }
  if (object(payload.usageMetadata)) {
    const usage = payload.usageMetadata
    const generated = number(usage.candidatesTokenCount) ?? 0
    const thoughts = number(usage.thoughtsTokenCount) ?? 0
    output.push({ choices: [], usage: {
      prompt_tokens: number(usage.promptTokenCount) ?? 0,
      completion_tokens: generated + thoughts,
      prompt_tokens_details: { cached_tokens: number(usage.cachedContentTokenCount) ?? 0 },
      completion_tokens_details: { reasoning_tokens: thoughts },
    } })
  }
  return output.map(item => JSON.stringify(item))
}

// readSse provides the existing abortable framing; the queue lets readStream
// consume events while the network is still producing them.
async function* streamLines(source, signal, timeoutMs, translate) {
  const queue = []
  let notify, ended = false, error, projectionError
  const pending = readSse(source, raw => {
    try {
      if (Buffer.byteLength(raw) > 4 * 1024 * 1024 || queue.length > 4096) {
        throw failure('INVALID_RESPONSE', 'Provider stream event too large')
      }
      for (const line of translate ? translate(raw) : [raw]) queue.push(line)
    } catch (cause) {
      projectionError = cause
      throw cause
    }
    notify?.()
  }, signal, timeoutMs).catch(cause => { error = projectionError ?? cause }).finally(() => { ended = true; notify?.() })
  try {
    while (!ended || queue.length) {
      if (queue.length) yield queue.shift()
      else await new Promise(resolve => { notify = resolve })
    }
    if (error) throw error
  } finally {
    // The caller aborts its controller before awaiting this task on failure.
    // Observe late errors even when readStream stops at an error event.
    void pending.catch(() => {})
  }
}

/**
 * Match only actual credential prefixes. The trie is linear in credential
 * length; each block retains at most one prefix, never its ordinary output.
 * At a block boundary an unresolved prefix is masked conservatively so that
 * concatenating different blocks or content types cannot reconstruct a secret.
 */
function credentialRedactor(secrets, deliver) {
  const root = { children: new Map(), terminal: false }
  for (const secret of new Set(secrets)) {
    let node = root
    for (let i = 0; i < secret.length; i++) {
      const char = secret[i]
      if (!node.children.has(char)) node.children.set(char, { children: new Map(), terminal: false })
      node = node.children.get(char)
    }
    node.terminal = true
  }
  const scan = (text, final = false) => {
    let output = '', position = 0
    while (position < text.length) {
      let node = root, end = position, matched = 0
      while (end < text.length && node.children.has(text[end])) {
        node = node.children.get(text[end++])
        if (node.terminal) matched = end - position
      }
      if (end === text.length && node.children.size && end > position) {
        if (final) return { output: output + '[redacted]', pending: '' }
        return { output, pending: text.slice(position) }
      }
      if (matched) { output += '[redacted]'; position += matched }
      else { output += text[position++] }
    }
    return { output, pending: '' }
  }
  const clean = (value, key) => {
    if (['type', 'blockType', 'kind'].includes(key)) return value
    if (typeof value === 'string') return scan(value, true).output
    if (Array.isArray(value)) return value.map(clean)
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, clean(child, name)]))
    return value
  }
  const pending = new Map()
  let held = 0
  const fieldFor = chunk => chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' ? 'text'
    : chunk.type === 'tool-call-delta' ? 'argumentsDelta' : null
  return chunk => {
    const field = fieldFor(chunk)
    if (field) {
      const prior = pending.get(chunk.index)
      if (prior) held -= prior.text.length
      const result = scan((prior?.text ?? '') + (chunk[field] ?? ''))
      const metadata = { ...chunk }
      delete metadata[field]
      const safe = clean(metadata)
      pending.delete(chunk.index)
      if (result.pending) {
        held += result.pending.length
        if (held > 131072 || pending.size >= 4096) throw failure('INVALID_RESPONSE', 'Provider redaction buffer exceeded')
        pending.set(chunk.index, { text: result.pending, chunk: safe, field })
      }
      if (result.output || field === 'argumentsDelta') deliver({ ...safe, [field]: result.output })
      return
    }
    if (chunk.type === 'block-end') {
      const prior = pending.get(chunk.index)
      if (prior) {
        held -= prior.text.length
        pending.delete(chunk.index)
        deliver({ ...prior.chunk, [prior.field]: scan(prior.text, true).output })
      }
    }
    // Assembled blocks are sanitized independently with the same final-boundary
    // policy, including tool identity and arguments; raw blocks never escape.
    deliver(clean(chunk))
  }
}

/**
 * Server-only completion runtime for imported accounts. stats may be the
 * existing JsonStore or an object with recordUsage(record)/recordTurn(record).
 * No network is performed until complete(). Catalog updates follow list().
 * resolveImage(attachment) synchronously returns a URL, as in the core adapter.
 * complete() may override it with request.resolveImage for that call only.
 */
export function createSubscriptionRuntime({
  subscriptions, stats, logger, fetchImpl = globalThis.fetch, timeoutMs = 300000, resolveImage,
} = {}) {
  if (typeof subscriptions?.list !== 'function' || typeof subscriptions?.resolve !== 'function'
    || (resolveImage !== undefined && typeof resolveImage !== 'function')
    || typeof fetchImpl !== 'function' || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw failure('INVALID_INPUT', 'Invalid subscription runtime configuration', 400)
  }
  const signatures = new Map()
  const catalog = () => subscriptions.list().filter(account => account.enabled).flatMap(account => account.models.map(model => {
    const value = typeof model === 'string' ? model : model.id
    const id = value.startsWith('subscription:') ? value : `subscription:${account.id}/${value}`
    return {
      id, name: id.slice(id.indexOf('/') + 1), provider: 'subscriptions',
      subscriptionId: account.id, subscriptionProvider: account.provider, wire: account.format,
    }
  }))
  const publicModelRows = () => catalog().map(entry => ({
    id: entry.id, object: 'model', created: 0, owned_by: entry.subscriptionProvider,
  }))
  // Own the entire namespace so a disabled/removed account gets a subscription
  // error instead of falling through into an unrelated pooled provider.
  const handles = id => typeof id === 'string' && id.startsWith('subscription:')
  const complete = async (request, onChunk = () => {}) => {
    if (!object(request) || typeof request.model !== 'string' || !handles(request.model)
      || (request.resolveImage !== undefined && typeof request.resolveImage !== 'function')
      || typeof onChunk !== 'function') throw failure('INVALID_INPUT', 'Invalid subscription completion request', 400)
    if (!catalog().some(entry => entry.id === request.model)) throw failure('NOT_FOUND', 'Subscription model not found', 404)
    const controller = new AbortController()
    let timedOut = false
    const onAbort = () => controller.abort()
    if (request.signal?.aborted) throw failure('ABORTED', 'Subscription completion aborted', 499)
    request.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    let rejectAbort
    const interrupted = new Promise((_, reject) => {
      rejectAbort = () => reject(safeError({}, request.signal, timedOut))
    })
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
    const started = Date.now()
    let config, response, streamState, firstDelta, thrown
    try {
      config = await Promise.race([subscriptions.resolve(request.model, { signal: controller.signal }), interrupted])
      const accountSignatures = signatures.get(config.id) ?? new Map()
      signatures.set(config.id, accountSignatures)
      if (signatures.size > 100) signatures.delete(signatures.keys().next().value)
      const payload = payloadFor(config, request, accountSignatures, request.resolveImage ?? resolveImage)
      const secrets = Object.entries(config.headers).filter(([key]) => /authorization|api-key|account-id/i.test(key))
        .map(([, value]) => value.replace(/^Bearer /, '')).filter(Boolean)
      const emit = credentialRedactor(secrets, chunk => {
        onChunk(chunk)
        foldForwardOutcome(outcome, chunk)
      })
      try {
        response = await Promise.race([fetchImpl(config.endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: {
            ...config.headers, 'content-type': 'application/json', accept: 'text/event-stream',
            ...(config.provider === 'gemini' ? { 'user-agent': `GeminiCLI/0.61.0/${config.model} (${process.platform}; ${process.arch}; terminal)` } : {}),
          },
          body: JSON.stringify(payload),
        }), interrupted])
      } catch (error) {
        if (controller.signal.aborted) throw error
        throw failure('NETWORK_ERROR', 'Subscription provider request failed')
      }
      if (!response.ok) {
        throw failure(response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED'
          : response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_ERROR', 'Provider rejected completion')
      }
      if (!response.body) throw failure('INVALID_RESPONSE', 'Provider response has no stream')
      const counters = { tools: 0 }
      const lines = streamLines(response.body, controller.signal, timeoutMs,
        config.wire === 'gemini-code-assist' ? raw => translateGemini(raw, accountSignatures, counters) : undefined)
      const iterator = readStream(lines, config.wire === 'gemini-code-assist' ? 'chat' : config.wire, new Map(),
        () => Date.now(), { onState: state => { streamState = state } })
      while (true) {
        const item = await Promise.race([iterator.next(), interrupted])
        if (item.done) { streamState = item.value; break }
        if (firstDelta === undefined && ['text-delta', 'reasoning-delta', 'tool-call-delta'].includes(item.value.type)) firstDelta = Date.now()
        emit(item.value)
      }
      if (!streamState?.sawFinish) throw failure('TRUNCATED_STREAM', 'Provider stream incomplete')
      if (streamState.finish === 'failed') throw failure('PROVIDER_ERROR', 'Provider stream failed')
      if (['content_filter', 'refusal', 'cancelled'].includes(streamState.finish)) {
        throw failure('CONTENT_BLOCKED', 'Provider blocked completion')
      }
      if (streamState.sawUsage) emit({ type: 'usage', usage: streamState.usage })
      const reason = streamState.brokenToolCall ? { kind: 'max-tokens' } : finishReason(streamState.finish)
      emit({ type: 'finish', reason })
      if (outcome.truncated) {
        outcome.toolCalls = outcome.toolCalls.filter(call => {
          try { JSON.parse(call.arguments || '{}'); return !!call.name } catch { return false }
        })
      }
      return outcome
    } catch (error) {
      thrown = safeError(error, request.signal, timedOut)
      throw thrown
    } finally {
      controller.abort()
      clearTimeout(timer)
      request.signal?.removeEventListener('abort', onAbort)
      controller.signal.removeEventListener('abort', rejectAbort)
      // Observe interruption even when failure occurred before its first race.
      void interrupted.catch(() => {})
      try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}) } catch {}
      const usage = streamState?.sawUsage ? streamState.usage : undefined
      const record = {
        at: Date.now(), model: request.model, provider: config?.provider ?? 'subscriptions',
        ok: !thrown, elapsedMs: Date.now() - started,
        input: usage?.inputTokens ?? 0, output: usage?.outputTokens ?? 0,
        cacheRead: usage?.cacheReadTokens ?? 0, reasoning: usage?.reasoningTokens ?? 0,
        ...(firstDelta === undefined ? {} : { ttftMs: firstDelta - started }),
      }
      try {
        // Physical usage always belongs to the model that served the call. The
        // logical turn belongs to whoever owns the turn: a combo chain records
        // its own single turn, so a member reached through one must not add a
        // second (request.recordTurn is false there).
        if (typeof stats?.edit === 'function') {
          recordUsage(stats, record)
          if (request.recordTurn !== false) recordTurn(stats, record)
        } else {
          stats?.recordUsage?.(record)
          if (request.recordTurn !== false) stats?.recordTurn?.(record)
        }
      } catch { /* Telemetry must not alter a completed model turn. */ }
      if (thrown) {
        try { logger?.warn?.(`Subscription completion failed (${thrown.code})`) } catch {}
      }
    }
  }
  const routingQuota = () => Object.fromEntries(subscriptions.list().filter(account => account.enabled)
    .flatMap(account => account.models.map(model => {
      const value = typeof model === 'string' ? model : model.id
      const id = value.startsWith('subscription:') ? value : `subscription:${account.id}/${value}`
      return [id, { status: account.quota?.status ?? 'unknown', checkedAt: account.quota?.checkedAt ?? null,
        windows: (account.quota?.windows ?? []).map(window => ({
          kind: window.kind, remainingPercent: window.remainingPercent, resetsAt: window.resetsAt, windowSeconds: window.windowSeconds,
        })) }]
    })))
  return { catalog, publicModelRows, handles, complete, routingQuota }
}
