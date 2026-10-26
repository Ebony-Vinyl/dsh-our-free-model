/**
 * OpenCode 免费推理产品配置与错误分类。
 *
 * ## 数据来源（设计文档 §0）
 *
 * 1. 端点 / 免费模型清单：官方 docs https://opencode.ai/docs/zen/ （2026-10-01 采集）
 * 2. 错误类型名：opencode 官方源码 `packages/opencode/src/session/retry.ts`
 *    （`FreeUsageLimitError` / `GoUsageLimitError` + `retry-after` 头）
 *
 * ## ⚠️ 为什么按「错误类型名」而不是「状态码」分类
 *
 * 本仓库 qoder 曾因「用错误码的默认归类代替业务语义判断」把确定性的额度耗尽
 * 当成可重试的 SERVER 而白重试 5 次；minimax 也曾把 402 归 AUTH 让用户
 * 看不到「去充值」这个唯一有效动作。Zen 的额度错误可能带 400/401/403/429
 * 任一状态码，唯一稳定的信号是**响应体里的错误类型名**。
 *
 * ## ⚠️ 身份结论（本 provider 设计的基石）
 *
 * opencode CLI 发往 Zen 的请求**没有任何机器级指纹**（1.18.22 源码逐行核对：
 * 无 machine-id / deviceId / 安装 ID / 遥测）。身份只有三个维度：
 * **出口 IP、API key（账号）、随机会话 id**。
 * ⇒ 「换一台 PC」在协议层等价于「换一个 key 或换一个出口 IP」，
 * 指纹派生的作用是**防关联**与满足形状门禁，不是换配额桶。
 */

// `retry-after` 的解析已收敛到 `src/retry-after.ts`（原先本文件与
// `opencode-adapter.ts` 各有一份几乎逐字相同的私有实现）。
import { retryAfterMsFromRecord } from './retry-after.js'

export interface OpencodeProduct {
  readonly id: 'opencode'
  readonly displayName: string
  readonly baseUrl: string
  readonly chatPath: string
  readonly modelsPath: string
  readonly chatHeaderTimeoutMs: number
  readonly chatChunkTimeoutMs: number
  readonly anonymousKey: string
  readonly defaultUserAgent: string
  /**
   * 模型能力元数据源（**远端**，能力的主来源）。
   *
   * ⚠️ 不是 `/zen/v1/models` —— 实测它只返回 `id`/`object`/`created`/
   * `owned_by` 四个字段，**不含任何能力信息**（85 条全如此）。
   * 能力在 **models.dev** 的 `opencode` 条目里，官方 CLI 自己就用它
   * （`packages/core/src/models-dev.ts`）。见 `opencode-capability.ts`。
   */
  readonly modelsDevUrl: string
  /** 能力表缓存 TTL（与官方 CLI 的 60 分钟同档）。 */
  readonly modelsDevTtlMs: number
}

