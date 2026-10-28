/** One opt-in real anonymous-provider turn through the bundled engine and DSH. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRuntimeStores, createModelRuntime } from '../src/core/runtime.js'
import { createMagpieEngine } from '../src/magpie-engine.js'
import { createMagpieModels } from '../src/magpie-models.js'
import { startForwardServer, generateKey } from '../src/forward.js'

assert.ok(process.argv.includes('--run'), 'Pass --run to send a real free-provider request')
const root = fileURLToPath(new URL('../', import.meta.url))
const output = path.join(root, '.verify', 'magpie-live')
fs.mkdirSync(output, { recursive: true })
const dataDir = fs.mkdtempSync(path.join(output, 'run-'))
const logger = { info() {}, warn() {} }
const stores = createRuntimeStores({ dataDir: path.join(dataDir, 'core'), logger })
stores.settings.update({ combos: [], aggregate: { enabled: false }, tokenSaver: { enabled: false } })
const runtime = createModelRuntime({ ...stores, logger })
const engine = createMagpieEngine({ dataDir, logger })
const bridge = createMagpieModels({ engine, logger })
const key = generateKey()
const report = {
  startedAt: new Date().toISOString(), realUpstream: true,
  nativeAccountsRead: false, importedAccounts: false,
  engineRevision: engine.status().revision, passed: false,
}
let listener
try {
  await runtime.refreshCatalog({ probe: false })
  const wanted = process.env.OFM_LIVE_MODEL ?? 'mimo-v2.6-flash-free'
  const model = runtime.catalog.find(row => row.id === wanted && !row.channel)
  assert.ok(model, `Real anonymous model is not listed: ${wanted}`)
  report.model = model.id
  listener = await startForwardServer({
    config: () => ({ host: '127.0.0.1', port: 0, enabled: true, key }),
    modelRows: () => runtime.publicModelRows().filter(row => row.id === model.id),
    complete: async (request, emit) => {
      assert.equal(request.model, model.id)
      const outcome = await runtime.complete(request, emit)
      if (outcome.error) report.upstreamFailure = {
        message: String(outcome.error).replaceAll(key, '[redacted]').slice(0, 600),
        code: outcome.failure?.code, status: outcome.failure?.status,
      }
      return outcome
    },
  })
  await engine.start()
  const saved = await engine.request('POST', '/api/provider/save', { body: {
    id: 'our-free-model-live', name: 'Our Free Model live check', key,
    chat: `http://127.0.0.1:${listener.port}/v1`, models: [model.id], new: true,
  } })
  assert.equal(saved.status, 200)
  await saved.arrayBuffer()
  await bridge.refresh()
  const selected = bridge.catalog().find(row => row.id.endsWith('/' + model.id))
  assert.ok(selected, 'Engine must publish the real upstream model')
  const chunks = []
  const outcome = await bridge.complete({
    model: selected.id, maxTokens: 2048, reasoningEffort: 'light',
    signal: AbortSignal.timeout(150000),
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly OFM_LIVE_OK. No explanation.' }] }],
  }, chunk => chunks.push(chunk))
  report.response = outcome.text
  report.usage = outcome.usage
  report.finish = chunks.findLast(chunk => chunk.type === 'finish')?.reason.kind
  report.error = outcome.error
  assert.equal(outcome.error, undefined)
  assert.equal(report.finish, 'stop')
  assert.match(outcome.text, /OFM_LIVE_OK/)
  report.passed = true
  console.log(`Real ${model.id} -> OFM gateway -> bundled Magpie -> DSH stream: ${outcome.text.trim()}`)
} catch (error) {
  report.error = String(error.message).replaceAll(key, '[redacted]').slice(0, 600)
  console.error(`Live upstream acceptance failed: ${report.error}`)
  process.exitCode = 1
} finally {
  bridge.close()
  await engine.close()
  await listener?.close()
  runtime.dispose()
  stores.dispose()
  report.finishedAt = new Date().toISOString()
  fs.writeFileSync(path.join(dataDir, 'result.json'), JSON.stringify(report, null, 2) + '\n')
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(report, null, 2) + '\n')
}
