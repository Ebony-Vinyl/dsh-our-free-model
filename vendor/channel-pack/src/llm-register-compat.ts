/**
 * `ctx.llm` 适配器注册的**重启幂等**包装。
 *
 * ## ⚠ 为什么需要（真实故障，2026-09-30 合并 master 后）
 *
 * 合并当晚 web profile 的插件树激活失败，**整个 Channel Pack RPC 不可用**
 *（所有 provider 面板 404）：
 *
 * ```
 * LlmError: configurable provider "minimax" is already declared
 *   at registerConfigurableProviders (…/dsh-llm/lib/index.js:1937)
 *   at registerMinimaxLlm (lib/minimax-adapter.js:352)
 *   at new apply (lib/index.js:920)
 * ```
 *
 * ## 根因（cordis + dsh-llm 的生命周期交互）
 *
 * `ctx.llm.registerAdapter()`（以及当时的 `registerConfigurableProviders()`）内部都是
 * `this.ctx.effect(…)` —— **effect 挂在 llm 服务的 ctx 上**（`super(ctx,'llm')`
 * 的那个），其生命周期绑定**宿主根 zone**。而插件 apply 里注册的**其它**资源
 * 挂在插件 fiber 上。当宿主在启动过程中**重启插件 fiber**（config/patch 应用
 * 时序），新 fiber 的同步 apply 与旧 fiber 的异步 dispose（cordis 1077 行：
 * `return async () => {…}`）**交错执行**：
 *
 * - 新 apply 逐个注册 provider —— 每个都调 `directory.has()` 检查；
 * - 旧 dispose **异步地**逐个清理 —— 两者在 `directory` 这个 Map 上赛跑。
 *
 * 赛跑的**确定性结果**取决于 Map 的插入/删除顺序与两边步调 —— 实测稳定撞在
 * 序列后段的 `minimax`（它紧邻合并新增的 zcode，注册时间最长，给异步 dispose
 * 留下了追上来的窗口）。既有 10 个 provider 从没撞过，是因为它们的注册序更靠前、
 * dispose 追不上；minimax 是**第 11 个**，恰好越过了临界点。
 *
 * ## 修复语义
 *
 * `an adapter for provider … is already declared` 意味着「**同名的注册已存在**」。
 * 在重启场景下那是**上一轮同一个插件的注册**（同一代码）—— 保留它、跳过本次提交
 * 是**语义等价**的：路由同样指向等价的实现。
 *
 * ⚠ 这**不是**吞错误：非重复类失败照常抛出（配置错等必须暴露）。
 * 也没有用「先查 directory 再注册」——查与注册之间存在同样的竞态窗口，
 * 只有 try/catch 能把检查与提交做成原子。
 *
 * ## ⚠ configurable provider 声明已**刻意停用**（2026-10-01，用户要求）
 *
 * **现象**：「设置 → 模型 → 提供商」里常驻十二行本插件的 provider（codearts /
 * buddy / workbuddy / lobsterai / qoder / qodercn / trae / cline / loomy /
 * raccoon / minimax / zcode），每行都带 API 密钥、baseURL 与模型目录编辑框，
 * 但这些对本插件**没有意义** —— 凭据由 Channel Pack 账号池 + `ctx.credentials` 注入，
 * 模型开关与模型目录也都在 Channel Pack 设置页管理。
 *
 * **机制**（依据 `dsh-client-ui-settings-models` 的产物源码）：
 * - 该页的行**只**来自 `ctx.llm.registerConfigurableProviders()` 声明的目录
 *   （`joinProviderDirectory()`：声明过的进目录行，未声明的存活路由只进模型选择器）；
 * - 「已配置」的判据是 `namespace 存在 && (settingsPath.length === 0 ||
 *   schema.getPath(namespace.value, settingsPath) !== undefined)`（`configured`）；
 *   本插件传的 `settingsPath: []` 使该条件**恒真** —— 于是它们不是「待设置卡片」，
 *   而是十二行常驻的已配置行，永远无法从页面上消失。
 *
 * **代价评估**（均在 DSH 0.2.0-rc.2 的打包产物里逐条核对）：
 * - **模型选择器不受影响**：未声明的存活路由在各选择器中仍然可见（dsh-llm 文档明示）；
 * - **首次运行引导不受影响**：`providerUsable()` 对「没有 settings 地址的活跃路由」
 *   返回 true，故不会因此重新弹出官方 DeepSeek 凭据步骤；
 * - `dsh-api-session-controller` 的 `hasProviderApiKey` 扫的是各 provider profile 的
 *   `apiKeyEnv`，本插件的 namespace 里没有该字段，本就恒为 false。
 *
 * **因此**：各 adapter 的 `registerXxxLlm` 只调 {@link registerAdapterIdempotent} 注册
 * 路由，**不再**声明可配置 provider。**恢复方式**：从 git 历史取回本文件的旧版本
 *（含 `registerConfigurableProvidersIdempotent`），在十个 adapter 的 `registerXxxLlm`
 * 里恢复 `ctx.llm.registerConfigurableProviders([...])` 声明块，并恢复
 * `settingsNamespaceFor()` 的调用 —— 该函数与 `ownEntryId` 仍保留在
 * `settings-compat.ts` 中（当前无调用方）。
 */