export const OPENCODE: OpencodeProduct = {
  id: 'opencode',
  // ⚠️ 必须与客户端 `PROVIDERS` 里的 label 逐字一致（rail 宽度算式依赖它，
  // 且 `opencode-client-panel.spec.ts` 有跨文件一致性断言）。
  displayName: 'OpenCode',
  // 免费模型的新入口统一挂在 /inference/v1；/zen/v1 对匿名免费模型
  // 会返回 FreeTierError。这里保留 v1 后缀拆分，便于复用下方路径字段。
  baseUrl: 'https://opencode.ai/inference',
  chatPath: '/v1/chat/completions',
  modelsPath: '/v1/models',
  // ⚠️ 与本仓库其余 provider 的流式超时常量同档（保守值）。
  chatHeaderTimeoutMs: 60_000,
  chatChunkTimeoutMs: 120_000,
  // ⚠️ 匿名凭证是**字面量** `public`：opencode 官方 CLI 在没有 key 时自己就用它
  // （其 provider.ts 的 opencode 分支：`options: ok ? {} : { apiKey: 'public' }`）。
  anonymousKey: 'public',
  // ⚠️ 兜底 UA。**v2 形状**（`opencode/<channel>/<version>/<client>`，major ≥ 2）：
  // 旧的 `opencode/1.18.22` 自 2026-10-14 起被上游按名字拒掉（403 FreeTierError）。
  // 接线层会用真机 `opencode --version` 的结果改写成同形状（`opencode.ts` 的
  // `opencodeUserAgentForVersion`）。
  defaultUserAgent: 'opencode/latest/2.0.26/cli',
  /**
   * 模型能力元数据源（**远端**，能力的主来源）。
   *
   * ⚠️ 不是 `/zen/v1/models` —— 实测它只返回 `id`/`object`/`created`/
   * `owned_by` 四个字段，**不含任何能力信息**（85 条全如此）。
   * 能力在 **models.dev** 的 `opencode` 条目里，官方 CLI 自己就用它
   * （`packages/core/src/models-dev.ts`）。见 `opencode-capability.ts`。
   */
  modelsDevUrl: 'https://models.dev/api.json',
  /** 能力表缓存 TTL（与官方 CLI 的 60 分钟同档）。 */
  modelsDevTtlMs: 60 * 60 * 1000,
}

export const OPENCODE_MODELS_DEV_URL = OPENCODE.modelsDevUrl
export const OPENCODE_MODELS_DEV_TTL_MS = OPENCODE.modelsDevTtlMs

/** 兜底模型目录条目。 */
export interface OpencodeFallbackModel {
  id: string
  name: string
  /** 是否为官方定价表标注的免费模型（匿名槽只能选这些）。 */
  isFree: boolean
  /** 上下文窗口（DSH 以它 × 0.8 作压缩阈值）。 */
  contextWindow: number
}

/**
 * 兜底模型表（**以真机实测为准**，2026-10-01 建立；2026-10-16 复核）。
 *
 * ⚠️ 每条都对应一次成功的真实请求。`isFree` 的含义是「**匿名通道**
 * （`Bearer public`）能否使用」，不是官方定价表的 Free 标记 —— 这是本插件
 * 唯一关心的维度。
 *
 * ⚠️ `ling-3.0-flash-fin-free` **已移除**：官方 docs 说它走 `/v1/messages`
 * （Anthropic），而该端点当前对匿名与付费 key 都返回 500（与 body 形态无关），
 * chat 端点则是 404 路由不存在 ⇒ 它在两条通道上都不可用，留在目录里只会
 * 让用户点到一个必然失败的模型。
 *
 * ## 2026-10-16 复核（`GET /inference/v1/models`，`Bearer public`，88 条）
 *
 * - 新增两条免费模型：`deepseek-v4.1-flash-free`、`glm-5.3-flash-free`
 *   （清单在列；models.dev 的 `cost.input`/`cost.output` 均为 0，即免费判定
 *   的权威来源）。窗口取 models.dev 的 `limit.context` = 200000。
 * - ⚠️ 当次复核**未能**补上逐模型的匿名对话实测：本机出口当时被
 *   `429 FreeUsageLimitError` 挡住（retry-after ≈ 12h）。两行的 `isFree: true`
 *   依据是「匿名清单在列 + models.dev 计费为 0 + id 自带 `-free`」三条一致，
 *   与表中既有免费行的判定口径相同；等出口恢复后应补一次直连对话验证。
 * - `mimo-v2.5-free` / `nemotron-3-ultra-free` / `union-alpha` 已**不在**当次
 *   清单里（models.dev 仍把它们标为免费）。它们**保留**在本表：本表是远端
 *   目录拉取失败时的兜底名册，而远端拉取成功时以远端清单为准（不在清单里的
 *   条目自然不会出现）。删掉只会让离线名册更短，不会修好任何东西。
 */
