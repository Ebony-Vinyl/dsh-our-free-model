/**
 * Subagent telemetry: what each delegated child is costing, and on which model.
 *
 * Why this is not already in the dashboard
 * ----------------------------------------
 * `store.js` aggregates usage by **day and model** — the right shape for "how
 * much did this lane cost me this week". A delegation tree is a different
 * question, and one the day/model buckets structurally cannot answer: a single
 * afternoon can put twenty children on the same model, and the frontier number
 * a user needs ("is this child still worth running?") is per child, not per
 * model.
 *
 * So this module keeps its own fold, keyed by the *parent* session and then by
 * child. It reads the harness's own projections rather than inventing a meter:
 *
 * - `subagentCatalog` on the parent names its direct children and their labels,
 *   which is the only place that mapping exists.
 * - `tokenUsage` on the child is the harness's own token meter. It is
 *   checkpointed per session, so a child that has already finished — or was
 *   evicted from memory — still reports what it spent. Hiding that would make a
 *   finished delegation look like it never ran.
 * - `sessionStats` on the child carries the decode window, which is what makes
 *   a speed figure comparable: wall-clock would fold in queueing and tool time.
 *
 * Both host halves are optional on purpose. A composition without
 * `sessionProjections` still serves models; it simply has no telemetry, which is
 * the same trade the rest of this plugin makes for `webServer`.
 *
 * @module src/subagent.js
 */

/** The delegation runtime's catalog projection. */
const CATALOG_KEY = 'subagentCatalog'

/** The harness's own token meter. */
const USAGE_KEY = 'tokenUsage'

/** The harness's own turn/step timing. */
const STATS_KEY = 'sessionStats'

/**
 * The floor below which a decode window is not a measurement.
 *
 * Same value as `store.js` uses for its speed charts: a call that produced its
 * whole answer in one frame has no observable decode window, and dividing by a
 * near-zero duration reports an absurd rate.
 */
const MIN_DECODE_MS = 250

/** Above this, the window is measuring something other than generation. */
const MAX_CREDIBLE_TPS = 250

/**
 * Read the direct children recorded on one parent session.
 *
 * Only direct children: a grandchild belongs to its own parent's catalog, and
 * flattening the tree here would double-count a chain of delegation.
 * @param projections - the session-projection registry.
 * @param parent - the parent session.
 * @returns `{ id, label, mode }` per child, in catalog order.
 */
export function childrenOf(projections, parent) {
  let state
  try {
    state = projections.stateOf(parent, CATALOG_KEY)
  } catch {
    return []
  }
  const values = state?.head?.values ?? state?.values
  if (!Array.isArray(values)) return []
  return values
    .filter(entry => typeof entry?.childId === 'string')
    .map(entry => ({
      id: entry.childId,
      label: typeof entry.label === 'string' ? entry.label : '',
      mode: typeof entry.mode === 'string' ? entry.mode : 'one-shot',
      createdAt: typeof entry.childCreatedAt === 'number' ? entry.childCreatedAt : 0,
    }))
}

/**
 * Normalize one session's token meter.
 * @param projections - the registry.
 * @param session - the live session, when there is one.
 * @param cachedRows - persisted checkpoint rows, for a cold session.
 * @returns totals, or undefined when nothing has been metered yet.
 */
export function usageOf(projections, session, cachedRows) {
  let state
  if (session !== undefined) {
    try {
      state = projections.stateOf(session, USAGE_KEY)
    } catch {
      state = undefined
    }
  }
  if (state === undefined) state = cachedRows?.[USAGE_KEY]?.val
  const totals = state?.totals
  if (totals === null || typeof totals !== 'object') return undefined
  const count = value => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  const result = {
    input: count(totals.uncachedInputTokens) || count(totals.input),
    output: count(totals.outputTokens),
    cacheRead: count(totals.cacheReadTokens),
    reasoning: count(totals.reasoningTokens),
  }
  if (result.input + result.output + result.cacheRead === 0) return undefined
  return result
}

