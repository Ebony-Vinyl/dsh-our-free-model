import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Check, CircleAlert, Eye, Layers3, Pencil, Plus, RefreshCw, Route, Save, Search, Trash2, X } from 'lucide-react'
import { Badge, Button, Input, Switch } from './components/ui'
import { WorkbenchDialog } from './components/workbench-dialog'
import { failureMessage, management, useManagementResource } from './management'
import { t, numLocale } from './i18n.mjs'
import type { Host } from './types'
import './routing.css'

type Strategy = 'fallback' | 'round-robin' | 'smart' | 'usage' | 'pace'
interface Combo { id: string; name: string; models: string[]; strategy: Strategy; stickyLimit: number; enabled: boolean }
interface RoutingModel { id: string; name: string; channel: string }
interface RoutingData { combos: Combo[]; models: RoutingModel[]; strategies: string[] }
interface Preview {
  capacity: { contextWindow?: number | null; maxOutput?: number | null; vision?: boolean | null; reasoning?: boolean | null } | null
  order: { id: string; name: string; reason?: string }[]
}
const STRATEGIES = new Set<string>(['fallback', 'round-robin', 'smart', 'usage', 'pace'])
const strategyName = (value: string) => STRATEGIES.has(value) ? t(`rt.strategy.${value}`) : value
const strategyDetail = (value: string) => STRATEGIES.has(value) ? t(`rt.strategy.${value}Detail`) : t('rt.strategyNote')
const capacityNumber = (value?: number | null) => typeof value === 'number' && Number.isFinite(value) && value > 0
  ? value.toLocaleString(numLocale()) : t('rt.notAvailable')
const capability = (value?: boolean | null) => value === true ? t('rt.supported') : value === false ? t('rt.unsupported') : t('rt.notAvailable')

function createsCycle(id: string, current: string | undefined, combos: Combo[]): boolean {
  if (!current) return false
  const byId = new Map(combos.map(combo => [combo.id, combo]))
  const visited = new Set<string>()
  const visit = (candidate: string): boolean => {
    if (candidate === current) return true
    if (visited.has(candidate)) return false
    visited.add(candidate)
    return byId.get(candidate)?.models.some(visit) ?? false
  }
  return visit(id)
}

