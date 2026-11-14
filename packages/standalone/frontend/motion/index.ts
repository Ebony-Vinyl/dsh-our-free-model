/**
 * 动效运行时 — 零依赖。
 *
 * 这里只放纯函数与一个共享的 rAF 调度器。React 绑定在 hooks.ts，
 * 装饰层渲染在 field.tsx。所有函数都假定调用方已经做过闸门判断
 * （reduced / 用户关闭 / 页面隐藏），除 `motionAllowed()` 本身。
 */

export const clamp = (value: number, min: number, max: number) => value < min ? min : value > max ? max : value

export const lerp = (from: number, to: number, t: number) => from + (to - from) * t

/** 系统的减少动效偏好。每次调用都重新读取，用户改系统设置后无需刷新。 */
export function reduced(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** 用户的动效开关，存在 localStorage['ofm-motion']（'off' 表示关闭，缺省为开）。 */
export function motionPreference(): boolean {
  try { return window.localStorage?.getItem('ofm-motion') !== 'off' } catch { return true }
}

export function saveMotionPreference(on: boolean): void {
  try { window.localStorage?.setItem('ofm-motion', on ? 'on' : 'off') } catch { /* 存储不可用时仅本次会话生效 */ }
}

/** 动效是否应该运行：系统允许 + 用户允许 + 页面可见。 */
export function motionAllowed(): boolean {
  if (reduced() || !motionPreference()) return false
  if (typeof document !== 'undefined' && document.hidden) return false
  return true
}

/**
 * 共享 rAF 循环。
 *
 * 所有动画订阅同一个循环，而不是每个组件各开一个 —— 十几张卡片同时
 * 倾斜时，一个循环比十几个循环省一个数量级的调度开销。没有订阅者时
 * 自动停表，不会在空闲页面里空转。
 */
type Tick = (now: number) => void
const ticks = new Set<Tick>()
let frame = 0
let last = 0

function loop(now: number) {
  const delta = last ? Math.min(now - last, 48) : 16
  last = now
  for (const tick of ticks) {
    try { tick(delta) } catch { ticks.delete(tick) }
  }
  frame = ticks.size ? requestAnimationFrame(loop) : 0
  if (!ticks.size) last = 0
}

/** 订阅共享循环，返回退订函数。 */
export function onFrame(tick: Tick): () => void {
  ticks.add(tick)
  if (!frame) frame = requestAnimationFrame(loop)
  return () => {
    ticks.delete(tick)
    if (!ticks.size && frame) { cancelAnimationFrame(frame); frame = 0; last = 0 }
  }
}

/**
 * 临界阻尼弹簧，用于"松手回位"这类需要一点过冲的动作。
 * 返回 0..1 的进度；调用方按需乘上幅度。
 */
export function spring(elapsed: number, duration = 420): number {
  const t = clamp(elapsed / duration, 0, 1)
  // 手调的近似弹簧：前 40% 快速到位，尾部轻微过冲后收敛
  return 1 - Math.exp(-6.2 * t) * Math.cos(9.4 * t)
}

/** 把 0..1 的进度映射成一次"按下再回弹"的形变，用于按钮。 */
export function pressScale(progress: number): number {
  const t = clamp(progress, 0, 1)
  return t < 0.35 ? lerp(1, 0.965, t / 0.35) : lerp(0.965, 1, spring((t - 0.35) * 900, 620))
}

/** 数字滚动用的缓出曲线（指数衰减），比线性自然。 */
export function easeOutExpo(t: number): number {
  return t >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(t, 0, 1))
}
