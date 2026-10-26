/**
 * Raccoon Work（商汤小浣熊）产品配置。
 *
 * ## 为什么新建 `RaccoonProduct` 而不复用既有类型
 *
 * ## 数据来源
 *
 * - API 基址与各前缀：`app.asar` 的 `.env.electron`
 * - 手机号加密密钥：渲染层模块 68284 的 `yv(e, t = "senseraccoon2023")`
 * - 阿里云验证码：渲染层模块 37907 的 `q3`（SceneId）/ `$j`（prefix）
 * - 兜底模型表：2026-09-26 用本机登录态实测
 *   `GET /api/web/llm/v2/model_catalog` 取 `visible:true` 的 6 条
 */

import { RACCOON_API_BASE, RACCOON_PHONE_CIPHER_SECRET } from './raccoon.js'
import { RACCOON_REQUEST_IMAGE_MAX_BYTES } from './image-budget.js'

/**
 * 思考档位：小浣熊**只有两态（开 / 关）**，这是实测确证的。
 *
 * ## ⚠️ 为什么是「开 / 关」而不是「high / 关闭」
 *
 * 服务端**接受** `reasoning_effort`（8 个枚举值，报错原文：
 * ``expected one of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `ultra`, `max` ``），
 * 但它**不产生任何可观测效果** —— 8 轮配对实验（`temperature=0`）：
 *
 * | 档位 | `reasoning_tokens` 均值 |
 * |---|---|
 * | `minimal` | 197 |
 * | `max` | 226 |
 *
 * 逐轮配对差值 `max - minimal`：**正差 4 次 / 负差 4 次**（纯随机）。
 * 4 轮小样本时曾观察到「单调趋势」（175→288），8 轮后消失 —— 那是巧合。
 * 且 `none` 均值 301 ≠ `disabled` 的 0，说明**它也不控制思考开关**。
 *
 * ⇒ `reasoning_effort` 只是被 JSON schema 接受，不影响行为。
 *
 * ## 唯一有效通道：`extra_body.thinking.type`
 *
 * 报错原文：``thinking.type: expected one of `adaptive`, `enabled`, `disabled` ``。
 * 实测（每组 6~8 次，判据为服务端上报的 `reasoning_tokens`）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | 基线（不发参数） | 均值 **222**，6/6 有思考 |
 * | `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** → ✅ 真关闭 |
 * | `extra_body.thinking={type:'enabled'}` | 均值 **218** → ✅ 与默认等价 |
 *
 * 故我们**只暴露这两态**：开（enabled）与关（disabled）。
 *
 * ## ⚠️ 无效的写法（都实测过，别照着试）
 *
 * | 写法 | 结果 |
 * |---|---|
 * | `extra_body.enable_thinking=false` | ❌ 无效 |
 * | `extra_body.extra_body.enable_thinking=false`（双层） | ❌ 无效 |
 * | `reasoning_effort`（单层/双层/顶层） | ❌ 被接受但**无效果**（见上） |
 * | `thinking` 放**顶层**（不在 `extra_body` 内） | ❌ 被忽略（非法值也不报错） |
 * | `thinking.budget_tokens` | ⚠️ 仅被**格式校验**（`max_tokens < budget_tokens` 回 400），1~4096 全接受但思考量无规律 |
 *
 * ⚠️ 客户端注释说 `extra_body` 双层嵌套是 **LiteLLM SDK 的调用约定**
 *（"LiteLLM expects another provider-owned extra_body object inside that body"）——
 * 但实测**单层才生效**，故以实测为准。
 */

/**
 * 档位 id：**开启**思考（`thinking:{type:'enabled'}`）。
 *
 * ⚠️ id 用 `on` 而不是 `high`：服务端虽接受 `high` 字样，但它走的是
 * `reasoning_effort` 通道、**实测无效果**。用 `on` 避免让用户误以为
 * 「选的是高强度档」—— 我们能表达的只有「开 / 关」。
 */
export const RACCOON_EFFORT_ON = 'on'

/** 档位 id：**关闭**思考（`thinking:{type:'disabled'}`）。 */
export const RACCOON_EFFORT_OFF = 'off'

/**
 * 档位展示名（DSH 直接渲染 `efforts[].name`，不本地化）。
 *
 * ⚠️ 用「开启 / 关闭」而非「深度思考 / 关闭思考」（用户 2026-09-28 要求：
 * 「现在开启档位显示的深度思考，就显示开启就行了」）。
 *
 * 理由是**如实**：我们能表达的只有「思考开 / 关」这一个布尔维度，
 * 没有任何强度档位（`reasoning_effort` 实测无效）。叫「深度思考」会让用户
 * 以为存在「浅度思考」之类的其他档位可选，而实际上没有。
 */
