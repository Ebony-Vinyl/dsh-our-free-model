import { Activity, Boxes, Cable, ChevronRight, Handshake, LayoutDashboard, LogOut, Moon, Network, Settings2, ShieldCheck, Sun } from 'lucide-react'
import { useState } from 'react'
import { flushSync } from 'react-dom'
import brandMark from '../../../../icon.svg?inline'
import { Badge, Button } from './ui'
import type { Host, Page, Summary } from '../types'

const navigation = [
  { label: 'Ruang kerja', items: [
    { id: 'overview', name: 'Ringkasan', icon: LayoutDashboard },
    { id: 'models', name: 'Daftar model', icon: Boxes },
    { id: 'usage', name: 'Statistik pemakaian', icon: Activity },
  ] },
  { label: 'Kanal & koneksi', items: [
    { id: 'channels', name: 'Kanal akun gratis', icon: Network },
    { id: 'eac', name: 'Kanal patungan EAC', icon: Handshake },
    { id: 'connection', name: 'Akses API', icon: Cable },
  ] },
  { label: 'Manajemen', items: [{ id: 'settings', name: 'Pengaturan layanan', icon: Settings2 }] },
] as const

type Origin = { x: number; y: number }

function useTheme() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const apply = (next: 'light' | 'dark') => {
    document.documentElement.dataset.theme = next
    try { localStorage.setItem('ofm-theme', next) } catch { /* bila penyimpanan tidak tersedia, berlaku untuk sesi ini saja */ }
    setTheme(next)
  }
  const toggle = (origin?: Origin) => {
    const next = theme === 'dark' ? 'light' : 'dark'
    // Tanpa View Transition, atau bila pengguna meminta animasi dikurangi, ganti langsung tanpa efek sebar.
    if (!origin || typeof document.startViewTransition !== 'function'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(next); return }
    const root = document.documentElement
    // Radius diambil dari pusat tombol ke sudut terjauh viewport agar lingkaran menutup seluruh layar.
    const radius = Math.hypot(Math.max(origin.x, window.innerWidth - origin.x), Math.max(origin.y, window.innerHeight - origin.y))
    root.style.setProperty('--theme-reveal-x', `${origin.x}px`)
    root.style.setProperty('--theme-reveal-y', `${origin.y}px`)
    root.style.setProperty('--theme-reveal-r', `${radius}px`)
    // Selama transisi, matikan transisi warna latar 300ms; jika tidak, snapshot "tema baru" menangkap warna tengah transisi.
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
  const label = theme === 'dark' ? 'Beralih ke tema terang' : 'Beralih ke tema gelap'
  return <Button variant="ghost" className="theme-toggle" aria-label={label} title={theme === 'dark' ? 'Terang' : 'Gelap'}
    onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); toggle({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }) }}>
    <span className="theme-toggle-track" data-theme={theme}>
      <span className="theme-toggle-icon theme-toggle-sun" aria-hidden="true"><Sun size={16} /></span>
      <span className="theme-toggle-icon theme-toggle-moon" aria-hidden="true"><Moon size={16} /></span>
    </span>
  </Button>
}

export const pageNames: Record<Page, string> = {
  overview: 'Ringkasan', models: 'Daftar model', usage: 'Statistik pemakaian', channels: 'Kanal akun gratis',
  eac: 'Kanal patungan EAC', settings: 'Pengaturan layanan', connection: 'Akses API',
}

export function Sidebar({ page, summary, host }: { page: Page; summary?: Summary; host: Host }) {
  return <>
    <a className="console-brand" href="/" aria-label="Beranda Our Free Model">
      <img className="console-mark" src={brandMark} alt="" width={34} height={36} />
      <span>Our Free Model<small>Meja kerja model lokal</small></span>
    </a>
    <div className="workspace-switch"><span className="workspace-avatar"><ShieldCheck size={17} /></span>
      <span>Ruang kerja pribadi<small>Layanan lokal mandiri</small></span><Badge>Lokal</Badge>
    </div>
    <nav className="console-nav" aria-label="Navigasi manajemen">{navigation.map(group => <div className="nav-group" key={group.label}>
      <span className="nav-group-label">{group.label}</span>
      {group.items.map(item => <button key={item.id} className={`console-nav-item ${page === item.id ? 'selected' : ''}`}
        aria-current={page === item.id ? 'page' : undefined} onClick={() => host.navigate(item.id)}>
        <span className="console-nav-indicator" aria-hidden="true" />
        <item.icon size={18} strokeWidth={1.7} /><span>{item.name}</span>
        {item.id === 'models' && <span className="count-badge">{summary?.catalog.length ?? '—'}</span>}
      </button>)}
    </div>)}</nav>
    <div className="sidebar-support"><ShieldCheck size={17} /><div><strong>Penyimpanan lokal mandiri</strong><p>Berjalan lokal / hanya mendengarkan loopback</p></div></div>
    <div className="console-sidebar-footer"><div><span className="status-dot" />Layanan lokal daring<small>v{summary?.version ?? '—'}</small></div>
      <ThemeToggle /><Button variant="ghost" aria-label="Keluar dari manajemen" title="Keluar dari manajemen" onClick={() => { void host.logout().catch(host.error) }}><LogOut size={16} /></Button></div>
  </>
}
export function Topbar({ page, summary }: { page: Page; summary?: Summary }) {
  return <><div className="console-breadcrumb"><span>Ruang kerja</span><ChevronRight size={14} /><strong key={page} className="console-breadcrumb-current">{pageNames[page]}</strong></div>
    <div className="console-topbar-status"><span className="status-dot" /><span>{summary?.settings.enabled === false ? 'Inferensi dijeda' : 'Layanan lokal'}</span><span className="topbar-divider" /><span>LOCAL</span></div></>
}