import { withDeadModelPruning } from './dead-model-store.js'
import { FALLBACK_IMAGE_PRICING } from '../../../src/image-pricing.js'

/** dsh-llm 对「configurable provider 已存在」抛的 code。**当前仅作防御**保留。 */
const DUPLICATE_DIRECTORY = 'DUPLICATE_DIRECTORY'

/**
 * 判断一个 LlmError 是否为「同名注册已存在」。
 *
 * ⚠ 判据**必须**含错误码 **或** 文案：dsh-llm 对 adapter 重复的抛错
 *（`an adapter for provider "x" is already declared`）用的不是
 * DUPLICATE_DIRECTORY 码，且不同 dsh 版本的码可能微调 —— 文案兜底保证
 * 跨版本行为一致。⚠ 只匹配「already declared / already registered」这类
 * 精确语义，不碰泛词（否则会把真实配置错误吞掉）。
 */
function isDuplicateRegistrationError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  if (code === DUPLICATE_DIRECTORY) return true
  const message = (error as { message?: unknown }).message
  if (typeof message !== 'string') return false
  return /already declared|already registered|is already (?:a|an) adapter/.test(message)
}

/**
 * configurable provider 目录项的入参（透传 dsh-llm 契约）。
 *
 * ⚠ 本插件**当前不再产生**这类注册（见模块头），保留该类型只是为了让
 * {@link AdapterRegisterTarget} 如实描述 dsh-llm 的接口形状。
 */
export interface ConfigurableProviderEntry {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
}

/** {@link registerAdapterIdempotent} 的入参（透传 dsh-llm 契约）。 */
export interface AdapterRegisterTarget {
  registerConfigurableProviders(entries: readonly ConfigurableProviderEntry[]): unknown
  registerAdapter(providers: readonly string[], adapter: unknown): unknown
}

import { recordTokenUsage, peekLedgerAccount } from './token-ledger.js'
import { channelOfOptions } from './openai-gateway/channel.js'

/**
 * dsh-llm 对 adapter 的最小形状契约；流式记账和缺失视觉计价在注册边界补齐。
 */
export interface StreamCapableAdapter {
  stream(options: never): AsyncIterable<unknown>
  [key: string]: unknown
}

/**
 * 把适配器包上 **Token 记账**（issue「本地 Token 计数」第 1 期的单点接入）。
 *
 * ## 为什么要在这里包（而不是改 13 个适配器）
 *
 * 全部 provider 的注册都收敛到 {@link registerAdapterIdempotent} —— 在它内部
 * 包一层，一处代码覆盖全仓库，且**完全不碰各适配器的推理路径**。包装只做三件事：
 *
 * 1. 透传 `stream()` 产出的**每一个** chunk（逐帧 `yield`，不改内容、不改顺序）；
 * 2. 捕获 `type:'usage'` 的 chunk 写账本（usageReported = true）；
 * 3. 捕获抛错写账本（usageReported = false + error），然后**原样再抛**——
 *    记账绝不吞错、也绝不反噬推理（`recordTokenUsage` 自身也不抛）。
 *
 * ## 渠道判定
 *
 * `options` 上带网关的 `GATEWAY_CHANNEL_MARK`（`src/openai-gateway/channel.ts`
 * 打标）→ `gateway`，否则 `direct`。打标丢失只会保守记成 direct，不会错账
 * （见 channel.ts 模块头的退化分析）。
 *
 * ## provider / model 的取值
 *
 * - provider：注册时的 `providers[]`（路由名，与 UI 的 provider 一致）；
 * - model：`options.model`（wire 口径）。
 *
 * ## ⚠️ 为什么用 Proxy 而不是 `{ ...adapter }` 展开（真实缺陷，写完即被测试抓住）
 *
 * 适配器是 **class 实例**，`providerInfo` / `listModels` / `resolveModel` 等
 * 方法都在**原型**上。对象展开只拷贝自有可枚举属性 —— 实例字段会留下，
 * 但全部原型方法会被丢掉，于是 `listModels()` 变成 "not a function"，
 * Channel Pack 的模型目录整体失效。`Proxy` 的 get 陷阱把**一切属性访问**转给
 * 原适配器（含原型链），只有 `stream` 被截获替换 —— 语义是「同一个适配器，
 * 换了个带记账的 stream」，而不是「拷贝了一个看起来像的」。
 *
 * ⚠️ **重复注册分支不包**：重启竞态时保留的是**上一轮已包装的路由**（同一代码），
 * 对它再包一层只会造成双记。`try` 分支（新注册）才包装。
 */
