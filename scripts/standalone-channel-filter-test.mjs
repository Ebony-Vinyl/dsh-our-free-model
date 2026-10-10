import assert from 'node:assert/strict'
import fs from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const source = fs.readFileSync(new URL('../packages/standalone/frontend/components/channel-browser.tsx', import.meta.url), 'utf8')
const start = source.indexOf('  const connected =')
const end = source.indexOf('  return <>', start)
const label = /onClick=\{\(\) => setFilter\(id\)\}>\{label\}<span>\{(.+?)\}<\/span>/.exec(source)?.[1]
assert.ok(start >= 0 && end > start && label, '渠道筛选和实际计数标签必须可定位')
const calculation = stripTypeScriptTypes(source.slice(start, end))
function filterChannels(statuses, filter, search = '') {
  return vm.runInNewContext(calculation + `\n;({
    rows, labels: ['all', 'connected', 'pending'].map(id => (${label}))
  })`, {
    statuses, filter, search, selected: undefined,
    providers: [
      { id: 'connected', name: '已接入渠道', org: '测试' },
      { id: 'pending', name: '待接入渠道', org: '测试' },
      { id: 'closed', name: '关闭渠道', org: '测试' },
      { id: 'unknown', name: '未读取渠道', org: '测试' },
    ],
  })
}
export function verifyChannelFilters() {
  const statuses = {
    connected: { accounts: { total: 1, enabled: 1 } },
    pending: { accounts: { total: 1, enabled: 0 } },
    closed: { closed: true, accounts: { total: 1, enabled: 1 } },
  }
  for (const [filter, expectedRows] of [['all', 4], ['connected', 1], ['pending', 2]]) {
    const view = filterChannels(statuses, filter)
    assert.deepEqual(Array.from(view.labels), [4, 1, 2], '分类数量不得随选中的筛选项变化')
    assert.equal(view.rows.length, expectedRows)
  }
  const searched = filterChannels(statuses, 'pending', '关闭')
  assert.equal(searched.rows.length, 1)
  assert.equal(searched.rows[0].id, 'closed')
  assert.deepEqual(Array.from(searched.labels), [4, 1, 2], '分类标签显示全量统计，搜索结果数由结果栏展示')
  assert.deepEqual(Array.from(filterChannels({}, 'all').labels), [4, 0, 0], '未读取的渠道不能计入待接入')
  assert.deepEqual(Array.from(filterChannels(undefined, 'all').labels), [4, '—', '—'], '状态加载前不显示虚构的分类数量')
}
