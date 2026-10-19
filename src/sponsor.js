/** 赞助内容与每日公告交互：浏览器专用，不读取账号或调用赞助商接口。 */
export const SPONSOR = Object.freeze({
  title: '来自赞助商的广告',
  name: '北辰 API',
  url: 'https://beichenapi.com/register?aff=DL49WAC2DQNG',
  invite: 'DL49WAC2DQNG',
  greeting: '非常抱歉，亲爱的朋友：',
  paragraphs: [
    '为了租上服务器(超级贵，我们几个穷学生...)，让我们的插件正常使用，我们不得不找甲方接一点广告和挣一点佣金。非常抱歉，这都是为了提高服务器并发量和号池(100%是为了提升体验和维护运营)(突然爆火了，我们的小服务器直接炸，只好花钱换)，属实是无奈之举。若广告带来了不好的体验，还望体谅。',
    '本插件旨在给大家学习提供免费的算力，可能响应速度确实偏慢，但已经尽我们所能在提升。(肯定不是为了骗你star，最近的爆火，真是意料之外)如果响应太慢，可能是因为同时多人使用，还希望多多包涵。',
    '关于广告：广告是为了用服务器以及运营，并且其来源是大家使用中转站的抽成。(所以如果可以，请务必使用我们的邀请码呀ʕ  •ᴥ•ʔ)',
    '这是我们甲方的中转站，可以去官网首页有群链接找群主要体验，提供了优质的外国大模型算力(肯定是有品质保证的，不然也不敢挂合作)。如果希望使用外国优质大模型(大胆进行鹈鹕)测试，请务必考虑使用我们的链接。(求求大家了，不要跳过这个邀请码，我们的某位成员为此什么都会做的( •̥́ ˍ •̀ू ))',
    '(•‾̑⌣‾̑•)✧˖如果你希望使用相关付费算力，请务必考虑我们提供的渠道(其实这个渠道很不错的，价格和质量还不错)。我们的项目还会继续运营，以后也会免费下去。打这个广告也是迫不得已...(相信我们，真的不想圈米，只想运营好这个项目(所以租了个很贵的服务器)，(ó﹏ò｡) 对于讨厌广告的朋友实在抱歉啊)',
    '总之，还是感谢大家的支持(没办法以中转站的形式中支持也没关系，愿意点Star和使用，就已经让我们非常高兴)和陪伴，有了这种变相的赞助，我们肯定会保障ofm服务的越来越好。再次真心谢谢大家。',
  ],
})

export const SPONSOR_DAY_KEY = 'ofm.sponsor.last-shown.v1'

/** 使用用户当地的日历日期，不能用 UTC 的 toISOString() 划分“今天”。 */
export function sponsorLocalDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** 同源窗口共用 Web Lock；只有公告成功打开后才记账。存储禁用时跳过自动广告。 */
export async function claimSponsorDay({ storage, locks, now = () => new Date(), eligible = () => true, show = () => {} }) {
  const claim = () => {
    if (!eligible()) return false
    const day = sponsorLocalDay(now())
    try {
      if (storage.getItem(SPONSOR_DAY_KEY) === day) return false
      // 写入失败时不弹窗，避免刷新、重挂载或隐私模式下反复打扰。
      const previous = storage.getItem(SPONSOR_DAY_KEY)
      storage.setItem(SPONSOR_DAY_KEY, day)
      try { show() } catch (error) {
        if (previous === null) storage.removeItem(SPONSOR_DAY_KEY)
        else storage.setItem(SPONSOR_DAY_KEY, previous)
        throw error
      }
      return true
    } catch { return false }
  }
  try { return locks?.request ? await locks.request('ofm-sponsor-daily', claim) : claim() }
  catch { return false }
}

