/**
 * ZCode（智谱 z.ai 免费额度）产品配置。
 *
 * ## 为什么新建 `ZcodeProduct` 而不复用既有类型
 *
 * ## 数据来源（全部实测，非推测）
 *
 * - 模型池：`GET /api/v1/client/configs` 的 `offPeak.allowed_models`
 *   与 `startPlanPreview.entitlements`；另经真实推理验证。
 * - 上游清单里有 4 个（`GLM-5-Turbo` / `GLM-5.2` / `GLM-5.3` /
 *   `GLM-5.3-Flash`），但**前两个在 Start Plan 下返回空响应**
 *   （实测 0/3 正确，而 GLM-5.3 是 3/3），故**只暴露后两个**
 *   —— 列一个用不了的模型比不列更糟。
 * - `GLM-5.3-Flash` 实测可用（本机账号 1 亿 token 额度，端到端 200）。
 */

import type { ZcodeCredential } from './zcode.js'
import { ZCODE_APP_VERSION_FALLBACK } from './zcode.js'

/** 兜底模型目录中的一个条目。 */
export interface ZcodeFallbackModel {
  /** 模型 ID（传给上游 `model` 字段）。 */
  id: string
  /** 展示名。 */
  name: string
  /** 上下文窗口。 */
  contextWindow: number
  /** 单次输出上限。 */
  maxTokens: number
  /** 是否支持图片输入。 */
  supportsImage: boolean
  /**
   * 可选的思考档位（**按展示顺序**）。
   *
   * ⚠ 取自上游 `client/configs` 的 `builtinModels[].reasoning.levels` 的**键序**。
   * 缺省 / 空数组表示「不声明档位」—— DSH 会显示
   * 「当前模型未提供推理等级」（对应 IDE 的「不支持」）。
   */
  reasoningLevels?: readonly string[]
  /**
   * 默认档位。
   *
   * ⚠ 取自上游 `reasoning.defaultLevel`，且**必须落在 `reasoningLevels` 内** ——
   * 否则 DSH 的档位选择器会指向一个不存在的选项（qoder 那边就是这么规定的）。
   */
  defaultReasoningLevel?: string
}

