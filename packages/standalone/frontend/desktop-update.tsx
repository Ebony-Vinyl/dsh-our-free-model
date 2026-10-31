import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, CircleAlert, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card } from './components/ui'
import { management } from './management'
import { t, numLocale } from './i18n.mjs'
import './settings.css'
import './desktop-update.css'

interface UpdateStatus {
  currentVersion: string
  supported: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'error'
  latest: { version: string; notes: string; publishedAt: string | null; releaseURL: string; size: number } | null
  available: boolean
  checkedAt: number | null
  received: number
  total: number
  error: string
}
type NativeWindow = Window & { __TAURI__?: { core?: { invoke<T>(command: string): Promise<T> } } }
export const hasDesktopBridge = () => typeof window !== 'undefined' && typeof (window as NativeWindow).__TAURI__?.core?.invoke === 'function'
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`

export function DesktopUpdate() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [error, setError] = useState('')
  const [loadError, setLoadError] = useState('')
  const [installing, setInstalling] = useState(false)
  const [requesting, setRequesting] = useState(false)
  const live = useRef(true)
  const busyRef = useRef(false)
  const native = hasDesktopBridge()
  useEffect(() => {
    live.current = true
    if (!native) return () => { live.current = false }
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const value = await management<UpdateStatus>('/desktop-update')
        if (!live.current) return
        setStatus(value)
        setLoadError('')
        timer = setTimeout(() => { void poll() }, 1000)
      } catch (reason) { if (live.current) { setLoadError(reason instanceof Error ? reason.message : t('upd.loadFailed')); timer = setTimeout(() => { void poll() }, 5000) } }
    }
    void poll()
    return () => { live.current = false; clearTimeout(timer) }
  }, [native])
  const action = async (name: 'check' | 'download') => {
    if (busyRef.current) return
    busyRef.current = true; setRequesting(true); setError('')
    try { const value = await management<UpdateStatus>(`/desktop-update/${name}`, {}); if (live.current) setStatus(value) }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : t('upd.requestFailed')) }
    finally { busyRef.current = false; if (live.current) setRequesting(false) }
  }
  const install = async () => {
    if (busyRef.current || status?.phase !== 'ready') return
    busyRef.current = true; setInstalling(true); setError('')
    try { await (window as NativeWindow).__TAURI__!.core!.invoke('install_desktop_update') }
    catch (reason) { if (live.current) { setError(String(reason)); setInstalling(false); busyRef.current = false } }
  }
  const busy = requesting || installing || status?.phase === 'checking' || status?.phase === 'downloading'
  const percentage = status?.total ? Math.min(100, Math.round(status.received / status.total * 100)) : 0
  return <div className="settings-browser desktop-update-browser" data-testid="desktop-update-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">MANAGEMENT / UPDATES</div>
      <h1>{t('nav.updates')}</h1><p>{t('upd.sub')}</p></div>
      <Badge tone={status?.phase === 'ready' ? 'success' : 'neutral'}>{status?.phase === 'ready' ? t('upd.badgeReady') : t('upd.badgeDesktop')}</Badge></header>
    <Card className="settings-card"><div className="settings-card-heading"><RefreshCw size={16} /><div><h2>{t('upd.cardTitle')}</h2><p>{t('upd.cardSub')}</p></div></div>
      <div className="desktop-update-versions"><div><small>{t('upd.current')}</small><strong>{status?.currentVersion ? `v${status.currentVersion}` : '—'}</strong></div>
        <div><small>{t('upd.latest')}</small><strong>{status?.latest ? `v${status.latest.version}` : t('upd.notChecked')}</strong></div>
        <div><small>{t('upd.lastChecked')}</small><span>{status?.checkedAt ? new Date(status.checkedAt).toLocaleString(numLocale()) : t('upd.neverChecked')}</span></div></div>
      {!native ? <p className="settings-note"><CircleAlert size={15} />{t('upd.desktopOnly')}</p>
        : status && !status.supported ? <p className="settings-note"><CircleAlert size={15} />{t('upd.platformOnly')}</p>
          : <div className="desktop-update-actions"><Button variant="outline" busy={requesting || status?.phase === 'checking'} disabled={!!busy || !status} onClick={() => { void action('check') }}><RefreshCw size={15} />{t('upd.check')}</Button>
            {status?.available && status.phase !== 'ready' && <Button busy={status.phase === 'downloading'} disabled={!!busy} onClick={() => { void action('download') }}><ArrowDownToLine size={15} />{t('upd.download')}{status.latest ? ` · ${bytes(status.latest.size)}` : ''}</Button>}
            {status?.phase === 'ready' && <Button busy={installing} disabled={!!busy} onClick={() => { void install() }}><RotateCw size={15} />{t('upd.install')}</Button>}</div>}
      {status?.checkedAt && status.phase === 'idle' && !status.available && <p className="settings-note" role="status"><Check size={15} />{status.latest ? t('upd.upToDate') : t('upd.noRelease')}</p>}
      {status?.phase === 'downloading' && <div className="desktop-update-progress" role="status"><div><span>{t('upd.downloading')}</span><span>{percentage}% · {bytes(status.received)} / {bytes(status.total)}</span></div><progress aria-label={t('upd.progress')} max={100} value={percentage} /></div>}
      {status?.phase === 'ready' && <p className="settings-note" role="status"><ShieldCheck size={15} />{t('upd.ready')}</p>}
      {installing && <p className="settings-note" role="status"><RotateCw size={15} />{t('upd.preparing')}</p>}
      {(error || loadError || status?.error) && <p className="settings-save-error" role="alert"><CircleAlert size={15} /><span>{error || loadError || status?.error}</span></p>}
    </Card>
    {status?.latest && <Card className="settings-card"><div className="settings-card-heading"><ArrowDownToLine size={16} /><div><h2>{t.format('upd.notesTitle', { version: status.latest.version })}</h2><p>{status.latest.publishedAt ? new Date(status.latest.publishedAt).toLocaleDateString(numLocale()) : t('upd.notesDate')}</p></div></div>
      <div className="desktop-update-notes">{status.latest.notes || t('upd.notesEmpty')}</div></Card>}
  </div>
}
