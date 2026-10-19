/**
 * The routing editor's chain-level capacity fields, mounted with the smallest
 * React stand-in that can drive a real `ChainEditor` (the same pattern as
 * channel-credits-ui-test.mjs — production error #31 came from skipping this).
 *
 * What must hold: the two number inputs exist, they show the stored numbers,
 * submitting carries them, a cleared field is written as absent so the chain
 * falls back to the intersection, and the card names the effective numbers.
 *
 * Run: node scripts/routing-caps-ui-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ChainEditor, ChainCard, DICT,')

function mount(componentName, props) {
  let bundle, cursor = 0
  const cells = []
  const window = {
    __ModuleLoader__: { load: value => { bundle = value } },
    addEventListener: () => {},
    removeEventListener: () => {},
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
    useEffect: () => {},
    useMemo: fn => fn(),
    useCallback: fn => fn(),
  }
  new Function('window', source)(window)
  const exported = bundle.factory(() => react).__test
  const component = exported[componentName]
  // Function components are expanded by hand: the stand-in never runs React's
  // reconciler, so a nested `h(Button, …)` stays a function element otherwise.
  const expand = node => {
    if (Array.isArray(node)) return node.flatMap(expand)
    if (node === null || node === undefined || typeof node !== 'object') return []
    if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }))
    return [node, ...(node.children ?? []).flatMap(expand)]
  }
  return {
    dict: exported.DICT,
    nodes: () => { cursor = 0; return expand(component(props)) },
  }
}

const MODELS = [
  { id: 'a', name: 'Model A', channel: 'free', vision: false, contextWindow: 131072, maxOutput: 32768 },
  { id: 'b', name: 'Model B', channel: 'chan', vision: false, contextWindow: 131072, maxOutput: 32768 },
]
const numberInputs = nodes => nodes.filter(node => node.type === 'input' && node.props.type === 'number')
const buttonWith = (nodes, label) => nodes.find(node => node.type === 'button' && node.children.flat(Infinity).includes(label))

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

await check('the editor shows the stored chain numbers', async () => {
  const saves = []
  const app = mount('ChainEditor', {
    t: key => app.dict.zh[key],
    chain: { id: 'combo:caps', name: 'caps', models: ['a', 'b'], strategy: 'fallback', contextWindow: 1000000, maxOutput: 200000, enabled: true },
    models: MODELS, onSave: row => saves.push(row), onCancel: () => {},
  })
  const inputs = numberInputs(app.nodes())
  assert.equal(inputs.length, 2, 'two number inputs: context window and max output')
  assert.deepEqual(inputs.map(node => node.props.value), ['1000000', '200000'])
  assert.deepEqual(saves, [], 'nothing is written until save')
})

await check('editing the numbers lands in the save payload', async () => {
  const saves = []
  const app = mount('ChainEditor', {
    t: key => app.dict.zh[key],
    chain: { id: 'combo:caps', name: 'caps', models: ['a'], strategy: 'fallback', enabled: true },
    models: MODELS, onSave: row => saves.push(row), onCancel: () => {},
  })
  const before = numberInputs(app.nodes())
  assert.deepEqual(before.map(node => node.props.value), ['', ''], 'no stored number reads as empty')
  before[0].props.onChange({ target: { value: '262144' } })
  before[1].props.onChange({ target: { value: '65536' } })
  const save = buttonWith(app.nodes(), app.dict.zh['routing.save'])
  await save.props.onClick()
  assert.equal(saves.length, 1)
  assert.equal(saves[0].contextWindow, 262144)
  assert.equal(saves[0].maxOutput, 65536)
})

await check('a cleared field is written as absent', async () => {
  const saves = []
  const app = mount('ChainEditor', {
    t: key => app.dict.zh[key],
    chain: { id: 'combo:caps', name: 'caps', models: ['a'], strategy: 'fallback', contextWindow: 1000000, maxOutput: 200000, enabled: true },
    models: MODELS, onSave: row => saves.push(row), onCancel: () => {},
  })
  const inputs = numberInputs(app.nodes())
  inputs[0].props.onChange({ target: { value: '' } })
  inputs[1].props.onChange({ target: { value: '' } })
  await buttonWith(app.nodes(), app.dict.zh['routing.save']).props.onClick()
  assert.equal('contextWindow' in saves[0], false, 'an empty input must not write a number')
  assert.equal('maxOutput' in saves[0], false)
})

// 审查意见 #341: "0.5 容量截断成 0"。0.5 个 token 不是容量:输入框里的
// 小数必须与留空等价(不写字段、回落到成员交集),不能写下一个 0。
await check('a fractional capacity below one is not written as zero', async () => {
  const saves = []
  const app = mount('ChainEditor', {
    t: key => app.dict.zh[key],
    chain: { id: 'combo:caps', name: 'caps', models: ['a'], strategy: 'fallback', enabled: true },
    models: MODELS, onSave: row => saves.push(row), onCancel: () => {},
  })
  const inputs = numberInputs(app.nodes())
  inputs[0].props.onChange({ target: { value: '0.5' } })
  inputs[1].props.onChange({ target: { value: '0.5' } })
  await buttonWith(app.nodes(), app.dict.zh['routing.save']).props.onClick()
  assert.equal('contextWindow' in saves[0], false, '0.5 must not be stored as 0')
  assert.equal('maxOutput' in saves[0], false, '0.5 must not be stored as 0')
})

await check('the chain card names the effective numbers', async () => {
  const app = mount('ChainCard', {
    t: key => app.dict.zh[key],
    index: 0,
    chain: { id: 'combo:caps', name: 'caps', models: ['a', 'b'], strategy: 'fallback' },
    resolved: ['a', 'b'],
    missing: [],
    lookup: new Map(MODELS.map(row => [row.id, row])),
    capacity: { contextWindow: 1000000, maxOutput: 200000, vision: false },
    onEdit: () => {},
    onDelete: () => {},
  })
  const text = JSON.stringify(app.nodes())
  assert.ok(text.includes(`${app.dict.zh['tag.context']} 1.0M`), `the window rides on the card: ${text}`)
  assert.ok(text.includes(`${app.dict.zh['tag.output']} 200K`), `the ceiling rides on the card: ${text}`)
})

/**
 * The card's numbers must match the value the user typed and the number the
 * rest of the plugin shows for the same capacity. Typing 500000 and reading
 * 488K (a /1024 KiB fold) instead of 500K (the shared `kilo()` /1000 fold) is
 * the bug this pins: one token count, one label, everywhere.
 */
await check('the chain card folds capacities like every other capacity label', async () => {
  const app = mount('ChainCard', {
    t: key => app.dict.zh[key],
    index: 0,
    chain: { id: 'combo:free', name: 'free', models: ['a'], strategy: 'fallback' },
    resolved: ['a'],
    missing: [],
    lookup: new Map(MODELS.map(row => [row.id, row])),
    capacity: { contextWindow: 500000, maxOutput: 100000, vision: false },
    onEdit: () => {},
    onDelete: () => {},
  })
  const text = JSON.stringify(app.nodes())
  assert.ok(text.includes(`${app.dict.zh['tag.context']} 500K`), `typed 500000 must read 500K, got: ${text.match(/上下文 [^"]*/)?.[0]}`)
  assert.ok(text.includes(`${app.dict.zh['tag.output']} 100K`), `typed 100000 must read 100K, got: ${text.match(/(最长输出|输出) [^"]*/)?.[0]}`)
})

if (failures > 0) console.error(`routing-caps-ui-test: ${failures} failure(s)`)
else console.log('routing-caps-ui-test: the chain capacity inputs render, submit and clear')
process.exitCode = failures > 0 ? 1 : 0
