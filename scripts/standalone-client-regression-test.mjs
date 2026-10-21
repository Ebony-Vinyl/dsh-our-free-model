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
  useMemo: callback => callback(),
  useCallback: callback => callback,
}
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
  rpc: async (method, payload) => {
    rpcCalls.push({ method, payload })
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
  { id: 'combo', channel: 'combo' }, { id: 'account', channel: 'lobsterai' },
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
try { ({ transformSync } = createRequire(new URL('../packages/standalone/package.json', import.meta.url))('esbuild')) } catch {}
if (transformSync) {
const modelsSource = fs.readFileSync(new URL('../packages/standalone/frontend/models.tsx', import.meta.url), 'utf8')
const modelsBody = modelsSource.slice(modelsSource.indexOf('const availabilityNames')).replace('export function Models', 'function Models')
cells.length = 0
const standaloneSummary = { settings: { enabled: true, hiddenModelIds: [], hideFreeModels: false, hideEacModels: false },
  catalog: [{ id: 'free', name: 'Free', channel: 'anonymous', routable: true }, { id: 'account', name: 'Account', channel: 'lobsterai', routable: true }] }
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
