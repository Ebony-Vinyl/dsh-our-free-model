/**
 * Proves the channels' OpenAI gateway emits a tool call an OpenAI client can
 * actually execute.
 *
 * Two defects, both measured on a real WorkBuddy turn (2026-10-20) routed
 * through the gateway at 127.0.0.1:18326:
 *
 * 1. `function.name` rode **every** argument delta. OpenAI clients concatenate
 *    the name across deltas that share an index, so a two-fragment call arrived
 *    as "ReadRead" and WorkBuddy answered `Tool "ReadReadReadRead…" does not
 *    exist in the current tool set` — after which the model lost every
 *    tool-calling turn it would ever take on that route.
 * 2. `tool_calls[].index` was the adapter's *block* index, shared with text and
 *    reasoning blocks. A turn that thought before calling a tool therefore
 *    started at index 1 or 2, and every index-accumulating client built an
 *    array with holes and dropped the call.
 *
 * The assertions below are written the way a client reads the wire: accumulate
 * by index, concatenate the name, concatenate the arguments — not the way the
 * gateway writes it. They fail on the pre-fix implementation (name becomes
 * "ReadRead", index stays 1).
 *
 * Run: node scripts/gateway-tool-wire-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

const checks = []
const check = (name, got, want) => {
  try {
    assert.deepEqual(got, want)
    checks.push(`ok   ${name}`)
  } catch {
    checks.push(`FAIL ${name}`)
    checks.push(`       got: ${JSON.stringify(got)}`)
    checks.push(`      want: ${JSON.stringify(want)}`)
    process.exitCode = 1
  }
}

const { toOpenAiSse, collectOpenAiCompletion } = await import('../vendor/channel-pack/src/openai-gateway/stream.ts')

/**
 * Read frames the way a client does: one entry per `tool_calls[].index`, with
 * `name` concatenated and `arguments` concatenated across deltas.
 */
function readAsClient(frames) {
  const calls = new Map()
  const text = []
  for (const frame of frames) {
    const payload = frame.trim().replace(/^data:\s*/, '')
    if (payload === '' || payload === '[DONE]') continue
    const event = JSON.parse(payload)
    for (const choice of event.choices ?? []) {
      const delta = choice.delta ?? {}
      if (typeof delta.content === 'string') text.push(delta.content)
      for (const call of delta.tool_calls ?? []) {
        let slot = calls.get(call.index)
        if (slot === undefined) {
          slot = { name: '', arguments: '' }
          calls.set(call.index, slot)
        }
        if (typeof call.function?.name === 'string') slot.name += call.function.name
        if (typeof call.function?.arguments === 'string') slot.arguments += call.function.arguments
      }
    }
  }
  return [...calls.entries()].sort(([a], [b]) => a - b).map(([index, slot]) => ({ index, ...slot }))
}

// ── 1. a thinking turn whose only tool block lands at block index 1 ──────────
// This is the shape buddy-adapter.ts really yields: the reasoning block takes
// index 0, the tool block takes index 1, and each fragment repeats the name.
async function* thinkingTurn() {
  yield { type: 'block-start', index: 0, blockType: 'reasoning' }
  yield { type: 'reasoning-delta', index: 0, text: 'I should read the file.' }
  yield { type: 'block-start', index: 1, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'Read', argumentsDelta: '{"file_path"' }
  yield { type: 'tool-call-delta', index: 1, id: 'call_1', name: 'Read', argumentsDelta: ':"a.txt"}' }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

const streamed = []
for await (const frame of toOpenAiSse(thinkingTurn(), 'chatcmpl-fix', 'test/model')) streamed.push(frame)
check('the tool call is renumbered to 0 even though its block index is 1', readAsClient(streamed).map(call => call.index), [0])
check('the name reaches the client once, not once per fragment', readAsClient(streamed).map(call => call.name), ['Read'])
check('the arguments still stream to completion', readAsClient(streamed).map(call => call.arguments), ['{"file_path":"a.txt"}'])

// ── 2. two calls keep arrival order, not block order gaps ────────────────────
async function* twoCalls() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: 'Looking at both.' }
  yield { type: 'tool-call-delta', index: 1, id: 'call_a', name: 'Read', argumentsDelta: '{"p":1}' }
  yield { type: 'tool-call-delta', index: 3, id: 'call_b', name: 'Grep', argumentsDelta: '{"q":"x"}' }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}
const two = []
for await (const frame of toOpenAiSse(twoCalls(), 'chatcmpl-two', 'test/model')) two.push(frame)
check('two calls occupy indices 0 and 1 with no holes', readAsClient(two).map(call => call.index), [0, 1])
check('each name is emitted exactly once', readAsClient(two).map(call => call.name), ['Read', 'Grep'])

// ── 3. the non-streaming body agrees with the stream ────────────────────────
const collected = await collectOpenAiCompletion(thinkingTurn(), 'chatcmpl-json', 'test/model')
const body = collected.choices[0].message
check('non-streaming reports the same single call', [body.tool_calls.length, body.tool_calls[0].function.name], [1, 'Read'])
check('non-streaming arguments match the stream', body.tool_calls[0].function.arguments, '{"file_path":"a.txt"}')
check('reasoning still arrives in both paths', body.reasoning_content, 'I should read the file.')

for (const line of checks) console.log(line)
console.log(process.exitCode === 1 ? '\ngateway-tool-wire-test: FAILED' : '\ngateway-tool-wire-test: ok')
