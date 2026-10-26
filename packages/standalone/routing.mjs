import { buildComboCatalog, comboChain, comboId, COMBO_STRATEGIES, isComboEntry, normalizeCombos } from '../../src/combos.js'

const fail = message => Object.assign(new Error(message), { statusCode: 400 })
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const capacity = entry => entry ? {
  contextWindow: entry.contextWindow, maxOutput: entry.maxOutput,
  vision: entry.vision, reasoning: entry.reasoning,
} : null

export function createRoutingManagement({ stores, runtime, persist }) {
  const snapshot = () => runtime.state()
  const list = () => ({
    combos: normalizeCombos(stores.settings.get().combos),
    models: runtime.catalog.map(row => ({ id: row.id, name: row.name, channel: row.channel ?? 'free' })),
    strategies: [...COMBO_STRATEGIES],
  })
  function validateCombo(value, previous) {
    if (!object(value) || Object.keys(value).some(key => !['id', 'name', 'models', 'strategy', 'stickyLimit', 'enabled'].includes(key))) throw fail('路由组配置无效')
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 120 || /[\0\r\n]/.test(value.name)) throw fail('请输入有效的路由组名称')
    const id = value.id ?? comboId(value.name)
    if (typeof id !== 'string' || !/^combo:[a-z0-9][a-z0-9_-]{0,95}$/.test(id)) throw fail('路由组 ID 无效')
    if (value.id !== undefined && !previous.some(row => row.id === value.id)) throw fail('路由组不存在')
    if (value.id === undefined && previous.some(row => row.id === id)) throw fail('已有同名路由组')
    if (!Array.isArray(value.models) || value.models.length < 1 || value.models.length > 100
      || value.models.some(model => typeof model !== 'string' || !model || model.length > 300)
      || new Set(value.models).size !== value.models.length) throw fail('请选择 1 到 100 个不重复的模型或路由组')
    if (value.models.includes(id)) throw fail('路由组不能引用自身')
    if (!COMBO_STRATEGIES.includes(value.strategy)) throw fail('请选择有效的路由策略')
    if (!Number.isInteger(value.stickyLimit) || value.stickyLimit < 1 || value.stickyLimit > 100) throw fail('轮询粘滞轮数必须为 1 到 100')
    if (typeof value.enabled !== 'boolean') throw fail('enabled 必须为布尔值')
    const known = new Set([...runtime.catalog.map(row => row.id), ...previous.map(row => row.id)])
    const oldMembers = previous.find(row => row.id === id)?.models ?? []
    if (value.models.some(model => !known.has(model) && !oldMembers.includes(model))) throw fail('所选模型或路由组已不存在，请刷新模型清单')
    return { id, name: value.name.trim(), models: [...value.models], strategy: value.strategy, stickyLimit: value.stickyLimit, enabled: value.enabled }
  }
  function ensureAcyclic(combos) {
    const byId = new Map(combos.map(row => [row.id, row]))
    const active = new Set(), checked = new Set()
    const visit = id => {
      if (active.has(id)) throw fail('嵌套路由组形成循环引用')
      if (checked.has(id)) return
      const row = byId.get(id)
      if (!row) return
      active.add(id)
      row.models.forEach(visit)
      active.delete(id); checked.add(id)
    }
    combos.forEach(row => visit(row.id))
  }
  function write(combos) {
    ensureAcyclic(combos)
    persist({ combos })
    runtime.syncAggregateCatalog()
    return { combos, usable: runtime.catalog.filter(isComboEntry).map(row => ({ id: row.id, ...capacity(row) })) }
  }
  return {
    list,
    save({ combo } = {}) {
      const rows = normalizeCombos(stores.settings.get().combos)
      const next = validateCombo(combo, rows)
      return write(rows.some(row => row.id === next.id) ? rows.map(row => row.id === next.id ? next : row) : [...rows, next])
    },
    remove({ id } = {}) {
      const rows = normalizeCombos(stores.settings.get().combos)
      if (!rows.some(row => row.id === id)) throw fail('路由组不存在')
      if (rows.some(row => row.id !== id && row.models.includes(id))) throw fail('其他路由组仍在引用此组，请先修改引用')
      return write(rows.filter(row => row.id !== id))
    },
    preview({ models, strategy = 'fallback' } = {}) {
      if (!Array.isArray(models) || models.length > 100 || models.some(id => typeof id !== 'string' || id.length > 300)
        || !COMBO_STRATEGIES.includes(strategy)) throw fail('预览参数无效')
      const state = snapshot()
      const previous = normalizeCombos(stores.settings.get().combos)
      let id = 'combo:preview'
      while (previous.some(row => row.id === id)) id += '-next'
      const definitions = [...previous, { id, name: 'preview', models, strategy, stickyLimit: 1, enabled: true }]
      const catalog = [...runtime.catalog.filter(row => !isComboEntry(row)), ...buildComboCatalog(definitions, runtime.catalog)]
      const entry = catalog.find(row => row.id === id)
      return { capacity: capacity(entry), order: entry ? comboChain(entry, catalog, { ...state.routing, peek: true })
        .map(row => ({ id: row.id, name: row.name })) : [] }
    },
  }
}
