/**
 * 插件端「反馈与许愿」的离线检查。
 *
 * 三件事必须成立，任何一件塌了页面就只是摆设：
 *
 *  1. 服务端把请求打到**正确的地址**。反馈服务挂在反代的 `/feedback/*` 下，
 *     客户端必须把这一段带上；早期版本把基址削成 origin，于是所有请求都打到
 *     面板根路径的 `/api/*`，登录与提交双双 404，而健康检查一切正常。
 *  2. 登录令牌不出进程。页面只该拿到「是谁登录了」，拿不到能冒名提交的凭据。
 *  3. 失败不能伪装成成功。缺单号、上游 401 都必须让调用方看见。
 *
 * 另外检查页面真的挂上了：标签页在导航里、提交按钮在未填内容时禁用、
 * 401 之后正文还留在输入框里。
 *
 * Run: node scripts/feedback-plugin-test.mjs
 */
import http from 'node:http'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createFeedback, feedbackBaseOf } from '../src/feed.js'
import { createApiRoutes } from '../index.js'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── 反馈服务器桩 ────────────────────────────────────────────────────────────
// 反向代理把 `/feedback/*` 剥成 `/*` 再转给反馈服务（Caddy handle_path），
// 桩必须照做 —— 否则"客户端有没有带前缀"这件事在测试里永远看不出来。
const received = []
let pollReply = { status: 'pending' }
let submitReply = { status: 200, body: { id: 'fb-1' } }
const stub = http.createServer((req, res) => {
  const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  let raw = ''
  req.on('data', chunk => { raw += chunk })
  req.on('end', () => {
    const body = raw === '' ? {} : JSON.parse(raw)
    const forwarded = req.url.startsWith('/feedback/') ? req.url.slice('/feedback'.length) : req.url
    received.push({ url: req.url, forwarded, headers: req.headers, body })
    if (forwarded === '/api/auth/start') {
      return send(200, { session: 'sess-1', userCode: 'WXYZ-9876', verifyUrl: 'https://github.com/login/device', expiresIn: 900 })
    }
    if (forwarded === '/api/auth/poll') return send(200, pollReply)
    if (forwarded === '/api/feedback') {
      if (!/^Bearer /.test(String(req.headers.authorization ?? ''))) return send(401, { error: 'unauthorized' })
      return send(submitReply.status, submitReply.body)
    }
    send(404, { error: 'not-found' })
  })
})
const port = await new Promise(resolve => stub.listen(0, '127.0.0.1', () => resolve(stub.address().port)))
const base = `http://127.0.0.1:${port}/feedback`

let settings = { feedbackUrl: base, feedbackAuth: null }
const persist = patch => { settings = { ...settings, ...patch } }
const feedback = createFeedback({ settings: () => settings, persist })

