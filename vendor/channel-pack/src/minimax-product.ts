/**
 * MiniMax Code（**中国版**）产品配置。
 *
 * ## 为什么新建 `MinimaxProduct` 而不复用既有类型
 *
 * ## 数据来源（全部实测或 asar 源码直读，见 docs/minimax-protocol-notes.md）
 *
 * - 主机：asar `@mavis/config/dist/config.js` 的 `PRESET_BASE_URLS['cn-prod']`
 * - OAuth 端点：asar `@mavis/oauth-core/dist/endpoint-config.js`
 * - `clientId` / `scope` / `audience`：`~/.minimax/auth/prod/cn/mcode-public/auth.json`
 *   与 asar `contracts.js`
 * - 兜底模型表：2026-09-28 实测 `GET /mavis/api/v1/models?region=cn&buildEnv=prod`
 */

/**
 * 兜底模型目录中的一个条目。
 *
 * ⚠️ **必须镜像远端实测值** —— 两处不一致会让「远端失败降级到兜底表」时
 * 档位或窗口**凭空变化**，且极难排查。
 */
export interface MinimaxFallbackModel {
  /** 模型 ID（传给推理端点的 `model`）。 */
  id: string
  /** 展示名（照抄远端 `name`，不加倍率/后缀）。 */
  name: string
  /**
   * 上下文窗口 —— **档位表最大档**（用户 2026-09-28 定口径）。
   *
   * ⚠️ **不是**远端 `limit.context`：`MiniMax-M3.1-Flash-Preview` 的
   * `limit.context` 是 512000，但 `context_window_options` 是
   * `[512000, 1000000]`。填 512K 会让 DSH **远早于官方能力触发压缩**
   * —— 与 Qoder 那次「档位表有 1M 档就填 1M」同口径。
   */
  contextWindow: number
  /** 单次输出上限（远端 `limit.output`）。 */
  maxTokens: number
  /** 是否支持图片输入（远端 `modalities.input` 含 `image`）。 */
  supportsImage: boolean
  /** 思考档位（远端 `effort_options`）；**只有 M3.1-Flash-Preview 有**。 */
  effortOptions?: readonly string[]
  /** 默认档位（远端 `default_effort`）；必须落在 `effortOptions` 内。 */
  defaultEffort?: string
  /**
   * 思考开关模式（远端 `thinking_config.mode`）。
   *
   * ⚠️ **实测三种值，语义完全不同**（2026-09-29 远端目录 + 真机请求）：
   * - `forced_on`：**思考强制开启**，传 `disabled` 会被**静默忽略**
   *   （M2.7 实测仍产出 49 个思考块）或**硬 400**（M3.1 实测
   *   `requires adaptive thinking ... (2013)`）。
   * - `switchable`：**可以开关**（M3 实测：不传/`disabled` → 0 思考块，
   *   `adaptive` → 有思考块）。官方形态见 `variants.none-thinking` / `variants.thinking`。
   *
   * 缺失 → 视为**未知**，不声明开关能力（不猜测）。
   */
  thinkingMode?: string
}

/**
 * 兜底模型目录（4 条，顺序**照抄远端 `model_order`**）。
 *
 * ⚠️ **必须含 `MiniMax-M3.1-Flash-Preview`** —— 它**不在**客户端内置静态表里
 * （asar `config.js` 的 `MINIMAX_MODELS` 只有 3 个：M3 / M2.7-highspeed / M2.7）。
 * 若兜底表也漏掉它，远端一失败用户就**看不到自己在用的模型**。
 *
 * ⚠️ **只有 M3.1-Flash-Preview 有 `effortOptions`** —— 其余三个远端
 * **没有 `effort_options` 字段**。给它们编档位就是凭空猜测
 * （与 Qoder「`qmodel` 没有档位就是没有，不要按截图猜」同型教训）。
 */
const MINIMAX_FALLBACK_MODELS: readonly MinimaxFallbackModel[] = [
  {
    id: 'MiniMax-M3.1-Flash-Preview',
    name: 'M3.1-Flash-Preview',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    effortOptions: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'default',
    // ⚠️ forced_on：传 disabled 会被服务端**硬拒**（400 `requires adaptive
    // thinking ... (2013)`，实测）。它与 M2.7 的 forced_on 不同形态：
    // M2.7 是**静默忽略**，M3.1 是**报错**。
    thinkingMode: 'forced_on',
  },
  {
    id: 'MiniMax-M3',
    name: 'M3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    supportsImage: true,
    // ⚠️ 实测可开关思考（`switchable`）：不传/disabled → 0 思考块，
    // adaptive → 有思考块。官方形态见远端 `variants`。
    // ⚠️ 但它**没有 `effort_options`** ⇒ 没有「档位」可选，
    // 只有「开/关」两态 —— 与 Qoder `qmodel` 的「只有关闭思考」同型。
    thinkingMode: 'switchable',
  },
  {
    id: 'MiniMax-M2.7-highspeed',
    name: 'M2.7-highspeed',
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    // ⚠️ forced_on：传 disabled 被**静默忽略**（实测仍产出思考块）
    thinkingMode: 'forced_on',
  },
  {
    id: 'MiniMax-M2.7',
    name: 'M2.7',
    contextWindow: 200_000,
    maxTokens: 128_000,
    supportsImage: false,
    thinkingMode: 'forced_on',
  },
]

