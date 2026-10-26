/**
 * The aggregate lane, offline.
 *
 * The lane makes four promises, and each one is checkable without a network:
 *
 * 1. **Rows** — a provider contributes models only when the user's config makes
 *    it dialable: enabled, keyed where the registry demands a key, and pointed
 *    at an endpoint that can actually be composed.
 * 2. **Resolution** — one provider, one effective credential/host/header set,
 *    shared by the poster and both probes; an unresolvable provider fails with
 *    a code outside the retryable set.
 * 3. **Turn** — a streamed answer reaches `onData` untouched; a JSON answer to a
 *    streamed request is synthesised into the frame sequence that row's wire
 *    decodes; refusals classify into the harness vocabulary.
 * 4. **Keys** — no thrown error, however talkative the provider's 401 body, ever
 *    contains the credential.
 *
 * The transport is a real `node:http` server on 127.0.0.1 whose reply each test
 * scripts; the provider records are the shipped registry, so the base URLs the
 * tests override are the ones users would override.
 *
 * Run: node scripts/aggregate-test.mjs
 */
import assert from 'node:assert/strict'
import http from 'node:http'
import { AGGREGATE_CHANNEL, buildAggregateCatalog, fetchProviderModels, isAggregateEntry, postAggregateStreamed, resolveProvider, testProvider } from '../src/aggregate.js'
import { UpstreamError } from '../src/http.js'
import { toClaudeMessages } from '../src/messages.js'
import { parseProviderModelId } from '../src/providers/index.js'
import { finishReason, readStream } from '../src/stream.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`ok   ${name}`) }
  catch (error) { failures++; console.log(`FAIL ${name} — ${error?.message ?? error}`) }
}
/** Run a thunk and return whatever it threw, or null. */
const thrown = fn => {
  try { fn(); return null } catch (error) { return error }
}
/** One decoded payload list through the plugin's own stream reader. */
async function decode(payloads, wire) {
  const lines = (async function * () { for (const payload of payloads) yield payload })()
  const reader = readStream(lines, wire, new Map())
  const chunks = []
  while (true) {
    const row = await reader.next()
    if (row.done) return { chunks, outcome: row.value }
    chunks.push(row.value)
  }
}
/** A port nothing listens on: bind, read the number, close. */
async function closedPort() {
  const server = http.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

// ── 1. the catalog, pure ─────────────────────────────────────────────────────
const catalogConfig = {
  enabled: true,
  providers: {
    cerebras: { enabled: true, apiKey: 'k-cerebras' },
    groq: { enabled: true },
    ollama: { enabled: true, models: ['llama3.2:1b'] },
    openai: { enabled: true, apiKey: 'k-openai' },
    'not-a-provider': { enabled: true, apiKey: 'k' },
    anthropic: { enabled: true, apiKey: 'k-anthropic' },
    openai_api: { enabled: true, apiKey: 'k-openai-api' },
    baidu: { enabled: true, apiKey: 'k-baidu' },
    mistral: { enabled: true, apiKey: 'k-mistral', discovered: ['mistral-large-latest'] },
    together: { enabled: true, apiKey: 'k-together', models: ['custom-a', 'custom-b'], discovered: ['live-x'] },
    azure_openai: { enabled: true, apiKey: 'k-azure', models: ['gpt-4o'] },
    cloudflare: { enabled: true, apiKey: 'k-cf' },
    deepseek: { enabled: false, apiKey: 'k-deepseek' },
  },
}
const rows = buildAggregateCatalog(catalogConfig)
const ids = rows.map(entry => entry.id)
const row = id => rows.find(entry => entry.id === id)

check('an enabled apiKey provider with a key contributes its registry models',
  ids.includes('cerebras/gpt-oss-120b') && ids.includes('cerebras/llama-3.3-70b'), true)
check('an enabled apiKey provider with no key is skipped', ids.some(id => id.startsWith('groq/')), false)
check('a local provider needs no key', ids.filter(id => id.startsWith('ollama/')), ['ollama/llama3.2:1b'])
check('an unknown provider id is skipped', ids.some(id => id.startsWith('not-a-provider/')), false)
check('a disabled provider is skipped', ids.some(id => id.startsWith('deepseek/')), false)
check('an oauth provider is not served even with a key pasted', ids.some(id => id.startsWith('openai/')), false)
check('a provider with no base URL of its own stays out until one is set', ids.some(id => id.startsWith('azure_openai/')), false)
check('a base URL still carrying a registry placeholder stays out', ids.some(id => id.startsWith('cloudflare/')), false)
check('the user\'s models override replaces the registry list',
  ids.filter(id => id.startsWith('together/')), ['together/custom-a', 'together/custom-b'])
check('a configured models list is marked static', row('together/custom-a').source, 'static')
check('a discovered list is served and marked discovered', row('mistral/mistral-large-latest').source, 'discovered')
check('the registry format maps to the plugin wire',
  [row('cerebras/gpt-oss-120b').wire, row('openai_api/gpt-5.5').wire, row('anthropic/claude-sonnet-4-20250514').wire],
  ['chat', 'responses', 'messages'])
check('the registry format rides the row too',
  [row('cerebras/gpt-oss-120b').format, row('anthropic/claude-sonnet-4-20250514').format],
  ['openai-chat', 'anthropic-messages'])
check('every row is an aggregate row with provider/model identity',
  rows.every(entry => entry.channel === AGGREGATE_CHANNEL && isAggregateEntry(entry)
    && entry.id === `${entry.providerId}/${entry.modelId}`), true)
check('every id round-trips through parseProviderModelId', rows.every(entry => {
  const parsed = parseProviderModelId(entry.id)
  return parsed !== null && parsed.providerId === entry.providerId && parsed.modelId === entry.modelId
}), true)
check('published capacities ride the row',
  [row('baidu/deepseek-v4-pro').contextWindow, row('baidu/deepseek-v4-pro').maxOutput], [1048576, 32768])
check('a row with no published capacity falls back to the plugin defaults',
  [row('cerebras/gpt-oss-120b').contextWindow, row('cerebras/gpt-oss-120b').maxOutput,
    row('cerebras/gpt-oss-120b').vision, row('cerebras/gpt-oss-120b').reasoning],
  [131072, 32768, false, true])
check('a row declares no provider-native menu, so the shared ladder is the control',
  [row('cerebras/gpt-oss-120b').efforts, row('cerebras/gpt-oss-120b').canDisableThinking], [undefined, true])
check('the name is provider-first, the other lanes\' tag-first shape',
  row('baidu/deepseek-v4-pro').name, 'Baidu Qianfan DeepSeek V4 Pro')
check('the section switch off means no rows at all',
  buildAggregateCatalog({ enabled: false, providers: { cerebras: { enabled: true, apiKey: 'k' } } }), [])
check('a config with no providers object builds nothing',
  [buildAggregateCatalog(undefined), buildAggregateCatalog({})], [[], []])
check('isAggregateEntry refuses other lanes\' rows',
  [isAggregateEntry({ channel: 'kilo' }), isAggregateEntry({ id: 'x' }), isAggregateEntry(null)], [false, false, false])

const azureConfig = {
  providers: { azure_openai: { enabled: true, apiKey: 'k-azure', baseUrl: 'https://res.openai.azure.com/openai/v1/', models: ['gpt-4o'] } },
}
check('a user base URL makes a record with no endpoint dialable',
  buildAggregateCatalog(azureConfig).map(entry => entry.id), ['azure_openai/gpt-4o'])
check('...and its endpoint is composed from that base and the format suffix',
  resolveProvider(azureConfig, 'azure_openai').chatUrl, 'https://res.openai.azure.com/openai/v1/chat/completions')
const cfConfig = {
  providers: { cloudflare: { enabled: true, apiKey: 'k-cf', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1' } },
}
check('a placeholder host is served once the user fills it in', buildAggregateCatalog(cfConfig).length > 0, true)
check('...on the endpoint the override composes',
  resolveProvider(cfConfig, 'cloudflare').chatUrl, 'https://api.cloudflare.com/client/v4/accounts/acc-1/ai/v1/chat/completions')

// ── 2. provider resolution ───────────────────────────────────────────────────
const unknown = thrown(() => resolveProvider({}, 'not-a-provider'))
check('an unknown provider id throws an UpstreamError', unknown instanceof UpstreamError, true)
check('...with a request-defect code', unknown?.code, 'CLIENT_ERROR')
const missingKey = thrown(() => resolveProvider({ providers: { cerebras: { enabled: true } } }, 'cerebras'))
check('a missing key throws a credential code', missingKey?.code, 'INVALID_CREDENTIAL')
check('...naming the provider, never a key',
  [missingKey.message.includes('Cerebras'), /needs an API key/.test(missingKey.message)], [true, true])
check('a switched-off provider refuses to resolve',
  thrown(() => resolveProvider({ providers: { cerebras: { enabled: false, apiKey: 'k' } } }, 'cerebras'))?.code, 'CLIENT_ERROR')
check('an oauth provider is refused whatever the config says',
  thrown(() => resolveProvider({ providers: { openai: { enabled: true, apiKey: 'k' } } }, 'openai'))?.code, 'INVALID_CREDENTIAL')
check('a provider with no base URL of its own refuses to resolve',
  thrown(() => resolveProvider({ providers: { azure_openai: { enabled: true, apiKey: 'k' } } }, 'azure_openai'))?.code, 'CLIENT_ERROR')
check('a placeholder base URL refuses to resolve',
  thrown(() => resolveProvider({ providers: { cloudflare: { enabled: true, apiKey: 'k' } } }, 'cloudflare'))?.code, 'CLIENT_ERROR')

const withKey = { providers: { cerebras: { enabled: true, apiKey: 'k-cerebras' } } }
const plain = resolveProvider(withKey, 'cerebras')
check('a key resolves with the registry host and the format\'s endpoint',
  [plain.apiKey, plain.baseUrl, plain.chatUrl, plain.modelsUrl, plain.wire],
  ['k-cerebras', 'https://api.cerebras.ai/v1', 'https://api.cerebras.ai/v1/chat/completions', 'https://api.cerebras.ai/v1/models', 'chat'])
check('the key rides in the authorization header',
  [plain.headers.authorization, plain.headers['content-type'], plain.headers['user-agent']],
  ['Bearer k-cerebras', 'application/json', 'dsh-our-free-model'])
const overridden = resolveProvider({ providers: { cerebras: { enabled: true, apiKey: 'k', baseUrl: 'http://127.0.0.1:9/cerebras/' } } }, 'cerebras')
check('a base URL override moves the turn and the listing with it',
  [overridden.baseUrl, overridden.chatUrl, overridden.modelsUrl],
  ['http://127.0.0.1:9/cerebras', 'http://127.0.0.1:9/cerebras/chat/completions', 'http://127.0.0.1:9/cerebras/models'])
// A keyless row resolves with no per-user credential at all: `apiKey` stays
// empty and no bearer is invented, which is what the local rows require.
const keyless = resolveProvider({ providers: { ollama: { enabled: true, models: ['llama3.2:1b'] } } }, 'ollama')
check('a keyless provider resolves with no credential of its own',
  [keyless.apiKey, keyless.headers.authorization, keyless.headers['x-api-key']], ['', undefined, undefined])
const claude = resolveProvider({ providers: { anthropic: { enabled: true, apiKey: 'sk-ant' } } }, 'anthropic')
check('an Anthropic row resolves to x-api-key plus the version header',
  [claude.chatUrl, claude.headers['x-api-key'], claude.headers.authorization, claude.headers['anthropic-version'], claude.wire, claude.modelsUrl],
  ['https://api.anthropic.com/v1/messages', 'sk-ant', undefined, '2023-06-01', 'messages', null])
check('a provider-declared header survives resolution',
  resolveProvider({ providers: { kimchi: { enabled: true, apiKey: 'k' } } }, 'kimchi').headers['user-agent'], 'kimchi/0.1.50')

// ── 3. the turn, against a loopback provider ─────────────────────────────────
const CEREBRAS_KEY = 'sk-cerebras-secret'
const ANTHROPIC_KEY = 'sk-ant-secret'
const seen = []
let script = () => {}
const openResponses = new Set()
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const record = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') }
    seen.push(record)
    openResponses.add(res)
    res.on('close', () => openResponses.delete(res))
    script(req, res, record)
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
const liveConfig = {
  enabled: true,
  providers: {
    cerebras: { enabled: true, apiKey: CEREBRAS_KEY, baseUrl: `${base}/cerebras` },
    anthropic: { enabled: true, apiKey: ANTHROPIC_KEY, baseUrl: `${base}/anthropic` },
    openai_api: { enabled: true, apiKey: 'sk-openai-secret', baseUrl: `${base}/openai` },
  },
}
const last = () => seen[seen.length - 1]
const lastGet = url => [...seen].reverse().find(record => record.method === 'GET' && record.url === url)

const CHAT_FRAMES = [
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'weighing' }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [{ index: 0, delta: { content: 'Aggregate ' }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [{ index: 0, delta: { content: 'answer' }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_7', type: 'function', function: { name: 'read', arguments: '{"path":"x"}' } }] }, finish_reason: null }] }),
  JSON.stringify({ id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-oss-120b', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 9, prompt_tokens_details: { cached_tokens: 2 } } }),
]

await checkAsync('a streamed answer is pushed through verbatim, in order', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(': KEEP-ALIVE\n\n')
    for (const frame of CHAT_FRAMES) res.write(`data: ${frame}\n\n`)
    res.end('data: [DONE]\n\n')
  }
  const pushed = []
  const result = await postAggregateStreamed({
    config: liveConfig, providerId: 'cerebras', modelId: 'gpt-oss-120b',
    body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
    onData: value => pushed.push(value),
  })
  assert.deepEqual(pushed, CHAT_FRAMES)
  assert.equal(result.status, 200)
  const request = last()
  assert.equal(request.url, '/cerebras/chat/completions')
  assert.equal(request.headers.authorization, `Bearer ${CEREBRAS_KEY}`)
  assert.equal(request.headers.accept, 'text/event-stream')
  assert.equal(JSON.parse(request.body).stream, true)
  const { chunks, outcome } = await decode(pushed, 'chat')
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'weighing'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Aggregate '))
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').map(chunk => chunk.block),
    [{ type: 'tool-call', id: 'call_7', name: 'read', arguments: '{"path":"x"}' }])
  assert.deepEqual(outcome.usage, { inputTokens: 10, outputTokens: 9, cacheReadTokens: 2, totalTokens: 21 })
  assert.equal(finishReason(outcome.finish).kind, 'tool-calls')
})

const COMPLETION = {
  id: 'cmpl-1',
  object: 'chat.completion',
  model: 'gpt-oss-120b',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      reasoning_content: 'deliberating',
      content: 'Aggregate answer',
      tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'read', arguments: '{"path":"y"}' } }],
    },
    finish_reason: 'tool_calls',
  }],
  usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 4 } },
}

