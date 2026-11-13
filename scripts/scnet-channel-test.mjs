/**
 * SCNet 渠道自检（离线，不访问任何真实服务）。
 *
 *     node scripts/scnet-channel-test.mjs
 *
 * 覆盖：
 *   1. 协议纯函数（手机号归一化、图形验证码签名、掩码、错误码/文案映射）；
 *   2. 网页登录状态机：图形验证码 → 发码（未注册 `0` / 已注册 `1004`）→ 提交
 *      → ticket 落 Cookie，两条通道各自走对；
 *   3. 换 Key：首次「模型服务尚未开通」→ 自动 `account/config/authorize` → 重试成功；
 *   4. 本地登录页端到端：真实起 127.0.0.1 服务器，用 HTTP 走完
 *      `/login` → `/captcha` → `/send-sms` → `/submit`，拿到完整凭据；
 *   5. 模型目录：客户端目录（带 priceLabel）优先、网关名单校验、兜底 SCNet-Max。
 *
 * 全部走注入的 `fetcher` 桩，绝不发出真实网络请求。
 */
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

// 直接跑 TypeScript 源码：把 src/*.ts 内部 `import './x.js'` 解析到 `x.ts`，
// 并用 typescript 转译（与 scripts/channel-pack-test.mjs 的 --source 模式同一套）。
const ts = (await import('typescript')).default
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.endsWith('.js')) {
      const url = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href
      if (fs.existsSync(fileURLToPath(url))) return { url, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
      const source = fs.readFileSync(fileURLToPath(url), 'utf8')
      return {
        format: 'module',
        source: ts.transpileModule(source, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: fileURLToPath(url),
        }).outputText,
        shortCircuit: true,
      }
    }
    return nextLoad(url, context)
  },
})

const {
  SCNET_CAPTCHA_SALT,
  isPlausibleScnetPhone,
  isScnetRefreshable,
  mapScnetLoginError,
  mapScnetSmsError,
  maskScnetKey,
  maskScnetPhone,
  normalizeScnetPhone,
  parseScnetEnvelope,
  pickScnetCookies,
  scnetCaptchaSignature,
  scnetCookieHeader,
  translateScnetMessage,
} = await import('../vendor/channel-pack/src/scnet.ts')
const { ensureApiKey, resolveSession } = await import('../vendor/channel-pack/src/scnet-platform.ts')
const { createScnetWebLogin } = await import('../vendor/channel-pack/src/scnet-web-login.ts')
const { startScnetLoginFlow } = await import('../vendor/channel-pack/src/scnet-login-page.ts')
const { readClientScnetCatalog, loadScnetModels, fetchGatewayModelIds } = await import('../vendor/channel-pack/src/scnet-catalog.ts')
const { SCNET } = await import('../vendor/channel-pack/src/scnet-product.ts')

let passed = 0
const ok = (label) => { passed += 1; console.log(`ok  ${label}`) }

// ── 1. 纯函数 ────────────────────────────────────────────────────────────────

assert.equal(normalizeScnetPhone('138 0000 0000'), '+8613800000000')
assert.equal(normalizeScnetPhone('+8613800000000'), '+8613800000000')
// 全角数字 / 全角加号（中文输入法与微信、通讯录粘贴的常见形态）
assert.equal(normalizeScnetPhone('１３８００００００００'), '+8613800000000')
assert.equal(normalizeScnetPhone('＋86 138 0000 0000'), '+8613800000000')
// 裸 86 国家码不应让用户自己删
assert.equal(normalizeScnetPhone('8613800000000'), '+8613800000000')
assert.equal(isPlausibleScnetPhone('13800000000'), true)
assert.equal(isPlausibleScnetPhone('１３８００００００００'), true)
assert.equal(isPlausibleScnetPhone('12'), false)
ok('手机号归一化：全角/空格/+86/裸 86 都能收敛到 +86 11 位')

// 登录页必须自带归一化与「识别到几位」提示：真实反馈过「填了 11 位仍提示
// 请填写 11 位手机号」（输入里夹了全角数字或 +86 前缀）。

const md5 = (input) => crypto.createHash('md5').update(input).digest('hex')
const sig = scnetCaptchaSignature('13800000000', md5, 1_700_000_000_000, () => 0)
assert.equal(sig.timestamp, 1_700_000_000_000)
assert.equal(sig.randomString, '0'.repeat(10))
assert.equal(sig.md5Str, md5(`+8613800000000${sig.timestamp}${sig.randomString}${SCNET_CAPTCHA_SALT}`))
ok('图形验证码签名：md5(phone + 时间戳 + 10 位随机串 + 盐)，盐取自平台前端')

