import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, RefreshCw, Settings2 } from 'lucide-react'
import { Button } from './components/ui'
import { management } from './management'
import './workspace.css'

/**
 * The model workspace: the same embedded engine the plugin's settings page runs,
 * mounted here at `/api/management/engine/ui/`.
 *
 * The engine serves its own page, so this component owns three things only —
 * starting it, telling it which theme the console is using, and telling the
 * catalog when the page changed something. Everything inside the frame is the
 * engine's own UI.
 */
export function Workspace({ active }: { active: boolean }) {
  const [state, setState] = useState<'starting' | 'ready' | 'error'>('starting')
  const [error, setError] = useState('')
  const [generation, setGeneration] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const frame = useRef<HTMLIFrameElement>(null)
  const host = useRef<HTMLDivElement>(null)
  const started = useRef(false)

  const syncTheme = () => {
    const style = window.getComputedStyle(document.documentElement)
    const variables: Record<string, string> = {}
    for (const token of ['label-primary', 'label-secondary', 'label-tertiary', 'label-on-accent',
      'bg-layer-1', 'bg-layer-2', 'bg-layer-3', 'border-l1', 'border-l2',
      'state-business-primary', 'state-success-primary', 'state-error-primary', 'state-warning-primary']) {
      const value = style.getPropertyValue(`--dsw-alias-${token}`).trim()
      if (value) variables[`--dsw-alias-${token}`] = value
    }
    frame.current?.contentWindow?.postMessage({
      type: 'ofm:engine-theme', variables,
      fontFamily: style.fontFamily,
      colorScheme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
      externalControls: true,
    }, window.location.origin)
  }

  useEffect(() => {
    if (!active || state !== 'ready') return
    const observer = new MutationObserver(syncTheme)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] })
    return () => observer.disconnect()
  }, [active, state])

  useEffect(() => {
    if (!active || started.current) return
    started.current = true
    let alive = true
    setState('starting'); setError('')
    management('/engine/start', {}, undefined)
      .then(() => { if (alive) setState('ready') })
      .catch(reason => {
        if (!alive) return
        setState('error')
        setError(reason instanceof Error ? reason.message : '模型工作台启动失败')
      })
    return () => { alive = false }
  }, [active, generation])

  useEffect(() => {
    const changed = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type !== 'ofm:engine-changed') return
      void management('/engine/refresh', {}).catch(() => {})
    }
    window.addEventListener('message', changed)
    return () => window.removeEventListener('message', changed)
  }, [])

  useEffect(() => {
    if (!expanded) return
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', escape)
    const previous = document.activeElement as HTMLElement | null
    return () => {
      window.removeEventListener('keydown', escape)
      if (previous?.isConnected) previous.focus?.()
    }
  }, [expanded])

  const refresh = async () => {
    try {
      await management('/engine/refresh', {})
      frame.current?.contentWindow?.postMessage({ type: 'ofm:engine-action', action: 'refresh' }, window.location.origin)
    } catch { setError('刷新失败，请重试') }
  }

  const toolbar = (
    <header className="ws-toolbar">
      <div className="ws-title">
        <h2>模型工作台</h2>
        <p>在应用内管理渠道、账号与模型；改动会同步进模型清单。</p>
      </div>
      <div className="ws-tools" role="group" aria-label="模型工作台操作">
        <Button variant="ghost" size="icon"
          title={expanded ? '退出全屏' : '全屏'} aria-label={expanded ? '退出全屏' : '全屏'}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </Button>
        {state === 'ready' && <>
          <Button variant="ghost" size="icon" title="刷新" aria-label="刷新" onClick={() => void refresh()}><RefreshCw size={17} /></Button>
          <Button variant="ghost" size="icon" title="工作台设置" aria-label="工作台设置"
            onClick={() => frame.current?.contentWindow?.postMessage({ type: 'ofm:engine-action', action: 'settings' }, window.location.origin)}>
            <Settings2 size={17} />
          </Button>
        </>}
      </div>
    </header>
  )

  const body = (
    <div className={`ws-body ${expanded ? 'is-expanded' : ''}`} ref={host}>
      {error && <div className="ws-error" role="alert">{error}</div>}
      {state === 'ready'
        ? <iframe ref={frame} className="ws-frame" title="模型工作台"
            src="/api/management/engine/ui/?mode=window&view=providers"
            allow="clipboard-write" referrerPolicy="same-origin"
            onLoad={syncTheme} />
        : <div className="ws-empty" role="status">
            <span>{state === 'starting' ? '正在启动模型工作台…' : '模型工作台未能启动'}</span>
            {state === 'error' && <Button onClick={() => { started.current = false; setGeneration(n => n + 1) }}>重试</Button>}
          </div>}
    </div>
  )

  return <section className={`ws-page ${expanded ? 'is-expanded' : ''}`}>{toolbar}{body}</section>
}
