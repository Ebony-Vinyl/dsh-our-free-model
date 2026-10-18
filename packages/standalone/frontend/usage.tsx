import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, CircleAlert, Layers3, RefreshCw, Search, RotateCcw, X } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { t, numLocale } from './i18n.mjs'
import { usageDays, usageModels } from './usage-data.mjs'
import type { Host, Stats, UsageModel } from './types'
import './usage.css'

const number = (value: number) => new Intl.NumberFormat(numLocale()).format(value)
const compact = (value: number) => value >= 1e6 ? `${Number((value / 1e6).toFixed(1))}M`
  : value >= 1e3 ? `${Number((value / 1e3).toFixed(1))}K` : number(value)
const measured = (value?: number | null) => value != null && Number.isFinite(value) ? number(value) : '—'

export function Usage({ stats, host, active }: { stats: Stats; host: Host; active: boolean }) {
  const [period, setPeriod] = useState(14)
  const [search, setSearch] = useState('')
  const [sort, setSort] = useState('calls')
  const [page, setPage] = useState(1)
  const [refreshing, setRefreshing] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const generation = useRef(0)
  const refreshingRef = useRef(false)
  const activeRef = useRef(active)
  activeRef.current = active
  useEffect(() => {
    if (!active) {
      generation.current++
      refreshingRef.current = false
      setRefreshing(false); setMessage(''); setError('')
    }
    return () => { generation.current++ }
  }, [active])
  const days: { day: string; total: number }[] = usageDays(stats.days, period)
  const windowTotal = days.reduce((sum, day) => sum + day.total, 0)
  const max = Math.max(1, ...days.map(day => day.total))
  const models: { total: number; pages: number; page: number; rows: UsageModel[] } = usageModels(stats.models, { search, sort, page })
  useEffect(() => { if (page !== models.page) setPage(models.page) }, [page, models.page])
  const hasHistory = stats.requests > 0 || stats.turns > 0 || stats.models.length > 0 || stats.days.length > 0
  const metrics = [
    { name: t('use.metricTurns'), value: stats.turns, detail: t('use.metricTurnsDetail'), icon: Layers3 },
    { name: t('use.metricRequests'), value: stats.requests, detail: t('use.metricRequestsDetail'), icon: Activity },
    { name: t('use.metricInput'), value: stats.grand.input, detail: t('use.metricReported'), icon: ArrowDownToLine },
    { name: t('use.metricOutput'), value: stats.grand.output, detail: t('use.metricReported'), icon: ArrowUpFromLine },
    { name: t('use.metricFailed'), value: stats.failedTurns, detail: t('use.metricFailedDetail'), icon: CircleAlert },
    { name: t('use.metricRecovered'), value: stats.recoveredTurns, detail: t('use.metricRecoveredDetail'), icon: RotateCcw },
  ]
  const refresh = async () => {
    if (refreshingRef.current || !activeRef.current) return
    const started = ++generation.current
    const isCurrent = () => started === generation.current && activeRef.current
    refreshingRef.current = true
    setRefreshing(true); setMessage(''); setError('')
    try {
      await host.refresh()
      if (isCurrent()) setMessage(t('use.updated'))
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.name === 'TimeoutError' ? t('use.refreshTimeout')
        : reason instanceof TypeError && /fetch/i.test(reason.message) ? t('use.unreachable')
        : reason.message : t('use.refreshFailed'))
    } finally {
      if (isCurrent()) { refreshingRef.current = false; setRefreshing(false) }
    }
  }
  if (!active) return null
  return <div className="usage-browser" data-testid="usage-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">WORKSPACE / USAGE</div>
      <h1>{t('use.heading')}</h1><p>{t('use.sub')}</p></div>
      <Button variant="outline" disabled={refreshing} onClick={() => { void refresh() }}>
        <RefreshCw size={15} className={refreshing ? 'spinning' : ''} />{refreshing ? t('use.updating') : t('use.update')}
      </Button>
    </header>
    {message && <p className="usage-feedback" role="status">{message}</p>}
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label={t('use.closeError')} onClick={() => setError('')}><X size={15} /></Button></div>}
    <div className="usage-metrics">{metrics.map(metric => <Card className="dashboard-metric ov-metric" key={metric.name}>
      <div><span>{metric.name}</span><div className="ov-metric-icon"><metric.icon size={17} /></div></div>
      <strong title={number(metric.value)} data-metric={metric.name}>{metric.name.includes('Token') ? compact(metric.value) : number(metric.value)}</strong><p>{metric.detail}</p>
    </Card>)}</div>
    <div className="usage-scope"><span>{t('use.scopeNote')}</span>
      <span>{t('use.requestFailures')} <strong data-testid="usage-request-failures">{number(stats.requestFailures)}</strong></span>
      <span>{t('use.reasoningTokens')} <strong>{number(stats.grand.reasoning)}</strong></span></div>
    {(stats.logicalEstimated || stats.requestFailuresEstimated) && <p className="usage-estimated" role="note">
      <CircleAlert size={15} /><span>{t('use.estimateNote')}
        {stats.logicalEstimated && t('use.estimateTurns')}
        {stats.requestFailuresEstimated && t('use.estimateFailures')}
        {t('use.estimateFoot')}</span></p>}
    <Card className="usage-trend">
      <div className="card-heading"><div><h2>{t('use.chartTitle')}</h2><p>{t.format('use.chartSub', { n: period })}</p></div>
        <div className="channel-filters" role="group" aria-label={t('use.rangeAria')}>{[7, 14, 30].map(count =>
          <button key={count} aria-pressed={period === count} onClick={() => setPeriod(count)}>{t.format('use.days', { n: count })}</button>)}</div>
      </div>
      <div className="usage-window-total"><strong data-testid="usage-window-total">{number(windowTotal)}</strong><span>{t('use.windowTotal')}</span></div>
      <p className="usage-scroll-hint">{t('use.scrollHint')}</p>
      <div className="usage-trend-scroll"><div className="usage-trend-chart" style={{ minWidth: period * 35 }}
        role="img" aria-label={t.format('use.trendAria', { n: period, days: days.map(day => `${day.day} ${number(day.total)}`).join('；') })}>
        {days.map(day => <div className="usage-day" key={day.day} tabIndex={0} title={t.format('use.dayTitle', { day: day.day, tokens: number(day.total) })}
          aria-label={t.format('use.dayAria', { day: day.day, tokens: number(day.total) })}>
          <div className="usage-day-track"><div className={`usage-day-bar ${day.total ? '' : 'zero'}`} style={{ height: `${Math.max(1, day.total / max * 100)}%` }} /></div>
          <span>{day.day.slice(5).replace('-', '/')}</span>
        </div>)}
      </div></div>
      {windowTotal === 0 && <p className="usage-window-empty" role="status">{hasHistory ? t('use.trendEmpty') : t('use.usageEmpty')}</p>}
      <div className="card-foot"><span>{days[0].day} — {days[days.length - 1].day} · {t('use.localDay')}</span><span>{t('use.reportNote')}</span></div>
    </Card>
    <Card className="usage-model-panel">
      <div className="card-heading"><div><h2>{t('use.byModel')}</h2><p>{t('use.byModelSub')}</p></div>
        <Badge>{t.format('use.modelCount', { n: number(stats.models.length) })}</Badge></div>
      <div className="usage-model-filters"><div className="usage-model-search"><Search size={16} />
        <Input type="search" aria-label={t('use.searchLabel')} placeholder={t('use.searchPlaceholder')} value={search}
          onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
        <select aria-label={t('use.sortAria')} value={sort} onChange={event => { setSort(event.target.value); setPage(1) }}>
          <option value="calls">{t('use.sortRequests')}</option><option value="tokens">{t('use.sortTokens')}</option>
          <option value="failedTurns">{t('use.sortFailed')}</option><option value="name">{t('use.sortName')}</option>
        </select>
        {search && <Button variant="ghost" onClick={() => { setSearch(''); setPage(1) }}><X size={14} />{t('use.clearSearch')}</Button>}
      </div>
      {models.total ? <><p className="usage-scroll-hint">{t('use.tableScrollHint')}</p>
      <div className="usage-model-scroll" tabIndex={0} role="region" aria-label={t('use.tableAria')}>
        <table className="usage-model-table"><thead><tr>
          <th scope="col">{t('use.colModel')}</th><th scope="col">{t('use.colTurns')}</th><th scope="col">{t('use.colRequests')}</th><th scope="col">{t('use.colInput')}</th>
          <th scope="col">{t('use.colOutput')}</th><th scope="col">{t('use.colFailedTurns')}</th><th scope="col">{t('use.colRecovered')}</th><th scope="col">{t('use.colTtft')}</th><th scope="col">{t('use.colSpeed')}</th>
        </tr></thead><tbody>{models.rows.map(model => <tr key={model.model} data-usage-model={model.model}>
          <td><strong>{model.name}</strong><code>{model.model}</code></td><td>{number(model.turns)}</td>
          <td>{number(model.calls)}<small>{t.format('use.failedSmall', { n: number(model.failed) })}</small></td>
          <td>{number(model.input)}</td><td>{number(model.output)}</td><td>{number(model.failedTurns)}</td>
          <td>{number(model.recoveredTurns)}</td><td>{measured(model.avgTtftMs)}<small>ms</small></td><td>{measured(model.tps)}<small>Token/s</small></td>
        </tr>)}</tbody></table>
      </div></> : <div className="usage-empty"><Activity size={25} /><h3>{search.trim() ? t('use.emptyMatched') : t('use.emptyNoRecords')}</h3>
        <p>{search.trim() ? t('use.emptyMatchedHint') : t('use.emptyRecordsHint')}</p></div>}
      <div className="usage-pagination"><span data-testid="usage-model-count">{t.format('use.pageCount', { shown: number(models.total), total: number(stats.models.length) })}</span>
        <span>{t.format('use.pageLabel', { page: models.page, pages: models.pages })}</span><Button variant="outline" aria-label={t('use.prevPageAria')} disabled={models.page === 1}
          onClick={() => setPage(models.page - 1)}><ChevronLeft size={15} />{t('use.prevPage')}</Button>
        <Button variant="outline" aria-label={t('use.nextPageAria')} disabled={models.page === models.pages}
          onClick={() => setPage(models.page + 1)}>{t('use.nextPage')}<ChevronRight size={15} /></Button></div>
    </Card>
    <p className="footnote">{t('use.footnote')}</p>
  </div>
}
