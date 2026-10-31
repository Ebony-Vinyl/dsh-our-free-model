/**
 * The regression gate for `vendor/channel-pack/pack.js` (issue #572).
 *
 * `src/` and `pack.js` are supposed to come from the same upstream commit, but
 * they have drifted before: rebuilding from a stale `src/` produced a bundle
 * ~1,100 lines smaller that still mounted cleanly, so nothing downstream
 * noticed until a user hit the re-opened defect (#308's empty-assistant-message
 * guard was one of them).
 *
 * Counting a few durable markers in the shipped bundle and in the freshly built
 * one turns that silent regression into a refused build. Kept in its own module
 * so the comparison can be tested without running esbuild.
 */

/**
 * Logic the shipped bundle must not lose.
 *
 * Only markers whose count must never *drop* belong here. Every entry has to be
 * present in the shipped bundle today; `staleMarkers()` reports the ones that
 * are not, so the list cannot rot silently. `toolResults.length === 0` is
 * deliberately absent: its direction is inverted between the two builds, so a
 * smaller count there is not a lost feature.
 */
export const PACK_MARKERS = [
  'collectHarnessSystem',
  'proseSuppressor',
  'createBlankReasoningSuppressor',
  'toolCalls.length === 0) continue',
  'createChannelFetch',
  'ChannelNetworkError',
]

/** Occurrences of every marker in `text`. */
export function countMarkers(text) {
  const counts = new Map()
  for (const marker of PACK_MARKERS) counts.set(marker, text.split(marker).length - 1)
  return counts
}

/**
 * Markers the rebuild carries fewer of than the shipped bundle.
 *
 * @returns {{ marker: string, before: number, after: number }[]} empty when the
 *   rebuild keeps every marker — the only case where writing is allowed.
 */
export function markerRegressions(shipped, built) {
  const before = countMarkers(shipped)
  const after = countMarkers(built)
  return PACK_MARKERS
    .filter(marker => after.get(marker) < before.get(marker))
    .map(marker => ({ marker, before: before.get(marker), after: after.get(marker) }))
}

/**
 * Markers that are absent from the shipped bundle, i.e. entries the list has
 * outgrown. A stale entry can never fire — `after < 0` is impossible — so it
 * silently stops protecting anything. Surfaced as a warning rather than an
 * error: a build is not wrong just because the list needs a refresh.
 */
export function staleMarkers(shipped) {
  const counts = countMarkers(shipped)
  return PACK_MARKERS.filter(marker => counts.get(marker) === 0)
}
