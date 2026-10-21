/** A real, held background HTTP probe must not replace a newer manual measurement. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubUpstream } from './lib/fake-kernel.mjs'

const id = 'mimo-v2.6-flash-free'
let releaseProbe, probeStarted
const gate = new Promise(resolve => { releaseProbe = resolve })
const ready = new Promise(resolve => { probeStarted = resolve })
let requests = 0
const upstream = await stubUpstream({ answer: () => {
  requests++
  if (requests === 1) probeStarted()
  return { status: 400, body: JSON.stringify({ error: { message: 'Model is unavailable.' } }), ...(requests === 1 ? { wait: gate } : {}) }
} })
process.env.OUR_FREE_MODEL_BASE = upstream.base
const { createRuntimeStores, createModelRuntime, computeMembership } = await import('../src/core/runtime.js')
const { modelAvailability } = await import('../src/model-test.js')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-probe-manual-order-'))
const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
stores.settings.update({ enabled: true, combos: [] })
stores.catalogStore.update({ entries: [id] })
const runtime = createModelRuntime({ ...stores, logger: { warn() {} } })
const realNow = Date.now
let clock = realNow()
let running
try {
  assert.deepEqual(runtime.catalog.map(row => row.id), [id])
  Date.now = () => clock
  const probeTime = clock
  running = runtime.refreshAvailability(true)
  await ready
  clock += 1000
  runtime.adapter.stream = async function* () {
    yield { type: 'text-delta', text: 'OK' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  assert.equal((await runtime.testModel(id)).persisted, true)
  const manualTime = clock
  clock += 1000
  releaseProbe()
  await running
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'))
  assert.equal(saved.results[id].startedAt, probeTime)
  assert.equal(saved.manualResults[id].at, manualTime)
  assert.ok(saved.results[id].at > manualTime, 'old probe really completed after the manual test')
  assert.equal(modelAvailability(id, saved).availabilitySource, 'manual')
  assert.equal(modelAvailability(id, saved).availability, 'available')
  const membership = computeMembership([{ id }, { id: 'other-model' }], saved, {})
  assert.ok(Object.values(membership).flat().includes(id), 'manual success remains routable')
  const reopened = createRuntimeStores({ dataDir })
  try {
    assert.equal(modelAvailability(id, reopened.availability.get()).availabilitySource, 'manual')
  } finally { reopened.dispose() }
  console.log('ok  an older real HTTP probe completes later without replacing manual success, including after disk reload')

  clock += 1000
  await runtime.refreshAvailability(true)
  const newer = stores.availability.get()
  assert.equal(modelAvailability(id, newer).availabilitySource, 'probe')
  assert.equal(modelAvailability(id, newer).availability, 'unavailable')
  assert.equal(newer.results[id].startedAt, clock)
  console.log('ok  a probe actually begun after manual completion may publish a newer verdict')
} finally {
  Date.now = realNow
  releaseProbe()
  runtime.dispose()
  await running?.catch(() => {})
  stores.dispose()
  await upstream.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
