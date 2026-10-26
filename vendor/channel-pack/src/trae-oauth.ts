/**
 * TRAE 登录流程：AuthCode 换 Token + 用户信息查询。
 *
 * 与 LobsterAI 同样采用**本地回调**方式——TRAR 强制回调 `127.0.0.1`，
 * 浏览器与服务器无需同机（回调链接可粘贴到浏览器所在机器执行授权）。
 *
 * ## 回调端口策略
 *
 * TRAE 登录页 `https://www.trae.cn/authorization` 强制回调
 * `http://127.0.0.1:18080/authorize`（端口固定 18080，对齐 Go 端默认）。
 *
 * ## 两步式模式
 *
 * 与 `lobsterai-oauth.ts` 的 `startLobsteraiLoginFlow` 同款模式：
 * - `startTraeLoginFlow`：起回调服务器并立即返回 `loginUrl`，由调用方先打开窗口；
 * - `runTraeLoginFlow`：阻塞式，等待回调完成后再返回（供 CLI / E2E 使用）。
 * - `exchangeTraeCallback`：纯函数，用回调解出的凭证直接换凭据（供两步式回调服务器使用）。
 */

import { createServer, type Server } from 'node:http'
import { credentialExpiresAtMs, jwtExpiresAtMs } from './credential-expiry.js'
import {
  TRAE_EXCHANGE_PATH,
  TRAE_LOGIN_TIMEOUT_MS,
  TRAE_REQUEST_TIMEOUT_MS,
  TRAE_USER_INFO_PATH,
  buildTraeCredential,
  generateDeviceId,
  generateMachineId,
  parseTraeExchangeResponse,
  parseTraeUserInfoResponse,
  traeOAuthHeaders,
  type TraeCredential,
  type TraeExchangeResult,
  type TraeUserInfoResult,
} from './trae.js'
import type { TraeProduct } from './trae-product.js'

/** 回调端口：TRAE 默认 18080（被占用时自动回退随机端口，见 `listenWithFallback`）。 */
const TRAE_CALLBACK_PORT = 18080

/**
 * 登录流程选项。
 */
export interface TraeLoginFlowOptions {
  /** 可选的 fetch 实现（测试用）。 */
  fetcher?: typeof fetch
  /** 自定义回调端口（默认 18080）。 */
  callbackPort?: number
}

/** 登录流程的结果。 */
export interface TraeLoginFlowResult {
  /** 可持久化的凭据 JSON 字符串。 */
  access: string
  /** 凭据过期的毫秒时间戳（无法解析时为 0）。 */
  expires: number
  /** 打开的登录 URL。 */
  loginUrl: string
  /** 凭据是否携带 refresh_token。 */
  refreshable: boolean
}

/**
 * 由 machineId + deviceId 派生稳定的 `login_trace_id`（hex16）。
 *
 * 对齐 Go 端 `machineTraceID`（`callback.go:55-63`）：取拼接串的**尾部 16 字符**。
 * 作用是让回调能被关联回本次登录的 pending（TRAE 回调不保证回传
 * machine_id/device_id，但会回传 login_trace_id）。
 */
export function machineTraceId(machineId: string, deviceId: string): string {
  const joined = machineId + deviceId
  return joined.length >= 16
    ? joined.slice(-16)
    : joined.padStart(16, '0')
}

/**
 * 构建 TRAE 登录 URL。
 *
 * 对齐 `login.sh:47-72` / Go 端 `BuildLoginURL`（`callback.go:28-51`）的
 * **完整 17 参数集**。
 *
 * ## ⚠️ 为什么参数一个都不能少（真实缺陷）
 *
 * 早期实现只发了 `client_id` / `machine_id` / `device_id` / `callback_url`
 * / `redirect_uri` 五个参数 —— 与真实协议**完全不匹配**：
 *
 * 1. **回调地址的参数名是 `auth_callback_url`**，不是 `callback_url`
 *    （也没有 `redirect_uri`）。名字错了，TRAE 拿不到回调地址，
 *    登录页会**永远停在授权中**，既不跳转也不回传任何东西。
 * 2. `auth_from` / `login_channel` / `auth_type` / `redirect` 决定走哪条
 *    授权通道；缺失时授权流程不会走到本地回传分支。
 * 3. `login_trace_id` 是回调**反查 pending** 的唯一凭据。
 * 4. `x_*` 系列是客户端形态伪装（设备/应用信息），缺席可能被风控拦截。
 *
 * 用户症状即为「网页一直停在认证中的界面」。
 */
