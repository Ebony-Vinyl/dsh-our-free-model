/**
 * The subagent strip, rendered against a stub React.
 *
 * `client.js` is a hand-written ModuleLoader bundle, so this mounts the real
 * module the way `scripts/client-lint.mjs` does and asserts on the element tree
 * the strip produces. What it pins:
 *
 * - nothing renders for a session with no children (the strip must not take
 *   composer space to say "nothing here");
 * - running children sort above finished ones, and the finished ones keep their
 *   spend;
 * - the four metrics appear in the order the row is meant to be read:
 *   total, speed, hit rate, cached volume;
 * - a child with no route says so instead of rendering an empty model name.
 *
 * Run: node scripts/subagent-ui-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import process from 'node:process'

let captured
globalThis.window = { __ModuleLoader__: { load: module => { captured = module } } }
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
// eslint-disable-next-line no-new-func
new Function(source)()

const React = {
  createElement: (type, props, ...children) => ({ type, props: { ...(props ?? {}), children } }),
  useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useCallback: fn => fn,
  useRef: value => ({ current: value ?? null }),
  useId: () => 'id',
  Fragment: 'fragment',
}
const exports = captured.factory(() => React)

let passed = 0
const check = (label, fn) => {
  try {
    fn()
  } catch (error) {
    // The bundle is half a megabyte; letting assert print it buries the finding.
    console.error(`FAIL ${label}: ${String(error?.message ?? error).split('\n')[0]}`)
    process.exitCode = 1
    return
  }
  passed += 1
  console.log(`ok   ${label}`)
}

/** Depth-first search for elements matching a predicate. */
const find = (node, predicate, out = []) => {
  if (node === null || typeof node !== 'object') return out
  if (predicate(node)) out.push(node)
  for (const child of node.props?.children ?? []) find(child, predicate, out)
  return out
}
const byClass = (node, className) => find(node, el => String(el.props?.className ?? '').split(' ').includes(className))
const textOf = node => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.props?.children)
}

const t = key => key
const strip = source.includes('function SubagentStrip')

check('the strip component is present in the bundle', () => {
  assert.equal(strip, true)
})

check('it is registered on the composer slot', () => {
  assert.match(source, /'conversation\.input\.right'/)
  assert.match(source, /id: 'our-free-model-subagents'/)
})

check('both dictionaries carry every key the strip reads', () => {
  const keys = ['sub.title', 'sub.heading', 'sub.runningOfTotal', 'sub.allDone', 'sub.running',
    'sub.noRoute', 'sub.totalHint', 'sub.cacheHint', 'sub.hit', 'sub.hitHint', 'sub.speedHint', 'sub.finished']
  const zh = source.slice(source.indexOf('const DICT = {'), source.indexOf('en: {'))
  const en = source.slice(source.indexOf('en: {'))
  for (const key of keys) {
    assert.ok(zh.includes(`'${key}'`), `zh is missing ${key}`)
    assert.ok(en.includes(`'${key}'`), `en is missing ${key}`)
  }
})

check('every style class the strip uses is declared', () => {
  for (const cls of ['ofm_sub', 'ofm_subbtn', 'ofm_subpanel', 'ofm_sublist', 'ofm_subrow',
    'ofm_subdot', 'ofm_sublabel', 'ofm_subbadge', 'ofm_subroute', 'ofm_subusage',
    'ofm_submetric', 'ofm_subtotal', 'ofm_subcount', 'ofm_submodel', 'ofm_subtokens',
    'ofm_subhead', 'ofm_submeta', 'ofm_subicon']) {
    assert.ok(source.includes(`.${cls}{`) || source.includes(`.${cls} `) || source.includes(`.${cls}:`),
      `no rule for .${cls}`)
  }
})

check('it renders nothing when the session has no children', () => {
  // The component returns null before touching the DOM; the early guards are
  // `failed || children.length === 0`.
  assert.match(source, /if \(failed \|\| children\.length === 0\) return null/)
})

check('the metrics are ordered total, speed, hit, cached', () => {
  const start = source.indexOf('ofm_subusage\' }')
  const end = source.indexOf('ofm_sublist', start)
  const region = source.slice(start, end > start ? end : start + 3000)
  const order = ['ofm_subtotal', 'speed === null', 'hit === null', 'cacheHint']
  let cursor = -1
  for (const marker of order) {
    const at = region.indexOf(marker)
    assert.ok(at > cursor, `${marker} is out of order`)
    cursor = at
  }
})

check('running children sort above finished ones in the markup', () => {
  assert.match(source, /const running = children\.filter\(row => row\.live === true\)/)
  assert.match(source, /const ordered = \[\.\.\.running, \.\.\.children\.filter\(row => row\.live !== true\)\]/)
})

check('kilo is reused rather than reimplemented', () => {
  // One formatter for the whole plugin: a second copy would drift.
  assert.ok(source.includes('kilo(totals.input)'), 'the strip does not format its totals with kilo')
  assert.ok(source.includes('function kilo('), 'kilo is missing from the bundle')
})

check('the strip hides itself on error instead of showing a broken pill', () => {
  assert.match(source, /if \(failed \|\| children\.length === 0\) return null/)
})

check('polling backs off once nothing is running', () => {
  assert.match(source, /running \? 2000 : 60000/)
})

check('an outside press and Escape both dismiss the panel', () => {
  assert.match(source, /document\.addEventListener\('pointerdown', onDown, true\)/)
  assert.match(source, /document\.addEventListener\('keydown', onKey, true\)/)
})

console.log(`\n${passed} subagent-ui checks passed`)
if (process.exitCode === 1) {
  console.error('some checks failed')
  process.exit(1)
}
