/**
 * Cline 产品配置。
 *
 * ## 为什么是**第七套**独立配置
 *
 * Cline 与既有六个 provider **都不同源**，且差异点与任何一个都不重合：
 *
 * 共用的是架构**模式**（产品差异收敛到单一真相源、账号池、限流切换），
 * 不是任何一个既有 Product 类型 —— 与 Qoder / TRAE 的处理方式一致。
 *
 * ## 数据来源
 *
 * 全部来自本机 Cline 桌面端产物逆向 + 实测（2026-09-25）：
 * - 二进制：`C:\Users\Jet\AppData\Local\Cline\code-sidecar.exe`（bun 单文件，144 MB）
 * - 真实凭据：`C:\Users\Jet\.cline\data\settings\providers.json`
 *
 * 排查脚本（均为只读）：`scripts/probe-cline-endpoints.mjs`（按关键词提取
 * 二进制字符串窗口）、`probe-cline-models.mjs`、`probe-cline-recommended.mjs`、
 * `probe-cline-balance.mjs`、`probe-cline-chat.mjs`。
 *
 * 详细取证见 `docs/superpowers/specs/2026-09-25-cline-provider-design.md` §2。
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ **本表只是兜底**：真实免费集合由远端
 * `GET /api/v1/ai/cline/recommended-models` 的 `free` 数组下发，
 * 且**内嵌目录缺 `stealth/space-bunny-alpha` 与 `cline-free/*`**（远端才有）。
 * 故本表不足以覆盖免费集合 —— 见 `src/cline-models.ts` 的合并逻辑。
 */
export interface ClineFallbackModel {
  /** 模型 id（远端原样，如 `cline-free/deepseek-v4.1-flash`）。 */
  id: string
  /** 展示名（不含 `· 免费` 后缀，后缀由展示函数统一拼）。 */
  name: string
  /** 上下文窗口（内嵌目录 `contextWindow`）。 */
  contextWindow: number
  /** 单次输出上限（内嵌目录 `maxTokens`）。 */
  maxTokens?: number
  /** 是否接受图片输入（内嵌目录 `capabilities` 含 `images`）。 */
  supportsImage?: boolean
  /**
   * 是否免费额度模型。
   *
   * 判据见 `src/cline-models.ts`：远端 `free` 数组 ∪ `:free` 后缀
   * ∪ `cline-free/` 前缀 ∪ 本字段。
   */
  isFree?: boolean
  /** 简介（内嵌目录 `description`，用于 /model 弹窗）。 */
  description?: string
}

/** Cline 产品配置。 */
export interface ClineProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'cline'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /**
   * API 基址（`CLINE_ENVIRONMENTS.production.apiBaseUrl`）。
   *
   * 推理、模型目录、账号端点、`auth/register`、`auth/refresh` 全部挂在它下面。
   */
  apiBase: string
  /** Web 应用基址（`appBaseUrl`）；登录引导页用。 */
  appBase: string
  /**
   * WorkOS 基址（`DEFAULT_WORKOS_API_BASE_URL`）。
   *
   * 设备码授权与 token 轮询走它，**不是** `apiBase`。
   */
  workOsBase: string
  /**
   * WorkOS client id（`workOsClientId`）。
   *
   * ⚠️ 这个值同时出现在 `CLINE_ENVIRONMENTS.production` 与凭据 JWT 的
   * `client_id` claim 里，两处一致（实测）。staging / local 环境各有自己的
   * client id，本插件只支持 prod。
   */
  workOsClientId: string
  /**
   * 客户端标识请求头。
   *
   * 源码 `DEFAULT_CLINE_REQUEST_HEADERS`。⚠️ **推理与账号端点都需要**：
   * 只带 Authorization 时实测虽可通（`/api/v1/users/me` 200），但这些头是
   * 官方客户端的身份声明，缺失可能在某些网关策略下被拒或降级，
   * 故照官方原样下发。
   */
  clientHeaders: Readonly<Record<string, string>>
  /**
   * 访问令牌的前缀。
   *
   * ⚠️ **必须保留**：源码 `resolveApiKey` 原样使用存储值，而 Cline 磁盘上
   * 存的就是 `workos:eyJ…`。该前缀只在**解码 JWT** 时被剥掉
   * （`decodeJwtPayload(token.replace(/^workos:/, ""))`），
   * **从不出现在请求头构造里**。
   *
   * 实测（同一凭据）：
   * - `Authorization: Bearer workos:eyJ…` → `/api/v1/users/me` **200**
   * - `Authorization: Bearer eyJ…`（剥掉前缀）→ **401**
   *
   * 401 文案是 "make sure you're using the latest version of Cline"，
   * 与真实原因毫不相干 —— 剥前缀会让人误判成「版本过旧」。
   */
  tokenPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9）。
   */
  imagePixelBudget?: number
  /** 单张请求图片的编码字节目标（未配置用 1 MiB，见 `src/image-budget.ts`）。 */
  imageMaxBytes?: number
  /** 模型列表不可用时的兜底目录。 */
  fallbackModels: readonly ClineFallbackModel[]
}

