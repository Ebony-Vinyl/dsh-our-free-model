/**
 * SCNet 登录流程（本地服务器承载登录页）。
 *
 * ## 为什么用本地页而不是在主界面里放表单
 *
 * 本插件其余渠道的登录契约是**两步式**：`account.create` **立即**返回一个
 * `loginUrl`，前端 `window.open` 打开它，后台异步等待结果（`window.open` 只在
 * 用户手势窗口内有效，等流程跑完再返回必被拦截）。SCNet 需要「手机号 + 图形
 * 验证码 + 短信码」三段交互，把它做成弹窗页最贴合既有契约：
 *
 * ```text
 * 本地服务器（127.0.0.1:随机端口，路径带一次性 token）
 *   GET  /login?k=<token>      → 登录页（自包含 HTML/CSS/JS，无外部资源）
 *   GET  /captcha?k=<token>    → { image: 'data:image/jpeg;base64,…' }（同时刷新图形码）
 *   POST /send-sms?k=<token>   → { ok, registered, message }（发短信）
 *   POST /submit?k=<token>     → { ok, message }（提交短信码 → 换 Cookie → 换 Key）
 *   GET  /state?k=<token>      → { phase: 'pending'|'done'|'failed' }（页面轮询用）
 * ```
 *
 * ## 与主界面的关系
 *
 * 登录成功后本模块**自己**完成「平台会话 → 模型服务 Key」的交换，把完整
 * {@link ScnetCredential} 交给 `ScnetAuth.persistLogin` 落盘；主界面只需要
 * `login.poll` 看到账号凭据出现即可（与其余渠道完全一致）。
 *
 * ## 安全
 *
 * - 只监听 `127.0.0.1`（不对外）；
 * - 每个流程一个随机 token，所有端点都校验它 —— 本机其它程序猜到端口也无法
 *   触发发码/登录；
 * - 响应里**只出现掩码**（手机号尾号），绝不返回 Key/Cookie；
 * - 超时（默认 5 分钟）或失败后服务器自动关闭。
 *
 * @module scnet-login-page
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { ensureApiKey, resolveSession } from './scnet-platform.js'
import { createScnetWebLogin } from './scnet-web-login.js'
import { SCNET_KEY_TTL_MS, type ScnetCredential } from './scnet.js'
import { SCNET, type ScnetProduct } from './scnet-product.js'

/** 整个登录流程的超时（毫秒）。 */
export const SCNET_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** 页面路径（其余端点都在同一 token 作用域下）。 */
export const SCNET_LOGIN_PAGE_PATH = '/login'
export const SCNET_LOGIN_CAPTCHA_PATH = '/captcha'
export const SCNET_LOGIN_SEND_SMS_PATH = '/send-sms'
export const SCNET_LOGIN_SUBMIT_PATH = '/submit'
export const SCNET_LOGIN_STATE_PATH = '/state'

/** 一次成功登录的结果。 */
export interface ScnetLoginResult {
  /** 完整凭据（Cookie + Key + 账号身份）。 */
  credential: ScnetCredential
  /** 脱敏手机号（展示用）。 */
  phone?: string
  /** 本次是否「注册即登录」（新账号）。 */
  registered: boolean
}

/** `startScnetLoginFlow` 的返回值（与其余渠道的 `StartedXxxLoginFlow` 同形）。 */
export interface StartedScnetLoginFlow {
  /** 登录页地址（本地服务器）。 */
  loginUrl: string
  /** 登录结果。 */
  result: Promise<ScnetLoginResult>
  /** 主动关闭本地服务器。 */
  close: () => Promise<void>
}

/** 登录流程选项。 */
export interface ScnetLoginFlowOptions {
  product?: ScnetProduct
  fetcher?: typeof fetch
  timeoutMs?: number
}

/** 服务器内部状态。 */
interface FlowState {
  token: string
  phase: 'pending' | 'done' | 'failed'
  message: string
  phone: string
  registered: boolean
}

/** 关闭一个响应（尽力而为，失败忽略）。 */
function writeJson(response: ServerResponse, status: number, value: unknown): void {
  try {
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(JSON.stringify(value))
  } catch { /* 响应可能已发出 */ }
}

/** 读 JSON 请求体（带大小上限）。 */
async function readJsonBody(request: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('请求体不是 JSON 对象')
  return parsed as Record<string, unknown>
}

