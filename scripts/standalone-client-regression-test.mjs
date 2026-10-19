import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { computeMembership } from '../src/core/runtime.js'
import { isModelHidden, publicModelVisibility, validateModelVisibility } from '../src/store.js'
import { buildComboCatalog } from '../src/combos.js'
import { filterModels } from '../packages/standalone/frontend/models-data.mjs'
import { visibilityCopy } from '../packages/standalone/frontend/visibility-data.mjs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { Shell, FreePage, ChannelCard, DICT, Roster, ModelCard, Preferences, ModelPicker, ChainEditor, ChainCard, ChainCapacity,')
let bundle
const window = { __ModuleLoader__: { load: value => { bundle = value } } }
let cursor = 0
const cells = []
let captureEffects = false
const effects = []
const react = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  Fragment: 'fragment',
  useState(initial) {
    const at = cursor++
    if (!(at in cells)) cells[at] = typeof initial === 'function' ? initial() : initial
    return [cells[at], value => { cells[at] = typeof value === 'function' ? value(cells[at]) : value }]
  },
  useRef(initial) { const at = cursor++; return cells[at] ??= { current: initial } },
  useEffect(effect) { if (captureEffects) effects.push(effect) },
  // 这里必须像 React 一样**吃掉一个 cell**：组件里 useCallback 与 useState 交错，
  // 假实现若不占位，一个 `const load = useCallback(...)` 就会把后面所有 useState 的
  // 槽位整体错开——加一行回调能让无关的「已隐藏」断言翻红，而真实 DOM 没变。
  // deps 逐个比较是为了让身份随依赖变化，与 React 一致。
  useMemo(callback, deps) {
    const at = cursor++
    const prev = cells[at]
    if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.value
    const value = callback()
    cells[at] = { deps, value }
    return value
  },
  useCallback(callback, deps) {
    const at = cursor++
    const prev = cells[at]
    if (prev !== undefined && sameDeps(prev.deps, deps)) return prev.value
    cells[at] = { deps, value: callback }
    return callback
  },
}
const sameDeps = (a, b) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((value, index) => Object.is(value, b[index]))
let release, reject
const calls = []
const fetch = async (url, options) => {
  calls.push({ url, options })
  if (url.endsWith('/combos/preview')) {
    const { models } = JSON.parse(options.body)
    const capacity = buildComboCatalog([{ id: 'combo:preview', models }], capacityModels)[0] ?? null
    return { ok: true, text: async () => JSON.stringify({ capacity }) }
  }
  return new Promise((resolve, fail) => {
    release = () => resolve({ ok: true, text: async () => '{}' })
    reject = fail
  })
}
new Function('window', 'fetch', source)(window, fetch)
const { Shell, FreePage, ChannelCard, DICT, Roster, ModelCard, Preferences, ModelPicker, ChainEditor, ChainCard, ChainCapacity } = bundle.factory(() => react).__test
const t = key => DICT.zh[key] ?? key
const nodes = tree => Array.isArray(tree) ? tree.flatMap(nodes)
  : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
const render = (Component, props) => { cursor = 0; return Component(props) }
let summaryReads = 0, statsReads = 0
const props = {
  t, data: { catalog: [], settings: {} }, counts: {}, busy: false,
  summary: { status: 'ready', reload: () => { summaryReads++ } },
  stats: { reload: () => { statsReads++ } },
  setBusy: () => assert.fail('catalog requests must not lock settings writes'),
}
const page = () => nodes(render(Shell, props)).find(node => node.type === FreePage)
const first = page().props.reprobe()
const duplicate = page().props.refresh()
assert.equal(calls.length, 1, 'a pending probe excludes duplicate catalog operations')
assert.equal(page().props.catalogBusy, true)
assert.equal(page().props.busy, false, 'other settings remain available while probing')
await duplicate
release()
await first
assert.equal(page().props.catalogBusy, false)
assert.equal(summaryReads, 1)
assert.equal(statsReads, 1)
const failed = page().props.reprobe()
reject(new Error('isolated probe failure'))
await failed
assert.equal(page().props.catalogBusy, false, 'failure must release the probe controls')
const retry = page().props.refresh()
assert.equal(calls.length, 3, 'a failed probe can be retried')
release()
await retry

