import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleAlert, Check, LoaderCircle, RotateCcw, Save, Settings2, RefreshCw } from 'lucide-react'
import { Badge, Button, Card, Input } from './components/ui'
import { t } from './i18n.mjs'
import { settingsDraft, settingsChanged, syncSettings, validateSettingsDraft } from './settings-data.mjs'
import { visibilityCopy } from './visibility-data.mjs'
import type { Host, Summary } from './types'
import './settings.css'

type Draft = ReturnType<typeof settingsDraft>
type NumberField = 'defaultMaxTokens' | 'probeIntervalMinutes'
const connectionError = (reason: unknown) => reason instanceof Error
  ? reason.name === 'TimeoutError' ? t('notice.saveTimeout')
    : reason instanceof TypeError && /fetch/i.test(reason.message) ? t('notice.saveFetchFailed')
    : reason.message : t('notice.saveErrorFallback')

export function Settings({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const visibility = visibilityCopy(document.documentElement.lang)
  const [state, setState] = useState(() => ({ saved: summary.settings, draft: settingsDraft(summary.settings) }))
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState<Partial<Record<NumberField, string>>>({})
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const savingRef = useRef(false)
  const mounted = useRef(true)
  const activeRef = useRef(active)
  const generation = useRef(0)
  activeRef.current = active
  useEffect(() => () => { mounted.current = false; generation.current++ }, [])
  useEffect(() => {
    if (!active) { generation.current++; setMessage(''); setError('') }
  }, [active])
  useEffect(() => {
    setState(previous => syncSettings(previous, summary.settings, savingRef.current))
  }, [summary.settings])
  const dirty = settingsChanged(state.draft, state.saved)
  const update = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setState(previous => ({ ...previous, draft: { ...previous.draft, [key]: value } }))
    setErrors(previous => ({ ...previous, [key]: undefined }))
    setMessage(''); setError('')
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (savingRef.current || !activeRef.current) return
    const validation = validateSettingsDraft(state.draft)
    setErrors(validation.errors); setMessage(''); setError('')
    if (!validation.patch) return
    const started = ++generation.current
    const feedbackCurrent = () => mounted.current && activeRef.current && started === generation.current
    savingRef.current = true
    setSaving(true)
    try {
      const saved = await host.saveSettings(validation.patch)
      if (!mounted.current) return
      setState({ saved, draft: settingsDraft(saved) })
      if (feedbackCurrent()) setMessage(t('notice.saved'))
      // 保存结果已确认；后续读取失败不能误报为保存失败。
      try { await host.refresh() } catch {
        if (feedbackCurrent()) setMessage(t('notice.savedRefreshPending'))
      }
    } catch (reason) {
      if (feedbackCurrent()) setError(connectionError(reason))
    } finally {
      savingRef.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const toggle = (name: 'enabled' | 'exposeRegionModels' | 'streamRecovery' | 'standaloneProbe' | 'hideFreeModels' | 'hideEacModels', label: string, help: string, disabled = false) =>
    <label className="settings-field" key={name}>
      <span><strong>{label}</strong><small>{help}</small></span>
      <input type="checkbox" role="switch" name={name} className="settings-toggle" disabled={disabled}
        checked={state.draft[name]} onChange={event => update(name, event.target.checked)} />
    </label>
  const numeric = (name: NumberField, label: string, help: string, min: number, max: number) =>
    <div className="settings-field settings-number-field">
      <label htmlFor={`setting-${name}`}><strong>{label}</strong><small>{help}</small></label>
      <div className="settings-number"><Input id={`setting-${name}`} name={name} type="number" min={min} max={max} step={1}
        value={state.draft[name]} onChange={event => update(name, event.target.value)}
        aria-invalid={!!errors[name]} aria-describedby={errors[name] ? `setting-error-${name}` : undefined} />
        {errors[name] ? <p id={`setting-error-${name}`} className="settings-field-error" role="alert"><CircleAlert size={12} />{errors[name]}</p>
          : <span className="settings-hint">{min}–{max}</span>}
      </div>
    </div>
  if (!active) return null
  const statusClass = saving ? 'settings-status-saving' : dirty ? 'settings-status-dirty' : message ? 'settings-status-saved' : ''
  return <div className="settings-browser" data-testid="settings-ready">
    <header className="dashboard-heading"><div><div className="heading-eyebrow">MANAGEMENT / SETTINGS</div>
      <h1>{t('cfg.heading')}</h1><p>{t('cfg.sub')}</p></div>
      <Badge tone={summary.settings.enabled ? 'success' : 'warning'}>{summary.settings.enabled ? t('cfg.serviceEnabled') : t('cfg.servicePaused')}</Badge>
    </header>
    <form onSubmit={event => { void submit(event) }} noValidate>
      <fieldset disabled={saving} className="settings-fieldset">
        <Card className="settings-card"><div className="settings-card-heading"><Settings2 size={16} /><div><h2>{t('cfg.inferenceTitle')}</h2><p>{t('cfg.inferenceSub')}</p></div></div>
          {toggle('enabled', t('cfg.enabled'), t('cfg.enabledHelp'))}
          {toggle('exposeRegionModels', t('cfg.exposeRegion'), t('cfg.exposeRegionHelp'))}
          {toggle('hideFreeModels', visibility.hideFree, t('cfg.hideFreeHelp'))}
          {toggle('hideEacModels', visibility.hideEac, t('cfg.hideEacHelp'))}
          {toggle('streamRecovery', t('cfg.recovery'), t('cfg.recoveryHelp'))}
          {numeric('defaultMaxTokens', t('cfg.maxTokens'), t('cfg.maxTokensHelp'), 512, 131072)}
        </Card>
        <Card className="settings-card"><div className="settings-card-heading"><RefreshCw size={16} /><div><h2>{t('cfg.refreshTitle')}</h2><p>{t('cfg.refreshSub')}</p></div></div>
          {numeric('probeIntervalMinutes', t('cfg.interval'), t('cfg.intervalHelp'), 1, 1440)}
          {toggle('standaloneProbe', t('cfg.probe'), t('cfg.probeHelp'), true)}
          <p className="settings-note" role="note"><CircleAlert size={15} /><span>{summary.automaticRefresh
            ? t('cfg.refreshOn')
            : t('cfg.refreshOff')}</span></p>
        </Card>
        <div className="settings-footer"><span role="status" aria-live="polite" className={statusClass}><span className="settings-status-dot" aria-hidden="true" />{saving ? t('cfg.saving') : dirty ? t('cfg.unsaved') : message || t('cfg.synced')}</span>
          <div className="settings-actions"><Button variant="outline" disabled={!dirty || saving} onClick={() => {
            setState(previous => ({ ...previous, draft: settingsDraft(previous.saved) }))
            setErrors({}); setError(''); setMessage('')
          }}><RotateCcw size={15} />{t('cfg.discard')}</Button>
            <Button type="submit" disabled={!dirty || saving}>{saving ? <LoaderCircle size={15} className="spinning" /> : message && !dirty ? <Check size={15} /> : <Save size={15} />}{saving ? t('cfg.savingButton') : t('cfg.save')}</Button></div>
        </div>
      </fieldset>
      {error && <p className="settings-save-error" role="alert"><CircleAlert size={16} /><span>{error}</span></p>}
    </form>
    <p className="footnote">{t('cfg.footnote')}</p>
  </div>
}
