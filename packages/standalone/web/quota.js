/**
 * 积分限额页 —— 独立版管理页的补充页面（方案 A 集成的界面层）。
 *
 * 数据链：GET/POST /api/management/quota + GET /api/management/summary（拿清单）。
 * 会话与控制台共用同一个 cookie；未登录时显示 Key 输入框走 POST /session。
 *
 * @module web/quota.js
 */
'use strict'

const $ = id => document.getElementById(id)
const app = $('app')
const login = $('login')

let quota = { enabled: false, onExceed: 'deny', models: {} }
let models = []          // summary.catalog 的可路由行 {id, name, channel, routable}
let dirty = false

const toastEl = $('toast')
let toastTimer
function toast(text) {
  toastEl.textContent = text
  toastEl.classList.add('show')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200)
}

async function api(path, options = {}) {
  const response = await fetch(`/api/management${path}`, {
    redirect: 'error',
    headers: options.body !== undefined ? { 'content-type': 'application/json' } : {},
    ...options,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  let payload
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 200) } }
  if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
  return payload
}

/** 积分口径与 src/quota.js 的 usageToday 完全一致，页面预览用。 */
function creditsOf(row) {
  const input = Number(row?.input) || 0
  const output = Number(row?.output) || 0
  return Math.ceil(input + output * 1.5)
}

