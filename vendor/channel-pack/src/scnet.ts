/**
 * SCNet 协议常量、凭据类型与纯函数。
 *
 * ## 与 Loomy 的差异（决定了本文件为什么长成这样）
 *
 * | 维度 | Loomy | SCNet |
 * | --- | --- | --- |
 * | 登录 | 讯飞 CAccount，HMAC-SHA1 签名 | 平台 SSO 表单（`/sso/*.action`），Cookie 会话 |
 * | 账号来源 | 必须先有账号 | **未注册手机号自动注册**（`registerByMobilephoneNum`） |
 * | 凭据 | `session` + `userid` | 平台 Cookie（jsessionid/Token）→ 换 `sk-` Key |
 * | 推理鉴权 | Bearer + `token` 两头 | **只认** `Authorization: Bearer sk-…` |
 * | 业务端点 | `token` 头 | Cookie |
 *
 * ## 三个必须记住的坑
 *
 * 1. **发码响应用 `code` 区分号码是否已注册**：`1004` = 已注册、`0` = 未注册
 *    （短信**照样发出去了**）。丢了这条区分，对未注册号仍调登录接口，平台会回
 *    `401 Username or password is incorrect` —— 用户看到「密码错误」，实际原因
 *    是「这个手机号没有账号」。
 * 2. **登录成功只是拿到了 ticket 地址**（`data` 字段），必须再 GET 它才会把
 *    `Token`/`jsessionid` 下发到当前 Cookie 罐。只判 `code === '0'` 会得到一个
 *    看起来成功、实际没有会话的「登录」。
 * 3. **平台业务失败恒返回 HTTP 200**，成败只能读 body 的 `code`（`'0'` 为成功）。
 *    只看状态码会把「登录已失效」误判成成功。
 *
 * @module scnet
 */

/** 平台网页登录/发码的统一 UA（平台按 UA 走 PC 流程）。 */
export const SCNET_WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/**
 * acx 平台接口的请求头三件套。
 *
 * 平台网关按 `source`/`version` 判客户端；缺了不会必然失败，但带上与桌面
 * 客户端一致，可减少风控误判。
 */
export const SCNET_SOURCE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'user-agent': 'scnet-client/4.1.0',
  source: 'Electron',
  version: '4.1.0',
})

/** 图形验证码签名的固定盐（取自平台登录页前端）。 */
export const SCNET_CAPTCHA_SALT = '20250207'

/** 随机串字符集（与平台前端一致）。 */
export const SCNET_CAPTCHA_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/**
 * 发码接口把「手机号已注册」也当成功。
 *
 * 平台前端原文：`if((c.code==="0"||c.code==="1004")&&…)` —— 两个都是「短信已发出」，
 * 区别只在后续提交走登录通道还是注册通道。
 */
export const SCNET_SMS_OK_CODES: readonly string[] = Object.freeze(['0', '1004'])

/** 已注册手机号的发码响应码（提交时走 `/sso/auth/login.action`）。 */
export const SCNET_SMS_REGISTERED_CODE = '1004'

/** 业务成功码。 */
export const SCNET_OK_CODE = '0'

/** 平台请求超时（毫秒）。 */
export const SCNET_REQUEST_TIMEOUT_MS = 20_000

/** 提交短信码的超时（平台这一步更慢）。 */
export const SCNET_SUBMIT_TIMEOUT_MS = 25_000

/** 换 key / 开通模型服务的超时。 */
export const SCNET_KEY_TIMEOUT_MS = 30_000

/**
 * Key 的本地有效期（6 天）。
 *
 * 平台不返回 Key 的有效期，参考实现按「6 天」主动重换 —— 那时平台 Cookie 通常
 * 还活着，用户不必重新收短信。到期后由 `refresh()` 静默换一份新的。
 */
export const SCNET_KEY_TTL_MS = 6 * 24 * 60 * 60 * 1000

/**
 * 平台会话 Cookie（登录的唯一凭证）。
 *
 * 平台不用 `Token: <jwt>` 头，而是这一对 Cookie。`Token` 是 48 字符的会话令牌
 * （**不是**客户端 config.json 里那个 JWT），`jsessionid` 是 32 位十六进制。
 */