cells.length = 0
let models = [{ id: 'retired', dead: true, disabled: true }]
let accounts = [{ id: 'account', nickname: 'Fixture', enabled: true }]
const rpcCalls = []
let changed = 0
const channelProps = {
  t, channel: { id: 'codearts', name: 'CodeArts' }, status: {},
  onError: (_provider, error) => { throw error },
  onChanged: () => { changed++ },
  // 卡片现在会拿到 ctx（老 pack 的促销标注要经 session.modelCatalog 读长标注）。
  // 这个固定装置不给宿主：ctx 缺省时兼容分支必须安静跳过而不是抛错——这正是
  // 下面 model.list 一行仍要能渲染出来的原因，别把 ctx 当必填项处理。
  ctx: {},
  rpc: async (method, payload) => {
    rpcCalls.push({ method, payload })
    // 当前 pack 的 `model.list` 声明了能力位 `promoTransport: true`
    // （见 vendor/channel-pack/src/channel-pack-rpc.ts）。固定装置若照实不带，
    // 卡片就会走「老 pack 兼容分支」，去宿主目录多读一次——那不是这个用例要
    // 测的东西，却能让下面的断言行因为一次 await 而看不到模型行。照契约给上。
    if (method === 'model.list') return { models, promoTransport: true }
    if (method === 'model.clearDead') models = models.map(model => ({ ...model, dead: false }))
    if (method === 'model.setDisabled') models = models.map(model => ({ ...model, disabled: payload.disabled }))
    if (method === 'account.update') accounts = accounts.map(row => ({ ...row, ...payload.patch }))
    return { models, accounts }
  },
}
const button = (tree, text) => nodes(tree).find(node => node.type === 'button' && node.children.includes(text))
let card = render(ChannelCard, channelProps)
await button(card, '模型').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已隐藏')))
await button(card, '恢复显示').props.onClick()
assert.equal(rpcCalls.find(call => call.method === 'model.clearDead').payload.modelId, 'retired')
assert.equal(models[0].disabled, true, 'restoring a retired model preserves the user blacklist')
assert.equal(rpcCalls.some(call => call.method === 'model.setDisabled'), false)
card = render(ChannelCard, channelProps)
await button(card, '开启').props.onClick()
assert.equal(models[0].disabled, false)
card = render(ChannelCard, channelProps)
await button(card, '账号').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已启用')))
await button(card, '停用').props.onClick()
card = render(ChannelCard, channelProps)
assert.ok(nodes(card).some(node => node.children.includes('已停用')))
assert.ok(button(card, '启用'))
assert.equal(changed, 3)
console.log('ok  client probe isolation/retry, account action labels, hidden status and retired model restoration')

const catalog = [
  { id: 'free' }, { id: 'region' }, { id: 'kilo', channel: 'kilo' },
  { id: 'eac', channel: 'eac' }, { id: 'aggregate', channel: 'aggregate' },
  { id: 'combo', channel: 'combo' }, { id: 'account', channel: 'buddy' },
]
const refused = { results: { free: { state: 'unavailable' }, region: { state: 'unavailable' } } }
const membership = settings => Object.values(computeMembership(catalog, refused, settings)).flat()
assert.deepEqual(membership({}), catalog.map(row => row.id), 'default fallback preserves the advertised catalog')
assert.deepEqual(membership({ hideFreeModels: true }), ['eac', 'aggregate', 'combo', 'account'])
assert.deepEqual(membership({ hideEacModels: true, hiddenModelIds: ['free'] }), ['region', 'kilo', 'aggregate', 'combo', 'account'])
assert.deepEqual(membership({ hideFreeModels: true, hideEacModels: true, hiddenModelIds: ['combo'] }), ['aggregate', 'account'],
  'refusedAll cannot restore preferences; unrelated channels remain isolated')
