/**
 * Qoder 内嵌 WASM（`qoder_auth_wasm`）的 wasm-bindgen 桥。
 *
 * ## 为什么需要它
 *
 * Qoder 客户端的**真实**推理不走公开的 OpenAI 兼容端点，而是走
 * **加密端点**：
 *
 * ```
 * POST {host}/algo/api/v2/service/pro/sse/agent_chat_generation
 *      ?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1
 * body: <由本 WASM 加密>
 * ```
 *
 * 服务端认的是**模型目录里的 key**（`qfmodel` / `dmodel` / …），
 * 而公开端点只认一小撮通用名 —— 这就是「拿不到 Qwen3.8 系列」的根因。
 *
 * 本模块把客户端内嵌的 WASM（`src/qoder-auth-wasm.wasm`，298 KB，
 * 随插件分发）按 wasm-bindgen 约定接起来，用它**生成加密请求体**，
 * 从而走客户端的同一条链路。
 *
 * ## ⚠️ 不是「破解密码学」
 *
 * WASM 同时导出了成对的编解码函数（`decrypt_server_response` /
 * `model_cache_decrypt` / `profileencryptor_*`）。我们**直接调用它**，
 * 不逆向其算法 —— 等同「用客户端自己的钥匙开自己的锁」。
 *
 * ## 三个实测踩过的坑（改动时务必保留）
 *
 * 1. **两个 `getRandomValues` import 的签名方向相反**：
 *    `_d49329ff89a07af1` 写 **wasm 内存**、`_c44a50d8cfdaebeb` 调 **JS 对象**。
 *    写反会得到 Rust panic `unreachable`。
 * 2. **返回值布局有两套**：字符串类为 `ptr/len/valIdx/isErr`，
 *    而 `qodercontext_new` / `prepareInferRequest` 为 `ptr/errIdx/isErr`。
 *    混用会得到 `null pointer passed to rust`。
 * 3. **`requestresult_url(栈指针, ptr)` 参数顺序与直觉相反**（栈指针在前）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

/** WASM 文件的绝对路径（位于 lib/，与编译产物的相对位置固定）。 */
const WASM_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'qoder-auth-wasm.wasm')

/**
 * 最小 `WebAssembly` 类型声明。
 *
 * tsconfig 的 `lib` 只有 `ES2023`（不含 DOM），而 WebAssembly 命名空间
 * 定义在 DOM lib 里。为不引入整个 DOM（会与 `@types/node` 的 fetch 等
 * 全局类型冲突），这里只声明本模块用到的部分。
 */
interface WasmModule {
  exports: readonly { name: string }[]
}
/** 本模块只用 `.buffer`（用于建立 TypedArray 视图）。 */
interface WasmMemory {
  buffer: ArrayBuffer
}
declare const WebAssembly: {
  compile(bytes: Uint8Array): Promise<unknown>
  instantiate(module: unknown, imports: Record<string, unknown>): Promise<{ exports: unknown }>
  Module: new (bytes: Uint8Array) => WasmModule
}

/** 客户端版本与产品标识（与 `QODER` 产品配置保持一致）。 */
const COSY_VERSION = '1.1.49'

/**
 * wasm-bindgen 生成的 import 对象名。WASM 里 embed 了这个模块路径，
 * 名字必须完全一致，否则 `instantiate` 会因缺 import 而失败。
 */
const IMPORT_MODULE = './qoder_auth_wasm_bg.js'

/** `generate_runtime_auth_fields` 的产物：服务端用于识别身份的加密字段。 */
export interface QoderRuntimeAuthFields {
  encrypt_user_info: string
  key: string
}

/** 构造 WASM 上下文所需的用户信息。 */
export interface QoderWasmUserInfo {
  uid: string
  securityOauthToken: string
  organizationId?: string
  organizationTags?: readonly string[]
  dataPolicyAgreed?: boolean
}

