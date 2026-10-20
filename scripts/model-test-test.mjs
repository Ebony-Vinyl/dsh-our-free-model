/** Text tests reject empty/incomplete responses and measure elapsed decode time. */
import assert from 'node:assert/strict'
import { measureModelTest } from '../src/model-test.js'

const text = value => ({ type: 'text-delta', text: value })
const stop = { type: 'finish', reason: { kind: 'stop' } }
async function* stream(chunks) { yield* chunks }
for (const chunks of [
  [], [stop], [text('  '), stop],
  [{ type: 'reasoning-delta', text: 'thinking' }, stop],
  [text('OK')],
  [text('OK'), { type: 'finish', reason: { kind: 'length' } }],
  [{ type: 'tool-call-delta', name: 'bash' }, stop],
]) await assert.rejects(measureModelTest(stream(chunks)))
const failure = new Error('transport ended')
await assert.rejects(measureModelTest((async function* () { yield text('OK'); throw failure })()), e => e === failure)
const times = [1_790_000_000_000, 1_790_000_000_300, 1_790_000_002_300]
const result = await measureModelTest(stream([
  text('OK'), stop, { type: 'usage', usage: { outputTokens: 100 } },
]), () => times.shift())
assert.equal(result.sample, 'OK')
assert.equal(result.totalMs, 2300)
assert.equal(result.ttftMs, 300)
assert.equal(result.tokensPerSecond, 50)
console.log('model-test: 8 failure cases and complete-response timing passed')