const region = computeMembership(catalog, { results: { region: { state: 'region-blocked' } } }, { hiddenModelIds: ['region'] })
assert.equal(Object.values(region).flat().includes('region'), false)
for (const patch of [{ hideFreeModels: 1 }, { hideEacModels: null }, { hiddenModelIds: [''] }, { hiddenModelIds: [3] }, null, []]) {
  assert.throws(() => validateModelVisibility(patch), error => error.statusCode === 400)
}
assert.deepEqual(publicModelVisibility({ hiddenModelIds: ['free', 'free', null], forwardKey: 'private' }),
  { hiddenModelIds: ['free'], hideFreeModels: false, hideEacModels: false })

for (const language of ['zh', 'en']) {
  cells.length = 0
  const translate = key => DICT[language][key]
  const writes = []
  const summary = { settings: { hiddenModelIds: ['free'], hideFreeModels: false, hideEacModels: false },
    catalog: [{ id: 'free', name: 'Free fixture', route: null, hiddenByUser: true, availability: 'available' }] }
  const roster = render(Roster, { summary, t: translate, onApply: patch => writes.push(patch), only: 'free' })
  const row = nodes(roster).find(node => node.type === ModelCard)
  assert.ok(row, 'route:null entries must retain a recovery control')
  const card = render(ModelCard, row.props)
  const control = nodes(card).find(node => node.props.label === translate('visibility.showModel'))
  assert.equal(control.props.checked, false)
  control.props.onChange()
  assert.deepEqual(writes.pop(), { hiddenModelIds: [] })
  nodes(roster).find(node => node.props.label === translate('pref.hideFreeModels')).props.onChange()
  assert.deepEqual(writes.pop(), { hideFreeModels: true })
  cells.length = 0
  const preferences = render(Preferences, { summary, t: translate, onApply: patch => writes.push(patch) })
  nodes(preferences).find(node => node.props.label === translate('pref.hideEacModels')).props.onChange()
  assert.deepEqual(writes.pop(), { hideEacModels: true })
}
console.log('ok  visibility fallback isolation, validation, recovery controls and bilingual plugin actions')

const capacityModels = [
  { id: 'large', name: 'Large', contextWindow: 1000000, maxOutput: 64000, vision: true },
  { id: 'small', name: 'Small', contextWindow: 128000, maxOutput: 16000, vision: false },
]
cells.length = 0
const picker = render(ModelPicker, { t, models: capacityModels, chosen: [], onPick() {} })
assert.ok(nodes(picker).some(node => node.children.includes(`${t('tag.context')} 1.0M`)))
captureEffects = true
const editorProps = { t, models: capacityModels, chain: { name: 'Fixture', models: ['small', 'large'] } }
render(ChainEditor, editorProps)
for (const effect of effects.splice(0)) effect()
await new Promise(resolve => setImmediate(resolve))
let editor = render(ChainEditor, editorProps)
let capacity = nodes(editor).find(node => node.type === ChainCapacity).props.capacity
assert.equal(capacity.contextWindow, 128000)
assert.equal(capacity.maxOutput, 16000)
assert.equal(capacity.vision, false)
effects.length = 0
button(editor, t('routing.removeMember')).props.onClick()
render(ChainEditor, editorProps)
for (const effect of effects.splice(0)) effect()
await new Promise(resolve => setImmediate(resolve))
editor = render(ChainEditor, editorProps)
capacity = nodes(editor).find(node => node.type === ChainCapacity).props.capacity
assert.equal(capacity.contextWindow, 1000000, 'removing the small member refreshes the real intersection')
captureEffects = false
effects.length = 0
const savedCard = render(ChainCard, { t, chain: { id: 'combo:fixture', name: 'Fixture', models: ['large'] },
  resolved: ['large'], missing: [], lookup: new Map(capacityModels.map(row => [row.id, row])), capacity, onEdit() {} })