/** 客户端元数据（写入 `QoderContext`）。 */
export interface QoderClientMetadata {
  client_type: string
  business_product: string
  business_type: string
  scene: string
}

/** `prepareInferRequest` 的产物。 */
export interface QoderInferRequest {
  url: string
  headers: Record<string, string>
  body: string
}

/**
 * assistant 消息携带的一次工具调用（**OpenAI 风格**）。
 *
 * 形态取自客户端 `t2c()`：它把内部 `tool_use` 块转成
 * `{id, type:'function', index, function:{name, arguments}}` 后挂到
 * 消息的 `tool_calls` 上。
 *
 * ⚠️ **不要**用 Anthropic 风格的 `tool_use` / `input` —— 那是客户端给
 * Anthropic BYOK 走的另一条分支（`input_schema` / `tool_use_id`），
 * 加密端点 `agent_chat_generation` 不吃那套。
 */
export interface QoderInferToolCall {
  id: string
  type: 'function'
  /** 同一 assistant 消息内多个调用的序号（客户端会给）。 */
  index?: number
  function: { name: string; arguments: string }
}

/**
 * 加密推理请求里，单条待发送消息。
 *
 * - `content` 通常是**字符串**（客户端 `udn(r, '')`；工具调用消息的正文是 `''`）。
 * - ⚠️ **带图片的消息 `content` 是多模态数组**（`{type:'image_url',…}`）。
 *   客户端 `eQc()` / `bJc()` 就是这么把它放进 `messages[]` 的 ——
 *   图片**不走** `chat_context.imageUrls`（官方 `Hyc()` 把那个字段恒置 `null`）。
 *   早期实现把 content 压成纯文本，导致图片在下游全部消失（真实缺陷，用户报障）。
 * - `tool_calls` 只出现在 assistant 上。
 * - `tool_call_id` 只出现在 `role: 'tool'` 上（客户端 `A2c()` 的 `tool_result` 分支）。
 *
 * ⚠️ 这三者缺一不可：只发工具结果而不发对应的 assistant `tool_calls`，
 * 会让模型看不到自己调用过什么 —— 表现为反复重调同一工具或凭空编造结果。
 */
export interface QoderInferMessage {
  role: string
  content: string | ReadonlyArray<Record<string, unknown>>
  tool_calls?: readonly QoderInferToolCall[]
  tool_call_id?: string
}

/**
 * 下发给模型的工具定义（**OpenAI 风格**）。
 *
 * 客户端 `$Hc(A)` 的产物：`{type:'function', function:{name, description?, parameters?}}`，
 * 写入请求体**顶层** `tools`（源码：`tools: o?.tools ?? []`）。
 * `description` / `parameters` 缺省时该键**不出现**。
 */
export interface QoderInferTool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters?: Record<string, unknown>
  }
}