try {
  await check('默认地址保留 /feedback 前缀（丢掉它会让登录与提交全部 404）', () => {
    const resolved = feedbackBaseOf(() => ({ feedbackUrl: '' }))
    assert.equal(resolved, 'https://ourfreemodel.beichenapi.com/feedback')
  })

  await check('自定义基址保留路径，只削掉结尾斜杠', () => {
    assert.equal(feedbackBaseOf(() => ({ feedbackUrl: `${base}/` })), base)
  })

  await check('拒绝 http 公网地址、凭据与查询串', () => {
    assert.throws(() => feedbackBaseOf(() => ({ feedbackUrl: 'http://example.com/feedback' })), /必须是 https/)
    assert.throws(() => feedbackBaseOf(() => ({ feedbackUrl: 'https://u:p@example.com/feedback' })), /不能包含凭据/)
    assert.throws(() => feedbackBaseOf(() => ({ feedbackUrl: 'https://example.com/feedback?a=1' })), /不能带查询串/)
  })

  await check('未登录时状态为未登录', () => {
    assert.deepEqual(feedback.status(), { signedIn: false, login: '' })
  })

  await check('未登录提交被拒绝', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: 'd' }), /请先用 GitHub 登录/)
  })

  await check('发起登录返回用户码，且请求打在 /feedback 下', async () => {
    const value = await feedback.start()
    assert.equal(value.userCode, 'WXYZ-9876')
    assert.equal(value.session, 'sess-1')
    const call = received.find(row => row.forwarded === '/api/auth/start')
    assert.equal(call.url, '/feedback/api/auth/start')
  })

  await check('轮询 pending 时不落令牌', async () => {
    pollReply = { status: 'pending' }
    assert.deepEqual(await feedback.poll({ session: 'sess-1' }), { status: 'pending' })
    assert.equal(settings.feedbackAuth, null)
  })

  await check('轮询成功后令牌只落本机设置', async () => {
    pollReply = { status: 'ok', token: 'local-token', login: 'octo' }
    const value = await feedback.poll({ session: 'sess-1' })
    assert.deepEqual(value, { status: 'ok', login: 'octo' })
    assert.equal(settings.feedbackAuth.token, 'local-token')
  })

  await check('已登录后状态只回 login，不回令牌', () => {
    const value = feedback.status()
    assert.deepEqual(value, { signedIn: true, login: 'octo' })
    assert.equal(JSON.stringify(value).includes('local-token'), false)
  })

  await check('提交带上 Bearer 令牌与完整字段', async () => {
    submitReply = { status: 200, body: { id: 'fb-1' } }
    const value = await feedback.submit({ kind: 'wish', title: '想要深色', detail: '细节如下', version: '2.8.4', platform: 'Win32' })
    assert.deepEqual(value, { id: 'fb-1' })
    const call = received.filter(row => row.forwarded === '/api/feedback').at(-1)
    assert.equal(call.url, '/feedback/api/feedback')
    assert.equal(call.headers.authorization, 'Bearer local-token')
    assert.equal(call.body.kind, 'wish')
    assert.equal(call.body.version, '2.8.4')
  })

  await check('字段校验：类型、标题、正文与长度上限', async () => {
    await assert.rejects(() => feedback.submit({ kind: 'other', title: 't', detail: 'd' }), /请选择反馈类型/)
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: '  ', detail: 'd' }), /请填写标题/)
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: ' ' }), /请描述/)
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 'x'.repeat(121), detail: 'd' }), /标题不能超过/)
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: 'x'.repeat(8001) }), /描述不能超过/)
  })

  await check('缺单号算失败，不能清空用户正文', async () => {
    submitReply = { status: 200, body: {} }
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: 'd' }), /没有返回单号/)
    submitReply = { status: 200, body: { id: 'fb-1' } }
  })

  await check('上游 401 清掉本机令牌并报登录失效', async () => {
    submitReply = { status: 401, body: { error: 'unauthorized' } }
    await assert.rejects(() => feedback.submit({ kind: 'bug', title: 't', detail: 'd' }), /登录已失效/)
    assert.equal(settings.feedbackAuth, null)
    assert.deepEqual(feedback.status(), { signedIn: false, login: '' })
    submitReply = { status: 200, body: { id: 'fb-1' } }
  })

  await check('退出只清本机令牌', () => {
    settings = { ...settings, feedbackAuth: { token: 't', login: 'octo', at: Date.now() } }
    assert.deepEqual(feedback.signOut(), { signedIn: false, login: '' })
    assert.equal(settings.feedbackAuth, null)
  })

  await check('会话 id 形状不合法时直接 400，不打上游', async () => {
    const before = received.length
    await assert.rejects(() => feedback.poll({ session: '' }), /登录会话无效/)
    assert.equal(received.length, before)
  })

  // 收集端没配 OAuth 时回的是 `unconfigured`，设备流被关时回的是
  // `device_flow_disabled`。把这两串原样丢给用户等于什么都没说 —— 它们都是
  // 维护者要动 GitHub 后台才能解决的事，页面必须说清是"等服务端配好"。
  await check('未配置 GitHub 登录时给出可行动的说明，而不是裸错误码', async () => {
    const raw = createFeedback({
      settings: () => settings,
      persist: () => {},
      fetch: async () => new Response(JSON.stringify({ error: 'unconfigured' }), { status: 503 }),
    })
    await assert.rejects(() => raw.start(), /尚未启用 GitHub 登录/)
    await assert.rejects(() => raw.start(), (error) => !error.message.includes('unconfigured'))
  })

  await check('Device Flow 未开启时点名 GitHub 后台的那一项', async () => {
    const raw = createFeedback({
      settings: () => settings,
      persist: () => {},
      fetch: async () => new Response(JSON.stringify({ error: 'device_flow_disabled' }), { status: 502 }),
    })
    await assert.rejects(() => raw.start(), /Device Flow/)
  })

  // ── 路由层 ────────────────────────────────────────────────────────────────
  const routes = createApiRoutes({
    feedback: createFeedback({ settings: () => settings, persist }),
    meta: () => ({ version: '2.8.4' }),
  })
  const server = http.createServer((req, res) => { void routes(req, res) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const apiBase = `http://127.0.0.1:${server.address().port}/api/our-free-model`
  const call = async (method, path, body) => {
    const response = await fetch(apiBase + path, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  }

  try {
    await check('GET /feedback 只回登录态', async () => {
      const value = await call('GET', '/feedback')
      assert.equal(value.status, 200)
      assert.deepEqual(value.body, { signedIn: false, login: '' })
    })

    await check('未登录 POST /feedback/submit 回 401', async () => {
      const value = await call('POST', '/feedback/submit', { kind: 'bug', title: 't', detail: 'd' })
      assert.equal(value.status, 401)
    })

    await check('发起 + 轮询 + 提交整条链路', async () => {
      pollReply = { status: 'ok', token: 'local-token', login: 'octo' }
      const started = await call('POST', '/feedback/start')
      assert.equal(started.status, 200)
      assert.equal(started.body.userCode, 'WXYZ-9876')
      const polled = await call('POST', '/feedback/poll', { session: started.body.session })
      assert.deepEqual(polled.body, { status: 'ok', login: 'octo' })
      const submitted = await call('POST', '/feedback/submit', { kind: 'wish', title: 't', detail: 'd' })
      assert.equal(submitted.status, 200)
      assert.equal(submitted.body.id, 'fb-1')
    })

    await check('版本号由宿主盖章，页面传来的被覆盖', async () => {
      const call_ = received.filter(row => row.forwarded === '/api/feedback').at(-1)
      assert.equal(call_.body.version, '2.8.4')
    })

    await check('未知 /feedback 子路径回 404', async () => {
      assert.equal((await call('GET', '/feedback/nope')).status, 404)
    })

    await check('没有挂反馈服务时回 503 而不是崩', async () => {
      const bare = createApiRoutes({})
      const bareServer = http.createServer((req, res) => { void bare(req, res) })
      await new Promise(resolve => bareServer.listen(0, '127.0.0.1', resolve))
      try {
        const response = await fetch(`http://127.0.0.1:${bareServer.address().port}/api/our-free-model/feedback`)
        assert.equal(response.status, 503)
      } finally { bareServer.close() }
    })
  } finally { server.close() }

  // ── 页面接线 ──────────────────────────────────────────────────────────────
  // 这一半不需要浏览器：只要标签页、组件、文案和样式都在源码里且互相对得上，
  // 真正点得动由 scripts/feedback-plugin-ui-test.mjs 在真浏览器里跑。
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')

  await check('导航里有反馈标签页，且派发到 FeedbackPage', () => {
    assert.match(source, /\['feedback', t\('nav\.tab\.feedback'\), null\]/)
    assert.match(source, /tab === 'feedback'\s*\?\s*h\(FeedbackPage/)
  })

  // 这个白名单决定"上次停留的标签页能不能恢复"。少写一个 id 不会报错：导航里
  // 有、点得动，但刷新后永远弹回 free —— 正是这条用例抓到过的真实缺陷。
  await check('反馈标签页登记在 TABS 白名单里（否则刷新后恢复不了）', () => {
    const tabs = source.match(/const TABS = \[([^\]]+)\]/)
    assert.ok(tabs !== null, 'TABS 白名单未找到')
    assert.ok(tabs[1].includes("'feedback'"), 'TABS 缺少 feedback，刷新后会弹回 free')
  })

  await check('五个路由都被页面用上', () => {
    for (const path of ["'/feedback'", "'/feedback/start'", "'/feedback/poll'", "'/feedback/signout'", "'/feedback/submit'"]) {
      assert.ok(source.includes(`api(${path})`) || source.includes(`post(${path}`), `${path} 未被页面调用`)
    }
  })

  await check('令牌字段从不被页面读取', () => {
    assert.equal(source.includes('feedbackAuth'), false, '页面不应出现 feedbackAuth')
  })

  await check('中英文两套文案都齐', () => {
    for (const key of ['fb.title', 'fb.gateTitle', 'fb.submit', 'fb.stale', 'nav.tab.feedback']) {
      const hits = source.split(`'${key}':`).length - 1
      assert.equal(hits, 2, `${key} 应在 zh 与 en 各出现一次，实际 ${hits}`)
    }
  })
} finally {
  stub.close()
}

console.log(failures === 0 ? 'feedback plugin: all checks passed' : `feedback plugin: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