export const RACCOON_EFFORT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  [RACCOON_EFFORT_ON]: '开启',
  [RACCOON_EFFORT_OFF]: '关闭',
})

/**
 * 该模型可选的思考档位（按展示顺序）。
 *
 * ⚠️ **所有 6 个可见模型都返回这两档** —— 实测 `extra_body.thinking` 是
 * **provider 级方言**，与模型无关（`thinking.type` 的枚举在服务端全局一致）。
 * 故不做 per-model 分派（那会是凭空猜测）。
 */
export const RACCOON_REASONING_EFFORTS: readonly string[] = Object.freeze([
  RACCOON_EFFORT_ON,
  RACCOON_EFFORT_OFF,
])

/**
 * 默认档位 = `on`。
 *
 * 依据：实测「不发参数」与「显式 `{type:'enabled'}`」的思考量**等价**
 *（均值 222 vs 218），即**服务端默认就是开启**。故默认标成 `on`
 * 是**如实描述**，不是我们强行改变行为。
 */
export const RACCOON_DEFAULT_EFFORT = RACCOON_EFFORT_ON

/**
 * 兜底模型目录中的一个条目。
 */
export interface RaccoonFallbackModel {
  /** 模型 ID（传给 `chat/completions` 的 `model`）。 */
  id: string
  /** **已规范化**的展示名（含倍率，` · ` 分隔；免费显示「免费」）。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限（远端 `params.max_tokens`）。 */
  maxTokens: number
  /** 是否支持图片输入（远端 `tags` 含 `vision`）。 */
  supportsImage: boolean
}

/** Raccoon Work 产品配置。 */
export interface RaccoonProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'raccoon'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** API 基址。 */
  apiBase: string
  /** 认证端点前缀。 */
  authApiPrefix: string
  /** 推理与模型目录前缀。 */
  llmApiPrefix: string
  /** 积分端点前缀。 */
  pointsApiPrefix: string
  /** 桌面端端点前缀。 */
  desktopApiPrefix: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9 的 raccoon 变体）。
   */
  imagePixelBudget?: number
  /**
   * 单张请求图片的**编码字节目标**（base64 展开前）。
   *
   * 取 **512 KB**：base64 膨胀 4/3 → 每张约占 683 KB，
   * 10 MB 的配额可放约 **14 张**（原图只能放 2 张）。
   * ⚠️ 这是"每张固定预算"路线的固有上限：图再多仍会 413。
   * 按张数分摊总配额会把每张压到 600×400 以下、UI 小字直接糊掉，
   * 权衡后选择「保住可辨认性 + 覆盖到 14 张」（用户 2026-09-28 定，方案 A）。
   */
  imageMaxBytes?: number
  /** User-Agent（仅记录用；实测该端点不校验 UA）。 */
  userAgent: string
  /**
   * 客户端平台标识。
   *
   * ⚠️ 取值必须是 `desktop-windows` / `desktop-macos` / `desktop-linux`
   * —— 依据主进程 `desktopDeviceIdentity.js` 的 `resolveDesktopClientPlatform`
   * （`win32` → `desktop-windows`）。`desktop/v1/login/points/grant`
   * **要求**该头，猜错会被拒。
   */
  clientPlatform: string
  /** 客户端版本（带 `v` 前缀，如 `v1.0.35`）。 */
  clientVersion: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /** 手机号传输层加密密钥（见 `raccoon.ts` 的说明：公开常量，非安全边界）。 */
  phoneCipherSecret: string
  /** 阿里云滑块验证码配置（短信登录必需）。 */
  aliyunCaptcha: { sceneId: string; prefix: string }
  /** 远端模型列表不可用时的兜底目录（6 个可见模型）。 */
  fallbackModels: readonly RaccoonFallbackModel[]
}