/** 构造加密推理请求的入参。 */
export interface QoderInferAsk {
  /** 模型目录 key（如 `qfmodel`）。

   * ⚠️ 这是**目录 key**，不是推理用的通用名 —— 本端点认的就是 key。 */
  modelKey: string
  /** 用户消息文本（`chat_context.text` 取最后一条 user 消息）。 */
  userText: string
  /** 系统提示（可选）。 */
  systemText?: string
  /** 该模型是否支持思考（写入 `model_config.is_reasoning`）。 */
  isReasoning?: boolean
  /** 会话里已发生的消息（历史），按顺序。首条 user 即 `userText`。 */
  history?: readonly QoderInferMessage[]
  /** 单次输出上限。 */
  maxTokens?: number
  /** 思考档位；`none` 表示关闭思考。 */
  reasoningEffort?: string
  /** 模型目录里的 `source`（默认 `system`）。 */
  source?: string
  /** 模型是否支持图片（`is_vl`）。 */
  isVl?: boolean
  /** 上下文长度（可选）。 */
  contextWindow?: number
  /**
   * 该模型在目录里的 `display_name`（写入 `model_config.display_name`）。
   *
   * 官方 `Uyc()` 的 `model_config` 有 10 个字段，这是其中之一；
   * 为对齐官方结构而带上（**不是**路由的决定因素 —— 那是 `business`）。
   */
  displayName?: string
  /** 目录里的 `format`（默认 `openai`）。 */
  format?: string
  /** 目录里的 `max_input_tokens`（写入 `model_config.max_input_tokens`）。 */
  maxInputTokens?: number
  /**
   * `session_type`。
   *
   * 官方源码：`session_type: process.env[SESSION_TYPE] ?? (r0() ? l7A : swe)`
   * —— 国际版是 **`qodercli`**（`swe`），国内版是 **`qoder_work`**（`l7A`）。
   * 早期传的是 `'cli'`（两边都不是）；现已对齐国际版。
   */
  sessionType?: string
  /**
   * **业务归属 —— 必填，它决定服务端路由。**
   *
   * ⚠️ 这是 `qfmodel`（Qwen3.8-Flash）`Execution failed` 的**真正根因**
   * （实测 2026-09-20）：**不带 `business`** 时请求恒被路由到故障节点
   * `oa_qwen-plus-2025-04-28`；补上后立即正常。
   *
   * 其余模型（如 `qmodel_38max`）恰好不受影响，故极易误判为
   * 「该模型服务端故障」—— 但同一模型在 IDE 里完全可用。
   *
   * 源码依据：`MPi(A) { return A === 'sec_scan' ? 'security' : 'default' }`
   * —— 服务端按 `business.type` 选路由池。
   */
  business?: Record<string, unknown>
  /**
   * 下发给模型的工具定义（OpenAI 风格）。
   *
   * ⚠️ **必须真的传**：加密端点认请求体**顶层** `tools`
   * （客户端源码 `tools: o?.tools ?? []`）。早期实现把它硬编码为 `[]`，
   * 模型拿不到任何函数 schema，只能用正文里的 XML 文本臆造工具调用
   * （用户报障：「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」）。
   *
   * 省略等价于空数组（与客户端一致：键恒在，值为 `[]`）。
   */
  tools?: readonly QoderInferTool[]
}

/**
 * 构造加密端点 `agent_chat_generation` 的**明文请求体**。
 *
 * 抽成纯函数有两个理由：
 * 1. **可测**：加密端点的请求体经 WASM 加密后本地不可解（朴素 `JSON.parse`
 *    会抛），把 payload 构造独立出来才能直接断言 `tools` / `messages`；
 * 2. **单一来源**：`prepareInfer` 只负责「拿它去加密」，不再内联一份结构。
 *
 * ⚠️ 结构逐项复刻官方 `G4A()`，改动前请先读
 * `docs/qoder-encryption-notes.md` 的 §3 与 §6：
 * `chat_context` 不能传空对象、`business` 缺失会被路由到故障节点。
 *
 * @param ask - 上层适配器给出的请求参数。
 * @param requestId - 请求 id（默认随机；测试可固定以求确定性）。
 */
