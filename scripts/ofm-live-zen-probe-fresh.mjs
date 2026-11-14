/**
 * Live probe dengan sesi SELALU BARU tiap percobaan.
 *
 * `scripts/ofm-live-zen-probe.mjs` memakai `sessionForConversation('live-zen-probe')`
 * yang diingat 2 jam, jadi setiap probe mengirim id sesi yang sama. Kalau gate
 * menghitung kuota per-sesi, semua percobaan setelah yang pertama akan selalu 429
 * walaupun IP berubah.
 *
 *   node scripts/ofm-live-zen-probe-fresh.mjs [model-id] [label-seed]
 */
const modelId = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const seed = process.argv[3] ?? `fresh-${Date.now()}`

const { postStreamed } = await import('../src/http.js')
const up = await import('../src/upstream.js')
const { transportSkipReason } = await import('../src/transport.js')

// Seed unik → tidak ada sesi yang diingat → id baru di-mint dengan jam sekarang.
const session = up.canonicalizeSession(seed)
const body = {
  model: modelId,
  messages: [{ role: 'user', content: 'Jawab satu kata: siap?' }],
  stream: true,
  max_tokens: 32,
}
up.applyFingerprint(body, false)
console.log('model', modelId, '| seed', seed)
console.log('session', session, '| clock-ok', up.isUsableSession(session))

let deltas = 0
try {
  const result = await postStreamed({
    path: up.endpointFor(modelId),
    body,
    session,
    onData: payload => {
      deltas += 1
      if (deltas <= 2) console.log('delta', payload.slice(0, 100))
    },
  })
  console.log('STATUS', result.status, '| deltas', deltas)
} catch (error) {
  console.log('ERROR', error?.code, String(error?.message).slice(0, 200))
}
console.log('transport', transportSkipReason())
process.exit(0)
