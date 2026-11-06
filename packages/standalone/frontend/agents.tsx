import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, ChevronDown, ChevronUp, CircleAlert, Clock3, FileJson, FolderSearch, KeyRound, Monitor, Play, Plus, RefreshCw, Save, Search, Square, Terminal, Trash2, Upload } from 'lucide-react'
import { Badge, Button, Input, Switch } from './components/ui'
import { WorkbenchDialog } from './components/workbench-dialog'
import { failureMessage, management, useManagementResource } from './management'
import { t, numLocale } from './i18n.mjs'
import type { Host, Summary } from './types'

interface Client {
  id: string; name: string; kind: 'cli' | 'desktop'; installed: boolean
  executable: string; cwd: string; model: string; mode: 'gateway' | 'native'
  running?: boolean; lastLaunchedAt?: number; error?: string; nativeOnly?: boolean
}
interface QuotaWindow {
  name: string; kind?: string; windowSeconds?: number; usedPercent?: number; remainingPercent?: number
  resetsAt?: number | string; limit?: number; remaining?: number
}
interface Account {
  id: string; provider: string; label: string; enabled: boolean; plan?: string; models: string[]
  quota?: { windows: QuotaWindow[]; fetchedAt?: number; checkedAt?: string; error?: string; state?: string; status?: string; plan?: string }
}
interface Workbench { clients: Client[]; accounts: Account[] }
interface Candidate { provider: string; label: string; available: boolean }
const splitModels = (text: string) => [...new Set(text.split(/[\n,]+/).map(value => value.trim()).filter(Boolean))]
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const dateLabel = (value?: number | string) => {
  if (value === undefined || value === '') return ''
  const date = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value)
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleString(numLocale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function ClientRow({ client, summary, onChanged }: { client: Client; summary: Summary; onChanged(): Promise<void> }) {
  const [expanded, setExpanded] = useState(false)
  const [executable, setExecutable] = useState(client.executable)
  const [cwd, setCwd] = useState(client.cwd)
  const [model, setModel] = useState(client.model)
  const [mode, setMode] = useState(client.mode)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => () => { live.current = false }, [])
  const availableModels = useMemo(() => summary.catalog.filter(row => row.routable && !row.hiddenByUser && !row.hiddenByGroup), [summary.catalog])
  const dirty = executable !== client.executable || cwd !== client.cwd || model !== client.model || mode !== client.mode
  const run = async (action: 'save' | 'launch' | 'stop') => {
    if (lock.current) return
    lock.current = true; setBusy(action); setError(''); setStatus('')
    try {
      if (action !== 'stop' && (dirty || action === 'save')) {
        if (!executable.trim()) throw new Error(t('ag.pathRequired'))
        await management('/workbench/clients/save', { id: client.id, executable: executable.trim(), cwd: cwd.trim(), model, mode })
      }
      if (action !== 'save') await management(`/workbench/clients/${action}`, { id: client.id })
      if (live.current) {
        setStatus(action === 'launch' ? t('ag.launchRequested') : action === 'stop' ? t('ag.stopped') : t('ag.saved'))
        await onChanged()
      }
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  return <div className="wb-client" data-running={client.running ? 'true' : undefined}>
    <div className="wb-client-row">
      <span className={`wb-app-icon ${client.kind === 'desktop' ? 'is-green' : ''}`}>{client.kind === 'desktop' ? <Monitor size={22} /> : <Terminal size={22} />}</span>
      <div className="wb-client-name"><strong>{client.name}</strong><small>{client.kind === 'desktop' ? t('ag.desktopApp') : t('ag.cliClient')}<span> · </span>{client.running ? t('ag.running') : client.installed ? t('ag.detected') : t('ag.notDetected')}</small></div>
      <label className="wb-model-select"><span className="wb-sr-only">{t.format('ag.modelFor', { name: client.name })}</span><select value={model} disabled={!!busy || client.running || client.nativeOnly} onChange={event => { setModel(event.target.value); setStatus('') }}>
        <option value="">{mode === 'gateway' ? t('ag.selectGatewayModel') : t('ag.defaultModel')}</option>
        {model && !availableModels.some(row => row.id === model) && <option value={model}>{t.format('ag.currentConfig', { model })}</option>}
        {availableModels.map(row => <option key={row.id} value={row.id}>{row.name || row.id}</option>)}
      </select></label>
      <Badge tone={client.running ? 'success' : 'neutral'} dot={!!client.running}>{client.running ? t('ag.running') : mode === 'gateway' ? t('ag.thirdPartyApi') : t('ag.nativeConfig')}</Badge>
      <div className="wb-client-actions">
        <Button variant="ghost" title={t.format('ag.launchSettings', { name: client.name })} aria-label={t.format('ag.launchSettings', { name: client.name })} aria-expanded={expanded} disabled={!!busy} onClick={() => setExpanded(!expanded)}>{expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</Button>
        {client.running ? <Button variant="outline" disabled={!!busy} busy={busy === 'stop'} onClick={() => void run('stop')}><Square size={13} />{t('ag.stop')}</Button>
          : <Button disabled={!!busy || !executable.trim() || (mode === 'gateway' && !model)} busy={busy === 'launch'} onClick={() => void run('launch')}><Play size={14} />{t('ag.start')}</Button>}
      </div>
    </div>
    {expanded && <form className="wb-client-settings" onSubmit={event => { event.preventDefault(); void run('save') }}>
      <label>{t('ag.executable')}<Input value={executable} disabled={!!busy || client.running} placeholder={t('ag.executablePlaceholder')} onChange={event => setExecutable(event.target.value)} /></label>
      <label>{t('ag.cwd')}<Input value={cwd} disabled={!!busy || client.running} placeholder={t('ag.cwdPlaceholder')} onChange={event => setCwd(event.target.value)} /></label>
      <label>{t('ag.accessMode')}<select value={mode} disabled={!!busy || client.running || client.nativeOnly} onChange={event => setMode(event.target.value as Client['mode'])}><option value="gateway">{t('ag.gatewayMode')}</option><option value="native">{t('ag.nativeMode')}</option></select></label>
      <Button type="submit" variant="outline" busy={busy === 'save'} disabled={!!busy || !dirty || !!client.running}><Save size={14} />{t('action.save')}</Button>
      {client.lastLaunchedAt && <small className="wb-client-last">{t.format('ag.lastLaunched', { time: dateLabel(client.lastLaunchedAt) })}</small>}
    </form>}
    {(error || client.error) && <p className="wb-row-feedback wb-error" role="alert"><CircleAlert size={14} />{error || client.error}</p>}
    {status && <p className="wb-row-feedback wb-status" role="status"><Check size={14} />{status}</p>}
  </div>
}

function QuotaMeter({ title, window }: { title: string; window?: QuotaWindow }) {
  const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
  const used = finite(window?.usedPercent) ? window.usedPercent
    : finite(window?.remainingPercent) ? 100 - window.remainingPercent
      : finite(window?.remaining) && finite(window?.limit) && window.limit > 0 ? 100 * (1 - window.remaining / window.limit) : undefined
  const clamped = used === undefined ? undefined : Math.min(100, Math.max(0, used))
  return <div className="wb-quota">
    <div><span>{title}</span><strong>{clamped === undefined ? t('action.unknown') : t.format('ag.usedPercent', { percent: Math.round(clamped) })}</strong></div>
    {clamped === undefined ? <div className="wb-quota-track is-unknown" aria-label={t.format('ag.quotaUnknownAria', { title })} />
      : <div className="wb-quota-track" role="progressbar" aria-label={t.format('ag.quotaUsedAria', { title })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(clamped)}><span className={clamped >= 90 ? 'is-low' : clamped >= 70 ? 'is-warn' : ''} style={{ width: `${clamped}%` }} /></div>}
    <small>{window?.resetsAt && dateLabel(window.resetsAt) ? t.format('ag.resetsAt', { time: dateLabel(window.resetsAt) }) : t('ag.resetUnknown')}</small>
  </div>
}

function ImportSubscription({ candidates, onClose, onSaved }: { candidates: Candidate[]; onClose(): void; onSaved(): Promise<void> }) {
  const [tab, setTab] = useState<'api' | 'json' | 'file'>('api')
  const [provider, setProvider] = useState('api')
  const [label, setLabel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [json, setJson] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [models, setModels] = useState('')
  const [format, setFormat] = useState('openai-chat')
  const [quotaOnly, setQuotaOnly] = useState(false)
  const [filename, setFilename] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fileValue = useRef<Record<string, unknown> | undefined>(undefined)
  const fileInput = useRef<HTMLInputElement>(null)
  const live = useRef(true)
  const fileSequence = useRef(0)
  useEffect(() => () => { live.current = false; fileSequence.current++; fileValue.current = undefined }, [])
  const clear = () => { setApiKey(''); setJson(''); setFilename(''); fileValue.current = undefined; if (fileInput.current) fileInput.current.value = '' }
  const chooseTab = (value: typeof tab) => { clear(); fileSequence.current++; setTab(value); setProvider(value === 'api' ? 'api' : 'codex'); setError('') }
  const readFile = async (file?: File) => {
    const sequence = ++fileSequence.current
    setError(''); setFilename(''); fileValue.current = undefined
    if (!file) return
    if (file.size > 768 * 1024) { setError(t('ag.fileTooBig')); return }
    try {
      const value: unknown = JSON.parse(await file.text())
      if (!object(value)) throw new Error()
      if (live.current && sequence === fileSequence.current) { fileValue.current = value; setFilename(file.name) }
    } catch { if (live.current && sequence === fileSequence.current) setError(t('ag.invalidJsonFile')) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    setError('')
    let credentials: Record<string, unknown>
    let payload: Record<string, unknown> = {}
    if (tab === 'api') {
      if (!apiKey.trim()) { setError(t('ag.apiKeyRequired')); return }
      credentials = { apiKey: apiKey.trim() }
    } else {
      let parsed: unknown
      try { parsed = tab === 'file' ? fileValue.current : JSON.parse(json) } catch { setError(t('ag.invalidJson')); return }
      if (!object(parsed)) { setError(tab === 'file' ? t('ag.pickFileFirst') : t('ag.credentialsObject')); return }
      credentials = object(parsed.credentials) ? parsed.credentials : parsed
      if (object(parsed.credentials)) {
        if (typeof parsed.provider === 'string') payload.provider = parsed.provider
        if (typeof parsed.label === 'string') payload.label = parsed.label
        if (typeof parsed.baseUrl === 'string') payload.baseUrl = parsed.baseUrl
        if (typeof parsed.format === 'string') payload.format = parsed.format
        if (Array.isArray(parsed.models) && parsed.models.every(value => typeof value === 'string')) payload.models = parsed.models
      }
    }
    if (!Object.keys(credentials).length) { setError(t('ag.emptyCredentials')); return }
    const actualProvider = typeof payload.provider === 'string' ? payload.provider : provider.trim()
    if (!['codex', 'claude', 'gemini', 'api'].includes(actualProvider)) { setError(t('ag.unsupportedProvider')); return }
    const actualUrl = actualProvider === 'api' ? baseUrl.trim() || (typeof payload.baseUrl === 'string' ? payload.baseUrl : '') : ''
    if (actualProvider === 'api' && !actualUrl) { setError(t('ag.apiUrlRequired')); return }
    if (actualUrl) {
      try { const url = new URL(actualUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error() }
      catch { setError(t('ag.invalidUrl')); return }
    }
    payload = {
      provider: actualProvider, ...(label.trim() ? { label: label.trim() } : {}),
      ...payload, ...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
      ...(models.trim() ? { models: splitModels(models) } : {}), credentials,
    }
    if (actualProvider === 'api') { payload.baseUrl = actualUrl; payload.format = payload.format ?? format }
    else { delete payload.baseUrl; delete payload.format }
    if (quotaOnly) payload.models = []
    else if (!Array.isArray(payload.models) || payload.models.length === 0) { setError(t('ag.modelIdRequired')); return }
    if (!payload.provider) { setError(t('ag.providerIdRequired')); return }
    setBusy(true)
    try {
      await management('/subscriptions/import', payload)
      if (!live.current) return
      clear(); await onSaved(); onClose()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { if (live.current) setBusy(false) }
  }
  return <WorkbenchDialog title={t('ag.importSub')} onClose={() => { clear(); onClose() }} busy={busy}>
    <form className="wb-form" onSubmit={event => void submit(event)}>
      <div className="wb-segments wb-import-tabs" aria-label={t('ag.importTabsAria')}>
        {([['api', 'API Key', KeyRound], ['json', t('ag.jsonCredentials'), FileJson], ['file', t('ag.jsonFile'), Upload]] as const).map(([id, name, Icon]) => <button key={id} type="button" aria-pressed={tab === id} disabled={busy} onClick={() => chooseTab(id)}><Icon size={14} />{name}</button>)}
      </div>
      <div className="wb-form-grid"><label>{t('ag.provider')}<select required value={provider} disabled={busy || tab === 'api'} onChange={event => setProvider(event.target.value)}><option value="api">{t('ag.apiOption')}</option><option value="codex">{t('ag.codexSub')}</option><option value="claude">{t('ag.claudeSub')}</option><option value="gemini">{t('ag.geminiSub')}</option></select></label>
        <label>{t('ag.accountName')}<Input value={label} disabled={busy} placeholder={t('ag.optional')} onChange={event => setLabel(event.target.value)} /></label></div>
      {tab === 'api' && <label>API Key<Input type="password" autoComplete="new-password" spellCheck={false} required value={apiKey} disabled={busy} onChange={event => setApiKey(event.target.value)} /></label>}
      {tab === 'json' && <label>{t('ag.credentialsJson')}<textarea rows={6} spellCheck={false} autoComplete="off" required value={json} disabled={busy} onChange={event => setJson(event.target.value)} /></label>}
      {tab === 'file' && <label className="wb-file"><Upload size={22} /><span>{filename || t('ag.pickJsonFile')}</span><input ref={fileInput} type="file" accept=".json,application/json" disabled={busy} aria-label={t('ag.chooseJsonFile')} onChange={event => void readFile(event.target.files?.[0])} /></label>}
      {provider === 'api' && <label>{t('ag.apiUrl')}<Input type="url" value={baseUrl} disabled={busy} placeholder="https://api.example.com/v1" onChange={event => setBaseUrl(event.target.value)} /></label>}
      <div className="wb-form-grid">{provider === 'api' && <label>{t('ag.protocol')}<select value={format} disabled={busy} onChange={event => setFormat(event.target.value)}><option value="openai-chat">OpenAI Chat</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label>}
        <label>{t('ag.modelIds')}<Input value={models} disabled={busy || quotaOnly} placeholder={t('ag.commaSeparated')} onChange={event => setModels(event.target.value)} /></label></div>
      <label className="wb-checkbox"><input type="checkbox" checked={quotaOnly} disabled={busy} onChange={event => setQuotaOnly(event.target.checked)} /><span>{t('ag.quotaOnlyOption')}</span></label>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      <div className="wb-form-actions"><Button variant="outline" disabled={busy} onClick={() => { clear(); onClose() }}>{t('action.cancel')}</Button><Button type="submit" busy={busy}><Upload size={15} />{t('ag.importSub')}</Button></div>
    </form>
  </WorkbenchDialog>
}

export function Agents({ summary, active, host }: { summary: Summary; active: boolean; host: Host }) {
  const workbench = useManagementResource<Workbench>('/workbench', active)
  const subscriptions = useManagementResource<{ accounts: Account[] }>('/subscriptions', active)
  const discovery = useManagementResource<{ candidates: Candidate[] }>('/subscriptions/discover', active)
  const [importing, setImporting] = useState(false)
  const [local, setLocal] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const [search, setSearch] = useState('')
  const [removing, setRemoving] = useState('')
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => () => { live.current = false }, [])
  const accounts = subscriptions.data?.accounts ?? workbench.data?.accounts ?? []
  const candidates = discovery.data?.candidates ?? []
  const refresh = async () => { await Promise.all([workbench.reload(), subscriptions.reload(), host.refresh()]) }
  const run = async (path: string, body: Record<string, unknown>, key: string) => {
    if (lock.current) return
    lock.current = true; setBusy(key); setError(''); setStatus('')
    try {
      await management(path, body)
      if (!live.current) return
      setStatus(path.endsWith('/quota') ? t('ag.quotaDone') : path.endsWith('/import-local') ? t('ag.localImported') : t('ag.settingsUpdated'))
      setRemoving(''); await subscriptions.reload()
      if (!path.endsWith('/quota')) await host.refresh()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  const rows = accounts.filter(account => `${account.label} ${account.provider} ${account.plan ?? ''}`.toLowerCase().includes(search.trim().toLowerCase()))
  return <div className="wb-page">
    <header className="wb-heading"><div><span className="wb-eyebrow">DESKTOP WORKBENCH</span><h1>{t('nav.agents')}</h1><p>{t('ag.sub')}</p></div>
      <Button variant="outline" title={t('ag.refresh')} aria-label={t('ag.refresh')} disabled={workbench.loading || subscriptions.loading || !!busy} busy={workbench.loading || subscriptions.loading} onClick={() => void refresh()}><RefreshCw size={15} /><span>{t('action.refresh')}</span></Button></header>
    <div className="wb-summary"><span><strong>{workbench.data ? workbench.data.clients.filter(client => client.installed).length : '—'}</strong> {t('ag.installedClients')}</span><span><i className="wb-dot" /><strong>{workbench.data ? workbench.data.clients.filter(client => client.running).length : '—'}</strong> {t('ag.running')}</span><span><strong>{subscriptions.data || workbench.data ? accounts.filter(account => account.enabled).length : '—'}</strong> {t('ag.enabledSubs')}</span></div>
    <div className="wb-section-heading"><h2><Monitor size={17} />{t('ag.clients')}</h2><Badge tone="blue">{t('ag.thirdPartyAccess')}</Badge></div>
    {workbench.error && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{workbench.error}</span><Button variant="outline" onClick={() => void workbench.reload()}>{t('action.retry')}</Button></div>}
    <section className="wb-client-list" aria-label={t('ag.clients')} aria-busy={workbench.loading}>
      {workbench.data?.clients.map(client => <ClientRow key={client.id} client={client} summary={summary} onChanged={workbench.reload} />)}
      {!workbench.data && workbench.loading && <div className="wb-empty" role="status"><RefreshCw size={22} /><strong>{t('ag.detecting')}</strong></div>}
      {workbench.data?.clients.length === 0 && <div className="wb-empty"><Terminal size={24} /><strong>{t('ag.noClients')}</strong><Button variant="outline" onClick={() => void workbench.reload()}>{t('ag.redetect')}</Button></div>}
    </section>
    <div className="wb-section-heading wb-subscription-heading"><h2><Clock3 size={17} />{t('ag.subsQuota')} <small>{accounts.length}</small></h2>
      <div><Button variant="outline" aria-expanded={local} onClick={() => setLocal(!local)}><FolderSearch size={15} />{t('ag.discoverLocal')}</Button><Button onClick={() => setImporting(true)}><Plus size={15} />{t('ag.importSub')}</Button></div></div>
    {local && <section className="wb-discovery" aria-label={t('ag.localSubs')}>
      <div className="wb-discovery-heading"><strong>{t('ag.localSubs')}</strong><Button variant="ghost" aria-label={t('ag.rediscover')} title={t('ag.rediscover')} disabled={discovery.loading || !!busy} busy={discovery.loading} onClick={() => void discovery.reload()}><RefreshCw size={15} /></Button></div>
      {discovery.error && <p role="alert" className="wb-error">{discovery.error}</p>}
      {candidates.map(candidate => <div className="wb-candidate" key={candidate.provider}><span><strong>{candidate.label}</strong><small>{candidate.provider}</small></span><Badge tone={candidate.available ? 'blue' : 'neutral'}>{candidate.available ? t('ag.importable') : t('ag.notFound')}</Badge><Button variant="outline" disabled={!candidate.available || !!busy} busy={busy === `local:${candidate.provider}`} onClick={() => void run('/subscriptions/import-local', { provider: candidate.provider }, `local:${candidate.provider}`)}><Upload size={14} />{t('ag.import')}</Button></div>)}
      {!discovery.loading && !candidates.length && !discovery.error && <p className="wb-discovery-empty">{t('ag.noLocalSubs')}</p>}
    </section>}
    <div className="wb-toolbar"><label className="wb-search"><Search size={16} /><Input aria-label={t('ag.searchSubs')} placeholder={t('ag.searchSubsPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} /></label><span className="wb-toolbar-meta">{t('ag.quotaWindows')}</span></div>
    {(error || subscriptions.error) && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error || subscriptions.error}</span><Button variant="outline" disabled={!!busy} onClick={() => { setError(''); void subscriptions.reload() }}>{t('action.retry')}</Button></div>}
    {status && <div className="wb-feedback wb-status" role="status"><Check size={16} />{status}</div>}
    <section className="wb-account-list" aria-label={t('ag.subAccounts')} aria-busy={subscriptions.loading}>
      {rows.map(account => {
        const windows = account.quota?.windows ?? []
        const fiveHour = windows.find(window => window.kind === 'five_hour' || window.windowSeconds === 18000 || /5\s*h|5.?hour|five.?hour|5.?小时|session|short/i.test(window.name))
        const weekly = windows.find(window => window.kind === 'weekly' || window.windowSeconds === 604800 || /week|seven.?day|7.?day|周|星期/i.test(window.name))
        const other = windows.filter(window => window !== fiveHour && window !== weekly)
        return <div className="wb-account" key={account.id}>
          <div className="wb-account-info"><span className="wb-app-icon is-green"><KeyRound size={20} /></span><div><strong>{account.label}</strong><small>{account.provider}{account.plan || account.quota?.plan ? ` · ${account.plan || account.quota?.plan}` : ''}</small><small>{t.format('ag.modelsCount', { n: account.models?.length ?? 0 })}</small></div>
            <Switch checked={account.enabled} aria-label={t.format('ag.enableSub', { name: account.label })} disabled={!!busy} onCheckedChange={enabled => void run('/subscriptions/enabled', { id: account.id, enabled }, `enable:${account.id}`)} /></div>
          <div className="wb-quota-windows"><QuotaMeter title={t('ag.fiveHours')} window={fiveHour} /><QuotaMeter title={t('ag.weekly')} window={weekly} />{other.map((window, index) => <QuotaMeter title={window.name} window={window} key={`${window.name}:${index}`} />)}</div>
          <div className="wb-account-actions"><Button variant="ghost" title={t.format('ag.refreshQuota', { name: account.label })} aria-label={t.format('ag.refreshQuota', { name: account.label })} disabled={!!busy} busy={busy === `quota:${account.id}`} onClick={() => void run('/subscriptions/quota', { id: account.id }, `quota:${account.id}`)}><RefreshCw size={15} /></Button>
            <Button variant="ghost" title={t.format('ag.removeSub', { name: account.label })} aria-label={t.format('ag.removeSub', { name: account.label })} className="wb-danger" disabled={!!busy} onClick={() => setRemoving(account.id)}><Trash2 size={15} /></Button></div>
          <div className="wb-account-foot"><Badge tone={account.enabled ? 'success' : 'neutral'}>{account.enabled ? t('action.enabled') : t('action.disabled')}</Badge>{!account.models?.length && <Badge>{t('ag.quotaOnly')}</Badge>}
            <span>{account.quota?.error ? t('ag.quotaUnavailable') : account.quota?.fetchedAt || account.quota?.checkedAt ? t.format('ag.updatedAt', { time: dateLabel(account.quota.fetchedAt ?? account.quota.checkedAt) }) : t('ag.quotaUnread')}{account.quota?.state ? ` · ${account.quota.state}` : ''}</span></div>
          {removing === account.id && <div className="wb-remove"><span>{t.format('ag.confirmRemoveSub', { name: account.label })}</span><Button variant="outline" disabled={!!busy} onClick={() => setRemoving('')}>{t('action.cancel')}</Button><Button variant="outline" className="wb-danger" disabled={!!busy} busy={busy === `remove:${account.id}`} onClick={() => void run('/subscriptions/remove', { id: account.id }, `remove:${account.id}`)}><Trash2 size={14} />{t('action.confirmRemove')}</Button></div>}
        </div>
      })}
      {!rows.length && <div className="wb-empty"><KeyRound size={24} /><strong>{search ? t('ag.noMatch') : subscriptions.loading ? t('ag.reading') : t('ag.none')}</strong>
        {search ? <Button variant="outline" onClick={() => setSearch('')}>{t('action.clearSearch')}</Button> : <Button variant="outline" onClick={() => setImporting(true)}><Plus size={14} />{t('ag.importSub')}</Button>}</div>}
    </section>
    {importing && active && <ImportSubscription candidates={candidates} onClose={() => setImporting(false)} onSaved={async () => { await Promise.all([subscriptions.reload(), host.refresh()]); if (live.current) setStatus(t('ag.imported')) }} />}
  </div>
}
