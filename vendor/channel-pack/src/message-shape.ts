/**
 * harness 消息形状归一化。
 *
 * DSH 在 0.1.7 把「工具结果」从**包裹块**改成**一等消息**：
 *
 * | | ≤0.1.6 | 0.1.7+ |
 * |---|---|---|
 * | 承载 | `role:'user'` 内嵌 `{type:'tool-result',toolCallId,content,isError}` | **`role:'tool'` 消息**，`toolCallId`/`isError` 在**顶层** |
 * | `ContentBlockMap` | 含 `'tool-result'` | **删除** `'tool-result'` |
 * | 角色 | system / user / assistant | 新增 **`tool`**、**`developer`** |
 *
 * ⚠️ **`StreamChunk`（插件产出方向）在 0.1.5→0.1.7 逐字节未变** —— 本模块只处理
 * **消费**方向（harness 传给适配器的 `options.messages`），适配器的 `stream()`
 * 产出逻辑无需任何改动。
 *
 * ## 为什么必须归一化
 *
 * 五个适配器的序列化实现都按 ≤0.1.6 形状识别工具结果（`type === 'tool-result'`）。
 * 在 0.1.7 下该判据恒不命中，于是：
 *
 * 1. 工具输出被当成**普通用户消息**下发，`tool_call_id` 关联丢失；
 * 2. `resolveToolPairing` 收集到的结果 id 集合为**空**
 *    → `usable.every(block => allResultIds.has(...))` 恒 false
 *    → **assistant 的 `tool_calls` 被整体剔除**。
 *
 * 最终 wire 上完全没有工具调用记录，模型看到的是"我说了段话，用户回了段工具
 * 输出"，表现为**提前判定对话结束**或**陷入循环思考**。
 *
 * 实证（真实 session `session-54cbd95c`，2492 行 v3 日志经 0.1.7 解析器迁移）：
 * 512 条工具调用在 0.1.7 形状下保留 **0** 条，套回 0.1.5 形状则保留 512 条。
 *
 * ## 设计取舍
 *
 * 把 0.1.7 形状**降级**为既有代码已理解的 0.1.5 形状，而不是改造五个序列化
 * 实现 —— 后者需要触碰 `buddy-adapter` / `lobsterai-adapter` 等已被大量单测
 * 与线上流量验证的代码（AGENTS.md 明确禁止顺手重构）。降级方案让改动收敛为
 * 「每个入口插一次调用」。
 *
 * 探测用**形状**而非版本号（沿用 `settings-compat.ts` 的能力探测先例）：
 * 版本号需要额外的运行时信息，而形状就在入参里，且对"升级期混合形态"天然鲁棒。
 */

/** harness 传给适配器的消息（只需 role / content / toolCallId 三个维度）。 */
export interface HarnessMessageLike {
  role: string
  content?: unknown
  toolCallId?: unknown
  isError?: unknown
  [key: string]: unknown
}

/** 归一化探测结果。 */
export type MessageShape =
  /** ≤0.1.6：工具结果包裹在 user 消息的 `tool-result` 块里。 */
  | 'legacy'
  /** 0.1.7+：工具结果是一等 `role:'tool'` 消息。 */
  | 'tool-role'
  /** 整段历史没有任何工具结果。 */
  | 'none'

/** 判断一个 content 块是否为 ≤0.1.6 的 `tool-result` 包裹块。 */
function isWrappedToolResult(block: unknown): boolean {
  return typeof block === 'object' && block !== null
    && (block as { type?: unknown }).type === 'tool-result'
}

/** 判断一条消息是否为 0.1.7 的一等工具结果消息。 */
function isToolRoleMessage(message: HarnessMessageLike): boolean {
  return message.role === 'tool'
}

/**
 * 探测整段历史的消息形状。
 *
 * ⚠️ **同时出现两种形态时以 `tool-role` 为准**：升级期的会话可能前半段是旧
 * 形态、后半段是新形态，而 `tool` 角色是 0.1.7 的权威判据。反之若判成
 * `legacy`，新形态的工具结果会被漏掉，等于没修。
 *
 * @param messages - harness 传入的完整消息序列。
 * @returns 该历史使用的形状。
 */
export function detectMessageShape(messages: readonly HarnessMessageLike[]): MessageShape {
  let sawLegacy = false
  for (const message of messages) {
    if (isToolRoleMessage(message)) return 'tool-role'
    const content = message.content
    if (Array.isArray(content) && content.some(isWrappedToolResult)) sawLegacy = true
  }
  return sawLegacy ? 'legacy' : 'none'
}