export function buildQoderInferPayload(
  ask: QoderInferAsk,
  requestId: string = crypto.randomUUID(),
): Record<string, unknown> {
  const isReasoning = ask.isReasoning ?? false
  const text = ask.userText

  const parameters: Record<string, unknown> = {}
  if (ask.maxTokens !== undefined) parameters.max_tokens = ask.maxTokens
  if (ask.reasoningEffort !== undefined) {
    parameters.reasoning_effort = ask.reasoningEffort
    parameters.enable_thinking = ask.reasoningEffort !== 'none'
  }
  if (ask.contextWindow !== undefined) parameters.context_length = ask.contextWindow

  const messages: QoderInferMessage[] = []
  for (const m of ask.history ?? []) {
    // 逐字段搬运而非整体展开：只保留协议认识的三个键，避免把调用方的
    // 内部字段（如 DSH 的 `id` / `source`）原样发给上游。
    messages.push({
      role: m.role,
      content: m.content,
      ...(m.tool_calls === undefined ? {} : { tool_calls: m.tool_calls }),
      ...(m.tool_call_id === undefined ? {} : { tool_call_id: m.tool_call_id }),
    })
  }
  if (messages.length === 0) messages.push({ role: 'user', content: text })

  return {
    request_id: requestId,
    request_set_id: requestId,
    chat_record_id: requestId,
    session_id: crypto.randomUUID(),
    stream: true,
    chat_task: 'FREE_INPUT',
    chat_context: {
      text,
      features: [],
      extra: {
        context: [],
        modelConfig: { key: ask.modelKey, is_reasoning: isReasoning },
        originalContent: text,
      },
      chatPrompt: '',
      imageUrls: null,
    },
    is_reply: true,
    is_retry: false,
    source: 1,
    version: '3',
    agent_id: 'agent_common',
    task_id: 'common',
    session_type: ask.sessionType ?? 'qodercli',
    aliyun_user_type: '',
    model_config: {
      key: ask.modelKey,
      // 官方 `Uyc()` 的 model_config 有 **10 个字段**，此处逐项对齐
      // （早期只传 6 个）。
      display_name: ask.displayName ?? '',
      model: '',
      format: ask.format ?? 'openai',
      is_vl: ask.isVl ?? true,
      is_reasoning: isReasoning,
      api_key: '',
      url: '',
      source: ask.source ?? 'system',
      max_input_tokens: ask.maxInputTokens ?? ask.contextWindow ?? 200_000,
    },
    custom_model: null,
    system: ask.systemText ? [{ type: 'text', text: ask.systemText }] : [],
    messages,
    // ⚠️ **必须把调用方的工具定义真的发出去**：它是**顶层** `tools`
    // （客户端源码 `tools: o?.tools ?? []`）。早期硬编码 `[]` 让模型拿不到
    // 任何函数 schema，只能用正文里的 XML 文本臆造工具调用 ——
    // 用户报障「qwen3.8-flash 执行任务出现任务调用 xml 泄露任务终止」。
    // 无工具时是**空数组**而非缺字段（与客户端一致）。
    tools: ask.tools ?? [],
    parameters,
    // `business` 决定服务端路由（`sec_scan` → 安全池，其余 → 默认池）。
    ...(ask.business === undefined ? {} : { business: ask.business }),
  }
}

/**
 * WASM 实例的 glue 状态。
 *
 * 这些变量名沿用 wasm-bindgen 生成的约定，便于与官方产物对照。
 */
interface Glue {
  /** 导出的函数表。 */
  exports: Record<string, (...args: number[]) => number>
  /** 内存视图缓存（内存增长后需重建）。 */
  heap: () => Uint8Array
  view: () => DataView
  /** 读 wasm 字符串。 */
  readString: (ptr: number, len: number) => string
  /** 写字符串进 wasm 内存，返回指针（长度经 `lastLength` 传出）。 */
  writeString: (text: string) => number
  lastLength: () => number
  /** 对象堆：JS 对象 ↔ 整数索引。 */
  heapObject: (index: number) => unknown
  pushObject: (value: unknown) => number
  takeObject: (index: number) => unknown
  /** 调用「字符串返回值」型函数，返回其字符串。 */
  callString: (invoke: (stack: number) => void) => string
  /** 调用「原始指针返回值」型函数，返回其指针。 */
  callPointer: (invoke: (stack: number) => void) => number
}

/** 已实例化的 glue（每个进程一份，WASM 实例无状态可复用）。 */
let gluePromise: Promise<Glue> | null = null

/** 建立（或复用）WASM glue。 */
async function getGlue(): Promise<Glue> {
  gluePromise ??= createGlue()
  return gluePromise
}

