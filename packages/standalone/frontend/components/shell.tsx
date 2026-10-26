import { Coffee, Activity, Boxes, Cable, ChevronRight, Handshake, LayoutDashboard, LogOut, Moon, Network, Settings2, ShieldCheck, Sun, Monitor, PanelsTopLeft, LibraryBig, Route, RotateCw } from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import brandMark from '../../../../icon.svg?inline'
import { t, getLocale as locale, switchLocale } from '../i18n.mjs'
import { Badge, Button } from './ui'
import type { Host, Page, Summary } from '../types'
import { hasDesktopBridge } from '../desktop-update'

const navigation = [
  { label: t('nav.workspace'), items: [
    { id: 'overview', name: t('nav.overview'), icon: LayoutDashboard },
    { id: 'workspace', name: t('nav.workbench'), icon: PanelsTopLeft },
    { id: 'agents', name: t('nav.agents'), icon: Monitor },
    { id: 'models', name: t('nav.models'), icon: Boxes },
    { id: 'usage', name: t('nav.usage'), icon: Activity },
    { id: 'library', name: t('nav.library'), icon: LibraryBig },
  ] },
  { label: t('nav.groupChannels'), items: [
    { id: 'providers', name: t('nav.providers'), icon: PanelsTopLeft },
    { id: 'routing', name: t('nav.routing'), icon: Route },
    { id: 'channels', name: t('nav.channels'), icon: Network },
    { id: 'eac', name: t('nav.eac'), icon: Handshake },
    { id: 'connection', name: t('nav.connection'), icon: Cable },
  ] },
  { label: t('nav.groupManage'), items: [{ id: 'settings', name: t('nav.settings'), icon: Settings2 }, { id: 'updates', name: t('nav.updates'), icon: RotateCw }] },
  { label: t('nav.groupSponsor'), items: [{ id: 'sponsor', name: t('nav.sponsor'), icon: Coffee }] },
] as const

type Origin = { x: number; y: number }

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const apply = (next: 'light' | 'dark') => {
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('ofm-theme', next) } catch { /* 存储不可用时仅本次会话生效 */ }
    setTheme(next)
  }
  const toggle = (origin?: Origin) => {
    const next = theme === 'dark' ? 'light' : 'dark'
    // 没有 View Transition、或用户要求减少动效时直接切换，不做扩散。
    if (!origin || typeof document.startViewTransition !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(next); return }
    const root = document.documentElement
    // 半径取按钮中心到视口最远角的距离，保证圆盘一定盖满整屏。
    const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y))
    root.style.setProperty('--theme-reveal-x', `${origin.x}px`)
    root.style.setProperty('--theme-reveal-y', `${origin.y}px`)
    root.style.setProperty('--theme-reveal-r', `${radius}px`)
    // 扩散期间关掉 300ms 的底色过渡，否则"新主题"快照会抓到过渡中间色。
    root.classList.add('theme-transitioning')
    const transition = document.startViewTransition(() => { flushSync(() => apply(next)) })
    const finish = () => {
      root.classList.remove('theme-transitioning')
      root.style.removeProperty('--theme-reveal-x')
      root.style.removeProperty('--theme-reveal-y')
      root.style.removeProperty('--theme-reveal-r')
    }
    transition.finished.then(finish, finish)
  }
  return { theme, toggle }
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme()
  const label = theme === 'dark' ? t('nav.themeLight') : t('nav.themeDark')
  return <Button variant="ghost" className="theme-toggle" aria-label={label} title={theme === 'dark' ? t('nav.light') : t('nav.dark')}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) }}>
    <span className="theme-toggle-track" data-theme={theme}>
      <span className="theme-toggle-icon theme-toggle-sun" aria-hidden="true"><Sun size={16} /></span>
      <span className="theme-toggle-icon theme-toggle-moon" aria-hidden="true"><Moon size={16} /></span>
    </span>
  </Button>
}

