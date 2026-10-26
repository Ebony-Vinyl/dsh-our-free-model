/** 日趋势使用本地自然日；累计指标始终由服务端累计字段提供。 */
export function usageDays(series, count = 14, now = new Date()) {
  const values = new Map(series.map(row => [row.day, row.total]))
  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  return Array.from({ length: count }, (_, index) => {
    const at = new Date(today)
    at.setDate(at.getDate() - count + 1 + index)
    const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    return { day, total: values.get(day) ?? 0 }
  })
}

/** 视图查询不修改统计；每页 20 条，刷新或筛选后限制在有效页码内。 */
export function usageModels(models, { search = '', sort = 'calls', page = 1 } = {}) {
  const query = search.trim().toLocaleLowerCase()
  const matches = models.filter(row => `${row.name} ${row.model}`.toLocaleLowerCase().includes(query))
  const tie = (a, b) => a.name.localeCompare(b.name, 'zh-CN') || a.model.localeCompare(b.model)
  matches.sort((a, b) => {
    if (sort === 'name') return tie(a, b)
    const value = row => sort === 'tokens' ? row.input + row.output : sort === 'failedTurns' ? row.failedTurns : row.calls
    return value(b) - value(a) || tie(a, b)
  })
  const pages = Math.max(1, Math.ceil(matches.length / 20))
  const current = Math.min(pages, Math.max(1, Number.isSafeInteger(page) ? page : 1))
  return { total: matches.length, pages, page: current, rows: matches.slice((current - 1) * 20, current * 20) }
}
