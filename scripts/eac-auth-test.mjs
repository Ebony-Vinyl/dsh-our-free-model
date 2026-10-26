/**
 * The EAC lane's GitHub authorization gate, offline.
 *
 * The gate is the only thing standing between a distributed plugin (whose
 * signing secret any install can extract) and the relay credential the
 * gateway holds, so its contract is pinned here end to end:
 *
 * 1. **OAuth shape** — the start redirect carries the configured client id,
 *    the exact callback URL, `read:user`, and a signed state; a tampered or
 *    expired state, a bad link code, or an unconfigured gateway is refused.
 * 2. **Star verdict** — 204 mints a per-user token, 404 keeps the user on a
 *    recheck ticket that needs no second OAuth round, and the token is
 *    collectable by repeated polls until the pending window closes: a lost
 *    poll response is retried by the plugin instead of stranding the login,
 *    and the pending entry survives a gateway restart.
 * 3. **Enforcement** — with REQUIRE_USER_TOKEN=1 a chat turn without a valid
 *    token is 401 AuthorizationRequired *before* the relay is touched, a
 *    valid one reaches the relay, listings stay open, a removed star revokes
 *    at the next recheck, and logout kills the token. With the flag off (the
 *    compatibility window) turns pass exactly as before.
 * 4. **Storage** — users.json is 0600, never contains the GitHub token or the
 *    issued token in readable form, and the plugin side attaches the token to
 *    the lane's own wire.
 *
 * GitHub is a stub and the relay is a loopback HTTP server: no network, no
 * quota, nothing real is contacted.
 *
 * Run: node scripts/eac-auth-test.mjs
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

process.env.OUR_FREE_MODEL_BASE ??= 'http://127.0.0.1:9'
const { createGatewayServer, resetAnalytics } = await import('../worker/gateway-node.mjs')
const { signSealedRequest, fetchSealedListing, lane, laneUser } = await import('../src/eac.js')
const { classifyFailure, CODE } = await import('../src/http.js')

const SIGNING = 'eac-auth-test-signing-secret-0123456789'
const STAR_REPO = 'Ebony-Vinyl/dsh-our-free-model'
const MODEL = 'deepseek-ai/deepseek-v4.1-flash'

// ── local stand-ins ──────────────────────────────────────────────────────────

/** The relay: /v1/models and a one-frame SSE chat turn. */
function startRelay() {
  const seen = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      seen.push({ url: req.url, model: (() => { try { return JSON.parse(body).model } catch { return null } })() })
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ data: [{ id: MODEL }] }))
      }
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'cmpl', model: MODEL, choices: [{ delta: { content: 'OK' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
      res.writeHead(404)
      res.end('not found')
    })
  })
  return { server, seen }
}

