/**
 * 反馈服务的离线端到端检查。
 *
 * 不碰真实 GitHub：起一个本地桩替换 GitHub 的四个端点，验证
 * 设备码 → 轮询 → 令牌 → 提交 的完整链路，以及每条拒绝路径。
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

let failures = 0
const check = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

// ── GitHub 桩 ───────────────────────────────────────────────────────────────
let pollState = 'pending'
let pollCalls = 0
const gh = http.createServer((req, res) => {
  const send = (code, payload) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)) }
  if (req.url === '/login/device/code') {
    return send(200, { device_code: 'DEVICE', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 })
  }
  if (req.url === '/login/oauth/access_token') {
    pollCalls += 1
    if (pollState === 'pending') return send(200, { error: 'authorization_pending' })
    if (pollState === 'denied') return send(200, { error: 'access_denied' })
    if (pollState === 'slow') return send(200, { error: 'slow_down' })
    return send(200, { access_token: 'gh-token', token_type: 'bearer', scope: 'read:user' })
  }
  if (req.url === '/user') return send(200, { id: 4242, login: 'octocat', avatar_url: 'https://x/a.png' })
  send(404, {})
})

const ghPort = await new Promise(resolve => gh.listen(0, '127.0.0.1', () => resolve(gh.address().port)))

// ── 反馈服务（把 GitHub 端点指到桩上）──────────────────────────────────────
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-feedback-'))
const serverSource = fs.readFileSync(new URL('../server/feedback/server.mjs', import.meta.url), 'utf8')
  .replace("'https://github.com/login/device/code'", `'http://127.0.0.1:${ghPort}/login/device/code'`)
  .replace("'https://github.com/login/oauth/access_token'", `'http://127.0.0.1:${ghPort}/login/oauth/access_token'`)
  .replace("'https://api.github.com/user'", `'http://127.0.0.1:${ghPort}/user'`)
const serverFile = path.join(dataDir, 'server.mjs')
fs.writeFileSync(serverFile, serverSource)

const port = 4500 + Math.floor(Math.random() * 400)
const child = (await import('node:child_process')).spawn(process.execPath, [serverFile], {
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', FEEDBACK_DATA_DIR: dataDir, GITHUB_CLIENT_ID: 'test-client' },
  stdio: 'ignore',
})
const base = `http://127.0.0.1:${port}`

async function waitReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await fetch(`${base}/api/health`); if (response.ok) return } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('feedback server did not start')
}

const post = async (route, body, headers = {}) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}

try {
  await waitReady()

  await check('健康检查报告已配置', async () => {
    const response = await fetch(`${base}/api/health`)
    assert.deepEqual(await response.json(), { ok: true, configured: true })
  })

  let session
  await check('发起登录返回用户码与验证地址', async () => {
    const result = await post('/api/auth/start')
    assert.equal(result.status, 200)
    assert.equal(result.body.userCode, 'ABCD-1234')
    assert.equal(result.body.verifyUrl, 'https://github.com/login/device')
    session = result.body.session
    assert.equal(typeof session, 'string')
  })

  await check('授权未完成时返回 pending', async () => {
    pollState = 'pending'
    const result = await post('/api/auth/poll', { session })
    assert.equal(result.body.status, 'pending')
  })

  await check('未知会话返回 expired', async () => {
    const result = await post('/api/auth/poll', { session: 'nope' })
    assert.equal(result.body.status, 'expired')
  })

  await check('用户拒绝时返回 denied', async () => {
    const fresh = (await post('/api/auth/start')).body.session
    pollState = 'denied'
    const result = await post('/api/auth/poll', { session: fresh })
    assert.equal(result.body.status, 'denied')
    assert.equal(result.body.error, 'access_denied')
  })

  await check('slow_down 仍按 pending 处理', async () => {
    const fresh = (await post('/api/auth/start')).body.session
    pollState = 'slow'
    const result = await post('/api/auth/poll', { session: fresh })
    assert.equal(result.body.status, 'pending')
  })

  let token
  await check('授权完成后发放令牌并带出 login', async () => {
    const fresh = (await post('/api/auth/start')).body.session
    pollState = 'granted'
    const result = await post('/api/auth/poll', { session: fresh })
    assert.equal(result.body.status, 'ok')
    assert.equal(result.body.login, 'octocat')
    assert.equal(typeof result.body.token, 'string')
    token = result.body.token
  })

  await check('重复轮询同一会话已失效（一次性）', async () => {
    const fresh = (await post('/api/auth/start')).body.session
    pollState = 'granted'
    await post('/api/auth/poll', { session: fresh })
    const again = await post('/api/auth/poll', { session: fresh })
    assert.equal(again.body.status, 'expired')
  })

  await check('无令牌提交被拒绝', async () => {
    const result = await post('/api/feedback', { kind: 'bug', title: 't', detail: 'd' })
    assert.equal(result.status, 401)
  })

  await check('伪造令牌提交被拒绝', async () => {
    const result = await post('/api/feedback', { kind: 'bug', title: 't', detail: 'd' }, { authorization: 'Bearer forged' })
    assert.equal(result.status, 401)
  })

  await check('未知类型被拒绝', async () => {
    const result = await post('/api/feedback', { kind: 'other', title: 't', detail: 'd' }, { authorization: `Bearer ${token}` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error, 'kind')
  })

  await check('空标题被拒绝', async () => {
    const result = await post('/api/feedback', { kind: 'bug', title: '   ', detail: 'd' }, { authorization: `Bearer ${token}` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error, 'title')
  })

  await check('超长描述被拒绝', async () => {
    const result = await post('/api/feedback', { kind: 'bug', title: 't', detail: 'x'.repeat(8001) }, { authorization: `Bearer ${token}` })
    assert.equal(result.status, 400)
    assert.equal(result.body.error, 'detail')
  })

  let submitted
  await check('合法提交落盘并返回单号', async () => {
    const result = await post('/api/feedback', {
      kind: 'wish', title: '希望支持自定义主题', detail: '想换配色。',
      version: '2.8.2', platform: 'Win32', page: 'feedback',
    }, { authorization: `Bearer ${token}` })
    assert.equal(result.status, 200)
    assert.equal(typeof result.body.id, 'string')
    submitted = result.body.id
  })

  await check('落盘内容包含身份、类型与正文，且不含令牌', async () => {
    const day = new Date().toISOString().slice(0, 10)
    const dir = path.join(dataDir, day)
    const file = fs.readdirSync(dir).find(name => name.includes(submitted))
    assert.ok(file, 'feedback file missing')
    const raw = fs.readFileSync(path.join(dir, file), 'utf8')
    const record = JSON.parse(raw)
    assert.equal(record.kind, 'wish')
    assert.equal(record.title, '希望支持自定义主题')
    assert.equal(record.github.login, 'octocat')
    assert.equal(record.github.id, '4242')
    assert.equal(record.version, '2.8.2')
    assert.ok(!raw.includes(token), 'access token must never be stored with the feedback')
    assert.ok(!raw.includes('gh-token'), 'github token must never be stored with the feedback')
  })

  await check('未知路由返回 404', async () => {
    const response = await fetch(`${base}/api/nope`)
    assert.equal(response.status, 404)
  })

  await check('未配置客户端时登录明确报错', async () => {
    const bare = path.join(dataDir, 'bare.mjs')
    fs.writeFileSync(bare, serverSource)
    const barePort = port + 500
    const proc = (await import('node:child_process')).spawn(process.execPath, [bare], {
      env: { ...process.env, PORT: String(barePort), HOST: '127.0.0.1', FEEDBACK_DATA_DIR: dataDir, GITHUB_CLIENT_ID: '' },
      stdio: 'ignore',
    })
    try {
      for (let attempt = 0; attempt < 60; attempt++) {
        try { if ((await fetch(`http://127.0.0.1:${barePort}/api/health`)).ok) break } catch { /* wait */ }
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const response = await fetch(`http://127.0.0.1:${barePort}/api/auth/start`, { method: 'POST' })
      assert.equal(response.status, 503)
      assert.equal((await response.json()).error, 'unconfigured')
    } finally { proc.kill() }
  })
} finally {
  child.kill()
  gh.close()
  fs.rmSync(dataDir, { recursive: true, force: true })
}

console.log(failures === 0 ? 'feedback server: all checks passed' : `feedback server: ${failures} failure(s)`)
process.exitCode = failures === 0 ? 0 : 1