/** ZCode 产品配置。 */
export interface ZcodeProduct {
  /** provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。 */
  id: 'zcode'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * **整轮墙钟**上限（毫秒）：覆盖 captcha 产出 → 请求 → 流式读取**全程**。
   *
   * ⚠⚠️ **它不是「推理超时」**（真实缺陷 IKJOVB）：早期实现把它当推理时限，
   * 于是「模型一进入长时间思考」就必然撞满 → abort → `TIMEOUT` → harness
   * 按可重试错误重试 → 又大思考 → 又撞满，形成死循环（用户报障：思考三分钟
   * 被截断，接着重试，又是雷霆大思考）。**长思考的正确保护是空闲超时**
   * （见 {@link streamIdleTimeoutMs}），不是墙钟。
   *
   * ⇒ 本值现已**只**兜「真正静默 / captcha 卡死」这条通道，
   * 故给到分钟级。⚠ 不得调回 180_000（见 {@link streamIdleTimeoutMs} 的说明）。
   */
  requestTimeoutMs: number
  /**
   * **流式读取空闲超时**（毫秒）：连续这么久**没读到任何字节**才判死，
   * **每收到一帧即重新计时**，故总时长可远超该值。
   *
   * ## 取值直接对齐官方 ZCode（权威依据，非推测）
   *
   * 官方客户端 `resources/glm/zcode.cjs` 的默认配置逐字还原：
   * ```js
   * YV = 6e5                                  // modelStream.idleTimeoutMs
   * Lm = { modelStream: { idleTimeoutMs: YV }, network: { timeout: 18e4 } }
   * ```
   * 官方**没有**保活心跳、**没有** ack 帧、也**没有**针对思考的特判 ——
   * `thinking_delta` 与普通帧走同一个 `Promise.race` 循环。
   *
   * ⚠⚠️ **别再取 180_000**：那是官方配置里**另一个**字段 `network.timeout`
   * 的值（普通 API 请求用），被早期实现误当成推理时限抄了过来。
   * 这正是 issue 里「一思考就超时」的直接成因。
   */
  streamIdleTimeoutMs: number
  /** 远端模型列表不可用时的兜底目录。 */
  fallbackModels: readonly ZcodeFallbackModel[]
  /**
   * 客户端版本（用于 `X-ZCode-App-Version` 等头）。
   *
   * ⚠ 它是**常量**，不再从已安装的官方客户端探测 ——
   * 那是「读本机 ZCode 数据」的一部分，已于 2026-10-05 整体删除
   * （见 `zcode.ts` 文件头）。版本只是一个头，不该成为硬依赖，
   * 故探测的移除不会让 provider 不可用。
   */
  appVersionFallback: string
  /**
   * 上游请求**串行闸门**：同一时刻只允许一个请求发往上游。
   *
   * 依据（`dsh-free-glm` 的实测）：上游 `429 code:3009`
   * （`model concurrency limit exceeded`）是**并发配额**，与剩余 token 无关。
   * 并发发起必然有一个白撞。
   */
  serializeUpstream: boolean
  /**
   * 按模型的最小**发车间隔**（毫秒，键为小写模型 id）。
   *
   * 串行只保证「不重叠」，不保证「有间隔」—— 相邻两次放行可能只隔几十毫秒，
   * 仍会撞并发窗口。那边的分模型实测：
   * `glm-5.3-flash` 605 次 200 / 0 次限流，而 `glm-5.3` 74 次里 21 次限流
   * ⇒ 两个模型的并发窗口**明显不同**，间隔要分别设（强加给 Flash 是纯损失）。
   */
  modelGapMs: Readonly<Record<string, number>>
  /**
   * 并发限流（`3009`）时**适配器内**的重试次数上限。
   *
   * ⚠ 与「额度类错误」的处理**完全不同**：并发限流等一下就过（重试），
   * 额度用尽要换账号（见 {@link quotaSwitchMax}）。
   */
  concurrencyRetryMax: number
  /** 并发限流重试的基础退避（毫秒，线性递增：base、2×base、…）。 */
  concurrencyRetryBaseMs: number
  /**
   * 额度类错误（`1005 exceed quota limit` / `1113 余额不足`）时
   * 最多切换几次账号。
   *
   * 取 2 = 「本账号 + 最多再试两个」，避免账号池很大时把整池都标记掉。
   */
  quotaSwitchMax: number
  /**
   * 是否给 tools 前缀打 **prompt caching 断点**。
   *
   * Anthropic 的缓存是**前缀式**的：在最后一个 tool 上打一个断点，
   * 「system + 全部 tools」整段都进缓存。不打的话，DSH 每步请求都要
   * 全量重算工具 schema 的 prefill（那边的实测：24 个工具、19492 字节）。
   */
  toolCacheBreakpoint: boolean
}

