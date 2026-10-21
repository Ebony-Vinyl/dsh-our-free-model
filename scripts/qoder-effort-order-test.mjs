/**
 * Qoder 思考档位**顺序**的回归测试。
 *
 * 背景：`QODER_CN_FALLBACK_MODELS` 的 `efforts` 记的是目录
 * `thinking_config.enabled.efforts` 的**键序**，而那并不是强度序 ——
 * `dfmodel` 的真实键序是 `high / max / low`，`supportsDisable` 又把 `none`
 * 追加到末尾，于是 DSH 侧拿到的是
 * `高 → 最大 → 低 → 关闭思考`。
 *
 * 官方客户端不这样渲染：它在 `displayReasoningEfforts()` 里按
 * `REASONING_EFFORT_DISPLAY_ORDER = [none, minimal, low, medium, high, xhigh, max]`
 * **稳定排序**（未登记排末尾），`EffortControl` 与设置面板都只渲染这个结果。
 * 取证：CN 0.4.8 asar `out/renderer/assets/index-DDa3WwIe.js`。
 *
 * 不排的后果是「越往右越弱」：依赖「位置 = 强度」的 UI
 * （如 `dsh-codex-effort-slider` 的滑条）会把 `最大` 画在 `高` 左边、
 * 把 `关闭思考` 画到最右并点亮满格能量。
 */

const CASES = [
  // [说明, 输入模型, 期望的档位序]
  ['dfmodel 真实键序（high/max/low + 追加 none）',
    { efforts: ['high', 'max', 'low'], supportsDisable: true }, ['none', 'low', 'high', 'max']],
  ['dmodel（high/max + 追加 none）',
    { efforts: ['high', 'max'], supportsDisable: true }, ['none', 'high', 'max']],
  ['gmodel（high/low/max，无 disabled）',
    { efforts: ['high', 'low', 'max'] }, ['low', 'high', 'max']],
  ['gfmodel（high/max，已经是强度序 → 不变）',
    { efforts: ['high', 'max'] }, ['high', 'max']],
  ['qwen3.8（xhigh/low/medium + 追加 none）',
    { efforts: ['xhigh', 'low', 'medium'], supportsDisable: true }, ['none', 'low', 'medium', 'xhigh']],
  ['qmodel（只有关闭思考）',
    { efforts: [], supportsDisable: true }, ['none']],
  ['无档位且不可关闭 → 空数组',
    { efforts: [] }, []],
]

/**
 * @param {(model: object) => string[]} qoderEffortsFor 被验证的真实实现
 * @param {(efforts: readonly string[]) => string[]} sortEffortsByStrength 真实实现
 */
export function verifyQoderEffortOrder(qoderEffortsFor, sortEffortsByStrength) {
  if (typeof qoderEffortsFor !== 'function') throw new TypeError('qoderEffortsFor 未导出')
  if (typeof sortEffortsByStrength !== 'function') throw new TypeError('sortEffortsByStrength 未导出')

  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a !== b) throw new Error(`${label}：期望 ${b}，实际 ${a}`)
  }

  // ── 1. 逐条真实模型 ───────────────────────────────────────────────────────
  for (const [label, model, expected] of CASES) {
    eq(qoderEffortsFor(model), expected, label)
  }

  // ── 2. 「关闭思考」永远在最左（有它的模型）────────────────────────────────
  for (const [label, model, expected] of CASES) {
    const got = qoderEffortsFor(model)
    if (!got.includes('none')) continue
    if (got[0] !== 'none') throw new Error(`${label}：「关闭思考」必须落在最左，实际位置 ${got.indexOf('none') + 1}/${got.length}`)
    if (JSON.stringify(got) !== JSON.stringify(expected)) throw new Error(`${label}：与期望不一致`)
  }

  // ── 3. 已知档位的强度必须单调不减（「越往右越强」）────────────────────────
  const RANK = { none: 0, minimal: 1, low: 3, medium: 4, high: 5, xhigh: 7, max: 8 }
  for (const [label, model] of CASES) {
    const got = qoderEffortsFor(model)
    for (let i = 1; i < got.length; i += 1) {
      const prev = RANK[got[i - 1]]
      const cur = RANK[got[i]]
      if (prev === undefined || cur === undefined) continue
      if (cur < prev) throw new Error(`${label}：强度序被破坏（位置 ${i} 的 ${got[i]} 弱于前一个 ${got[i - 1]}）`)
    }
  }

  // ── 4. 未登记 id 排末尾、彼此保持原相对顺序 ───────────────────────────────
  eq(sortEffortsByStrength(['max', 'turbo', 'low', 'zen']), ['low', 'max', 'turbo', 'zen'],
    '未登记 id 排末尾并保持原序')
  eq(sortEffortsByStrength(['alpha', 'beta', 'gamma']), ['alpha', 'beta', 'gamma'],
    '全部未登记 → 原序不变（对未知 provider 零行为变化）')

  // ── 5. 同排名稳定：off/none 与 high/on ────────────────────────────────────
  eq(sortEffortsByStrength(['none', 'off', 'low']), ['none', 'off', 'low'], 'off/none 同排名 → 保持原序')
  eq(sortEffortsByStrength(['on', 'high', 'max']), ['on', 'high', 'max'], 'high/on 同排名 → 保持原序')

  // ── 6. 幂等 + 不改入参 ────────────────────────────────────────────────────
  const input = ['high', 'max', 'low', 'none']
  const snapshot = JSON.stringify(input)
  const once = sortEffortsByStrength(input)
  if (JSON.stringify(input) !== snapshot) throw new Error('sortEffortsByStrength 改动了传入的数组')
  eq(sortEffortsByStrength(once), once, '排序是幂等的')

  // ── 7. 边界 ───────────────────────────────────────────────────────────────
  eq(sortEffortsByStrength([]), [], '空数组 → 空数组')
  eq(sortEffortsByStrength(['none']), ['none'], '单档原样返回')
}
