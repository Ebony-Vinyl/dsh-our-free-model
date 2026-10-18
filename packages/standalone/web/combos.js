/**
 * Auto 路由（模型链）配置页 —— 独立版管理页的补充页面。
 *
 * 数据链：GET/POST /api/management/combos + GET /api/management/combos/preview。
 * 契约与桌面版一致：POST 是全量替换（新增 = [...l, row]，删除 = l.filter(...)）。
 * 会话与控制台共用同一个 cookie；未登录时显示 Key 输入框走 POST /session。
 *
 * @module web/combos.js
 */
'use strict'

const $ = id => document.getElementById(id)
const app = $('app')
const login = $('login')

let combos = []   // normalizeCombos 形状：{id,name,models,strategy,stickyLimit,enabled}
let models = []   // summary.catalog 可挂链候选 {id,name,channel,vision,contextWindow,maxOutput}
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

function esc(value) {
  const div = document.createElement('div')
  div.textContent = String(value)
  return div.innerHTML
}

function nameOf(id) {
  const hit = models.find(entry => entry.id === id)
  return hit ? `${hit.name} · ${id}` : id
}

async function boot() {
  try {
    const [comboData, summaryData] = await Promise.all([api('/combos'), api('/summary')])
    combos = Array.isArray(comboData.combos) ? comboData.combos : []
    models = (summaryData?.catalog ?? []).filter(entry => entry.routable !== false && entry.id !== 'combo')
    app.hidden = false
    render()
  } catch (error) {
    $('loginmsg').textContent = String(error?.message ?? error)
    login.hidden = false
  }
}

function render() {
  renderChains()
}

function memberSelect(value) {
  const options = ['<option value="">— 选择模型 —</option>']
  for (const entry of [...models].sort((a, b) => a.id.localeCompare(b.id))) {
    options.push(`<option value="${esc(entry.id)}"${entry.id === value ? ' selected' : ''}>${esc(entry.name)}（${esc(entry.id)}）</option>`)
  }
  return options.join('')
}

function renderChains() {
  const wrap = $('chains')
  if (combos.length === 0) {
    wrap.innerHTML = '<div class="card muted">还没有模型链。点「＋ 新建链」创建第一条——比如把「免费大杯」放链头、「免费中杯」兜底。</div>'
    return
  }
  wrap.innerHTML = ''
  combos.forEach((combo, index) => {
    const card = document.createElement('div')
    card.className = 'card'
    card.dataset.index = String(index)
    const members = combo.models.map((mid, mi) => `
      <div class="member-row" data-mi="${mi}">
        <span class="ord">${mi + 1}.</span>
        <select data-member="${mi}">${memberSelect(mid)}</select>
        <button class="iconbtn" data-up="${mi}"${mi === 0 ? ' disabled' : ''}>↑</button>
        <button class="iconbtn" data-down="${mi}"${mi === combo.models.length - 1 ? ' disabled' : ''}>↓</button>
        <button class="iconbtn danger" data-del-member="${mi}">移除</button>
        <span class="mid">${esc(mid)}</span>
      </div>`).join('')
    card.innerHTML = `
      <div class="row" style="margin-bottom:10px">
        <input type="text" class="chain-name" data-name value="${esc(combo.name)}" placeholder="链名称">
        <span class="pill">${esc(combo.id)}</span>
        <label class="inline"><input type="checkbox" data-enabled${combo.enabled !== false ? ' checked' : ''}> 启用</label>
        <span class="grow"></span>
        <button class="danger" data-del-chain>删除整条链</button>
      </div>
      <div class="row" style="margin-bottom:8px">
        <label class="inline">策略：
          <select data-strategy>
            <option value="fallback"${combo.strategy !== 'round-robin' ? ' selected' : ''}>fallback（链头优先）</option>
            <option value="round-robin"${combo.strategy === 'round-robin' ? ' selected' : ''}>round-robin（轮换起点）</option>
          </select>
        </label>
        <label class="inline" data-sticky-row style="${combo.strategy === 'round-robin' ? '' : 'display:none'}">驻留轮数：
          <input type="number" data-sticky min="1" max="100" value="${combo.stickyLimit ?? 1}">
        </label>
      </div>
      <h2>成员顺序（失败按此顺序换手）</h2>
      <div data-members>${members}</div>
      <div class="row cap">
        <select data-add-member>${memberSelect('')}</select>
        <button class="iconbtn" data-add>＋ 添加成员</button>
        <span class="grow"></span>
        <span class="muted" data-cap>…</span>
      </div>`
    wrap.appendChild(card)
  })
  wireChainEvents()
  for (let i = 0; i < combos.length; i++) refreshCap(i)
}

