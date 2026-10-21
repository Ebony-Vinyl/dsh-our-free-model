import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { defaultRangeExtractor, useVirtualizer, type Range } from '@tanstack/react-virtual'
import { Boxes, Check, CircleAlert, CircleCheck, Copy, Eye, EyeOff, LoaderCircle, Play, RefreshCw, Search, SlidersHorizontal, Square, X } from 'lucide-react'
import { providers } from 'ofm-provider-list'
import { Badge, Button, Input } from './components/ui'
import { t, numLocale, providerText } from './i18n.mjs'
import { filterModels } from './models-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Model, ModelTestResult, ServiceSettings, Summary } from './types'
import './models.css'

const availabilityNames: Record<string, string> = {
  available: t('mdl.status.available'), listed: t('mdl.status.listed'), unknown: t('mdl.status.unknown'),
  unavailable: t('mdl.status.unavailable'), throttled: t('mdl.status.throttled'), 'region-blocked': t('mdl.status.region-blocked'),
}
const sourceNames: Record<string, string> = { anonymous: t('mdl.channel.anonymous'), kilo: t('mdl.channel.kilo'), eac: t('mdl.channel.eac') }
const channelName = (id: string) => {
  if (sourceNames[id]) return sourceNames[id]
  const provider = providers.find(row => row.id === id)
  return provider ? providerText(provider, 'name') : id
}
const number = (value: number) => new Intl.NumberFormat(numLocale()).format(value)
const capacity = (value?: number) => value && Number.isFinite(value) && value > 0
  ? value >= 1000 ? `${Number((value / 1000).toFixed(1))}K` : number(value) : t('mdl.unknown')
const initialFilters = { search: '', channel: 'all', capability: 'all', availability: 'all', access: 'all' }
type Operation = 'refresh' | 'probe' | 'test'
type TestState = { model: Model; state: 'pending' | 'success' | 'error' | 'cancelled'; result?: ModelTestResult; error?: string }

