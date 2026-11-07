import assert from 'node:assert/strict'
import { createMagpieModels, combineSubscriptionRuntimes } from '../src/magpie-models.js'
import { subscriptionCatalog } from '../src/subscription-adapter.js'

let state = 'ready'
let changes = 0
let completionStatus = 403
const secret = 'fixture-private-engine-key'
const model = 'subscription:magpie/vendor/vision-model'
const calls = []
const engine = {
  status: () => ({ state }),
  gateway: () => ({ url: 'http://127.0.0.1:1', key: secret }),
}
const bridge = createMagpieModels({
  engine, onChanged: () => { changes++ },
  fetchImpl: async (url, options) => {
    calls.push({ url, options })
    assert.equal(options.headers.authorization, `Bearer ${secret}`)
    if (url.endsWith('/v1/models')) return Response.json({ data: [{
      id: 'vendor/vision-model', display_name: 'Vision model', context_window: 200000,
      max_output_tokens: 32000, modalities: { input: ['text', 'image'] },
      reasoning: true, reasoning_levels: ['low', 'high', 'high', '<invalid>'],
    }] })
    return new Response(`Do not expose this provider response: ${secret}`, { status: completionStatus })
  },
})
try {
  await Promise.all([bridge.refresh(), bridge.refresh()])
  assert.equal(calls.length, 1, 'simultaneous catalog refreshes must coalesce')
  assert.equal(changes, 1)
  const catalog = subscriptionCatalog(bridge)
  assert.equal(catalog[0].id, model)
  assert.equal(catalog[0].name, 'Vision model')
  assert.equal(catalog[0].vision, true)
  assert.equal(catalog[0].contextWindow, 200000)
  assert.equal(catalog[0].maxOutput, 32000)
  assert.deepEqual(catalog[0].efforts, ['low', 'high'])
  assert.ok(!JSON.stringify(catalog).includes(secret))
  let fallbackCalls = 0
  const combined = combineSubscriptionRuntimes(bridge, {
    handles: () => true, catalog: () => [], complete: () => { fallbackCalls++ },
  })
  for (const status of [401, 403]) {
    completionStatus = status
    await assert.rejects(combined.complete({
      model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    }), error => {
      assert.equal(error.code, 'PROVIDER_ERROR')
      assert.match(error.message, /connection and network status/)
      assert.ok(!/re-import|credentials|fixture-private-engine-key/i.test(error.message))
      return true
    })
  }
  assert.equal(fallbackCalls, 0)
  state = 'error'
  await bridge.refresh()
  assert.deepEqual(subscriptionCatalog(bridge), [])
  assert.equal(changes, 2)
  state = 'ready'
  await bridge.refresh()
  assert.equal(subscriptionCatalog(bridge).length, 1)
  console.log('magpie-models: native capabilities survive publication; access refusals never suggest re-importing accounts; stale models disappear')
} finally { bridge.close() }

// ── the enhancement-hook seam: extensions see and rewrite the magpie body ────
{
  const NL = String.fromCharCode(10)
  const sseStream = contentText => new Response([
    `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: { content: contentText }, finish_reason: null }] })}`,
    '',
    `data: ${JSON.stringify({ id: 'x', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
    '',
    'data: [DONE]',
    '',
  ].join(NL), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const seenBodies = []
  const hookRuntime = {
    applyRequestHooks: async (payload, meta) => {
      seenBodies.push({ payload, meta })
      return { ...payload, max_tokens: 1, system: 'extension-was-here' }
    },
  }
  const chatCalls = []
  const hookBridge = createMagpieModels({
    engine: { status: () => ({ state: 'ready' }), gateway: () => ({ url: 'http://127.0.0.1:1', key: 'fixture-key-00000000' }) },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/v1/models')) return Response.json({ data: [{ id: 'vendor/echo' }] })
      chatCalls.push(JSON.parse(options.body))
      return sseStream('ok')
    },
    extensionRuntime: hookRuntime,
  })
  try {
    await hookBridge.refresh()
    const chunks = []
    await hookBridge.complete({
      model: 'subscription:magpie/vendor/echo',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    }, chunk => chunks.push(chunk))
    assert.equal(chatCalls.length, 1)
    assert.equal(chatCalls[0].max_tokens, 1, 'the extension rewrite reaches the wire')
    assert.equal(chatCalls[0].system, 'extension-was-here')
    assert.equal(seenBodies[0].meta.lane, 'magpie')
    assert.equal(seenBodies[0].meta.model, 'vendor/echo')
    assert.equal(seenBodies[0].meta.wire, 'chat')
    assert.ok(JSON.stringify(chunks).includes('ok'), 'the turn still streams')
    console.log('magpie-models: enhancement extensions rewrite the magpie body fail-open with lane meta')
  } finally { hookBridge.close() }

  // A hook source that is not mounted yet (boot ordering) ships the payload unchanged.
  const lazyBridge = createMagpieModels({
    engine: { status: () => ({ state: 'ready' }), gateway: () => ({ url: 'http://127.0.0.1:1', key: 'fixture-key-00000000' }) },
    fetchImpl: async url => url.endsWith('/v1/models')
      ? Response.json({ data: [{ id: 'vendor/lazy' }] })
      : sseStream('raw'),
    extensionRuntime: () => null,
  })
  try {
    await lazyBridge.refresh()
    const chunks = []
    await lazyBridge.complete({
      model: 'subscription:magpie/vendor/lazy',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
    }, chunk => chunks.push(chunk))
    assert.ok(JSON.stringify(chunks).includes('raw'), 'the turn still streams')
    console.log('magpie-models: an unmounted extension source ships the payload unchanged')
  } finally { lazyBridge.close() }
}
