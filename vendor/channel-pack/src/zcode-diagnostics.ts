/**
 * ZCode 的**可观测诊断**：为 `3012` 这类「只有一句话、没有第二条信息」的错误
 * 补齐排查所需的现场数据。
 *
 * ## 为什么需要它（Gitee issue IKJI0Y）
 *
 * `3012 unusual activity` 的既有文案只有**固定句 + 原始响应**。用户遇到时
 * 只能确认一件事：「我猜的请求体大概是对的」。剩下全是猜：
 *
 * - 本次是账号池里**第几个账号**？（分不清是账号自身被标记，还是恰好轮到它）
 * - 这个账号此前**成功过几次**？**最近一次成功**是什么时候？
 *   —— 这两条决定「一直如此」还是「突然开始」，两者的排查方向完全不同；
 * - **实际发出**的身份块有多少字符？首轮 user 到底带没带日期块？
 * - 本次距**上一条** zcode 请求隔了多久？（频率风控的唯一直观证据）
 *
 * ## 三条设计红线
 *
 * 1. **绝不写凭据**。账号只以「进程内自增序号」出现（{@link accountOrdinal}），
 *    不含 accountId、JWT、device_mid、账号名中的任何一个字符片段。
 *    回归用例用「凭据标识的每个子串都不得出现在文案里」来钉死这条。
 * 2. **只诊断「实际发出的请求体」**，不诊断「我们以为发出了什么」。
 *    {@link describeZcodeRequestShape} 直接读已构造好的 `system` / `messages`
 *    —— 这样一旦真出现「身份块没进去」，诊断会**如实显示 0 字符**，
 *    而不是显示常量里的 2898 把问题盖住。
 * 3. **进程级、不落盘**。与 {@link file://./captcha-requirement.ts} 同口径：
 *    `$DSH_HOME/channel-pack/state.json` 是同机多 profile 共享的 home 级文档，
 *    落盘会把一个 profile 的账号画像传染给另一个。
 *
 * ## ★ 本模块同时是 `3012` 判据与文案的**唯一出处**（Gitee issue IKJOQB）
 *
 * **真实缺陷**：`3012` 的文案曾在**两个地方各写一份** ——
 * `zcode-adapter.ts` 的 `describeUpstreamError`（推理路径，带冷却警告）
 * 与 `zcode-auth.ts` 的 `toClaimOutcome`（领取路径，**只有裸上游串**）。
 * 于是领取路径的用户看到的是
 * `zcode-v3-start-plan-trust-1005: request has been blocked due to unusual activity.`
 * —— 既看不出这是**风控**，更看不到「请勿连续重试」这条**唯一正确的动作**
 * （`3012` 有账号冷却惩罚，反复触发会 30 分钟 → 24 小时 → 停用）。
 *
 * ⇒ 判据（{@link isZcodeUnusualActivityCode} / {@link looksLikeZcodeUnusualActivity}）
 * 与文案（{@link formatZcodeUnusualActivityMessage}）都收敛到本文件，
 * 两条路径**引用同一份**。改文案只需改这里，不会再漂移。
 */

/**
 * 上游 `3012`（unusual activity）的**判据**之一：业务码精确命中。
 *
 * ⚠ 上游把码给成数字 `3012`，但**字符串 `"3012"` 也在线上出现过**
 * （`{"code":"3012"}` 这类把数字写成字符串的响应），故两者都认。
 * 与 `httpErrorCodeForZcode` 同口径（那边用的是 `body.includes('3012')`）。
 */
export function isZcodeUnusualActivityCode(code: unknown): boolean {
  if (code === 3012) return true
  if (typeof code !== 'string') return false
  return code.trim() === '3012'
}

