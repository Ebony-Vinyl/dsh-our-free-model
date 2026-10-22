/**
 * Reasoning-effort policy.
 *
 * 档位是「思考强度指示器」，与输出预算完全解耦。实测（2026-10-22）免费车道
 * 上游按 `reasoning_effort` 校验取值，接受集是
 * `none|minimal|low|medium|high|xhigh|max`；插件自己的三档 id
 * （`light` / `balanced` / `deep`）不在这个集合里，直接下发会得到 400
 * `Invalid option`，所以每个档位都按强度映射到一个上游认识的取值再透传。
 *
 * 输出预算由 `budgetFor` 单独决定，与档位无关：
 * - 客户端显式给的 `max_output_tokens` 原样生效；
 * - 客户端没给时按模型容量（`maxOutput`），插件默认值只作为用户设定的上限
 *   参与，两者取小。
 *
 * @module src/effort.js
 */

/** Ordered for display: the array order is the picker's order. */
export const LEVELS = [
  { id: 'light', name: 'Light', zh: '精简', hint: '精简思考，快速回答' },
  { id: 'balanced', name: 'Balanced', zh: '均衡', hint: '标准思考，完整回答' },
  { id: 'deep', name: 'Deep', zh: '深思', hint: '深度思考，完整答案 + 详细推理' },
]

export const DEFAULT_LEVEL = 'balanced'

/** Does this model expose an effort menu at all? */
export function supportsEffort(model) {
  return model?.reasoning === true
}

const LEVEL_ALIASES = new Map(Object.entries({
  light: 'light', minimal: 'light', low: 'light', none: 'light', off: 'light', disabled: 'light',
  balanced: 'balanced', medium: 'balanced',
  deep: 'deep', high: 'deep', xhigh: 'deep', max: 'deep', ultra: 'deep',
}))

/** Aliases for the plugin's own three rungs, never for a model's declared menu. */
export function normalizeLevel(level) {
  return typeof level === 'string' ? LEVEL_ALIASES.get(level.trim().toLowerCase()) : undefined
}

/**
 * The upstream intensity value one plugin rung stands for.
 *
 * The free lane's gateway validates `reasoning_effort` and answers 400
 * `Invalid option` for anything outside
 * `none|minimal|low|medium|high|xhigh|max` (measured 2026-10-22 on
 * `mimo-v2.6-flash-free`: `light`, `balanced` and `deep` are all refused, while
 * `low` / `medium` / `high` / `xhigh` / `max` / `none` are accepted and do move
 * the reasoning volume). So the three rungs map onto that set by strength:
 * 精简 → `low`, 均衡 → `medium`, 深思 → `high`.
 *
 * @param {string|undefined} level - the rung id or one of its aliases
 * @returns {string|undefined} an upstream `reasoning_effort` value
 */
export function upstreamEffortFor(level) {
  const rung = normalizeLevel(level)
  if (rung === undefined) return undefined
  if (rung === 'light') return 'low'
  if (rung === 'balanced') return 'medium'
  return 'high'
}

/**
 * The rung in force for one call, resolved the same way for the effort sent
 * upstream and the effort recorded against it.
 *
 * A model with a declared menu keeps its own level ids: that set is the
 * model's contract, and the upstream validates it. A model with no menu takes
 * the plugin's own three rungs, and the rung is recorded as itself even though
 * the wire carries the mapped intensity value.
 *
 * @param {string|undefined} level - effort id from the harness, when it sent one
 * @param {object} model - catalog entry
 * @returns {object|undefined} the declared level, or undefined when none applies
 */
export function resolveLevel(level, model) {
  // A menu model's recorded effort is the level the wire actually carries —
  // resolving 'high' onto the free ladder's nearest rung logged 均衡 next to a
  // generation the model delivered at High.
  if (hasDeclaredEffortMenu(model)) {
    const chosen = model.efforts.includes(level) ? level : eacDefaultLevel(model)
    return { id: chosen }
  }
  if (!supportsEffort(model)) return undefined
  const wanted = normalizeLevel(level)
  return LEVELS.find(candidate => candidate.id === wanted)
    ?? LEVELS.find(candidate => candidate.id === DEFAULT_LEVEL)
}

/**
 * Resolve the generation ceiling against one model.
 *
 * 档位**不再**参与预算计算。规则有三条：
 *
 * - 客户端显式发的 `max_output_tokens` 原样生效（不超过模型容量）；
 * - 客户端没给时按模型容量（`maxOutput`）走，模型有多少就给多少；
 * - 插件默认值是**用户自己设的上限**，只参与收窄，不参与决定默认值。
 *
 * @param {object} model - catalog entry, supplying `maxOutput`
 * @param {number|undefined} requested - the session's maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin's own ceiling, when the user set one
 * @returns {number} tokens
 */
export function budgetFor(model, requested, fallback) {
  // A ceiling that is not a positive number is *no* ceiling. Without this, the
  // settings page's own cleared input — `Number('') || 0` — reached the wire as
  // `min(model capacity, 0)`, and every turn of every model silently came back
  // clamped to `MIN_BUDGET`.
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    usableTokens(requested),
    usableTokens(fallback),
  )
  // 客户端明确给的预算就是它给的数字：把它抬到下限会让「我只要 200 token」
  // 变成 512，用户看到的截断点与自己要求的不是一回事。下限只守住
  // 「没有明确值」的那条路径（模型容量或插件默认值算出来是 0 或更小的场合）。
  if (Number.isFinite(requested) && requested > 0) return Math.trunc(capacity)
  return Math.max(MIN_BUDGET, Math.trunc(capacity))
}

