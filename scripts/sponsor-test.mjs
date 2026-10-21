/** 每日广告规则的边界验证，完全离线。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { SPONSOR, SPONSOR_DAY_KEY, sponsorLocalDay, claimSponsorDay } from '../src/sponsor.js'
const memory = () => {
  const data = new Map()
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) }
}
let shows = 0
const storage = memory()
let date = new Date(2026, 9, 19, 23, 59, 59)
const options = { storage, now: () => date, show: () => { shows++ } }
assert.equal(sponsorLocalDay(new Date(2026, 9, 19, 0, 1)), '2026-10-19')
assert.equal(await claimSponsorDay(options), true)
assert.equal(await claimSponsorDay(options), false)
assert.equal(shows, 1, '同日刷新、重挂载不能再展示')
date = new Date(2026, 9, 20, 0, 0, 1)
assert.equal(await claimSponsorDay(options), true)
assert.equal(shows, 2, '本地午夜之后首次进入应展示')
const broken = { getItem() { throw new Error('private storage') } }
assert.equal(await claimSponsorDay({ ...options, storage: broken }), false)
assert.equal(await claimSponsorDay({ ...options, storage: { getItem: () => null, setItem() { throw new Error('quota') } } }), false)
assert.equal(shows, 2, '存储异常不能导致每次打开都打扰')
const cancelled = memory()
assert.equal(await claimSponsorDay({ ...options, storage: cancelled, eligible: () => false }), false)
assert.equal(cancelled.getItem(SPONSOR_DAY_KEY), null, '隐藏、取消或卸载不能消耗当天展示')
const failed = memory()
assert.equal(await claimSponsorDay({ ...options, storage: failed, show: () => { throw new Error('another dialog is open') } }), false)
assert.equal(failed.getItem(SPONSOR_DAY_KEY), null, '公告打开失败不能误记已展示')
let queue = Promise.resolve()
const locks = { request: (_name, callback) => { const next = queue.then(callback); queue = next.catch(() => {}); return next } }
const concurrent = memory()
let concurrentShows = 0
const claims = await Promise.all(Array.from({ length: 30 }, () => claimSponsorDay({ storage: concurrent, locks, show: () => concurrentShows++ })))
assert.equal(claims.filter(Boolean).length, 1)
assert.equal(concurrentShows, 1, '多个同源窗口只能有一个展示')
assert.equal(new URL(SPONSOR.url).searchParams.get('aff'), SPONSOR.invite)
assert.equal(SPONSOR.paragraphs.length, 6)
assert.equal(fs.readFileSync(new URL('../docs/images/sponsor-beichen-examples.jpg', import.meta.url)).length, 59507)
execFileSync(process.execPath, [fileURLToPath(new URL('./build-sponsor.mjs', import.meta.url)), '--check'], { stdio: 'pipe' })
console.log('sponsor: 日期、跨日、重复挂载、并发窗口、存储异常、取消展示与共享内容检查通过')
