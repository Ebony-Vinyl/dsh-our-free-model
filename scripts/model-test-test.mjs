import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { measureModelTest, runModelTest, modelAvailability, MODEL_TEST_TIMEOUT_MS } from '../src/model-test.js'
import { createRuntimeStores, createModelRuntime, computeMembership } from '../src/core/runtime.js'
import { CODE } from '../src/http.js'

const text = value => ({ type: 'text-delta', text: value })
const stop = { type: 'finish', reason: { kind: 'stop' } }
async function* chunks(values) { yield* values }
const answer = () => chunks([text('OK'), stop, { type: 'usage', usage: { outputTokens: 7 } }])

// Validation and elapsed-time cases are based on PR #491, extended to cover cancellation and durable results.
test('text test rejects empty, incomplete, reasoning-only and tool replies', async () => {
  for (const values of [[], [stop], [text('  '), stop],
    [{ type: 'reasoning-delta', text: 'thinking' }, stop], [text('OK')],
    [text('OK'), { type: 'finish', reason: { kind: 'max-tokens' } }],
    [{ type: 'tool-call-delta', name: 'bash' }, stop],
    [{ type: 'block-end', block: { type: 'tool-call', name: 'bash' } }, stop]]) {
    await assert.rejects(measureModelTest(chunks(values)))
  }
  const failure = new Error('transport ended')
  await assert.rejects(measureModelTest((async function* () { yield text('OK'); throw failure })()), e => e === failure)
})

test('text test uses an elapsed decode window and accepts usage after finish', async () => {
  const times = [1_790_000_000_000, 1_790_000_000_300, 1_790_000_002_300]
  const result = await measureModelTest(chunks([text('OK'), stop, { type: 'usage', usage: { outputTokens: 100 } }]), () => times.shift())
  assert.equal(result.text, 'OK'); assert.equal(result.sample, 'OK')
  assert.equal(result.totalMs, 2300); assert.equal(result.ttftMs, 300); assert.equal(result.tokensPerSecond, 50)
  assert.equal(MODEL_TEST_TIMEOUT_MS, 300_000)
})

test('test total budget aborts a pending upstream and closes the adapter iterator', async () => {
  let signal, closed = false
  await assert.rejects(runModelTest(current => {
    signal = current
    return { [Symbol.asyncIterator]() { return this }, next: () => new Promise(resolve => current.addEventListener('abort', () => resolve({ done: true }), { once: true })), return: async () => { closed = true; return { done: true } } }
  }, { timeoutMs: 12 }), e => e.code === CODE.timeout)
  assert.equal(signal.aborted, true); assert.equal(closed, true)
})

test('pre-cancelled test never creates a request', async () => {
  const controller = new AbortController(); controller.abort()
  let requested = false
  await assert.rejects(runModelTest(() => { requested = true; return answer() }, { signal: controller.signal }))
  assert.equal(requested, false)
})

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-manual-test-'))
  const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
  stores.settings.update({ enabled: true, combos: [] })
  const runtime = createModelRuntime({ ...stores, logger: { warn() {} } })
  const id = runtime.catalog[0].id
  return { dataDir, stores, runtime, id, close() { runtime.dispose(); stores.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }) } }
}

test('successful manual sample survives disk reload and newer samples beat an older probe', async () => {
  const f = fixture()
  try {
    f.runtime.adapter.stream = answer
    const result = await f.runtime.testModel(f.id)
    assert.equal(result.ok, true); assert.equal(result.persisted, true)
    const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'availability.json')))
    assert.equal(saved.manualResults[f.id].state, 'available')
    const reopened = createRuntimeStores({ dataDir: f.dataDir })
    try { assert.deepEqual(reopened.availability.get().manualResults, saved.manualResults) } finally { reopened.dispose() }
    saved.results = { [f.id]: { state: 'unavailable', at: saved.manualResults[f.id].at - 1 } }
    assert.equal(modelAvailability(f.id, saved).availabilitySource, 'manual')
    assert.equal(modelAvailability(f.id, saved).availability, 'available')
    const membership = computeMembership([{ id: f.id }, { id: 'other-model' }], saved, {})
    assert.ok(Object.values(membership).flat().includes(f.id))
    saved.results[f.id].at += 2
    assert.equal(modelAvailability(f.id, saved).availabilitySource, 'probe')
    assert.equal(modelAvailability(f.id, saved).availability, 'unavailable')
  } finally { f.close() }
})

test('failed manual test replaces stale success with unknown and no invented speed', async () => {
  const f = fixture()
  try {
    f.runtime.adapter.stream = answer
    await f.runtime.testModel(f.id)
    f.runtime.adapter.stream = () => chunks([stop])
    await assert.rejects(f.runtime.testModel(f.id), e => e.code === CODE.empty)
    const row = f.stores.availability.get().manualResults[f.id]
    assert.equal(row.state, 'unknown'); assert.match(row.detail, /no response text/)
    assert.equal(row.ttftMs, undefined); assert.equal(row.latencyMs, undefined)
  } finally { f.close() }
})

test('a cancelled request does not erase an earlier measurement', async () => {
  const f = fixture()
  try {
    f.runtime.adapter.stream = answer
    await f.runtime.testModel(f.id)
    const saved = structuredClone(f.stores.availability.get().manualResults)
    let started
    const ready = new Promise(resolve => { started = resolve })
    f.runtime.adapter.stream = options => (async function* () {
      started()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    })()
    const controller = new AbortController()
    const running = f.runtime.testModel(f.id, undefined, { signal: controller.signal })
    await ready; controller.abort()
    await assert.rejects(running)
    assert.deepEqual(f.stores.availability.get().manualResults, saved)
  } finally { f.close() }
})

test('an older overlapping failed test cannot overwrite the newer successful result', async () => {
  const f = fixture()
  try {
    let rejectOld
    let started
    const ready = new Promise(resolve => { started = resolve })
    f.runtime.adapter.stream = () => (async function* () { started(); await new Promise((_, reject) => { rejectOld = reject }); yield stop })()
    const older = f.runtime.testModel(f.id)
    await ready
    f.runtime.adapter.stream = answer
    await f.runtime.testModel(f.id)
    const saved = structuredClone(f.stores.availability.get().manualResults)
    rejectOld(new Error('old failure'))
    await assert.rejects(older, /old failure/)
    assert.deepEqual(f.stores.availability.get().manualResults, saved)
  } finally { f.close() }
})

test('a listing alone is not reported as a successful test', () => {
  assert.equal(modelAvailability('eac/test', {}, true).availabilitySource, 'listing')
  assert.equal(modelAvailability('eac/test', {}, true).availability, 'unknown')
})
