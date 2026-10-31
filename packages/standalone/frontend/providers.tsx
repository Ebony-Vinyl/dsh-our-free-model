import { useMemo, useRef, useState, useEffect } from 'react'
import { ArrowRight, Cable, Check, CircleAlert, FlaskConical, ListRestart, RefreshCw, Save, Search, Settings2, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Switch } from './components/ui'
import { WorkbenchDialog } from './components/workbench-dialog'
import { failureMessage, management, useManagementResource } from './management'
import { t } from './i18n.mjs'
import type { Host } from './types'

interface Provider {
  id: string; name: string; category: string; format: string; authKind: string
  baseUrl: string; modelCount: number; models?: string[]
}
interface Configuration {
  enabled: boolean; hasKey: boolean; keyHint?: string; baseUrl: string; models: string[]
  lastTest?: { ok?: boolean; at?: number } | number
}
interface Directory { registry: Provider[]; configured: Record<string, Configuration> }
const connected = (provider: Provider, config?: Configuration) => !!config?.enabled && (config.hasKey || provider.authKind === 'none')
const modelList = (text: string) => [...new Set(text.split(/[\n,]+/).map(row => row.trim()).filter(Boolean))]
const endpoint = (url: string) => {
  try { const value = new URL(url); return value.host + value.pathname.replace(/\/$/, '') } catch { return url || t('pd.endpointUnset') }
}