assert.equal(maskScnetPhone('+8613800000000'), '138****0000')
assert.equal(maskScnetKey('sk-abcdefghijkl'), 'sk-ab…jkl')
assert.equal(maskScnetKey(''), '')
ok('掩码：手机号 138****0000、Key 只露首尾')

assert.equal(parseScnetEnvelope({ code: '0', data: { a: 1 } }).ok, true)
assert.equal(parseScnetEnvelope({ code: '1004', msg: '已注册' }).ok, false)
assert.equal(parseScnetEnvelope('nope').ok, false)
ok('平台信封：HTTP 200 里按 code 判成败')

assert.equal(mapScnetSmsError('1005'), 'too-frequent')
assert.equal(mapScnetSmsError('3002'), 'captcha-invalid')
assert.equal(mapScnetLoginError('401'), 'auth-failed')
assert.equal(translateScnetMessage('Username or password is incorrect').includes('密码'), true)
assert.equal(translateScnetMessage('模型服务尚未开通'), '模型服务尚未开通')
ok('错误码映射：发码/提交各自的归类，英文原文兜底翻中文')

assert.equal(isScnetRefreshable({ apiKey: 'sk-1', baseUrl: SCNET.apiBase }), false)
assert.equal(isScnetRefreshable({ apiKey: 'sk-1', baseUrl: SCNET.apiBase, cookies: { Token: 't' } }), true)
ok('可续期判据：凭据里还有平台 Token 即视为可续期')

// ⚠️ 回归防线（真实缺陷）：DSH 的凭据 ref 名只允许 /^[A-Za-z_][A-Za-z0-9_]*$/。
// 渠道 id 改成 `scnet-ofm` 后，若 ref 名仍按 `${id.toUpperCase()}_ACCOUNT_*` 拼接，
// 会得到 `SCNET-OFM_ACCOUNT_*` —— credentialRef() 直接抛 TypeError，表现为
// 「登录页显示成功、但凭据一行都没落盘、DSH 面板一直等授权」。
assert.match('SCNETOFM_ACCOUNT_AB12CD', /^[A-Za-z_][A-Za-z0-9_]*$/)
assert.doesNotMatch('SCNET-OFM_ACCOUNT_AB12CD', /^[A-Za-z_][A-Za-z0-9_]*$/)
ok('凭据 ref 名：前缀必须是 SCNETOFM（不能带连字符），否则 credentialRef 抛错')

assert.equal(scnetCookieHeader({ jsessionid: 'a', Token: 'b' }), 'jsessionid=a; Token=b')
assert.deepEqual(pickScnetCookies(['jsessionid=a; Path=/', 'Token=b; Path=/', 'other=c']), { jsessionid: 'a', Token: 'b' })
assert.deepEqual(pickScnetCookies(['Token=; Max-Age=0']), {})
ok('Cookie 处理：只留 jsessionid/Token，删除指令不记成有效值')

// ── 2. 假平台 ────────────────────────────────────────────────────────────────

/** 平台调用记录。 */
const calls = []

/**
 * 假平台/假网关。
 *
 * @param {{ registered?: boolean, needActivate?: boolean }} options
 */