function wireChainEvents() {
  const wrap = $('chains')
  for (const card of wrap.querySelectorAll('.card[data-index]')) {
    const index = Number(card.dataset.index)
    const combo = combos[index]
    card.querySelector('[data-name]').addEventListener('change', event => {
      combo.name = event.target.value.trim()
      dirty = true
    })
    card.querySelector('[data-enabled]').addEventListener('change', event => {
      combo.enabled = event.target.checked
      dirty = true
    })
    card.querySelector('[data-strategy]').addEventListener('change', event => {
      combo.strategy = event.target.value
      card.querySelector('[data-sticky-row]').style.display = combo.strategy === 'round-robin' ? '' : 'none'
      dirty = true
    })
    card.querySelector('[data-sticky]').addEventListener('change', event => {
      const value = Math.trunc(Number(event.target.value))
      combo.stickyLimit = Number.isFinite(value) && value > 0 ? Math.min(value, 100) : 1
      dirty = true
    })
    card.querySelector('[data-del-chain]').addEventListener('click', () => {
      combos = combos.filter((_, i) => i !== index)
      dirty = true
      renderChains()
    })
    card.querySelector('[data-add]').addEventListener('click', () => {
      const select = card.querySelector('[data-add-member]')
      const mid = select.value
      if (mid === '') { toast('先选一个要挂进链里的模型'); return }
      if (combo.models.includes(mid)) { toast('这个模型已经在链里了'); return }
      combo.models.push(mid)
      dirty = true
      renderChains()
    })
    for (const select of card.querySelectorAll('select[data-member]')) {
      select.addEventListener('change', () => {
        const mi = Number(select.dataset.member)
        combo.models[mi] = select.value
        dirty = true
        renderChains()
      })
    }
    for (const button of card.querySelectorAll('button[data-up]')) {
      button.addEventListener('click', () => {
        const mi = Number(button.dataset.up)
        if (mi <= 0) return
        ;[combo.models[mi - 1], combo.models[mi]] = [combo.models[mi], combo.models[mi - 1]]
        dirty = true
        renderChains()
      })
    }
    for (const button of card.querySelectorAll('button[data-down]')) {
      button.addEventListener('click', () => {
        const mi = Number(button.dataset.down)
        if (mi >= combo.models.length - 1) return
        ;[combo.models[mi], combo.models[mi + 1]] = [combo.models[mi + 1], combo.models[mi]]
        dirty = true
        renderChains()
      })
    }
    for (const button of card.querySelectorAll('button[data-del-member]')) {
      button.addEventListener('click', () => {
        const mi = Number(button.dataset.delMember)
        combo.models.splice(mi, 1)
        dirty = true
        renderChains()
      })
    }
  }
}

/** 链能力 = 成员交集（与 buildComboCatalog 同口径），只做页面预览。 */
async function refreshCap(index) {
  const combo = combos[index]
  const capEl = $('chains').querySelector(`.card[data-index="${index}"] [data-cap]`)
  if (!capEl) return
  if (combo.models.length === 0) { capEl.textContent = '还没有成员'; return }
  try {
    const data = await api(`/combos/preview?models=${encodeURIComponent(combo.models.join(','))}`)
    const capacity = data.capacity
    if (capacity === null) { capEl.textContent = '成员都不在当前清单里'; return }
    capEl.textContent = `链能力取交集：上下文 ${fmt(capacity.contextWindow)} tok · 输出 ${fmt(capacity.maxOutput)} tok${capacity.vision ? ' · 支持图像' : ' · 纯文本'}`
  } catch {
    capEl.textContent = '能力预览不可用（不影响保存）'
  }
}

function fmt(n) {
  const value = Number(n)
  if (!Number.isFinite(value) || value <= 0) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`
  if (value >= 10_000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}k`
  return String(Math.trunc(value))
}

$('addchain').addEventListener('click', () => {
  const existing = new Set(combos.map(combo => combo.name))
  let name = '新链'
  for (let i = 2; existing.has(name); i++) name = `新链 ${i}`
  combos.push({ id: '', name, models: [], strategy: 'fallback', stickyLimit: 1, enabled: true })
  dirty = true
  renderChains()
})

$('save').addEventListener('click', async () => {
  const button = $('save')
  button.disabled = true
  $('savestate').textContent = '保存中…'
  try {
    const cleaned = []
    for (const combo of combos) {
      const name = String(combo.name ?? '').trim()
      if (name === '') { throw new Error('有链还没起名字') }
      if (combo.models.length === 0) { throw new Error(`链「${name}」至少要有一个成员模型`) }
      cleaned.push({
        id: combo.id || undefined,
        name,
        models: combo.models,
        strategy: combo.strategy === 'round-robin' ? 'round-robin' : 'fallback',
        stickyLimit: combo.stickyLimit,
        enabled: combo.enabled !== false,
      })
    }
    const data = await api('/combos', { method: 'POST', body: { combos: cleaned } })
    combos = data.combos
    dirty = false
    renderChains()
    markSaved($('savestate'), '已保存，/v1/models 立即出现链 ID')
  } catch (error) {
    toast(`保存失败：${error?.message ?? error}`)
    $('savestate').textContent = ''
  } finally {
    button.disabled = false
  }
})

function markSaved(node, text) {
  node.textContent = text
  setTimeout(() => { node.textContent = '' }, 2600)
}

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

window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = '' }
})

boot()