/** 真正实例化 WASM 并接好 import。 */
async function createGlue(): Promise<Glue> {
  const bytes = readFileSync(WASM_PATH)
  const module = await WebAssembly.compile(bytes)

  let exports: Record<string, (...args: number[]) => number> = {}
  let cachedHeap: Uint8Array | null = null
  let cachedView: DataView | null = null

  const decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
  const encoder = new TextEncoder()

  const heap = (): Uint8Array => {
    if (cachedHeap === null || cachedHeap.byteLength === 0) {
      cachedHeap = new Uint8Array((exports.memory as unknown as WasmMemory).buffer)
    }
    return cachedHeap
  }
  const view = (): DataView => {
    if (cachedView === null || cachedView.buffer !== (exports.memory as unknown as WasmMemory).buffer) {
      cachedView = new DataView((exports.memory as unknown as WasmMemory).buffer)
    }
    return cachedView
  }
  const readString = (ptr: number, len: number): string =>
    decoder.decode(heap().subarray(ptr >>> 0, (ptr >>> 0) + len))

  /** 对象堆（与官方 `wW` 一致：1024 个 undefined，再 push 四个哨兵）。 */
  const objects: unknown[] = new Array(1024).fill(undefined)
  objects.push(undefined, null, true, false)
  let firstFree = objects.length
  const heapObject = (index: number): unknown => objects[index]
  const pushObject = (value: unknown): number => {
    if (firstFree === objects.length) objects.push(objects.length + 1)
    const index = firstFree
    firstFree = objects[index] as number
    objects[index] = value
    return index
  }
  const takeObject = (index: number): unknown => {
    const value = heapObject(index)
    // 索引 < 1028 是哨兵（undefined/null/true/false），不可回收
    if (index >= 1028) {
      objects[index] = firstFree
      firstFree = index
    }
    return value
  }

  let lastLength = 0
  const writeString = (text: string): number => {
    const encoded = encoder.encode(text)
    const ptr = exports.__wbindgen_export2!(encoded.length, 1) >>> 0
    heap().subarray(ptr, ptr + encoded.length).set(encoded)
    lastLength = encoded.length
    return ptr
  }

  const callString = (invoke: (stack: number) => void): string => {
    let ptr = 0
    let len = 0
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const v = view()
      ptr = v.getInt32(stack + 0, true)
      len = v.getInt32(stack + 4, true)
      const isError = v.getInt32(stack + 12, true)
      if (isError) throw takeObject(v.getInt32(stack + 8, true))
      return readString(ptr, len)
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
      if (ptr) exports.__wbindgen_export4!(ptr, len, 1)
    }
  }

  const callPointer = (invoke: (stack: number) => void): number => {
    const stack = exports.__wbindgen_add_to_stack_pointer!(-16)
    try {
      invoke(stack)
      const v = view()
      const ptr = v.getInt32(stack + 0, true)
      const isError = v.getInt32(stack + 8, true)
      if (isError) throw takeObject(v.getInt32(stack + 4, true))
      return ptr
    } finally {
      exports.__wbindgen_add_to_stack_pointer!(16)
    }
  }

  /** wasm-bindgen 的「调用 JS 函数并捕获异常」包装。 */
  const guard = (fn: (...args: number[]) => void, args: number[]): void => {
    try {
      fn(...args)
    } catch (error) {
      exports.__wbindgen_export!(pushObject(error))
    }
  }

  const imports = {
    __wbindgen_object_drop_ref: (a: number) => takeObject(a),
    __wbindgen_object_clone_ref: (a: number) => pushObject(heapObject(a)),
    __wbindgen_cast_0000000000000001: (a: number, e: number) =>
      pushObject(heap().subarray(a >>> 0, (a >>> 0) + e)),
    __wbindgen_cast_0000000000000002: (a: number, e: number) => pushObject(readString(a, e)),
    __wbg_set_08463b1df38a7e29: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).set(heapObject(e) as Uint8Array, heapObject(t) as number)),
    // ⚠️ 这两个签名**方向相反**：一个写 wasm 内存，一个调 JS 对象。
    // 写反会得到 Rust panic `unreachable`。
    __wbg_getRandomValues_d49329ff89a07af1: (...a: number[]) =>
      guard((x: number, y: number) => {
        globalThis.crypto.getRandomValues(heap().subarray(x >>> 0, (x >>> 0) + y))
      }, a),
    __wbg_getRandomValues_c44a50d8cfdaebeb: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { getRandomValues: (v: unknown) => void }).getRandomValues(heapObject(y))
      }, a),
    __wbg_crypto_38df2bab126b63dc: (a: number) =>
      pushObject((heapObject(a) as { crypto: unknown }).crypto),
    __wbg_process_44c7a14e11e9f69e: (a: number) =>
      pushObject((heapObject(a) as { process: unknown }).process),
    __wbg_versions_276b2795b1c6a219: (a: number) =>
      pushObject((heapObject(a) as { versions: unknown }).versions),
    __wbg_node_84ea875411254db1: (a: number) => pushObject((heapObject(a) as { node: unknown }).node),
    __wbg_require_b4edbdcf3e2a1ef0: (...a: number[]) => guard(() => pushObject(module), a),
    __wbg_msCrypto_bd5a034af96bcba6: (a: number) =>
      pushObject((heapObject(a) as { msCrypto: unknown }).msCrypto),
    __wbg_randomFillSync_6c25eac9869eb53c: (...a: number[]) =>
      guard((x: number, y: number) => {
        ;(heapObject(x) as { randomFillSync: (v: unknown) => void }).randomFillSync(takeObject(y))
      }, a),
    __wbg_call_d578befcc3145dee: (...a: number[]) =>
      guard((fn: number, self: number, arg: number) => {
        const target = heapObject(fn) as { call: (thisArg: unknown, ...rest: unknown[]) => unknown }
        pushObject(target.call(heapObject(self), heapObject(arg)))
      }, a),
    __wbg_new_with_length_9cedd08484b73942: (a: number) => pushObject(new Uint8Array(a >>> 0)),
    __wbg_length_0c32cb8543c8e4c8: (a: number) => (heapObject(a) as { length: number }).length,
    __wbg_prototypesetcall_3e05eb9545565046: (a: number, e: number, t: number) => {
      Uint8Array.prototype.set.call(heap().subarray(a >>> 0, (a >>> 0) + e), heapObject(t) as Uint8Array)
    },
    __wbg_subarray_0f98d3fb634508ad: (a: number, e: number, t: number) =>
      pushObject((heapObject(a) as Uint8Array).subarray(e >>> 0, t >>> 0)),
    __wbg_new_99cabae501c0a8a0: () => pushObject(new Map()),
    __wbg_now_88621c9c9a4f3ffc: () => Date.now(),
    __wbg_static_accessor_GLOBAL_THIS_a1248013d790bf5f: () => pushObject(globalThis),
    __wbg_static_accessor_GLOBAL_f2e0f995a21329ff: () => pushObject(globalThis),
    __wbg_static_accessor_SELF_24f78b6d23f286ea: () =>
      (globalThis as { self?: unknown }).self === undefined ? 0 : pushObject((globalThis as { self?: unknown }).self),
    __wbg_static_accessor_WINDOW_59fd959c540fe405: () =>
      (globalThis as { window?: unknown }).window === undefined ? 0 : pushObject((globalThis as { window?: unknown }).window),
    __wbg___wbindgen_throw_81fc77679af83bc6: (p: number, l: number) => {
      throw new Error(readString(p, l))
    },
    __wbg_Error_2e59b1b37a9a34c3: (p: number, l: number) => pushObject(new Error(readString(p, l))),
    __wbg___wbindgen_is_object_40c5a80572e8f9d3: (id: number) => {
      const v = heapObject(id)
      return typeof v === 'object' && v !== null
    },
    __wbg___wbindgen_is_string_b29b5c5a8065ba1a: (id: number) => typeof heapObject(id) === 'string',
    __wbg___wbindgen_is_function_49868bde5eb1e745: (id: number) => typeof heapObject(id) === 'function',
    __wbg___wbindgen_is_undefined_c0cca72b82b86f4d: (id: number) => heapObject(id) === undefined,
  }

  const instance = await WebAssembly.instantiate(module, { [IMPORT_MODULE]: imports })
  exports = instance.exports as unknown as Record<string, (...args: number[]) => number>

  return {
    exports,
    heap,
    view,
    readString,
    writeString,
    lastLength: () => lastLength,
    heapObject,
    pushObject,
    takeObject,
    callString,
    callPointer,
  }
}

