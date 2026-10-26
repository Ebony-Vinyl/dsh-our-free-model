/**
 * OpenAI chat payload 构造 + FreeTier 形状门禁注入（**v2 指纹**）。
 *
 * ## 门禁依据（v2，2026-10-14 起）
 *
 * 匿名通道按 **v2 客户端**校验工具形状，与 `src/upstream.js`（插件自己的免费
 * 车道）同一套规则：
 *
 * 1. 必须声明 `read` 与 `shell` **两个**工具，且 description 与参数 schema
 *    与官方客户端**逐字一致**（下面的常量即逐字副本）；
 * 2. 调用方自己的工具原样保留，含 `Read`/`Bash` 这类大小写变体；
 * 3. 调用方若**正好**用了 `read`/`shell` 这个名字但定义不同，改名成
 *    `<name>_client[N]`，响应侧再还原；
 * 4. `tool_choice: 'none'` 一律 403，绝不下发；
 * 5. 注入的工具会被模型真的调用（v2 的定义是真工具），所以注入后要补一句
 *    系统提示「别调它们」。
 *
 * ⚠️ v1 的四个名字（`bash`/`glob`/`grep`/`read`）+「空 schema 补一个占位
 * property」已失效：v2 比对定义本身，桩描述与空 properties 都会 403。
 * ⚠️ 门禁参数**收敛在本文件**，不散落到适配器 —— 服务端再收紧时只改一处。
 * ⚠️ 账号槽（带 API key）**同样注入**：免费通道与认证通道的服务端策略
 * 可能共用同一层形状检查，多注入一层对认证通道无害（官方 CLI 本来也带
 * 全套工具），但缺了它就可能让匿名槽整体失效。
 */

/** DSH 的工具 schema（`GenerateOptions.tools` 的形状）。 */
export interface OpencodeHarnessTool {
  name: string
  description: string
  parameters?: Record<string, unknown>
}

