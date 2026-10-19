import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowRight, ArrowUpRight, Boxes, Check, CircleCheck, Copy, Handshake, Layers3, Network, RefreshCw, Terminal, Zap } from 'lucide-react'
import { Badge, Button, Card } from './ui'
import '../usage.css'
import type { Host, Snapshot } from '../types'

const number = (value: number) => new Intl.NumberFormat('id-ID').format(value)
const compact = (value: number) => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}K` : number(value)

export function Overview({ summary, stats, host }: Snapshot & { host: Host }) {
  const [refreshing, setRefreshing] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current) }, [])

  const metricRows = [
    { name: 'Model dapat diakses', value: number(summary.catalog.filter(model => model.routable).length), icon: Boxes, detail: 'Daftar model yang dipublikasikan saat ini' },
    { name: 'Giliran pengguna', value: number(stats.turns), icon: Layers3, detail: `${number(stats.requests)} permintaan fisik` },
    { name: 'Token kumulatif', value: compact(stats.grand.input + stats.grand.output), icon: Zap, detail: `Masukan ${compact(stats.grand.input)} · Keluaran ${compact(stats.grand.output)}` },
    { name: 'Giliran pulih', value: number(stats.recoveredTurns), icon: Activity, detail: `Belum selesai ${number(stats.failedTurns)} giliran` },
  ]
  const today = new Date()
  const days = Array.from({ length: 7 }, (_, index) => {
    const at = new Date(today); at.setDate(at.getDate() - 6 + index)
    const id = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    return { id, value: stats.days.find(row => row.day === id)?.total ?? 0 }
  })
  const total = days.reduce((sum, row) => sum + row.value, 0)
  const max = Math.max(1, ...days.map(row => row.value))
  const failures = [...stats.samples].reverse().filter(row => row.ok === false).slice(0, 4)
  const sources = [
    { name: 'Anonim & Kilo', sub: 'Model gratis tanpa akun', icon: Zap, count: summary.catalog.filter(row => row.channel === 'anonymous' || row.channel === 'kilo').length, page: 'models' as const },
    { name: 'Kanal akun gratis', sub: '13 penyedia, kumpulan akun terpisah', icon: Network, count: summary.catalog.filter(row => !['anonymous', 'kilo', 'eac'].includes(row.channel)).length, page: 'channels' as const },
    { name: 'Kanal patungan EAC', sub: summary.eacAuth?.local ? 'Otorisasi lokal tersimpan' : 'Otorisasi lokal belum tersimpan', icon: Handshake, count: summary.catalog.filter(row => row.channel === 'eac').length, page: 'eac' as const },
  ]

  const copyEndpoint = () => {
    void host.copy(`${summary.baseUrl}/v1`).then(() => {
      setCopied(true)
      if (copyTimer.current) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 2000)
    }).catch(host.error)
  }

  return <div className="dashboard" data-testid="overview-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">WORKSPACE / OVERVIEW</div><h1>Ikhtisar ruang kerja</h1><p>Lihat koneksi model dan kondisi operasional Anda.</p></div>
      <Button variant="outline" disabled={refreshing} onClick={() => {
        setRefreshing(true); void host.refresh().catch(host.error).finally(() => setRefreshing(false))
      }}><RefreshCw size={15} className={refreshing ? 'spinning' : ''} />{refreshing ? 'Memperbarui' : 'Perbarui status'}</Button></header>

    <div className="dashboard-metrics">{metricRows.map(metric => <Card className="dashboard-metric ov-metric" key={metric.name}>
      <div><span>{metric.name}</span><div className="ov-metric-icon"><metric.icon size={17} /></div></div>
      <strong>{metric.value}</strong><p>{metric.detail}</p>
    </Card>)}</div>

    <div className="dashboard-main-grid">
      <Card className="usage-panel ov-chart-panel">
        <div className="card-heading"><div><h2>Pemakaian token</h2><p>Masukan dan keluaran 7 hari terakhir</p></div><Badge>7 hari terakhir</Badge></div>
        <div className="usage-total ov-chart-total">{compact(total)} <span>Token</span></div>
        <div className="dashboard-chart ov-chart" role="img" aria-label={`Pemakaian token tujuh hari terakhir: ${days.map(day => `${day.id} ${day.value}`).join('; ')}`}>
          <div className="chart-grid-lines"><span /><span /><span /><span /></div>
          {days.map(day => <div className="dashboard-chart-column ov-chart-col" key={day.id} title={`${day.id} · ${number(day.value)} Token`}>
            <div className={`dashboard-chart-bar ${day.value === 0 ? 'zero' : ''}`} style={{ height: `${Math.max(2, day.value / max * 80)}%` }} />
            <span>{day.id.slice(5).replace('-', '/')}</span>
          </div>)}
          {total === 0 && <div className="chart-empty ov-chart-empty"><Activity size={22} /><span>Belum ada catatan pemanggilan</span><small>Setelah klien terhubung, pemakaian akan tampil di sini</small></div>}
        </div>
        <div className="card-foot"><span>Dihitung dari catatan permintaan sebenarnya</span><button onClick={() => host.navigate('usage')}>Lihat semua pemakaian <ArrowRight size={14} /></button></div>
      </Card>

      <Card className="quick-connect ov-quick">
        <div className="quick-icon ov-quick-icon"><Terminal size={20} /></div>
        <h2>Akses API</h2><p>[OI] kompatibel · Chat Completions / Responses</p>
        <label>API BASE URL</label>
        <div className="quick-endpoint ov-endpoint"><code>{summary.baseUrl}/v1</code>
          <Button variant="ghost" aria-label="Salin alamat API" onClick={copyEndpoint} title="Salin alamat API"
            className={copied ? 'ov-copied' : ''}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </Button>
        </div>
        {copied && <span className="copy-feedback" role="status">Alamat disalin</span>}
        <div className="connect-steps"><span>Sesi manajemen: sesi lokal mandiri</span><span>Autentikasi inferensi: Bearer API Key</span><span>Cakupan listener: hanya loopback</span></div>
        <Button className="connect-button" onClick={() => host.navigate('connection')}>Lihat konfigurasi akses <ArrowUpRight size={16} /></Button>
        <div className="connection-footnote"><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? 'Layanan inferensi aktif' : 'Layanan inferensi dijeda'}</div>
      </Card>
    </div>

    <div className="dashboard-bottom-grid">
      <Card className="ov-sources">
        <div className="card-heading"><div><h2>Sumber model</h2><p>Semua kanal berbagi satu alamat akses</p></div><Network size={18} /></div>
        <div className="source-list ov-source-list">{sources.map((source, index) => <button className="source-row ov-source-row" key={source.name} onClick={() => host.navigate(source.page)}
          style={{ animationDelay: `${index * 60}ms` }}>
          <span className="source-icon"><source.icon size={18} /></span>
          <span><strong>{source.name}</strong><small>{source.sub}</small></span>
          <Badge>{source.count} model</Badge><ArrowRight size={14} />
        </button>)}</div>
      </Card>

      <Card className="ov-failures">
        <div className="card-heading"><div><h2>Pemeriksaan operasional</h2><p>Layanan dan permintaan gagal terakhir</p></div>
          <Badge tone={failures.length ? 'warning' : 'success'}>{failures.length ? 'Ada catatan gagal' : 'Belum ada catatan gagal'}</Badge></div>
        <div className="runtime-check"><CircleCheck size={17} /><span>Modul kanal</span><strong>{summary.channels.state === 'ready' ? 'Siap' : summary.channels.state === 'failed' ? 'Gagal dimuat' : 'Menginisialisasi'}</strong></div>
        <div className="runtime-check"><RefreshCw size={17} /><span>Penyegaran model otomatis</span><strong>{summary.automaticRefresh ? `Setiap ${summary.settings.probeIntervalMinutes} menit` : 'Dijeda'}</strong></div>
        {failures.length ? <div className="failure-list ov-failure-list">{failures.map((row, index) =>
          <div key={`${row.at}-${index}`} className="ov-failure-row">
            <span>{row.model ?? 'Model tidak dikenal'}</span>
            <small>{row.at ? new Date(row.at).toLocaleTimeString('id-ID') : 'Waktu tidak diketahui'} · Permintaan tidak selesai</small>
          </div>)}</div>
          : <div className="runtime-empty ov-runtime-empty"><CircleCheck size={18} /><span>Tidak ada catatan gagal pada sampel permintaan terakhir</span></div>}
        <div className="card-foot"><span title={summary.dataDir}>Data hanya disimpan di direktori lokal mandiri</span><button onClick={() => host.navigate('settings')}>Pengaturan layanan <ArrowRight size={14} /></button></div>
      </Card>
    </div>
  </div>
}
