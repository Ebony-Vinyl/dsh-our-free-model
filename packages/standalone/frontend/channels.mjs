import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { shared } from 'ofm-shared-client'
import { ChannelBrowser } from './components/channel-browser'
import { bindT, getLocale, providerText } from './i18n.mjs'
import 'ofm-shared-styles.css'

const { EacAuth, useEacLogin, DICT, Tank, usePool, poolReading, capacityText, CHANNEL_PROVIDERS, LedgerPage, LogsPage } = shared
const h = React.createElement
const t = bindT(key => DICT[getLocale()][key] ?? key)
const localizedProviders = CHANNEL_PROVIDERS.map(row => ({ ...row, name: providerText(row, 'name'), org: providerText(row, 'org'), note: providerText(row, 'note') }))
let requestLifetime = new AbortController()
const ctx = {
  connection: { rpc: {
    async call(_base, _method, payload, signal) {
      const lifetime = requestLifetime.signal
      const response = await fetch('/api/management/channels/rpc', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.any([signal, lifetime]), credentials: 'same-origin',
      })
      const result = await response.json()
      lifetime.throwIfAborted()
      if (response.status === 401) window.dispatchEvent(new CustomEvent('ofm:unauthorized'))
      if (!response.ok) throw new Error(result.error ?? t('ct.rpcError'))
      return result
    },
  } },
}
async function rpc(method, payload = {}) {
  const result = await ctx.connection.rpc.call('/api', 'channel-pack', { method, payload }, AbortSignal.timeout(180000))
  if (!result.ok) throw new Error(result.error?.message ?? t('ct.rpcError'))
  return result.value
}
const lockedProviders = new Set(['loomy'])

