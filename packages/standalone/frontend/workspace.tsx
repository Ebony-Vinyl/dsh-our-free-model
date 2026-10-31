import { useEffect, useRef, useState } from 'react'
import { Maximize2, Minimize2, RefreshCw, Settings2 } from 'lucide-react'
import { Button } from './components/ui'
import { management } from './management'
import { t } from './i18n.mjs'
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
        setError(reason instanceof Error ? reason.message : t('ws.startFailed'))
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
    } catch { setError(t('ws.refreshFailed')) }
  }

  const toolbar = (
    <header className="ws-toolbar">
      <div className="ws-title">
        <h2>{t('ws.title')}</h2>
        <p>{t('ws.sub')}</p>
      </div>
      <div className="ws-tools" role="group" aria-label={t('ws.toolsAria')}>
        <Button variant="ghost" size="icon"
          title={expanded ? t('ws.exitFullscreen') : t('ws.fullscreen')} aria-label={expanded ? t('ws.exitFullscreen') : t('ws.fullscreen')}
          onClick={() => setExpanded(value => !value)}>
          {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
        </Button>
        {state === 'ready' && <>
          <Button variant="ghost" size="icon" title={t('action.refresh')} aria-label={t('action.refresh')} onClick={() => void refresh()}><RefreshCw size={17} /></Button>
          <Button variant="ghost" size="icon" title={t('ws.settings')} aria-label={t('ws.settings')}
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
        ? <iframe ref={frame} className="ws-frame" title={t('ws.title')}
            src="/api/management/engine/ui/?mode=window&view=providers"
            allow="clipboard-write" referrerPolicy="same-origin"
            onLoad={syncTheme} />
        : <div className="ws-empty" role="status">
            <span>{state === 'starting' ? t('ws.starting') : t('ws.empty')}</span>
            {state === 'error' && <Button onClick={() => { started.current = false; setGeneration(n => n + 1) }}>{t('action.retry')}</Button>}
          </div>}
    </div>
  )

  return <section className={`ws-page ${expanded ? 'is-expanded' : ''}`}>{toolbar}{body}</section>
}
