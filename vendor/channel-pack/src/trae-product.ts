/**
 * TRAE（字节跳动 TRAE IDE）产品配置。
 *
 * ## 数据来源
 *
 * 基于对 `E:\Workplace\APP\Golang\trae2api` 的逆向分析（2026-08），
 * 以及上游项目 `Sliverkiss/traework2api` 的实测结果。
 *
 * - API 端点：`trae2api/internal/upstream/constants.go`（实测可用的 SOLO 免费通道）；
 * - 客户端常量：同一文件，版本号 `0.1.52` / `20260811` 为实测可获取 glm-5.3 的最低版本；
 * - 兜底模型表：`trae2api/internal/server/handler.go:247-280` 的 staticModels；
 * - 登录 URL 格式：`trae2api/internal/server/login.go` 的 `BuildLoginURL`。
 *
 * 因此这里定义**平行**的 `TraeProduct`：共用的是架构模式（产品差异收敛到单一真相源），
 * 不是那个类型。
 */

/**
 * 兜底模型目录中的一个条目（对齐 Go 端 staticModels 格式）。
 *
 * 数据来源：`handler.go:247-280`（2026-08 实测快照）。
 * 远端 `batch_get_detail_param` 拉取失败时用此表回退。
 *
 * ⚠️ **数值是估值**（采信实测主流值 `contextWindow=200000`），远端可用时
 * **完全采信远端**的 `context_window_tokens` 与 `max_tokens`。旧的 `131072` /
 * `maxOutputTokens: 128000` 是 2026-08 的估值，已被实测推翻（见 `AGENTS.md`）。
 */
export interface TraeFallbackModel {
  id: string
  name: string
  contextWindow: number
  /** 已知的上游内部/隐藏条目（远端不可用时也不该出现在目录里）。 */
  isHidden?: boolean
}

/**
 * TRAE 产品配置。
 */