/** 语言随 localStorage 持久化并由 switchLocale 重载页面，无需响应式状态。 */
export function LangToggle() {
  const next = locale() === 'zh' ? 'en' : 'zh'
  const label = next === 'en' ? t('nav.switchToEnglish') : t('nav.switchToChinese')
  return <Button variant="ghost" className="lang-toggle" aria-label={label} title={label} onClick={() => switchLocale(next)}>
    <span className={next === 'en' ? undefined : 'lang-toggle-cn'} aria-hidden="true">{next === 'en' ? 'EN' : '中'}</span>
  </Button>
}

export const pageNames: Record<Page, string> = {
  overview: t('nav.overview'), workspace: t('nav.workbench'), models: t('nav.models'), usage: t('nav.usage'), channels: t('nav.channels'),
  agents: t('nav.agents'), providers: t('nav.providers'), library: t('nav.library'), routing: t('nav.routing'),
  eac: t('nav.eac'), settings: t('nav.settings'), updates: t('nav.updates'), connection: t('nav.connection'), sponsor: t('nav.sponsor'),
}

export function Sidebar({ page, summary, host, onDisclaimer }: { page: Page; summary?: Summary; host: Host; onDisclaimer(): void }) {
  return <>
    <a className="console-brand" href="/" aria-label={t('nav.home')}>
      <img className="console-mark" src={brandMark} alt="" width={34} height={36} />
      <span>Our Free Model<small>{t('nav.subtitle')}</small></span>
    </a>
    <div className="workspace-switch"><span className="workspace-avatar"><ShieldCheck size={17} /></span>
      <span>{t('nav.personalWorkspace')}<small>{t('nav.standaloneService')}</small></span><Badge>{t('nav.localBadge')}</Badge>
    </div>
    <nav className="console-nav" aria-label={t('nav.management')}>{navigation.map(group => <div className="nav-group" key={group.label}>
      <span className="nav-group-label">{group.label}</span>
      {group.items.filter(item => item.id !== 'updates' || hasDesktopBridge()).map(item => <button key={item.id} id={item.id === 'sponsor' ? 'ofm-sponsor-menu-desktop' : undefined} className={`console-nav-item ${item.id === 'sponsor' ? 'ofm-sponsor-nav' : ''} ${page === item.id ? 'selected' : ''}`}
        aria-current={page === item.id ? 'page' : undefined} onClick={() => host.navigate(item.id)}>
        <span className="console-nav-indicator" aria-hidden="true" />
        <item.icon size={18} strokeWidth={1.7} /><span>{item.name}</span>
        {item.id === 'models' && <span className="count-badge">{summary?.catalog.length ?? '—'}</span>}
      </button>)}
    </div>)}</nav>
    <div className="sidebar-support"><ShieldCheck size={17} /><div><strong>{t('nav.localStorage')}</strong><p>{t('nav.localNote')}</p></div></div>
    <div className="console-sidebar-footer"><div><span className="status-dot" />{t('nav.serviceOnline')}<small>v{summary?.version ?? '—'}</small></div>
      <ThemeToggle /><LangToggle /><Button variant="ghost" aria-label={t('nav.logout')} title={t('nav.logout')} onClick={() => { void host.logout().catch(host.error) }}><LogOut size={16} /></Button></div>
    <button type="button" className="sidebar-disclaimer" onClick={onDisclaimer}>{t('nav.disclaimer')}</button>
  </>
}
export function Topbar({ page, summary }: { page: Page; summary?: Summary }) {
  return <><div className="console-breadcrumb"><span>{t('nav.workspace')}</span><ChevronRight size={14} /><strong key={page} className="console-breadcrumb-current">{pageNames[page]}</strong></div>
    <div className="console-topbar-status"><span className="status-dot" /><span>{summary?.settings.enabled === false ? t('nav.paused') : t('nav.localService')}</span><span className="topbar-divider" /><span>LOCAL</span></div></>
}