await checkAsync('a JSON answer to a streamed chat request is synthesised into a complete turn', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(COMPLETION))
  }
  const pushed = []
  await postAggregateStreamed({
    config: liveConfig, providerId: 'cerebras', modelId: 'gpt-oss-120b',
    body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
    onData: value => pushed.push(value),
  })
  assert.ok(pushed.length >= 3, `expected a frame sequence, got ${pushed.length} payload(s)`)
  for (const frame of pushed) assert.equal(typeof JSON.parse(frame), 'object')
  const { chunks, outcome } = await decode(pushed, 'chat')
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'deliberating'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Aggregate answer'))
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').map(chunk => chunk.block),
    [{ type: 'tool-call', id: 'call_9', name: 'read', arguments: '{"path":"y"}' }])
  assert.deepEqual(outcome.usage, { inputTokens: 16, outputTokens: 5, cacheReadTokens: 4, totalTokens: 25 })
  assert.equal(finishReason(outcome.finish).kind, 'tool-calls')
})

const ANTHROPIC_JSON = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-20250514',
  content: [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'Hello' },
    { type: 'tool_use', id: 'toolu_1', name: 'read', input: { path: 'z' } },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 7, output_tokens: 3 },
}

await checkAsync('a JSON answer to a streamed messages request is synthesised into Anthropic events', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(ANTHROPIC_JSON))
  }
  const pushed = []
  await postAggregateStreamed({
    config: liveConfig, providerId: 'anthropic', modelId: 'claude-sonnet-4-20250514',
    body: { model: 'claude-sonnet-4-20250514', max_tokens: 128, messages: [{ role: 'user', content: 'hi' }] },
    onData: value => pushed.push(value),
  })
  assert.ok(pushed.every(frame => typeof JSON.parse(frame).type === 'string'), 'every frame names its Anthropic event')
  const { chunks, outcome } = await decode(pushed, 'messages')
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'hmm'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Hello'))
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').map(chunk => chunk.block),
    [{ type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"path":"z"}' }])
  assert.deepEqual(outcome.usage, { inputTokens: 7, outputTokens: 3, totalTokens: 10 })
  assert.equal(finishReason(outcome.finish).kind, 'tool-calls')
})

