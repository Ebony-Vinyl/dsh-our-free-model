/**
 * Loomy 微信扫码登录流程（本地服务器承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方客户端用 Electron `BrowserWindow` 的 `will-redirect` 截获微信 code，
 * 而那个回调页（`loomy.xunfei.cn/oauth/wechat/callback`）实测 **404**。
 * 本插件没有 `will-redirect`，故**不用回调页收 code** —— 改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET /wechat/qr       → 弹窗页：内联二维码（data URL）+ 前端轮询 + 绑定手机号表单
 *   GET /wechat/poll     → 前端轮询：长轮询微信，返回状态（待扫码/已扫码/已确认）
 *   POST /wechat/complete→ 提交微信 code（或手机号+验证码）完成登录
 * ```
 *
 * 微信 `code` 由**长轮询**（`loomy-wechat.ts`）直接拿到，完全绕开那个 404 回调页。
 *
 * ## 与其余 provider 的契约一致性
 *
 * ## ⚠️ redirect_uri 必须是官方地址
 *
 * 微信校验域名白名单（实测换本地地址会得到「redirect_uri 参数错误」），
 * 故 `buildLoomyWechatAuthUrl` 里写死官方地址 —— 它只用于**取 uuid**，
 * 不参与回调（我们从长轮询拿 code）。
 */

import { createServer, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import type { LoomyProduct } from './loomy-product.js'
import {
  LOOMY_WECHAT_POLL_STATUS,
  fetchLoomyWechatQrImage,
  fetchLoomyWechatUuid,
  pollLoomyWechatOnce,
} from './loomy-wechat.js'
import {
  bindLoomyCheckCode,
  bindLoomySendMsg,
  bindLoomySkip,
  bindLoomyThirdAccount,
  type LoomyLoginResult,
} from './loomy-oauth.js'

/**
 * 按平台决定「用哪个命令打开 URL」。
 *
 * 保留这个纯函数是为了让「平台分派」有**可离线单测**的落点 ——
 * 早期这里有个会真的 spawn 浏览器的 `defaultOpenBrowser`，单测一调它
 * 就弹出 `http://127.0.0.1:1/never`（真实缺陷，用户报障）。
 * 现在只测这个纯函数，**永不 spawn**。
 */
export function resolveOpenCommand(
  platform: string,
): { command: string; args: string[] } {
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] }
  if (platform === 'darwin') return { command: 'open', args: [] }
  return { command: 'xdg-open', args: [] }
}

/** 整个扫码 + 绑定的超时（毫秒）。 */
export const LOOMY_WECHAT_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 本地弹窗页的路径。 */
export const LOOMY_WECHAT_QR_PATH = '/wechat/qr'
/** 前端轮询端点。 */
export const LOOMY_WECHAT_POLL_PATH = '/wechat/poll'
/** 提交端点（微信 code 或手机号验证码）。 */
export const LOOMY_WECHAT_COMPLETE_PATH = '/wechat/complete'

/** 微信登录流程的选项。 */
export interface LoomyWechatLoginOptions {
  product: LoomyProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 超时（毫秒）。 */
  timeoutMs?: number
}

/** `startLoomyWechatLoginFlow` 的返回值（与其余 provider 的 `StartedXxxLoginFlow` 同形）。 */
export interface StartedLoomyWechatLoginFlow {
  /** 弹窗地址（本地服务器）。 */
  loginUrl: string
  /** 登录结果（凭据 + 手机号）。 */
  result: Promise<LoomyLoginResult & { phone: string; nickname?: string }>
  /** 主动关闭本地服务器。 */
  close: () => Promise<void>
}

/** 服务器内部状态。 */
interface FlowState {
  uuid: string
  /** 最近一次长轮询的 errcode（作为下次的 `last` 参数）。 */
  lastErrcode: string
  /** 微信确认后拿到的 code（一次性）。 */
  wechatCode: string
  /** bindAuth 返回的上下文（拿 code 后填充）。 */
  rcode: string
  /** `bindAuthThirdAccount` 的 bind 值。 */
  bind: 0 | 1
  /** 微信昵称（展示用）。 */
  nickname: string
  /** 绑手机号流程里 `bindSendMsg` 返回的 msgid。 */
  bindMsgid: string
}

