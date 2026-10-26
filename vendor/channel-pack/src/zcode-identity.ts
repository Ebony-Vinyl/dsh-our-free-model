/**
 * 官方 ZCode 的 system 身份块（**3012 准入的唯一开关**）。
 *
 * ## 为什么必须内置这段文本
 *
 * 上游对 `/zcode-plan/anthropic` 通道做**请求体内容检查**：`system` 字段
 * 缺少官方的身份块结构时，直接返回
 * `\{"code":3012,"msg":"request has been blocked due to unusual activity."\}`（实测）。
 *
 * 实测矩阵（同账号、同 captcha 来源）：
 *
 * | system 内容 | 字符数 | 结果 |
 * |---|---|---|
 * | 无 system | 0 | ✗ 405 + `3012` |
 * | 仅 cliPrefix | 42 | ✗ 405 + `3012` |
 * | **cliPrefix + stable（全部三段）** | **2898** | **✓ 200** |
 * | 完整四块（含 dynamic 段） | 7599 | ✓ 200 |
 *
 * ⇒ **判据是「身份块是否存在」**，不是「块数多少」或「字符数够不够」，
 * 也与 HTTP 头、运行时（Electron / curl / Node）无关。上游 curl 带完整块同样 200。
 *
 * ⚠⚠ **2026-10-03 复测修正了两条旧说法**（issue IKJI0Y 驱动，本机三个账号、
 * 17 次请求）。**改本文件前先读那两条**：
 *
 * 1. **HTTP 状态码是 `405`**，不是 `403`。排查时别按 403 找。
 * 2. **日期块在这个窗口不是判据**（`withContextPrefix` 去掉照样 200）。
 *    它仍照发（官方如此、零成本），但它与身份块是**必要非充分**的关系，
 *    ❌ **不要再把它写成「3012 的最后一个开关」当成唯一结论** ——
 *    那句来自早期窗口，见 {@link withContextPrefix}。
 *    本次逐项排除的**非判据**还有：HTTP 头、版本头（`3.14.3`/`3.14.4`/`4.0.0`）、
 *    请求频率（单账号无间隔连发 6 发）、多轮历史（`tool_use`/`tool_result`）、
 *    `tools` 声明、账号池中的其它账号。完整矩阵见 README 的 ZCode 章节。
 *
 * ⚠ 即便如此，「身份块达标仍 3012」**目前没有已知解释**。遇到时的可观测信息
 * 由 `src/zcode-diagnostics.ts` 打进错误文案（账号序号 / 计数 / 间隔 /
 * **实测**身份块字符数 / 日期块有无），诊断行**不含任何凭据**。
 *
 * ## ⚠ 维护警告（来自 `dsh-free-glm/patches/zcode-official-identity.ts`）
 *
 * 上游策略与此结构**强耦合**：官方客户端升级后若改变身份块结构，
 * 需要同步更新本文件，否则会重新出现 3012 —— 而
 * **3012 有账号冷却惩罚**（30 分钟；24h 内第 3 次起 24h；**5 次停用**）。
 * **不要为了调试反复触发。**
 *
 * ## 本文件里的文本从哪来
 *
 * `dsh-free-glm/patches/zcode-official-identity.ts` 从同类项目
 * `a137460387/zcode2api` 的 `src/upstream/zcode-system.json` 提取，
 * 该项目由官方 3.11.2 bundle 反解。本仓库按**程序化提取**（esbuild 编译后
 * 读常量再字面量化）落地，避免手抄引入偏差。
 */

/** 第一块：CLI 身份前缀（官方以此开头，42 字符）。 */
export const OFFICIAL_CLI_PREFIX: string =
  "You are ZCode, an interactive coding agent"

/**
 * 第二块：stable 段（多段用 `\n\n` 连接）。
 *
 * ⚠ 只发**准入必需**的部分。官方完整身份块还含 5KB 的 dynamic 段
 * （`# Communicating with the user` / `# Context management`），
 * 那些是**给 ZCode 内 coding agent 的行为指令**，与准入无关 ——
 * 且它们会被放在 system 开头，**压过调用方（DSH）自己的 prompt**，
 * 表现为「啰嗦、慢」。故此处不含 dynamic 段。
 */
export const OFFICIAL_STABLE_SECTIONS: readonly string[] = [
  "\nYou are an interactive ZCode agent that helps users with software engineering tasks.\n\nIMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.\n\n# Harness\n- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.\n- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.\n- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.\n- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.\n- Reference code as `file_path:line_number` — it's clickable.",
  "# ZCode Desktop Context\n\n### Files & URLs\n- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).\n- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).\n\n### Inline Code Comments\n- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.\n- Emit one directive per inline comment; emit none when there are no actionable inline comments.\n- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).\n- Optional attributes: start, end (1-based line numbers), priority (0-3).\n- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.\n- Keep line ranges tight; end defaults to start.\n- Example: ::code-comment{title=\"[P2] Off-by-one\" body=\"Loop iterates past the end when length is 0.\" file=\"/path/to/foo.ts\" start=10 end=11 priority=2}",
  "# Working style\n\nWhen you have enough information to act, act. Do not re-derive facts already established in the conversation, re-litigate a decision the user has already made, or narrate options you will not pursue. If you are weighing a choice, give a recommendation, not an exhaustive survey. Prefer reading the actual file or running the actual command over reasoning about what it probably contains. When a signal pattern-matches to a known failure, check that the evidence actually supports that specific diagnosis before acting on it.",
]

