import assert from 'node:assert/strict'
import { buildComboCatalog, comboChain, normalizeCombos, resetRotation } from '../src/combos.js'
import { createRoutingManagement } from '../packages/standalone/routing.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createModelRuntime, createRuntimeStores } from '../src/core/runtime.js'

const now = Date.parse('2026-10-23T12:00:00Z')
const models = ['first', 'second', 'third', 'fourth'].map((id, index) => ({
  id, name: id, contextWindow: (index + 1) * 1000, maxOutput: 500, vision: index !== 3, reasoning: true,
}))
const quotaWindow = (remainingPercent, seconds, kind = 'five_hour') => ({
  kind, remainingPercent, resetsAt: new Date(now + seconds * 1000).toISOString(), windowSeconds: kind === 'weekly' ? 604800 : 18000,
})
const reading = windows => ({ status: 'ok', checkedAt: new Date(now - 1000).toISOString(), windows })
const entry = strategy => buildComboCatalog(normalizeCombos([{ id: 'combo:daily', name: 'daily', models: models.map(row => row.id), strategy }]), models)[0]
const ids = (strategy, options) => comboChain(entry(strategy), models, { now, ...options }).map(row => row.id)
let checks = 0
const check = (name, run) => { run(); checks++; console.log(`ok ${name}`) }
check('smart prioritizes reported usable windows resetting soon and benches exhausted readings', () => {
  const quota = {
    first: reading([quotaWindow(0, 180)]), second: reading([quotaWindow(70, 3600)]),
    third: reading([quotaWindow(40, 600)]),
  }
  assert.deepEqual(ids('smart', { quota }), ['third', 'second', 'fourth'])
  assert.deepEqual(ids('smart', { quota: Object.fromEntries(models.map(row => [row.id, reading([quotaWindow(0, 180)])])) }), [])
})
check('unknown, stale, failed, out-of-range and already-reset quotas do not fabricate exhaustion', () => {
  const quota = {
    first: { ...reading([quotaWindow(0, 180)]), checkedAt: new Date(now - 16 * 60_000).toISOString() },
    second: { ...reading([quotaWindow(0, 180)]), status: 'error' },
    third: reading([quotaWindow(0, -1)]),
    fourth: reading([{ remainingPercent: 101 }]),
  }
  assert.deepEqual(ids('smart', { quota }), ['first', 'second', 'third', 'fourth'])
})
check('weekly pacing ranks remaining percentage per reset hour and does not label unknown as full', () => {
  const quota = {
    first: reading([quotaWindow(40, 20 * 3600, 'weekly')]),
    second: reading([quotaWindow(30, 5 * 3600, 'weekly')]),
    third: reading([quotaWindow(0, 5 * 3600, 'weekly')]),
  }
  assert.deepEqual(ids('pace', { quota }), ['second', 'first', 'fourth'])
})
check('usage uses actual call totals, stable ties and exhausted account rank', () => {
  assert.deepEqual(ids('usage', { usage: { first: 8, second: 2, third: 2 }, quota: { second: reading([quotaWindow(0, 600)]) } }),
    ['third', 'first', 'fourth'])
  assert.deepEqual(ids('usage', { usage: { first: 0, second: 0 } }), ['first', 'second', 'third', 'fourth'])
})
check('flat legacy fallback and round robin preserve their existing behavior', () => {
  resetRotation()
  assert.deepEqual(ids('fallback', {}), ['first', 'second', 'third', 'fourth'])
  assert.deepEqual(ids('round-robin', {}), ['first', 'second', 'third', 'fourth'])
  assert.deepEqual(ids('round-robin', { peek: true }), ['second', 'third', 'fourth', 'first'])
  assert.deepEqual(ids('round-robin', {}), ['second', 'third', 'fourth', 'first'])
})
check('nested groups preserve capacities, ordered leaf routing and deduplicate shared leaves', () => {
  const definitions = normalizeCombos([
    { id: 'combo:outer', name: 'outer', models: ['combo:inner', 'first', 'fourth'], strategy: 'fallback' },
    { id: 'combo:inner', name: 'inner', models: ['third', 'second'], strategy: 'fallback' },
  ])
  const rows = buildComboCatalog(definitions, models)
  const outer = rows.find(row => row.id === 'combo:outer')
  assert.equal(outer.contextWindow, 1000)
  assert.equal(outer.vision, false)
  assert.deepEqual(comboChain(outer, [...models, ...rows]).map(row => row.id), ['third', 'second', 'first', 'fourth'])
})
check('nested cycles and every dependent group fail closed without recursion or advertisement', () => {
  const definitions = normalizeCombos([
    { id: 'combo:a', name: 'a', models: ['combo:b', 'first'] },
    { id: 'combo:b', name: 'b', models: ['combo:c', 'second'] },
    { id: 'combo:c', name: 'c', models: ['combo:a', 'third'] },
    { id: 'combo:dependent', name: 'dependent', models: ['combo:a', 'fourth'] },
    { id: 'combo:safe', name: 'safe', models: ['first'] },
  ])
  assert.deepEqual(buildComboCatalog(definitions, models).map(row => row.id), ['combo:safe'])
  const malicious = { id: 'combo:x', channel: 'combo', combo: ['combo:x'] }
  assert.deepEqual(comboChain(malicious, [malicious]), [])
})
let settings = { combos: [] }, writes = 0
const runtime = {
  get catalog() { return [...models, ...buildComboCatalog(normalizeCombos(settings.combos), models)] },
  state() { return { catalog: this.catalog, routing: { quota: { second: reading([quotaWindow(80, 30)]) }, now } } },
  syncAggregateCatalog() { return this.catalog },
}
const management = createRoutingManagement({
  runtime, stores: { settings: { get: () => settings } },
  persist: patch => { settings = { ...settings, ...patch }; writes++ },
})
check('routing management stores validated groups and exposes all real strategies', () => {
  management.save({ combo: { name: 'Daily', models: ['first', 'second'], strategy: 'smart', stickyLimit: 1, enabled: true } })
  assert.equal(writes, 1)
  assert.ok(management.list().strategies.includes('pace'))
  assert.ok(management.list().combos[0].id.startsWith('combo:'))
  assert.deepEqual(management.preview({ models: ['first', 'second'], strategy: 'smart' }).order.map(row => row.id), ['second', 'first'])
})
check('invalid fields and unknown IDs fail without losing the saved groups', () => {
  const before = structuredClone(settings)
  for (const combo of [
    { name: '', models: ['first'], strategy: 'smart', stickyLimit: 1, enabled: true },
    { name: 'New', models: ['unknown'], strategy: 'smart', stickyLimit: 1, enabled: true },
    { name: 'New', models: ['first', 'first'], strategy: 'smart', stickyLimit: 1, enabled: true },
    { name: 'New', models: ['first'], strategy: 'bad', stickyLimit: 1, enabled: true },
  ]) assert.throws(() => management.save({ combo }))
  assert.deepEqual(settings, before)
})
check('management rejects nesting cycles and refuses removal of a referenced group', () => {
  const first = settings.combos[0]
  management.save({ combo: { name: 'Outer', models: [first.id, 'third'], strategy: 'fallback', stickyLimit: 1, enabled: true } })
  const outer = settings.combos[1]
  assert.throws(() => management.save({ combo: { ...first, models: [outer.id] } }), /循环/)
  assert.throws(() => management.remove({ id: first.id }), /仍在引用/)
  management.remove({ id: outer.id })
  management.remove({ id: first.id })
  assert.deepEqual(settings.combos, [])
})
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-quota-routing-'))
let core, stores
try {
  stores = createRuntimeStores({ dataDir: scratch })
  const called = []
  const accountModels = ['a', 'b', 'c'].map(id => ({ id: `subscription:${id}/model`, name: id, subscriptionId: id, subscriptionProvider: 'api', wire: 'chat' }))
  const liveReading = (remainingPercent, seconds) => ({ status: 'ok', checkedAt: new Date().toISOString(),
    windows: [{ kind: 'five_hour', remainingPercent, resetsAt: new Date(Date.now() + seconds * 1000).toISOString() }] })
  let quota = {
    [accountModels[0].id]: liveReading(0, 60),
    [accountModels[1].id]: liveReading(50, 600),
    [accountModels[2].id]: liveReading(50, 60),
  }
  const subscriptionRuntime = {
    catalog: () => accountModels, routingQuota: () => quota,
    async complete(request, onChunk) {
      called.push(request.model)
      if (request.model === accountModels[2].id) throw Object.assign(new Error('rate limit fixture'), { statusCode: 429, code: 'RATE_LIMIT' })
      onChunk({ type: 'text-delta', index: 0, text: 'QUOTA_ROUTED' })
      onChunk({ type: 'finish', reason: { kind: 'stop' } })
      return { text: 'QUOTA_ROUTED', toolCalls: [] }
    },
  }
  stores.settings.update({ enabled: true, combos: [{ id: 'combo:quota-live', name: 'quota live', models: accountModels.map(row => row.id), strategy: 'smart', enabled: true }] })
  core = createModelRuntime({ ...stores, subscriptionRuntime, logger: { warn() {}, info() {} } })
  const response = await core.complete({ model: 'combo:quota-live', openAi: { messages: [{ role: 'user', content: 'test' }] } })
  assert.equal(response.text, 'QUOTA_ROUTED')
  assert.deepEqual(called, [accountModels[2].id, accountModels[1].id])
  assert.equal(called.includes(accountModels[0].id), false, 'reported exhausted account cannot spend an upstream request')
  quota = Object.fromEntries(accountModels.map(model => [model.id, liveReading(0, 60)]))
  const before = called.length
  const unavailable = await core.complete({ model: 'combo:quota-live', openAi: { messages: [{ role: 'user', content: 'test' }] } })
  assert.ok(unavailable.error)
  assert.equal(called.length, before)
  checks++
  console.log('ok actual shared core skips exhausted accounts, prioritizes reset and falls through a quota refusal before output')
} finally {
  core?.dispose()
  stores?.dispose()
  assert.ok(fs.realpathSync(scratch).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`quota routing: ${checks} checks passed`)
