/**
 * Qoder 产品配置。
 *
 * Qoder 的协议与现有四个 provider **都不同源**：
 *
 * ## 数据来源
 *
 * 全部来自本机 Qoder 0.3.4 产物逆向 + 实测，详见
 * `docs/superpowers/specs/2026-09-19-qoder-provider-design.md` §2。
 * 逆向目标：
 * - `C:\Users\Jet\AppData\Local\Programs\Qoder\resources\app.asar`
 * - `...\@qoder-ai\qoder-agent-sdk\dist\_worker\qoder-worker-runtime.obf.mjs`
 *   （字符串经 `_$d = base64 → XOR("tqrRVttEZQ4G")` 编码）
 */

/** 兜底模型目录中的一个条目（字段口径见下方 `QODER_FALLBACK_MODELS` 的注释）。 */
export interface QoderFallbackModel {
  /** 模型目录 **key**（如 `qfmodel`）。
   * ⚠️ **必须走加密端点** `agent_chat_generation` —— 公开的
   * `/model/v1/chat/completions` 不认这些 key（见 `src/qoder-wasm.ts`）。 */
  id: string
  /** 展示名（取自目录 `display_name`）。 */
  name: string
  /**
   * 上下文窗口（**总上下文**，DSH 以它 × 0.8 作压缩阈值）。
   *
   * ⚠️ 取目录 `context_config` **档位表的最大档**，**不是** `max_input_tokens`。
   * 两者经常自相矛盾（CN `dmodel`：`max_input_tokens` 96000、档位表却到 1M），
   * 而官方客户端只认档位表 —— 详见 `QODER_CN_FALLBACK_MODELS` 前的长注释。
   * `auto` 这类没有档位表的条目才退回 200K。
   */
  contextWindow: number
  /** 是否接受图片输入（远端 `is_vl`；实测 17 个全为 true）。 */
  supportsImage?: boolean
  /** 是否支持思考档位（远端 `is_reasoning`）。 */
  supportsThinking?: boolean
  /** 是否免费额度模型（远端 `is_free`）。 */
  isFree?: boolean
  /**
   * 计费倍率（目录 `price_factor`）。
   *
   * ⚠️ 字段名是 **`price_factor`**，不是 `cost_multiplier`（后者不存在于
   * Qoder 目录；`cost_multiplier` 是有道 LobsterAI 的字段，别混淆）。
   *
   * ⚠️ **它是「目录下发那一刻」的生效价，会随错峰窗口变化** ——
   * 窗口内是折后价、窗口外是原价。因此本表存的是**采集时刻的值**，
   * 展示时须结合 {@link QoderModelPromotion} 的窗口**本地推算**当前价
   * （见 `qoderDisplayName`），不要把它当成恒定原价。
   *
   * 实测本机 catalog（2026-09-21，17 个 chat 模型）：
   * `qfmodel`（Qwen3.8-Flash）= **0**、`qmodel` = 0.04、`qmodel_latest`/
   * `dfmodel`/`gfmodel` = 0.1 …… `smodel`（Sonus）= 8。
   *
   * **0 是合法值**（免费），故不能用 `!== undefined && > 0` 过滤 ——
   * 那会把用户最关心的免费模型漏掉。
   */
  priceFactor?: number
  /**
   * 促销前的原价倍率（目录 `original_price_factor` / `before_promotion_price_factor`）。
   *
   * 与 {@link priceFactor} 是**两个独立字段**：实测 `qfmodel` 的
   * `price_factor=0` 而 `original_price_factor=0.1`，即免费额度是在原价
   * 0.1 的基础上打折到 0。只在两者不同时才值得展示。
   */
  originalPriceFactor?: number
  /**
   * 错峰折扣（目录 `promotion`）。
   *
   * ⚠️ **`active` 是「目录下发那一刻」的快照，不可作为长期判据**：
   * 用户长时间不重启客户端时它会过期。真实窗口由 `windowStart`/`windowEnd`
   * 描述且稳定，故展示时**按当前时间本地推算**是否在窗口内
   * （见 `qoderDisplayName` 的 `promotionActiveNow`），`active` 仅作回退。
   *
   * 实测三档（`qfmodel` 无 promotion；`qmodel_38max` 是 4 折、
   * `qmodel_latest` 是 2 折），窗口统一为 22:00–08:00（Asia/Singapore）。
   *
   * 关系式（实测三条全部吻合）：
   * `priceFactor === beforePromotionPriceFactor × discountFactor`
   * —— 故可据原价与折扣推算任意时刻的生效价。
   */
  promotion?: QoderModelPromotion
  /**
   * 可选思考档位（远端 `thinking_config.enabled.efforts` 的**键**）。
   *
   * ## ⚠️ 三个必须记住的口径
   *
   * 1. **取值来源是 `efforts` 的键名，不是值**：目录形如
   *    `efforts: { xhigh: {}, low: {}, medium: { is_default: true } }`，
   *    键即档位 id。本字段按**目录原始顺序**保存（客户端也按对象键序渲染）。
   * 2. **`*`（`is_default`）是"默认选中"，不是"多选"**：
   *    IDE 里是**下拉单选**，「极高/低/中」三选一，默认落在「中」
   *    （见 {@link defaultEffort}）。
   * 3. **「关闭思考」不在这个数组里** —— 它由 `disabled` 分支决定，
   *    通过 {@link supportsDisable} 表达。客户端是在 `gU()` 里**追加** `none` 的：
   *    `gU(A){ let e=…efforts; return A.supports_disabled||A.supportsDisabled||e.includes("none") ? e : [...e,"none"] }`
   *    —— 故这里**不要**手动塞 `none`，否则会与 `supportsDisable` 语义重复。
   *
   * ⚠️ **档位必须在客户端的白名单内**才会被接受，不在的会被 `ao()`
   * **静默丢弃**。白名单（asar 常量 `Qj`）：
   * `['none','low','medium','high','xhigh','max']`；
   * 另有别名表 `_lc`：`disabled`→`none`、`off`→`none`。
   * 官方 UI 的中文名（asar i18n `settings.efforts`）：
   * `none:关闭思考 / minimal:最小 / low:低 / medium:中 / high:高 / xhigh:极高 / max:最大`。
   */
  efforts?: readonly string[]
  /**
   * 默认思考档位（目录 `efforts.<key>.is_default === true` 的那一项）。
   *
   * ⚠️ **必须落在 {@link efforts} 内**，否则 DSH 会拿一个不存在的档位发请求
   * （同 `trae-adapter.ts` 的教训：给不存在的档位会抛 `UNSUPPORTED_REASONING_EFFORT`）。
   * 无 `is_default` 时不设该字段，让 DSH 显示「Default」由上游自行决定。
   */
  defaultEffort?: string
  /**
   * 是否提供「关闭思考」（目录 `thinking_config.disabled` 分支存在即 true）。
   *
   * ⚠️ 与 {@link efforts} **相互独立**：实测 `gfmodel` / `gmodel` / `kmodel` 等
   * 有档位但**不能关闭**（目录无 `disabled`），而 CN 的 `qmodel` / `qmodel_latest`
   * **没有档位但能关闭**（目录只有 `disabled` + `enabled.is_default`，
   * 无 `efforts` 键）。两者不能用一个标志表达。
   */
  supportsDisable?: boolean
}

