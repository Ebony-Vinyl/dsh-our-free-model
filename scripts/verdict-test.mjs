/**
 * The refusal vocabulary: what the probe's stored sentence means, when it may
 * be acted on, and what the picker does with it.
 *
 * Every string asserted here was copied out of a real `availability.json`
 * (2026-10-20, exit 50.7.250.107) rather than invented, because the whole
 * feature is a reading of upstream prose: a classifier tuned to made-up wording
 * would pass while the live lane said something else. The prose is stable but
 * not guaranteed, so the *unknown* class is a first-class answer — it must
 * degrade to a described refusal, never to a silent pass or a wrong diagnosis.
 *
 * The membership cases pin the one behaviour change that is visible in the
 * picker: a lane refused for two consecutive rounds stops advertising, a single
 * refused round does not, and a chain whose every link is refused disappears
 * with it (a combo is never probed itself, so nothing else would remove it).
 *
 * Pure: no network, no timers.
 *
 * Run: node scripts/verdict-test.mjs
 */
import assert from 'node:assert/strict'
import { DETAIL_CLASS, LANE, classOfVerdict, classifyDetail, isFresh, laneView, refusalFor, refusedState, roundRefused } from '../src/verdict.js'
import { STATE } from '../src/probe.js'
import { computeMembership } from '../src/core/runtime.js'
import { ROUTE_MAIN, ROUTE_REGION } from '../src/adapter.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── the real sentences ───────────────────────────────────────────────────────
// Verbatim from the ten rows of `~/.dsh/our-free-model/availability.json`, cut
// where the probe cuts them (200 chars).
const ABUSIVE = "OpenCode's free models aren't available from your current network because we've detected abusive traffic from this IP address. This isn't related to your account. If you're on a VPN or proxy, turn it (cut)"
const REGION = 'This model is not available in your country'
const GONE = 'Error: no such model: space-bunny-free'
const THROTTLED = 'Rate limit reached for this session, try again later'
const MURKY = 'the upstream closed the stream before any header arrived'

check('abusive-traffic prose is the exit address, not the model', () => {
  assert.equal(classifyDetail(ABUSIVE), DETAIL_CLASS.abusiveIp)
})

check('a country refusal is region, even though it also says "not available"', () => {
  assert.equal(classifyDetail(REGION), DETAIL_CLASS.regionBlocked)
})

check('a dropped id wins over the network wording it is dressed in', () => {
  assert.equal(classifyDetail(GONE), DETAIL_CLASS.gone)
})

check('a quota line is time, not state', () => {
  assert.equal(classifyDetail(THROTTLED), DETAIL_CLASS.throttled)
})

check('unrecognized prose is `unknown`, never a silent pass', () => {
  assert.equal(classifyDetail(MURKY), DETAIL_CLASS.unknown)
  assert.equal(classifyDetail(''), DETAIL_CLASS.unknown)
  assert.equal(classifyDetail(undefined), DETAIL_CLASS.unknown)
})

check('classOfVerdict reads the state when the detail is missing', () => {
  assert.equal(classOfVerdict({ state: STATE.regionBlocked }), DETAIL_CLASS.regionBlocked)
  assert.equal(classOfVerdict({ state: STATE.throttled }), DETAIL_CLASS.throttled)
  // state=unavailable with no text is the refusal the lane has always meant;
  // it must not read as "unknown" and quietly stop being refused.
  assert.equal(classOfVerdict({ state: STATE.unavailable, detail: '' }), DETAIL_CLASS.abusiveIp)
})

// ── freshness ────────────────────────────────────────────────────────────────
const now = 1_800_000_000_000

check('a verdict from inside two probe rounds may be acted on', () => {
  assert.equal(isFresh({ at: now - 60_000 }, now, 15), true)
  assert.equal(isFresh({ at: now - 29 * 60_000 }, now, 15), true)
})

check('a verdict older than two probe rounds is not evidence', () => {
  assert.equal(isFresh({ at: now - 31 * 60_000 }, now, 15), false)
  assert.equal(isFresh({ at: 0 }, now, 15), false)
  assert.equal(isFresh(undefined, now, 15), false)
})

check('a nonsense interval falls back to 15 minutes instead of trusting the reading forever', () => {
  assert.equal(isFresh({ at: now - 31 * 60_000 }, now, 0), false)
  assert.equal(isFresh({ at: now - 60_000 }, now, 'x'), true)
})

