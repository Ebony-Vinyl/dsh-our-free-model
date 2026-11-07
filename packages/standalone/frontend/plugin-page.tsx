import { useEffect, useRef, useState } from 'react'
import { AlertCircle, Loader2, RefreshCw } from 'lucide-react'
import { Button } from './components/ui'
import type { PluginPage as PluginPageRecord } from './types'

interface ThemeMessage {
  __ofm: 1
  type: 'theme'
  theme: 'light' | 'dark'
  tokens: Record<string, string>
}

function themeMessage(): ThemeMessage {
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const read = (name: string, fallback: string) => {
    const value = root.getPropertyValue(name).trim()
    return value === '' ? fallback : value
  }
  return {
    __ofm: 1,
    type: 'theme',
    theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
    tokens: {
      '--ofm-bg': body.backgroundColor || read('--dsw-alias-bg-layer-1', '#ffffff'),
      '--ofm-panel': read('--dsw-alias-bg-layer-2', body.backgroundColor || '#ffffff'),
      '--ofm-text': body.color || read('--dsw-alias-label-primary', '#111827'),
      '--ofm-muted': read('--dsw-alias-label-secondary', '#6b7280'),
      '--ofm-accent': read('--accent', '#0d9488'),
      '--ofm-border': read('--dsw-alias-border-l1', 'rgba(0,0,0,.12)'),
      '--ofm-radius': '14px',
    },
  }
}

/**
 * One page plugin, rendered in a sandboxed iframe.
 *
 * `sandbox="allow-scripts"` gives the frame an opaque origin: it cannot reach
 * this document, its storage, or its cookies. Everything it asks for crosses
 * the postMessage bridge, and this parent validates the sender and forwards
 * only the allowlisted RPC methods to the management API.
 */
export function PluginPage({ page, onNotice }: { page: PluginPageRecord; onNotice?: (message: string) => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(640)
  const [state, setState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [generation, setGeneration] = useState(0)
  /* An iframe fires `load` even for the host's 404 body, so `onLoad` alone can
     never tell "loaded fine" from "the asset is gone" (a plugin uninstalled
     while its page was open). The page bridge announces `ready` on boot; if it
     never does, the frame shows the failure state instead of a spinner that
     runs forever. */
  const readyRef = useRef(false)

  const post = (message: unknown) => {
    frame.current?.contentWindow?.postMessage(message, '*')
  }

  const sendTheme = () => post(themeMessage())

  useEffect(() => {
    const target = frame.current
    if (target === null) return
    readyRef.current = false
    const deadline = window.setTimeout(() => { if (!readyRef.current) setState('failed') }, 10_000)
    const onMessage = async (event: MessageEvent) => {
      if (event.source !== target.contentWindow) return
      const data = event.data
      if (data === null || typeof data !== 'object' || data.__ofm !== 1) return
      if (data.type === 'ready') {
        readyRef.current = true
        window.clearTimeout(deadline)
        setState('ready')
        sendTheme()
        return
      }
      if (data.type === 'resize') {
        const next = Number(data.height)
        if (Number.isFinite(next) && next > 0) setHeight(Math.max(320, Math.min(2400, Math.round(next))))
        return
      }
      if (data.type === 'notify') {
        onNotice?.(String(data.message ?? '').slice(0, 200))
        return
      }
      if (data.type !== 'rpc') return
      const id = Number(data.id)
      const method = String(data.method ?? '')
      if (!Number.isInteger(id)) return
      try {
        const response = await fetch('/api/management/plugins/page-rpc', {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            pluginId: page.pluginId,
            pageId: page.pageId,
            method,
            params: data.params !== null && typeof data.params === 'object' ? data.params : {},
          }),
        })
        const value = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(String(value?.error ?? `页面请求失败（${response.status}）`))
        post({ __ofm: 1, type: 'rpc-reply', id, ok: true, result: value.result ?? null })
      } catch (reason) {
        post({ __ofm: 1, type: 'rpc-reply', id, ok: false, error: reason instanceof Error ? reason.message : '页面请求失败' })
      }
    }
    window.addEventListener('message', onMessage)
    const observer = new MutationObserver(() => sendTheme())
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => {
      window.clearTimeout(deadline)
      window.removeEventListener('message', onMessage)
      observer.disconnect()
    }
  }, [page.pluginId, page.pageId, generation])

  return <section className="plugin-page" data-testid="plugin-page">
    <header className="plugin-page-header">
      <div><span className="eyebrow">PLUGIN PAGE</span><h1>{page.title}</h1><p>{page.pluginId} · v{page.version}{page.description ? ` · ${page.description}` : ''}</p></div>
      <div className="plugin-actions">
        <Button variant="ghost" onClick={() => { setState('loading'); setGeneration(current => current + 1) }}><RefreshCw size={14} />重新加载</Button>
      </div>
    </header>
    {state === 'failed'
      ? <div className="plugin-page-fallback" role="alert"><AlertCircle size={18} /><div><strong>插件页面未能加载</strong><p>页面文件可能已被卸载或完整性校验失败。可以回到插件中心重新安装。</p></div></div>
      : <div className="plugin-page-frame">
        {state === 'loading' && <p className="plugin-page-loading" role="status"><Loader2 className="spin" size={16} />正在加载插件页面…</p>}
        <iframe
          key={`${page.id}:${generation}`}
          ref={frame}
          title={page.title}
          src={page.url}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          style={{ height: `${height}px` }}
          onLoad={() => sendTheme()}
          onError={() => setState('failed')}
        />
      </div>}
  </section>
}
