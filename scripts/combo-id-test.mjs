/**
 * The id a chain name resolves to.
 *
 * The id is derived from the name, and everything downstream keys on it: the
 * picker row, the gateway's `combo:` model, the stored list, the rotation
 * cursor. So the one thing `comboId` may never do is return nothing for a name
 * the editor accepted — that is what it did for a purely non-ASCII name, and the
 * row was then dropped as malformed while the save route answered 200 (#379).
 *
 * The checks below pin both halves of the contract that replaced it:
 *
 * - an ASCII name keeps the readable slug it has always had, so stored chains,
 *   the README's `combo:<name>` and every id a user has pinned keep working;
 * - a name the slug cannot spell still gets a stable id, and two such names
 *   never fold onto one id — 免費優先 and 付費優先 both slug to nothing, and a
 *   collision would silently drop the second one as a duplicate.
 *
 * Pure module, no host: `comboId` and `normalizeCombos` only.
 *
 * Run: node scripts/combo-id-test.mjs
 */
import assert from 'node:assert/strict'
import { comboId, normalizeCombos } from '../src/combos.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
/** Every id this module can mint, spelled in the alphabet the slug promises. */
const WELL_FORMED = /^combo:[a-z0-9][a-z0-9-]*$/

check('an ASCII name is still spelled out as the slug it always was', () => {
  assert.equal(comboId('My Fast Chain'), 'combo:my-fast-chain')
  assert.equal(comboId('  Second  Chain  '), 'combo:second-chain')
  assert.equal(comboId('Night--Shift'), 'combo:night-shift')
  assert.equal(comboId('x'.repeat(60)), `combo:${'x'.repeat(48)}`, 'the slug still stops at 48 characters')
})

check('a name with no ASCII at all now yields an id instead of an empty string', () => {
  for (const name of ['免费优先', '先免费后协付', 'Приоритет', '優先チェーン']) {
    const id = comboId(name)
    assert.match(id, WELL_FORMED, `${name} -> ${JSON.stringify(id)}`)
  }
})

check('the id depends on the name and on nothing else', () => {
  assert.equal(comboId('免费优先'), comboId('免费优先'))
  assert.equal(comboId(' 免费优先 '), comboId('免费优先'), 'the surrounding space is not part of the name')
})

check('two names that slug to nothing stay two chains', () => {
  assert.notEqual(comboId('免費優先'), comboId('付費優先'))
  assert.notEqual(comboId('免费优先'), comboId('免費優先'))
})

check('a mixed name keeps its readable head and stays distinct', () => {
  const id = comboId('免费 Pro')
  assert.match(id, WELL_FORMED)
  assert.ok(id.startsWith('combo:pro-'), `expected the slug to survive the digest — got ${id}`)
  assert.notEqual(id, comboId('付费 Pro'))
})

check('a name made only of punctuation is still a name', () => {
  assert.match(comboId('!!!'), WELL_FORMED)
  assert.match(comboId('——'), WELL_FORMED)
})

check('an empty name still has no id', () => {
  assert.equal(comboId(''), '')
  assert.equal(comboId('   '), '')
  assert.equal(comboId(undefined), '')
})

check('normalizeCombos keeps the row the editor just saved', () => {
  const rows = normalizeCombos([{ name: '免费优先', models: ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free'] }])
  assert.equal(rows.length, 1, 'the chain reached the stored list')
  assert.match(rows[0].id, WELL_FORMED)
  assert.equal(rows[0].name, '免费优先', 'and kept its name for the picker')
  assert.deepEqual(rows[0].models, ['deepseek-v4-flash-free', 'mimo-v2.6-flash-free'])
})

check('two non-ASCII chains are stored side by side, not deduplicated', () => {
  const rows = normalizeCombos([
    { name: '免費優先', models: ['a-model'] },
    { name: '付費優先', models: ['b-model'] },
  ])
  assert.equal(rows.length, 2, 'both chains survived normalization')
})

check('a stored chain keeps its id when it is renamed', () => {
  const [renamed] = normalizeCombos([{ id: 'combo:free-first', name: '优先免费', models: ['a-model'] }])
  assert.equal(renamed.id, 'combo:free-first', 'the id a client may already be pinned to does not move')
  assert.equal(renamed.name, '优先免费', 'while the new name is what the picker shows')
})

check('the stored list keeps both the old and the new shape of id', () => {
  const rows = normalizeCombos([
    { id: 'combo:never-fails', name: 'Never Fails', models: ['a-model'] },
    { name: '免费优先', models: ['b-model'] },
  ])
  assert.deepEqual(rows.map(row => row.id), ['combo:never-fails', comboId('免费优先')])
})

check('an empty name is still refused, and it is the only name that is', () => {
  const rows = normalizeCombos([
    { name: '', models: ['a-model'] },
    { name: '   ', models: ['b-model'] },
    { name: '免费优先', models: ['c-model'] },
  ])
  assert.equal(rows.length, 1, 'only the unnamed row was dropped')
  assert.equal(rows[0].name, '免费优先')
})

if (failures > 0) console.error(`combo-id-test: ${failures} failure(s)`)
else console.log('combo-id-test: every name an editor accepts resolves to one stable, ASCII-safe id')
process.exitCode = failures > 0 ? 1 : 0