/**
 * 把上游 `code` 归一成数字：认 `number`，**也认纯数字字符串**。
 *
 * ## ⚠⚠ 为什么必须认字符串（真实缺陷，2026-10-05 对抗性审计打出）
 *
 * `zcode-upstream.ts` 原先用 `num(parsed.code)` 解析业务码，而它**只认 number**：
 * ```js
 * function num(v){ return typeof v === 'number' && Number.isFinite(v) ? v : undefined }
 * ```
 * 于是上游回 `{"code":"3012","msg":"request has been blocked due to unusual activity."}`
 * 时，`code` 被解析成 **`undefined`** ⇒ 风控码**整条丢失**，用户看到的正是
 * issue 要修的那句裸上游串：
 *
 * ```
 * zcode-v3-start-plan-trust-1005: request has been blocked due to unusual activity.
 * ```
 *
 * ⇒ 本函数让 `3012` 的**字符串形态**不再在解析层被吃掉。
 *
 * ⚠ 这同时修掉了本文件 {@link isZcodeUnusualActivityCode} 那个字符串分支的
 *   **死代码**状态：它有分支、但领取侧的调用方永远拿不到字符串输入
 *   （上游更早的 `num()` 已经把它变成了 `undefined`）。
 * ⚠ 只认**纯数字**字符串（`/^-?\d+$/`），不认 `"3012 "` 以外的怪值更不认
 *   `"abc"` —— 避免把任意文本静默变成业务码。
 */
export function parseZcodeBusinessCode(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return /^-?\d+$/.test(trimmed) ? Number(trimmed) : undefined
}

/**
 * 正文里是否**表达了上游风控** —— 这是「仅凭正文」判定风控的**唯一**入口。
 *
 * ## ⚠⚠ 为什么不能只看裸数字（真实缺陷，2026-10-05 对抗性审计打出）
 *
 * 词边界正则解决了 `13012` / `plan-3012` 这类**紧邻**形态，但拦不住
 * **自然语言里恰好出现的独立数字**。审计实测被误判的形态：
 *
 * | 正文（`code` 缺失） | 仅词边界 | 本函数 |
 * |---|---|---|
 * | `too many requests, retry after 3012 ms` | ❌ **误判成风控** | ✅ 不命中 |
 * | `<h1>Error 3012</h1>upstream connect timeout` | ❌ **误判成风控** | ✅ 不命中 |
 * | `request has been blocked due to unusual activity.` | ❌ **漏判** | ✅ 命中 |
 *
 * 前者后果**不是文案问题**：`too many requests` 是**限流、稍后重试即可**，
 * 被改写成「风控、**别重试**」—— 两者用户动作**完全相反**；且领取路径据此
 * **短路**，跳过本可领取的 plan（审计实测 3 个 plan 只发 1 发）。
 *
 * ## ⚠⚠ 为什么也**不能**用「独立词 3012」当门禁
 *
 * 上游 `3012` 的 `msg` **原文就是** `request has been blocked due to unusual
 * activity.` —— **它不含任何数字**（数字在 `code` 字段里）。以上游真实文案
 * 做样本时，「必须有独立词 3012」这条门禁会**反过来把它漏掉**：
 * 写用例时实测到该断言为 `false`。
 * ⇒ 判据以**语义短语**为主，数字只作兜底（配合 `block` 字样）。
 *
 * ⚠ `code` 已解析出来时**不走本函数**（它只用于「仅凭正文」的兜底，
 *   见 {@link hasZcodeUnusualActivity}）—— 有权威业务码时不该猜文本。
 */
export function mentionsZcodeUnusualActivity(body: string): boolean {
  /**
   * ★ 主判据：上游风控的**实测原文**语义。
   * 覆盖 `request has been blocked due to unusual activity.` 及其变体。
   */
  if (/unusual activity|blocked due to/i.test(body)) return true
  /**
   * 兜底：独立词 `3012` 与 `block` 字样**紧邻**（≤10 字符），
   * 如 `3012 blocked by waf`。
   *
   * ## ⚠⚠ 为什么必须「紧邻」，而不是全文任意共现
   *
   * 第一版写成「独立词 `3012` **且** 全文含 `block`」，仍会误判**限流**
   * 正文（真实缺陷，2026-10-05 审计 N2）：
   *
   * | 正文（无码） | 40 字符窗口 | **10 字符紧邻**（本实现） |
   * |---|---|---|
   * | `rate limited: request blocked, retry after 3012 ms` | ❌ 仍误判（距 14） | ✅ 不命中 |
   * | `temporarily blocked; see error 3012` | ❌ 仍误判（距 12） | ✅ 不命中 |
   * | `3012 blocked by waf` | ✅ | ✅（距 1） |
   *
   * ⚠ 窗口不是随便取的：写第一版修复时用 40，**实测发现两个反例仍命中**
   *   （`blocked` 与 `3012` 之间只隔 `, retry after ` / `; see error `），
   *   故收紧到 10 —— 它仍容纳 `3012 block…` 这类紧邻，而把两个反例排除。
   * ⚠ 限流是「稍后重试即可」、风控是「**别重试**」，动作相反，不能混。
   * ⚠ 单靠数字**永远**不算（见上方的毫秒数反例）。
   */
  return looksLikeZcodeUnusualActivity(body)
    && /3012[^]{0,10}?block|block[^]{0,10}?3012/i.test(body)
}