const RESPONSES_JSON = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'gpt-5.5',
  output: [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'pondering' }] },
    { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Responses answer', annotations: [] }] },
    { type: 'function_call', id: 'fc_1', call_id: 'call_r1', name: 'read', arguments: '{"path":"r"}' },
  ],
  usage: { input_tokens: 14, output_tokens: 6, input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 } },
}

await checkAsync('a JSON answer to a streamed responses request is synthesised into Responses events', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(RESPONSES_JSON))
  }
  const pushed = []
  await postAggregateStreamed({
    config: liveConfig, providerId: 'openai_api', modelId: 'gpt-5.5',
    body: { model: 'gpt-5.5', input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] },
    onData: value => pushed.push(value),
  })
  assert.equal(last().url, '/openai/responses')
  assert.ok(pushed.every(frame => JSON.parse(frame).type.startsWith('response.')), 'every frame names a Responses event')
  const { chunks, outcome } = await decode(pushed, 'responses')
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'pondering'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Responses answer'))
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').map(chunk => chunk.block),
    [{ type: 'tool-call', id: 'call_r1', name: 'read', arguments: '{"path":"r"}' }])
  assert.deepEqual(outcome.usage,
    { inputTokens: 12, outputTokens: 6, cacheReadTokens: 2, reasoningTokens: 1, totalTokens: 20 })
  assert.equal(finishReason(outcome.finish).kind, 'stop')
})