/**
 * 启动微信扫码登录流程。
 *
 * 立即返回 `loginUrl`（本地弹窗页）与 `result` promise，**不阻塞** ——
 * 与其余 provider 的「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export async function startLoomyWechatLoginFlow(
  options: LoomyWechatLoginOptions,
): Promise<StartedLoomyWechatLoginFlow> {
  const fetcher = options.fetcher ?? fetch
  const product = options.product
  const state: FlowState = {
    uuid: '',
    lastErrcode: '',
    wechatCode: '',
    rcode: '',
    bind: 0,
    nickname: '',
    bindMsgid: '',
  }

  let resolveResult!: (value: LoomyLoginResult & { phone: string; nickname?: string }) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<LoomyLoginResult & { phone: string; nickname?: string }>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快完成或立刻失败），
  // 那一段窗口里 Node 会报 unhandled rejection（与 lobsterai-oauth 同因）。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: LoomyLoginResult & { phone: string; nickname?: string }): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  // 先取 uuid（失败则整个流程起不来，直接抛给调用方）。
  state.uuid = await fetchLoomyWechatUuid(randomUUID(), fetcher)

  const server = createServer((request, response) => {
    void handleRequest(request, response, {
      state, product, fetcher, settleOk, settleErr,
    }).catch((error: unknown) => {
      try {
        response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // 响应可能已发出，忽略
      }
    })
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${LOOMY_WECHAT_QR_PATH}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const timeoutMs = options.timeoutMs ?? LOOMY_WECHAT_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`Loomy 微信登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径）。
  result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    void close()
  })

  return { loginUrl, result, close }
}

/** 一次请求的依赖集合。 */
interface HandleDeps {
  state: FlowState
  product: LoomyProduct
  fetcher: typeof fetch
  settleOk: (value: LoomyLoginResult & { phone: string; nickname?: string }) => void
  settleErr: (error: unknown) => void
}