/** 从响应正文里读出业务码（认 `number` 与纯数字字符串）。 */
export function readZcodeBusinessCodeFromBody(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body.trim()) as { code?: unknown } | null
    if (parsed === null || typeof parsed !== 'object') return undefined
    return parseZcodeBusinessCode(parsed.code)
  } catch {
    // 非 JSON（网关 HTML / 纯文本）⇒ 无码可读，由调用方决定是否看正文。
    return undefined
  }
}

/**
 * 响应正文里是否表达了**上游风控**（`3012`）—— 给「只有一段正文」的调用方用
 * （`zcode-adapter.ts` 的 `httpErrorCodeForZcode` 与 `describeUpstreamError`）。
 *
 * 判据**有优先级**：
 * ① 正文能解析出业务码 ⇒ **只信码**（`3012` 即风控，`13012` 不是）；
 * ② 无码可读 ⇒ 才看正文，且要求**风控语义共现**（见
 *    {@link mentionsZcodeUnusualActivity}）。
 *
 * ⚠ 这个优先级是必须的：`{"code":3012}` 这种正文**不含语义词**，
 *   若直接走 ② 会漏判 ⇒ `httpErrorCodeForZcode` 返回 `SERVER`，
 *   而 `SERVER` 在 harness 的 `DEFAULT_RETRYABLE_CODES` 里 ⇒
 *   有冷却惩罚的风控错误被**白重试 5 次**（`qoder` 那边记过同型缺陷）。
 */
export function hasZcodeUnusualActivity(body: string): boolean {
  const code = readZcodeBusinessCodeFromBody(body)
  if (code !== undefined) return isZcodeUnusualActivityCode(code)
  return mentionsZcodeUnusualActivity(body)
}

/**
 * 上游 `3012` 的**判据**之二：正文里以**独立词**出现 `3012`。
 *
 * ⚠⚠ **必须是词边界匹配，不能是 `body.includes('3012')`**（真实缺陷，
 * 2026-10-05 自审发现）。裸 `includes` 会把**其它码里的数字片段**一并命中：
 *
 * | 正文 | `includes('3012')` | 本函数（词边界） |
 * |---|---|---|
 * | `{"code":3012}` | ✅ | ✅ |
 * | `{"code":13012}` | ❌ **误命中** | ✅ 不命中 |
 * | `plan-3012-trust` | ❌ **误命中** | ✅ 不命中 |
 * | `quota 3012 remaining` | ✅（且**可能**是真风控文案） | ✅ |
 *
 * 误判的后果**不是「文案不好看」**：领取路径据此**短路**（`break`）⇒
 * 把一个「plan 名里恰好含 3012」的普通失败当成风控，**跳过本可领取的 plan**，
 * 并把真实业务码（如 `1005` 额度用尽）改写成 `3012` ——
 * 而这两者的用户动作**完全相反**（等额度重置 vs 别重试）。
 *
 * ## ⚠ 边界字符是「数字、字母**以及 `-` / `_`**」
 *
 * 初版只写 `(?<!\d)3012(?!\d)`，于是 `plan-3012-trust` **仍然命中** ——
 * `3012` 前后是连字符，不是数字（写单测时实测到）。第二版补了字母，
 * `plan-3012-trust` **还是**命中（连字符与下划线都不属于 `[0-9A-Za-z]`）。
 * ⇒ 标识符形态（`plan-3012`、`trust_3012`、`x3012y`、`13012`）必须**全部**
 * 排除，故边界集取 `[0-9A-Za-z_-]`。
 *
 * ⚠ `.` / `,` / `}` / `:` / 空格 / 行首行尾都**不**被排除，
 * 上游真实形态 `{"code":3012,"msg":"…"}` 与自然语言 `error: 3012 blocked`
 * 因此照常命中。
 */
export function looksLikeZcodeUnusualActivity(body: string): boolean {
  return /(?<![0-9A-Za-z_-])3012(?![0-9A-Za-z_-])/.test(body)
}

