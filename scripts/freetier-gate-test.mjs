/**
 * The free lane's client gate is named for what it is (issue #310).
 *
 * The upstream answers a client it does not recognise with 403 FreeTierError —
 * "OpenCode's free tier can only be used from within OpenCode". The stock
 * classifier filed that under INVALID_CREDENTIAL: the settings page told users
 * their credential was bad, and a credential refusal wipes the cached roster
 * and sends people re-installing for a problem no credential can fix. The
 * availability probe's `stateOf` matched neither "unavailable" nor any routing
 * wording in the message, so the verdict stayed `unknown` and every dead model
 * sat in the picker, failing each turn it was picked.
 *
 * These checks run the real classifier and the real probe against a gateway
 * stand-in that hands back the refusal verbatim, and read the two verdicts the
 * user actually sees: the failure's code, and the probe's state.
 *
 * Run: node scripts/freetier-gate-test.mjs
 */
import { chatFrames, stubUpstream } from './lib/fake-kernel.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** The refusal exactly as the upstream spells it (issue #288/#310 transcripts). */
const GATE_PAYLOAD = {
  type: 'error',
  error: {
    type: 'FreeTierError',
    message: "OpenCode's free tier can only be used from within OpenCode. Download it at https://opencode.ai and keep building.",
  },
}

// The probe imports the lane base at module load, so the stand-in must be
// standing before the import — same order the adapter tests use.
const stub = await stubUpstream({
  listing: ['gate-model-free', 'open-model-free'],
  answer: model => model === 'gate-model-free'
    ? { status: 403, body: JSON.stringify(GATE_PAYLOAD) }
    : { body: chatFrames('fine') },
})
process.env.OUR_FREE_MODEL_BASE = stub.base
const { CODE, classifyFailure } = await import('../src/http.js')
const { probeModel, STATE } = await import('../src/probe.js')

// --- The classifier: the refusal keeps its own name, not the credential's. ---
const typed = classifyFailure(403, GATE_PAYLOAD)
check('403 FreeTierError is a lane lock', typed.code, CODE.laneLocked)
check('it does not read as INVALID_CREDENTIAL', typed.code === CODE.credential, false)
check('it keeps the upstream type', typed.type, 'FreeTierError')
check('it keeps the upstream message', typed.message, GATE_PAYLOAD.error.message)

// The upstream may spell the same gate without the structured type; the prose
// alone must classify the same way, or a wire change re-opens the hole.
const prose = classifyFailure(403, { error: { message: "OpenCode's free tier can only be used from within OpenCode." } })
check('the prose alone classifies as a lane lock', prose.code, CODE.laneLocked)

// --- The probe: a locked model stops advertising itself. ---
const entry = id => ({ id, name: id, availability: 'available', vision: false, reasoning: true, contextWindow: 128000, maxOutput: 8192 })
const locked = await probeModel(entry('gate-model-free'), { attributionUserAgent: 'test/1.0' })
check('the locked model probes unavailable', locked.state, STATE.unavailable)
check('the probe detail carries the upstream words', locked.detail.startsWith("OpenCode's free tier can only be used from within OpenCode"), true)

const open = await probeModel(entry('open-model-free'), { attributionUserAgent: 'test/1.0' })
check('an open model still probes available', open.state, STATE.available)

// --- The classifier's neighbours are untouched: the gate must not swallow them. ---
const credential = classifyFailure(401, { error: { type: 'authentication_error', message: 'invalid api key' } })
check('a plain 401 still reads as a credential', credential.code, CODE.credential)
const signature = classifyFailure(403, { error: { type: 'signature_error', message: 'signature rejected' } })
check('a signature refusal still names the transit', signature.code, CODE.transport)
const region = classifyFailure(403, { error: { type: 'RegionError', message: 'This model is not available in your country' } })
check('a region refusal still reads as region-blocked', region.code, CODE.region)

await stub.close()
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`)
// Let Node drain the closed fetch/server handles. Calling process.exit here
// races libuv's Windows socket teardown and can assert after all checks pass.
process.exitCode = failures === 0 ? 0 : 1
