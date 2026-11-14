/**
 * Model measurement: the text test this lane runs itself, and the figures the
 * site publishes for the same models.
 *
 * The two halves answer the same question — "how is this model actually
 * serving?" — from opposite directions. `measureModelTest` establishes it by
 * sending the smallest request that can produce a verdict; the second half
 * reads the site's own hourly statistics so a card can show the strip the site
 * shows, rather than an invented one.
 *
 * They share a module because the release set has a hard ceiling: updaters from
 * 1.3.1 and 2.5.9 reject any manifest listing more than 80 files, so a new
 * module of this size cannot simply be added. Folding it in beside the
 * measurement it complements keeps old installs upgradable.
 *
 * Text-test validation adapted from upstream PR #491; timing, cancellation and
 * persistence complete issue #462.
 */
import { CODE, UpstreamError } from './http.js'
import { decodeWindow } from './store.js'
import { windowTokens } from './stream.js'
export const MODEL_TEST_TIMEOUT_MS = 300_000

/** Only a nonempty, normally finished tool-free answer establishes a successful text test. */
export async function measureModelTest(stream, now = Date.now) {
  const started = now()
  let firstFrame
  let sawReasoning = false
  let finished = false
  let text = ''
  let usage
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
      if (typeof chunk.text === 'string' && chunk.text.length > 0 && firstFrame === undefined) firstFrame = now()
      if (chunk.type === 'reasoning-delta' && chunk.text?.length > 0) sawReasoning = true
      if (chunk.type === 'text-delta') text += chunk.text ?? ''
    }
    if (chunk.type === 'tool-call-delta' || (chunk.type === 'block-end' && chunk.block?.type === 'tool-call'))
      throw new UpstreamError('Text test returned an unexpected tool call', CODE.server)
    if (chunk.type === 'usage') usage = chunk.usage
    if (chunk.type === 'finish') {
      if (chunk.upstreamFinish !== undefined && !['stop', 'end_turn', 'stop_sequence'].includes(chunk.upstreamFinish))
        throw new UpstreamError('Text test did not finish normally: ' + String(chunk.upstreamFinish), CODE.server)
      if (chunk.reason?.kind !== 'stop')
        throw new UpstreamError(chunk.reason?.failure?.message ?? chunk.reason?.kind ?? 'Text test did not finish normally', chunk.reason?.failure?.code ?? CODE.server)
      finished = true
    }
  }
  if (!finished) throw new UpstreamError('Text test ended without a normal finish', CODE.empty)
  if (!text.trim()) throw new UpstreamError('Text test returned no response text', CODE.empty)
  const ended = now()
  const measured = decodeWindow(firstFrame === undefined ? 0 : ended - firstFrame, windowTokens(usage, sawReasoning), true)
  return {
    totalMs: ended - started, latencyMs: ended - started,
    ttftMs: firstFrame === undefined ? ended - started : firstFrame - started,
    outputTokens: usage?.outputTokens ?? 0, reasoningTokens: usage?.reasoningTokens ?? 0,
    tokensPerSecond: measured.tps, sample: text.slice(0, 60), text: text.slice(0, 2000),
  }
}

/** Bound the whole test, including a route chain's retries, not just an individual upstream request. */
export async function runModelTest(createStream, { signal, timeoutMs = MODEL_TEST_TIMEOUT_MS, now = Date.now } = {}) {
  const controller = new AbortController()
  const cancellation = () => signal?.reason instanceof Error ? signal.reason : new UpstreamError('Text test cancelled', CODE.aborted)
  const forwardAbort = () => controller.abort(cancellation())
  let timer
  let onAbort
  let iterator
  if (signal?.aborted) forwardAbort()
  else signal?.addEventListener('abort', forwardAbort, { once: true })
  try {
    controller.signal.throwIfAborted()
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', onAbort, { once: true })
    })
    timer = setTimeout(() => controller.abort(new UpstreamError('Text test exceeded its total time budget', CODE.timeout)), timeoutMs)
    iterator = createStream(controller.signal)
    return await Promise.race([measureModelTest(iterator, now), aborted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
    if (onAbort) controller.signal.removeEventListener('abort', onAbort)
    // Adapter.return() aborts its pending next() before awaiting generator cleanup.
    if (controller.signal.aborted) {
      try { Promise.resolve(iterator?.return?.()).catch(() => {}) } catch { /* the original error wins */ }
    }
  }
}

