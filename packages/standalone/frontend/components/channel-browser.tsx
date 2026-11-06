import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Network, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { shared } from 'ofm-shared-client'
import { Badge, Button, Card, Input } from './ui'
import { t as consoleT, bindT, providerText, getLocale } from '../i18n.mjs'
import type { Summary } from '../types'

interface Status { closed?: boolean; accounts?: { total: number; enabled: number }; models?: { total: number; disabled: number } }
type Rpc = (method: string, payload?: object) => Promise<any>
const t = bindT((key: string) => shared.DICT[getLocale()][key] ?? key)

export function ChannelBrowser({ rpc, summary }: { rpc: Rpc; summary: Summary & { reload?(): void } }) {
  const [statuses, setStatuses] = useState<Record<string, Status>>()
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [selected, select] = useState<string>()
  const [auto, setAuto] = useState<{ enabled: boolean; running?: boolean; ranToday?: boolean }>()
  const [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const sequence = useRef(0)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const reload = useCallback(async () => {
    const started = ++sequence.current
    try {
      const value = await rpc('provider.status', { providers: providers.map(row => row.id) })
      if (!mounted.current || started !== sequence.current) return
      setStatuses(value.statuses ?? {})
      setError('')
    } catch (failure) {
      if (mounted.current && started === sequence.current) setError((failure as Error).message)
    }
  }, [rpc])
  useEffect(() => {
    mounted.current = true
    void reload()
    void rpc('usage.autoCheckin', {}).then(value => {
      if (mounted.current) setAuto(value.autoCheckin)
    }).catch(() => {})
    const timer = setInterval(() => { if (!document.hidden) void reload() }, 45000)
    return () => { mounted.current = false; sequence.current++; clearInterval(timer) }
  }, [rpc, reload])
  useEffect(() => {
    if (selected) {
      window.scrollTo({ top: 0, behavior: 'instant' })
      detailHeading.current?.focus({ preventScroll: true })
    }
  }, [selected])
  const onChanged = useCallback(() => {
    void reload()
    window.dispatchEvent(new CustomEvent('ofm:channels'))
    summary.reload?.()
  }, [reload, summary.reload])
  const onError = useCallback((_provider: unknown, failure: Error) => { if (mounted.current) setError(failure.message) }, [])
  const connected = providers.filter(provider => statuses?.[provider.id]?.accounts?.enabled && !statuses[provider.id].closed).length
  const accounts = Object.values(statuses ?? {}).reduce((sum, row) => sum + (row.accounts?.total ?? 0), 0)
  const selectedProvider = providers.find(row => row.id === selected)
  const rows = providers.filter(provider => {
    const status = statuses?.[provider.id]
    const isConnected = (status?.accounts?.enabled ?? 0) > 0 && !status?.closed
    return `${providerText(provider, 'name')} ${providerText(provider, 'org')}`.toLowerCase().includes(search.toLowerCase().trim())
      && (filter === 'all' || (filter === 'connected' ? isConnected : !isConnected))
  })
  // 分类标签展示全量数量；搜索后的匹配数量由结果栏单独展示。
  const counts: Record<string, number> = {
    all: providers.length,
    connected,
    pending: providers.filter(provider => {
      const status = statuses?.[provider.id]
      return !status || status.closed || (status.accounts?.enabled ?? 0) <= 0
    }).length,
  }
  return <>
    <div className="channel-summary-strip">
      <div className="ch-metric"><span className="ch-metric-icon"><Network size={16} /></span>
        <div className="ch-metric-body"><span className="ch-metric-label">{t('cb.connectedChannels')}</span>
          <strong className="ch-metric-value">{statuses ? connected : <span className="ch-skeleton" />}<small> / {providers.length}</small></strong></div></div>
      <div className="ch-metric"><span className="ch-metric-icon"><ShieldCheck size={16} /></span>
        <div className="ch-metric-body"><span className="ch-metric-label">{t('cb.localAccounts')}</span>
          <strong className="ch-metric-value">{statuses ? accounts : <span className="ch-skeleton" />}</strong></div></div>
      <div className="checkin-control"><span className="status-dot" /><span>{auto?.running ? t('cb.checkinRunning') : auto?.ranToday ? t('cb.checkinDone') : t('cb.autoCheckin')}</span>
        <button type="button" role="switch" aria-label={t('cb.autoCheckin')} aria-checked={auto?.enabled === true}
          className={`ui-switch ${auto?.enabled ? 'on' : ''}`} disabled={!auto || busy} onClick={() => {
            setBusy(true)
            void rpc('usage.autoCheckin', { enabled: !auto?.enabled }).then(value => { if (mounted.current) setAuto(value.autoCheckin) })
              .catch(failure => { if (mounted.current) setError(failure.message) }).finally(() => { if (mounted.current) setBusy(false) })
          }}><span /></button>
      </div>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="ghost" onClick={() => { void reload() }}>{t('action.retry')}</Button></div>}
    {selectedProvider ? <div className="provider-detail" data-testid="provider-detail">
      <div className="provider-detail-top"><Button variant="outline" onClick={() => select(undefined)}><ArrowLeft size={15} />{t('cb.backToAll')}</Button>
        <span>{t('cb.credentialNote')}</span></div>
      <div className="provider-detail-layout"><Card className="provider-detail-sidebar"><h2 tabIndex={-1} ref={detailHeading}>{providerText(selectedProvider, 'name')}</h2><p>{providerText(selectedProvider, 'org')}</p>
        <div className="detail-label">{t('cb.switchChannel')}</div>{providers.map(provider => <button className={`detail-provider-link ${provider.id === selected ? 'active' : ''}`} key={provider.id}
          onClick={() => select(provider.id)}><span>{providerText(provider, 'name')}</span>{provider.id === selected && <Check size={14} />}</button>)}</Card>
        <div className="provider-detail-main"><div className="provider-detail-description"><h2>{t('cb.accountsAndModels')}</h2><p>{t('cb.accountsAndModelsSub')}</p></div>
          <shared.ChannelCard key={selectedProvider.id} channel={selectedProvider} status={statuses?.[selectedProvider.id]} rpc={rpc} t={t} onChanged={onChanged} onError={onError} />
          <div className="detail-security-note"><ShieldCheck size={16} />{t('cb.securityNote')}</div>
        </div></div>
    </div> : <>
      <div className="channel-toolbar"><div className="channel-search"><Search size={17} /><Input aria-label={t('cb.searchChannels')} placeholder={t('cb.searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="channel-filters" aria-label={t('cb.statusFilter')}>{[['all', t('mdl.allChannels')], ['connected', t('cb.connected')], ['pending', t('cb.pending')]].map(([id, label]) =>
          <button key={id} aria-pressed={filter === id} disabled={id !== 'all' && !statuses} onClick={() => setFilter(id)}>{label}<span>{id === 'all' || statuses ? counts[id] : '—'}</span></button>)}</div>
      </div>
      <div className="channel-results-meta"><span>{t.format('cb.resultCount', { n: rows.length })}</span><span><SlidersHorizontal size={13} />{t('cb.manageHint')}</span></div>
      <div className="provider-grid">{rows.map(provider => {
        const status = statuses?.[provider.id]
        const state = status?.closed ? t('cb.closed') : (status?.accounts?.enabled ?? 0) > 0 ? t('cb.connected') : t('cb.pending')
        return <Card className="provider-card channel-directory-row" key={provider.id}>
          <span className="provider-logo" style={{ color: provider.accent, backgroundColor: `${provider.accent}0d` }}>{providerText(provider, 'name').slice(0, 2).toUpperCase()}</span>
          <div className="channel-directory-name"><h2>{providerText(provider, 'name')}</h2><div className="provider-org">{providerText(provider, 'org')}</div><p className="provider-description">{providerText(provider, 'note')}</p></div>
          <div className="provider-counts"><span>{t('cb.accounts')} <strong>{status ? status.accounts?.total ?? 0 : '—'}</strong></span>
            <span>{t('cb.models')} <strong>{status ? Math.max(0, (status.models?.total ?? 0) - (status.models?.disabled ?? 0)) : '—'}</strong></span></div>
          <Badge tone={state === t('cb.connected') ? 'success' : 'neutral'}>{state === t('cb.connected') && <span className="status-dot" />}{state}</Badge>
          <Button variant="outline" className="provider-manage" onClick={() => select(provider.id)}>{state === t('cb.connected') ? t('cb.manage') : t('cb.connect')}<ArrowRight size={14} /></Button>
        </Card>
      })}</div>
      {rows.length === 0 && <Card className="channel-empty"><Search size={24} /><h2>{t('cb.noMatch')}</h2><p>{t('cb.noMatchHint')}</p><Button variant="outline" onClick={() => { setSearch(''); setFilter('all') }}>{t('cb.resetFilters')}</Button></Card>}
    </>}
  </>
}
