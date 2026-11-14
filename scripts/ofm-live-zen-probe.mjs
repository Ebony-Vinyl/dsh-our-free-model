// Live probe: one chat turn to the free lane through the fixed pipeline
// (env block + fresh session clock + Bun transport hop).
//
// Use after a quota window resets to verify the 2026-11-14 fixes end to end:
//   node scripts/ofm-live-zen-probe.mjs [model-id]

const modelId = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const { postStreamed } = await import('../src/http.js')
const up = await import('../src/upstream.js')
const { transportSkipReason } = await import('../src/transport.js')

const session = up.sessionForConversation('live-zen-probe')
const body = {
  model: modelId,
  messages: [{ role: 'user', content: 'Jawab satu kata: siap?' }],
  stream: true,
  max_tokens: 32,
}
up.applyFingerprint(body, false)
console.log('model', modelId)
console.log('session', session, '| clock-ok', up.isUsableSession(session))
const before = transportSkipReason()

let deltas = 0
try {
  const result = await postStreamed({
    path: up.endpointFor(modelId),
    body,
    session,
    onData: payload => {
      deltas += 1
      if (deltas <= 3) console.log('delta', payload.slice(0, 120))
    },
  })
  console.log('STATUS', result.status, '| deltas', deltas)
} catch (error) {
  console.log('ERROR', error?.code, error?.message?.slice(0, 300))
}
console.log('transport', transportSkipReason())
process.exit(0)
