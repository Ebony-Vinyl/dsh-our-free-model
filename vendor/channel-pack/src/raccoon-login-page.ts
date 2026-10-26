/**
 * Raccoon Work 本地登录页（宿主侧承载弹窗页）。
 *
 * ## 为什么需要本地服务器
 *
 * 官方桌面端的登录靠 `office-raccoon://auth/callback` 自定义协议回调，
 * 而本插件是宿主侧 Node 进程，**收不到该回调**；`/code/authorize` 页面的
 * 回调地址又是写死的，改不成 localhost。故改为：
 *
 * ```
 * 本地服务器（127.0.0.1:随机端口）
 *   GET  /raccoon/login       → 弹窗页：Tab 切换「微信扫码 / 短信登录」
 *   GET  /raccoon/poll        → 前端轮询登录状态（宿主侧持有 qrcode_code）
 *   POST /raccoon/sms/send    → 提交手机号 + 阿里云 captcha_param
 *   POST /raccoon/sms/verify  → 提交验证码完成登录
 * ```
 *
 * 微信扫码的 `code` 由**宿主侧本地随机生成**（实测服务端接受任意自造 code
 * 并进入 `pending`），完全绕开那个收不到的自定义协议回调。
 *
 * ## 与其余 provider 的契约一致性
 *
 * ## ⚠️ 职责边界（安全约束）
 *
 * - **宿主侧**持有全部敏感状态：`qrcode_code`、手机号、凭据
 * - **页面侧**只做展示与表单提交：**不知道** `phoneCipherSecret`、token 等秘密
 * - 二维码由**宿主侧**生成 SVG 内联进 HTML（页面不需要任何 QR 逻辑，也不需要 CDN）
 * - 手机号加密在宿主侧的 `/raccoon/sms/send` 里完成
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  RACCOON_LOGIN_TIMEOUT_MS,
  type RaccoonCredential,
} from './raccoon.js'
import {
  buildQrImageUrl,
  generateQrCode,
  loginRaccoonWithSmsCode,
  pollRaccoonQrLogin,
  sendRaccoonSmsCode,
} from './raccoon-oauth.js'
import { RACCOON, type RaccoonProduct } from './raccoon-product.js'
import { renderQrSvg } from './raccoon-qr.js'

/** 本地登录页的路径。 */
export const RACCOON_LOGIN_PAGE_PATHS = {
  login: '/raccoon/login',
  poll: '/raccoon/poll',
  smsSend: '/raccoon/sms/send',
  smsVerify: '/raccoon/sms/verify',
} as const

/** 一次登录流程的句柄。 */
export interface StartedRaccoonLoginFlow {
  /** 弹窗地址（本地服务器）。 */
  loginUrl: string
  /** 登录结果（凭据）。 */
  result: Promise<RaccoonCredential>
  /** 主动关闭本地服务器。 */
  close: () => Promise<void>
}

/** 流程内部状态（**只存在于宿主侧**）。 */
interface FlowState {
  /** 扫码用的 code（宿主侧生成，页面不知道）。 */
  qrCode: string
  /** 当前展示的短信目标手机号（未发过短信时为空）。 */
  phone: string
  /** 最近一次轮询的二维码有效期（供页面展示倒计时）。 */
  lastExpiredAt: string | undefined
}

/** `startRaccoonLoginFlow` 的选项。 */
export interface RaccoonLoginFlowOptions {
  product?: RaccoonProduct
  /** 注入的 fetch（测试用）。 */
  fetcher?: typeof fetch
  /** 超时（毫秒）。 */
  timeoutMs?: number
}

/**
 * 启动登录流程。
 *
 * 立即返回 `loginUrl` 与 `result` promise，**不阻塞** —— 与其余 provider 的
 * 「两步式」约束一致（`window.open` 只在用户手势窗口内有效）。
 */
export async function startRaccoonLoginFlow(
  options: RaccoonLoginFlowOptions = {},
): Promise<StartedRaccoonLoginFlow> {
  const product = options.product ?? RACCOON
  const fetcher = options.fetcher ?? fetch
  const state: FlowState = {
    qrCode: generateQrCode(),
    phone: '',
    lastExpiredAt: undefined,
  }

  let resolveResult!: (value: RaccoonCredential) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<RaccoonCredential>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject（用户极快失败/立刻关闭），
  // 那一段窗口里 Node 会报 unhandled rejection（与 loomy-wechat-login 同因）。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: RaccoonCredential): void => {
    if (settled) return
    settled = true
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    rejectResult(error)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response, { state, product, fetcher, settleOk }).catch(
      (error: unknown) => {
        try {
          response
            .writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            .end(`内部错误：${error instanceof Error ? error.message : String(error)}`)
        } catch {
          // 响应可能已发出，忽略
        }
      },
    )
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${RACCOON_LOGIN_PAGE_PATHS.login}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    // 尚未落定则先 reject，避免调用方拿到一个永远悬挂的 promise。
    settleErr(new Error('raccoon: 登录流程已关闭'))
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
    })
  }

  const timeoutMs = options.timeoutMs ?? RACCOON_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`raccoon: 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成）`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径）。
  void result
    .catch(() => {})
    .finally(() => {
      clearTimeout(timer)
      if (!closed) {
        closed = true
        void new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
      }
    })

  return { loginUrl, result, close }
}

