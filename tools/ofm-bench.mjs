// ofm-bench.mjs — uji kesehatan tiap model OFL di gateway lokal (127.0.0.1:18900).
// Jalankan: node ofm-bench.mjs
// Roster diambil dari GET /v1/models (bukan daftar hardcode).
// Menangkap delta.content DAN delta.reasoning, mendeteksi error-frame SSE,
// lalu mengklasifikasikan tiap model: OK / REASONING-ONLY / TRUNCATED / dst.
// Hasil detail ditulis ke ofm-bench-results.json
import fs from 'node:fs'

const KEY = process.env.OFM_KEY || 'ofm-X3NQCZ1UGsYzYI959kp00DOnvDSpvn-r'
const BASE = process.env.OFM_BASE || 'http://127.0.0.1:18900'
const ENDPOINT = `${BASE}/v1/chat/completions`
const MODELS_URL = `${BASE}/v1/models`
const OUT = new URL('./ofm-bench-results.json', import.meta.url)
const TIMEOUT_MS = Number(process.env.OFM_TIMEOUT_MS || 120_000)

// Budget token cukup besar supaya model "reasoning" tetap sempat memuntahkan
// jawaban nyata setelah token berpikirnya (dulu 900 -> semua habis di reasoning).
const MAX_TOKENS = Number(process.env.OFM_MAX_TOKENS || 2048)

// Hanya uji subset? Set OFM_ONLY="model-a,model-b" untuk membatasi.
const ONLY = (process.env.OFM_ONLY || '').split(',').map(s => s.trim()).filter(Boolean)

const PROMPT =
  'Write a JavaScript function `chunk(array, size)` that splits an array into chunks of length `size`. ' +
  'Include a short JSDoc comment. Return only the code, no explanation.'

async function getRoster() {
  const res = await fetch(MODELS_URL, { headers: { authorization: `Bearer ${KEY}` } })
  if (!res.ok) throw new Error(`GET /v1/models -> ${res.status} ${await res.text()}`)
  const j = await res.json()
  const ids = (j.data || []).map(m => m.id).filter(Boolean)
  return ONLY.length ? ids.filter(id => ONLY.includes(id)) : ids
}

// Klasifikasi akhir sebuah hasil uji.
function classify(r) {
  if (r.status !== 200) {
    if (r.status === 404) return 'UNKNOWN_MODEL'
    if (r.status === 429) return 'RATE_LIMITED'
    if (r.status === 0) return 'TIMEOUT'
    return `HTTP_${r.status}`
  }
  const msg = (r.errorMessage || '').toLowerCase()
  if (msg) {
    if (msg.includes('rate limit') || msg.includes('daily limit') || msg.includes('limit_rpd')) return 'RATE_LIMITED'
    if (msg.includes('can only be used from within opencode') || msg.includes('download it at')) return 'UPSTREAM_BLOCKED'
    if (msg.includes('unavailable') || msg.includes('not found') || msg.includes('no such model')) return 'UNKNOWN_MODEL'
    return 'ERROR_FRAME'
  }
  if (r.text.trim()) return 'OK'
  if (r.reasoningText.trim()) {
    return r.finishReason === 'length' ? 'REASONING_ONLY_TRUNCATED' : 'REASONING_ONLY'
  }
  if (r.finishReason === 'length') return 'TRUNCATED_NO_CONTENT'
  return 'EMPTY'
}

