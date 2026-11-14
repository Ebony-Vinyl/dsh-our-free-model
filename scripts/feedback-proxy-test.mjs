/**
 * 反馈代理（packages/standalone/feedback.mjs）的离线检查。
 *
 * 用一个本地 HTTP 桩替换反馈服务器，验证：地址校验、令牌不出进程、
 * 提交前必须登录、字段上限，以及 401 后的状态一致性。
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import { createFeedback } from '../packages/standalone/feedback.mjs'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── 反馈服务器桩 ────────────────────────────────────────────────────────────
const received = []
let pollReply = { status: 'pending' }
let startReply = null
const stub = http.createServer((req, res) => {
  const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = raw ? JSON.parse(raw) : {}
    // 线上形态：反向代理把 /feedback/* 剥成 /* 再转给反馈服务（Caddy handle_path）。
    // 桩必须照做，否则"客户端有没有带前缀"这件事在测试里永远看不出来。
    const route = req.url.startsWith('/feedback/') ? req.url.slice('/feedback'.length) : req.url
    received.push({ route: req.url, forwarded: route, headers: req.headers, body })
    if (route === '/api/auth/start') {
      if (startReply) return send(startReply.status, startReply.body)
      return send(200, { session: 'sess-1', userCode: 'WXYZ-9876', verifyUrl: 'https://github.com/login/device', expiresIn: 900 })
    }
    if (route === '/api/auth/poll') return send(200, pollReply)
    if (route === '/api/feedback') {
      if (!/^Bearer /.test(String(req.headers.authorization ?? ''))) return send(401, { error: 'unauthorized' })
      return send(200, { id: 'fb-1' })
    }
    send(404, { error: 'not-found' })
  })
})
const port = await new Promise(resolve => stub.listen(0, '127.0.0.1', () => resolve(stub.address().port)))

// 本机 http 是允许的（回环调试），所以这些用例不需要 https。
let settings = { feedbackUrl: `http://127.0.0.1:${port}`, feedbackAuth: null }
const persist = patch => { settings = { ...settings, ...patch } }
const feedback = createFeedback({ settings: () => settings, persist })

try {
  await check('未登录时状态为未登录', () => {
    assert.deepEqual(feedback.status(), { signedIn: false, login: '' })
  })

  await check('未登录提交被拒绝', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: 'd' }), /请先用 GitHub 登录/)
  })

  await check('发起登录返回用户码', async () => {
    const value = await feedback.start()
    assert.equal(value.userCode, 'WXYZ-9876')
    assert.equal(value.session, 'sess-1')
  })

  await check('轮询 pending 不落盘令牌', async () => {
    pollReply = { status: 'pending' }
    assert.deepEqual(await feedback.poll({ session: 'sess-1' }), { status: 'pending' })
    assert.equal(settings.feedbackAuth, null)
  })

  await check('轮询成功后令牌落盘且状态可读', async () => {
    pollReply = { status: 'ok', token: 'local-token', login: 'octocat' }
    const value = await feedback.poll({ session: 'sess-1' })
    assert.deepEqual(value, { status: 'ok', login: 'octocat' })
    assert.equal(settings.feedbackAuth.token, 'local-token')
    assert.equal(feedback.status().signedIn, true)
    assert.equal(feedback.status().login, 'octocat')
  })

  await check('status 不暴露令牌', () => {
    const value = feedback.status()
    assert.ok(!JSON.stringify(value).includes('local-token'))
  })

  await check('expired 与 denied 原样返回', async () => {
    pollReply = { status: 'expired' }
    assert.deepEqual(await feedback.poll({ session: 'x' }), { status: 'expired' })
    pollReply = { status: 'denied', error: 'access_denied' }
    assert.deepEqual(await feedback.poll({ session: 'x' }), { status: 'denied', error: 'access_denied' })
  })

  await check('提交时把令牌放在 Authorization 头里', async () => {
    received.length = 0
    const value = await feedback.submit({ kind: 'bug', title: '标题', detail: '正文', version: '2.8.2', platform: 'Win32', page: 'feedback' })
    assert.equal(value.id, 'fb-1')
    const call = received.find(row => row.route === '/api/feedback')
    assert.equal(call.headers.authorization, 'Bearer local-token')
    assert.equal(call.body.kind, 'bug')
    assert.equal(call.body.title, '标题')
  })

  await check('类型必须是 bug 或 wish', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'other', title: 't', detail: 'd' }), /反馈类型/)
  })

  await check('空标题被拒绝', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: '  ', detail: 'd' }), /标题/)
  })

  await check('空描述被拒绝', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: ' ' }), /描述/)
  })

  await check('标题超长被拒绝', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 'x'.repeat(121), detail: 'd' }), /120/)
  })

  await check('描述超长被拒绝', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: 'x'.repeat(8001) }), /8000/)
  })

  await check('退出清除本机令牌', () => {
    assert.deepEqual(feedback.signOut(), { signedIn: false, login: '' })
    assert.equal(settings.feedbackAuth, null)
  })

  await check('拒绝带凭据的服务器地址', async () => {
    const previous = settings.feedbackUrl
    settings = { ...settings, feedbackUrl: 'https://user:pass@example.com' }
    await assert.rejects(() => feedback.start(), /凭据/)
    settings = { ...settings, feedbackUrl: previous }
  })

  await check('拒绝非 https 的非本机地址', async () => {
    const previous = settings.feedbackUrl
    settings = { ...settings, feedbackUrl: 'http://example.com' }
    await assert.rejects(() => feedback.start(), /https/)
    settings = { ...settings, feedbackUrl: previous }
  })

  await check('服务端错误码被透出但不回显正文', async () => {
    startReply = { status: 502, body: { error: 'device_flow_disabled', secret: 'must-not-leak' } }
    try {
      await assert.rejects(() => feedback.start(), error => {
        assert.match(error.message, /device_flow_disabled/)
        assert.ok(!error.message.includes('must-not-leak'), 'response body must not leak into the message')
        return true
      })
    } finally { startReply = null }
  })

  // 线上反馈服务挂在反向代理的 /feedback/* 下（Caddy handle_path 去前缀），
  // 所以客户端必须把这一段路径带上。早期实现 return parsed.origin，把默认地址
  // 里的 /feedback 丢掉，于是请求打到面板根路径的 /api/* 全部 404 —— 而上面
  // 那些用例都用裸 origin 做 feedbackUrl，永远碰不到这条路径。
  await check('保留基址里的路径前缀（/feedback/* 反代形态）', async () => {
    const previous = settings.feedbackUrl
    received.length = 0
    settings = { ...settings, feedbackUrl: `http://127.0.0.1:${port}/feedback` }
    try {
      await feedback.start()
      const call = received.find(row => row.route !== undefined)
      assert.equal(call.route, '/feedback/api/auth/start', `expected the /feedback prefix to survive, got ${call.route}`)
    } finally { settings = { ...settings, feedbackUrl: previous } }
  })

  await check('默认基址同样保留 /feedback 前缀', async () => {
    const previous = settings.feedbackUrl
    received.length = 0
    settings = { ...settings, feedbackUrl: '' }
    try {
      // 默认地址是 https 的远端，这里只验证拼出来的 URL，不真的联网：
      // 用假 fetch 记录请求地址即可。
      const seen = []
      const realFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        seen.push(String(url))
        throw new Error('offline')
      }
      try { await feedback.start() } catch { /* 预期：假 fetch 直接失败 */ }
      finally { globalThis.fetch = realFetch }
      assert.ok(seen.length === 1, `expected one attempt, got ${seen.length}`)
      assert.match(seen[0], /\/feedback\/api\/auth\/start$/, `default base lost its /feedback prefix: ${seen[0]}`)
    } finally { settings = { ...settings, feedbackUrl: previous } }
  })
} finally {
  stub.close()
}

console.log(failures === 0 ? 'feedback proxy: all checks passed' : `feedback proxy: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