/**
 * 兜底模型目录（内嵌 `BUILTIN_MODEL_CATALOG.cline` 段 + 远端 `free` 数组实测）。
 *
 * ⚠️ **免费模型是独立 id**：`cline-free/deepseek-v4.1-flash`（免费）与
 * `deepseek/deepseek-v4.1-flash`（按量计费）是**两个不同条目**。
 * 绝不可用「名字包含 deepseek」之类的模糊匹配判免费。
 *
 * ⚠️ 远端 `/api/v1/models` 的 460 个 id 里**根本没有 `cline-free/*`**
 * （实测 `Select-String 'cline-free/'` 零命中）—— 免费模型**只**由
 * `recommended-models` 下发。这是「只调 `/models` 会看不到任何免费模型」的原因。
 *
 * ⚠️ 内嵌目录（`cline-models.ts` 的 `BUILTIN_MODEL_CATALOG`）**缺
 * `stealth/space-bunny-alpha` 与 `cline-free/*`**，它们只由 `recommended-models`
 * 的 `free` 数组下发；故本兜底表把它们补上，否则离线 / 远端失败时用户看不到免费模型。
 * ⚠️ **别把「内嵌目录」与「本兜底表」当成同一个东西**（早先的注释正是这么写的，
 * 「内嵌目录缺 `cline-free/*`」紧跟着下面这张**含有 2 条 `cline-free/*`** 的表，
 * 读起来自相矛盾）。内嵌目录缺的、由本表补的 —— 说的是**来源**，不是本表的内容。
 *
 * ⚠️ **这条表要与远端 `free` 数组同步** —— 它是**编译期快照**，上游撤掉某个
 * 免费模型时它不会自己跟着变，而陈旧条目会让用户看到一个标着「免费」的模型、
 * 选中却回 `404 {"error":"model not found"}`。已经发生过两次：
 * - `gemini-3.8-flash`（2026-10-03 复测发现）；
 * - `deepseek-v4.1-flash`（2026-10-05 复测发现，`free` 数组由 4 条降到 **3 条**）。
 *
 * **别照抄旧版本的表把它们加回来**（旧版本里 `gemini-3.8-flash` 带着
 * `maxTokens: 65_536` 那条实测值，那是为解决当时的 400 而填的，见
 * AGENTS.md「Gemini 系模型的两个 400」）。
 *
 * ⚠️ 与 `mergeClineModels` 的分工：本表**只在远端不可用时**整表兜底；远端可用时
 * 那条路径会丢弃「远端已不认识」的条目（见 `cline-models.ts` 第 2 步注释），
 * 故本表万一再次落后，也不会在在线状态下把下架模型复活。
 */
const CLINE_FALLBACK_MODELS: readonly ClineFallbackModel[] = [
  // ── 免费模型（远端 `free` 数组实测，2026-10-05 复测：共 3 个）──
  {
    id: 'stealth/space-bunny-alpha',
    name: 'Space Bunny Alpha',
    contextWindow: 1_000_000,
    maxTokens: 524_288,
    supportsImage: true,
    isFree: true,
    description: 'Blazing-fast inference with 1M context',
  },
  {
    id: 'cline-free/mimo-v2.6-flash',
    name: 'MiMo-V2.6-Flash',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    supportsImage: true,
    isFree: true,
    description: 'Mixture-of-Experts architecture with 309B total parameters',
  },
  {
    id: 'cline-free/muse-spark-1.3-contributor',
    name: 'Muse Spark 1.3 Contributor',
    contextWindow: 1_048_576,
    maxTokens: 943_718,
    supportsImage: true,
    isFree: true,
    description:
      'Meta\u2019s multimodal reasoning model for experimentation, learning, '
      + 'and early-stage agentic, multi-agent, and coding workflows.',
  },
]

