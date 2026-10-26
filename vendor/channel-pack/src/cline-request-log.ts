/**
 * Cline **请求记录**（本插件自己发出的推理请求流水）。
 *
 * ## 与网关 `/usages` 是两回事，不能互相替代
 *
 * | | 本模块（本地流水） | 网关 `/users/{id}/usages` |
 * |---|---|---|
 * | 记什么 | **本插件发出的**每笔请求 | 该账号在 Cline **官方所有渠道**的消费 |
 * | 延迟/首块 | ✓（只有调用方知道） | ✗ |
 * | 成本 | ✗（那是网关记账） | ✓ `costUsd` |
 *
 * 参考实现：`github.com/codeOct/dsh-cline-pass` 的请求记录部分 —— 它记录的
 * 同样是**自己适配器**发出的请求（字段 `ms` / `ttfb` / `ttft` / `usage` /
 * `error` / `account`），表格列为「时间 | 模型/上游 | TOKEN | 延迟」。
 * 本模块对齐这套字段。
 *
 * ## 存储是**进程内存**，重启即丢（刻意，与参考实现一致）
 *
 * 请求流水是高频写入的派生数据：持久化会把「每笔推理」都变成一次磁盘写，
 * 且记录的价值只在于「刚刚发生了什么」。上限 {@link CLINE_HISTORY_LIMIT} 条，
 * 新记录淘汰最旧的。
 *
 * ## ⚠️ 记录**绝不抛错**：它在推理的关键路径上
 *
 * `record()` 由适配器在流结束/失败时调用 —— 这里抛错会**反噬推理本身**。
 * 所有入参都被截断/钳制，写满即淘汰最旧。
 */

/** 记录上限（参考实现同值：DEFAULT_HISTORY_LIMIT = 100）。 */
export const CLINE_HISTORY_LIMIT = 100

/** 一条请求记录。 */
export interface ClineRequestEntry {
  /** 请求**发起**时刻（毫秒时间戳；表格按它显示「时间」）。 */
  ts: number
  /** 模型 id（wire 上请求的 `model`，如 `cline-pass/deepseek-v4.1-flash`）。 */
  model: string
  /** 发请求用的**账号**（账号池里的 `id`；换号后是**最终服务的那笔**）。 */
  accountId: string
  /**
   * 是否**收到过 usage 帧**。
   *
   * ⚠️ 与「token 为 0」**不是一回事**：网关没发 usage 时（调用方 abort、
   * 上游提前断开）表格必须显示 `—`（未知），而不是 `0` ——
   * 给 0 会被读成「瞬间完成、没花 token」。参考实现同约定
   * （其 `usageReported !== true` 时 tokenSummary 返回 `—`）。
   */
  usageReported: boolean
  /** 输入 token（未命中缓存的部分）。 */
  inputTokens: number
  /** 输出 token。 */
  outputTokens: number
  /** 缓存命中的输入 token（缺失时省略；有值时表格显示 ⚡ 那一项）。 */
  cacheReadTokens?: number
  /** 思考 token（上游不流式输出，只在 usage 里出现；缺失时省略）。 */
  reasoningTokens?: number
  /**
   * 本次请求的**推理强度**（DSH 注入的 `options.reasoningEffort`）。
   *
   * ⚠️ **空串表示「本次没指定」** —— 展示层据此整行不渲染（参考实现同约定：
   * `entry.effort === ''` 时 tooltip 少一行）。不要写成 `'auto'`：
   * 那会被读成「确实选了自动这一档」，与「没传这个字段」是两回事。
   */
  effort: string
  /**
   * **真正服务这笔请求的上游渠道**（网关下发的路由元数据，如 `alibaba`）。
   *
   * ⚠️ 与「模型命名空间」（`cline-pass` / `cline-free`）**不是一回事** ——
   * 后者是订阅通道，甚至可能是厂商名（`deepseek/…`）。原先展示层取的是后者，
   * 用户报障「上游显示的不正确」；真实来源见 `src/cline-routing.ts`。
   *
   * ⚠️ **空串 = 网关本次没报路由**，展示层据此回落到模型命名空间。
   * 不要写成 `'auto'` 之类的代称：那会把「没读到」冒充成一个具体读数。
   */
  upstream: string
  /** 首个内容块耗时（毫秒）—— 解释「为什么等了这么久才出字」的关键数字。 */
  ttftMs: number
  /**
   * **首个「正文」块**耗时（毫秒；0 = 本次没有任何正文/工具调用块）。
   *
   * ⚠️ 与 {@link ttftMs} 是**两个不同时刻**：`ttftMs` 是「收到的第一块」
   * （可能是思考增量），`ttfcMs` 是「第一块**正文**」。
   *
   * 为什么要分开（真实缺陷，用户报障 2026-09-30「输出速率 11814.8 t/s」）：
   * 「输出速率」必须让**分子与分母描述同一段时间**。`outputTokens`
   * **含思考 token**（本仓库已实测：`reasoning_tokens` 计入
   * `completion_tokens`），而思考是在 `ttftMs` 之前产生的 —— 拿
   * `outputTokens ÷ (totalMs − ttftMs)` 会把不在那段窗口里的 token 算进去，
   * 速率被无限放大（实测见 11814.8 t/s，物理上不可能）。
   *
   * ⇒ 速率的正确口径是**正文阶段**：分子 = `outputTokens − reasoningTokens`，
   * 分母 = `totalMs − ttfcMs`。
   */
  ttfcMs: number
  /** 全程耗时（毫秒）。 */
  totalMs: number
  /** 失败原因；**成功时为 undefined**。 */
  error?: string
}