function fmt(n) {
  if (!Number.isFinite(Number(n)) || n <= 0) return '0'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`
  return String(Math.trunc(n))
}

function esc(value) {
  const div = document.createElement('div')
  div.textContent = String(value)
  return div.innerHTML
}

async function boot() {
  try {
    await loadSummary()
    await loadQuota()
    app.hidden = false
    render()
  } catch (error) {
    // 401 → 显示登录框；其他错误也用登录框兜底并说明原因。
    $('loginmsg').textContent = String(error?.message ?? error)
    login.hidden = false
  }
}

async function loadSummary() {
  const data = await api('/summary')
  models = (data?.catalog ?? []).filter(entry => entry.routable !== false)
  const pick = $('pick')
  pick.innerHTML = '<option value="">— 从清单选择模型 —</option>'
  for (const entry of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    const option = document.createElement('option')
    option.value = entry.id
    option.textContent = `${entry.name}（${entry.id}）`
    pick.appendChild(option)
  }
}

async function loadQuota() {
  // settings 走 summary（managementSettings 里带 quota），避免多一个读口。
  const data = await api('/summary')
  quota = data?.settings?.quota ?? { enabled: false, onExceed: 'deny', models: {} }
}

function render() {
  $('enabled').checked = quota.enabled === true
  for (const radio of document.querySelectorAll('input[name=onExceed]')) {
    radio.checked = radio.value === (quota.onExceed ?? 'deny')
  }
  renderRows()
  renderUsage()
}

function renderRows() {
  const tbody = $('rows')
  const ids = Object.keys(quota.models ?? {}).sort((a, b) => a.localeCompare(b))
  if (ids.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">还没有规则。从上方清单选择模型，或手输 id（支持 * 通配整个渠道，如 kilo/*）。</td></tr>'
    return
  }
  tbody.innerHTML = ''
  for (const id of ids) {
    const limit = quota.models[id] ?? {}
    const tr = document.createElement('tr')
    tr.innerHTML = `
      <td><span title="${esc(id)}">${esc(nameOf(id))}</span> ${id.includes('*') ? '<span class="pill">通配</span>' : ''}</td>
      <td class="muted" data-usage="${esc(id)}">…</td>
      <td class="num"><input type="number" min="0" step="1" data-field="dailyRequests" data-id="${esc(id)}" value="${limit.dailyRequests || ''}" placeholder="不限"></td>
      <td class="num"><input type="number" min="0" step="1" data-field="dailyTokens" data-id="${esc(id)}" value="${limit.dailyTokens || ''}" placeholder="不限"></td>
      <td class="num"><input type="number" min="0" step="1" data-field="dailyCredits" data-id="${esc(id)}" value="${limit.dailyCredits || ''}" placeholder="不限"></td>
      <td><button class="danger" data-remove="${esc(id)}">删除</button></td>`
    tbody.appendChild(tr)
  }
  for (const button of tbody.querySelectorAll('button[data-remove]')) {
    button.addEventListener('click', () => {
      const id = button.getAttribute('data-remove')
      delete quota.models[id]
      dirty = true
      renderRows()
    })
  }
  for (const input of tbody.querySelectorAll('input[data-field]')) {
    input.addEventListener('change', () => {
      const id = input.getAttribute('data-id')
      const field = input.getAttribute('data-field')
      const value = input.value === '' ? 0 : Number(input.value)
      if (!Number.isFinite(value) || value < 0) { input.value = ''; return }
      quota.models[id] = { ...(quota.models[id] ?? {}), [field]: Math.trunc(value) }
      dirty = true
    })
  }
}

function nameOf(id) {
  if (id.includes('*')) return id
  const hit = models.find(entry => entry.id === id)
  return hit ? `${hit.name} · ${id}` : id
}

/** 今日用量直接从 stats 端点取，逐行填；限额页不缓存它，每次渲染都刷新。 */
async function renderUsage() {
  let usage = {}
  try {
    const data = await api('/stats')
    const today = new Date()
    const y = today.getFullYear()
    const m = String(today.getMonth() + 1).padStart(2, '0')
    const d = String(today.getDate()).padStart(2, '0')
    const day = `${y}-${m}-${d}`
    const bucket = (data?.days ?? []).find(entry => entry.day === day)
    usage = bucket?.models ?? {}
  } catch { /* 用量读不到不拦配置，显示 — 即可 */ }
  for (const cell of document.querySelectorAll('[data-usage]')) {
    const id = cell.getAttribute('data-usage')
    const row = usage[id]
    if (row === undefined) { cell.textContent = '今日 0 次 · 0 tok'; continue }
    const requests = Number(row.calls) || 0
    const tokens = (Number(row.input) || 0) + (Number(row.output) || 0)
    const limit = quota.models?.[id] ?? {}
    const overRequests = (limit.dailyRequests ?? 0) > 0 && requests >= limit.dailyRequests
    const overTokens = (limit.dailyTokens ?? 0) > 0 && tokens >= limit.dailyTokens
    const overCredits = (limit.dailyCredits ?? 0) > 0 && creditsOf(row) >= limit.dailyCredits
    const over = overRequests || overTokens || overCredits
    cell.innerHTML = `<span class="${over ? 'over' : ''}">今日 ${requests} 次 · ${fmt(tokens)} tok</span>${over ? ' <span class="pill warn">已到限</span>' : ''}`
  }
}

function markSaved(node, text) {
  node.textContent = text
  setTimeout(() => { node.textContent = '' }, 2600)
}

$('enabled').addEventListener('change', () => { quota.enabled = $('enabled').checked; dirty = true })
for (const radio of document.querySelectorAll('input[name=onExceed]')) {
  radio.addEventListener('change', () => { quota.onExceed = radio.value; dirty = true })
}

$('add').addEventListener('click', () => {
  const id = ($('pick').value || $('customId').value.trim()).trim()
  if (id === '') { toast('先选一个模型，或手输模型 id'); return }
  if (quota.models?.[id] !== undefined) { toast('这个模型已经有规则了'); return }
  quota.models = { ...(quota.models ?? {}), [id]: {} }
  $('customId').value = ''
  $('pick').value = ''
  dirty = true
  renderRows()
})

$('save').addEventListener('click', async () => {
  const button = $('save')
  button.disabled = true
  $('savestate').textContent = '保存中…'
  try {
    const cleaned = {}
    for (const [id, limit] of Object.entries(quota.models ?? {})) {
      const row = {}
      for (const field of ['dailyRequests', 'dailyTokens', 'dailyCredits']) {
        const value = Number(limit?.[field])
        if (Number.isFinite(value) && value > 0) row[field] = Math.trunc(value)
      }
      cleaned[id] = row
    }
    const data = await api('/quota', { method: 'POST', body: { quota: { enabled: quota.enabled === true, onExceed: quota.onExceed ?? 'deny', models: cleaned } } })
    quota = data.quota
    dirty = false
    render()
    markSaved($('savestate'), '已保存，闸门即时生效')
  } catch (error) {
    toast(`保存失败：${error?.message ?? error}`)
    $('savestate').textContent = ''
  } finally {
    button.disabled = false
  }
})

$('loginbtn').addEventListener('click', async () => {
  const key = $('key').value.trim()
  if (key === '') { $('loginmsg').textContent = '先粘贴 API Key'; return }
  try {
    await api('/session', { method: 'POST', body: { key } })
    login.hidden = true
    await boot()
  } catch (error) {
    $('loginmsg').textContent = `登录失败：${error?.message ?? error}`
  }
})
$('key').addEventListener('keydown', event => { if (event.key === 'Enter') $('loginbtn').click() })

// 离开前提醒未保存的修改；防误关。
window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = '' }
})

boot()
