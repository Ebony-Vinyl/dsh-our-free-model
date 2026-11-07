import { Coffee, Activity, BarChart3, BookOpen, Boxes, Cable, ChevronRight, Globe, Handshake, Image, LayoutDashboard, LogOut, Moon, Network, Palette, PanelsTopLeft, Puzzle, Route, RotateCw, Settings2, ShieldCheck, Sparkles, Sun, Terminal, Monitor, LibraryBig, Wrench } from 'lucide-react'
import { useState } from 'react'
import type { ComponentType } from 'react'
import { flushSync } from 'react-dom'
import brandMark from '../../../../icon.svg?inline'
import { Badge, Button } from './ui'
import type { Host, Page, PluginPage, Summary } from '../types'
import { hasDesktopBridge } from '../desktop-update'

type NavIcon = ComponentType<{ size?: number | string; strokeWidth?: number | string; className?: string }>
interface NavItem { id: Page; name: string; icon: NavIcon }
interface NavGroup { label: string; items: NavItem[] }

const CORE_NAVIGATION: NavGroup[] = [
  { label: '工作空间', items: [
    { id: 'overview', name: '概览', icon: LayoutDashboard },
    { id: 'workspace', name: '模型工作台', icon: PanelsTopLeft },
    { id: 'agents', name: '客户端与订阅', icon: Monitor },
    { id: 'models', name: '模型清单', icon: Boxes },
    { id: 'usage', name: '用量统计', icon: Activity },
    { id: 'library', name: '资源库', icon: LibraryBig },
  ] },
  { label: '渠道与连接', items: [
    { id: 'providers', name: '聚合渠道', icon: PanelsTopLeft },
    { id: 'routing', name: '路由组', icon: Route },
    { id: 'channels', name: 'EAC router', icon: Network },
    { id: 'eac', name: 'EAC 协付渠道', icon: Handshake },
    { id: 'connection', name: 'API 接入', icon: Cable },
  ] },
  { label: '管理', items: [
    { id: 'plugins', name: '插件中心', icon: Puzzle },
    { id: 'settings', name: '服务设置', icon: Settings2 },
    { id: 'updates', name: '应用更新', icon: RotateCw },
  ] },
  { label: '项目支持', items: [{ id: 'sponsor', name: '来自赞助商的广告', icon: Coffee }] },
]

const PAGE_ICONS: Record<string, NavIcon> = {
  puzzle: Puzzle,
  sparkles: Sparkles,
  chart: BarChart3,
  tool: Wrench,
  image: Image,
  globe: Globe,
  terminal: Terminal,
  book: BookOpen,
  palette: Palette,
  activity: Activity,
  boxes: Boxes,
  route: Route,
}

export const pageIcon = (name: string): NavIcon => PAGE_ICONS[name] ?? Puzzle

/**
 * The sidebar is the only list of pages — nothing may restate it.
 *
 * `navigationPages` is the core whitelist (`App` derives it from the sidebar),
 * and `pageIdsFor` appends the plugin pages the console learned from
 * `/summary`. A page that is not in either list is silently unreachable, so
 * both the shell and the host must read the same source.
 *
 * 此前 `app.tsx` 自己又写了一份同样的数组，两份一漂移就出了「模型工作台」
 * 点了没反应 —— 侧边栏有这一项、白名单里没有，`navigate('workspace')` 直接被
 * `includes` 短路（#678）。从侧边栏**推导**而不是重述，是让两份永远不可能再
 * 漂移的唯一办法。
 */
export const navigationPages: Page[] = CORE_NAVIGATION.flatMap(group => group.items.map(item => item.id))