const ANTHROPIC_SSE = [
  JSON.stringify({ type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 11, cache_read_input_tokens: 3, output_tokens: 0 } } }),
  JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
  JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'considering' } }),
  JSON.stringify({ type: 'content_block_stop', index: 0 }),
  JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
  JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Claude answer' } }),
  JSON.stringify({ type: 'content_block_stop', index: 1 }),
  JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'read' } }),
  JSON.stringify({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"q"}' } }),
  JSON.stringify({ type: 'content_block_stop', index: 2 }),
  JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } }),
  JSON.stringify({ type: 'message_stop' }),
]

await checkAsync('an Anthropic answer stays on its own wire and the messages decoder reads it whole', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const frame of ANTHROPIC_SSE) res.write(`event: ${JSON.parse(frame).type}\ndata: ${frame}\n\n`)
    res.end()
  }
  // The request body is the one the plugin's own shaper produces for this wire,
  // so the check below pins the whole request mapping, not a hand-written body.
  const shaped = toClaudeMessages([
    { role: 'system', content: [{ type: 'text', text: 'be brief' }] },
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
  ], undefined, [])
  const body = { model: 'claude-sonnet-4-20250514', messages: shaped.messages, system: shaped.system, max_tokens: 512 }
  const pushed = []
  await postAggregateStreamed({
    config: liveConfig, providerId: 'anthropic', modelId: 'claude-sonnet-4-20250514',
    body, onData: value => pushed.push(value),
  })
  const request = last()
  assert.equal(request.url, '/anthropic/messages')
  assert.equal(request.headers['x-api-key'], ANTHROPIC_KEY)
  assert.equal(request.headers.authorization, undefined)
  assert.equal(request.headers['anthropic-version'], '2023-06-01')
  const sent = JSON.parse(request.body)
  assert.equal(sent.max_tokens, 512)
  assert.equal(sent.system, 'be brief')
  assert.deepEqual(sent.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  assert.equal(sent.stream, true)
  // Untouched: the frames the provider sent are the frames the decoder gets.
  assert.deepEqual(pushed, ANTHROPIC_SSE)
  const { chunks, outcome } = await decode(pushed, 'messages')
  assert.ok(chunks.some(chunk => chunk.type === 'reasoning-delta' && chunk.text === 'considering'))
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'Claude answer'))
  assert.deepEqual(
    chunks.filter(chunk => chunk.type === 'block-end' && chunk.block?.type === 'tool-call').map(chunk => chunk.block),
    [{ type: 'tool-call', id: 'toolu_2', name: 'read', arguments: '{"path":"q"}' }])
  assert.deepEqual(outcome.usage, { inputTokens: 8, outputTokens: 6, cacheReadTokens: 3, totalTokens: 17 })
  assert.equal(finishReason(outcome.finish).kind, 'tool-calls')
})