/** Keep manual samples apart from the automatic round so an older probe cannot erase them. */
export function modelAvailability(id, snapshot, listed = false) {
  // 旧出口的测量仍保留在磁盘，但不再作为当前出口的可用性判定。
  const probeRow = listed ? undefined : snapshot?.results?.[id]
  const manualRow = snapshot?.manualResults?.[id]
  const probe = probeRow?.stale === true ? undefined : probeRow
  const manual = manualRow?.stale === true ? undefined : manualRow
  // Compare a probe's request time with the completed manual measurement, so
  // an older in-flight probe cannot supersede it merely by finishing later.
  // Older saved snapshots have only `at`, which retains their previous order.
  const measured = manual && (!probe || manual.at >= (probe.startedAt ?? probe.at)) ? manual : probe
  return {
    availabilitySource: measured === manual && manual ? 'manual'
      : measured?.source === 'passive' ? 'passive'
        : listed ? 'listing' : 'probe',
    availability: measured?.state ?? 'unknown',
    detail: measured?.detail ?? '', probedAt: measured?.at ?? 0,
    ttftMs: measured?.ttftMs, latencyMs: measured?.latencyMs,
  }
}

// ── the site's own per-model figures ─────────────────────────────────────────
//
// The model square at the site root draws one performance strip per card: a
// success-rate bar of 24 hourly ticks, the average latency, the output speed,
// and a 详情 button that opens the trend charts. These functions read the same
// numbers from the same endpoint so the plugin's cards show the same strip
// rather than an invented one.
//
// The endpoint (`GET /api/perf-metrics/summary?hours=24`) is public — no
// credential — and answers every model in one document, each with its own
// `recent_success_series`. It sends no CORS headers, so a page served from the
// harness cannot call it directly; index.js hops through it.
//
// Two rules are enforced, both learned from the live data:
//
// 1. **A window that spans a channel change is not a verdict.** Two relayed
//    models were moved onto a different upstream mid-window; their 24h rate
//    still averages in the hours of fast failures from the lane they left, so it
//    reads ~3% while the last hour reads ~93%. Such a model is reported as
//    `settling` and its card draws no strip — a wrong number is worse than none.
//
// 2. **No endpoint, no strip.** When the site does not answer, the map is empty
//    and every card renders exactly as it did before this feature existed.

/** How long one metrics read may take before the page gets an empty map. */
const METRICS_TIMEOUT_MS = 6000

/** The window the strip describes, in hours. The site's own strip says 24. */
export const WINDOW_HOURS = 24

/**
 * A model's window rate and its recent hour may differ by this much before the
 * figure is withheld. The relay move left a 90-point gap; ordinary drift on a
 * busy day stays well inside 20 (the live minimax card swings 57→96 across the
 * day and is still shown).
 */
const SETTLING_GAP = 30

/**
 * The site root, derived from the lane's own base (`…/eac/v1` → `…`).
 *
 * The metrics endpoint lives beside the panel, not under the signed lane, so
 * the `/eac/v1` suffix is dropped rather than rewritten. A base that does not
 * look like a URL yields null and the feature stays off.
 */
