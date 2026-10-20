/**
 * What a refusal actually says, and what that means for the user.
 *
 * The probe records one line of upstream prose per model (`state` plus a
 * truncated `detail`), and until now that line reached the settings page and
 * nothing else: ten models read "暂不可用" with the same unreasoned badge, one
 * read "地区受限", and the page had no way to say *why* half a lane vanished or
 * what the user could do about it. The distinction lives entirely in the
 * wording, and the wording is stable enough to classify:
 *
 * - "we've detected abusive traffic from this IP address" is the exit address,
 *   not the model and not the account. Nine of ten models answered exactly
 *   this on 2026-10-20 from 50.7.250.107 while the picker still offered all
 *   ten; switching the exit is the only thing that fixes it, and re-probing the
 *   same exit cannot.
 * - "This model is not available in your country" is the model, on this
 *   country, and it survives an exit change only as far as the new country.
 * - "no such model" is the roster: a cached entry whose id upstream dropped
 *   (space-bunny-free on 2026-10-19), which must be pruned rather than shown.
 * - a quota line is time, not state — the next window answers, so it must not
 *   be turned into a refusal the request path can trip over.
 *
 * Nothing here talks to the network: it is a pure reading of text the probe has
 * already stored, which is what makes it testable against the real strings.
 *
 * @module src/verdict.js
 */

import { STATE } from './probe.js'

/** One word for the whole lane, which is what the free tab's tank shows. */
export const LANE = { ok: 'ok', partial: 'partial', refused: 'refused' }

/** Why one model did not answer. Every consumer switches on these codes. */
export const DETAIL_CLASS = {
  abusiveIp: 'abusive-ip',
  regionBlocked: 'region-blocked',
  throttled: 'throttled',
  gone: 'model-gone',
  unknown: 'unknown',
}

const RULES = [
  // Roster first: "no longer available" would otherwise read as a network
  // refusal, and a pruned id is a different fix from a blocked exit.
  { code: DETAIL_CLASS.gone, pattern: /no such model|unknown model|model_not_found|has been retired|is no longer available|not a valid model|model not found/i },
  { code: DETAIL_CLASS.abusiveIp, pattern: /abusive traffic|detected abusive|from this ip address|not available from your current network/i },
  { code: DETAIL_CLASS.regionBlocked, pattern: /not available in your country|not available in your region|not available in this location|this model is not available in/i },
  { code: DETAIL_CLASS.throttled, pattern: /rate.?limit|too many requests|quota|capacity|try again later|overloaded/i },
]

/**
 * Classify one recorded probe detail.
 *
 * @param {string} detail - the truncated upstream sentence the probe stored
 * @returns {string} one of `DETAIL_CLASS`
 */
export function classifyDetail(detail) {
  const text = typeof detail === 'string' ? detail : ''
  if (text === '') return DETAIL_CLASS.unknown
  for (const rule of RULES) if (rule.pattern.test(text)) return rule.code
  return DETAIL_CLASS.unknown
}

/** A verdict's class: the stored state when there is no detail to read. */
export function classOfVerdict(verdict) {
  if (verdict === null || verdict === undefined) return DETAIL_CLASS.unknown
  if (verdict.state === STATE.regionBlocked) return DETAIL_CLASS.regionBlocked
  if (verdict.state === STATE.throttled) return DETAIL_CLASS.throttled
  if (verdict.state === STATE.unavailable) {
    const byText = classifyDetail(verdict.detail)
    return byText === DETAIL_CLASS.unknown ? DETAIL_CLASS.abusiveIp : byText
  }
  return DETAIL_CLASS.unknown
}

/** The sentence a refused request gets, keyed by why it was refused. */
const HINTS = {
  [DETAIL_CLASS.abusiveIp]: 'upstream reports abusive traffic from this exit address; switch the network exit and re-probe',
  [DETAIL_CLASS.regionBlocked]: 'upstream does not serve this model in your region',
  [DETAIL_CLASS.gone]: 'the model is no longer on the upstream roster',
  [DETAIL_CLASS.throttled]: 'the free lane is rate-limiting this exit; the next window answers',
  [DETAIL_CLASS.unknown]: 'the last probe of this model was refused',
}

/**
 * Is the stored verdict recent enough to act on?
 *
 * A verdict is a reading, not a fact: the probe runs every
 * `probeIntervalMinutes`, and the exit can change between rounds. Acting on a
 * stale reading would block a model for an hour after the user fixed their
 * network, so anything older than two rounds is treated as no evidence at all
 * and the request is allowed through to find out for itself.
 */
export function isFresh(verdict, now, probeIntervalMinutes) {
  if (verdict === null || verdict === undefined) return false
  const minutes = Number.isFinite(Number(probeIntervalMinutes)) && Number(probeIntervalMinutes) > 0
    ? Number(probeIntervalMinutes)
    : 15
  const at = Number(verdict.at)
  if (!Number.isFinite(at) || at <= 0) return false
  return now - at <= minutes * 2 * 60_000
}