export function pageIdsFor(pluginPages: PluginPage[] = []): Page[] {
  return [...navigationPages, ...pluginPages.map(page => page.id)]
}

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
  const label = theme === 'dark' ? '切换到浅色主题' : '切换到深色主题'
  return <Button variant="ghost" className="theme-toggle" aria-label={label} title={theme === 'dark' ? '浅色' : '深色'}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) }}>
    <span className="theme-toggle-track" data-theme={theme}>
      <span className="theme-toggle-icon theme-toggle-sun" aria-hidden="true"><Sun size={16} /></span>
      <span className="theme-toggle-icon theme-toggle-moon" aria-hidden="true"><Moon size={16} /></span>
    </span>
  </Button>
}

export const pageNames: Record<string, string> = Object.fromEntries(CORE_NAVIGATION.flatMap(group => group.items.map(item => [item.id, item.name])))

export function pageLabel(page: Page, pluginPages: PluginPage[] = []): string {
  return pluginPages.find(entry => entry.id === page)?.title ?? pageNames[page] ?? '插件页面'
}

export function Sidebar({ page, summary, host, onDisclaimer, pluginPages = [] }: { page: Page; summary?: Summary; host: Host; onDisclaimer(): void; pluginPages?: PluginPage[] }) {
  const groups: NavGroup[] = pluginPages.length === 0 ? CORE_NAVIGATION : [...CORE_NAVIGATION, {
    label: '插件',
    items: pluginPages.map(entry => ({ id: entry.id, name: entry.title, icon: pageIcon(entry.icon) })),
  }]
  return <>
    <a className="console-brand" href="/" aria-label="Our Free Model 首页">
      <img className="console-mark" src={brandMark} alt="" width={34} height={36} />
      <span>Our Free Model<small>本地模型工作台</small></span>
    </a>
    <div className="workspace-switch"><span className="workspace-avatar"><ShieldCheck size={17} /></span>
      <span>个人工作空间<small>独立本地服务</small></span><Badge>本机</Badge>
    </div>
    <nav className="console-nav" aria-label="管理导航">{groups.map(group => <div className="nav-group" key={group.label}>
      <span className="nav-group-label">{group.label}</span>
      {group.items.filter(item => item.id !== 'updates' || hasDesktopBridge()).map(item => <button key={item.id} id={item.id === 'sponsor' ? 'ofm-sponsor-menu-desktop' : undefined} className={`console-nav-item ${item.id === 'sponsor' ? 'ofm-sponsor-nav' : ''} ${page === item.id ? 'selected' : ''}`}
        aria-current={page === item.id ? 'page' : undefined} onClick={() => host.navigate(item.id)}>
        <span className="console-nav-indicator" aria-hidden="true" />
        <item.icon size={18} strokeWidth={1.7} /><span>{item.name}</span>
        {item.id === 'models' && <span className="count-badge">{summary?.catalog.length ?? '—'}</span>}
      </button>)}
    </div>)}</nav>
    <div className="sidebar-support"><ShieldCheck size={17} /><div><strong>独立本地存储</strong><p>本机运行 / 仅监听回环地址</p></div></div>
    <div className="console-sidebar-footer"><div><span className="status-dot" />本地服务在线<small>v{summary?.version ?? '—'}</small></div>
      <ThemeToggle /><Button variant="ghost" aria-label="退出管理" title="退出管理" onClick={() => { void host.logout().catch(host.error) }}><LogOut size={16} /></Button></div>
    <button type="button" className="sidebar-disclaimer" onClick={onDisclaimer}>使用须知与免责声明</button>
  </>
}
export function Topbar({ page, summary, pluginPages = [] }: { page: Page; summary?: Summary; pluginPages?: PluginPage[] }) {
  return <><div className="console-breadcrumb"><span>工作空间</span><ChevronRight size={14} /><strong key={page} className="console-breadcrumb-current">{pageLabel(page, pluginPages)}</strong></div>
    <div className="console-topbar-status"><span className="status-dot" /><span>{summary?.settings.enabled === false ? '推理已暂停' : '本地服务'}</span><span className="topbar-divider" /><span>LOCAL</span></div></>
}
