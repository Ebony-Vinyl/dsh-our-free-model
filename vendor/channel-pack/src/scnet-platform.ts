/**
 * SCNet 平台（www.scnet.cn）会话客户端。
 *
 * 模型调用走 `api.scnet.cn/api/llm/v1`（`Authorization: Bearer sk-…`），但拿
 * `sk-` Key 必须先有**平台登录态** —— 它不是 `Token: <jwt>` 头，而是登录时
 * 下发的一对 Cookie：`jsessionid` + `Token`。
 *
 * 本模块只做四件事，全部基于实测端点：
 *
 *   1. `resolveSession` —— `GET /acx/user/users/current-user-info`：会话是否有效、属于谁；
 *   2. `ensureApiKey` —— `POST /acx/llm/api-key/createActivityApiKey`：换模型服务 Key
 *      （新账号会回「模型服务尚未开通」，此时自动走一次 `account/config/authorize` 再重试）；
 *   3. `logout` —— 尽力让平台侧会话失效；
 *   4. `platformRequest` —— 上面三者的共同底座。
 *
 * 安全约束：Cookie 与 Key **绝不**写日志；错误信息只带平台原话与 HTTP 状态。
 *
 * @module scnet-platform
 */

import {
  SCNET_KEY_TIMEOUT_MS,
  SCNET_OK_CODE,
  SCNET_REQUEST_TIMEOUT_MS,
  SCNET_SOURCE_HEADERS,
  maskScnetPhone,
  normalizeScnetCookies,
  parseScnetEnvelope,
  pickScnetCookies,
  scnetCookieHeader,
  translateScnetMessage,
  type ScnetAccount,
  type ScnetCookies,
} from './scnet.js'
import { SCNET, type ScnetProduct } from './scnet-product.js'

/** 单个平台请求的结果（原始状态 + 解析后的 body + 新 Cookie）。 */
export interface PlatformResponse {
  status: number
  body: unknown
  text: string
  cookies: ScnetCookies
}

/** 一次请求的选项。 */
export interface PlatformRequestOptions {
  method?: 'GET' | 'POST'
  cookies?: ScnetCookies | string
  /** JSON 请求体（`undefined` = 不带 body）。 */
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 产品常量（默认 {@link SCNET}）。 */
  product?: ScnetProduct
}

/** 让 fetch 在超时/外部取消时都能及时结束，并在结束时摘掉监听器。 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  const forward = (): void => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', forward, { once: true })
  }
  return {
    signal: controller.signal,
    clear: () => {
      clearTimeout(timer)
      // 不摘监听器的话，每次请求都会往调用方的长生命周期 signal 上挂一个闭包。
      signal?.removeEventListener?.('abort', forward)
    },
  }
}

/**
 * 平台请求底座。
 *
 * ⚠️ `redirect: 'manual'`：平台换 key 的链路里有 302，跟随会丢掉 `Set-Cookie`。
 * ⚠️ body 一律 JSON（`content-type: application/json`）：`createActivityApiKey`
 *    用表单编码会回 405。
 */
