/**
 * Native Gemini HTTP contract tests. No provider, credentials or channel pack.
 * Run: node scripts/gemini-gateway-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { startForwardServer, keyMatches } from '../src/forward.js'

const key = 'local+gemini/key?secret'
const model = 'channel/provider/model:tag'
const path = `/v1beta/models/${encodeURIComponent(model)}`
const prompt = { contents: [{ role: 'user', parts: [{ text: 'hello' }] }] }
const logs = []
const traces = []
const seen = []
let run = async () => ({ text: 'hello back', toolCalls: [], usage: { prompt_tokens: 4, completion_tokens: 2 } })
const server = await startForwardServer({
  config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key }),
  modelRows: () => [{ id: model, context_window: 8192 }, { id: 'second' }],
  complete: async (request, emit) => { seen.push(request); return run(request, emit) },
  log: message => logs.push(message),
  onTrace: event => traces.push(event),
})
const base = `http://127.0.0.1:${server.port}`
const get = (target, headers = { 'x-goog-api-key': key }) => fetch(base + target, { headers })
const post = (target, body = prompt, headers = { 'x-goog-api-key': key }) => fetch(base + target, {
  method: 'POST', headers: { 'content-type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const frames = text => text.split('\n\n').filter(row => row.startsWith('data: ')).map(row => JSON.parse(row.slice(6)))
const waitFor = async predicate => {
  const end = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() > end) assert.fail('timed out waiting for HTTP event')
    await delay(5)
  }
}
let passed = 0
let failures = 0
async function check(name, test) {
  try { await test(); passed++; console.log(`ok ${name}`) }
  catch (error) { failures++; console.error(`FAIL ${name}\n${error.stack}`) }
}
async function errorIs(response, code, status) {
  assert.equal(response.status, code)
  const payload = await response.json()
  assert.equal(payload.error.code, code)
  assert.equal(payload.error.status, status)
  return payload
}
const tool = { functionDeclarations: [{ name: 'read', description: 'Read a file', parameters: { type: 'OBJECT', properties: { file: { type: 'STRING' } } } }] }

try {
  await check('Gemini discovery, pagination and model details; OpenAI discovery stays compatible', async () => {
    const first = await (await get('/v1beta/models?pageSize=1')).json()
    assert.equal(first.models[0].name, `models/${model}`)
    assert.equal(first.models[0].inputTokenLimit, 8192)
    assert.deepEqual(first.models[0].supportedGenerationMethods, ['generateContent', 'streamGenerateContent', 'countTokens'])
    assert.equal(first.nextPageToken, '1')
    assert.equal((await (await get(`/v1beta/models?pageToken=${first.nextPageToken}`)).json()).models[0].name, 'models/second')
    assert.equal((await (await get(path)).json()).name, `models/${model}`)
    await errorIs(await get('/v1beta/models/unknown'), 404, 'NOT_FOUND')
    assert.equal((await (await get('/v1/models', { authorization: `Bearer ${key}` })).json()).object, 'list')
  })

  await check('header, query, bearer and Anthropic credentials work; missing/wrong credentials never dispatch', async () => {
    const count = seen.length
    await errorIs(await post(`${path}:generateContent`, prompt, {}), 401, 'UNAUTHENTICATED')
    await errorIs(await post(`${path}:generateContent?key=wrong`, prompt, {}), 401, 'UNAUTHENTICATED')
    await errorIs(await post(`${path}:generateContent`, prompt, { 'x-goog-api-key': `${key}wrong` }), 401, 'UNAUTHENTICATED')
    assert.equal(seen.length, count)
    for (const [query, headers] of [
      ['', { 'x-goog-api-key': key }],
      [`?key=${encodeURIComponent(key)}`, {}],
      ['', { authorization: `Bearer ${key}` }],
      ['', { 'x-api-key': key }],
    ]) {
      const response = await post(`${path}:generateContent${query}`, prompt, headers)
      assert.equal(response.status, 200)
      await response.text()
    }
    assert.equal(keyMatches(key, key), true)
    assert.equal(keyMatches(key + 'x', key), false)
    assert.equal(keyMatches('', key), false)
  })

  await check('CORS allows Gemini SDK headers', async () => {
    const response = await fetch(base + path, { method: 'OPTIONS' })
    assert.equal(response.status, 204)
    assert.match(response.headers.get('access-control-allow-headers'), /x-goog-api-key/)
    assert.match(response.headers.get('access-control-allow-headers'), /x-goog-api-client/)
  })

  await check('existing Anthropic and OpenAI HTTP authentication and output remain usable', async () => {
    run = async (request, emit) => {
      emit?.({ type: 'text-delta', index: 0, text: 'legacy answer' })
      emit?.({ type: 'finish', reason: { kind: 'stop' } })
      return { text: 'legacy answer', toolCalls: [] }
    }
    const anthropic = await post('/v1/messages', { model, max_tokens: 64, messages: [{ role: 'user', content: 'hello' }] }, { 'x-api-key': key })
    assert.equal(anthropic.status, 200)
    assert.equal((await anthropic.json()).content[0].text, 'legacy answer')
    const openai = await post('/v1/chat/completions', { model, messages: [{ role: 'user', content: 'hello' }] }, { authorization: `Bearer ${key}` })
    assert.equal(openai.status, 200)
    assert.equal((await openai.json()).choices[0].message.content, 'legacy answer')
  })

  await check('nonstream translates composite model, system, image, tools, reasoning and generation controls', async () => {
    run = async (request, emit) => {
      assert.equal(request.model, model)
      assert.equal(request.maxTokens, 128)
      assert.equal(request.temperature, 0.3)
      assert.equal(request.reasoningEffort, 'deep')
      assert.deepEqual(request.messages[0], { role: 'system', content: [{ type: 'text', text: 'be concise' }] })
      const blocks = request.messages[1].content
      assert.equal(blocks[1].attachment.url, 'data:image/png;base64,AAAA')
      assert.equal(blocks[2].attachment.url, 'https://example.test/picture.png')
      assert.deepEqual(request.tools[0].parameters, { type: 'object', properties: { file: { type: 'string' } } })
      emit({ type: 'reasoning-delta', index: 0, text: 'consider' })
      emit({ type: 'text-delta', index: 1, text: 'answer' })
      emit({ type: 'tool-call-delta', index: 4, id: 'r1', name: 'read', argumentsDelta: '{"file":' })
      emit({ type: 'block-end', index: 4, block: { type: 'tool-call', id: 'r1', name: 'read', arguments: '{"file":"a"}' } })
      emit({ type: 'finish', reason: { kind: 'tool-calls' } })
      return { usage: { inputTokens: 10, cacheReadTokens: 3, outputTokens: 9, reasoningTokens: 2 } }
    }
    const response = await post(`${path}:generateContent`, {
      systemInstruction: { parts: [{ text: 'be concise' }] },
      contents: [{ parts: [{ text: 'look' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { fileData: { mimeType: 'image/png', fileUri: 'https://example.test/picture.png' } }] }],
      tools: [tool], generationConfig: { maxOutputTokens: 128, temperature: 0.3, candidateCount: 1, thinkingConfig: { thinkingBudget: 32768, includeThoughts: true } },
    })
    assert.equal(response.status, 200)
    const payload = await response.json()
    assert.deepEqual(payload.candidates[0].content.parts, [
      { text: 'consider', thought: true }, { text: 'answer' }, { functionCall: { id: 'r1', name: 'read', args: { file: 'a' } } },
    ])
    assert.equal(payload.candidates[0].finishReason, 'STOP')
    assert.equal(payload.modelVersion, model)
    assert.match(payload.responseId, /^gemini-/)
    assert.deepEqual(payload.usageMetadata, { promptTokenCount: 13, candidatesTokenCount: 7, thoughtsTokenCount: 2, cachedContentTokenCount: 3, totalTokenCount: 22 })
  })

  await check('history pairs parallel calls by explicit id or FIFO name and preserves tool/text ordering', async () => {
    run = async request => {
      const rows = request.messages
      assert.equal(rows[0].role, 'assistant')
      assert.deepEqual(rows[0].source, { kind: 'model', provider: 'our-free-model', model })
      assert.equal(rows[1].role, 'user')
      assert.equal(rows[1].content[0].text, 'before')
      assert.equal(rows[2].toolCallId, 'explicit')
      assert.equal(rows[2].isError, true)
      assert.equal(rows[2].content[1].type, 'image')
      assert.equal(rows[3].role, 'user')
      assert.equal(rows[3].content[0].text, 'between')
      assert.equal(rows[4].toolCallId, rows[0].content[0].id)
      assert.deepEqual(rows[4].source, { kind: 'tool', callId: rows[4].toolCallId })
      assert.equal(rows[5].content[0].text, 'after')
      return { text: 'done' }
    }
    const response = await post(`${path}:generateContent`, {
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'read', args: { file: 'one' } } }, { functionCall: { id: 'explicit', name: 'read', args: { file: 'two' } } }] },
        { role: 'user', parts: [
          { text: 'before' },
          { functionResponse: { id: 'explicit', name: 'read', response: { error: 'missing' }, parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] } },
          { text: 'between' }, { functionResponse: { name: 'read', response: { output: 'body' } } }, { text: 'after' },
        ] },
      ],
      tools: [tool],
    })
    assert.equal(response.status, 200)
    await response.text()
  })

  await check('v1 generation/count aliases and unescaped composite model paths work', async () => {
    run = async request => { assert.equal(request.model, model); return { text: 'alias' } }
    for (const target of [`/v1/models/${encodeURIComponent(model)}`, `/v1beta/models/${model}`]) {
      assert.equal((await post(`${target}:generateContent`)).status, 200)
      assert.equal((await post(`${target}:countTokens`)).status, 200)
    }
  })

  await check('countTokens estimates direct and nested generation requests locally, including images/tools/system', async () => {
    const before = seen.length
    const small = await (await post(`${path}:countTokens`)).json()
    const rich = {
      ...prompt, systemInstruction: { parts: [{ text: 'instructions' }] }, tools: [tool],
      contents: [{ parts: [{ text: 'hello' }, { inlineData: { mimeType: 'image/png', data: 'AAAA' } }] }],
    }
    const response = await post(`${path}:countTokens`, { generateContentRequest: { ...rich, model: `models/${model}` } })
    assert.equal(response.headers.get('x-ofm-token-count-estimated'), 'true')
    const large = await response.json()
    assert.ok(small.totalTokens > 0)
    assert.ok(large.totalTokens > small.totalTokens + 1024)
    assert.equal(seen.length, before)
    await errorIs(await post(`${path}:countTokens`, { ...prompt, generateContentRequest: rich }), 400, 'INVALID_ARGUMENT')
  })

  await check('stream sends actual deltas before completion, emits complete calls once and never replays text', async () => {
    let release
    const gate = new Promise(resolve => { release = resolve })
    let done = false
    run = async (request, emit) => {
      emit({ type: 'reasoning-delta', index: 0, text: 'think' })
      emit({ type: 'text-delta', index: 1, text: 'first' })
      await gate
      emit({ type: 'text-delta', index: 1, text: ' second' })
      emit({ type: 'tool-call-delta', index: 7, argumentsDelta: '{"file"' })
      emit({ type: 'tool-call-delta', index: 7, id: 'stream-call', name: 'read', argumentsDelta: ':"a"}' })
      emit({ type: 'block-end', index: 7, block: { type: 'tool-call', id: 'stream-call', name: 'read', arguments: '{"file":"a"}' } })
      emit({ type: 'usage', usage: { inputTokens: 12, outputTokens: 6, reasoningTokens: 1 } })
      emit({ type: 'finish', reason: { kind: 'tool-calls' } })
      done = true
      return { text: 'first second', toolCalls: [{ id: 'stream-call', name: 'read', arguments: '{"file":"a"}' }] }
    }
    try {
      const response = await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] })
      assert.match(response.headers.get('content-type'), /^text\/event-stream/)
      const reader = response.body.getReader()
      let text = ''
      while (!text.includes('"text":"first"')) {
        const row = await reader.read()
        assert.equal(row.done, false)
        text += Buffer.from(row.value).toString()
      }
      assert.equal(done, false, 'first delta must arrive while completion is blocked')
      release()
      for (;;) {
        const row = await reader.read()
        if (row.done) break
        text += Buffer.from(row.value).toString()
      }
      assert.ok(!text.includes('[DONE]'))
      const events = frames(text)
      assert.deepEqual(events.flatMap(event => event.candidates[0].content.parts).filter(part => part.text).map(part => part.text), ['think', 'first', ' second'])
      assert.equal(events.flatMap(event => event.candidates[0].content.parts).filter(part => part.functionCall).length, 1)
      assert.deepEqual(events[0].candidates[0].content.parts[0], { text: 'think', thought: true })
      assert.equal(events.at(-1).candidates[0].finishReason, 'STOP')
      assert.equal(events.at(-1).usageMetadata.totalTokenCount, 18)
      assert.equal(new Set(events.map(event => event.responseId)).size, 1)
    } finally { release() }
  })

  await check('stream flushes interleaved calls independently and outcome-only calls at completion', async () => {
    run = async (request, emit) => {
      emit({ type: 'tool-call-delta', index: 3, id: 'a', name: 'read', argumentsDelta: '{"file":"a"}' })
      emit({ type: 'tool-call-delta', index: 8, id: 'b', name: 'read', argumentsDelta: '{"file":"b"}' })
      emit({ type: 'block-end', index: 8, block: { type: 'tool-call', id: 'b', name: 'read', arguments: '{"file":"b"}' } })
      return { toolCalls: [{ id: 'a', name: 'read', arguments: '{"file":"a"}' }, { id: 'b', name: 'read', arguments: '{"file":"b"}' }, { id: 'c', name: 'read', arguments: '{}' }] }
    }
    const events = frames(await (await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] })).text())
    assert.deepEqual(events.flatMap(event => event.candidates[0].content.parts).map(part => part.functionCall.id), ['b', 'a', 'c'])
  })

  await check('max tokens, outcome-only responses and explicit thought suppression', async () => {
    run = async () => ({ text: 'partial', thinking: 'private', truncated: true, usage: { prompt_tokens: 2, completion_tokens: 1 } })
    const response = await post(`${path}:generateContent`, { ...prompt, generationConfig: { thinkingConfig: { includeThoughts: false } } })
    const payload = await response.json()
    assert.deepEqual(payload.candidates[0].content.parts, [{ text: 'partial' }])
    assert.equal(payload.candidates[0].finishReason, 'MAX_TOKENS')
  })

  await check('a token ceiling discards incomplete functions and keeps MAX_TOKENS on both wires', async () => {
    run = async (request, emit) => {
      emit({ type: 'tool-call-delta', index: 0, id: 'partial', name: 'read', argumentsDelta: '{"file":' })
      emit({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'partial', name: 'read', arguments: '{"file":' } })
      emit({ type: 'finish', reason: { kind: 'max-tokens' } })
      return { truncated: true, toolCalls: [] }
    }
    const jsonResponse = await post(`${path}:generateContent`, { ...prompt, tools: [tool] })
    assert.equal(jsonResponse.status, 200)
    const candidate = (await jsonResponse.json()).candidates[0]
    assert.equal(candidate.finishReason, 'MAX_TOKENS')
    assert.deepEqual(candidate.content.parts, [])
    const streamResponse = await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] })
    const events = frames(await streamResponse.text())
    assert.equal(events.at(-1).candidates[0].finishReason, 'MAX_TOKENS')
    assert.ok(events.every(event => event.candidates[0].content.parts.length === 0))
    run = async (request, emit) => {
      emit({ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'read', arguments: '{' } })
      return { toolCalls: [] }
    }
    await errorIs(await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] }), 502, 'UNAVAILABLE')
  })

  await check('chunk-only usage preserves cache and thinking counters; schemas preserve literal data', async () => {
    run = async (request, emit) => {
      const parameters = request.tools[0].parameters
      assert.equal(parameters.type, 'object')
      assert.deepEqual(parameters.properties.literal.default, { type: 'OBJECT' })
      assert.deepEqual(parameters.properties.literal.enum, [{ type: 'STRING' }])
      emit({ type: 'text-delta', index: 0, text: 'done' })
      emit({ type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 4, outputTokens: 6, reasoningTokens: 2 } })
      emit({ type: 'finish', reason: { kind: 'stop' } })
      return {}
    }
    const response = await post(`${path}:generateContent`, {
      ...prompt,
      tools: [{ functionDeclarations: [{ name: 'read', parameters: { type: 'OBJECT', properties: { literal: { type: 'OBJECT', default: { type: 'OBJECT' }, enum: [{ type: 'STRING' }] } } } }] }],
    })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).usageMetadata, {
      promptTokenCount: 14, candidatesTokenCount: 4, totalTokenCount: 20, thoughtsTokenCount: 2, cachedContentTokenCount: 4,
    })
  })

  await check('empty-string enum members are dropped before the strict upstream schema check (#251)', async () => {
    let seen
    run = async (request, emit) => {
      seen = request.tools[0].parameters
      emit({ type: 'text-delta', index: 0, text: 'done' })
      emit({ type: 'finish', reason: { kind: 'stop' } })
      return {}
    }
    const response = await post(`${path}:generateContent`, {
      ...prompt,
      tools: [{ functionDeclarations: [
        { name: 'style-tool', parameters: { type: 'OBJECT', properties: {
          style: { type: 'STRING', enum: ['', 'dark', 'light'], description: 'may be blank' },
          blank: { type: 'STRING', enum: [''] },
        } } },
      ] }],
    })
    assert.equal(response.status, 200)
    assert.deepEqual(seen.properties.style.enum, ['dark', 'light'], 'empty members are filtered, the rest survive')
    assert.equal(Object.hasOwn(seen.properties.blank, 'enum'), false, 'a members-only-of-"" enum becomes unconstrained')
    assert.equal(seen.properties.blank.description, undefined)
  })

  await check('stream fallback keeps outcome-only text and deduplicates calls without ids', async () => {
    run = async (request, emit) => {
      emit({ type: 'tool-call-delta', index: 5, name: 'read', argumentsDelta: '{}' })
      emit({ type: 'block-end', index: 5, block: { type: 'tool-call', name: 'read', arguments: '{}' } })
      return { text: 'outcome text', thinking: 'outcome thought', toolCalls: [{ name: 'read', arguments: '{}' }] }
    }
    const events = frames(await (await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] })).text())
    const parts = events.flatMap(event => event.candidates[0].content.parts)
    assert.equal(parts.filter(part => part.functionCall).length, 1)
    assert.deepEqual(parts.filter(part => part.text), [{ text: 'outcome thought', thought: true }, { text: 'outcome text' }])
  })

  await check('many streamed text chunks are delivered before completion without a final text replay', async () => {
    const delta = 'x'.repeat(1024)
    run = async (request, emit) => {
      for (let i = 0; i < 2048; i++) {
        emit({ type: 'text-delta', index: 0, text: delta })
        if (i % 8 === 0) await delay(1)
      }
      return { text: delta.repeat(2048) }
    }
    const response = await post(`${path}:streamGenerateContent?alt=sse`)
    assert.equal(response.status, 200)
    const events = frames(await response.text())
    assert.equal(events.filter(event => event.candidates[0].content.parts.length).length, 2048)
    assert.equal(events.at(-1).candidates[0].finishReason, 'STOP')
  })

  await check('invalid/unsupported significant constructs fail before dispatch', async () => {
    const before = seen.length
    for (const bad of [
      null, [], '{invalid', {}, { contents: [] },
      { ...prompt, generationConfig: { topP: 0.5 } },
      { ...prompt, generationConfig: { stopSequences: ['END'] } },
      { ...prompt, generationConfig: { responseMimeType: 'application/json' } },
      { ...prompt, generationConfig: { candidateCount: 2 } },
      { ...prompt, generationConfig: { temperature: -1 } },
      { ...prompt, generationConfig: { maxOutputTokens: 0 } },
      { ...prompt, toolConfig: { functionCallingConfig: { mode: 'ANY' } } },
      { ...prompt, safetySettings: [{ category: 'danger', threshold: 'OFF' }] },
      { ...prompt, tools: [{ googleSearch: {} }] },
      { contents: [{ parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }] }] },
      { contents: [{ parts: [{ fileData: { mimeType: 'image/png', fileUri: 'gs://bucket/image' } }] }] },
      { contents: [{ role: 'model', parts: [{ text: 'opaque', thoughtSignature: 'signature' }] }] },
      { contents: [{ parts: [{ functionResponse: { name: 'unpaired', response: {} } }] }] },
      { ...prompt, model: 'conflicting-model' },
    ]) await errorIs(await post(`${path}:generateContent`, bad), 400, 'INVALID_ARGUMENT')
    await errorIs(await post(`${path}:streamGenerateContent`), 400, 'INVALID_ARGUMENT')
    await errorIs(await post(`${path}:unknownMethod`), 404, 'NOT_FOUND')
    await errorIs(await get(`${path}:generateContent`), 405, 'UNIMPLEMENTED')
    await errorIs(await post('/v1beta/models/%ZZ:generateContent'), 400, 'INVALID_ARGUMENT')
    assert.equal(seen.length, before)
  })

  await check('bounded HTTP request body returns a Gemini error and never dispatches', async () => {
    const before = seen.length
    const response = await post(`${path}:generateContent`, JSON.stringify({ padding: 'x'.repeat(8 * 1024 * 1024) }))
    await errorIs(response, 413, 'RESOURCE_EXHAUSTED')
    assert.equal(seen.length, before)
  })

  await check('NONE function mode removes executable tools', async () => {
    run = async request => { assert.deepEqual(request.tools, []); return { text: 'no function' } }
    assert.equal((await post(`${path}:generateContent`, { ...prompt, tools: [tool], toolConfig: { functionCallingConfig: { mode: 'NONE' } } })).status, 200)
  })

  await check('early classified and thrown failures use Gemini HTTP errors and retry metadata', async () => {
    run = async () => ({ error: 'limited', failure: { code: 'RATE_LIMIT', message: 'limited', providerRetryAfterMs: 2500 } })
    for (const method of ['generateContent', 'streamGenerateContent?alt=sse']) {
      const response = await post(`${path}:${method}`)
      assert.equal(response.headers.get('retry-after'), '3')
      await errorIs(response, 429, 'RESOURCE_EXHAUSTED')
    }
    run = async () => { throw Object.assign(new Error('unknown model'), { statusCode: 404 }) }
    await errorIs(await post(`${path}:generateContent`), 404, 'NOT_FOUND')
    run = async (request, emit) => {
      emit({ type: 'finish', reason: { kind: 'error', failure: { message: 'no permission', code: 'PERMISSION_DENIED' } } })
      return {}
    }
    await errorIs(await post(`${path}:streamGenerateContent?alt=sse`), 403, 'PERMISSION_DENIED')
  })

  await check('late streamed errors emit an error object without a successful finish frame or leaked credentials', async () => {
    run = async (request, emit) => {
      emit({ type: 'text-delta', text: 'started' })
      throw new Error(`failed request ?key=${encodeURIComponent(key)} with ${key}`)
    }
    const response = await post(`${path}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`, prompt, {})
    assert.equal(response.status, 200)
    const text = await response.text()
    assert.ok(!text.includes(key))
    assert.ok(!text.includes(encodeURIComponent(key)))
    const events = frames(text)
    assert.equal(events[0].candidates[0].content.parts[0].text, 'started')
    assert.equal(events.at(-1).error.status, 'UNAVAILABLE')
    assert.ok(events.every(event => !event.candidates?.[0]?.finishReason))
  })

  await check('invalid/undeclared output calls fail explicitly; streaming arguments are bounded', async () => {
    for (const call of [{ id: 'bad', name: 'read', arguments: '{' }, { id: 'bad', name: 'not_declared', arguments: '{}' }]) {
      run = async () => ({ toolCalls: [call] })
      await errorIs(await post(`${path}:generateContent`, { ...prompt, tools: [tool] }), 502, 'UNAVAILABLE')
    }
    run = async (request, emit) => {
      emit({ type: 'tool-call-delta', index: 0, name: 'read', argumentsDelta: 'x'.repeat(1024 * 1024 + 1) })
      return {}
    }
    const events = frames(await (await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] })).text())
    assert.equal(events.at(-1).error.status, 'UNAVAILABLE')
    run = async (request, emit) => {
      emit({ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'read', arguments: JSON.stringify({ file: 'x'.repeat(1024 * 1024) }) } })
      return {}
    }
    await errorIs(await post(`${path}:streamGenerateContent?alt=sse`, { ...prompt, tools: [tool] }), 502, 'UNAVAILABLE')
    run = async (request, emit) => {
      emit({ type: 'block-end', index: 0, block: { type: 'image', attachment: {} } })
      return {}
    }
    await errorIs(await post(`${path}:generateContent`), 502, 'UNAVAILABLE')
  })

  for (const stream of [false, true]) await check(`${stream ? 'stream' : 'nonstream'} disconnect cancels the completion signal`, async () => {
    let signal
    let finished = false
    run = async (request, emit) => {
      signal = request.signal
      if (stream) emit({ type: 'text-delta', index: 0, text: 'first' })
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
      finished = true
      return { error: 'cancelled' }
    }
    const client = http.request(`${base}${path}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
      method: 'POST', headers: { 'x-goog-api-key': key },
    })
    client.on('error', () => {})
    client.on('response', response => response.on('data', () => { if (stream) client.destroy() }))
    client.end(JSON.stringify(prompt))
    try {
      await waitFor(() => signal !== undefined)
      if (!stream) client.destroy()
      await waitFor(() => finished)
      assert.equal(signal.aborted, true)
    } finally { client.destroy() }
  })

  await check('credential-bearing Gemini requests never reach gateway logs or traces', async () => {
    const diagnostic = JSON.stringify({ logs, traces })
    assert.ok(!diagnostic.includes(key))
    assert.ok(!diagnostic.includes(encodeURIComponent(key)))
    assert.deepEqual(logs, [])
  })
} finally {
  await server.close()
}

console.log(`gemini-gateway-test: ${passed} passed, ${failures} failed`)
process.exitCode = failures ? 1 : 0