/** GitHub: code exchange, /user, and the starred check the state object steers. */
function makeGithubStub() {
  const state = { starred: false, ghToken: 'gho_test_token_value', fail: null, fatal: false }
  const calls = []
  const impl = async (url, init = {}) => {
    const href = String(url)
    calls.push({ url: href, method: init.method ?? 'GET' })
    if (state.fail !== null) throw new Error(state.fail)
    if (href === 'https://github.com/login/oauth/access_token') {
      return new Response(JSON.stringify({ access_token: state.ghToken, token_type: 'bearer', scope: 'read:user' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href === 'https://api.github.com/user') {
      return new Response(JSON.stringify({ id: 4242, login: 'octocat', avatar_url: 'https://avatars.example/u/4242' }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    if (href === `https://api.github.com/user/starred/${STAR_REPO}`) {
      if (state.fatal === true) return new Response('unauthorized', { status: 401 })
      return new Response(null, { status: state.starred ? 204 : 404 })
    }
    return new Response('not found', { status: 404 })
  }
  return { impl, state, calls }
}

async function startGateway(github, patch = {}, upstreamPort = relay.port) {
  // `__dir` reuses a previous instance's directory (same users.json): that is
  // how the restart-persistence contract further down is tested.
  const { __dir: reuseDir, ...rest } = patch
  const dir = reuseDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'eac-auth-'))
  const env = {
    UPSTREAM_URL: `http://127.0.0.1:${upstreamPort}/v1`,
    UPSTREAM_API_KEY: 'sk-relay-test',
    SIGNING_SECRETS: SIGNING,
    MOUNT_PREFIX: '/eac',
    GITHUB_CLIENT_ID: 'client-test-id',
    GITHUB_CLIENT_SECRET: 'client-test-secret',
    PUBLIC_ORIGIN: 'https://gateway.example',
    REQUIRE_STAR_REPO: STAR_REPO,
    USER_STORE_KEY: 'user-store-key-0123456789abcdefghijkl',
    USER_STORE_PATH: path.join(dir, 'users.json'),
    STATS_PATH: path.join(dir, 'stats.json'),
    ADMIN_TOKEN: 'admin-test',
    RATE_LIMIT_PER_MINUTE: '0',
    RATE_LIMIT_PER_DAY: '0',
    CONCURRENCY_PER_IP: '0',
    SSE_PRELUDE_SECONDS: '0',
    LOG_SALT: 'auth-test-salt',
    ...rest,
  }
  const server = createGatewayServer(env, { authFetch: github.impl })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, dir, base: `http://127.0.0.1:${server.address().port}/eac` }
}

const get = (url, headers = {}) => fetch(url, { headers, redirect: 'manual' })
const post = (url, headers = {}, body = '') => fetch(url, { method: 'POST', headers, body, redirect: 'manual' })

function signedHeaders(method, pathname, body) {
  return { 'content-type': 'application/json', accept: 'text/event-stream', ...signSealedRequest(SIGNING, { method, path: pathname, body }) }
}

const chatBody = JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'hi' }], stream: true })

// ── 0. the plugin side of the wire ───────────────────────────────────────────
{
  const captured = []
  lane.fetch = async (url, init) => { captured.push({ url, headers: init.headers }); return { ok: true, status: 200, headers: { get: () => null }, body: null, text: async () => '{"data":[]}' } }
  const credential = { mode: 'worker', base: 'https://gw.example/eac/v1', signingSecret: SIGNING }
  laneUser.token = 'user-token-abc'
  await fetchSealedListing(credential)
  const withToken = captured.at(-1).headers
  check('the lane sends x-ofm-user when this install holds one', withToken['x-ofm-user'], 'user-token-abc')
  const expected = signSealedRequest(SIGNING, { method: 'GET', path: '/eac/v1/models', body: '' }, Number(withToken['x-ofm-timestamp']))
  check('the signature still covers method/path/body only', [withToken['x-ofm-signature'], withToken['x-ofm-timestamp'] !== undefined], [expected['x-ofm-signature'], true])
  laneUser.token = null
  await fetchSealedListing(credential)
  check('and sends none before login', captured.at(-1).headers['x-ofm-user'], undefined)
  laneUser.token = undefined
  lane.fetch = null
  const classified = classifyFailure(401, { error: { message: '需要 GitHub 授权：请在插件设置页用 GitHub 登录，并 star 仓库后使用 EAC 模型', type: 'AuthorizationRequired', reason: 'missing' } })
  check('the gate refusal gets its own code, not INVALID_CREDENTIAL', [classified.code, classified.reason], [CODE.authorization, 'missing'])
}

const relayHandle = startRelay()
const relay = { server: relayHandle.server, seen: relayHandle.seen, port: 0 }
await new Promise(resolve => relay.server.listen(0, '127.0.0.1', resolve))
relay.port = relay.server.address().port