async function run(model) {
  const t0 = performance.now()
  const r = {
    model,
    status: 0,
    errorMessage: null,
    finishReason: null,
    ttftMs: null,
    ttftReasoningMs: null,
    firstByteMs: null,
    totalMs: 0,
    outTokens: null,
    reasoningTokens: null,
    text: '',
    reasoningText: '',
  }
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: MAX_TOKENS,
        stream: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    r.status = res.status
    if (!res.ok) {
      const body = await res.text()
      r.errorMessage = body.slice(0, 400)
      r.totalMs = Math.round(performance.now() - t0)
      r.verdict = classify(r)
      return r
    }

    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (r.firstByteMs === null) r.firstByteMs = Math.round(performance.now() - t0)
      buf += dec.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '' || data === '[DONE]') continue
        let j
        try { j = JSON.parse(data) } catch { continue }

        // error-frame: gateway/upstream mengirim {"error":{...}} di dalam stream
        if (j.error) {
          const m = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error))
          if (!r.errorMessage) r.errorMessage = m
          continue
        }

        const choice = j.choices?.[0]
        if (choice?.finish_reason) r.finishReason = choice.finish_reason
        const delta = choice?.delta || {}
        if (delta.content) {
          if (r.ttftMs === null) r.ttftMs = Math.round(performance.now() - t0)
          r.text += delta.content
        }
        const rc = delta.reasoning_content ?? delta.reasoning
        if (rc) {
          if (r.ttftReasoningMs === null) r.ttftReasoningMs = Math.round(performance.now() - t0)
          r.reasoningText += rc
        }
        if (j.usage) {
          r.outTokens = j.usage.completion_tokens ?? r.outTokens
          r.reasoningTokens = j.usage.completion_tokens_details?.reasoning_tokens ?? r.reasoningTokens
        }
      }
    }
  } catch (error) {
    r.errorMessage = `${error?.name ?? 'Error'}: ${error?.message ?? error}`
    r.totalMs = Math.round(performance.now() - t0)
    r.verdict = classify(r)
    return r
  }
  r.totalMs = Math.round(performance.now() - t0)
  r.verdict = classify(r)
  return r
}

const models = await getRoster()
console.log(`Menguji ${models.length} model dari ${MODELS_URL}\n`)

const results = []
for (const model of models) {
  process.stdout.write(`… ${model}\n`)
  const r = await run(model)
  results.push(r)
  const speed = r.ttftMs != null ? `ttft=${r.ttftMs}ms` : (r.ttftReasoningMs != null ? `ttft(rsn)=${r.ttftReasoningMs}ms` : 'ttft=-')
  process.stdout.write(
    `   [${r.verdict}] ${speed} total=${r.totalMs}ms out=${r.outTokens ?? '-'} ` +
    `content=${r.text.length}ch reason=${r.reasoningText.length}ch` +
    (r.errorMessage ? ` err=${r.errorMessage.slice(0, 80)}` : '') + '\n'
  )
}

fs.writeFileSync(OUT, JSON.stringify(results, null, 2))

const byVerdict = {}
for (const r of results) (byVerdict[r.verdict] ||= []).push(r)

console.log('\n=== RINGKASAN PER VERDICT ===')
for (const [v, list] of Object.entries(byVerdict).sort()) {
  console.log(`\n${v} (${list.length})`)
  for (const r of list) {
    const speed = r.ttftMs != null ? `ttft=${r.ttftMs}ms` : (r.ttftReasoningMs != null ? `ttft(rsn)=${r.ttftReasoningMs}ms` : 'ttft=-')
    console.log(`  ${r.model.padEnd(52)} ${speed.padEnd(18)} total=${String(r.totalMs).padStart(6)}ms out=${r.outTokens ?? '-'}`)
  }
}

console.log('\n=== RANKING (OK, tercepat dulu) ===')
console.log('model'.padEnd(52), 'ttft(ms)'.padStart(9), 'byte1(ms)'.padStart(10), 'total(ms)'.padStart(10), 'out'.padStart(6))
for (const r of results.filter(x => x.verdict === 'OK').sort((a, b) => (a.ttftMs ?? 1e9) - (b.ttftMs ?? 1e9))) {
  console.log(r.model.padEnd(52), String(r.ttftMs).padStart(9), String(r.firstByteMs).padStart(10), String(r.totalMs).padStart(10), String(r.outTokens ?? '-').padStart(6))
}
console.log(`\nDetail lengkap: ${OUT.pathname}`)
