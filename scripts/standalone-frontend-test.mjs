import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { buildStats } from '../src/core/stats.js'
import { filterModels } from '../packages/standalone/frontend/models-data.mjs'
import { usageDays, usageModels } from '../packages/standalone/frontend/usage-data.mjs'
import { settingsDraft, settingsChanged, syncSettings, validateSettingsDraft } from '../packages/standalone/frontend/settings-data.mjs'
import { verifySettingsHost } from './standalone-settings-host-test.mjs'
import { verifyModelOperation } from './standalone-model-operation-test.mjs'
import { verifyChannelFilters } from './standalone-channel-filter-test.mjs'
import { spawnSync } from 'node:child_process'

const web = new URL('../packages/standalone/web/', import.meta.url)
const assets = JSON.parse(fs.readFileSync(new URL('assets.json', web), 'utf8'))
assert.equal(new Set(assets).size, assets.length)
assert.ok(assets.includes('app.js') && assets.includes('app.css'))
assert.ok(assets.every(name => /^[\w-]+\.(js|css)$/.test(name)))
for (const name of assets) assert.ok(fs.statSync(new URL(name, web)).size > 0)
const html = fs.readFileSync(new URL('index.html', web), 'utf8')
const themeSource = fs.readFileSync(new URL('../packages/standalone/frontend/theme.mjs', import.meta.url), 'utf8')
for (const [saved, prefersDark, expected, storageUnavailable] of [
  ['dark', false, 'dark'],
  ['light', true, 'light'],
  [null, true, 'dark'],
  [null, false, 'light'],
  ['invalid', true, 'dark'],
  [null, true, 'dark', true],
]) {
  const document = { documentElement: { dataset: {} } }
  vm.runInNewContext(themeSource, {
    document,
    localStorage: { getItem() { if (storageUnavailable) throw new Error('存储不可用'); return saved } },
    window: { matchMedia: () => ({ matches: prefersDark }) },
  })
  assert.equal(document.documentElement.dataset.theme, expected,
    `主题初始化：保存值=${saved}，系统深色=${prefersDark}，存储不可用=${!!storageUnavailable}`)
}
assert.match(html, /type="module".+src="\/assets\/app.js"/)
assert.ok(!html.includes('channels-'), '渠道不应在登录首屏预加载')
assert.ok(!html.includes('models-'), '模型页面不应在登录首屏预加载')
assert.ok(!html.includes('usage-'), '用量页面不应在登录首屏预加载')
assert.ok(!html.includes('settings-'), '设置页面不应在登录首屏预加载')
assert.ok(!html.includes('app.tsx'), '只提供编译后的资源')
assert.ok(!fs.existsSync(new URL('channels.js', web)), '不同时携带第二份 React 渠道包')
const app = fs.readFileSync(new URL('app.js', web), 'utf8')
const channel = assets.find(name => name.startsWith('channels-'))
assert.ok(channel, '渠道必须是独立分包')
assert.ok(app.includes(channel) && app.includes('import('), '入口必须动态导入渠道')
const modelsChunk = assets.find(name => name.startsWith('models-'))
assert.ok(modelsChunk && app.includes(modelsChunk), '入口必须按需导入模型页面')
const usageChunk = assets.find(name => name.startsWith('usage-'))
assert.ok(usageChunk && app.includes(usageChunk), '入口必须按需导入用量页面')
const settingsChunk = assets.find(name => name.startsWith('settings-'))
assert.ok(settingsChunk && app.includes(settingsChunk), '入口必须按需导入服务设置')
for (const [_, name] of html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/g)) {
  assert.ok(assets.includes(name), `HTML 资源未登记：${name}`)
}
for (const name of assets.filter(name => name.endsWith('.js'))) {
  const source = fs.readFileSync(new URL(name, web), 'utf8')
  for (const [_, dependency] of source.matchAll(/(?:from|import\()\s*["']\.\/([^"']+\.js)["']/g)) {
    assert.ok(assets.includes(dependency), `分包依赖未登记：${dependency}`)
  }
}
const empty = buildStats({}, [])
assert.equal(empty.turns, 0)
assert.equal(empty.requests, 0)
assert.equal(empty.recoveredTurns, 0)
assert.deepEqual(empty.samples, [])
const catalog = Array.from({ length: 1000 }, (_, index) => ({
  id: `provider/model-${index}`, name: `测试模型 ${index}`, channel: index % 2 ? 'buddy' : 'kilo',
  vision: index % 3 === 0, reasoning: index % 5 === 0, routable: index % 7 !== 0,
  availability: index % 2 ? 'listed' : 'available',
}))
const baseline = structuredClone(catalog)
assert.equal(filterModels(catalog, {}).length, 1000)
assert.equal(filterModels(catalog, { search: '  PROVIDER/MODEL-999  ' })[0].id, catalog[999].id)
assert.equal(filterModels(catalog, { search: '测试模型 999' }).length, 1)
assert.equal(filterModels(catalog, { channel: 'eac' }).length, 0)
assert.ok(filterModels(catalog, { capability: 'text' }).every(model => !model.vision))
const combined = filterModels(catalog, { channel: 'buddy', capability: 'reasoning', availability: 'listed', access: 'routable' })
assert.ok(combined.length > 0)
assert.ok(combined.every(model => model.channel === 'buddy' && model.reasoning && model.routable && model.availability === 'listed'))
assert.equal(filterModels(catalog, { channel: 'buddy', availability: 'available' }).length, 0)
assert.equal(filterModels(catalog, { access: 'hidden' }).length + filterModels(catalog, { access: 'routable' }).length, catalog.length)
assert.equal(filterModels([{ id: 'unknown', name: '未知状态', routable: false }], { availability: 'unknown' }).length, 1)
assert.deepEqual(catalog, baseline, '视图筛选不得改变目录、公开状态或模型开关')
const usageRows = Array.from({ length: 47 }, (_, index) => ({
  model: `fixture/usage-${index}`, name: `用量模型 ${index}`, calls: index + 1, turns: index,
  input: index * 10, output: (46 - index) * 20, failedTurns: index % 4,
}))
const usageBaseline = structuredClone(usageRows)
const first = usageModels(usageRows)
assert.equal(first.total, 47)
assert.equal(first.pages, 3)
assert.equal(first.rows.length, 20)
assert.equal(first.rows[0].model, 'fixture/usage-46')
assert.equal(usageModels(usageRows, { page: 3 }).rows.length, 7)
assert.equal(usageModels(usageRows, { page: 999 }).page, 3)
assert.equal(usageModels(usageRows, { page: -1 }).page, 1)
assert.equal(usageModels([], { page: 3 }).page, 1)
assert.equal(usageModels(usageRows, { search: '  FIXTURE/USAGE-46  ', page: 3 }).rows[0].model, 'fixture/usage-46')
assert.equal(usageModels(usageRows, { search: '用量模型 46' }).total, 1)
assert.equal(usageModels(usageRows, { search: '没有这个模型' }).total, 0)
assert.equal(usageModels(usageRows, { sort: 'tokens' }).rows[0].model, 'fixture/usage-0')
assert.equal(usageModels(usageRows, { sort: 'failedTurns' }).rows[0].failedTurns, 3)
assert.equal(usageModels(usageRows, { sort: 'name' }).rows[0].name, '用量模型 0')
assert.deepEqual(usageRows, usageBaseline, '筛选排序不得修改累计统计')
const series = [{ day: '2025-12-31', total: 18 }, { day: '2026-01-02', total: 7 }, { day: '2026-01-03', total: 999 }]
const seriesBaseline = structuredClone(series)
assert.deepEqual(usageDays(series, 3, new Date(2026, 0, 2, 1)), [
  { day: '2025-12-31', total: 18 }, { day: '2026-01-01', total: 0 }, { day: '2026-01-02', total: 7 },
])
assert.deepEqual(usageDays([], 1, new Date(2026, 9, 9)), [{ day: '2026-10-09', total: 0 }])
assert.equal(usageDays(series, 30, new Date(2026, 0, 2)).length, 30)
assert.deepEqual(series, seriesBaseline)
// 跨夏令时不能按固定 24 小时回退；本地日期在两个时区均应连续且不重复。
for (const timezone of ['Asia/Shanghai', 'America/New_York']) {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict'
    import { usageDays } from './packages/standalone/frontend/usage-data.mjs'
    assert.deepEqual(usageDays([], 3, new Date(2026, 2, 9, 1)).map(row => row.day),
      ['2026-03-07', '2026-03-08', '2026-03-09'])
  `], { cwd: new URL('../', import.meta.url), env: { ...process.env, TZ: timezone }, encoding: 'utf8' })
  assert.equal(result.status, 0, `${timezone}: ${result.stderr}`)
}
const cumulative = buildStats({
  requests: 50, failedRequests: 3, logical: { turns: 40, failed: 2, recovered: 4, estimated: true, models: {} },
  models: { old: { input: 9000, output: 1000, reasoning: 10, calls: 50, failed: 3 } },
  days: { '2026-01-01': { total: 18, models: {} } },
}, [])
assert.equal(cumulative.grand.input + cumulative.grand.output, 10000)
assert.equal(usageDays(cumulative.days, 14, new Date(2026, 9, 9)).reduce((sum, row) => sum + row.total, 0), 0)
assert.equal(cumulative.turns, 40)
assert.equal(cumulative.requests, 50)
assert.equal(cumulative.logicalEstimated, true)
assert.equal(cumulative.requestFailures, 3)
const savedSettings = {
  enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false,
  defaultMaxTokens: 32768, probeIntervalMinutes: 15,
}
const cleanDraft = settingsDraft(savedSettings)
assert.equal(settingsChanged(cleanDraft, savedSettings), false)
assert.deepEqual(validateSettingsDraft(cleanDraft).patch, savedSettings)
for (const [field, valid, invalid] of [
  ['defaultMaxTokens', ['512', '131072', ' 8192 '], ['', ' ', '511', '131073', '512.5', 'NaN', 'Infinity']],
  ['probeIntervalMinutes', ['1', '1440', '12'], ['', ' ', '0', '1441', '1.5', 'NaN', 'Infinity']],
]) {
  for (const value of valid) {
    const result = validateSettingsDraft({ ...cleanDraft, [field]: value })
    assert.ok(result.patch, `${field}=${value} 应可保存`)
    assert.equal(result.patch[field], Number(value))
  }
  for (const value of invalid) {
    const result = validateSettingsDraft({ ...cleanDraft, [field]: value })
    assert.equal(result.patch, null, `${field}=${value} 不应提交`)
    assert.ok(result.errors[field])
  }
}
const bothInvalid = validateSettingsDraft({ ...cleanDraft, defaultMaxTokens: '', probeIntervalMinutes: '0' })
assert.equal(Object.keys(bothInvalid.errors).length, 2)
assert.ok(!Object.hasOwn(validateSettingsDraft({ ...cleanDraft, forwardKey: '不应进入请求' }).patch, 'forwardKey'))
const editedDraft = { ...cleanDraft, defaultMaxTokens: '8192', enabled: false }
assert.equal(settingsChanged(editedDraft, savedSettings), true)
const nextSaved = { ...savedSettings, probeIntervalMinutes: 12 }
assert.deepEqual(syncSettings({ saved: savedSettings, draft: cleanDraft }, nextSaved, false),
  { saved: nextSaved, draft: settingsDraft(nextSaved) }, '无修改时跟随后台')
const synchronized = syncSettings({ saved: savedSettings, draft: editedDraft }, nextSaved, false)
assert.deepEqual(synchronized.saved, nextSaved)
assert.deepEqual(synchronized.draft, editedDraft, '轮询更新基线，但不能覆盖草稿')
assert.deepEqual(syncSettings({ saved: savedSettings, draft: cleanDraft }, nextSaved, true).draft,
  cleanDraft, '保存期间即使草稿恰好等于旧基线，也不能被轮询覆盖')
assert.equal(settingsChanged(settingsDraft(synchronized.saved), synchronized.saved), false, '撤销恢复最新保存值')
assert.equal(settingsChanged({ ...editedDraft, defaultMaxTokens: '32768', enabled: true }, savedSettings), false,
  '改回原值不应继续提示未保存')
assert.deepEqual(savedSettings, {
  enabled: true, exposeRegionModels: true, streamRecovery: true, standaloneProbe: false,
  defaultMaxTokens: 32768, probeIntervalMinutes: 15,
}, '草稿操作不能改动输入配置')
await verifySettingsHost()
await verifyModelOperation()
verifyChannelFilters()
console.log('standalone-frontend: 资源登记、四页面分包、模型筛选、统计日期分页、设置校验与草稿同步、迟到摘要及退出保存检查通过')
