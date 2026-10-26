/**
 * LobsterAI（有道龙虾）产品配置。
 *
 * 因此这里定义**平行**的 `LobsteraiProduct`：共用的是架构**模式**
 * （产品差异收敛到单一真相源），不是那个类型。
 *
 * ## 数据来源
 *
 * - API 基址 / 版本号接口：`lobsterai2api/sigin.py:10-11`（实测可用）；
 * - 端点路径与请求头：`lobsterai2api/internal/upstream/client.go`；
 * - 兜底模型表：`lobsterai2api/internal/server/handler.go:94-114`
 *   （注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」）；
 * - portal 基址：本次实测确认（见下）。
 */

/**
 * 兜底模型目录中的一个条目。
 */
export interface LobsteraiFallbackModel {
  /** 模型 ID（传给 `POST /api/proxy/v1/chat/completions` 的 `model`）。 */
  id: string
  /** 展示名。 */
  name: string
  /**
   * 上下文窗口（**桥接层的估计值，非远端权威值**）。
   *
   * `handler.go:94-114` 里 19 个模型全部标 `131072`，那是对齐
   * `deepseek-v4` 系的取值后**统一填的**，并非逐个实测。
   * 实测远端多数模型返回 `1000000`，故该估计值偏保守。
   */
  contextWindow: number
}

/**
 * 上游 API 基址。
 *
 * `sigin.py:10` 硬编码 `https://lobsterai-server.youdao.com`；Go 侧被
 * 脱敏成 env `LB2A_UPSTREAM_BASE`（无编译期默认值）。
 * 本插件按文档 §0.2b 的结论固化在常量里 —— 插件面向终端用户，
 * 不应要求用户自行提供域名。
 */
export const LOBSTERAI_API_BASE = 'https://lobsterai-server.youdao.com'

/**
 * 登录 portal 基址。
 *
 * 实测（见文档 §0.2b）：与 `LOBSTERAI_API_BASE` **同一 IP、同一 CNAME 目标**
 * （`pub-g1-gz.alb.ntes53.netease.com`），说明是同一套服务的不同路径；
 * 访问 `{portalBase}/portal` 返回 HTTP 200，页面标题
 * 「LobsterAI - 全场景个人助理 Agent」，与 `cmd/login/main.go:226` 拼出的
 * `{portal}/portal#/login?...` 路径吻合。
 *
 * 之所以仍与 `apiBase` 分成两个字段：Go 侧本就是两个独立 env，
 * 且不排除未来门户与 API 分离部署。
 */
export const LOBSTERAI_PORTAL_BASE = 'https://lobsterai.youdao.com'

/**
 * 客户端版本号查询端点（第三方域名）。
 *
 * 注意该响应**不是**统一信封：`code`/`msg` 在**外层**，载荷在 `data.value`。
 * 实测（2026）返回 `version: "2026.9.4"`（日期式版本号）。
 */
export const LOBSTERAI_CLIENT_VERSION_API
  = 'https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update'

/**
 * 无法动态取到版本号时的兜底值。
 *
 * `sigin.py:73-76` 在取不到版本号时**整个脚本放弃签到**；本插件比它宽容：
 * 用这个兜底值继续尝试，并在日志里警告。理由是宁可用一个稍旧的版本号试，
 * 也别让用户完全无法签到 —— 后端对 `version` 并不强校验
 * （反证：Go 侧一直发假值 `0.1.0` 也未导致失败）。
 *
 * 取值来自 2026 年实测的最后一个已知版本；随着客户端更新会逐渐变旧。
 */
export const LOBSTERAI_FALLBACK_CLIENT_VERSION = '2026.9.4'

/**
 * 客户端能力声明（`X-LobsterAI-Client-Capabilities` 头）。
 *
 * 两个能力**都必须声明**，各自解决一个具体问题（2026-09-17 真实凭据实测）：
 *
 * - `kimi-k3-agentic-v1`：**模型列表的准入条件**。不带该能力时
 *   `/api/models/available` 只返回 25 个模型且**没有 `kimi-k3`**；带上才 26 个。
 *   该值来自 `internal/upstream/client.go:99` 的硬编码。
 * - `thinking-level-control-v1`：**思考档位协议的前提**。`reasoning_effort`
 *   的常规档位（low/high/max/xhigh）不需要它，但 `"off"`（关闭思考）
 *   在**不带**该能力时服务端直接 HTTP 500（`{"code":500,"message":"服务器内部错误"}`），
 *   带上则正常返回。也就是说「关掉思考」这条协议要先声明支持它。
 *
 * 顺序无关（两种顺序都实测通过），但保持与 IDE 的
 * `LOBSTERAI_CLIENT_CAPABILITIES`（`modelRuntimeProfiles.js`）一致的排列。
 */
export const LOBSTERAI_CLIENT_CAPABILITIES
  = 'kimi-k3-agentic-v1,thinking-level-control-v1'

