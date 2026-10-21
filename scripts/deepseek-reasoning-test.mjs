/**
 * Does a DeepSeek thinking-mode turn survive its own history?
 *
 * Reported against the free lane: a second turn on `deepseek-v4.1-flash-free`
 * failed with
 *
 *   Upstream request failed: [invalid_request_error]
 *   The `reasoning_content` in the thinking mode must be passed back to the API.
 *
 * DeepSeek's contract (https://api-docs.deepseek.com/guides/thinking_mode/)
 * makes `reasoning_content` mandatory on the assistant turns of every request
 * that carries `tools` — including turns that called no tool at all. This lane
 * cannot avoid carrying tools: the v2 fingerprint gate injects `read` and
 * `shell` unconditionally, so the condition never lifts.
 *
 * `toChatMessages` used to drop reasoning by design (see its docstring), so the
 * field was always absent and the upstream refused the turn. The absorbed
 * channel pack had already solved the same wall in `serializeMessages`
 * (`vendor/channel-pack/pack.js`); this suite pins the free lane to the same
 * rule — emit the field *unconditionally, as an empty string when there was no
 * reasoning*, because the check is on the field's presence.
 *
 * Scope is the other half of the contract: a non-DeepSeek gateway must keep
 * receiving exactly the body it received before this change.
 *
 * Run: node scripts/deepseek-reasoning-test.mjs
 */

import { toChatMessages } from '../src/messages.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const DEEPSEEK = 'deepseek-v4.1-flash-free'
const OTHER = 'glm-5.3-flash-free'

/**
 * The shape of the turn that failed, taken from the durable session
 * (`session-b741277e`): assistant turns that reasoned and then called a tool,
 * each answered by its own `role:'tool'` row.
 */
const turnWithToolCall = (reasoningText) => [
  { role: 'user', content: [{ type: 'text', text: 'list the files' }] },
  {
    role: 'assistant',
    content: [
      ...reasoningText === '' ? [] : [{ type: 'reasoning', text: reasoningText }],
      { type: 'tool-call', id: 'call_00', name: 'pwsh', arguments: '{"command":"ls"}' },
    ],
  },
  { role: 'tool', toolCallId: 'call_00', content: [{ type: 'text', text: 'a.txt' }] },
]

// ── The fix itself ─────────────────────────────────────────────────────────
console.log('\n# DeepSeek: the field must be there, carrying the reasoning')

check('a reasoning turn echoes its reasoning_content',
  toChatMessages(turnWithToolCall('look at the listing first'), undefined, [], { model: DEEPSEEK })
    .find(message => message.role === 'assistant'),
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_00', type: 'function', function: { name: 'pwsh', arguments: '{"command":"ls"}' } }], reasoning_content: 'look at the listing first' })

check('a turn with no reasoning still carries the field, empty',
  toChatMessages([
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'user', content: [{ type: 'text', text: 'again' }] },
  ], undefined, [], { model: DEEPSEEK }).find(message => message.role === 'assistant'),
  { role: 'assistant', content: 'hello', reasoning_content: '' })

check('several reasoning blocks are concatenated into one string',
  toChatMessages([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'first. ' }, { type: 'reasoning', text: 'second.' }, { type: 'text', text: 'done' }] },
  ], undefined, [], { model: DEEPSEEK }).find(message => message.role === 'assistant')?.reasoning_content,
  'first. second.')

check('visible text and tool calls survive next to the reasoning',
  toChatMessages([...turnWithToolCall('t'), {
    role: 'assistant', content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'answer' }, { type: 'tool-call', id: 'c2', name: 'read', arguments: '{}' }],
  }], undefined, [], { model: DEEPSEEK }).filter(message => message.role === 'assistant').map(message => ({
    content: message.content, toolCalls: message.tool_calls?.length ?? 0, reasoning: message.reasoning_content,
  })),
  [
    { content: null, toolCalls: 1, reasoning: 't' },
    { content: 'answer', toolCalls: 1, reasoning: 'r' },
  ])

console.log('\n# DeepSeek ids are recognised by family, not by exact spelling')

for (const id of ['deepseek-v4.1-flash-free', 'deepseek-v4-flash-free', 'DeepSeek-V4.1-Flash', 'deepseek-v4.1-flash-free(high)']) {
  check(`  ${id} is treated as DeepSeek`,
    Object.hasOwn(toChatMessages(turnWithToolCall('r'), undefined, [], { model: id }).find(message => message.role === 'assistant') ?? {}, 'reasoning_content'),
    true)
}

console.log('\n# Every other lane keeps the body it always had')

check('a non-DeepSeek model gets no reasoning_content',
  toChatMessages(turnWithToolCall('r'), undefined, [], { model: OTHER }).find(message => message.role === 'assistant'),
  { role: 'assistant', content: null, tool_calls: [{ id: 'call_00', type: 'function', function: { name: 'pwsh', arguments: '{"command":"ls"}' } }] })

check('a caller that passes no model (the old signature) gets no reasoning_content',
  Object.hasOwn(toChatMessages(turnWithToolCall('r'), undefined, []).find(message => message.role === 'assistant') ?? {}, 'reasoning_content'),
  false)

check('the source history is not mutated',
  (() => {
    const history = turnWithToolCall('r')
    const before = JSON.stringify(history)
    toChatMessages(history, undefined, [], { model: DEEPSEEK })
    return JSON.stringify(history) === before
  })(),
  true)

console.log('')
if (failures > 0) {
  console.log(`${failures} check(s) failed`)
  process.exit(1)
}
console.log('all deepseek reasoning checks passed')