/**
 * 兜底模型目录（6 个 `visible:true` 模型）。
 *
 * 来源：2026-09-26 实测 `GET /api/web/llm/v2/model_catalog`。
 * 顺序**照抄远端返回顺序**，不重排 —— 重排会让「与远端对比」这类排查失去可比性。
 *
 * ⚠️ 展示名由 `raccoonDisplayName` 的输出形态固化（` · x倍率` / ` · 免费` /
 * ` · x原价→x折后价`），与远端 `billing_effective_multiplier` 逐条对应：
 *
 * | id | 原价 | 生效价 | 展示 |
 * |---|---|---|---|
 * | `sn-sensenova-6-8-flash` | 0.5 | 0 | 免费 |
 * | `sn-sensenova-6-8-flash-lite` | 0.5 | 0 | 免费 |
 * | `sn-glm-5-3` | 0.75 | 0.75 | x0.75 |
 * | `sn-kimi-k3` | 1 | 1 | x1 |
 * | `sn-glm-5-3-flash` | 0.2 | 0.1 | x0.2→x0.1 |
 * | `sn-deepseek-v4-1-flash` | 0.25 | 0.25 | x0.25 |
 *
 * ⚠️ **不含** `Raccoon-Auto`：它是客户端 i18n 条目（`modelPicker.auto`）渲染的
 * 「自动选模」入口，不是远端模型 —— 直接发给 `chat/completions` 会 404。
 * ⚠️ 也不含 3 个 `visible:false` 的 `raccoon-*` 内部模型。
 */
const RACCOON_FALLBACK_MODELS: readonly RaccoonFallbackModel[] = [
  {
    id: 'sn-sensenova-6-8-flash',
    name: 'SenseNova-6.8-Flash · 免费',
    contextWindow: 256_000,
    maxTokens: 63_999,
    supportsImage: true,
  },
  {
    id: 'sn-sensenova-6-8-flash-lite',
    name: 'SenseNova-6.8-Flash-Lite · 免费',
    contextWindow: 256_000,
    maxTokens: 63_999,
    supportsImage: true,
  },
  {
    id: 'sn-glm-5-3',
    name: 'GLM-5-3 · x0.75',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    supportsImage: true,
  },
  {
    id: 'sn-kimi-k3',
    // ⚠️ 1 倍也要显示（用户报障「为什么 Kimi-K3 没有倍率，ide 是 1 倍，
    // 1 倍也要显示倍率」）—— 见 `raccoonDisplayName` 的注释。
    name: 'Kimi-K3 · x1',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    supportsImage: true,
  },
  {
    id: 'sn-glm-5-3-flash',
    name: 'GLM-5-3-Flash · x0.2→x0.1',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    // ⚠️ 远端 tags 不含 `vision`，但**实测能看图**（见 RACCOON_IMAGE_CAPABILITY_OVERRIDES）。
    supportsImage: true,
  },
  {
    id: 'sn-deepseek-v4-1-flash',
    name: 'DeepSeek-V4.1-Flash · x0.25',
    contextWindow: 1_000_000,
    maxTokens: 100_000,
    // ⚠️ 同上：远端 tags 不含 `vision`，实测 5/5 读对随机数字。
    supportsImage: true,
  },
]

/**
 * 远端 `tags` 缺 `vision`、但**实测能看图**的模型。
 *
 * ## ⚠️ 为什么需要它：`tags` 不是能力契约（真实缺陷，用户 2026-10-03 报障）
 *
 * 症状：给 `sn-deepseek-v4-1-flash` 发图，模型回「无法读取图片 / 不支持图片」。
 *
 * ### 根因链
 *
 * 1. 我们把「远端 `tags` 含 `vision`」当成了服务端能力声明；
 * 2. `sn-deepseek-v4-1-flash` 的 `tags` 是
 *    `["general","code","html","analysis","reasoning","auto"]` —— **没有** `vision`
 *    （`display_description` 也只写「通用对话、代码开发、复杂分析」，不提图像识别）；
 * 3. ⇒ `inputModalities` 播报 `['text']`；
 * 4. ⇒ **DSH 在 `LlmRuntime` 里把图片替换成文本占位符**
 *    （`dsh-llm/lib/index.js` 的 `projectImagesForTextModel`，产出
 *    `[image omitted because this model accepts text only; attachment sha256:…]`）
 *    —— **图片根本没发出去**；
 * 5. ⇒ 用户看到模型说「读不到图片」，而端点其实完全正常。
 *
 * ### 决定性证据：带图实测 6/6 全部读对
 *
 * 同一张「随机 6 位数字」图（模型无法猜）打 `POST /api/web/llm/v2/chat/completions`：
 *
 * | 模型 | 远端 tags 含 vision | 实测读图 |
 * |---|---|---|
 * | `sn-deepseek-v4-1-flash` | ❌ | ✅ **5/5**（208063/942977/999889/123015/478368） |
 * | `sn-glm-5-3-flash` | ❌ | ✅ 1/1 |
 * | `sn-sensenova-6-8-flash` | ✅ | ✅ 2/2 |
 * | `sn-sensenova-6-8-flash-lite` | ✅ | ✅ 1/1 |
 * | `sn-kimi-k3` | ✅ | ✅ 1/1 |
 * | `sn-glm-5-3` | ✅ | ⚠️ 1/3（**provider 侧节点不一致**，见下） |
 *
 * ### 为什么不能指望远端补字段
 *
 * 已穷举 9 个条目的**键并集**：顶层 14 个键、`params` **只有** `context_window`
 * 与 `max_tokens`。用 `/modal|vision|image|img|multimodal|media|type|capab|support|input|output/i`
 * 扫描，**命中 0 个**。⇒ 远端**从未下发**模态字段，`tags` 是唯一信号，而它被证伪。
 *
 * `tags` 的真实用途是**客户端「Raccoon-Auto 选模」的偏好标签**
 * （`TASK_TAG_PATTERNS` 给消息打 vision 标记后，挑一个带 `vision` 的模型）——
 * 它回答的是「该模型适不适合处理这类任务」，**不是**「能不能吃图」。
 *
 * ### 为什么用显式白名单，而不是「恒 true」
 *
 * ### ⚠️ 顺带发现：`sn-glm-5-3` 节点不一致（provider 侧缺陷，不归我们）
 *
 * 它 3 次里只对 1 次，两次回「当前模型不支持图片或视频输入」。错误体暴露网关有
 * 3 个 fallback 组（`raccoon-4eb26a` / `raccoon-0c119c` / `raccoon-ecc5fd`），
 * **部分节点是纯文本的**。它本来就带 `vision` 标签、我们一直在发图，
 * **本次修复不改变它的行为**，故按「已知 provider 缺陷」记录而不特殊处理。
 */
