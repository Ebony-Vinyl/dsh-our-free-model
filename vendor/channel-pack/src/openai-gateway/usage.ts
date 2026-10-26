/**
 * 用量口径转换：DSH 的 `TokenUsage` → **OpenAI 官方口径**。
 *
 * ## 为什么必须单独抽一份
 *
 * 两个出口（`/v1/chat/completions` 与 `/v1/responses`）必须给出**同一个数字**，
 * 否则「换个 URL 用量就变了」会被当成计费缺陷（见 `responses.ts` 文件头第 2 条）。
 * 故转换只有这一份实现，两端各自只做字段改名。
 *
 * ## 两种口径的差异（本模块存在的唯一理由）
 *
 * | | DSH `TokenUsage` | OpenAI `usage` |
 * |---|---|---|
 * | 输入 | `inputTokens` **只含未命中缓存**的部分；命中单列 `cacheReadTokens` | `prompt_tokens` / `input_tokens` 是**含缓存**的总输入 |
 * | 明细 | 无 | `prompt_tokens_details.cached_tokens` 是上者的**子集**（不是并列项） |
 *
 * ## ⚠️ 真实缺陷（用户报障，2026-10-04）：接入 Codex 后上下文占用被少算上百倍
 *
 * 现象：同一个会话，用 `raccoon` 时 Codex 的上下文进度条「搞半天只占 5%」，
 * 换成 `trae` 就「正常显示占了 300k 多」。
 *
 * 实测证据（`~/.codex/sessions/2026/10/02/rollout-…01a0fc83….jsonl` 的
 * `token_usage_record`，逐帧对得上）：
 *
 * | 时刻 | DSH 内部（互斥） | 网关发出的 wire | Codex 显示 | 真实占用 |
 * |---|---|---|---|---|
 * | raccoon 会话中 | 未命中 52129 + 命中 4096 | `total_tokens: 52787` | **5.56%** | 5.92% |
 * | raccoon 会话末 | 未命中 770 + 命中 207488 | `total_tokens: 1403` | **0.15%** | **21.92%** |
 * | trae 会话末 | 未命中 326134（trae 无缓存） | `total_tokens: 326742` | **34.39%** | 34.33% |
 *
 * trae 之所以「正常」**不是它被修好了，而是它不报缓存** ——
 * `trae-adapter.ts` 的 `token_usage` 只读 `prompt_tokens` / `completion_tokens`，
 * 从不算 `cacheReadTokens`，于是旧的 `inputTokens + outputTokens` 恰好等于完整上下文。
 *
 * Codex 自己的判据（`agcodex_protocol::protocol::TokenUsage`，
 * 与 openai/codex 的 `tokens_in_context_window` 同源）：
 *
 * ```rust
 * pub fn non_cached_input(&self) -> u64 {
 *     self.input_tokens.saturating_sub(self.cached_input())   // ← 它要减，说明 input_tokens 含缓存
 * }
 * pub fn tokens_in_context_window(&self) -> u64 {
 *     self.total_tokens.saturating_sub(self.reasoning_output_tokens.unwrap_or(0))
 * }
 * ```
 *
 * 旧实现发的是 `input_tokens = 770`（不含缓存）配 `cached_tokens = 207488`，
 * 于是 Codex 算 `770 - 207488`，`saturating_sub` 夹到 **0**，总数只剩 `output=633`。
 *
 * ⚠️ **这不只是显示问题**：Codex 判断该不该自动压缩用的就是
 * `tokens_in_context_window()`。计量恒定在 0.1%~5% ⇒
 * `model_auto_compact_token_limit` **永远不会触发**，真实上下文会一路涨到
 * 撞上模型硬限直接报错，而不是优雅地压缩。
 *
 * ⚠️ 这是 `6f352ca`（Chat 出口）与 `c19917a`（Responses 出口）就带着的既有缺陷，
 * 不是第 7、8 轮引入的；只是**接入 Codex 用 Responses 端点之后才暴露** ——
 * 在那之前没有消费者会这样解读这两个字段。
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/**
 * 已归一化到 OpenAI 口径的用量。
 *
 * ⚠️ `cachedTokens` 是 `inputTokens` 的**子集**，不是可以相加的并列项 ——
 * 把它当并列项加上去会得到「输入 = 未命中 + 命中 + 命中」的重复计数。
 */
export interface OpenAiUsage {
  /** **含缓存命中**的总输入 token（OpenAI 的 `prompt_tokens` / `input_tokens`）。 */
  inputTokens: number
  /** 生成 token（OpenAI 的 `completion_tokens` / `output_tokens`）。 */
  outputTokens: number
  /** 总 token = 总输入 + 输出。 */
  totalTokens: number
  /** 总输入里**命中缓存**的那部分（上者的子集）。 */
  cachedTokens: number
  /** 思考 token（输出的子集）；上游没报时为 `undefined`。 */
  reasoningTokens?: number
}

/** 非负整数归一；非法值一律当 0（用量字段宁少不崩，绝不抛错中断整轮对话）。 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}

/**
 * 把 DSH 的互斥口径拼成 OpenAI 的含缓存口径。
 *
 * ⚠️ `cacheWriteTokens` **也要计入总输入**：缓存写入的那些 token 同样是这一轮
 * 真实发出去的输入（Anthropic 的 `cache_creation_input_tokens` 即此），
 * 漏掉它会让刚建好缓存的那一轮少算。但它**不是**「缓存命中」，
 * 故不进 `cachedTokens`。
 */
export function toOpenAiUsage(usage: TokenUsage): OpenAiUsage {
  const cached = count(usage.cacheReadTokens)
  const written = count(usage.cacheWriteTokens)
  // ⚠️ 这一行是本次修复的核心：DSH 的 `inputTokens` 不含缓存，必须加回去。
  const inputTokens = count(usage.inputTokens) + cached + written
  const outputTokens = count(usage.outputTokens)
  const reported = typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens) && usage.totalTokens > 0
    ? Math.trunc(usage.totalTokens)
    : undefined
  return {
    inputTokens,
    outputTokens,
    // 上游自己报了总数就用它：实测 zcode 报的是「未命中 + 命中 + 写入 + 输出」，
    // gemini 的 `totalTokenCount` 还把思考算在内 —— 两者都比我们拼出来的更准。
    // ⚠️ 取 `max` 而不是直接采信：万一某个上游报的总数**不含缓存**
    // （本仓库无法穷举验证 14 个 provider），直接采信就会原样重现本缺陷。
    // 取较大者保证「只会多算、绝不漏算」—— 漏算的代价是自动压缩永不触发。
    totalTokens: Math.max(reported ?? 0, inputTokens + outputTokens),
    cachedTokens: cached,
    ...count(usage.reasoningTokens) > 0 ? { reasoningTokens: count(usage.reasoningTokens) } : {},
  }
}
