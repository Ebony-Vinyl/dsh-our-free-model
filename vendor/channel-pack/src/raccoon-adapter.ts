/**
 * Raccoon Work LLM 适配器。
 *
 * ## 为什么复用 `openai-compat.ts`
 *
 * 实测 `POST /api/web/llm/v2/chat/completions` 是**标准 OpenAI 兼容 + 标准 SSE**
 * （`chat.completion.chunk` + `data: [DONE]`，无加密、无信封、无格式转换），
 * 与 Qoder / Loomy 同形，正是 `openai-compat.ts` 的适用场景。
 *
 * ⚠️ **不改 `openai-compat.ts` 的内部逻辑** —— 它当前服务 qoder 与 loomy；
 * raccoon 是第三个消费者。若实测发现字段形态不符，应在**本文件**内做局部适配，
 * 而不是改共享层（那会影响另外两个 provider 的既有行为）。
 *
 * ## 两个必须真的做到的点
 *
 * 1. **`tools` 必须下发到请求体顶层** —— Qoder 与 TRAE 都因漏发而让模型
 *    在正文里臆造 XML 工具调用、harness 认不出 → 任务终止。
 * 2. **`listAllModels()` 必须实现** —— 设置页要显示被关闭的模型及其倍率；
 *    缺了它会退化为裸 id（AGENTS.md 记录的真实缺陷）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { AccountPool, providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import { settingsNamespaceFor } from './settings-compat.js'
import { isRaccoonExpired, type RaccoonCredential } from './raccoon.js'
import {
  RACCOON,
  RACCOON_DEFAULT_EFFORT,
  RACCOON_EFFORT_NAMES,
  RACCOON_EFFORT_OFF,
  RACCOON_EFFORT_ON,
  RACCOON_REASONING_EFFORTS,
  type RaccoonFallbackModel,
  type RaccoonProduct,
} from './raccoon-product.js'
import { projectRequestImage, type ImageRequestTarget } from './image-budget.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  collectImages,
  consumeOpenAiSse,
  errorDetail,
  httpErrorCode,
  isTransportError,
  serializeMessages,
} from './openai-compat.js'

/** 本适配器注册的 provider 路由名（等价于 `RACCOON.id`）。 */
export const PROVIDER = 'raccoon'

/**
 * 一轮请求最多让几个账号参与（对齐 buddy / lobsterai / trae / cline / gemini
 * 的 `MaxRotate = 3`）。即：首次尝试 + 最多 2 次换号。
 *
 * ⚠️ 不是「重试 3 次」：换号的前提是**一个字都还没产出**（见 `stream()` 的
 * 约束 ②），故它绝不会把已生成的正文重放给用户，只是在候选账号之间选一个
 * 能真正干活的。
 */
export const RACCOON_MAX_ROTATE = 3

/**
 * 把 DSH 的档位 id 映射成请求体的 `extra_body.thinking` 字段。
 *
 * ## 为什么是这个形态（实测确证，别改）
 *
 * 唯一**有效**的思考控制通道是 **`extra_body.thinking`**（Anthropic 风格对象），
 * 服务端报错原文确认其枚举：``expected one of `adaptive`, `enabled`, `disabled` ``。
 *
 * 实测（判据为服务端上报的 `reasoning_tokens`）：
 *
 * | 请求 | 结果 |
 * |---|---|
 * | `extra_body.thinking={type:'disabled'}` | **6/6、8/8 全为 0** → 真关闭 |
 * | `extra_body.thinking={type:'enabled'}` | 均值 218 ≈ 基线 222 → 与默认等价 |
 *
 * ⚠️ **`reasoning_effort` 虽然被服务端接受（8 个枚举值），但实测无效果** ——
 * 8 轮配对实验里 `max - minimal` 正差 4 次 / 负差 4 次（纯随机），
 * 且 `none` 不关闭思考（均值 301 vs `disabled` 的 0）。
 * 故**不用它**表达档位，详见 `raccoon-product.ts` 的常量注释。
 *
 * ⚠️ **无效的写法**（都实测过）：`extra_body.enable_thinking`、
 * 双层 `extra_body.extra_body.*`、把 `thinking` 放**顶层**（不在 `extra_body` 内）、
 * `thinking.budget_tokens`（仅被格式校验）。
 *
 * ## 语义
 *
 * - 档位为 `off` → `{ thinking: { type: 'disabled' } }`（真的不产生思考内容）
 * - 其余（含 `on`）→ `{ thinking: { type: 'enabled' } }`
 *
 * ⚠️ **不传档位时返回 `undefined`**（不发该字段），保持服务端默认行为 ——
 * 实测默认就是开启，故与 `on` 等价，但**少发一个字段**更稳。
 *
 * @returns 要写进 `extra_body` 的对象；`undefined` 表示不发该字段。
 */