export interface TraeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'trae'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 上游 API 基址（Agent 服务：对话 + 模型列表）。 */
  agentHost: string
  /** 签到/积分/Ug 基址。 */
  ugHost: string
  /** OAuth/认证基址（ExchangeToken / GetUserInfo）。 */
  oauthHost: string
  /** 登录门户基址。 */
  consoleHost: string
  /** 客户端 ID（OAuth2 的 client_id）。 */
  clientId: string
  /** App ID（请求头 X-App-Id）。 */
  appId: string
  /**
   * IDE 版本号（控制模型可用性：0.1.52 才能用 glm-5.3）。
   *
   * 版本号是「模型可用的准入条件」—— 上游按 `X-Ide-Version` / `X-App-Version-Code`
   * 决定哪些模型可以返回，版本过低时 glm-5.3 等新模型会报 `4001 param is invalid`。
   */
  ideVersion: string
  /** IDE 版本号代码（日期式，如 `20260811`）。 */
  ideVersionCode: string
  /** 设备品牌（请求头 X-Device-Brand）。 */
  deviceBrand: string
  /** 操作系统版本（请求头 X-OS-Version）。 */
  osVersion: string
  /**
   * **默认**对话通道（`function`），模型未标明所属通道时使用。
   *
   * ⚠️ 它不是「唯一的通道」——各通道模型集不同，真正的通道归属由远端目录
   * 的每条 `function` 决定（见 {@link channels}）。
   */
  function: string
  /**
   * **可调用通道白名单**，**顺序即优先级**。
   *
   * 真实 CN IDE 用 `batch_get_detail_param` 一次查 22 个 function，每个
   * function 各自一套模型目录；同一条目在不同通道的可用性（`is_custom_model`
   * / `is_invisible_to_user` / `config_switch`）**可以不同**，而且
   * **模型只在列出它的通道里可调用**（发错通道 → 流内错误码）。
   *
   * ⚠️ **本表是白名单，不只是排序表**（Issue IKJOZ7）：上游下发的 22 个
   * function 里，**只有一部分**在本插件的推理端点
   * （`/api/agent/v3/llm_utils_chat`）下真正可调用。此前实现让 `parseTraeBatchModelList`
   * 「目录声明了什么通道就照着发什么通道」，于是 38 条目录里有 **19 条（50%）**
   * 带着不可调用的 `function`（`chat` / `builder` / `inline_chat` / `git_ai` …），
   * 用户一选中就稳定失败 —— 而报错文案（`the model is unknown` /
   * `param is invalid`）指向**模型**，极易误判成「这个模型坏了」。
   *
   * 逐通道实测（2026-10-04，真实凭据，每个 function 各发一次最小请求；
   * 脚本 `scripts/probe-trae-channel-callable.mjs`）：
   *
   * | 结果 | function |
   * |---|---|
   * | ✅ 可调用（**本表内容，15 个**） | `solo_agent` / `solo_work_lite` / `solo_agent_remote` / `solo_work_remote` / `solo_agent_lite` / `solo_design_lite` / `solo_design_remote` / `solo_coder` / `chat_v3` / `builder_v3` / `git_ai` / `code_reviewer` / `code_review_summary` / `multimodal` / `system_diagnosis` |
   * | ❌ 稳定被拒 | `chat`（`code=4023 the model is unknown`）/ `builder`（`4001 param is invalid`）/ `inline_chat`（`3003 model service is unavailable`） |
   * | ⚪️ 目录恒空 | `ui_builder_v2` / `solo_builder` / `custom_agent_generation` / `utils` |
   *
   * ⚠️ 与 issue 原文的两处差异（都以上表实测为准，别照抄 issue 的推测）：
   * - **`chat_v3` 是可调用的**，不要与 `chat` 混为一谈（issue 把二者并列怀疑）；
   * - **`solo_coder` 首测超时、复测 4/4 成功** ⇒ 归为可调用；其独有模型
   *   （`minimax-m2.7` 等）因此得以保留。
   *
   * ⚠️ **顺序即优先级**：同一模型被多个白名单通道列出时，取更靠前者
   * （见 `parseTraeBatchModelList` 的规则 2）。`solo_agent` 排首位是对齐官方
   * Auto Mode 选择器；`solo_work_lite` 紧随其后以保既有模型的通道尽量不变。
   * 专用通道（`multimodal` / `git_ai` / `code_reviewer` …）排末尾：只有当某个
   * 模型**不在**任何通用通道里时，才会落到它们上面（如
   * `multimodal_image_kimi-k2.5`）。
   *
   * 可用 `DSH_TRAE_CHANNELS`（逗号分隔）覆盖以试验其它通道 —— ⚠️ 覆盖的是
   * **整张白名单**，写错即过滤掉全部模型（这是有意的：宁可空目录，也不要
   * 再让不可调用的通道流出去）。
   */
  channels: readonly string[]
  /**
   * 远端不可用时的兜底输出上限（`max_tokens`）。
   *
   * 实测主流模型在远端声明的即为此值；远端可用时**以远端为准**。
   * 不放进 `fallbackModels` 逐条声明是因为各模型真实值并不一致
   * （4000 ~ 384000），逐条填只会编造出更细的假数据。
   */
  fallbackMaxOutputTokens?: number
  /**
   * 是否启用 **Max 模式**（1M 上下文）。**默认开启**，显式设 `DSH_TRAE_MAX_MODE=0` 关闭。
   *
   * 默认开的原因（用户要求）：上下文应当用**最大的那一档**。开启后只有远端
   * `display_config.max_mode === true` 的模型才会走 1M —— 未标记的模型即便
   * 开关为开也仍走常规 `dev`(200K)，见 `TraeAdapter.maxModeFor`，所以开启
   * 不会让任何模型失败。
   *
   * ⚠️ Max 会话向 1M 窗口里塞入远超常规的上下文，**计费倍率与常规会话不同**
   * （远端按 `strategy=max` 单独计价）。需要省额度时设 `DSH_TRAE_MAX_MODE=0`。
   *
   * 与 `Trae2api-cn` 的 `TRAE_REMOTE_MAX_MODE` 同名（但那边默认 `0`，本插件
   * 按用户要求改为默认开）。
   */
  maxMode?: boolean
  /**
   * Max 模式白名单（逗号分隔，`DSH_TRAE_MAX_MODELS`）。留空 = 所有
   * `max_mode=true` 的模型都生效；含 `*` 亦表示全部。
   *
   * 对齐 `Trae2api-cn` 的 `TRAE_REMOTE_MAX_MODELS`。
   */
  maxModeModels?: readonly string[]
  /**
   * @deprecated **不再生效**。`is_invisible_to_user` 过滤已移至
   * `parseTraeBatchModelList` 作为硬性过滤执行，不再由本开关控制。保留字段
   * 仅为避免破坏现有 profile 配置中显式设置了该值的用户。
   */
  hideInternalModels?: boolean
  /**
   * 登录 URL 的 `plugin_version` 参数（**不是** IDE 版本号）。
   *
   * 实测值 `2.3.62834`（`login.sh:54`）—— 与 `ideVersion` 是两个独立字段：
   * 前者是登录门户认的插件版本，后者是 chat 端点的模型准入版本。
   */
  pluginVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** User-Agent。 */
  userAgent: string
  /** 远端模型列表不可用时的兜底模型目录。 */
  fallbackModels: readonly TraeFallbackModel[]
}

