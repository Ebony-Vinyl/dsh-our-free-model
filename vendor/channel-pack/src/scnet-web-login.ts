/**
 * SCNet 免客户端登录 · 网页短信验证码（零客户端）。
 *
 * 用户在**本地登录页**（`scnet-login-page.ts` 起的 127.0.0.1 服务）里填手机号 →
 * 图形验证码 → 短信验证码，本模块负责把这三步换成平台会话 Cookie，再由
 * `scnet-platform.ts` 换成模型服务 Key。
 *
 * ## 端点与判定全部取自平台登录页前端，不是猜的
 *
 * ```text
 * POST /sso/captcha.action                     → { code:'0', data:'data:image/jpeg;base64,…' }
 * POST /sso/sendRegisterMessageCode.action     → code '0'(未注册) | '1004'(已注册) 都算发码成功
 * POST /sso/auth/login.action                  （已注册号，mode='2' 快捷登录）
 * POST /sso/registerByMobilephoneNum.action    （未注册号，注册即登录）
 *      ↑ 两者成功都回 { code:'0', data:'<带 ticket 的跳转地址>' }
 * GET  <ticket 地址>                            → Set-Cookie: jsessionid + Token
 * ```
 *
 * ## 三个必须记住的坑
 *
 * 1. **一个 Cookie 罐贯穿全程**：图形验证码状态、短信码绑定、ticket 消费全部挂在
 *    同一个 `jsessionid` 上。中途换罐 = 平台按「没发过码」处理。
 * 2. **发码响应用 `code` 区分号码是否已注册**（`1004` = 已注册、`0` = 未注册），
 *    提交时必须据此选通道 —— 对未注册号调登录接口，平台回
 *    `401 Username or password is incorrect`，用户会误以为「密码错」。
 * 3. **登录成功 ≠ 拿到会话**：`data` 只是 ticket 地址，必须再 GET 它，`Token` 才会
 *    落到罐里；没拿到 `Token` 要按「风控静默拦截」报错，而不是假装成功。
 *
 * @module scnet-web-login
 */

import crypto from 'node:crypto'
import {
  SCNET_REQUEST_TIMEOUT_MS,
  SCNET_SMS_OK_CODES,
  SCNET_SMS_REGISTERED_CODE,
  SCNET_SUBMIT_TIMEOUT_MS,
  SCNET_WEB_UA,
  isPlausibleScnetPhone,
  mapScnetLoginError,
  mapScnetSmsError,
  normalizeScnetPhone,
  pickScnetCookies,
  scnetCaptchaSignature,
  translateScnetMessage,
  type ScnetCookies,
} from './scnet.js'
import { SCNET, type ScnetProduct } from './scnet-product.js'

/** 一次网页登录会话的存活时间（图形码/风控状态）。 */
export const SCNET_PENDING_TTL_MS = 10 * 60 * 1000

/** 极简 Cookie 罐：登录流程必须复用同一个 `jsessionid`。 */
class CookieJar {
  private readonly store = new Map<string, string>()

  absorb(response: Response): void {
    const headers = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
    for (const raw of headers) {
      const [pair = ''] = String(raw).split(';')
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      const name = pair.slice(0, eq).trim()
      const value = pair.slice(eq + 1).trim()
      if (value.length === 0) this.store.delete(name)
      else this.store.set(name, value)
    }
  }

  header(): string {
    return [...this.store.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  }

  get(name: string): string | undefined {
    return this.store.get(name)
  }

  clear(): void {
    this.store.clear()
  }
}

/** 登录结果。 */
export type ScnetWebLoginOutcome =
  | { ok: true; cookies: ScnetCookies; via: 'login' | 'register'; registered: boolean }
  | { ok: false; reason: string; message?: string; code?: string; via?: 'login' | 'register' }

/** 发码结果。 */
export type ScnetSendSmsOutcome =
  | { ok: true; registered: boolean }
  | { ok: false; reason: string; message?: string; code?: string }

/** 图形验证码结果。 */
export type ScnetCaptchaOutcome =
  | { ok: true; image: string }
  | { ok: false; reason: string; message?: string }

/** 网页登录会话。 */
export interface ScnetWebLogin {
  /** 抓一张图形验证码（base64 data URL）。 */
  captcha(): Promise<ScnetCaptchaOutcome>
  /** 发短信验证码；`captchaCode` 可空（空则用平台那套签名占位）。 */
  sendSmsCode(phone: string, captchaCode?: string): Promise<ScnetSendSmsOutcome>
  /** 提交短信验证码，拿到平台会话 Cookie。 */
  submit(form: { phone?: string; smsCode?: string; captcha?: string }): Promise<ScnetWebLoginOutcome>
  /** 丢弃当前会话（风控状态已脏时强制下一轮重新取图形码）。 */
  reset(): void
}

/** 登录会话选项。 */
export interface ScnetWebLoginOptions {
  product?: ScnetProduct
  fetcher?: typeof fetch
  signal?: AbortSignal
}

/** form-urlencoded 编码（`null`/`undefined` 跳过，空串保留）。 */
function encodeForm(fields: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue
    params.set(key, String(value))
  }
  return params.toString()
}

