/**
 * The free lane's summary chips must account for every model in the roster.
 *
 * Issue #573: `counts` is reduced over the whole free-lane roster by
 * `availability`, so `throttled` and `unknown` were counted — and then thrown
 * away, because the summary row rendered only three of the five buckets. A
 * throttled round therefore read as "0 available · 1 region-limited · 1
 * unavailable" over a roster of eleven, which looks like a broken counter
 * rather than what it is: eight models the upstream was throttling.
 *
 * The roster and the chips are two views of one reduce, so the regression is
 * arithmetic: the five chips must sum to the roster the chips describe.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { FreePage,')

/** Mount the client bundle against a stub React and hand back the rendered tree. */
function mount(counts, catalog) {
  let bundle, cursor = 0
  const cells = []
  const window = {
    __ModuleLoader__: { load: value => { bundle = value } },
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
  }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef(initial) { return cells[cursor++] ??= { current: initial } },
    useEffect() {},
    useMemo: fn => fn(),
    useCallback: fn => fn,
  }
  new Function('window', source)(window)
  const { FreePage, DICT } = bundle.factory(() => react).__test
  const t = key => DICT.zh[key]
  t.locale = 'zh-CN'
  const props = {
    t,
    data: { catalog, settings: { enabled: true } },
    counts,
    summary: { reload() {} },
    stats: { status: 'idle', data: undefined, reload() {} },
    eacAuth: {},
    setEacAuth() {},
    eacLogin: {},
    busy: false,
    setBusy() {},
    apply() {},
    bench() {},
    benches: {},
    refresh() {},
    reprobe() {},
  }
  cursor = 0
  return { tree: FreePage(props), DICT }
}

/** Every `ofm_stat` chip in the tree, as its number and its label. */
function chips(tree) {
  const found = []
  const visit = node => {
    if (Array.isArray(node)) return node.forEach(visit)
    if (!node || typeof node !== 'object') return
    // A chip that carries a non-zero count is marked `ofm_stat hot`, so the
    // class is matched by prefix rather than by equality.
    if (typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes('ofm_stat')) {
      const number = node.children.find(child => child?.type === 'b')?.children?.[0]
      const label = node.children.find(child => child?.type === 'span')?.children?.[0]
      found.push({ number, label })
    }
    visit(node.children)
  }
  visit(tree)
  return found
}

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n       ${error.message}`)
  }
}

const ROSTER = [
  { id: 'a-free', availability: 'available' },
  { id: 'b-free', availability: 'available' },
  { id: 'c-free', availability: 'region-blocked' },
  { id: 'd-free', availability: 'unavailable' },
  { id: 'e-free', availability: 'throttled' },
  { id: 'f-free', availability: 'throttled' },
  { id: 'g-free', availability: 'throttled' },
  { id: 'h-free', availability: 'throttled' },
  { id: 'i-free', availability: 'throttled' },
  { id: 'j-free', availability: 'throttled' },
  { id: 'k-free', availability: 'throttled' },
  { id: 'l-free', availability: 'throttled' },
  { id: 'm-free', availability: 'throttled' },
]
// The counts the runtime's reduce produces for that roster: the nine throttled
// models vanish from the three-chip summary, which is what #573 reported.
const COUNTS = { available: 2, 'region-blocked': 1, unavailable: 1, throttled: 9, unknown: 0 }

check('the summary renders one chip per availability bucket', () => {
  const rendered = chips(mount(COUNTS, ROSTER).tree)
  assert.equal(rendered.length, 5, `expected 5 chips, got ${rendered.length}: ${JSON.stringify(rendered)}`)
})

check('the chip numbers are the counted buckets', () => {
  const rendered = chips(mount(COUNTS, ROSTER).tree)
  const byLabel = Object.fromEntries(rendered.map(row => [row.label, row.number]))
  assert.equal(byLabel['可用'], '2')
  assert.equal(byLabel['地区受限'], '1')
  assert.equal(byLabel['暂不可用'], '1')
  assert.equal(byLabel['限流'], '9')
  assert.equal(byLabel['未探测'], '0')
})

check('the chips add up to the roster they describe', () => {
  const rendered = chips(mount(COUNTS, ROSTER).tree)
  const sum = rendered.reduce((total, row) => total + Number(row.number), 0)
  assert.equal(sum, ROSTER.length, `chips sum to ${sum}, roster holds ${ROSTER.length}`)
})

check('an unprobed roster is reported, not silently dropped', () => {
  const roster = [{ id: 'x', availability: 'unknown' }, { id: 'y', availability: 'unknown' }]
  const rendered = chips(mount({ unknown: 2 }, roster).tree)
  const unknown = rendered.find(row => row.label === '未探测')
  assert.ok(unknown !== undefined, 'the unprobed bucket has no chip')
  assert.equal(unknown.number, '2')
})

check('throttled and unavailable read differently', () => {
  // Both used to be "暂不可用", so the two chips were indistinguishable.
  const { DICT } = mount(COUNTS, ROSTER)
  assert.notEqual(DICT.zh['state.throttled'], DICT.zh['state.unavailable'])
  assert.notEqual(DICT.en['state.throttled'], DICT.en['state.unavailable'])
})

check('the summary states its own scope', () => {
  const { DICT } = mount(COUNTS, ROSTER)
  assert.ok(DICT.zh['free.statHint'].includes('{total}'), 'the zh hint does not name the roster size')
  assert.ok(DICT.en['free.statHint'].includes('{total}'), 'the en hint does not name the roster size')
})

console.log(failures === 0 ? '\nall stat bucket checks passed' : `\n${failures} stat bucket check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
