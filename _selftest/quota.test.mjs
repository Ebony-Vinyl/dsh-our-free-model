/**
 * quota.js 单元自检 —— 含 JsonStore 形态回归。
 *
 * 背景：第一版 usageToday 直接读 stats.days，而运行时传入的是 JsonStore
 * 本体（数据在 .value 里），store 上没有 .days —— 闸门永远读到 0 用量，
 * 形同虚设。这条回归就是钉死那个坑的。
 *
 * 运行：node _selftest/quota.test.mjs（从 ofm-test 根目录）
 */
import assert from 'node:assert/strict'
import { normalizeQuota, checkQuota, usageToday, quotaFailure } from '../src/quota.js'

let pass = 0
let fail = 0
const cases = []
const test = (name, fn) => cases.push({ name, fn })

// —— 伪造 JsonStore：只需要 get() 和 value ——
function fakeStore(value) {
  return { value, get() { return this.value } }
}

const DAY = '2026-10-18'
const AT = new Date('2026-10-18T12:00:00+08:00').getTime()

test('normalize: 缺省全关', () => {
  const q = normalizeQuota(undefined)
  assert.equal(q.enabled, false)
  assert.equal(q.onExceed, 'deny')
  assert.deepEqual(q.models, {})
})

test('normalize: 负数与字符串数字', () => {
  const q = normalizeQuota({ enabled: true, models: { m: { dailyRequests: -5, dailyTokens: '200', dailyCredits: NaN } } })
  assert.equal(q.models.m.dailyRequests, 0)
  assert.equal(q.models.m.dailyTokens, 200)
  assert.equal(q.models.m.dailyCredits, 0)
})

test('usageToday: 裸对象形态', () => {
  const stats = { days: { [DAY]: { models: { m: { input: 100, output: 200, calls: 5 } } } } }
  const u = usageToday(stats, 'm', AT)
  assert.equal(u.requests, 5)
  assert.equal(u.tokens, 300)
  assert.equal(u.credits, Math.ceil(100 + 200 * 1.5))
})

test('usageToday: JsonStore 形态（回归第一版穿透坑）', () => {
  const store = fakeStore({ days: { [DAY]: { models: { m: { input: 100, output: 200, calls: 5 } } } } })
  const u = usageToday(store, 'm', AT)
  assert.equal(u.requests, 5)
  assert.equal(u.tokens, 300)
  assert.equal(u.credits, Math.ceil(100 + 200 * 1.5))
})

test('usageToday: JsonStore 空账本', () => {
  const store = fakeStore({ days: {} })
  const u = usageToday(store, 'm', AT)
  assert.deepEqual(u, { requests: 0, tokens: 0, credits: 0 })
})

test('usageToday: 昨天的不算今天', () => {
  const store = fakeStore({ days: { '2026-10-17': { models: { m: { input: 999, output: 999, calls: 99 } } } } })
  const u = usageToday(store, 'm', AT)
  assert.equal(u.requests, 0)
})

test('checkQuota: store 形态命中 dailyRequests', () => {
  const quota = normalizeQuota({ enabled: true, models: { m: { dailyRequests: 1 } } })
  const store = fakeStore({ days: { [DAY]: { models: { m: { input: 10, output: 10, calls: 6 } } } } })
  const check = checkQuota(quota, store, 'm', AT)
  assert.equal(check.allowed, false)
  assert.equal(check.field, 'dailyRequests')
  assert.equal(check.used, 6)
  assert.equal(check.limit, 1)
  assert.match(check.reason, /请求数/)
})

test('checkQuota: 未配置的模型放行', () => {
  const quota = normalizeQuota({ enabled: true, models: { m: { dailyRequests: 1 } } })
  const store = fakeStore({ days: { [DAY]: { models: { other: { calls: 999 } } } } })
  assert.equal(checkQuota(quota, store, 'other', AT).allowed, true)
})

test('checkQuota: 关闭时全放行', () => {
  const quota = normalizeQuota({ enabled: false, models: { m: { dailyRequests: 1 } } })
  const store = fakeStore({ days: { [DAY]: { models: { m: { calls: 999 } } } } })
  assert.equal(checkQuota(quota, store, 'm', AT).allowed, true)
})

test('checkQuota: dailyTokens 命中', () => {
  const quota = normalizeQuota({ enabled: true, models: { m: { dailyTokens: 100 } } })
  const store = fakeStore({ days: { [DAY]: { models: { m: { input: 60, output: 50, calls: 1 } } } } })
  const check = checkQuota(quota, store, 'm', AT)
  assert.equal(check.allowed, false)
  assert.equal(check.field, 'dailyTokens')
  assert.equal(check.used, 110)
})

test('checkQuota: dailyCredits 命中', () => {
  const quota = normalizeQuota({ enabled: true, models: { m: { dailyCredits: 10 } } })
  const store = fakeStore({ days: { [DAY]: { models: { m: { input: 100, output: 200, calls: 1 } } } } })
  const check = checkQuota(quota, store, 'm', AT)
  assert.equal(check.allowed, false)
  assert.equal(check.field, 'dailyCredits')
  assert.equal(check.used, Math.ceil(100 + 200 * 1.5))
})

test('checkQuota: 恰好等于上限即拒（used >= cap）', () => {
  const quota = normalizeQuota({ enabled: true, models: { m: { dailyRequests: 5 } } })
  const store = fakeStore({ days: { [DAY]: { models: { m: { calls: 5 } } } } })
  assert.equal(checkQuota(quota, store, 'm', AT).allowed, false)
})

test('quotaFailure: 形状与人话', () => {
  const f = quotaFailure({ reason: '今日请求数已达上限 6/1' })
  assert.equal(f.code, 'QUOTA_EXCEEDED')
  assert.equal(f.message, '今日请求数已达上限 6/1')
})

for (const { name, fn } of cases) {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    fail++
    console.error(`FAIL  ${name}\n      ${error.message}`)
  }
}

console.log(`\nquota 自检：${pass} 过 / ${fail} 挂 / 共 ${cases.length} 条`)
process.exit(fail > 0 ? 1 : 0)
