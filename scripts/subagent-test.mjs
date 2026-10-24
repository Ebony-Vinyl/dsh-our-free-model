/**
 * The subagent telemetry fold, against stand-in projections.
 *
 * The point of this module is that its numbers mean something, so the cases
 * here are the ones where a naive fold would quietly lie:
 *
 * - a child that has finished must still report what it spent (its state comes
 *   from the checkpoint, not from memory);
 * - a grandchild must not be counted (only the parent's own catalog);
 * - an unmeasurable decode window must be omitted, not reported as 0 tok/s;
 * - a cache-hit rate is share of *billed* input, so a child that is all cache
 *   reads still divides by a non-zero denominator.
 *
 * Run: node scripts/subagent-test.mjs
 */
import assert from 'node:assert/strict'
import process from 'node:process'
import { childrenOf, usageOf, statsOf, metricsOf, describeChildren, summarize } from '../src/subagent.js'

let passed = 0
const check = (label, fn) => {
  fn()
  passed += 1
  console.log(`ok   ${label}`)
}

/** A projection registry stand-in: `stateOf` answers from a plain map. */
function projectionsFor(table) {
  return {
    stateOf(session, key) {
      const row = table[session.id]?.[key]
      if (row === undefined) throw new Error(`no projection ${key}`)
      return row
    },
  }
}

const child = (id, extra = {}) => ({ id, requestHeader: () => ({ config: { provider: 'our-free-model', model: 'kimi-k3' } }), ...extra })

// --- childrenOf ---------------------------------------------------------------
check('reads the head.values shape', () => {
  const parent = { id: 'p' }
  const projections = projectionsFor({
    p: {
      subagentCatalog: {
        head: {
          values: [
            { childId: 'c1', label: 'audit A', mode: 'continuable', childCreatedAt: 10 },
            { childId: 'c2', label: 'audit B', mode: 'one-shot', childCreatedAt: 20 },
          ],
        },
      },
    },
  })
  const kids = childrenOf(projections, parent)
  assert.equal(kids.length, 2)
  assert.deepEqual(kids[0], { id: 'c1', label: 'audit A', mode: 'continuable', createdAt: 10 })
})

check('drops entries without a usable childId', () => {
  const projections = projectionsFor({
    p: { subagentCatalog: { head: { values: [{ label: 'no id' }, { childId: 'kept' }] } } },
  })
  assert.deepEqual(childrenOf(projections, { id: 'p' }).map(row => row.id), ['kept'])
})

check('a missing catalog is empty, not a throw', () => {
  assert.deepEqual(childrenOf(projectionsFor({ p: {} }), { id: 'p' }), [])
})

check('an empty catalog is empty', () => {
  const projections = projectionsFor({ p: { subagentCatalog: { head: { values: [] } } } })
  assert.deepEqual(childrenOf(projections, { id: 'p' }), [])
})

// --- usageOf ------------------------------------------------------------------
check('normalizes the harness token meter', () => {
  const projections = projectionsFor({
    c: { tokenUsage: { totals: { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 900, reasoningTokens: 7 } } },
  })
  assert.deepEqual(usageOf(projections, child('c'), undefined), { input: 100, output: 40, cacheRead: 900, reasoning: 7 })
})

check('falls back to the checkpoint for a cold child', () => {
  const projections = projectionsFor({})
  const cached = { tokenUsage: { val: { totals: { uncachedInputTokens: 5, outputTokens: 6, cacheReadTokens: 7 } } } }
  assert.deepEqual(usageOf(projections, undefined, cached), { input: 5, output: 6, cacheRead: 7, reasoning: 0 })
})

check('an all-zero meter is "nothing metered", not a row of zeroes', () => {
  const projections = projectionsFor({ c: { tokenUsage: { totals: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } } } })
  assert.equal(usageOf(projections, child('c'), undefined), undefined)
})

check('a missing tokenUsage unit yields undefined', () => {
  assert.equal(usageOf(projectionsFor({ c: {} }), child('c'), undefined), undefined)
})

// --- statsOf ------------------------------------------------------------------
check('prefers live stats over the checkpoint', () => {
  const projections = projectionsFor({ c: { sessionStats: { decodeMs: 1000, decodeTokens: 100 } } })
  const cached = { sessionStats: { val: { decodeMs: 9, decodeTokens: 9 } } }
  assert.equal(statsOf(projections, child('c'), cached).decodeMs, 1000)
})

check('uses the checkpoint when the session is cold', () => {
  const cached = { sessionStats: { val: { decodeMs: 2000, decodeTokens: 200 } } }
  assert.equal(statsOf(projectionsFor({}), undefined, cached).decodeMs, 2000)
})

// --- metricsOf ----------------------------------------------------------------
check('cache hit is share of billed input', () => {
  const usage = { input: 100, output: 50, cacheRead: 900, reasoning: 0 }
  assert.equal(metricsOf(usage, undefined).cacheHitRate, 0.9)
})