export interface ScnetCookies {
  jsessionid?: string
  Token?: string
}

/** 登录拿到的账号身份（展示用）。 */
export interface ScnetAccount {
  /** 平台用户 id（开通模型服务要用）。 */
  userId?: string
  /** 用户名。 */
  userName?: string
  /** 脱敏手机号（`138****0000`）。 */
  mobile?: string
  /** 机构（部分账号有）。 */
  institution?: string
}

/**
 * SCNet 凭据（存进 `ctx.credentials` 的 JSON）。
 *
 * 与 Loomy 不同：这里**同时**保留平台 Cookie 与 `sk-` Key ——
 * 前者用来在 Key 失效时静默重换（`refresh`），后者是推理唯一可用的凭据。
 */
export interface ScnetCredential {
  /** 平台会话 Cookie。 */
  cookies?: ScnetCookies
  /** 模型服务 Key（`sk-` 开头）。 */
  apiKey: string
  /** 网关根地址（平台可能下发别的地址，缺省用产品常量）。 */
  baseUrl: string
  /** 账号身份。 */
  account?: ScnetAccount
  /** 换取该凭据的时间（ISO 字符串）。 */
  obtainedAt?: string
  /** 换到 Key 的时间（ISO 字符串）。 */
  keyedAt?: string
  /**
   * 本地推算的 Key 过期时间（**毫秒时间戳字符串**）。
   *
   * 平台不返回 Key 的有效期，参考实现按「6 天」主动重换（Cookie 通常还活着）。
   */
  expiresAt?: string
  /** 凭据来源；目前只有网页短信登录一条路。 */
  source?: 'web'
}

/** 平台统一响应信封 `{ code, msg, data }`。 */
export interface ScnetEnvelope<T> {
  ok: boolean
  code: string
  message: string
  data: T | undefined
}

/**
 * 解析平台信封。
 *
 * 平台业务失败**恒返回 HTTP 200**，成败只能读 `code` —— 只看状态码会把
 * 「登录已失效」误判成成功。
 */
export function parseScnetEnvelope<T>(payload: unknown): ScnetEnvelope<T> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, code: '', message: '响应不是 JSON 对象', data: undefined }
  }
  const record = payload as Record<string, unknown>
  const code = record.code === undefined || record.code === null ? '' : String(record.code)
  const message = typeof record.msg === 'string' && record.msg.length > 0
    ? record.msg
    : typeof record.message === 'string' ? record.message : ''
  if (code !== SCNET_OK_CODE) {
    return {
      ok: false,
      code,
      message: message.length > 0 ? message : `平台返回 code=${code || '(缺少 code)'}`,
      data: undefined,
    }
  }
  return { ok: true, code, message, data: record.data as T }
}

/**
 * 手机号归一化：`+86` + 11 位；已是国际格式则原样保留。
 *
 * ⚠️ 必须先做**全角 → 半角**：用户从微信、文档或通讯录粘贴时经常带全角数字
 * （`１３８…`）与全角加号（`＋`）。JS 的 `\d` 只认 ASCII 数字，不转换就会把
 * 一个合法的 11 位号码判成非法（登录页曾因此提示「请填写 11 位手机号」）。
 *
 * 另外剥掉裸 `86` 国家码：粘贴 `+86 138…` 或 `86138…` 时不该让用户自己删。
 */