// ── 0b. the gate's GitHub transport ─────────────────────────────────────────
// The gate speaks node:https, not the global fetch: measured on the live host,
// undici cannot open the connection to GitHub at all (UND_ERR_CONNECT_TIMEOUT)
// while node:https answers in milliseconds. Pinned here against a loopback
// server so the shape (status/text/json/headers.get) cannot drift.
{
  const { nodeFetch } = await import('../worker/auth-github.mjs')
  const got = await nodeFetch(`http://127.0.0.1:${relay.port}/v1/models`)
  check('nodeFetch reports status and parses JSON', [got.ok, got.status, (await got.json()).data[0].id], [true, 200, MODEL])
  const missing = await nodeFetch(`http://127.0.0.1:${relay.port}/nope`)
  check('and reports a non-2xx without throwing', [missing.ok, missing.status], [false, 404])
  const aborted = await nodeFetch(`http://127.0.0.1:${relay.port}/v1/models`, { signal: AbortSignal.abort() }).then(() => 'resolved', error => String(error?.message ?? error))
  check('an aborted signal rejects the call', /abort/i.test(aborted), true)
}

// ── 1. the OAuth surface ─────────────────────────────────────────────────────
const github = makeGithubStub()
const primary = await startGateway(github, { REQUIRE_USER_TOKEN: '1' })
try {
  const started = await get(`${primary.base}/auth/github/start?link=${'a'.repeat(32)}`)
  const location = started.headers.get('location') ?? ''
  const authorize = new URL(location)
  check('start redirects to GitHub', [started.status, authorize.origin + authorize.pathname], [302, 'https://github.com/login/oauth/authorize'])
  check('with the configured client id and scope', [authorize.searchParams.get('client_id'), authorize.searchParams.get('scope')], ['client-test-id', 'read:user'])
  check('and the exact registered callback', authorize.searchParams.get('redirect_uri'), 'https://gateway.example/eac/auth/github/callback')
  check('and a state that is not the link itself', authorize.searchParams.get('state') !== 'a'.repeat(32) && authorize.searchParams.get('state').includes('.'), true)

  check('a bad link code is refused', (await get(`${primary.base}/auth/github/start?link=short`)).status, 400)
  check('poll before the callback is just pending', (await (await get(`${primary.base}/auth/poll?link=${'a'.repeat(32)}`)).json()).status, 'pending')
  check('a link the gate never opened is expired, not pending', (await (await get(`${primary.base}/auth/poll?link=${'f'.repeat(32)}`)).json()).status, 'expired')

  const callbackPath = `/eac/auth/github/callback?code=code-test&state=${encodeURIComponent(authorize.searchParams.get('state'))}`
  const tampered = await get(`http://127.0.0.1:${new URL(primary.base).port}/eac/auth/github/callback?code=code-test&state=${encodeURIComponent('x' + authorize.searchParams.get('state'))}`)
  check('a tampered state is refused', [tampered.status, (await tampered.text()).includes('授权已过期')], [400, true])

  // ── 2. the star verdict ────────────────────────────────────────────────────
  github.state.starred = false
  const unstarredPage = await get(`http://127.0.0.1:${new URL(primary.base).port}${callbackPath}`)
  const unstarredHtml = await unstarredPage.text()
  check('not starred: the page asks for the star, not for a re-login', [unstarredPage.status, unstarredHtml.includes('还差一步'), unstarredHtml.includes('/eac/auth/github/recheck?t=')], [200, true, true])
  const recheckUrl = new URL(/href="([^"]*recheck[^"]*)"/.exec(unstarredHtml)[1], 'https://gateway.example')
  const recheckPath = recheckUrl.pathname + recheckUrl.search
  check('poll reports the unstarred login', (await (await get(`${primary.base}/auth/poll?link=${'a'.repeat(32)}`)).json()).status, 'unstarred')

  github.state.starred = true
  const rechecked = await get(`http://127.0.0.1:${new URL(primary.base).port}${recheckPath}`)
  check('recheck after starring grants without a new OAuth round', [rechecked.status, (await rechecked.text()).includes('已确认 Star')], [200, true])

  const collected = await (await get(`${primary.base}/auth/poll?link=${'a'.repeat(32)}`)).json()
  check('poll hands the token over', [collected.status, collected.login, typeof collected.token === 'string' && collected.token.length >= 32], ['ok', 'octocat', true])
  // 收取是幂等的：一次领取的响应可能在半路死掉（源站重启/代理掐断都会变成
  // 520），客户端只能靠再轮询一次自救——一次性领取把这种抖动变成永久卡死。
  const recollected = await (await get(`${primary.base}/auth/poll?link=${'a'.repeat(32)}`)).json()
  check('and again, until the window closes', [recollected.status, recollected.token === collected.token], ['ok', true])

  const token = collected.token
  const statusWith = await (await get(`${primary.base}/auth/status`, { 'x-ofm-user': token })).json()
  check('status reports the authorization', [statusWith.authorized, statusWith.login, statusWith.required, statusWith.configured], [true, 'octocat', true, true])
  check('status without a token is honest', (await (await get(`${primary.base}/auth/status`)).json()).authorized, false)

  // ── 3. storage ─────────────────────────────────────────────────────────────
  const storeText = fs.readFileSync(path.join(primary.dir, 'users.json'), 'utf8')
  const mode = fs.statSync(path.join(primary.dir, 'users.json')).mode & 0o777
  check('users.json holds neither the github token nor the issued token', [storeText.includes(github.state.ghToken), storeText.includes(token)], [false, false])
  check('it holds the issued token hashed instead', storeText.includes(crypto.createHash('sha256').update(token).digest('hex')), true)
  // Windows has no POSIX mode bits to check — writeFileSync's mode is a no-op
  // there, and the repo's own JsonStore makes the same trade.
  check('and it is 0600 where the platform has modes', process.platform === 'win32' || mode === 0o600, true)

  // ── 3b. a completed login survives a gateway restart ───────────────────────
  // The live host restarts its gateway (deploys, panel actions, the old
  // watch-mode restart storm that caused HTTP 520 mid-login): a login between
  // callback and collect must not evaporate with the process.
  {
    const reborn = await startGateway(github, { __dir: primary.dir, REQUIRE_USER_TOKEN: '1' })
    try {
      const after = await (await get(`${reborn.base}/auth/poll?link=${'a'.repeat(32)}`)).json()
      check('the pending token is still collectable after a restart', [after.status, after.token === token, after.login], ['ok', true, 'octocat'])
      check('the user it belongs to is still authorized', (await (await get(`${reborn.base}/auth/status`, { 'x-ofm-user': token })).json()).authorized, true)
    } finally {
      reborn.server.close()
    }
  }

  // ── 4. enforcement ─────────────────────────────────────────────────────────
  const chatPath = '/eac/v1/chat/completions'
  const withoutToken = await post(`${primary.base}/v1/chat/completions`, signedHeaders('POST', chatPath, chatBody), chatBody)
  const withoutPayload = await withoutToken.json()
  check('a chat turn without a token is refused before the relay', [withoutToken.status, withoutPayload.error?.type, withoutPayload.error?.reason], [401, 'AuthorizationRequired', 'missing'])
  const unknownToken = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': 'not-a-real-token' }, chatBody)
  check('an unknown token is refused too', [unknownToken.status, (await unknownToken.json()).error?.reason], [401, 'unknown'])

  const relayCallsBefore = relay.seen.length
  const allowed = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': token }, chatBody)
  const allowedText = await allowed.text()
  check('a valid token reaches the relay and streams', [allowed.status, allowedText.includes('OK'), relay.seen.length > relayCallsBefore], [200, true, true])

  const listing = await get(`${primary.base}/v1/models`, signedHeaders('GET', '/eac/v1/models', ''))
  check('the listing stays open so the lane is visible before login', listing.status, 200)

  // ── 5. revocation paths ────────────────────────────────────────────────────
  github.state.starred = false
  await primary.server.authGate.recheckUser('4242', true)
  const afterUnstar = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': token }, chatBody)
  const afterUnstarPayload = await afterUnstar.json()
  check('a removed star ends access at the next recheck', [afterUnstar.status, afterUnstarPayload.error?.reason, /star/.test(afterUnstarPayload.error?.message ?? '')], [401, 'unstarred', true])

  github.state.starred = true
  await primary.server.authGate.recheckUser('4242', true)
  const restored = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': token }, chatBody)
  check('starring again restores it', restored.status, 200)

  const loggedOut = await (await post(`${primary.base}/auth/logout`, { 'x-ofm-user': token })).json()
  const afterLogout = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': token }, chatBody)
  check('logout revokes the token', [loggedOut.ok, afterLogout.status], [true, 401])

  // A GitHub outage (or rate limit) must never take access away from a user who
  // may well still be starred; a 401 from GitHub (the app was revoked) must.
  const again = await get(`${primary.base}/auth/github/start?link=${'b'.repeat(32)}`)
  const state2 = new URL(again.headers.get('location')).searchParams.get('state')
  await get(`http://127.0.0.1:${new URL(primary.base).port}/eac/auth/github/callback?code=c2&state=${encodeURIComponent(state2)}`)
  const token2 = (await (await get(`${primary.base}/auth/poll?link=${'b'.repeat(32)}`)).json()).token
  github.state.fail = 'network down'
  await primary.server.authGate.recheckUser('4242', true)
  const transient = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': token2 }, chatBody)
  check('github being unreachable never takes access away', transient.status, 200)
  github.state.fail = null
  github.state.fatal = true
  await primary.server.authGate.recheckUser('4242', true)
  const afterFatal = await post(`${primary.base}/v1/chat/completions`, { ...signedHeaders('POST', chatPath, chatBody), 'x-ofm-user': token2 }, chatBody)
  check('a revoked GitHub authorization ends access', [afterFatal.status, (await afterFatal.json()).error?.reason], [401, 'unstarred'])
} finally {
  primary.server.authGate.close()
  await new Promise(resolve => primary.server.close(resolve))
}

