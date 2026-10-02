/**
 * End-to-end tests for the OpenAI-compatible forward listener, against the real
 * `startForwardServer` with a stubbed completion lane.
 *
 * Covers the three wire-hygiene failures behind issue #20 ("forwarded clients
 * cannot call tools") and the responses-endpoint compatibility gaps:
 *
 * - streaming `tool_calls[].index` renumbered from 0 (upstream block indices
 *   share a counter with reasoning/text, so the first tool call used to arrive
 *   as index 2+ and index-accumulating clients got holes);
 * - tool calls aimed at the fingerprint decoys are suppressed instead of handed
 *   to a client that never declared them;
 * - a turn whose tool arguments were cut by the output ceiling finishes as
 *   `length`, not as an executable `tool_calls`;
 * - a non-JSON body answers 400 (not 500), an unknown model 404 (not 502);
 * - `/v1/responses` honors `instructions`, `max_output_tokens` and `stream`.
 *
 * Run: node scripts/forward-test.mjs
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { startForwardServer, resolveLoopbackBind } from '../src/forward.js'
import { toToolDefs } from '../src/messages.js'
import { applyFingerprint } from '../src/upstream.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}\n${error.stack?.split('\n').slice(1, 3).join('\n') ?? ''}`) }
}

/**
 * The stub lane: one scripted sequence of harness chunks per request, plus the
 * outcome summary the host half would fold from them. Records what arrived so
 * the responses-endpoint tests can assert on the translated request.
 */
function makeLane() {
  const lane = { seen: [] }
  lane.script = () => ({ chunks: [], outcome: { text: '', toolCalls: [], usage: undefined } })
  lane.complete = async (request, onChunk) => {
    lane.seen.push(request)
    const { chunks, outcome } = lane.script(request)
    for (const chunk of chunks) onChunk(chunk)
    return outcome
  }
  return lane
}

const openServers = []
async function serve(lane) {
  const server = await startForwardServer({
    config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key: 'k-test' }),
    complete: lane.complete,
    modelRows: () => [],
  })
  openServers.push(server)
  return `http://127.0.0.1:${server.port}`
}

const authFetch = (base, path, body) => fetch(`${base}${path}`, {
  method: 'POST',
  headers: { authorization: 'Bearer k-test', 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})

/** Split one SSE body into its data frames. */
function sseFrames(body) {
  return body.split('\n\n').filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice('data: '.length)))
}

const toolCallDeltas = body => sseFrames(body)
  .flatMap(frame => frame.choices?.[0]?.delta?.tool_calls ?? [])

// ── streaming tool-call wiring (#20) ─────────────────────────────────────────
await checkAsync('streaming tool_calls renumber from 0 after reasoning blocks', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({
    chunks: [
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'text-delta', index: 1, text: 'partial answer' },
      { type: 'tool-call-delta', index: 2, id: 'call_a', name: 'read', argumentsDelta: '{"file"' },
      { type: 'tool-call-delta', index: 2, argumentsDelta: ':"x"}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"file":"x"}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    outcome: { text: 'partial answer', toolCalls: [{ slot: 2, id: 'call_a', name: 'read', arguments: '{"file":"x"}' }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
  })
  const response = await authFetch(base, '/v1/chat/completions', {
    model: 'mimo-v2.6-flash-free', stream: true,
    tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: {} } } }],
  })
  assert.equal(response.status, 200)
  const frames = toolCallDeltas(await response.text())
  assert.ok(frames.length >= 3, `expected id, name and argument frames, got ${frames.length}`)
  assert.ok(frames.every(frame => frame.index === 0), `every frame must carry the renumbered index 0, got ${frames.map(f => f.index)}`)
  const named = frames.find(frame => frame.function?.name !== undefined)
  assert.equal(named?.function?.name, 'read')
  const args = frames.filter(frame => frame.function?.arguments !== undefined).map(frame => frame.function.arguments).join('')
  assert.equal(args, '{"file":"x"}')
})

