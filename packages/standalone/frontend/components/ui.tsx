import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

// 按 shadcn 的源码维护方式组合基础组件，只引入本阶段需要的原语。
export const cn = (...values: ClassValue[]) => twMerge(clsx(values))

type ButtonVariant = 'default' | 'outline' | 'ghost'
type ButtonSize = 'sm' | 'md' | 'lg' | 'icon'

/**
 * 按钮。`asChild` 时渲染为 Slot（Radix），把样式挂到调用方给的子元素上。
 * forwardRef 是必需的：动效 hook 要把 ref 挂到真实 DOM 上写 CSS 变量。
 */
export const Button = React.forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant; size?: ButtonSize; busy?: boolean; asChild?: boolean
}>(function Button({ className, variant = 'default', size, busy = false, asChild = false, children, disabled, ...props }, ref) {
  const Component = asChild ? Slot : 'button'
  return <Component type="button" ref={ref} className={cn('ui-button', `ui-button-${variant}`, size && `ui-button-${size}`, busy && 'is-busy', className)}
    disabled={disabled || busy} data-busy={busy || undefined} {...props}>
    {busy && <Spinner className="ui-button-spinner" aria-hidden="true" />}{children}
  </Component>
})

export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { interactive?: boolean }>(
  function Card({ className, interactive = false, ...props }, ref) {
    return <div ref={ref} className={cn('ui-card', interactive && 'ui-card-interactive', className)} {...props} />
  })

export function Badge({ className, tone = 'neutral', dot = false, children, ...props }:
  React.HTMLAttributes<HTMLSpanElement> & { tone?: 'neutral' | 'success' | 'warning' | 'blue'; dot?: boolean }) {
  return <span className={cn('ui-badge', `ui-badge-${tone}`, className)} {...props}>
    {dot && <span className="ui-badge-dot" aria-hidden="true" />}{children}
  </span>
}

export function Input({ className, invalid = false, ...props }:
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }) {
  return <input aria-invalid={invalid || undefined} className={cn('ui-input', invalid && 'is-invalid', className)} {...props} />
}

/** 16px 旋转指示器，配合按钮 busy 态或独立使用；只动 transform。 */
export function Spinner({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn('ui-spinner', className)} role="status" aria-label="加载中" {...props} />
}

/** 纯 CSS 提示：把文字放到 tip，悬停/聚焦可见。不引入定位依赖。 */
export function Tooltip({ className, tip, children, ...props }:
  React.HTMLAttributes<HTMLSpanElement> & { tip: string }) {
  return <span className={cn('ui-tooltip', className)} data-tip={tip} {...props}>{children}</span>
}

export function Kbd({ className, ...props }: React.HTMLAttributes<HTMLElement>) {
  return <kbd className={cn('ui-kbd', className)} {...props} />
}

/** 受控小开关：class 契约与既有 .ui-switch 完全一致（on 表示开启）。 */
export function Switch({ className, checked = false, onCheckedChange, disabled, ...props }:
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & { checked?: boolean; onCheckedChange?: (next: boolean) => void }) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled}
    className={cn('ui-switch', checked && 'on', className)}
    onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) onCheckedChange?.(!checked) }} {...props}>
    <span aria-hidden="true" />
  </button>
}
