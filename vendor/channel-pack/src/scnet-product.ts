/**
 * SCNet（超算互联网）产品常量。
 *
 * ## 与其余渠道的关系
 *
 * SCNet 是本插件新增的**账号渠道**，登录方式与 Loomy 同族（**手机号 + 短信
 * 验证码**，见 `loomy.ts`），但多了两件事，且都在 `scnet-web-login.ts` 里：
 *
 *   1. 一条 `POST /sso/captcha.action` 的**图形验证码**（base64 data URL）；
 *   2. 发码响应用 `code` 区分「号码是否已注册」——未注册走**注册即登录**。
 *
 * ## 两个域必须分清
 *
 * - `platformBase`（`https://www.scnet.cn`）——平台：登录、Cookie、acx 业务接口、换 key；
 * - `apiBase`（`https://api.scnet.cn/api/llm/v1`）——模型网关：只认 `Bearer sk-…`，**不认 Cookie**。
 *
 * ## 上下文与输出上限为什么是 1M / 128k
 *
 * 参考实现实测（scnet-api 协议笔记里的同源探针）：输入 ~97.3 万 token 通过、
 * 1.07M 被拒（`10013`），`max_tokens: 131072` 被接受。客户端目录里那条
 * `262144` 是客户端主进程自己的保守暂定值，不是平台能力 —— 照抄会在 1/4 处
 * 就开始压缩上下文，白白浪费 3/4 的窗口。
 *
 * @module scnet-product
 */

/**
 * 兜底模型条目：客户端目录 / 网关目录都拿不到元数据时使用。
 */
export interface ScnetFallbackModel {
  /** 模型 id（SCNet 网关区分大小写：`SCNet-Max`）。 */
  id: string
  /** 展示名（带「免费」标记，与其余渠道的「倍率拼进 name」同一约定）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 最大输出 token。 */
  maxTokens: number
  /**
   * 可选思考档位。
   *
   * 网关接受 `none/low/medium/high/xhigh/max`（外加 `minimal`），并且 `none`
   * 实测让 reasoning token 归零 —— 是**真关闭**而不是摆设。DSH 的七档与上游
   * 七档一一对应，故这里原样列出、不做折叠。
   */
  efforts?: readonly string[]
  /** 默认档位。 */
  defaultEffort?: string
  /** 是否声明接受图片输入（SCNet 网关实测支持视觉输入）。 */
  supportsImage?: boolean
}

/** SCNet 产品配置。 */
export interface ScnetProduct {
  /**
   * 渠道 id（同时是 ctx.llm 路由名、账号池 provider 字段、凭据 ref 前缀）。
   *
   * ⚠️ **不能叫 `scnet`**：独立插件 `dsh-scnet-connect` 用的正是这个路由名，
   * 而它在 profile 的 bundle 顺序里排在 OFM 之前 —— 同一个 llm 路由重复注册时
   * OFM 会被判「已注册」静默跳过（`registerAdapterIdempotent`），表现为
   * 「登录成功、账号也在，但模型选择器里只有另一个插件的 SCNet-Max」。
   * 故本渠道用 `scnet-ofm`，两者可以并存。
   */
  readonly id: 'scnet-ofm'
  /** 模型选择器里的分组名。 */
  readonly displayName: string
  /** 平台根地址（登录 / Cookie / acx 接口）。 */
  readonly platformBase: string
  /** 模型网关根地址（OpenAI 兼容）。 */
  readonly apiBase: string
  /** 登录成功后平台回跳用的 service（发码与提交必须一致）。 */
  readonly loginService: string
  /** 平台网页登录页（用户可在自己浏览器里打开）。 */
  readonly loginPageUrl: string
  /** 单凭据回退 ref 名（账号池为空时的兜底）。 */
  readonly defaultCredentialRef: string
  /** 兜底模型表。 */
  readonly fallbackModels: readonly ScnetFallbackModel[]
}

/**
 * 兜底模型表。
 *
 * 只放 `SCNet-Max`：它是平台当前唯一 `priceLabel=free` 的模型，也是本渠道
 * 的默认模型。其余模型由网关 `GET /models` 实时下发（拿不到元数据时按本表的
 * 能力字段归一，见 `scnet-adapter.ts` 的 `normalizeRemoteModels`）。
 */
export const SCNET_FALLBACK_MODELS: readonly ScnetFallbackModel[] = [
  {
    id: 'SCNet-Max',
    name: 'SCNet-Max · 免费',
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    efforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'high',
    supportsImage: true,
  },
]

/** 本渠道的默认模型 id。 */
export const SCNET_DEFAULT_MODEL_ID = SCNET_FALLBACK_MODELS[0]!.id

/** SCNet 产品常量。 */
export const SCNET: ScnetProduct = Object.freeze({
  id: 'scnet-ofm' as const,
  displayName: 'SCNet（超算互联网）',
  platformBase: 'https://www.scnet.cn',
  apiBase: 'https://api.scnet.cn/api/llm/v1',
  loginService: 'https://www.scnet.cn/ac/api/auth/loginSsoRedirect.action',
  loginPageUrl: 'https://www.scnet.cn/ui/acm/index.html#/login',
  defaultCredentialRef: 'SCNET_ACCESS_TOKEN',
  fallbackModels: SCNET_FALLBACK_MODELS,
})

/** 全部 SCNet 产品（与其余渠道保持同一形状，便于将来扩展中国版）。 */
export const ALL_SCNET_PRODUCTS: readonly ScnetProduct[] = [SCNET]

/** 按 id 取产品；未知 id 返回 `undefined`。 */
export function scnetProductById(id: string): ScnetProduct | undefined {
  return ALL_SCNET_PRODUCTS.find((product) => product.id === id)
}