export function raccoonThinkingExtraBody(
  effort: string | undefined,
): { thinking: { type: 'enabled' | 'disabled' } } | undefined {
  if (effort === undefined || effort.length === 0) return undefined
  // 只有明确的「关闭」才关；未知档位一律按开启处理（宁可多思考，不可静默关掉
  // —— 用户看不到思考内容会以为模型坏了）。
  const type = effort === RACCOON_EFFORT_OFF ? 'disabled' : 'enabled'
  return { thinking: { type } }
}

/**
 * 该模型在 UI 上可选的思考档位。
 *
 * ⚠️ **所有模型都返回同样两档** —— 实测 `extra_body.thinking` 是 **provider 级
 * 方言**，与模型无关。故不做 per-model 分派（那会是凭空猜测）。
 *
 * ⚠️ `defaultEffort` 必须落在 `efforts` 内 —— DSH 会直接拿它发请求，
 * 给一个不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`。
 */
export function raccoonReasoningInfo(): {
  efforts: Array<{ id: ReturnType<typeof ReasoningEffortId>; name: string }>
  defaultEffort: ReturnType<typeof ReasoningEffortId>
} {
  const efforts = RACCOON_REASONING_EFFORTS.map((id) => ({
    id: ReasoningEffortId(id),
    name: RACCOON_EFFORT_NAMES[id] ?? id,
  }))
  // ⚠️ 默认档必须确实在列表里（防御：常量被改乱时不至于抛错）
  const defaultEffort = RACCOON_REASONING_EFFORTS.includes(RACCOON_DEFAULT_EFFORT)
    ? ReasoningEffortId(RACCOON_DEFAULT_EFFORT)
    : ReasoningEffortId(RACCOON_REASONING_EFFORTS[0] ?? RACCOON_EFFORT_ON)
  return { efforts, defaultEffort }
}

/** 远端模型条目（已归一）。 */
export interface RaccoonRemoteModel {
  id: string
  /** **已规范化**的展示名（含倍率）。 */
  name: string
  contextWindow: number
  maxTokens: number
  supportsImage: boolean
}

/**
 * 只放行**安全正整数**。
 *
 * ⚠️ 远端是外部输入：`0` / 负数 / `NaN` 会让 DSH 在
 * `defaultMaxTokens` 的硬校验上抛 `INVALID_MODEL_MAX_TOKENS`，
 * **整轮对话起不来**（不是降级，是崩）。
 */
function positiveMaxTokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 兜底表条目转远端形状。 */
function fallbackToRemote(model: RaccoonFallbackModel): RaccoonRemoteModel {
  return {
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    // 兜底表**声明**图片能力（它有该字段）；与 loomy 不同（那边兜底表没有该信息）。
    supportsImage: model.supportsImage,
  }
}