// Retained delivery survives a lost response and requires the matching token.
{
  const gh = makeGithubStub()
  gh.state.starred = true
  const retained = await startGateway(gh, { REQUIRE_USER_TOKEN: '1' })
  const authorize = async link => {
    const start = await get(`${retained.base}/auth/github/start?link=${link}`)
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    await get(`${retained.base}/auth/github/callback?code=retained&state=${encodeURIComponent(state)}`)
    return (await get(`${retained.base}/auth/poll?link=${link}&retain=1`)).json()
  }
  try {
    const link = 'r'.repeat(32), otherLink = 's'.repeat(32)
    const { createEacLoginPoller } = await import('../src/eac-login.js')
    const { directFetch } = await import('../src/eac.js')
    const preparing = createEacLoginPoller({
      credentialOf: () => ({ mode: 'worker', base: `${retained.base}/v1` }),
      readUser: () => null, writeUser: () => { throw Error('preparation must not save a user') },
      onSaved() {}, fetch: directFetch,
    })
    check('Host registers manual browser login through the actual gateway', await preparing.prepare(link), { ok: true })
    check('the registered link is pending before the system browser opens', await preparing.poll(link), { status: 'pending' })
    const first = await authorize(link)
    const retry = await (await get(`${retained.base}/auth/poll?link=${link}&retain=1`)).json()
    check('retained delivery repeats the same token after a lost response', [first.status, first.ackRequired, retry.token === first.token], ['ok', true, true])
    await get(`${retained.base}/auth/github/start?link=${link}`)
    const reopened = await (await get(`${retained.base}/auth/poll?link=${link}&retain=1`)).json()
    check('reopening a registered browser entry does not erase completed delivery', [reopened.status, reopened.token === first.token], ['ok', true])
    const restarted = await startGateway(gh, { __dir: retained.dir, REQUIRE_USER_TOKEN: '1' })
    try {
      const recovered = await (await get(`${restarted.base}/auth/poll?link=${link}&retain=1`)).json()
      check('retained delivery survives a gateway restart', [recovered.status, recovered.token === first.token, recovered.ackRequired], ['ok', true, true])
    } finally {
      restarted.server.authGate.close()
      await new Promise(resolve => restarted.server.close(resolve))
    }
    const other = await authorize(otherLink)
    check('a different valid user token cannot ACK another delivery', (await post(`${retained.base}/auth/ack?link=${link}`, { 'x-ofm-user': other.token })).status, 401)
    check('an unauthenticated ACK is refused', (await post(`${retained.base}/auth/ack?link=${link}`)).status, 401)
    check('failed ACK leaves the original delivery collectable', (await (await get(`${retained.base}/auth/poll?link=${link}&retain=1`)).json()).token === first.token, true)
    check('matching ACK succeeds', (await post(`${retained.base}/auth/ack?link=${link}`, { 'x-ofm-user': first.token })).status, 200)
    check('matching ACK is idempotent', (await post(`${retained.base}/auth/ack?link=${link}`, { 'x-ofm-user': first.token })).status, 200)
    check('ACK removes pending delivery', (await (await get(`${retained.base}/auth/poll?link=${link}&retain=1`)).json()).status, 'expired')
    const confirmedRestart = await startGateway(gh, { __dir: retained.dir, REQUIRE_USER_TOKEN: '1' })
    try {
      check('ACK removal is persisted across a gateway restart', (await (await get(`${confirmedRestart.base}/auth/poll?link=${link}&retain=1`)).json()).status, 'expired')
    } finally {
      confirmedRestart.server.authGate.close()
      await new Promise(resolve => confirmedRestart.server.close(resolve))
    }
    await post(`${retained.base}/auth/logout`, { 'x-ofm-user': other.token })
    check('a revoked token cannot be redelivered', (await (await get(`${retained.base}/auth/poll?link=${otherLink}&retain=1`)).json()).status, 'expired')
    check('a revoked token cannot ACK', (await post(`${retained.base}/auth/ack?link=${otherLink}`, { 'x-ofm-user': other.token })).status, 401)
  } finally {
    retained.server.authGate.close()
    await new Promise(resolve => retained.server.close(resolve))
  }
}