/**
 * `3012` 的**共用文案** —— 推理路径与领取路径引用同一份（Gitee issue IKJOQB）。
 *
 * ## 为什么必须共用
 *
 * 这两条路径是**同一个错误的两个入口**，而用户该做的事完全不同：
 * `3012` 不是「重试就能过」（那是 `3007`/`3009`），而是**有账号冷却惩罚**：
 * 30 分钟起步，反复触发升级到 24 小时乃至停用。
 * ⇒「请勿连续重试」是这段文案里**最重要的一句**，绝不能只在其中一条路径上有。
 *
 * ## 参数语义
 *
 * @param options.subject 定位信息（领取路径传 `planId`），**非空时**并入首句。
 *   推理路径不传 ⇒ 首句与历史输出**逐字一致**（单测钉住了这一点）。
 * @param options.diagnostic {@link formatZcodeDiagnostic} 的产物。**为空则整段省略**
 *   —— 与 `describeUpstreamError` 的历史行为一致（不写空壳「本机诊断：」）。
 * @param options.rawResponse 原始响应（上游 `msg` 或截断后的正文）。
 */
export function formatZcodeUnusualActivityMessage(options: {
  subject?: string
  diagnostic?: string
  rawResponse?: string
} = {}): string {
  const subject = typeof options.subject === 'string' && options.subject.length > 0
    ? ` · ${options.subject}`
    : ''
  const diag = typeof options.diagnostic === 'string' && options.diagnostic.length > 0
    ? `本机诊断：${options.diagnostic}\n`
    : ''
  const raw = typeof options.rawResponse === 'string' && options.rawResponse.length > 0
    ? `原始响应：${options.rawResponse}`
    : ''
  return (
    `上游风控拦截（3012 unusual activity）${subject}。` +
    `⚠ 该错误有账号冷却惩罚（30 分钟，反复触发会升级到 24 小时乃至停用），` +
    `请勿连续重试。\n${diag}${raw}`
  )
}

/** 账号的进程级画像。key 与 {@link accountOrdinal} 用的是同一个。 */
interface AccountProfile {
  /** 进程内自增序号（1 起），**不含任何凭据派生信息**。 */
  ordinal: number
  /** 已发出的请求数。 */
  sent: number
  /** 拿到 HTTP 2xx 的次数。 */
  ok: number
  /** 拿到 HTTP 非 2xx 的次数。 */
  failed: number
  /** 最近一次成功时刻（毫秒）。从未成功为 undefined。 */
  lastOkAt: number | undefined
  /** 最近一次「发出请求」的时刻（毫秒）。 */
  lastSentAt: number | undefined
  /**
   * **上上条**发出请求的时刻（毫秒）—— 即「距上一条」的分母。
   *
   * ⚠⚠ 必须与 `lastSentAt` 分开存，**不能拿 `lastSentAt` 顶替**：
   * 适配器的调用顺序是「先 {@link noteZcodeRequestSent} 记本次、再在失败时
   * {@link formatZcodeDiagnostic} 诊断」，两者用的是同一个 `sentAt`
   * ⇒ 若诊断时读 `lastSentAt`，算出来恒为 `0ms`，这一项就永远没有信息量
   * （写脚本做端到端验证时真的打印出过 `距上条 0ms`）。
   */
  previousSentAt: number | undefined
}

const profiles = new Map<string, AccountProfile>()
let nextOrdinal = 1

/** 空/缺失的账号 id 归一成 `-`（与 `captchaRequirementKey` 同口径）。 */
function normalizeKey(accountId: string | undefined): string {
  return accountId === undefined || accountId === '' ? '-' : accountId
}

/**
 * 取账号的进程内序号，**首次见到时分配**（之后稳定不变）。
 *
 * ⚠ 同一个账号在多次请求里拿到同一个序号 —— 否则「本次是第几个账号」这句话
 * 会随请求变化，跨请求对比就失去意义（这正是 issue 要解决的问题）。
 */
export function accountOrdinal(accountId: string | undefined): number {
  const key = normalizeKey(accountId)
  const existing = profiles.get(key)
  if (existing !== undefined) return existing.ordinal
  const profile: AccountProfile = {
    ordinal: nextOrdinal,
    sent: 0,
    ok: 0,
    failed: 0,
    lastOkAt: undefined,
    lastSentAt: undefined,
    previousSentAt: undefined,
  }
  nextOrdinal += 1
  profiles.set(key, profile)
  return profile.ordinal
}