export async function platformRequest(path: string, options: PlatformRequestOptions = {}): Promise<PlatformResponse> {
  const product = options.product ?? SCNET
  const fetcher = options.fetcher ?? fetch
  const timer = withTimeout(options.signal, options.timeoutMs ?? SCNET_REQUEST_TIMEOUT_MS)
  try {
    const cookie = scnetCookieHeader(options.cookies)
    const headers: Record<string, string> = {
      ...SCNET_SOURCE_HEADERS,
      accept: 'application/json, text/plain, */*',
    }
    if (cookie.length > 0) headers.cookie = cookie
    let payload: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      payload = JSON.stringify(options.body)
    }
    const response = await fetcher(`${product.platformBase}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(payload === undefined ? {} : { body: payload }),
      signal: timer.signal,
      redirect: 'manual',
    })
    const text = await response.text()
    let parsed: unknown
    try {
      parsed = text.length > 0 ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    return { status: response.status, body: parsed, text, cookies: pickScnetCookies(setCookie) }
  } finally {
    timer.clear()
  }
}

/** 会话校验结果。 */
export type ScnetSessionResult =
  | { ok: true; account: ScnetAccount; cookies: ScnetCookies }
  | { ok: false; reason: string; message?: string }

/**
 * 现在的会话是谁？会话无效时返回 `{ ok: false, reason }`，不抛网络错误以外的东西。
 *
 * 这条响应**可能顺带续期 Cookie**，故把新 Cookie 合并回返回值 —— 调用方应当用它
 * 覆盖旧的（否则「平台已经续期、本地还在用旧值」会提前 401）。
 */
export async function resolveSession(options: {
  cookies?: ScnetCookies | string
  signal?: AbortSignal
  fetcher?: typeof fetch
  product?: ScnetProduct
} = {}): Promise<ScnetSessionResult> {
  const cookies = normalizeScnetCookies(options.cookies)
  if (cookies === undefined) return { ok: false, reason: 'missing-cookies' }
  try {
    const result = await platformRequest('/acx/user/users/current-user-info?includeToken=true&refresh=true', {
      cookies,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.product === undefined ? {} : { product: options.product }),
    })
    if (result.status === 401) return { ok: false, reason: 'expired' }
    if (result.status !== 200 || result.body === undefined) {
      return { ok: false, reason: `http-${result.status}` }
    }
    const envelope = parseScnetEnvelope<Record<string, unknown>>(result.body)
    if (!envelope.ok) {
      return { ok: false, reason: 'rejected', message: translateScnetMessage(envelope.message) }
    }
    const data = envelope.data ?? {}
    const userId = data.id !== undefined && data.id !== null ? String(data.id) : ''
    if (userId.length === 0) return { ok: false, reason: 'invalid-response' }
    const account: ScnetAccount = {
      userId,
      ...(typeof data.userName === 'string' && data.userName.length > 0 ? { userName: data.userName } : {}),
      ...(typeof data.mobilephoneNum === 'string' && data.mobilephoneNum.length > 0
        ? { mobile: maskScnetPhone(data.mobilephoneNum) ?? data.mobilephoneNum }
        : {}),
      ...(typeof data.institution === 'string' && data.institution.trim().length > 0
        ? { institution: data.institution.trim() }
        : {}),
    }
    return { ok: true, account, cookies: { ...cookies, ...result.cookies } }
  } catch (error) {
    return { ok: false, reason: 'network', message: error instanceof Error ? error.message : String(error) }
  }
}

/** 换 Key 的结果。 */
export type ScnetApiKeyResult =
  | { ok: true; apiKey: string; baseUrl: string; cookies: ScnetCookies }
  | { ok: false; reason: string; message?: string }

/** 「模型服务尚未开通」的判据（平台原话，兼容英文网关）。 */
const NOT_ACTIVATED_RE = /尚未开通|not\s*(?:been\s*)?(?:opened|enabled|activated)/i

/** 从会话里取账号 id（开通模型服务要用）；失败返回 `undefined`。 */
async function resolveAccountId(
  cookies: ScnetCookies,
  options: { signal?: AbortSignal; fetcher?: typeof fetch; product?: ScnetProduct },
): Promise<string | undefined> {
  try {
    const result = await platformRequest('/acx/user/users/current-user-info?includeToken=true&refresh=true', {
      cookies,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.product === undefined ? {} : { product: options.product }),
    })
    const envelope = parseScnetEnvelope<Record<string, unknown>>(result.body)
    if (!envelope.ok) return undefined
    const data = envelope.data ?? {}
    const id = data.id ?? data.accountId ?? data.userId
    return id === undefined || id === null || String(id).length === 0 ? undefined : String(id)
  } catch {
    return undefined
  }
}

/**
 * 用会话换模型服务 API Key。
 *
 * 走「活动 Key」端点：同一账号拿到的 Key 与桌面客户端落盘的是同一个，
 * 不会每次刷新都新建。
 *
 * **新账号要自动开通模型服务**：全新注册的账号调这个端点会得到
 * `{"msg":"模型服务尚未开通"}`。平台客户端遇到它时先调
 * `/acx/llm/account/config/authorize` 开通再重试 —— 这里照做，否则「自动注册」
 * 只能走到「账号建好了但拿不到 Key」，等于白注册。
 */
export async function ensureApiKey(options: {
  cookies?: ScnetCookies | string
  accountId?: string
  signal?: AbortSignal
  fetcher?: typeof fetch
  product?: ScnetProduct
} = {}): Promise<ScnetApiKeyResult> {
  const product = options.product ?? SCNET
  const cookies = normalizeScnetCookies(options.cookies)
  if (cookies === undefined) return { ok: false, reason: 'missing-cookies' }

  const createOnce = async (): Promise<PlatformResponse> => platformRequest('/acx/llm/api-key/createActivityApiKey', {
    method: 'POST',
    cookies,
    body: {},
    timeoutMs: SCNET_KEY_TIMEOUT_MS,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    product,
  })

  try {
    let result = await createOnce()
    let merged: ScnetCookies = { ...cookies, ...result.cookies }
    const rawMessage = (result.body as Record<string, unknown> | undefined)
    const firstMessage = typeof rawMessage?.msg === 'string'
      ? rawMessage.msg
      : typeof rawMessage?.message === 'string' ? rawMessage.message : ''

    // 「模型服务尚未开通」→ 开通一次后重试。只重试一次，避免开通失败时死循环。
    if (result.status === 200 && NOT_ACTIVATED_RE.test(firstMessage)) {
      const accountId = options.accountId ?? await resolveAccountId(cookies, options)
      if (accountId !== undefined && accountId.length > 0) {
        try {
          const authorized = await platformRequest('/acx/llm/account/config/authorize', {
            method: 'POST',
            cookies: merged,
            // ⚠️ accountId 必须放 body：放 query 平台会回 API010006「无权限访问」。
            body: { accountId },
            timeoutMs: SCNET_KEY_TIMEOUT_MS,
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
            product,
          })
          merged = { ...merged, ...authorized.cookies }
        } catch {
          // 开通失败就继续往下走，让调用方看到原始的「尚未开通」，而不是被这里吞掉。
        }
        result = await createOnce()
        merged = { ...merged, ...result.cookies }
      }
    }

    if (result.status === 401) return { ok: false, reason: 'expired' }
    if (result.status !== 200 || result.body === undefined) {
      const message = typeof rawMessage?.msg === 'string' ? rawMessage.msg : `HTTP ${result.status}`
      return { ok: false, reason: 'rejected', message: translateScnetMessage(message) }
    }
    const envelope = parseScnetEnvelope<Record<string, unknown> | string>(result.body)
    if (!envelope.ok) {
      return {
        ok: false,
        reason: NOT_ACTIVATED_RE.test(envelope.message) ? 'not-activated' : 'rejected',
        message: translateScnetMessage(envelope.message),
      }
    }
    const data = envelope.data
    const key = typeof data === 'string'
      ? data
      : typeof data?.apiKey === 'string' ? data.apiKey : ''
    if (!key.startsWith('sk-')) {
      const rawMsg = typeof rawMessage?.msg === 'string' ? rawMessage.msg : ''
      return {
        ok: false,
        reason: 'invalid-response',
        message: rawMsg.length > 0 ? `平台返回：${translateScnetMessage(rawMsg)}` : '平台没有返回 sk- 开头的模型服务 Key',
      }
    }
    const baseUrl = typeof data === 'object' && data !== null && typeof data.baseUrl === 'string' && data.baseUrl.trim().length > 0
      ? data.baseUrl.trim()
      : product.apiBase
    return { ok: true, apiKey: key, baseUrl, cookies: merged }
  } catch (error) {
    return {
      ok: false,
      reason: 'network',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 让平台侧会话失效（尽力而为，失败不影响本地清理）。 */
export async function scnetPlatformLogout(options: {
  cookies?: ScnetCookies | string
  signal?: AbortSignal
  fetcher?: typeof fetch
  product?: ScnetProduct
} = {}): Promise<{ ok: boolean }> {
  const cookies = normalizeScnetCookies(options.cookies)
  if (cookies === undefined) return { ok: true }
  try {
    const result = await platformRequest('/acx/user/users/logout', {
      cookies,
      timeoutMs: 8_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      ...(options.product === undefined ? {} : { product: options.product }),
    })
    return { ok: result.status === 200 }
  } catch {
    return { ok: false }
  }
}

/** 平台业务成功判定的最小工具（导出给别的模块复用，避免各自判码）。 */
export function isScnetPlatformOk(body: unknown): boolean {
  const record = body as Record<string, unknown> | undefined
  return record !== undefined && record !== null && String(record.code ?? '') === SCNET_OK_CODE
}
