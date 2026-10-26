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