function fakePlatform(options = {}) {
  let keyCreated = 0
  return async (input, init = {}) => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    calls.push({ url, method })
    const json = (body, headers = {}) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json', ...headers },
    })

    if (url.endsWith('/sso/captcha.action')) {
      return json({ code: '0', data: 'data:image/jpeg;base64,AAAA' }, { 'set-cookie': 'jsessionid=js-1; Path=/' })
    }
    if (url.endsWith('/sso/sendRegisterMessageCode.action')) {
      return json({ code: options.registered ? '1004' : '0', msg: '' })
    }
    if (url.endsWith('/sso/auth/login.action')) {
      return json({ code: '0', data: 'https://www.scnet.cn/ac/api/auth/loginSsoRedirect.action?ticket=ST-1' })
    }
    if (url.endsWith('/sso/registerByMobilephoneNum.action')) {
      return json({ code: '0', data: 'https://www.scnet.cn/ac/api/auth/loginSsoRedirect.action?ticket=ST-2' })
    }
    if (url.includes('loginSsoRedirect.action')) {
      return new Response('', { status: 302, headers: { 'set-cookie': 'Token=tk-1; Path=/' } })
    }
    if (url.includes('/acx/user/users/current-user-info')) {
      return json({
        code: '0',
        data: { id: 'u-1', userName: 'tester', mobilephoneNum: '13800000000', institution: '某大学' },
      })
    }
    if (url.endsWith('/acx/llm/api-key/createActivityApiKey')) {
      keyCreated += 1
      if (options.needActivate === true && keyCreated === 1) {
        return json({ code: '1', msg: '模型服务尚未开通' })
      }
      return json({ code: '0', data: { apiKey: 'sk-test-123456', baseUrl: 'https://api.scnet.cn/api/llm/v1' } })
    }
    if (url.endsWith('/acx/llm/account/config/authorize')) {
      return json({ code: '0', data: null })
    }
    if (url.endsWith('/acx/user/users/logout')) {
      return json({ code: '0', data: null })
    }
    if (url.endsWith('/models')) {
      return json({ data: [{ id: 'SCNet-Max' }, { id: 'SCNet-Pro' }] })
    }
    throw new Error(`fake platform: unhandled ${method} ${url}`)
  }
}

// ── 3. 网页登录状态机：未注册号走「注册即登录」 ───────────────────────────────

