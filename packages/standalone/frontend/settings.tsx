import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, Check, LoaderCircle, RotateCcw, Save, Settings2, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { settingsDraft, settingsChanged, syncSettings, validateSettingsDraft } from './settings-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Summary } from './types'
import './settings.css'

type Draft = ReturnType<typeof settingsDraft>
type NumberField = 'defaultMaxTokens' | 'probeIntervalMinutes'
const connectionError = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? 'Waktu permintaan simpan habis; hasilnya belum dapat dipastikan. Coba lagi atau periksa status layanan.'
    : reason instanceof TypeError && /fetch/i.test(reason.message) ? 'Tidak dapat terhubung ke layanan lokal. Perubahan Anda tetap tersimpan di formulir; pastikan layanan berjalan lalu coba lagi.'
    : reason.message : 'Gagal menyimpan. Perubahan Anda tetap tersimpan di formulir; coba lagi.'

export function Settings({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [state, setState] = useState(() => ({ saved: summary.settings, draft: settingsDraft(summary.settings) }))
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<NumberField, string>>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  const generation = useRef(0)
  activeRef.current = active
  useEffect(() => () => { mounted.current = false; generation.current++ }, [])
  useEffect(() => {
    if (!active) { generation.current++; setMessage(''); setError('') }
  }, [active])
  useEffect(() => {
    setState(previous => syncSettings(previous, summary.settings, savingRef.current))
  }, [summary.settings])
  const dirty = settingsChanged(state.draft, state.saved)
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
    setMessage(''); setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current || !activeRef.current) return
    const validation = validateSettingsDraft(state.draft)
    setErrors(validation.errors); setMessage(''); setError('')
    if (!validation.patch) return
    const started = ++generation.current
    const feedbackCurrent = () => mounted.current && activeRef.current && started === generation.current
    savingRef.current = true
    setSaving(true)
    try {
      const saved = await host.saveSettings(validation.patch)
      if (!mounted.current) return
      setState({ saved, draft: settingsDraft(saved) })
      if (feedbackCurrent()) setMessage('Pengaturan tersimpan dan berlaku')
      // Hasil simpan sudah dikonfirmasi; kegagalan pembacaan berikutnya tidak boleh dilaporkan sebagai gagal simpan.
      try { await host.refresh() } catch {
        if (feedbackCurrent()) setMessage('Pengaturan tersimpan; status gagal dimuat ulang dan akan dicoba lagi nanti.')
      }
    } catch (reason) {
      if (feedbackCurrent()) setError(connectionError(reason))
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const toggle = (name: 'enabled' | 'exposeRegionModels' | 'streamRecovery' | 'standaloneProbe' | 'hideFreeModels' | 'hideEacModels', label: string, help: string) =>
    <label className="settings-field" key={name}>
      <span><strong>{label}</strong><small>{help}</small></span>
      <input type="checkbox" role="switch" name={name} className="settings-toggle"
        checked={state.draft[name]} onChange={event => update(name, event.target.checked)} />
    </label>
  const numeric = (name: NumberField, label: string, help: string, min: number, max: number) =>
    <div className="settings-field settings-number-field">
      <label htmlFor={`setting-${name}`}><strong>{label}</strong><small>{help}</small></label>
      <div className="settings-number"><Input id={`setting-${name}`} name={name} type="number" min={min} max={max} step={1}
        value={state.draft[name]} onChange={event => update(name, event.target.value)}
        aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `setting-error-${name}` : undefined} />
        {errors[name] ? <p id={`setting-error-${name}`} className="settings-field-error" role="alert"><CircleAlert size={12} />{errors[name]}</p>
          : <span className="settings-hint">{min}–{max}</span>}
      </div>
    </div>
  if (!active) return null
  const statusClass = saving ? 'settings-status-saving' : dirty ? 'settings-status-dirty' : message ? 'settings-status-saved' : ''
  return <div className="settings-browser" data-testid="settings-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">MANAGEMENT / SETTINGS</div>
      <h1>Pengaturan layanan</h1><p>Sesuaikan inferensi dan penyegaran model di perangkat ini; berlaku setelah disimpan.</p></div>
      <Badge tone={summary.settings.enabled ? 'success' : 'warning'}>{summary.settings.enabled ? 'Inferensi aktif' : 'Inferensi dijeda'}</Badge>
    </header>
    <form onSubmit={event => { void submit(event) }} noValidate>
      <fieldset disabled={saving} className="settings-fieldset">
        <Card className="settings-card"><div className="settings-card-heading"><Settings2 size={16} /><div><h2>Inferensi dan model</h2><p>Kendalikan pemanggilan klien dan tampilan model.</p></div></div>
          {toggle('enabled', 'Aktifkan layanan inferensi', 'Jika dimatikan, inferensi API dijeda tetapi halaman manajemen tetap dapat diakses.')}
          {toggle('exposeRegionModels', 'Tampilkan model yang dibatasi wilayah', 'Tetap tampilkan model yang dibatasi wilayah keluar saat ini agar dapat dipilih klien.')}
          {toggle('hideFreeModels', visibility.hideFree, 'Hanya disembunyikan dari pemilih dan daftar model API; riwayat pemanggilan model tetap disimpan.')}
          {toggle('hideEacModels', visibility.hideEac, 'Izin dan riwayat pemanggilan model tetap disimpan dan dapat ditampilkan kembali kapan saja.')}
          {toggle('streamRecovery', 'Pulihkan aliran otomatis', 'Izinkan jawaban dilanjutkan dari titik pemeriksaan yang sudah dihasilkan.')}
          {numeric('defaultMaxTokens', 'Token keluaran maksimum per permintaan', '512–131072; keluaran aktual tetap dibatasi kemampuan model.', 512, 131072)}
        </Card>
        <Card className="settings-card"><div className="settings-card-heading"><RefreshCw size={16} /><div><h2>Penyegaran model</h2><p>Atur pembaruan dan deteksi berkala daftar model.</p></div></div>
          {numeric('probeIntervalMinutes', 'Interval penyegaran (menit)', '1–1440 menit; putaran berikutnya dijadwalkan ulang setelah disimpan.', 1, 1440)}
          {toggle('standaloneProbe', 'Deteksi ketersediaan otomatis', 'Mengirim permintaan deteksi saat penyegaran berkala dan memakai kuota upstream; otomatis mundur saat terkena pembatasan laju.')}
          <p className="settings-note" role="note"><CircleAlert size={15} /><span>{summary.automaticRefresh
            ? 'Penyegaran otomatis aktif; putaran berikutnya dijadwalkan ulang setelah interval disimpan.'
            : 'Saat ini dijalankan dengan --no-refresh. Pengaturan tetap disimpan, tetapi tugas otomatis tetap dijeda; penyegaran manual masih tersedia.'}</span></p>
        </Card>
        <div className="settings-footer"><span role="status" aria-live="polite" className={statusClass}><span className="settings-status-dot" aria-hidden="true" />{saving ? 'Menyimpan, mohon tunggu…' : dirty ? 'Ada perubahan yang belum disimpan' : message || 'Pengaturan saat ini sudah sinkron'}</span>
          <div className="settings-actions"><Button variant="outline" disabled={!dirty || saving} onClick={() => {
            setState(previous => ({ ...previous, draft: settingsDraft(previous.saved) }))
            setErrors({}); setError(''); setMessage('')
          }}><RotateCcw size={15} />Batalkan perubahan</Button>
            <Button type="submit" disabled={!dirty || saving}>{saving ? <LoaderCircle size={15} className="spinning" /> : message && !dirty ? <Check size={15} /> : <Save size={15} />}{saving ? 'Menyimpan' : 'Simpan pengaturan'}</Button></div>
        </div>
      </fieldset>
      {error && <p className="settings-save-error" role="alert"><CircleAlert size={16} /><span>{error}</span></p>}
    </form>
    <p className="footnote">Konfigurasi disimpan di direktori data layanan mandiri ini. Membaca dan menyimpan pengaturan di halaman ini tidak langsung mengirim permintaan inferensi model.</p>
  </div>
}