export function buildTraeLoginURL(
  product: TraeProduct,
  machineId: string,
  deviceId: string,
  callbackUrl: string,
): string {
  const params = new URLSearchParams({
    login_version: '1',
    auth_from: 'solo',
    login_channel: 'native_ide',
    plugin_version: product.pluginVersion,
    auth_type: 'local',
    client_id: product.clientId,
    redirect: '0',
    login_trace_id: machineTraceId(machineId, deviceId),
    // ⚠️ 参数名必须是 auth_callback_url（见函数注释）。
    auth_callback_url: callbackUrl,
    machine_id: machineId,
    device_id: deviceId,
    x_device_id: deviceId,
    x_machine_id: machineId,
    x_device_brand: 'PC',
    x_device_type: 'PC',
    x_os_version: '1.0',
    x_app_version: product.ideVersion,
    x_app_type: 'stable',
  })
  return `${product.consoleHost}/authorization?${params.toString()}`
}

/**
 * TRAE 登录回调解出的原始凭证。
 *
 * 对齐 Go 端 `CallbackInfo`（`callback.go:66-73`）与 `login.sh:153-166`。
 */
export interface TraeCallbackInfo {
  /** 优先取 query.refreshToken；缺失时回退 userJwt.RefreshToken。 */
  refreshToken: string
  /** 无 refreshToken 时的兜底 access token（userJwt.Token）。 */
  accessToken: string
  uid: string
  nickname: string
  /** ⚠️ 回调里字段名是 **TenantID**（不是 EnterpriseID）。 */
  enterpriseId: string
  /**
   * **PKCE 新流程**携带的授权码（`code` / `authCodeInfo.code`）。
   *
   * ## 为什么需要它（对齐 `Trae2api-cn/src/main.py:478-484`）
   *
   * TRAE 授权页实际会走**两套并列的流程**：
   *
   * 1. **新流程**（`code_challenge` / PKCE）：回调带 `authCodeInfo` / `code`；
   * 2. **老流程**（`refreshToken`）：回调**直接回传 token**（当前 `auth_type=local`
   *    走的即是这条，见 `buildTraeLoginURL`）。
   *
   * 早期实现只认第 2 条，并把「没有 refreshToken」一律判为**无效回调** ——
   * 一旦上游切到 PKCE 流程，合法回调会被误判为失败，症状与「一直认证中」
   * 一模一样（因为失败路径当时不会落定结果 Promise）。
   *
   * 本字段用于**识别**该形态并给出精确报错，而不是把它错报成
   * 「缺少 refreshToken」。
   */
  authCode?: string
}

/**
 * `parseTraeCallback` 的详细结果。
 *
 * 除了「解出了什么」，还回答「**为什么没解出来**」—— 回调服务器需要把原因
 * 写进 HTTP 响应与日志，否则用户只看到一句含糊的
 * `missing refreshToken / userJwt.Token`，无法区分「上游换了流程」与「参数名变了」。
 */
export type TraeCallbackParseResult =
  | { ok: true; info: TraeCallbackInfo }
  | { ok: false; reason: string; authCodeFlow: boolean }

/**
 * 解析回调里 URL 编码的 JSON 参数（`userInfo` / `userJwt`）。
 *
 * 对齐 Go 端 `parseJSONParam`（`callback.go:77-92`）与 `login.sh:122-133`：
 * `URLSearchParams` 已解一层 percent-encoding，但 TRAE 的 `userInfo` 中文
 * 存在**双重编码**（实测昵称乱码 `Óû§8847309959`），故再容错解一层。
 */
function parseJsonParam(raw: string | null): Record<string, unknown> | undefined {
  if (raw === null || raw.length === 0) return undefined
  const candidates = [raw]
  try {
    const unescaped = decodeURIComponent(raw)
    if (unescaped !== raw) candidates.push(unescaped)
  } catch { /* 非法编码：只用原串 */ }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch { /* 试下一个 */ }
  }
  return undefined
}

