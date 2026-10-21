import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, chatFrames, fakeContext, stubUpstream, until } from './lib/fake-kernel.mjs'

const upstream = await stubUpstream({ listing: ['deepseek-v4-flash-free'], answer: () => ({ body: chatFrames('OK') }) })
process.env.OUR_FREE_MODEL_BASE = upstream.base
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-bench-http-'))
process.env.DSH_HOME = home
const dataDir = path.join(home, 'our-free-model')
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
  distribution: 'managed', enabled: true, combos: [], forward: { enabled: false },
  aggregate: { enabled: true, providers: { open_router: { enabled: true, apiKey: 'synthetic-key', baseUrl: upstream.base, models: ['alpha-model'] } } },
}))
const { apply, inject } = await import('../index.js')
const routes = []
const ctx = fakeContext({ inject, onRegister: route => routes.push(route) })
apply(ctx, {})
try {
  await until(() => routes.some(route => route.kind === 'prefix'), { timeoutMs: 5000, what: 'plugin settings API' })
  const handler = routes.find(route => route.kind === 'prefix').handler
  const summary = async () => (await callRoute(handler, 'GET', '/api/our-free-model/summary')).json
  const model = 'open_router/alpha-model'
  const listed = (await summary()).catalog.find(row => row.id === model)
  assert.equal(listed.availabilitySource, 'listing')
  assert.equal(listed.availability, 'unknown')
  const before = upstream.requests.length
  const result = await callRoute(handler, 'POST', '/api/our-free-model/bench', { model })
  assert.equal(result.status, 200, JSON.stringify(result.json))
  assert.equal(result.json.text, 'OK')
  assert.equal(result.json.ok, true)
  assert.equal(result.json.persisted, true)
  assert.ok(upstream.requests.slice(before).some(row => row.body.model === 'alpha-model'), 'bench reaches the selected aggregate route')
  const measured = (await summary()).catalog.find(row => row.id === model)
  assert.equal(measured.availabilitySource, 'manual')
  assert.equal(measured.availability, 'available')
  assert.equal(measured.ttftMs, result.json.ttftMs)
  assert.equal(measured.latencyMs, result.json.totalMs)
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'))
  assert.equal(saved.manualResults[model].ttftMs, result.json.ttftMs)
  const unknown = await callRoute(handler, 'POST', '/api/our-free-model/bench', { model: 'missing' })
  assert.equal(unknown.status, 404)
  console.log('bench integration: real plugin management API + selected local upstream + manual measurement + durable store + refreshed summary + unknown model passed')
} finally {
  for (const dispose of ctx.__disposers.reverse()) dispose()
  await upstream.close()
  fs.rmSync(home, { recursive: true, force: true })
}