// Exercise the actual Host collector, Node transport, disk persistence and
// gateway together. GitHub is stubbed; all HTTP stays on loopback.
{
  const { createEacLoginPoller } = await import('../src/eac-login.js')
  const { directFetch } = await import('../src/eac.js')
  const { readEacUser, writeEacUser } = await import('../src/eac-user.js')
  const previousHome = process.env.DSH_HOME
  const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-host-delivery-'))
  process.env.DSH_HOME = clientHome
  const gh = makeGithubStub(); gh.state.starred = true
  const gateway = await startGateway(gh, { REQUIRE_USER_TOKEN: '1' })
  try {
    const link = 'h'.repeat(32)
    const start = await get(`${gateway.base}/auth/github/start?link=${link}`)
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    await get(`${gateway.base}/auth/github/callback?code=host-delivery&state=${encodeURIComponent(state)}`)
    let savedBeforeAck = false, ackStatus = null
    const collector = createEacLoginPoller({
      credentialOf: () => ({ mode: 'worker', base: `${gateway.base}/v1` }),
      readUser: readEacUser, writeUser: writeEacUser, onSaved() {},
      fetch: async (url, init) => {
        if (url.includes('/auth/ack?')) savedBeforeAck = readEacUser()?.token === init.headers['x-ofm-user']
        const response = await directFetch(url, init)
        if (url.includes('/auth/ack?')) ackStatus = response.status
        return response
      },
    })
    const result = await collector.poll(link)
    const saved = readEacUser()
    check('real Host collection saves before the gateway ACK', [result.status, savedBeforeAck, ackStatus], ['ok', true, 200])
    check('the actual Host response contains no user token', typeof result.token, 'undefined')
    const status = await (await get(`${gateway.base}/auth/status`, { 'x-ofm-user': saved?.token ?? '' })).json()
    check('the saved local token authorizes against the real gateway', [status.authorized, status.required], [true, true])
    check('gateway delivery is removed after Host confirmation', (await (await get(`${gateway.base}/auth/poll?link=${link}&retain=1`)).json()).status, 'expired')
    check('the Host still completes a retry of its lost local response', (await collector.poll(link)).status, 'ok')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    gateway.server.authGate.close()
    await new Promise(resolve => gateway.server.close(resolve))
    fs.rmSync(clientHome, { recursive: true, force: true })
    fs.rmSync(gateway.dir, { recursive: true, force: true })
  }
}