/** OpenAI wire 侧的工具定义。 */
export interface OpencodeWireTool {
  type: 'function'
  function: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/** 门禁工具名（服务端按这两个名字**及其定义**识别官方客户端形状）。 */
export const FREE_LANE_GATE_TOOLS = ['read', 'shell'] as const
const FREE_LANE_GATE_TOOL_SET = new Set<string>(FREE_LANE_GATE_TOOLS)

/**
 * 官方定义（**逐字**取自 OpenCode v2.0.26 CLI；与 `src/upstream.js` 的同名
 * 常量必须保持一致 —— 两处不一致时以本文件为准并同步过去）。
 *
 * ⚠️ 不要改写措辞、不要精简 schema、不要调换键序：上游比对 description 与
 * parameters 的 JSON，任何改动都是 403 FreeTierError。
 */
const GATE_TOOL_DEFINITIONS: Readonly<Record<string, { description: string; parameters: Record<string, unknown> }>> = Object.freeze({
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: 'Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
})

/** wire 名称 → 调用方名称；响应工具调用时需要还原调用方名称。 */
export type OpencodeToolNameMap = ReadonlyMap<string, string>

/** 门禁工具的官方声明（chat 形状）。 */
function gateTool(name: string): OpencodeWireTool {
  const definition = GATE_TOOL_DEFINITIONS[name]
  return {
    type: 'function',
    function: {
      name,
      description: definition?.description ?? '',
      parameters: definition?.parameters ?? { type: 'object', properties: {} },
    },
  }
}

/** 工具名（chat 形状 `{function:{name}}` 与扁平 `{name}` 都认）。 */
function wireToolName(tool: unknown): string {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return ''
  const row = tool as { name?: unknown; function?: { name?: unknown } }
  const name = typeof row.name === 'string' && row.name.trim() !== '' ? row.name : row.function?.name
  return typeof name === 'string' ? name.trim() : ''
}

/** 这个工具是否已带官方定义（description 与 parameters 逐字一致）。 */
function isOfficialGateTool(tool: unknown, name: string): boolean {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return false
  const row = tool as { description?: unknown; parameters?: unknown; function?: { description?: unknown; parameters?: unknown } }
  const wrapper = row.function !== null && typeof row.function === 'object' ? row.function : row
  const definition = GATE_TOOL_DEFINITIONS[name]
  if (definition === undefined) return false
  return wrapper.description === definition.description
    && JSON.stringify(wrapper.parameters) === JSON.stringify(definition.parameters)
}

/** 换掉工具的 wire 名称，保留其余字段（含 `function` 包裹层）。 */
function withWireToolName(tool: unknown, name: string): unknown {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return tool
  const row = tool as { function?: Record<string, unknown> }
  if (row.function !== null && typeof row.function === 'object' && !Array.isArray(row.function)) {
    return { ...row, function: { ...row.function, name } }
  }
  return { ...row, name }
}

/**
 * 注入「别调注入工具」的系统提示。
 *
 * ⚠️ v2 的定义是真工具（官方描述与 schema），模型会真的去调它；v1 靠
 * 「must not be used」的桩描述压住，v2 只能用提示词。措辞是实测选出来的：
 * 「不可用」会让模型连调用方自己的 `Read`/`Bash` 也拒绝，「占位、请用别的工具」
 * 才既压住注入项、又不误伤调用方工具。
 */
function noteInjectedGateTools(payload: Record<string, unknown>, names: readonly string[]): void {
  const list = names.map((name) => `\`${name}\``).join(' or ')
  const note = names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
  // ⚠️ 本渠道的 system 提示走**顶层 `system` 字段**（见 payload 构造），不是
  // messages 里的一条；两条路都要覆盖，否则注入的提示会静默丢失。
  if (typeof payload.system === 'string' && payload.system !== '') {
    payload.system = `${payload.system}\n\n${note}`
    return
  }
  if (typeof payload.system === 'string') {
    payload.system = note
    return
  }
  const messages = Array.isArray(payload.messages) ? (payload.messages as unknown[]) : []
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined
  if (first?.role === 'system' && typeof first.content === 'string') {
    payload.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)]
    return
  }
  payload.messages = [{ role: 'system', content: note }, ...messages]
}

/**
 * 把 `tool_choice` 指向被改名工具的别名（只动别名，其余原样）。
 *
 * ⚠️ 绝不写回 `none`：v2 见到 `tool_choice: 'none'` 就 403。
 */
function retargetGateToolChoice(payload: Record<string, unknown>, toolNameMap?: Map<string, string>): void {
  if (toolNameMap === undefined || toolNameMap.size === 0) return
  const choice = payload.tool_choice
  if (choice === null || typeof choice !== 'object' || Array.isArray(choice)) return
  const aliases = new Map([...toolNameMap].map(([alias, original]) => [original, alias]))
  const row = choice as { name?: unknown; function?: { name?: unknown } }
  if (typeof row.name === 'string') {
    const alias = aliases.get(row.name.trim())
    if (alias !== undefined) payload.tool_choice = { ...row, name: alias }
    return
  }
  const fn = row.function
  if (fn !== null && typeof fn === 'object' && typeof fn.name === 'string') {
    const alias = aliases.get(fn.name.trim())
    if (alias !== undefined) payload.tool_choice = { ...row, function: { ...fn, name: alias } }
  }
}

/**
 * 把历史里对被改名工具的调用一起改成别名。
 *
 * ⚠️ 与 `src/upstream.js` 的 {@link aliasHistoryToolCalls} 同一职责：调用方的
 * `read` 让位给官方定义后改名成 `read_client`，而模型自己的历史调用还写着
 * `read` —— 不一起改，上游读到的是「对官方 `read` 的一次调用」，参数却是调用方
 * 那套，两侧定义对不上。本文件只服务 chat 线，故只处理 `tool_calls`。
 */