/**
 * 兜底模型目录。
 *
 * ⚠ **只放实测可用的两个**。服务端的模型清单里有 `GLM-5-Turbo` 与
 * `GLM-5.2`，但 2026-09-28 实测它们**返回空响应**（同样的三题 0/3 正确，
 * 而 GLM-5.3 是 3/3）。把不可用的模型列出来会让用户选中后收到空回复，
 * 比不列更糟。
 *
 * ⚠ 两者的速度差异**不是**「谁更快」那么简单，实测结论：
 *
 * | 模型 | 中位延迟 | 正确率 | 并发限流 |
 * |---|---|---|---|
 * | GLM-5.3 | 4452ms | 8/14 (57%) | 撞过 21 次 3009 |
 * | GLM-5.3-Flash | 4915ms | 10/15 (67%) | **0 次** |
 *
 * ⇒ GLM-5.3 略快但略不准，且并发配额严得多。默认放 Flash（更稳）。
 * 样本量偏小（n≈15），所以两个都列出来让用户自己选。
 *
 * ## ⚠ 图片能力：**支持**（曾经误标为 `false`）
 *
 * 早先两个模型都标 `supportsImage: false`，理由是「该通道图片链路未验证」。
 * **那是个错误结论** —— 用户实测在 ZCode IDE 里用 `GLM-5.3-Flash`
 * 发图片能**正确理解**（描述出了一张足球截图里的拉拽犯规、箭头标注、
 * bilibili 水印等细节）。
 *
 * 逆向官方 agent 拿到了它序列化图片的确切形态（见
 * `zcode-anthropic.ts` 的 `toImageBlock`），与我们的实现一致 ——
 * 所以之前失败的原因是**适配器里那个「显式拒绝图片」的守卫**，
 * 而不是通道不支持。守卫已删除。
 *
 * ⚠ 标 `true` 就必须**真支持**：DSH 按适配器播报的 `inputModalities`
 * 决定是否把图片原样送进来（否则投影成文本占位符）。两边必须一致。
 *
 * ## ⚠⚠ 上下文窗口 / 最大输出 / 思考档位：**全部照上游 `client/configs` 抄**
 *
 * **真实缺陷（用户报障）**：模型配置页里上下文窗口显示 **1,000,000**、
 * 最大输出 **128,000**，而模型选择器里**没有任何思考档位可选** ——
 * 尽管 ZCode IDE 里可以设置（截图见用户反馈）。
 *
 * 上游 `GET /api/v1/client/configs` 的 `builtinModels` 是**权威来源**，
 * 实测（2026-09-29）逐字如下：
 *
 * | 字段 | GLM-5.3 | GLM-5.3-Flash |
 * |---|---|---|
 * | `contextWindow` | **1000000** | **1000000** |
 * | `maxCompletionTokens` | **128000** | **128000** |
 * | `capabilities.vision` | **（无）** | **true** |
 * | `reasoning.levels` | `low` / `high` / `max` | 同 |
 * | `reasoning.defaultLevel` | **max** | **max** |
 * | `modalities.input` | （无） | `text` / `image` / `video` |
 *
 * ⚠ 我此前填的 `200_000` / `32_768` **都是错的**（凭空估的），
 * 且把两个模型都标了 `supportsImage: true` —— 但**上游说只有 Flash 有 vision**。
 * 教训：能力字段必须抄上游，不能按「同族应该一样」推断。
 *
 * ⚠ **档位协议是 `output_config.effort`**（不是 `reasoning_effort`）——
 * 每个档位在 `reasoning.levels[level].anthropic.set` 里给出确切写法：
 *
 * ```json
 * { "path": ["output_config", "effort"], "value": "low" | "high" | "max" }
 * ```
 */
const ZCODE_FALLBACK_MODELS: readonly ZcodeFallbackModel[] = [
  {
    id: 'GLM-5.3-Flash',
    name: 'GLM-5.3-Flash',
    // 上游值（client/configs 的 builtinModels）。
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    // 上游 capabilities.vision === true。
    supportsImage: true,
    // 上游 reasoning.levels 的顺序即展示顺序（low → high → max）。
    reasoningLevels: ['low', 'high', 'max'],
    // 上游 reasoning.defaultLevel。
    defaultReasoningLevel: 'max',
  },
  {
    id: 'GLM-5.3',
    name: 'GLM-5.3',
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    /**
     * ⚠ **上游 `capabilities` 是空对象** ⇒ 这个模型**没有 vision**。
     * 我此前按「同族应该一样」推断成 `true` —— 那是错的。
     */
    supportsImage: false,
    reasoningLevels: ['low', 'high', 'max'],
    defaultReasoningLevel: 'max',
  },
]