/** 从 JSON 对象读字符串（兼容数字）。 */
function jsonString(source: Record<string, unknown> | undefined, key: string): string {
  if (source === undefined) return ''
  const value = source[key]
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

/**
 * 修复回调 `userInfo.ScreenName` 的**双重编码乱码**。
 *
 * 对齐 `login.sh:135-150` 的 `fix_mojibake`：TRAE 回调的中文昵称会被错误地
 * 按 latin-1/cp1252 解读一次，实测得到 `Óû§8847309959` 这类乱码。
 * 尝试回转编码；无法修复且**不含任何 CJK 字符**时，回退为「用户+uid末4位」。
 */
export function fixNicknameMojibake(raw: string, uid: string): string {
  if (raw.length === 0) return raw
  // 只尝试 latin1：Node 的 Buffer 没有 cp1252 编码名（`Buffer.from(s,'cp1252')` 抛
  // ERR_UNKNOWN_ENCODING）。latin1 已覆盖实测的乱码形态。
  for (const encoding of ['latin1'] as const) {
    try {
      const fixed = Buffer.from(raw, encoding).toString('utf8')
      if (fixed.length > 0 && !fixed.includes('\uFFFD')
        && [...fixed].every((ch) => ch.charCodeAt(0) >= 32)) {
        return fixed
      }
    } catch { /* 解码失败：走下面的兜底 */ }
  }
  // 无 CJK → 判定为乱码，回退到可读占位（防止把乱码写进凭据）。
  if (!/[\u4e00-\u9fff]/.test(raw)) return `用户${uid.slice(-4)}`
  return raw
}

/**
 * 解析 TRAE 登录回调 URL，提取凭证字段。
 *
 * ## ⚠️ 回调**没有** `code` 参数（真实缺陷的根因）
 *
 * 真实回调形如（`login.sh:117` 注释、`callback.go:117`）：
 * ```
 * http://127.0.0.1:18080/authorize?refreshToken=...&userInfo={...}&userJwt={...}
 * ```
 * 即它**直接回传 token**，不是 OAuth 的 `?code=` 授权码交换。
 *
 * 早期实现按 OAuth 惯例去找 `?code=`，于是 `parseAuthCode` **恒返回 undefined**
 * → 回调服务器回 400 "Missing code" → 结果 Promise 永不落定
 * → 前端 `login.poll` 永远拿不到 `done:true` → **网页一直停在认证中**。
 *
 * ## ⚠️ 但「带 code」的回调**不是**无效回调（第二次修正）
 *
 * 上述结论只说明「token 直传」是**当时实测的**流程，并不意味着带 `code` 的
 * 回调可以判为非法。TRAE 授权页并存两套流程（`Trae2api-cn/src/main.py:478-484`）：
 * 新流程走 PKCE（回带 `code` / `authCodeInfo`），老流程直传 `refreshToken`。
 *
 * 因此本函数对两种形态**都返回结果**：
 * - 有 token（refreshToken / userJwt.Token）→ 正常解出；
 * - 只有 `code` / `authCodeInfo` → 也解出，把 code 放进 `authCode`，
 *   由调用方**明确报出「上游走了 PKCE 流程，本实现暂不支持」**，
 *   而不是含糊地说「缺少 refreshToken」。
 *
 * 需要区分失败原因时用 {@link parseTraeCallbackDetailed}。
 */
export function parseTraeCallback(rawUrl: string): TraeCallbackInfo | undefined {
  const result = parseTraeCallbackDetailed(rawUrl)
  return result.ok ? result.info : undefined
}

/**
 * 解析回调并**带回失败原因**（供回调服务器写出可读文案与日志）。
 *
 * @see parseTraeCallback 了解两套流程的背景
 */
export function parseTraeCallbackDetailed(rawUrl: string): TraeCallbackParseResult {
  let query: URLSearchParams
  try {
    // 允许传入相对形式（`/authorize?...`），补全成完整 URL 再解析。
    query = new URL(rawUrl.startsWith('http') ? rawUrl : `http://127.0.0.1${rawUrl}`).searchParams
  } catch {
    return { ok: false, reason: '回调 URL 无法解析', authCodeFlow: false }
  }

  const userInfo = parseJsonParam(query.get('userInfo'))
  const userJwt = parseJsonParam(query.get('userJwt'))

  let refreshToken = query.get('refreshToken') ?? ''
  const uid = jsonString(userInfo, 'UserID')
  const nicknameRaw = jsonString(userInfo, 'ScreenName')
  // ⚠️ 回调字段名是 TenantID（见 TraeCallbackInfo 说明）。
  const enterpriseId = jsonString(userInfo, 'TenantID')

  const jwtToken = jsonString(userJwt, 'Token')
  const jwtRefresh = jsonString(userJwt, 'RefreshToken')

  // 对齐 login.sh:165-166：query 缺 refreshToken 时回退 userJwt.RefreshToken。
  if (refreshToken.length === 0) refreshToken = jwtRefresh

  // ── PKCE 形态探测：code / authCodeInfo.code ──
  //
  // `authCodeInfo` 可能是 JSON 字符串，也可能是纯 code 字符串。
  const authCodeInfo = parseJsonParam(query.get('authCodeInfo'))
  //
  // ⚠️ 这里逐个来源取第一个**非空**值，不能用 `??` 串起来：`jsonString`
  // 取不到时返回**空串**而非 undefined，空串不是 nullish，会让后续来源
  // 永远短路掉（`a ?? b ?? c` 里 a='' 就直接返回 ''）。
  const authCodeCandidates: string[] = [
    query.get('code') ?? '',
    query.get('authCode') ?? '',
    jsonString(authCodeInfo, 'code'),
    jsonString(authCodeInfo, 'authCode'),
    // authCodeInfo 为**纯 code 字符串**（非 JSON）时 parseJsonParam 解不出，
    // 故把原始值也作为兜底候选放在最后 —— 前面能解出 JSON 字段时不会走到这里。
    query.get('authCodeInfo') ?? '',
  ]
  const authCode = authCodeCandidates.find((candidate) => candidate.trim().length > 0)?.trim() ?? ''

  const info: TraeCallbackInfo = {
    refreshToken,
    // 仅在「无 refreshToken」时才用 userJwt.Token 兜底（login.sh:186-195）。
    accessToken: refreshToken.length === 0 ? jwtToken : '',
    uid,
    nickname: fixNicknameMojibake(nicknameRaw, uid),
    enterpriseId,
  }
  if (authCode.length > 0) info.authCode = authCode

  // ── 判定 ──
  if (info.refreshToken.length === 0 && info.accessToken.length === 0) {
    if (authCode.length > 0) {
      // ⚠️ 关键：这是**合法回调**，只是走了我们尚未支持的 PKCE 分支。
      // 不能判为「无效」，否则用户看到的错误会指向完全错误的方向。
      return {
        ok: false,
        authCodeFlow: true,
        reason: '上游返回了 PKCE 授权码（code/authCodeInfo），本实现暂不支持该流程；'
          + '请确认 TRAE 授权页是否已切换到新流程',
      }
    }
    return {
      ok: false,
      authCodeFlow: false,
      reason: '回调未携带 refreshToken / userJwt.Token / code',
    }
  }
  return { ok: true, info }
}

/**
 * 用**回调解出的凭证**换取最终凭据（供回调服务器与 E2E 复用）。
 *
 * 对齐 `login.sh:168-212` 的两条分支：
 * 1. 有 `refreshToken` → `ExchangeToken` 换新 access（并**轮换** refreshToken）；
 * 2. 无 `refreshToken` → 直接用 `userJwt.Token` 兜底，不走 ExchangeToken。
 *
 * 随后调 `GetUserInfo` 补齐 uid / nickname / enterpriseId；**失败不阻塞**
 * （回退用回调 `userInfo` 的值）—— 对齐 `login.sh:197-209` 的容错。
 *
 * 不涉及本地服务器，纯 HTTP 请求。
 *
 * @param callback `parseTraeCallback` 的解出结果
 * @param session 登录时生成的 machineId / deviceId
 * @param product 产品配置
 * @param fetcher fetch 实现
 * @param nowMs 当前时间（测试注入）
 */
export async function exchangeTraeCallback(
  callback: TraeCallbackInfo,
  session: { machineId: string; deviceId: string },
  product: TraeProduct,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<TraeCredential> {
  let exchange: TraeExchangeResult
  if (callback.refreshToken.length > 0) {
    // ── 分支 1：ExchangeToken（access + refreshToken 轮换）──
    const exchangeBody = {
      ClientID: product.clientId,
      RefreshToken: callback.refreshToken,
      ClientSecret: '-',
      UserID: '',
    }
    const exchangeResp = await fetcher(`${product.oauthHost}${TRAE_EXCHANGE_PATH}`, {
      method: 'POST',
      headers: traeOAuthHeaders(product),
      body: JSON.stringify(exchangeBody),
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
    })
    if (!exchangeResp.ok) {
      const text = await exchangeResp.text().catch(() => '')
      throw new Error(`TRAE ExchangeToken 失败（HTTP ${exchangeResp.status}）：${text.length > 200 ? text.slice(0, 200) : text}`)
    }
    const parsed = parseTraeExchangeResponse(await exchangeResp.json() as Record<string, unknown>)
    if (parsed === undefined) throw new Error('TRAE ExchangeToken 响应缺少 Token')
    exchange = parsed
  } else {
    // ── 分支 2：无 refreshToken，直接用 userJwt.Token 兜底 ──
    exchange = {
      accessToken: callback.accessToken,
      refreshToken: '',
      tokenExpireAt: 0,
      tokenExpireDuration: 0,
      refreshExpireAt: 0,
    }
  }

  // GetUserInfo 补齐信息；失败不阻塞（回退回调 userInfo）。
  let userInfo: TraeUserInfoResult = {
    uid: callback.uid,
    screenName: callback.nickname,
    enterpriseId: callback.enterpriseId,
    // ⚠️ 回调的 `userInfo` 参数**不含**脱敏手机号 / 邮箱（实测只有 UserID /
    // ScreenName / TenantID），它们只在 `GetUserInfo` 响应里 —— 故这里回退空串，
    // 由下面的 GetUserInfo 分支补上。
    phone: '',
    email: '',
  }
  try {
    const uHeaders = traeOAuthHeaders(product)
    uHeaders['X-Cloudide-Token'] = exchange.accessToken
    const userInfoResp = await fetcher(`${product.oauthHost}${TRAE_USER_INFO_PATH}`, {
      method: 'POST',
      headers: uHeaders,
      body: JSON.stringify({ ReqSource: 'IDE', IDEVersion: product.ideVersion }),
      signal: AbortSignal.timeout(TRAE_REQUEST_TIMEOUT_MS),
    })
    if (userInfoResp.ok) {
      const fetched = parseTraeUserInfoResponse(await userInfoResp.json() as Record<string, unknown>)
      if (fetched !== undefined) {
        userInfo = {
          uid: fetched.uid,
          screenName: fetched.screenName.length > 0 ? fetched.screenName : userInfo.screenName,
          enterpriseId: fetched.enterpriseId.length > 0 ? fetched.enterpriseId : userInfo.enterpriseId,
          // 手机号 / 邮箱只在 GetUserInfo 里有，拿到即用（空串表示确实没有）。
          phone: fetched.phone,
          email: fetched.email,
        }
      }
    }
  } catch { /* 容错：沿用回调 userInfo（对齐 login.sh:208-209） */ }

  if (userInfo.uid.length === 0) {
    throw new Error('TRAE 未能确定 uid（回调 userInfo 与 GetUserInfo 均为空）')
  }
  if (exchange.accessToken.length === 0) {
    throw new Error('TRAE 换 token 后没有 accessToken')
  }

  return buildTraeCredential(exchange, userInfo, session, nowMs)
}

/**
 * 在 `port` 上启动 server，**把启动期的 listen 失败转成 Promise reject**。
 *
 * ## 为什么必须单独封装（真实缺陷）
 *
 * Node 的 `server.listen()` 失败（最典型的是 `EADDRINUSE`：端口已被占用）
 * 是**通过 `'error'` 事件异步抛出**的，它不属于任何 Promise 链 ——
 * `await` 一个内部调用 `listen()` 的 Promise **捕获不到**这个错误。
 *
 * 若不给 `'error'` 注册处理器，该事件会成为**进程级 unhandled error**，
 * 直接终止整个宿主进程。用户实际症状是：TRAE 面板点「+ 新建账号」时若
 * 18080 被占用，不是看到一条可读错误，而是
 * ```
 * Error: listen EADDRINUSE: address already in use :::18080
 *     at Server.setupListenHandle [as _listen2] (node:net:2167:16)
 * ```
 * 加整堆栈、process 退出（整个 DSH 一起挂掉）。
 *
 * 修法：在 `listen()` **之前**注册 `'error'`，把首个错误 reject 出去，
 * 让上层（RPC 层）能照常返回规范错误响应，前端展示可读文案。
 *
 * 启动成功后把一次性处理器**降级为常驻监听**：运行期仍可能出现 `'error'`
 * （如 EMFILE），届时没有监听者会再次变成进程级崩溃。
 *
 * @param server 待启动的 server
 * @param port 期望监听端口；传 `0` 表示由系统分配空闲端口
 * @param onError 启动失败时的清理钩子（如 clearTimeout）
 * @returns 实际监听的端口
 */
function listenOrReject(
  server: Server,
  port: number,
  onError?: (error: Error) => void,
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false
    const onListenError = (error: Error): void => {
      if (settled) {
        // 启动成功**之后**的运行时错误：此时 Promise 已 resolve，
        // 不能再 reject（会被忽略），但必须有监听者以免进程崩溃。
        return
      }
      settled = true
      onError?.(error)
      reject(error)
    }
    // 必须**先**注册 'error' 再 listen：listen 失败是异步事件，不注册就成
    // 进程级 unhandled error（本缺陷的根因，详见函数头注释）。
    server.once('error', onListenError)
    // 绑定 **127.0.0.1** 而不是 `::`/`0.0.0.0`：这是本地 OAuth 回调服务器，
    // 只应接受本机浏览器的重定向。绑定所有网卡会让同局域网的其它机器也能
    // 向该端口投递伪造的 `?code=`，把攻击者的授权码写进用户凭据。
    // （`src/login.ts` 与 `src/lobsterai-oauth.ts` 同样只绑回环。）
    server.listen(port, '127.0.0.1', () => {
      settled = true
      // 启动成功后把一次性错误处理器降级为常驻监听：运行期仍可能出现
      // 'error'（如 EMFILE），没有监听者会再次变成进程级崩溃。
      server.removeListener('error', onListenError)
      server.on('error', () => { /* 运行期错误：吞掉以免崩进程，由上层超时兜底 */ })
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
}

/**
 * 启动回调服务器：优先用 `preferredPort`，被占用时回退到系统分配的随机端口。
 *
 * ## 为什么要回退（而非直接报错）
 *
 * TRAE 的 `redirect_uri` 是**由我们构造并随登录 URL 一起发给服务端**的，
 * 服务端会原样回跳 —— 因此端口不固定也能工作（`buildTraeLoginURL` 用实际
 * 监听到的端口重算 URL）。而固定的 18080 极易被别的程序占用（用户报障即是
 * 此因），直接失败会让「新建账号」功能在那种机器上完全不可用。
 *
 * @returns 实际端口与（用该端口重算的）回调地址
 */
async function listenWithFallback(
  server: Server,
  preferredPort: number,
): Promise<number> {
  try {
    return await listenOrReject(server, preferredPort)
  } catch (error) {
    // 仅在「端口被占用」这类可恢复的启动错误上回退；其它错误（如权限不足
    // 绑定低端口）重试也无意义，直接冒泡。
    const code = (error as { code?: string }).code
    if (code !== 'EADDRINUSE' && code !== 'EACCES') throw error
    return await listenOrReject(server, 0)
  }
}

/**
 * 阻塞式完整登录流程。
 *
 * 起本地回调服务器 → 打开登录 URL → 等待回调 → ExchangeToken + GetUserInfo → 返回凭据。
 */
export async function runTraeLoginFlow(
  options: TraeLoginFlowOptions & {
    product: TraeProduct
  },
): Promise<TraeLoginFlowResult> {
  // 首先生成 machineId / deviceId
  const machineId = generateMachineId()
  const deviceId = generateDeviceId()
  const preferredPort = options.callbackPort ?? TRAE_CALLBACK_PORT

  // 先监听拿到实际端口（首选被占用时会回退到随机端口），
  // 再用实际端口构造 loginUrl —— redirect_uri 必须与实际监听一致。
  // 先监听拿到实际端口（首选被占用时会回退到随机端口），
  // 再用实际端口构造 loginUrl —— auth_callback_url 必须与实际监听一致。
  const { callback, port } = await startCallbackServer(preferredPort, options.product.consoleHost)
  const callbackUrl = `http://127.0.0.1:${port}/authorize`
  const loginUrl = buildTraeLoginURL(options.product, machineId, deviceId, callbackUrl)

  const credential = await exchangeTraeCallback(
    callback, { machineId, deviceId }, options.product, options.fetcher,
  )

  const access = JSON.stringify(credential)
  const expires = credentialExpiresAtMs(credential) ?? 0
  return {
    access,
    expires,
    loginUrl,
    refreshable: credential.refresh_token.length > 0,
  }
}

/**
 * 两步式登录：起回调服务器并立即返回 loginUrl。
 *
 * 调用方拿到 loginUrl 后应 **立即** `window.open`，再 await `result`。
 *
 * 顺序说明：**先监听拿到端口，再构造登录 URL**。因为首选端口被占用时会
 * 回退到系统分配的随机端口，而 `redirect_uri` 必须写实际端口，否则回调
 * 会打到没人监听的地址上（详见 `listenWithFallback` 的注释）。
 */
export async function startTraeLoginFlow(
  options: TraeLoginFlowOptions & {
    product: TraeProduct
  },
): Promise<{
  loginUrl: string
  result: Promise<TraeLoginFlowResult>
  close: () => Promise<void>
}> {
  const machineId = generateMachineId()
  const deviceId = generateDeviceId()
  const preferredPort = options.callbackPort ?? TRAE_CALLBACK_PORT

  const server = createServer()
  let resultTimer: ReturnType<typeof setTimeout> | undefined

  // ── 1. 先把结果 Promise 的拒绝通道与请求处理器挂好 ──
  let rejectResult: ((error: Error) => void) | undefined
  let loginUrl = ''
  const resultPromise = new Promise<TraeLoginFlowResult>((resolve, reject) => {
    rejectResult = reject
    resultTimer = setTimeout(() => {
      server.close()
      reject(new Error('TRAE 登录超时'))
    }, TRAE_LOGIN_TIMEOUT_MS)
    // 不让登录超时定时器**独占事件循环**：它只是一个兜底窗口（默认 10 分钟），
    // 不该阻止进程正常退出（与 src/refresh.ts 的 `timer.unref?.()` 同款处理）。
    resultTimer.unref?.()

    server.on('request', (req, res) => {
      const url = req.url ?? ''
      if (!url.startsWith('/authorize')) {
        res.writeHead(404)
        res.end()
        return
      }

      // ⚠️ TRAE 回调**直接回传 token**（refreshToken/userInfo/userJwt），
      // 不是 OAuth 的 `?code=` 授权码 —— 早期按 OAuth 惯例找 code，
      // 恒判失败 → 回 400 → 前端永远「认证中」（详见 parseTraeCallback）。
      const parsed = parseTraeCallbackDetailed(url)
      if (!parsed.ok) {
        // ⚠️ **必须落定结果 Promise**：这里的早期实现在 `res.end()` 之后
        // 直接 return，`result` Promise 既没 resolve 也没 reject ——
        // 前端 `login.poll` 永远拿不到 `done:true`，界面永久停在「认证中」，
        // 与「回调解析错了」的症状完全一样，但根因是**这里漏了落定**。
        if (resultTimer) clearTimeout(resultTimer)
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`TRAE 登录回调无效：${parsed.reason}`)
        server.close()
        reject(new Error(`TRAE 登录回调无效：${parsed.reason}`))
        return
      }
      const callback = parsed.info

      // 异步完成剩余流程
      exchangeTraeCallback(callback, { machineId, deviceId }, options.product, options.fetcher)
        .then((credential) => {
          if (resultTimer) clearTimeout(resultTimer)
          const access = JSON.stringify(credential)
          const expires = credentialExpiresAtMs(credential) ?? 0
          // 给浏览器返回成功页面
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`TRAE 登录成功：${credential.nickname ?? credential.uid}。可以关闭此页面返回面板。`)
          // 关服务器
          server.close()
          resolve({
            access,
            expires,
            loginUrl,
            refreshable: credential.refresh_token.length > 0,
          })
        })
        .catch((error) => {
          if (resultTimer) clearTimeout(resultTimer)
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`TRAE 登录失败：${error instanceof Error ? error.message : String(error)}`)
          server.close()
          reject(error)
        })
    })
  })

  // 挂空处理器避免「未处理的拒绝」告警（错误仍会传给真正的消费者）。
  resultPromise.catch(() => {})

  // ⚠️ 必须 await：`listen` 失败（EADDRINUSE 等）通过 'error' **事件**抛出，
  // 不属于 Promise 链，不 await 会变成进程级 unhandled error 而崩掉宿主。
  // `listenWithFallback` 会先试首选端口，被占用则退到系统分配的随机端口。
  let actualPort: number
  try {
    actualPort = await listenWithFallback(server, preferredPort)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const message = `TRAE 回调端口无法监听（${reason}）；端口可能已被其它程序占用，请释放后重试。`
    // 启动失败：把结果 Promise 也一并落定为拒绝，避免调用方 await 它时永远挂起。
    rejectResult?.(new Error(message))
    throw new Error(message)
  }

  // ── 2. 监听成功后才构造登录 URL：redirect_uri 必须写**实际**端口 ──
  const callbackUrl = `http://127.0.0.1:${actualPort}/authorize`
  loginUrl = buildTraeLoginURL(options.product, machineId, deviceId, callbackUrl)

  return {
    loginUrl,
    result: resultPromise,
    // 关闭时**必须**同时清掉兜底超时定时器：否则用户在浏览器里点了取消、
    // 前端调 close() 之后，那个 10 分钟的定时器仍会挂着并最终 reject 一个
    // 无人消费的 Promise（未处理拒绝告警）。
    close: () => new Promise<void>((resolve) => {
      if (resultTimer) clearTimeout(resultTimer)
      server.close(() => resolve())
    }),
  }
}

/**
 * 启本地回调服务器，等待 TRAE 的回调，返回**解析出的凭证**与实际监听端口。
 *
 * `port` 为**首选**端口：被占用时会自动回退到系统分配的随机端口，
 * 因此调用方**必须**使用返回的 `port`（而非传入值）来构造 `auth_callback_url`。
 *
 * @param port 首选监听端口（默认 18080）
 * @param _consoleHost TRAE 登录门户域名（保留参数，当前未使用）
 * @param timeoutMs 超时毫秒
 */
export async function startCallbackServer(
  port: number = TRAE_CALLBACK_PORT,
  _consoleHost?: string,
  timeoutMs: number = TRAE_LOGIN_TIMEOUT_MS,
): Promise<{ callback: TraeCallbackInfo; port: number }> {
  const server = createServer()
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 实际监听的端口；在 listen 成功后才赋值（见下方）。 */
  let actualPort = port

  const result = new Promise<{ callback: TraeCallbackInfo; port: number }>((resolve, reject) => {
    server.on('request', (req, res) => {
      const url = req.url ?? ''
      if (!url.startsWith('/authorize')) {
        res.writeHead(404)
        res.end()
        return
      }
      // ⚠️ TRAE 回调直接回传 token（refreshToken/userInfo/userJwt），不是 ?code=。
      const parsed = parseTraeCallbackDetailed(url)
      if (!parsed.ok) {
        // ⚠️ **必须落定结果 Promise**（与 startTraeLoginFlow 同款的真实缺陷）：
        // 早期实现只 res.end() 后 return，既不 resolve 也不 reject ——
        // 调用方 await 的 Promise 永远挂起直到超时，前端 login.poll 也就
        // 永远拿不到 done:true，界面永久停在「认证中」。
        if (timer) clearTimeout(timer)
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(`TRAE 登录回调无效：${parsed.reason}`)
        server.close()
        reject(new Error(`TRAE 登录回调无效：${parsed.reason}`))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('已收到 TRAE 授权，正在换取凭据…可以关闭此页面。')
      server.close()
      resolve({ callback: parsed.info, port: actualPort })
    })

    timer = setTimeout(() => {
      server.close()
      reject(new Error('TRAE 登录回调超时'))
    }, timeoutMs)
    // 兜底超时同样 unref：不该独占事件循环。
    timer.unref?.()
  })

  // 挂空处理器：listen 失败时由下面的 await 负责抛出，这里避免未处理拒绝告警。
  result.catch(() => {})

  let resolvedPort: number
  try {
    // 与 startTraeLoginFlow 共用同一安全启动路径（见 listenOrReject 的说明）。
    resolvedPort = await listenWithFallback(server, port)
  } catch (error) {
    if (timer) clearTimeout(timer)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`TRAE 回调端口 ${port} 无法监听（${reason}）；端口可能已被占用。`)
  }
  actualPort = resolvedPort

  // 实际端口必须让调用方知道：它要和 auth_callback_url 一致。
  server.once('close', () => { if (timer) clearTimeout(timer) })
  return result
}