// Use the real gate with a controlled clock to prove retained TTL and unstar.
{
  const { createAuthGate } = await import('../worker/auth-github.mjs')
  const gh = makeGithubStub(); gh.state.starred = true
  let clock = Date.now()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-delivery-expiry-'))
  const gate = createAuthGate({ GITHUB_CLIENT_ID: 'test', GITHUB_CLIENT_SECRET: 'test', USER_STORE_KEY: SIGNING, REQUIRE_USER_TOKEN: '1', MOUNT_PREFIX: '/eac' }, { now: () => clock, fetchImpl: gh.impl, storePath: path.join(dir, 'users.json'), log() {} })
  const server = http.createServer((req, res) => gate.handle(req, res, new URL(req.url, 'http://localhost')))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/eac`
  const authorize = async link => {
    const start = await get(`${base}/auth/github/start?link=${link}`)
    const state = new URL(start.headers.get('location')).searchParams.get('state')
    await get(`${base}/auth/github/callback?code=ttl&state=${encodeURIComponent(state)}`)
  }
  try {
    const link = 't'.repeat(32)
    await authorize(link)
    clock += 14 * 60_000
    await get(`${base}/auth/github/start?link=${link}`)
    clock += 60_000 + 1
    check('retained delivery expires after 15 minutes', (await (await get(`${base}/auth/poll?link=${link}&retain=1`)).json()).status, 'expired')
    await authorize('u'.repeat(32))
    gh.state.starred = false
    await gate.recheckUser('4242', true)
    check('removed star prevents retained token redelivery', (await (await get(`${base}/auth/poll?link=${'u'.repeat(32)}&retain=1`)).json()).status, 'expired')
  } finally {
    gate.close(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true })
  }
}

// ── 6. the compatibility window ──────────────────────────────────────────────
{
  const githubWindow = makeGithubStub()
  const window = await startGateway(githubWindow, { REQUIRE_USER_TOKEN: '0' })
  try {
    const turned = await post(`${window.base}/v1/chat/completions`, signedHeaders('POST', '/eac/v1/chat/completions', chatBody), chatBody)
    check('with enforcement off a tokenless turn still passes', turned.status, 200)
    const status = await (await get(`${window.base}/auth/status`)).json()
    check('and the status says so', [status.required, status.configured], [false, true])
  } finally {
    window.server.authGate.close()
    await new Promise(resolve => window.server.close(resolve))
  }
}

// ── 7. per-account ceilings ──────────────────────────────────────────────────
{
  const githubCeiling = makeGithubStub()
  githubCeiling.state.starred = true
  const ceiling = await startGateway(githubCeiling, { REQUIRE_USER_TOKEN: '1', TOKEN_RATE_LIMIT_PER_MINUTE: '1' })
  try {
    const started = await get(`${ceiling.base}/auth/github/start?link=${'c'.repeat(32)}`)
    const state = new URL(started.headers.get('location')).searchParams.get('state')
    await get(`http://127.0.0.1:${new URL(ceiling.base).port}/eac/auth/github/callback?code=c3&state=${encodeURIComponent(state)}`)
    const token = (await (await get(`${ceiling.base}/auth/poll?link=${'c'.repeat(32)}`)).json()).token
    const first = await post(`${ceiling.base}/v1/chat/completions`, { ...signedHeaders('POST', '/eac/v1/chat/completions', chatBody), 'x-ofm-user': token }, chatBody)
    const second = await post(`${ceiling.base}/v1/chat/completions`, { ...signedHeaders('POST', '/eac/v1/chat/completions', chatBody), 'x-ofm-user': token }, chatBody)
    check('the account ceiling trips on the second turn', [first.status, second.status], [200, 429])
  } finally {
    ceiling.server.authGate.close()
    await new Promise(resolve => ceiling.server.close(resolve))
  }
}