/** MiniMax Code 产品配置。 */
export interface MinimaxProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'minimax'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 账号与 OAuth 主机（`account.minimax.cn`）。 */
  accountHost: string
  /** API 主机（目录 / 签到 / 积分）。 */
  apiHost: string
  /** 区域（目录查询参数）。 */
  region: string
  /** 构建环境（目录查询参数）。 */
  buildEnv: string
  /** OAuth client_id（官方常量，取自 auth.json 与 asar）。 */
  clientId: string
  /** OAuth audience（asar `contracts.js` 的 `MCODE_OAUTH_AUDIENCE`）。 */
  audience: string
  /** OAuth scope（**凭据校验要求必须含它**，否则 `invalid_token_response`）。 */
  scope: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 远端模型列表不可用时的兜底目录。 */
  fallbackModels: readonly MinimaxFallbackModel[]
  /** 单张内联图片字节上限（远端 `capabilities.max_image_bytes_inline`，未实测）。 */
  maxImageBytesInline: number
  /** 请求体字节上限（远端 `capabilities.max_request_body_bytes`，未实测）。 */
  maxRequestBodyBytes: number
}

/** MiniMax Code 中国版 provider 配置。 */
export const MINIMAX: MinimaxProduct = {
  id: 'minimax',
  displayName: 'MiniMax Code',
  accountHost: 'https://account.minimax.cn',
  apiHost: 'https://agent.minimax.cn',
  region: 'cn',
  buildEnv: 'prod',
  clientId: 'mcode-public',
  audience: 'agent-backend',
  scope: 'agent.default',
  defaultCredentialRef: 'MINIMAX_ACCESS_TOKEN',
  fallbackModels: MINIMAX_FALLBACK_MODELS,
  maxImageBytesInline: 10 * 1024 * 1024,
  maxRequestBodyBytes: 64 * 1024 * 1024,
}

/** 产品注册表（供 `productById` 风格查找；本轮只有一个）。 */
export const ALL_MINIMAX_PRODUCTS: readonly MinimaxProduct[] = [MINIMAX]

/** 按 id 查产品配置。 */
export function minimaxProductById(id: string): MinimaxProduct | undefined {
  return ALL_MINIMAX_PRODUCTS.find((product) => product.id === id)
}

// ===== 端点路径 =====

/** OAuth 设备码申请（asar `endpoint-config.js`）。 */
export const MINIMAX_DEVICE_CODE_PATH = '/oauth2/device/code'
/** OAuth 令牌（轮询与续期共用）。 */
export const MINIMAX_TOKEN_PATH = '/oauth2/token'
/** OAuth 撤销。 */
export const MINIMAX_REVOKE_PATH = '/oauth2/revoke'
/** 远端模型目录（需 `?region=&buildEnv=`）。 */
export const MINIMAX_MODELS_PATH = '/mavis/api/v1/models'
/**
 * 推理路径（Anthropic Messages）。
 *
 * ⚠️ **本轮不发请求**（用户 2026-09-28 决定：账号余额不足，无法端到端验证）。
 * 常量保留供将来实现 `stream()` 时使用，并在文档里标注未实测。
 */
export const MINIMAX_INFER_PATH = '/mavis/api/v1/llm/v1/messages'
/** 签到状态（⚠️ 必须带 `?timezone_id=`）。 */
export const MINIMAX_SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status'
/** 签到领取（⚠️ 必须带 `?timezone_id=`）。 */
export const MINIMAX_SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'
/** 积分明细。 */
export const MINIMAX_CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details'

/** 请求超时（毫秒）。 */
export const MINIMAX_REQUEST_TIMEOUT_MS = 30_000
/** OAuth 请求超时（毫秒）；比业务请求短，避免用户干等。 */
export const MINIMAX_OAUTH_TIMEOUT_MS = 20_000
/**
 * 模型目录的**客户端**缓存期（远端 `ttlSeconds: 300`）。
 *
 * ⚠️ **当前仓库中无任何引用** —— 保留它是因为远端快照确实下发了 `ttlSeconds`，
 * 且这是将来实现「目录本地缓存」时该用的值。
 * 我们**不照抄**这么久的缓存（DSH 按需拉取目录），故实现缓存时也应重新评估。
 */
export const MINIMAX_MODEL_TTL_MS = 300_000