await checkAsync('a 401 is a credential failure and never carries the key', async () => {
  script = (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: {
        message: `Incorrect API key provided: ${CEREBRAS_KEY}. You can find your API key at https://example.test/keys`,
        type: 'invalid_request_error',
        code: 'invalid_api_key',
      },
    }))
  }
  let failure
  try {
    await postAggregateStreamed({
      config: liveConfig, providerId: 'cerebras', modelId: 'gpt-oss-120b',
      body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
      onData: () => {},
    })
  } catch (error) { failure = error }
  assert.ok(failure instanceof UpstreamError, 'an UpstreamError, not a bare Error')
  assert.equal(failure.code, 'INVALID_CREDENTIAL')
  assert.equal(failure.status, 401)
  assert.ok(failure.message.includes('[redacted]'), `the echo should be redacted, got: ${failure.message}`)
  const rendered = `${String(failure)}\n${JSON.stringify(failure)}\n${failure.stack ?? ''}`
  assert.ok(!rendered.includes(CEREBRAS_KEY), `the key leaked into the error: ${rendered}`)
})

await checkAsync('a key that JSON escapes is redacted in its escaped spelling too', async () => {
  const awkward = 'sk-"weird\\key'
  script = (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `bad key ${awkward}`, type: 'invalid_request_error' } }))
  }
  let failure
  try {
    await postAggregateStreamed({
      config: { providers: { cerebras: { enabled: true, apiKey: awkward, baseUrl: `${base}/cerebras` } } },
      providerId: 'cerebras', modelId: 'gpt-oss-120b',
      body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
      onData: () => {},
    })
  } catch (error) { failure = error }
  assert.equal(failure?.code, 'INVALID_CREDENTIAL')
  const rendered = `${String(failure)}\n${JSON.stringify(failure)}`
  assert.ok(!rendered.includes('weird'), `the key leaked in some spelling: ${rendered}`)
  assert.ok(failure.message.includes('[redacted]'))
})