/**
 * 创建一次网页登录会话。
 *
 * 每次「重新登录」都应当新建一个实例（罐是一次性的）；风控失败后由调用方
 * 决定是否 `reset()` 后重开。
 */
export function createScnetWebLogin(options: ScnetWebLoginOptions = {}): ScnetWebLogin {
  const product = options.product ?? SCNET
  const fetcher = options.fetcher ?? fetch
  const jar = new CookieJar()
  const signal = options.signal
  /** 上一次发码用的手机号（提交时要与之一致）。 */
  let pendingPhone: string | undefined
  /** 上一条短信码发给的号是否已注册（`sendSmsCode` 写入、`submit` 读取）。 */
  let pendingRegistered: boolean | undefined

  const webPost = async (
    path: string,
    body: string,
    timeoutMs: number = SCNET_REQUEST_TIMEOUT_MS,
  ): Promise<{ status: number; json: unknown; text: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
    const forward = (): void => controller.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) controller.abort(signal.reason)
      else signal.addEventListener('abort', forward, { once: true })
    }
    try {
      const cookie = jar.header()
      const response = await fetcher(`${product.platformBase}${path}`, {
        method: 'POST',
        headers: {
          'user-agent': SCNET_WEB_UA,
          referer: product.loginPageUrl,
          origin: product.platformBase,
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
          ...(cookie.length > 0 ? { cookie } : {}),
        },
        body,
        signal: controller.signal,
        redirect: 'manual',
      })
      jar.absorb(response)
      const text = await response.text()
      let json: unknown
      try {
        json = text.length > 0 ? JSON.parse(text) : undefined
      } catch {
        json = undefined
      }
      return { status: response.status, json, text }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', forward)
    }
  }

  const captcha = async (): Promise<ScnetCaptchaOutcome> => {
    try {
      const result = await webPost('/sso/captcha.action', '')
      const record = result.json as Record<string, unknown> | undefined
      const code = record === undefined || record === null ? '' : String(record.code ?? '')
      const data = typeof record?.data === 'string' ? record.data : ''
      if (result.status !== 200 || code !== '0' || !data.startsWith('data:image/')) {
        const message = typeof record?.msg === 'string' ? record.msg : `HTTP ${result.status}`
        return { ok: false, reason: 'captcha-unavailable', message: translateScnetMessage(message) }
      }
      return { ok: true, image: data }
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const sendSmsCode = async (phone: string, captchaCode?: string): Promise<ScnetSendSmsOutcome> => {
    if (!isPlausibleScnetPhone(phone)) {
      return { ok: false, reason: 'invalid-phone', message: '手机号格式不对' }
    }
    const mobilephoneNum = normalizeScnetPhone(phone)
    const { timestamp, randomString, md5Str } = scnetCaptchaSignature(
      mobilephoneNum,
      (input) => crypto.createHash('md5').update(input).digest('hex'),
    )
    try {
      const result = await webPost('/sso/sendRegisterMessageCode.action', encodeForm({
        mobilephoneNum,
        // 用户填了图形验证码就用它；没填就用平台那套签名（平台前端同样这么做）。
        captcha: captchaCode !== undefined && captchaCode.length > 0 ? captchaCode : md5Str,
        t: timestamp,
        sn: randomString,
        createBy: 'scnet',
        siteCode: 'sacp',
        service: product.loginService,
        originalUrl: product.loginPageUrl,
        sensorsAnonId: '',
      }))
      const record = result.json as Record<string, unknown> | undefined
      const code = record === undefined || record === null ? '' : String(record.code ?? '')
      if (record !== undefined && SCNET_SMS_OK_CODES.includes(code)) {
        pendingPhone = mobilephoneNum
        pendingRegistered = code === SCNET_SMS_REGISTERED_CODE
        return { ok: true, registered: pendingRegistered }
      }
      const rawMessage = typeof record?.msg === 'string' ? record.msg : `HTTP ${result.status}`
      return {
        ok: false,
        reason: mapScnetSmsError(code, rawMessage),
        code,
        message: translateScnetMessage(rawMessage),
      }
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        message: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /** 跟随 ticket 跳转，把平台下发的会话 Cookie 收进罐里。 */
  const followTicket = async (target: string): Promise<{ ok: true } | { ok: false; reason: string; message?: string }> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('timeout')), SCNET_REQUEST_TIMEOUT_MS)
    const absolute = (value: string): string => value.startsWith('http')
      ? value
      : `${product.platformBase}${value.startsWith('/') ? '' : '/'}${value}`
    const hop = async (url: string): Promise<Response> => fetcher(url, {
      headers: { 'user-agent': SCNET_WEB_UA, ...(jar.header().length > 0 ? { cookie: jar.header() } : {}) },
      redirect: 'manual',
      signal: controller.signal,
    })
    try {
      const response = await hop(absolute(target))
      jar.absorb(response)
      const location = response.headers.get('location')
      if (location !== null && response.status >= 300 && response.status < 400) {
        const next = absolute(location)
        if (next.startsWith(product.platformBase)) {
          const second = await hop(next)
          jar.absorb(second)
        }
      }
      return { ok: true }
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        message: error instanceof Error ? error.message : String(error),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  const submit = async (form: { phone?: string; smsCode?: string; captcha?: string }): Promise<ScnetWebLoginOutcome> => {
    const mobilephoneNum = normalizeScnetPhone(form.phone !== undefined && form.phone.length > 0 ? form.phone : pendingPhone ?? '')
    if (!isPlausibleScnetPhone(mobilephoneNum)) {
      return { ok: false, reason: 'invalid-phone', message: '请填写手机号' }
    }
    const smsCode = typeof form.smsCode === 'string' ? form.smsCode.trim() : ''
    if (smsCode.length === 0) return { ok: false, reason: 'invalid-params', message: '请填写短信验证码' }

    /**
     * 按发码时平台告知的注册状态选通道。
     *
     *   · 已注册号 → `/sso/auth/login.action`（`mode=2` 快捷登录）
     *   · 未注册号 → `/sso/registerByMobilephoneNum.action`（注册即登录）
     *
     * `pendingRegistered === undefined`（没发过码）时退回登录接口：平台对已注册号
     * 必然成功；对未注册号会回 401，届时报错文案已经翻译过。
     */
    const viaRegister = pendingRegistered === false
    const path = viaRegister ? '/sso/registerByMobilephoneNum.action' : '/sso/auth/login.action'
    const fields = viaRegister
      ? {
          mobilephoneNum,
          messageCode: smsCode,
          // 注册接口把这几项当必填（缺 createBy 会 400）。
          createBy: 'scnet',
          siteCode: 'sacp',
          invitationCode: '',
          fullName: '',
          institution: '',
          service: product.loginService,
          originalUrl: product.loginPageUrl,
          sensorsAnonId: '',
        }
      : {
          service: product.loginService,
          originalUrl: product.loginPageUrl,
          sensorsAnonId: '',
          captcha: form.captcha ?? '',
          mobilephoneNum,
          messageCode: smsCode,
          mode: '2',
        }
    const via: 'login' | 'register' = viaRegister ? 'register' : 'login'
    try {
      const result = await webPost(path, encodeForm(fields), SCNET_SUBMIT_TIMEOUT_MS)
      const record = result.json as Record<string, unknown> | undefined
      if (record === undefined || record === null) {
        return { ok: false, reason: 'invalid-response', message: `HTTP ${result.status}`, via }
      }
      const code = String(record.code ?? '')
      if (code !== '0') {
        const rawMessage = typeof record.msg === 'string' ? record.msg : ''
        return {
          ok: false,
          reason: mapScnetLoginError(code, rawMessage),
          code,
          message: translateScnetMessage(rawMessage) || (viaRegister ? '注册失败' : '登录失败'),
          via,
        }
      }
      const ticket = typeof record.data === 'string' && record.data.length > 0 ? record.data : ''
      if (ticket.length > 0) {
        const followed = await followTicket(ticket)
        if (!followed.ok) return { ...followed, via }
      }
      const cookies = readCookies()
      if (cookies === undefined || cookies.Token === undefined) {
        return {
          ok: false,
          reason: 'no-session-cookie',
          message: '平台返回成功，但没有下发会话 Cookie（可能被风控拦截）。请稍后重试。',
          via,
        }
      }
      // 走到这里这个号一定已经在平台上存在了。
      pendingRegistered = true
      return { ok: true, cookies, via, registered: true }
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        message: error instanceof Error ? error.message : String(error),
        via,
      }
    }
  }

  const readCookies = (): ScnetCookies | undefined => {
    const jsessionid = jar.get('jsessionid')
    const token = jar.get('Token')
    if (jsessionid === undefined && token === undefined) return undefined
    return {
      ...(jsessionid === undefined ? {} : { jsessionid }),
      ...(token === undefined ? {} : { Token: token }),
    }
  }

  return {
    captcha,
    sendSmsCode,
    submit,
    reset() {
      jar.clear()
      pendingPhone = undefined
      pendingRegistered = undefined
    },
  }
}

/**
 * 从一张响应里挑出会话 Cookie（导出给登录页/测试复用）。
 *
 * 与 `pickScnetCookies` 同源；这里保留一层是为了让「登录页拿到 Set-Cookie」
 * 不必再 import 协议模块的两个函数。
 */
export function scnetSessionCookies(response: Response): ScnetCookies {
  return pickScnetCookies(
    typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [],
  )
}