/**
 * 记一次「请求已发出」。
 *
 * @param sentAt 本次的出发时刻（毫秒）。**在真正 `fetch` 之前取**，
 *   否则算出来的「距上一条」会把本次的排队/等待时间算进去。
 */
export function noteZcodeRequestSent(accountId: string | undefined, sentAt: number): void {
  const key = normalizeKey(accountId)
  accountOrdinal(accountId)
  const profile = profiles.get(key)
  if (profile === undefined) return
  profile.sent += 1
  // ⚠ 旧值下沉一格再写新的 —— 诊断要的「距上条」是**上一条**，不是本次。
  profile.previousSentAt = profile.lastSentAt
  profile.lastSentAt = sentAt
}

/** 记一次成功（拿到 HTTP 2xx）。 */
export function noteZcodeRequestOk(accountId: string | undefined, at: number): void {
  const profile = profiles.get(normalizeKey(accountId))
  if (profile === undefined) return
  profile.ok += 1
  profile.lastOkAt = at
}

/** 记一次失败（HTTP 非 2xx）。 */
export function noteZcodeRequestFailed(accountId: string | undefined): void {
  const profile = profiles.get(normalizeKey(accountId))
  if (profile === undefined) return
  profile.failed += 1
}

/**
 * 把毫秒差写成一眼能读的形态。
 *
 * ⚠ 秒以上的换算**逐档单独写过**：初版把分钟档写成
 * `${Math.floor(seconds % 60)}分…`，于是 90 秒被渲染成「30分30秒」
 * —— 分位取的是**秒的余数**而不是已算好的分钟数。
 * 这个错误是在**真实探针输出**里发现的（「最近成功 29分29秒前」），
 * 纯函数单测当时没覆盖到 ≥60 秒的区间。
 */
function formatGap(ms: number | undefined): string {
  if (ms === undefined) return '—'
  if (ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) {
    const rest = totalSeconds % 60
    return rest === 0 ? `${minutes}分` : `${minutes}分${rest}秒`
  }
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  return restMin === 0 ? `${hours}小时` : `${hours}小时${restMin}分`
}

/** 「最近一次成功距今」的文案（从未成功过要如实说「无」，不写 0）。 */
function formatSinceLastOk(at: number | undefined, now: number): string {
  return at === undefined ? '从未成功过' : `${formatGap(now - at)}前`
}

/**
 * 请求体形态的实测描述 —— **读的是真正要发出去的那个对象**。
 *
 * ⚠ 这里刻意**不读** `OFFICIAL_IDENTITY_CHARS` 常量：常量只能证明
 * 「源码里写了多少字」，证明不了「线上发出去多少字」。两者一旦不一致
 * （例如某条改动把 `system` 顶掉了），只有读实际值才看得出来。
 */
export interface ZcodeRequestShape {
  /** `system` 块数组的块数（不是数组则 0）。 */
  systemBlocks: number
  /** 前两块（官方身份块）的字符数合计。 */
  identityChars: number
  /** 逐块的字符数（异常时能看出是哪一块短了）。 */
  identityBlockChars: readonly number[]
  /** 第一块（cliPrefix）的字符数。 */
  cliPrefixChars: number
  /** 首条 user 消息是否带 `<system-reminder>` 日期块。 */
  hasDateBlock: boolean
  /** 首条消息的 role（诊断「历史首条不是 user」这类异常）。 */
  firstRole: string
}

/** 取一个 system 块的 text 长度（非 text 块记 0）。 */
function blockChars(block: unknown): number {
  if (typeof block !== 'object' || block === null) return 0
  const text = (block as { text?: unknown }).text
  return typeof text === 'string' ? text.length : 0
}