/** 上游 API 基址（Agent 服务）。 */
export const TRAE_AGENT_HOST = 'https://trae-api-cn.mchost.guru'
/** 签到/积分/Ug 基址。 */
export const TRAE_UG_HOST = 'https://api.trae.cn'
/** OAuth/认证基址。 */
export const TRAE_OAUTH_HOST = 'https://api.trae.com.cn'
/** 登录门户基址。 */
export const TRAE_CONSOLE_HOST = 'https://www.trae.cn'

/**
 * 兜底模型目录（32 个，对齐 Go 端 staticModels）。
 *
 * 来源：`handler.go:247-280`，2026-08 实测快照。
 * 顺序照抄 Go 端，不重排。远端可用时完全采信远端，本表只在远端整体失败时顶替。
 */
const TRAE_FALLBACK_MODELS: readonly TraeFallbackModel[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek V4 Flash Official', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Pro', name: 'Doubao Seed 2.1 Pro', contextWindow: 200_000 },
  { id: 'seed-code-pro-0430', name: 'Seed Code Pro 0430', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.1-Turbo', name: 'Doubao Seed 2.1 Turbo', contextWindow: 200_000 },
  { id: 'Doubao-Seed-2.0-Code', name: 'Doubao Seed 2.0 Code', contextWindow: 200_000 },
  { id: 'browser_use_subagent', name: 'Browser Use Subagent', contextWindow: 200_000, isHidden: true },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'glm-5-turbo', name: 'GLM-5 Turbo', contextWindow: 200_000 },
  { id: 'glm-5', name: 'GLM-5', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Flash', name: 'DeepSeek V4 Flash', contextWindow: 200_000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200_000 },
  { id: 'kimi-k2.7-code', name: 'Kimi K2.7 Code', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi K2.6', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax M3', contextWindow: 200_000 },
  { id: 'qwen-3.7-plus', name: 'Qwen 3.7 Plus', contextWindow: 200_000 },
  { id: 'sagitta', name: 'Sagitta', contextWindow: 200_000 },
  { id: 'aquila', name: 'Aquila', contextWindow: 200_000 },
  { id: 'custom_model_gemini', name: 'Custom Gemini', contextWindow: 200_000 },
  { id: 'custom_model_placeholder', name: 'Custom Placeholder', contextWindow: 200_000 },
  { id: 'custom_model_1M_text', name: 'Custom 1M Text', contextWindow: 200_000 },
  { id: 'custom_model_1M', name: 'Custom 1M', contextWindow: 200_000 },
  { id: 'custom_model_kimi', name: 'Custom Kimi', contextWindow: 200_000 },
  { id: 'custom_model_claude', name: 'Custom Claude', contextWindow: 200_000 },
  { id: 'custom_model_gpt-5', name: 'Custom GPT-5', contextWindow: 200_000 },
  { id: 'custom_model_no-fc', name: 'Custom No-FC', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_chat', name: 'Custom DeepSeek Chat', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_reasoner', name: 'Custom DeepSeek Reasoner', contextWindow: 200_000 },
  { id: 'custom_model_deepseek_v4', name: 'Custom DeepSeek V4', contextWindow: 200_000 },
  { id: 'explore_sub_agent_v13', name: 'Explore Sub Agent V13', contextWindow: 200_000, isHidden: true },
  { id: 'explore_sub_agent_v2', name: 'Explore Sub Agent V2', contextWindow: 200_000, isHidden: true },
  { id: 'summary', name: 'Summary', contextWindow: 200_000, isHidden: true },
]

