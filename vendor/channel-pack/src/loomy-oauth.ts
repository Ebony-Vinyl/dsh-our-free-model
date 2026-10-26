/**
 * Loomy 短信验证码登录。
 *
 * ## 为什么与其余 7 个 provider 不同
 *
 * 那 7 个都是「返回 loginUrl → 前端 window.open → 轮询 login.poll」。
 * 短信登录**没有 URL 可打开**，故走「发验证码 → 用户输入 → 提交」三步，
 * 由 Channel Pack 渲染表单（见 `loginMode: 'sms'` 契约）。
 *
 * ## 端点与请求体
 *
 * ```
 * POST {accountBase}/login/phone/sendMsgCode   { base, param:{ ccode, phone, expire:300 } }
 * POST {accountBase}/login/phone/checkCode     { base, param:{ ccode, phone, mcode, msgid, expire:1209600 } }
 * ```
 *
 * ⚠️ 认证是 **HMAC-SHA1 签名**（`Authorization: account {ak}:{sig}`），
 * 不是 Bearer。见 `loomy-sign.ts`。
 * ⚠️ body 必须**先序列化成字符串**，签名与发送共用同一个字符串 ——
 * 二次序列化会改变字节（键序/空格）导致签名失效。
 * ⚠️ `ua` 硬编码 `Loomy|Desktop|Electron|macOS`，Windows 上也是这个值。
 */

import { randomUUID } from 'node:crypto'
import { LOOMY_REQUEST_TIMEOUT_MS, parseLoomyEnvelope } from './loomy.js'
import { loomyAuthHeaders } from './loomy-sign.js'
import type { LoomyProduct } from './loomy-product.js'

/** 短信验证码有效期（秒）。 */
export const LOOMY_SMS_CODE_TTL_SECONDS = 300

/**
 * 登录会话有效期（秒）= 14 天。
 *
 * 依据 `account-service.js:391` 的 `expire: 14 * 24 * 3600`。
 * ⚠️ 这只是向服务端**声明**的有效期，响应里不带到期时间戳，
 * 故凭据的 `expires_at` 由本地按此推算。
 */
export const LOOMY_SESSION_TTL_SECONDS = 1_209_600

/** 一次成功登录的结果。 */
export interface LoomyLoginResult {
  /** 32 位小写 hex 的讯飞 session。 */
  session: string
  /** 讯飞用户 id。 */
  userid: string
}

/**
 * 构建账号端点的请求体信封 `{ base, param }`。
 *
 * 依据 `account-service.js:441-450`。`traceid` 每次调用重新生成
 * （去掉连字符的 uuid，32 位 hex）。
 */
export function buildLoomyAccountBody(
  product: LoomyProduct,
  param: Record<string, unknown>,
): Record<string, unknown> {
  return {
    base: {
      appid: product.appId,
      modelid: 'Web',
      version: '1.0.0',
      devid: 'web',
      // ⚠️ 硬编码 macOS：客户端在 Windows 上发的也是这个值，照抄不要改。
      ua: 'Loomy|Desktop|Electron|macOS',
      traceid: randomUUID().replace(/-/g, ''),
    },
    param,
  }
}

/**
 * 发一次账号端点请求并拆信封。
 *
 * ⚠️ body 序列化一次、签名与发送共用 —— 这是签名能通过的前提。
 */