function ChannelTools({ summary }) {
  const [provider, setProvider] = React.useState('lobsterai')
  const [status, setStatus] = React.useState()
  const [lock, setLock] = React.useState()
  const [busy, setBusy] = React.useState(false)
  const [message, setMessage] = React.useState('')
  const [accounts, setAccounts] = React.useState([])
  const [account, setAccount] = React.useState('')
  const [nickname, setNickname] = React.useState('')
  const file = React.useRef()
  const generation = React.useRef(0)
  const reload = React.useCallback(async () => {
    const started = ++generation.current
    const [statuses, value, nextLock] = await Promise.all([
      rpc('provider.status', { providers: [provider] }),
      rpc('account.list', { provider }),
      lockedProviders.has(provider) ? rpc('credits.permanentLock', { provider }) : undefined,
    ])
    if (started !== generation.current) return
    setStatus(statuses.statuses[provider])
    setAccounts(value.accounts)
    setLock(nextLock)
  }, [provider])
  React.useEffect(() => {
    setStatus(undefined); setLock(undefined); setAccounts([]); setAccount(''); setNickname(''); setMessage('')
    let active = true
    void reload().catch(error => { if (active) setMessage(error.message) })
    return () => { active = false; generation.current++ }
  }, [reload])
  const run = async action => {
    setBusy(true); setMessage('')
    try {
      await action()
      await reload()
      window.dispatchEvent(new CustomEvent('ofm:channels'))
      summary.reload?.()
      setMessage(t('ct.saved'))
    } catch (error) { setMessage(error.message) }
    finally { setBusy(false) }
  }
  const backup = async () => {
    const value = await rpc('backup.export')
    const blob = new Blob([JSON.stringify(value.payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url; link.download = `ofm-channels-${new Date().toISOString().slice(0, 10)}.json`
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 60000)
  }
  const importFile = async event => {
    const selected = event.target.files[0]
    event.target.value = ''
    if (!selected) return
    if (selected.size > 8 * 1024 * 1024) { setMessage(t('ct.backupTooBig')); return }
    if (!window.confirm(t('ct.importConfirm'))) return
    await run(async () => { await rpc('backup.import', { payload: JSON.parse(await selected.text()) }) })
  }
  return h('section', { className: 'ofm_hero', 'aria-label': t('ct.toolsHeading') },
    h('h3', null, t('ct.toolsHeading')),
    h('div', { className: 'ofm_row' },
      h('label', null, t('ct.provider') + ' ', h('select', { value: provider, disabled: busy, onChange: event => setProvider(event.target.value) },
        localizedProviders.map(row => h('option', { value: row.id, key: row.id }, row.name)))),
      h('button', { className: 'ofm_btn', disabled: busy || !status, onClick: () => run(() => rpc('provider.setEnabled', { provider, enabled: status.closed === true })) },
        status?.closed ? t('ct.enableProvider') : t('ct.disableProvider')),
      lock ? h('label', null, h('input', { type: 'checkbox', checked: lock.locked === true, disabled: busy, onChange: event => run(() => rpc('credits.permanentLock', { provider, locked: event.target.checked })) }), ' ' + t('ct.lockCredits')) : null),
    lock ? h('p', { className: 'ofm_note' }, lock.windowDays ? t.format('ct.lockWindowed', { days: lock.windowDays }) : t('ct.lockPlain')) : null,
    h('div', { className: 'ofm_row' },
      h('label', null, t('ct.account') + ' ', h('select', { value: account, disabled: busy, onChange: event => { setAccount(event.target.value); setNickname(accounts.find(row => row.id === event.target.value)?.nickname ?? '') } },
        h('option', { value: '' }, t('ct.pickAccount')),
        accounts.map(row => h('option', { value: row.id, key: row.id }, row.nickname ?? row.id)))),
      h('input', { 'aria-label': t('ct.nickname'), value: nickname, placeholder: t('ct.nickname'), disabled: !account || busy, onChange: event => setNickname(event.target.value) }),
      h('button', { className: 'ofm_btn', disabled: !account || busy, onClick: () => run(() => rpc('account.update', { accountId: account, patch: { nickname } })) }, t('ct.saveNickname')),
      h('button', { className: 'ofm_btn', disabled: !account || busy, onClick: () => run(() => rpc('account.reorder', { provider, orderedIds: [account, ...accounts.filter(row => row.id !== account).map(row => row.id)] })) }, t('ct.preferAccount')),
      h('button', { className: 'ofm_btn', disabled: !account || busy, onClick: () => run(() => rpc('account.reset', { accountId: account })) }, t('ct.resetThrottle'))),
    h('div', { className: 'ofm_row ofm_acts' },
      h('button', { className: 'ofm_btn', disabled: busy, onClick: () => run(backup) }, t('ct.exportBackup')),
      h('button', { className: 'ofm_btn', disabled: busy, onClick: () => file.current.click() }, t('ct.importBackup')),
      h('input', { ref: file, type: 'file', hidden: true, accept: '.json,application/json', onChange: importFile })),
    h('p', { className: 'ofm_note' }, t('ct.backupNote')),
    message ? h('p', { role: 'status', className: 'ofm_note' }, message) : null)
}

function ChannelConsole({ summary }) {
  const [page, setPage] = React.useState('accounts')
  return h(React.Fragment, null,
    h('header', { className: 'dashboard-heading' },
      h('div', null, h('div', { className: 'heading-eyebrow' }, 'WORKSPACE / CHANNELS'),
        h('h1', null, t('ct.heading')), h('p', null, t('ct.sub')))),
    h('div', { className: 'ofm_seg', role: 'tablist', 'aria-label': t('ct.tabsAria') },
      [['accounts', t('ct.tabAccounts')], ['ledger', t('ct.tabLedger')], ['logs', t('ct.tabLogs')], ['tools', t('ct.tabTools')]].map(([id, name]) =>
        h('button', { key: id, role: 'tab', 'aria-selected': page === id, onClick: () => setPage(id) }, name))),
    page === 'accounts' ? h(ChannelBrowser, { rpc, summary })
      : page === 'ledger' ? h(LedgerPage, { t, ctx, summary })
        : page === 'logs' ? h(LogsPage, { t, ctx, summary })
          : h(ChannelTools, { summary }))
}

function EacPage({ summary }) {
  const [auth, onAuth] = React.useState(summary.eacAuth)
  const login = useEacLogin({ t, summary, onAuth })
  const { pool } = usePool()
  const reading = pool == null ? null : poolReading(pool)
  React.useEffect(() => { login.refresh() }, [login.refresh])
  return h(React.Fragment, null,
    h('header', { className: 'dashboard-heading' },
      h('div', null, h('div', { className: 'heading-eyebrow' }, 'WORKSPACE / EAC'),
        h('h1', null, t('nav.eac')), h('p', null, t('eac.sub')))),
    h(EacAuth, { t, auth, eacLogin: login }),
    h('div', { className: 'ofm_hero' },
      h('h3', null, t('eac.poolTitle')),
      pool == null ? h('p', null, pool === undefined ? t('eac.poolLoading') : t('eac.poolUnavailable'))
        : h(React.Fragment, null,
          h(Tank, { pct: reading.pct, level: reading.level, size: 'xl' }),
          h('p', null, t.format('eac.poolLine', { inflight: pool.inflight, active: reading.active ?? t('eac.poolUnknown'), pool: pool.pool ?? t('eac.poolUnknown') })),
          h('p', null, capacityText(pool, t)))))
}

let root
export function show(kind, summary) {
  if (!root) {
    requestLifetime = new AbortController()
    root = createRoot(document.getElementById('channel-root'))
  }
  root.render(h(kind === 'eac' ? EacPage : ChannelConsole, { t, ctx, summary }))
}
export function hide() {
  requestLifetime.abort()
  if (root) { root.unmount(); root = undefined }
}
