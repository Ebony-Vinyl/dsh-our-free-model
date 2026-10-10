/**
 * 设置接口往返测试：`hideChannelModels` 必须能被写入、持久化、回读。
 *
 * 同时覆盖一条重要的降级路径：渠道包**未挂载**时（headless / CLI 组合缺
 * credentials 或 commands，或 pack 加载失败），`channelVisibility` 停在默认的
 * no-op 上。此时保存设置不能抛错 —— 否则用户一改设置就 500。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { callRoute, fakeContext, until } from './lib/fake-kernel.mjs'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-visibility-settings-'))
process.env.DSH_HOME = home

const { apply, inject } = await import('../index.js')

const routes = []
// 只挂 llm/webServer 等：**故意不挂** credentials/commands，让渠道包的 inject
// 永远不触发 —— 这正是 headless 组合的形状。
const ctx = fakeContext({ inject, mounted: ['llm', 'webServer', 'attachments'], onRegister: route => routes.push(route) })
apply(ctx, {})

try {
  const api = () => routes.find(route => route.kind === 'prefix')?.handler
  await until(() => api() !== undefined, { what: 'the settings API route', timeoutMs: 5000 })

  const settingsPath = path.join(home, 'our-free-model', 'settings.json')

  // 默认关闭：升级不应静默改变用户看到的模型列表。
  const before = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  assert.equal(before.json.settings.hideChannelModels, false, '默认不隐藏渠道分组')

  // 打开：接口 200、载荷回读为 true、并落到 settings.json。
  const on = await callRoute(api(), 'POST', '/api/our-free-model/settings', { hideChannelModels: true })
  assert.equal(on.status, 200, '打开开关返回 200')
  assert.equal(on.json.settings.hideChannelModels, true, '载荷回读为 true')
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hideChannelModels, true, '已持久化到 settings.json')

  // 重新读一次 summary，确认不是只在本次响应里正确。
  const after = await callRoute(api(), 'GET', '/api/our-free-model/summary')
  assert.equal(after.json.settings.hideChannelModels, true, 'summary 回读为 true')

  // 关闭：恢复 false（可逆）。
  const off = await callRoute(api(), 'POST', '/api/our-free-model/settings', { hideChannelModels: false })
  assert.equal(off.status, 200, '关闭开关返回 200')
  assert.equal(off.json.settings.hideChannelModels, false, '载荷回读为 false')
  assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).hideChannelModels, false, '已持久化为 false')

  // 其它设置照常可写（没有把既有字段挤掉）。
  const other = await callRoute(api(), 'POST', '/api/our-free-model/settings', { probeIntervalMinutes: 42 })
  assert.equal(other.json.settings.probeIntervalMinutes, 42, '其它设置项仍可写')
  assert.equal(other.json.settings.hideChannelModels, false, '且不影响新开关')

  console.log('ok  设置往返：默认关、开则落盘回读为真、关则恢复、渠道包未挂载时不报错')
} finally {
  for (const disposer of ctx.__disposers.reverse()) {
    try { disposer() } catch { /* teardown must not fail the suite */ }
  }
  fs.rmSync(home, { recursive: true, force: true })
}
