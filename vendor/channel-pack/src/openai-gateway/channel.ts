/**
 * 网关渠道的**入口打标**：让记账层区分「直连」与「网关」两路流量。
 *
 * ## 为什么需要打标（而不是在适配器层区分）
 *
 * 网关（`src/openai-gateway/server.ts`）与 DSH 宿主对话调用的是**同一个**
 * `ctx.llm` 运行时（`openai-gateway/index.ts:64` 直接传 `ctx.llm`）——
 * 适配器在流里根本看不到「调用方是谁」。唯一的区分点在**入口**：
 * 网关发请求前在 `GenerateOptions` 上挂一个模块级 `Symbol` 标记，
 * 记账包装层（`src/llm-register-compat.ts`）读到即判 `gateway`。
 *
 * ## 为什么用 Symbol 而不是字符串字段
 *
 * `GenerateOptions` 的形状由 dsh-llm 契约定义，塞任意字符串字段既污染类型、
 * 又可能与上游将来新增的字段撞名；`Symbol` 属性天然不参与序列化/结构克隆
 * （网关内部构造 options，不存在跨进程传输），且**只有同时 import 本模块的
 * 两侧才能读它** —— 记账层与网关层是仅有的两个合法读者。
 *
 * ## ⚠️ 透传前提（issue 已列的验证项 ①）
 *
 * dsh-llm 必须把 `GenerateOptions` **原样**传给适配器（含非自有 Symbol 属性）。
 * 实测它是透传（适配器靠 `options.signal` / `options.messages` 等工作，且
 * `registerAdapter` 直接把 options 交给 adapter.stream）；若未来某版 dsh-llm
 * 改为「重建 options 对象」导致 Symbol 丢失，**不会静默错账**——只会全部记成
 * `direct`（保守缺省），由单测 `tests/unit/token-ledger.spec.ts` 的
 * 「打标丢失时全部落 direct」用例锁住这一退化形态，届时改走差值兜底。
 */

/**
 * 打在 `GenerateOptions` 上的网关标记（模块级唯一）。
 *
 * 用法（网关侧）：`markGatewayChannel(generate)` —— 返回带标记的同一对象。
 * 读法（记账侧）：`channelOfOptions(options)`。
 */
export const GATEWAY_CHANNEL_MARK: unique symbol = Symbol('dsh.openai-gateway.channel')

/**
 * 给网关即将发出的 `GenerateOptions` 打上渠道标记。
 *
 * 返回**同一对象**（原地打标）——网关路径上不复制对象，避免与透传假设纠缠。
 * 对 `null`/非对象入参直接原样返回（防御：打标绝不抛错）。
 */
export function markGatewayChannel<T>(options: T): T {
  try {
    if (typeof options === 'object' && options !== null) {
      (options as { [GATEWAY_CHANNEL_MARK]?: true })[GATEWAY_CHANNEL_MARK] = true
    }
  } catch {
    // 极端入参（sealed Object 等）打不上就不打：记账层会保守记成 direct。
  }
  return options
}

/**
 * 记账层读渠道：带标记 = `gateway`，否则 `direct`。
 *
 * ⚠️ 非 object / null 一律 `direct`（与 `recordTokenUsage` 的保守缺省同口径）。
 */
export function channelOfOptions(options: unknown): 'direct' | 'gateway' {
  return typeof options === 'object' && options !== null
    && (options as { [GATEWAY_CHANNEL_MARK]?: unknown })[GATEWAY_CHANNEL_MARK] === true
    ? 'gateway'
    : 'direct'
}