/** ZCode provider 配置。 */
export const ZCODE: ZcodeProduct = {
  id: 'zcode',
  // ⚠ 用『ZCode (智谱)』而非长名 —— 后者在 Channel Pack 的 provider Tab 里
  // **触发换行**（与 Raccoon 同样的用户报障）。
  // 与 `plugin-src/client/channel-pack.js` 的 `PROVIDERS` label 保持一致。
  displayName: 'ZCode (智谱)',
  /**
   * 单凭据回退 ref。
   *
   * ⚠ ZCode 正常**不需要**用户填任何东西 —— 凭据从官方
   * `~/.zcode/v2/credentials.json` 自动解密读取（见 `zcode.ts`）。
   * 这个 ref 只用于「账号池里没有任何 zcode 账号」时的兜底路径，
   * 内容为 `ZcodeCredential` 的 JSON。
   */
  defaultCredentialRef: 'ZCODE_CREDENTIAL',
  /**
   * **整轮墙钟**上限：15 分钟。
   *
   * ⚠⚠️ **不要按「推理该等多久」来定它**（真实缺陷 IKJOVB）。它只兜两件事：
   * ① 上游**真静默**且空闲超时也失效的极端情况；② **captcha 卡死** ——
   * `zcode-captcha.ts` 里存在**无上限的等待**（取页自旋、等 CDP WebSocket `open`），
   * 早期实测把 `pageBusy` 卡死后整个 turn 永挂，只能靠这里兜。
   *
   * ⚠ **180_000 是错的**（那是官方 `network.timeout`，属另一个字段，见接口注释）。
   * 长思考该由 {@link streamIdleTimeoutMs} 管，本值可以给得很宽。
   *
   * ⚠ 实测 free 通道单请求 3–30 秒（本机 GLM-5.3-Flash 2.99 秒），mint 稳态
   * 0.4–0.5 秒（中位 426ms / 均值 546ms）、含 chromium 冷启动首次 4.2 秒 ——
   * 这些都在 15 分钟里，不构成约束。
   */
  requestTimeoutMs: 15 * 60_000,
  /**
   * 流式读取空闲超时：**600_000ms（10 分钟）**，逐字对齐官方
   * `modelStream.idleTimeoutMs = 6e5`（`zcode.cjs` 默认配置还原）。
   *
   * ⚠ 每收到一帧即续期，所以「持续大思考」可以跑满 10 分钟以上而不被判超时 ——
   * 这正是官方 IDE 面对同一场景不报错的原因。
   */
  streamIdleTimeoutMs: 600_000,
  fallbackModels: ZCODE_FALLBACK_MODELS,
  appVersionFallback: ZCODE_APP_VERSION_FALLBACK,
  /**
   * 闸门与重试参数**全部照搬 `dsh-free-glm` 的实测值**。
   *
   * ⚠ 这些值是在**同一个上游**（`zcode.z.ai` 的免费额度通道）上实测出来的，
   * 而并发配额是**服务端按模型 + 账号**计量的 —— 与我们走不走壳无关，
   * 故可以直接沿用。将来若上游调整配额，改这里即可（不要在适配器里写死）。
   */
  serializeUpstream: true,
  modelGapMs: {
    // 那边实测：GLM-5.3 需要间隔（起步 350ms，21 次限流降到 1 次）。
    'glm-5.3': 350,
    // Flash 从未撞过限流 —— 强加间隔是纯粹的性能损失。
    'glm-5.3-flash': 0,
  },
  concurrencyRetryMax: 2,
  concurrencyRetryBaseMs: 1_500,
  quotaSwitchMax: 2,
  toolCacheBreakpoint: true,
}

/** 全部 ZCode 产品配置（当前只有一个，保留数组以便将来扩展）。 */
export const ALL_ZCODE_PRODUCTS: readonly ZcodeProduct[] = [ZCODE]

/**
 * 按 provider id 取产品配置；未知 id 返回 undefined。
 *
 * 与 `productById` / `raccoonProductById` 分开：各自返回**不同类型**，
 * 合并会让调用方拿到联合类型后再也不得不做类型收窄。
 */
export function zcodeProductById(id: string): ZcodeProduct | undefined {
  return ALL_ZCODE_PRODUCTS.find((product) => product.id === id)
}

/** 供适配器使用的凭据别名（避免循环 import）。 */
export type { ZcodeCredential }

/**
 * 远端模型条目的形状（适配器与 auth 服务共用的最小契约）。
 *
 * 为什么不直接用 `ZcodeFallbackModel`：那个是**兜底表**的类型，
 * 语义是「实测可用的静态清单」；这里是「运行期拿到的目录条目」。
 * 两者当前字段相同，但**语义不同** —— 将来远端可能多出字段
 * （例如倍率、能力标记），那时不该被迫改兜底表。
 */
/**
 * 远端模型条目的**结构子集**（`fetchModels()` 的返回形状）。
 *
 * ⚠ 字段与上游 `client/configs` 的 `builtinModels[]` 一一对应 ——
 * 不要只挑「当前用得上的」几个：`reasoningLevels` / `defaultReasoningLevel`
 * 是思考档位选择器的唯一来源（漏了它选择器就不出现，qoder 那边踩过同型坑）。
 */
export interface ZcodeRemoteModelLike {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
  /** 思考档位（键序即展示顺序）；空/缺省表示不声明。 */
  reasoningLevels?: readonly string[]
  /** 默认档位（必须落在 `reasoningLevels` 内）。 */
  defaultReasoningLevel?: string
}
