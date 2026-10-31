// Explicitly opt-in: this sends ONE real free-lane request and may consume quota.
import assert from 'node:assert/strict'
import { applyFingerprint, mintSessionId, endpointFor } from '../src/upstream.js'
import { postStreamed } from '../src/http.js'
import { startEgressRelay } from '../src/egress.js'
if (!process.argv.includes('--live')) { console.log('Skipped: pass --live to send an actual request.'); process.exit(0) }
const modelIndex = process.argv.indexOf('--model')
const model = modelIndex >= 0 ? process.argv[modelIndex + 1] : 'deepseek-v4.1-flash-free'
if (!model || model.startsWith('--')) throw new Error('--model requires a model ID')
const proxyIndex = process.argv.indexOf('--proxy')
let relay
try {
  if (proxyIndex >= 0) relay = await startEgressRelay({ config: () => ({ mode: 'client', url: process.argv[proxyIndex + 1] }), dataDir: '.' })
  const body = { model, messages: [{ role: 'user', content: 'Do not use tools. Reply with exactly: PONG' }], stream: true, stream_options: { include_usage: true }, max_completion_tokens: 128 }
  applyFingerprint(body, false)
  let text = '', usage, chunks = 0
  const start = Date.now()
  const result = await postStreamed({ path: endpointFor(model), body, session: mintSessionId(), signal: AbortSignal.timeout(45000), onData: data => {
    if (data === '[DONE]') return
    const j = JSON.parse(data)
    text += j.choices?.[0]?.delta?.content ?? ''
    usage = j.usage ?? usage
    chunks++
  } })
  assert.equal(result.status, 200)
  assert.equal(text.trim(), 'PONG')
  console.log(JSON.stringify({ at: new Date().toISOString(), model, status: result.status, reply: text, chunks, elapsedMs: Date.now() - start, configuredOutlet: !!relay, billingSource: usage?.opencode?.billing_source, tokens: usage?.total_tokens }))
} finally { if (relay) await relay.close() }
