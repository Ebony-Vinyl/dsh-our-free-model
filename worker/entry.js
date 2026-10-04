/**
 * EAC 看板侧边栏入口注入脚本 — 由网关在 {mount}/entry.js 提供，nginx 会把它
 * 注入到 New API 面板的每个页面（</body> 前）。
 *
 * 它做的事只有一件：等 New API 的管理员侧边栏渲染出来，在「管理员」分组的
 * 「系统信息」后面克隆一份条目，改名为「EAC 看板」，指向 /eac/stats。克隆的
 * 是游离 DOM（不接 React 事件），点击走原生跳转；若面板更新导致条目被
 * React 重渲染移除，观察器会重新补上。没有任何密钥内嵌。
 */
(function () {
  if (location.pathname.indexOf('/eac/') === 0) return // 看板自身不再注入
  var HREF = '/eac/stats'
  try {
    if (document.currentScript && document.currentScript.src) {
      HREF = new URL('../stats', document.currentScript.src).pathname
    }
  } catch (e) { /* 保持默认路径 */ }
  var done = false

  function textLeaf(el) {
    var all = el.querySelectorAll('*')
    for (var i = 0; i < all.length; i++) {
      if (all[i].children.length === 0 && all[i].textContent.trim() !== '') return all[i]
    }
    return null
  }

  function inject() {
    if (done || document.getElementById('eac-stats-entry')) { done = true; return }
    var candidates = document.querySelectorAll('aside a, aside div, nav a, nav div, [class*="sider"] a, [class*="sider"] div')
    var anchor = null
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i]
      if (el.childElementCount === 0) continue
      var leaf = textLeaf(el)
      if (leaf && leaf.textContent.trim() === '系统信息') { anchor = el; break }
    }
    if (!anchor) return
    var clone = anchor.cloneNode(true)
    clone.id = 'eac-stats-entry'
    if (clone.tagName === 'A') clone.setAttribute('href', HREF)
    else clone.addEventListener('click', function () { location.href = HREF })
    clone.style.cursor = 'pointer'
    var leaf = textLeaf(clone)
    if (leaf) leaf.textContent = 'EAC 看板'
    anchor.parentElement.insertBefore(clone, anchor.nextSibling)
    done = true
  }

  function start() {
    inject()
    if (!done) {
      var obs = new MutationObserver(function () { if (inject()) obs.disconnect() })
      obs.observe(document.body, { childList: true, subtree: true })
      setTimeout(function () { obs.disconnect() }, 60000)
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})()