/**
 * 生成运行时鉴权字段（`encrypt_user_info` / `key`）。
 *
 * 这两个字段是服务端识别用户身份的依据，后续 `QoderContext` 需要它们。
 */
export async function generateRuntimeAuthFields(user: QoderWasmUserInfo): Promise<QoderRuntimeAuthFields> {
  const g = await getGlue()
  const payload = JSON.stringify({
    uid: user.uid,
    security_oauth_token: user.securityOauthToken,
    organization_id: user.organizationId ?? '',
    organization_tags: user.organizationTags ?? [],
    data_policy_agreed: user.dataPolicyAgreed ?? false,
  })
  const raw = g.callString((stack) => {
    const a = g.writeString(payload)
    g.exports.generate_runtime_auth_fields!(stack, a, g.lastLength())
  })
  return JSON.parse(raw) as QoderRuntimeAuthFields
}

/**
 * 解密 Qoder 的模型目录缓存（`~/.qoder/.models/{uid}/catalog-v6`）。
 *
 * 目录文件是 WASM 加密的 base64 文本，明文是模型目录 JSON —— 里面有
 * **倍率**（`cost_multiplier`）等本插件兜底表尚未收录的字段。
 * WASM 自己导出了 `model_cache_decrypt`，直接调用即可（不是破解）。
 *
 * ⚠️ **`machineId` 是必填的第二参**（官方调用点 `model_cache_decrypt(i, A)`，
 * `A` 即 machineId）。漏传会得到 `AES-GCM decrypt failed: aead::Error` ——
 * 这个报错看起来像「密文损坏」，实际是缺参数。
 * 该值由本插件生成并随凭据持久化（`QoderCredential.machine_id`）。
 *
 * 仅用于离线读取本机缓存做核对/排查；线上模型列表仍走兜底表
 * （目录端点需 WASM 签名，见 `qoder-adapter.ts` 的 `listModels`）。
 */
