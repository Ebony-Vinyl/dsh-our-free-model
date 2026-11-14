/**
 * 动效绑定 — React hooks。
 *
 * 每个 hook 都返回一个 ref 或值，副作用全部写进 CSS 自定义属性，
 * 由 CSS 决定最终形变。这样做的好处：动画跑在合成层上，React 不会
 * 因为逐帧状态更新而重渲染；关掉动效时 CSS 只需忽略这些变量。
 *
 * 闸门统一在 `motionAllowed()` 里判断（系统偏好 + 用户开关 + 页面可见）。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { clamp, easeOutExpo, lerp, motionAllowed, onFrame } from './index'

/** 元素离屏时暂停逐帧工作，回到视口再继续。 */
function useInViewport<T extends Element>(ref: React.RefObject<T | null>, enabled = true): React.RefObject<boolean> {
  const visible = useRef(true)
  useEffect(() => {
    const node = ref.current
    if (!enabled || !node || typeof IntersectionObserver !== 'function') return
    const observer = new IntersectionObserver(entries => {
      visible.current = entries.some(entry => entry.isIntersecting)
    }, { rootMargin: '80px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref, enabled])
  return visible
}

/**
 * 聚光灯：把指针在元素内的相对位置写进 --spot-x / --spot-y。
 * 只写两个 CSS 变量，不触发 React 渲染。
 */
export function useSpotlight<T extends HTMLElement = HTMLDivElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || !motionAllowed()) return
    let frame = 0
    let pending: { x: number; y: number } | undefined
    const write = () => {
      frame = 0
      if (!pending) return
      node.style.setProperty('--spot-x', `${pending.x}%`)
      node.style.setProperty('--spot-y', `${pending.y}%`)
      pending = undefined
    }
    const onMove = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      pending = { x: ((event.clientX - rect.left) / rect.width) * 100, y: ((event.clientY - rect.top) / rect.height) * 100 }
      // 每帧最多写一次，指针高频移动时不会刷爆样式
      if (!frame) frame = requestAnimationFrame(write)
    }
    node.addEventListener('pointermove', onMove, { passive: true })
    return () => {
      node.removeEventListener('pointermove', onMove)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])
  return ref
}

/**
 * 3D 倾斜：指针在元素内的位置映射成 ±max 度的旋转，外加一点抬起。
 * 离开时用弹簧回位（不是瞬间归零，那样很硬）。
 */
export function useTilt<T extends HTMLElement = HTMLDivElement>(max = 6, lift = 4): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const visible = useInViewport(ref)
  useEffect(() => {
    const node = ref.current
    if (!node || !motionAllowed()) return
    // 触摸设备没有 hover，倾斜会变成"点了才动"，不如不做
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(hover: hover)').matches) return

    let target = { x: 0, y: 0 }
    let current = { x: 0, y: 0 }
    let settle = 0
    let stop: (() => void) | undefined

    const apply = () => {
      node.style.setProperty('--tilt-x', `${current.x.toFixed(2)}deg`)
      node.style.setProperty('--tilt-y', `${current.y.toFixed(2)}deg`)
      node.style.setProperty('--tilt-lift', `${(-Math.abs(current.x) - Math.abs(current.y)) / max * (lift / 2) * -1}px`)
      node.style.setProperty('--sheen-a', `${(Math.abs(current.y) / max * 0.8 + 0.2).toFixed(2)}`)
    }

    const tick = (delta: number) => {
      const k = 1 - Math.pow(0.001, delta / 1000)
      current.x = lerp(current.x, target.x, k)
      current.y = lerp(current.y, target.y, k)
      apply()
      if (Math.abs(current.x - target.x) < 0.02 && Math.abs(current.y - target.y) < 0.02) {
        current = { ...target }
        apply()
        stop?.()
        stop = undefined
      }
    }

    const start = () => {
      if (stop) return
      node.classList.add('is-tracking')
      stop = onFrame(tick)
    }

    const onMove = (event: PointerEvent) => {
      if (!visible.current) return
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      target = {
        x: clamp(-((event.clientY - rect.top) / rect.height - 0.5) * 2 * max, -max, max),
        y: clamp(((event.clientX - rect.left) / rect.width - 0.5) * 2 * max, -max, max),
      }
      start()
    }
    const onLeave = () => {
      target = { x: 0, y: 0 }
      settle = window.setTimeout(() => node.classList.remove('is-tracking'), 220)
      start()
    }

    node.addEventListener('pointermove', onMove, { passive: true })
    node.addEventListener('pointerleave', onLeave, { passive: true })
    return () => {
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerleave', onLeave)
      stop?.()
      if (settle) clearTimeout(settle)
      node.classList.remove('is-tracking')
    }
  }, [max, lift, visible])
  return ref
}