/** 目录 `promotion` 字段（错峰折扣）。 */
export interface QoderModelPromotion {
  /**
   * 目录下发时是否处于折扣时段内（远端 `active`）—— **快照值，会过期**。
   *
   * 长期运行的会话里它会与真实时段脱节，故只作回退：
   * `windowStart`/`windowEnd` 齐备时以**本地时间推算**为准。
   */
  active: boolean
  /** 折扣后倍率（远端 `discount_factor`），如 0.4 = 4 折。 */
  discountFactor?: number
  /** 折扣前倍率（远端 `before_promotion_price_factor`）。 */
  beforePromotionPriceFactor?: number
  /** 时段起点（远端 `window_start`，如 `22:00`）。 */
  windowStart?: string
  /** 时段终点（远端 `window_end`，如 `08:00`）。 */
  windowEnd?: string
  /**
   * 中文角标文案（远端 `badge.zh`，如「错峰 4 折」）。
   */
  badgeZh?: string
}

/**
 * Qoder 产品配置。
 */
export interface QoderProduct {
  /**
   * provider 标识：注册到 `ctx.llm` 的路由名，也是账号列表的 provider 字段值。
   *
   * ⚠️ 两个取值**共用同一套协议实现**（`qoder.ts` / `qoder-oauth.ts` /
   * `qoder-credits.ts` / `qoder-adapter.ts` / `qoder-wasm.ts`）—— 中国版与国际版
   * 的差异全部是本配置里的字段值，不存在「CN 要另写一份协议」的情况。
   * 新增同族产品时只加本联合类型的值与一份配置，**不要**复制实现文件。
   */
  id: 'qoder' | 'qodercn'
  /** 设置页 / 模型选择器展示名。 */
  displayName: string
  /** 登录与 OAuth 基址。 */
  authBase: string
  /** OpenAPI 基址（轮询、续期、userinfo 都走它）。 */
  openApiBase: string
  /**
   * 推理基址（**公开的 OpenAI 兼容端点**）。
   *
   * ⚠️ **不是** `environments.prod.inferBaseUrl`（那是 `https://api2.qoder.sh`）。
   * 推理实际走独立的 model server host `api2-v2.qoder.sh`
   * （源码 `Sja = { prod: "api2-v2.qoder.sh", ... }`）。
   *
   * ⚠️ 该端点只认**通用模型名**（`qwen-flash` 等），**不认目录 key**
   * （`qfmodel` → `Unsupported model`）。要按目录 key 推理必须走
   * `encryptedInferBase`。
   */
  inferBase: string
  /**
   * **加密推理**基址（`agent_chat_generation` 端点所在 host）。
   *
   * ⚠️ 与 `inferBase` **不是同一个 host**：加密端点走 `api2.qoder.sh`
   * （即源码里的 `environments.prod.inferBaseUrl`），实测写错会 404。
   * 请求体由 `src/qoder-wasm.ts` 加密，该端点**认模型目录 key**。
   */
  encryptedInferBase: string
  /**
   * OAuth client id —— **prod 环境用的那一个**（源码 `J_a` 解码值）。
   *
   * ⚠️ 两个 client id 的对应关系**容易读反**，这里记录正确语义：
   *
   * ```js
   * async function __a(A, e, t, i = true, n, r) {   // i 是第 4 参
   *   ...client_id: i ? J_a : G_a
   * }
   * // 调用点（loginWithDeviceFlow）：
   * ({authUrl, pollForCompletion} = await A(o, s, i, n(), r.signal, a))
   * //                                          ↑ n() = isProd()
   * // $Oa(){return "prod"===db()}
   * ```
   *
   * 即第 4 参是 **`isProd()`（布尔）**：prod → `true` → **`J_a`**；
   * 非 prod（daily/test）→ `false` → `G_a`。
   *
   * **真实缺陷**（用户报障）：早期把第 4 参误读成「useIdeClientId」，
   * 于是 prod 用了 `G_a`，GitHub 授权回调后被服务端拒绝，页面报
   * 「参数无效 / 你可以稍后前往 IDE 客户端并登录Qoder」。
   */
  clientId: string
  /**
   * 非 prod 环境（daily / test）用的 client id（源码 `G_a`）。
   *
   * 仅作记录 —— 本插件只支持 prod，**不要**拿它当 prod 的 client id。
   */
  testClientId: string
  /** 请求体 `metadata.context` 的客户端标识（源码 `Fp()` 的 CLI 默认值）。 */
  clientMetadata: {
    client_type: string
    business_product: string
    business_type: string
    scene: string
  }
  /**
   * `/sash/` 端点（用量、活动）的 `Cosy-ClientType` 头取值。
   *
   * ⚠️ **与 `clientMetadata.client_type` 不是同一个身份，不要合并**：
   *
   * - `clientMetadata.client_type`（`'5'` + `business_product:'cli'`）对应源码
   *   `Fp()` 的 **CLI** 默认值，用于**推理请求体**的加密信封 `metadata`；
   * - 本值（`'10'`）对应官方**桌面客户端**身份 —— 源码里是一个冻结常量
   *   `Mh = Object.freeze({ clientType: 10, businessProduct: 'app', sessionType: 'app' })`，
   *   官方拿它请求 `/sash/api/v1/me/campaigns`。
   *
   * 服务端按这个头进入活动下发分支（真实缺陷，2026-09-25 定位）：
   *
   * | `Cosy-ClientType` | `/sash/api/v1/me/campaigns` 响应 |
   * |---|---|
   * | `'5'`（旧值） | `{"showCampaign":false,"claimable":false,"campaignUrl":"","campaigns":[]}` |
   * | `'10'`（本值） | `{"showCampaign":true,…,"campaigns":[1 条 VIEW_DETAILS]}` |
   *
   * ⚠️ **`'10'` 只是必要前提，不足以拿到「可领取」的活动**。要让服务端下发
   * `CLAIM_BENEFIT/CLAIMABLE`，还必须同时带 `Cosy-MachineToken` +
   * `Cosy-MachineType`（成对，见 `src/qoder-machine.ts`）。同一账号对照：
   *
   * | 头 | 结果 |
   * |---|---|
   * | 仅 `'10'` | 1 条 `VIEW_DETAILS`，`claimable:false` |
   * | `'10'` ＋ MachineToken ＋ MachineType | **2 条**，含 `CLAIM_BENEFIT/CLAIMABLE/100` |
   *
   * 该结论由 2026-09-21 抓包（`qoder积分.pcapng` + `SSLKEYLOGFILE` 解密）
   * 与逐项消融实验共同证实，详见 `qoder-machine.ts`。
   */
  sashClientType: string
  /** `User-Agent` 头取值前缀（源码拼 `qoder/{version}`）。 */
  userAgentPrefix: string
  /** 默认凭据 ref（无账号池时的单凭据回退）。 */
  defaultCredentialRef: string
  /**
   * 单张请求图片的像素预算（issue !IKITT9）。
   */
  imagePixelBudget?: number
  /**
   * 单张请求图片的编码字节目标。
   *
   * 未配置时用 `DEFAULT_BODY_LIMITED_IMAGE_MAX_BYTES`（1 MiB）——
   * 取值的算术依据记在 `src/image-budget.ts`。
   * ⚠️ 与 raccoon 的 512 KB 不同值是**有意的**（那家硬限 10 MB），别合并。
   */
  imageMaxBytes?: number
  /**
   * 模型列表不可用时的兜底模型目录（本插件不发远端请求，恒用它）。
   *
   * ⚠️ **只有模型列表需要 WASM 签名**，不要据此推断其它端点：
   * 推理（`model/v1/chat/completions`）、用户信息（`api/v1/userinfo`）、
   * **积分余额（`sash/api/v2/me/usage`）** 都只需 Bearer。
   * 早期因「模型列表要签名」而误以为余额也要，把积分能力误登记为 false
   * （见 `src/qoder-credits.ts` 的模块注释）。
   */
  fallbackModels: readonly QoderFallbackModel[]
}