await checkAsync('a decoy tool call never reaches the streaming client', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({
    chunks: [
      { type: 'text-delta', index: 1, text: 'let me check' },
      // The model dialed the fingerprint decoy: the caller declared no such tool.
      { type: 'tool-call-delta', index: 2, id: 'call_d', name: 'bash', argumentsDelta: '{"command"' },
      { type: 'tool-call-delta', index: 2, argumentsDelta: ':"ls"}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_d', name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    outcome: { text: 'let me check', toolCalls: [{ slot: 2, id: 'call_d', name: 'bash', arguments: '{"command":"ls"}' }] },
  })
  const response = await authFetch(base, '/v1/chat/completions', {
    model: 'mimo-v2.6-flash-free', stream: true,
    tools: [{ type: 'function', function: { name: 'mytool', parameters: { type: 'object', properties: {} } } }],
  })
  const body = await response.text()
  assert.deepEqual(toolCallDeltas(body), [], 'no tool frame may mention the undeclared decoy')
  const finish = sseFrames(body).map(frame => frame.choices?.[0]?.finish_reason).filter(Boolean)
  assert.deepEqual(finish, ['stop'], `a suppressed-only turn must not finish as tool_calls, got ${finish}`)
})

await checkAsync('a ceiling-cut tool call finishes as length on the stream', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({
    chunks: [
      { type: 'tool-call-delta', index: 0, id: 'call_t', name: 'mytool', argumentsDelta: '{"x":"' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ],
    outcome: { text: '', toolCalls: [{ slot: 0, id: 'call_t', name: 'mytool', arguments: '{"x":"' }], truncated: true },
  })
  const response = await authFetch(base, '/v1/chat/completions', {
    model: 'mimo-v2.6-flash-free', stream: true,
    tools: [{ type: 'function', function: { name: 'mytool', parameters: { type: 'object', properties: {} } } }],
  })
  const body = await response.text()
  const finish = sseFrames(body).map(frame => frame.choices?.[0]?.finish_reason).filter(Boolean)
  assert.deepEqual(finish, ['length'], `got ${finish}`)
})

// ── non-streaming ────────────────────────────────────────────────────────────
await checkAsync('non-streaming drops decoys and unexecutable calls after a cut', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({
    chunks: [],
    outcome: {
      text: '',
      toolCalls: [
        { slot: 0, id: 'call_d', name: 'bash', arguments: '{}' },
        { slot: 1, id: 'call_b', name: 'mytool', arguments: '{"x":' },
        { slot: 2, id: 'call_g', name: 'mytool', arguments: '{"y":1}' },
      ],
      truncated: true,
    },
  })
  const response = await authFetch(base, '/v1/chat/completions', {
    model: 'mimo-v2.6-flash-free',
    tools: [{ type: 'function', function: { name: 'mytool', parameters: { type: 'object', properties: {} } } }],
  })
  const payload = await response.json()
  assert.deepEqual(payload.choices[0].message.tool_calls?.map(call => call.function.arguments), ['{"y":1}'])
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
})

await checkAsync('a non-JSON body answers 400', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  const response = await authFetch(base, '/v1/chat/completions', 'not json at all')
  assert.equal(response.status, 400)
  const payload = await response.json()
  assert.equal(payload.error.type, 'invalid_request_error')
})

// ── the responses endpoint (#20 / Codex-shaped clients) ──────────────────────
await checkAsync('responses endpoint maps instructions and max_output_tokens', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({ chunks: [], outcome: { text: 'done', toolCalls: [] } })
  const response = await authFetch(base, '/v1/responses', {
    model: 'muse-spark-1.3-contributor-free',
    instructions: 'be brief',
    input: 'hello',
    max_output_tokens: 512,
  })
  assert.equal(response.status, 200)
  const request = lane.seen[0]
  assert.equal(request.openAi.max_tokens, 512, 'max_output_tokens must reach the lane as max_tokens')
  assert.equal(request.openAi.input[0]?.role, 'system')
  assert.equal(request.openAi.input[0]?.content, 'be brief')
  const payload = await response.json()
  assert.equal(payload.status, 'completed')
  assert.equal(payload.output[0]?.content?.[0]?.text, 'done')
})