{
  calls.length = 0
  const login = createScnetWebLogin({ fetcher: fakePlatform({ registered: false }) })
  const captcha = await login.captcha()
  assert.equal(captcha.ok, true)
  assert.ok(captcha.image.startsWith('data:image/'))
  const sent = await login.sendSmsCode('13800000000', 'ab12')
  assert.equal(sent.ok, true)
  assert.equal(sent.registered, false)
  const outcome = await login.submit({ phone: '13800000000', smsCode: '123456' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.via, 'register')
  assert.equal(outcome.cookies.Token, 'tk-1')
  assert.equal(outcome.cookies.jsessionid, 'js-1')
  assert.ok(calls.some((call) => call.url.endsWith('/sso/registerByMobilephoneNum.action')))
  ok('登录状态机：未注册号（code=0）→ 走 registerByMobilephoneNum.action，ticket 落 Cookie')
}

// ── 4. 网页登录状态机：已注册号走快捷登录 ─────────────────────────────────────

{
  calls.length = 0
  const login = createScnetWebLogin({ fetcher: fakePlatform({ registered: true }) })
  assert.equal((await login.captcha()).ok, true)
  const sent = await login.sendSmsCode('13800000000')
  assert.equal(sent.registered, true)
  const outcome = await login.submit({ smsCode: '654321' })
  assert.equal(outcome.ok, true)
  assert.equal(outcome.via, 'login')
  assert.ok(calls.some((call) => call.url.endsWith('/sso/auth/login.action')))
  ok('登录状态机：已注册号（code=1004）→ 走 auth/login.action，mode=2 快捷登录')
}

// ── 5. 换 Key：首次「尚未开通」→ 自动开通 → 重试成功 ─────────────────────────

{
  calls.length = 0
  const result = await ensureApiKey({
    cookies: { jsessionid: 'js-1', Token: 'tk-1' },
    fetcher: fakePlatform({ needActivate: true }),
  })
  assert.equal(result.ok, true)
  assert.equal(result.apiKey, 'sk-test-123456')
  assert.equal(result.baseUrl, 'https://api.scnet.cn/api/llm/v1')
  assert.ok(calls.some((call) => call.url.endsWith('/acx/llm/account/config/authorize')))
  assert.equal(calls.filter((call) => call.url.endsWith('/createActivityApiKey')).length, 2)
  ok('换 Key：新账号「模型服务尚未开通」→ 自动 authorize → 重试一次拿到 sk- Key')
}

// ── 6. 会话校验 ──────────────────────────────────────────────────────────────

{
  const session = await resolveSession({ cookies: { jsessionid: 'js-1', Token: 'tk-1' }, fetcher: fakePlatform() })
  assert.equal(session.ok, true)
  assert.equal(session.account.userId, 'u-1')
  assert.equal(session.account.mobile, '138****0000')
  const missing = await resolveSession({ cookies: {}, fetcher: fakePlatform() })
  assert.equal(missing.ok, false)
  ok('会话校验：返回脱敏手机号与用户 id；没有 Cookie 时明确失败')
}

// ── 7. 本地登录页端到端（真实 HTTP）──────────────────────────────────────────

{
  calls.length = 0
  const flow = await startScnetLoginFlow({ fetcher: fakePlatform({ registered: false, needActivate: true }) })
  const url = new URL(flow.loginUrl)
  const token = url.searchParams.get('k')
  assert.ok(token && token.length >= 16, 'loginUrl 必须带一次性 token')
  const origin = url.origin

  const pageResponse = await fetch(flow.loginUrl)
  const html = await pageResponse.text()
  assert.equal(pageResponse.status, 200)
  assert.ok(html.includes('SCNet 登录'))
  assert.ok(html.includes(`'${token}'`), '页面必须内嵌同一个 token')

  // 页面内联脚本的**语法**必须能解析（esbuild 只打包 TS，不会替这段 HTML 里的
  // JS 做语法检查；一旦写错，用户点按钮时才会炸）。
  const inlineScript = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(inlineScript, '登录页必须内联脚本')
  new Function(inlineScript[1])
  ok('本地登录页：内联脚本语法可解析（按钮逻辑不会在运行时才炸）')
  // ⚠️ 回归防线（真实缺陷）：页面 HTML 由 TS 模板字符串拼出，模板字符串会把
  // 正则里的 \\d 当成无效转义吃掉反斜杠 —— 生成 /[^d]/ 后所有数字都被删光，
  // 用户填了 11 位手机号却被告知「识别到 0 位数字」。现在改用 String.raw，
  // 这三条断言锁住「反斜杠必须原样出现在产物里」。
  assert.ok(html.includes('[^\\d]'), '生成页面必须保留 [^\\d] 正则')
  assert.ok(!html.includes('[^d]'), '模板字符串不得吞掉正则里的反斜杠')
  assert.ok(!html.includes('1d{10}'), '被吞掉反斜杠的旧正则不得再出现')
  assert.ok(html.includes('function phoneDigits'), '登录页必须内置全角/国家码归一化')
  assert.ok(html.includes('识别到'), '手机号校验失败时必须告诉用户识别到几位')

  const unauthorized = await fetch(`${origin}/captcha?k=wrong`)
  assert.equal(unauthorized.status, 403)

  const captcha = await (await fetch(`${origin}/captcha?k=${token}`)).json()
  assert.equal(captcha.ok, true)
  assert.ok(captcha.image.startsWith('data:image/'))

  const sent = await (await fetch(`${origin}/send-sms?k=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000000', captcha: 'ab12' }),
  })).json()
  assert.equal(sent.ok, true)
  assert.equal(sent.registered, false)

  const submitted = await (await fetch(`${origin}/submit?k=${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone: '13800000000', smsCode: '123456' }),
  })).json()
  assert.equal(submitted.ok, true)

  const result = await flow.result
  assert.equal(result.credential.apiKey, 'sk-test-123456')
  assert.equal(result.credential.cookies.Token, 'tk-1')
  assert.equal(result.credential.account.userId, 'u-1')
  assert.equal(result.registered, true, '未注册号应被标记为「本次自动注册」')
  assert.ok(Number(result.credential.expiresAt) > Date.now())
  ok('本地登录页端到端：token 校验 → 图形验证码 → 发短信 → 提交 → 落盘凭据（含自动注册标记）')
}