/**
 * 模型目录（**实测数据**，2026-09-20）。
 *
 * ## `id` 是目录 key，且**必须走加密端点**
 *
 * 这些 key（`qfmodel` / `dmodel` / …）是 Qoder 客户端的**真实模型标识**，
 * 但公开的 `/model/v1/chat/completions` **不认它们**：
 *
 * ```
 * {"code":"invalid_model_error","message":"Unsupported model \"qfmodel\""}
 * ```
 *
 * 客户端真实推理走**加密端点**（见 `src/qoder-wasm.ts`）：
 * ```
 * POST {host}/algo/api/v2/service/pro/sse/agent_chat_generation
 *      ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 * body: <WASM 加密>
 * ```
 * 该端点**认这些 key**（实测 17 个全部可用）。
 *
 * ⚠️ 但请求体**必须带 `business` 字段**（见 `src/qoder-adapter.ts`）：
 * 缺了服务端会把请求路由到故障节点 `oa_qwen-plus-2025-04-28` 并返回
 * `[FAIL]node:... msg:Execution failed`。`qfmodel` 曾因此被误判为
 * 「服务端故障」（而 IDE 里同一模型完全正常）。
 *
 * ## ⚠️ 两套名字不可混用（踩过两次的坑）
 *
 * | 名字来源 | 示例 | 用途 |
 * |---|---|---|
 * | **目录 key**（本表） | `qfmodel` / `dmodel` | **加密端点**的 `model` 字段 |
 * | 通用名 | `qwen-flash` / `qwen-plus` | 公开端点的 `model` 字段（**不是**同一批模型） |
 *
 * 早期误把目录 key 发给公开端点 → `Unsupported model`；
 * 又误以为只有 11 个可用 → 表里换成通用名，结果拿到的是 Qwen3.5/2.5
 * 而非 Qwen3.8 系列（用户报障）。
 *
 * ## 数据来源
 *
 * 从本机 Qoder 的 `~/.qoder/.models/{uid}/catalog-v6` 解密取得
 * （`model_cache_decrypt`），字段逐项实测。
 *
 * ## 字段口径
 *
 * - `contextWindow`：目录 `max_input_tokens`。
 * - `supportsImage`：目录 `is_vl`（实测全为 true）。
 * - `supportsThinking`：目录 `is_reasoning`。
 * - `isFree`：目录 `is_free`（仅 Qwen3.8-Max / Qwen3.8-Flash）。
 * - `priceFactor`：目录 `price_factor`（**实测 2026-09-21，逐条对照本机
 *   catalog-v6 的 `chat` 场景**）。注意 `qfmodel` 的值是 **0**（免费），
 *   0 是合法值不能当缺失处理。
 * - `originalPriceFactor`：目录 `original_price_factor`（仅部分模型下发）。
 * - `promotion`：目录 `promotion`（错峰折扣，三档实测）。
 * - `efforts`：目录 `thinking_config.enabled.efforts` 的键。
 */
