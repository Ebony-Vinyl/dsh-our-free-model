/**
 * The thinking-mode replay: a tool turn has to travel back with its thinking.
 *
 * Issue #508 is that the free lane's Chat projection drops a turn's thinking on
 * the way upstream, and DeepSeek's thinking mode refuses the next tool turn for
 * exactly that: "The `reasoning_content` in the thinking mode must be passed
 * back to the API". The free lane always ships tools (the fingerprint gate
 * injects `read` and `shell`), so every follow-up of such a turn is a 400 —
 * and it is a 400 that lands on a *pool* upstream, so the same history shape
 * both works and fails.
 *
 * Two facts shape the fix, and both are easy to get wrong:
 *
 *   - The field has to be there and it has to be non-empty. An empty string
 *     reads as "not passed back" and is refused the same way; a single space
 *     is the placeholder the upstream accepts (`vendor/channel-pack/src/
 *     openai-gateway/messages.ts` keeps it for that reason).
 *   - The forwarding contract is a different one. #484 settled that a
 *     caller's own `reasoning_content` is relayed verbatim and that a missing
 *     field is not invented — so the replay is opt-in, the default projector
 *     stays byte-identical, and the forward listener is left alone.
 *
 * Run: node scripts/reasoning-replay-test.mjs
 */
import { chatFrames, stubUpstream } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/**
 * The gateway stand-in goes up before the plugin modules are imported, because
 * `src/upstream.js` reads `OUR_FREE_MODEL_BASE` once, at import time.
 */
const stub = await stubUpstream({ listing: ['deepseek-v4.1-flash-free', 'mimo-v2.6-flash-free'], answer: () => ({ body: chatFrames('done') }) })
process.env.OUR_FREE_MODEL_BASE = stub.base
const { toChatMessages } = await import('../src/messages.js')
const { replaysReasoning } = await import('../src/upstream.js')
const { buildCatalog } = await import('../src/catalog.js')
const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')

const MODEL = 'deepseek-v4.1-flash-free'
const OTHER = 'mimo-v2.6-flash-free'

/** One assistant turn that called a tool, in the harness's own shape. */
const toolTurn = (thinking, model = MODEL) => ({
  role: 'assistant',
  source: { kind: 'model', provider: ROUTE_MAIN, model },
  content: [
    ...(thinking === undefined ? [] : [{ type: 'reasoning', text: thinking }]),
    { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{"path":"owned.txt"}' },
  ],
})

/** The tool's answer, so the call is not dropped as unanswered. */
const toolResult = [{ role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] }]

const SCOPE = { reasoningReplay: true, model: MODEL }

console.log('=== 1. the default projector stays byte-identical ===')
{
  const history = [toolTurn('the file is at owned.txt'), ...toolResult]
  const projected = toChatMessages(history)
  check('no reasoning is invented for a tool turn', projected[0].reasoning_content, undefined)
  check('the field is not even present', Object.keys(projected[0]), ['role', 'content', 'tool_calls'])
  check('the thinking never leaks as Chat text', projected[0].content, null)
  check('a caller’s own value is still relayed verbatim',
    toChatMessages([{ role: 'assistant', content: 'hi', reasoning_content: '' }])[0].reasoning_content, '')
}