function ProviderEditor({ provider, configuration, onClose, onSaved }: {
  provider: Provider; configuration?: Configuration; onClose(): void; onSaved(): Promise<void>
}) {
  const [key, setKey] = useState('')
  const [baseUrl, setBaseUrl] = useState(configuration?.baseUrl || provider.baseUrl)
  const [models, setModels] = useState((configuration?.models ?? provider.models ?? []).join('\n'))
  const [enabled, setEnabled] = useState(configuration?.enabled ?? true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [saved, setSaved] = useState(!!configuration)
  const [hasKey, setHasKey] = useState(!!configuration?.hasKey)
  const [dirty, setDirty] = useState(false)
  const [removing, setRemoving] = useState(false)
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => () => { live.current = false }, [])
  const change = (action: () => void) => { action(); setDirty(true); setStatus(''); setRemoving(false) }
  const run = async (action: string) => {
    if (lock.current) return
    lock.current = true
    setError(''); setStatus(''); setBusy(action)
    try {
      if (action === 'save') {
        const url = new URL(baseUrl.trim())
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error(t('ag.invalidUrl'))
        if (!key.trim() && !hasKey && provider.authKind !== 'none') throw new Error(t('ag.apiKeyRequired'))
        await management('/providers/save', {
          providerId: provider.id, ...(key.trim() ? { apiKey: key.trim() } : {}),
          baseUrl: url.toString(), models: modelList(models), enabled,
        })
        if (!live.current) return
        setHasKey(hasKey || !!key.trim()); setKey(''); setSaved(true); setDirty(false); setStatus(t('pd.saved'))
      } else if (action === 'test') {
        const result = await management<{ ok?: boolean; success?: boolean; lastTest?: { ok?: boolean } }>('/providers/test', { providerId: provider.id })
        if (result.success === false || result.lastTest?.ok === false) throw new Error(t('pd.testFailed'))
        if (!live.current) return
        setStatus(result.ok === true || result.success === true || result.lastTest?.ok === true ? t('pd.testPassed') : t('pd.testIndeterminate'))
      } else if (action === 'discover') {
        const result = await management<{ models?: (string | { id: string })[]; configured?: Configuration; provider?: Configuration }>('/providers/discover', { providerId: provider.id })
        if (!live.current) return
        const discovered = result.models ?? result.configured?.models ?? result.provider?.models
        if (discovered) {
          setModels(discovered.map(row => typeof row === 'string' ? row : row.id).join('\n'))
          setDirty(true)
          setStatus(t.format('pd.discovered', { n: discovered.length }))
        } else setStatus(t('pd.discoverEmpty'))
      } else {
        await management('/providers/remove', { providerId: provider.id })
        if (!live.current) return
        setKey(''); await onSaved(); onClose(); return
      }
      await onSaved()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  return <WorkbenchDialog title={t.format(saved ? 'pd.configTitle' : 'pd.connectTitle', { name: provider.name })} onClose={onClose} busy={!!busy}>
    <form className="wb-form" onSubmit={event => { event.preventDefault(); void run('save') }}>
      <div className="wb-form-meta"><Badge tone="blue">{provider.format}</Badge><Badge>{provider.category}</Badge><span>{provider.authKind}</span></div>
      <label>{t('pd.apiUrl')}<Input required type="url" value={baseUrl} disabled={!!busy} onChange={event => change(() => setBaseUrl(event.target.value))} /></label>
      <label>API Key<Input type="password" autoComplete="new-password" spellCheck={false} value={key}
        placeholder={hasKey ? t('pd.apiKeySaved') : t('pd.apiKeyPlaceholder')} disabled={!!busy}
        onChange={event => change(() => setKey(event.target.value))} /></label>
      <label>{t('pd.modelList')}<textarea rows={5} spellCheck={false} value={models} placeholder={t('pd.modelPlaceholder')} disabled={!!busy} onChange={event => change(() => setModels(event.target.value))} /></label>
      <div className="wb-form-switch"><span>{t('pd.enable')}</span><Switch checked={enabled} disabled={!!busy} aria-label={t('pd.enable')} onCheckedChange={value => change(() => setEnabled(value))} /></div>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      {status && <p className="wb-status" role="status"><Check size={15} />{status}</p>}
      <div className="wb-form-actions">
        <Button variant="outline" disabled={!!busy || !saved || dirty} onClick={() => void run('test')} busy={busy === 'test'}><FlaskConical size={15} />{t('pd.test')}</Button>
        <Button variant="outline" disabled={!!busy || !saved || dirty} onClick={() => void run('discover')} busy={busy === 'discover'}><ListRestart size={15} />{t('pd.discover')}</Button>
        <Button type="submit" disabled={!!busy} busy={busy === 'save'}><Save size={15} />{saved ? t('pd.saveConfig') : t('pd.saveAndConnect')}</Button>
      </div>
      {saved && <div className="wb-remove">
        {removing ? <><span>{t('pd.removeConfirm')}</span><Button variant="outline" disabled={!!busy} onClick={() => setRemoving(false)}>{t('action.cancel')}</Button><Button variant="outline" className="wb-danger" busy={busy === 'remove'} disabled={!!busy} onClick={() => void run('remove')}><Trash2 size={14} />{t('pd.confirmRemove')}</Button></>
          : <Button variant="ghost" className="wb-danger" disabled={!!busy} onClick={() => setRemoving(true)}><Trash2 size={14} />{t('pd.remove')}</Button>}
      </div>}
    </form>
  </WorkbenchDialog>
}

export function Providers({ active, host }: { active: boolean; host: Host }) {
  const { data, error, loading, reload } = useManagementResource<Directory>('/providers', active)
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [filter, setFilter] = useState('all')
  const [selected, setSelected] = useState<Provider>()
  const registry = data?.registry ?? []
  const configured = data?.configured ?? {}
  const categories = useMemo(() => [...new Set(registry.map(row => row.category))], [data])
  const totalConnected = registry.filter(row => connected(row, configured[row.id])).length
  const rows = registry.filter(row => {
    const isConnected = connected(row, configured[row.id])
    return `${row.name} ${row.id} ${row.baseUrl} ${row.category} ${row.format}`.toLowerCase().includes(search.toLowerCase().trim())
      && (category === 'all' || row.category === category)
      && (filter === 'all' || (filter === 'connected' ? isConnected : !isConnected))
  })
  return <div className="pd-page">
    <header className="wb-heading"><div><span className="wb-eyebrow">PROVIDERS</span><h1>{t('nav.providers')}</h1><p>{t('pd.sub')}</p></div>
      <Button variant="outline" title={t('pd.refresh')} aria-label={t('pd.refresh')} disabled={loading || !!selected} busy={loading} onClick={() => void reload()}><RefreshCw size={15} /><span>{t('action.refresh')}</span></Button></header>
    <div className="wb-summary"><span><strong>{data ? registry.length : '—'}</strong> {t('pd.all')}</span><span><i className="wb-dot" /><strong>{data ? totalConnected : '—'}</strong> {t('pd.connected')}</span><span><strong>{data ? registry.length - totalConnected : '—'}</strong> {t('pd.disconnected')}</span></div>
    <div className="wb-toolbar"><label className="wb-search"><Search size={16} /><Input aria-label={t('pd.search')} value={search} placeholder={t('pd.searchPlaceholder')} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label={t('pd.category')} value={category} onChange={event => setCategory(event.target.value)}><option value="all">{t('pd.allCategories')}</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <div className="wb-segments" aria-label={t('pd.status')}>{[['all', t('pd.allStatus')], ['connected', t('pd.connected')], ['pending', t('pd.disconnected')]].map(([id, name]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}</button>)}</div></div>
    {error && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="outline" disabled={loading} onClick={() => void reload()}>{t('action.retry')}</Button></div>}
    <div className="wb-list-caption"><span>{t.format('pd.count', { n: rows.length })}</span><span>{t('pd.columns')}</span></div>
    <div className="pd-list" aria-busy={loading}>
      {rows.map(provider => {
        const config = configured[provider.id], isConnected = connected(provider, config)
        return <div className="pd-row" key={provider.id}>
          <span className={`wb-app-icon ${isConnected ? 'is-green' : ''}`}><Cable size={21} /></span>
          <div className="pd-name"><strong>{provider.name}</strong><small title={config?.baseUrl || provider.baseUrl}>{endpoint(config?.baseUrl || provider.baseUrl)}</small></div>
          <div className="pd-protocol"><Badge>{provider.format}</Badge><small>{provider.category}</small></div>
          <span className="pd-model-count">{config?.models?.length ?? provider.modelCount ?? t('action.unknown')} <small>{t('pd.models')}</small></span>
          <Badge tone={isConnected ? 'success' : 'neutral'} dot={isConnected}>{isConnected ? t('pd.connected') : t('pd.disconnected')}</Badge>
          <Button variant="outline" onClick={() => ['oauth', 'adc'].includes(provider.authKind) ? host.navigate('agents') : setSelected(provider)}>{isConnected || config ? <Settings2 size={14} /> : <ArrowRight size={14} />}{['oauth', 'adc'].includes(provider.authKind) ? t('pd.importSub') : isConnected || config ? t('pd.configure') : t('pd.connect')}</Button>
        </div>
      })}
      {!data && loading && <div className="wb-empty" role="status"><RefreshCw size={22} /><strong>{t('pd.reading')}</strong></div>}
      {data && rows.length === 0 && <div className="wb-empty"><Search size={24} /><strong>{registry.length ? t('pd.noMatch') : t('pd.empty')}</strong>
        {registry.length > 0 && <Button variant="outline" onClick={() => { setSearch(''); setCategory('all'); setFilter('all') }}>{t('action.clearFilters')}</Button>}</div>}
    </div>
    {selected && active && <ProviderEditor key={selected.id} provider={selected} configuration={configured[selected.id]} onClose={() => setSelected(undefined)} onSaved={async () => { await Promise.all([reload(), host.refresh()]) }} />}
  </div>
}
