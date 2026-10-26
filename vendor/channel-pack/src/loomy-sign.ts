/**
 * 讯飞账号（CAccount）HMAC-SHA1 签名。
 *
 * 逐字节复刻 Loomy 客户端 `electron/xfyun/sign.js`。任何偏差都会让账号端点
 * 返回鉴权失败，故本模块**全部是纯函数**，由单测锁死拼串格式。
 *
 * ## 签名字符串（9 段，`\n` 连接）
 *
 * ```
 * {METHOD}\n{ESCAPED_PATH}\n{ESCAPED_QUERY}\n{Content-MD5}\n
 * {Content-Type}\n{Date}\n{Nonce}\n{SignedHeaders}\n{CanonicalizedHeaders}
 * ```
 *
 * ⚠️ 后两段在本项目**恒为空串**（我们不发任何 `x-*` 头），
 * 故最终字符串**以两个换行结尾**。这是 `join('\n')` 在 9 个元素上的自然结果，
 * 不要「顺手」去掉尾随换行 —— 去掉会让签名不匹配。
 *
 * ⚠️ 认证头前缀是 **`account`**（`account {ak}:{sig}`），不是 `Bearer`。
 */

import { createHash, createHmac, randomUUID } from 'node:crypto'

/** 签名所需参数。 */
export interface LoomySignOptions {
  accessKeyId: string
  accessKeySecret: string
  method: string
  path: string
  queryParams?: Record<string, string>
  /** **已序列化**的请求体字符串（与发送时用的必须是同一个）。 */
  body?: string
  contentType?: string
}

/**
 * 计算 `Content-MD5`（base64）。
 *
 * ⚠️ 空 body 返回**空串**而不是空串的 md5 —— 与客户端 `sign.js:13-18` 一致。
 */
export function loomyContentMd5(body: string): string {
  if (body.length === 0) return ''
  return createHash('md5').update(body, 'utf8').digest('base64')
}

/**
 * RFC3986 转义（`encodeURIComponent` + 补转 `! ' ( ) *`）。
 *
 * 依据 `sign.js:23-42`：路径段与 query 值用同一套转义。
 */
function escapeRfc3986(value: string): string {
  return encodeURIComponent(value)
    .replace(/!/g, '%21')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/\*/g, '%2A')
}

/**
 * 构建 ESCAPED_PATH。
 *
 * 依据 `sign.js:47-58`：补前导 `/`、剥末尾 `/`（长度 > 1 时）、
 * 按 `/` 切段后逐段转义再拼回。
 */
function buildEscapedPath(rawPath: string): string {
  let clean = rawPath.startsWith('/') ? rawPath : `/${rawPath}`
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1)
  return clean.split('/').map((seg) => (seg.length > 0 ? escapeRfc3986(seg) : '')).join('/')
}

/**
 * 构建 ESCAPED_QUERY_STRING。
 *
 * 依据 `sign.js:63-79`：`key=value` 用 `&` 连接，**不排序**（保持传入顺序），
 * 两者都转义；`null` / `undefined` 值转成空串。
 */
function buildEscapedQueryString(queryParams: Record<string, string> | undefined): string {
  if (queryParams === undefined) return ''
  const entries = Object.entries(queryParams)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${escapeRfc3986(key)}=${value === null || value === undefined ? '' : escapeRfc3986(String(value))}`)
    .join('&')
}

/**
 * 构建待签名字符串。
 *
 * `date` / `nonce` 由调用方传入（而非在此生成），使本函数**完全确定**、
 * 可用固定值单测。
 */
export function buildLoomySigningString(
  options: LoomySignOptions & { date: string; nonce: string },
): string {
  const method = options.method.toUpperCase()
  const escapedPath = buildEscapedPath(options.path)
  const escapedQuery = buildEscapedQueryString(options.queryParams)
  const body = options.body ?? ''
  const md5 = loomyContentMd5(body)
  const contentType = options.contentType ?? ''

  // ⚠️ 后两段恒为空串（本项目不发 x-* 头）。join 后字符串以 `\n\n` 结尾。
  const signedHeaders = ''
  const canonicalizedHeaders = ''

  return [
    method,
    escapedPath,
    escapedQuery,
    md5,
    contentType,
    options.date,
    options.nonce,
    signedHeaders,
    canonicalizedHeaders,
  ].join('\n')
}

/**
 * 生成完整的讯飞账号请求头。
 *
 * `Date` 用 UTC 字符串、`Nonce` 用 UUID（与客户端 `sign.js:207-208` 一致）。
 *
 * ⚠️ **返回的 body 必须与签名时的 `options.body` 是同一个字符串**：
 * 调用方应先把 body `JSON.stringify` 一次，签名与发送共用该字符串，
 * 否则 axios/fetch 的二次序列化会改变字节（键序、空格），签名随即失效。
 */
export function loomyAuthHeaders(options: LoomySignOptions): Record<string, string> {
  const date = new Date().toUTCString()
  const nonce = randomUUID()
  const contentType = options.contentType ?? 'application/json'
  const body = options.body ?? ''

  const stringToSign = buildLoomySigningString({ ...options, contentType, body, date, nonce })
  const signature = createHmac('sha1', options.accessKeySecret)
    .update(stringToSign, 'utf8')
    .digest('base64')

  const headers: Record<string, string> = {
    Authorization: `account ${options.accessKeyId}:${signature}`,
    Date: date,
    Nonce: nonce,
    'Content-Type': contentType,
  }
  const md5 = loomyContentMd5(body)
  if (md5.length > 0) headers['Content-MD5'] = md5
  return headers
}
