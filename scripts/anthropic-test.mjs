/**
 * Tests for the Anthropic Messages codec (`src/anthropic.js`).
 *
 * The codec is pure — parsed bodies in, harness messages or complete SSE frame
 * strings out — so every check here runs without a socket. What it pins:
 *
 * - the request translation: string and block-list `system`, text / base64
 *   image / url image / tool_use / tool_result / thinking blocks, flat tool
 *   defs from `input_schema`, and the `thinking` budget -> effort mapping
 *   against the ids `src/effort.js` actually resolves;
 * - the streaming lifecycle: a realistic thinking -> text -> tool_use turn
 *   yields message_start, sequential content blocks and a tool_use stop reason,
 *   with no delta outside an open block and no block left unstopped;
 * - the stop_reason table (stop / max-tokens / tool-call / error / aborted),
 *   including the two endings that have no Anthropic stop_reason at all;
 * - the non-streaming fold and message shape, including unparseable tool
 *   arguments;
 * - countTokens' estimate: monotonic in text, non-zero for an empty body, and
 *   charged extra for images and tools;
 * - a round trip through the real `toClaudeMessages` from `src/messages.js`,
 *   which is the projector the adapter will feed: no `undefined` values, a
 *   valid `max_tokens`, and tool pairing that survives the trip.
 *
 * Run: node scripts/anthropic-test.mjs
 */
import assert from 'node:assert/strict'
import { fromAnthropicRequest, anthropicFrames, anthropicMessage, foldAnthropicOutcome, countTokens } from '../src/anthropic.js'
import { toClaudeMessages } from '../src/messages.js'
import { LEVELS, resolveLevel } from '../src/effort.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** Parse rendered frames, asserting each one is a complete SSE frame whose
 *  `event:` name agrees with the `type` inside its JSON payload. */
function parseFrames(frames) {
  return frames.map(raw => {
    assert.ok(raw.endsWith('\n\n'), `a frame must end with a blank line: ${JSON.stringify(raw.slice(0, 60))}`)
    const [eventLine, dataLine] = raw.split('\n')
    assert.ok(eventLine?.startsWith('event: '), `a frame must open with an event line: ${JSON.stringify(raw.slice(0, 60))}`)
    assert.ok(dataLine?.startsWith('data: '), `a frame must carry a data line: ${JSON.stringify(raw.slice(0, 60))}`)
    const payload = JSON.parse(dataLine.slice('data: '.length))
    const event = eventLine.slice('event: '.length)
    assert.equal(payload.type, event, 'the event name and the payload type must agree')
    return { event, payload }
  })
}

const makeState = (over = {}) => ({
  messageId: 'msg_test', model: 'union-alpha', started: false, blockIndex: 0,
  openBlock: null, toolSlots: new Map(), inputTokens: 0, outputTokens: 0, stopReason: null,
  ...over,
})

const userRequest = body => fromAnthropicRequest({ model: 'union-alpha', messages: [{ role: 'user', content: 'hi' }], ...body })

// ── fromAnthropicRequest ─────────────────────────────────────────────────────
check('system flattens from a string and from text blocks', () => {
  assert.equal(userRequest({ system: 'be terse' }).system, 'be terse')
  assert.equal(userRequest({ system: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] }).system, 'one\n\ntwo')
  assert.equal(userRequest({}).system, '')
})

check('text, base64 image, url image and tool_use blocks convert to the harness shape', () => {
  const request = fromAnthropicRequest({
    model: 'union-alpha',
    system: 'sys',
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'url', url: 'https://example.test/cat.png' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { file: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'file body' }] }] },
    ],
  })
  assert.deepEqual(request.messages[0], {
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', attachment: { attachmentId: 'data:image/png;base64,AAAA', mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: 'data:image/png;base64,AAAA' } },
      { type: 'image', attachment: { attachmentId: 'url:https://example.test/cat.png', mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: 'https://example.test/cat.png' } },
    ],
  })
  assert.deepEqual(request.messages[1], {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'hmm' },
      { type: 'text', text: 'calling' },
      { type: 'tool-call', id: 'toolu_1', name: 'read', arguments: '{"file":"x"}' },
    ],
  })
  assert.deepEqual(request.messages[2], {
    role: 'tool',
    content: [{ type: 'text', text: 'file body' }],
    toolCallId: 'toolu_1',
    source: { kind: 'tool', callId: 'toolu_1' },
  })
})

