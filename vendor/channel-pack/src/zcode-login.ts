/**
 * ZCode 插件内登录（**不需要 ZCode IDE**）。
 *
 * ## 协议（从官方 asar 的 `startOAuthWithPolling` 解出，并经实测跑通）
 *
 * 官方 3.12.3+ 桌面版用的是**服务端中介的设备授权流** ——
 * 完全不经 `zcode://` 自定义协议回调，故普通 Node 进程就能走完：
 *
 * ```
 * ① POST /api/v1/oauth/cli/init
 *      Authorization: Bearer <自己生成的 32 字节 hex>
 *      body: { provider: "bigmodel" }
 *    → { flow_id, poll_token, authorize_url, expires_at, poll_interval_sec }
 *
 * ② 用户在浏览器打开 authorize_url 完成授权
 *      （授权在**服务端**完成，回调到 /oauth/cli/callback/bigmodel）
 *
 * ③ GET /api/v1/oauth/cli/poll/{flow_id}
 *      → { status: "pending" }                    继续等
 *      → { status: "ready", token, user, bigmodel: { access_token, refresh_token? } }
 * ```
 *
 * 本机实测（2026-09-29）：
 *
 * ```
 * ① HTTP 200  flow_id=ed3c813afe…  poll_interval_sec=2
 *    authorize_url=https://bigmodel.cn/login?appId=zcode&redirect=…&state=…
 * ③ HTTP 200  status=pending  （轮询正常）
 * ```
 *
 * ## 为什么这条路径是正确的
 *
 * 它**绕开了故障的 `POST /api/v1/oauth/token`**（`dsh-free-glm` 记录该端点
 * 自 2026-09-28 起稳定 500 / code 2007）—— token 由轮询直接返回，
 * 完全不经过它。
 *
 * ## 凭据的**唯一**来源
 *
 * 就是本文件这条授权流。此前还存在一条「回退：解密官方客户端的
 * `~/.zcode/v2/credentials.json`」的旁路，它已于 2026-10-05 整体删除
 * （理由见 `zcode.ts` 文件头）⇒ 现在**不读本机任何 ZCode 数据**。
 */

import { randomBytes, randomUUID } from 'node:crypto'

/** ZCode 平台 origin。 */
export const ZCODE_ORIGIN = 'https://zcode.z.ai'

/** 设备授权流的初始化端点。 */
export const ZCODE_OAUTH_CLI_INIT_URL = `${ZCODE_ORIGIN}/api/v1/oauth/cli/init`

/** 轮询端点（需拼 `flow_id`）。 */
export const zcodeOauthCliPollUrl = (flowId: string): string =>
  `${ZCODE_ORIGIN}/api/v1/oauth/cli/poll/${encodeURIComponent(flowId)}`

/**
 * 支持的 provider 标识（官方 `Ne` / `"zai"` 两个）。
 *
 * ⚠ 实测 `bigmodel`（对应 `Ne`）在授权 URL 上追加的是 `redirect=`；
 * 官方对 `zai` 追加的是 `redirect_uri=` —— 两者语义相同但参数名不同，
 * 故这里保留区分。
 *
 * ## 两者的实际差异（2026-10-02 实测）
 *
 * | provider | 授权页 | 凭据落点 | 适用 |
 * |---|---|---|---|
 * | `bigmodel` | `bigmodel.cn/login?appId=zcode&redirect=…` | `data.bigmodel` | 智谱开放平台（国内） |
 * | `zai` | `chat.z.ai/api/oauth/authorize?client_id=…&redirect_uri=…` | `data.zai` | z.ai（国际版） |
 *
 * 两者的 `init` 响应结构**完全一致**（`flow_id` / `poll_token` /
 * `authorize_url` / `expires_at` / `poll_interval_sec`），差异只在
 * ready 响应里第三方 token 落在哪个块 —— 故 `pollZcodeLogin` 对两者
 * 都做了兼容（见那里的字段注释）。
 */
export const ZCODE_LOGIN_PROVIDER = 'bigmodel'