function RoutingEditor({ combo, data, onClose, onSaved }: {
  combo?: Combo; data: RoutingData; onClose(): void; onSaved(): Promise<void>
}) {
  const [name, setName] = useState(combo?.name ?? '')
  const [models, setModels] = useState<string[]>(combo?.models ?? [])
  const [strategy, setStrategy] = useState(combo?.strategy ?? (data.strategies.includes('fallback') ? 'fallback' : data.strategies[0] ?? 'fallback'))
  const [stickyLimit, setStickyLimit] = useState(String(combo?.stickyLimit ?? 1))
  const [enabled, setEnabled] = useState(combo?.enabled ?? true)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('all')
  const [saving, setSaving] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const [preview, setPreview] = useState<Preview>()
  const [error, setError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const live = useRef(true)
  const saveLock = useRef(false)
  const previewRequest = useRef<AbortController | undefined>(undefined)
  const choices = useMemo(() => {
    const rows = new Map(data.models.map(model => [model.id, model]))
    for (const group of data.combos) rows.set(group.id, { id: group.id, name: group.name, channel: 'combo' })
    return [...rows.values()]
  }, [data])
  const byId = useMemo(() => new Map(choices.map(model => [model.id, model])), [choices])
  const groupIds = useMemo(() => new Set(data.combos.map(group => group.id)), [data.combos])
  const allowedStrategies = [...new Set(data.strategies)]
  const invalidModels = models.filter(id => !byId.has(id) || createsCycle(id, combo?.id, data.combos))
  const available = choices.filter(model => !models.includes(model.id)
    && (kind === 'all' || (kind === 'groups' ? groupIds.has(model.id) : !groupIds.has(model.id)))
    && `${model.id} ${model.name} ${model.channel}`.toLowerCase().includes(query.trim().toLowerCase()))
  useEffect(() => {
    live.current = true
    return () => { live.current = false; previewRequest.current?.abort() }
  }, [])
  useEffect(() => {
    previewRequest.current?.abort()
    setPreview(undefined); setPreviewError(''); setPreviewing(false)
  }, [models, strategy])
  const validate = () => {
    if (!models.length || models.length > 100) throw new Error(t('rt.membersRange'))
    if (new Set(models).size !== models.length) throw new Error(t('rt.duplicate'))
    if (invalidModels.length) throw new Error(t('rt.invalidMembers'))
    if (!allowedStrategies.includes(strategy)) throw new Error(t('rt.strategyUnavailable'))
  }
  const editModels = (next: string[]) => { previewRequest.current?.abort(); setPreview(undefined); setModels(next); setError('') }
  const move = (index: number, direction: number) => {
    const target = index + direction
    if (target < 0 || target >= models.length) return
    const next = [...models]
    const previous = next[index]
    next[index] = next[target]
    next[target] = previous
    editModels(next)
  }
  const loadPreview = async () => {
    if (saving || previewing) return
    setPreviewError(''); setPreview(undefined)
    try { validate() } catch (reason) { setPreviewError(failureMessage(reason)); return }
    previewRequest.current?.abort()
    const request = new AbortController()
    previewRequest.current = request
    setPreviewing(true)
    try {
      const value = await management<Preview>('/routing/preview', { models, strategy }, request.signal)
      if (live.current && !request.signal.aborted) setPreview(value)
    } catch (reason) { if (live.current && !request.signal.aborted) setPreviewError(failureMessage(reason)) }
    finally { if (live.current && !request.signal.aborted) setPreviewing(false) }
  }
  const save = async () => {
    if (saveLock.current) return
    setError('')
    try {
      if (!name.trim() || name.length > 120 || /[\0\r\n]/.test(name)) throw new Error(t('rt.nameInvalid'))
      validate()
      const limit = Number(stickyLimit)
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error(t('rt.stickyInvalid'))
      saveLock.current = true; setSaving(true)
      previewRequest.current?.abort(); setPreviewing(false)
      await management('/routing/save', { combo: {
        ...(combo ? { id: combo.id } : {}), name: name.trim(), models, strategy, stickyLimit: limit, enabled,
      } })
      if (!live.current) return
      await onSaved()
      if (live.current) onClose()
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { saveLock.current = false; if (live.current) setSaving(false) }
  }
  return <WorkbenchDialog title={combo ? t('rt.editorEdit') : t('rt.editorNew')} onClose={onClose} busy={saving}>
    <form className="wb-form rt-editor" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="rt-settings">
        <label>{t('rt.name')}<Input autoFocus required maxLength={120} value={name} disabled={saving} onChange={event => setName(event.target.value)} /></label>
        <label>{t('rt.strategy')}<select aria-label={t('rt.strategy')} value={strategy} disabled={saving} onChange={event => { previewRequest.current?.abort(); setPreview(undefined); setStrategy(event.target.value) }}>
          {!allowedStrategies.includes(strategy) && <option value={strategy} disabled>{t.format('rt.unavailable', { name: strategyName(strategy) })}</option>}
          {allowedStrategies.map(value => <option key={value} value={value}>{strategyName(value)}</option>)}
        </select></label>
        <label>{t('rt.sticky')}<Input type="number" inputMode="numeric" min={1} max={100} step={1} required value={stickyLimit} disabled={saving} onChange={event => setStickyLimit(event.target.value)} /></label>
        <div className="rt-enabled"><span>{t('rt.enable')}</span><Switch checked={enabled} aria-label={t('rt.enable')} disabled={saving} onCheckedChange={setEnabled} /></div>
      </div>
      <div className="rt-strategy-description"><Badge tone="blue">{strategyName(strategy)}</Badge><span>{strategyDetail(strategy)}</span></div>
      <div className="rt-members-layout">
        <section className="rt-members" aria-label={t('rt.selectedOrder')}>
          <div className="rt-section-heading"><h3>{t('rt.memberOrder')}</h3><span>{models.length}</span></div>
          <ol className="rt-selected">
            {models.map((id, index) => {
              const model = byId.get(id), invalid = invalidModels.includes(id)
              return <li className={invalid ? 'rt-member-invalid' : ''} key={id}>
                <span className="rt-position">{index + 1}</span>
                <div className="rt-model-name"><strong>{model?.name || id}</strong><small>{id}</small>
                  {invalid ? <span className="rt-member-error">{model ? t('rt.cycle') : t('rt.unknownMember')}</span> : groupIds.has(id) && <Badge>{t('rt.groupMember')}</Badge>}</div>
                <div className="rt-member-actions">
                  <Button variant="ghost" disabled={saving || index === 0} aria-label={t.format('rt.moveUpMember', { name: model?.name || id })} title={t('rt.moveUp')} onClick={() => move(index, -1)}><ArrowUp size={14} /></Button>
                  <Button variant="ghost" disabled={saving || index === models.length - 1} aria-label={t.format('rt.moveDownMember', { name: model?.name || id })} title={t('rt.moveDown')} onClick={() => move(index, 1)}><ArrowDown size={14} /></Button>
                  <Button variant="ghost" disabled={saving} aria-label={t.format('rt.removeMemberAria', { name: model?.name || id })} title={t('rt.removeMember')} onClick={() => editModels(models.filter(member => member !== id))}><X size={14} /></Button>
                </div>
              </li>
            })}
          </ol>
          {!models.length && <div className="rt-section-empty">{t('rt.noMembers')}</div>}
        </section>
        <section className="rt-picker" aria-label={t('rt.availableAria')}>
          <div className="rt-section-heading"><h3>{t('rt.addMembers')}</h3><span>{available.length}</span></div>
          <div className="rt-picker-filters"><label className="wb-search"><Search size={15} /><Input aria-label={t('rt.searchMembers')} placeholder={t('rt.searchMembersPlaceholder')} value={query} disabled={saving} onChange={event => setQuery(event.target.value)} /></label>
            <select aria-label={t('rt.memberType')} value={kind} disabled={saving} onChange={event => setKind(event.target.value)}><option value="all">{t('rt.allTypes')}</option><option value="models">{t('rt.models')}</option><option value="groups">{t('rt.groups')}</option></select></div>
          <div className="rt-picker-list">{available.map(model => {
            const cycle = createsCycle(model.id, combo?.id, data.combos)
            return <div className="rt-picker-row" key={model.id}>
              <div className="rt-model-name"><strong>{model.name || model.id}</strong><small>{model.id}</small><span>{cycle ? t('rt.wouldCycle') : groupIds.has(model.id) ? t('rt.groupMember') : model.channel}</span></div>
              <Button variant="ghost" disabled={saving || cycle || models.length >= 100} title={cycle ? t('rt.wouldCycle') : models.length >= 100 ? t('rt.maxMembers') : t('rt.addMember')} aria-label={t.format('rt.addMemberAria', { name: model.name || model.id })} onClick={() => editModels([...models, model.id])}><Plus size={16} /></Button>
            </div>
          })}</div>
          {!available.length && <div className="rt-section-empty">{choices.length ? t('rt.noAvailable') : t('rt.noChoices')}</div>}
        </section>
      </div>
      <section className="rt-preview" aria-label={t('rt.previewAria')}>
        <div className="rt-section-heading"><h3>{t('rt.previewTitle')}</h3><Button variant="outline" disabled={saving || previewing || !models.length} busy={previewing} onClick={() => void loadPreview()}><Eye size={14} />{t('rt.preview')}</Button></div>
        {previewError && <p className="wb-error" role="alert"><CircleAlert size={15} />{previewError}</p>}
        {preview && <>
          <dl className="rt-capacity"><div><dt>{t('rt.contextWindow')}</dt><dd>{capacityNumber(preview.capacity?.contextWindow)}</dd></div><div><dt>{t('rt.maxOutput')}</dt><dd>{capacityNumber(preview.capacity?.maxOutput)}</dd></div><div><dt>{t('rt.vision')}</dt><dd>{capability(preview.capacity?.vision)}</dd></div><div><dt>{t('rt.reasoning')}</dt><dd>{capability(preview.capacity?.reasoning)}</dd></div></dl>
          <ol className="rt-preview-order">{preview.order.map((model, index) => <li key={`${model.id}:${index}`}><span className="rt-position">{index + 1}</span><div className="rt-model-name"><strong>{model.name || model.id}</strong><small>{model.id}</small>{model.reason && <p>{model.reason}</p>}</div></li>)}</ol>
          {!preview.order.length && <p className="rt-section-empty">{t('rt.noCandidates')}</p>}
        </>}
      </section>
      {error && <p className="wb-error" role="alert"><CircleAlert size={15} />{error}</p>}
      <div className="wb-form-actions"><Button variant="outline" disabled={saving} onClick={onClose}>{t('action.cancel')}</Button><Button type="submit" disabled={saving || !models.length} busy={saving}><Save size={15} />{t('rt.save')}</Button></div>
    </form>
  </WorkbenchDialog>
}

export function Routing({ active, host }: { active: boolean; host: Host }) {
  const { data, error: loadError, loading, reload } = useManagementResource<RoutingData>('/routing', active)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [editor, setEditor] = useState<Combo | 'new'>()
  const [removing, setRemoving] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [status, setStatus] = useState('')
  const live = useRef(true)
  const lock = useRef(false)
  useEffect(() => {
    live.current = active
    return () => { live.current = false }
  }, [active])
  const combos = data?.combos ?? []
  const rows = combos.filter(combo => `${combo.name} ${combo.id} ${combo.models.join(' ')}`.toLowerCase().includes(search.trim().toLowerCase())
    && (filter === 'all' || (filter === 'enabled' ? combo.enabled : !combo.enabled)))
  const names = new Map([...(data?.models ?? []).map(model => [model.id, model.name] as const), ...combos.map(combo => [combo.id, combo.name] as const)])
  const blocked = !!busy || loading || !!editor
  const afterWrite = async (message: string) => {
    if (!live.current) return
    setStatus(message); setError('')
    const results = await Promise.allSettled([reload(), host.refresh()])
    if (live.current && results[1].status === 'rejected') setError(t.format('rt.savedRefreshFailed', { detail: failureMessage(results[1].reason) }))
  }
  const run = async (combo: Combo, remove = false) => {
    if (lock.current) return
    lock.current = true; setBusy(combo.id); setError(''); setStatus('')
    try {
      await management(remove ? '/routing/remove' : '/routing/save', remove ? { id: combo.id } : { combo: { ...combo, enabled: !combo.enabled } })
      if (!live.current) return
      setRemoving('')
      await afterWrite(remove ? t('rt.deleted') : combo.enabled ? t('rt.disabledMsg') : t('rt.enabledMsg'))
    } catch (reason) { if (live.current) setError(failureMessage(reason)) }
    finally { lock.current = false; if (live.current) setBusy('') }
  }
  return <div className="wb-page rt-page">
    <header className="wb-heading"><div><span className="wb-eyebrow">ROUTING</span><h1>{t('rt.heading')}</h1></div><Button variant="outline" aria-label={t('rt.refresh')} title={t('rt.refresh')} disabled={blocked} busy={loading} onClick={() => void reload()}><RefreshCw size={15} />{t('action.refresh')}</Button></header>
    <div className="wb-summary"><span><strong>{data ? combos.length : '—'}</strong> {t('rt.groups')}</span><span><i className="wb-dot" /><strong>{data ? combos.filter(combo => combo.enabled).length : '—'}</strong> {t('rt.enabledCount')}</span><span><strong>{data ? data.models.length : '—'}</strong> {t('rt.availableModels')}</span></div>
    <div className="wb-toolbar rt-toolbar"><label className="wb-search"><Search size={16} /><Input aria-label={t('rt.search')} placeholder={t('rt.searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label={t('rt.status')} value={filter} onChange={event => setFilter(event.target.value)}><option value="all">{t('rt.allStatus')}</option><option value="enabled">{t('action.enabled')}</option><option value="disabled">{t('action.disabled')}</option></select>
      <Button className="rt-create" disabled={blocked || !data} onClick={() => { setStatus(''); setError(''); setEditor('new') }}><Plus size={15} />{t('rt.create')}</Button></div>
    {(error || loadError) && <div className="wb-feedback wb-error" role="alert"><CircleAlert size={16} /><span>{error || loadError}</span>{loadError && <Button variant="outline" disabled={blocked} onClick={() => void reload()}>{t('action.retry')}</Button>}</div>}
    {status && <div className="wb-feedback wb-status" role="status"><Check size={16} /><span>{status}</span></div>}
    <section className="rt-list" aria-label={t('rt.listAria')} aria-busy={loading}>
      {rows.map(combo => <div className="rt-group" key={combo.id}>
        <div className="rt-group-row"><span className="wb-app-icon is-green"><Route size={20} /></span><div className="rt-group-name"><strong>{combo.name}</strong><small>{combo.id}</small></div>
          <div className="rt-group-strategy"><Badge tone="blue">{strategyName(combo.strategy)}</Badge><small>{t.format('rt.membersAndSticky', { n: combo.models.length, sticky: combo.stickyLimit })}</small></div>
          <Switch checked={combo.enabled} disabled={blocked} aria-label={t.format('rt.enableGroup', { name: combo.name })} onCheckedChange={() => void run(combo)} />
          <div className="rt-group-actions"><Button variant="ghost" disabled={blocked} title={t('rt.edit')} aria-label={t.format('rt.editGroupAria', { name: combo.name })} onClick={() => { setError(''); setStatus(''); setEditor(combo) }}><Pencil size={15} /></Button><Button variant="ghost" className="wb-danger" disabled={blocked} title={t('rt.delete')} aria-label={t.format('rt.deleteGroupAria', { name: combo.name })} onClick={() => setRemoving(combo.id)}><Trash2 size={15} /></Button></div>
        </div>
        <ol className="rt-group-members">{combo.models.map((id, index) => <li key={`${id}:${index}`}><span>{index + 1}</span><span title={id}>{names.get(id) || id}</span></li>)}</ol>
        {removing === combo.id && <div className="wb-remove rt-remove"><span>{t.format('rt.confirmDelete', { name: combo.name })}</span><Button variant="outline" disabled={!!busy} onClick={() => setRemoving('')}>{t('action.cancel')}</Button><Button variant="outline" className="wb-danger" disabled={!!busy} busy={busy === combo.id} onClick={() => void run(combo, true)}><Trash2 size={14} />{t('action.confirmDelete')}</Button></div>}
      </div>)}
      {!data && loading && <div className="wb-empty" role="status"><RefreshCw size={22} /><strong>{t('rt.reading')}</strong></div>}
      {data && !rows.length && <div className="wb-empty"><Layers3 size={24} /><strong>{combos.length ? t('rt.noMatch') : t('rt.none')}</strong>{combos.length
        ? <Button variant="outline" onClick={() => { setSearch(''); setFilter('all') }}>{t('action.clearFilters')}</Button>
        : <Button variant="outline" disabled={blocked} onClick={() => setEditor('new')}><Plus size={15} />{t('rt.create')}</Button>}</div>}
    </section>
    {editor && data && active && <RoutingEditor key={editor === 'new' ? 'new' : editor.id} combo={editor === 'new' ? undefined : editor} data={data} onClose={() => setEditor(undefined)} onSaved={() => afterWrite(t('rt.saved'))} />}
  </div>
}
