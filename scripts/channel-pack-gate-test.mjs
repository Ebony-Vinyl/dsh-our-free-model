/**
 * The build gate that keeps `vendor/channel-pack/pack.js` from regressing (#572).
 *
 * The failure it exists for is silent by nature: a rebuild from a stale `src/`
 * produces a smaller bundle that still mounts, so nothing downstream complains
 * until a user hits the re-opened defect. These cases pin both halves — that a
 * lost marker is refused, and that a healthy rebuild is allowed through.
 *
 * Run: node scripts/channel-pack-gate-test.mjs
 */

import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { PACK_MARKERS, countMarkers, markerRegressions, staleMarkers } from './lib/channel-pack-gate.mjs'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const shipped = [
  'function collectHarnessSystem() {}',
  'const proseSuppressor = 1',
  'createBlankReasoningSuppressor(1)',
  'if (text.trim().length === 0 && toolCalls.length === 0) continue',
  'export { createChannelFetch }',
  'class ChannelNetworkError extends Error {}',
].join('\n')

// --- counting -------------------------------------------------------------

// countMarkers is scoped to the gate's own list, so the probe uses a real entry.
check('countMarkers counts every occurrence, not just presence',
  countMarkers('proseSuppressor proseSuppressor proseSuppressor').get('proseSuppressor'), 3)
check('countMarkers reports 0 for an absent marker',
  countMarkers('nothing here').get('proseSuppressor'), 0)

// --- the healthy case -----------------------------------------------------

check('an identical rebuild is not a regression',
  markerRegressions(shipped, shipped), [])
check('growth is not a regression',
  markerRegressions(shipped, `${shipped}\n${shipped}`), [])

// --- the #572 case --------------------------------------------------------

// Exactly what the issue measured: `src/` older than `pack.js` drops whole
// features while the bundle still loads.
const regressed = shipped
  .replace('function collectHarnessSystem() {}\n', '')
  .replace('if (text.trim().length === 0 && toolCalls.length === 0) continue\n', '')

check('a dropped marker is reported with its before/after counts',
  markerRegressions(shipped, regressed),
  [
    { marker: 'collectHarnessSystem', before: 1, after: 0 },
    { marker: 'toolCalls.length === 0) continue', before: 1, after: 0 },
  ])

// A rebuild that keeps the marker once where the shipped bundle had three has
// still lost two call sites — count, not presence, is what the gate compares.
check('a partially dropped marker is reported',
  markerRegressions('proseSuppressor proseSuppressor proseSuppressor', 'proseSuppressor'),
  [{ marker: 'proseSuppressor', before: 3, after: 1 }])

// --- staleness ------------------------------------------------------------

check('a marker the shipped bundle lacks is reported as stale',
  staleMarkers('proseSuppressor'), PACK_MARKERS.filter(marker => marker !== 'proseSuppressor'))
check('a shipped bundle containing every marker has none stale',
  staleMarkers(shipped), [])

// --- the real bundle ------------------------------------------------------

// Guards the list itself: an entry that no longer appears in the shipped bundle
// can never fire, so it would quietly stop protecting anything.
const bundle = fs.readFileSync(
  fileURLToPath(new URL('../vendor/channel-pack/pack.js', import.meta.url)), 'utf8')
const stale = staleMarkers(bundle)
check('every marker is present in the shipped pack.js', stale, [])
if (stale.length > 0) {
  console.log('       refresh scripts/lib/channel-pack-gate.mjs — these markers are gone from the bundle')
}

console.log(failures === 0 ? '\nall channel-pack gate checks passed' : `\n${failures} channel-pack gate check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
