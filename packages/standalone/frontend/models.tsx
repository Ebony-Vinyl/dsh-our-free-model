import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { Boxes, Check, CircleAlert, CircleCheck, Copy, Eye, EyeOff, LoaderCircle, Play, RefreshCw, Search, SlidersHorizontal, Square, X } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { Badge, Button, Input } from './components/ui'
import { filterModels } from './models-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Model, ModelTestResult, ServiceSettings, Summary } from './types'
import './models.css'

const availabilityNames: Record<string, string> = {
  available: 'Tersedia (terdeteksi)', listed: 'Tercatat di daftar', unknown: 'Belum dideteksi',
  unavailable: 'Tidak tersedia', throttled: 'Dibatasi', 'region-blocked': 'Dibatasi wilayah',
}
const sourceNames: Record<string, string> = { anonymous: 'Model anonim', kilo: 'Kumpulan gratis Kilo', eac: 'Patungan EAC' }
const channelName = (id: string) => sourceNames[id]
  ?? providers.find(provider => provider.id === id)?.name ?? id
const number = (value: number) => new Intl.NumberFormat('id-ID').format(value)
const capacity = (value?: number) => value && Number.isFinite(value) && value > 0
  ? value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : number(value) : 'Tidak diketahui'
const initialFilters = { search: '', channel: 'all', capability: 'all', availability: 'all', access: 'all' }
type Operation = 'refresh' | 'probe' | 'test'
type TestState = { model: Model; state: 'pending' | 'success' | 'error' | 'cancelled'; result?: ModelTestResult; error?: string }