export async function decryptModelCatalog(encrypted: string, machineId: string): Promise<unknown> {
  const g = await getGlue()
  const raw = g.callString((stack) => {
    const a = g.writeString(encrypted)
    const aLen = g.lastLength()
    const b = g.writeString(machineId)
    const bLen = g.lastLength()
    g.exports.model_cache_decrypt!(stack, a, aLen, b, bLen)
  })
  return JSON.parse(raw)
}

/**
 * Qoder 加密推理客户端。
 *
 * 持有 WASM 上下文（`QoderContext`）与运行时鉴权字段，用于反复生成
 * 加密推理请求。实例**不是**线程安全的；一个账号一个实例即可。
 */
export class QoderEncryptedInfer {
  private constructor(
    private readonly g: Glue,
    private readonly context: number,
    private readonly metadata: QoderClientMetadata,
    /** 加密端点所在 host（`agent_chat_generation`）。 */
    private readonly host: string,
  ) {}

  /** 创建客户端（会调 WASM 构造 `QoderContext`）。 */
  static async create(options: {
    user: QoderWasmUserInfo
    /** 设备标识（官方用硬件指纹；本插件用持久化的随机 UUID）。 */
    machineId: string
    metadata: QoderClientMetadata
    /**
     * 加密推理端点所在 host。
     *
     * ⚠️ 必须是 `api2.qoder.sh` 系 —— 传 `api2-v2.qoder.sh` 会 404
     * （那是公开 OpenAI 兼容端点的 host，两者不同）。
     */
    host: string
    /** 客户端版本；影响 `Cosy-Version` 与签名载荷。 */
    clientVersion?: string
  }): Promise<QoderEncryptedInfer> {
    const g = await getGlue()
    const fields = await generateRuntimeAuthFields(options.user)
    const version = options.clientVersion ?? COSY_VERSION

    const userInfoJson = JSON.stringify({
      uid: options.user.uid,
      encrypt_user_info: fields.encrypt_user_info,
      key: fields.key,
      organization_id: options.user.organizationId ?? '',
      organization_tags: options.user.organizationTags ?? [],
      data_policy_agreed: options.user.dataPolicyAgreed ?? false,
    })

    const context = g.callPointer((stack) => {
      const machine = g.writeString(options.machineId); const machineLen = g.lastLength()
      const ver = g.writeString(version); const verLen = g.lastLength()
      const info = g.writeString(userInfoJson); const infoLen = g.lastLength()
      const meta = g.writeString(JSON.stringify(options.metadata)); const metaLen = g.lastLength()
      // 参数顺序：(sp, machineId, len, version, len, userInfo, len, clientMeta, len)
      g.exports.qodercontext_new!(stack, machine, machineLen, ver, verLen, info, infoLen, meta, metaLen)
    })

    return new QoderEncryptedInfer(g, context, options.metadata, options.host)
  }

