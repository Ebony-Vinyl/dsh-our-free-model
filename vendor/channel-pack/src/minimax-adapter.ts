/**
 * MiniMax Code 模型适配器。
 *
 * ## 推理已实现（2026-09-29，真实请求验证）
 *
 * 走 **Anthropic Messages** 协议（`POST {apiHost}/mavis/api/v1/llm/v1/messages`），
 * 请求体构造与 SSE 消费在 `src/minimax-messages.ts`。
 *
 * 实测（4 个模型全部 HTTP 200，文本 / 思考 / 工具调用均正常）：
 * - `MiniMax-M3.1-Flash-Preview`：**必须** `thinking.type='adaptive'`，
 *   档位走 `output_config.effort`；传 `disabled` ⇒ `400 ... (2013)`。
 * - `M3` / `M2.7` / `M2.7-highspeed`：**不发 thinking 即接受**，
 *   且服务端默认会思考（M2.7 实测 `thinking_tokens: 250`）。
 *
 * ## 两个必须记住的口径
 *
 * 1. **窗口取档位表最大档**：`MiniMax-M3.1-Flash-Preview` 的 `limit.context`
 *    是 512000，但 `context_window_options` 是 `[512000, 1000000]`。
 *    填 512K 会让 DSH 远早于官方能力触发压缩（与 Qoder 同口径）。
 * 2. **只有 M3.1-Flash-Preview 有档位**：其余三个远端没有 `effort_options`。
 *    给它们编档位就是凭空猜测（Qoder 同型教训）。
 *
 * ## ⚠️ 未实现：图片
 *
 * `MiniMax-M3.1` / `M3` 的目录条目声明支持图片（`supportsImage: true`，
 * 用于 `inputModalities` 播报），但**带图请求未实测**，
 * 故 `serializeMinimaxMessages` 遇到 image 块**显式抛错**（不静默丢弃）。
 * 静默丢弃会让用户以为图片被模型看到了。
 */

import { LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmModelInfo,
  LlmModelReasoningInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import { providerCatalogVisible } from './account-pool.js'
import { RemoteCatalogGate } from './remote-catalog-gate.js'
import type { AccountPool } from './account-pool.js'
import { httpErrorCode, collectImages } from './openai-compat.js'
import { MINIMAX, MINIMAX_INFER_PATH, type MinimaxProduct } from './minimax-product.js'
import { minimaxInferHeaders } from './minimax.js'
import {
  registerAdapterIdempotent,
} from './llm-register-compat.js'
import {
  buildMinimaxMessagesPayload,
  consumeMinimaxSse,
  type MinimaxInlineImage,
} from './minimax-messages.js'
import {
  isMinimaxExpired,
  minimaxFallbackEntries,
  type MinimaxCredential,
  type MinimaxModelEntry,
} from './minimax.js'

/**
 * 前缀识别「必须 adaptive thinking」的模型。
 *
 * ⚠️ 按**前缀**而非全等：`MiniMax-M3.1-Flash-Preview` 是 preview 名，
 * 正式版可能叫 `MiniMax-M3.1`，前缀能同时覆盖两者；
 * 而 `MiniMax-M3` **不能**被这个前缀命中（它不需要 adaptive，实测 200）——
 * 故必须是 `M3.1` 而不是 `M3`。
 */
const MINIMAX_ADAPTIVE_ONLY_PREFIX = 'MiniMax-M3.1'

/**
 * 由模型条目构造 DSH 的思考档位声明。
 *
 * ⚠️ 返回 `undefined` 表示**不声明** `reasoning` —— DSH 的档位选择器会显示
 * 「当前模型未提供推理等级」（对应官方 IDE 的「不支持」）。
 *
 * ## ⚠️ 两种能力都要表达（2026-09-29 补的真实缺口）
 *
 * 远端 `thinking_config.mode` 实测三种值，**语义完全不同**：
 *
 * | 模型 | `mode` | `effort_options` | 实测行为 |
 * |---|---|---|---|
 * | M3.1-Flash-Preview | `forced_on` | ✅ 6 档 | 传 `disabled` **硬 400**（2013） |
 * | **M3** | **`switchable`** | ❌ 无 | 不传/`disabled` → **0 思考块**；`adaptive` → 有 |
 * | M2.7 / M2.7-highspeed | `forced_on` | ❌ 无 | 传 `disabled` **静默忽略**（仍有思考） |
 *
 * ⚠️ **初版只看了 `effort_options`，于是 M3 被声明成「无推理等级」**
 * —— 而它**实际可以开关思考**（真机实测）。那是**功能缺失**：
 * 用户在 UI 上无法为 M3 关闭思考。
 *
 * 修法（照 Qoder `qoderEffortsFor` 的既有口径）：
 * - `efforts` 取远端 `effort_options`（只有 M3.1 有）；
 * - `thinkingMode === 'switchable'` 时**追加 `none`**（= 「关闭思考」档）
 *   —— DSH 的 `LlmModelReasoningInfo` **没有** `supportsDisable` 字段，
 *   「可关闭」就是靠 `efforts` 里出现 `none` 表达的；
 * - 两者皆无 ⇒ `undefined`（不声明）。
 *
 * ⚠️ `forced_on` 的模型**绝不**追加 `none`：M3.1 会硬 400，
 * M2.7 会被静默忽略（那会让用户以为关掉了、实际没关 —— 比不给选项更糟）。
 *
 * 修法（照客户端 `thinking.js` 的**权威词汇**）：
 * - `efforts` 取远端 `effort_options`（只有 M3.1 有）；
 * - `thinkingMode === 'switchable'` 时给出**开/关两态**：
 *   `on`（→ `thinking:{type:'adaptive'}`）与 `none`（→ `{type:'disabled'}`）。
 *   ⚠️ 客户端用的就是 `on` / `off` 这两个词
 *   （`isMiniMaxM3ThinkingMode`：`value === 'on' || value === 'off'`），
 *   `off` 在 DSH 侧的惯用名是 `none`（Qoder 的「关闭思考」也用 `none`）；
 * - 两者皆无 ⇒ `undefined`（不声明）。
 *
 * ⚠️⚠️ **必须给 `on`，不能只给 `none`**（我第一版就只给了 `none`）：
 * 实测 M3 **不发 `thinking` 时默认「不思考」**（两轮各 0 字符），
 * 而 `adaptive` 有 **2785 / 2797** 字符。若只声明 `none`，用户**只能关、无法开**
 * —— 那比不给选项更糟（把模型的强项藏起来了）。
 *
 * ⚠️ `forced_on` 的模型**绝不**追加任何开关：M3.1 会硬 400，
 * M2.7 会被静默忽略（那会让用户以为关掉了、实际没关）。
 *
 * ⚠️ **展示名**：远端档位用原文字面量（官方 IDE 就是 `default` / `low` / …），
 * 但 `on` / `none` 是我们**追加**的（远端没有这两个名字），给中文名
 * 「开启思考」/「关闭思考」以免用户看不懂。
 */
export function minimaxReasoningInfo(
  entry: MinimaxModelEntry,
): LlmModelReasoningInfo | undefined {
  const options = entry.effortOptions
  const switchable = entry.thinkingMode === 'switchable'
  // ⚠️ 两种能力任一存在就要声明；只有两者皆无才返回 undefined。
  if ((options === undefined || options.length === 0) && !switchable) return undefined
  const ids = [...(options ?? [])]
  if (switchable) {
    // ⚠️ 顺序：**先 `on` 后 `none`** —— DSH 按数组顺序渲染，
    // 「开启」应排在「关闭」之前（默认档也由 `defaultEffort` 表达，
    // 但 M3 远端没给 `default_effort`，故把 `on` 放前面更符合直觉）。
    // 幂等：远端若哪天自己下了这几个名字，不重复追加。
    if (!ids.includes('on')) ids.push('on')
    if (!ids.includes('none')) ids.push('none')
  }
  const efforts = ids.map((id) => {
    if (id === 'none') return { id: ReasoningEffortId(id), name: '关闭思考' }
    if (id === 'on') return { id: ReasoningEffortId(id), name: '开启思考' }
    return { id: ReasoningEffortId(id), name: id }
  })
  // ⚠️ 默认档必须落在档位表内，否则**不发**（照 Qoder 的 resolveModel）。
  // ⚠️ M3 没有 `default_effort` ⇒ 不设 `defaultEffort` ⇒ 保持服务端默认
  //（实测 = 不思考）。**不要**擅自把它设成 `on` —— 那会改变用户既有行为。
  const defaultEffort = entry.defaultEffort !== undefined && ids.includes(entry.defaultEffort)
    ? ReasoningEffortId(entry.defaultEffort)
    : undefined
  return { efforts, ...defaultEffort === undefined ? {} : { defaultEffort } }
}

/** {@link MinimaxAdapter} 的构造选项。 */
export interface MinimaxAdapterOptions {
  /** 单凭据回退 ref（无账号池时）。 */
  credentialRef: CredentialRef
  /** 解析当前可用凭据。 */
  resolveCredential: (modelId?: string) => Promise<MinimaxCredential | undefined>
  /** 凭据失效时的处理。 */
  refresh: () => Promise<void>
  /** 拉取远端模型目录；失败时适配器回退兜底表。 */
  fetchRemoteModels?: () => Promise<readonly MinimaxModelEntry[]>
  /** 账号池（目录门控与黑名单）。 */
  accountPool?: AccountPool
  /**
   * 内联一张图片为**裸 base64**（由调用方桥接 `ctx.attachments.readImage`）。
   *
   * ⚠️ 未提供时收到图片会**报错**而不是静默丢图 —— 静默丢图会让用户以为
   * 图片被模型看到了（与 cline / lobsterai 的既有契约一致）。
   */
  readImage?: (attachment: unknown) => Promise<{ data: Uint8Array; mediaType: string } | undefined>
  /** 产品配置；默认 {@link MINIMAX}。 */
  product?: MinimaxProduct
}

/** MiniMax Code 模型适配器。 */
export class MinimaxAdapter extends LlmAdapter {
  private readonly product: MinimaxProduct
  private remoteModels: readonly MinimaxModelEntry[] | undefined
  /** 目录加载闸门：并发去重 + 失败/空结果冷却（见 `remote-catalog-gate.ts`）。 */
  private readonly catalogGate = new RemoteCatalogGate()

  constructor(private readonly options: MinimaxAdapterOptions) {
    super()
    this.product = options.product ?? MINIMAX
  }

  providerInfo(provider: string): LlmProviderInfo {
    const id = typeof provider === 'string' && provider.length > 0 ? provider : this.product.id
    return { id, name: this.product.displayName }
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
  private async loadModels(): Promise<readonly MinimaxModelEntry[]> {
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
    return minimaxFallbackEntries(this.product)
  }

  /**
   * 完整目录（**不套黑名单**），供 Channel Pack「显示列表」用。
   *
   * ⚠️ **必须同步返回数组，不能是 `async`**（真实缺陷，2026-09-29 修正）。
   *
   * 本插件 8 个既有适配器的 `listAllModels()` 全是同步返回 `readonly {...}[]`
   * （见 `llm-adapter.ts:789`、`raccoon-adapter.ts:229` 等），
   * `channel-pack-rpc.ts` 的接口（`:587` / `:641` 的 `ModelCatalogSource`）也是同步，
   * 且两处消费者**都不 await**：
   * - `:2041` `catalog = [...all]`
   * - `:2125` `ids = all.map((model) => model.id)`
   *
   * 早期这里写成 `async`，返回的是 Promise —— Promise **不是** `undefined`，
   * 故两处都会走进 `all !== undefined` 分支并抛
   * `TypeError: all is not iterable` / `TypeError: all.map is not a function`
   * ⇒「显示列表」与「关闭全部」两个功能同时崩。
   *
   * 当时未被发现，是因为 minimax 尚未接入 `src/index.ts` 的 `modelAdapters`
   * （无调用方），一旦接线即爆发。
   *
   * ⚠️ 读缓存而非 `await loadModels()` 是**正确**的：RPC 路径在调用本方法**之前**
   * 已先 `await llm.listModels(provider)`（`channel-pack-rpc.ts:2011`），
   * 而 `listModels` 内部会 `await this.loadModels()` 落缓存。
   * 与 `raccoon-adapter.ts:229-232` 逐字同构。
   */
  listAllModels(): readonly { id: string; name: string }[] {
    const source = this.remoteModels ?? minimaxFallbackEntries(this.product)
    return source.map((model) => ({ id: model.id, name: model.name }))
  }

  private inputModalitiesFor(
    entry: MinimaxModelEntry | undefined,
  ): readonly ('text' | 'image')[] {
    return entry?.supportsImage === true ? ['text', 'image'] : ['text']
  }

  async listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    // ⚠️ 无已登录账号时返回 `[]` → DSH 把整个 provider 分组隐藏。
    // **必须返回空数组而不能抛错**（抛错会多一条 provider 报错）。
    if (!await providerCatalogVisible(this.options.accountPool, this.product.id)) return []

    const all = await this.loadModels()
    const disabled = this.options.accountPool?.disabledModelsFor(this.product.id)
    const listed = disabled === undefined || disabled.size === 0
      ? all
      : all.filter((model) => !disabled.has(model.id))

    return listed.map((model) => ({
      provider: this.product.id,
      id: model.id,
      name: model.name,
      inputModalities: this.inputModalitiesFor(model),
    }))
  }

  async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const all = await this.loadModels()
    const entry = all.find((item) => item.id === model)
    const resolved: LlmResolvedModelInfo = {
      provider,
      id: model,
      name: entry?.name ?? model,
      inputModalities: this.inputModalitiesFor(entry),
    }
    // ⚠️ 未知模型不编造 context（宁可让 DSH 用默认值，也不报一个假窗口）
    if (entry !== undefined && entry.contextWindow > 0) {
      resolved.context = { contextWindow: entry.contextWindow }
    }
    // ⚠️ 远端非法值必须过滤：0/负数/NaN 会让 DSH 抛 INVALID_MODEL_MAX_TOKENS，
    // **整轮对话起不来**（不是降级，是崩）
    // ⚠️ 先取出局部变量再判：`entry.maxTokens` 是可选属性，直接写
    // `Number.isSafeInteger(entry.maxTokens) && entry.maxTokens > 0` 时
    // `Number.isSafeInteger` 带 `number` 形参，**不做**类型收窄，`strict` 下
    // 第二个条件会报 TS18048（'entry.maxTokens' is possibly 'undefined'）。
    // 取出局部变量后 `!== undefined` 即可正常收窄，判据本身（safe integer + > 0）
    // 与 brief 完全一致；`raccoon-adapter.ts` 的 `positiveMaxTokens` 同款写法。
    const maxTokens = entry?.maxTokens
    if (maxTokens !== undefined && Number.isSafeInteger(maxTokens) && maxTokens > 0) {
      resolved.defaultMaxTokens = maxTokens
    }
    // ⚠️ 只有 M3.1-Flash-Preview 有档位；其余返回 undefined 表示不声明
    if (entry !== undefined) {
      const reasoning = minimaxReasoningInfo(entry)
      if (reasoning !== undefined) resolved.reasoning = reasoning
    }
    return resolved
  }

  /** 兼容 0.1.1-rc.2 的 `prepareCall` shim（与其余适配器同款）。 */
  async prepareCall(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<{
    model: LlmResolvedModelInfo
    stream: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  }> {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options: GenerateOptions) => this.stream(options),
    }
  }

  /**
   * 走 **Anthropic Messages** 协议发一次流式请求。
   *
   * ⚠️ 凭据过期先静默续期一次（与其余九个适配器同款）。
   *
   * ⚠️ **错误必须抛错**，不静默返回空流（Qoder 早期同型缺陷）。
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    let credential = await this.options.resolveCredential(options.model)
    if (credential === undefined || isMinimaxExpired(credential)) {
      await this.options.refresh()
      credential = await this.options.resolveCredential(options.model)
    }
    if (credential === undefined || credential.access_token === '') {
      throw new LlmError('minimax: no usable credential; log in first', 'MISSING_CREDENTIAL')
    }

    const entry = (await this.loadModels()).find((item) => item.id === options.model)

    // ⚠️ 图片：先判定模型是否支持，再内联。
    // **不能**放宽成「总是接受」：DSH 按适配器播报的 `inputModalities` 决定要不要
    // 把图片投影成文本占位符，声明支持就必须真支持；声明不支持却收到图片
    // 应当**报错**而不是发出去让服务端 400。
    const imageRefs = new Map<string, unknown>()
    for (const message of options.messages) {
      if (Array.isArray(message.content)) collectImages(message.content, imageRefs)
    }
    let images: Map<string, MinimaxInlineImage> | undefined
    if (imageRefs.size > 0) {
      if (entry?.supportsImage !== true) {
        throw new LlmError(
          `minimax: 模型 "${options.model}" 不支持图片输入`,
          'UNSUPPORTED_CONTENT',
        )
      }
      if (this.options.readImage === undefined) {
        throw new LlmError(
          'minimax: 图片输入需要附件服务（readImage 未提供）',
          'UNSUPPORTED_CONTENT',
        )
      }
      images = new Map()
      const readImage = this.options.readImage
      for (const [id, ref] of imageRefs) {
        const inline = await readImage(ref)
        if (inline === undefined) continue
        // ⚠️ Anthropic 的 `source.data` 要**裸 base64**，不加 `data:` 前缀
        //（实测；加前缀是否为 400 未单独验证，但没必要冒这个风险）。
        images.set(id, {
          mediaType: inline.mediaType,
          data: Buffer.from(inline.data).toString('base64'),
        })
      }
    }

    // ⚠️ **只有 M3.1-Flash-Preview 必须 adaptive**：实测传 `disabled` 会被拒
    //（`400 ... requires adaptive thinking ... not allowed (2013)`）。
    // 其余模型不发 thinking 即接受（实测 200），且服务端默认会思考。
    const requiresAdaptiveThinking = options.model.startsWith(MINIMAX_ADAPTIVE_ONLY_PREFIX)
    // ⚠️ 档位合法性：不仅要「在 effortOptions 里」，还要考虑 `none`
    //（「关闭思考」）—— 它是我们**为 switchable 模型追加**的档，
    // **不在**远端 `effortOptions` 里，故不能只按 effortOptions 过滤。
    // 判据与 `minimaxReasoningInfo` 的产出**保持一致**（否则 UI 给了选项、
    // 请求却把它丢掉 —— 用户选了「关闭思考」而模型仍在思考）。
    const requested = options.reasoningEffort === undefined
      ? undefined
      : String(options.reasoningEffort)
    const declared = entry === undefined ? undefined : minimaxReasoningInfo(entry)
    const effort = requested !== undefined
      && declared?.efforts.some((e) => String(e.id) === requested) === true
      ? requested
      : undefined

    const payload = buildMinimaxMessagesPayload({
      model: options.model,
      messages: options.messages,
      system: options.system,
      tools: options.tools,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      stop: options.stop,
      effort,
      requiresAdaptiveThinking,
      ...images === undefined ? {} : { images },
    })

    const response = await fetch(`${this.product.apiHost}${MINIMAX_INFER_PATH}`, {
      method: 'POST',
      headers: minimaxInferHeaders(credential),
      body: JSON.stringify(payload),
      signal: options.signal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      // ⚠️ 402 是**余额不足**，必须原样透出 —— 它是最常见的真实失败，
      // 归成 SERVER/AUTH 会让用户看不到「去充值」这个唯一有效动作。
      const code = response.status === 402 ? 'QUOTA_EXCEEDED' : httpErrorCode(response.status)
      throw new LlmError(
        `minimax: HTTP ${response.status}${text === '' ? '' : ` — ${text.slice(0, 500)}`}`,
        code,
        { status: response.status },
      )
    }
    if (response.body === null) {
      throw new LlmError('minimax: 响应缺少 body', 'EMPTY_RESPONSE')
    }

    yield* consumeMinimaxSse({ body: response.body, signal: options.signal })
  }
}

/** 在 `ctx.llm` 上注册 minimax provider 路由与适配器。 */
export function registerMinimaxLlm(
  ctx: Context,
  options: MinimaxAdapterOptions,
): MinimaxAdapter {
  const product = options.product ?? MINIMAX
  const adapter = new MinimaxAdapter(options)
  registerAdapterIdempotent(ctx.llm, [product.id], adapter)
  return adapter
}