export const RACCOON_IMAGE_CAPABILITY_OVERRIDES: ReadonlySet<string> = new Set([
  'sn-deepseek-v4-1-flash',
  'sn-glm-5-3-flash',
])

/**
 * 远端目录条目的图片能力判定 —— **远端解析路径专用**。
 *
 * ⚠️ 兜底表路径（`fallbackToRemote`）不走本函数：它的真相源是
 * `RACCOON_FALLBACK_MODELS[].supportsImage`（已按同一批实测证据修正为 `true`）。
 * 两个真相源由 `tests/unit/raccoon-product.spec.ts` 的
 * 「兜底表与远端判定必须一致」一条锁死 —— **别让它们悄悄分叉**。
 *
 * @param modelId 模型 id。
 * @param tags 远端 `tags`（`normalizeRemoteModel` 已小写化；无标签时传空数组）。
 */
export function raccoonSupportsImage(modelId: string, tags: readonly string[]): boolean {
  if (RACCOON_IMAGE_CAPABILITY_OVERRIDES.has(modelId)) return true
  return tags.includes('vision') || tags.includes('image') || tags.includes('image-understanding')
}

/** Raccoon Work provider 配置。 */
export const RACCOON: RaccoonProduct = {
  id: 'raccoon',
  // ⚠️ 用『Raccoon (商汤)』而非『Raccoon Work (商汤)』—— 后者在 Channel Pack 的
  // provider Tab 里**触发换行**（用户报障）。客户端内的品牌名是 `Raccoon Work`，
  // 但那个词组太长；缩短成 `Raccoon` 后与其余 provider 的标签长度一致

  displayName: 'Raccoon (商汤)',
  apiBase: RACCOON_API_BASE,
  authApiPrefix: '/api/web/auth/v1',
  llmApiPrefix: '/api/web/llm/v2',
  pointsApiPrefix: '/api/web/points/v1',
  desktopApiPrefix: '/api/web/desktop/v1',
  userAgent: 'Raccoon Work/1.0.35 (Windows)',
  clientPlatform: 'desktop-windows',
  clientVersion: 'v1.0.35',
  defaultCredentialRef: 'RACCOON_ACCESS_TOKEN',
  // 实测该网关按**请求体字节**卡（`HTTP_413: request body exceeds 10MB`），
  // 所以字节目标是主约束；像素预算保证图不至于大到压不进那个字节目标。
  imagePixelBudget: 640_000,
  imageMaxBytes: RACCOON_REQUEST_IMAGE_MAX_BYTES,
  phoneCipherSecret: RACCOON_PHONE_CIPHER_SECRET,
  aliyunCaptcha: { sceneId: '1pkmy0x3', prefix: 'hk1r5l' },
  fallbackModels: RACCOON_FALLBACK_MODELS,
}

/** 全部 Raccoon 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_RACCOON_PRODUCTS: readonly RaccoonProduct[] = [RACCOON]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 */
export function raccoonProductById(id: string): RaccoonProduct | undefined {
  return ALL_RACCOON_PRODUCTS.find((product) => product.id === id)
}
