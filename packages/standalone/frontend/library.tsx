import { useEffect, useRef, useState } from 'react'
import { Blocks, Check, ChevronDown, ChevronUp, CircleAlert, FileText, Layers3, Pencil, Play, Plus, RefreshCw, Save, Search, Terminal, Trash2, Users, WandSparkles } from 'lucide-react'
import { Badge, Button, Input, Switch } from './components/ui'
import { WorkbenchDialog } from './components/workbench-dialog'
import { failureMessage, management, useManagementResource } from './management'
import { t, numLocale } from './i18n.mjs'

type ResourceKind = 'mcp' | 'prompt' | 'skill' | 'agent'
interface Resource { id: string; kind: ResourceKind; name: string; content: string; enabled: boolean }
interface ProfileClient { id: string; mode: 'gateway' | 'native'; model: string; cwd: string; executable: string }
interface Profile { id: string; name: string; clients: ProfileClient[] }
interface LibraryData { profiles: Profile[]; resources: Resource[] }
const kinds = [
  { id: 'mcp', name: 'MCP', icon: Blocks },
  { id: 'prompt', name: t('lib.kindPrompt'), icon: FileText },
  { id: 'skill', name: t('lib.kindSkill'), icon: WandSparkles },
  { id: 'agent', name: 'Agent', icon: Users },
] as const
const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const validName = (value: string) => !!value && value.length <= 80 && !/[\x00-\x1f\x7f<>:"/\\|?*]/.test(value)
  && !value.endsWith('.') && !value.includes('..') && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value)

