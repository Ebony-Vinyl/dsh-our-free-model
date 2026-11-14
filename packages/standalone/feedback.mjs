/**
 * 插件内反馈：GitHub 登录 + 问题/许愿提交。
 *
 * 浏览器不直接连反馈服务器，原因有两条：
 *  1. 管理页面是 loopback 上的本地服务，直连外部域会被 CSP 与同源策略拦掉；
 *  2. 登录令牌必须留在本机（`settings.feedbackAuth`），页面只拿到"已登录是谁"，
 *     拿不到令牌本身 —— 这样即便页面被注入脚本，也偷不走能冒名提交的凭据。
 *
 * 与 `src/eac-login.js` 的关系：两者都是 device flow，但那边绑的是 EAC 网关
 * （付费通道，要校验 star），这里绑的是反馈收集服务，只有只读身份。刻意不共用
 * 一份实现 —— 共用会让"改反馈服务器"变成"可能弄坏付费通道"。
 */

const DEFAULT_BASE = 'https://ourfreemodel.beichenapi.com/feedback'
const MAX_TITLE = 120
const MAX_DETAIL = 8000
const KINDS = new Set(['bug', 'wish'])

const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode })

/**
 * 只接受 https；允许 loopback http，便于本机自测反馈服务。
 *
 * 返回的是**完整基址**（origin + path），不是 origin：反馈服务挂在反向代理的
 * `/feedback/*` 下，由 Caddy 的 handle_path 剥掉前缀再转给它，所以客户端必须
 * 把这一段带上。早期版本这里 return parsed.origin，把默认地址里的 `/feedback`
 * 丢掉，于是所有请求都打到面板根路径的 `/api/*`（404），登录与提交全部不可用。
 */
function baseOf(settings) {
  const raw = typeof settings()?.feedbackUrl === 'string' ? settings().feedbackUrl.trim() : ''
  const value = raw || DEFAULT_BASE
  let parsed
  try { parsed = new URL(value) } catch { throw fail(400, '反馈服务器地址无效') }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)
  if (parsed.protocol !== 'https:' && !(loopback && parsed.protocol === 'http:')) {
    throw fail(400, '反馈服务器必须是 https 地址（本机调试可用 http）')
  }
  if (parsed.username || parsed.password) throw fail(400, '反馈服务器地址不能包含凭据')
  if (parsed.search || parsed.hash) throw fail(400, '反馈服务器地址不能带查询串或片段')
  // 去掉结尾斜杠，拼接时统一补 `/api/...`；路径本身保留。
  return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '')
}

async function call(url, init = {}) {
  let response
  try {
    response = await fetch(url, {
      ...init,
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    })
  } catch { throw fail(502, '反馈服务器暂时无法连接，请稍后重试') }
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    // 把服务端的错误码透出去，但不透整段响应体：服务端可能回显请求内容。
    const code = typeof body?.error === 'string' ? body.error.slice(0, 40) : `HTTP ${response.status}`
    // 上游 401 单独标出来：调用方据此清掉本地令牌，否则页面会一直显示"已登录"
    // 而每次提交都失败，用户唯一的出路是自己发现要点退出。
    throw Object.assign(fail(502, `反馈服务器返回错误：${code}`), { upstreamStatus: response.status })
  }
  return body ?? {}
}

export function createFeedback({ settings, persist }) {
  const token = () => {
    const value = settings()?.feedbackAuth
    return value && typeof value.token === 'string' && value.token !== '' ? value : null
  }
  return {
    /** 当前登录状态。令牌不出本进程。 */
    status() {
      const value = token()
      return value ? { signedIn: true, login: String(value.login ?? '') } : { signedIn: false, login: '' }
    },
    /** 发起 device flow：返回用户码与验证地址，令牌由 poll 收下。 */
    async start() {
      const base = baseOf(settings)
      const body = await call(`${base}/api/auth/start`, { method: 'POST' })
      if (typeof body.session !== 'string' || typeof body.userCode !== 'string') throw fail(502, '反馈服务器返回了无法识别的登录响应')
      return {
        session: body.session, userCode: body.userCode,
        verifyUrl: typeof body.verifyUrl === 'string' ? body.verifyUrl : 'https://github.com/login/device',
        expiresIn: Number(body.expiresIn) || 900,
      }
    },
    /** 轮询授权结果；成功后把令牌落到本机设置。 */
    async poll({ session }) {
      if (typeof session !== 'string' || session.length > 200) throw fail(400, '登录会话无效')
      const base = baseOf(settings)
      const body = await call(`${base}/api/auth/poll`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session }),
      })
      if (body.status === 'ok') {
        if (typeof body.token !== 'string' || body.token === '') throw fail(502, '反馈服务器未返回登录令牌')
        persist({ feedbackAuth: { token: body.token, login: String(body.login ?? ''), at: Date.now() } })
        return { status: 'ok', login: String(body.login ?? '') }
      }
      if (body.status === 'pending') return { status: 'pending' }
      if (body.status === 'expired') return { status: 'expired' }
      if (body.status === 'denied') return { status: 'denied', error: String(body.error ?? '') }
      throw fail(502, '反馈服务器返回了无法识别的登录状态')
    },
    /** 退出：只清本机令牌。服务端令牌自然过期，不做远端撤销。 */
    signOut() {
      persist({ feedbackAuth: null })
      return { signedIn: false, login: '' }
    },
    /** 提交一条反馈。没有登录一律拒绝 —— 无法回访的问题单没有价值。 */
    async submit(patch) {
      const auth = token()
      if (!auth) throw fail(401, '请先用 GitHub 登录再提交反馈')
      const kind = typeof patch?.kind === 'string' ? patch.kind : ''
      const title = typeof patch?.title === 'string' ? patch.title.trim() : ''
      const detail = typeof patch?.detail === 'string' ? patch.detail.trim() : ''
      if (!KINDS.has(kind)) throw fail(400, '请选择反馈类型')
      if (!title) throw fail(400, '请填写标题')
      if (title.length > MAX_TITLE) throw fail(400, `标题不能超过 ${MAX_TITLE} 字`)
      if (!detail) throw fail(400, '请描述你遇到的问题或想要的功能')
      if (detail.length > MAX_DETAIL) throw fail(400, `描述不能超过 ${MAX_DETAIL} 字`)
      const base = baseOf(settings)
      let body
      try {
        body = await call(`${base}/api/feedback`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
          body: JSON.stringify({
            kind, title, detail,
            version: String(patch?.version ?? '').slice(0, 64),
            platform: String(patch?.platform ?? '').slice(0, 64),
            page: String(patch?.page ?? '').slice(0, 64),
          }),
        })
      } catch (error) {
        // 服务端说这个令牌不认（重启丢了内存会话、或 7 天到期）：清掉本地令牌，
        // 让页面回到"未登录"，用户下一次点击就会重新走 device flow，而不是对着
        // 一个永远失败的提交按钮。
        if (error?.upstreamStatus === 401) {
          persist({ feedbackAuth: null })
          throw fail(401, '反馈登录已失效，请重新用 GitHub 登录。')
        }
        throw error
      }
      // 没有单号就等于没落盘：代理回的 200 HTML 错误页也会走到这里，那时若照样
      // 回一个空单号，页面会显示"已提交，单号 "并清空正文，用户既丢了文字也没有凭证。
      if (typeof body.id !== 'string' || body.id === '') throw fail(502, '反馈服务器没有返回单号，请稍后重试')
      return { id: body.id }
    },
  }
}