export function normalizeScnetPhone(phone: string): string {
  const halved = String(phone ?? '')
    .replace(/[\uFF10-\uFF19]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .replace(/\uFF0B/g, '+')
  const digits = halved.replace(/[\s-]/g, '').replace(/[^\d+]/g, '')
  if (digits.startsWith('+')) return digits
  // 裸 `86` 前缀（13 位 = 2 位国家码 + 11 位号码）→ 补 `+`
  if (digits.length === 13 && digits.startsWith('86')) return `+${digits}`
  if (digits.length === 11) return `+86${digits}`
  return digits
}

/** 手机号基本形状校验（只挡明显错误，具体以平台为准）。 */
export function isPlausibleScnetPhone(phone: string): boolean {
  return /^\+?\d{6,15}$/.test(normalizeScnetPhone(phone))
}

/**
 * 图形验证码签名（平台登录页前端的 `AY(phone)`）。
 *
 * ```text
 * md5Str = MD5(phone + 时间戳 + 10 位随机串 + '20250207')
 * ```
 *
 * 用户**没填**图形验证码时，平台前端就把这个 `md5Str` 当 `captcha` 传上去；
 * 不带 `t`/`sn` 会偶发 `3002 signature failed`。
 */
export function scnetCaptchaSignature(
  phone: string,
  /** 注入的哈希实现（测试用；默认 `node:crypto` 的 md5）。 */
  md5: (input: string) => string,
  now: number = Date.now(),
  random: () => number = Math.random,
): { timestamp: number; randomString: string; md5Str: string } {
  const normalized = normalizeScnetPhone(phone)
  let randomString = ''
  for (let index = 0; index < 10; index += 1) {
    randomString += SCNET_CAPTCHA_ALPHABET.charAt(Math.floor(random() * SCNET_CAPTCHA_ALPHABET.length))
  }
  return {
    timestamp: now,
    randomString,
    md5Str: md5(`${normalized}${now}${randomString}${SCNET_CAPTCHA_SALT}`),
  }
}

/**
 * 手机号脱敏（与平台一致的 `138****0000` 风格）。
 */
export function maskScnetPhone(value: string | undefined): string | undefined {
  const raw = String(value ?? '').replace(/^\+86/, '').replace(/\D/g, '')
  if (raw.length < 7) return value
  return `${raw.slice(0, 3)}****${raw.slice(-4)}`
}

/** Key 掩码（设置页/诊断只显示它，绝不返回明文）。 */
export function maskScnetKey(value: string | undefined): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw.length <= 8) return raw.length > 0 ? '****' : ''
  return `${raw.slice(0, 5)}…${raw.slice(-3)}`
}

