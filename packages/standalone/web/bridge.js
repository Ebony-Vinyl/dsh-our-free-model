/**
 * 控制台侧栏注入 —— 给独立版控制台补「Auto 路由」「积分限额」两个入口。
 *
 * 桌面版控制台由插件宿主提供 /combos 页，独立版打包产物没有这两个页签。
 * 这份脚本不改打包代码（那种补丁脆），而是在 DOM 里把入口插到侧栏：
 * - Auto 路由 → /combos.html（模型链配置页）
 * - 积分限额 → /quota.html（限额配置页）
 *
 * React 渲染是异步的：登录前后侧栏会重建多次，所以用 MutationObserver
 * 持续盯侧栏容器，页签被重渲染冲掉就重新插。脚本自身无依赖，CSP 下
 * 以外部文件加载（script-src 'self' 允许）。
 *
 * @module web/bridge.js
 */
'use strict'

const LINKS = [
  { href: '/combos.html', label: 'Auto 路由', tag: 'chain' },
  { href: '/quota.html', label: '积分限额', tag: 'limit' },
]

function buildItem(link) {
  const item = document.createElement('a')
  item.className = 'console-nav-item ofm-bridge-item'
  item.href = link.href
  item.dataset.bridgeTag = link.tag
  item.setAttribute('aria-label', link.label)
  const indicator = document.createElement('span')
  indicator.className = 'console-nav-indicator'
  indicator.setAttribute('aria-hidden', 'true')
  const label = document.createElement('span')
  label.textContent = link.label
  item.appendChild(indicator)
  item.appendChild(label)
  return item
}

function buildCaption() {
  const caption = document.createElement('span')
  caption.className = 'nav-group-label ofm-bridge-caption'
  caption.textContent = '扩展功能'
  return caption
}

function injectSidebar() {
  const nav = document.querySelector('nav.console-nav')
  if (!nav) return
  let group = nav.querySelector('[data-ofm-bridge-group]')
  if (!group) {
    group = document.createElement('div')
    group.className = 'nav-group'
    group.dataset.ofmBridgeGroup = '1'
    nav.appendChild(group)
  }
  // 保险：React 重渲染可能保留 group 容器但清掉子节点，逐个补。
  // caption 必须排在最前：被整体清掉时重建、被单独删掉时插回头部，
  // 两种形态都不会出现「两个扩展功能」或「标签跑到入口后面」。
  const caption = group.querySelector('.ofm-bridge-caption')
  if (!caption) {
    group.insertBefore(buildCaption(), group.firstChild)
  } else if (group.firstChild !== caption) {
    group.insertBefore(caption, group.firstChild)
  }
  // 入口按 LINKS 的声明顺序补齐，并顺带归一顺序。
  // 「补齐」只处理缺失；「归一」处理顺序颠倒（极端情况下 React 若部分重排）。
  // 归一用 appendChild 的移动语义：已在树中的节点再次 append 不会复制，只会挪到末尾，
  // 因此重复调用无害 —— 这是 bridge 在多次注入下保持结构稳定的关键。
  const ordered = []
  for (const link of LINKS) {
    let item = group.querySelector(`[data-bridge-tag="${link.tag}"]`)
    if (!item) { item = buildItem(link) }
    ordered.push(item)
  }
  for (const item of ordered) group.appendChild(item)
}

function injectStyles() {
  if (document.getElementById('ofm-bridge-style')) return
  const style = document.createElement('style')
  style.id = 'ofm-bridge-style'
  style.textContent = `
    a.console-nav-item { text-decoration: none; cursor: pointer; }
    a.console-nav-item .console-nav-indicator { width: 18px; height: 18px; display: inline-block; }
    a.console-nav-item[data-bridge-tag="chain"] .console-nav-indicator { border: 1.6px solid currentColor; border-radius: 3px; position: relative; }
    a.console-nav-item[data-bridge-tag="chain"] .console-nav-indicator::after { content: ""; position: absolute; inset: 3px 4px auto 4px; height: 1.6px; background: currentColor; }
    a.console-nav-item[data-bridge-tag="limit"] .console-nav-indicator { border: 1.6px solid currentColor; border-radius: 50%; position: relative; }
    a.console-nav-item[data-bridge-tag="limit"] .console-nav-indicator::after { content: ""; position: absolute; left: 50%; top: 2px; bottom: 2px; width: 1.6px; margin-left: -0.8px; background: currentColor; }
  `
  document.head.appendChild(style)
}

/**
 * 观察者回调和注入本身都会改 DOM，直接 observe(inject) 会自触发成环：
 * 注入 → 变更 → 回调 → 再注入 → 再变更……主线程被占满，React 反而渲染不出来
 * （实测：侧栏 20s 不出现）。所以观察回调只打标记，真正的注入合并到一次
 * 微任务里跑，且跑前先 disconnect——注入造成的变更不会再次触发自己。
 */
let scheduled = false
let observer = null

function scheduleInject() {
  if (scheduled) return
  scheduled = true
  const flush = () => {
    scheduled = false
    observer?.disconnect()
    injectStyles()
    injectSidebar()
    rearm()
  }
  if (typeof queueMicrotask === 'function') queueMicrotask(flush)
  else Promise.resolve().then(flush)
}

function rearm() {
  const nav = document.querySelector('nav.console-nav')
  if (nav) observer?.observe(nav, { childList: true, subtree: true })
  else observer?.observe(document.body, { childList: true, subtree: true })
}

function start() {
  injectStyles()
  injectSidebar()
  observer = new MutationObserver(() => scheduleInject())
  rearm()
}

start()