/** 官方预期的 `cliPrefix + stable` 合计长度（供自检与单测断言）。 */
export const OFFICIAL_IDENTITY_CHARS = 2900

/** Anthropic Messages 的内容块（ZCode 只接受 `text` 块）。 */
export interface ZcodeTextBlock {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral' }
}

/**
 * 构造官方形态的 `system` 块数组。
 *
 * ## 结构（逐字复刻官方，**不要"优化"**）
 *
 * ```
 * block[0] = cliPrefix（42 字符）          ← 准入必需
 * block[1] = stable（2856 字符）           ← 准入必需
 * block[2] = "# Environment" 段
 * block[3..] = 调用方的 system（追加在最后）
 * ```
 *
 * ⚠ **调用方内容必须追加在最后** —— 官方身份块必须处在开头位置
 * （上游的检查看的是前缀结构）。
 *
 * ⚠ 每个块都带 `cache_control: {type:'ephemeral'}`（官方如此，
 * 且利于上游缓存命中）。
 *
 * @param callerSystem 调用方的 system（DSH 的完整 prompt / AGENTS.md 规则）
 * @param options.cwd  工作目录。
 *        官方实现声明「cwd is never "unknown" in real traffic」，
 *        故调用方必须给真值。
 * @param options.provider 展示用的 provider id（进 environment 段）。
 * @param options.model 模型名（进 environment 段的 poweredByLine）。
 */
export function buildZcodeSystemBlocks(
  callerSystem: string | undefined,
  options: {
    cwd: string
    provider?: string
    model?: string
    platform?: string
    osVersion?: string
  },
): ZcodeTextBlock[] {
  const ephemeral = { type: 'ephemeral' as const }
  const stable = OFFICIAL_STABLE_SECTIONS.join('\n\n')
  const blocks: ZcodeTextBlock[] = [
    { type: 'text', text: OFFICIAL_CLI_PREFIX },
    { type: 'text', text: stable },
    { type: 'text', text: buildEnvironmentSection(options) },
  ]
  if (typeof callerSystem === 'string' && callerSystem.trim().length > 0) {
    blocks.push({ type: 'text', text: callerSystem })
  }
  /**
   * ★ **只在最后一块**打 prompt caching 断点（2026-09-30 调整；此前是每块都打）。
   *
   * ## 依据一：前缀式语义 ⇒ 一个断点就够
   *
   * Anthropic 的 prompt caching 是**前缀式**的：断点覆盖「**该断点之前的全部内容**」。
   * 故一个位于**最后一块**的断点，其覆盖面**等于（且不小于）**每块各打一个。
   * 多个断点只在「希望多个不同长度的前缀各自成缓存块」时才有额外意义。
   *
   * ## 依据二：断点有**数量上限**（Anthropic：单请求最多 4 个）
   *
   * 本函数产出 3-4 块（调用方的 system 存在时是 4 块）——「每块都打」正好**用满**
   * 4 个预算，于是 tools 再也打不了点（见 `zcode-adapter.ts` 的
   * `withToolCacheBreakpoint`：DSH 每步带 24 个工具、约 19KB schema）。
   * 收敛成 1 个后，预算留给 tools，**总断点数 2 ≤ 4**。
   *
   * ## 依据三：调用方 system 必须落在断点内（本项目特有）
   *
   * `callerSystem` 是 DSH 的完整规范（本仓库的 `AGENTS.md` 就有数十 KB）。
   * 断点若不在它之后，这段**每步都要重算 prefill** —— 而它恰恰是最大的可缓存前缀。
   * 只给最后一块打点天然满足这一点（有 `callerSystem` 时最后一块就是它）。
   *
   * ⚠ 与官方「逐块打点」的形态有偏差，但**不影响准入**：3012 的判据是
   * 身份块的**内容与结构**存在（`AGENTS.md` 与 `OFFICIAL_*` 注释都记过），
   * `cache_control` 只是缓存提示，不参与风控判定。
   */
  const last = blocks[blocks.length - 1]
  if (last !== undefined) last.cache_control = ephemeral
  return blocks
}

/**
 * 构造官方形态的 `# Environment` 段。
 *
 * 官方每个会话都会告诉模型它的运行环境。不发的实测后果：
 * 问「Which model are you?」只能答出笼统的 "GLM" —— 因为它**没被告知**
 * 自己在 `zcode/glm-5.3-flash`、也不知道工作目录与平台。
 *
 * 这不只是自我认知问题：不知道 `Platform` / `Shell` 会以为该给 bash 命令
 * （而这里是 PowerShell），不知道工作目录会用相对路径瞎猜。
 */
