import assert from 'node:assert/strict'
import http from 'node:http'
import { chatFrames } from './lib/fake-kernel.mjs'
import { FreeModelAdapter, ROUTE_MAIN } from '../src/adapter.js'
import { buildAggregateCatalog } from '../src/aggregate.js'
import { hasGeneratedOutput } from '../src/output-delta.js'

const received = []
const server = http.createServer(async (req, res) => {
  const pieces = []
  for await (const piece of req) pieces.push(piece)
  received.push(JSON.parse(Buffer.concat(pieces)))
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  if (req.url.endsWith('/responses')) {
    const events = [
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' },
      { type: 'response.completed', response: { status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
    res.end(events.map(x => `data: ${JSON.stringify(x)}\n\n`).join(''))
  } else res.end(chatFrames('OK'))
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  const aggregate = { providers: Object.fromEntries(['groq', 'openai_api'].map(id =>
    [id, { enabled: true, apiKey: 'test', baseUrl, models: ['deepseek-test'] }])) }
  const catalog = buildAggregateCatalog(aggregate)
  const adapter = new FreeModelAdapter({ state: () => ({ catalog, settings: { aggregate, streamRecovery: false } }) })
  for (const entry of catalog) {
    for await (const _chunk of adapter.stream({ provider: ROUTE_MAIN, model: entry.id, reasoningEffort: 'medium',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) { /* drain */ }
  }
  assert.equal(received.length, 2)
  assert.equal(received[0].reasoning_effort, 'medium')
  assert.equal(received[1].reasoning.effort, 'medium')
  assert.equal(received[1].model, 'deepseek-test')
  assert.equal(hasGeneratedOutput({ type: 'text-delta', text: '' }), false)
  assert.equal(hasGeneratedOutput({ type: 'block-start', blockType: 'text' }), false)
  assert.equal(hasGeneratedOutput({ type: 'usage', usage: {} }), false)
  assert.equal(hasGeneratedOutput({ type: 'reasoning-delta', text: 'thinking' }), true)
  assert.equal(hasGeneratedOutput({ type: 'tool-call-delta', argumentsDelta: '{}' }), true)
  console.log('aggregate-effort-test: medium reaches Chat and Responses upstreams; empty chunks are not tokens')
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
