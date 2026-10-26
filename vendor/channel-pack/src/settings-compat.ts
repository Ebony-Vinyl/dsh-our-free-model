/**
 * 跨 DSH 版本的 `ctx.settings` 契约适配。
 *
 * ## 契约变更
 *
 * - **≤0.1.6**：`ctx.settings` 是 SettingsProvider，插件用
 *   `register(ns, schema)` 注册**任意**命名空间并拿到 owner scope。
 * - **0.1.7-rc.1**：换成 `SettingsForms` —— **没有 `register`**，
 *   表单命名空间只能是 **profile 条目 id**，且只投影该条目 Config 中
 *   标了 `.volatile()` 的字段；写入走 `update/replace/mutate`（最终落到
 *   profile 的 `cordis.patch.yml`）。
 *
 * 因此旧写法 `settings.register(...)` 在 0.1.7 上恒为「服务不可用」，
 * 而 provider 的 `settingsNs` 也必须改成**本插件的条目 id**（官方适配器同做法：
 * `ctx.fiber.entry?.options.id ?? NS`）—— 2026-10-01 起本插件已不再向 DSH 声明
 * 可配置 provider，故当前只有 {@link settingsNamespaceFor} 承载这条语义而没有调用方
 * （见 `llm-register-compat.ts` 模块头）。
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * `ctx.settings` 的最小结构接口。
 *
 * 刻意全部可选：两个版本各自只实现其中一部分，调用方必须按能力探测，
 * 不能假定任一方法存在。
 */
export interface SettingsServiceLike {
  /** 老契约：注册命名空间（0.1.7 起不存在）。 */
  register?: (ns: string, schema: unknown) => unknown
  /** 0.1.7：声明本插件实例的表单策略（不改变 Config）。 */
  configure?: (presentation: { auto?: boolean }, owner?: unknown) => () => void
  /** 两个版本都有，但取值语义不同（老：任意 namespace；新：profile 条目 id）。 */
  describe?: (options?: { redactSecrets?: boolean }) => Array<{ ns: string; value?: unknown }>
}

/**
 * 安全读取一个服务：替身 ctx（大量单测只 mock 了 `llm`）可能连 `get` 都没有。
 *
 * @param ctx - 任意 ctx 形状（真 cordis Context 或测试替身）。
 * @param key - 服务名。
 * @returns 服务值；`get` 缺失时返回 undefined。
 */
export function readService(ctx: unknown, key: string): unknown {
  const get = (ctx as { get?: unknown } | undefined)?.get
  if (typeof get !== 'function') return undefined
  return (get as (this: unknown, name: string) => unknown).call(ctx, key)
}

/** 取 settings 服务（可能不存在：headless / 单测替身）。 */
export function settingsOf(ctx: Context): SettingsServiceLike | undefined {
  return readService(ctx, 'settings') as SettingsServiceLike | undefined
}

/**
 * 是否仍是「插件可注册任意命名空间」的老契约。
 *
 * 判据只看 `register` 是否为函数 —— 这正是 0.1.7 移除的那个方法。
 */
export function hasLegacyNamespaceRegistration(
  settings: SettingsServiceLike | undefined,
): boolean {
  return typeof settings?.register === 'function'
}

/**
 * 本插件在 profile 中的条目 id（0.1.7 起它就是 settings 命名空间）。
 *
 * `fiber.entry` 在 cordis 4.0.2 的类型里尚未暴露，故按结构读取并在缺失时
 * 返回 undefined —— 调用方必须能接受「拿不到」。
 */
export function ownEntryId(ctx: Context): string | undefined {
  const fiber = (ctx as unknown as { fiber?: { entry?: { options?: { id?: unknown } } } }).fiber
  const id = fiber?.entry?.options?.id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

/**
 * 解析 `registerConfigurableProviders` 的 `settingsNs`。
 *
 * - 老契约：沿用各 provider 自己的 `llm-<id>` 命名空间（与 ≤0.1.6 完全一致）；
 * - 0.1.7+：指向**本插件的 profile 条目 id**（同一插件的六个 provider 共用它，
 *   因为一个插件实例只对应一个条目）。拿不到条目 id 时退回旧名，此时该
 *   provider 在模型设置页会显示为「未配置」，但**不影响路由与收发**。
 */
export function settingsNamespaceFor(ctx: Context, legacyNs: string): string {
  if (hasLegacyNamespaceRegistration(settingsOf(ctx))) return legacyNs
  return ownEntryId(ctx) ?? legacyNs
}

/**
 * 关闭 0.1.7 自动生成的插件配置页。
 *
 * 本插件自带 Channel Pack 设置页（`settings.section` 的 `channel-pack` 条目），
 * 不需要再由 Config schema 反渲染一个表单。老契约没有这个方法，静默跳过。
 *
 * `configure()` 返回 disposer，故挂到本插件的 effect 上：插件重载时策略随
 * 旧实例一起撤销，不会在两个实例间留下悬挂的 presentation。
 */
export function suppressAutoSettingsPage(ctx: Context): void {
  const settings = settingsOf(ctx)
  if (typeof settings?.configure !== 'function') return
  const configure = settings.configure.bind(settings)
  const owner = (ctx as unknown as { fiber?: unknown }).fiber
  const effect = (ctx as unknown as { effect?: (body: () => unknown, label?: string) => unknown }).effect
  const register = (): unknown => configure({ auto: false }, owner)
  try {
    if (typeof effect === 'function') effect.call(ctx, register, 'channel-pack: settings presentation')
    else register()
  } catch {
    // 已配置过（同一实例重复调用）不是错误。
  }
}