/** 处理一次本地请求。 */
async function handleRequest(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
  const { state } = deps

  if (url.pathname === LOOMY_WECHAT_QR_PATH) {
    // 弹窗页：内联二维码（data URL），无需外部资源。
    const qrDataUrl = await fetchLoomyWechatQrImage(state.uuid, deps.fetcher)
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderQrPage(qrDataUrl))
    return
  }

  if (url.pathname === LOOMY_WECHAT_POLL_PATH) {
    // 前端轮询：转发一次微信长轮询，把状态回给页面。
    if (state.wechatCode.length > 0) {
      writeJson(response, { status: LOOMY_WECHAT_POLL_STATUS.confirmed })
      return
    }
    const polled = await pollLoomyWechatOnce(state.uuid, state.lastErrcode, deps.fetcher)
    if (polled.errcode.length > 0) state.lastErrcode = polled.errcode

    if (polled.status === LOOMY_WECHAT_POLL_STATUS.confirmed && polled.code.length > 0) {
      state.wechatCode = polled.code
      // 拿到 code 后立刻换 rcode（一次网络往返），把 bind 结果一并回给页面，
      // 页面据此决定「直接成功」还是「显示绑定手机号表单」。
      try {
        const auth = await bindLoomyThirdAccount(polled.code, deps.product, deps.fetcher)
        state.rcode = auth.rcode
        state.bind = auth.bind
        state.nickname = auth.nickname ?? ''
        if (auth.bind === 1) {
          // 已绑手机号：直接 skip 换 session，整个流程结束。
          const login = await bindLoomySkip(auth.rcode, deps.product, deps.fetcher)
          deps.settleOk({ ...login, phone: '', ...state.nickname.length > 0 ? { nickname: state.nickname } : {} })
          writeJson(response, { status: 'done', message: '登录成功，可以关闭此窗口了' })
          return
        }
        writeJson(response, { status: 'need_phone' })
        return
      } catch (error) {
        deps.settleErr(error)
        writeJson(response, { status: 'error', message: error instanceof Error ? error.message : String(error) })
        return
      }
    }
    writeJson(response, { status: polled.status })
    return
  }

  if (url.pathname === LOOMY_WECHAT_COMPLETE_PATH && request.method === 'POST') {
    const body = await readJsonBody(request)
    const action = typeof body.action === 'string' ? body.action : ''
    try {
      if (action === 'send_sms') {
        const phone = String(body.phone ?? '')
        state.bindMsgid = await bindLoomySendMsg(state.rcode, phone, deps.product, deps.fetcher)
        writeJson(response, { ok: true })
        return
      }
      if (action === 'verify_sms') {
        const phone = String(body.phone ?? '')
        const code = String(body.code ?? '')
        const login = await bindLoomyCheckCode(
          state.rcode, code, state.bindMsgid, deps.product, deps.fetcher,
        )
        deps.settleOk({
          session: login.session,
          userid: login.userid,
          phone: login.phone.length > 0 ? login.phone : phone,
          ...state.nickname.length > 0 ? { nickname: state.nickname } : {},
        })
        writeJson(response, { ok: true, done: true })
        return
      }
      writeJson(response, { ok: false, message: `未知 action: ${action}` })
    } catch (error) {
      // 单步失败**不终止**整个流程（用户可能只是验证码输错），
      // 把原因回给页面让它就地提示并允许重试。
      writeJson(response, { ok: false, message: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

/** 写一个 JSON 响应。 */
function writeJson(response: import('node:http').ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** 读取并解析请求体（上限 64KB，避免被塞爆）。 */
async function readJsonBody(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buf = chunk as Buffer
    total += buf.length
    if (total > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buf)
  }
  const text = Buffer.concat(chunks).toString('utf-8')
  if (text.length === 0) return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/**
 * 在 `127.0.0.1` 的随机空闲端口上启动服务器。
 *
 * 绑 `127.0.0.1` 而非 `0.0.0.0`：弹窗页只可能来自本机浏览器，不对外暴露。
 */
function listenOnRandomPort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      if (port === 0) {
        reject(new Error('Loomy 微信登录服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/**
 * 渲染弹窗页。
 *
 * 单文件、内联二维码（data URL）、无外部资源 —— 断网也能显示（除轮询外）。
 * 页面自己负责：轮询状态 → 需要时显示绑定手机号表单 → 成功后提示关闭。
 *
 * ⚠️ 二维码是**内联**的（`data:image/jpeg;base64,…`），不走外部请求：
 * 避免弹窗页依赖网络加载图片而白屏。
 */
function renderQrPage(qrDataUrl: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Loomy 微信登录</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 28px 32px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 17px; margin: 0 0 4px; font-weight: 600; }
  .sub { font-size: 13px; color: #8a9099; margin-bottom: 18px; }
  .qr { width: 220px; height: 220px; display: block; margin: 0 auto; border: 1px solid #eceef1; border-radius: 8px; }
  .status { margin-top: 16px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  .form { display: none; margin-top: 18px; text-align: left; }
  .form[data-show="1"] { display: block; }
  .form label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
           background: #07c160; color: #fff; cursor: pointer; }
  button:disabled { background: #c9cdd4; cursor: not-allowed; }
  button.ghost { background: #f2f3f5; color: #1f2329; margin-top: 8px; }
  .row { display: flex; gap: 8px; }
  .row input { margin-bottom: 10px; }
  .row button { width: auto; white-space: nowrap; padding: 8px 12px; }
</style>
</head>
<body>
  <div class="card">
    <h1>使用微信扫码登录 Loomy</h1>
    <div class="sub">打开微信扫一扫，扫描下方二维码</div>
    <img class="qr" id="qr" alt="微信登录二维码" src="${qrDataUrl}">
    <div class="status" id="status">等待扫码…</div>

    <div class="form" id="phoneForm">
      <label for="phone">首次使用需绑定手机号</label>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="手机号">
        <button id="sendBtn" type="button">获取验证码</button>
      </div>
      <input id="code" type="text" inputmode="numeric" maxlength="6" placeholder="短信验证码">
      <button id="verifyBtn" type="button">完成绑定并登录</button>
    </div>
  </div>

<script>
(function () {
  var statusEl = document.getElementById('status');
  var formEl = document.getElementById('phoneForm');
  var phoneEl = document.getElementById('phone');
  var codeEl = document.getElementById('code');
  var sendBtn = document.getElementById('sendBtn');
  var verifyBtn = document.getElementById('verifyBtn');
  var stopped = false;

  function setStatus(text, tone) {
    statusEl.textContent = text;
    if (tone) statusEl.setAttribute('data-tone', tone);
    else statusEl.removeAttribute('data-tone');
  }

  function post(payload) {
    return fetch('${LOOMY_WECHAT_COMPLETE_PATH}', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) { return r.json(); });
  }

  // 轮询循环：408/405 继续；need_phone 切到绑定表单；done 停止。
  function poll() {
    if (stopped) return;
    fetch('${LOOMY_WECHAT_POLL_PATH}')
      .then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.status === 'done') {
          stopped = true;
          setStatus(res.message || '登录成功，可以关闭此窗口了', 'ok');
          formEl.setAttribute('data-show', '0');
          return;
        }
        if (res.status === 'need_phone') {
          stopped = true;
          setStatus('已扫码，请绑定手机号');
          formEl.setAttribute('data-show', '1');
          return;
        }
        if (res.status === 'expired') {
          stopped = true;
          setStatus('二维码已失效，请关闭窗口后重试', 'err');
          return;
        }
        if (res.status === 'cancelled') {
          stopped = true;
          setStatus('你已取消授权，请关闭窗口后重试', 'err');
          return;
        }
        if (res.status === 'error') {
          setStatus(res.message || '微信授权失败', 'err');
          stopped = true;
          return;
        }
        // ⚠️ scanned（404）只是「已扫码待确认」，**必须继续轮询**等 405。
        // 早期把 404/405 读反，导致此处永远停在「已扫码，请在手机上确认」。
        if (res.status === 'scanned') setStatus('已扫码，请在手机上确认');
        else setStatus('等待扫码…');
        setTimeout(poll, 1200);
      })
      .catch(function () {
        // 网络抖动不终止轮询（长轮询偶发失败是常态）。
        setTimeout(poll, 2000);
      });
  }

  sendBtn.addEventListener('click', function () {
    var phone = (phoneEl.value || '').replace(/\\D/g, '');
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    sendBtn.disabled = true;
    setStatus('正在发送验证码…');
    post({ action: 'send_sms', phone: phone })
      .then(function (res) {
        if (res.ok) setStatus('验证码已发送至 ' + phone);
        else setStatus(res.message || '发送失败', 'err');
      })
      .catch(function () { setStatus('发送失败，请重试', 'err'); })
      .finally(function () { sendBtn.disabled = false; });
  });

  verifyBtn.addEventListener('click', function () {
    var phone = (phoneEl.value || '').replace(/\\D/g, '');
    var code = (codeEl.value || '').replace(/\\D/g, '');
    if (phone.length !== 11) { setStatus('请输入 11 位手机号', 'err'); return; }
    if (code.length === 0) { setStatus('请输入短信验证码', 'err'); return; }
    verifyBtn.disabled = true;
    setStatus('正在完成绑定…');
    post({ action: 'verify_sms', phone: phone, code: code })
      .then(function (res) {
        if (res.ok && res.done) setStatus('登录成功，可以关闭此窗口了', 'ok');
        else setStatus(res.message || '验证码错误，请重试', 'err');
      })
      .catch(function () { setStatus('绑定失败，请重试', 'err'); })
      .finally(function () { verifyBtn.disabled = false; });
  });

  poll();
})();
</script>
</body>
</html>`
}
