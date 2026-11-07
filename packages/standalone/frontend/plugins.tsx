import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { AlertCircle, Boxes, Check, Download, ExternalLink, Eye, Loader2, Lock, Network, Puzzle, RefreshCw, Search, ShieldAlert, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import { Button } from './components/ui'
import type { Host, PluginPage, PluginRecord, PluginRegistryEntry, PluginUpdate, RegistryMeta, Summary } from './types'

interface Marketplace {
  installed: PluginRecord[]
  registry: { generatedAt: string; plugins: PluginRegistryEntry[] } | null
  registryError: string
  pages: PluginPage[]
  audit: { at: string; action: string; id: string; version?: string; enabled?: boolean; key?: string }[]
  updates?: PluginUpdate[]
  registryMeta?: RegistryMeta
  settings: { developerPlugins: boolean; autoUpdateExtensions: boolean }
}

type Tab = 'installed' | 'discover' | 'builtin'
type KindFilter = 'all' | 'channel' | 'enhancement' | 'page'

const KIND_LABEL: Record<string, string> = {
  channel: '渠道插件',
  enhancement: '增强插件',
  page: '页面插件',
  bundle: '组合插件',
}

const AUDIT_LABEL: Record<string, string> = {
  install: '安装',
  'install-local': '本地安装',
  uninstall: '卸载',
  'set-enabled': '启停',
  config: '配置',
  secret: '密钥',
  'self-test': '自检',
  'registry-refresh': '刷新市场',
  'auto-update': '自动更新',
}

function kindLabel(record: { kinds?: string[]; kind?: string }): string {
  const kinds = record.kinds ?? []
  if (kinds.includes('channel') && kinds.includes('page')) return '渠道 + 页面'
  if (kinds.includes('enhancement') && kinds.includes('page')) return '增强 + 页面'
  return KIND_LABEL[kinds[0] ?? record.kind ?? ''] ?? '插件'
}

function kindOf(record: { kinds?: string[]; kind?: string; type?: string }): KindFilter {
  const kinds = record.kinds ?? []
  if (kinds.includes('channel')) return 'channel'
  if (kinds.includes('enhancement')) return 'enhancement'
  if (kinds.includes('page')) return 'page'
  const type = record.type ?? record.kind ?? ''
  return type === 'channel' || type === 'enhancement' || type === 'page' ? type : 'all'
}

function stateLabel(state: string): string {
  return ({ ready: '运行中', starting: '启动中', stopped: '已停止', disabled: '已停用', pending: '等待依赖', failed: '失败' } as Record<string, string>)[state] ?? state
}

function permissionsText(record: { permissions?: { network?: string[]; secrets?: string[]; storage?: boolean } }): string {
  const permissions = record.permissions ?? {}
  const parts = []
  if ((permissions.network ?? []).length > 0) parts.push(`${permissions.network?.length} 个网络域`)
  if ((permissions.secrets ?? []).length > 0) parts.push(`${permissions.secrets?.length} 个密钥`)
  if (permissions.storage === true) parts.push('本地存储')
  return parts.length === 0 ? '无额外权限' : parts.join(' · ')
}

function permissionList(record: { permissions?: { network?: string[]; secrets?: string[]; storage?: boolean } }): string[] {
  const permissions = record.permissions ?? {}
  const rows: string[] = []
  for (const origin of permissions.network ?? []) rows.push(`网络：${origin}`)
  for (const key of permissions.secrets ?? []) rows.push(`密钥：${key}`)
  if (permissions.storage === true) rows.push('本地存储：读写该插件自己的键值空间')
  return rows
}

function defaultsOf(record: PluginRecord): Record<string, unknown> {
  const values: Record<string, unknown> = {}
  for (const field of record.config) values[field.key] = field.default
  return { ...values, ...record.values }
}

/** 签名市场的封面横幅。服务端按摘要校验字节；加载失败只是没有横幅，卡片照常。
 *  字节到位后淡入 —— 一张慢图不应该把卡片骨架撕开一个洞。 */
function PluginCover({ id, kind }: { id: string; kind: string }) {
  const [failed, setFailed] = useState(false)
  const [loaded, setLoaded] = useState(false)
  if (failed) return null
  return <div className={`plugin-cover ${kind}${loaded ? ' loaded' : ''}`}>
    <img src={`/api/management/plugins/cover?id=${encodeURIComponent(id)}`} alt="" loading="lazy" decoding="async"
      onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
  </div>
}

/** soak 倒计时的一句话：就绪的更新与仍在窗口里的更新读法不同。 */
function soakHint(update: PluginUpdate | undefined): string {
  if (update === undefined) return ''
  if (update.ready) return '已过观察窗口，点「全部更新」或单个「更新」立即安装'
  const hours = Math.max(1, Math.ceil(update.soakRemainingMs / 3_600_000))
  return `观察窗口还剩约 ${hours} 小时（新版本上线后先沉淀，防供应链投毒）；也可手动立即更新`
}

export function Plugins({ summary, host, active }: { summary: Summary; host: Host; active: boolean }) {
  const [data, setData] = useState<Marketplace>()
  const [tab, setTab] = useState<Tab>('installed')
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [installTarget, setInstallTarget] = useState<PluginRegistryEntry>()
  const [openConfig, setOpenConfig] = useState('')
  const [drafts, setDrafts] = useState<Record<string, Record<string, unknown>>>({})
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({})
  const [developerPath, setDeveloperPath] = useState('')
  const [developerAck, setDeveloperAck] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(null)

  const load = async (quiet = false) => {
    if (!quiet) setBusy(current => current === '' ? 'load' : current)
    try {
      const value = await host.request<Marketplace>('/plugins', undefined, 30_000)
      setData(value)
      setError('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '插件中心加载失败')
    } finally {
      if (!quiet) setBusy(current => current === 'load' ? '' : current)
    }
  }

  useEffect(() => { if (active) void load() }, [active])
  useEffect(() => { if (notice === '') return; const timer = window.setTimeout(() => setNotice(''), 5000); return () => window.clearTimeout(timer) }, [notice])

  const act = async (path: string, body: unknown, key: string) => {
    if (busy !== '') return
    setBusy(key)
    setError('')
    try {
      await host.request(path, body, 120_000)
      await load(true)
      // The sidebar's plugin pages come from `/summary`; refresh it so a new
      // page is clickable immediately instead of waiting for the 15s poll.
      await host.refresh()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败')
    } finally {
      setBusy('')
    }
  }

  const needle = search.trim().toLowerCase()
  const matches = (record: { name?: string; id?: string; description?: string; summary?: string; author?: string; tags?: string[] }) =>
    needle === '' || [record.name, record.id, record.description, record.summary, record.author, ...(record.tags ?? [])]
      .some(value => String(value ?? '').toLowerCase().includes(needle))

  const installed = useMemo(() => (data?.installed ?? []).filter(record => record.builtin !== true && matches(record)), [data, needle])
  const builtins = useMemo(() => (data?.installed ?? []).filter(record => record.builtin === true && matches(record)), [data, needle])
  const registryRows = data?.registry?.plugins ?? []
  const kindCounts = useMemo(() => {
    const counts: Record<KindFilter, number> = { all: registryRows.length, channel: 0, enhancement: 0, page: 0 }
    for (const entry of registryRows) counts[kindOf(entry)] += 1
    return counts
  }, [registryRows])
  const registry = useMemo(() => registryRows.filter(entry =>
    matches(entry) && (kindFilter === 'all' || kindOf(entry) === kindFilter)), [registryRows, needle, kindFilter])

  const updatesById = useMemo(() => new Map((data?.updates ?? []).map(update => [update.id, update])), [data])
  const registryMeta = data?.registryMeta
  const updateCandidates = useMemo(() => (data?.installed ?? [])
    .filter(record => record.builtin !== true)
    .filter(record => {
      const entry = registryRows.find(item => item.id === record.id)
      return entry !== undefined && entry.installed && entry.updateAvailable && entry.installable
    }), [data, registryRows])

  const openPluginPage = (record: PluginRecord, page: PluginRecord['pages'][number]) => {
    host.navigate(`plugin:${record.id}:${page.id}`)
  }

  const saveConfig = async (record: PluginRecord) => {
    const values = drafts[record.id] ?? defaultsOf(record)
    await act('/plugins/config', { id: record.id, values }, `config:${record.id}`)
    setOpenConfig('')
    setNotice('配置已保存')
  }

  const saveSecret = async (record: PluginRecord, key: string) => {
    const value = secretDrafts[`${record.id}:${key}`] ?? ''
    await act('/plugins/secret', { id: record.id, key, value }, `secret:${record.id}:${key}`)
    setSecretDrafts(current => ({ ...current, [`${record.id}:${key}`]: '' }))
    setNotice('密钥已保存')
  }

  const selfTest = async (record: PluginRecord) => {
    if (busy !== '') return
    setBusy(`self:${record.id}`)
    try {
      const result = await host.request<{ ok: boolean; message: string }>('/plugins/self-test', { id: record.id }, 60_000)
      setNotice(result.ok ? `自检通过${result.message ? '：' + result.message : ''}` : `自检未通过：${result.message}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '自检失败')
    } finally {
      setBusy('')
    }
  }

  const installLocal = async () => {
    if (developerPath.trim() === '' || !developerAck) return
    await act('/plugins/install-local', { path: developerPath.trim(), acknowledgeUnsigned: true }, 'install-local')
    setDeveloperPath('')
    setDeveloperAck(false)
  }

  const toggleDeveloper = async () => {
    if (data === undefined || busy !== '') return
    setBusy('developer')
    try {
      await host.saveSettings({ developerPlugins: data.settings.developerPlugins !== true })
      await load(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置保存失败')
    } finally {
      setBusy('')
    }
  }

  const toggleAutoUpdate = async () => {
    if (data === undefined || busy !== '') return
    setBusy('autoupdate')
    try {
      await host.saveSettings({ autoUpdateExtensions: data.settings.autoUpdateExtensions !== true })
      await load(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '设置保存失败')
    } finally {
      setBusy('')
    }
  }

  const refreshRegistry = async () => {
    if (busy !== '') return
    setBusy('refresh')
    setError('')
    try {
      await host.request('/plugins/registry/refresh', {}, 60_000)
      await load(true)
      setNotice('插件市场已刷新')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '市场刷新失败')
    } finally {
      setBusy('')
    }
  }

  /** 迁移助手：导出已安装清单（id、版本、启停、配置；密钥永不导出）。 */
  const exportShelf = () => {
    const installedAll = data?.installed ?? []
    if (installedAll.length === 0) { setNotice('还没有可导出的插件'); return }
    const shelf = {
      version: 1,
      exportedAt: new Date().toISOString(),
      host: summary?.version ?? '',
      plugins: installedAll.filter(record => record.builtin !== true).map(record => ({
        id: record.id,
        version: record.version,
        enabled: record.enabled === true,
        config: record.values ?? {},
      })),
    }
    const blob = new Blob([JSON.stringify(shelf, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `ofm-plugins-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    setNotice('插件清单已导出（JSON，不含密钥）')
  }

  /** 迁移助手：按清单逐个从签名市场重装并恢复配置；一个失败不拖累其余。 */
  const importShelf = async (file: File) => {
    if (busy !== '') return
    let shelf: { plugins?: { id?: unknown; enabled?: unknown; config?: unknown }[] }
    try { shelf = JSON.parse(await file.text()) } catch { setError('清单文件不是有效的 JSON'); return }
    const entries = Array.isArray(shelf?.plugins)
      ? shelf.plugins.filter(row => row !== null && typeof row === 'object' && typeof row.id === 'string')
      : []
    if (entries.length === 0) { setError('清单里没有可安装的插件'); return }
    setBusy('import')
    setError('')
    let restored = 0
    let failed = 0
    try {
      for (const entry of entries) {
        try {
          await host.request('/plugins/install', { id: entry.id }, 120_000)
          if (entry.config !== null && typeof entry.config === 'object' && !Array.isArray(entry.config)) {
            await host.request('/plugins/config', { id: entry.id, values: entry.config }, 30_000)
          }
          if (entry.enabled === true) await host.request('/plugins/toggle', { id: entry.id, enabled: true }, 60_000)
          restored += 1
        } catch {
          failed += 1
        }
      }
      await load(true)
      await host.refresh()
      setNotice(`已恢复 ${restored} 个插件${failed > 0 ? `，${failed} 个失败（可能已下架或不兼容）` : ''}`)
    } finally {
      setBusy('')
    }
  }

  /** 全部更新：逐个装，一个被拒绝不拖累其余 —— 与 DSH 控制台同一契约。 */
  const updateAll = async () => {
    if (busy !== '' || updateCandidates.length === 0) return
    setBusy('update-all')
    setError('')
    setUpdateProgress({ done: 0, total: updateCandidates.length })
    let failed = 0
    try {
      let done = 0
      for (const record of updateCandidates) {
        try {
          await host.request('/plugins/install', { id: record.id }, 120_000)
        } catch {
          failed += 1
        }
        done += 1
        setUpdateProgress({ done, total: updateCandidates.length })
      }
      await load(true)
      setNotice(`已更新 ${updateCandidates.length - failed} 个插件${failed > 0 ? `，${failed} 个失败` : ''}`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '更新失败')
    } finally {
      setBusy('')
      setUpdateProgress(null)
    }
  }

  const renderConfig = (record: PluginRecord) => {
    const values = drafts[record.id] ?? defaultsOf(record)
    const set = (key: string, value: unknown) => setDrafts(current => ({ ...current, [record.id]: { ...values, [key]: value } }))
    return <div className="plugin-config">
      {record.config.length === 0 && <p className="plugin-muted">这个插件没有可配置项。</p>}
      {record.config.map(field => <label className="plugin-field" key={field.key}>
        <span>{field.label}{field.description ? <small>{field.description}</small> : null}</span>
        {field.type === 'toggle'
          ? <input type="checkbox" checked={values[field.key] === true} onChange={event => set(field.key, event.target.checked)} />
          : field.type === 'select'
            ? <select value={String(values[field.key] ?? '')} onChange={event => set(field.key, event.target.value)}>
              {(field.options ?? []).map(option => <option value={option} key={option}>{option}</option>)}
            </select>
            : <input type={field.type === 'number' ? 'number' : field.type === 'password' ? 'password' : 'text'}
              value={String(values[field.key] ?? '')} onChange={event => set(field.key, field.type === 'number' ? Number(event.target.value) : event.target.value)} />}
      </label>)}
      <div className="plugin-actions"><Button onClick={() => { void saveConfig(record) }} disabled={busy !== ''}>{busy === `config:${record.id}` ? '保存中…' : '保存配置'}</Button>
        <Button variant="ghost" onClick={() => setOpenConfig('')}>收起</Button></div>
    </div>
  }

  const renderSecrets = (record: PluginRecord) => record.secrets.length === 0 ? null : <div className="plugin-secrets">
    {record.secrets.map(secret => <label className="plugin-field" key={secret.key}>
      <span>{secret.key}<small>{secret.hasValue ? `已保存 ${secret.hint}` : '尚未设置'}</small></span>
      <div className="plugin-secret-row">
        <input type="password" autoComplete="off" placeholder={secret.hasValue ? '输入新值以替换' : '输入密钥'}
          value={secretDrafts[`${record.id}:${secret.key}`] ?? ''}
          onChange={event => setSecretDrafts(current => ({ ...current, [`${record.id}:${secret.key}`]: event.target.value }))} />
        <Button onClick={() => { void saveSecret(record, secret.key) }} disabled={busy !== ''}>保存</Button>
      </div>
    </label>)}
  </div>

  const renderInstalledCard = (record: PluginRecord, index: number) => {
    const update = data?.registry?.plugins.find(entry => entry.id === record.id)
    const pages = record.pages ?? []
    const kind = kindOf(record)
    return <article className={`plugin-card kind-${kind}`} key={record.id} style={{ '--i': String(index) } as CSSProperties}>
      {update?.cover !== undefined && <PluginCover id={record.id} kind={kind} />}
      <header>
        <span className="plugin-icon"><Puzzle size={18} /></span>
        <div className="plugin-title"><strong>{record.name}</strong>
          <span className="plugin-sub">{record.id} · v{record.version} · {kindLabel(record)}</span>
        </div>
        <span className={`plugin-state ${record.state}`}>{record.builtin ? '内置' : stateLabel(record.state)}</span>
      </header>
      {record.description && <p className="plugin-description">{record.description}</p>}
      <div className="plugin-meta">
        <span>{permissionsText(record)}</span>
        {record.modelCount !== undefined && <span>{record.modelCount} 个模型</span>}
        {record.pageCount > 0 && <span>{record.pageCount} 个页面</span>}
        {record.source === 'local' && <span className="plugin-badge warning">开发者包</span>}
        {record.verified === false && <span className="plugin-badge warning">未验证</span>}
      </div>
      {record.error && <p className="plugin-error"><AlertCircle size={14} />{record.error}</p>}
      <div className="plugin-actions">
        {pages.map(page => <Button key={page.id} onClick={() => openPluginPage(record, page)}><ExternalLink size={14} />打开 {page.title}</Button>)}
        {!record.builtin && <Button variant={record.enabled ? 'ghost' : 'default'} onClick={() => { void act('/plugins/toggle', { id: record.id, enabled: !record.enabled }, `toggle:${record.id}`) }} disabled={busy !== ''}>
          {record.enabled ? '停用' : '启用'}
        </Button>}
        {record.config.length > 0 && <Button variant="ghost" onClick={() => setOpenConfig(openConfig === record.id ? '' : record.id)}>{openConfig === record.id ? '收起配置' : '配置'}</Button>}
        {record.selfTestAvailable && <Button variant="ghost" onClick={() => { void selfTest(record) }} disabled={busy !== ''}>{busy === `self:${record.id}` ? '自检中…' : '自检'}</Button>}
        {update?.updateAvailable && update.installable && <Button onClick={() => setInstallTarget(update)}>更新到 v{update.version}</Button>}
      {update?.updateAvailable && <p className="plugin-soak">{(update.changelog ?? [])[0] ?? ''}{(update.changelog ?? []).length > 0 ? ' · ' : ''}{soakHint(updatesById.get(record.id))}</p>}
        {!record.builtin && <Button variant="ghost" className="danger" onClick={() => { if (window.confirm(`卸载 ${record.name}？它的配置、密钥与本地存储会一起删除。`)) void act('/plugins/uninstall', { id: record.id }, `uninstall:${record.id}`) }} disabled={busy !== ''}>
          <Trash2 size={14} />卸载
        </Button>}
      </div>
      {openConfig === record.id && renderConfig(record)}
      {renderSecrets(record)}
    </article>
  }

  const renderRegistryCard = (entry: PluginRegistryEntry, index: number) => {
    const kind = kindOf(entry)
    return <article className={`plugin-card kind-${kind}`} key={entry.id} style={{ '--i': String(index) } as CSSProperties}>
      {entry.cover !== undefined && <PluginCover id={entry.id} kind={kind} />}
      <header>
        <span className="plugin-icon"><Puzzle size={18} /></span>
        <div className="plugin-title"><strong>{entry.name}</strong>
          <span className="plugin-sub">{entry.id} · v{entry.version} · {kindLabel(entry)}</span>
        </div>
        {entry.installed && <span className="plugin-state ready">{entry.updateAvailable ? '可更新' : '已安装'}</span>}
      </header>
      {entry.summary && <p className="plugin-description">{entry.summary}</p>}
      <div className="plugin-meta">
        <span>{permissionsText(entry)}</span>
        {entry.pages.length > 0 && <span>{entry.pages.length} 个页面</span>}
        {entry.author && <button type="button" className="plugin-meta-btn" title={`查看 ${entry.author} 的其他插件`} onClick={() => { setTab('discover'); setSearch(entry.author ?? '') }}>{entry.author}</button>}
        {(entry.tags ?? []).slice(0, 3).map(tag => <button type="button" className="plugin-tag" key={tag} onClick={() => { setTab('discover'); setSearch(tag) }}>{tag}</button>)}
      </div>
      <div className="plugin-actions">
        {!entry.installed && <Button onClick={() => setInstallTarget(entry)} disabled={!entry.installable || busy !== ''}>{entry.installable ? <><Download size={14} />安装</> : '当前版本不兼容'}</Button>}
        {entry.installed && entry.updateAvailable && <Button onClick={() => setInstallTarget(entry)} disabled={!entry.installable || busy !== ''}>更新到 v{entry.version}</Button>}
        {entry.installed && !entry.updateAvailable && <span className="plugin-muted"><Check size={14} />已是最新</span>}
      </div>
    </article>
  }

  const renderBuiltinCard = (record: PluginRecord, index: number) => <article className="plugin-card builtin" key={record.id} style={{ '--i': String(index) } as CSSProperties}>
    <header>
      <span className="plugin-icon"><Boxes size={18} /></span>
      <div className="plugin-title"><strong>{record.name}</strong><span className="plugin-sub">{record.id} · {kindLabel(record)}</span></div>
      <span className="plugin-state ready">内置</span>
    </header>
    {record.description && <p className="plugin-description">{record.description}</p>}
    <div className="plugin-meta">
      {record.modelCount !== undefined && record.modelCount > 0 && <span>{record.modelCount} 项贡献</span>}
      <span>{record.provides?.join(' · ') || '内核组成'}</span>
    </div>
  </article>

  const skeleton = (count = 6) => <div className="plugin-grid" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <div className="plugin-skel" key={index} style={{ '--i': String(index) } as CSSProperties}>
      <i style={{ width: '44%' }} /><i style={{ width: '72%' }} /><i style={{ width: '88%' }} /><i style={{ width: '56%' }} />
    </div>)}
  </div>

  const clearFilters = () => { setSearch(''); setKindFilter('all') }
  const filtersActive = needle !== '' || kindFilter !== 'all'

  return <section className="plugins-page" data-testid="plugins-page">
    <header className="plugins-header">
      <div><span className="eyebrow">PLUGIN CENTER</span><h1>插件中心</h1>
        <p>渠道、增强与页面都走同一套签名清单、权限与沙箱；内置能力也在这里登记。</p></div>
      <div className="plugin-actions">
        <Button variant="ghost" onClick={() => void load()} disabled={busy !== ''}><RefreshCw size={14} />刷新</Button>
        <Button variant="ghost" onClick={() => void refreshRegistry()} disabled={busy !== ''}>{busy === 'refresh' ? <Loader2 className="spin" size={14} /> : <RefreshCw size={14} />}刷新市场</Button>
        <label className="plugin-import" title="从清单文件恢复插件（不含密钥）">
          <input type="file" accept="application/json,.json" disabled={busy !== ''} hidden
            onChange={event => { const file = event.target.files?.[0]; if (file !== undefined) void importShelf(file); event.target.value = '' }} />
          <Upload size={14} />导入清单
        </label>
        <Button variant="ghost" onClick={exportShelf} disabled={busy !== ''} title="导出已安装插件与配置（不含密钥）"><Download size={14} />导出清单</Button>
        <Button onClick={() => void updateAll()} disabled={busy !== '' || updateProgress !== null || updateCandidates.length === 0} title={updateCandidates.length === 0 ? '没有可更新的插件' : undefined}>
          {updateProgress !== null ? `更新中 ${updateProgress.done}/${updateProgress.total}` : `全部更新${updateCandidates.length > 0 ? `（${updateCandidates.length}）` : ''}`}
        </Button>
      </div>
      <div className="plugins-subrow">
        <label className="plugin-switch" title="注册表定时刷新时，自动安装已过观察窗口且处于启用状态的更新">
          <input type="checkbox" checked={data?.settings.autoUpdateExtensions === true} onChange={() => void toggleAutoUpdate()} disabled={busy !== ''} /><span>自动更新插件</span>
        </label>
        {registryMeta?.source ? <span className="plugin-source" title={`索引来源：${registryMeta.source} · 生成于 ${registryMeta.generatedAt || '—'}`}>
          索引来源 {registryMeta.source === 'bundled' ? '本地内置快照' : (() => { try { return new URL(registryMeta.source).hostname } catch { return registryMeta.source } })()}
        </span> : null}
      </div>
    </header>

    {error && <div className="notice error-notice" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    {notice && <div className="notice" role="status">{notice}<button className="text-button" onClick={() => setNotice('')}>关闭</button></div>}
    {data?.registryError && <div className="notice" role="status"><ShieldAlert size={16} /><span>市场暂不可用，正在显示本地缓存：{data.registryError}</span></div>}

    <div className="plugins-toolbar">
      <div className="plugin-tabs" role="tablist">
        {([['installed', `已安装 ${installed.length}`], ['discover', '发现'], ['builtin', `内置 ${builtins.length}`]] as [Tab, string][]).map(([id, label]) =>
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'selected' : ''} onClick={() => setTab(id)}>{label}</button>)}
      </div>
      <label className="plugin-search"><Search size={15} /><input type="search" placeholder="搜索插件（名称、ID、作者、标签）" value={search} onChange={event => setSearch(event.target.value)} /></label>
    </div>

    {tab === 'discover' && <div className="plugin-kindbar" role="group" aria-label="按类型筛选">
      {([['all', '全部'], ['channel', '渠道'], ['enhancement', '增强'], ['page', '页面']] as [KindFilter, string][]).map(([id, label]) =>
        <button key={id} type="button" aria-pressed={kindFilter === id} className={kindFilter === id ? 'selected' : ''}
          onClick={() => setKindFilter(id)}>{label}<span className="plugin-kindcount">{kindCounts[id]}</span></button>)}
      {filtersActive && <button type="button" className="plugin-clear" onClick={clearFilters}><X size={13} />清除筛选</button>}
    </div>}

    {data === undefined ? skeleton()
      : tab === 'installed' && <div className="plugin-grid">
        {installed.length === 0
          ? <p className="plugin-empty">{filtersActive ? <>没有匹配的插件。<button className="text-button" onClick={clearFilters}>清除筛选</button></> : '还没有安装插件。到“发现”里挑一个，或在下方用开发者模式安装本地包。'}</p>
          : installed.map(renderInstalledCard)}
      </div>}
    {data !== undefined && tab === 'discover' && <div className="plugin-grid">
      {registry.length === 0
        ? <p className="plugin-empty">{filtersActive ? <>没有匹配的插件。<button className="text-button" onClick={clearFilters}>清除筛选</button></> : '市场为空。'}</p>
        : registry.map(renderRegistryCard)}
    </div>}
    {data !== undefined && tab === 'builtin' && <div className="plugin-grid">
      {builtins.length === 0 ? <p className="plugin-empty">没有匹配的内置能力。</p> : builtins.map(renderBuiltinCard)}
    </div>}

    <section className="plugin-developer">
      <header><div><h2>开发者模式</h2><p>从本机目录安装未签名的插件包，用于自研与调试。安装后仍运行在同一沙箱里，但会显示“未验证”。</p></div>
        <label className="plugin-switch"><input type="checkbox" checked={data?.settings.developerPlugins === true} onChange={() => void toggleDeveloper()} disabled={busy !== ''} /><span>允许本地未签名插件</span></label>
      </header>
      {data?.settings.developerPlugins === true && <div className="plugin-developer-form">
        <label className="plugin-field"><span>插件目录<small>目录内必须有 ofm-plugin.json，并在 files 中列出全部文件</small></span>
          <input type="text" placeholder="D:\\plugins\\my-plugin" value={developerPath} onChange={event => setDeveloperPath(event.target.value)} /></label>
        <label className="plugin-check"><input type="checkbox" checked={developerAck} onChange={event => setDeveloperAck(event.target.checked)} /><span>我理解未签名插件不受市场审核与签名保护，仅安装我信任的代码。</span></label>
        <Button onClick={() => void installLocal()} disabled={busy !== '' || developerPath.trim() === '' || !developerAck}><Upload size={14} />安装本地插件</Button>
      </div>}
    </section>

    <section className="plugin-audit">
      <h2>最近操作</h2>
      {data === undefined || data.audit.length === 0 ? <p className="plugin-muted">暂无记录。</p> : <ul>{data.audit.slice().reverse().slice(0, 20).map((entry, index) =>
        <li key={`${entry.at}-${index}`}><span>{new Date(entry.at).toLocaleString()}</span><strong>{AUDIT_LABEL[entry.action] ?? entry.action}</strong><code>{entry.id}</code>{entry.version && <span>v{entry.version}</span>}{entry.enabled !== undefined && <span>{entry.enabled ? '启用' : '停用'}</span>}</li>)}</ul>}
    </section>

    {installTarget !== undefined && <div className="plugin-modal-backdrop" role="presentation" onClick={() => setInstallTarget(undefined)}>
      <div className="plugin-modal" role="dialog" aria-modal="true" aria-label="安装插件" onClick={event => event.stopPropagation()}>
        <header><h2>{installTarget.installed ? '更新' : '安装'} {installTarget.name}</h2><button className="text-button" onClick={() => setInstallTarget(undefined)} aria-label="关闭"><X size={16} /></button></header>
        <div className="plugin-modal-band">
          <span className={`plugin-kindchip kind-${kindOf(installTarget)}`}>{KIND_LABEL[kindOf(installTarget)]}</span>
          {installTarget.cover !== undefined && <img className="plugin-modal-cover" src={`/api/management/plugins/cover?id=${encodeURIComponent(installTarget.id)}`} alt="" />}
        </div>
        <p className="plugin-sub">{installTarget.id} · v{installTarget.version} · {installTarget.author || '未知作者'}</p>
        {installTarget.summary && <p>{installTarget.summary}</p>}
        {(installTarget.tags ?? []).length > 0 && <div className="plugin-meta">{(installTarget.tags ?? []).map(tag => <span className="plugin-tag" key={tag}>{tag}</span>)}</div>}
        <div className="plugin-modal-facts">
          {installTarget.license && <span><ShieldCheck size={13} />{installTarget.license}</span>}
          {typeof installTarget.publishedAt === 'string' && installTarget.publishedAt !== '' && <span><Eye size={13} />发布于 {new Date(installTarget.publishedAt).toLocaleDateString()}</span>}
          {(installTarget.models?.length ?? 0) > 0 && <span><Puzzle size={13} />{installTarget.models?.length} 个模型</span>}
          {installTarget.pages.length > 0 && <span><ExternalLink size={13} />{installTarget.pages.length} 个页面</span>}
        </div>
        {(installTarget.models ?? []).length > 0 && <div className="plugin-models">
          {installTarget.models?.slice(0, 12).map(model => <span className="plugin-model" key={model.id} title={model.id}>{model.name ?? model.id}</span>)}
          {(installTarget.models?.length ?? 0) > 12 && <span className="plugin-muted">+{installTarget.models!.length - 12}</span>}
        </div>}
        <div className="plugin-permissions">
          <strong>这个插件会获得</strong>
          {permissionList(installTarget).length === 0 ? <p className="plugin-muted"><ShieldCheck size={14} />无额外权限。</p> : <ul>{permissionList(installTarget).map(row => <li key={row}>{row.startsWith('网络') ? <Network size={12} /> : row.startsWith('密钥') ? <Lock size={12} /> : null}{row}</li>)}</ul>}
        </div>
        {(installTarget.changelog ?? []).length > 0 && <div className="plugin-changelog">
          <strong>更新内容</strong>
          <ul>{installTarget.changelog?.map((row, index) => <li key={index} className={index === 0 ? 'latest' : ''}>{row}</li>)}</ul>
        </div>}
        <p className="plugin-muted">安装前会校验签名市场给出的文件大小与 SHA-256，并在写入前做静态扫描。</p>
        {(installTarget.homepage || installTarget.repository || installTarget.sourceUrl) && <div className="plugin-actions">
          {installTarget.sourceUrl && <a className="plugin-link" href={installTarget.sourceUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />查看源码</a>}
          {installTarget.homepage && <a className="plugin-link" href={installTarget.homepage} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />主页</a>}
          {installTarget.repository && <a className="plugin-link" href={installTarget.repository} target="_blank" rel="noopener noreferrer"><ExternalLink size={13} />源码仓库</a>}
        </div>}
        <div className="plugin-actions"><Button onClick={() => { void act('/plugins/install', { id: installTarget.id }, `install:${installTarget.id}`).then(() => setInstallTarget(undefined)) }} disabled={busy !== ''}>
          {busy.startsWith('install:') ? <Loader2 className="spin" size={14} /> : <Download size={14} />}{installTarget.installed ? '确认更新' : '确认安装'}
        </Button><Button variant="ghost" onClick={() => setInstallTarget(undefined)}>取消</Button></div>
      </div>
    </div>}
  </section>
}