export const OPENCODE_FALLBACK_MODELS: readonly OpencodeFallbackModel[] = [
  // ── 匿名可用（chat 端点，无需 key）──
  { id: 'big-pickle', name: 'Big Pickle', isFree: true, contextWindow: 262144 },
  { id: 'space-bunny-free', name: 'Space Bunny Free', isFree: true, contextWindow: 262144 },
  { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5 Preview Free', isFree: true, contextWindow: 262144 },
  { id: 'mimo-v2.6-flash-free', name: 'MiMo-V2.6-Flash Free', isFree: true, contextWindow: 262144 },
  { id: 'mimo-v2.5-free', name: 'MiMo-V2.5 Free', isFree: true, contextWindow: 262144 },
  { id: 'deepseek-v4.1-flash-free', name: 'DeepSeek V4.1 Flash Free', isFree: true, contextWindow: 200000 },
  { id: 'glm-5.3-flash-free', name: 'GLM 5.3 Flash Free', isFree: true, contextWindow: 200000 },
  // ⚠️ 这两个官方 docs 标注走 `/v1/models/{id}`（Gemini 风格），但**实测
  // chat 端点也通** ⇒ 按 chat 处理。**以实测为准，不以 docs 为准。**
  { id: 'nemotron-3-ultra-free', name: 'Nemotron 3 Ultra Free', isFree: true, contextWindow: 262144 },
  { id: 'nemotron-3.5-lightning-free', name: 'Nemotron 3.5 Lightning Free', isFree: true, contextWindow: 262144 },
  // ── 需付费 key（chat 端点；实测匿名为 401）──
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', isFree: false, contextWindow: 262144 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', isFree: false, contextWindow: 262144 },
  { id: 'glm-5.2', name: 'GLM 5.2', isFree: false, contextWindow: 262144 },
  { id: 'kimi-k2.5', name: 'Kimi K2.5', isFree: false, contextWindow: 262144 },
  { id: 'minimax-m2.7', name: 'minimax M2.7', isFree: false, contextWindow: 262144 },
  { id: 'minimax-m3', name: 'minimax M3', isFree: false, contextWindow: 262144 },
  { id: 'qwen3.8-max', name: 'Qwen3.8 Max', isFree: false, contextWindow: 262144 },
]

const FREE_IDS = new Set(OPENCODE_FALLBACK_MODELS.filter((m) => m.isFree).map((m) => m.id))
const REACHABLE_IDS = new Set(OPENCODE_FALLBACK_MODELS.map((m) => m.id))

/**
 * 该模型是否属免费（匿名槽只接受免费模型）。
 *
 * ⚠️ **未知模型返回 false**：远端目录可能含表外的新免费模型，
 * 但在未实测前把它们放给匿名槽只会换来 403/500；宁可要求用户加一个付费账号。
 */
export function isFreeOpencodeModel(id: string): boolean {
  return FREE_IDS.has(id)
}

/**
 * 该模型在我们**已实现并实测可达**的通道里是否存在。
 *
 * ## 为什么远端目录必须过这道闸（真实报障 2026-10-01）
 *
 * `GET /v1/models` 返回全部 84 个模型，且**不含任何协议信息**
 * （字段只有 id/object/created/owned_by）。若直接把它们交给 DSH，
 * 用户会在选择器里看到 `ling-3.0-flash-fin-free`、`claude-*`、
 * `gpt-*` 等模型 —— 点下去只会拿到 404/401/500。
 *
 * ⇒ 目录**只暴露本表内的模型**；表外的新模型要等实测确认端点后再加进来。
 * （表本身也来自实测：见 `2026-10-02-opencode-zen-endpoint-matrix.md`。）
 */
export function isReachableOpencodeModel(id: string): boolean {
  return REACHABLE_IDS.has(id)
}