/** 可选的登录 provider。 */
export type ZcodeLoginProvider = 'bigmodel' | 'zai'

/** ① 的响应。 */
export interface ZcodeLoginFlow {
  /** 流程 id（③ 用它轮询）。 */
  flowId: string
  /**
   * 轮询令牌。
   *
   * ⚠ 官方的实现里 ③ **只带 flow_id、不带这个 token**（它把
   * `oauthFlowStartGeneration` 用作并发保护）。这里保留字段以便诊断，
   * 但**不**把它当作 ③ 的鉴权凭证 —— 实测 ③ 不带它也返回 200。
   */
  pollToken?: string
  /** 用户在浏览器打开这个 URL 完成授权。 */
  authorizeUrl: string
  /** 过期时刻（Unix 秒）。 */
  expiresAt: number
  /** 官方建议的轮询间隔（秒）。 */
  pollIntervalSec: number
  /** 发起这次流程用的 CLI 会话密钥（官方用它做 Bearer）。 */
  flowSecret: string
}

/** ③ 在 `status: "ready"` 时返回的东西。 */
export interface ZcodeLoginResult {
  /** zcode JWT —— 免费额度通道的 `Authorization: Bearer`。 */
  zcodeJwt: string
  /** 大模型 access token（bigmodel 侧；`zai` 登录时为 `undefined`）。 */
  bigmodelAccessToken?: string
  /** 大模型 access token（zai 侧；`bigmodel` 登录时为 `undefined`）。 */
  zaiAccessToken?: string
  /** 大模型 refresh token（若服务端给）。 */
  bigmodelRefreshToken?: string
  /** 用户 id。 */
  userId: string
  /** 展示名（用户名 / 邮箱 / id）。 */
  displayName: string
}

/** 一次登录尝试的失败原因（人类可读）。 */
export class ZcodeLoginError extends Error {
  constructor(message: string, readonly kind: 'init' | 'poll' | 'timeout' | 'denied' | 'cancelled') {
    super(message)
    this.name = 'ZcodeLoginError'
  }
}

/** 生成 CLI 会话密钥（官方 `UH(32).toString("hex")` = 32 字节 hex）。 */
export function generateFlowSecret(): string {
  return randomBytes(32).toString('hex')
}

/**
 * ★ 生成一个**自用**的设备标识。
 *
 * ## 为什么可以自己生成（实测依据）
 *
 * `X-Device-Mid` 是 `billing/*` 与推理端点的**硬需求**（缺它回
 * `400 {"code":3001,"msg":"parameter error"}`），但它的**值本身**并不被
 * 绑定校验 —— 实测同一 JWT 换任意随机 UUID 都返回 200：
 *
 * ```
 * 官方 mid      → 200
 * 随机 mid #1   → 200
 * 随机 mid #1 重试 → 200
 * 随机 mid #2   → 200（间隔后重测；首次的 429 是限流）
 * 全新随机 mid  → 200
 * 无 mid        → 400 code 3001   ← 证明它确实必需
 * ```
 *
 * ⇒ 插件可以自己生成并持久化一个稳定的 UUID，**不再依赖官方客户端的
 * `telemetry-state.json`** —— 这是「脱离 IDE」的关键一步。
 *
 * ⚠ 生成后**必须持久化**：同一账号换 mid 会让服务端的用量归集看起来
 * 像换了一台设备（虽然不报错，但不自然）。故存进凭据本体，
 * 登录一次就固定下来。
 */
export function generateDeviceMid(): string {
  return randomUUID()
}

