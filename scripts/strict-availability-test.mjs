/** Strict advertising is opt-in and uses completed free-channel generations. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubUpstream, chatFrames } from './lib/fake-kernel.mjs'

let limited = false
const stub = await stubUpstream({ answer: id => {
  if (id === 'limited-free' || (limited && id === 'kilo-good')) return {
    status: 429, body: JSON.stringify({ error: { type: 'FreeUsageLimitError', message: 'Free usage limit reached' } }),
  }
  if (id === 'empty-free') return { body: chatFrames('') }
  if (id === 'error-free') return { body: 'data: {"error":{"message":"Free usage limit reached"}}\n\ndata: [DONE]\n\n' }
  return { body: chatFrames('OK') }
} })
process.env.OUR_FREE_MODEL_BASE = stub.base
process.env.OUR_FREE_MODEL_KILO_BASE = stub.base
const { computeMembership, createModelRuntime, createRuntimeStores } = await import('../src/core/runtime.js')
const { modelAvailability } = await import('../src/model-test.js')
const at = Date.now()
const settings = { strictAvailability: true, exposeRegionModels: true, probeIntervalMinutes: 15 }
const catalog = ['ok', 'limited', 'unknown', 'region', 'old', 'light'].map(id => ({ id }))
catalog.push({ id: 'kilo', channel: 'kilo' }, { id: 'paid', channel: 'aggregate' })
const results = Object.fromEntries([
  ['ok', 'available'], ['limited', 'throttled'], ['region', 'region-blocked'],
  ['old', 'available'], ['light', 'available'], ['kilo', 'available'],
].map(([id, state]) => [id, { state, at: id === 'old' ? at - 1 : at, textVerified: id !== 'light' }]))
const ids = value => Object.values(value).flat()
assert.deepEqual(ids(computeMembership(catalog, { results }, settings, at)), ['ok', 'kilo', 'paid'])
assert(ids(computeMembership(catalog, { results }, {})).includes('limited'), 'default policy stays fail-open')
assert.deepEqual(computeMembership([{ id: 'only' }], { results: { only: { state: 'unavailable' } } }, settings), {})
assert.deepEqual(computeMembership([{ id: 'ok' }], { results }, { ...settings, hiddenModelIds: ['ok'] }), {})
assert.equal(modelAvailability('ok', { results, turnResults: { ok: { state: 'throttled', at: at + 1 } } }).availability, 'throttled')
assert.equal(modelAvailability('ok', { results: { ok: { state: 'available', startedAt: at + 2, at: at + 3 } }, turnResults: { ok: { state: 'throttled', at: at + 1 } } }).availability, 'available')
console.log('ok  strict membership, default behavior, freshness, visibility and turn/probe ordering')

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-strict-'))
const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
stores.settings.update({ ...settings, combos: [] })
stores.catalogStore.update({ entries: ['good-free', 'limited-free', 'empty-free', 'error-free'], kiloRows: [{ id: 'kilo-good', channel: 'kilo' }] })
let updates = 0
const runtime = createModelRuntime({ ...stores, logger: { warn() {} }, onTopology: () => updates++ })
try {
  assert.deepEqual(runtime.publicModelRows(), [], 'unverified models are not advertised at boot')
  await runtime.refreshAvailability(true)
  assert.deepEqual(runtime.publicModelRows().map(row => row.id), ['good-free', 'kilo-good'])
  assert.equal(stores.availability.get().results['limited-free'].state, 'throttled')
  assert.equal(stores.availability.get().results['empty-free'].state, 'unknown')
  assert.notEqual(stores.availability.get().results['error-free'].state, 'available')
  assert(stub.requests.some(row => row.path === '/chat/completions' && row.body.model === 'kilo-good'))
  assert(stub.requests.every(row => row.body.max_tokens === 512), 'automatic generation tests use the adapter minimum output budget')
  assert.equal(stores.stats.get().turns?.length ?? 0, 0, 'automatic probes do not count as conversations')
  assert(updates > 1, 'results are published progressively')
  console.log('ok  real HTTP probes use the matching free-channel endpoint and reject empty/error streams')
  limited = true
  const entry = runtime.catalog.find(row => row.id === 'kilo-good')
  for await (const chunk of runtime.adapter.stream({
    provider: 'our-free-model', model: entry.id, sessionId: 'strict-test',
    messages: [{ role: 'user', content: 'ping' }],
  }, entry, runtime.state())) { /* consume the real quota failure */ }
  assert(!runtime.publicModelRows().some(row => row.id === 'kilo-good'))
  assert.equal(modelAvailability(entry.id, stores.availability.get()).availability, 'throttled')
  limited = false
  await runtime.refreshAvailability(true)
  assert(runtime.publicModelRows().some(row => row.id === 'kilo-good'), 'a newer success restores the model')
  console.log('ok  a live turn reaching quota hides the model until a newer successful probe')
} finally {
  runtime.dispose(); stores.dispose(); await stub.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
