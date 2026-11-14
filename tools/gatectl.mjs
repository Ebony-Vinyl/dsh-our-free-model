/**
 * Uji "gerbang" ZEN dengan dua kutub, terpisah dari model mana pun.
 *
 * Yang mau dibuktikan: 429 yang kita lihat itu **kuota**, bukan gerbang bentuk
 * request (yang di repo ebouther/opencode-unlimited-proxy disebut gate 1-4).
 *
 * Kalau gerbangnya yang menolak, seluruh request akan 403 dengan pesan
 * "within opencode" — tanpa peduli model. Kalau kuotanya yang habis, request
 * yang bentuknya SEMPURNA pun 429 FreeUsageLimitError.
 *
 * Kunci: `reflection/beam-free` sudah diukur 200 dari laptop (blok jaringan
 * berbeda). Jadi kalau model itu 200 di sini sementara deepseek 429, berarti
 * dari host ini koneksi + header + bentuk request kita LULUS gerbang, dan
 * satu-satunya yang tersisa adalah penghitung kuota per model/akun.
 *
 * Jalankan di VPS: node gatectl.mjs
 */
const UPSTREAM = 'https://opencode.ai/zen/v1/chat/completions'
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Id kanonik ala OpenCode CLI: ~(ms<<12|counter) jadi 6 byte hex. */
function canonicalId(prefix, counter = 1) {
  const ms = Date.now()
  const payload = ~((ms << 12) | counter) & ((1 << 48) - 1)
  const head = payload.toString(16).padStart(12, '0')
  let suffix = ''
  for (let i = 0; i < 14; i++) suffix += BASE62[Math.floor(Math.random() * BASE62.length)]
  return `${prefix}_${head}${suffix}`
}

function toolset(names) {
  return names.map(n => ({ type: 'function', function: { name: n, description: 't', parameters: { type: 'object', properties: {} } } }))
}

const UA = 'opencode/1.19.0 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14'

async function fire({ label, model, tools = ['bash', 'glob', 'grep', 'read'], stream = true, ua = UA, encodedSession = true }) {
  const body = {
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    stream,
    max_tokens: 60,
  }
  if (tools !== null) body.tools = toolset(tools)
  const headers = {
    Authorization: 'Bearer public',
    'Content-Type': 'application/json',
    'User-Agent': ua,
    'x-opencode-client': 'desktop',
    'x-opencode-project': 'global',
    'x-opencode-session': encodedSession ? canonicalId('ses') : 'ses_' + Math.random().toString(16).slice(2, 14) + canonicalId('x').slice(4),
    'x-opencode-request': canonicalId('msg'),
    Accept: 'text/event-stream',
  }
  const t0 = Date.now()
  try {
    const r = await fetch(UPSTREAM, { method: 'POST', headers, body: JSON.stringify(body) })
    const txt = (await r.text()).slice(0, 200).replace(/\s+/g, ' ')
    let kind = 'unknown'
    const low = txt.toLowerCase()
    if (r.status === 200) kind = 'ok'
    else if (low.includes('within opencode')) kind = 'SHAPE-GATE (403)'
    else if (low.includes('freeusagelimiterror') || low.includes('usage limit')) kind = 'KUOTA (429)'
    else if (low.includes('not available in your country')) kind = 'GEO'
    console.log(`[${String(r.status)}] ${label.padEnd(28)} ${Date.now() - t0}ms  ${kind}`)
    if (kind !== 'ok' && kind !== 'SHAPE-GATE (403)') console.log(`     ${txt.slice(0, 130)}`)
    return { kind, status: r.status }
  } catch (e) {
    console.log(`[ERR] ${label.padEnd(28)} ${e?.message?.slice(0, 100)}`)
    return { kind: 'ERR', status: 0 }
  }
}

const model = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const control = process.argv[3] ?? 'reflection/beam-free'
console.log('egress: host ini\n')

// Kutub A: model yang kuotanya (diduga) habis, bentuk request sempurna.
await fire({ label: `${model} (bentuk penuh)`, model })
await new Promise(r => setTimeout(r, 3000))
// Kutub B: model kontrol yang di laptop 200 — kalau ini 200, gerbang LULUS.
await fire({ label: `${control} (kontrol)`, model: control })
await new Promise(r => setTimeout(r, 3000))
// Kutub C: negatif — UA bukan opencode, harus 403 kalau gerbangnya hidup.
await fire({ label: 'kontrol + UA curl (negatif)', model: control, ua: 'curl/8.0' })
