/** Provider finish tokens travel through the real HTTP/parser/adapter before certification. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { stubUpstream } from './lib/fake-kernel.mjs'

const chat = 'mimo-v2.6-flash-free', messages = 'union-alpha', responses = 'muse-spark-1.2-contributor-free'
let reply = ''
const upstream = await stubUpstream({ answer: () => ({ body: reply }) })
process.env.OUR_FREE_MODEL_BASE = upstream.base
const { createRuntimeStores, createModelRuntime } = await import('../src/core/runtime.js')
const { modelAvailability } = await import('../src/model-test.js')
const { CODE } = await import('../src/http.js')
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-finish-test-'))
const stores = createRuntimeStores({ dataDir, logger: { warn() {} } })
stores.settings.update({ enabled: true, combos: [], streamRecovery: { enabled: false } })
stores.catalogStore.update({ entries: [chat, messages, responses] })
const runtime = createModelRuntime({ ...stores, logger: { warn() {} } })
const sse = values => values.map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('')
const chatReply = reason => sse([
  { choices: [{ index: 0, delta: { content: 'partial answer' } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: reason }] },
]) + 'data: [DONE]\n\n'
const messagesReply = reason => sse([
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } },
  { type: 'message_delta', delta: { stop_reason: reason } },
  { type: 'message_stop' },
])
const responsesReply = (status, reason) => sse([
  { type: 'response.output_text.delta', output_index: 0, delta: 'partial answer' },
  { type: 'response.done', response: { status, ...(reason ? { incomplete_details: { reason } } : {}) } },
])
let checks = 0
try {
  for (const [model, validReply] of [
    [chat, chatReply('stop')], [messages, messagesReply('end_turn')],
    [messages, messagesReply('stop_sequence')], [responses, responsesReply('completed')],
  ]) {
    reply = validReply
    assert.equal((await runtime.testModel(model)).ok, true)
    assert.equal(modelAvailability(model, stores.availability.get(), true).availability, 'available')
    checks++
  }
  for (const [model, invalidReply, reason] of [
    [chat, chatReply('content_filter'), 'content_filter'],
    [chat, chatReply('safety'), 'safety'],
    [chat, chatReply('provider_unknown_stop'), 'provider_unknown_stop'],
    [messages, messagesReply('refusal'), 'refusal'],
    [responses, responsesReply('content_filter'), 'content_filter'],
    [responses, responsesReply('incomplete', 'content_filter'), null],
  ]) {
    reply = invalidReply
    await assert.rejects(runtime.testModel(model), error => error.code === CODE.server && (!reason || error.message.includes(reason)))
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'))
    assert.equal(saved.manualResults[model].state, 'unknown')
    assert.equal(saved.manualResults[model].ttftMs, undefined)
    assert.equal(saved.manualResults[model].latencyMs, undefined)
    assert.equal(modelAvailability(model, saved, true).availability, 'unknown')
    const reopened = createRuntimeStores({ dataDir })
    try { assert.equal(reopened.availability.get().manualResults[model].state, 'unknown') }
    finally { reopened.dispose() }
    checks++
  }
  // The existing inference finish reason remains compatible; strict tests read
  // the preserved provider metadata rather than changing all inference behavior.
  reply = chatReply('content_filter')
  const entry = runtime.catalog.find(row => row.id === chat)
  const chunks = []
  for await (const chunk of runtime.adapter.stream({ model: chat, messages: [{ role: 'user', content: 'ping' }] }, entry, runtime.state())) chunks.push(chunk)
  const finish = chunks.find(chunk => chunk.type === 'finish')
  assert.equal(finish.reason.kind, 'stop')
  assert.equal(finish.upstreamFinish, 'content_filter')
  checks++
  console.log('model-test finish integration: ' + checks + ' checks passed (real local HTTP; chat, Messages, Responses; durable failures; compatible inference)')
} finally {
  runtime.dispose()
  stores.dispose()
  await upstream.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}