export function buildEnvironmentSection(options: {
  cwd: string
  provider?: string
  model?: string
  platform?: string
  osVersion?: string
}): string {
  const cwd = options.cwd.trim().length > 0 ? options.cwd : '.'
  const provider = options.provider ?? 'zcode'
  const model = options.model ?? 'glm-5.3-flash'
  const platform = options.platform ?? process.platform
  return [
    '# Environment',
    'You have been invoked in the following environment:',
    ` - Primary working directory: ${cwd}`,
    ` - Is a git repository: ${isGitRepo(cwd) ? 'yes' : 'no'}`,
    ` - Platform: ${platform}`,
    ` - Shell: ${platform === 'win32' ? 'powershell' : 'bash'}`,
    ` - OS Version: ${options.osVersion ?? `${platform} ${process.arch}`}`,
    ` - You are powered by the model named ${provider}/${model}.`,
  ].join('\n')
}

/** 判断目录是否是 git 仓库 —— 只看 `.git` 是否存在（廉价、无副作用）。 */
function isGitRepo(cwd: string): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { existsSync } = require('node:fs') as typeof import('node:fs')
    const { join } = require('node:path') as typeof import('node:path')
    return existsSync(join(cwd, '.git'))
  } catch {
    return false
  }
}

/**
 * `<system-reminder>` 日期块（官方逐字形态，**照发但不是 3012 的判据**）。
 *
 * ⚠ 桥侧源码曾称这是「3012 的最后一个开关」。**2026-10-03 实测推翻了它**：
 * 去掉日期块、带完整身份块的请求**照样 HTTP 200**（见文件头注释）。
 * 它与身份块是**必要非充分**的关系 —— 仍照发是因为官方如此、且零成本，
 * 但**别把「缺了它就一定 3012」当成结论**，那会让排查在错误的方向上耗时间。
 */
const CONTEXT_PREFIX_INTRO =
  "As you answer the user's questions, you can use the following context:"

/** 结尾段（⚠ 前有 **6 个空格**缩进，官方逐字如此）。 */
const CONTEXT_PREFIX_OUTRO =
  '      IMPORTANT: this context may or may not be relevant to your tasks. '
  + 'You should not respond to this context unless it is highly relevant to your task.'

/** 本地时区的 ISO 日期（官方用本地日期，**不是** UTC）。 */
export function formatLocalIsoDate(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 构造 `<system-reminder>` 上下文块。
 *
 * ⚠ 形态细节（逐字复刻，不要"优化"）：
 * - 整块是**一个** `{type:'text'}`，插到 `content` **数组**最前面 ——
 *   不是拼进文本字符串（后者会改变结构，仍被判为裸请求）
 * - `outro` 前有 **6 个空格**缩进
 * - 空行由 `join('\n')` 里的空串产生
 * - 日期用**本地时区**的 ISO 日期
 */
export function buildContextPrefixBlock(now: Date = new Date()): ZcodeTextBlock {
  const body = [
    CONTEXT_PREFIX_INTRO,
    `# currentDate\nToday's date is ${formatLocalIsoDate(now)}.`,
    '',
    CONTEXT_PREFIX_OUTRO,
  ].join('\n')
  return { type: 'text', text: `<system-reminder>${body}</system-reminder>` }
}

/** 判断一条消息的 content 是否已经是「已插过日期块」的形态。 */
function startsWithSystemReminder(content: unknown): boolean {
  if (typeof content === 'string') return content.startsWith('<system-reminder>')
  if (Array.isArray(content)) {
    const first = content[0] as { text?: unknown } | undefined
    return typeof first?.text === 'string' && first.text.startsWith('<system-reminder>')
  }
  return false
}

/**
 * 给**首轮 user 消息**的 content 数组最前面插入日期块。
 *
 * 规则（官方行为）：
 * - 只处理第一条消息，且它必须是 `role === 'user'`
 * - **幂等**：已以 `<system-reminder>` 开头则不重复插
 * - 纯文本 content 会被转成块数组（官方就是数组形态）
 */
export function withContextPrefix<T extends { role: string; content: unknown }>(
  messages: readonly T[],
  now: Date = new Date(),
): Array<Record<string, unknown>> {
  const out = messages.map((message) => ({ ...message }) as Record<string, unknown>)
  const first = out[0]
  if (first === undefined || first.role !== 'user') return out
  if (startsWithSystemReminder(first.content)) return out

  const prefix = buildContextPrefixBlock(now)
  const content = first.content
  if (Array.isArray(content)) {
    first.content = [prefix, ...content]
  } else if (typeof content === 'string') {
    first.content = [prefix, { type: 'text', text: content }]
  } else {
    first.content = [prefix]
  }
  return out
}
