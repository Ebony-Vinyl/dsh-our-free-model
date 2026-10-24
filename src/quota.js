/**
 * 积分限额闸门 —— 从 LMR 猎模人移植的核心能力。
 *
 * LMR 的三级限额（渠道 / 账号 / 模型）里，能原样搬进 OFM 的是**模型级**那一级：
 * 每日请求数、每日积分（token 消耗折算）、到点自动冷却。渠道级和账号级依赖
 * LMR 的账号体系，那是另一回事，不在这里。
 *
 * ## 为什么挂在 adapter 而不是 aggregate
 *
 * OFM 的四条车道（free / sealed / kilo / aggregate）都是 `postStreamed` 家族的
 * 出口，闸门放在任一条都会漏掉另外三条。adapter 的 `runSingle` 是四条车道
 * 唯一的共同入口，闸门挂在那里才对所有车道生效，且不影响任何一条的内部逻辑。
 *
 * ## 数据来源
 *
 * 不另起炉灶：直接用 `store.js` 的 `stats` —— `recordUsage` 已经在按天按模型
 * 累加 input/output/calls。限额闸门只读不写，与统计口径天然一致，不会出现
 * 「限额说用了 100 次、面板显示 90 次」的两套账。
 *
 * ## 冷却语义
 *
 * 「今日已用满」的判定基于**本地当天 0 点**重置，与 `dayKey` 同一口径。
 * 命中上限时返回 `{ kind: 'quota' }`，调用方决定是拒绝整个回合还是跳过这个
 * 候选（combo 链会自动切下一个）。
 *
 * @module src/quota.js
 */

import { dayKey } from './store.js'

/** 限额的三个维度，各自可独立设置；0 或 undefined 表示不限。 */
export const QUOTA_FIELDS = ['dailyRequests', 'dailyTokens', 'dailyCredits']

/**
 * 把 settings 里的限额配置规范成可用形状。
 *
 * 用户手写进 JSON 的什么都有可能：负数当不限、字符串数字放行、缺失字段补 0。
 * 这里的规则是「说不清的就不限」——宁可比实际上限松，也不要因为一个手滑的
 * `-1` 把用户拦死在门外。
 *
 * @param {object} raw - `settings.quota`
 * @returns {{enabled:boolean, models:Record<string,object>, onExceed:'deny'|'skip'}}
 */
export function normalizeQuota(raw) {
  const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const models = {}
  const rawModels = source.models !== null && typeof source.models === 'object' && !Array.isArray(source.models)
    ? source.models : {}
  for (const [modelId, limit] of Object.entries(rawModels)) {
    const key = String(modelId ?? '').trim()
    if (key === '') continue
    const row = limit !== null && typeof limit === 'object' && !Array.isArray(limit) ? limit : {}
    models[key] = {
      dailyRequests: positive(row.dailyRequests),
      dailyTokens: positive(row.dailyTokens),
      dailyCredits: positive(row.dailyCredits),
    }
  }
  return {
    enabled: source.enabled === true,
    models,
    // deny：命中上限直接拒绝整个回合（默认）。
    // skip：命中上限当这个候选不可用，让 combo 链切下一个。
    onExceed: source.onExceed === 'skip' ? 'skip' : 'deny',
  }
}

/** 正整数或 0；说不清的值（负、NaN、非数字字符串）一律 0 = 不限。 */
function positive(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.trunc(n)
}

/**
 * 一个模型「今天」已用了多少，从 stats 读。
 *
 * stats 的 `days` 形如 `{ '2026-10-18': { total, models: { 'x/y': { input, output, calls } } } }`。
 * 用 `dayKey()` 而不是缓存的「当天」，因为跨午夜的进程不会刷新 —— 一个挂在
 * 后台的服务跑过 0 点，缓存会让它继续按昨天判限额。
 *
 * @returns {{requests:number, tokens:number, credits:number}}
 */
export function usageToday(stats, modelId, at = Date.now()) {
  // 兼容两种入参：裸 stats 对象（自检里手工构造）和 JsonStore 实例
  // （adapter 运行时传的本体）。后者必须先 get() —— store 上没有 .days，
  // 直接读会得到 undefined，闸门就形同虚设地永远放行。
  const source = typeof stats?.get === 'function' ? stats.get() : stats
  const day = dayKey(at)
  const bucket = source?.days?.[day]
  const row = bucket?.models?.[modelId]
  if (row === undefined) return { requests: 0, tokens: 0, credits: 0 }
  const input = num(row.input)
  const output = num(row.output)
  return {
    requests: num(row.calls),
    // 积分：与 LMR 的口径一致 —— input+output 折算，output 权重更高。
    // LMR 用各家自己的 credit 倍率，OFM 侧统一按 token 数近似，简单且可解释。
    tokens: input + output,
    credits: Math.ceil(input + output * 1.5),
  }
}

function num(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0
}

/**
 * 这个模型今天是否还能用。
 *
 * @param {object} quota - normalizeQuota 的结果
 * @param {object|JsonStore} stats - 裸 stats 对象或 settings 旁的 stats store（只读）
 * @param {string} modelId - 要检查的模型 id（combo 链会逐个问）
 * @param {number} [at] - 时间戳，测试用
 * @returns {{allowed:boolean, reason?:string, field?:string, used?:number, limit?:number}}
 */
export function checkQuota(quota, stats, modelId, at = Date.now()) {
  if (quota?.enabled !== true) return { allowed: true }
  const limit = quota.models?.[modelId]
  if (limit === undefined) return { allowed: true }
  const usage = usageToday(stats, modelId, at)

  for (const field of QUOTA_FIELDS) {
    const cap = limit[field]
    if (cap <= 0) continue
    const used = usage[field === 'dailyRequests' ? 'requests' : field === 'dailyTokens' ? 'tokens' : 'credits']
    if (used >= cap) {
      return {
        allowed: false,
        field,
        used,
        limit: cap,
        reason: `今日${labelOf(field)}已达上限 ${used}/${cap}`,
      }
    }
  }
  return { allowed: true }
}

function labelOf(field) {
  if (field === 'dailyRequests') return '请求数'
  if (field === 'dailyTokens') return 'token 量'
  return '积分'
}

/**
 * 限额被命中时，给 adapter 的 finish 帧用的 failure 形状。
 *
 * 真正重要的是 `message` 里那句人话，用户看得懂，链式决策也读得到。
 * code 用 `QUOTA_EXCEEDED`：分类器按文本匹配到 'quota exceeded' 会给出
 * rate_limit 判定，跟 combo 的换手语义一致。
 */
export function quotaFailure(check) {
  return {
    message: check.reason ?? '今日配额已用尽',
    code: 'QUOTA_EXCEEDED',
  }
}
