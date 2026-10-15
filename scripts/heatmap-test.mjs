/** Calendar and rendering regressions for the real client heatmap, without a browser or network. */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let today
class ClockDate extends Date {
  constructor(...args) { super(...(args.length === 0 ? [today] : args)) }
}
let bundle
const window = { __ModuleLoader__: { load: record => { bundle = record } } }
const react = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: 'fragment',
  useState: initial => [initial, () => {}],
  useEffect: () => {},
  useMemo: factory => factory(),
  useRef: () => ({ current: null }),
  useCallback: fn => fn,
}
new Function('window', 'Date', source)(window, ClockDate)
const { buildHeatCells, Heatmap } = bundle.factory(name => {
  if (name === 'react') return react
  if (name === 'react-dom') {
    return { createPortal: (children, container) => ({ type: 'portal', children, container }) }
  }
  throw new Error(`the browser half may only require react or react-dom; it asked for "${name}"`)
}).__test
const dateKey = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
const localDate = key => {
  const [year, month, day] = key.split('-').map(Number)
  return new Date(year, month - 1, day)
}
const row = (day, total = 200) => ({ day, total, models: [{ model: 'model-a', output: 20 }, { model: 'model-b', output: 30 }] })

let checks = 0
function check(name, run) {
  run()
  checks += 1
  console.log(`  ok  ${name}`)
}

// Both zones must preserve the user's local day, including 23- and 25-hour DST days.
for (const zone of ['Asia/Shanghai', 'America/New_York', 'America/Sao_Paulo']) {
  process.env.TZ = zone
  for (const endKey of ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2027-01-01', '2028-03-01', '2026-03-08', '2026-11-01', '2018-11-05']) {
    check(`${zone}: 17 Sunday-aligned weeks ending ${endKey}`, () => {
      today = localDate(endKey).getTime()
      const cells = buildHeatCells([row(endKey)])
      const end = localDate(endKey)
      assert.equal(cells.length, 113 + end.getDay())
      assert.equal(Math.ceil(cells.length / 7), 17)
      assert.equal(localDate(cells[0].day).getDay(), 0)
      assert.equal(cells.at(-1).day, endKey)
      assert.equal(new Set(cells.map(cell => cell.day)).size, cells.length)
      const expected = localDate(cells[0].day)
      expected.setHours(12, 0, 0, 0)
      for (const cell of cells) {
        assert.equal(cell.day, dateKey(expected))
        expected.setDate(expected.getDate() + 1)
      }
      assert.equal(cells.at(-1).total, 200)
      assert.deepEqual(cells.at(-1).models, ['model-a', 'model-b'])
      assert.ok(cells.slice(0, -1).every(cell => cell.total === 0))
    })
  }
}

check('sparse usage fills missing days and excludes records outside the window', () => {
  today = localDate('2026-10-04').getTime()
  const cells = buildHeatCells([row('2026-06-13'), row('2026-06-14', 50), row('2026-10-04'), row('2026-10-05')])
  assert.equal(cells[0].day, '2026-06-14')
  assert.equal(cells[0].total, 50)
  assert.equal(cells[1].total, 0)
  assert.equal(cells.at(-1).day, '2026-10-04')
  assert.equal(cells.reduce((sum, cell) => sum + cell.total, 0), 250)
})

check('empty records render the existing no-usage message', () => {
  assert.deepEqual(buildHeatCells([]), [])
  const tree = Heatmap({ days: [], t: key => key })
  assert.equal(tree.type, 'p')
  assert.deepEqual(tree.children, ['heat.empty'])
})

check('a recorded zero-token day still renders the calendar', () => {
  today = localDate('2026-10-04').getTime()
  const tree = Heatmap({ days: [row('2026-10-04', 0)], t: key => key })
  assert.equal(tree.type, 'fragment')
  assert.equal(tree.children[0].props.className, 'ofm_heat')
  assert.equal(tree.children[0].children[0].length, 113)
})

check('usage renders a colored day and preserves its tooltip', () => {
  today = localDate('2026-10-04').getTime()
  const tree = Heatmap({ days: [row('2026-10-04')], t: key => key })
  const cell = tree.children[0].children[0].at(-1)
  assert.equal(cell.props.className, 'ofm_cell l4')
  assert.equal(cell.props.title, '2026-10-04 · 200 tokens · model-a, model-b')
})

console.log(`${checks} heatmap checks passed`)
