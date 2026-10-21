import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

// This suite compiles the TSX page source in-process, so it needs esbuild — a
// `packages/standalone` devDependency. The offline CI job installs nothing by
// design (see .github/workflows/test.yml), so the check skips when the compiler
// is absent, the same way the release-preparation suite skips its Windows-only
// symlink check. Locally, where the devDependency is installed, it runs.
let transformSync
try {
  const standaloneRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
  ;({ transformSync } = standaloneRequire('esbuild'))
} catch {
  console.log('ok  standalone-page-lifecycle skipped: esbuild is not installed (the offline job installs nothing)')
  process.exit(0)
}

const source = fs.readFileSync(new URL('../packages/standalone/frontend/app.tsx', import.meta.url), 'utf8')
const code = source.slice(source.indexOf('function App()'), source.indexOf('createRoot(document'))
const slots = [], effects = []
let index = 0
const react = {
  useState(initial) { const at = index++; if (!(at in slots)) slots[at] = typeof initial === 'function' ? initial() : initial; return [slots[at], value => { slots[at] = typeof value === 'function' ? value(slots[at]) : value }] },
  useRef(value) { const at = index++; return slots[at] ??= { current: value } },
  useMemo(factory) { index++; return factory() },
  useEffect(effect, deps) { const at = index++, previous = slots[at]; if (previous?.deps?.length === deps?.length && deps?.every((value, i) => value === previous.deps[i])) return; slots[at] = { deps }; effects.push(effect) },
}
const settings = { enabled: true }
const summary = { settings, catalog: [], networkMode: 'fixture' }
const context = {
  ...react, h: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity) }), Fragment: 'fragment',
  Sidebar: 'Sidebar', Topbar: 'Topbar', SponsorNotice: 'SponsorNotice', Overview: 'Overview', Connection: 'Connection', ChannelMount: 'ChannelMount', LazyPage: 'LazyPage', LoadingScreen: 'LoadingScreen', LoginScreen: 'LoginScreen', AlertCircle: 'AlertCircle',
  pageNames: ['overview', 'models', 'usage', 'channels', 'eac', 'settings', 'connection'], API: '/api/management',
  messageOf: error => error.message, AbortSignal, URLSearchParams, location: { hash: '' }, history: {},
  window: { scrollTo() {}, addEventListener() {}, removeEventListener() {}, setInterval() { return 1 }, clearInterval() {} },
  document: { hidden: false }, navigator: { clipboard: { writeText: async () => {} } },
  fetch: async url => ({ ok: true, json: async () => url.endsWith('/summary') ? summary : { models: [], days: [] } }),
}
vm.createContext(context)
vm.runInContext(transformSync(code + '\nglobalThis.testApp = App', { loader: 'tsx', jsxFactory: 'h', jsxFragment: 'Fragment' }).code, context)
const render = () => { index = 0; return context.testApp() }
const all = tree => tree && typeof tree === 'object' ? [tree, ...tree.children.flatMap(all)] : []
const flush = async () => { for (const effect of effects.splice(0)) effect(); await new Promise(resolve => setImmediate(resolve)) }
render(); await flush()
let tree = render()
const host = () => all(tree).find(node => node.type === 'Sidebar').props.host
host().navigate('settings'); tree = render()
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'settings'))
host().navigate('models'); tree = render()
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'settings' && node.props.active === false), '切页后保留设置组件及草稿，但停止非活动页面任务')
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'models' && node.props.active === true))
host().navigate('usage'); tree = render()
assert.ok(all(tree).some(node => node.type === 'LazyPage' && node.props.name === 'models' && node.props.active === false), '模型筛选状态在切页后保留')
assert.ok(!all(tree).some(node => node.type === 'Connection'), '密钥页面离开后卸载，清除显示的密钥')
host().navigate('channels'); tree = render()
assert.equal(all(tree).find(node => node.type === 'ChannelMount').props.key, 'channels', '账号渠道使用独立嵌套根容器')
host().navigate('eac'); tree = render()
assert.equal(all(tree).find(node => node.type === 'ChannelMount').props.key, 'eac', 'EAC 切换时更换容器，避免旧 React 根覆盖新页面')
let releaseOldKey
context.fetch = async url => url.endsWith('/key') ? new Promise(resolve => { releaseOldKey = resolve }) : { ok: true, json: async () => ({}) }
const oldKey = host().getApiKey().catch(error => error)
await host().logout(); tree = render()
assert.equal(tree.type, 'LoginScreen')
context.fetch = async url => ({ ok: true, json: async () => url.endsWith('/summary') ? summary : { models: [], days: [] } })
await tree.props.request('/session', { key: 'test' }); tree = render()
assert.equal(tree.props.id, 'app')
releaseOldKey({ ok: false, status: 401, json: async () => ({ error: '旧会话已过期' }) })
await oldKey; tree = render()
assert.equal(tree.props.id, 'app', '旧会话迟到 401 不得登出新会话')
console.log('ok  切页保留设置草稿与模型筛选，非活动页面暂停任务，退出移除工作空间')