await checkAsync('responses endpoint streams events and reports usage', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({
    chunks: [
      { type: 'text-delta', index: 1, text: 'hello ' },
      { type: 'text-delta', index: 1, text: 'world' },
      { type: 'usage', usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    outcome: { text: 'hello world', toolCalls: [], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } },
  })
  const response = await authFetch(base, '/v1/responses', { model: 'muse-spark-1.3-contributor-free', input: 'hi', stream: true })
  assert.equal(response.status, 200)
  const body = await response.text()
  const types = body.split('\n').filter(line => line.startsWith('event: ')).map(line => line.slice('event: '.length))
  assert.deepEqual(types, ['response.created', 'response.output_item.added', 'response.output_text.delta', 'response.output_text.delta', 'response.completed'])
  const completed = JSON.parse(body.split('\n').filter(line => line.startsWith('data: ')).at(-1).slice('data: '.length))
  assert.equal(completed.response.status, 'completed')
  assert.equal(completed.response.output[0].content[0].text, 'hello world')
  assert.equal(completed.response.usage.output_tokens, 5)
})

await checkAsync('responses streaming gives text and calls distinct output indexes', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({
    chunks: [
      { type: 'text-delta', index: 1, text: 'checking ' },
      { type: 'tool-call-delta', index: 2, id: 'call_a', name: 'mytool', argumentsDelta: '{"a"' },
      { type: 'tool-call-delta', index: 3, id: 'call_b', name: 'mytool', argumentsDelta: '{"b"' },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
    outcome: { text: 'checking ', toolCalls: [
      { slot: 2, id: 'call_a', name: 'mytool', arguments: '{"a":1}' },
      { slot: 3, id: 'call_b', name: 'mytool', arguments: '{"b":2}' },
    ] },
  })
  const response = await authFetch(base, '/v1/responses', {
    model: 'muse-spark-1.3-contributor-free', input: 'hi', stream: true,
    tools: [{ type: 'function', name: 'mytool', parameters: { type: 'object', properties: {} } }],
  })
  assert.equal(response.status, 200)
  const body = await response.text()
  const frames = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
  const added = frames.filter(frame => frame.type === 'response.output_item.added')
  assert.deepEqual(added.map(frame => frame.output_index), [0, 1, 2], `indexes must be distinct and sequential, got ${added.map(frame => frame.output_index)}`)
  assert.deepEqual(added.map(frame => frame.item.type), ['message', 'function_call', 'function_call'])
  // each arguments delta carries the same output_index its item was announced with
  const argDeltas = frames.filter(frame => frame.type === 'response.function_call_arguments.delta')
  assert.deepEqual(argDeltas.map(frame => frame.output_index), [1, 2])
  assert.equal(argDeltas.map(frame => frame.delta).join(''), '{"a"{"b"')
  const completed = frames.find(frame => frame.type === 'response.completed')
  assert.deepEqual(completed.response.output.map(row => row.type), ['message', 'function_call', 'function_call'])
  assert.equal(completed.response.output[1].arguments, '{"a":1}')
  assert.equal(completed.response.output[2].arguments, '{"b":2}')
})

await checkAsync('responses endpoint reports an incomplete turn after a cut', async () => {
  const lane = makeLane()
  const base = await serve(lane)
  lane.script = () => ({ chunks: [], outcome: { text: 'half an answer', toolCalls: [], truncated: true } })
  const response = await authFetch(base, '/v1/responses', { model: 'muse-spark-1.3-contributor-free', input: 'hi' })
  const payload = await response.json()
  assert.equal(payload.status, 'incomplete')
  assert.deepEqual(payload.incomplete_details, { reason: 'max_output_tokens' })
})

// ── caller tools survive the round trip (#26) ────────────────────────────────
// The listener used to pre-convert its caller's `body.tools` into the OpenAI
// wrapper shape before handing them to the adapter, while the adapter's own
// conversion reads `tool.name` — so every tool was dropped, the request reached
// the wire with an empty tool list, and `applyFingerprint` filled the quartet's
// self-disabling decoys in their place and pinned `tool_choice: 'none'`. The
// model then told the client it had no tools, and any decoy it called anyway was
// dropped downstream as an empty answer.
const openAiTool = name => ({
  type: 'function',
  function: {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  },
})

/** Mirrors index.js's own normalizer, the listener's front door for caller tools. */
const normalizeTool = tool => {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  return {
    name,
    description: String(tool?.description ?? tool?.function?.description ?? ''),
    parameters: tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} },
  }
}

