/**
 * One logical turn per turn, whichever lane served it.
 *
 * A combo chain records one logical turn for the whole chain and one physical
 * call per member. A subscription member records its own physical usage, so
 * letting it also record the logical turn counted a chain turn twice — the
 * stats panel then showed more turns than the user ever made. This pins the
 * split: physical usage belongs to the serving model, the logical turn belongs
 * to whoever owns the turn.
 *
 * Also covers the disclaimer copy, which both surfaces read: one source, a
 * stable version, and an acknowledgement that is a settings write rather than
 * a gate on inference.
 */
import assert from 'node:assert/strict'
import { FreeModelAdapter, ROUTE_MAIN } from '../src/adapter.js'
import { createSubscriptionRuntime } from '../src/subscription-completion.js'
import { DISCLAIMER, DISCLAIMER_VERSION, EXCLUDED_CHANNELS, disclaimerAcknowledged } from '../src/disclaimer.js'
import { recordTurn } from '../src/store.js'

let checks = 0
const check = async (name, run) => { await run(); checks++; console.log(`ok ${name}`) }

/** A subscription account whose completion emits text and a finish. */
function fixture({ onComplete } = {}) {
  const model = 'subscription:acct/m'
  const combo = 'combo:mix'
  const catalog = [
    { id: model, channel: 'subscription', subscriptionId: 'acct', maxOutput: 4096, contextWindow: 128000, wire: 'chat' },
    { id: combo, name: 'mix', channel: 'combo', combo: [model], strategy: 'fallback', maxOutput: 4096, contextWindow: 128000 },
  ]
  const runtime = {
    catalog: () => catalog.filter(row => row.channel === 'subscription'),
    complete: async (request, emit) => {
      onComplete?.(request)
      emit({ type: 'text-delta', text: 'hello' })
      emit({ type: 'finish', reason: { kind: 'end' } })
      return { text: 'hello' }
    },
  }
  return { model, combo, catalog, runtime }
}

/** Drive one adapter turn and return every chunk it produced. */
async function drive(adapter, model) {
  const controller = new AbortController()
  const chunks = []
  try {
    const stream = adapter.stream({
      provider: ROUTE_MAIN, model, maxTokens: 1024, sessionId: 'turn-accounting',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], signal: controller.signal,
    })
    for await (const chunk of stream) chunks.push(chunk)
  } finally { controller.abort() }
  return chunks
}

await check('a combo turn through a subscription member records one logical turn', async () => {
  const turns = []
  const { combo, catalog, runtime } = fixture()
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog, membership: { [ROUTE_MAIN]: [combo] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false }, attributionUserAgent: 'test' }),
    subscriptionRuntime: runtime,
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  const chunks = await drive(adapter, combo)
  assert.equal(chunks.at(-1)?.type, 'finish', JSON.stringify(chunks))
  assert.equal(chunks.at(-1).reason.kind, 'end', 'the turn succeeds')
  assert.equal(turns.length, 1, `one logical turn, got ${JSON.stringify(turns)}`)
  assert.equal(turns[0].model, combo, 'the turn belongs to the chain')
})

await check('a direct subscription turn leaves the logical turn to its runtime', async () => {
  // The helper owns the turn for a direct call (it is the one that knows the
  // account and the physical call), so the adapter must not add a second one.
  const turns = []
  let seen
  const { model, catalog, runtime } = fixture({ onComplete: request => { seen = request.recordTurn } })
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog, membership: { [ROUTE_MAIN]: [model] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false }, attributionUserAgent: 'test' }),
    subscriptionRuntime: runtime,
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  await drive(adapter, model)
  assert.equal(seen, true, 'the runtime is allowed to record the turn')
  assert.equal(turns.length, 0, `the adapter must not record it a second time, got ${JSON.stringify(turns)}`)
})