function validateMcp(content: string, name: string) {
  let value: unknown
  try { value = JSON.parse(content) } catch { throw new Error(t('lib.mcpInvalidJson')) }
  if (!isObject(value)) throw new Error(t('lib.mcpObject'))
  const wrapped = Object.hasOwn(value, 'mcpServers')
  if (wrapped && (Object.keys(value).length !== 1 || !isObject(value.mcpServers))) throw new Error(t('lib.mcpWrapped'))
  const servers = wrapped ? Object.entries(value.mcpServers as Record<string, unknown>) : [[name, value] as const]
  if (!servers.length || servers.length > 64) throw new Error(t('lib.mcpServersRange'))
  for (const [serverName, server] of servers) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(serverName) || !validName(serverName)) throw new Error(t('lib.mcpServerName'))
    if (!isObject(server)) throw new Error(t('lib.mcpServerObject'))
    if (Object.keys(server).some(key => !['type', 'command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'headers'].includes(key))) throw new Error(t('lib.mcpFields'))
    const stdio = Object.hasOwn(server, 'command')
    const remote = Object.hasOwn(server, 'url') || Object.hasOwn(server, 'httpUrl')
    if (stdio === remote || (Object.hasOwn(server, 'url') && Object.hasOwn(server, 'httpUrl'))) throw new Error(t('lib.mcpTransport'))
    if (stdio) {
      if (typeof server.command !== 'string' || !server.command.trim()) throw new Error(t('lib.mcpCommand'))
      if (server.type !== undefined && server.type !== 'stdio') throw new Error(t('lib.mcpStdioType'))
      if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string'))) throw new Error(t('lib.mcpArgs'))
      if (Object.hasOwn(server, 'headers')) throw new Error(t('lib.mcpHeadersHttp'))
    } else {
      if (['args', 'env', 'cwd'].some(key => Object.hasOwn(server, key))) throw new Error(t('lib.mcpHttpFields'))
      if (server.type !== undefined && !['http', 'streamable-http', 'sse'].includes(String(server.type))) throw new Error(t('lib.mcpHttpType'))
      try {
        const url = new URL(String(server.httpUrl ?? server.url))
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error()
      } catch { throw new Error(t('lib.mcpUrl')) }
    }
    for (const field of ['env', 'headers']) {
      if (server[field] !== undefined && (!isObject(server[field]) || Object.values(server[field]).some(item => typeof item !== 'string'))) throw new Error(t.format('lib.mcpMap', { field }))
    }
  }
}

function ResourceEditor({ resource, onClose, onSaved }: { resource?: Resource; onClose(): void; onSaved(): Promise<void> }) {
  const [kind, setKind] = useState<ResourceKind>(resource?.kind ?? 'mcp')
  const [name, setName] = useState(resource?.name ?? '')
  const [content, setContent] = useState(resource?.content ?? '')
  const [enabled, setEnabled] = useState(resource?.enabled ?? true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const submit = async () => {
    if (lock.current) return
    setError('')
    const trimmedName = name.trim()
    try {
      if (!validName(trimmedName)) throw new Error(t('lib.nameInvalid'))
      if (!content.trim()) throw new Error(t('lib.contentRequired'))
      if (new TextEncoder().encode(content).byteLength > 1024 * 1024) throw new Error(t('lib.contentTooBig'))
      if (kind === 'mcp') validateMcp(content, trimmedName)
      lock.current = true; setBusy(true)
      await management('/library/resources/save', { ...(resource ? { id: resource.id } : {}), kind, name: trimmedName, content, enabled })
      if (!live.current) return
      await onSaved()
      if (live.current) onClose()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  return <WorkbenchDialog title={resource ? t('lib.editTitle') : t('lib.newTitle')} busy={busy} onClose={onClose}>
    <form className="wb-form lib-editor" onSubmit={event => { event.preventDefault(); void submit() }}>
      <div className="wb-form-grid">
        <label>{t('lib.name')}<Input autoFocus required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label>{t('lib.type')}<select aria-label={t('lib.type')} value={kind} disabled={busy} onChange={event => setKind(event.target.value as ResourceKind)}>{kinds.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select></label>
      </div>
      <label>{kind === 'mcp' ? t('lib.mcpJson') : t('lib.markdown')}
        <textarea aria-label={kind === 'mcp' ? t('lib.mcpJson') : t('lib.markdown')} className="lib-content" rows={12} spellCheck={false} autoComplete="off" required value={content} disabled={busy}
          placeholder={kind === 'mcp' ? '{\n  "command": "npx",\n  "args": [],\n  "env": {}\n}' : ''} onChange={event => setContent(event.target.value)} /></label>
      <div className="wb-form-switch"><span>{t('lib.enable')}</span><Switch checked={enabled} disabled={busy} aria-label={t('lib.enable')} onCheckedChange={setEnabled} /></div>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      <div className="wb-form-actions"><Button variant="outline" disabled={busy} onClick={onClose}>{t('action.cancel')}</Button><Button type="submit" busy={busy}><Save size={15} />{t('lib.saveResource')}</Button></div>
    </form>
  </WorkbenchDialog>
}

function ProfileEditor({ onClose, onSaved }: { onClose(): void; onSaved(): Promise<void> }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const live = useRef(true)
  useEffect(() => () => { live.current = false }, [])
  const submit = async () => {
    if (lock.current) return
    setError('')
    if (!validName(name.trim())) { setError(t('lib.profileNameInvalid')); return }
    lock.current = true; setBusy(true)
    try {
      await management('/library/profiles/save', { name: name.trim() })
      if (!live.current) return
      await onSaved()
      if (live.current) onClose()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy(false) }
  }
  return <WorkbenchDialog title={t('lib.saveProfileTitle')} onClose={onClose} busy={busy}>
    <form className="wb-form" onSubmit={event => { event.preventDefault(); void submit() }}>
      <label>{t('lib.profileName')}<Input autoFocus required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      <div className="wb-form-actions"><Button variant="outline" disabled={busy} onClick={onClose}>{t('action.cancel')}</Button><Button type="submit" busy={busy}><Save size={15} />{t('lib.saveProfile')}</Button></div>
    </form>
  </WorkbenchDialog>
}

export function Library({ active }: { active: boolean }) {
  const { data, error: loadError, loading, reload } = useManagementResource<LibraryData>('/library', active)
  const [tab, setTab] = useState<'resources' | 'profiles'>('resources')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('all')
  const [editor, setEditor] = useState<Resource | 'new'>()
  const [profileEditor, setProfileEditor] = useState(false)
  const [expanded, setExpanded] = useState('')
  const [removing, setRemoving] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => () => { live.current = false }, [])
  const resources = data?.resources ?? [], profiles = data?.profiles ?? []
  const visibleResources = resources.filter(row => (kind === 'all' || row.kind === kind) && row.name.toLowerCase().includes(search.trim().toLowerCase()))
  const visibleProfiles = profiles.filter(row => row.name.toLowerCase().includes(search.trim().toLowerCase()))
  const blocked = !!busy || loading || !!editor || profileEditor
  const run = async (path: string, body: object, id: string, message: string) => {
    if (lock.current) return
    lock.current = true; setBusy(id); setError(''); setStatus('')
    try {
      const result = await management<{ ok?: boolean; clients?: ProfileClient[] }>(path, body)
      if (!live.current) return
      setStatus(path.endsWith('/apply')
        ? result.ok === true ? Array.isArray(result.clients) ? t.format('lib.appliedClients', { n: result.clients.length }) : t('lib.applied') : t('lib.applyIndeterminate')
        : message)
      setRemoving('')
      await reload()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  const selectTab = (next: typeof tab) => { setTab(next); setSearch(''); setRemoving(''); setError(''); setStatus('') }
  const saved = async (message: string) => { await reload(); if (live.current) { setStatus(message); setError('') } }
  return <div className="wb-page lib-page">
    <header className="wb-heading"><div><span className="wb-eyebrow">LIBRARY</span><h1>{t('nav.library')}</h1></div>
      <Button variant="outline" aria-label={t('lib.refresh')} title={t('lib.refresh')} busy={loading} disabled={blocked} onClick={() => void reload()}><RefreshCw size={15} />{t('action.refresh')}</Button></header>
    <div className="lib-tabs" role="tablist" aria-label={t('lib.tabsAria')}>
      {([['resources', t('lib.resources'), resources.length], ['profiles', t('lib.profiles'), profiles.length]] as const).map(([id, name, count]) =>
        <button key={id} type="button" role="tab" id={`lib-tab-${id}`} aria-controls={`lib-panel-${id}`} aria-selected={tab === id} tabIndex={tab === id ? 0 : -1}
          onClick={() => selectTab(id)} onKeyDown={event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const next = event.key === 'Home' ? 'resources' : event.key === 'End' ? 'profiles' : tab === 'resources' ? 'profiles' : 'resources'
            selectTab(next); document.getElementById(`lib-tab-${next}`)?.focus()
          }}>{name}<span>{data ? count : '—'}</span></button>)}
    </div>
    <div className="wb-toolbar lib-toolbar">
      <label className="wb-search"><Search size={16} /><Input aria-label={tab === 'resources' ? t('lib.searchResources') : t('lib.searchProfiles')} placeholder={tab === 'resources' ? t('lib.searchResourcesPlaceholder') : t('lib.searchProfilesPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {tab === 'resources' && <select aria-label={t('lib.resourceType')} value={kind} onChange={event => setKind(event.target.value)}><option value="all">{t('lib.allTypes')}</option>{kinds.map(row => <option value={row.id} key={row.id}>{row.name}</option>)}</select>}
      <Button className="lib-create" disabled={blocked || !data} onClick={() => { setError(''); setStatus(''); if (tab === 'resources') setEditor('new'); else setProfileEditor(true) }}>
        {tab === 'resources' ? <Plus size={15} /> : <Save size={15} />}{tab === 'resources' ? t('lib.newResource') : t('lib.saveCurrent')}</Button>
    </div>
    {(error || loadError) && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error || loadError}</span>{loadError && <Button variant="outline" disabled={blocked} onClick={() => void reload()}>{t('action.retry')}</Button>}</div>}
    {status && <div className="wb-feedback wb-status" role="status"><Check size={16} /><span>{status}</span></div>}
    <section className="lib-list" role="tabpanel" id={`lib-panel-${tab}`} aria-labelledby={`lib-tab-${tab}`} aria-busy={loading}>
      {tab === 'resources' ? visibleResources.map(resource => {
        const type = kinds.find(row => row.id === resource.kind)!
        return <div className="lib-resource" key={resource.id}>
          <div className="lib-resource-row">
            <span className={`wb-app-icon ${resource.kind === 'skill' || resource.kind === 'agent' ? 'is-green' : ''}`}><type.icon size={20} /></span>
            <div className="lib-name"><strong>{resource.name}</strong><small>{t.format('lib.bytes', { n: new TextEncoder().encode(resource.content).byteLength.toLocaleString(numLocale()) })}</small></div>
            <Badge>{type.name}</Badge><Switch checked={resource.enabled} disabled={blocked} aria-label={t.format('lib.enableResource', { name: resource.name })}
              onCheckedChange={enabled => void run('/library/resources/save', { ...resource, enabled }, resource.id, enabled ? t('lib.resourceEnabled') : t('lib.resourceDisabled'))} />
            <div className="lib-actions"><Button variant="ghost" aria-label={t.format('lib.editResourceAria', { name: resource.name })} title={t('lib.editResource')} disabled={blocked} onClick={() => setEditor(resource)}><Pencil size={15} /></Button>
              <Button variant="ghost" className="wb-danger" aria-label={t.format('lib.deleteResourceAria', { name: resource.name })} title={t('lib.deleteResource')} disabled={blocked} onClick={() => setRemoving(resource.id)}><Trash2 size={15} /></Button></div>
          </div>
          {removing === resource.id && <div className="wb-remove lib-confirm"><span>{t.format('lib.confirmDeleteResource', { name: resource.name })}</span><Button variant="outline" disabled={!!busy} onClick={() => setRemoving('')}>{t('action.cancel')}</Button>
            <Button variant="outline" className="wb-danger" busy={busy === resource.id} disabled={!!busy} onClick={() => void run('/library/resources/remove', { id: resource.id }, resource.id, t('lib.resourceDeleted'))}><Trash2 size={14} />{t('action.confirmDelete')}</Button></div>}
        </div>
      }) : visibleProfiles.map(profile => <div className="lib-profile" key={profile.id}>
        <div className="lib-profile-row"><span className="wb-app-icon is-green"><Layers3 size={20} /></span><div className="lib-name"><strong>{profile.name}</strong><small>{t.format('lib.clientsCount', { n: profile.clients.length })}</small></div>
          <div className="lib-actions"><Button variant="ghost" aria-label={t.format('lib.viewProfile', { name: profile.name })} title={t('lib.viewClients')} aria-expanded={expanded === profile.id} aria-controls={`lib-clients-${profile.id}`} onClick={() => setExpanded(expanded === profile.id ? '' : profile.id)}>{expanded === profile.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}</Button>
            <Button variant="outline" busy={busy === `apply:${profile.id}`} disabled={blocked} onClick={() => void run('/library/profiles/apply', { id: profile.id }, `apply:${profile.id}`, '')}><Play size={14} />{t('lib.apply')}</Button>
            <Button variant="ghost" className="wb-danger" aria-label={t.format('lib.deleteProfile', { name: profile.name })} title={t('lib.deleteProfile')} disabled={blocked} onClick={() => setRemoving(profile.id)}><Trash2 size={15} /></Button></div></div>
        {expanded === profile.id && <div className="lib-profile-clients" id={`lib-clients-${profile.id}`}>{profile.clients.map(client => <div className="lib-profile-client" key={client.id}>
          <Terminal size={15} /><strong>{client.id}</strong><Badge>{client.mode === 'gateway' ? t('lib.modeGateway') : t('lib.modeNative')}</Badge>
          <dl><div><dt>{t('lib.model')}</dt><dd>{client.model || t('lib.clientDefault')}</dd></div><div><dt>{t('lib.cwd')}</dt><dd>{client.cwd || t('lib.default')}</dd></div><div><dt>{t('lib.executable')}</dt><dd>{client.executable || t('lib.autoDetect')}</dd></div></dl>
        </div>)}</div>}
        {removing === profile.id && <div className="wb-remove lib-confirm"><span>{t.format('lib.confirmDeleteProfile', { name: profile.name })}</span><Button variant="outline" disabled={!!busy} onClick={() => setRemoving('')}>{t('action.cancel')}</Button>
          <Button variant="outline" className="wb-danger" busy={busy === profile.id} disabled={!!busy} onClick={() => void run('/library/profiles/remove', { id: profile.id }, profile.id, t('lib.profileDeleted'))}><Trash2 size={14} />{t('action.confirmDelete')}</Button></div>}
      </div>)}
      {!data && loading && <div className="wb-empty" role="status"><RefreshCw size={22} /><strong>{t('lib.reading')}</strong></div>}
      {data && !(tab === 'resources' ? visibleResources.length : visibleProfiles.length) && <div className="wb-empty"><Layers3 size={24} />
        <strong>{search || (tab === 'resources' && kind !== 'all') ? t('lib.noMatch') : tab === 'resources' ? t('lib.noResources') : t('lib.noProfiles')}</strong>
        {search || (tab === 'resources' && kind !== 'all') ? <Button variant="outline" onClick={() => { setSearch(''); setKind('all') }}>{t('action.clearFilters')}</Button>
          : <Button variant="outline" disabled={blocked} onClick={() => tab === 'resources' ? setEditor('new') : setProfileEditor(true)}><Plus size={15} />{tab === 'resources' ? t('lib.newResource') : t('lib.saveCurrent')}</Button>}</div>}
    </section>
    {editor && active && <ResourceEditor resource={editor === 'new' ? undefined : editor} onClose={() => setEditor(undefined)} onSaved={() => saved(t('lib.resourceSaved'))} />}
    {profileEditor && active && <ProfileEditor onClose={() => setProfileEditor(false)} onSaved={() => saved(t('lib.profileSaved'))} />}
  </div>
}
