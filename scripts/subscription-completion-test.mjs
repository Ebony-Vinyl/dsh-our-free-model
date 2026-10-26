import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { once } from 'node:events'
import { createSubscriptions } from '../src/subscriptions.js'
import { createSubscriptionRuntime } from '../src/subscription-completion.js'
import { STATS_INITIAL } from '../src/store.js'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-subscription-completion-'))
let checks = 0
let failures = 0
const TOKEN = 'private-subscription-access-123456789'
const KEY = 'private-third-party-key-123456789'
const ACCOUNT = 'private-chatgpt-account-123456789'
const check = async (name, run) => {
  checks++
  try { await run(); console.log(`ok ${checks} - ${name}`) }
  catch (error) { failures++; console.error(`not ok ${checks} - ${name}\n${error.stack}`) }
}
const assertClean = value => {
  const encoded = JSON.stringify(value)
  for (const secret of [TOKEN, KEY, ACCOUNT]) assert.ok(!encoded.includes(secret), 'output exposes a credential')
}
const errorCode = code => error => { assert.equal(error.code, code); assertClean({ ...error, message: error.message }); return true }
const sse = events => new Response(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } })
const chatEvents = () => [
  { choices: [{ delta: { content: 'Hello ' } }] },
  { choices: [{ delta: { content: 'world' } }] },
  { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } },
  '[DONE]',
]
const responseEvents = () => [
  { type: 'response.output_text.delta', output_index: 0, delta: 'Codex answer' },
  { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 12, output_tokens: 5 } } },
]
const claudeEvents = () => [
  { type: 'message_start', message: { usage: { input_tokens: 11, output_tokens: 0, cache_read_input_tokens: 2 } } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Thinking.' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Claude answer' } },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
]
const geminiEvents = () => [
  { response: { candidates: [{ content: { parts: [{ text: 'Reasoning.', thought: true }] } }] } },
  { response: { candidates: [{ content: { parts: [{ text: 'Gemini answer' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 3, cachedContentTokenCount: 4 } } },
]
function setup(provider = 'api', { fetchImpl = async () => sse(chatEvents()), format = 'openai-chat',
  models = ['test-model'], project = 'saved-project', ...runtimeOptions } = {}) {
  const subscriptions = createSubscriptions({
    dataDir: path.join(scratch, crypto.randomUUID()), fetchImpl,
  })
  const credentials = provider === 'codex' ? { tokens: { access_token: TOKEN, account_id: ACCOUNT } }
    : provider === 'claude' ? { claudeAiOauth: { accessToken: TOKEN, expiresAt: Date.now() + 3600000 } }
      : provider === 'gemini' ? { access_token: TOKEN, expiry_date: Date.now() + 3600000, ...(project ? { project } : {}) }
        : { apiKey: KEY }
  const account = subscriptions.import({ provider, credentials, models,
    ...(provider === 'api' ? { baseUrl: 'http://127.0.0.1:9988/v1', format } : {}) })
  const runtime = createSubscriptionRuntime({ subscriptions, fetchImpl, ...runtimeOptions })
  const model = `subscription:${account.id}/${models[0]}`
  return { subscriptions, runtime, account, model }
}
const request = model => ({ model, openAi: { messages: [{ role: 'user', content: 'Hi' }] } })
const redactionRuntime = (events, secrets = [KEY], options = {}) => createSubscriptionRuntime({
  subscriptions: {
    list: () => [{ id: 'redaction', provider: 'api', enabled: true, models: ['model'] }],
    resolve: async () => ({
      id: 'redaction', model: 'model', provider: 'api', wire: 'chat', endpoint: 'https://fixture.invalid/v1/chat/completions',
      headers: Object.fromEntries(secrets.map((secret, index) => [
        index === 0 ? 'authorization' : `x-api-key-${index}`, index === 0 ? `Bearer ${secret}` : secret,
      ])),
    }),
  },
  fetchImpl: async () => sse(events), ...options,
})
const assertRedactedLifecycle = (chunks, outcome, secrets = [KEY]) => {
  const material = [JSON.stringify(chunks), JSON.stringify(outcome), outcome.text]
  for (const type of ['text-delta', 'reasoning-delta', 'tool-call-delta']) {
    material.push(chunks.filter(chunk => chunk.type === type).map(chunk => chunk.text ?? chunk.argumentsDelta ?? '').join(''))
  }
  material.push(chunks.filter(chunk => chunk.type === 'block-end').map(chunk =>
    chunk.block.text ?? chunk.block.arguments ?? '').join(''))
  for (const secret of secrets) {
    for (const text of material) assert.ok(!text.includes(secret), 'credential reconstructed from public stream/outcome')
  }
  for (const end of chunks.filter(chunk => chunk.type === 'block-end')) {
    const deltas = chunks.filter(chunk => chunk.index === end.index && /-delta$/.test(chunk.type))
    assert.equal(deltas.map(chunk => chunk.text ?? chunk.argumentsDelta ?? '').join(''),
      end.block.text ?? end.block.arguments ?? '', 'assembled block must agree with its sanitized deltas')
  }
}

try {
  await check('catalog/publicModelRows expose composite IDs and track enable/remove synchronously', () => {
    const { runtime, subscriptions, account, model } = setup()
    assert.equal(runtime.catalog()[0].id, model)
    assert.deepEqual(runtime.publicModelRows(), [{ id: model, object: 'model', created: 0, owned_by: 'api' }])
    assert.equal(runtime.handles(model), true)
    assert.equal(runtime.handles('ordinary-model'), false)
    subscriptions.setEnabled({ id: account.id, enabled: false })
    assert.deepEqual(runtime.catalog(), [])
    assert.equal(runtime.handles(model), true)
    subscriptions.remove({ id: account.id })
    assert.deepEqual(runtime.publicModelRows(), [])
    assertClean(runtime.catalog())
  })
  await check('third-party Chat completion shapes messages and returns live chunks, usage and outcome', async () => {
    let posted
    const { runtime, model } = setup('api', { fetchImpl: async (endpoint, options) => {
      posted = { endpoint, options, body: JSON.parse(options.body) }
      return sse(chatEvents())
    } })
    const chunks = []
    const result = await runtime.complete({ ...request(model), maxTokens: 100, temperature: 0.3 }, chunk => chunks.push(chunk))
    assert.equal(posted.endpoint, 'http://127.0.0.1:9988/v1/chat/completions')
    assert.equal(posted.options.headers.authorization, `Bearer ${KEY}`)
    assert.equal(posted.options.redirect, 'error')
    assert.equal(posted.body.model, 'test-model')
    assert.deepEqual(posted.body.messages, [{ role: 'user', content: 'Hi' }])
    assert.equal(posted.body.max_tokens, 100)
    assert.equal(posted.body.temperature, 0.3)
    assert.equal(result.text, 'Hello world')
    assert.equal(result.usage.prompt_tokens, 10)
    assert.equal(result.usage.completion_tokens, 3)
    assert.equal(chunks.filter(chunk => chunk.type === 'finish').length, 1)
    assert.equal(chunks.at(-1).type, 'finish')
    assertClean({ chunks, result })
  })
  await check('official Codex uses fixed Responses endpoint, instructions, store=false and account header', async () => {
    let posted
    const { runtime, model } = setup('codex', { fetchImpl: async (endpoint, options) => {
      posted = { endpoint, options, body: JSON.parse(options.body) }
      return sse(responseEvents())
    } })
    const result = await runtime.complete({
      ...request(model), maxTokens: 99, temperature: 0.5, reasoningEffort: 'high',
      openAi: { messages: [{ role: 'system', content: 'Be precise.' }, { role: 'user', content: 'Hi' }], store: true },
    })
    assert.equal(posted.endpoint, 'https://chatgpt.com/backend-api/codex/responses')
    assert.equal(posted.options.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(posted.options.headers['chatgpt-account-id'], ACCOUNT)
    assert.equal(posted.body.instructions, 'Be precise.')
    assert.equal(posted.body.store, false)
    assert.equal(posted.body.stream, true)
    assert.equal(posted.body.max_output_tokens, undefined)
    assert.equal(posted.body.temperature, undefined)
    assert.equal(posted.body.reasoning.effort, 'high')
    assert.ok(!posted.body.input.some(row => row.role === 'system'))
    assert.equal(result.text, 'Codex answer')
    assert.equal(result.usage.completion_tokens, 5)
  })
  await check('Responses callers and third-party Responses retain input, tools and generation controls', async () => {
    let body
    const { runtime, model } = setup('api', { format: 'openai-responses', fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'http://127.0.0.1:9988/v1/responses')
      body = JSON.parse(options.body)
      return sse(responseEvents())
    } })
    await runtime.complete({ model, responses: true, openAi: {
      instructions: 'Keep it brief.', input: 'Hi', max_output_tokens: 120, temperature: 0.2,
      tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'read' },
    } })
    assert.equal(body.instructions, 'Keep it brief.')
    assert.equal(body.max_output_tokens, 120)
    assert.equal(body.temperature, 0.2)
    assert.equal(body.tools[0].name, 'read')
    assert.deepEqual(body.tool_choice, { type: 'function', name: 'read' })
    assert.ok(body.input.some(row => row.role === 'user'))
  })
  await check('official Claude bearer/OAuth headers and Messages shaping stream reasoning and usage', async () => {
    let body
    const { runtime, model } = setup('claude', { fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'https://api.anthropic.com/v1/messages')
      assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
      assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20')
      assert.equal(options.headers['anthropic-version'], '2023-06-01')
      assert.equal(options.headers['x-api-key'], undefined)
      body = JSON.parse(options.body)
      return sse(claudeEvents())
    } })
    const chunks = []
    const result = await runtime.complete({
      model, messages: [
        { role: 'system', content: [{ type: 'text', text: 'System instructions' }] },
        { role: 'user', content: [{ type: 'text', text: 'Question' }] },
      ], tools: [{ name: 'read', parameters: { type: 'object', properties: {} } }], toolChoice: 'required',
    }, chunk => chunks.push(chunk))
    assert.equal(body.system, 'System instructions')
    assert.equal(body.max_tokens, 8192)
    assert.equal(body.messages[0].role, 'user')
    assert.equal(body.tools[0].input_schema.type, 'object')
    assert.deepEqual(body.tool_choice, { type: 'any' })
    assert.equal(result.text, 'Claude answer')
    assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'Thinking.'))
    assert.equal(result.usage.completion_tokens, 7)
  })
  await check('third-party Anthropic API uses x-api-key and its own endpoint', async () => {
    const { runtime, model } = setup('api', { format: 'anthropic-messages', fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'http://127.0.0.1:9988/v1/messages')
      assert.equal(options.headers['x-api-key'], KEY)
      assert.equal(options.headers.authorization, undefined)
      assert.equal(options.headers['anthropic-beta'], undefined)
      return sse(claudeEvents())
    } })
    assert.equal((await runtime.complete(request(model))).text, 'Claude answer')
  })
  await check('Gemini CodeAssist wraps model/project/request and translates reasoning/text/usage', async () => {
    let body
    const { runtime, model } = setup('gemini', { fetchImpl: async (endpoint, options) => {
      assert.equal(endpoint, 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse')
      assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
      body = JSON.parse(options.body)
      return sse(geminiEvents())
    } })
    const chunks = []
    const result = await runtime.complete({
      ...request(model), maxTokens: 300, temperature: 0.2,
      openAi: { messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hi' }] },
      tools: [{ name: 'read', description: 'Read file', parameters: { type: 'object' } }],
      toolChoice: { name: 'read' },
    }, chunk => chunks.push(chunk))
    assert.equal(body.model, 'test-model')
    assert.equal(body.project, 'saved-project')
    assert.ok(body.user_prompt_id)
    assert.deepEqual(body.request.contents, [{ role: 'user', parts: [{ text: 'Hi' }] }])
    assert.deepEqual(body.request.systemInstruction, { parts: [{ text: 'System' }] })
    assert.equal(body.request.generationConfig.maxOutputTokens, 300)
    assert.equal(body.request.tools[0].functionDeclarations[0].parametersJsonSchema.type, 'object')
    assert.deepEqual(body.request.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['read'] } })
    assert.equal(result.text, 'Gemini answer')
    assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta'))
    assert.equal(result.usage.prompt_tokens, 20)
    assert.equal(result.usage.completion_tokens, 8)
    assert.equal(result.usage.prompt_tokens_details.cached_tokens, 4)
  })
  await check('Gemini resolves a native account project before first completion', async () => {
    const calls = []
    const { runtime, model } = setup('gemini', { project: null, fetchImpl: async (endpoint, options) => {
      calls.push(endpoint)
      if (endpoint.endsWith(':loadCodeAssist')) return new Response(JSON.stringify({ cloudaicompanionProject: { projectId: 'loaded-project' } }))
      assert.equal(JSON.parse(options.body).project, 'loaded-project')
      return sse(geminiEvents())
    } })
    await runtime.complete(request(model))
    assert.equal(calls.length, 2)
    assert.ok(calls[0].endsWith(':loadCodeAssist'))
  })
  await check('Chat tool calls keep identity and assembled arguments in harness/outcome', async () => {
    const { runtime, model } = setup('api', { fetchImpl: async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] }, finish_reason: 'tool_calls' }] },
    ]) })
    const result = await runtime.complete(request(model))
    assert.equal(result.toolCalls.length, 1)
    assert.equal(result.toolCalls[0].name, 'read')
    assert.equal(result.toolCalls[0].id, 'call_1')
    assert.equal(result.toolCalls[0].arguments, '{"path":"a.txt"}')
  })
  await check('Codex Responses function calls assemble and input tool results are preserved', async () => {
    let body
    const { runtime, model } = setup('codex', { fetchImpl: async (endpoint, options) => {
      body = JSON.parse(options.body)
      return sse([
        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_new', name: 'read' } },
        { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":"next"}' },
        { type: 'response.completed', response: { status: 'completed' } },
      ])
    } })
    const result = await runtime.complete({ model, messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: 'call_old', name: 'read', arguments: '{"path":"old"}' }] },
      { role: 'tool', toolCallId: 'call_old', content: [{ type: 'text', text: 'old result' }] },
    ] })
    assert.equal(body.input[0].type, 'function_call')
    assert.equal(body.input[1].type, 'function_call_output')
    assert.equal(result.toolCalls[0].name, 'read')
    assert.equal(result.toolCalls[0].arguments, '{"path":"next"}')
  })
  await check('Gemini tool results, thought signatures and image content round-trip', async () => {
    let invocation = 0
    let body
    const { runtime, model } = setup('gemini', { fetchImpl: async (endpoint, options) => {
      invocation++
      body = JSON.parse(options.body)
      if (invocation === 1) return sse([{ response: { candidates: [{ content: { parts: [{
        functionCall: { id: 'gemini_call_1', name: 'read', args: { path: 'a.txt' } }, thoughtSignature: 'opaque-thought-signature',
      }] }, finishReason: 'STOP' }] } }])
      return sse(geminiEvents())
    } })
    const result = await runtime.complete(request(model))
    assert.equal(result.toolCalls[0].arguments, '{"path":"a.txt"}')
    await runtime.complete({ model, messages: [
      { role: 'assistant', content: [{ type: 'tool-call', id: result.toolCalls[0].id,
        name: 'read', arguments: result.toolCalls[0].arguments }] },
      { role: 'tool', toolCallId: result.toolCalls[0].id, content: [{ type: 'text', text: 'file contents' }] },
      { role: 'user', content: [{ type: 'image', attachment: { url: 'data:image/png;base64,aGk=' } }] },
    ] })
    assert.equal(body.request.contents[0].parts[0].thoughtSignature, 'opaque-thought-signature')
    assert.equal(body.request.contents[1].parts[0].functionResponse.name, 'read')
    assert.equal(body.request.contents[1].parts[0].functionResponse.response.output, 'file contents')
    assert.ok(body.request.contents[1].parts.some(part => part.inlineData?.mimeType === 'image/png'))
  })
  await check('truncated output and broken tool JSON never become executable calls', async () => {
    const { runtime, model } = setup('api', { fetchImpl: async () => sse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_broken', function: { name: 'read', arguments: '{"a":' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'length' }] },
    ]) })
    const result = await runtime.complete(request(model))
    assert.equal(result.truncated, true)
    assert.deepEqual(result.toolCalls, [])
  })
  await check('SSE Responses incomplete and Gemini MAX_TOKENS preserve truncation', async () => {
    for (const [provider, events] of [
      ['codex', [{ type: 'response.output_text.delta', output_index: 0, delta: 'Partial' },
        { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }]],
      ['gemini', [{ response: { candidates: [{ content: { parts: [{ text: 'Partial' }] }, finishReason: 'MAX_TOKENS' }] } }]],
    ]) {
      const { runtime, model } = setup(provider, { fetchImpl: async () => sse(events) })
      const result = await runtime.complete(request(model))
      assert.equal(result.truncated, true)
      assert.equal(result.text, 'Partial')
    }
  })
  await check('first text chunk arrives before response finishes', async () => {
    let release, firstDelta
    const received = new Promise(resolve => { firstDelta = resolve })
    const { runtime, model } = setup('api', { fetchImpl: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'live' } }] })}\n\n`))
        release = () => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`))
          controller.close()
        }
      },
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    let done = false
    const pending = runtime.complete(request(model), chunk => { if (chunk.type === 'text-delta') firstDelta() })
      .finally(() => { done = true })
    await received
    assert.equal(done, false)
    release()
    assert.equal((await pending).text, 'live')
  })
  await check('provider HTTP failures, network errors, stream errors and logger never expose credentials', async () => {
    for (const [fetchImpl, expected] of [
      [async () => new Response(TOKEN, { status: 401, statusText: TOKEN }), 'AUTH_REQUIRED'],
      [async () => new Response(TOKEN, { status: 429 }), 'RATE_LIMIT'],
      [async () => { throw new Error(`network: ${KEY}`) }, 'NETWORK_ERROR'],
      [async () => sse([{ error: { message: TOKEN } }]), 'PROVIDER_ERROR'],
      [async () => sse([{ type: 'response.failed', response: { status: 'failed', error: { message: TOKEN } } }]), 'PROVIDER_ERROR'],
    ]) {
      const logs = []
      const { runtime, model } = setup('api', { fetchImpl, logger: { warn: value => logs.push(value) } })
      await assert.rejects(runtime.complete(request(model)), errorCode(expected))
      assertClean(logs)
    }
  })
  await check('successful upstream credential echoes are redacted in chunks and outcome', async () => {
    const { runtime, model } = setup('api', { fetchImpl: async () => sse([
      { choices: [{ delta: { content: `Echo ${KEY}` } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ]) })
    const chunks = []
    const result = await runtime.complete(request(model), chunk => chunks.push(chunk))
    assertClean({ chunks, result })
    assert.ok(result.text.includes('[redacted]'))
  })
  await check('all text/reasoning/tool-argument credential split positions and bytewise repetition are redacted', async () => {
    const cuts = [...Array(KEY.length - 1)].map((_, index) => [KEY.slice(0, index + 1), KEY.slice(index + 1)])
    cuts.push([KEY], [...KEY], [...KEY, ...KEY])
    for (const type of ['text', 'reasoning', 'arguments']) {
      for (const parts of cuts) {
        const values = type === 'arguments' ? ['{"value":"', ...parts, '"}'] : parts
        const events = values.map((value, index) => ({ choices: [{ delta: type === 'arguments'
          ? { tool_calls: [{ index: 0, ...(index === 0 ? { id: 'call_1' } : {}),
            function: { ...(index === 0 ? { name: 'read' } : {}), arguments: value } }] }
          : { [type === 'reasoning' ? 'reasoning_content' : 'content']: value } }] }))
        events.push({ choices: [{ delta: {}, finish_reason: type === 'arguments' ? 'tool_calls' : 'stop' }] })
        const runtime = redactionRuntime(events)
        const chunks = []
        const result = await runtime.complete(request('subscription:redaction/model'), chunk => chunks.push(chunk))
        assertRedactedLifecycle(chunks, result)
        assert.ok(JSON.stringify(chunks).includes('[redacted]'))
        if (type === 'arguments') assert.doesNotThrow(() => JSON.parse(result.toolCalls[0].arguments))
      }
    }
  })
  await check('overlapping credentials, prefixes, false starts and repetition remain coherent', async () => {
    for (const [secrets, input] of [
      [['credential-abc', 'credential-abcdef'], 'credential-abcdef credential-abc credential-abX done!'],
      [['abab', 'baba'], 'abababababa!'],
      [['secret-123', '123-xyz'], 'secret-123-xyz secret-123123-xyz!'],
      [['aaaaab', 'aaaa'], 'aaaaaaaaaabaaaa!'],
    ]) {
      const events = [...input].map(content => ({ choices: [{ delta: { content } }] }))
      events.push({ choices: [{ delta: {}, finish_reason: 'stop' }] })
      const chunks = []
      const result = await redactionRuntime(events, secrets).complete(request('subscription:redaction/model'), chunk => chunks.push(chunk))
      assertRedactedLifecycle(chunks, result, secrets)
      assert.ok(result.text.includes('[redacted]'))
      if (input.includes('credential-abX')) assert.ok(result.text.includes('credential-abX done!'), 'false prefix must be released')
    }
  })
  await check('split credentials cannot reconstruct across content blocks, types or interleaved tools', async () => {
    const middle = Math.floor(TOKEN.length / 2)
    const events = [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: TOKEN.slice(0, middle) } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: TOKEN.slice(middle) } },
      { type: 'content_block_delta', index: 2, delta: { type: 'thinking_delta', thinking: TOKEN.slice(0, middle) } },
      { type: 'content_block_delta', index: 3, delta: { type: 'thinking_delta', thinking: TOKEN.slice(middle) } },
      { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'call_a', name: 'read' } },
      { type: 'content_block_start', index: 5, content_block: { type: 'tool_use', id: 'call_b', name: 'read' } },
      { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: `{"value":"${TOKEN.slice(0, middle)}` } },
      { type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: `{"value":"${TOKEN}` } },
      { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: `${TOKEN.slice(middle)}"}` } },
      { type: 'content_block_delta', index: 5, delta: { type: 'input_json_delta', partial_json: '"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ]
    const { runtime, model } = setup('claude', { fetchImpl: async () => sse(events) })
    const chunks = []
    const result = await runtime.complete(request(model), chunk => chunks.push(chunk))
    assertRedactedLifecycle(chunks, result, [TOKEN])
    const allDeltas = chunks.filter(chunk => /-delta$/.test(chunk.type)).map(chunk => chunk.text ?? chunk.argumentsDelta ?? '').join('')
    assert.ok(!allDeltas.includes(TOKEN))
    assert.equal(result.toolCalls.length, 2)
  })
  await check('ordinary output is immediate; only genuine secret prefixes wait for continuation', async () => {
    let source, wake
    let notice = new Promise(resolve => { wake = resolve })
    const observed = []
    const runtime = redactionRuntime([], [KEY], {
      fetchImpl: async () => new Response(new ReadableStream({ start(controller) { source = controller } })),
    })
    const pending = runtime.complete(request('subscription:redaction/model'), chunk => {
      observed.push(chunk)
      if (chunk.type === 'text-delta') wake()
    })
    await new Promise(resolve => setImmediate(resolve))
    const send = content => source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`))
    send('normal output!')
    await notice
    assert.equal(observed.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'normal output!')
    notice = new Promise(resolve => { wake = resolve })
    send('safe: ' + KEY.slice(0, 10))
    await notice
    assert.equal(observed.filter(chunk => chunk.type === 'text-delta').at(-1).text, 'safe: ')
    notice = new Promise(resolve => { wake = resolve })
    send(KEY.slice(10) + ' done!')
    await notice
    source.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'))
    source.close()
    const result = await pending
    assert.equal(result.text, 'normal output!safe: [redacted] done!')
    assertRedactedLifecycle(observed, result)
  })
  await check('aborted streams never flush held credential prefixes into callbacks', async () => {
    let source, received
    const first = new Promise(resolve => { received = resolve })
    const controller = new AbortController()
    const chunks = []
    const runtime = redactionRuntime([], [KEY], {
      fetchImpl: async () => new Response(new ReadableStream({ start(value) { source = value } })),
    })
    const pending = runtime.complete({ ...request('subscription:redaction/model'), signal: controller.signal }, chunk => {
      chunks.push(chunk)
      if (chunk.type === 'text-delta') received()
    })
    await new Promise(resolve => setImmediate(resolve))
    source.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'safe! ' + KEY.slice(0, 12) } }] })}\n\n`))
    await first
    controller.abort()
    await assert.rejects(pending, errorCode('ABORTED'))
    assert.equal(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''), 'safe! ')
  })
  await check('attachment resolvers reach every wire for user images and tool-result images', async () => {
    for (const [provider, format, events] of [
      ['api', 'openai-chat', chatEvents()], ['api', 'openai-responses', responseEvents()],
      ['api', 'anthropic-messages', claudeEvents()], ['codex', undefined, responseEvents()],
      ['claude', undefined, claudeEvents()], ['gemini', undefined, geminiEvents()],
    ]) {
      for (const scope of ['constructor', 'request']) {
        const resolved = []
        let posted
        const resolveImage = attachment => {
          resolved.push(attachment.attachmentId)
          return `data:image/png;base64,${attachment.attachmentId === 'user-image' ? 'dXNlcg==' : 'dG9vbA=='}`
        }
        const { runtime, model } = setup(provider, {
          format, resolveImage: scope === 'constructor' ? resolveImage : () => { throw new Error('request override was ignored') },
          fetchImpl: async (_endpoint, options) => { posted = JSON.parse(options.body); return sse(events) },
        })
        await runtime.complete({
          model, ...(scope === 'request' ? { resolveImage } : {}),
          messages: [
            { role: 'assistant', content: [{ type: 'tool-call', id: 'call_image', name: 'read', arguments: '{}' }] },
            { role: 'tool', toolCallId: 'call_image', content: [{ type: 'image', attachment: { attachmentId: 'tool-image', mediaType: 'image/png' } }] },
            { role: 'user', content: [{ type: 'image', attachment: { attachmentId: 'user-image', mediaType: 'image/png' } }] },
          ],
        })
        assert.deepEqual(resolved.sort(), ['tool-image', 'user-image'], `${provider}/${format}/${scope}`)
        assert.ok(JSON.stringify(posted).includes('dXNlcg=='), 'user attachment must be in provider payload')
        assert.ok(JSON.stringify(posted).includes('dG9vbA=='), 'tool attachment must be in provider payload')
        assert.ok(!JSON.stringify(posted).includes('attachmentId'), 'provider receives resolved images, not storage references')
      }
    }
  })
  await check('missing terminal, malformed SSE and content blocks are explicit failures', async () => {
    for (const [provider, events, expected] of [
      ['api', [{ choices: [{ delta: { content: 'partial' } }] }], 'TRUNCATED_STREAM'],
      ['api', ['{invalid-json}'], 'TRUNCATED_STREAM'],
      ['gemini', [{ response: { promptFeedback: { blockReason: 'SAFETY' } } }], 'CONTENT_BLOCKED'],
      ['gemini', [{ response: { candidates: [{ finishReason: 'SAFETY' }] } }], 'CONTENT_BLOCKED'],
    ]) {
      const { runtime, model } = setup(provider, { fetchImpl: async () => sse(events) })
      await assert.rejects(runtime.complete(request(model)), errorCode(expected))
    }
  })
  await check('unknown/disabled/removed models fail before network; namespace ownership is stable', async () => {
    let calls = 0
    const { runtime, subscriptions, account, model } = setup('api', { fetchImpl: async () => { calls++; return sse(chatEvents()) } })
    await assert.rejects(runtime.complete(request(`subscription:${account.id}/unknown`)), errorCode('NOT_FOUND'))
    subscriptions.setEnabled({ id: account.id, enabled: false })
    await assert.rejects(runtime.complete(request(model)), errorCode('NOT_FOUND'))
    subscriptions.remove({ id: account.id })
    await assert.rejects(runtime.complete(request(model)), errorCode('NOT_FOUND'))
    assert.equal(runtime.handles(model), true)
    assert.equal(calls, 0)
  })
  await check('malformed generation parameters fail before upstream fetch', async () => {
    let calls = 0
    const { runtime, model } = setup('api', { fetchImpl: async () => { calls++; return sse(chatEvents()) } })
    for (const patch of [{ maxTokens: -1 }, { maxTokens: 1.5 }, { temperature: NaN }, { toolChoice: 'bogus' }]) {
      await assert.rejects(runtime.complete({ ...request(model), ...patch }), errorCode('INVALID_INPUT'))
    }
    await assert.rejects(runtime.complete(null), errorCode('INVALID_INPUT'))
    assert.equal(calls, 0)
  })
  await check('caller abort and total deadline bound stalled fetch and body reads', async () => {
    for (const body of [false, true]) {
      const fetchImpl = async () => body ? new Response(new ReadableStream({ start() {} })) : new Promise(() => {})
      const { runtime, model } = setup('api', { fetchImpl, timeoutMs: 50 })
      const start = Date.now()
      await assert.rejects(runtime.complete(request(model)), errorCode('TIMEOUT'))
      assert.ok(Date.now() - start < 1000)
      const controller = new AbortController()
      const pending = runtime.complete({ ...request(model), signal: controller.signal })
      setTimeout(() => controller.abort(new Error(KEY)), 10)
      await assert.rejects(pending, errorCode('ABORTED'))
      await assert.rejects(runtime.complete({ ...request(model), signal: AbortSignal.abort(new Error(KEY)) }), errorCode('ABORTED'))
    }
  })
  await check('optional telemetry records a successful turn using existing stats store shape', async () => {
    let state = structuredClone(STATS_INITIAL)
    const stats = { edit: mutate => { state = mutate(state) } }
    const { runtime, model } = setup('api', { stats })
    await runtime.complete(request(model))
    assert.equal(state.logical.turns, 1)
    assert.equal(state.logical.failed, 0)
    const bucket = Object.values(state.days)[0].models[model]
    assert.equal(bucket.calls, 1)
    assert.equal(bucket.input, 10)
    assert.equal(bucket.output, 3)
    assertClean(state)
  })
  await check('subscription credential resolution timeouts keep their sanitized status', async () => {
    const runtime = createSubscriptionRuntime({
      subscriptions: {
        list: () => [{ id: 'account', provider: 'gemini', enabled: true, models: ['model'] }],
        resolve: async () => { throw Object.assign(new Error(TOKEN), { code: 'TIMEOUT' }) },
      },
    })
    await assert.rejects(runtime.complete(request('subscription:account/model')), error => {
      assert.equal(error.statusCode, 504)
      return errorCode('TIMEOUT')(error)
    })
  })
  await check('native fetch performs a streamed roundtrip and refuses credential redirects', async () => {
    let destinationCalls = 0
    const server = http.createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        if (req.url.startsWith('/redirect/')) {
          res.writeHead(307, { location: '/destination' })
          res.end()
        } else if (req.url === '/destination') {
          destinationCalls++
          res.end('{}')
        } else {
          assert.equal(req.headers.authorization, `Bearer ${KEY}`)
          res.writeHead(200, { 'content-type': 'text/event-stream' })
          res.end(chatEvents().map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''))
        }
      })
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
      const base = `http://127.0.0.1:${server.address().port}`
      const subscriptions = createSubscriptions({ dataDir: path.join(scratch, 'native-http') })
      const runtime = createSubscriptionRuntime({ subscriptions })
      for (const prefix of ['/v1', '/redirect/v1']) {
        const account = subscriptions.import({ provider: 'api', baseUrl: `${base}${prefix}`,
          credentials: { apiKey: KEY }, models: ['model'] })
        const input = request(`subscription:${account.id}/model`)
        if (prefix === '/v1') assert.equal((await runtime.complete(input)).text, 'Hello world')
        else await assert.rejects(runtime.complete(input), errorCode('NETWORK_ERROR'))
      }
      assert.equal(destinationCalls, 0)
    } finally {
      server.closeAllConnections()
      await new Promise(resolve => server.close(resolve))
    }
  })
} finally {
  const resolved = path.resolve(scratch)
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()))
  assert.ok(path.basename(resolved).startsWith('ofm-subscription-completion-'))
  fs.rmSync(resolved, { recursive: true, force: true })
}

console.log(`${checks - failures}/${checks} subscription completion checks passed`)
if (failures) process.exitCode = 1
