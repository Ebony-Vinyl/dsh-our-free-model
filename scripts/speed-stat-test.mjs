/**
 * Proves the speed panel cannot be poisoned by tokens it never saw.
 *
 * Measured live (scripts/probes/decode-window.mjs): one call reported 422 output
 * tokens of which 291 were reasoning, and not a single reasoning frame arrived —
 * those tokens were produced during the 5.2 s before the first observed frame,
 * so dividing them by the 1.2 s the answer took published 349 tok/s for a 108
 * tok/s answer. A worse recorded sample divided 63 tokens by a 1 ms window and
 * published 63 000 tok/s; averaged over 26 calls that one point dragged the
 * whole card to 2 493 while the lane was doing ~40. The gateway is not at fault:
 * a raw-read probe (batch-delivery.mjs) shows 64 frames spread over 5.6 s.
 *
 * Run: node scripts/speed-stat-test.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { decodeWindow, migrateSettings, migrateStats, pruneDays, recordTurn, recordUsage, JsonStore, SETTINGS_INITIAL, SETTINGS_VERSION, STATS_INITIAL } = await import('../src/store.js')
const { windowTokens } = await import('../src/stream.js')
const { buildStats } = await import('../index.js')

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** The smallest thing recordUsage needs: a get/edit pair over a plain object. */
const store = value => ({
  value,
  get() { return this.value },
  edit(mutate) { this.value = mutate(structuredClone(this.value)); return this.value },
})

check('unstreamed reasoning leaves the numerator', windowTokens({ outputTokens: 422, reasoningTokens: 291 }, false), 131)
check('streamed reasoning stays in it', windowTokens({ outputTokens: 135, reasoningTokens: 23 }, true), 135)
check('a model that reports no reasoning is unaffected', windowTokens({ outputTokens: 50 }, false), 50)

// ── 设置迁移：旧的出厂上限 32768 不是用户选的 ────────────────────────────────
// 版本 1 把这个数字当成每轮默认额度，于是容量更大的模型全被压到 32K，长回答
// 稳定撞上 max_output_tokens。升级时它必须变成「不限制」；用户自己填过的其它
// 数字要原样保留，否则这次迁移就成了静默改写用户设置。
check('a fresh install ships no cap at all', SETTINGS_INITIAL.defaultMaxTokens, 0)
check('the settings file version moves with the meaning',
  [SETTINGS_INITIAL.version, SETTINGS_VERSION], [SETTINGS_VERSION, 2])
check('the old factory value migrates to no cap',
  migrateSettings({ version: 1, defaultMaxTokens: 32768 }).defaultMaxTokens, 0)
check('a value the user chose survives the migration',
  migrateSettings({ version: 1, defaultMaxTokens: 8192 }).defaultMaxTokens, 8192)
check('a current file is left alone',
  migrateSettings({ version: 2, defaultMaxTokens: 32768 }).defaultMaxTokens, 32768)
check('and the migration stamps the new version',
  migrateSettings({ version: 1, defaultMaxTokens: 32768 }).version, SETTINGS_VERSION)
check('no usage is no tokens', windowTokens(undefined, false), 0)

check('131 tokens in 1.2 s is a real 108 tok/s', decodeWindow(1209, 131, true), { measurable: true, decodeMs: 1209, tps: 108 })
check('a 1 ms window is not a measurement', decodeWindow(1, 3, true), { measurable: false, decodeMs: 0, tps: null })
check('561 tok/s is coalesced frames, not speed', decodeWindow(358, 201, true), { measurable: false, decodeMs: 0, tps: null })
check('a failed call has no rate', decodeWindow(0, 0, false), { measurable: false, decodeMs: 0, tps: null })
check('no numerator, no rate', decodeWindow(4000, 0, true), { measurable: false, decodeMs: 0, tps: null })

const call = over => ({ at: 1, model: 'mimo-v2.6-flash-free', input: 100, output: 100, reasoning: 0, cacheRead: 0, effort: 'balanced', ...over })
const stats = store(structuredClone(STATS_INITIAL))
for (const record of [
  call({ ok: true, output: 146, decodeTokens: 146, ttftMs: 1649, decodeMs: 2704 }),
  call({ ok: true, output: 51, decodeTokens: 51, ttftMs: 4431, decodeMs: 1750 }),
  call({ ok: true, output: 63, decodeTokens: 3, ttftMs: 2977, decodeMs: 1 }),
  call({ ok: false, output: 0, decodeTokens: 0, ttftMs: 10732, decodeMs: 0 }),
]) recordUsage(stats, record)

