import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'
import { Sidebar, Topbar } from './components/shell'
import { Overview } from './components/overview'
import { Connection } from './connection'
import { t, getLocale as locale, switchLocale } from './i18n.mjs'
import { Agents } from './agents'
import { Providers } from './providers'
import { Library } from './library'
import { Routing } from './routing'
import { Workspace } from './workspace'
import { DisclaimerDialog } from './components/disclaimer-dialog'
import type { Host, Page, ServiceSettings, Snapshot } from './types'
import { DesktopUpdate } from './desktop-update'
import './app.css'
import './workbench.css'
import { SponsorPage, SponsorNotice } from './sponsor'

const API = '/api/management'
const pageNames: Page[] = ['overview', 'workspace', 'agents', 'providers', 'library', 'routing', 'models', 'usage', 'channels', 'eac', 'settings', 'updates', 'connection', 'sponsor']
const platform = document.getElementById('root')?.dataset.loginPlatform ?? (/Windows/i.test(navigator.userAgent) ? 'windows' : /Macintosh|Mac OS/i.test(navigator.userAgent) ? 'macos' : 'unsupported')
const terminalName = platform === 'windows' ? 'PowerShell' : t('app.terminal')
type Request = <T = any>(path: string, body?: unknown, timeoutMs?: number, signal?: AbortSignal) => Promise<T>
const messageOf = (error: unknown) => error instanceof Error ? error.name === 'TimeoutError' ? t('err.timeout') : error.message : t('err.requestFailed')

