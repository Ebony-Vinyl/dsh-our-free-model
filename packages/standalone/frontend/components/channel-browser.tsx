import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, CircleAlert, Network, Search, ShieldCheck, SlidersHorizontal } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { shared } from 'ofm-shared-client'
import { Badge, Button, Card, Input } from './ui'
import type { Summary } from '../types'

interface Status { closed?: boolean; accounts?: { total: number; enabled: number }; models?: { total: number; disabled: number } }
type Rpc = (method: string, payload?: object) => Promise<any>
const t = Object.assign((key: string) => shared.DICT.zh[key] ?? key, { locale: 'zh' })

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
    const timer = setInterval(() => { void reload() }, 45000)
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
    return `${provider.name} ${provider.org}`.toLowerCase().includes(search.toLowerCase().trim())
      && (filter === 'all' || (status !== undefined && (filter === 'connected' ? isConnected : !isConnected)))
  })
  // Label kategori menampilkan jumlah keseluruhan; jumlah hasil pencarian ditampilkan terpisah di bilah hasil.
  const counts: Record<string, number> = {
    all: providers.length,
    connected,
    pending: providers.filter(provider => {
      const status = statuses?.[provider.id]
      return status !== undefined && (status.closed || (status.accounts?.enabled ?? 0) <= 0)
    }).length,
  }
  return <>
    <div className="channel-summary-strip">
      <div className="ch-metric"><span className="ch-metric-icon"><Network size={16} /></span>
        <div className="ch-metric-body"><span className="ch-metric-label">Kanal terhubung</span>
          <strong className="ch-metric-value">{statuses ? connected : <span className="ch-skeleton" />}<small> / {providers.length}</small></strong></div></div>
      <div className="ch-metric"><span className="ch-metric-icon"><ShieldCheck size={16} /></span>
        <div className="ch-metric-body"><span className="ch-metric-label">Akun di perangkat ini</span>
          <strong className="ch-metric-value">{statuses ? accounts : <span className="ch-skeleton" />}</strong></div></div>
      <div className="checkin-control"><span className="status-dot" /><span>{auto?.running ? 'Check-in berjalan' : auto?.ranToday ? 'Check-in hari ini sudah dijalankan' : 'Check-in otomatis harian'}</span>
        <button type="button" role="switch" aria-label="Check-in otomatis harian" aria-checked={auto?.enabled === true}
          className={`ui-switch ${auto?.enabled ? 'on' : ''}`} disabled={!auto || busy} onClick={() => {
            setBusy(true)
            void rpc('usage.autoCheckin', { enabled: !auto?.enabled }).then(value => { if (mounted.current) setAuto(value.autoCheckin) })
              .catch(failure => { if (mounted.current) setError(failure.message) }).finally(() => { if (mounted.current) setBusy(false) })
          }}><span /></button>
      </div>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="ghost" onClick={() => { void reload() }}>Coba lagi</Button></div>}
    {selectedProvider ? <div className="provider-detail" data-testid="provider-detail">
      <div className="provider-detail-top"><Button variant="outline" onClick={() => select(undefined)}><ArrowLeft size={15} />Kembali ke semua kanal</Button>
        <span>Kredensial akun disimpan di direktori mandiri perangkat ini</span></div>
      <div className="provider-detail-layout"><Card className="provider-detail-sidebar"><h2 tabIndex={-1} ref={detailHeading}>{selectedProvider.name}</h2><p>{selectedProvider.org}</p>
        <div className="detail-label">Ganti kanal</div>{providers.map(provider => <button className={`detail-provider-link ${provider.id === selected ? 'active' : ''}`} key={provider.id}
          onClick={() => select(provider.id)}><span>{provider.name}</span>{provider.id === selected && <Check size={14} />}</button>)}</Card>
        <div className="provider-detail-main"><div className="provider-detail-description"><h2>Akun dan model</h2><p>Tambahkan akun, kelola kuota gratis dan model yang tersedia.</p></div>
          <shared.ChannelCard key={selectedProvider.id} channel={selectedProvider} status={statuses?.[selectedProvider.id]} rpc={rpc} t={t} onChanged={onChanged} onError={onError} />
          <div className="detail-security-note"><ShieldCheck size={16} />Mengikuti aturan login, perpanjangan, dan kuota kanal asal. Cadangan akun dan pengaturan penyedia ada di "Penyedia dan cadangan".</div>
        </div></div>
    </div> : <>
      <div className="channel-toolbar"><div className="channel-search"><Search size={17} /><Input aria-label="Cari kanal" placeholder="Cari kanal atau penyedia…" value={search} onChange={event => setSearch(event.target.value)} /></div>
        <div className="channel-filters" aria-label="Filter status kanal">{[['all', 'Semua kanal'], ['connected', 'Terhubung'], ['pending', 'Belum terhubung']].map(([id, label]) =>
          <button key={id} aria-pressed={filter === id} disabled={id !== 'all' && !statuses} onClick={() => setFilter(id)}>{label}<span>{id === 'all' || statuses ? counts[id] : '—'}</span></button>)}</div>
      </div>
      <div className="channel-results-meta"><span>{rows.length} kanal</span><span><SlidersHorizontal size={13} />Kelola akun dan kuota terpisah per penyedia</span></div>
      <div className="provider-grid">{rows.map(provider => {
        const status = statuses?.[provider.id]
        const state = status === undefined ? 'Memuat' : status.closed ? 'Ditutup' : (status.accounts?.enabled ?? 0) > 0 ? 'Terhubung' : 'Belum terhubung'
        return <Card className="provider-card" key={provider.id}>
          <div className="provider-card-top"><span className="provider-logo" style={{ color: provider.accent, backgroundColor: `${provider.accent}0d` }}>{provider.name.slice(0, 2).toUpperCase()}</span>
            <Badge tone={state === 'Terhubung' ? 'success' : 'neutral'}>{state === 'Terhubung' && <span className="status-dot" />}{state}</Badge></div>
          <h2>{provider.name}</h2><div className="provider-org">{provider.org}</div><p className="provider-description">{provider.note}</p>
          <div className="provider-counts"><span>Akun <strong>{status ? status.accounts?.total ?? 0 : '—'}</strong></span>
            <span>Model <strong>{status ? Math.max(0, (status.models?.total ?? 0) - (status.models?.disabled ?? 0)) : '—'}</strong></span></div>
          <Button variant="outline" className="provider-manage" onClick={() => select(provider.id)}>Kelola kanal <ArrowRight size={14} /></Button>
        </Card>
      })}</div>
      {rows.length === 0 && <Card className="channel-empty"><Search size={24} /><h2>Tidak ada kanal yang cocok</h2><p>Coba nama lain, atau ubah filter.</p><Button variant="outline" onClick={() => { setSearch(''); setFilter('all') }}>Atur ulang filter</Button></Card>}
    </>}
  </>
}