/** 发起登录：拿到 `authorize_url`。 */
export async function startZcodeLogin(
  fetchImpl: typeof fetch = fetch,
  options: { provider?: ZcodeLoginProvider; appVersion?: string } = {},
): Promise<ZcodeLoginFlow> {
  const flowSecret = generateFlowSecret()
  const appVersion = options.appVersion ?? '3.14.3'
  const provider = options.provider ?? ZCODE_LOGIN_PROVIDER

  let response: Response
  try {
    response = await fetchImpl(ZCODE_OAUTH_CLI_INIT_URL, {
      method: 'POST',
      headers: {
        // ⚠ 这里的 Bearer 是**我们自己生成的会话密钥**，不是用户凭据 ——
        // 官方就是这么做的（`UH(32).toString("hex")`）。
        Authorization: `Bearer ${flowSecret}`,
        'Content-Type': 'application/json',
        'User-Agent': `ZCode/${appVersion}`,
        'HTTP-Referer': ZCODE_ORIGIN,
        'X-ZCode-App-Version': appVersion,
        'X-Platform': 'win32',
      },
      body: JSON.stringify({ provider }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    throw new ZcodeLoginError(
      `无法连接 ZCode 授权服务：${error instanceof Error ? error.message : String(error)}`,
      'init',
    )
  }

  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new ZcodeLoginError(`授权初始化失败（HTTP ${response.status}）：${text.slice(0, 200)}`, 'init')
  }

  let parsed: {
    code?: unknown
    msg?: unknown
    data?: {
      flow_id?: unknown
      poll_token?: unknown
      authorize_url?: unknown
      expires_at?: unknown
      poll_interval_sec?: unknown
    }
  }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new ZcodeLoginError(`授权初始化响应不是 JSON：${text.slice(0, 200)}`, 'init')
  }

  const data = parsed.data
  const flowId = data?.flow_id
  const authorizeUrl = data?.authorize_url
  if (typeof flowId !== 'string' || flowId.length === 0) {
    throw new ZcodeLoginError(
      `授权初始化响应缺 flow_id：${typeof parsed.msg === 'string' ? parsed.msg : text.slice(0, 160)}`,
      'init',
    )
  }
  if (typeof authorizeUrl !== 'string' || !authorizeUrl.startsWith('https://')) {
    throw new ZcodeLoginError('授权初始化响应缺合法的 authorize_url', 'init')
  }

  const expiresAt = typeof data?.expires_at === 'number' ? data.expires_at : 0
  // ⚠ 官方校验 `poll_interval_sec` 必须 ≥1 秒且 < 总时长；这里保守兜底。
  const rawInterval = typeof data?.poll_interval_sec === 'number' ? data.poll_interval_sec : 2
  const pollIntervalSec = Number.isFinite(rawInterval) && rawInterval >= 1 ? rawInterval : 2

  return {
    flowId,
    pollToken: typeof data?.poll_token === 'string' ? data.poll_token : undefined,
    authorizeUrl,
    expiresAt,
    pollIntervalSec,
    flowSecret,
  }
}

/** ③ 的单次轮询结果。 */
export type ZcodePollOutcome =
  | { kind: 'pending' }
  | { kind: 'ready'; result: ZcodeLoginResult }
  | { kind: 'failed'; message: string }

/** 轮询一次。 */
export async function pollZcodeLogin(
  flow: Pick<ZcodeLoginFlow, 'flowId' | 'flowSecret'>,
  fetchImpl: typeof fetch = fetch,
  appVersion = '3.14.3',
): Promise<ZcodePollOutcome> {
  let response: Response
  try {
    response = await fetchImpl(zcodeOauthCliPollUrl(flow.flowId), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${flow.flowSecret}`,
        'User-Agent': `ZCode/${appVersion}`,
        'HTTP-Referer': ZCODE_ORIGIN,
        'X-ZCode-App-Version': appVersion,
      },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    /**
     * ⚠ 网络抖动**不算失败** —— 返回 `pending` 让调用方继续轮询。
     * 这与官方实现一致（它把 4xx（除 408/429）当失败，其余重试）。
     */
    void error
    return { kind: 'pending' }
  }

  /**
   * ⚠ HTTP 4xx（除 408/429）才是**终态**失败；5xx 与网络错误继续重试。
   * 官方原实现：`status >= 400 && status < 500 && status !== 408 && status !== 429`。
   */
  if (response.status >= 400 && response.status < 500 &&
      response.status !== 408 && response.status !== 429) {
    const text = await response.text().catch(() => '')
    return { kind: 'failed', message: `轮询被拒（HTTP ${response.status}）：${text.slice(0, 200)}` }
  }
  if (!response.ok) return { kind: 'pending' }

  let parsed: {
    code?: unknown
    msg?: unknown
    data?: {
      status?: unknown
      token?: unknown
      user?: { user_id?: unknown; id?: unknown; name?: unknown; email?: unknown }
      bigmodel?: { access_token?: unknown; accessToken?: unknown; refresh_token?: unknown; refreshToken?: unknown }
      zai?: { access_token?: unknown; accessToken?: unknown; refresh_token?: unknown; refreshToken?: unknown }
    }
  }
  try {
    parsed = await response.json() as typeof parsed
  } catch {
    return { kind: 'pending' }
  }

  const data = parsed.data
  if (parsed.code !== 0 || data === undefined || data === null) {
    return { kind: 'pending' }
  }
  const status = typeof data.status === 'string' ? data.status : undefined
  if (status === 'pending') return { kind: 'pending' }
  if (status === 'failed') return { kind: 'failed', message: '用户拒绝了授权或授权失败' }
  if (status !== 'ready') {
    return { kind: 'failed', message: `轮询响应状态无法识别：${String(status)}` }
  }

  /**
   * ⚠ `token`（zcode JWT）与 `user.user_id` **都必需**（官方断言 `!g || !f || !v`
   * 即视为无效响应）。
   *
   * 第三方 access token 则**按登录 provider 取对应分支**：`zai` 登录回
   * `data.zai`、`bigmodel` 登录回 `data.bigmodel`。
   *
   * 权威依据是官方 bundle 的 ready 解析器（`zcode.cjs` 的 `W7s`）——它只认
   * `data.zai.access_token`，且把 `zai` 作为**通用**第三方凭据分支：
   *
   * ```js
   * function W7s(e){ let t=KOe(e.user), n=KOe(e.zai)
   *   if(typeof e.token!="string" || !t || typeof t.user_id!="string"
   *      || !n || typeof n.access_token!="string") throw ...
   *   return { status:"ready", token:e.token, user:{...}, zai:{access_token:n.access_token} } }
   * ```
   *
   * 而 `bigmodel` 登录实测返回的是 `data.bigmodel`（本插件早期只走这一条，
   * 故此前把它写死）。两者**不可互相替代**：只认 `bigmodel` 会让 `zai`
   * 登录在「缺关键字段」处失败，只认 `zai` 会让 `bigmodel` 登录失败。
   *
   * ⚠ 这个字段**不参与推理**：适配器只用 `credential.zcode_jwt`
   * 作 `Authorization`（见 `zcode-adapter.ts` 的 `Bearer ${credential.zcode_jwt}`），
   * 第三方 token 仅作备用身份。故这里**放宽为「二者有其一」**，并把实际
   * 拿到的那条存下来，而不是在缺失时拒绝整轮登录。
   */
  const zcodeJwt = typeof data.token === 'string' ? data.token : undefined
  const pickToken = (
    block: { access_token?: unknown; accessToken?: unknown } | undefined,
  ): string | undefined => {
    if (typeof block?.access_token === 'string') return block.access_token
    if (typeof block?.accessToken === 'string') return block.accessToken
    return undefined
  }
  const bigmodelAccessToken = pickToken(data.bigmodel)
  const zaiAccessToken = pickToken(data.zai)
  const userId = typeof data.user?.user_id === 'string'
    ? data.user.user_id
    : typeof data.user?.id === 'string'
      ? data.user.id
      : undefined

  if (zcodeJwt === undefined || userId === undefined) {
    return { kind: 'failed', message: '轮询响应缺关键字段（token / user_id）' }
  }
  if (bigmodelAccessToken === undefined && zaiAccessToken === undefined) {
    return {
      kind: 'failed',
      message: '轮询响应缺第三方 access_token（data.zai 与 data.bigmodel 均为空）',
    }
  }

  const refreshRaw = data.bigmodel?.refresh_token ?? data.bigmodel?.refreshToken
    ?? data.zai?.refresh_token ?? data.zai?.refreshToken
  const displayName = typeof data.user?.name === 'string' && data.user.name.length > 0
    ? data.user.name
    : typeof data.user?.email === 'string' && data.user.email.length > 0
      ? data.user.email
      : userId

  return {
    kind: 'ready',
    result: {
      zcodeJwt,
      bigmodelAccessToken,
      zaiAccessToken,
      bigmodelRefreshToken: typeof refreshRaw === 'string' ? refreshRaw : undefined,
      userId,
      displayName,
    },
  }
}

/**
 * 一次性完成「发起 → 轮询到 ready」。
 *
 * ⚠ `onAuthorizeUrl` 必须在**返回 URL 后立刻**调用（前端据此弹窗），
 * 因为 `window.open` 只在用户手势窗口内有效。
 *
 * @param options.timeoutMs 总超时（默认 5 分钟，与官方 `zH` 一致）
 * @param options.signal    外部取消（用户在 Channel Pack 点「取消」）
 */
export async function runZcodeLogin(
  options: {
    fetchImpl?: typeof fetch
    appVersion?: string
    /** 登录 provider（默认 `bigmodel`；`zai` 走 chat.z.ai 国际版）。 */
    provider?: ZcodeLoginProvider
    timeoutMs?: number
    signal?: AbortSignal
    /** 拿到授权 URL 时立刻回调（前端弹窗用）。 */
    onAuthorizeUrl?: (url: string) => void
    /** 轮询间隔覆盖（测试用）。 */
    pollIntervalMs?: number
  } = {},
): Promise<ZcodeLoginResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 300_000

  const flow = await startZcodeLogin(fetchImpl, {
    appVersion: options.appVersion,
    provider: options.provider,
  })
  options.onAuthorizeUrl?.(flow.authorizeUrl)

  const intervalMs = options.pollIntervalMs ?? Math.max(1_000, flow.pollIntervalSec * 1_000)
  /**
   * 轮询截止时刻。
   *
   * ⚠ **不能给 `expires_at` 路径设下限**（曾经写成 `Math.max(5_000, …)`）。
   * 那会在服务端给出的授权有效期已经很近时，让本地**比服务端更晚**放弃 ——
   * 于是用户明明已经无法再授权了，我们还在空转，最终报「超时」而不是
   * 更准确的「授权流程已过期」。
   *
   * 正确语义：截止时刻 = **min(调用方超时, 服务端有效期 - 余量)**。
   * 余量留 1 秒（官方留 5 秒是为了网络往返，但我们这里间隔最低 1 秒即可）。
   */
  const remainingFromServer = flow.expiresAt > 0
    ? Math.max(0, flow.expiresAt * 1_000 - Date.now() - 1_000)
    : timeoutMs
  const deadline = Date.now() + Math.min(timeoutMs, remainingFromServer)

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) {
      throw new ZcodeLoginError('登录已取消', 'cancelled')
    }
    const outcome = await pollZcodeLogin(flow, fetchImpl, options.appVersion)
    if (outcome.kind === 'ready') return outcome.result
    if (outcome.kind === 'failed') {
      throw new ZcodeLoginError(outcome.message, 'denied')
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, intervalMs)
      /**
       * ⚠ **有意 `unref()`**：本函数跑在 DSH 常驻进程里，不该让一次
       * 未完成的登录轮询**拖住进程退出**（用户点了登录又立刻关 DSH 时）。
       *
       * ⚠ 但这个选择在**短寿脚本**里会出问题：脚本除这个 sleep 外没有别的
       * pending handle，`unref()` 会让 Node 判定「无事可做」而直接退出
       * （表现为 `Detected unsettled top-level await` + exit 13）—— 实测踩过。
       *
       * ⇒ **两种场景诉求相反，故意不统一**：库代码（常驻）用 unref，
       * 一次性脚本自己写 `setTimeout`（不要 unref）。
       */
      timer.unref?.()
    })
  }

  throw new ZcodeLoginError(
    `登录超时（${Math.round((Date.now() - (deadline - timeoutMs)) / 1000)} 秒内未完成授权）。` +
    `请重新发起并用浏览器打开授权页。`,
    'timeout',
  )
}