/**
 * 逐项入场：容器进入视口后加 `.is-revealed`，子项按 --i 依次升起。
 * 只触发一次（入场是"第一印象"，反复播放会烦）。
 *
 * 安全阀（两条，缺一不可）：
 *   1. 观察器的下边界放宽到 3 个视口高 —— 首屏之下的内容在挂载时就判定为
 *      "会看到"，立刻揭示。否则用户往下滚时才发现它们一直是隐形的。
 *   2. 400ms 兜底定时器 —— 观察器不回调（尺寸为 0、容器被隐藏）时也能显示。
 * 内容永远不该因为动画没跑而消失：那是比"少个动画"严重得多的失败。
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>(count = 0): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node) return
    if (!motionAllowed() || typeof IntersectionObserver !== 'function') {
      node.classList.add('is-revealed')
      return
    }
    node.classList.add('is-armed')
    const fallback = window.setTimeout(() => node.classList.add('is-revealed'), 400)
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {
        node.classList.add('is-revealed')
        window.clearTimeout(fallback)
        observer.disconnect()
      }
    }, { rootMargin: '0px 0px 300% 0px' })
    observer.observe(node)
    return () => { window.clearTimeout(fallback); observer.disconnect() }
  }, [count])
  return ref
}

/** 数字滚动：从 0 缓出到目标值。目标是字符串时原样返回，不做动画。 */
export function useCountUp(target: number, duration = 900): number {
  const [value, setValue] = useState(() => motionAllowed() ? 0 : target)
  const from = useRef(0)
  useEffect(() => {
    if (!motionAllowed() || !Number.isFinite(target)) { setValue(target); return }
    const start = performance.now()
    const origin = from.current
    let stop: (() => void) | undefined
    const tick = () => {
      const elapsed = performance.now() - start
      const progress = clamp(elapsed / duration, 0, 1)
      const next = lerp(origin, target, easeOutExpo(progress))
      setValue(next)
      if (progress >= 1) { from.current = target; stop?.(); stop = undefined }
    }
    stop = onFrame(tick)
    return () => stop?.()
  }, [target, duration])
  return value
}

/**
 * 磁吸：指针靠近时元素朝光标方向偏移（最多 max 像素）。
 * 幅度刻意做得极小 —— 大到能"看见在动"，小到不会让按钮跑出点击区。
 */
export function useMagnetic<T extends HTMLElement = HTMLButtonElement>(max = 3): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useEffect(() => {
    const node = ref.current
    if (!node || !motionAllowed()) return
    if (typeof window.matchMedia === 'function' && !window.matchMedia('(hover: hover)').matches) return
    const onMove = (event: PointerEvent) => {
      const rect = node.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dx = (event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2)
      const dy = (event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2)
      node.style.setProperty('--mag-x', `${clamp(dx, -1, 1) * max}px`)
      node.style.setProperty('--mag-y', `${clamp(dy, -1, 1) * max}px`)
    }
    const reset = () => {
      node.style.setProperty('--mag-x', '0px')
      node.style.setProperty('--mag-y', '0px')
    }
    node.addEventListener('pointermove', onMove, { passive: true })
    node.addEventListener('pointerleave', reset, { passive: true })
    return () => {
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerleave', reset)
    }
  }, [max])
  return ref
}

/**
 * 视差：元素随页面滚动做极小幅位移，制造前后层次。
 * 只在元素处于视口内时计算。
 */
export function useParallax<T extends HTMLElement = HTMLDivElement>(strength = 12): React.RefObject<T | null> {
  const ref = useRef<T | null>(null)
  const visible = useInViewport(ref)
  useEffect(() => {
    const node = ref.current
    if (!node || !motionAllowed()) return
    let frame = 0
    const update = () => {
      frame = 0
      if (!visible.current) return
      const rect = node.getBoundingClientRect()
      const offset = (rect.top + rect.height / 2 - window.innerHeight / 2) / window.innerHeight
      node.style.setProperty('--par-y', `${clamp(offset, -1, 1) * strength}px`)
    }
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update) }
    update()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [strength, visible])
  return ref
}

/**
 * 用户动效开关的读写。侧边栏那个开关用它，写入后整个文档立刻响应
 * （motion.css 的 `[data-motion="off"]` 闸门）。
 */
export function useMotionSetting(): [boolean, (next: boolean) => void] {
  const [on, setOn] = useState(() => {
    try { return window.localStorage?.getItem('ofm-motion') !== 'off' } catch { return true }
  })
  const toggle = useCallback((next: boolean) => {
    setOn(next)
    try { window.localStorage?.setItem('ofm-motion', next ? 'on' : 'off') } catch { /* 仅本次会话 */ }
  }, [])
  useEffect(() => {
    document.documentElement.dataset.motion = on ? 'on' : 'off'
  }, [on])
  return [on, toggle]
}