await checkAsync('a 429 is a rate-limit failure with the retry hint', async () => {  script = (req, res) => {
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '2' })
    res.end(JSON.stringify({ error: { message: 'Rate limit reached for this key', type: 'rate_limit_error' } }))
  }
  let failure
  try {
    await postAggregateStreamed({
      config: liveConfig, providerId: 'cerebras', modelId: 'gpt-oss-120b',
      body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
      onData: () => {},
    })
  } catch (error) { failure = error }
  assert.equal(failure?.code, 'RATE_LIMIT')
  assert.equal(failure?.status, 429)
  assert.equal(failure?.providerRetryAfterMs, 2000)
})

await checkAsync('an HTML 200 body is the front proxy speaking, not a retryable fault', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end('<!doctype html><html><body>524: A timeout occurred</body></html>')
  }
  let failure
  try {
    await postAggregateStreamed({
      config: liveConfig, providerId: 'cerebras', modelId: 'gpt-oss-120b',
      body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
      onData: () => {},
    })
  } catch (error) { failure = error }
  assert.equal(failure?.code, 'CLIENT_ERROR')
  assert.match(failure?.message ?? '', /HTML error page/)
})

await checkAsync('an aborted signal ends the turn as ABORTED', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${CHAT_FRAMES[1]}\n\n`)
    // Deliberately left open: the abort has to land while the reader waits.
  }
  const controller = new AbortController()
  const pushed = []
  const pending = postAggregateStreamed({
    config: liveConfig, providerId: 'cerebras', modelId: 'gpt-oss-120b',
    body: { model: 'gpt-oss-120b', messages: [{ role: 'user', content: 'hi' }] },
    signal: controller.signal, onData: value => pushed.push(value),
  })
  const deadline = Date.now() + 3000
  while (pushed.length === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(pushed.length, 1, 'the first frame should arrive before the abort')
  controller.abort()
  let failure
  try { await pending } catch (error) { failure = error }
  assert.equal(failure?.code, 'ABORTED')
})

// ── 4. the key probes ────────────────────────────────────────────────────────
const LISTING = { data: [{ id: 'live-a' }, { id: 'live-b' }] }

await checkAsync('testProvider accepts a 200 listing and counts it', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(LISTING))
  }
  const answer = await testProvider(liveConfig, 'cerebras')
  assert.equal(answer.ok, true)
  assert.equal(answer.status, 200)
  assert.equal(answer.modelCount, 2)
  const request = lastGet('/cerebras/models')
  assert.equal(request.headers.authorization, `Bearer ${CEREBRAS_KEY}`)
  assert.equal(request.headers.accept, 'application/json')
})

await checkAsync('testProvider reports a rejected key without echoing it', async () => {
  script = (req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: `Invalid key: ${CEREBRAS_KEY}`, type: 'invalid_request_error' } }))
  }
  const answer = await testProvider(liveConfig, 'cerebras')
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 401)
  assert.ok(!answer.message.includes(CEREBRAS_KEY), `the key leaked: ${answer.message}`)
  assert.ok(answer.message.includes('[redacted]'))
})

await checkAsync('testProvider refuses to guess a listing URL', async () => {
  const answer = await testProvider(liveConfig, 'anthropic')
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 0)
  assert.match(answer.message, /declares no model listing/)
})

await checkAsync('testProvider answers a refused connection instead of throwing', async () => {
  const port = await closedPort()
  const answer = await testProvider({
    providers: { cerebras: { enabled: true, apiKey: 'k-refused', baseUrl: `http://127.0.0.1:${port}/cerebras` } },
  }, 'cerebras')
  assert.equal(answer.ok, false)
  assert.equal(answer.status, 0)
  assert.match(answer.message, /could not be reached/)
})