/** 一次请求的依赖集合。 */
interface HandleDeps {
  state: FlowState
  product: RaccoonProduct
  fetcher: typeof fetch
  settleOk: (value: RaccoonCredential) => void
}

/** 处理一次本地请求。 */
async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  deps: HandleDeps,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${request.socket.localPort ?? 0}`)
  const { state, product } = deps

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.login) {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end(renderRaccoonLoginPage(product, state.qrCode))
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.poll) {
    const polled = await pollRaccoonQrLogin(product, state.qrCode, deps.fetcher)
    if (polled.status === 'success' && polled.accessToken !== undefined) {
      const credential: RaccoonCredential = {
        access_token: polled.accessToken,
        refresh_token: polled.refreshToken ?? '',
        ...polled.expiresAt !== undefined ? { expires_at: polled.expiresAt } : {},
      }
      deps.settleOk(credential)
      writeJson(response, { status: 'success' })
      return
    }
    if (polled.expiredAt !== undefined) state.lastExpiredAt = polled.expiredAt
    // `canceled` 时换一个新 code，让页面上的二维码重新可用（否则用户卡死）。
    if (polled.status === 'canceled') {
      state.qrCode = generateQrCode()
    }
    writeJson(response, {
      status: polled.status,
      ...polled.expiredAt !== undefined ? { expiredAt: polled.expiredAt } : {},
      // code 变化时把新二维码给页面（页面据此换图）
      ...polled.status === 'canceled' ? { qr: renderQrSvg(buildQrImageUrl(product, state.qrCode)) } : {},
    })
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsSend && request.method === 'POST') {
    const body = await readJsonBody(request)
    const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
    const captchaParam = typeof body.captchaParam === 'string' ? body.captchaParam : ''
    if (!/^1[3-9]\d{9}$/.test(phone)) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入有效的 11 位手机号' }))
      return
    }
    try {
      await sendRaccoonSmsCode(product, phone, captchaParam, deps.fetcher)
      // 只在发送成功后才记住手机号：否则后续 verify 会用一个没收到验证码的号码
      state.phone = phone
      writeJson(response, { ok: true })
    } catch (error) {
      // 单步失败**不终止**流程（用户可能只是滑块过期/验证码输错），
      // 把原因回给页面让它就地提示并允许重试。
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (url.pathname === RACCOON_LOGIN_PAGE_PATHS.smsVerify && request.method === 'POST') {
    const body = await readJsonBody(request)
    const smsCode = typeof body.smsCode === 'string' ? body.smsCode.trim() : ''
    if (state.phone.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请先获取手机验证码' }))
      return
    }
    if (smsCode.length === 0) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, message: '请输入验证码' }))
      return
    }
    try {
      const credential = await loginRaccoonWithSmsCode(product, state.phone, smsCode, deps.fetcher)
      deps.settleOk(credential)
      writeJson(response, { ok: true })
    } catch (error) {
      writeJson(response, {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found')
}

/** 写一个 JSON 响应。 */
function writeJson(response: ServerResponse, payload: unknown): void {
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** 读取并解析请求体（上限 64KB，避免被塞爆）。 */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
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
        reject(new Error('raccoon: 本地登录页服务器未能获得端口'))
        return
      }
      resolve(port)
    })
  })
}

/**
 * 渲染登录页 HTML。
 *
 * 导出以便单测断言页面结构（尤其是「不含任何密钥」这条安全约束）。
 *
 * ## 页面职责
 *
 * - 两个 Tab：微信扫码（默认）与短信登录
 * - 二维码由宿主侧生成的 **SVG 内联**进来（页面不需要 QR 逻辑，也不走 CDN）
 * - 每 2 秒轮询 `/raccoon/poll`（与官方客户端一致）
 * - 短信 Tab 加载阿里云滑块脚本，拿到 `captchaParam` 后提交
 *
 * @param qrCode 当前会话的扫码 code（宿主侧生成）。**注意**：本函数只是把它
 *   渲染成二维码 —— 页面拿不到 code 本身（它被编码进二维码图像里）。
 *   这符合职责边界：页面不需要知道 code，只需要展示。
 */
export function renderRaccoonLoginPage(product: RaccoonProduct, qrCode?: string): string {
  // 未传 code 时生成一个仅供渲染的占位（单测直接调本函数时用）。
  const code = qrCode ?? generateQrCode()
  const qrSvg = renderQrSvg(buildQrImageUrl(product, code), { size: 200 })

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Raccoon Work 登录</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #f5f6f8; color: #1f2329; }
  .card { background: #fff; border-radius: 12px; padding: 20px 24px 24px; box-shadow: 0 4px 24px rgba(0,0,0,.08);
          text-align: center; width: 320px; }
  h1 { font-size: 16px; margin: 0 0 14px; font-weight: 600; }
  .tabs { display: flex; gap: 4px; background: #f2f3f5; border-radius: 8px; padding: 4px; margin-bottom: 16px; }
  .tabs button { flex: 1; padding: 7px; font-size: 13px; border: 0; border-radius: 6px;
                 background: transparent; color: #4e5969; cursor: pointer; }
  .tabs button[data-active="1"] { background: #fff; color: #1f2329; font-weight: 600;
                                  box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .pane { display: none; }
  .pane[data-show="1"] { display: block; }
  /* 二维码容器：SVG 自适应填充（SVG 自带 width/height 与 viewBox） */
  .qr { width: 200px; height: 200px; display: block; margin: 0 auto; border: 1px solid #eceef1;
        border-radius: 8px; padding: 6px; box-sizing: content-box; background: #fff; }
  .qr svg { display: block; width: 100%; height: 100%; }
  .sub { font-size: 12px; color: #8a9099; margin: 10px 0 0; }
  .status { margin-top: 12px; font-size: 13px; color: #4e5969; min-height: 20px; }
  .status[data-tone="ok"] { color: #0f9d58; font-weight: 600; }
  .status[data-tone="err"] { color: #d93026; }
  label { display: block; font-size: 12px; color: #8a9099; margin-bottom: 4px; text-align: left; }
  input { width: 100%; box-sizing: border-box; padding: 8px 10px; font-size: 14px; margin-bottom: 10px;
          border: 1px solid #d9dde3; border-radius: 6px; }
  button.primary { width: 100%; padding: 9px; font-size: 14px; border: 0; border-radius: 6px;
                   background: #8E6BF2; color: #fff; cursor: pointer; }
  button.primary:disabled { background: #c9cdd4; cursor: not-allowed; }
  .row { display: flex; gap: 8px; align-items: flex-start; }
  .row input { margin-bottom: 10px; }
  #captcha-element { margin-bottom: 10px; }
</style>
</head>
<body>
  <div class="card">
    <h1>登录 Raccoon Work</h1>

    <div class="tabs">
      <button id="tabQr" data-active="1" type="button">微信扫码</button>
      <button id="tabSms" data-active="0" type="button">短信登录</button>
    </div>

    <div class="pane" id="paneQr" data-show="1">
      <div class="qr" id="qrBox">${qrSvg}</div>
      <p class="sub">打开微信扫一扫，扫描上方二维码</p>
      <div class="status" id="qrStatus">等待扫码…</div>
    </div>

    <div class="pane" id="paneSms" data-show="0">
      <label for="phone">手机号</label>
      <div class="row">
        <input id="phone" type="tel" inputmode="numeric" maxlength="11" placeholder="请输入 11 位手机号">
        <button class="primary" id="sendCode" type="button" style="width:auto;white-space:nowrap;padding:9px 12px;">获取验证码</button>
      </div>
      <div id="captcha-element"></div>
      <label for="smsCode">验证码</label>
      <input id="smsCode" type="text" inputmode="numeric" maxlength="6" placeholder="请输入 6 位验证码">
      <button class="primary" id="doLogin" type="button">登录</button>
      <div class="status" id="smsStatus"></div>
    </div>
  </div>

<script src="https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js"></script>
<script>
(function () {
  'use strict';
  var POLL_INTERVAL_MS = 2000;
  var paths = ${JSON.stringify(RACCOON_LOGIN_PAGE_PATHS)};

  // ── Tab 切换 ──
  var tabQr = document.getElementById('tabQr');
  var tabSms = document.getElementById('tabSms');
  var paneQr = document.getElementById('paneQr');
  var paneSms = document.getElementById('paneSms');
  function selectTab(sms) {
    tabQr.setAttribute('data-active', sms ? '0' : '1');
    tabSms.setAttribute('data-active', sms ? '1' : '0');
    paneQr.setAttribute('data-show', sms ? '0' : '1');
    paneSms.setAttribute('data-show', sms ? '1' : '0');
  }
  tabQr.addEventListener('click', function () { selectTab(false); });
  tabSms.addEventListener('click', function () { selectTab(true); });

  // ── 扫码轮询 ──
  var qrStatus = document.getElementById('qrStatus');
  var qrBox = document.getElementById('qrBox');
  var pollTimer = null;
  function setQrStatus(text, tone) {
    qrStatus.textContent = text;
    if (tone) { qrStatus.setAttribute('data-tone', tone); } else { qrStatus.removeAttribute('data-tone'); }
  }
  function pollOnce() {
    fetch(paths.poll).then(function (r) { return r.json(); }).then(function (data) {
      if (data.status === 'success') {
        setQrStatus('登录成功，可以关闭此窗口了', 'ok');
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        setTimeout(function () { window.close(); }, 1200);
        return;
      }
      if (data.status === 'logging') { setQrStatus('已扫码，请在微信中确认…'); return; }
      if (data.status === 'canceled') {
        if (data.qr) { qrBox.innerHTML = data.qr; }
        setQrStatus('二维码已刷新，请重新扫码');
        return;
      }
      setQrStatus('等待扫码…');
    }).catch(function () {
      // 轮询偶发失败不打断（下一次继续）
    });
  }
  pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  pollOnce();

  // ── 短信登录 ──
  var smsStatus = document.getElementById('smsStatus');
  var phoneInput = document.getElementById('phone');
  var smsCodeInput = document.getElementById('smsCode');
  var sendBtn = document.getElementById('sendCode');
  var loginBtn = document.getElementById('doLogin');
  var captchaInstance = null;
  var pendingCaptcha = null;

  function setSmsStatus(text, tone) {
    smsStatus.textContent = text || '';
    if (tone) { smsStatus.setAttribute('data-tone', tone); } else { smsStatus.removeAttribute('data-tone'); }
  }

  function submitSmsSend(captchaParam) {
    var phone = (phoneInput.value || '').trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) {
      setSmsStatus('请输入有效的 11 位手机号', 'err');
      return;
    }
    sendBtn.disabled = true;
    setSmsStatus('发送中…');
    fetch(paths.smsSend, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone: phone, captchaParam: captchaParam || '' })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) { setSmsStatus('验证码已发送，请查收短信', 'ok'); }
      else { setSmsStatus((data && data.message) || '发送失败，请重试', 'err'); }
    }).catch(function () {
      setSmsStatus('发送失败，请检查网络后重试', 'err');
    }).finally(function () {
      sendBtn.disabled = false;
    });
  }

  // 阿里云滑块：真实加载官方脚本（SceneId / prefix 来自客户端配置）。
  function initCaptcha() {
    if (typeof window.initAliyunCaptcha !== 'function') { return false; }
    window.initAliyunCaptcha({
      SceneId: '${product.aliyunCaptcha.sceneId}',
      prefix: '${product.aliyunCaptcha.prefix}',
      mode: 'popup',
      element: '#captcha-element',
      button: '#sendCode',
      captchaVerifyCallback: function (captchaParam) {
        pendingCaptcha = captchaParam;
        submitSmsSend(captchaParam);
        return { captchaResult: true, bizResult: true };
      },
      onBizResultCallback: function () { return null; },
      getInstance: function (instance) { captchaInstance = instance; return null; },
      slideStyle: { width: 320, height: 40 },
      language: 'cn'
    });
    return true;
  }
  var captchaReady = initCaptcha();
  sendBtn.addEventListener('click', function () {
    if (!captchaReady) { captchaReady = initCaptcha(); }
    if (!captchaReady) {
      // 脚本未加载（离线/被拦截）：退化为直接提交，让服务端报明确原因
      // （实测会回 captcha_verify_error，页面据此提示用户）。
      setSmsStatus('验证码组件未加载，正在尝试直接发送…');
      submitSmsSend('');
    }
  });

  loginBtn.addEventListener('click', function () {
    var code = (smsCodeInput.value || '').trim();
    if (!code) { setSmsStatus('请输入验证码', 'err'); return; }
    loginBtn.disabled = true;
    setSmsStatus('登录中…');
    fetch(paths.smsVerify, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ smsCode: code })
    }).then(function (r) { return r.json(); }).then(function (data) {
      if (data && data.ok) {
        setSmsStatus('登录成功，可以关闭此窗口了', 'ok');
        setTimeout(function () { window.close(); }, 1200);
      } else {
        setSmsStatus((data && data.message) || '验证码不正确，请重试', 'err');
      }
    }).catch(function () {
      setSmsStatus('登录失败，请检查网络后重试', 'err');
    }).finally(function () {
      loginBtn.disabled = false;
    });
  });
})();
</script>
</body>
</html>`
}
