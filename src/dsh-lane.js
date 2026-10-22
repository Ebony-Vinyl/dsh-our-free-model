/**
 * DSH 自带模型车道（`dsh:`）。
 *
 * DSH 设置页添加的模型由宿主 `llm` 服务的 provider 目录发布，本插件不持有
 * 它们的 endpoint 或凭据。为了让组合链可以引用这些模型，同时不把它们
 * 重复广告成插件自己的独立路由，这里把宿主模型转换成仅用于路由的目录行，
 * 调用时再交还 `ctx.llm.stream`。
 *
 * @module src/dsh-lane
 */

export const DSH_LANE = 'dsh'
export const DSH_PREFIX = 'dsh:'

const DEFAULT_CONTEXT_WINDOW = 131072
const DEFAULT_MAX_OUTPUT = 32768

/** 宿主的 `provider/model` -> `dsh:provider/model`。 */
export function dshCatalogId(provider, model) {
  return `${DSH_PREFIX}${provider}/${model}`
}

/** 从 `provider/model` 拆分出提供方与模型；提供方只取第一个斜杠之前的部分。 */
function splitRoute(value) {
  const slash = value.indexOf('/')
  if (slash <= 0 || slash === value.length - 1) return null
  return { providerId: value.slice(0, slash), modelId: value.slice(slash + 1) }
}

/** `dsh:provider/model` -> `{ providerId, modelId }`，无法调用时返回 null。 */
export function parseDshCatalogId(id) {
  const value = typeof id === 'string' ? id.trim() : ''
  if (!value.startsWith(DSH_PREFIX)) return null
  return splitRoute(value.slice(DSH_PREFIX.length))
}

export function isDshEntry(entry) {
  return entry?.channel === DSH_LANE
}

function text(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : ''
}

function positive(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const whole = Math.trunc(value)
  return whole > 0 ? whole : undefined
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 宿主模型元数据 -> 一条组合链可引用的目录行。
 *
 * `resolved` 来自宿主的 `resolveModelInfo`，用于补齐目录清单未给出的窗口、
 * 输出上限、输入模态与思考档位。宿主没有提供这些字段时，保留组合链足以
 * 工作的保守默认值。
 */
function entryOf(model, resolved = {}) {
  if (!isRecord(model)) return null
  const providerId = text(model.provider)
  const modelId = text(model.id)
  if (providerId === '' || modelId === '') return null
  const contextWindow = positive(resolved.context?.contextWindow) ?? positive(model.contextWindow) ?? DEFAULT_CONTEXT_WINDOW
  const maxOutput = positive(resolved.defaultMaxTokens) ?? positive(model.maxTokens) ?? DEFAULT_MAX_OUTPUT
  const input = Array.isArray(model.inputModalities) ? model.inputModalities : resolved.inputModalities
  const vision = Array.isArray(input) && input.includes('image')
  const efforts = Array.isArray(resolved.reasoning?.efforts)
    ? resolved.reasoning.efforts.map(effort => effort.id).filter(id => typeof id === 'string' && id !== '')
    : []
  return {
    id: dshCatalogId(providerId, modelId),
    name: text(model.name) || modelId,
    description: text(resolved.description) || text(model.description) || `DSH ${providerId}`,
    channel: DSH_LANE,
    providerId,
    modelId,
    wire: 'host',
    contextWindow,
    maxOutput,
    vision,
    reasoning: resolved.reasoning !== undefined || model.reasoning === true,
    ...efforts.length === 0 ? {} : {
      efforts,
      effortDefault: typeof resolved.reasoning.defaultEffort === 'string' && efforts.includes(resolved.reasoning.defaultEffort)
        ? resolved.reasoning.defaultEffort
        : efforts[0],
    },
  }
}

/** 把宿主目录行转换为本插件目录行，去除无法调用的条目与重复项。 */
export function buildDshCatalog(models, resolved = new Map()) {
  const seen = new Set()
  const out = []
  for (const model of Array.isArray(models) ? models : []) {
    const route = `${model?.provider}/${model?.id}`
    const entry = entryOf(model, typeof resolved === 'function' ? resolved(model) : resolved.get(route))
    if (entry === null || seen.has(entry.id)) continue
    seen.add(entry.id)
    out.push(entry)
  }
  return out
}