/** 从已构造好的请求体里抽出形态信息。 */
export function describeZcodeRequestShape(
  system: unknown,
  messages: unknown,
): ZcodeRequestShape {
  const blocks = Array.isArray(system) ? system : []
  const identityBlockChars = blocks.slice(0, 2).map(blockChars)
  const first = Array.isArray(messages) && messages.length > 0
    ? messages[0]
    : undefined
  const firstRecord = (typeof first === 'object' && first !== null)
    ? first as { role?: unknown, content?: unknown }
    : {}
  const content = firstRecord.content
  const firstContentBlock = Array.isArray(content) && content.length > 0 ? content[0] : undefined
  const firstText = (typeof firstContentBlock === 'object' && firstContentBlock !== null)
    ? (firstContentBlock as { text?: unknown }).text
    : undefined
  return {
    systemBlocks: blocks.length,
    identityChars: identityBlockChars.reduce((sum, n) => sum + n, 0),
    identityBlockChars,
    cliPrefixChars: identityBlockChars[0] ?? 0,
    hasDateBlock: typeof firstText === 'string' && firstText.startsWith('<system-reminder>'),
    firstRole: typeof firstRecord.role === 'string' ? firstRecord.role : '(无)',
  }
}

/** 传给 {@link formatZcodeDiagnostic} 的现场快照。 */
export interface ZcodeDiagnosticInput {
  /** 本次使用的账号（只用于取序号与画像，不进文案）。 */
  accountId: string | undefined
  /** 本次请求的出发时刻（毫秒）。 */
  sentAt: number
  /** 上游 HTTP 状态码。 */
  status: number
  /**
   * 实际发出的请求体形态。
   *
   * ★ **可选**（Gitee issue IKJOQB）。推理请求体有 `system` / `messages`，
   * 而**领取请求体只有 `{ plan_id }`** —— 两者结构完全不同，
   * 不能照搬 `describeZcodeRequestShape(system, messages)`。
   *
   * ⚠ 缺省时**只省略**依赖它的两项（`身份块` / `日期块`），
   * **其余五项照常输出** —— 账号序号、成功/失败计数、最近成功、距上条、HTTP
   * 这五项与请求形态**无关**，恰恰是 `3012` 排查里最有价值的部分
   * （「一直如此还是突然开始」「是否频率风控」全靠它们回答）。
   * 为了缺一个 shape 就把整行丢掉是错的取舍。
   */
  shape?: ZcodeRequestShape
  /** 取当前时刻（可注入，便于单测）。 */
  now: number
}

/**
 * 把现场数据渲染成一行**不含任何凭据**的诊断摘要。
 *
 * ⚠ 字段顺序按 issue 的建议排：账号序号 → 计数 → 字符数 → 间隔 ——
 * 「最常被怀疑的」在前，「最容易被忽略的」在后。
 *
 * ⚠ `shape` 缺省时（领取路径，见 {@link ZcodeDiagnosticInput.shape}）
 * **只**少掉 `身份块` / `日期块` 两项，其余照常 —— 不要因为缺 shape
 * 就整行返回空串。
 */
export function formatZcodeDiagnostic(input: ZcodeDiagnosticInput): string {
  const key = normalizeKey(input.accountId)
  const profile = profiles.get(key)
  const ordinal = profile?.ordinal ?? accountOrdinal(input.accountId)
  const gap = profile?.previousSentAt === undefined
    ? '—'
    : formatGap(input.sentAt - profile.previousSentAt)
  /**
   * ★ 形态相关的两项单独成组，**缺 shape 时整组消失**。
   * ⚠ 判定用 `!== undefined` 而不是真值判断：`shape` 是对象，恒为真；
   *   真正的分支是「传了 / 没传」。
   */
  const shapeParts = input.shape === undefined
    ? []
    : [
      `身份块 ${input.shape.identityChars} 字符(${
        input.shape.identityBlockChars.length > 0
          ? input.shape.identityBlockChars.join('+')
          : '无'
      })`,
      `日期块 ${input.shape.hasDateBlock ? '有' : '无'}`,
    ]
  return [
    `账号#${ordinal}`,
    `本进程 成功 ${profile?.ok ?? 0}/失败 ${profile?.failed ?? 0}`,
    `最近成功 ${formatSinceLastOk(profile?.lastOkAt, input.now)}`,
    `距上条 ${gap}`,
    ...shapeParts,
    `HTTP ${input.status}`,
  ].join(' · ')
}

/**
 * 清空全部进程级状态（**只给单测的 `beforeEach` 用**）。
 *
 * ⚠ 与 `resetCaptchaRequirementMemory()` 同款：序号分配器也一并归零，
 * 否则同一进程里跑两轮用例会拿到不同的 `账号#N`，断言就得写成相对值。
 */
export function resetZcodeDiagnostics(): void {
  profiles.clear()
  nextOrdinal = 1
}