/**
 * Cline 全 provider 统一的思考档位（**顺序即 UI 展示顺序**）。
 *
 * ## 为什么所有模型共用一张表
 *
 * 远端**不下发**档位：`/api/v1/models` 只有 `{id, object, created, owned_by}`，
 * `recommended-models` 只有 `{id, name, description, tags}`；sidecar 里
 * `/api/v1/` 的 21 个路径中也没有任何模型详情端点。档位只存在于客户端
 * 内嵌 `BUILTIN_MODEL_CATALOG`，而那张表覆盖不了远端 460 个 id。
 *
 * 故按产品决策对**所有**模型统一给这 5 档。已知局限：对不在内嵌目录里的
 * 模型，档位是猜的 —— 但上游对不认识的档位**静默忽略而不报错**
 * （实测 `reasoning_effort: 'banana'` 返回 HTTP 200 且思考量为 0），
 * 所以最坏情况是「开关无效」，不会是「请求失败」。
 *
 * ## `id` 与 `name` 刻意不同（wire 值 ≠ 展示名）
 *
 * Cline IDE 的档位菜单是 None/Low/Medium/High/**Extra**（用户截图实测），
 * 而上游认的 wire 值是 `none/low/medium/high/max`。最高档的对应关系是
 * **行为实测**出来的，不是从二进制反推的：
 *
 * | effort | reasoning 字符数（`stealth/space-bunny-alpha`，同题 3 次采样均值） |
 * |---|---|
 * | 不传 / `none` | 0（**不传 = 不思考**） |
 * | `low` | 67 |
 * | `medium` | 379 |
 * | `high` | 294 |
 * | `xhigh` | **259（与 high 无可辨差异 → 伪档位，跳过）** |
 * | `max` | **1192（high 的 4 倍 → 最高档）** |
 *
 * 旁证：sidecar 权重表 `{ max:1, xhigh:0.95, high:0.8, medium:0.5, low:0.2, ... }`
 * 同样确认 `max` 在 `xhigh` 之上。
 *
 * ⚠️ **把 `id` 与 `name` 当成同一个概念会让用户找不到档位** —— 与本项目
 * LobsterAI 那条「wire 值 ≠ 展示名」的教训同源。
 */
export const CLINE_REASONING_EFFORTS: readonly { id: string; name: string }[] = [
  { id: 'none', name: 'None' },
  { id: 'low', name: 'Low' },
  { id: 'medium', name: 'Medium' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Extra' },
]

/**
 * 默认思考档位。
 *
 * ⚠️ **声明它会改变默认行为**：实测「不传 `reasoning_effort` → 模型完全不思考」，
 * 而 `dsh-client-ui-model-selection` 在用户未手动选择时会自动采用
 * `model.reasoning.defaultEffort`（`state.current?.reasoningEffort ?? defaultEffort`）。
 * 即声明后 Cline 从「默认不思考」变成「默认 High 思考」，与 IDE 一致，
 * 代价是思考 token 计入 `completion_tokens`。这是**用户明确要求**的变更。
 */
export const CLINE_DEFAULT_REASONING_EFFORT = 'high'

/** Cline provider 配置（生产环境）。 */
export const CLINE: ClineProduct = {
  id: 'cline',
  displayName: 'Cline',
  apiBase: 'https://api.cline.bot',
  appBase: 'https://app.cline.bot',
  workOsBase: 'https://api.workos.com',
  workOsClientId: 'client_01K3A541FN8TA3EPPHTD2325AR',
  clientHeaders: {
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline',
    'X-IS-MULTIROOT': 'false',
    'X-CLIENT-TYPE': 'cline-sdk',
  },
  tokenPrefix: 'workos:',
  defaultCredentialRef: 'CLINE_ACCESS_TOKEN',
  fallbackModels: CLINE_FALLBACK_MODELS,
}

/** 全部 Cline 产品配置（当前只有一个，保留数组以便将来扩展 staging）。 */
export const ALL_CLINE_PRODUCTS: readonly ClineProduct[] = [CLINE]

/** 按 provider id 取 Cline 产品配置；未知 id 返回 undefined。 */
export function clineProductById(id: string): ClineProduct | undefined {
  return ALL_CLINE_PRODUCTS.find((product) => product.id === id)
}

// ── 端点路径常量 ──
// 抽成常量而非散落字面量：登录、续期、模型、余额四处都要用，
// 且它们**全部挂在 `apiBase` 下**（WorkOS 那两个例外，挂 `workOsBase`）。

/** 设备码授权（挂 `workOsBase`）。 */
export const CLINE_DEVICE_AUTHORIZATION_PATH = '/user_management/authorize/device'
/** 设备码 token 轮询（挂 `workOsBase`）。 */
export const CLINE_DEVICE_AUTHENTICATE_PATH = '/user_management/authenticate'
/** 注册 WorkOS token（换 Cline 自己的 token，挂 `apiBase`）。 */
export const CLINE_REGISTER_PATH = '/api/v1/auth/register'
/** 续期（挂 `apiBase`）。 */
export const CLINE_REFRESH_PATH = '/api/v1/auth/refresh'
/** 推理（OpenAI 兼容，挂 `apiBase`）。 */
export const CLINE_CHAT_PATH = '/api/v1/chat/completions'
/** 全量模型 id 列表（挂 `apiBase`）。 */
export const CLINE_MODELS_PATH = '/api/v1/models'
/** 推荐模型（含 **`free` 数组**，挂 `apiBase`，**无需认证**）。 */
export const CLINE_RECOMMENDED_MODELS_PATH = '/api/v1/ai/cline/recommended-models'
/** 账号信息（挂 `apiBase`）。 */
export const CLINE_ME_PATH = '/api/v1/users/me'