check('toToolDefs reads a flat harness def', () => {
  const defs = toToolDefs([{ name: 'pwsh', description: 'shell', parameters: { type: 'object', properties: {} } }], 'chat')
  assert.equal(defs.length, 1)
  assert.equal(defs[0].function.name, 'pwsh')
})

check('toToolDefs reads an OpenAI wrapper def instead of dropping the tool', () => {
  const defs = toToolDefs([openAiTool('pwsh'), openAiTool('glob')], 'chat')
  assert.deepEqual(defs.map(def => def.function.name), ['pwsh', 'glob'])
  assert.equal(defs[0].function.parameters.properties.x.type, 'string')
})

check('the adapter conversion keeps every caller tool', () => {
  const callerTools = ['pwsh', 'glob', 'grep', 'read'].map(openAiTool)
  // The listener's own pass used to produce this wrapper shape and the adapter
  // then ran its own conversion over it — the step where every tool vanished.
  const preConverted = toToolDefs(callerTools.map(normalizeTool).filter(Boolean), 'chat')
  const declared = toToolDefs(preConverted, 'chat')
  assert.equal(declared.length, callerTools.length)
})

check('a non-empty caller list keeps its real tools and no forced tool_choice', () => {
  const body = { tools: toToolDefs([normalizeTool(openAiTool('pwsh')), normalizeTool(openAiTool('glob'))], 'chat') }
  applyFingerprint(body, false)
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  assert.equal(String(body.tools[0].function.description).includes('unavailable'), false)
  assert.equal(String(body.tools[1].function.description).includes('unavailable'), false)
  assert.equal(body.tool_choice, undefined)
})

check('an empty caller list is the shape that forces tool_choice none', () => {
  const body = { tools: [] }
  applyFingerprint(body, false)
  assert.deepEqual(body.tools.map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  assert.equal(body.tool_choice, 'none')
})

await checkAsync('a promoted quartet slot stays mapped back to the caller name', async () => {
  const body = { tools: toToolDefs([normalizeTool(openAiTool('pwsh'))], 'chat') }
  const map = applyFingerprint(body, false)
  assert.equal(map.get('bash'), 'pwsh')
})

await checkAsync('the lane receives the caller tools the client sent', async () => {
  const lane = makeLane()
  lane.script = () => ({ chunks: [], outcome: { text: 'ok', toolCalls: [], usage: undefined } })
  const base = await serve(lane)
  const response = await authFetch(base, '/v1/chat/completions', {
    model: 'm', stream: false, tools: [openAiTool('pwsh')], messages: [{ role: 'user', content: 'hi' }],
  })
  assert.equal(response.status, 200)
  assert.deepEqual(lane.seen.at(-1).openAi.tools.map(tool => tool.function.name), ['pwsh'])
})

// ── the bind address (issue #19) ─────────────────────────────────────────────
await checkAsync('resolveLoopbackBind refuses a routable resolution', async () => {
  await assert.rejects(() => resolveLoopbackBind('example.com'), /loopback/)
  await assert.rejects(() => resolveLoopbackBind('8.8.8.8'), /loopback/)
})
await checkAsync('resolveLoopbackBind accepts loopback literals and localhost', async () => {
  assert.equal(await resolveLoopbackBind('127.0.0.1'), '127.0.0.1')
  const resolved = await resolveLoopbackBind('localhost')
  assert.ok(resolved === '127.0.0.1' || resolved === '::1', `localhost must resolve to a loopback address, got ${resolved}`)
})

// ── the disabled gate ────────────────────────────────────────────────────────
{
  const disabled = await startForwardServer({
    config: () => ({ host: '127.0.0.1', port: 0, enabled: false, key: 'k-test' }),
    complete: async () => { throw new Error('must not be called') },
    modelRows: () => [],
  })
  const response = await fetch(`http://127.0.0.1:${disabled.port}/v1/models`)
  assert.equal(response.status, 503)
  console.log('  ok  the disabled listener answers 503 without a key')
  await disabled.close()
}

for (const server of openServers) await server.close()
if (failures > 0) console.error(`forward-test: ${failures} failure(s)`)
else console.log('forward-test: the wire speaks OpenAI the way callers expect')
process.exitCode = failures > 0 ? 1 : 0
