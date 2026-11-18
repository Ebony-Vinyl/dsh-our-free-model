// One explicitly enabled live request; no local tool executes and no retry is sent.
import assert from 'node:assert/strict'
import { applyFingerprint, endpointFor, sessionForConversation, restoreToolName } from '../src/upstream.js'
import { postStreamed } from '../src/http.js'
if (!process.argv.includes('--live')) { console.log('Skipped: --live sends one upstream request.'); process.exit(0) }
const model = 'deepseek-v4.1-flash-free'
const body = {
  model, messages: [{ role: 'user', content: 'Call sum_numbers with a=2 and b=3. Do not answer in text.' }],
  tools: [{ type: 'function', function: {
    name: 'sum_numbers', description: 'Add two numbers.',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'], additionalProperties: false },
  } }],
  tool_choice: { type: 'function', function: { name: 'sum_numbers' } }, stream: true, max_completion_tokens: 256,
}
const map = applyFingerprint(body, false)
let name = '', argumentsText = ''
const response = await postStreamed({
  path: endpointFor(model), body, session: sessionForConversation('independent-core-tool-test'), signal: AbortSignal.timeout(45000),
  onData(data) {
    if (data === '[DONE]') return
    for (const call of JSON.parse(data).choices?.[0]?.delta?.tool_calls ?? []) {
      name += call.function?.name ?? ''
      argumentsText += call.function?.arguments ?? ''
    }
  },
})
assert.equal(response.status, 200)
assert.equal(restoreToolName(name, map), 'sum_numbers')
assert.deepEqual(JSON.parse(argumentsText), { a: 2, b: 3 })
console.log(JSON.stringify({ status: response.status, restored: restoreToolName(name, map), arguments: JSON.parse(argumentsText), executed: false }))
