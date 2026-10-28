/**
 * The sidebar is the only list of pages — nothing may restate it.
 *
 * 「模型工作台」在 2.7.1 里是个死入口：侧边栏有这一项，`App` 的 `host.navigate`
 * 却拿另一份手写数组当白名单，`navigate('workspace')` 被 `includes` 直接短路，
 * 于是点击无反应、无报错、无 loading（#678）。
 *
 * 修法不是往白名单里补一个字符串，而是让它**从侧边栏推导**。这个脚本守住两件事：
 *
 * 1. `Page` 联合类型与侧边栏条目是同一个集合 —— 类型允许的页面必须真的能点到，
 *    侧边栏也不能列出类型里没有的页面；
 * 2. `app.tsx` 不再自己写一份名单，而是用 `shell.tsx` 导出的 `navigationPages`。
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

// ── the declared page set ───────────────────────────────────────────────────
const types = read('types.ts')
const pageUnion = /export type Page\s*=([\s\S]*?)\n/.exec(types)
assert.ok(pageUnion, 'types.ts must declare `export type Page = ...`')
const declared = new Set([...pageUnion[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]))
assert.ok(declared.size > 0, 'the Page union must list at least one page')

// ── the sidebar ─────────────────────────────────────────────────────────────
const shell = read('components/shell.tsx')
const navigationBlock = /const navigation = \[([\s\S]*?)\n\] as const/.exec(shell)
assert.ok(navigationBlock, 'shell.tsx must declare `const navigation = [...] as const`')
const listed = [...navigationBlock[1].matchAll(/\bid:\s*'([a-z-]+)'/g)].map(match => match[1])
assert.ok(listed.length > 0, 'the sidebar must list at least one page')

check('every page the Page type allows is reachable from the sidebar', () => {
  const missing = [...declared].filter(page => !listed.includes(page))
  assert.deepEqual(missing, [], `unreachable pages: ${missing.join(', ')}`)
})

check('and the sidebar lists no page outside the Page type', () => {
  const extra = listed.filter(page => !declared.has(page))
  assert.deepEqual(extra, [], `sidebar entries missing from the type: ${extra.join(', ')}`)
})

check('the sidebar has no duplicate entries', () => {
  const duplicates = listed.filter((page, index) => listed.indexOf(page) !== index)
  assert.deepEqual([...new Set(duplicates)], [], `duplicated: ${[...new Set(duplicates)].join(', ')}`)
})

// ── the whitelist must be derived, never restated ───────────────────────────
const app = read('app.tsx')

check('App navigates against the sidebar-derived list', () => {
  assert.match(app, /from '\.\/components\/shell'/, 'app.tsx must import from the shell')
  assert.match(app, /\bnavigationPages\b/, 'app.tsx must use `navigationPages`')
  assert.doesNotMatch(app, /\bpageNames\b/, 'app.tsx must not keep its own page-name list')
})

check('and shell.tsx actually exports it', () => {
  assert.match(shell, /export const navigationPages: Page\[\] = navigation\.flatMap\(/, 'shell.tsx must export `navigationPages` derived from `navigation`')
})

console.log(`\nok ${checks}/${checks} navigation invariants hold`)