const QODER_FALLBACK_MODELS: readonly QoderFallbackModel[] = [
  // ⚠️ 全部数值逐条对照本机 catalog-v6 实测（2026-09-21）。早期版本多处为
  // 手工估值，与真实值**大范围不符**（14 个模型有偏差，如 `smodel` 写 3.2
  // 实际 8、`qmodel_38max` 写 0.5 实际 0.2），用户据此报障。
  // 改动本表时必须重新对照 catalog，不要凭印象填。
  //
  // 字段顺序：id, 展示名, 上下文, vl, reasoning, free, 倍率
  //
  // ⚠️ `contextWindow` 取官方档位表 `context_config` 的**最大档**，不是 `max_input_tokens`
  // —— 与本文件 CN 表的同一口径，完整论证见那份表的注释与 AGENTS.md「2.1」。
  // 国际版客户端里该判定的实现与 CN **逐字符同构**
  // （`function LV(A,e){…let i=Jqr(A);if(i)return i.includes(t);…max_input_tokens…}`，
  // 由 `scripts/probe-qoder-intl-window-logic.mjs` 复核），故同一条结论成立。
  // 本表 17 条的档位表实测（`scripts/probe-qoder-windows.mjs intl`）：
  // 除 `auto` 无档位表外**全部含 1M 档**（`performance` 是 {272K,400K,1M}、
  // `efficient` 默认档为 400K）。
  //
  // ⚠️ **国际版的「服务端真能收多少」未实测**：`api2.qoder.sh` 在本机网络下
  // 恒定 HTTP/2 `NGHTTP2_INTERNAL_ERROR`（连 1K 的最小请求也不通），
  // 故本表依据是「客户端逻辑 + 目录档位表」，**不是** CN 那样的实发验证。
  // 若将来国际版可用，应按 `probe-qoder-context-needle.mjs` 复核一遍。
  //
  // ⚠️ **思考档位**（`efforts` / `defaultEffort` / `supportsDisable`）逐条对照
  // 客户端算法复刻结果（`scripts/probe-qoder-effort-fields.mjs`，按 `$lc` 顺序
  // 逐字段试、再过白名单 `Qj`）。本表的档位来自目录 `thinking_config.enabled.efforts`。
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: false, priceFactor: 0.5 },
  { id: 'ultimate', name: 'Ultimate', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 2, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high', supportsDisable: true },
  // ⚠️ `is_reasoning: false` 但 `thinking_config.enabled` 为真 —— 上游确实
  // 提供档位选择，故 `efforts` 保留；而请求体的 `isReasoning` 取 `is_reasoning`。
  // ⚠️ 档位表是 {272K(default), 400K, 1M}，取最大档。
  { id: 'performance', name: 'Performance', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.1, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'medium', supportsDisable: true },
  // ⚠️ 档位表 {200K, 400K(default), 1M} —— 唯一默认档不是 200K 的国际版模型。
  { id: 'efficient', name: 'Efficient', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.3 },
  // ⚠️ `smodel` / `cmodel` 有 5 档但**无 `disabled` 分支** → 不能关闭思考。
  { id: 'smodel', name: 'Sonus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 8, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  { id: 'cmodel', name: 'Cantus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 4, efforts: ['xhigh', 'high', 'low', 'max', 'medium'], defaultEffort: 'high' },
  // 免费额度模型（is_free=true）：e2e 探针默认用它们以免消耗积分。
  // ⚠️ `priceFactor` 是**采集时刻的生效价**（窗口内为折后价），原价在
  // `promotion.beforePromotionPriceFactor`；展示时本地推算当前价。
  {
    // ⚠️ 默认档与国际版其他模型不同：这里是 `xhigh`（CN 同模型是 `medium`）。
    id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
    isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'xhigh', supportsDisable: true,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
  },
  {
    // ⚠️ `priceFactor: 0` 是**免费**（实测），不是缺失 —— 见接口注释。
    id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
    isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
  },
  // ⚠️ 这两个模型目录里**只有 `disabled` + `enabled.is_default`，没有 `efforts`**
  // —— 即官方只提供「关闭思考」一个选项（用户 2026-09-28 确认：
  // 「上面两个没有思考档位就是关闭的意思」）。故 `efforts` 留空，
  // 由 `supportsDisable` 表达，适配器会追加 `none`（复刻客户端 `gU()`）。
  {
    id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
    priceFactor: 0.1, originalPriceFactor: 0.5, supportsDisable: true,
    promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 2 折' },
  },
  {
    id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false,
    priceFactor: 0.04, supportsDisable: true,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
  },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  // ⚠️ 该模型**未下发 `max_input_tokens`**（这正是「该字段不是权威值」的旁证）——
  // 旧表因此退回 `context_config` 的**默认档** 200K，但官方客户端给用户选的是
  // **最大档** 1M（`zX()` 只查成员资格，不限于默认档）。故取 1M。
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true },
  { id: 'mmodel', name: 'MiniMax-M3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: false, priceFactor: 0.2 },
]

