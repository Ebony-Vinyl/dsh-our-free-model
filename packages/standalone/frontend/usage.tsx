import { useEffect, useRef, useState } from 'react'
import { Activity, ArrowDownToLine, ArrowUpFromLine, ChevronLeft, ChevronRight, CircleAlert, Layers3, RefreshCw, Search, RotateCcw, X } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { usageDays, usageModels } from './usage-data.mjs'
import type { Host, Stats, UsageModel } from './types'
import './usage.css'

const number = (value: number) => new Intl.NumberFormat('id-ID').format(value)
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
    { name: 'Giliran pengguna', value: stats.turns, detail: 'Satu permintaan pengguna dihitung sebagai satu giliran', icon: Layers3 },
    { name: 'Permintaan fisik', value: stats.requests, detail: 'Termasuk percobaan ulang dan permintaan lanjutan pemulihan', icon: Activity },
    { name: 'Token masukan', value: stats.grand.input, detail: 'Mengikuti pemakaian yang dilaporkan', icon: ArrowDownToLine },
    { name: 'Token keluaran', value: stats.grand.output, detail: 'Mengikuti pemakaian yang dilaporkan', icon: ArrowUpFromLine },
    { name: 'Giliran gagal', value: stats.failedTurns, detail: 'Giliran pengguna yang tidak selesai', icon: CircleAlert },
    { name: 'Giliran pulih', value: stats.recoveredTurns, detail: 'Giliran pengguna yang selesai setelah pemulihan', icon: RotateCcw },
  ]
  const refresh = async () => {
    if (refreshingRef.current || !activeRef.current) return
    const started = ++generation.current
    const isCurrent = () => started === generation.current && activeRef.current
    refreshingRef.current = true
    setRefreshing(true); setMessage(''); setError('')
    try {
      await host.refresh()
      if (isCurrent()) setMessage('Statistik diperbarui')
    } catch (reason) {
      if (isCurrent()) setError(reason instanceof Error ? reason.name === 'TimeoutError' ? 'Waktu pembaruan habis. Coba lagi.'
        : reason instanceof TypeError && /fetch/i.test(reason.message) ? 'Tidak dapat terhubung ke layanan lokal. Pastikan layanan berjalan lalu coba lagi.'
        : reason.message : 'Gagal memperbarui statistik. Coba lagi.')
    } finally {
      if (isCurrent()) { refreshingRef.current = false; setRefreshing(false) }
    }
  }
  if (!active) return null
  return <div className="usage-browser" data-testid="usage-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">WORKSPACE / USAGE</div>
      <h1>Statistik pemakaian</h1><p>Lihat pemakaian kumulatif dan tren harian di perangkat ini.</p></div>
      <Button variant="outline" disabled={refreshing} onClick={() => { void refresh() }}>
        <RefreshCw size={15} className={refreshing ? 'spinning' : ''} />{refreshing ? 'Memperbarui' : 'Perbarui statistik'}
      </Button>
    </header>
    {message && <p className="usage-feedback" role="status">{message}</p>}
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label="Tutup pesan galat statistik" onClick={() => setError('')}><X size={15} /></Button></div>}
    <div className="usage-metrics">{metrics.map(metric => <Card className="dashboard-metric ov-metric" key={metric.name}>
      <div><span>{metric.name}</span><div className="ov-metric-icon"><metric.icon size={17} /></div></div>
      <strong title={number(metric.value)} data-metric={metric.name}>{metric.name.includes('Token') ? compact(metric.value) : number(metric.value)}</strong><p>{metric.detail}</p>
    </Card>)}</div>
    <div className="usage-scope"><span>Statistik kumulatif · tidak terpengaruh jumlah hari tren di bawah</span>
      <span>Permintaan fisik gagal <strong data-testid="usage-request-failures">{number(stats.requestFailures)}</strong></span>
      <span>Token penalaran <strong>{number(stats.grand.reasoning)}</strong></span></div>
    {(stats.logicalEstimated || stats.requestFailuresEstimated) && <p className="usage-estimated" role="note">
      <CircleAlert size={15} /><span>Statistik historis memuat perkiraan:
        {stats.logicalEstimated && ' giliran pengguna sebelum migrasi diperkirakan dari riwayat permintaan.'}
        {stats.requestFailuresEstimated && ' sebagian permintaan fisik yang gagal diperkirakan dari catatan yang tersisa.'}
        {' '}Catatan baru tetap memakai statistik permintaan dan giliran tersendiri.</span></p>}
    <Card className="usage-trend">
      <div className="card-heading"><div><h2>Pemakaian Token harian</h2><p>{period} hari terakhir · total masukan dan keluaran</p></div>
        <div className="channel-filters" role="group" aria-label="Rentang waktu tren">{[7, 14, 30].map(count =>
          <button key={count} aria-pressed={period === count} onClick={() => setPeriod(count)}>{count} hari</button>)}</div>
      </div>
      <div className="usage-window-total"><strong data-testid="usage-window-total">{number(windowTotal)}</strong><span>Token / rentang terpilih</span></div>
      <p className="usage-scroll-hint">Geser ke kiri dan kanan untuk melihat seluruh tanggal.</p>
      <div className="usage-trend-scroll"><div className="usage-trend-chart" style={{ minWidth: period * 35 }}
        role="img" aria-label={`Pemakaian Token ${period} hari terakhir: ${days.map(day => `${day.day} ${number(day.total)}`).join('; ')}`}>
        {days.map(day => <div className="usage-day" key={day.day} tabIndex={0} title={`${day.day} · ${number(day.total)} Token`}
          aria-label={`${day.day}: ${number(day.total)} Token`}>
          <div className="usage-day-track"><div className={`usage-day-bar ${day.total ? '' : 'zero'}`} style={{ height: `${Math.max(1, day.total / max * 100)}%` }} /></div>
          <span>{day.day.slice(5).replace('-', '/')}</span>
        </div>)}
      </div></div>
      {windowTotal === 0 && <p className="usage-window-empty" role="status">{hasHistory ? 'Tidak ada pemakaian Token tercatat pada rentang ini; statistik kumulatif tetap menyimpan riwayat.' : 'Belum ada catatan pemanggilan. Setelah klien terhubung, pemakaian akan tampil di sini.'}</p>}
      <div className="card-foot"><span>{days[0].day} — {days[days.length - 1].day} · hari lokal</span><span>Pemakaian yang tidak dilaporkan tidak diperkirakan sebagai Token nyata</span></div>
    </Card>
    <Card className="usage-model-panel">
      <div className="card-heading"><div><h2>Statistik per model</h2><p>Catatan kumulatif · maksimal 20 model per halaman</p></div>
        <Badge>{number(stats.models.length)} model</Badge></div>
      <div className="usage-model-filters"><div className="usage-model-search"><Search size={16} />
        <Input type="search" aria-label="Cari model statistik" placeholder="Cari nama atau ID model…" value={search}
          onChange={event => { setSearch(event.target.value); setPage(1) }} /></div>
        <select aria-label="Urutkan model statistik" value={sort} onChange={event => { setSort(event.target.value); setPage(1) }}>
          <option value="calls">Permintaan fisik terbanyak</option><option value="tokens">Pemakaian Token terbanyak</option>
          <option value="failedTurns">Giliran gagal terbanyak</option><option value="name">Nama model</option>
        </select>
        {search && <Button variant="ghost" onClick={() => { setSearch(''); setPage(1) }}><X size={14} />Hapus pencarian</Button>}
      </div>
      {models.total ? <><p className="usage-scroll-hint">Geser ke kiri dan kanan untuk melihat statistik lengkap.</p>
      <div className="usage-model-scroll" tabIndex={0} role="region" aria-label="Statistik kumulatif per model, dapat digulir horizontal">
        <table className="usage-model-table"><thead><tr>
          <th scope="col">Model / ID</th><th scope="col">Giliran pengguna</th><th scope="col">Permintaan fisik</th><th scope="col">Token masukan</th>
          <th scope="col">Token keluaran</th><th scope="col">Giliran gagal</th><th scope="col">Giliran pulih</th><th scope="col">Latensi token pertama</th><th scope="col">Kecepatan generasi</th>
        </tr></thead><tbody>{models.rows.map(model => <tr key={model.model} data-usage-model={model.model}>
          <td><strong>{model.name}</strong><code>{model.model}</code></td><td>{number(model.turns)}</td>
          <td>{number(model.calls)}<small>gagal {number(model.failed)}</small></td>
          <td>{number(model.input)}</td><td>{number(model.output)}</td><td>{number(model.failedTurns)}</td>
          <td>{number(model.recoveredTurns)}</td><td>{measured(model.avgTtftMs)}<small>ms</small></td><td>{measured(model.tps)}<small>Token/dtk</small></td>
        </tr>)}</tbody></table>
      </div></> : <div className="usage-empty"><Activity size={25} /><h3>{search.trim() ? 'Tidak ada model yang cocok' : 'Belum ada catatan pemakaian model'}</h3>
        <p>{search.trim() ? 'Coba nama atau ID lain, atau hapus pencarian.' : 'Setelah klien terhubung dan mengirim pesan, statistik model akan tampil di sini.'}</p></div>}
      <div className="usage-pagination"><span data-testid="usage-model-count">{number(models.total)} / {number(stats.models.length)} model</span>
        <span>Halaman {models.page} / {models.pages}</span><Button variant="outline" aria-label="Halaman sebelumnya model statistik" disabled={models.page === 1}
          onClick={() => setPage(models.page - 1)}><ChevronLeft size={15} />Sebelumnya</Button>
        <Button variant="outline" aria-label="Halaman berikutnya model statistik" disabled={models.page === models.pages}
          onClick={() => setPage(models.page + 1)}>Berikutnya<ChevronRight size={15} /></Button></div>
    </Card>
    <p className="footnote">Statistik hanya mencatat pemakaian dan performa; prompt dan jawaban tidak disimpan. Latensi token pertama dan kecepatan generasi dihitung dari sampel terukur yang tersimpan; bila tidak terukur, tampil “—”.</p>
  </div>
}