check('a child that is entirely cache reads still divides', () => {
  const usage = { input: 0, output: 10, cacheRead: 500, reasoning: 0 }
  assert.equal(metricsOf(usage, undefined).cacheHitRate, 1)
})

check('no input at all omits the hit rate', () => {
  assert.equal(metricsOf({ input: 0, output: 0, cacheRead: 0, reasoning: 0 }, undefined).cacheHitRate, undefined)
})

check('decode speed is tokens per second of window', () => {
  assert.equal(metricsOf(undefined, { decodeMs: 2000, decodeTokens: 100 }).tokensPerSecond, 50)
})

check('a window under the floor is unmeasurable, not 0 tok/s', () => {
  assert.equal(metricsOf(undefined, { decodeMs: 249, decodeTokens: 500 }).tokensPerSecond, undefined)
})

check('a rate above the credibility ceiling is dropped', () => {
  // 1000 tokens in 1000 ms = 1000 tok/s, which is not generation.
  assert.equal(metricsOf(undefined, { decodeMs: 1000, decodeTokens: 1000 }).tokensPerSecond, undefined)
})

check('exactly the ceiling is kept', () => {
  assert.equal(metricsOf(undefined, { decodeMs: 1000, decodeTokens: 250 }).tokensPerSecond, 250)
})

check('a non-numeric window is ignored', () => {
  assert.equal(metricsOf(undefined, { decodeMs: 'abc', decodeTokens: 100 }).tokensPerSecond, undefined)
})

// --- describeChildren ---------------------------------------------------------
check('a finished child keeps its usage and loses its route', () => {
  const parent = { id: 'p' }
  const projections = projectionsFor({
    p: { subagentCatalog: { head: { values: [{ childId: 'gone', label: 'finished work' }] } } },
  })
  const deps = {
    sessions: { get: id => (id === 'p' ? parent : undefined) },
    projections,
    checkpointOf: id => (id === 'gone'
      ? {
        tokenUsage: { val: { totals: { uncachedInputTokens: 10, outputTokens: 20, cacheReadTokens: 30 } } },
        sessionStats: { val: { decodeMs: 1000, decodeTokens: 20 } },
      }
      : undefined),
  }
  const rows = describeChildren(deps, 'p')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].live, false)
  assert.equal(rows[0].label, 'finished work')
  assert.equal(rows[0].provider, undefined)
  assert.deepEqual(rows[0].usage, { input: 10, output: 20, cacheRead: 30, reasoning: 0 })
  assert.equal(rows[0].tokensPerSecond, 20)
})

check('a live child reports its current route', () => {
  const parent = { id: 'p' }
  const projections = projectionsFor({
    p: { subagentCatalog: { head: { values: [{ childId: 'live1', label: 'working' }] } } },
    live1: {
      tokenUsage: { totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3 } },
      sessionStats: { decodeMs: 1000, decodeTokens: 100 },
    },
  })
  const deps = {
    sessions: { get: id => (id === 'p' ? parent : id === 'live1' ? child('live1') : undefined) },
    projections,
    checkpointOf: undefined,
  }
  const [row] = describeChildren(deps, 'p')
  assert.equal(row.live, true)
  assert.equal(row.provider, 'our-free-model')
  assert.equal(row.model, 'kimi-k3')
  assert.equal(row.tokensPerSecond, 100)
})

check('grandchildren are not counted', () => {
  // The parent's catalog names one child; that child has its own catalog, which
  // must not leak into the parent's view.
  const parent = { id: 'p' }
  const projections = projectionsFor({
    p: { subagentCatalog: { head: { values: [{ childId: 'kid' }] } } },
    kid: { subagentCatalog: { head: { values: [{ childId: 'grandkid' }] } } },
  })
  const deps = {
    sessions: { get: id => (id === 'p' ? parent : undefined) },
    projections,
    checkpointOf: undefined,
  }
  assert.deepEqual(describeChildren(deps, 'p').map(row => row.id), ['kid'])
})

check('an absent parent yields no rows', () => {
  const deps = { sessions: { get: () => undefined }, projections: projectionsFor({}), checkpointOf: undefined }
  assert.deepEqual(describeChildren(deps, 'p'), [])
})

check('missing services are inert rather than fatal', () => {
  assert.deepEqual(describeChildren({ sessions: undefined, projections: undefined }, 'p'), [])
})

// --- summarize ----------------------------------------------------------------
check('summarize counts live children and folds spend', () => {
  const rows = [
    { live: true, usage: { input: 10, output: 20, cacheRead: 30 } },
    { live: false, usage: { input: 5, output: 5, cacheRead: 5 } },
    { live: false },
  ]
  assert.deepEqual(summarize(rows), { total: 3, live: 1, input: 15, output: 25, cacheRead: 35 })
})

check('summarize of nothing is all zeroes', () => {
  assert.deepEqual(summarize([]), { total: 0, live: 0, input: 0, output: 0, cacheRead: 0 })
})

console.log(`\nall ${passed} subagent checks passed`)
process.exit(0)