const row = Object.values(stats.get().days)[0].models['mimo-v2.6-flash-free']
check('unmeasurable windows add to neither sum', [row.decodeMs, row.decodeTokens], [4454, 197])
check('the failed call is not a first-frame sample', [row.ttftMs, row.ttftSamples], [9057, 3])

const named = buildStats(stats.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }]).models[0]
check('the reported rate is token-weighted', named.tps, 44)
check('an unweighted mean of the same calls would read', Math.round((54 + 29 + 3000) / 3), 1028)
check('mean first frame covers successes only', named.avgTtftMs, 3019)
check('every call still counts', [named.calls, named.failed], [4, 1])
check('physical failures are lifetime accounting', stats.get().failedRequests, 1)

const recoveredStats = store(structuredClone(STATS_INITIAL))
recordUsage(recoveredStats, call({ ok: false, recoveryId: 'turn-1', attempt: 0, recoveryScheduled: true, output: 0, decodeTokens: 0, decodeMs: 0 }))
recordUsage(recoveredStats, call({ ok: true, recoveryId: 'turn-1', attempt: 1, recoveryAttempt: true, recovered: true, output: 80, decodeTokens: 80, decodeMs: 1000 }))
recordTurn(recoveredStats, { at: 1, model: 'mimo-v2.6-flash-free', ok: true, recovered: true, attempts: 2 })
const recovered = buildStats(recoveredStats.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }])
check('a recovered turn keeps both accounting layers', [recovered.requests, recovered.requestFailures, recovered.turns, recovered.failedTurns, recovered.recoveredTurns], [2, 1, 1, 0, 1])
check('the model row exposes turn accounting separately', [recovered.models[0].calls, recovered.models[0].failed, recovered.models[0].turns, recovered.models[0].failedTurns, recovered.models[0].recoveredTurns], [2, 1, 1, 0, 1])
check('a logical row does not fall back to physical attempts', [recovered.models[0].turns, recovered.models[0].failedTurns], [1, 0])

const exactNoTurn = store(structuredClone(STATS_INITIAL))
recordUsage(exactNoTurn, call({ ok: true }))
const noTurnStats = buildStats(exactNoTurn.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }])
check('a new physical call without a final turn is not counted as a turn', [noTurnStats.turns, noTurnStats.failedTurns, noTurnStats.logicalEstimated], [0, 0, false])

const retainedWindow = store(structuredClone(STATS_INITIAL))
recordUsage(retainedWindow, call({ at: Date.UTC(2025, 0, 1), output: 10, ok: true }))
recordTurn(retainedWindow, { at: Date.UTC(2025, 0, 1), model: 'mimo-v2.6-flash-free', ok: true })
recordUsage(retainedWindow, call({ at: Date.UTC(2026, 0, 1), output: 5, ok: true }))
recordTurn(retainedWindow, { at: Date.UTC(2026, 0, 1), model: 'mimo-v2.6-flash-free', ok: true })
retainedWindow.value = pruneDays(retainedWindow.get(), 1)
const retainedSummary = buildStats(retainedWindow.get(), [{ id: 'mimo-v2.6-flash-free', name: 'Mimo' }])
check('model totals remain lifetime when the speed window is pruned', [retainedSummary.days.length, retainedSummary.requests, retainedSummary.turns, retainedSummary.models[0].calls, retainedSummary.models[0].output], [1, 2, 2, 2, 15])

const silent = store(structuredClone(STATS_INITIAL))
recordUsage(silent, call({ model: 'space-bunny-free', ok: true, output: 63, decodeTokens: 3, ttftMs: 2977, decodeMs: 1 }))
check('a model nobody timed shows no rate, not zero', buildStats(silent.get(), []).models[0].tps, null)