/**
 * Read one session's turn/step statistics.
 * @param projections - the registry.
 * @param session - the live session, when there is one.
 * @param cachedRows - persisted checkpoint rows, for a cold session.
 * @returns the stats state, or undefined when the unit is absent.
 */
export function statsOf(projections, session, cachedRows) {
  if (session !== undefined) {
    try {
      const live = projections.stateOf(session, STATS_KEY)
      if (live !== undefined) return live
    } catch {
      // A cold session has no live state; fall through to its checkpoint.
    }
  }
  return cachedRows?.[STATS_KEY]?.val
}

/**
 * Derive the two figures that explain a child's cost and speed.
 *
 * - **cache hit rate** is the share of *billed input* served from the prompt
 *   cache: `cacheRead / (cacheRead + uncachedInput)`. It is the reason a child
 *   showing a million cached tokens can still be cheap.
 * - **tokens per second** is decode speed, `decodeTokens / decodeMs`, guarded by
 *   the same window rules `store.js` applies so the two surfaces cannot disagree
 *   about what a credible speed is.
 *
 * Either figure is omitted rather than reported as zero: an unmeasurable rate is
 * not a slow rate.
 * @param usage - normalized totals, when metered.
 * @param stats - the `sessionStats` state, when present.
 * @returns the measurable figures.
 */
export function metricsOf(usage, stats) {
  const result = {}
  if (usage !== undefined) {
    const billed = usage.cacheRead + usage.input
    if (billed > 0) result.cacheHitRate = usage.cacheRead / billed
  }
  if (stats !== null && typeof stats === 'object') {
    const decodeMs = Number(stats.decodeMs)
    const tokens = Number(stats.decodeTokens)
    if (Number.isFinite(decodeMs) && decodeMs >= MIN_DECODE_MS && Number.isFinite(tokens) && tokens > 0) {
      const tps = (tokens / decodeMs) * 1000
      // A rate above the ceiling means the window caught something other than
      // generation; reporting it would make the column untrustworthy.
      if (Number.isFinite(tps) && tps <= MAX_CREDIBLE_TPS) result.tokensPerSecond = Math.round(tps)
    }
  }
  return result
}

/**
 * Describe every direct child of one parent session.
 * @param deps - live services plus the checkpoint reader.
 * @param parentId - the parent session id.
 * @returns one flat row per child; empty when the parent is not resident.
 */
export function describeChildren(deps, parentId) {
  const { sessions, projections, checkpointOf } = deps
  if (sessions === undefined || projections === undefined) return []
  const parent = sessions.get(parentId)
  if (parent === undefined) return []
  const rows = []
  for (const child of childrenOf(projections, parent)) {
    const live = sessions.get(child.id)
    let provider
    let model
    if (live !== undefined) {
      const config = live.requestHeader()?.config
      if (config !== undefined) {
        provider = config.provider
        model = config.model
      }
    }
    const cached = live === undefined && checkpointOf !== undefined ? checkpointOf(child.id) : undefined
    const usage = usageOf(projections, live, cached)
    rows.push({
      id: child.id,
      label: child.label,
      mode: child.mode,
      live: live !== undefined,
      ...provider === undefined ? {} : { provider, model },
      ...usage === undefined ? {} : { usage },
      ...metricsOf(usage, statsOf(projections, live, cached)),
    })
  }
  return rows
}

/**
 * Fold a set of child rows into the one-line summary a strip shows.
 * @param rows - `describeChildren` output.
 * @returns counts and totals; `live` counts children still resident.
 */
export function summarize(rows) {
  const live = rows.filter(row => row.live === true)
  let input = 0
  let output = 0
  let cacheRead = 0
  for (const row of rows) {
    input += row.usage?.input ?? 0
    output += row.usage?.output ?? 0
    cacheRead += row.usage?.cacheRead ?? 0
  }
  return { total: rows.length, live: live.length, input, output, cacheRead }
}