export function Models({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [filters, setFilters] = useState(initialFilters)
  const [operation, setOperation] = useState<Operation>()
  const [test, setTest] = useState<TestState>()
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<string>()
  const [focusedId, setFocusedId] = useState<string>()
  const [visibilitySaving, setVisibilitySaving] = useState(false)
  const visibilityPending = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pending = useRef<AbortController | undefined>(undefined)
  const activeRef = useRef(active)
  activeRef.current = active
  const models = useMemo<Model[]>(() => filterModels(summary.catalog, filters), [summary.catalog, filters])
  const channels = useMemo(() => [...new Set(['anonymous', 'kilo', 'eac', ...summary.catalog.map(model => model.channel), filters.channel])]
    .filter(id => id !== 'all'), [summary.catalog, filters.channel])
  const focusedIndex = focusedId ? models.findIndex(model => model.id === focusedId) : -1
  const rangeExtractor = useCallback((range: Range) => {
    const visible = defaultRangeExtractor(range)
    return focusedIndex >= 0 ? [...new Set([...visible, focusedIndex])].sort((a, b) => a - b) : visible
  }, [focusedIndex])
  const virtual = useVirtualizer({
    count: models.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 112, overscan: 5, enabled: active,
    getItemKey: index => models[index].id, rangeExtractor,
  })
  const changeFilters = (patch: Partial<typeof initialFilters>) => {
    // 使用原生滚动归零，避免动态测量时平滑滚动的目标高度变化。
    if (scrollRef.current) scrollRef.current.scrollTop = 0
    setFilters(previous => ({ ...previous, ...patch }))
    setFocusedId(undefined)
  }
  useEffect(() => {
    if (!active) {
      pending.current?.abort()
      pending.current = undefined
      setOperation(undefined)
      setTest(previous => previous?.state === 'pending' ? { ...previous, state: 'cancelled' } : previous)
    }
    return () => { pending.current?.abort(); pending.current = undefined }
  }, [active])
  useEffect(() => {
    if (active && scrollRef.current) {
      const max = Math.max(0, virtual.getTotalSize() - scrollRef.current.clientHeight)
      if (scrollRef.current.scrollTop > max) scrollRef.current.scrollTop = max
    }
  }, [models.length, active, virtual])

  const run = async (kind: Operation, model?: Model) => {
    if (pending.current || !activeRef.current) return
    const controller = new AbortController()
    pending.current = controller
    setOperation(kind); setError(''); setMessage('')
    if (model) setTest({ model, state: 'pending' })
    const isCurrent = () => pending.current === controller && !controller.signal.aborted && activeRef.current
    try {
      if (kind === 'test' && model) {
        const result = await host.testModel(model.id, controller.signal)
        if (!isCurrent()) return
        setTest({ model, state: 'success', result })
        try {
          await host.refresh()
        } catch (reason) {
          if (!isCurrent()) return
          const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? t('mdl.timeoutRetry') : reason.message : t('err.requestFailed')
          setError(t.format('mdl.testRefreshFailed', { detail }))
        }
      } else {
        await host.refreshModels(kind === 'probe', controller.signal)
        if (!isCurrent()) return
        setMessage(kind === 'probe' ? t('mdl.probeDone') : t('mdl.refreshDone'))
      }
    } catch (reason) {
      if (!isCurrent()) return
      const detail = reason instanceof Error ? reason.name === 'TimeoutError' ? t('mdl.timeoutRetry') : reason.message : t('err.operationFailed')
      if (kind === 'test' && model) setTest({ model, state: 'error', error: detail })
      else setError(detail)
    } finally {
      if (isCurrent()) { pending.current = undefined; setOperation(undefined) }
    }
  }

  const cancel = () => {
    pending.current?.abort()
    pending.current = undefined
    setOperation(undefined)
    setTest(previous => previous ? { ...previous, state: 'cancelled' } : previous)
  }

  const copyModelId = (model: Model) => {
    void host.copy(model.id).then(() => {
      if (activeRef.current) {
        setCopied(model.id)
        setTimeout(() => { if (activeRef.current) setCopied(undefined) }, 1800)
      }
    }).catch(host.error)
  }

  const saveVisibility = async (patch: Partial<ServiceSettings>) => {
    if (visibilityPending.current || !activeRef.current) return
    visibilityPending.current = true
    setVisibilitySaving(true); setError(''); setMessage('')
    try {
      await host.saveSettings(patch)
      if (activeRef.current) setMessage(visibility.saved)
      try { await host.refresh() } catch (reason) { if (activeRef.current) host.error(reason as Error) }
    } catch (reason) {
      if (activeRef.current) setError(reason instanceof Error ? reason.message : t('err.saveFailed'))
    } finally {
      visibilityPending.current = false
      setVisibilitySaving(false)
    }
  }

  if (!active) return null
  const filtered = Object.entries(filters).some(([key, value]) => value !== initialFilters[key as keyof typeof initialFilters])
  const routable = summary.catalog.filter(model => model.routable).length
  return <div className="model-browser" data-testid="models-ready">
    <header className="dashboard-heading">
      <div><div className="heading-eyebrow">WORKSPACE / MODELS</div><h1>{t('mdl.heading')}</h1>
        <p>{t.format('mdl.countLine', { total: number(summary.catalog.length), routable: number(routable) })}</p></div>
      <div className="actions">
        <Button variant="outline" disabled={!!operation} onClick={() => { void run('refresh') }}>
          <RefreshCw size={15} className={operation === 'refresh' ? 'spinning' : ''} />{operation === 'refresh' ? t('mdl.refreshing') : t('mdl.refresh')}
        </Button>
        <Button disabled={!!operation || !summary.settings.enabled} title={t('mdl.probeTitle')}
          onClick={() => { void run('probe') }}>
          {operation === 'probe' ? <LoaderCircle size={15} className="spinning" /> : <CircleCheck size={15} />}
          {operation === 'probe' ? t('mdl.probing') : t('mdl.probe')}
        </Button>
      </div>
    </header>
    <div className="model-summary">
      <span><span className={`status-dot ${summary.settings.enabled ? '' : 'paused'}`} />{summary.settings.enabled ? t('mdl.enabled') : t('mdl.paused')}</span>
      <span>{t.format('mdl.syncedAt', { at: summary.catalogSyncedAt ? new Date(summary.catalogSyncedAt).toLocaleString(numLocale(), { hour12: false }) : t('mdl.neverSynced') })}</span>
      <span>{t('mdl.probeNote')}</span>
    </div>
    {error && <div className="channel-error" role="alert"><CircleAlert size={16} /><span>{error}</span>
      <Button variant="ghost" aria-label={t('mdl.closeError')} title={t('mdl.closeError')} onClick={() => setError('')}><X size={15} /></Button></div>}
    {message && <p className="model-feedback" role="status"><Check size={15} />{message}</p>}
    <div className="model-filters">
      <div className="model-search"><Search size={16} /><Input type="search" aria-label={t('mdl.searchLabel')} placeholder={t('mdl.searchPlaceholder')}
        value={filters.search} onChange={event => changeFilters({ search: event.target.value })} /></div>
      <select aria-label={t('mdl.filterChannel')} value={filters.channel} onChange={event => changeFilters({ channel: event.target.value })}>
        <option value="all">{t('mdl.allChannels')}</option>{channels.map(id => <option value={id} key={id}>{channelName(id)}</option>)}
      </select>
      <select aria-label={t('mdl.filterCapability')} value={filters.capability} onChange={event => changeFilters({ capability: event.target.value })}>
        <option value="all">{t('mdl.allCapabilities')}</option><option value="text">{t('mdl.capabilityText')}</option><option value="vision">{t('mdl.capabilityVision')}</option><option value="reasoning">{t('mdl.capabilityReasoning')}</option>
      </select>
      <select aria-label={t('mdl.filterAvailability')} value={filters.availability} onChange={event => changeFilters({ availability: event.target.value })}>
        <option value="all">{t('mdl.allAvailability')}</option>{Object.entries(availabilityNames).map(([id, name]) => <option value={id} key={id}>{name}</option>)}
      </select>
    </div>
    <div className="model-list-toolbar">
      <div className="channel-filters" role="group" aria-label={t('mdl.filterAccess')}>
        {([['all', t('mdl.allModels')], ['routable', t('mdl.accessRoutable')], ['hidden', t('mdl.accessHidden')]] as const).map(([id, name]) =>
          <button key={id} aria-pressed={filters.access === id} onClick={() => changeFilters({ access: id })}>{name}</button>)}
      </div>
      <span role="status" data-testid="model-result-count">{t.format('mdl.resultCount', { shown: number(models.length), total: number(summary.catalog.length) })}</span>
      {filtered && <Button variant="ghost" onClick={() => changeFilters(initialFilters)}><X size={14} />{t('mdl.clearFilters')}</Button>}
    </div>
    <div className="model-list-toolbar">
      <label><input type="checkbox" role="switch" checked={summary.settings.hideFreeModels === true}
        disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideFreeModels: event.target.checked }) }} /> {visibility.hideFree}</label>
      <label><input type="checkbox" role="switch" checked={summary.settings.hideEacModels === true}
        disabled={visibilitySaving} onChange={event => { void saveVisibility({ hideEacModels: event.target.checked }) }} /> {visibility.hideEac}</label>
    </div>
    {test && <section className={`model-test-result model-test-${test.state}`} aria-label={t('mdl.testAria')} aria-live="polite">
      <div className="model-test-heading"><div><strong>
        {test.state === 'pending' ? t('mdl.testPending') : test.state === 'success' ? t('mdl.testSuccess') : test.state === 'cancelled' ? t('mdl.testCancelled') : t('mdl.testFailed')}
      </strong><span>{test.model.name}{test.result && ` · ${number(test.result.latencyMs)} ms`}</span></div>
        {test.state === 'pending' ? <Button variant="outline" onClick={cancel}><Square size={14} />t('mdl.testCancel')</Button>
          : <Button variant="ghost" aria-label={t('mdl.closeTest')} title={t('mdl.closeTest')} onClick={() => setTest(undefined)}><X size={15} /></Button>}
      </div>
      {test.state === 'success' && <><pre>{test.result?.text}</pre>{test.result?.persisted === false && <p role="status">{t('mdl.testNotPersisted')}</p>}</>}
      {test.state === 'error' && <p>{test.error}</p>}
    </section>}
    {models.length ? <div className="model-table" role="table" aria-label={t('mdl.listAria')} aria-rowcount={models.length + 1} aria-colcount={5}>
      <div className="model-table-header" role="row"><span role="columnheader">{t('mdl.colModel')}</span><span role="columnheader">{t('mdl.colCapability')}</span>
        <span role="columnheader">{t('mdl.colLimits')}</span><span role="columnheader">{t('mdl.colState')}</span><span role="columnheader">{t('mdl.colActions')}</span></div>
      <div ref={scrollRef} className="model-scroll" role="rowgroup" tabIndex={0} aria-label={t('mdl.scrollAria')} onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          virtual.scrollToIndex(event.key === 'Home' ? 0 : models.length - 1, { align: event.key === 'Home' ? 'start' : 'end' })
        }
      }}>
        <div className="model-virtual-content" style={{ height: virtual.getTotalSize() }}>
          {virtual.getVirtualItems().map(item => {
            const model = models[item.index]
            const state = model.availabilitySource === 'listing' ? 'listed' : model.availability ?? 'unknown'
            const manual = model.availabilitySource === 'manual'
            const failed = manual && state === 'unknown'
            const availabilityName = failed ? t('mdl.status.manualFailed') : manual && state === 'available' ? t('mdl.status.manualOk') : availabilityNames[state] ?? t('mdl.status.unknownState')
            const disabledReason = !summary.settings.enabled ? t('mdl.pausedReason') : !model.routable && !model.hiddenByUser ? t('mdl.notPublicReason') : operation ? t('mdl.waitReason') : ''
            return <div role="row" aria-rowindex={item.index + 2} key={item.key} data-index={item.index} data-model-id={model.id}
              className="model-table-row" ref={virtual.measureElement} style={{ transform: `translateY(${item.start}px)` }}
              onFocusCapture={() => setFocusedId(model.id)} onBlurCapture={event => {
                if (!event.currentTarget.contains(event.relatedTarget)) setFocusedId(undefined)
              }}>
              <div role="cell" className="model-identity"><strong>{model.name}</strong><code>{model.id}</code></div>
              <div role="cell" className="model-source"><span>{channelName(model.channel)}</span><div className="model-capabilities">
                <Badge>{model.vision ? t('mdl.badgeVision') : t('mdl.badgeText')}</Badge>{model.reasoning && <Badge tone="blue">{t('mdl.badgeThinking')}</Badge>}</div></div>
              <div role="cell" className="model-limits"><span title={model.contextWindow ? `${model.contextWindow} Token` : undefined}>{capacity(model.contextWindow)} <small>{t('mdl.context')}</small></span>
                <span title={model.maxOutput ? `${model.maxOutput} Token` : undefined}>{capacity(model.maxOutput)} <small>{t('mdl.output')}</small></span></div>
              <div role="cell" className="model-state"><Badge tone={state === 'available' ? 'success' : failed || ['unavailable', 'throttled', 'region-blocked'].includes(state) ? 'warning' : 'neutral'}>
                {availabilityName}</Badge>
                {manual && state !== 'available' && model.detail && <small title={model.detail}
                  style={{ maxWidth: '100%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model.detail}</small>}
                {!model.routable && <small>{model.hiddenByUser ? visibility.hidden : t('mdl.accessHidden')}</small>}
                {model.ttftMs != null && <small>{t.format('mdl.ttft', { ms: number(model.ttftMs) })}</small>}</div>
              <div role="cell" className="model-row-actions">
                {['anonymous', 'kilo', 'eac', 'aggregate', 'combo'].includes(model.channel) && <Button variant="ghost"
                  disabled={visibilitySaving || model.hiddenByGroup === true}
                  title={model.hiddenByGroup ? visibility.groupHidden : model.hiddenByUser ? visibility.show : visibility.hide}
                  aria-label={`${model.hiddenByUser ? visibility.show : visibility.hide}：${model.id}`}
                  onClick={() => { const ids = summary.settings.hiddenModelIds ?? []; void saveVisibility({
                    hiddenModelIds: ids.includes(model.id) ? ids.filter(id => id !== model.id) : [...ids, model.id],
                  }) }}>{model.hiddenByUser ? <Eye size={16} /> : <EyeOff size={16} />}</Button>}
                <Button variant="ghost" title={t.format('mdl.copyIdTitle', { id: model.id })} aria-label={t.format('mdl.copyIdAria', { id: model.id })} onClick={() => copyModelId(model)}
                  className={copied === model.id ? 'md-copy-done' : ''}>
                  {copied === model.id ? <Check size={16} /> : <Copy size={16} />}
                </Button>
                <Button variant="outline" disabled={!!disabledReason} title={disabledReason || t.format('mdl.testModelTitle', { name: model.name })}
                  aria-label={t.format('mdl.testModelAria', { id: model.id })} onClick={() => { void run('test', model) }}
                  className={operation === 'test' && test?.model.id === model.id ? 'md-testing' : ''}>
                  {operation === 'test' && test?.model.id === model.id ? <LoaderCircle size={14} className="spinning" /> : <Play size={14} />}{t('mdl.testButton')}
                </Button>
              </div>
            </div>
          })}
        </div>
      </div>
    </div> : <div className="model-empty"><Boxes size={28} /><h2>{summary.catalog.length ? t('mdl.emptyMatched') : t('mdl.emptyCatalog')}</h2>
      <p>{summary.catalog.length ? t('mdl.emptyMatchedHint') : t('mdl.emptyCatalogHint')}</p>
      {filtered && <Button variant="outline" onClick={() => changeFilters(initialFilters)}><SlidersHorizontal size={15} />{t('mdl.clearFilters')}</Button>}
    </div>}
    <p className="footnote">{t('mdl.footnote')}</p>
  </div>
}