export function Models({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [filters, setFilters] = useState(initialFilters)
  const [operation, setOperation] = useState<Operation>()
  const [test, setTest] = useState<TestState>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string>()
  const [focusedId, setFocusedId] = useState<string>()
  const [visibilitySaving, setVisibilitySaving] = useState(false)
  const visibilityPending = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef<AbortController | undefined>(undefined)
  const activeRef = useRef(active)
  activeRef.current = active
  const models = useMemo<Model[]>(() => filterModels(summary.catalog, filters), [summary.catalog, filters])
  const channels = useMemo(() => [...new Set(['anonymous', 'kilo', 'eac', ...summary.catalog.map(model => model.channel), filters.channel])]
    .filter(id => id !== 'all'), [summary.catalog, filters.channel])
  const focusedIndex = focusedId ? models.findIndex(model => model.id === focusedId) : -1
  const rangeExtractor = useCallback((range: Range) => {
    const visible = defaultRangeExtractor(range)
    return focusedIndex >= 0 ? [...new Set([...visible, focusedIndex])].sort((a, b) => a - b) : visible
  }, [focusedIndex])
  const virtual = useVirtualizer({
    count: models.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 112, overscan: 5, enabled: active,
    getItemKey: index => models[index].id, rangeExtractor,
  })
  const changeFilters = (patch: Partial<typeof initialFilters>) => {
    // Gulir native ke nol agar target gulir halus tidak berubah saat pengukuran dinamis.
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setFilters(previous => ({ ...previous, ...patch }))
    setFocusedId(undefined)
  }
  useEffect(() => {
    if (!active) {
      pending.current?.abort()
      pending.current = undefined
      setOperation(undefined)
      setTest(previous => previous?.state === 'pending' ? { ...previous, state: 'cancelled' } : previous)
    }
    return () => { pending.current?.abort(); pending.current = undefined }
  }, [active])
  useEffect(() => {
    if (active && scrollRef.current) {
      const max = Math.max(0, virtual.getTotalSize() - scrollRef.current.clientHeight)
      if (scrollRef.current.scrollTop > max) scrollRef.current.scrollTop = max
    }
  }, [models.length, active, virtual])

  const run = async (kind: Operation, model?: Model) => {
    if (pending.current || !activeRef.current) return
    const controller = new AbortController()
    pending.current = controller
    setOperation(kind); setError(''); setMessage('')
    if (model) setTest({ model, state: 'pending' })
    const isCurrent = () => pending.current === controller && !controller.signal.aborted && activeRef.current
    try {
      if (kind === 'test' && model) {
        const result = await host.testModel(model.id, controller.signal)
        if (!isCurrent()) return
        setTest({ model, state: 'success', result })
        try {
          await host.refresh()
        } catch (reason) {
          if (!isCurrent()) return
          const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? 'Permintaan habis waktu. Coba lagi.' : reason.message : 'Permintaan gagal. Coba lagi.'
          setError(`Uji model berhasil, tetapi penyegaran ringkasan gagal: ${detail}`)
        }
      } else {
        await host.refreshModels(kind === 'probe', controller.signal)
        if (!isCurrent()) return
        setMessage(kind === 'probe' ? 'Deteksi ketersediaan selesai' : 'Daftar model diperbarui')
      }
    } catch (reason) {
      if (!isCurrent()) return
      const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? 'Permintaan habis waktu. Coba lagi.' : reason.message : 'Operasi gagal. Coba lagi.'
      if (kind === 'test' && model) setTest({ model, state: 'error', error: detail })
      else setError(detail)
    } finally {
      if (isCurrent()) { pending.current = undefined; setOperation(undefined) }
    }
  }

  const cancel = () => {
    pending.current?.abort()
    pending.current = undefined
    setOperation(undefined)
    setTest(previous => previous ? { ...previous, state: 'cancelled' } : previous)
  }

  const copyModelId = (model: Model) => {
    void host.copy(model.id).then(() => {
      if (activeRef.current) {
        setCopied(model.id)
        setTimeout(() => { if (activeRef.current) setCopied(undefined) }, 1800)
      }
    }).catch(host.error)
  }

  const saveVisibility = async (patch: Partial<ServiceSettings>) => {
    if (visibilityPending.current || !activeRef.current) return
    visibilityPending.current = true
    setVisibilitySaving(true); setError(''); setMessage('')
    try {
      await host.saveSettings(patch)
      if (activeRef.current) setMessage(visibility.saved)
      try { await host.refresh() } catch (reason) { if (activeRef.current) host.error(reason as Error) }
    } catch (reason) {
      if (activeRef.current) setError(reason instanceof Error ? reason.message : 'Gagal menyimpan. Coba lagi.')
    } finally {
      visibilityPending.current = false
      setVisibilitySaving(false)
    }
  }

  if (!active) return null
  const filtered = Object.entries(filters).some(([key, value]) => value !== initialFilters[key as keyof typeof initialFilters])
  const routable = summary.catalog.filter(model => model.routable).length
  return <div className="model-browser" data-testid="models-ready">
    <header className="dashboard-heading">
      <div><div className="heading-eyebrow">WORKSPACE / MODELS</div><h1>Daftar model</h1>
        <p>{number(summary.catalog.length)} model · {number(routable)} dapat diakses</p></div>
      <div className="actions">
        <Button variant="outline" disabled={!!operation} onClick={() => { void run('refresh') }}>
          <RefreshCw size={15} className={operation === 'refresh' ? 'spinning' : ''} />{operation === 'refresh' ? 'Menyegarkan' : 'Segarkan daftar'}
        </Button>
        <Button disabled={!!operation || !summary.settings.enabled} title="Akan mengirim sedikit permintaan inferensi ke hulu"
          onClick={() => { void run('probe') }}>
          {operation === 'probe' ? <LoaderCircle size={15} className="spinning" /> : <CircleCheck size={15} />}
          {operation === 'probe' ? 'Mendeteksi' : 'Deteksi ketersediaan'}
        </Button>
      </div>
    </header>
    <div className="model-summary">
      <span><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? 'Inferensi aktif' : 'Inferensi dijeda'}</span>
      <span>Pembaruan daftar: {summary.catalogSyncedAt ? new Date(summary.catalogSyncedAt).toLocaleString('id-ID', { hour12: false }) : 'Belum disegarkan'}</span>
      <span>Deteksi dan uji aktif akan menghasilkan permintaan inferensi</span>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label="Tutup pesan galat" title="Tutup pesan galat" onClick={() => setError('')}><X size={15} /></Button></div>}
    {message && <p className="model-feedback" role="status"><Check size={15} />{message}</p>}
    <div className="model-filters">
      <div className="model-search"><Search size={16} /><Input type="search" aria-label="Cari model" placeholder="Cari nama model atau ID…"
        value={filters.search} onChange={event => changeFilters({ search: event.target.value })} /></div>
      <select aria-label="Filter kanal" value={filters.channel} onChange={event => changeFilters({ channel: event.target.value })}>
        <option value="all">Semua kanal</option>{channels.map(id => <option value={id} key={id}>{channelName(id)}</option>)}
      </select>
      <select aria-label="Filter kemampuan model" value={filters.capability} onChange={event => changeFilters({ capability: event.target.value })}>
        <option value="all">Semua kemampuan</option><option value="text">Teks saja</option><option value="vision">Mendukung visual</option><option value="reasoning">Mendukung penalaran</option>
      </select>
      <select aria-label="Filter status ketersediaan" value={filters.availability} onChange={event => changeFilters({ availability: event.target.value })}>
        <option value="all">Semua status</option>{Object.entries(availabilityNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
      </select>
    </div>
    <div className="model-list-toolbar">
      <div className="channel-filters" role="group" aria-label="Filter cakupan publikasi">
        {([['all', 'Semua model'], ['routable', 'Dapat diakses'], ['hidden', 'Tidak dipublikasikan']] as const).map(([id, name]) =>
          <button key={id} aria-pressed={filters.access === id} onClick={() => changeFilters({ access: id })}>{name}</button>)}
      </div>
      <span role="status" data-testid="model-result-count">{number(models.length)} / {number(summary.catalog.length)} model</span>
      {filtered && <Button variant="ghost" onClick={() => changeFilters(initialFilters)}><X size={14} />Hapus filter</Button>}
    </div>
    <div className="model-list-toolbar">
      <label><input type="checkbox" role="switch" checked={summary.settings.hideFreeModels === true}
        disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideFreeModels: event.target.checked }) }} /> {visibility.hideFree}</label>
      <label><input type="checkbox" role="switch" checked={summary.settings.hideEacModels === true}
        disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideEacModels: event.target.checked }) }} /> {visibility.hideEac}</label>
    </div>
    {test && <section className={`model-test-result model-test-${test.state}`} aria-label="Hasil uji model" aria-live="polite">
      <div className="model-test-heading"><div><strong>
        {test.state === 'pending' ? 'Sedang menguji' : test.state === 'success' ? 'Uji selesai' : test.state === 'cancelled' ? 'Uji dibatalkan' : 'Uji gagal'}
      </strong><span>{test.model.name}{test.result && ` · ${number(test.result.latencyMs)} ms`}</span></div>
        {test.state === 'pending' ? <Button variant="outline" onClick={cancel}><Square size={14} />Batalkan uji</Button>
          : <Button variant="ghost" aria-label="Tutup hasil uji" title="Tutup hasil uji" onClick={() => setTest(undefined)}><X size={15} /></Button>}
      </div>
      {test.state === 'success' && <pre>{test.result?.text || 'Permintaan selesai, tetapi hulu tidak mengembalikan isi yang terlihat.'}</pre>}
      {test.state === 'error' && <p>{test.error}</p>}
    </section>}
    {models.length ? <div className="model-table" role="table" aria-label="Daftar model" aria-rowcount={models.length + 1} aria-colcount={5}>
      <div className="model-table-header" role="row"><span role="columnheader">Model / ID</span><span role="columnheader">Kanal & kemampuan</span>
        <span role="columnheader">Konteks / keluaran</span><span role="columnheader">Status</span><span role="columnheader">Tindakan</span></div>
      <div ref={scrollRef} className="model-scroll" role="rowgroup" tabIndex={0} aria-label="Gulir daftar model" onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          virtual.scrollToIndex(event.key === 'Home' ? 0 : models.length - 1, { align: event.key === 'Home' ? 'start' : 'end' })
        }
      }}>
        <div className="model-virtual-content" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map(item => {
            const model = models[item.index]
            const state = model.availability ?? 'unknown'
            const disabledReason = !summary.settings.enabled ? 'Layanan inferensi dijeda' : !model.routable && !model.hiddenByUser ? 'Model belum dipublikasikan; periksa akun kanal atau pengaturan model' : operation ? 'Tunggu operasi saat ini selesai' : ''
            return <div role="row" aria-rowindex={item.index + 2} key={item.key} data-index={item.index} data-model-id={model.id}
              className="model-table-row" ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)` }}
              onFocusCapture={() => setFocusedId(model.id)} onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
              }}>
              <div role="cell" className="model-identity"><strong>{model.name}</strong><code>{model.id}</code></div>
              <div role="cell" className="model-source"><span>{channelName(model.channel)}</span><div className="model-capabilities">
                <Badge>{model.vision ? 'Visual' : 'Teks saja'}</Badge>{model.reasoning && <Badge tone="blue">Penalaran</Badge>}</div></div>
              <div role="cell" className="model-limits"><span title={model.contextWindow ? `${model.contextWindow} Token` : undefined}>{capacity(model.contextWindow)} <small>konteks</small></span>
                <span title={model.maxOutput ? `${model.maxOutput} Token` : undefined}>{capacity(model.maxOutput)} <small>keluaran</small></span></div>
              <div role="cell" className="model-state"><Badge tone={state === 'available' ? 'success' : ['unavailable', 'throttled', 'region-blocked'].includes(state) ? 'warning' : 'neutral'}>
                {availabilityNames[state] ?? 'Status tidak dikenal'}</Badge>{!model.routable && <small>{model.hiddenByUser ? visibility.hidden : 'Tidak dipublikasikan'}</small>}
                {model.ttftMs != null && <small>Respons pertama {number(model.ttftMs)} ms</small>}</div>
              <div role="cell" className="model-row-actions">
                {['anonymous', 'kilo', 'eac', 'aggregate', 'combo'].includes(model.channel) && <Button variant="ghost"
                  disabled={visibilitySaving || model.hiddenByGroup === true}
                  title={model.hiddenByGroup ? visibility.groupHidden : model.hiddenByUser ? visibility.show : visibility.hide}
                  aria-label={`${model.hiddenByUser ? visibility.show : visibility.hide}: ${model.id}`}
                  onClick={() => { const ids = summary.settings.hiddenModelIds ?? []; void saveVisibility({
                    hiddenModelIds: ids.includes(model.id) ? ids.filter(id => id !== model.id) : [...ids, model.id],
                  }) }}>{model.hiddenByUser ? <Eye size={16} /> : <EyeOff size={16} />}</Button>}
                <Button variant="ghost" title={`Salin ${model.id}`} aria-label={`Salin ID model: ${model.id}`} onClick={() => copyModelId(model)}
                  className={copied === model.id ? 'md-copy-done' : ''}>
                  {copied === model.id ? <Check size={16} /> : <Copy size={16} />}
                </Button>
                <Button variant="outline" disabled={!!disabledReason} title={disabledReason || `Uji ${model.name}; akan menghasilkan permintaan inferensi`}
                  aria-label={`Uji model: ${model.id}`} onClick={() => { void run('test', model) }}
                  className={operation === 'test' && test?.model.id === model.id ? 'md-testing' : ''}>
                  {operation === 'test' && test?.model.id === model.id ? <LoaderCircle size={14} className="spinning" /> : <Play size={14} />}Uji
                </Button>
              </div>
            </div>
          })}
        </div>
      </div>
    </div> : <div className="model-empty"><Boxes size={28} /><h2>{summary.catalog.length ? 'Tidak ada model yang cocok' : 'Daftar model kosong'}</h2>
      <p>{summary.catalog.length ? 'Ubah kata kunci atau hapus filter.' : 'Segarkan daftar lalu coba lagi, atau periksa koneksi kanal.'}</p>
      {filtered && <Button variant="outline" onClick={() => changeFilters(initialFilters)}><SlidersHorizontal size={15} />Hapus filter</Button>}
    </div>}
    <p className="footnote">Tercatat di daftar tidak berarti tersedia saat ini. Kumpulan gratis Kilo dapat merekam prompt; jangan kirim data sensitif.</p>
  </div>
}
