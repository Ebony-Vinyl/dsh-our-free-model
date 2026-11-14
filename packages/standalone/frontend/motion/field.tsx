/**
 * 装饰层 — 极光 / 网格 / 扫描线 / 颗粒 / 尘埃。
 *
 * 以副作用方式挂到 document.body 上，而不是渲染进 React 树。理由：
 *   · 外壳里的 .topbar 有 backdrop-filter、.sidebar 有 overflow，
 *     它们都会成为 fixed 后代的包含块或裁剪容器，装饰层会被压扁或裁掉；
 *   · 挂在 body 上，配合 motion.css 的 z-index 契约（装饰 0 / 内容 1），
 *     层级永远正确，且与任何页面的布局改动解耦。
 *
 * 尘埃是唯一用 JS 画的部分：canvas + 共享 rAF 循环。以下任一条件成立时
 * 循环立刻停止（不是降频，是完全停）：
 *   · prefers-reduced-motion
 *   · 用户关掉动效（data-motion="off"）
 *   · 标签页隐藏
 *   · 视口小于 700px（手机上这层没有视觉价值，省电）
 */

import { useEffect } from 'react'
import { motionAllowed, onFrame } from './index'

type Particle = { x: number; y: number; vx: number; vy: number; r: number; a: number }

const DUST_DENSITY = 1 / 22000 // 每平方像素的粒子数
const DUST_MAX = 110
const DUST_MIN = 36
const HOST_ID = 'ofm-motion-field'

/** 创建（或复用）装饰层 DOM，返回卸载函数。幂等：重复调用不会叠出两层。 */
export function mountMotionField(): () => void {
  if (typeof document === 'undefined') return () => {}
  const existing = document.getElementById(HOST_ID)
  if (existing) return () => {} // 已有实例（例如热重载），交给原实例管理

  const host = document.createElement('div')
  host.id = HOST_ID
  host.className = 'm-field'
  host.setAttribute('aria-hidden', 'true')

  const aurora = document.createElement('div')
  aurora.className = 'm-aurora'
  const grid = document.createElement('div')
  grid.className = 'm-grid'
  const canvas = document.createElement('canvas')
  canvas.className = 'm-dust'
  const scan = document.createElement('div')
  scan.className = 'm-scan'
  const grain = document.createElement('div')
  grain.className = 'm-grain'
  host.append(aurora, grid, canvas, scan, grain)
  document.body.appendChild(host)

  const context = canvas.getContext('2d', { alpha: true })
  let particles: Particle[] = []
  let width = 0
  let height = 0

  const seed = () => {
    const count = Math.round(Math.min(DUST_MAX, Math.max(DUST_MIN, width * height * DUST_DENSITY)))
    particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 7,   // px/s
      vy: -Math.random() * 9 - 2,      // 整体缓慢上升，像浮尘
      r: Math.random() * 1.5 + 0.4,
      a: Math.random() * 0.35 + 0.08,
    }))
  }

  const resize = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    width = window.innerWidth
    height = window.innerHeight
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    context?.setTransform(dpr, 0, 0, dpr, 0, 0)
    seed()
  }

  const draw = (delta: number) => {
    if (!context) return
    context.clearRect(0, 0, width, height)
    const step = delta / 1000
    const dark = document.documentElement.dataset.theme === 'dark'
    const tint = dark ? '255,255,255' : '0,0,0'
    for (const particle of particles) {
      particle.x += particle.vx * step
      particle.y += particle.vy * step
      // 环绕：从上方飘出后从底部回来，横向同理
      if (particle.y < -8) { particle.y = height + 8; particle.x = Math.random() * width }
      if (particle.x < -8) particle.x = width + 8
      if (particle.x > width + 8) particle.x = -8
      context.beginPath()
      context.arc(particle.x, particle.y, particle.r, 0, Math.PI * 2)
      context.fillStyle = `rgba(${tint},${particle.a * (dark ? 1 : 0.45)})`
      context.fill()
    }
  }

  resize()

  let stop: (() => void) | undefined
  let frame = 0
  const start = () => {
    if (stop) return
    stop = onFrame(draw)
  }
  const halt = () => {
    stop?.()
    stop = undefined
    context?.clearRect(0, 0, width, height)
  }
  const sync = () => {
    // 小视口直接不画：手机上这层是纯负担
    if (!motionAllowed() || width < 700) halt()
    else start()
  }

  const onResize = () => {
    if (frame) return
    frame = requestAnimationFrame(() => { frame = 0; resize(); sync() })
  }
  window.addEventListener('resize', onResize, { passive: true })
  document.addEventListener('visibilitychange', sync)
  // 主题切换 / 用户拨动效开关都会改 documentElement 上的属性，需要重新判定
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(sync) : null
  observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] })

  sync()

  return () => {
    window.removeEventListener('resize', onResize)
    document.removeEventListener('visibilitychange', sync)
    observer?.disconnect()
    if (frame) cancelAnimationFrame(frame)
    halt()
    host.remove()
  }
}

/** 在应用外壳挂载时安装装饰层；卸载时移除。 */
export function useMotionField(): void {
  useEffect(() => mountMotionField(), [])
}