check('a string tool_result body and is_error survive; an empty body is empty', () => {
  const request = fromAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Error: nope', is_error: true }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '' }] },
    ],
  })
  assert.deepEqual(request.messages[1], {
    role: 'tool',
    content: [{ type: 'text', text: 'Error: nope' }],
    toolCallId: 't1',
    source: { kind: 'tool', callId: 't1' },
    isError: true,
  })
  assert.deepEqual(request.messages[3].content, [], 'an empty tool answer carries no text block')
  assert.equal(request.messages[3].isError, undefined, 'false is omitted, never written as undefined')
})

check('thinking is kept as reasoning history; redacted_thinking is dropped', () => {
  const request = fromAnthropicRequest({
    model: 'm',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'redacted_thinking', data: 'opaque-ciphertext' },
        { type: 'thinking', thinking: 'kept' },
        { type: 'text', text: 'answer' },
      ],
    }],
  })
  assert.deepEqual(request.messages[0].content, [{ type: 'reasoning', text: 'kept' }, { type: 'text', text: 'answer' }])
})

check('Anthropic tools flatten onto {name, description, parameters}', () => {
  const request = userRequest({
    tools: [
      { name: 'read', description: 'read a file', input_schema: { type: 'object', properties: { file: { type: 'string' } } } },
      { name: 'bare' },
      { description: 'nameless tools are dropped' },
      { name: '  ' },
    ],
  })
  assert.deepEqual(request.tools, [
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: { file: { type: 'string' } } } },
    { name: 'bare', description: '', parameters: { type: 'object', properties: {} } },
  ])
})

check('a body with no model or no messages is refused with an error only', () => {
  assert.deepEqual(fromAnthropicRequest({ messages: [{ role: 'user', content: 'hi' }] }), { error: '`model` is required' })
  assert.deepEqual(fromAnthropicRequest({ model: 'm' }), { error: '`messages` must be a non-empty array' })
  assert.deepEqual(fromAnthropicRequest({ model: 'm', messages: [] }), { error: '`messages` must be a non-empty array' })
  assert.deepEqual(fromAnthropicRequest(null), { error: 'the request body must be a JSON object' })
  const refusal = fromAnthropicRequest({ messages: [] })
  assert.deepEqual(Object.keys(refusal), ['error'], 'a refusal carries nothing else')
})

check('max_tokens, temperature, stream and the model pass through', () => {
  const request = userRequest({ max_tokens: 4096, temperature: 0.2, stream: true })
  assert.equal(request.model, 'union-alpha')
  assert.equal(request.maxTokens, 4096)
  assert.equal(request.temperature, 0.2)
  assert.equal(request.stream, true)
  assert.equal(request.reasoningEffort, undefined)
  // A non-positive or non-numeric ceiling is "unset", never 0.
  assert.equal(userRequest({ max_tokens: 0 }).maxTokens, undefined)
  assert.equal(userRequest({ max_tokens: 'many' }).maxTokens, undefined)
  assert.equal(userRequest({}).stream, false)
})

