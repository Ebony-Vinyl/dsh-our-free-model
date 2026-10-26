import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, Check, CircleAlert, RefreshCw, RotateCw, ShieldCheck } from 'lucide-react'
import { Badge, Button, Card } from './components/ui'
import { management } from './management'
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
      } catch (reason) { if (live.current) { setLoadError(reason instanceof Error ? reason.message : '无法读取更新状态'); timer = setTimeout(() => { void poll() }, 5000) } }
    }
    void poll()
    return () => { live.current = false; clearTimeout(timer) }
  }, [native])
  const action = async (name: 'check' | 'download') => {
    if (busyRef.current) return
    busyRef.current = true; setRequesting(true); setError('')
    try { const value = await management<UpdateStatus>(`/desktop-update/${name}`, {}); if (live.current) setStatus(value) }
    catch (reason) { if (live.current) setError(reason instanceof Error ? reason.message : '更新请求失败，请重试') }
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
      <h1>应用更新</h1><p>保持桌面客户端为最新版本，配置与账号保留。</p></div>
      <Badge tone={status?.phase === 'ready' ? 'success' : 'neutral'}>{status?.phase === 'ready' ? '已校验，待安装' : '桌面客户端'}</Badge></header>
    <Card className="settings-card"><div className="settings-card-heading"><RefreshCw size={16} /><div><h2>版本与更新</h2><p>检查本项目正式发布的桌面安装包。</p></div></div>
      <div className="desktop-update-versions"><div><small>当前版本</small><strong>{status?.currentVersion ? `v${status.currentVersion}` : '—'}</strong></div>
        <div><small>最新桌面版本</small><strong>{status?.latest ? `v${status.latest.version}` : '尚未检查'}</strong></div>
        <div><small>上次检查</small><span>{status?.checkedAt ? new Date(status.checkedAt).toLocaleString() : '从未检查'}</span></div></div>
      {!native ? <p className="settings-note"><CircleAlert size={15} />请在桌面客户端中打开此栏目，浏览器访问不支持安装应用更新。</p>
        : status && !status.supported ? <p className="settings-note"><CircleAlert size={15} />当前提供 Windows x64 桌面端内置更新，其他平台请使用对应安装包。</p>
          : <div className="desktop-update-actions"><Button variant="outline" busy={requesting || status?.phase === 'checking'} disabled={!!busy || !status} onClick={() => { void action('check') }}><RefreshCw size={15} />检查更新</Button>
            {status?.available && status.phase !== 'ready' && <Button busy={status.phase === 'downloading'} disabled={!!busy} onClick={() => { void action('download') }}><ArrowDownToLine size={15} />下载更新{status.latest ? ` · ${bytes(status.latest.size)}` : ''}</Button>}
            {status?.phase === 'ready' && <Button busy={installing} disabled={!!busy} onClick={() => { void install() }}><RotateCw size={15} />退出并安装</Button>}</div>}
      {status?.checkedAt && status.phase === 'idle' && !status.available && <p className="settings-note" role="status"><Check size={15} />{status.latest ? '当前已是最新桌面版本' : '暂未找到适配此设备的正式桌面安装包'}</p>}
      {status?.phase === 'downloading' && <div className="desktop-update-progress" role="status"><div><span>正在下载更新</span><span>{percentage}% · {bytes(status.received)} / {bytes(status.total)}</span></div><progress aria-label="更新下载进度" max={100} value={percentage} /></div>}
      {status?.phase === 'ready' && <p className="settings-note" role="status"><ShieldCheck size={15} />安装包校验通过。点击安装后会退出客户端，完成覆盖安装后自动重新打开。</p>}
      {installing && <p className="settings-note" role="status"><RotateCw size={15} />正在准备安装，请等待客户端退出并重新打开。</p>}
      {(error || loadError || status?.error) && <p className="settings-save-error" role="alert"><CircleAlert size={15} /><span>{error || loadError || status?.error}</span></p>}
    </Card>
    {status?.latest && <Card className="settings-card"><div className="settings-card-heading"><ArrowDownToLine size={16} /><div><h2>更新说明 · v{status.latest.version}</h2><p>{status.latest.publishedAt ? new Date(status.latest.publishedAt).toLocaleDateString() : '正式发布'}</p></div></div>
      <div className="desktop-update-notes">{status.latest.notes || '此版本未附更新说明。'}</div></Card>}
  </div>
}
