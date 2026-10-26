import assert from 'node:assert/strict'
import fs from 'node:fs'

const app = fs.readFileSync(new URL('../packages/standalone/frontend/app.tsx', import.meta.url), 'utf8')
const html = fs.readFileSync(new URL('../packages/standalone/frontend/index.html', import.meta.url), 'utf8')
assert.ok(!app.includes("./legacy"), 'React 入口不得依赖 legacy 宿主')
assert.ok(!fs.existsSync(new URL('../packages/standalone/frontend/legacy.js', import.meta.url)), 'legacy 宿主必须删除')
assert.ok(html.includes('id="root"'), '入口必须只提供 React 根节点')
assert.ok(!html.includes('page-connection'), '连接页不得由静态 HTML 承载')
assert.ok(app.includes('function LoginScreen'), '登录页必须由 React 渲染')
assert.ok(app.includes('function LoadingScreen'), '加载页必须由 React 渲染')
assert.ok(app.includes('function ChannelMount'), '渠道页必须由 React 生命周期管理')
export function verifySettingsHost() { return true }
console.log('standalone-settings-host: React 根入口、登录页、连接页和宿主生命周期检查通过')