function aliasHistoryToolCalls(payload: Record<string, unknown>, toolNameMap?: Map<string, string>): void {
  if (toolNameMap === undefined || toolNameMap.size === 0) return
  const aliases = new Map([...toolNameMap].map(([alias, original]) => [original, alias]))
  if (!Array.isArray(payload.messages)) return
  payload.messages = (payload.messages as unknown[]).map((message) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
    const row = message as { tool_calls?: unknown }
    if (!Array.isArray(row.tool_calls)) return message
    return {
      ...row,
      tool_calls: row.tool_calls.map((call) => {
        if (call === null || typeof call !== 'object' || Array.isArray(call)) return call
        const entry = call as { function?: { name?: unknown } }
        const name = entry.function?.name
        if (typeof name !== 'string' || !aliases.has(name)) return call
        return { ...entry, function: { ...entry.function, name: aliases.get(name) } }
      }),
    }
  })
}

/**
 * DSH 工具 → wire 工具（**不改名**）。
 *
 * ⚠️ 这是 `options.tools` 的**唯一出口**。不下发它，模型在 wire 上看不到
 * 任何函数定义，只能用正文里的 XML 臆造工具调用 —— qoder 的用户报障
 * 「执行任务出现任务调用 xml 泄露任务终止」就是这个根因。
 *
 * ⚠️ v2 起这里**不再做大小写归并**：上游接受 `Read`/`Bash` 与注入的
 * `read`/`shell` 并存，而归并会把调用方的 `Read` 变成 `read` —— 正好撞上
 * 「同名但定义不同」的判定，反而需要改名。改名与注入统一在
 * {@link ensureFreeLaneShape} 里做。
 */
export function buildOpencodeTools(
  tools: readonly OpencodeHarnessTool[] | undefined,
): OpencodeWireTool[] {
  if (tools === undefined || tools.length === 0) return []
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      ...(tool.description.length > 0 ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    },
  }))
}

/**
 * 满足 v2 门禁：注入 `read`/`shell`，冲突的调用方工具改名。
 *
 * @param toolNameMap 改名表（`别名 → 调用方原名`），由响应侧用来还原名字。
 * @returns 满足门禁的 body；**已满足**时返回同一引用。
 */
export function ensureFreeLaneShape(
  payload: Record<string, unknown>,
  toolNameMap?: Map<string, string>,
): Record<string, unknown> {
  if (!Array.isArray(payload.messages)) return payload
  const tools = Array.isArray(payload.tools) ? (payload.tools as unknown[]) : []
  const taken = new Set<string>()
  for (const tool of tools) {
    const name = wireToolName(tool)
    if (name !== '') taken.add(name)
  }

  const seen = new Set<string>()
  const present = new Set<string>()
  const next: unknown[] = []
  let changed = false
  for (const tool of tools) {
    const name = wireToolName(tool)
    if (!FREE_LANE_GATE_TOOL_SET.has(name)) {
      next.push(tool)
      continue
    }
    // 同名重复声明：上游按重复拒，留第一个。
    if (seen.has(name)) { changed = true; continue }
    seen.add(name)
    if (isOfficialGateTool(tool, name)) {
      next.push(tool)
      present.add(name)
      continue
    }
    // 调用方用同名但定义不同 → 让位给官方定义，自己改走别名。
    let alias = `${name}_client`
    for (let i = 2; taken.has(alias); i += 1) alias = `${name}_client${i}`
    taken.add(alias)
    toolNameMap?.set(alias, name)
    next.push(withWireToolName(tool, alias))
    changed = true
  }

  const injected: string[] = []
  // ⚠️ 判据是 `present` 而不是 `seen`：调用方的 `read` 被改成 `read_client` 后
  // `read` 这个名字并没有留下，官方定义必须补上（否则门禁 403）。
  for (const name of FREE_LANE_GATE_TOOLS) {
    if (present.has(name)) continue
    next.push(gateTool(name))
    injected.push(name)
    changed = true
  }

  if (!changed) {
    retargetGateToolChoice(payload, toolNameMap)
    aliasHistoryToolCalls(payload, toolNameMap)
    return payload
  }
  const shaped: Record<string, unknown> = { ...payload, tools: next }
  retargetGateToolChoice(shaped, toolNameMap)
  aliasHistoryToolCalls(shaped, toolNameMap)
  if (injected.length > 0) noteInjectedGateTools(shaped, injected)
  // ⚠️ 绝不写回 `tool_choice: 'none'`：v2 见到它就 403。旧实现会在「调用方
  // 一个工具都没有」时补 `none` 来压住诱饵，那条路已经不存在了。
  if (shaped.tool_choice === 'none'
    || (shaped.tool_choice !== null && typeof shaped.tool_choice === 'object'
      && (shaped.tool_choice as { type?: unknown }).type === 'none')) {
    delete shaped.tool_choice
  }
  return shaped
}