/** Qoder provider 配置（国际版）。 */
export const QODER: QoderProduct = {
  id: 'qoder',
  displayName: 'Qoder',
  authBase: 'https://qoder.com',
  openApiBase: 'https://openapi.qoder.sh',
  inferBase: 'https://api2-v2.qoder.sh',
  encryptedInferBase: 'https://api2.qoder.sh',
  clientId: 'e883ade2-e6e3-4d6d-adf7-f92ceff5fdcb',
  testClientId: 'e93fe488-5778-4c35-a6fc-0f54ed7b3139',
  clientMetadata: {
    client_type: '5',
    business_product: 'cli',
    business_type: 'agent',
    scene: 'assistant',
  },
  // 官方桌面客户端身份（源码常量 `Mh.clientType`）。仅用于 `/sash/` 端点。
  sashClientType: '10',
  userAgentPrefix: 'qoder',
  defaultCredentialRef: 'QODER_ACCESS_TOKEN',
  fallbackModels: QODER_FALLBACK_MODELS,
}

/**
 * 中国版模型目录（**实测数据**，2026-09-27，设计文档 E6）。
 *
 * 来源：本机 `~/.qoder-cn/.models/{uid}/catalog-v6` 的 `chat` 场景，
 * 用**国际版那份** WASM 解密（见 E5），共 14 条。
 *
 * ⚠️ **不能沿用国际版那张 17 条的表**：
 * - CN 独有 `q37fmodel` / `gm51model`；
 * - CN **没有** `ultimate` / `performance` / `efficient` / `smodel` / `cmodel`
 *   —— 沿用会让菜单出现 5 个 CN 端点根本不认的模型，点了就报错；
 * - 5 条上下文窗口、4 条思考标记、1 条 vl 标记不同；
 * - `mmodel` 在 CN 是 **MiniMax-M2.7**（国际版 M3）。
 *
 * ⚠️ CN 目录条目的标识字段名是 **`key`**，国际版是 `model_key` —— 只影响
 * 重新采集时的解析（`scripts/probe-qodercn-catalog.mjs` 两个名字都认），
 * 不影响本表（本表已是扁平结构）。
 *
 * 字段口径与国际版表完全一致，见 `QoderFallbackModel` 的注释。
 */