// ── the refusal a turn may skip the round trip for ───────────────────────────
const fresh = detail => ({ state: STATE.unavailable, detail, at: now })
const options = { now, probeIntervalMinutes: 15 }

check('a fresh unfair-egress reading refuses the turn with the exit as the reason', () => {
  const refusal = refusalFor('deepseek-v4.1-flash-free', { 'deepseek-v4.1-flash-free': fresh(ABUSIVE) }, options)
  assert.equal(refusal.code, 'LANE_REFUSED')
  assert.equal(refusal.class, DETAIL_CLASS.abusiveIp)
  assert.equal(refusal.status, 503)
  assert.match(refusal.message, /deepseek-v4\.1-flash-free/)
  assert.match(refusal.message, /switch the network exit and re-probe/)
})

check('a country refusal keeps its own code, which maps to 403', () => {
  const refusal = refusalFor('beam-free', { 'beam-free': { state: STATE.regionBlocked, detail: REGION, at: now } }, options)
  assert.equal(refusal.code, 'REGION_BLOCKED')
  assert.equal(refusal.status, 403)
})

check('a throttled lane is not refused: the user\'s own request is longer than the probe\'s', () => {
  assert.equal(refusalFor('mimo-v2.6-flash-free', { 'mimo-v2.6-flash-free': { state: STATE.throttled, at: now } }, options), null)
})

check('a stale refusal lets the request find out for itself', () => {
  assert.equal(refusalFor('glm-5.3-flash-free', { 'glm-5.3-flash-free': { ...fresh(ABUSIVE), at: now - 40 * 60_000 } }, options), null)
})

check('an available or unprobed model is never refused', () => {
  assert.equal(refusalFor('a', { a: { state: STATE.available, at: now } }, options), null)
  assert.equal(refusalFor('b', {}, options), null)
  assert.equal(refusalFor('c', { c: { state: STATE.unknown, detail: MURKY, at: now } }, options), null)
})

// ── the lane at a glance ─────────────────────────────────────────────────────
const rows = ids => ids.map(id => ({ id }))
const TEN = rows(['big-pickle', 'beam-free', 'mimo-v2.6-flash-free', 'nemotron-3.5-super-vl-free', 'nemotron-3.5-lightning-free', 'jev-1.13-free', 'longcat-2.5-preview-free', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'minimax-m3.1-flash-free'])
const allRefused = () => Object.fromEntries(TEN.map(entry => [entry.id,
  entry.id === 'beam-free' ? { state: STATE.regionBlocked, detail: REGION, at: now } : { state: STATE.unavailable, detail: ABUSIVE, at: now }]))

check('ten refused rows are a refused lane that names the exit', () => {
  const view = laneView(TEN, allRefused(), { egress: { ip: '50.7.250.107' }, at: now, refusedStreak: 3, probeIntervalMinutes: 15 })
  assert.equal(view.state, LANE.refused)
  assert.equal(view.counts.total, 10)
  assert.equal(view.counts.ok, 0)
  assert.equal(view.counts.abusiveIp, 9)
  assert.equal(view.counts.regionBlocked, 1)
  assert.equal(view.reason, DETAIL_CLASS.abusiveIp)
  assert.equal(view.exitIp, '50.7.250.107')
  assert.equal(view.refusedStreak, 3)
  assert.equal(view.stale, false)
})

check('one answering model makes the lane partial, not refused', () => {
  const results = { ...allRefused(), 'glm-5.3-flash-free': { state: STATE.available, at: now } }
  const view = laneView(TEN, results, { at: now, probeIntervalMinutes: 15 })
  assert.equal(view.state, LANE.partial)
  assert.equal(view.counts.ok, 1)
})

check('an old round is reported as stale so the page does not speak for a network that moved', () => {
  const view = laneView(TEN, allRefused(), { at: now - 60 * 60_000, now, probeIntervalMinutes: 15 })
  assert.equal(view.stale, true)
})

check('the lane counts rows, so a verdict for a model that left the roster is invisible', () => {
  const ghost = { ...allRefused(), 'space-bunny-free': { state: STATE.unavailable, detail: ABUSIVE, at: now } }
  const view = laneView(TEN, ghost, { at: now, probeIntervalMinutes: 15 })
  assert.equal(view.counts.total, 10)
  assert.equal(view.counts.abusiveIp, 9)
})