/** 凭据的 `expiresAt`（毫秒）；缺失或非法返回 `undefined`。 */
export function scnetCredentialExpiresAtMs(credential: ScnetCredential | undefined): number | undefined {
  const raw = credential?.expiresAt
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/**
 * 凭据是否已过期。
 *
 * 无 `expiresAt` 时视为**不过期**：宁可用一个可能过期的 Key 去试（网关会回 401，
 * 我们能识别并重换），也不要凭猜测阻止用户使用。
 */
export function isScnetExpired(credential: ScnetCredential | undefined): boolean {
  const expiresAt = scnetCredentialExpiresAtMs(credential)
  return expiresAt !== undefined && expiresAt <= Date.now()
}

/**
 * 凭据是否可静默续期。
 *
 * **只要还有平台 Cookie 就可以**：`refresh()` 会先验活会话（`current-user-info`），
 * 再用它重换一次 `sk-` Key。Cookie 本身过期时只能重新短信登录，届时会抛错。
 */
export function isScnetRefreshable(credential: ScnetCredential | undefined): boolean {
  const cookies = credential?.cookies
  return typeof cookies?.Token === 'string' && cookies.Token.length > 0
}

/**
 * 推理请求头。
 *
 * ⚠️ **SCNet 网关只认 `Authorization: Bearer sk-…`**，平台 Cookie 在这里完全
 * 不参与（参考实现实测：带 Cookie 不改变结果，带错 Key 回 401）。
 */
export function scnetChatHeaders(apiKey: string): Record<string, string> {
  return {
    accept: 'text/event-stream',
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  }
}

/** 网关 `GET /models` 的请求头。 */
export function scnetGatewayHeaders(apiKey: string): Record<string, string> {
  return { accept: 'application/json', authorization: `Bearer ${apiKey}` }
}

/** 发码失败的错误码 → 归类（文案取自平台登录页字典）。 */
export function mapScnetSmsError(code: string, message?: string): string {
  switch (String(code)) {
    case '1005': return 'too-frequent'
    case '1009': return 'captcha-invalid'
    case '3002': return 'captcha-invalid'
    case '1010': return 'virtual-number'
    case '429': return 'too-many-attempts'
    default: return translateScnetMessage(message) !== message ? 'platform' : 'rejected'
  }
}

/** 提交短信码失败的错误码 → 归类。 */
export function mapScnetLoginError(code: string, message?: string): string {
  switch (String(code)) {
    case '401': return 'auth-failed'
    case '1004': return 'auth-failed'
    case '1005': return 'auth-failed'
    case '1006': return 'invalid-params'
    case '1008': return 'user-not-exist'
    case '1009': return 'captcha-invalid'
    case '3002': return 'captcha-invalid'
    case '1001': return 'server-busy'
    case '429': return 'too-many-attempts'
    default: return 'rejected'
  }
}

/**
 * 平台英文原文 → 中文兜底。
 *
 * 平台在部分分支返回英文原文（`Username or password is incorrect` 之类），
 * 不翻译的话界面会把英文直接甩给用户。**平台自己的中文原话（`尚未开通`）
 * 原样返回**。
 */
export function translateScnetMessage(message: string | undefined): string {
  const text = String(message ?? '').trim()
  if (text.length === 0) return ''
  if (/[\u4e00-\u9fa5]/.test(text)) return text
  if (/username\s+or\s+password\s+is\s+incorrect/i.test(text)) {
    return '平台把这次提交当成了账号密码登录（该手机号可能尚未注册，或需要重新获取图形验证码后重试）'
  }
  if (/invalid\s+verification\s+code/i.test(text)) return '短信验证码不正确或已过期'
  if (/invalid\s+parameters/i.test(text)) return '参数无效（请重新获取图形验证码后重试）'
  if (/too\s+often|too\s+many/i.test(text)) return '操作过于频繁，请稍后再试'
  if (/virtual/i.test(text)) return '该号段为虚拟运营商，平台不接受'
  if (/not\s+exist/i.test(text)) return '该手机号尚未注册'
  if (/signature\s+failed/i.test(text)) return '图形验证码签名校验失败，请刷新验证码后重试'
  if (/timeout|timed\s+out/i.test(text)) return '平台响应超时，请重试'
  return text
}

/** `Set-Cookie` 头 → 只保留我们要的那两个 Cookie。 */
export function pickScnetCookies(setCookieHeaders: readonly string[]): ScnetCookies {
  const wanted = ['jsessionid', 'Token']
  const picked: ScnetCookies = {}
  for (const raw of setCookieHeaders) {
    const first = String(raw).split(';')[0] ?? ''
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    const canonical = wanted.find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    if (canonical === undefined || value.length === 0) continue
    // 删除 Cookie（Max-Age=0）时不记成有效值。
    if (/max-age\s*=\s*0/i.test(String(raw))) continue
    if (canonical === 'jsessionid') picked.jsessionid = value
    else picked.Token = value
  }
  return picked
}

/** Cookie 对象 → `Cookie` 请求头（也接受调用方直接给字符串）。 */
export function scnetCookieHeader(cookies: ScnetCookies | string | undefined): string {
  if (typeof cookies === 'string') return cookies.trim()
  if (cookies === undefined || cookies === null) return ''
  return (['jsessionid', 'Token'] as const)
    .map((name) => {
      const value = cookies[name]
      return typeof value === 'string' && value.length > 0 ? `${name}=${value}` : ''
    })
    .filter((part) => part.length > 0)
    .join('; ')
}

/** 只保留允许的形状；不做任何补全。 */
export function normalizeScnetCookies(input: unknown): ScnetCookies | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const out: ScnetCookies = {}
  for (const name of ['jsessionid', 'Token'] as const) {
    const value = record[name]
    if (typeof value === 'string' && value.trim().length > 0 && value.length < 4096) {
      out[name] = value.trim()
    }
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** 从凭据里读出可用的 Key（形状校验：必须 `sk-` 开头）。 */
export function scnetApiKeyOf(credential: ScnetCredential | undefined): string | undefined {
  const key = typeof credential?.apiKey === 'string' ? credential.apiKey.trim() : ''
  return key.startsWith('sk-') ? key : undefined
}