/**
 * The refusal a request for this model must report, or `null` to let it run.
 *
 * Only two readings are terminal enough to short-circuit a turn: the model is
 * hidden here, or upstream will not serve this model at all. A throttled lane
 * is *not* refused — the user's own request may well succeed where the 16-token
 * probe was told to wait, so that stays a live call.
 *
 * @param {string} modelId
 * @param {object} results - `availability.results`
 * @param {{ now?: number, probeIntervalMinutes?: number }} [options]
 * @returns {{ code: string, class: string, message: string, status: number } | null}
 */
export function refusalFor(modelId, results, options = {}) {
  const verdict = results?.[modelId]
  if (verdict === null || verdict === undefined) return null
  const now = options.now ?? Date.now()
  if (!isFresh(verdict, now, options.probeIntervalMinutes)) return null
  const kind = classOfVerdict(verdict)
  if (kind === DETAIL_CLASS.throttled) return null
  if (verdict.state !== STATE.unavailable && verdict.state !== STATE.regionBlocked) return null
  const region = verdict.state === STATE.regionBlocked
  // Upstream's own words lead the message. The picker's contract is that a
  // model the user already picked still fails on the *gateway's* answer rather
  // than on the plugin's opinion of it (`scripts/picker-test.mjs`), and that
  // holds even when the answer came from the probe: the stored detail is that
  // answer, verbatim. The action the user can take follows it in a parenthetical
  // so the sentence stays readable when a client renders one line.
  const detail = typeof verdict.detail === 'string' ? verdict.detail.trim() : ''
  const hint = HINTS[kind] ?? HINTS[DETAIL_CLASS.unknown]
  return {
    code: region ? 'REGION_BLOCKED' : 'LANE_REFUSED',
    class: kind,
    status: region ? 403 : 503,
    message: detail === ''
      ? `${modelId}: ${hint}`
      : `${detail} (${modelId}: ${hint})`,
  }
}

/**
 * The lane at a glance, for `/summary` and the free tab's diagnosis block.
 *
 * Counted over the roster the page shows, so the numbers always add up to the
 * rows beneath them — the stale `space-bunny-free` entry that sat in
 * `availability.results` for thirteen hours after upstream dropped it never
 * appears here, because it is not a row.
 *
 * @param {Array<object>} entries - the free lane's own catalog rows
 * @param {object} results - `availability.results`
 * @param {{ egress?: object|null, at?: number, refusedStreak?: number, probeIntervalMinutes?: number }} [context]
 */
export function laneView(entries, results, context = {}) {
  const counts = { ok: 0, abusiveIp: 0, regionBlocked: 0, throttled: 0, gone: 0, unknown: 0, total: 0 }
  // Injectable so a suite can age a round without waiting for one.
  const now = Number(context.now) || Date.now()
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || entry === undefined) continue
    if (entry.channel !== undefined && entry.channel !== null && entry.channel !== '') continue
    counts.total += 1
    const verdict = results?.[entry.id]
    if (verdict === undefined || verdict === null) { counts.unknown += 1; continue }
    if (verdict.state === STATE.available) { counts.ok += 1; continue }
    const kind = classOfVerdict(verdict)
    const key = kind === DETAIL_CLASS.abusiveIp ? 'abusiveIp'
      : kind === DETAIL_CLASS.regionBlocked ? 'regionBlocked'
        : kind === DETAIL_CLASS.throttled ? 'throttled'
          : kind === DETAIL_CLASS.gone ? 'gone' : 'unknown'
    counts[key] += 1
  }
  // `refused` is the state the user is actually in on a flagged exit: nothing
  // answers. `partial` is every other mixed reading, and it is not a problem
  // the page has to explain — the rows do.
  const state = counts.total === 0 ? LANE.partial
    : counts.ok === 0 ? LANE.refused
      : counts.ok === counts.total ? LANE.ok : LANE.partial
  return {
    state,
    counts,
    exitIp: typeof context.egress?.ip === 'string' ? context.egress.ip : '',
    country: typeof context.egress?.country === 'string' ? context.egress.country : '',
    at: Number(context.at) || 0,
    refusedStreak: Number.isFinite(Number(context.refusedStreak)) ? Number(context.refusedStreak) : 0,
    // The one code that says what to do next; when several models are refused
    // for different reasons the exit is still the shared one, so it wins.
    reason: counts.abusiveIp > 0 ? DETAIL_CLASS.abusiveIp
      : counts.regionBlocked > 0 && counts.ok === 0 ? DETAIL_CLASS.regionBlocked
        : counts.throttled > 0 && counts.ok === 0 ? DETAIL_CLASS.throttled
          : counts.gone > 0 && counts.ok === 0 ? DETAIL_CLASS.gone : '',
    stale: counts.total > 0 && !isFresh({ at: Number(context.at) || 0 }, now, context.probeIntervalMinutes),
  }
}