/** 两端共用 React 组件；插件通过构建脚本内联，独立端直接导入。 */
export function createSponsorUI(React, image, createPortal, variant = 'plugin') {
  const { createElement: h, useState, useEffect, useRef } = React
  const surfaceClass = `ofm-sponsor ofm-sponsor-${variant}`
  const icon = (name, size = 18) => h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
    name === 'arrow' ? h('path', { d: 'M7 17 17 7M7 7h10v10' })
      : name === 'close' ? h('path', { d: 'm6 6 12 12M6 18 18 6' })
        : [h('path', { key: 1, d: 'M20 8v5a3 3 0 0 1-3 3H8a4 4 0 0 1-4-4V8zM20 9h1a2 2 0 0 1 0 4h-1M8 4v1m5-1v1' }), h('path', { key: 2, d: 'M4 20h16' })])

  function SponsorArticle() {
    const [copied, setCopied] = useState('')
    const copyTimer = useRef(null)
    useEffect(() => () => clearTimeout(copyTimer.current), [])
    const copy = async (value, label) => {
      try {
        await navigator.clipboard.writeText(value)
        setCopied(`${label}已复制`)
      } catch { setCopied('复制未完成，请选中文字手动复制。') }
      clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(''), 3000)
    }
    const paragraph = index => h('p', { key: index }, SPONSOR.paragraphs[index])
    return h('article', { className: 'ofm-sponsor-article' },
      h('div', { className: 'ofm-sponsor-intro' },
        h('div', null, h('h2', null, '让免费服务，继续陪伴。'), h('p', null, '一封来自 OFM 团队的说明，也是一份坦诚的赞助邀请。')),
        h('span', { className: 'ofm-sponsor-seal', 'aria-hidden': true }, icon('cup', 26))),
      h('div', { className: 'ofm-sponsor-letter' },
        h('p', { className: 'ofm-sponsor-greeting' }, SPONSOR.greeting),
        paragraph(0), paragraph(1), paragraph(2),
        h('div', { className: 'ofm-sponsor-contact' },
          h('p', null, '这里是附上了邀请码的链接：'),
          h('a', { className: 'ofm-sponsor-url', href: SPONSOR.url, target: '_blank', rel: 'noopener noreferrer' }, SPONSOR.url, icon('arrow', 16)),
          h('div', { className: 'ofm-sponsor-copyrow' }, h('span', null, '邀请码 ', h('strong', null, SPONSOR.invite)),
            h('button', { type: 'button', onClick: () => copy(SPONSOR.invite, '邀请码') }, '复制邀请码')),
          h('span', { className: 'ofm-sponsor-copy-status', role: 'status' }, copied)),
        paragraph(3), paragraph(4), paragraph(5),
        h('div', { className: 'ofm-sponsor-signoff' }, h('span', null, '感谢你的理解与陪伴'), h('strong', null, 'OFM 团队'))),
      h('figure', { className: 'ofm-sponsor-evidence' },
        h('figcaption', null, h('strong', null, '另附：中转站鹈鹕测试'), h('span', null, '发现问题直接电 · 以下为提供的原图')),
        h('img', { src: image, alt: '提供的生成示例：三幅图像分别展示骑行鹈鹕和山河场景，下方保留模型名称、生成时间与耗时。', width: 1227, height: 367, loading: 'lazy', decoding: 'async' })),
      h('div', { className: 'ofm-sponsor-end' }, h('p', null, '愿意了解，再往前一步。'),
        h('a', { className: 'ofm-sponsor-visit', href: SPONSOR.url, target: '_blank', rel: 'noopener noreferrer' }, '前往北辰 API', icon('arrow')), h('span', null, '赞助商网站 · 含邀请码')))
  }

  function SponsorPage() {
    return h('section', { className: surfaceClass + ' ofm-sponsor-page', 'aria-labelledby': 'ofm-sponsor-page-title' },
      h('header', { className: 'ofm-sponsor-pagehead' }, h('h1', { id: 'ofm-sponsor-page-title' }, SPONSOR.title), h('p', null, '北辰 API × OFM · 你可以在这里随时阅读全文。')),
      h(SponsorArticle))
  }

  function SponsorNotice({ targetId, placement = 'below' }) {
    const dialog = useRef(null)
    const mounted = useRef(false)
    const closing = useRef(false)
    const animation = useRef(null)
    const previousFocus = useRef(null)
    const unlock = useRef(() => {})
    const [opened, setOpened] = useState(false)
    const [leaving, setLeaving] = useState(false)
    const finish = () => {
      dialog.current?.close()
      // 清除收起动画的 forwards 状态，否则同一界面跨日再打开会透明并卡住操作。
      animation.current?.cancel()
      animation.current = null
      unlock.current()
      if (mounted.current) { setOpened(false); setLeaving(false) }
    }
    const dismiss = () => {
      const node = dialog.current
      if (!node?.open || closing.current) return
      closing.current = true
      setLeaving(true)
      const target = document.getElementById(targetId)
      const focusedInside = node.contains(document.activeElement)
      const complete = () => {
        if (!mounted.current) return
        finish()
        if (focusedInside) (target ?? previousFocus.current)?.focus({ preventScroll: true })
        if (target && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          target.animate?.([{ outline: '2px solid currentColor', outlineOffset: '4px' }, { outline: '2px solid transparent', outlineOffset: '0px' }], { duration: 700, easing: 'ease-out' })
        }
      }
      if (target) {
        const rect = target.getBoundingClientRect()
        if (rect.left < 0 || rect.right > window.innerWidth || rect.top < 0 || rect.bottom > window.innerHeight) {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' })
        }
      }
      if (!target || !node.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { complete(); return }
      const from = node.getBoundingClientRect(), to = target.getBoundingClientRect()
      if (to.bottom < 0 || to.top > window.innerHeight) { complete(); return }
      animation.current = node.animate([
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        { transform: `translate(${to.x + to.width / 2 - from.x - from.width / 2}px, ${to.y + to.height / 2 - from.y - from.height / 2}px) scale(${Math.max(.08, to.width / from.width)}, ${Math.max(.04, to.height / from.height)})`, opacity: 0 },
      ], { duration: 440, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'forwards' })
      animation.current.finished.then(complete, complete)
    }
    useEffect(() => {
      mounted.current = true
      let cancelled = false
      const blockedByDialog = () => {
        const selector = 'dialog[open], [role="dialog"][aria-modal="true"]'
        // 插件挂在宿主设置弹窗中；菜单所在的这一层不是需要避让的其他弹窗。
        const hostDialog = variant === 'plugin' ? document.getElementById(targetId)?.closest(selector) : null
        return [...document.querySelectorAll(selector)].some(node => node !== dialog.current && node !== hostDialog && node.getClientRects().length > 0)
      }
      const show = () => {
        if (cancelled || document.hidden || !dialog.current || blockedByDialog()) throw new Error('not ready')
        previousFocus.current = document.activeElement
        dialog.current.showModal()
        closing.current = false
        const oldOverflow = document.body.style.overflow, oldPadding = document.body.style.paddingRight
        const gutter = Math.max(0, window.innerWidth - document.documentElement.clientWidth)
        document.body.style.overflow = 'hidden'
        if (gutter) document.body.style.paddingRight = `${gutter + parseFloat(getComputedStyle(document.body).paddingRight || '0')}px`
        let restored = false
        unlock.current = () => { if (restored) return; restored = true; document.body.style.overflow = oldOverflow; document.body.style.paddingRight = oldPadding }
        setOpened(true)
      }
      const tryShow = () => {
        if (cancelled || document.hidden) return
        if (blockedByDialog()) { observe(); return }
        let storage
        try { storage = window.localStorage } catch { return }
        void claimSponsorDay({ storage, locks: navigator.locks, eligible: () => !cancelled && !document.hidden, show }).then(shown => {
          if (shown || storage.getItem(SPONSOR_DAY_KEY) === sponsorLocalDay()) observer.disconnect()
        }).catch(() => { observer.disconnect() })
      }
      const observer = new MutationObserver(tryShow)
      const observe = () => observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open', 'aria-hidden'] })
      const timer = setTimeout(tryShow, 700)
      const onVisibility = () => { if (!document.hidden) tryShow() }
      // 宿主在 document 上用 Esc 关闭设置页；公告打开时先消费按键，保留设置页。
      const onKeyDown = event => {
        if (event.key !== 'Escape' || !dialog.current?.open) return
        event.preventDefault()
        event.stopPropagation()
        dismiss()
      }
      document.addEventListener('visibilitychange', onVisibility)
      document.addEventListener('keydown', onKeyDown, true)
      return () => {
        cancelled = true; mounted.current = false
        clearTimeout(timer)
        observer.disconnect()
        document.removeEventListener('visibilitychange', onVisibility)
        document.removeEventListener('keydown', onKeyDown, true)
        animation.current?.cancel()
        dialog.current?.close()
        unlock.current()
      }
    }, [])
    return createPortal(h('dialog', { ref: dialog, className: `${surfaceClass} ofm-sponsor-dialog${leaving ? ' is-closing' : ''}`, 'aria-labelledby': 'ofm-sponsor-dialog-title', 'aria-describedby': 'ofm-sponsor-dialog-description', 'data-placement': placement,
      onCancel: event => { event.preventDefault(); dismiss() },
      onClick: event => { if (event.target === dialog.current) { const r = dialog.current.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dismiss() } } },
      h('header', { className: 'ofm-sponsor-dialoghead' }, h('div', null, h('h2', { id: 'ofm-sponsor-dialog-title' }, SPONSOR.title), h('p', { id: 'ofm-sponsor-dialog-description' }, '北辰 API × OFM · 每天首次打开时展示一次')),
        h('button', { type: 'button', className: 'ofm-sponsor-close', autoFocus: true, onClick: dismiss, 'aria-label': '收起公告到广告菜单', title: '收起到广告菜单（Esc）' }, icon('close'))),
      h('div', { className: 'ofm-sponsor-scroll', tabIndex: 0, role: 'region', 'aria-label': '广告全文，可向下滚动' }, opened ? h(SponsorArticle) : null),
      h('footer', { className: 'ofm-sponsor-dialogfoot' }, h('p', null, '无需读完，也可以随时收起。', h('span', null, '全文会留在广告菜单中。')),
        h('button', { type: 'button', className: 'ofm-sponsor-fold', onClick: dismiss }, '收起至菜单', icon('arrow', 16)))), document.body)
  }
  return { SponsorPage, SponsorNotice }
}