assert.equal(nodes(savedCard).find(node => node.type === ChainCapacity).props.capacity.contextWindow, 1000000)
assert.ok(nodes(ChainCapacity({ t, capacity })).some(node => node.children.includes(`${t('tag.context')} 1.0M`)))
console.log('ok  combo picker capacities, saved card and live server intersection refresh')

// Compile the actual standalone page in memory, without rebuilding web output.
const require = createRequire(import.meta.url)
let transformSync
try { ({ transformSync } = require('esbuild')) } catch {}
if (transformSync) {
const modelsSource = fs.readFileSync(new URL('../packages/standalone/frontend/models.tsx', import.meta.url), 'utf8')
const modelsBody = modelsSource.slice(modelsSource.indexOf('const availabilityNames')).replace('export function Models', 'function Models')
cells.length = 0
const standaloneSummary = { settings: { enabled: true, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false },
  catalog: [{ id: 'free', name: 'Free', channel: 'anonymous', routable: true }, { id: 'account', name: 'Account', channel: 'buddy', routable: true }] }
const savedPatches = []
const context = {
  ...react, h: react.createElement, Fragment: 'fragment', providers: [], filterModels, visibilityCopy,
  document: { documentElement: { lang: 'en' } },
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }) => ({ getTotalSize: () => count * 112,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, key: index, start: index * 112 })), measureElement() {} }),
  ...Object.fromEntries(['Badge', 'Button', 'Input', 'Boxes', 'Check', 'CircleAlert', 'CircleCheck', 'Copy', 'Eye', 'EyeOff',
    'LoaderCircle', 'Play', 'RefreshCw', 'Search', 'SlidersHorizontal', 'Square', 'X'].map(name => [name, name])),
}
vm.createContext(context)
vm.runInContext(transformSync(modelsBody + '\nglobalThis.Page = Models', { loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code, context)
const standaloneProps = { active: true, summary: standaloneSummary, host: {
  saveSettings: async patch => {
    savedPatches.push(JSON.parse(JSON.stringify(patch)))
    Object.assign(standaloneSummary.settings, patch)
    for (const model of standaloneSummary.catalog) {
      model.hiddenByUser = isModelHidden(model, standaloneSummary.settings)
      model.hiddenByGroup = isModelHidden(model, { ...standaloneSummary.settings, hiddenModelIds: [] })
    }
  },
  refresh: async () => {}, error: error => { throw error },
} }
let standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Hide model：free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hiddenModelIds: ['free'] })
standaloneTree = render(context.Page, standaloneProps)
const group = nodes(standaloneTree).find(node => node.type === 'input' && node.props.role === 'switch')
group.props.onChange({ target: { checked: true } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hideFreeModels: true })
standaloneTree = render(context.Page, standaloneProps)
assert.equal(nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：free').props.disabled, true)
assert.equal(nodes(standaloneTree).some(node => /(?:Hide|Show) model：account/.test(node.props['aria-label'] ?? '')), false)
nodes(standaloneTree).find(node => node.type === 'input' && node.props.role === 'switch').props.onChange({ target: { checked: false } })
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(Array.from(standaloneSummary.settings.hiddenModelIds), ['free'], 'group restore preserves individual choices')
standaloneTree = render(context.Page, standaloneProps)
nodes(standaloneTree).find(node => node.props['aria-label'] === 'Show model：free').props.onClick()
await new Promise(resolve => setImmediate(resolve))
assert.deepEqual(savedPatches.pop(), { hiddenModelIds: [] })
console.log('ok  standalone actual model-row and group controls save preferences and isolate account channels')
} else {
  console.log('ok  standalone TSX visibility controls skipped: esbuild is not installed')
}