/** {@link RaccoonAdapter} 的构造选项。 */
export interface RaccoonAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<RaccoonCredential | undefined>
  /**
   * 凭据失效时的处理（raccoon 有 refresh 端点，会真续期）。
   *
   * ## ⚠️ 为什么必须传 `accountId`（真实缺陷，审查发现并实测复现）
   *
   * 早先这里是无参的，接线侧只好自己猜「该刷哪个账号」，猜法是
   * `pool.getAvailableAccount(RACCOON.id, '')` —— 而**空 modelId 会让池的
   * 模型级限流过滤整体短路**（`account-pool.ts`：`if (modelId.length === 0) return true`），
   * 于是它返回的是「手动顺序第一个 enabled 账号」，**不保证是本次请求在用的那个**。
   *
   * 实测的坏场景：账号 A 今日额度耗尽（已被标到 UTC+8 24:00）、账号 B 健康但
   * token 过期。请求用 B 发出 → 401 → `refresh()` 却刷了 **A**
   *（桩件实测请求体是 `{"refresh_token":"rt-a"}`）→ B 的 token 从未续期 →
   * 重发仍 401 → 换号时 A 被 modelId 滤掉、B 已在 `tried` 里 →
   * `nextAccount` 返回 undefined → 报「没有其它可用账号」。
   * **而 B 只要续期就能用** —— 换号因此完全失效。
   *
   * 故把归属显式化：适配器知道自己这轮用的是哪个账号
   *（`resolveCurrentAccountId`），接线侧按它精确续期。
   * `accountId` 为空串时（单凭据模式、或凭据不在池中）由接线侧自行决定回退。
   */
  refresh: (accountId: string) => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<RaccoonRemoteModel[]>
  /** 读取图片附件的原始字节（内联为 data URL 用）。 */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /**
   * 读取图片附件的**请求版本**（按字节目标缩放后的字节）。
   *
   * ⚠️ 与 {@link readImage} 的错误契约相反：**不可用时要返回 `undefined`**
   * 而不是抛错，适配器据此回退原图。理由与桥接实现见
   * `src/index.ts` 的 `makeReadImageRequest`、`src/image-budget.ts` 的
   * `projectRequestImage`。
   *
   * 背景（issue !IKITT9 的 raccoon 变体）：该网关按**请求体字节**设限，
   * 实测 `HTTP_413: request body exceeds 10MB` —— 两张 2560×1600 的截图
   *（base64 后各 ≈3.9 MB）再加别的内容就可能被拒。
   */
  readImageRequest?: (
    attachment: unknown,
    target: ImageRequestTarget,
  ) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /**
   * 换号：取**下一个**可用账号（排除 `tried`）。
   *
   * 返回 `undefined` 表示没有别的候选了。
   *
   * ## 为什么换号必须由接线侧注入，而不是适配器自己问池
   *
   * 选号是一条带策略的链（余额分档 → 限流过滤 → `enabled` 过滤），
   * 而适配器只该关心「发请求、认失败」。把策略留在 `index.ts`，
   * 适配器与池之间就只有一个窄接口，日后换选号策略不必动这里。
   *
   * ⚠️ 传 `tried` 是**必需**的：池按用户手动顺序返回候选，
   * **刚失败的那个账号很可能仍排第一**，不排除就会拿回同一个、
   * 换号形同虚设（本插件在 qoder / cline 上各踩过一次，见
   * `qoder-adapter.ts` 的 `switchAccountOnQuota` 注释）。
   */
  nextAccount?: (
    modelId: string,
    tried: ReadonlySet<string>,
  ) => Promise<{ credential: RaccoonCredential; accountId: string } | undefined>
  /**
   * 标记「这个账号在这个模型上刚失败」。
   *
   * 池会把该 (账号, 模型) 对排除一段时间，从而让**下一次请求**也不再
   * 选它 —— 这是「换号」能持久生效的关键：只换当前这一轮，下一轮又
   * 挑回坏号，用户看到的就是「每次都从头撞一遍」。
   *
   * @param quota - 是否为**额度类**失败（无余额 / 积分不足 / 429）。
   *   `true` 时接线侧应按「当日内不再选它」处理（额度按自然日刷新），
   *   `false` 时只该做很短的冷却甚至不标记 —— 5xx / 超时是瞬时的，
   *   按天冷却会把一个健康的账号白白关掉一整天（本插件在 cline 上
   *   踩过反向的坑：兜底的**短**冷却覆盖了真值的长冷却）。
   */
  noteFailure?: (accountId: string, modelId: string, quota: boolean) => Promise<void>
  /** 调拨账本用的账号归属回报（换号后回报**最终服务**的那个）。 */
  reportAccount?: (accountId: string) => void
  /** 产品配置；默认 {@link RACCOON}。 */
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetchImpl?: typeof fetch
}

/** Raccoon Work 模型适配器。 */
export class RaccoonAdapter extends LlmAdapter {
  private readonly product: RaccoonProduct
  private readonly fetchImpl: typeof fetch
  /** 兜底模型索引（id → 条目）。 */
  private readonly fallbackIndex: ReadonlyMap<string, RaccoonFallbackModel>
  /** 远端模型缓存；未拉取时为 undefined。 */
  private remoteModels: RaccoonRemoteModel[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: RaccoonAdapterOptions) {
    super()
    this.product = options.product ?? RACCOON
    this.fetchImpl = options.fetchImpl ?? fetch
    this.fallbackIndex = new Map(this.product.fallbackModels.map((model) => [model.id, model]))
  }