export type OpencodeErrorKind =
  | 'free_usage_limit'
  | 'go_usage_limit'
  | 'rate_limit'
  | 'free_tier'
  | 'quota'
  | 'auth'
  | 'server'
  | 'transport'

export interface OpencodeErrorInfo {
  kind: OpencodeErrorKind
  /** 服务端要求的等待时长（毫秒）；仅在限流类错误上产出。 */
  retryAfterMs?: number
  /** 面向用户的可读描述（禁止裸 JSON）。 */
  detail: string
}

/** 从错误体里抽出人可读片段（禁止把整坨 JSON 抛给用户）。 */
function readableDetail(body: string): string {
  const text = body.trim()
  if (text === '') return '（上游未返回错误详情）'
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown; msg?: unknown }
    const nested = typeof data.error === 'object' && data.error !== null
      ? (data.error as { message?: unknown }).message
      : data.error
    const parts = [data.message, nested, data.msg]
      .filter((v): v is string => typeof v === 'string' && v.length > 0)
    if (parts.length > 0) return parts.join(' ')
  } catch {
    // 非 JSON：直接截断原文
  }
  return text.length > 500 ? `${text.slice(0, 500)}…` : text
}

/**
 * 把一次失败的 HTTP 响应归类为语义化的错误。
 *
 * @param status  HTTP 状态码；传输层失败传 0。
 * @param body    响应体原文（调用方**必须先读一次体**再调本函数）。
 * @param headers 响应头。
 */
export function classifyOpencodeError(
  status: number,
  body: string,
  headers?: Readonly<Record<string, string>>,
): OpencodeErrorInfo {
  const retryAfterMs = retryAfterMsFromRecord(headers)
  const detail = readableDetail(body)
  const lower = body.toLowerCase()

  // ⚠️ **顺序即优先级**：限流语义必须在 auth 之前判 —— 上游的额度错误
  // 经常带 401/403 状态码，若先判状态码会把「额度用尽」误报成「key 失效」，
  // 用户的唯一有效动作（等窗口恢复 / 切下一个账号）会被完全掩盖。
  if (body.includes('FreeUsageLimitError')) {
    return { kind: 'free_usage_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (body.includes('GoUsageLimitError')) {
    return { kind: 'go_usage_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (body.includes('FreeTierError')) {
    // 形状门禁：伪装形态被拒。**不重试也不换槽**（我们每槽发的是同一套形状，
    // 换槽重试无意义），如实透传让人知道「伪装需跟进上游更新」。
    return { kind: 'free_tier', detail }
  }
  if (status === 429 || lower.includes('too many requests') || lower.includes('rate limit')) {
    return { kind: 'rate_limit', ...retryAfterMs === undefined ? {} : { retryAfterMs }, detail }
  }
  if (status === 0 || lower.includes('fetch failed') || lower.includes('terminated')
      || lower.includes('econnreset') || lower.includes('socket hang up')
      || lower.includes('getaddrinfo') || lower.includes('econnrefused')) {
    return { kind: 'transport', detail }
  }
  // ⚠️⚠️ **402 必须单独归类**（真实报障 2026-10-01）：
  // 实测付费 key 余额耗尽时上游回 `402
  // {"error":{"type":"server_error","message":"...Insufficient account funds"}}`。
  // 若落进下面的 `status >= 500` 之外、又被 `httpErrorCode` 归成 `SERVER`，
  // 用户看到的是「服务端故障，请重试」—— 而重试永远不会成功（要充值）。
  // 必须映射到 QUOTA_EXCEEDED，UI 才能给出「去充值」这个唯一有效动作。
  if (status === 402 || lower.includes('insufficient account funds')
    || lower.includes('insufficient funds') || lower.includes('insufficient balance')) {
    return { kind: 'quota', detail }
  }
  if (status === 401 || status === 403) return { kind: 'auth', detail }
  if (status >= 500) return { kind: 'server', detail }
  return { kind: 'auth', detail }
}