/**
 * 启动 SCNet 登录流程。
 *
 * 立即返回 `loginUrl`（本地登录页）与 `result` promise，**不阻塞** ——
 * 与其余 provider 的「两步式」约束一致。
 */
export async function startScnetLoginFlow(options: ScnetLoginFlowOptions = {}): Promise<StartedScnetLoginFlow> {
  const product = options.product ?? SCNET
  const fetcher = options.fetcher ?? fetch
  const token = randomBytes(16).toString('hex')
  const state: FlowState = { token, phase: 'pending', message: '', phone: '', registered: false }

  /**
   * 登录会话（Cookie 罐）必须是**单例**：图形码、发码、提交、ticket 全挂在同一个
   * `jsessionid` 上。风控失败（`captcha-invalid` / `too-many-attempts`）后清掉它，
   * 强制下一轮重新取图形码。
   */
  let login = createScnetWebLogin({ product, fetcher })
  /** 最近一次发码的图形码答案（提交时可空，平台不强校验）。 */
  let lastCaptchaCode = ''

  let resolveResult!: (value: ScnetLoginResult) => void
  let rejectResult!: (reason: unknown) => void
  const result = new Promise<ScnetLoginResult>((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject
  })
  // 先挂空处理器：这个 promise 可能在被消费前就 reject，那一段窗口里 Node 会报
  // unhandled rejection（与 loomy-wechat-login / lobsterai-oauth 同因）。
  result.catch(() => {})

  let settled = false
  const settleOk = (value: ScnetLoginResult): void => {
    if (settled) return
    settled = true
    state.phase = 'done'
    state.message = '登录成功，可以关闭此窗口了'
    resolveResult(value)
  }
  const settleErr = (error: unknown): void => {
    if (settled) return
    settled = true
    state.phase = 'failed'
    state.message = error instanceof Error ? error.message : String(error)
    rejectResult(error)
  }

  const server = createServer((request, response) => {
    void handleRequest(request, response).catch((error: unknown) => {
      writeJson(response, 500, { ok: false, message: error instanceof Error ? error.message : String(error) })
    })
  })

  const port = await listenOnRandomPort(server)
  const loginUrl = `http://127.0.0.1:${port}${SCNET_LOGIN_PAGE_PATH}?k=${token}`

  let closed = false
  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  const timeoutMs = options.timeoutMs ?? SCNET_LOGIN_TIMEOUT_MS
  const timer = setTimeout(() => {
    settleErr(new Error(`SCNet 登录超时（${Math.round(timeoutMs / 1000)} 秒内未完成），请重新点「添加账号」`))
  }, timeoutMs)
  timer.unref?.()

  // 结果落定即关服务器（含超时与失败路径）。
  void result.catch(() => {}).finally(() => {
    clearTimeout(timer)
    void close()
  })

  /** 完成登录：Cookie → 会话校验 → 换 Key → 组装凭据。 */
  const complete = async (cookies: { jsessionid?: string; Token?: string }): Promise<ScnetLoginResult> => {
    const session = await resolveSession({ cookies, fetcher, product })
    if (!session.ok) {
      const message = session.reason === 'expired'
        ? '平台会话已过期，请重新登录'
        : session.message ?? `会话校验失败（${session.reason}）`
      throw new Error(message)
    }
    const keyed = await ensureApiKey({
      cookies: session.cookies,
      ...(session.account.userId === undefined ? {} : { accountId: session.account.userId }),
      fetcher,
      product,
    })
    if (!keyed.ok) {
      const message = keyed.reason === 'not-activated'
        ? '平台尚未为该账号开通模型服务，自动开通也没成功。请稍后重试，或到 SCNet 控制台手动开通模型服务。'
        : keyed.reason === 'expired'
          ? '平台会话已过期，请重新登录'
          : keyed.message ?? `换取模型 Key 失败（${keyed.reason}）`
      throw new Error(message)
    }
    const now = new Date()
    const expiresAt = String(now.getTime() + SCNET_KEY_TTL_MS)
    const credential: ScnetCredential = {
      cookies: keyed.cookies,
      apiKey: keyed.apiKey,
      baseUrl: keyed.baseUrl,
      account: session.account,
      obtainedAt: now.toISOString(),
      keyedAt: now.toISOString(),
      expiresAt,
      source: 'web',
    }
    return {
      credential,
      ...(session.account.mobile === undefined ? {} : { phone: session.account.mobile }),
      registered: state.registered,
    }
  }

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    // 每个端点都校验一次性 token：本机其它程序猜到端口也无法触发发码/登录。
    if (url.searchParams.get('k') !== token) {
      writeJson(response, 403, { ok: false, message: '登录链接已失效，请回到 OFM 重新点「添加账号」' })
      return
    }
    if (url.pathname === SCNET_LOGIN_PAGE_PATH) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        // 页面自包含（内联脚本），不需要任何外部资源。
        'content-security-policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
      })
      response.end(renderLoginPage(token))
      return
    }
    if (url.pathname === SCNET_LOGIN_CAPTCHA_PATH) {
      const outcome = await login.captcha()
      if (!outcome.ok) {
        writeJson(response, 200, { ok: false, message: outcome.message ?? '图形验证码获取失败，请刷新重试' })
        return
      }
      writeJson(response, 200, { ok: true, image: outcome.image })
      return
    }
    if (url.pathname === SCNET_LOGIN_SEND_SMS_PATH && request.method === 'POST') {
      const body = await readJsonBody(request)
      const phone = typeof body.phone === 'string' ? body.phone : ''
      const captcha = typeof body.captcha === 'string' ? body.captcha : ''
      const outcome = await login.sendSmsCode(phone, captcha)
      if (outcome.ok) {
        lastCaptchaCode = captcha
        state.phone = phone.trim()
        writeJson(response, 200, { ok: true, registered: outcome.registered })
        return
      }
      if (outcome.reason === 'captcha-invalid' || outcome.reason === 'too-many-attempts') {
        // 风控状态已脏：丢弃这个罐，下一轮重新取图形码。
        login = createScnetWebLogin({ product, fetcher })
      }
      writeJson(response, 200, { ok: false, message: outcome.message ?? '发送失败', reason: outcome.reason })
      return
    }
    if (url.pathname === SCNET_LOGIN_SUBMIT_PATH && request.method === 'POST') {
      const body = await readJsonBody(request)
      const phone = typeof body.phone === 'string' ? body.phone : state.phone
      const smsCode = typeof body.smsCode === 'string' ? body.smsCode : ''
      const captcha = typeof body.captcha === 'string' && body.captcha.length > 0 ? body.captcha : lastCaptchaCode
      const outcome = await login.submit({ phone, smsCode, captcha })
      if (!outcome.ok) {
        if (outcome.reason === 'captcha-invalid' || outcome.reason === 'too-many-attempts') {
          login = createScnetWebLogin({ product, fetcher })
        }
        writeJson(response, 200, { ok: false, message: outcome.message ?? '登录失败', reason: outcome.reason })
        return
      }
      try {
        // ⚠️ 必须在 `complete()` **之前**写入：`complete()` 会读它填进结果
        //（顺序写反过：返回值里的「本次自动注册」恒为 false）。
        state.registered = outcome.via === 'register'
        const completed = await complete(outcome.cookies)
        settleOk(completed)
        writeJson(response, 200, { ok: true, message: '登录成功，可以关闭此窗口了' })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // ⚠️ 短信码是**一次性**的：提交已经成功、只是换 Key 失败时，用户无法在同一
        // 页面上重试（重发码要走新的图形验证码）。故这里必须**终结本次登录**，
        // 让 account.create 的后台 promise reject —— 占位账号会被清掉，用户
        // 重新点「添加账号」即可开一轮干净的流程。
        settleErr(new Error(message))
        writeJson(response, 200, { ok: false, message })
      }
      return
    }
    if (url.pathname === SCNET_LOGIN_STATE_PATH) {
      writeJson(response, 200, { ok: true, phase: state.phase, message: state.message })
      return
    }
    writeJson(response, 404, { ok: false, message: 'not found' })
  }

  return { loginUrl, result, close }
}