/**
 * User-Agent。
 *
 * 原样照抄 `client.go:21` 的 `clientUA = "LobsterAI/0.1.0"`。
 *
 * **刻意不跟着真版本号改**：Go 侧用这个 UA 是实测可用的，而
 * `X-LobsterAI-Client-Version` 头用真值 `2026.9.4`（见下方说明）。
 * 若同时改两处，一旦服务端行为变化将无法归因是哪一个导致的，
 * 故先只改有确定依据的那一个（版本头），UA 待单独实测。
 */
export const LOBSTERAI_USER_AGENT = 'LobsterAI/0.1.0'

/**
 * LobsterAI 产品配置。
 */
export interface LobsteraiProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'lobsterai'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 登录门户基址（不含 `/portal` 路径）。 */
  portalBase: string
  /** 上游 API 基址（不含路径）。 */
  apiBase: string
  /** 客户端版本号查询端点。 */
  clientVersionApi: string
  /** 版本号动态拉取失败时的兜底值。 */
  fallbackClientVersion: string
  /** `User-Agent` 头取值。 */
  userAgent: string
  /** `X-LobsterAI-Client-Capabilities` 头取值。 */
  clientCapabilities: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9）。
   */
  imagePixelBudget?: number
  /** 单张请求图片的编码字节目标（未配置用 1 MiB，见 `src/image-budget.ts`）。 */
  imageMaxBytes?: number
  /** 远端模型列表不可用时的兜底模型目录。 */
  fallbackModels: readonly LobsteraiFallbackModel[]
}

/**
 * 兜底模型目录（19 个）。
 *
 * 来源：`lobsterai2api/internal/server/handler.go:94-114` 的 `staticModels`，
 * 注释标明「2026-08-06 从 `GET /api/models/available` 实测拉取」。
 *
 * 顺序**照抄原表**，不重排 —— 它是实测时的返回顺序，重排会让「与上游对比」
 * 这类排查工作失去可比性。
 *
 * `contextWindow` 全部为 131072：这是桥接层统一填的值（见
 * {@link LobsteraiFallbackModel.contextWindow} 的说明），**不是**逐个实测结果。
 */
const LOBSTERAI_FALLBACK_MODELS: readonly LobsteraiFallbackModel[] = [
  { id: 'deepseek-v4-flash', name: 'deepseek-v4-flash', contextWindow: 131_072 },
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', contextWindow: 131_072 },
  { id: 'MiniMax-M3', name: 'MiniMax-M3', contextWindow: 131_072 },
  { id: 'MiniMax-M2.7', name: 'MiniMax-M2.7', contextWindow: 131_072 },
  { id: 'qwen3.7-max', name: 'qwen3.7-max', contextWindow: 131_072 },
  { id: 'qwen3.7-plus', name: 'qwen3.7-plus', contextWindow: 131_072 },
  { id: 'qwen3.6-plus', name: 'qwen3.6-plus', contextWindow: 131_072 },
  { id: 'qwen3.5-plus-2026-04-20', name: 'qwen3.5-plus-2026-04-20', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code', name: 'kimi-k2.7-code', contextWindow: 131_072 },
  { id: 'kimi-k2.7-code-highspeed', name: 'kimi-k2.7-code-highspeed', contextWindow: 131_072 },
  { id: 'kimi-k2.6', name: 'kimi-k2.6', contextWindow: 131_072 },
  { id: 'kimi-k2.5', name: 'kimi-k2.5', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-pro-260628', name: 'doubao-seed-2-1-pro-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-1-turbo-260628', name: 'doubao-seed-2-1-turbo-260628', contextWindow: 131_072 },
  { id: 'doubao-seed-2-0-code-preview-260215', name: 'doubao-seed-2-0-code-preview-260215', contextWindow: 131_072 },
  { id: 'glm-5.2', name: 'glm-5.2', contextWindow: 131_072 },
  { id: 'glm-5.1', name: 'glm-5.1', contextWindow: 131_072 },
  { id: 'glm-5v-turbo', name: 'glm-5v-turbo', contextWindow: 131_072 },
  { id: 'glm-5', name: 'glm-5', contextWindow: 131_072 },
]

/**
 * LobsterAI provider 配置。
 */
export const LOBSTERAI: LobsteraiProduct = {
  id: 'lobsterai',
  displayName: 'LobsterAI (有道)',
  portalBase: LOBSTERAI_PORTAL_BASE,
  apiBase: LOBSTERAI_API_BASE,
  clientVersionApi: LOBSTERAI_CLIENT_VERSION_API,
  fallbackClientVersion: LOBSTERAI_FALLBACK_CLIENT_VERSION,
  userAgent: LOBSTERAI_USER_AGENT,
  clientCapabilities: LOBSTERAI_CLIENT_CAPABILITIES,
  defaultCredentialRef: 'LOBSTERAI_ACCESS_TOKEN',
  fallbackModels: LOBSTERAI_FALLBACK_MODELS,
}

/** 全部 LobsterAI 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_LOBSTERAI_PRODUCTS: readonly LobsteraiProduct[] = [LOBSTERAI]

/**
 * 按 provider id 取 LobsterAI 产品配置；未知 id 返回 undefined。
 */
export function lobsteraiProductById(id: string): LobsteraiProduct | undefined {
  return ALL_LOBSTERAI_PRODUCTS.find((product) => product.id === id)
}