await check('the combo member is told not to record the turn itself', async () => {
  let seen
  const { combo, catalog, runtime } = fixture({ onComplete: request => { seen = request.recordTurn } })
  const adapter = new FreeModelAdapter({
    state: () => ({ catalog, membership: { [ROUTE_MAIN]: [combo] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false }, attributionUserAgent: 'test' }),
    subscriptionRuntime: runtime,
    recordUsage: () => {}, recordTurn: () => {}, warn: () => {},
  })
  await drive(adapter, combo)
  assert.equal(seen, false, 'a chain member must not count the chain turn again')
})

await check('the subscription runtime honours recordTurn:false but keeps physical usage', async () => {
  // The real helper, not a stand-in: physical usage must still be recorded.
  let turns = 0, usages = 0
  const stats = { recordUsage: () => { usages++ }, recordTurn: () => { turns++ } }
  const subscriptions = {
    list: () => [{ id: 'acct', provider: 'api', enabled: true, format: 'openai-chat', models: ['m'], quota: {} }],
    resolve: async () => ({ id: 'acct', provider: 'api', model: 'm', wire: 'chat',
      endpoint: 'http://127.0.0.1:1/v1/chat/completions', headers: {}, format: 'openai-chat' }),
  }
  const runtime = createSubscriptionRuntime({
    subscriptions, stats, logger: {},
    // A minimal SSE body: one content delta and a stop, enough to finish.
    fetchImpl: async () => ({
      ok: true,
      body: (async function* () {
        yield Buffer.from('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n')
        yield Buffer.from('data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
        yield Buffer.from('data: [DONE]\n\n')
      })(),
    }),
  })
  await runtime.complete({ model: 'subscription:acct/m', recordTurn: false, messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(usages, 1, 'physical usage is always recorded')
  assert.equal(turns, 0, 'the caller owns the logical turn')
  await runtime.complete({ model: 'subscription:acct/m', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(turns, 1, 'a direct caller still gets its turn recorded')
})

await check('recordTurn accumulates one row per call', () => {
  let state = { version: 1, days: {}, models: {}, logical: { turns: 0, failed: 0, recovered: 0, models: {} } }
  const stats = { get: () => state, edit: transform => { state = transform(state); return state } }
  recordTurn(stats, { at: Date.now(), model: 'combo:mix', ok: true })
  recordTurn(stats, { at: Date.now(), model: 'combo:mix', ok: true })
  assert.equal(state.logical.turns, 2)
  assert.equal(state.logical.models['combo:mix'].turns, 2)
})

await check('the disclaimer names both excluded channels and stays versioned', () => {
  assert.equal(DISCLAIMER.version, DISCLAIMER_VERSION)
  assert.ok(EXCLUDED_CHANNELS.some(name => /WorkBuddy/i.test(name)), 'WorkBuddy is named')
  assert.ok(EXCLUDED_CHANNELS.some(name => /Huawei/i.test(name)), 'Huawei Cloud is named')
  const copy = JSON.stringify(DISCLAIMER)
  assert.match(copy, /个人学习/, 'the project describes itself as personal study')
  assert.match(copy, /与我们无关|与本项目作者及团队无关/, 'it states the team is not responsible')
  assert.ok(DISCLAIMER.sections.length >= 3, 'it covers exclusion, responsibility and warranty')
  assert.ok(DISCLAIMER.accept.length > 0 && DISCLAIMER.reopen.length > 0)
})

await check('acknowledgement is a version compare, not a gate', () => {
  assert.equal(disclaimerAcknowledged({}), false)
  assert.equal(disclaimerAcknowledged({ disclaimerAck: DISCLAIMER_VERSION }), true)
  assert.equal(disclaimerAcknowledged({ disclaimerAck: DISCLAIMER_VERSION - 1 }), false)
  assert.equal(disclaimerAcknowledged({ disclaimerAck: 'garbage' }), false)
})

console.log(`turn-accounting: ${checks} checks passed`)
