/**
 * 连续失败拉黑：链上某个成员连续失败 N 次后，在 M 分钟内被跳过。
 *
 * 三条契约：
 * - 计数是「连续」的，一次成功清零；未达阈值时成员仍会被尝试；
 * - 达到阈值后 comboChain 跳过它，窗口到期后自动恢复，并重新获得 N 次机会；
 * - 全员都被拉黑时仍尝试全部成员，避免把临时故障变成用户看不见的硬失败。
 *
 * Run: node scripts/combo-blacklist-test.mjs
 */
import assert from 'node:assert/strict'
import {
  buildComboCatalog, comboChain, failureCount, isBlacklisted, normalizeCombos,
  pruneBlacklist, recordMemberOutcome, resetBlacklist,
} from '../src/combos.js'

const CATALOG = [
  { id: 'a', name: 'A', contextWindow: 128000, maxOutput: 32000 },
  { id: 'b', name: 'B', contextWindow: 128000, maxOutput: 32000 },
  { id: 'c', name: 'C', contextWindow: 128000, maxOutput: 32000 },
]

let failures = 0
const check = async (name, fn) => {
  resetBlacklist()
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const row = (extra = {}) => buildComboCatalog(normalizeCombos([
  { name: 'chain', models: ['a', 'b', 'c'], failureThreshold: 3, blackoutMinutes: 5, ...extra },
]), CATALOG)[0]

await check('the policy fields survive normalize and reach the catalog row', async () => {
  const entry = row()
  assert.equal(entry.failureThreshold, 3)
  assert.equal(entry.blackoutMinutes, 5)
})

await check('a chain without the policy keeps no streak and never benches', async () => {
  const entry = buildComboCatalog(normalizeCombos([{ name: 'off', models: ['a', 'b'] }]), CATALOG)[0]
  assert.equal(entry.failureThreshold, undefined)
  for (let i = 0; i < 10; i += 1) {
    assert.equal(recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false }), 0)
  }
  assert.equal(failureCount(entry.id, 'a'), 0)
  assert.equal(comboChain(entry, CATALOG).length, 2)
})

await check('failures below the threshold keep the member in the chain', async () => {
  const entry = row()
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  assert.equal(failureCount(entry.id, 'a'), 2)
  assert.equal(isBlacklisted(entry.id, 'a'), false)
  assert.deepEqual(comboChain(entry, CATALOG).map(r => r.id), ['a', 'b', 'c'])
})

await check('the Nth consecutive failure benches the member', async () => {
  const entry = row()
  for (let i = 0; i < 3; i += 1) {
    recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  }
  assert.equal(isBlacklisted(entry.id, 'a'), true)
  assert.deepEqual(comboChain(entry, CATALOG).map(r => r.id), ['b', 'c'], 'the benched member is skipped')
})

await check('a success clears the consecutive streak', async () => {
  const entry = row()
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: true })
  assert.equal(failureCount(entry.id, 'a'), 0)
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  assert.equal(isBlacklisted(entry.id, 'a'), false, 'the streak restarted rather than finishing the old one')
})

await check('the blackout expires and the member gets a fresh streak', async () => {
  const entry = row()
  for (let i = 0; i < 3; i += 1) {
    recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 3, blackoutMinutes: 5 })
  }
  const later = Date.now() + 6 * 60_000
  assert.equal(isBlacklisted(entry.id, 'a', later), false)
  assert.equal(failureCount(entry.id, 'a'), 0, 'expiry clears the streak too')
  assert.deepEqual(comboChain(entry, CATALOG, { now: later }).map(r => r.id), ['a', 'b', 'c'])
})

await check('a chain whose members are all benched still tries them', async () => {
  const entry = row()
  for (const id of ['a', 'b', 'c']) {
    for (let i = 0; i < 3; i += 1) {
      recordMemberOutcome({ comboId: entry.id, memberId: id, ok: false, threshold: 3, blackoutMinutes: 5 })
    }
  }
  assert.deepEqual(comboChain(entry, CATALOG).map(r => r.id), ['a', 'b', 'c'], 'trying costs one attempt; refusing answers nothing')
})

await check('two chains sharing a member keep separate verdicts', async () => {
  const one = row()
  const two = buildComboCatalog(normalizeCombos([
    { name: 'other', models: ['a', 'b'], failureThreshold: 1, blackoutMinutes: 5 },
  ]), CATALOG)[0]
  recordMemberOutcome({ comboId: two.id, memberId: 'a', ok: false, threshold: 1, blackoutMinutes: 5 })
  assert.equal(isBlacklisted(two.id, 'a'), true)
  assert.equal(isBlacklisted(one.id, 'a'), false)
})

await check('pruning a deleted chain drops its state', async () => {
  const entry = row()
  recordMemberOutcome({ comboId: entry.id, memberId: 'a', ok: false, threshold: 1, blackoutMinutes: 5 })
  assert.equal(isBlacklisted(entry.id, 'a'), true)
  pruneBlacklist([])
  assert.equal(isBlacklisted(entry.id, 'a'), false)
})

await check('a fractional threshold or window below one is not a policy', async () => {
  const rows = normalizeCombos([{ name: 'tiny', models: ['a'], failureThreshold: 0.5, blackoutMinutes: 0.2 }])
  assert.equal(rows[0].failureThreshold, undefined)
  assert.equal(rows[0].blackoutMinutes, undefined)
})

if (failures > 0) console.error(`combo-blacklist-test: ${failures} failure(s)`)
else console.log('combo-blacklist-test: consecutive failures bench a member for the configured window and expire cleanly')
process.exitCode = failures > 0 ? 1 : 0