/** A caller-supplied token ceiling, or "none" when it is not a positive number. */
function usableTokens(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/** Below this the answer itself cannot land, so no level is allowed to go. */
export const MIN_BUDGET = 512

/**
 * The whole ladder as it applies to one model right now. 档位不再改变预算，所以
 * 三档的数字相同；这份列表只用于 UI 展示强度档位与默认档。
 *
 * @param {object} model - catalog entry
 * @param {number|undefined} requested - the session's maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {Array<{id: string, name: string, tokens: number, isDefault: boolean}>}
 */
export function budgetLadder(model, requested, fallback) {
  return LEVELS.map(entry => ({
    id: entry.id,
    name: entry.name,
    tokens: budgetFor(model, requested, fallback),
    isDefault: entry.id === DEFAULT_LEVEL,
  }))
}

/**
 * Deep-clone a declared patch and substitute the selected level for `$effort`.
 *
 * The patch is a plain JSON object (ZCode's declaration shape); `$effort` is
 * the placeholder the selected thinking level stands in for. A patch with no
 * placeholder is emitted as-is (the off patch), so a level whose mapping does
 * not name the level itself is expressible.
 */
function instantiatePatch(patch, effort) {
  const walk = value => {
    if (typeof value === 'string') return value === '$effort' ? effort : value
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, inner] of Object.entries(value)) out[key] = walk(inner)
      return out
    }
    return value
  }
  return walk(patch)
}

/**
 * The thinking menu a model declares in ZCode's shape.
 *
 * These models are not budget-driven: the gateway takes the level itself as
 * the control (a JSON merge patch on the request body), so the menu is the
 * model's own level list rather than the plugin's three intensity rungs.
 *
 * @param {object} model - catalog entry carrying `efforts`/`effortDefault`
 * @returns {Array<{id:string, name:string, description:string}>|undefined}
 */
function declaredEffortsFor(model) {
  const levels = Array.isArray(model?.efforts) ? model.efforts : undefined
  if (levels === undefined || levels.length === 0) return undefined
  const names = { disabled: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' }
  return levels.map(id => ({
    id,
    name: names[id] ?? id,
    description: id === 'disabled'
      ? 'thinking switched off for this turn; the answer alone'
      : `thinking level "${id}", sent to the gateway as this model's own effort field`,
  }))
}

/** The declared default level id for a menu model, or its first level. */
export function eacDefaultLevel(model) {
  const levels = Array.isArray(model?.efforts) ? model.efforts : []
  if (levels.length === 0) return undefined
  return levels.includes(model.effortDefault) ? model.effortDefault : levels[0]
}

/**
 * The request-body patch a co-paid-lane level turns into, or null when the
 * model declares no thinking menu at all.
 *
 * @param {string|undefined} level - the effort id the harness selected
 * @param {object} model - catalog entry
 * @returns {object|null}
 */
export function effortPatchFor(level, model) {
  if (!Array.isArray(model?.efforts) || model.efforts.length === 0) return null
  const chosen = model.efforts.includes(level) ? level : eacDefaultLevel(model)
  if (chosen === 'disabled' && model.effortOffPatch !== undefined) {
    return instantiatePatch(model.effortOffPatch, chosen)
  }
  if (model.effortPatch === undefined) return null
  return instantiatePatch(model.effortPatch, chosen)
}

/** Does this entry carry a declared thinking menu (its own effort field is
 *  the control on the wire)? The absorbed channels' entries do, and so do the
 *  free-lane models that publish one (`src/catalog.js` declares `efforts` +
 *  `effortPatch` per model). A model without one takes the plugin's own three
 *  rungs, which ride the wire as a mapped intensity value. */
export function hasDeclaredEffortMenu(model) {
  return Array.isArray(model?.efforts) && model.efforts.length > 0
}

/**
 * The effort id the harness should treat as this model's default.
 *
 * The free lane's ladder always has `balanced`; the co-paid lane's menu is
 * the model's own declaration, whose default is not `balanced` — reporting the
 * free lane's id for a sealed model made the harness reject the whole roster
 * ("adapter returned an unknown default reasoning effort").
 */
export function defaultEffortFor(model) {
  if (hasDeclaredEffortMenu(model)) return eacDefaultLevel(model) ?? DEFAULT_LEVEL
  return DEFAULT_LEVEL
}

/**
 * The declared effort list for one model, in picker order.
 *
 * Two producers, two shapes: a model with a declared menu offers its own levels,
 * which the gateway honours as an effort field (see {@link declaredEffortsFor});
 * an entry with no menu falls back to the plugin's own three intensity rungs,
 * which are pure indicators and do not move the budget.
 *
 * 描述文案不再写「输出上限」：档位不再决定预算，写一个数字会与实际发到线上的
 * 数字不一致（issue #2 的同一类缺陷）。三档共用同一个预算，由模型容量与
 * 客户端的 `max_output_tokens` 决定。
 *
 * @param {object} model - catalog entry
 * @param {number|undefined} requested - the session's maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {Array<{id:string, name:string, description:string}>|undefined}
 */
export function effortsFor(model, requested, fallback) {
  if (hasDeclaredEffortMenu(model)) return declaredEffortsFor(model)
  if (!supportsEffort(model)) return undefined
  return budgetLadder(model, requested, fallback).map(row => ({
    id: row.id,
    name: row.name,
    description: `${LEVELS.find(level => level.id === row.id)?.hint ?? ''}`
      + ` · ${kilos(row.tokens)} output, shared by thinking and the answer`,
  }))
}

/** 16384 -> `16 K`, the spelling the settings page and the README both use. */
function kilos(tokens) {
  return `${Math.round(tokens / 1024)} K`
}