  /**
   * 构造加密推理请求（url / headers / body）。
   *
   * ⚠️ 返回的 `headers` **必须原样透传**：其中的 `Authorization` 是
   * WASM 生成的 `Bearer COSY.<载荷>.<签名>`。用普通 `Bearer <token>`
   * 覆盖会导致 `403 Signature invalid`。
   */
  prepareInfer(ask: QoderInferAsk): QoderInferRequest {
    const g = this.g
    const payload = buildQoderInferPayload(ask)

    const result = g.callPointer((stack) => {
      const host = g.writeString(this.host); const hostLen = g.lastLength()
      const body = g.writeString(JSON.stringify(payload)); const bodyLen = g.lastLength()
      const key = g.writeString(ask.modelKey); const keyLen = g.lastLength()
      const source = g.writeString(ask.source ?? 'system'); const sourceLen = g.lastLength()
      g.exports.qodercontext_prepareInferRequest!(
        stack, this.context, host, hostLen, body, bodyLen, key, keyLen, source, sourceLen,
      )
    })

    const headerMap = g.takeObject(g.exports.requestresult_headers!(result))
    const headers: Record<string, string> = {}
    if (headerMap instanceof Map) {
      for (const [k, v] of headerMap) headers[String(k)] = String(v)
    }

    const readResultString = (invoke: (stack: number, ptr: number) => void): string => {
      let out = ''
      const v = g.view()
      const stack = g.exports.__wbindgen_add_to_stack_pointer!(-16)
      try {
        invoke(stack, result)
        const ptr = v.getInt32(stack + 0, true)
        const len = v.getInt32(stack + 4, true)
        out = ptr ? g.readString(ptr, len) : ''
      } finally {
        g.exports.__wbindgen_add_to_stack_pointer!(16)
      }
      return out
    }

    return {
      // ⚠️ 参数顺序：(栈指针, ptr) —— 与直觉相反
      url: readResultString((stack, ptr) => g.exports.requestresult_url!(stack, ptr)),
      headers,
      body: readResultString((stack, ptr) => g.exports.requestresult_body!(stack, ptr)),
    }
  }
}

/** 供测试注入/复位（导出以便单测隔离）。 */
export const __testing = {
  resetGlue(): void {
    gluePromise = null
  },
  wasmPath: WASM_PATH,
}