const QODER_CN_FALLBACK_MODELS: readonly QoderFallbackModel[] = [
  // ⚠️ 全部数值逐条对照本机 CN catalog-v6 的 chat 场景实解值（2026-09-27）。
  // 国际版曾因为「手工估值 + 单测只断言 id 列表」让价格漂移长期未被发现
  // （14 个模型有偏差，用户报障）。改本表必须重新跑探针对照。
  //
  // ⚠️ **`contextWindow` 取官方档位表 `context_config` 的最大档，不是 `max_input_tokens`。**
  //
  // 两个字段经常自相矛盾（CN `dmodel`：`max_input_tokens: 96000`，档位表却是
  // `{200K, 400K, 1M}`），而**官方客户端只认后者**：`isContextWindowSupportedByModel()`
  // 把值换算成整数后交给 `zX()`，`zX()` 一旦发现档位表存在就**只检查「是否为表内成员」**，
  // 那条 `max_input_tokens` 兜底分支（`t <= n`）根本不会执行
  // （asar 证据：`function zX(A,e){…let i=Yai(A);if(i)return i.includes(t);…}`）。
  // 故照 `max_input_tokens` 填（180K / 96K）会让 DSH 远早于官方能力就触发压缩。
  //
  // 实测（2026-09-27，CN 网关加密端点，`scripts/probe-qoder-context-needle.mjs`）：
  // `max_input_tokens` 与 `parameters.context_length` **都不构成**服务端约束 ——
  // 同一份 400K 提示在声明 180K / 200K / 1M / 不发该字段时**全部完整送达**
  // （`prompt_tokens` 一致）；声明 96K 的 `dmodel` 也照收 852K。
  //
  // ⚠️ **上限因模型而异，不是网关统一值**（这是被实测推翻的早期结论）。
  // 逐模型实测的最大通过量（针埋在提示正中间，命中即证明未被截断）：
  //
  // | 模型 | 实测通过最大 | 服务端实际计入 | 越界点 | 越界错误形态 |
  // |---|---|---|---|---|
  // | `dfmodel` | 938,000 目标 | **999,991** | ≈1,002,000 | `Internal Server Error` |
  // | `qfmodel` | 984,000 目标 | **983,490** | 990,000 | 参数错误 + `Range … [1, 983616]` |
  // | `dmodel` | 800,000 目标 | **852,951** | 985,000 | `Internal Server Error` |
  //
  // ⚠️ **`983,616`（`1M − 16K`）只对报了它的那个模型成立，不能推广成全局上限** ——
  // `dfmodel` 实测通过到 999,991，已超过该数。
  //
  // ⇒ **取值口径（用户 2026-09-27 定）**：**档位表有 1M 档就填 1M**。
  // - `qfmodel` / `dfmodel` / `dmodel` 及以下各条：**填 1M**。
  //   `qfmodel` 与 `dfmodel` 的实测已逼近 1M（983,490 / 999,991）；
  //   `dmodel` 的实测只到 852,951（985,000 越界），但它是**档位表成员 1M**
  //   —— 采信官方档位表，且 1M × 0.8 = 800K 的压缩阈值低于 852,951 这个
  //   已知安全点，故填 1M 在 DSH 侧安全。
  // - `mmodel`：档位表**只有 200K 一档**，故填 200K。
  // - `auto`：无档位表，沿用 200K。
  //
  // ⚠️ **思考档位**（`efforts` / `defaultEffort` / `supportsDisable`）逐条对照
  // 客户端算法复刻结果（`scripts/probe-qoder-effort-fields.mjs`）。三条口径：
  // - `efforts` 取自目录 `thinking_config.enabled.efforts` 的**键**（目录原序）；
  // - `defaultEffort` 取该对象里 `is_default: true` 的键；
  // - `supportsDisable` = 目录存在 `thinking_config.disabled` 分支。
  // ⚠️ **`qmodel` / `qmodel_latest` 只有「关闭思考」**：目录里它们的 `enabled`
  // **没有 `efforts` 键**，只有 `disabled` + `enabled.is_default` ——
  // 即官方就只提供「关」这一个选项（用户 2026-09-28 确认：
  // 「上面两个没有思考档位就是关闭的意思」）。不要给它们补默认档位。
  // ⚠️ `q37fmodel` / `mmodel` / `auto` **连 `thinking_config` 都没有** →
  // 完全不可选（界面显示「当前模型未提供推理等级」，与 IDE 的「不支持」一致）。
  { id: 'auto', name: 'Auto', contextWindow: 200_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5 },
  // 免费额度模型（isFree=true）：e2e 探针默认用它们，以免消耗积分。
  {
    id: 'qmodel_38max', name: 'Qwen3.8-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
    isFree: true, priceFactor: 0.2, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折' },
  },
  {
    // ⚠️ `priceFactor: 0` 是**免费**，不是缺失 —— 0 是合法值，不能用 `> 0` 过滤。
    // 实测最大窗口：984,000 目标 → 服务端计入 **983,490**（越界点 990,000，
    // 越界时服务端回 `Range of input length should be [1, 983616]`）。填 1M。
    id: 'qfmodel', name: 'Qwen3.8-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
    isFree: true, priceFactor: 0, originalPriceFactor: 0.1, efforts: ['xhigh', 'low', 'medium'], defaultEffort: 'medium', supportsDisable: true,
  },
  {
    // ⚠️ **没有 `efforts`，只有「关闭思考」**（见本表前的口径注释）。
    id: 'qmodel_latest', name: 'Qwen3.7-Max', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
    priceFactor: 0.1, supportsDisable: true,
    promotion: { active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰2折' },
  },
  {
    // ⚠️ 同上：只有「关闭思考」。
    id: 'qmodel', name: 'Qwen3.7-Plus', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true,
    priceFactor: 0.04, supportsDisable: true,
    promotion: { active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.1, windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰4折' },
  },
  // CN 独有：Qwen3.7-Flash（国际版目录无此 key）
  // ⚠️ 目录里**完全没有 `thinking_config`** → 不可选档位（IDE 显示「不支持」）。
  { id: 'q37fmodel', name: 'Qwen3.7-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1 },
  // ⚠️ CN 的 `max_input_tokens` 是 96000，但档位表与其它模型一样有 1M 档；
  // 官方客户端只认档位表 → **填 1M**（用户 2026-09-27 定：档位表有 1M 就填 1M）。
  // 实测只探到 800,000 目标 → 服务端计入 **852,951** 通过，985,000 时越界且
  // **只回 `Internal Server Error`（未给出区间）**，故它的真实天花板未探明；
  // 但 1M × 0.8 = 800K 的压缩阈值低于 852,951 这个已证安全点，故 1M 在 DSH 侧安全。
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.5, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
  // ⚠️ CN 的 `is_reasoning` 为 false（国际版为 true），故不声明 supportsThinking。
  // 实测最大窗口：938,000 目标 → 服务端计入 **999,991** 通过（连续 3 次可复现），
  // 939,000 时越界（`Internal Server Error`）→ 真实上限≈1,000,000。填 1M。
  { id: 'dfmodel', name: 'DeepSeek-Flash', contextWindow: 1_000_000, supportsImage: true, priceFactor: 0.1, efforts: ['high', 'max', 'low'], defaultEffort: 'max', supportsDisable: true },
  // ⚠️ `gmodel` / `gfmodel` / `kmodel*` 有档位但**无 `disabled` 分支** → 不能关闭。
  { id: 'gmodel', name: 'GLM-5.3', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.1, efforts: ['high', 'max'], defaultEffort: 'max' },
  // CN 独有：GLM-5.2（国际版目录无此 key）
  { id: 'gm51model', name: 'GLM-5.2', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.6, efforts: ['high', 'max'], defaultEffort: 'max', supportsDisable: true },
  { id: 'kmodel_latest', name: 'Kimi-K3', contextWindow: 1_000_000, supportsImage: true, priceFactor: 1.4, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', contextWindow: 1_000_000, supportsImage: true, supportsThinking: true, priceFactor: 0.8, efforts: ['high', 'low', 'max'], defaultEffort: 'max' },
  // ⚠️ 版本是 **M2.7**（国际版 M3），且 CN 的 `is_vl` 为 false，故两个标记都不写。
  // ⚠️ 唯一档位表只有 200K 一档的 CN 模型 —— 不要跟着其它条改成 1M。
  // ⚠️ 目录里也**没有 `thinking_config`** → 不可选档位（与 IDE「不支持」一致）。
  { id: 'mmodel', name: 'MiniMax-M2.7', contextWindow: 200_000, priceFactor: 0.2 },
]

/** Qoder provider 配置（**中国版**）。 */
export const QODER_CN: QoderProduct = {
  // ⚠️ id 不带连字符：它同时是 cordis 服务名（`qodercnAuth`）、LLM 路由名
  // （`llm-qodercn`）与凭据 ref 前缀（`QODERCN_ACCESS_TOKEN`）的组成部分，
  // 带连字符会让服务名不符合 camelCase 惯例。
  id: 'qodercn',
  displayName: 'Qoder (中国版)',
  // E4：CN endpoint-cache.json + asar `environments.prod`（website/auth/collaboration
  // 三个都指向 qoder.cn，openApi 指向 openapi.qoder.com.cn）。
  authBase: 'https://qoder.cn',
  openApiBase: 'https://openapi.qoder.com.cn',
  // ⚠️ CN **没有**可用的公开 OpenAI 兼容端点：实测
  // `gateway.qoder.com.cn/model/v1/chat/completions` 与
  // `openapi.qoder.com.cn/model/v1/chat/completions` 都回 503（alb 无上游路由）。
  // 而 `inferBase` 在本代码里**没有任何调用方**（公开端点方案早已被加密
  // 端点取代，见 `QODER_CHAT_PATH` 同样无人使用），故这里填成与
  // `encryptedInferBase` 同值仅表示「没有独立公开端点」，**不要**据此发请求。
  // 不删该字段：删除属于与本任务无关的重构，且会牵动国际版注释。
  inferBase: 'https://gateway.qoder.com.cn',
  // E4 + E9：`algo` 网关在 CN 换域名，路径与协议同形
  // （零凭据 POST 的错误响应形态与国际版逐字节一致）。
  encryptedInferBase: 'https://gateway.qoder.com.cn',
  // E2：取自 CN asar 的 `Vpe.authClientIds.prod`。
  // ⚠️ **与国际版完全不同** —— 国际版两个 id 在 CN asar 里命中 0 次。
  // 用错的症状是「授权页 302 正常、点击授权后报参数无效」，
  // 故**不能**靠探测入口验证，必须真实登录闭环（tests/e2e/qodercn-probe）。
  clientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  // E2：CN 的 `authClientIds.test` 与 `prod` **同一个值**，因此不存在国际版
  // `J_a` / `G_a` 被读反的那类风险。字段仍保留以免改动 `QoderProduct` 形状。
  testClientId: '732aef47-9cf2-46a2-95fe-4cebb5d0d1fa',
  // 沿用国际版的 **CLI** 身份（源码 `Fp()` 默认值）。
  // ⚠️ CN 桌面端自己用的是 `Fh`（clientType 10 / businessProduct 'app' /
  // sessionType 'app' / scene 'app'）。插件走 CLI 身份在国际版实测可用；
  // CN 是否接受由 e2e 对话探针验证 —— 若被拒，改这一组值，
  // 但**不要**顺手把下面 `sashClientType` 一起改（那是两个不同身份，
  // 见 `QoderProduct.sashClientType` 的注释）。
  clientMetadata: {
    client_type: '5',
    business_product: 'cli',
    business_type: 'agent',
    scene: 'assistant',
  },
  // E10：CN asar 里同样是 `Fh = Object.freeze({ clientType: 10, … })`。
  sashClientType: '10',
  // E11：CN asar 的 sash 请求头 UA 恒为 `"Qoder"`，与国际版一致。
  userAgentPrefix: 'qoder',
  defaultCredentialRef: 'QODERCN_ACCESS_TOKEN',
  fallbackModels: QODER_CN_FALLBACK_MODELS,
}

/**
 * 全部 Qoder 产品配置（国际版 + 中国版）。
 *
 * 顺序即 `qoderProductById()` 的查找顺序，也是续期调度遍历的顺序。
 * 新增同族产品（如将来的其它区域版本）只在此追加一项 + 一份配置，
 * **不要**复制 `src/qoder*.ts` 的任何实现文件。
 */
export const ALL_QODER_PRODUCTS: readonly QoderProduct[] = [QODER, QODER_CN]

/**
 * 按 provider id 取 Qoder 产品配置；未知 id 返回 undefined。
 */
export function qoderProductById(id: string): QoderProduct | undefined {
  return ALL_QODER_PRODUCTS.find((product) => product.id === id)
}
