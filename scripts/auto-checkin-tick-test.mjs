/**
 * 跨天巡检：常驻进程过了零点也要补一轮签到。
 *
 * 只测「什么时候该叫 runIfDue」，不碰真实渠道 —— `claim()` 用替身并计数，
 * 断言的是可观测的调用次数，而不是内部实现。
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-checkin-tick-'))
process.env.DSH_CHANNEL_PACK_HOME = scratch

// 用 typescript 的 transpileModule 而不是 Node 内置 strip：后者不支持构造函数参数
// 属性（依赖链里的 channel-pack-store 就用了），会直接抛 ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX。
const ts = (await import('typescript')).default

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: ts.transpileModule(fs.readFileSync(fileURLToPath(url), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        fileName: fileURLToPath(url),
      }).outputText,
    }
    return nextLoad(url, context)
  },
})

const { createAutoCheckin, AUTO_CHECKIN_TICK_MS, AUTO_CHECKIN_RETRY_MS } =
  await import('../vendor/channel-pack/src/auto-checkin.ts')

let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok   ${name}`)
}

const EMPTY_DOC = () => ({
  enabled: true, lastDate: '', lastResult: '', lastAt: 0,
  channels: [], todayDate: '', today: [], dismissedRunAt: 0,
})

/** UTC+8 的某个时刻 → 毫秒时间戳（避免手算时区）。 */
const utc8 = (date, hour = 12) => Date.parse(`${date}T00:00:00+08:00`) + hour * 3_600_000

function harness({ doc = {}, clock = utc8('2026-10-27', 16) } = {}) {
  const state = { clock, claims: [], providers: ['fixture'] }
  const stored = { ...EMPTY_DOC(), ...doc }
  const timers = { start: null, tick: null }
  const checkin = createAutoCheckin({
    store: { load: () => stored, save: value => Object.assign(stored, value), flush() {} },
    now: () => state.clock,
    listProviderIds: async () => state.providers,
    claim: async provider => {
      state.claims.push(provider)
      // coversToday=false → 不记 lastDate，正好用来观察退避
      return { ok: true, value: { summary: { claimed: 1, coversToday: false }, accounts: [] } }
    },
    delayMs: 0,
    tickMs: 1_000,
    schedule: fn => { timers.start = fn; return { cancel() {} } },
    scheduleTick: (fn, ms) => { timers.tick = { fn, ms, cancelled: false }; return { cancel() { timers.tick.cancelled = true; timers.tick = null } } },
    warn() {},
  })
  return { checkin, stored, timers, state }
}

const settle = () => new Promise(resolve => setImmediate(resolve))

await check('start() 挂上跨天巡检，间隔取自 tickMs', async () => {
  const { checkin, timers } = harness()
  checkin.start()
  assert.ok(timers.tick !== null, 'start() 必须排定巡检')
  assert.equal(timers.tick.ms, 1_000)
  checkin.stop()
})

await check('stop() 取消巡检，不留下悬挂定时器', async () => {
  const { checkin, timers } = harness()
  checkin.start()
  const scheduled = timers.tick
  checkin.stop()
  assert.equal(scheduled.cancelled, true, 'stop() 必须真的取消巡检')
  assert.equal(timers.tick, null)
})

await check('tickMs=0 时不排巡检（宿主不需要常驻）', async () => {
  let scheduled = null
  const checkin = createAutoCheckin({
    store: { load: EMPTY_DOC, save() {}, flush() {} },
    now: () => utc8('2026-10-27'),
    listProviderIds: async () => [], claim: async () => ({ ok: true, value: {} }),
    delayMs: 0, tickMs: 0,
    schedule: () => ({ cancel() {} }),
    scheduleTick: fn => { scheduled = fn; return { cancel() {} } },
    warn() {},
  })
  checkin.start()
  assert.equal(scheduled, null, 'tickMs=0 表示关闭巡检')
  checkin.stop()
})

await check('今天已经跑成过 → 巡检不重复打上游', async () => {
  const { checkin, timers, state } = harness({
    doc: { lastDate: '2026-10-27', lastAt: utc8('2026-10-27', 9) },
    clock: utc8('2026-10-27', 16),
  })
  checkin.start()
  state.clock = utc8('2026-10-27', 20)
  timers.tick.fn()
  await settle()
  assert.deepEqual(state.claims, [], '当天已成功，巡检不得再调 claim')
  checkin.stop()
})

await check('跨天后巡检补跑一轮', async () => {
  const { checkin, timers, state } = harness({
    doc: { lastDate: '2026-10-26', lastAt: utc8('2026-10-26', 9) },
    clock: utc8('2026-10-27', 1),
  })
  checkin.start()
  state.clock = utc8('2026-10-28', 1)
  timers.tick.fn()
  await settle()
  assert.deepEqual(state.claims, ['fixture'], '进入新的一天后必须补跑')
  checkin.stop()
})

await check('今天试过但失败 → 退避期内不再打上游', async () => {
  const start = utc8('2026-10-27', 9)
  const { checkin, timers, state } = harness({ clock: start })
  checkin.start()
  await settle()
  // start() 的 delayMs=0 立刻跑了一轮；claim 返回 coversToday=false，
  // 所以 lastDate 仍为空、lastAt 停在 09:00 —— 正是「今天试过但失败」的形态。
  assert.deepEqual(state.claims, ['fixture'], '前提：已经试过一轮')
  const tried = state.claims.length
  state.clock = start + 10 * 60_000
  timers.tick.fn()
  await settle()
  assert.equal(state.claims.length, tried, '退避期内（<1h）不应重试')
  checkin.stop()
})

await check('过了退避下限 → 巡检允许重试', async () => {
  const start = utc8('2026-10-27', 9)
  const { checkin, timers, state } = harness({ clock: start })
  checkin.start()
  await settle()
  const tried = state.claims.length
  state.clock = start + AUTO_CHECKIN_RETRY_MS + 60_000
  timers.tick.fn()
  await settle()
  assert.equal(state.claims.length, tried + 1, '超过 1 小时后应允许重试')
  checkin.stop()
})

await check('默认常量符合设计（巡检 2.5h、退避 1h）', async () => {
  assert.equal(AUTO_CHECKIN_TICK_MS, 150 * 60 * 1000)
  assert.equal(AUTO_CHECKIN_RETRY_MS, 60 * 60 * 1000)
})

console.log(`\n${checks} 项跨天巡检检查通过`)
fs.rmSync(scratch, { recursive: true, force: true })