check('channel rows are not part of the free lane', () => {
  const withChannel = [...TEN, { id: 'kilo:x', channel: 'kilo' }]
  assert.equal(laneView(withChannel, allRefused(), { at: now, probeIntervalMinutes: 15 }).counts.total, 10)
})

// ── what the picker advertises ───────────────────────────────────────────────
const settings = { exposeRegionModels: true }
const membershipOf = (streak, results, extra = {}) => computeMembership(TEN, { results, refusedStreak: streak }, { ...settings, ...extra })

check('one refused round is weather: every model stays advertised', () => {
  const membership = membershipOf(0, allRefused())
  // The country-blocked row lives on the region route by construction, so main
  // holds the nine refused-on-this-exit rows: one bad round must not prune them.
  assert.equal((membership[ROUTE_MAIN] ?? []).length, 9)
  assert.deepEqual(membership[ROUTE_REGION], ['beam-free'])
})

check('two refused rounds stop advertising the unfair-egress rows', () => {
  const membership = membershipOf(2, allRefused())
  assert.equal(membership[ROUTE_MAIN], undefined)
  // …while the region route still honours its own explicit opt-in: dropping a
  // country-blocked row the user asked to see would hide a fact, not fix one.
  assert.deepEqual(membership[ROUTE_REGION], ['beam-free'])
})

check('keepRefusedModels overrides the suppression', () => {
  const membership = membershipOf(5, allRefused(), { keepRefusedModels: true })
  assert.equal((membership[ROUTE_MAIN] ?? []).length, 9)
})

check('a refused chain is dropped once its every link is refused', () => {
  const combo = { id: 'combo:recommended-free', name: '推荐免费组', channel: 'combo', combo: ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free'] }
  const catalog = [...TEN, combo]
  const refused = computeMembership(catalog, { results: allRefused(), refusedStreak: 2 }, settings)
  assert.equal(refused[ROUTE_MAIN], undefined)
  // …but a chain with one dialable link survives the same round.
  const partly = computeMembership(catalog, {
    results: { ...allRefused(), 'glm-5.3-flash-free': { state: STATE.available, at: now } },
    refusedStreak: 2,
  }, settings)
  assert.equal((partly[ROUTE_MAIN] ?? []).includes('combo:recommended-free'), true)
})

check('a region refusal still lands on the region route, which is a separate advertisement', () => {
  const results = { 'beam-free': { state: STATE.regionBlocked, detail: REGION, at: now } }
  const membership = computeMembership([{ id: 'beam-free' }], { results, refusedStreak: 0 }, settings)
  assert.equal(membership[ROUTE_MAIN], undefined)
  assert.deepEqual(membership[ROUTE_REGION], ['beam-free'])
})

check('refused and region-blocked both mean an empty dial', () => {
  // The live exit mixes them — nine refused, one not served here — so a round
  // that counts only the refusals would read as "not refused" forever and the
  // two-round suppression could never fire.
  assert.equal(refusedState(STATE.unavailable), true)
  assert.equal(refusedState(STATE.regionBlocked), true)
  assert.equal(refusedState(STATE.available), false)
  assert.equal(refusedState(STATE.throttled), false)
  assert.equal(refusedState(STATE.unknown), false)
})

check('a round is refused when something refused and nothing answered', () => {
  // Live round at 10:24:46 was nine refusals, one region block and one
  // `fetch failed`; requiring every row to refuse would call that a healthy
  // lane and reset the streak — the exact thing the streak exists to prevent.
  assert.equal(roundRefused([STATE.unavailable, STATE.unavailable, STATE.regionBlocked]), true)
  assert.equal(roundRefused([STATE.unavailable, STATE.regionBlocked, STATE.unknown]), true)
  // One answer proves the lane is alive, no matter how many rows refused.
  assert.equal(roundRefused([STATE.unavailable, STATE.unavailable, STATE.available]), false)
  // A pure rate-limit window is not a refusal: throttling has its own backoff.
  assert.equal(roundRefused([STATE.throttled, STATE.throttled]), false)
  assert.equal(roundRefused([STATE.unknown, STATE.unknown]), false)
  assert.equal(roundRefused([]), false)
})

console.log(failures === 0 ? '\nverdict: refuse, prune and broadcast agree' : `\n${failures} verdict check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