export function wrapAdapterWithTokenLedger<T extends object>(providers: readonly string[], adapter: T): T {
  const provider = providers[0] ?? ''
  /**
   * 把一次流式调用包上记账（顶层 `stream` 与 `prepareCall` 返回的 `call.stream`
   * 共用同一实现，口径才不会分叉）。
   */
  const accountingStream = (options: unknown, open: () => AsyncIterable<unknown>): AsyncIterable<unknown> => {
    const channel = channelOfOptions(options)
    const model = String((options as { model?: unknown })?.model ?? '').slice(0, 160)
    return recordThroughStream(open, { channel, provider, model, startedAt: Date.now() })
  }

  return new Proxy(adapter, {
    get(target, prop) {
      if (prop === 'imageRequestPricing') {
        return (provider: string, model: string) => {
          const original = Reflect.get(target, prop, target) as unknown
          // 保留厂商已提供的同步计价；原对象作为 this，兼容适配器私有字段。
          const pricing = typeof original === 'function' ? original.call(target, provider, model) : undefined
          return pricing ?? FALLBACK_IMAGE_PRICING
        }
      }
      if (prop === 'stream') {
        // ⚠️ `this` 必须绑回**原适配器**（target 而不是 proxy）：真实适配器的
        // 私有字段（`#field`）对 proxy 的 this 不可见，绑 proxy 会抛 TypeError。
        return (options: never) => accountingStream(
          options,
          () => (target as unknown as StreamCapableAdapter).stream.call(target, options) as AsyncIterable<unknown>,
        )
      }
      /**
       * ⚠️⚠️ **必须同时包装 `prepareCall` 返回的 `call.stream`**（真实缺陷，2026-10-06）。
       *
       * **生产路径只走这里**：dsh-llm 的 `adapterStream` 用
       * `adapter.prepareCall(...)` 拿到的 `adapterCall.stream(options)` 派发
       *（`node_modules/@deepseek-ai/dsh-llm/lib/index.js`：
       * `dispatch = (options) => adapterCall.stream(options)`），
       * **从不直接调用顶层 `adapter.stream`**。
       *
       * 早先只拦顶层 `stream` 时，记账之所以「碰巧」生效，全靠各适配器的
       * `prepareCall` 恰好写成转发形式 `stream: (o) => this.stream(o)`，且调用方
       * 经 Proxy 取 `prepareCall` 时 `this` 落在 Proxy 上 —— 这是一条**隐式依赖**：
       * 任何适配器改成持有闭包引用（或在包装层用 `.bind(原对象)`）就会**静默失效**
       * （请求照常、账本永远为空）。已实测：闭包式 prepareCall 下记账 = 0 条。
       *
       * ⇒ 显式包装返回的 `call.stream`，与顶层 `stream` **共用同一实现**（保证
       * 口径一致），不再依赖 `this` 的绑定链。
       * 同一根因的既有教训见 `src/dead-model-store.ts`（PR !66 复审）。
       */
      if (prop === 'prepareCall') {
        const original = Reflect.get(target, prop, target) as unknown
        if (typeof original !== 'function') return original
        return async (...args: unknown[]): Promise<unknown> => {
          const call = await (original as (...a: unknown[]) => Promise<unknown>).apply(target, args)
          if (call === null || typeof call !== 'object') return call
          const inner = (call as { stream?: unknown }).stream
          if (typeof inner !== 'function') return call
          return {
            ...(call as object),
            // ⚠️ 只包 `stream` 这一个字段，其余（modelInfo 等）原样透传。
            stream: (options: unknown) => accountingStream(
              options,
              () => (inner as (o: unknown) => AsyncIterable<unknown>).call(target, options),
            ),
          }
        }
      }
      return Reflect.get(target, prop, target)
    },
  })
}