/**
 * **可调用通道白名单**（顺序即优先级，详见 `TraeProduct.channels` 的注释）。
 *
 * 内容来自逐通道实测（2026-10-04）：只放行在
 * `/api/agent/v3/llm_utils_chat` 下真正可调用的 15 个 function。
 * `chat` / `builder` / `inline_chat` 实测稳定被拒，**不得**放入；
 * `ui_builder_v2` / `solo_builder` / `custom_agent_generation` / `utils`
 * 目录恒空，放进来也无意义。
 *
 * 前三条是通用通道（官方 Auto Mode 用的就是它们），其余为专用通道：
 * - `solo_agent`：**首位**，对应 Auto Mode 的模型列表，包含最多的模型
 *   （实测 18 条）与 `display_contact_config` / `reasoning_effort_config`。
 * - `solo_work_lite`：本项目既有通道。⚠️ 历史注释说 `glm-5-turbo` / `sagitta`
 *   在此可用 —— 那两个模型**已从目录下架**（2026-10-04 实测不在任何通道里），
 *   该说法是过期快照，不要据此断言。
 * - `solo_agent_remote`：补上 agent 专有模型（`glm-5.1` / `kimi-k2.7-code` 等）。
 *
 * 可用 `DSH_TRAE_CHANNELS`（逗号分隔）覆盖。
 */
export const TRAE_CHANNELS: readonly string[] = resolveChannelList(
  process.env.DSH_TRAE_CHANNELS,
)

/** 解析 `DSH_TRAE_CHANNELS`；空/非法时回退默认通道列表。 */
function resolveChannelList(raw: string | undefined): readonly string[] {
  const fallback: readonly string[] = [
    // ── 通用通道（顺序即优先级）──
    'solo_agent',
    'solo_work_lite',
    'solo_agent_remote',
    'solo_work_remote',
    'solo_agent_lite',
    // ── 专用通道（只有通用通道都不含某模型时才会命中）──
    'chat_v3',
    'builder_v3',
    'solo_coder',
    'solo_design_lite',
    'solo_design_remote',
    'git_ai',
    'code_reviewer',
    'code_review_summary',
    'multimodal',
    'system_diagnosis',
  ]
  if (raw === undefined) return fallback
  const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return parsed.length > 0 ? parsed : fallback
}

/** 解析布尔型开关环境变量；只有显式真值才算开启。 */
function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false
  const value = raw.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

/**
 * 解析 `DSH_TRAE_MAX_MODE`；**默认开启**（用户要求「上下文用最大的那一档」）。
 *
 * 只有显式假值（`0` / `false` / `no` / `off`）才关闭 —— 与
 * `isTruthyFlag` 的「默认关」语义相反，故单列一个函数，不要混用。
 */
function resolveMaxModeFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true
  const value = raw.trim().toLowerCase()
  return !(value === '0' || value === 'false' || value === 'no' || value === 'off')
}

/**
 * 解析 `DSH_TRAE_MAX_MODELS` 白名单。
 *
 * 留空返回 `undefined`（而非空数组）：空数组在下游是「白名单存在但什么都不匹配」
 * 的语义，会把 Max 模式**全部**关掉，与「留空 = 全部生效」相反。
 */
function resolveMaxModeModels(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined
  const parsed = raw.split(',').map((item) => item.trim()).filter((item) => item.length > 0)
  return parsed.length > 0 ? parsed : undefined
}

/**
 * TRAE provider 配置。
 */
export const TRAE: TraeProduct = {
  id: 'trae',
  displayName: 'TRAE (字节)',
  agentHost: TRAE_AGENT_HOST,
  ugHost: TRAE_UG_HOST,
  oauthHost: TRAE_OAUTH_HOST,
  consoleHost: TRAE_CONSOLE_HOST,
  clientId: 'en1oxy7wnw8j9n',
  appId: '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
  ideVersion: '0.1.52',
  ideVersionCode: '20260811',
  deviceBrand: 'Apple',
  osVersion: 'macOS 15.7.4',
  function: 'solo_work_lite',
  channels: TRAE_CHANNELS,
  fallbackMaxOutputTokens: 32_000,
  maxMode: resolveMaxModeFlag(process.env.DSH_TRAE_MAX_MODE),
  maxModeModels: resolveMaxModeModels(process.env.DSH_TRAE_MAX_MODELS),
  hideInternalModels: isTruthyFlag(process.env.DSH_TRAE_HIDE_INTERNAL),
  pluginVersion: '2.3.62834',
  defaultCredentialRef: 'TRAE_ACCESS_TOKEN',
  userAgent: 'Trae/0.1.52',
  fallbackModels: TRAE_FALLBACK_MODELS,
}
