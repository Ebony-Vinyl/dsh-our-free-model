/**
 * A refusal the probe already recorded must cost zero round trips.
 *
 * The failure this pins is invisible in a log: a turn on a flagged exit walked
 * all three links of `combo:recommended-free`, each one spending a full request
 * to be told the same sentence, and the user waited through all of it to read
 * the *last* link's wording. The chain now skips links the probe refused and,
 * when nothing is dialable, ends on the first refusal — which names the exit
 * instead of a model that happened to fail last.
 *
 * Both cases are proven without a network: a path that refuses before dialing
 * cannot reach one, so `attempts: 0` plus the LANE_REFUSED code is the proof
 * that nothing was sent.
 *
 * Run: node scripts/refusal-fast-fail-test.mjs
 */
import assert from 'node:assert/strict'
import { STATE } from '../src/probe.js'

// The dial-because-it-must cases below need a socket that refuses instantly
// instead of the real gateway: this suite has to stay offline and cost no quota.
// The base is read once, when `src/upstream.js` is first evaluated, so it is set
// before the adapter is imported — hence the dynamic import.
process.env.OUR_FREE_MODEL_BASE = 'http://127.0.0.1:9'
const { FreeModelAdapter, ROUTE_MAIN } = await import('../src/adapter.js')

const ABUSIVE = "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or proxy, turn it"
const MODELS = ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'space-bunny-free']
const COMBO = 'combo:recommended-free'
const TASK = 'what is a TCP handshake?'

const CATALOG = [
  ...MODELS.map(id => ({ id, name: id, channel: undefined })),
  { id: COMBO, name: '推荐免费组', channel: 'combo', combo: MODELS, strategy: 'fallback' },
]

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

async function drive({ model, results, refusedStreak = 2, settings = {} }) {
  const turns = []
  const controller = new AbortController()
  const adapter = new FreeModelAdapter({
    state: () => ({
      catalog: CATALOG,
      membership: { [ROUTE_MAIN]: [COMBO, ...MODELS] },
      settings: { enabled: true, defaultMaxTokens: 32768, streamRecovery: false, probeIntervalMinutes: 15, ...settings },
      availability: { at: Date.now(), egress: { ip: '50.7.250.107' }, refusedStreak, results },
      attributionUserAgent: 'offline-refusal-test',
    }),
    recordUsage: () => {},
    recordTurn: row => turns.push(row),
    warn: () => {},
  })
  const chunks = []
  try {
    for await (const chunk of adapter.stream({
      provider: ROUTE_MAIN,
      model,
      maxTokens: 4096,
      sessionId: 'refusal-fast-fail-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: TASK }] }],
      signal: controller.signal,
    })) chunks.push(chunk)
  } finally {
    controller.abort()
  }
  return {
    turns,
    chunks,
    finish: chunks.find(chunk => chunk.type === 'finish')?.reason,
    text: chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join(''),
  }
}

const refused = () => Object.fromEntries(MODELS.map(id => [id, { state: STATE.unavailable, detail: ABUSIVE, at: Date.now() }]))

await check('a single refused model ends the turn before dialing', async () => {
  const run = await drive({ model: MODELS[0], results: refused() })
  assert.equal(run.finish?.kind, 'error')
  assert.equal(run.finish?.failure?.code, 'LANE_REFUSED')
  // The stored detail leads: the picker's contract is that a picked model fails
  // on the gateway's own words, and the probe stored exactly those words.
  assert.ok(run.finish.failure.message.startsWith(ABUSIVE.slice(0, 60)), run.finish.failure.message)
  assert.match(run.finish.failure.message, new RegExp(MODELS[0]))
  assert.equal(run.text, '')
  assert.equal(run.turns.length, 1)
  assert.equal(run.turns[0].attempts, 0, 'no candidate was attempted')
  assert.equal(run.turns[0].ok, false)
})

await check('a chain whose every link is refused ends on the first refusal', async () => {
  const run = await drive({ model: COMBO, results: refused() })
  assert.equal(run.finish?.failure?.code, 'LANE_REFUSED')
  // The first link's refusal, not the last link's wording: the sentence the user
  // reads has to be the one that explains the exit.
  assert.ok(run.finish.failure.message.startsWith(ABUSIVE.slice(0, 60)), run.finish.failure.message)
  assert.match(run.finish.failure.message, new RegExp(`\\(${MODELS[0]}:`))
  assert.equal(run.turns[0].attempts, 0)
})

await check('an unavailable model that is not the first link does not refuse the chain', async () => {
  // Only the tail is refused. Proving the chain still *tries* would need a
  // network, so this asserts the filter's own answer instead: the tail is
  // refused, the head is not, and the head is what the chain would dial.
  const results = { [MODELS[2]]: { state: STATE.unavailable, detail: ABUSIVE, at: Date.now() } }
  const { refusalFor } = await import('../src/verdict.js')
  assert.equal(refusalFor(MODELS[0], results, { probeIntervalMinutes: 15 }), null)
  assert.equal(refusalFor(MODELS[2], results, { probeIntervalMinutes: 15 })?.code, 'LANE_REFUSED')
})

await check('a country refusal names the country, not the exit', async () => {
  const results = { [MODELS[0]]: { state: STATE.regionBlocked, detail: 'This model is not available in your country', at: Date.now() } }
  const run = await drive({ model: MODELS[0], results })
  assert.equal(run.finish?.failure?.code, 'REGION_BLOCKED')
})

await check('a throttled lane is dialed, not refused: the stored sentence is about the probe\'s token budget', async () => {
  // Refusing here would turn a two-minute rate limit into a hard stop for the
  // user's much longer request, so the verdict must not be acted on. The turn
  // does go on to dial, which cannot be observed offline; the code it ends with
  // is therefore only asserted to not be the refusal.
  const results = { [MODELS[0]]: { state: STATE.throttled, detail: 'Rate limit reached', at: Date.now() } }
  const run = await drive({ model: MODELS[0], results })
  assert.notEqual(run.finish?.failure?.code, 'LANE_REFUSED')
  assert.ok((run.turns[0]?.attempts ?? 0) >= 1, 'the turn did dial instead of refusing')
})

console.log(failures === 0 ? '\nrefusal: a known refusal costs no round trip' : `\n${failures} refusal check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
