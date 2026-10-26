import { useMemo, useRef, useState, useEffect } from 'react'
import { ArrowRight, Cable, Check, CircleAlert, FlaskConical, ListRestart, RefreshCw, Save, Search, Settings2, Trash2 } from 'lucide-react'
import { Badge, Button, Input, Switch } from './components/ui'
import { WorkbenchDialog } from './components/workbench-dialog'
import { failureMessage, management, useManagementResource } from './management'
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
  try { const value = new URL(url); return value.host + value.pathname.replace(/\/$/, '') } catch { return url || '未设置 API 地址' }
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
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入不含用户名和密码的 HTTP(S) API 地址。')
        if (!key.trim() && !hasKey && provider.authKind !== 'none') throw new Error('请输入 API Key。')
        await management('/providers/save', {
          providerId: provider.id, ...(key.trim() ? { apiKey: key.trim() } : {}),
          baseUrl: url.toString(), models: modelList(models), enabled,
        })
        if (!live.current) return
        setHasKey(hasKey || !!key.trim()); setKey(''); setSaved(true); setDirty(false); setStatus('渠道配置已保存。')
      } else if (action === 'test') {
        const result = await management<{ ok?: boolean; success?: boolean; lastTest?: { ok?: boolean } }>('/providers/test', { providerId: provider.id })
        if (result.success === false || result.lastTest?.ok === false) throw new Error('连接测试未通过，请检查 API 地址、密钥与模型。')
        if (!live.current) return
        setStatus(result.ok === true || result.success === true || result.lastTest?.ok === true ? '连接测试通过。' : '测试请求已完成，服务未返回明确的通过状态。')
      } else if (action === 'discover') {
        const result = await management<{ models?: (string | { id: string })[]; configured?: Configuration; provider?: Configuration }>('/providers/discover', { providerId: provider.id })
        if (!live.current) return
        const discovered = result.models ?? result.configured?.models ?? result.provider?.models
        if (discovered) {
          setModels(discovered.map(row => typeof row === 'string' ? row : row.id).join('\n'))
          setDirty(true)
          setStatus(`已发现 ${discovered.length} 个模型，请保存模型配置。`)
        } else setStatus('模型发现请求已完成，服务未返回模型列表。')
      } else {
        await management('/providers/remove', { providerId: provider.id })
        if (!live.current) return
        setKey(''); await onSaved(); onClose(); return
      }
      await onSaved()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  return <WorkbenchDialog title={`${provider.name} · ${saved ? '渠道配置' : '连接渠道'}`} onClose={onClose} busy={!!busy}>
    <form className="wb-form" onSubmit={event => { event.preventDefault(); void run('save') }}>
      <div className="wb-form-meta"><Badge tone="blue">{provider.format}</Badge><Badge>{provider.category}</Badge><span>{provider.authKind}</span></div>
      <label>API 地址<Input required type="url" value={baseUrl} disabled={!!busy} onChange={event => change(() => setBaseUrl(event.target.value))} /></label>
      <label>API Key<Input type="password" autoComplete="new-password" spellCheck={false} value={key}
        placeholder={hasKey ? '已保存密钥；留空保留' : '输入 API Key'} disabled={!!busy}
        onChange={event => change(() => setKey(event.target.value))} /></label>
      <label>模型<textarea rows={5} spellCheck={false} value={models} placeholder="每行一个模型 ID" disabled={!!busy} onChange={event => change(() => setModels(event.target.value))} /></label>
      <div className="wb-form-switch"><span>启用渠道</span><Switch checked={enabled} disabled={!!busy} aria-label="启用渠道" onCheckedChange={value => change(() => setEnabled(value))} /></div>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      {status && <p className="wb-status" role="status"><Check size={15} />{status}</p>}
      <div className="wb-form-actions">
        <Button variant="outline" disabled={!!busy || !saved || dirty} onClick={() => void run('test')} busy={busy === 'test'}><FlaskConical size={15} />测试连接</Button>
        <Button variant="outline" disabled={!!busy || !saved || dirty} onClick={() => void run('discover')} busy={busy === 'discover'}><ListRestart size={15} />发现模型</Button>
        <Button type="submit" disabled={!!busy} busy={busy === 'save'}><Save size={15} />{saved ? '保存配置' : '保存并连接'}</Button>
      </div>
      {saved && <div className="wb-remove">
        {removing ? <><span>移除本机渠道配置？</span><Button variant="outline" disabled={!!busy} onClick={() => setRemoving(false)}>取消</Button><Button variant="outline" className="wb-danger" busy={busy === 'remove'} disabled={!!busy} onClick={() => void run('remove')}><Trash2 size={14} />确认移除</Button></>
          : <Button variant="ghost" className="wb-danger" disabled={!!busy} onClick={() => setRemoving(true)}><Trash2 size={14} />移除连接</Button>}
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
    <header className="wb-heading"><div><span className="wb-eyebrow">PROVIDERS</span><h1>聚合渠道</h1><p>第三方 API 与自有密钥</p></div>
      <Button variant="outline" title="刷新渠道目录" aria-label="刷新渠道目录" disabled={loading || !!selected} busy={loading} onClick={() => void reload()}><RefreshCw size={15} /><span>刷新</span></Button></header>
    <div className="wb-summary"><span><strong>{data ? registry.length : '—'}</strong> 全部渠道</span><span><i className="wb-dot" /><strong>{data ? totalConnected : '—'}</strong> 已连接</span><span><strong>{data ? registry.length - totalConnected : '—'}</strong> 未连接</span></div>
    <div className="wb-toolbar"><label className="wb-search"><Search size={16} /><Input aria-label="搜索聚合渠道" value={search} placeholder="搜索渠道、地址或协议" onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label="渠道分类" value={category} onChange={event => setCategory(event.target.value)}><option value="all">全部分类</option>{categories.map(value => <option key={value} value={value}>{value}</option>)}</select>
      <div className="wb-segments" aria-label="连接状态">{[['all', '全部'], ['connected', '已连接'], ['pending', '未连接']].map(([id, name]) => <button key={id} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)}>{name}</button>)}</div></div>
    {error && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error}</span><Button variant="outline" disabled={loading} onClick={() => void reload()}>重试</Button></div>}
    <div className="wb-list-caption"><span>{rows.length} 个渠道</span><span>协议 / 模型 / 连接状态</span></div>
    <div className="pd-list" aria-busy={loading}>
      {rows.map(provider => {
        const config = configured[provider.id], isConnected = connected(provider, config)
        return <div className="pd-row" key={provider.id}>
          <span className={`wb-app-icon ${isConnected ? 'is-green' : ''}`}><Cable size={21} /></span>
          <div className="pd-name"><strong>{provider.name}</strong><small title={config?.baseUrl || provider.baseUrl}>{endpoint(config?.baseUrl || provider.baseUrl)}</small></div>
          <div className="pd-protocol"><Badge>{provider.format}</Badge><small>{provider.category}</small></div>
          <span className="pd-model-count">{config?.models?.length ?? provider.modelCount ?? '未知'} <small>模型</small></span>
          <Badge tone={isConnected ? 'success' : 'neutral'} dot={isConnected}>{isConnected ? '已连接' : '未连接'}</Badge>
          <Button variant="outline" onClick={() => ['oauth', 'adc'].includes(provider.authKind) ? host.navigate('agents') : setSelected(provider)}>{isConnected || config ? <Settings2 size={14} /> : <ArrowRight size={14} />}{['oauth', 'adc'].includes(provider.authKind) ? '导入订阅' : isConnected || config ? '配置' : '连接'}</Button>
        </div>
      })}
      {!data && loading && <div className="wb-empty" role="status"><RefreshCw size={22} /><strong>正在读取渠道目录</strong></div>}
      {data && rows.length === 0 && <div className="wb-empty"><Search size={24} /><strong>{registry.length ? '没有匹配的渠道' : '渠道目录为空'}</strong>
        {registry.length > 0 && <Button variant="outline" onClick={() => { setSearch(''); setCategory('all'); setFilter('all') }}>清除筛选</Button>}</div>}
    </div>
    {selected && active && <ProviderEditor key={selected.id} provider={selected} configuration={configured[selected.id]} onClose={() => setSelected(undefined)} onSaved={async () => { await Promise.all([reload(), host.refresh()]) }} />}
  </div>
}
