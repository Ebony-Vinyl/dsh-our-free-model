/**
 * Static checks for the plugin-center UI and the sandbox host.
 *
 * These do not replace the browser pass; they pin the properties that are easy
 * to regress and expensive to notice by eye: the iframe keeps `allow-scripts`
 * only, the parent validates the sender, the page RPC goes through the
 * session-gated route, and the console actually imports the new page.
 *
 * Run: node scripts/plugins-ui-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8')
let checks = 0
const check = (name, run) => {
  checks += 1
  run()
  console.log(`ok   ${name}`)
}

const app = read('packages/standalone/frontend/app.tsx')
const shell = read('packages/standalone/frontend/components/shell.tsx')
const plugins = read('packages/standalone/frontend/plugins.tsx')
const pluginPage = read('packages/standalone/frontend/plugin-page.tsx')
const management = read('packages/standalone/management.mjs')
const types = read('packages/standalone/frontend/types.ts')
const css = read('packages/standalone/web/app.css')
const web = JSON.parse(read('packages/standalone/web/assets.json'))

check('the console imports the plugin center and the page host', () => {
  assert.match(app, /from '\.\/plugins'/)
  assert.match(app, /from '\.\/plugin-page'/)
  assert.match(app, /<Plugins summary=\{snapshot\.summary\} host=\{host\} active \/>/)
  assert.match(app, /<PluginPage page=\{pluginPage\} onNotice=\{setNotice\} \/>/)
  assert.match(app, /import '\.\/plugins\.css'/)
  assert.match(app, /import '\.\/plugin-page\.css'/)
})

check('the sidebar appends plugin pages to the derived whitelist', () => {
  assert.match(shell, /label: '插件'/)
  assert.match(shell, /pluginPages\.map\(entry => \(\{ id: entry\.id, name: entry\.title, icon: pageIcon\(entry\.icon\) \}\)\)/)
  assert.match(shell, /export function pageIdsFor/)
})

check('the plugin center covers market, installed, built-in and developer flows', () => {
  assert.match(plugins, /host\.request<Marketplace>\('\/plugins'/)
  assert.match(plugins, /'\/plugins\/install'/)
  assert.match(plugins, /'\/plugins\/install-local'/)
  assert.match(plugins, /'\/plugins\/uninstall'/)
  assert.match(plugins, /'\/plugins\/toggle'/)
  assert.match(plugins, /'\/plugins\/config'/)
  assert.match(plugins, /'\/plugins\/secret'/)
  assert.match(plugins, /'\/plugins\/self-test'/)
  assert.match(plugins, /'\/plugins\/registry\/refresh'/)
  assert.match(plugins, /开发者模式/)
  assert.match(plugins, /确认安装/)
  assert.match(plugins, /permissionList\(installTarget\)/)
})

check('a page runs with allow-scripts only', () => {
  assert.match(pluginPage, /sandbox="allow-scripts"/)
  assert.doesNotMatch(pluginPage, /allow-same-origin/)
  assert.doesNotMatch(pluginPage, /allow-top-navigation/)
  assert.doesNotMatch(pluginPage, /allow-forms/)
})

check('the parent validates the iframe sender and answers only the bridge', () => {
  assert.match(pluginPage, /if \(event\.source !== target\.contentWindow\) return/)
  assert.match(pluginPage, /data\.__ofm !== 1/)
  assert.match(pluginPage, /'\/api\/management\/plugins\/page-rpc'/)
  assert.match(pluginPage, /type: 'rpc-reply'/)
  assert.match(pluginPage, /data\.type === 'ready'/)
  assert.match(pluginPage, /MutationObserver/)
})

check('the management layer owns the asset capability and CSP', () => {
  assert.match(management, /PLUGIN_ASSET_RE/)
  assert.match(management, /servePluginAsset/)
  assert.match(management, /frame-ancestors \$\{origin\}/)
  assert.match(management, /cross-origin-resource-policy/)
  assert.match(management, /injectPluginBridge/)
  assert.match(management, /suffix === '\/install-local'/)
  assert.match(management, /suffix === '\/page-rpc'/)
  assert.match(management, /suffix === '\/pages'/)
  assert.match(management, /suffix === '\/audit'/)
})

check('plugin settings and types are part of the console contract', () => {
  assert.match(types, /export interface PluginsSummary/)
  assert.match(types, /export interface PluginPage/)
  assert.match(types, /developerPlugins: boolean/)
  assert.match(types, /request<T = unknown>\(path: string/)
  assert.match(management, /developerPlugins: value\.developerPlugins === true/)
})

check('the built plugin carries the new styles and strings', () => {
  assert.ok(web.includes('app.css') && web.includes('app.js'))
  assert.match(css, /\.plugins-page/)
  assert.match(css, /\.plugin-page-frame/)
  const bundle = read('packages/standalone/web/app.js')
  assert.match(bundle, /插件中心/)
  assert.match(bundle, /allow-scripts/)
})

console.log(`\nok ${checks}/${checks} plugin UI invariants hold`)
