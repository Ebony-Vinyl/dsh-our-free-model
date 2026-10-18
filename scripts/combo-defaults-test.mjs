/**
 * Regression tests for the recommended-free-model combo default.
 *
 * These lock in the two behaviours the author flagged as regressions when the
 * default combo first landed:
 *
 *   1. The default combo must NOT be merged into an install that already has a
 *      settings.json — only a genuinely fresh install (no settings.json yet)
 *      receives it once. JsonStore shallow-merges SETTINGS_INITIAL over the
 *      saved file, so seeding the chain there would pollute every existing
 *      user's picker (issue raised on PR #421 / #424).
 *   2. A combo whose members are all free-group models follows the free group's
 *      visibility: it disappears when `hideFreeModels` is on AND when the whole
 *      free lane is down (lane-wide refusal), not only when the user hides it.
 *
 * Run: node scripts/combo-defaults-test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRuntimeStores, computeMembership } from '../src/core/runtime.js'
import { ROUTE_MAIN } from '../src/adapter.js'
import { STATE } from '../src/probe.js'
import { DEFAULT_RECOMMENDED_COMBO } from '../src/store.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// ── fresh install seeds the default combo exactly once ──────────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdef-fresh-'))
  const stores = createRuntimeStores({ dataDir: dir })
  const combos = stores.settings.get().combos
  check('a fresh install (no settings.json) seeds the recommended combo',
    combos.map(row => row.id), ['combo:recommended-free'])
  check('the seeded combo keeps its members', combos[0]?.models,
    ['deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'space-bunny-free'])
  stores.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── an existing settings.json without combos is NOT polluted ────────────────
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdef-existing-'))
  fs.writeFileSync(path.join(dir, 'settings.json'),
    JSON.stringify({ version: 1, enabled: true }), { mode: 0o600 })
  const stores = createRuntimeStores({ dataDir: dir })
  check('an existing settings.json with no combos stays unpolluted',
    stores.settings.get().combos, [])
  stores.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── an existing settings.json that already has combos keeps the user value ──
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-cdef-user-'))
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    version: 1,
    combos: [{ id: 'combo:mine', name: 'My Chain', models: ['x', 'y'], strategy: 'fallback', stickyLimit: 1, enabled: true }],
  }), { mode: 0o600 })
  const stores = createRuntimeStores({ dataDir: dir })
  check('an existing settings.json keeps the user’s own combos',
    stores.settings.get().combos.map(row => row.id), ['combo:mine'])
  stores.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}

// ── a pure-free combo follows the free-group visibility policy ──────────────
// Free-lane models carry NO `channel` field (undefined) in the real catalog —
// `isModelHidden`'s `!entry.channel` branch is what hides them under
// `hideFreeModels`. The combo lane sets `channel: 'combo'` and derives its
// `lanes` from its members' channels (`entry.channel ?? 'free'`).
const baseEntry = id => ({
  id,
  vision: true, reasoning: true, contextWindow: 131072, maxOutput: 8192, canDisableThinking: true,
})
const freeModel = baseEntry('mimo-v2.6-flash-free')
const comboEntry = {
  id: 'combo:recommended-free', channel: 'combo', lanes: ['free'],
  combo: ['mimo-v2.6-flash-free'], strategy: 'fallback', stickyLimit: 1,
  vision: true, reasoning: true, contextWindow: 131072, maxOutput: 8192, canDisableThinking: true,
}
// A non-free model so the route is non-empty and the assertions are meaningful.
const paidModel = { id: 'claude-sonnet', channel: 'aggregate', vision: true, reasoning: true, contextWindow: 200000, maxOutput: 8192, canDisableThinking: true }
const catalog = [freeModel, comboEntry, paidModel]

// (a) hideFreeModels hides both the free model and the pure-free combo.
{
  const membership = computeMembership(catalog, { results: {} }, { hideFreeModels: true })
  const main = membership[ROUTE_MAIN] ?? []
  check('hideFreeModels hides the pure-free combo', main.includes('combo:recommended-free'), false)
  check('hideFreeModels hides the free model too', main.includes('mimo-v2.6-flash-free'), false)
  check('hideFreeModels leaves non-free models visible', main.includes('claude-sonnet'), true)
}

// (b) a lane-wide refusal (every probeable free model unavailable) hides the
// pure-free combo even though hideFreeModels is off.
{
  const availability = { results: { 'mimo-v2.6-flash-free': { state: STATE.unavailable } } }
  const membership = computeMembership(catalog, availability, { hideFreeModels: false })
  const main = membership[ROUTE_MAIN] ?? []
  check('a lane-wide refusal hides the pure-free combo', main.includes('combo:recommended-free'), false)
  check('a lane-wide refusal still restores the refused free model', main.includes('mimo-v2.6-flash-free'), true)
}

// (c) a combo mixing the free group with another lane is NOT over-hidden by
// hideFreeModels — only pure-free chains follow the free-group policy.
{
  const mixed = {
    id: 'combo:mixed', channel: 'combo', lanes: ['free', 'eac'],
    combo: ['mimo-v2.6-flash-free', 'some-eac-model'], strategy: 'fallback', stickyLimit: 1,
    vision: true, reasoning: true, contextWindow: 131072, maxOutput: 8192, canDisableThinking: true,
  }
  const mixedCatalog = [freeModel, mixed, paidModel]
  const membership = computeMembership(mixedCatalog, { results: {} }, { hideFreeModels: true })
  const main = membership[ROUTE_MAIN] ?? []
  check('a free+eac combo is NOT hidden by hideFreeModels', main.includes('combo:mixed'), true)
}

// ── the exported default is the one the fresh install receives ──────────────
check('DEFAULT_RECOMMENDED_COMBO is the recommended-free chain',
  DEFAULT_RECOMMENDED_COMBO?.id, 'combo:recommended-free')

console.log(failures === 0 ? '\ncombo-defaults: fresh-only seeding + free-group visibility hold' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