check('a system role inside messages is hoisted into system', () => {
  const request = fromAnthropicRequest({
    model: 'm',
    system: 'top',
    messages: [{ role: 'system', content: [{ type: 'text', text: 'extra' }] }, { role: 'user', content: 'hi' }],
  })
  assert.equal(request.system, 'top\n\nextra')
  assert.deepEqual(request.messages, [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
})

check('thinking budgets bucket onto the free ladder effort ids', () => {
  const effort = thinking => userRequest({ thinking }).reasoningEffort
  assert.equal(effort({ type: 'enabled', budget_tokens: 1024 }), 'light')
  assert.equal(effort({ type: 'enabled', budget_tokens: 8192 }), 'balanced')
  assert.equal(effort({ type: 'enabled', budget_tokens: 32768 }), 'deep')
  assert.equal(effort({ type: 'enabled', budget_tokens: 4096 }), 'balanced', 'the balanced threshold is inclusive')
  assert.equal(effort({ type: 'enabled', budget_tokens: 16384 }), 'deep', 'the deep threshold is inclusive')
  assert.equal(effort({ type: 'enabled' }), 'light', 'an enabled block with no budget asks for the smallest rung')
  assert.equal(effort({ type: 'disabled' }), 'disabled')
  assert.equal(effort(undefined), undefined)
})

check('the returned effort ids are ones src/effort.js actually resolves', () => {
  const ladder = ['light', 'balanced', 'deep']
  for (const id of ladder) {
    assert.ok(LEVELS.some(level => level.id === id), `"${id}" is not a rung of the free ladder`)
    // A free-lane model (no declared menu) must resolve the id to itself — an
    // id effort.js does not know would silently become `balanced`.
    assert.equal(resolveLevel(id, { reasoning: true }).id, id)
  }
  // `disabled` is the off spelling of a model that declares a level menu.
  assert.equal(resolveLevel('disabled', { reasoning: true, efforts: ['disabled', 'low', 'high'], effortDefault: 'high' }).id, 'disabled')
})

// ── anthropicFrames: the streaming lifecycle ─────────────────────────────────
check('a thinking -> text -> tool_use turn renders the exact frame sequence', () => {
  const state = makeState()
  const chunks = [
    { type: 'reasoning-delta', index: 0, text: 'Let me' },
    { type: 'reasoning-delta', index: 0, text: ' think' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Let me think' } },
    { type: 'text-delta', index: 1, text: 'Answer' },
    { type: 'text-delta', index: 1, text: ' here' },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'Answer here' } },
    { type: 'tool-call-delta', index: 2, id: 'call_a', name: 'read', argumentsDelta: '{"file"' },
    { type: 'tool-call-delta', index: 2, argumentsDelta: ':"x"}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"file":"x"}' } },
    { type: 'usage', usage: { inputTokens: 120, outputTokens: 42, totalTokens: 162 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
  const parsed = parseFrames(chunks.flatMap(chunk => anthropicFrames(chunk, state)))

  assert.deepEqual(parsed.map(frame => frame.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta', 'content_block_delta', 'content_block_stop',
    'message_delta', 'message_stop',
  ])
  assert.equal(parsed[0].event, 'message_start')
  assert.equal(parsed.at(-1).event, 'message_stop')

  // The protocol invariants a Claude client relies on.
  const started = new Set()
  const stopped = new Set()
  for (const { payload } of parsed) {
    if (payload.type === 'content_block_start') {
      assert.ok(!started.has(payload.index), `block ${payload.index} started twice`)
      started.add(payload.index)
    }
    if (payload.type === 'content_block_delta') {
      assert.ok(started.has(payload.index), `delta for block ${payload.index} arrived before its start`)
      assert.ok(!stopped.has(payload.index), `delta for block ${payload.index} arrived after its stop`)
    }
    if (payload.type === 'content_block_stop') {
      assert.ok(started.has(payload.index), `stop for block ${payload.index} arrived before its start`)
      assert.ok(!stopped.has(payload.index), `block ${payload.index} stopped twice`)
      stopped.add(payload.index)
    }
  }
  assert.deepEqual([...started].sort((a, b) => a - b), [0, 1, 2], 'blocks are announced in order')
  assert.deepEqual([...stopped].sort((a, b) => a - b), [0, 1, 2], 'every opened block is stopped')

  // Payload detail, not just the event names.
  assert.deepEqual(parsed[0].payload.message, {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'union-alpha',
    content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 },
  })
  assert.deepEqual(parsed[1].payload.content_block, { type: 'thinking', thinking: '' })
  assert.deepEqual(parsed[2].payload.delta, { type: 'thinking_delta', thinking: 'Let me' })
  assert.deepEqual(parsed[5].payload.content_block, { type: 'text', text: '' })
  assert.deepEqual(parsed[9].payload.content_block, { type: 'tool_use', id: 'call_a', name: 'read', input: {} })
  const partial = parsed.filter(frame => frame.payload.delta?.type === 'input_json_delta')
    .map(frame => frame.payload.delta.partial_json).join('')
  assert.equal(partial, '{"file":"x"}', 'the deltas reassemble the tool arguments')
  assert.deepEqual(parsed.at(-2).payload, {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { input_tokens: 120, output_tokens: 42 },
  })
  assert.equal(state.stopReason, 'tool_use')
  assert.equal(state.outputTokens, 42)
})

check('message_start is emitted once, before a first chunk that is itself a finish', () => {
  const state = makeState()
  const frames = anthropicFrames({ type: 'finish', reason: { kind: 'stop' } }, state)
  assert.deepEqual(parseFrames(frames).map(frame => frame.event), ['message_start', 'message_delta', 'message_stop'])
  assert.deepEqual(anthropicFrames({ type: 'block-start', index: 0, blockType: 'text' }, state), [], 'an ignored chunk adds nothing after the start')
  assert.equal(state.started, true)
})

check('a pre-seeded input count rides message_start', () => {
  const state = makeState({ inputTokens: 321 })
  const parsed = parseFrames(anthropicFrames({ type: 'text-delta', index: 0, text: 'x' }, state))
  assert.equal(parsed[0].payload.message.usage.input_tokens, 321)
})

check('fragments that arrive before the tool name are held, not announced nameless', () => {
  const state = makeState()
  const first = anthropicFrames({ type: 'tool-call-delta', index: 0, id: 'call_x', argumentsDelta: '{"a"' }, state)
  assert.deepEqual(parseFrames(first).map(frame => frame.event), ['message_start'], 'nothing may be announced without a name')
  const second = anthropicFrames({ type: 'tool-call-delta', index: 0, name: 'read', argumentsDelta: ':1}' }, state)
  const parsed = parseFrames(second)
  assert.deepEqual(parsed.map(frame => frame.event), ['content_block_start', 'content_block_delta', 'content_block_delta'])
  assert.deepEqual(parsed[0].payload.content_block, { type: 'tool_use', id: 'call_x', name: 'read', input: {} })
  assert.equal(parsed[1].payload.delta.partial_json, '{"a"', 'the held fragment is spilled first')
  assert.equal(parsed[2].payload.delta.partial_json, ':1}')
  anthropicFrames({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_x', name: 'read', arguments: '{"a":1}' } }, state)
  assert.deepEqual(parseFrames(anthropicFrames({ type: 'finish', reason: { kind: 'tool-calls' } }, state)).map(frame => frame.event), ['message_delta', 'message_stop'])
})

check('a tool call whose name arrives only in block-end is opened and closed, not lost', () => {
  const state = makeState()
  const frames = anthropicFrames({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_b', name: 'grep', arguments: '{"q":"x"}' } }, state)
  const parsed = parseFrames(frames)
  assert.deepEqual(parsed.map(frame => frame.event), ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop'])
  assert.deepEqual(parsed[1].payload.content_block, { type: 'tool_use', id: 'call_b', name: 'grep', input: {} })
  assert.equal(parsed[2].payload.delta.partial_json, '{"q":"x"}')
  assert.equal(parsed[3].payload.index, 0)
})

check('a nameless broken call is not announced as an unusable tool_use', () => {
  const state = makeState()
  const frames = anthropicFrames({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_c', name: '', arguments: '{}' } }, state)
  assert.deepEqual(parseFrames(frames).map(frame => frame.event), ['message_start'])
  assert.equal(state.toolSlots.get(0).block, null)
})

check('parallel tool calls stay open until their own block-end', () => {
  const state = makeState()
  const frames = [
    ...anthropicFrames({ type: 'tool-call-delta', index: 2, id: 'call_a', name: 'read', argumentsDelta: '{"a"' }, state),
    ...anthropicFrames({ type: 'tool-call-delta', index: 3, id: 'call_b', name: 'grep', argumentsDelta: '{"b"' }, state),
    ...anthropicFrames({ type: 'tool-call-delta', index: 2, argumentsDelta: ':1}' }, state),
    ...anthropicFrames({ type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"a":1}' } }, state),
    ...anthropicFrames({ type: 'block-end', index: 3, block: { type: 'tool-call', id: 'call_b', name: 'grep', arguments: '{"b":2}' } }, state),
  ]
  const parsed = parseFrames(frames)
  const starts = parsed.filter(frame => frame.event === 'content_block_start')
  assert.deepEqual(starts.map(frame => frame.payload.index), [0, 1], 'each call gets its own block')
  const secondDelta = parsed.find(frame => frame.event === 'content_block_delta' && frame.payload.index === 0 && frame.payload.delta.partial_json === ':1}')
  assert.ok(secondDelta !== undefined, 'a late fragment continues its own block, not a duplicate of it')
  assert.deepEqual(parsed.filter(frame => frame.event === 'content_block_stop').map(frame => frame.payload.index), [0, 1])
})

check('text after a tool block opens a new text block without splitting the call', () => {
  const state = makeState()
  const frames = [
    ...anthropicFrames({ type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read', argumentsDelta: '{}' }, state),
    ...anthropicFrames({ type: 'text-delta', index: 1, text: 'after' }, state),
    ...anthropicFrames({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' } }, state),
    ...anthropicFrames({ type: 'finish', reason: { kind: 'stop' } }, state),
  ]
  const parsed = parseFrames(frames)
  assert.deepEqual(parsed.map(frame => frame.event), [
    'message_start',
    'content_block_start', 'content_block_delta',
    'content_block_start', 'content_block_delta',
    'content_block_stop', 'content_block_stop',
    'message_delta', 'message_stop',
  ])
  assert.deepEqual(parsed[2].payload, { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })
  assert.deepEqual(parsed[4].payload, { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'after' } })
})

check('a stream cut mid-block still closes what was open', () => {
  const state = makeState()
  const frames = [
    ...anthropicFrames({ type: 'text-delta', index: 0, text: 'partial' }, state),
    ...anthropicFrames({ type: 'tool-call-delta', index: 1, id: 'call_a', name: 'read', argumentsDelta: '{"a"' }, state),
    ...anthropicFrames({ type: 'finish', reason: { kind: 'error', failure: { message: 'stream cut' } } }, state),
  ]
  const parsed = parseFrames(frames)
  assert.deepEqual(parsed.map(frame => frame.event), [
    'message_start',
    'content_block_start', 'content_block_delta', 'content_block_stop',
    'content_block_start', 'content_block_delta',
    'content_block_stop',
    'error', 'message_stop',
  ])
  assert.equal(parsed[2].payload.index, 0, 'the text block closes when the tool block opens')
  assert.equal(parsed[6].payload.index, 1, 'the tool block closes on the cut')
  assert.equal(parsed[7].payload.error.message, 'stream cut')
})

// ── stop_reason mapping ──────────────────────────────────────────────────────
const finishOf = (reason, chunks = []) => {
  const state = makeState()
  const frames = [...chunks, { type: 'finish', reason }].flatMap(chunk => anthropicFrames(chunk, state))
  return { state, parsed: parseFrames(frames) }
}
const stopReasonOf = parsed => parsed.find(frame => frame.event === 'message_delta')?.payload.delta.stop_reason

check('stop -> end_turn, max-tokens -> max_tokens, tool-calls -> tool_use', () => {
  assert.equal(stopReasonOf(finishOf({ kind: 'stop' }).parsed), 'end_turn')
  assert.equal(stopReasonOf(finishOf({ kind: 'max-tokens' }).parsed), 'max_tokens')
  assert.equal(stopReasonOf(finishOf({ kind: 'tool-calls' }).parsed), 'tool_use')
})

check('a streamed tool block forces tool_use even when the finish token said stop', () => {
  const { parsed } = finishOf({ kind: 'stop' }, [
    { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{}' } },
  ])
  assert.equal(stopReasonOf(parsed), 'tool_use')
})

check('max-tokens wins over a tool call the ceiling cut', () => {
  const { parsed } = finishOf({ kind: 'max-tokens' }, [
    { type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read', argumentsDelta: '{"a"' },
  ])
  assert.equal(stopReasonOf(parsed), 'max_tokens')
})

check('error -> an error event and message_stop, with no message_delta', () => {
  const { state, parsed } = finishOf({ kind: 'error', failure: { message: 'upstream 503', code: 'UPSTREAM' } })
  assert.deepEqual(parsed.map(frame => frame.event), ['message_start', 'error', 'message_stop'])
  assert.deepEqual(parsed[1].payload, { type: 'error', error: { type: 'api_error', message: 'upstream 503', code: 'UPSTREAM' } })
  assert.equal(state.stopReason, null)
})

check('aborted -> an error event and message_stop, with no message_delta', () => {
  const { parsed } = finishOf({ kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } })
  assert.deepEqual(parsed.map(frame => frame.event), ['message_start', 'error', 'message_stop'])
  assert.equal(parsed[1].payload.error.message, 'request aborted')
  assert.equal(parsed.some(frame => frame.event === 'message_delta'), false)
})

check('an error with no message falls back to a readable one', () => {
  assert.equal(finishOf({ kind: 'error' }).parsed[1].payload.error.message, 'our free model failed the turn')
  assert.equal(finishOf({ kind: 'aborted' }).parsed[1].payload.error.message, 'request aborted')
})

// ── foldAnthropicOutcome + anthropicMessage ──────────────────────────────────
const foldChunks = chunks => {
  const outcome = { text: '', thinking: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
  for (const chunk of chunks) foldAnthropicOutcome(outcome, chunk)
  return outcome
}

check('foldAnthropicOutcome keeps thinking, merges calls and records usage', () => {
  const outcome = foldChunks([
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'text-delta', index: 1, text: 'answer' },
    { type: 'tool-call-delta', index: 2, id: 'call_a', name: 'read', argumentsDelta: '{"a"' },
    { type: 'tool-call-delta', index: 2, argumentsDelta: ':1}' },
    { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call_a', name: 'read', arguments: '{"a":1}' } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, reasoningTokens: 3 } },
  ])
  assert.equal(outcome.thinking, 'think')
  assert.equal(outcome.text, 'answer')
  assert.deepEqual(outcome.toolCalls, [{ slot: 2, id: 'call_a', name: 'read', arguments: '{"a":1}' }])
  assert.deepEqual(outcome.usage, { input_tokens: 10, output_tokens: 5, total_tokens: 15, reasoning_tokens: 3 })
  assert.equal(outcome.truncated, false)
})

check('foldAnthropicOutcome records a tool call that only ever had a block-end', () => {
  const outcome = foldChunks([
    { type: 'block-end', index: 4, block: { type: 'tool-call', id: 'call_z', name: 'grep', arguments: '{}' } },
  ])
  assert.deepEqual(outcome.toolCalls, [{ slot: 4, id: 'call_z', name: 'grep', arguments: '{}' }])
})

check('foldAnthropicOutcome flags a ceiling cut and a failed turn', () => {
  assert.equal(foldChunks([{ type: 'finish', reason: { kind: 'max-tokens' } }]).truncated, true)
  assert.equal(foldChunks([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }]).error, 'boom')
  assert.equal(foldChunks([{ type: 'finish', reason: { kind: 'aborted', failure: { message: 'gone' } } }]).error, 'gone')
})

check('anthropicMessage renders thinking first, then text, then parsed tool input', () => {
  const outcome = foldChunks([
    { type: 'reasoning-delta', index: 0, text: 'why' },
    { type: 'text-delta', index: 1, text: 'how' },
    { type: 'tool-call-delta', index: 2, id: 'call_a', name: 'read', argumentsDelta: '{"file":"x"}' },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } },
  ])
  const message = anthropicMessage(outcome, { model: 'union-alpha', id: 'msg_1' })
  assert.deepEqual(message, {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'union-alpha',
    content: [
      { type: 'thinking', thinking: 'why' },
      { type: 'text', text: 'how' },
      { type: 'tool_use', id: 'call_a', name: 'read', input: { file: 'x' } },
    ],
    stop_reason: 'tool_use',
    stop_sequence: null,
    usage: { input_tokens: 7, output_tokens: 3 },
  })
})

check('anthropicMessage falls back to {} for unparseable arguments', () => {
  const broken = foldChunks([{ type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read', argumentsDelta: '{"file":' }])
  const message = anthropicMessage(broken, { model: 'm', id: 'msg_2' })
  assert.deepEqual(message.content, [{ type: 'tool_use', id: 'call_a', name: 'read', input: {} }])
  const nonObject = foldChunks([{ type: 'tool-call-delta', index: 0, id: 'call_a', name: 'read', argumentsDelta: '[1,2]' }])
  assert.deepEqual(anthropicMessage(nonObject, { model: 'm', id: 'msg_3' }).content[0].input, {}, 'a JSON array is not an Anthropic input object')
})

check('anthropicMessage stop_reason follows the same table as the stream', () => {
  const plain = anthropicMessage(foldChunks([{ type: 'text-delta', index: 0, text: 'hi' }]), { model: 'm', id: 'msg_4' })
  assert.equal(plain.stop_reason, 'end_turn')
  assert.deepEqual(plain.content, [{ type: 'text', text: 'hi' }])
  const cut = foldChunks([{ type: 'text-delta', index: 0, text: 'partial' }, { type: 'finish', reason: { kind: 'max-tokens' } }])
  assert.equal(anthropicMessage(cut, { model: 'm', id: 'msg_5' }).stop_reason, 'max_tokens')
  // An errored turn still renders a well-formed message; the endpoint is
  // expected to check `error` and answer with an HTTP error instead.
  const failed = foldChunks([{ type: 'finish', reason: { kind: 'error', failure: { message: 'boom' } } }])
  const rendered = anthropicMessage(failed, { model: 'm', id: 'msg_6' })
  assert.equal(rendered.stop_reason, 'end_turn')
  assert.deepEqual(rendered.content, [])
  assert.equal(rendered.usage.output_tokens, 0)
})

check('anthropicMessage reads either usage spelling and never emits NaN', () => {
  const openAiShaped = anthropicMessage({ text: '', toolCalls: [], usage: { prompt_tokens: 11, completion_tokens: 4 } }, { model: 'm', id: 'msg_7' })
  assert.deepEqual(openAiShaped.usage, { input_tokens: 11, output_tokens: 4 })
  const missing = anthropicMessage({ text: 'x' }, { model: 'm', id: 'msg_8' })
  assert.deepEqual(missing.usage, { input_tokens: 0, output_tokens: 0 })
  assert.equal(Number.isNaN(missing.usage.input_tokens), false)
})

// ── countTokens ──────────────────────────────────────────────────────────────
check('countTokens is monotonic in text length', () => {
  const short = countTokens({ messages: [{ role: 'user', content: 'x'.repeat(40) }] }).input_tokens
  const long = countTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] }).input_tokens
  assert.ok(long > short, `expected ${long} > ${short}`)
  const longer = countTokens({ messages: [{ role: 'user', content: 'x'.repeat(4000) }] }).input_tokens
  assert.ok(longer > long)
})

check('countTokens answers a small non-zero number for an empty body', () => {
  for (const body of [{}, null, { messages: [] }, { system: '' }]) {
    const count = countTokens(body).input_tokens
    assert.ok(Number.isInteger(count) && count > 0 && count < 64, `got ${count} for ${JSON.stringify(body)}`)
  }
})

check('countTokens charges for images and tools', () => {
  const text = countTokens({ messages: [{ role: 'user', content: 'hello' }] }).input_tokens
  const withImage = countTokens({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] }).input_tokens
  assert.ok(withImage > text + 500, `an image must add real cost (${withImage} vs ${text})`)
  const withTool = countTokens({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'read', description: 'read a file from disk', input_schema: { type: 'object', properties: { file: { type: 'string' } } } }],
  }).input_tokens
  assert.ok(withTool > text, `a tool must add cost (${withTool} vs ${text})`)
})

check('countTokens counts tool results and assistant tool input as text', () => {
  const base = countTokens({ messages: [{ role: 'user', content: 'q' }] }).input_tokens
  const withResult = countTokens({ messages: [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read', input: { file: 'a'.repeat(200) } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'b'.repeat(200) }] },
  ] }).input_tokens
  assert.ok(withResult > base + 50, `got ${withResult}`)
})

// ── round trip through the real projector ────────────────────────────────────
/** Every path in a value that holds an explicit `undefined` (JSON.stringify
 *  would hide it, and the v4 session log refuses it). */
function undefinedPaths(value, path = '$', out = []) {
  if (value === undefined) out.push(path)
  else if (Array.isArray(value)) value.forEach((item, index) => undefinedPaths(item, `${path}[${index}]`, out))
  else if (value !== null && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) undefinedPaths(inner, `${path}.${key}`, out)
  }
  return out
}

check('a converted request survives toClaudeMessages with no undefined values', () => {
  const request = fromAnthropicRequest({
    model: 'union-alpha',
    system: [{ type: 'text', text: 'be brief' }],
    max_tokens: 4096,
    temperature: 0.2,
    stream: true,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'read x' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        ],
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'tool_use', id: 'toolu_1', name: 'read', input: { file: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'body' }] },
    ],
  })
  assert.equal(request.error, undefined)

  // The endpoint's own shape: system hoisted as a harness row, exactly how the
  // adapter's `buildPayload` hands messages to `toClaudeMessages`.
  const rows = request.system === '' ? [...request.messages] : [{ role: 'system', content: [{ type: 'text', text: request.system }] }, ...request.messages]
  const shaped = toClaudeMessages(rows)
  const body = {
    model: request.model,
    messages: shaped.messages,
    max_tokens: request.maxTokens,
    stream: request.stream,
    ...shaped.system === undefined ? {} : { system: shaped.system },
  }

  assert.deepEqual(undefinedPaths(body), [], 'no explicit undefined may reach the wire')
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0, `max_tokens must be a positive integer, got ${body.max_tokens}`)
  assert.equal(body.system, 'be brief')
  assert.equal(body.stream, true)
  assert.equal(body.temperature, undefined, 'temperature is the caller\'s field on the request, not a projector output')

  const assistant = body.messages.find(row => row.role === 'assistant')
  assert.deepEqual(assistant.content, [{ type: 'tool_use', id: 'toolu_1', name: 'read', input: { file: 'x' } }], 'reasoning history is never replayed upstream')
  const toolTurn = body.messages.find(row => row.role === 'user' && row.content.some(block => block.type === 'tool_result'))
  assert.deepEqual(toolTurn.content, [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'body' }], is_error: false }])
  const userTurn = body.messages.find(row => row.role === 'user' && row.content.some(block => block.type === 'image'))
  assert.deepEqual(userTurn.content[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } })
  assert.deepEqual(JSON.parse(JSON.stringify(body)), body, 'the whole body must survive a JSON round trip')
})

check('a tool_result-only request still pairs its call after projection', () => {
  const request = fromAnthropicRequest({
    model: 'm',
    max_tokens: 1024,
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'grep', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [{ type: 'text', text: 'hit' }] }] },
    ],
  })
  const shaped = toClaudeMessages(request.messages)
  assert.deepEqual(shaped.messages, [
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'grep', input: { q: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [{ type: 'text', text: 'hit' }], is_error: false }] },
  ])
  // The projector always spells the system key, with `undefined` when there is
  // no system text; the endpoint drops it before the wire (see the round trip
  // above), and nothing else may be undefined.
  assert.equal(shaped.system, undefined)
  assert.deepEqual(undefinedPaths(shaped.messages), [])
})

if (failures > 0) console.error(`anthropic-test: ${failures} failure(s)`)
else console.log('anthropic-test: the Messages codec speaks Anthropic the way Claude clients expect')
process.exitCode = failures > 0 ? 1 : 0