  /**
   * 描述本适配器拥有的 provider 路由。
   *
   * 对入参做防御性归一化：DSH 会强制校验 `info.id === provider`，而模型设置页
   * 会用该 id 计算 `deriveKeyRef(provider)`（内部调 `provider.toUpperCase()`）。
   * 一旦 provider 不是字符串，直接回退到本产品的 id。
   */
  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
  }

  /**
   * 完整目录（**不套黑名单**），带最终展示名。
   *
   * 设置页需要它渲染被关闭的模型 —— 否则那些条目只能凭 `disabledMap` 的 key
   * 补回，而那条路径拿不到展示名，会退化成裸 id（倍率与模型名随之丢失）。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? this.product.fallbackModels.map(fallbackToRemote)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  /**
   * 取远端模型目录；**失败时不把兜底表写进缓存**。
   *
   * ⚠ 原实现是 `this.remoteModels = fallback; return fallback` —— 把兜底表当成
   * 「已加载」记下，于是一次瞬时失败会让该 provider **整个进程生命周期**都只剩
   * 兜底模型（用户看不到自己的模型，且无从触发重试，只能重启）。
   * 改为：只缓存**真实远端目录**，兜底表每次现算（纯本地、零成本），
   * 并用 {@link RemoteCatalogGate} 的冷却挡住「每模型重试一次」的放大。
   */
  private async loadModels(): Promise<RaccoonRemoteModel[]> {
    if (this.remoteModels !== undefined) return this.remoteModels
    const fetchRemote = this.options.fetchRemoteModels
    if (fetchRemote !== undefined) {
      await this.catalogGate.run(async () => {
        const fetched = await fetchRemote()
        if (fetched.length === 0) return false
        this.remoteModels = fetched
        return true
      })
      if (this.remoteModels !== undefined) return this.remoteModels
    }
    return this.product.fallbackModels.map(fallbackToRemote)
  }

  private inputModalitiesFor(model: RaccoonRemoteModel | undefined): readonly ('text' | 'image')[] {
    return model?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 的 buildModelCatalog 把整个 provider
    // 分组隐藏。**必须返回空数组而不能抛错**（抛错会被归入 catalog 的
    // failures，界面上反而多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      // 倍率拼进 name（不是 description）：composer 的模型切换菜单只渲染 name。
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const fallback = this.fallbackIndex.get(model)
    // ⚠️ name **不带倍率**（与 qoder/trae/loomy 一致）：价格只属于选择列表语境。
    const bareName = fallback !== undefined ? fallback.name.replace(/ · .*$/, '') : model
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry !== undefined ? entry.name.replace(/ · .*$/, '') : bareName,
      inputModalities: this.inputModalitiesFor(entry),
    }
    const contextWindow = entry?.contextWindow ?? fallback?.contextWindow
    // 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）。
    if (contextWindow !== undefined && contextWindow > 0) {
      resolved.context = { contextWindow }
    }
    // ⚠️ 远端非法值必须过滤（见 positiveMaxTokens）：不声明就让 DSH 用默认值。
    const maxTokens = positiveMaxTokens(entry?.maxTokens ?? fallback?.maxTokens)
    if (maxTokens !== undefined) resolved.defaultMaxTokens = maxTokens
    // 思考档位（两态：深度思考 / 关闭思考）。实测确证见 `raccoonReasoningInfo`。
    // ⚠️ 所有模型一致 —— `extra_body.thinking` 是 provider 级方言，与模型无关。
    resolved.reasoning = raccoonReasoningInfo()
    return resolved
  }

  /**
   * 兼容 0.1.1-rc.2：新版 `LlmRuntime.prepareCall()` 会调用
   * `registration.adapter.prepareCall(...)`，而本仓库链接的 dsh-llm 副本
   * 基类尚未提供该方法。与其余适配器同款 shim。
   */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{ model: LlmResolvedModelInfo; stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    // 图片能力按**模型**判定。不能放宽成「总是接受」：DSH 在 LlmRuntime 里
    // 按适配器播报的 `inputModalities` 决定要不要把图片投影成文本占位符，
    // 声明支持就必须真支持。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === options.model)
    let imageUrls: Map<string, string> | undefined
    if (imageRefs.size > 0) {
      if (!this.inputModalitiesFor(entry).includes('image')) {
        throw new LlmError(`raccoon: 模型 "${options.model}" 不支持图片输入`, 'UNSUPPORTED_CONTENT')
      }
      if (this.options.readImage === undefined) {
        throw new LlmError('raccoon: 图片输入需要附件服务', 'UNSUPPORTED_CONTENT')
      }
      // 保留**空 Map**（而非降级为 undefined）：图片存在但全部读取失败时，
      // 空 Map 仍会让 userContentParts 产出 [image unavailable] 占位符。
      imageUrls = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        // ⚠️ 先试**请求版本**：这家网关按请求体字节设限（实测
        // `HTTP_413: request body exceeds 10MB`），原图直发时两张大截图
        // 就能把配额吃掉大半。拿不到（老宿主 / 拒绝投影 / 缺尺寸）就回退原图。
        const projected = await projectRequestImage(ref, {
          readImageRequest: this.options.readImageRequest,
          pixelBudget: this.product.imagePixelBudget,
          maxBytes: this.product.imageMaxBytes,
        })
        const image = projected ?? await readImage(ref)
        if (image === undefined) continue
        imageUrls.set(id, `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`)
      }
    }

    // 1. 取凭据（过期则先续期）
    let credential = await this.options.resolveCredential(options.model)

    /**
     * 本轮实际使用的账号 id（空串 = 没有池 / 凭据不在池里）。
     *
     * ⚠️ **必须在续期之前解析**（真实缺陷，审查发现并实测复现）：
     * 续期要刷的正是「这一份凭据所属的账号」，而解析归属只能靠凭据本身。
     * 若先续期再解析，接线侧就只能猜 —— 它猜的是「池里第一个 enabled 账号」，
     * 在「A 被限流、B 在用」的场景下会**刷成 A**，B 永远续不上，
     * 换号跟着一起失效（详见 {@link RaccoonAdapterOptions.refresh} 的注释）。
     *
     * ⚠️ 局部可变：换号后池的「当前账号」不跟着变，靠回调取值会在两号间来回
     *（与 gemini / qoder 同因）。
     */
    let currentAccountId = await this.resolveCurrentAccountId(credential)

    if (credential === undefined || isRaccoonExpired(credential)) {
      // ⚠️ **刷新失败不致命**（真实遗漏，与下面 401 分支同一约定）。
      //
      // 这是进入 `stream()` 的**第一道门**：凭据一过期就会走到这里。此前没有
      // try/catch，于是 refresh_token 失效时**直接冒泡** —— 换号逻辑一步都不执行，
      // 用户只看到「登录态已过期，请重新登录」，而池里另一个健康账号从未被尝试
      //（行为测试实测：`chat/completions` 被调用 **0** 次）。
      //
      // 捕获后继续往下走：拿不到新凭据时仍会带着原凭据尝试，失败则由下面的
      // 换号分支兜底 —— 单个账号的凭据故障不该让整轮陪葬。
      try {
        await this.options.refresh(currentAccountId)
        credential = await this.options.resolveCredential(options.model)
        // 续期后凭据可能变了（换了账号或换了 token），归属要重新解析。
        currentAccountId = await this.resolveCurrentAccountId(credential)
      } catch (error) {
        console.warn(`[raccoon] 凭据续期失败，继续尝试（必要时由换号兜底）：${String(error)}`)
      }
    }
    if (credential === undefined || credential.access_token.length === 0) {
      throw new LlmError('raccoon: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const messages = serializeMessages(options.messages, imageUrls)

    /**
     * 前置 system 消息（若有）。
     *
     * ⚠️ 必须**先拼再放进对象**，不要在对象字面量里写两次 `messages` ——
     * 后者依赖「后面的键覆盖前面」这一隐式行为，读者极易误判成漏了 system。
     */
    const wireMessages = options.system !== undefined && options.system.length > 0
      ? [{ role: 'system', content: options.system }, ...messages]
      : messages

    /**
     * 思考档位 → `extra_body` 内容。
     *
     * ⚠️ 在 `buildBody` **之外**算一次：`buildBody` 会在重试时被多次调用，
     * 每次重算虽无害但没必要。
     */
    const thinking = raccoonThinkingExtraBody(options.reasoningEffort)

    /** 构造请求体。 */
    const buildBody = (): string => JSON.stringify({
      model: options.model,
      messages: wireMessages,
      stream: true,
      ...options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {},
      ...options.temperature !== undefined ? { temperature: options.temperature } : {},
      ...options.stop !== undefined && options.stop.length > 0 ? { stop: options.stop } : {},
      // ⚠️ tools 必须真的下发到请求体**顶层**：Qoder/TRAE 都因漏发而让模型
      // 在正文里臆造 XML 工具调用，harness 认不出 → 任务终止。
      ...options.tools !== undefined && options.tools.length > 0
        ? {
            tools: options.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                ...tool.description.length > 0 ? { description: tool.description } : {},
                ...tool.parameters === undefined ? {} : { parameters: tool.parameters },
              },
            })),
          }
        : {},
      // 思考档位（开 / 关）。⚠️ **必须在 `extra_body` 内** —— 实测放顶层会被忽略
      //（连非法值都不报错）。不传档位时不发该字段，保持服务端默认（= 开）。
      ...thinking !== undefined ? { extra_body: thinking } : {},
    })

    const headers = (): Record<string, string> => ({
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${credential?.access_token ?? ''}`,
      'X-Org-Code': credential?.office_identity ?? '',
      'X-Raccoon-Language': 'zh',
      'X-Client-Platform': this.product.clientPlatform,
    })

    /** 发送一次 chat 请求。 */
    const send = async (): Promise<Response> => {
      try {
        return await this.fetchImpl(
          `${this.product.apiBase}${this.product.llmApiPrefix}/chat/completions`,
          {
            method: 'POST',
            headers: headers(),
            body: buildBody(),
            signal: options.signal,
          },
        )
      } catch (error) {
        if (options.signal?.aborted) throw error
        if (isTransportError(error)) {
          throw new LlmError(
            `raccoon: transport error: ${error instanceof Error ? error.message : String(error)}`,
            'TRANSPORT',
            { cause: error as Error },
          )
        }
        throw error
      }
    }

    /**
     * 换号的状态。
     *
     * `tried` 跨轮保留：池按用户手动顺序返回候选，**刚失败的账号很可能仍
     * 排第一**，不排除就会拿回同一个、换号形同虚设。
     *
     * ⚠️ `currentAccountId` 已在上面（取凭据阶段）声明并解析 —— 它必须先于
     * 续期存在，理由见那里的注释。这里只补进 `tried`。
     */
    const tried = new Set<string>()
    if (currentAccountId !== '') tried.add(currentAccountId)
    /** 已经试过的账号数（含首轮），用于对齐 `RACCOON_MAX_ROTATE`。 */
    let attempts = 0
    /** 最近一次失败的**可读原因**（换号耗尽时如实报出）。 */
    let lastFailure = ''
    /**
     * 最近一次失败应映射成的错误码。
     *
     * ⚠️ 不能换号耗尽时统一用 `httpErrorCode(response.status)`：**流内错误帧**
     * 走的是 HTTP 200，那样会报出 `HTTP_200` 这个自相矛盾的码，还会落进
     * harness 的可重试集合白重试一轮。`consumeOpenAiSse` 已经把额度类错误
     * 分类成 `QUOTA_EXCEEDED`（不在该集合里，立即交还用户），必须保住它。
     */
    let lastCode = ''

    for (;;) {
      /**
       * ① 首轮之后才换号：先按当前凭据发一次。
       *
       * 401/403 仍然先续期一次并重发（raccoon 有 refresh_token 轮换）——
       * 这是**同账号内**的修复，比换号更轻，且不消耗换号预算。
       */
      let response = await send()
      if (response.status === 401 || response.status === 403) {
        // ⚠️ **刷新失败不致命**（真实遗漏，对齐 `buddy-adapter.ts` L1461-1464 的
        // 既有约定：*"刷新失败不致命：换号仍有机会，单个账号故障不该让整轮陪葬"*）。
        //
        // `refresh()` 在 refresh_token 失效时会抛 `RefreshTokenExpiredError`
        // （"raccoon: 登录态已过期，请重新登录"）。原先这一行**没有** try/catch，
        // 于是「账号 A 的凭据坏了、账号 B 完全健康」这个**最该换号**的场景
        // 反而直接冒泡报错 —— 换号逻辑一行都不会执行
        //（行为测试实测：推理端点被调用 **0** 次，用户只看到「请重新登录」）。
        //
        // 捕获后继续往下走，交给后面的换号分支处理。
        try {
          // ⚠️ 传**本轮在用的账号**（`currentAccountId`），不要让它去猜 ——
          // 接线侧猜的那一套会刷错账号（见 `refresh` 的注释与实测复现）。
          await this.options.refresh(currentAccountId)
          const refreshed = await this.options.resolveCredential(options.model)
          if (refreshed !== undefined && refreshed.access_token.length > 0) {
            credential = refreshed
            // 续期后归属可能变了，同步一次，供后续轮次与失败标记使用。
            currentAccountId = await this.resolveCurrentAccountId(credential)
            response = await send()
          }
        } catch (error) {
          console.warn(`[raccoon] 刷新凭据失败，改用换号重试：${String(error)}`)
        }
      }

      // ② 成功：消费流。**只有尚未产出任何内容时才允许换号**（见下）。
      if (response.ok) {
        let emitted = false
        try {
          for await (const chunk of consumeOpenAiSse(response, { signal: options.signal }, {
            label: 'raccoon',
            firstTokenTimeoutMs: resolveFirstTokenTimeoutMs(),
            chunkTimeoutMs: resolveChunkTimeoutMs(),
            ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          })) {
            emitted = true
            yield chunk
          }
          return
        } catch (error) {
          // ⚠️ **已产出内容后绝不能换号**（真实缺陷，2026-09-23 在 lobsterai
          // 上实测到，同一形状）：换号会重放请求，而新的 `consumeOpenAiSse`
          // 是**全新的生成器** —— 它的 `block.index` 从 0 重新开始，于是会
          // 再发一次 `block-start(index=0)`。DSH 对重复块索引是**硬失败**：
          //
          //   `dsh-llm/lib/invariant.js`：
          //     case "block-start":
          //       if (open.has(chunk.index)) fail(`LLM stream repeated block-start index ${chunk.index}`)
          //
          // 于是「额度耗尽」这个可读错误会被升级成 invariant 崩溃，
          // 还会把两个账号的正文拼在一起 —— 比不换号更糟。
          //
          // 此时如实抛出：harness 会重试整个回合，而在那次请求里失败通常
          // 发生在**首帧**（尚未产出内容），可干净换号。
          if (emitted) throw error
          // 传输/超时错误不换号：它多半是网络或本机代理的问题，换个账号
          // 照样撞 —— 留给 harness 决定是否重试整个回合。
          if (!(error instanceof LlmError)) throw error
          lastFailure = error instanceof Error ? error.message : String(error)
          // 保住流内分类的码（额度类是 `QUOTA_EXCEEDED`，不该被 HTTP 200 覆盖）。
          lastCode = error.code
        }
      } else {
        lastFailure = await response.text().catch(() => '')
        lastCode = httpErrorCode(response.status)
      }

      // ③ 记录失败，让**下一次请求**也不再挑这个账号。
      //
      // ⚠️ 必须记在**真正失败的那个账号**上（`currentAccountId`），而不是
      // 下一轮才会被赋值的新账号 —— 标错会把无辜的账号关掉，而坏号仍被
      // 反复选中（qoder 的单测实测到过 `['acct-A','acct-A']` 这种记录）。
      if (currentAccountId !== '' && this.options.noteFailure !== undefined) {
        // 额度类的两个来源：HTTP 状态码/正文（`isRaccoonQuotaFailure`），
        // 以及**流内错误帧**的分类结果 —— 后者走 HTTP 200，状态码看不出
        // 任何东西，只能认 `consumeOpenAiSse` 给出的 `QUOTA_EXCEEDED`。
        const quota = lastCode === 'QUOTA_EXCEEDED'
          || isRaccoonQuotaFailure(response.status, lastFailure)
        await this.options.noteFailure(currentAccountId, options.model, quota).catch(() => {})
      }

      // ④ 换号。用户明确要求「任何报错都切换」，故这里**不对错误分类挑肥拣瘦**
      // —— 唯一的例外是上面那两条（已产出内容、传输错误），它们换号无益。
      const reason = describeRaccoonFailure(lastFailure)
      if (this.options.nextAccount === undefined) {
        // 无账号池（headless / 单测）：如实报出，不做换号。
        throw new LlmError(reason, lastCode, { status: response.status })
      }
      if (attempts >= RACCOON_MAX_ROTATE - 1) {
        throw new LlmError(
          `raccoon: 账号池中 ${tried.size} 个账号均不可用（最近一次：${reason}）`,
          lastCode,
          { status: response.status },
        )
      }

      const next = await this.options.nextAccount(options.model, tried)
      if (next === undefined) {
        // 池里没有别的候选：其余账号可能都已知额度耗尽（无余额），
        // 或都被限流标记挡着。如实报出最近一次的真实原因。
        throw new LlmError(
          `raccoon: 没有其它可用账号 —— ${reason}`,
          lastCode,
          { status: response.status },
        )
      }
      attempts += 1
      tried.add(next.accountId)
      credential = next.credential
      currentAccountId = next.accountId
      // 换号后回报账本：usage 归到**最终服务**的那个账号。
      this.options.reportAccount?.(next.accountId)
    }
  }

  /**
   * 由凭据反查它属于池里的哪个账号（找不到返回空串）。
   *
   * 空串表示「这份凭据不在池里」（单凭据回退模式），此时不写失败标记 ——
   * 池里没有对应条目，`updateModelRateLimit` 会记一条「账号不在列表中」的
   * 警告，纯噪声。
   *
   * ⚠️ `credential` 可以是 `undefined`（取凭据阶段还没拿到凭据时就要先问归属，
   * 以便**精确续期** —— 见 `refresh` 的注释）。那种情况返回空串，
   * 由接线侧走「按 id 找不到 → 兜底」的分支。
   */
  private async resolveCurrentAccountId(
    credential: RaccoonCredential | undefined,
  ): Promise<string> {
    const pool = this.options.accountPool
    if (pool === undefined || credential === undefined || credential.access_token.length === 0) {
      return ''
    }
    try {
      return await pool.findAccountIdByCredential(this.product.id, credential.access_token)
    } catch {
      return ''
    }
  }
}

/**
 * 把「最近一次失败的原文」整理成可以给用户看的单行原因。
 *
 * ## 为什么要单独一步
 *
 * 失败原文有两个来源，形状不同：
 *
 * - **HTTP 非 2xx**：`response.text()` 的裸响应体（可能是 JSON，也可能是
 *   一段 HTML 错误页）。需要过 `errorDetail()` 把 JSON 里的 `code` /
 *   `message` 抠成一行。
 * - **流内错误帧**：`LlmError.message`，**已经**是 `consumeOpenAiSse` 拼好的
 *   可读串（形如 `raccoon: Billing daily count exceeded`）。再套一次
 *   `errorDetail()` 只会得到同样的字符串（它不是 JSON），但再补一个
 *   `raccoon:` 前缀就会变成 `raccoon: raccoon: …` —— 那种重复前缀会让人
 *   以为是两层错误，排查时白绕一圈。
 *
 * 界面上这一行是用户唯一能看到的线索，故两条路径都要给出准确原文，
 * **不能**退化成「请求失败」这类把证据丢掉的说法。
 */
function describeRaccoonFailure(raw: string): string {
  const detail = errorDetail(raw)
  return detail.startsWith('raccoon:') ? detail : `raccoon: ${detail}`
}

/**
 * 该失败是否属于**额度类**（无余额 / 积分不足 / 限流）。
 *
 * ## 为什么要分这两类
 *
 * 接线侧对它们的**冷却时长**不同：
 *
 * - 额度类：商汤的免费额度按**自然日**结算，故标到 UTC+8 当日 24:00
 *   （复用 `nextUtc8DayStartMs()`）。标短了会让用户 1 小时后再撞同一堵墙。
 * - 其它（5xx / 超时 / 请求错误）：**短冷却**，甚至不标 —— 它们是瞬时的，
 *   按天冷却会把一个健康的账号白白关掉一整天。
 *
 * ## 判据
 *
 * 状态码 402 / 429 是权威信号；正文关键词是兜底（上游也可能用 200 +
 * 业务错误码表达额度不足）。关键词刻意**窄**：`balance` / `quota` 这类泛词
 * 会误伤模型正文里恰好讨论「余额」的情况（`model-queue.ts` 记过这条）。
 */
export function isRaccoonQuotaFailure(status: number, text: string): boolean {
  if (status === 402 || status === 429) return true
  return /积分不足|额度不足|余额不足|积分用完|额度用尽|没有积分|积分耗尽|insufficient\s+(?:credit|balance|quota|points)/i
    .test(text)
}

/** 首 token 超时（毫秒）；可用环境变量覆盖（与其余适配器同约定）。 */
function resolveFirstTokenTimeoutMs(): number {
  const raw = Number(process.env.DSH_RACCOON_FIRST_TOKEN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/** chunk 间隔超时（毫秒）。 */
function resolveChunkTimeoutMs(): number {
  const raw = Number(process.env.DSH_RACCOON_CHUNK_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000
}

/**
 * 在 `ctx.llm` 上注册 raccoon provider 路由与适配器。
 *
 * 返回适配器实例：Channel Pack「显示列表」需要 `listAllModels()`
 * （不受黑名单影响、带最终展示名）。`ctx.llm` 不透传自定义方法，
 * 故须由调用方持有引用并在 `index.ts` 的 `modelAdapters` 里登记。
 */
export function registerRaccoonLlm(ctx: Context, options: RaccoonAdapterOptions): RaccoonAdapter {
  const product = options.product ?? RACCOON
  const adapter = new RaccoonAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