export interface OpencodePayloadInput {
  model: string
  messages: ReadonlyArray<Record<string, unknown>>
  system?: string
  tools?: readonly OpencodeHarnessTool[]
  temperature?: number
  maxTokens?: number
  /**
   * 思考档位（issue IKJJ0V）。
   *
   * ⚠️ 取自 `GenerateOptions.reasoningEffort`（品牌类型 `ReasoningEffortId`，
   * 传进来前转成普通字符串）。声明了档位就**必须真的发出去**，否则选择器只是
   * UI 装饰 —— 用户选了「高」却没有任何效果。
   */
  reasoningEffort?: string
}

/** 构造一次 chat 请求的完整 body（已过门禁）。 */
export function buildOpencodePayloadWithToolMap(input: OpencodePayloadInput): {
  payload: Record<string, unknown>
  toolNameMap: OpencodeToolNameMap
} {
  const toolNameMap = new Map<string, string>()
  const base: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    // ⚠️ 恒 true：这是门禁的一半要求。
    stream: true,
    tools: buildOpencodeTools(input.tools),
    ...input.system !== undefined && input.system.length > 0 ? { system: input.system } : {},
    ...typeof input.temperature === 'number' && Number.isFinite(input.temperature)
      ? { temperature: input.temperature }
      : {},
    // ⚠️ 只放行安全正整数：0 / 负数 / NaN 会让 DSH 侧抛
    // INVALID_MODEL_MAX_TOKENS，把整轮对话搞崩（不是降级，是崩）。
    ...Number.isSafeInteger(input.maxTokens) && (input.maxTokens ?? 0) > 0
      ? { max_tokens: input.maxTokens }
      : {},
    // ⚠️ 思考档位（issue IKJJ0V）。**声明了档位就必须真的发出去**，
    // 否则选择器只是 UI 装饰 —— 用户选了「高」却拿不到任何效果。
    //
    // 参数名 `reasoning_effort` 由**实测**确定（2026-10-02）：给
    // `ling-3.0-flash-fin-free` 传非法值时，错误信息变成 `[400] reasoning_…`
    // （与基线的 `Endpoint is unavailable` 不同），说明 Zen 侧确实解析并校验它。
    //
    // ⚠️ 只发**模型声明过的**档位：上游对非法值是 400，而档位表来自 models.dev
    // 的 `reasoning_options`（官方 CLI 的同一份数据）。上游对越界值的兜底由
    // 适配器的 `resolveOpencodeEffort()` 负责（就近翻译 / 丢弃）。
    ...typeof input.reasoningEffort === 'string' && input.reasoningEffort.length > 0
      ? { reasoning_effort: input.reasoningEffort }
      : {},
  }
  return { payload: ensureFreeLaneShape(base, toolNameMap), toolNameMap }
}

/** 构造一次 chat 请求的完整 body（已过门禁）。 */
export function buildOpencodePayload(input: OpencodePayloadInput): Record<string, unknown> {
  return buildOpencodePayloadWithToolMap(input).payload
}
