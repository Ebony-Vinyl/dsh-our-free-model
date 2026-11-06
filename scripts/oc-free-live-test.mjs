// Explicitly opt-in: this sends ONE real free-lane request and may consume quota.
//
// The lane's own verification shape, aligned with the 2.8.1 quota discipline:
// one model, one request, the production session mint (`sessionForConversation`,
// the same slow-clock identity a real turn carries — the old script's raw
// `mintSessionId()` tested an identity the lane never sends), and a classified
// exit: 200 reports the round-trip; 429/403 report the breaker's terms and stop.
// Never loop, never re-mint, never try a second model — issue #767 measured
// that none of it moves a per-IP quota window.
import { applyFingerprint, endpointFor, sessionForConversation } from '../src/upstream.js'
import { postStreamed, CODE } from '../src/http.js'
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
  let result
  try {
    result = await postStreamed({
      path: endpointFor(model), body,
      // The production conversation identity, exactly as a harness turn mints it.
      session: sessionForConversation(`oc-free-live:${model}`),
      signal: AbortSignal.timeout(45000),
      onData: data => {
        if (data === '[DONE]') return
        const j = JSON.parse(data)
        text += j.choices?.[0]?.delta?.content ?? ''
        usage = j.usage ?? usage
        chunks++
      },
    })
  } catch (error) {
    // A refusal is a finding, not a crash: report the class, the window the
    // upstream named, and exit non-zero without a second attempt.
    const retryAfterMs = Number(error?.providerRetryAfterMs)
    console.log(JSON.stringify({
      at: new Date().toISOString(), model,
      ok: false,
      code: error?.code ?? 'unknown',
      status: error?.status,
      message: String(error?.message ?? error).slice(0, 300),
      ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? { retryAfterMs, retryAfterMinutes: Math.round(retryAfterMs / 60000), windowEndsAt: new Date(Date.now() + retryAfterMs).toISOString() }
        : {}),
      configuredOutlet: !!relay,
      note: error?.code === CODE.quota
        ? 'the free quota window is open on this egress; no retry was sent'
        : error?.code === CODE.laneLocked
          ? 'the free tier answers the official client only; no retry was sent'
          : 'single-shot test; no retry was sent',
    }, null, 1))
    process.exit(1)
  }
  if (result.status !== 200 || text.trim() !== 'PONG') {
    console.log(JSON.stringify({ at: new Date().toISOString(), model, ok: false, status: result.status, reply: text.slice(0, 100), chunks }, null, 1))
    process.exit(1)
  }
  console.log(JSON.stringify({
    at: new Date().toISOString(), model, ok: true, status: result.status, reply: text, chunks,
    elapsedMs: Date.now() - start, configuredOutlet: !!relay,
    billingSource: usage?.opencode?.billing_source, tokens: usage?.total_tokens,
  }, null, 1))
} finally { if (relay) await relay.close() }