export function siteRootFor(base) {
  const text = String(base ?? '').trim()
  if (text === '') return null
  let url
  try { url = new URL(text) } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  // Drop the lane's own mount (`/eac/v1`, `/v1`) so the result is the site root
  // the panel and its API are served from. A bare `/eac` is dropped too, for a
  // base that names only the mount and no API version.
  const path = url.pathname
    .replace(/\/(?:eac\/)?v1\/?$/i, '')
    .replace(/\/eac\/?$/i, '')
    .replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/**
 * A finite non-negative number, or null.
 *
 * `null` and `''` must stay null rather than becoming 0: the endpoint uses null
 * for "no sample in this hour", and `Number(null)` is 0 — which would paint a
 * red 0% tick, or drop a latency line to the floor, for an hour that simply had
 * no traffic.
 */
function metricOf(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * One tick of the success bar.
 *
 * The site colours each hourly tick by its own rate — emerald at 99 and above,
 * amber from 90, red below — so a glance reads the shape of the day, not just
 * its average. `null` marks an hour with no sample: the site draws those grey.
 */
function tickOf(row) {
  return metricOf(row?.success_rate)
}

/**
 * Reduce one model's entry to what the card draws.
 *
 * Returns null when the entry carries nothing worth showing, and
 * `{ settling: true }` when its window rate disagrees with how it is serving
 * now by more than {@link SETTLING_GAP} points.
 *
 * The comparison deliberately skips the final bucket. The series ends with the
 * hour still in progress (the endpoint's `window_end` is "now"), so that sample
 * covers however many minutes have elapsed — three, or fifty-nine. Comparing a
 * partial hour against a 24-hour average compares incomparable things and made
 * the strip appear and disappear as the hour filled: on live data one model
 * read a 34-point gap three minutes into the hour and an 18-point gap minutes
 * later, flipping between hidden and shown. The newest *complete* hour is a
 * settled sample, so the verdict stops flapping without changing which models
 * are withheld.
 *
 * The reference is a recent hour rather than a median of the window on purpose:
 * this endpoint reports hours with no traffic as 0 rather than null, so a median
 * over the whole series is dominated by quiet hours and stops noticing the very
 * upstream switch this check exists to catch.
 */
export function perfFrom(entry) {
  if (entry === null || typeof entry !== 'object') return null
  const rate = metricOf(entry.success_rate)
  if (rate === null) return null
  const latency = metricOf(entry.avg_latency_ms)
  const speed = metricOf(entry.avg_tps)

  const series = Array.isArray(entry.recent_success_series) ? entry.recent_success_series : []
  const ticks = series.map(tickOf)
  // Everything but the in-progress bucket. With a single bucket there is no
  // complete hour to compare against, so the window rate stands unexamined.
  const complete = ticks.slice(0, -1).filter(value => value !== null)
  const reference = complete.length > 0 ? complete[complete.length - 1] : null

  // A window rate that disagrees violently with the recent complete hour
  // describes a window that spanned a change of upstream, not the model as it
  // serves now.
  if (reference !== null && Math.abs(reference - rate) > SETTLING_GAP) {
    return { settling: true, rate, newest: reference }
  }

  return {
    rate,
    latencyMs: latency,
    speed,
    // Every hourly sample, oldest first: the bar the card draws.
    ticks,
    windowHours: series.length > 0 ? series.length : WINDOW_HOURS,
  }
}

/**
 * One point of a trend chart, from the per-model series.
 *
 * The site draws two charts from this one series: latency over time and
 * availability over time. Both read the same hourly rows, so they are reduced
 * together rather than in two passes.
 */
function pointOf(row) {
  if (row === null || typeof row !== 'object') return null
  const ts = metricOf(row.ts)
  if (ts === null) return null
  return {
    ts,
    latencyMs: metricOf(row.avg_latency_ms),
    ttftMs: metricOf(row.avg_ttft_ms),
    rate: metricOf(row.success_rate),
    speed: metricOf(row.avg_tps),
  }
}

/**
 * The trend series for one model, oldest first.
 *
 * A point with no latency sample keeps its slot so the two charts stay aligned
 * in time; the renderer skips it when drawing the line.
 */
export function seriesFrom(entry) {
  const rows = Array.isArray(entry?.series) ? entry.series : []
  return rows.map(pointOf).filter(point => point !== null)
}

/**
 * Read one model's full trend series (`GET /api/perf-metrics?model=…`).
 *
 * The summary endpoint answers every model's headline figures in one request;
 * the per-model endpoint is the only one that carries the hourly series. The
 * card asks for this only when its 详情 is opened, so a roster of twelve cards
 * costs one request until the reader actually looks.
 */
export async function readSeries({ root, modelId, fetch, signal, timeoutMs = METRICS_TIMEOUT_MS }) {
  if (root === null || root === undefined || typeof modelId !== 'string' || modelId === '') return null
  // Already cancelled: do not spend a round trip on a request nobody will read.
  if (signal?.aborted === true) return null
  const url = `${root}/api/perf-metrics?model=${encodeURIComponent(modelId)}&hours=${WINDOW_HOURS}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { return null }
    const series = seriesFrom(payload?.data)
    if (series.length === 0) return null
    return {
      series,
      windowStart: metricOf(payload?.data?.window_start),
      windowEnd: metricOf(payload?.data?.window_end),
    }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}

/**
 * Read every model's figures from the site in one request.
 *
 * The endpoint answers all models together, so this is one round trip rather
 * than one per model. The map is keyed by the id the site spells, which is the
 * same id the catalog uses. Models the site does not answer for are absent
 * rather than present-and-null: absence is what the card renders as "no strip".
 *
 * The site's root is deliberately not echoed back: it is the co-paid gateway's
 * host, the seal keeps it server-side, and the page never reads it. Only the
 * figures travel.
 *
 * Never throws — a failure is the same answer as "the site has no figures",
 * which the card already handles by drawing nothing.
 */
export async function readPerf({ root, fetch, signal, timeoutMs = METRICS_TIMEOUT_MS }) {
  if (root === null || root === undefined) return { models: {} }
  // Already cancelled: do not spend a round trip on a request nobody will read.
  if (signal?.aborted === true) return { models: {} }
  const url = `${root}/api/perf-metrics/summary?hours=${WINDOW_HOURS}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } })
    if (!response.ok) return { models: {} }
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { return { models: {} } }
    const rows = payload?.data?.models
    if (!Array.isArray(rows)) return { models: {} }
    const models = {}
    for (const row of rows) {
      const id = typeof row?.model_name === 'string' ? row.model_name.trim() : ''
      if (id === '') continue
      const perf = perfFrom(row)
      if (perf !== null) models[id] = perf
    }
    return {
      models,
      windowStart: metricOf(payload?.data?.window_start),
      windowEnd: metricOf(payload?.data?.window_end),
    }
  } catch {
    return { models: {} }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.('abort', onAbort)
  }
}