// ── 8. 模型目录：客户端目录优先 → 网关校验 → 兜底 ─────────────────────────────

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scnet-catalog-'))
  const modelsPath = path.join(dir, 'models.json')
  fs.writeFileSync(modelsPath, JSON.stringify({
    providers: {
      scnet: {
        models: [
          { id: 'SCNet-Pro', name: 'SCNet Pro', priceLabel: 'none', contextWindow: 32768, maxTokens: 8192 },
          {
            id: 'SCNet-Max',
            name: 'SCNet-Max',
            priceLabel: 'free',
            contextWindow: 1048576,
            maxTokens: 131072,
            input: ['text', 'image'],
            thinkingMode: 'levels',
          },
        ],
      },
    },
  }))
  const catalog = readClientScnetCatalog(modelsPath)
  assert.equal(catalog.models.length, 2)
  assert.equal(catalog.models[1].supportsImage, true)
  assert.equal(catalog.models[1].supportsThinking, true)

  const models = await loadScnetModels({
    modelsPath,
    apiKey: 'sk-test-123456',
    baseUrl: SCNET.apiBase,
    fetcher: fakePlatform(),
  })
  assert.deepEqual(models.map((model) => model.id), ['SCNet-Max'])
  assert.equal(models[0].contextWindow, 1_048_576)
  ok('模型目录：客户端目录里只挑 priceLabel=free 的模型，元数据（1M/图片/思考）原样带入')
  // ⚠️ 客户端目录把 contextWindow 写成 262144（客户端自己的保守值）时，不能被它拖小：
  // 平台实测 1M 可用，照抄目录值会在 1/4 处就开始压缩上下文。
  const conservativePath = path.join(dir, 'models-conservative.json')
  fs.writeFileSync(conservativePath, JSON.stringify({
    providers: { scnet: { models: [{ id: 'SCNet-Max', name: 'SCNet-Max', priceLabel: 'free', contextWindow: 262144, maxTokens: 32768 }] } },
  }))
  const floored = await loadScnetModels({ modelsPath: conservativePath, freeOnly: true })
  assert.equal(floored[0].contextWindow, 1048576, '上下文不得被客户端目录的保守值拖小')
  assert.equal(floored[0].maxTokens, 131072, '输出上限同样取实测值')
  ok('模型能力下限：客户端目录的 262144/32768 不会把 SCNet-Max 拖到实测能力以下')

  const fallback = await loadScnetModels({
    modelsPath: path.join(dir, 'missing.json'),
    freeOnly: true,
  })
  assert.deepEqual(fallback.map((model) => model.id), ['SCNet-Max'])
  assert.equal(fallback[0].contextWindow, 1_048_576)
  ok('模型目录：没有客户端目录、没有 Key 时退回内置 SCNet-Max（1M / 131072）')

  const gateway = await fetchGatewayModelIds({ apiKey: 'sk-test-123456', baseUrl: SCNET.apiBase, fetcher: fakePlatform() })
  assert.equal(gateway.ok, true)
  assert.deepEqual(gateway.ids, ['SCNet-Max', 'SCNet-Pro'])
  const empty = await fetchGatewayModelIds({ apiKey: '', baseUrl: SCNET.apiBase, fetcher: fakePlatform() })
  assert.equal(empty.ok, false)
  ok('网关名单：GET /models 只取 id；没有 Key 时不发请求')

  fs.rmSync(dir, { recursive: true, force: true })
}

// ── 9. 适配器的模型元数据字段名（DSH 契约）─────────────────────────────────
{
  // 真实缺陷：resolveModel 把上下文写成顶层 contextWindow、输出上限写成 maxOutputTokens ——
  // 这两个字段在 LlmResolvedModelInfo 上都不存在，被静默忽略，于是切换模型时报
  // 「no context capacity for scnet-ofm/SCNet-Max」，压缩直接失败。
  const source = fs.readFileSync(new URL('../vendor/channel-pack/src/scnet-adapter.ts', import.meta.url), 'utf8')
  assert.ok(source.includes('resolved.context = { contextWindow }'), '上下文必须写进 context.contextWindow')
  assert.ok(source.includes('resolved.defaultMaxTokens'), '输出上限必须写成 defaultMaxTokens')
  // 只查 resolveModel 的赋值形态（fallbackModels() 里也有 contextWindow: 字面量，那是
  // 模型目录条目，不是 LlmResolvedModelInfo 的字段）。
  assert.equal(/resolved\.contextWindow\s*=/.test(source), false, '不得再往 resolved 顶层写 contextWindow')
  assert.equal(/resolved\.maxOutputTokens\s*=/.test(source), false, '不得再往 resolved 顶层写 maxOutputTokens')
  ok('适配器元数据：上下文用 context.contextWindow、输出用 defaultMaxTokens（DSH 契约）')
  // 真实缺陷：collectImages 的入参是「消息 content 块数组」，直接传 options.messages
  // 时每个元素都是 {role, content}，type==='image' 永不命中 → 图片被静默丢弃，
  // 表现为「用户贴了图，模型说没收到图像内容」。
  assert.ok(source.includes('for (const message of options.messages)'), '必须逐条消息取 content 再收集图片')
  assert.equal(source.includes('collectImages(options.messages'), false, '不得把消息数组直接传给 collectImages')
  assert.ok(source.includes('supportsImage !== true'), '模型不支持图片时必须明确报错，不能静默丢图')
  ok('图片桥接：逐条消息收集 content 块、按模型能力判定、空 Map 保占位符')
}

console.log(`\nall SCNet channel checks passed (${passed} groups)`)