/**
 * 把 0.1.7 的一等 `tool` 消息降级为 ≤0.1.6 的包裹形状。
 *
 * 规则：
 * - `role:'tool'` → `role:'user'`，content 包成单个 `{type:'tool-result',...}` 块，
 *   `toolCallId` 取自顶层（缺失时回退 `source.callId`），`isError` **仅在存在时**携带
 *   （避免给下游造出 `isError: undefined` 的差异）；
 * - `role:'developer'` → **丢弃**。它只承载工具增删元数据（`tool-addition` /
 *   `tool-removal`），不是对话内容。插件不声明 `toolUpdate` 能力时 harness 的
 *   `projectToolUpdates` 本会自行剥离（`withoutDeveloperMessages`），此处兜底，
 *   防止它被当作普通 user 消息下发给上游；
 * - 其余消息**原样透传**（保持引用身份）。
 *
 * ⚠️ **`content` 数组整体保留、不压平** —— 既有实现依赖内嵌 `image` 块做图片
 * 提升（工具结果内嵌图片须挂到其后的独立 user 消息），压平会让图片静默丢失。
 *
 * @param messages - harness 传入的完整消息序列。
 * @returns 归一化后的消息序列；**无需改动时返回原数组引用**（零成本透传）。
 */
export function normalizeHarnessMessages<T extends HarnessMessageLike>(
  messages: readonly T[],
): readonly HarnessMessageLike[] {
  // `detectMessageShape` 只回答"工具结果长什么样"；`developer` 是 0.1.7 专有角色
  // （0.1.5 的 role 联合类型只有 system/user/assistant），无论有没有工具结果都
  // 必须剥离。两个判据相互独立，故在此分别求值。
  const shape = detectMessageShape(messages)
  const hasDeveloper = messages.some(message => message.role === 'developer')
  if (shape !== 'tool-role' && !hasDeveloper) {
    // 0.1.5 路径：连数组身份都不变，确保既有行为逐字节不受影响。
    return messages
  }
  const normalized: HarnessMessageLike[] = []
  for (const message of messages) {
    if (message.role === 'developer') continue
    if (!isToolRoleMessage(message)) {
      normalized.push(message)
      continue
    }
    // `source.callId` 是 0.1.7 的伴随字段；顶层缺失时回退它，
    // 两者都缺则保持 undefined（下游按"无 id"处理，与旧行为一致）。
    const source = message['source']
    const sourceCallId = typeof source === 'object' && source !== null
      ? (source as { callId?: unknown }).callId
      : undefined
    const toolCallId = message.toolCallId ?? sourceCallId
    const block: Record<string, unknown> = {
      type: 'tool-result',
      toolCallId,
      content: message.content,
    }
    if (message.isError !== undefined) block.isError = message.isError
    normalized.push({ role: 'user', content: [block] })
  }
  return normalized
}

/**
 * 收集**消息承载**的 system 文本。
 *
 * ## 为什么需要
 *
 * DSH 把系统提示词放在 `GenerateOptions.system`（见 `dsh-llm` 的
 * `GenerateOptions`），**同时**把它作为 `role:'system'` 消息放进
 * `options.messages` 的首位。两处内容一致，任取其一即可 —— 但只有
 * `dsh-llm-deepseek` 做了一次「把 `system` 消息提到 `system` 字段」的提升。
 *
 * Gemini / MiniMax 的序列化实现**只**读 `options.system`（`gemini-messages.ts`
 * 与 `minimax-messages.ts` 的注释都写着「DSH 不会把 system 放进 messages」），
 * 于是把 `role:'system'` 显式 `continue` 掉。该假设不成立时，整段系统提示词
 * ——身份、人格、工具说明、以及别的插件注册的提示词段—— 会在**没有任何报错**
 * 的情况下从请求里消失。表现为模型不遵守任何指令，却照常回答。
 *
 * 实证：同一份 64470 字符的提示词（sha256 `400265a601fd`）在两个 provider 下
 * 行为相反 —— deepseek 复述了提示词里的 Bangla 偏好，Gemini 从未复述。
 *
 * ## 取舍
 *
 * 收集放在**共享模块**而不是两个适配器各自实现：三处（含 Minimax）都要同一
 * 判据，重复实现必然漂移。`developer` 不参与收集 —— 它只承载工具增删元数据，
 * 不是系统提示词。
 *
 * @param messages - harness 传入的完整消息序列（归一化前后均可）。
 * @returns 各 system 消息文本按出现顺序以空行连接；无 system 消息时返回 `''`。
 */
export function collectHarnessSystem(messages: readonly HarnessMessageLike[]): string {
  const parts: string[] = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object' || message.role !== 'system') continue
    const content = message.content
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
          .filter((block): block is { type: string; text: string } => (
            typeof block === 'object' && block !== null
            && (block as { type?: unknown }).type === 'text'
            && typeof (block as { text?: unknown }).text === 'string'
          ))
          .map(block => block.text)
          .join('\n')
        : ''
    if (text !== '') parts.push(text)
  }
  return parts.join('\n\n')
}