/** 在随机空闲端口上监听 127.0.0.1。 */
async function listenOnRandomPort(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw new Error('SCNet 登录服务器未能获得端口')
  }
  return address.port
}

/**
 * 渲染登录页（自包含 HTML，无外部资源）。
 *
 * ⚠️ 页面里的 JS **不使用模板字符串**：这段 HTML 本身就在 TS 模板字符串里，
 * 内层再写反引号会把外层截断。全部用单引号拼接。
 */
function renderLoginPage(token: string): string {
  return String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SCNet 登录 · Our Free Model</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    background: #0f1115; color: #e7e9ee; padding: 24px;
  }
  .card {
    width: 100%; max-width: 420px; background: #171a21; border: 1px solid #262b36;
    border-radius: 16px; padding: 28px 24px 22px; box-shadow: 0 18px 50px rgba(0,0,0,.45);
  }
  h1 { font-size: 19px; margin: 0 0 6px; letter-spacing: .3px; }
  .sub { font-size: 12.5px; color: #8b93a4; margin: 0 0 22px; line-height: 1.6; }
  label { display: block; font-size: 12.5px; color: #a8b0c0; margin: 0 0 6px; }
  input[type=text], input[type=tel] {
    width: 100%; height: 42px; padding: 0 12px; border-radius: 10px; border: 1px solid #2c3340;
    background: #11141a; color: #e7e9ee; font-size: 15px; letter-spacing: .5px; outline: none;
  }
  input:focus { border-color: #4d7cff; box-shadow: 0 0 0 3px rgba(77,124,255,.18); }
  .row { display: flex; gap: 10px; align-items: flex-start; }
  .row > * { min-width: 0; }
  .grow { flex: 1; }
  .field { margin-bottom: 16px; }
  .captcha {
    width: 108px; height: 42px; border-radius: 10px; border: 1px solid #2c3340; background: #11141a;
    cursor: pointer; object-fit: cover; flex: none;
  }
  .captcha.loading { opacity: .45; cursor: progress; }
  button {
    height: 42px; padding: 0 16px; border-radius: 10px; border: 1px solid transparent;
    background: #4d7cff; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; flex: none;
  }
  button:disabled { opacity: .55; cursor: not-allowed; }
  button.ghost { background: #1e2430; border-color: #2c3340; color: #cdd4e2; font-weight: 500; }
  .submit { width: 100%; margin-top: 4px; }
  .hint { font-size: 12.5px; line-height: 1.6; margin: 14px 0 0; min-height: 20px; color: #8b93a4; }
  .hint.err { color: #ff7b7b; }
  .hint.ok { color: #52d09a; }
  .foot { margin-top: 18px; padding-top: 14px; border-top: 1px solid #232833; font-size: 11.5px; color: #6b7385; line-height: 1.7; }
  .done { text-align: center; padding: 18px 0 6px; }
  .done .big { font-size: 34px; line-height: 1; margin-bottom: 12px; }
  .done h2 { font-size: 16px; margin: 0 0 8px; }
  .done p { font-size: 12.5px; color: #8b93a4; margin: 0; line-height: 1.7; }
</style>
</head>
<body>
<div class="card" id="card">
  <h1>SCNet 登录</h1>
  <p class="sub">超算互联网 · 手机号短信登录。没有账号也可以：平台会为你自动注册一个。</p>
  <div class="field">
    <label for="phone">手机号</label>
    <input id="phone" type="tel" inputmode="numeric" autocomplete="tel" maxlength="20" placeholder="11 位手机号">
  </div>
  <div class="field">
    <label for="captcha">图形验证码</label>
    <div class="row">
      <input id="captcha" class="grow" type="text" maxlength="8" placeholder="输入右侧字符" autocomplete="off">
      <img id="captchaImg" class="captcha" alt="点击刷新">
    </div>
  </div>
  <div class="field">
    <label for="sms">短信验证码</label>
    <div class="row">
      <input id="sms" class="grow" type="text" inputmode="numeric" maxlength="8" placeholder="6 位验证码" autocomplete="one-time-code">
      <button id="sendBtn" class="ghost" type="button">获取验证码</button>
    </div>
  </div>
  <button id="loginBtn" class="submit" type="button">登录</button>
  <p class="hint" id="hint"></p>
  <div class="foot">登录凭证只保存在本机的 OFM 插件目录，不会上传到任何第三方。窗口关闭后登录仍在后台继续。</div>
</div>
<script>
(function () {
  'use strict';
  var TOKEN = '${token}';
  var q = '?k=' + encodeURIComponent(TOKEN);
  var phone = document.getElementById('phone');
  var captcha = document.getElementById('captcha');
  var sms = document.getElementById('sms');
  var captchaImg = document.getElementById('captchaImg');
  var sendBtn = document.getElementById('sendBtn');
  var loginBtn = document.getElementById('loginBtn');
  var hint = document.getElementById('hint');

  function say(text, kind) {
    hint.textContent = text || '';
    hint.className = 'hint' + (kind ? ' ' + kind : '');
  }
  function busy(button, on, label) {
    button.disabled = on;
    if (label) button.textContent = label;
  }
  function post(path, body) {
    return fetch(path + q, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (response) { return response.json(); });
  }
  function loadCaptcha() {
    captchaImg.classList.add('loading');
    return fetch('/captcha' + q).then(function (response) { return response.json(); }).then(function (data) {
      captchaImg.classList.remove('loading');
      if (data && data.ok) { captchaImg.src = data.image; return; }
      say((data && data.message) || '图形验证码加载失败，点图片重试', 'err');
    }).catch(function () {
      captchaImg.classList.remove('loading');
      say('图形验证码加载失败，点图片重试', 'err');
    });
  }
  function finish(message) {
    document.getElementById('card').innerHTML =
      '<div class="done"><div class="big">✅</div><h2>登录成功</h2><p>' +
      (message || '这个窗口可以关闭了。回到 OFM 就能看到新账号。') +
      '</p></div>';
    setTimeout(function () { window.close(); }, 1200);
  }

  /**
   * 把输入框内容归一成 11 位纯数字。
   *
   * ⚠️ 真实反馈：用户填了 11 位仍被判「请填写 11 位手机号」。原因不在按键次数，
   * 而在输入里夹了全角数字、+86 前缀或零宽字符 —— 这些都不匹配「11 位 ASCII 数字」。
   * 这里先归一化（全角→半角、只留数字、剥掉 86 国家码），校验失败时再把
   * 「识别到几位」告诉用户，避免一句无信息量的提示让人反复试。
   *
   * 注意：这段代码位于外层模板字符串内部，注释里不能出现未转义的反引号
   * （写错一次就会提前结束模板、esbuild 直接报 Unexpected token）。
   */
  function phoneDigits() {
    var raw = String(phone.value || '');
    // 全角数字（U+FF10-U+FF19）与全角加号 → 半角
    raw = raw.replace(/[\uFF10-\uFF19]/g, function (ch) {
      return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
    });
    raw = raw.replace(/\uFF0B/g, '+');
    var digits = raw.replace(/[^\d]/g, '');
    // 粘贴 +86 / 86 前缀时剥掉国家码（11 位国内号码才是我们要的）
    if (digits.length > 11 && digits.slice(0, 2) === '86') digits = digits.slice(2);
    return digits;
  }
  /** 取并校验手机号；失败时给出「识别到几位」并返回空串。 */
  function requirePhone() {
    var value = phoneDigits();
    if (value.length !== 11 || value.charAt(0) !== '1') {
      say('请填写 11 位手机号（当前识别到 ' + value.length + ' 位数字）', 'err');
      return '';
    }
    return value;
  }

  captchaImg.addEventListener('click', loadCaptcha);
  sendBtn.addEventListener('click', function () {
    var value = requirePhone();
    if (!value) return;
    busy(sendBtn, true, '发送中…');
    say('正在发送短信…');
    post('/send-sms', { phone: value, captcha: captcha.value || '' }).then(function (data) {
      busy(sendBtn, false, '重新获取');
      if (data && data.ok) {
        say(data.registered ? '短信已发出（该手机号已注册）' : '短信已发出（该手机号未注册，登录时会自动为你注册）', 'ok');
        return;
      }
      say((data && data.message) || '发送失败', 'err');
      loadCaptcha();
      captcha.value = '';
    }).catch(function () {
      busy(sendBtn, false, '获取验证码');
      say('网络异常，请重试', 'err');
    });
  });
  loginBtn.addEventListener('click', function () {
    var value = requirePhone();
    if (!value) return;
    if (!sms.value) { say('请填写短信验证码', 'err'); return; }
    busy(loginBtn, true, '登录中…');
    say('正在登录并换取模型 Key…');
    post('/submit', { phone: value, smsCode: sms.value, captcha: captcha.value || '' }).then(function (data) {
      if (data && data.ok) { finish(data.message); return; }
      busy(loginBtn, false, '登录');
      say((data && data.message) || '登录失败', 'err');
      loadCaptcha();
      captcha.value = '';
    }).catch(function () {
      busy(loginBtn, false, '登录');
      say('网络异常，请重试', 'err');
    });
  });

  loadCaptcha();
})();
</script>
</body>
</html>`
}