/**
 * 包住一次流式调用的**记账骨架**（与 {@link wrapAdapterWithTokenLedger} 配套）。
 *
 * 独立成函数是为了能用假适配器做行为单测（不必起真实 provider）。
 *
 * 语义：
 * - 正常结束且没等到 usage ⇒ 记 `usageReported: false`（显示 `—` 不显示 0）；
 * - 流内出现过 usage（哪怕 0 token）⇒ 记 `usageReported: true`；
 * - 抛错 ⇒ 记失败行后**原样再抛**（记账不吞错）；
 * - `finally` 兜底记 `durationMs`（cancel/提前 return 也算一笔）。
 */
export async function* recordThroughStream(
  openStream: () => AsyncIterable<unknown>,
  meta: { channel: 'direct' | 'gateway'; provider: string; model: string; startedAt: number },
): AsyncIterable<unknown> {
  let usageReported = false
  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens: number | undefined
  let cacheWriteTokens: number | undefined
  let reasoningTokens: number | undefined
  /**
   * **首个内容块耗时**（第 3 期）：收到任何一块（含思考增量）的时刻 − 发起。
   * 0 = 还没有任何块。口径与 `cline-request-log.ttftMs` 一致 —— 用户口中的
   * 「首字用时」。**必须在收块时测量**：包装层是唯一同时知道「发起时刻」与
   * 「每块到达时刻」的位置（各适配器内部没有统一的测量点）。
   */
  let ttftMs = 0
  /**
   * 账号归属（第 2 期）：**usage 帧到达时**从回报表读取（彼时凭据必然已
   * 解析 —— `resolveCredential` / 池查询先于任何 SSE 帧）。流开始前读取
   * 会拿到「上一笔请求的账号」（生成器懒执行的时序陷阱），在 usage 帧
   * 时读才是「本笔请求已解析出凭据」的时刻。精度边界见
   * `token-ledger.ts` 的 `reportedAccounts` 注释。
   */
  let accountId = ''
  let failure: string | undefined
  try {
    for await (const chunk of openStream()) {
      // 首块计时：任何 chunk（思考/正文/工具调用都算「模型开始说话」）。
      // ⚠️ 必须在具体类型判断**之前**：漏块会让「只有思考增量的慢启动」被记成 0。
      if (ttftMs === 0) ttftMs = Date.now() - meta.startedAt
      if (
        typeof chunk === 'object' && chunk !== null
        && (chunk as { type?: unknown }).type === 'usage'
      ) {
        // dsh-llm 契约：usage chunk 的形状 { type:'usage', usage: TokenUsage }。
        const usage = (chunk as { usage?: Record<string, unknown> }).usage
        if (typeof usage === 'object' && usage !== null) {
          usageReported = true
          inputTokens = Number(usage.inputTokens)
          outputTokens = Number(usage.outputTokens)
          if (Number(usage.cacheReadTokens) > 0) cacheReadTokens = Number(usage.cacheReadTokens)
          if (Number(usage.cacheWriteTokens) > 0) cacheWriteTokens = Number(usage.cacheWriteTokens)
          if (Number(usage.reasoningTokens) > 0) reasoningTokens = Number(usage.reasoningTokens)
          if (accountId === '') accountId = peekLedgerAccount(meta.provider)
        }
      }
      yield chunk
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    // ⚠️ finally 里记账（而不是成功分支）：cancel / 提前 return / 抛错都必须落账。
    // durationMs 用「现在 − 发起」：成功与失败同口径，就是请求全程耗时。
    // 账号兜底：失败请求可能没等到 usage 帧（彼时才读账号）——失败行的
    // 归属退回「最后一次解析出的账号」，比留空有用（排查「哪个号挂了」）。
    if (accountId === '') accountId = peekLedgerAccount(meta.provider)
    recordTokenUsage({
      channel: meta.channel,
      provider: meta.provider,
      model: meta.model,
      ...(accountId.length > 0 ? { accountId } : {}),
      usageReported,
      inputTokens,
      outputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
      ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
      // 首字用时（0 = 无任何块 → recordTokenUsage 内省略该字段）
      ...(ttftMs > 0 ? { ttftMs } : {}),
      durationMs: Date.now() - meta.startedAt,
      ...(failure !== undefined ? { error: failure } : {}),
    })
  }
}

/**
 * 幂等版的 `ctx.llm.registerAdapter`。
 *
 * ⚠ 重复场景下的行为：保留现有 adapter 路由（重启竞态，见模块头）。
 * ⚠ 返回 dsh-llm 的 handle（含 `.replace()`）——重复分支没有 handle 可还，
 * 返回 `undefined`；调用方若需要 replace 能力应保存成功路径的返回值。
 *
 * ## 顺带做 Token 记账包装
 *
 * ⚠ 成功路径注册的是**记账包装**（`wrapAdapterWithTokenLedger`），重复分支
 * **不再包一层**（上一轮已是包装后的路由，再包会双记）。
 *
 * ## 顺带做「已失效模型」剔除包装
 *
 * 本函数是**全部适配器**的唯一注册入口，故在这里统一包装，避免十四个
 * `registerXxxLlm` 各写一遍（见 `dead-model-store.ts` 模块头：为什么不能改用
 * 「远端目录比对」，以及为什么判据必须是**阳性证据**）。
 *
 * ⚠ 包装失败**不阻断注册** —— 它只是显示层的收敛，回退到原适配器即可，
 * 不能因为它挂掉导致整个 provider 起不来。
 *
 * ## ⚠ 两层包装的顺序（曾一度是语义性的，现已不敏感）
 *
 * 当前顺序是 **记账在内、剔除在外**：
 *
 * ```ts
 * withDeadModelPruning(providers, wrapAdapterWithTokenLedger(providers, adapter))
 * ```
 *
 * **历史**（值得记住，因为它是一类极易复发的缺陷）：`wrapAdapterWithTokenLedger`
 * 早先**只拦顶层 `stream`**，而 dsh-llm 的 `adapterStream` 走的是
 * `adapter.prepareCall(...)` 返回的 `adapterCall.stream(options)`
 *（`dsh-llm/lib/index.js`：`dispatch = (options) => adapterCall.stream(options)`），
 * **从不直接调用顶层 `adapter.stream`**。当时记账之所以生效，全靠各适配器的
 * `prepareCall` 恰好写成 `stream: (o) => this.stream(o)`、且 `this` 落在 Proxy 上
 * —— 一条**隐式依赖**：顺序写反（或任一适配器改成闭包引用）就**静默失效**。
 *
 * ⇒ 现已**显式包装 `prepareCall` 返回的 `call.stream`**（见
 * `wrapAdapterWithTokenLedger` 的注释），因此**两种顺序都能记账**，不再依赖
 * `this` 绑定链。顺序仍保持「记账在内」只是为了与既有注释/测试一致。
 *
 * ⚠️ 同根因的既有教训见 `src/dead-model-store.ts`：只包 `stream` 会让包装
 * **在生产环境完全不生效**（单测却全绿，因为直接调了 `proxy.stream`）。
 * **通用手法：别问「哪个成员被包了」，去 `node_modules` 读消费者的真实调用链。**
 *
 * 回归用例：`tests/unit/token-ledger-wiring.spec.ts` 的「两层包装的嵌套顺序」段
 *（按 dsh-llm 的 `prepareCall → call.stream` 真实路径驱动，含闭包式适配器用例）。
 */
export function registerAdapterIdempotent(
  llm: AdapterRegisterTarget,
  providers: readonly string[],
  adapter: unknown,
  warn?: (message: string) => void,
): unknown {
  // ⚠️ 顺序语义（见函数 doc）：**记账在内、剔除在外**。
  //    剔除 Proxy 调用 prepareCall 时 this 绑到它包着的记账 Proxy，
  //    于是 this.stream 命中记账陷阱；反过来则 this 落到裸适配器、记账被绕过。
  let target = wrapAdapterWithTokenLedger(providers, adapter as object)
  if (typeof adapter === 'object' && adapter !== null) {
    try {
      target = withDeadModelPruning(providers, target)
    } catch (error) {
      warn?.(`[llm-register] 已失效模型剔除包装失败，使用原适配器: ${String(error)}`)
    }
  }
  try {
    return llm.registerAdapter(providers, target)
  } catch (error) {
    if (!isDuplicateRegistrationError(error)) throw error
    warn?.(
      `[llm-register] adapter for ${providers.map((p) => `"${p}"`).join(', ')} `
      + '已注册（插件 fiber 重启竞态），保留现有路由并跳过本次注册',
    )
    return undefined
  }
}