function LoginScreen({ request }: { request: Request }) {
  const [key, setKey] = useState(''), [error, setError] = useState(''), [status, setStatus] = useState(''), [busy, setBusy] = useState(false)
  const command = platform === 'windows'
    ? '$ofmLogin = Get-Content -LiteralPath "$env:USERPROFILE\\.our-free-model\\settings.json" -Raw -Encoding UTF8 | ConvertFrom-Json; $(if ($ofmLogin.managementKey) { $ofmLogin.managementKey } else { $ofmLogin.forwardKey }) | Set-Clipboard'
    : platform === 'macos'
      ? `node -e 'const fs = require("node:fs"); const {execFileSync} = require("node:child_process"); const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const key = settings.managementKey ?? settings.forwardKey; if (typeof key !== "string" || !key.trim()) throw new Error("missing login token"); execFileSync("/usr/bin/pbcopy", [], {input: key});' "$HOME/.our-free-model/settings.json"`
      : `node -e 'const fs = require("node:fs"); const settings = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); const key = settings.managementKey ?? settings.forwardKey; if (typeof key !== "string" || !key.trim()) throw new Error("missing login token"); process.stdout.write(key + "\\n");' "$HOME/.our-free-model/settings.json"`
  const submit = async (event: FormEvent) => { event.preventDefault(); if (busy) return; setBusy(true); setError(''); try { await request('/session', { key: key.trim() }); setKey(''); window.dispatchEvent(new CustomEvent('ofm:logged-in')) } catch (reason) { setError(messageOf(reason)) } finally { setBusy(false) } }
  const openTerminal = async () => { if (platform === 'unsupported' || busy) return; setBusy(true); setStatus(t.format('login.opening', { terminal: terminalName })); try { await request('/login/terminal', {}, 15000); setStatus(t.format('login.requested', { terminal: terminalName })); document.getElementById('login-key')?.focus() } catch (reason) { setStatus(t.format('login.openFailed', { detail: messageOf(reason) })) } finally { setBusy(false) } }
  const copyCommand = async () => { try { await navigator.clipboard.writeText(command); setStatus(t.format('login.commandCopied', { terminal: terminalName })) } catch { const input = document.getElementById('login-command') as HTMLTextAreaElement | null; input?.focus(); input?.select(); setStatus(t.format('login.copyNotAllowed', { key: platform === 'macos' ? 'Command+C' : 'Ctrl+C' })) } }
  return <section id="login-screen" className="login-shell" data-testid="login-screen"><div className="login-card login-card-enter"><span className="login-card-glow" aria-hidden="true" /><div className="brand-mark" aria-hidden="true">ofm<span>.</span></div>
    <span className="eyebrow">OUR FREE MODEL / LOCAL CONSOLE</span><h1>{t('login.heading')}</h1><p>{t('login.intro')}</p>
    <form id="login-form" onSubmit={event => { void submit(event) }}><label htmlFor="login-key">{t('login.tokenLabel')}</label><input id="login-key" name="key" type="password" autoComplete="off" placeholder="ofm-…" required value={key} onChange={event => setKey(event.target.value)} /><button className={"primary" + (busy ? " is-busy" : "")} type="submit" disabled={busy}>{busy && <span className="ui-spinner" aria-hidden="true" />}<span className="login-submit-label">{t('login.submit')}</span> <span aria-hidden="true">→</span></button></form>
    {error && <p id="login-error" role="alert" className="error login-error-enter">{error}</p>}<div className="login-help"><h2>{t('login.noToken')}</h2><p id="login-terminal-help">{platform === 'unsupported' ? t('login.manualHint') : t.format('login.autoHint', { terminal: terminalName })}</p>
      <button id="login-terminal" className="secondary" type="button" data-login-platform={platform} disabled={platform === 'unsupported' || busy} onClick={() => void openTerminal()}>{t.format('login.openButton', { terminal: platform === 'windows' ? ' PowerShell ' : t('app.terminal') })}</button><p id="login-help-status" role="status">{status}</p><details><summary>{t('login.manualHeading')}</summary><p>{t('login.pathBefore')}<code>.our-free-model/settings.json</code>{t('login.pathAfter')}<code>managementKey</code>{t('login.fieldAfter')}</p><label id="login-command-label" htmlFor="login-command">{t('login.commandLabel')}</label><textarea id="login-command" readOnly rows={4} spellCheck={false} value={command} /><button id="copy-login-command" className="text-button" type="button" onClick={() => void copyCommand()}>{t('login.copyCommand')}</button></details></div><small>{t('login.note')}</small><div className="login-lang-row"><button className="text-button" type="button" data-testid="login-lang" onClick={() => switchLocale(locale() === 'zh' ? 'en' : 'zh')}>{locale() === 'zh' ? t('login.switchToEnglish') : t('nav.switchToChinese')}</button></div></div></section>
}
function LoadingScreen() { return <div id="loading-screen" className="loading-screen"><div className="loading-inner"><div className="brand-mark loading-brand">ofm<span>·</span></div><span className="loading-bar" aria-hidden="true"><span className="loading-bar-fill" /></span><p>{t('ui.connecting')}</p></div></div> }
function ChannelMount({ kind, summary }: { kind: 'channels' | 'eac'; summary: Snapshot['summary'] & { reload(): void } }) {
  const [module, setModule] = useState<typeof import('./channels.mjs')>(); const generation = useRef(0); const summaryRef = useRef(summary); summaryRef.current = summary
  useEffect(() => { const current = ++generation.current; let alive = true; void import('./channels.mjs').then(value => { if (alive && current === generation.current) setModule(value) }); return () => { alive = false; generation.current++; module?.hide() } }, [kind])
  useEffect(() => { if (!module) return; module.show(kind, summaryRef.current); return () => module.hide() }, [module, kind])
  return <div id="channel-root" className="ofm_root" role={module ? undefined : 'status'}>{module ? null : t('ui.loadingChannels')}</div>
}
function LazyPage({ name, snapshot, host, active }: { name: 'models' | 'usage' | 'settings'; snapshot: Snapshot; host: Host; active: boolean }) {
  const [module, setModule] = useState<any>(); useEffect(() => { let alive = true; const loaded = name === 'models' ? import('./models') : name === 'usage' ? import('./usage') : import('./settings'); void loaded.then(value => { if (alive) setModule(value) }); return () => { alive = false } }, [name])
  if (!module) return <p role="status">{t('ui.loadingPage')}</p>; const Component = module[name === 'models' ? 'Models' : name === 'usage' ? 'Usage' : 'Settings']; return <Component summary={snapshot.summary} stats={snapshot.stats} host={host} active={active} />
}
function App() {
  const [mode, setMode] = useState<'loading' | 'login' | 'ready'>('loading'), [snapshot, setSnapshot] = useState<Snapshot>(), [page, setPage] = useState<Page>('overview'), [notice, setNotice] = useState(''), [error, setError] = useState('')
  const [visited, setVisited] = useState<Page[]>([])
  // The disclaimer reads once on the first console visit and is reopenable from
  // the sidebar. It never gates the lanes: acknowledging only writes a setting.
  const [disclaimer, setDisclaimer] = useState<{ acknowledged?: boolean } | undefined>(undefined)
  const [disclaimerOpen, setDisclaimerOpen] = useState(false)
  const generation = useRef(0), loading = useRef<Promise<void> | undefined>(undefined), authenticated = useRef(false), settingsRevision = useRef(0)
  const enterLogin = (reason = '') => { generation.current++; loading.current = undefined; authenticated.current = false; setSnapshot(undefined); setVisited([]); setPage('overview'); setError(reason); setNotice(''); setMode('login') }
  const request: Request = async (path, body, timeoutMs = 10000, signal) => { const current = generation.current; const response = await fetch(API + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: { ...body === undefined ? {} : { 'content-type': 'application/json' }, 'x-ofm-lang': locale() }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) }); const value = await response.json(); if (!response.ok) { const reason = Object.assign(new Error(value.error ?? t.format('err.requestFailedStatus', { status: response.status })), { status: response.status }); if (current === generation.current && response.status === 401 && path !== '/session') enterLogin(reason.message); throw reason } if (current !== generation.current) throw new Error(t('err.sessionChanged')); return value }
  const loadData = async () => { if (loading.current) return loading.current; const current = generation.current, revision = settingsRevision.current; const pending = Promise.all([request('/summary'), request('/stats')]).then(([summary, stats]) => { if (current !== generation.current) return; setSnapshot(previous => ({ summary: revision !== settingsRevision.current && previous ? { ...summary, settings: previous.summary.settings } : summary, stats })); authenticated.current = true; setMode('ready'); setError('') }).finally(() => { if (loading.current === pending) loading.current = undefined }); loading.current = pending; return pending }
  const host = useMemo<Host>(() => ({ navigate: next => { if (pageNames.includes(next)) { setPage(next); setVisited(previous => previous.includes(next) ? previous : [...previous, next]); setError(''); setNotice('') } }, refresh: async () => { await loadData() }, copy: async value => { await navigator.clipboard.writeText(value); setNotice(t('notice.copied')) }, getApiKey: async () => (await request<{ key: string }>('/key')).key, rotateKey: async () => (await request<{ key: string }>('/key/rotate', { confirm: true })).key, logout: async () => { await request('/logout', {}); enterLogin(t('notice.signedOut')) }, error: reason => setError(messageOf(reason)), testModel: (model, signal) => request('/models/test', { model }, 330000, signal), refreshModels: async (probe, signal) => { await request('/models/refresh', { probe }, 300000, signal); if (!signal.aborted) await loadData() }, saveSettings: async (settings: Partial<ServiceSettings>) => { const value = await request<{ settings: ServiceSettings }>('/settings', settings); settingsRevision.current++; setSnapshot(previous => previous ? { ...previous, summary: { ...previous.summary, settings: value.settings } } : previous); return value.settings } }), [page])
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [page])
  useEffect(() => { const onUnauthorized = () => enterLogin(t('err.sessionExpired')); window.addEventListener('ofm:unauthorized', onUnauthorized); return () => window.removeEventListener('ofm:unauthorized', onUnauthorized) }, [])
  useEffect(() => { const token = new URLSearchParams(location.hash.slice(1)).get('login'); if (token) history.replaceState(null, '', location.pathname + location.search); void (async () => { try { if (token) await request('/session', { bootstrapToken: token }); await loadData() } catch (reason) { enterLogin((reason as any)?.status === 401 && !token ? '' : messageOf(reason)) } })() }, [])
  useEffect(() => { if (mode !== 'ready') return; const timer = window.setInterval(() => { if (!document.hidden) void loadData().catch(reason => setError(messageOf(reason))) }, 15000); return () => window.clearInterval(timer) }, [mode])
  useEffect(() => {
    if (mode !== 'ready') return
    let alive = true
    request<{ acknowledged?: boolean }>('/disclaimer')
      .then(value => { if (alive) { setDisclaimer(value); if (value.acknowledged !== true) setDisclaimerOpen(true) } })
      .catch(() => { if (alive) setDisclaimer({ acknowledged: true }) })
    return () => { alive = false }
  }, [mode])
  const content: ReactNode = snapshot && page === 'updates' ? <DesktopUpdate /> : snapshot && page === 'routing' ? <Routing active host={host} /> : snapshot && page === 'workspace' ? <Workspace active /> : snapshot && page === 'library' ? <Library active /> : snapshot && page === 'agents' ? <Agents summary={snapshot.summary} active host={host} /> : snapshot && page === 'providers' ? <Providers active host={host} /> : snapshot && page === 'sponsor' ? <SponsorPage /> : snapshot && page === 'overview' ? <Overview {...snapshot} host={host} /> : snapshot && page === 'connection' ? <Connection summary={snapshot.summary} host={host} active /> : snapshot && (page === 'channels' || page === 'eac') ? <ChannelMount key={page} kind={page} summary={{ ...snapshot.summary, reload: () => { void loadData() } }} /> : null
  if (mode === 'loading') return <LoadingScreen />
  if (mode === 'login') return <LoginScreen request={async (...args) => { const result = await request(...args); if (args[0] === '/session') await loadData(); return result }} />
  return <div id="app" className="app-shell"><aside className="sidebar"><Sidebar page={page} summary={snapshot?.summary} host={host} onDisclaimer={() => setDisclaimerOpen(true)} /></aside><main><header className="topbar"><Topbar page={page} summary={snapshot?.summary} /></header>{snapshot?.summary.networkMode === 'fixture' && <div className="notice test-mode-notice notice-enter" role="alert">{t('notice.fixtureMode')}</div>}{notice && <div className="notice notice-enter" role="status">{notice}<button className="text-button" onClick={() => setNotice('')}>{t('action.close')}</button></div>}{error && <div className="notice error-notice notice-enter" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="text-button" onClick={() => { setError(''); void loadData() }}>{t('action.retry')}</button></div>}<section className="page">{content}{snapshot && (['models', 'usage', 'settings'] as const).filter(name => visited.includes(name)).map(name => <div key={name} hidden={page !== name}><LazyPage name={name} snapshot={snapshot} host={host} active={page === name} /></div>)}</section><footer>OUR FREE MODEL <span>·</span> {t('footer.note')}</footer></main><SponsorNotice targetId="ofm-sponsor-menu-desktop" placement="side" /><DisclaimerDialog open={disclaimerOpen} onClose={() => { setDisclaimerOpen(false); setDisclaimer(current => current ? { ...current, acknowledged: true } : current) }} /></div>
}
createRoot(document.getElementById('root')!).render(<App />)
