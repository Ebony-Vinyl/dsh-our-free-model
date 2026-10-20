/**
 * Qoder 倍率展示的回归测试。
 *
 * 背景：`QODER_CN_FALLBACK_MODELS` 是**编译期快照**，而上游会做限时活动。
 * 2026-10-17 起 Qoder CN 对 DeepSeek-V4.1-Flash-1017 开启 0 倍计费
 * （官方客户端显示「0.1x 划线 → 0x」+「限时免费」角标，至 10-25 00:00 +08:00）。
 * 若只把 `priceFactor` 改成 0 而不带截止时刻，活动结束后插件会**永久误报「免费」**。
 *
 * 这里断言三件事：
 *   1. 活动期内 → 「免费」
 *   2. 到期瞬间及之后 → 回落到 `originalPriceFactor`（不是仍显示免费）
 *   3. 没有 `freeUntil` 的长期免费模型（如 `qfmodel`）行为不变
 */

const AT = {
  duringPromo: new Date('2026-10-20T14:00:00+08:00'),
  justBeforeEnd: new Date('2026-10-24T23:59:00+08:00'),
  atEnd: new Date('2026-10-25T00:00:00+08:00'),
  afterEnd: new Date('2026-10-26T12:00:00+08:00'),
}

/**
 * @param {(model: object, now?: Date) => string} qoderDisplayName
 *   被验证的展示名函数（真实实现，不是副本）
 */
export function verifyQoderPriceDisplay(qoderDisplayName) {
  if (typeof qoderDisplayName !== 'function') {
    throw new TypeError('qoderDisplayName 未导出；本测试需要真实实现')
  }

  // ── 1. 限时免费：活动期内显示免费 ────────────────────────────────────────────
  const timeLimited = {
    id: 'dfmodel', name: 'DeepSeek-Flash',
    priceFactor: 0, originalPriceFactor: 0.1,
    freeUntil: '2026-10-25T00:00:00+08:00',
  }
  if (qoderDisplayName(timeLimited, AT.duringPromo) !== 'DeepSeek-Flash · 免费') {
    throw new Error(`活动期内应显示免费，实际 ${JSON.stringify(qoderDisplayName(timeLimited, AT.duringPromo))}`)
  }
  if (qoderDisplayName(timeLimited, AT.justBeforeEnd) !== 'DeepSeek-Flash · 免费') {
    throw new Error(`到期前 1 分钟仍应在活动期内，实际 ${JSON.stringify(qoderDisplayName(timeLimited, AT.justBeforeEnd))}`)
  }

  // ── 2. 到期后必须回落，不能永久免费 ─────────────────────────────────────────
  for (const [label, at] of [['到期瞬间', AT.atEnd], ['到期之后', AT.afterEnd]]) {
    const shown = qoderDisplayName(timeLimited, at)
    if (shown === 'DeepSeek-Flash · 免费') {
      throw new Error(`${label}仍显示免费 —— 这正是本字段要防的「永久误报免费」`)
    }
    if (shown !== 'DeepSeek-Flash · x0.1') {
      throw new Error(`${label}应回落到原价 x0.1，实际 ${JSON.stringify(shown)}`)
    }
  }

  // ── 3. 无 freeUntil 的长期免费模型行为不变（qfmodel = 免费额度）───────────────
  const permanentlyFree = {
    id: 'qfmodel', name: 'Qwen3.8-Flash',
    priceFactor: 0, originalPriceFactor: 0.1,
  }
  for (const [label, at] of Object.entries(AT)) {
    if (qoderDisplayName(permanentlyFree, at) !== 'Qwen3.8-Flash · 免费') {
      throw new Error(`长期免费模型在 ${label} 不应受 freeUntil 逻辑影响`)
    }
  }

  // ── 4. 国际版未被波及（它仍是常规价 0.1，且没有 freeUntil）───────────────────
  const intl = {
    id: 'dfmodel', name: 'DeepSeek-Flash',
    priceFactor: 0.1,
  }
  for (const [label, at] of Object.entries(AT)) {
    if (qoderDisplayName(intl, at) !== 'DeepSeek-Flash · x0.1') {
      throw new Error(`国际版在 ${label} 应稳定显示 x0.1`)
    }
  }

  // ── 5. 截止时刻不可解析时不误杀（宁可多显示一次免费）──────────────────────────
  const unparsable = {
    id: 'dfmodel', name: 'DeepSeek-Flash',
    priceFactor: 0, originalPriceFactor: 0.1, freeUntil: 'not-a-date',
  }
  if (qoderDisplayName(unparsable, AT.afterEnd) !== 'DeepSeek-Flash · 免费') {
    throw new Error('freeUntil 无法解析时应保持免费展示，不得单方面判定活动已结束')
  }
}
