/**
 * The sidebar is the only list of core pages — nothing may restate it.
 *
 * 「模型工作台」在 2.7.1 里是个死入口：侧边栏有这一项，`App` 的 `host.navigate`
 * 却拿另一份手写数组当白名单，`navigate('workspace')` 被 `includes` 直接短路，
 * 于是点击无反应、无报错、无 loading（#678）。
 *
 * 现在页面集合由两部分组成：`CORE_NAVIGATION` 的侧边栏条目，以及 `/summary`
 * 返回的插件页。`pageIdsFor` 把两者拼成唯一的白名单，`App` 只调用它，不再自己
 * 写第二份数组。插件页是运行时数据，因此这里校验的是：
 *
 * 1. 核心导航没有重复条目，每项都有 id；
 * 2. `navigationPages` 从 `CORE_NAVIGATION` 推导；
 * 3. `pageIdsFor` 同时包含核心页与插件页；
 * 4. `app.tsx` 使用 `pageIdsFor` 而不是手写白名单。
 *
 * 纯静态检查：不需要浏览器，也不构建前端产物。
 *
 * Run: node scripts/standalone-nav-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const frontend = path.join(root, 'packages', 'standalone', 'frontend')
const read = rel => fs.readFileSync(path.join(frontend, rel), 'utf8')

let checks = 0
const check = (name, run) => {
  checks++
  run()
  console.log(`ok  ${name}`)
}

const shell = read('components/shell.tsx')
const app = read('app.tsx')

check('the core navigation is a single declared list', () => {
  assert.match(shell, /const CORE_NAVIGATION: NavGroup\[\] = \[/)
  assert.match(shell, /export const navigationPages: Page\[\] = CORE_NAVIGATION\.flatMap/)
})

check('the core navigation has no duplicate ids and every entry names one', () => {
  const block = /const CORE_NAVIGATION: NavGroup\[\] = \[([\s\S]*?)\n\]/.exec(shell)
  assert.ok(block, 'CORE_NAVIGATION must be a literal array')
  const ids = [...block[1].matchAll(/\bid:\s*'([a-z-]+)'/g)].map(match => match[1])
  assert.ok(ids.length > 0)
  assert.equal(new Set(ids).size, ids.length, `duplicated: ${ids.filter((id, index) => ids.indexOf(id) !== index).join(', ')}`)
  assert.ok(ids.includes('plugins'), 'the plugin center must be reachable from the core sidebar')
})

check('pageIdsFor appends plugin pages to the core whitelist', () => {
  assert.match(shell, /export function pageIdsFor\(pluginPages: PluginPage\[\] = \[\]\): Page\[\]/)
  assert.match(shell, /return \[\.\.\.navigationPages, \.\.\.pluginPages\.map\(page => page\.id\)\]/)
})

check('the sidebar renders plugin pages from the summary, not a hardcoded list', () => {
  assert.match(shell, /pluginPages: PluginPage\[\] = \[\]/)
  assert.match(shell, /label: '插件'/)
  assert.match(shell, /items: pluginPages\.map\(entry => \(\{ id: entry\.id, name: entry\.title, icon: pageIcon\(entry\.icon\) \}\)\)/)
})

check('App navigates against the derived list', () => {
  assert.match(app, /pageIdsFor/)
  assert.match(app, /pageIds\.includes\(next\)/)
  assert.doesNotMatch(app, /navigationPages\.includes/)
})

check('App resolves a plugin page to the sandbox host', () => {
  assert.match(app, /pluginPage = pluginPages\.find\(entry => entry\.id === page\)/)
  assert.match(app, /<PluginPage page=\{pluginPage\} onNotice=\{setNotice\} \/>/)
})

console.log(`\nok ${checks}/${checks} navigation invariants hold`)