/** 内存中的流水（最新在前）。 */
let history: ClineRequestEntry[] = []

/**
 * 记录一笔请求。
 *
 * ⚠️ **本函数绝不抛错**：它由适配器在流结束/失败时调用，抛错会把
 * 记账失败反噬成推理失败 —— 那是比丢一条记录严重得多的故障。
 * 字段全部截断/钳制，`Object.freeze` 防止调用方后续修改共享对象。
 */
export function recordClineRequest(entry: Omit<ClineRequestEntry, 'ts'>): void {
  try {
    history.unshift(Object.freeze({
      ts: Date.now(),
      model: String(entry.model ?? '').slice(0, 120),
      accountId: String(entry.accountId ?? '').slice(0, 64),
      // ⚠️ 必须显式判 `=== true`：缺失/垃圾值一律当「没收到 usage」，
      // 由展示层显示 `—` 而不是 0（见接口注释）。
      usageReported: entry.usageReported === true,
      inputTokens: Math.max(0, Math.trunc(Number(entry.inputTokens ?? 0))) || 0,
      outputTokens: Math.max(0, Math.trunc(Number(entry.outputTokens ?? 0))) || 0,
      ...(Number(entry.cacheReadTokens ?? 0) > 0
        ? { cacheReadTokens: Math.trunc(Number(entry.cacheReadTokens)) }
        : {}),
      ...(Number(entry.reasoningTokens ?? 0) > 0
        ? { reasoningTokens: Math.trunc(Number(entry.reasoningTokens)) }
        : {}),
      // ⚠️ 与 token 字段不同，这里**始终写字符串**（缺省空串）：展示层的判据
      // 是「空串 ⇒ 不渲染那一行」，若此处省略字段，判据就得同时处理
      // undefined 与 ''，两处口径容易分叉（参考实现同取 `''` 兜底）。
      effort: String(entry.effort ?? '').slice(0, 32),
      // 上游渠道：与 `effort` 同口径**始终写字符串**（缺省空串 = 网关没报），
      // 展示层据「空串 ⇒ 回落到模型命名空间」判断，避免两处口径分叉。
      upstream: String(entry.upstream ?? '').slice(0, 64),
      ttftMs: Math.max(0, Math.trunc(Number(entry.ttftMs ?? 0))) || 0,
      // 首个**正文**块耗时（0 = 没有正文块）。⚠️ 必须单独存：速率的分子分母
      // 都要落在正文阶段（见接口上 `ttfcMs` 的注释）。
      ttfcMs: Math.max(0, Math.trunc(Number(entry.ttfcMs ?? 0))) || 0,
      totalMs: Math.max(0, Math.trunc(Number(entry.totalMs ?? 0))) || 0,
      ...(typeof entry.error === 'string' && entry.error.length > 0
        ? { error: entry.error.slice(0, 200) }
        : {}),
    }) as ClineRequestEntry)
    if (history.length > CLINE_HISTORY_LIMIT) history.length = CLINE_HISTORY_LIMIT
  } catch {
    // 记账失败绝不反噬推理（见函数注释）。
  }
}

/**
 * 读取请求流水（最新在前）。
 *
 * @param accountId - 只看该账号；缺省返回**全部**（含无账号的失败行）。
 * @param limit - 最多多少条（不超过上限）。
 */
export function readClineRequestHistory(
  options: { accountId?: string; limit?: number } = {},
): ClineRequestEntry[] {
  const needle = typeof options.accountId === 'string' && options.accountId.length > 0
    ? options.accountId
    : ''
  const limit = Math.max(0, Math.min(options.limit ?? CLINE_HISTORY_LIMIT, CLINE_HISTORY_LIMIT))
  return history
    .filter((entry) => needle === '' || entry.accountId === needle)
    .slice(0, limit)
}

/** 当前保留的流水条数（诊断用）。 */
export function clineRequestHistorySize(): number {
  return history.length
}

/**
 * 模型 id 的**模型族/上游**前缀（`/` 之前），如
 * `cline-pass/deepseek-v4.1-flash` → `cline-pass`。
 *
 * 与参考实现的「模型 / 上游」两列对应：上游是**网关按什么通道服务的**
 * （cline-pass 订阅 / cline-free 免费），模型是**具体哪个模型** ——
 * 两者是两个维度，合成一列会让「同名不同上游」的行无法区分。
 * 无 `/` 前缀时返回空串（表格那格显示「—」而非编一个值）。
 */
export function clineUpstreamOf(model: string): string {
  const idx = String(model ?? '').indexOf('/')
  return idx > 0 ? String(model).slice(0, idx) : ''
}

/** 清空流水（仅测试用：模块级状态会在用例间泄漏）。 */
export function resetClineRequestHistory(): void {
  history = []
}
