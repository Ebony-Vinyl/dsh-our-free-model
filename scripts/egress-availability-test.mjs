/** 出口变化只使旧测量失效，不能自动探测或恢复迟到的旧判定。 */
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubUpstream } from './lib/fake-kernel.mjs'

let probeAnswer
const upstream = await stubUpstream({ answer: () => probeAnswer() })
process.env.OUR_FREE_MODEL_BASE = upstream.base
const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')
const { modelAvailability } = await import('../src/model-test.js')
const { CODE } = await import('../src/http.js')
after(() => upstream.close())

const id = 'mimo-v2.6-flash-free'
const other = 'space-bunny-free'
const originalFetch = globalThis.fetch
const stop = { type: 'finish', reason: { kind: 'stop' } }
const answer = async function* () { yield { type: 'text-delta', text: 'OK' }; yield stop }
const gate = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function fixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-egress-availability-'))
  const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
  stores.settings.update({ enabled: true, exposeRegionModels: false, combos: [] })
  stores.catalogStore.update({ entries: [id, other] })
  stores.availability.update({
    egress: { ip: '198.51.100.1' }, at: 1234,
    results: { [id]: { state: 'region-blocked', detail: '旧出口受限', at: 1234 }, [other]: { state: 'available', at: 1234 } },
    manualResults: { [other]: { state: 'available', source: 'manual', at: 2345 } },
  })
  let changes = 0
  let ip = '198.51.100.2'
  const requests = []
  globalThis.fetch = (url, init) => {
    const address = String(url)
    requests.push(address)
    if (new URL(address).hostname === 'api.ipify.org') return Promise.resolve(Response.json({ ip }))
    assert.ok(address.startsWith(upstream.base + '/'), `不得请求外部网络：${address}`)
    return originalFetch(url, init)
  }
  const runtime = createModelRuntime({ ...stores, logger: { info() {}, warn() {} }, onTopology: () => { changes++ } })
  return {
    dataDir, stores, runtime, requests, get changes() { return changes }, setIp(value) { ip = value },
    advertised: () => Object.values(runtime.state().membership).flat(),
    close() { globalThis.fetch = originalFetch; runtime.dispose(); stores.dispose(); fs.rmSync(dataDir, { recursive: true, force: true }) },
  }
}

test('换出口恢复被旧地区判定隐藏的模型，历史测量保留且重启后仍失效，不发送探测', async () => {
  const f = fixture()
  try {
    assert.ok(!f.advertised().includes(id))
    await f.runtime.watchEgress()
    assert.ok(f.advertised().includes(id))
    assert.equal(f.changes, 1, '应通知选择器重新计算模型分组')
    assert.equal(f.requests.length, 1)
    assert.match(f.requests[0], /ipify/)
    const saved = JSON.parse(fs.readFileSync(path.join(f.dataDir, 'availability.json'), 'utf8'))
    assert.equal(saved.at, 0)
    assert.equal(saved.results[id].state, 'region-blocked')
    assert.equal(saved.results[id].stale, true)
    assert.equal(saved.manualResults[other].stale, true)
    const reopened = createRuntimeStores({ dataDir: f.dataDir })
    try {
      assert.equal(modelAvailability(id, reopened.availability.get()).availability, 'unknown')
      assert.equal(modelAvailability(other, reopened.availability.get()).availability, 'unknown')
    } finally { reopened.dispose() }
    f.runtime.adapter.stream = answer
    assert.equal((await f.runtime.testModel(id)).persisted, true)
    assert.equal(modelAvailability(id, f.stores.availability.get()).availability, 'available')
    assert.equal(modelAvailability(id, f.stores.availability.get()).availabilitySource, 'manual')
  } finally { f.close() }
})

test('相同出口保留有效测量且不发送探测，也不重复通知选择器', async () => {
  const f = fixture()
  try {
    f.setIp('198.51.100.1')
    const previous = structuredClone(f.stores.availability.get())
    await f.runtime.watchEgress()
    assert.deepEqual(f.stores.availability.get(), previous)
    assert.equal(f.changes, 0)
    assert.equal(f.requests.length, 1)
  } finally { f.close() }
})

test('旧出口的在途手动测量不能覆盖新出口结果', async () => {
  const f = fixture()
  const started = gate(), release = gate()
  let running
  try {
    f.runtime.adapter.stream = async function* () { started.resolve(); await release.promise; yield* answer() }
    running = f.runtime.testModel(id)
    const rejected = assert.rejects(running, error => error.code === CODE.aborted && /egress changed/.test(error.message))
    await started.promise
    await f.runtime.watchEgress()
    f.runtime.adapter.stream = answer
    await f.runtime.testModel(id)
    const saved = structuredClone(f.stores.availability.get().manualResults[id])
    release.resolve()
    await rejected
    assert.deepEqual(f.stores.availability.get().manualResults[id], saved)
  } finally { release.resolve(); await running?.catch(() => {}); f.close() }
})

test('旧出口的迟到失败不能写入新出口缓存', async () => {
  const f = fixture()
  const started = gate(), release = gate()
  let running
  try {
    f.runtime.adapter.stream = async function* () { started.resolve(); await release.promise; throw new Error('旧出口失败') }
    running = f.runtime.testModel(id)
    const rejected = assert.rejects(running, /旧出口失败/)
    await started.promise
    await f.runtime.watchEgress()
    const saved = structuredClone(f.stores.availability.get())
    release.resolve()
    await rejected
    assert.deepEqual(f.stores.availability.get(), saved)
  } finally { release.resolve(); await running?.catch(() => {}); f.close() }
})

test('新出口的手动探测不合并到旧轮次，旧 HTTP 探测完成后不恢复过期判定', async () => {
  const f = fixture()
  const started = gate(), release = gate()
  let running
  try {
    // 两个旧 HTTP 请求都到达后再换出口，不依赖计时碰运气。
    let oldRequests = 0
    probeAnswer = () => {
      oldRequests++
      if (oldRequests === 2) started.resolve()
      return { status: 400, body: JSON.stringify({ error: { message: 'Model is unavailable.' } }), wait: release.promise }
    }
    running = f.runtime.refreshAvailability(true)
    await started.promise
    await f.runtime.watchEgress()
    probeAnswer = () => ({ status: 400, body: JSON.stringify({ error: { message: 'Model is unavailable.' } }) })
    const newer = f.runtime.refreshAvailability(true)
    const deadline = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('新出口探测错误地等待旧轮次')), 3000)
      timer.unref()
      newer.finally(() => clearTimeout(timer)).catch(() => {})
    })
    await Promise.race([newer, deadline])
    const saved = structuredClone(f.stores.availability.get())
    assert.equal(modelAvailability(id, saved).availability, 'unavailable')
    release.resolve()
    await running
    assert.deepEqual(f.stores.availability.get(), saved)
  } finally { release.resolve(); await running?.catch(() => {}); f.close() }
})