await checkAsync('fetchProviderModels returns the ids a listing names', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(LISTING))
  }
  assert.deepEqual(await fetchProviderModels(liveConfig, 'cerebras'), ['live-a', 'live-b'])
  const request = lastGet('/cerebras/models')
  assert.equal(request.headers.authorization, `Bearer ${CEREBRAS_KEY}`)
})

await checkAsync('fetchProviderModels reads the dialects the registry points at', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ models: [{ name: 'command-r' }, { name: 'command-r' }, { model_name: 'other' }] }))
  }
  assert.deepEqual(await fetchProviderModels(liveConfig, 'cerebras'), ['command-r', 'other'])
})

await checkAsync('fetchProviderModels distinguishes an empty roster from a failure', async () => {
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [] }))
  }
  assert.deepEqual(await fetchProviderModels(liveConfig, 'cerebras'), [])
  script = (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: {} }))
  }
  assert.equal(await fetchProviderModels(liveConfig, 'cerebras'), null)
  script = (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'listing exploded' } }))
  }
  assert.equal(await fetchProviderModels(liveConfig, 'cerebras'), null)
})

await checkAsync('fetchProviderModels stays null where there is nothing to fetch', async () => {
  assert.equal(await fetchProviderModels(liveConfig, 'anthropic'), null)
  assert.equal(await fetchProviderModels(liveConfig, 'not-a-provider'), null)
  const port = await closedPort()
  const refusedConfig = {
    providers: { cerebras: { enabled: true, apiKey: 'k-refused', baseUrl: `http://127.0.0.1:${port}/cerebras` } },
  }
  assert.equal(await fetchProviderModels(refusedConfig, 'cerebras'), null)
})

// ── teardown ─────────────────────────────────────────────────────────────────
for (const response of openResponses) response.destroy()
server.closeAllConnections?.()
await new Promise(resolve => server.close(resolve))
console.log(failures === 0 ? '\naggregate-test: all checks passed' : `\naggregate-test: ${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