async function postLoomyAccount(
  path: string,
  body: Record<string, unknown>,
  product: LoomyProduct,
  fetcher: typeof fetch,
): Promise<unknown> {
  const serialized = JSON.stringify(body)
  const headers = loomyAuthHeaders({
    accessKeyId: product.accessKeyId,
    accessKeySecret: product.accessKeySecret,
    method: 'POST',
    path,
    body: serialized,
    contentType: 'application/json',
  })

  let response: Response
  try {
    response = await fetcher(`${product.accountBase}${path}`, {
      method: 'POST',
      headers,
      body: serialized,
      signal: AbortSignal.timeout(LOOMY_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new Error(
      `讯飞账号请求失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
    )
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    throw new Error(`讯飞账号响应不是 JSON（${path}，HTTP ${response.status}）`)
  }

  const envelope = parseLoomyEnvelope<Record<string, unknown>>(parsed)
  if (!envelope.ok) {
    // 账号端点的鉴权错误码与业务端点不同（实测 `020002` 也是登录态问题），
    // 但对本模块而言都是「这次调用失败」，直接透传 desc 即可 ——
    // 上层据文案判断「验证码错误」还是「手机号格式不正确」。
    throw new Error(envelope.message.length > 0 ? envelope.message : `讯飞账号请求失败（${path}）`)
  }
  return envelope.data
}

/**
 * 下发短信验证码。
 *
 * @returns `msgid` —— 提交验证码时必须原样带回。
 * @throws 手机号格式错误、频率限制、网络失败等（消息含服务端 `desc`）。
 */
export async function sendLoomySmsCode(
  phone: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = buildLoomyAccountBody(product, {
    ccode: '86',
    phone,
    expire: LOOMY_SMS_CODE_TTL_SECONDS,
  })
  const data = await postLoomyAccount('/login/phone/sendMsgCode', body, product, fetcher)
  const msgid = typeof (data as Record<string, unknown> | undefined)?.msgid === 'string'
    ? String((data as Record<string, unknown>).msgid)
    : ''
  if (msgid.length === 0) {
    // 不返回空串：上层会拿它去登录，服务端必然报「msgid 无效」，
    // 用户看到的将是一个与真实原因无关的错误。
    throw new Error('短信验证码响应缺少 msgid')
  }
  return msgid
}

/**
 * 用短信验证码登录。
 *
 * @returns `{ session, userid }`。
 * @throws 验证码错误/过期、缺少字段、网络失败。
 */
export async function loginLoomyBySmsCode(
  phone: string,
  code: string,
  msgid: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyLoginResult> {
  const body = buildLoomyAccountBody(product, {
    ccode: '86',
    phone,
    mcode: code,
    msgid,
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  const data = await postLoomyAccount('/login/phone/checkCode', body, product, fetcher)
  const record = (data ?? {}) as Record<string, unknown>
  const session = typeof record.session === 'string' ? record.session : ''
  const userid = typeof record.userid === 'string' ? record.userid : ''
  if (session.length === 0) throw new Error('登录响应缺少 session')
  if (userid.length === 0) throw new Error('登录响应缺少 userid')
  return { session, userid }
}

// ── 微信扫码登录：四步强制绑手机号流程 ──────────────────────────────
//
// 依据 `account-service.js:429-519`（注释直接引讯飞文档 §3.2.7）：
//
//   1. bindAuthThirdAccount(code) → { bind, rcode, isnew, nickname, headpic }
//        - bind=1 已绑手机号 → 直接 bindSkip 拿 session
//        - bind=0 未绑       → 弹绑定 UI，走 bindSendMsg + bindCheckCode
//   2. bindSendMsg({ rcode, phone })          → { msgid }
//   3. bindCheckCode({ rcode, mcode, msgid }) → session + userid + phone
//   4. bindSkip({ rcode })                    → session + userid
//
// ⚠️ 微信 code 只在第 1 步用一次；后续三步只用 `rcode`。

/** 微信授权的中间上下文（第 1 步返回）。 */
export interface LoomyWechatBindAuth {
  /** 1 = 讯飞侧已绑手机号（可直接 bindSkip）；0 = 需绑定手机号。 */
  bind: 0 | 1
  /** 后续三步都要用的会话标识。 */
  rcode: string
  /** 是否新注册用户（仅展示用）。 */
  isnew?: number
  /** 微信昵称（仅展示用）。 */
  nickname?: string
  /** 微信头像（仅展示用）。 */
  headpic?: string
}

/**
 * 第 1 步：用微信 code 换 rcode，并得知是否已绑手机号。
 *
 * @throws 缺少 rcode、微信 code 无效、网络失败。
 */
export async function bindLoomyThirdAccount(
  code: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyWechatBindAuth> {
  const body = buildLoomyAccountBody(product, {
    tcode: { code },
    type: 'wx',
  })
  const data = await postLoomyAccount('/login/thirdAccount/bind/auth', body, product, fetcher)
  const record = (data ?? {}) as Record<string, unknown>
  const rcode = typeof record.rcode === 'string' ? record.rcode : ''
  if (rcode.length === 0) {
    // 没有 rcode 后续三步全做不了，必须明确报错（而不是让流程走到一半才失败）。
    throw new Error('微信授权响应缺少 rcode')
  }
  // ⚠️ `bind` 缺失时**归为 0**（走绑定流程）：保守方向 —— 若实际已绑，
  // 用户最多多填一次手机号；若实际未绑却跳过，会拿到一个没有手机号的账号。
  const bind = record.bind === 1 ? 1 : 0
  return {
    bind,
    rcode,
    ...typeof record.isnew === 'number' ? { isnew: record.isnew } : {},
    ...typeof record.nickname === 'string' && record.nickname.length > 0
      ? { nickname: record.nickname } : {},
    ...typeof record.headpic === 'string' && record.headpic.length > 0
      ? { headpic: record.headpic } : {},
  }
}

/**
 * 第 2 步：向待绑定的手机号下发验证码。
 *
 * @returns `msgid` —— 第 3 步必须原样带回。
 */
export async function bindLoomySendMsg(
  rcode: string,
  phone: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const body = buildLoomyAccountBody(product, {
    rcode,
    phone,
    ccode: '86',
    expire: LOOMY_SMS_CODE_TTL_SECONDS,
  })
  const data = await postLoomyAccount('/login/thirdAccount/bind/sendMsg', body, product, fetcher)
  const msgid = typeof (data as Record<string, unknown> | undefined)?.msgid === 'string'
    ? String((data as Record<string, unknown>).msgid)
    : ''
  if (msgid.length === 0) throw new Error('绑定手机号响应缺少 msgid')
  return msgid
}

/**
 * 第 3 步：验证短信验证码，通过即完成绑定 + 登录。
 *
 * @returns `{ session, userid, phone }`。
 */
export async function bindLoomyCheckCode(
  rcode: string,
  mcode: string,
  msgid: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyLoginResult & { phone: string }> {
  const body = buildLoomyAccountBody(product, {
    rcode,
    mcode,
    msgid,
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  const data = await postLoomyAccount('/login/thirdAccount/bind/checkCode', body, product, fetcher)
  const record = (data ?? {}) as Record<string, unknown>
  const session = typeof record.session === 'string' ? record.session : ''
  const userid = typeof record.userid === 'string' ? record.userid : ''
  const phone = typeof record.phone === 'string' ? record.phone : ''
  if (session.length === 0) throw new Error('绑定登录响应缺少 session')
  if (userid.length === 0) throw new Error('绑定登录响应缺少 userid')
  return { session, userid, phone }
}

/**
 * 第 4 步（`bind === 1` 时走）：跳过绑定，直接换 session。
 *
 * 业务侧仅在 `bind === 1`（微信已绑过手机号）时调用 —— 让讯飞跳过
 * 「重新绑手机」步骤直接下发 session。
 */
export async function bindLoomySkip(
  rcode: string,
  product: LoomyProduct,
  fetcher: typeof fetch = fetch,
): Promise<LoomyLoginResult> {
  const body = buildLoomyAccountBody(product, {
    rcode,
    expire: LOOMY_SESSION_TTL_SECONDS,
  })
  const data = await postLoomyAccount('/login/thirdAccount/bind/skip', body, product, fetcher)
  const record = (data ?? {}) as Record<string, unknown>
  const session = typeof record.session === 'string' ? record.session : ''
  const userid = typeof record.userid === 'string' ? record.userid : ''
  if (session.length === 0) throw new Error('微信登录响应缺少 session')
  if (userid.length === 0) throw new Error('微信登录响应缺少 userid')
  return { session, userid }
}