console.log('\n=== 2. the scoped projector replays the turn’s thinking ===')
{
  const projected = toChatMessages([toolTurn('the file is at owned.txt'), ...toolResult], undefined, undefined, SCOPE)
  check('the turn keeps the thinking it was answered with', projected[0].reasoning_content, 'the file is at owned.txt')
  check('the key order is role, content, reasoning_content, tool_calls', Object.keys(projected[0]), ['role', 'content', 'reasoning_content', 'tool_calls'])
  check('the thinking still never becomes Chat text', projected[0].content, null)
}
{
  // The upstream reads an empty string as "not passed back", so a turn whose
  // thinking the harness kept none of travels as the placeholder it accepts.
  const projected = toChatMessages([toolTurn(undefined), ...toolResult], undefined, undefined, SCOPE)
  check('a turn without thinking travels as the placeholder', projected[0].reasoning_content, ' ')
  check('and never as an empty string', projected[0].reasoning_content === '', false)
}
{
  const projected = toChatMessages([{ role: 'assistant', source: { kind: 'model', provider: ROUTE_MAIN, model: MODEL }, content: [{ type: 'reasoning', text: 'thinking' }, { type: 'text', text: 'done' }] }], undefined, undefined, SCOPE)
  check('a turn that called no tool keeps no field', projected[0].reasoning_content, undefined)
}
{
  const projected = toChatMessages([{ role: 'assistant', content: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }], reasoning_content: 'caller’s own' }], undefined, undefined, SCOPE)
  check('an explicit value wins over the replay', projected[0].reasoning_content, 'caller’s own')
}

console.log('\n=== 3. which models replay ===')
{
  check('the measured id replays', replaysReasoning(MODEL), true)
  check('a level suffix is the same model', replaysReasoning(`${MODEL} (high)`), true)
  check('another free model does not', replaysReasoning(OTHER), false)
  check('a responses-wire model does not', replaysReasoning('muse-spark-1.3-contributor-free'), false)
  check('the EAC id is not the free lane’s', replaysReasoning('deepseek-ai/deepseek-v4.1-flash'), false)
  check('nor is the EAC lane’s own id', replaysReasoning('opencode/deepseek-v4.1-flash-free'), false)
  check('nor is another provider’s model', replaysReasoning('workbuddy/deepseek-v4.1-flash'), false)
}

console.log('\n=== 4. the body that goes on the wire ===')
{
  const catalog = buildCatalog([MODEL, OTHER])
  const entry = catalog.find(row => row.id === MODEL)
  const other = catalog.find(row => row.id === OTHER)
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog, membership: { [ROUTE_MAIN]: catalog.map(row => row.id) }, settings: { enabled: true, defaultMaxTokens: 32768 }, attributionUserAgent: 'test/1.0' }),
    recordUsage: () => {},
    warn: () => {},
  })
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'read a file' }] },
    toolTurn('the file is at owned.txt'),
    ...toolResult,
    { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
  ]

  /** The body the adapter sent last. */
  const lastBody = () => stub.requests[stub.requests.length - 1].body
  const assistantRow = body => body.messages.find(row => row.role === 'assistant')

  // The harness's own session: the plugin is the upstream's client here, so
  // the upstream's replay contract binds us.
  const call = await adapter.prepareCall(ROUTE_MAIN, MODEL)
  for await (const chunk of call.stream({ provider: ROUTE_MAIN, model: MODEL, messages: history })) void chunk
  check('the harness’s own session replays the thinking', assistantRow(lastBody()).reasoning_content, 'the file is at owned.txt')
  check('the request still carries the tool call', assistantRow(lastBody()).tool_calls[0].function.name, 'read')

  // A model the upstream does not hold to the thinking contract keeps its body.
  const otherCall = await adapter.prepareCall(ROUTE_MAIN, OTHER)
  for await (const chunk of otherCall.stream({ provider: ROUTE_MAIN, model: OTHER, messages: history })) void chunk
  check('a model that does not replay keeps its body', assistantRow(lastBody()).reasoning_content, undefined)

  // The forward listener replays a caller's conversation: #484's contract is
  // "relay the caller's own values, invent nothing", so nothing is added there.
  for await (const chunk of adapter.stream({ provider: ROUTE_MAIN, model: MODEL, messages: history })) void chunk
  check('the forward path invents nothing', assistantRow(lastBody()).reasoning_content, undefined)

  check('the entry the catalog served is the one that was called', entry.id, MODEL)
  check('and the other model is a different one', other.id, OTHER)
}

console.log(failures === 0 ? '\nall reasoning-replay checks passed' : `\n${failures} reasoning-replay check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