const legacy = {
  version: 1,
  requests: 3,
  days: { '2026-09-24': { total: 500, models: { 'space-bunny-free': {
    input: 100, output: 65, reasoning: 0, cacheRead: 0, calls: 2, failed: 1,
    ttftMs: 13709, decodeMs: 2, decodeTokens: 65,
  } } } },
  models: {},
  samples: [
    { at: 1, model: 'space-bunny-free', ok: true, input: 100, output: 63, ttftMs: 2977, tps: 63000 },
    { at: 2, model: 'space-bunny-free', ok: false, input: 0, output: 0, ttftMs: 10732, tps: 0 },
  ],
}
const migrated = migrateStats(legacy)
const legacyRow = migrated.days['2026-09-24'].models['space-bunny-free']
check('migration clears the poisoned speed totals', [legacyRow.decodeMs, legacyRow.decodeTokens, legacyRow.ttftMs, legacyRow.ttftSamples], [0, 0, 0, 0])
check('migration keeps what was really measured', [migrated.samples[0].ttftMs, migrated.samples[0].tps, migrated.samples[0].decodeMs], [2977, null, 0])
check('a failure is not promoted to a latency sample', [migrated.samples[1].ttftMs, migrated.samples[1].tps], [null, null])
check('token totals survive', [legacyRow.input, legacyRow.output, migrated.requests], [100, 65, 3])
check('migration is idempotent', migrateStats(migrated), migrated)

const v2 = { ...legacy, version: 2, logical: undefined }
const migratedV2 = migrateStats(v2)
check('v2 migration keeps already-correct speed totals',
  [migratedV2.days['2026-09-24'].models['space-bunny-free'].decodeMs, migratedV2.samples[0].tps], [2, 63000])
check('v2 migration baselines logical turns from physical history',
  [migratedV2.logical.turns, migratedV2.logical.failed, migratedV2.logical.recovered], [2, 1, 0])
check('legacy logical baseline is explicitly estimated', [migratedV2.logical.estimated, migratedV2.failedRequests, migratedV2.failedRequestsEstimated], [true, 1, true])
const mergedV2 = migrateStats({ ...v2, failedRequests: 0, logical: structuredClone(STATS_INITIAL.logical) })
check('migration ignores default-filled v3 counters on old files', [mergedV2.failedRequests, mergedV2.failedRequestsEstimated, mergedV2.logical.turns], [1, true, 2])
const migratedStore = store(migratedV2)
recordTurn(migratedStore, { at: 3, model: 'space-bunny-free', ok: true })
check('new exact turns preserve the historical estimate marker', migratedStore.get().logical.estimated, true)

const retained = store(structuredClone(STATS_INITIAL))
for (let index = 0; index < 405; index += 1) recordUsage(retained, call({ at: index + 1, ok: true }))
check('physical samples retain a bounded audit window', retained.get().samples.length, 400)

const persistedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-stats-'))
const persistedPath = path.join(persistedDir, 'stats.json')
const persisted = new JsonStore(persistedPath, structuredClone(STATS_INITIAL))
recordUsage(persisted, call({ ok: false }))
recordTurn(persisted, { at: 1, model: 'mimo-v2.6-flash-free', ok: false })
persisted.flush()
const reloaded = new JsonStore(persistedPath, structuredClone(STATS_INITIAL))
check('physical and logical counters survive reload', [reloaded.get().requests, reloaded.get().failedRequests, reloaded.get().logical.turns, reloaded.get().logical.failed], [1, 1, 1, 1])
persisted.dispose()
reloaded.dispose()
fs.rmSync(persistedDir, { recursive: true, force: true })

// ── the file itself ──────────────────────────────────────────────────────────
// A half-written store file is the one failure the plugin used to answer by
// quietly starting over: `load()` swallowed the parse error, kept the defaults,
// and the first scheduled flush renamed them over the top of whatever was there —
// the forward key and the acknowledged announcements gone with nothing on disk to
// recover and nothing in the log to explain it.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-store-'))
const damaged = path.join(scratch, 'settings.json')
const original = '{"forwardKey":"ofm-was-here","probeIntervalMinutes":'
fs.writeFileSync(damaged, original)
const store2 = new JsonStore(damaged, { forwardKey: '', probeIntervalMinutes: 15 })
check('a file that will not parse falls back to the defaults', [store2.get().forwardKey, store2.get().probeIntervalMinutes], ['', 15])
store2.update({ forwardKey: 'ofm-new' })
store2.flush()
check('the damaged bytes survive the write that replaces them',
  fs.readdirSync(scratch).some(name => name.startsWith('settings.json.corrupt-')
    && fs.readFileSync(path.join(scratch, name), 'utf8') === original), true)
check('and the replacement is readable by the next load', new JsonStore(damaged, { forwardKey: '' }).get().forwardKey, 'ofm-new')
fs.rmSync(scratch, { recursive: true, force: true })

console.log(failures === 0 ? '\nspeed-stat: the panel can no longer be averaged into nonsense' : `\nspeed-stat: ${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