// ── 7b. a rejected turn must not spend a concurrency slot ───────────────────
// The per-account ceiling exists so a shared token cannot multiply itself by
// moving IPs. Its rejection path runs *after* the per-IP gate has already taken
// the request's slot, so a rejection that skips the release leaks one per-IP
// slot per hit: a handful of account-429s from other machines would lock the
// victim's own IP out with zero real turns in flight. Pinned here: every
// account-ceiling refusal says so, and after the held turn drains, a fresh
// turn from the same IP passes with nothing stuck in the counters.
{
  let releaseHeld = () => {}
  const held = new Promise(resolve => { releaseHeld = resolve })
  let relaySeen = 0
  const holdRelay = http.createServer((req, res) => {
    if (req.url === '/v1/chat/completions') {
      relaySeen += 1
      void held.then(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ id: 'cmpl', model: MODEL, choices: [{ delta: { content: 'OK' } }] })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: MODEL }] }))
  })
  await new Promise(resolve => holdRelay.listen(0, '127.0.0.1', resolve))
  const holdPort = holdRelay.address().port

  const githubLeak = makeGithubStub()
  githubLeak.state.starred = true
  const leak = await startGateway(
    githubLeak,
    { REQUIRE_USER_TOKEN: '1', CONCURRENCY_PER_IP: '3', TOKEN_CONCURRENCY_PER_USER: '1' },
    holdPort)
  try {
    const started = await get(`${leak.base}/auth/github/start?link=${'e'.repeat(32)}`)
    const state = new URL(started.headers.get('location')).searchParams.get('state')
    await get(`http://127.0.0.1:${new URL(leak.base).port}/eac/auth/github/callback?code=c4&state=${encodeURIComponent(state)}`)
    const token = (await (await get(`${leak.base}/auth/poll?link=${'e'.repeat(32)}`)).json()).token
    const headers = { ...signedHeaders('POST', '/eac/v1/chat/completions', chatBody), 'x-ofm-user': token }
    const chatPath = '/eac/v1/chat/completions'

    const heldTurn = post(`${leak.base}/v1/chat/completions`, headers, chatBody)
    // The held turn must be parked inside the gateway (slot taken, upstream
    // waiting) before the rejections fire, or they would race it for the
    // account's single slot.
    while (relaySeen < 1) await new Promise(resolve => setTimeout(resolve, 20))
    for (let i = 0; i < 5; i += 1) {
      const rejected = await post(`${leak.base}/v1/chat/completions`, headers, chatBody)
      const payload = await rejected.json()
      check(`rejection ${i + 1} names the account ceiling, not a phantom IP one`,
        [rejected.status, /this account/.test(payload.error?.message ?? ''), /this IP/.test(payload.error?.message ?? '')],
        [429, true, false])
    }
    releaseHeld()
    check('the held turn finishes with its slot intact', (await heldTurn).status, 200)

    const fresh = await post(`${leak.base}/v1/chat/completions`, headers, chatBody)
    check('and a fresh turn from the same IP passes — no leaked slots', fresh.status, 200)
  } finally {
    leak.server.authGate.close()
    await new Promise(resolve => leak.server.close(resolve))
    await new Promise(resolve => holdRelay.close(resolve))
  }
}

// ── 8. an unconfigured gateway says so instead of guessing ───────────────────
{
  const githubOff = makeGithubStub()
  const off = await startGateway(githubOff, { GITHUB_CLIENT_ID: '', GITHUB_CLIENT_SECRET: '' })
  try {
    const page = await get(`${off.base}/auth/github/start?link=${'d'.repeat(32)}`)
    check('start without OAuth credentials answers 503 with a readable page', [page.status, (await page.text()).includes('未就绪')], [503, true])
  } finally {
    off.server.authGate.close()
    await new Promise(resolve => off.server.close(resolve))
  }
}

resetAnalytics()
await new Promise(resolve => relay.server.close(resolve))
console.log(failures === 0 ? '\neac-auth-test: all checks passed' : `\neac-auth-test: ${failures} check(s) FAILED`)
process.exit(failures === 0 ? 0 : 1)
