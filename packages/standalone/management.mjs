import { modelAvailability } from '../../src/model-test.js'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { buildStats } from '../../src/core/stats.js'
import { generateKey } from '../../src/forward.js'
import { structuralRejection } from '../../src/trust.js'
import { openLoginTerminal } from './login-terminal.mjs'
import { publicModelVisibility, validateModelVisibility, isModelHidden } from '../../src/store.js'
import { normalizeCombos, buildComboCatalog, comboId } from '../../src/combos.js'
import { normalizeQuota, usageToday } from '../../src/quota.js'
import { dayKey } from '../../src/store.js'

const PREFIX = '/api/management'
const BOOTSTRAP_MS = 10 * 60_000
const SESSION_MS = 8 * 60 * 60_000
const MAX_BODY_BYTES = 16 * 1024
const ASSETS = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/quota.html', ['quota.html', 'text/html; charset=utf-8']],
  ['/combos.html', ['combos.html', 'text/html; charset=utf-8']],
])
const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
}

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}

function matches(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || expected === '') return false
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

async function readBody(req, limit = MAX_BODY_BYTES) {
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw fail(415, '请求必须使用 application/json')
  }
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > limit) throw fail(413, '请求内容过大')
    chunks.push(chunk)
  }
  let value
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw fail(400, '请求不是有效 JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw fail(400, '请求必须是 JSON 对象')
  return value
}

function validateSettings(patch) {
  const visibility = validateModelVisibility(patch)
  const booleans = new Set(['enabled', 'exposeRegionModels', 'streamRecovery', 'standaloneProbe', 'standaloneLanEnabled'])
  const numbers = { probeIntervalMinutes: [1, 1440], defaultMaxTokens: [512, 131072], standaloneLanPort: [0, 65535] }
  const result = {}
  for (const [key, value] of Object.entries(patch)) {
    if (Object.hasOwn(visibility, key)) { result[key] = visibility[key]; continue }
    if (key === 'quota') { result[key] = validateQuota(value); continue }
    if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw fail(400, `${key} 必须是布尔值`)
    } else if (Object.hasOwn(numbers, key)) {
      const [min, max] = numbers[key]
      if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${key} 必须是 ${min} 到 ${max} 的整数`)
    } else throw fail(400, `不支持的设置字段：${key}`)
    result[key] = value
  }
  return result
}

/** 限额段的整体校验：结构不对整体拒绝，单个模型的上限字段逐个查。 */
function validateQuota(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw fail(400, 'quota 必须是 JSON 对象')
  }
  const out = {}
  if (Object.hasOwn(value, 'enabled')) {
    if (typeof value.enabled !== 'boolean') throw fail(400, 'quota.enabled 必须是布尔值')
    out.enabled = value.enabled
  }
  if (Object.hasOwn(value, 'onExceed')) {
    if (value.onExceed !== 'deny' && value.onExceed !== 'skip') throw fail(400, "quota.onExceed 必须是 'deny' 或 'skip'")
    out.onExceed = value.onExceed
  }
  if (Object.hasOwn(value, 'models')) {
    if (value.models === null || typeof value.models !== 'object' || Array.isArray(value.models)) {
      throw fail(400, 'quota.models 必须是对象')
    }
    const models = {}
    const entries = Object.entries(value.models)
    if (entries.length > 500) throw fail(400, 'quota.models 最多 500 个模型')
    for (const [id, limit] of entries) {
      if (typeof id !== 'string' || id.trim() === '' || id.length > 300) throw fail(400, `quota.models 的模型 id 无效：${String(id).slice(0, 40)}`)
      if (limit === null || typeof limit !== 'object' || Array.isArray(limit)) throw fail(400, `quota.models["${id}"] 必须是对象`)
      const row = {}
      for (const field of ['dailyRequests', 'dailyTokens', 'dailyCredits']) {
        if (!Object.hasOwn(limit, field)) continue
        const n = limit[field]
        if (!Number.isFinite(n) || n < 0 || n > 100_000_000) throw fail(400, `quota.models["${id}"].${field} 必须是 0 到 1 亿的数字`)
        row[field] = Math.trunc(n)
      }
      models[id] = row
    }
    out.models = models
  }
  return out
}

export function managementSettings(value) {
  return {
    ...publicModelVisibility(value),
    enabled: value.enabled !== false,
    exposeRegionModels: value.exposeRegionModels !== false,
    streamRecovery: value.streamRecovery !== false,
    standaloneProbe: value.standaloneProbe === true,
    standaloneLanEnabled: value.standaloneLanEnabled === true,
    standaloneLanPort: value.standaloneLanPort ?? 0,
    probeIntervalMinutes: value.probeIntervalMinutes ?? 15,
    defaultMaxTokens: value.defaultMaxTokens ?? 32768,
    quota: value.quota ?? { enabled: false, onExceed: 'deny', models: {} },
  }
}

/** 管理读写要求鉴权；登录恢复仅允许同源页面触发固定本机动作。 */
export function createManagement({ stores, runtime, channels, eac, info, onSettingsChanged, loginTerminal = openLoginTerminal }) {
  let bootstrap = { token: crypto.randomBytes(32).toString('base64url'), until: Date.now() + BOOTSTRAP_MS }
  const sessions = new Map()
  let cookieName
  let closed = false
  let terminalOpening = false
  let terminalOpenedAt = null
  const loginPlatform = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'unsupported'
  const assets = new Map([...ASSETS].map(([url, [file, type]]) => [
    url, { type, body: file === 'index.html'
      ? Buffer.from(fs.readFileSync(new URL(`./web/${file}`, import.meta.url), 'utf8')
        .replace('data-login-platform="unsupported"', `data-login-platform="${loginPlatform}"`))
      : fs.readFileSync(new URL(`./web/${file}`, import.meta.url)) },
  ]))
  // 只公开构建清单中经过路径校验的 JS/CSS，绝不按请求路径读取磁盘。
  const manifest = JSON.parse(fs.readFileSync(new URL('./web/assets.json', import.meta.url), 'utf8'))
  if (!Array.isArray(manifest) || manifest.some(name => typeof name !== 'string' || !/^[\w-]+\.(js|css)$/.test(name))) {
    throw new Error('独立端资源清单无效')
  }
  for (const name of manifest) assets.set(`/assets/${name}`, {
    type: name.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8',
    body: fs.readFileSync(new URL(`./web/${name}`, import.meta.url)),
  })
  // 限额页脚本是手写的静态文件，不进构建清单；同样只按固定名读一次。
  assets.set('/assets/quota.js', {
    type: 'text/javascript; charset=utf-8',
    body: fs.readFileSync(new URL('./web/quota.js', import.meta.url)),
  })
  // 路由（模型链）页脚本：同上，手写静态文件，路径固定不读请求输入。
  assets.set('/assets/combos.js', {
    type: 'text/javascript; charset=utf-8',
    body: fs.readFileSync(new URL('./web/combos.js', import.meta.url)),
  })
  // 侧栏注入：给打包产物没有的「Auto 路由 / 积分限额」补常驻入口。
  assets.set('/assets/bridge.js', {
    type: 'text/javascript; charset=utf-8',
    body: fs.readFileSync(new URL('./web/bridge.js', import.meta.url)),
  })
  const json = (res, status, payload, headers = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8', ...headers })
    res.end(JSON.stringify(payload))
  }
  const cookie = req => {
    const parts = String(req.headers.cookie ?? '').split(';')
    return parts.map(value => value.trim()).find(value => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1)
  }
  const clearCookie = () => `${cookieName}=; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=0`
  const pruneSessions = () => {
    for (const [id, until] of sessions) if (until <= Date.now()) sessions.delete(id)
  }
  const authenticated = req => {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1]
    if (matches(bearer, stores.settings.get().forwardKey)) return true
    pruneSessions()
    return sessions.has(cookie(req))
  }
  const persist = patch => {
    const previous = stores.settings.get()
    stores.settings.update(patch)
    stores.settings.flush()
    if (stores.settings.writeFailed) {
      // 不向页面谎报保存成功；保留原运行配置并由后续写入重试落盘。
      stores.settings.value = previous
      throw fail(500, '无法保存设置，请检查数据目录权限和磁盘空间')
    }
  }
  const summary = () => {
    const state = runtime.state()
    const available = stores.availability.get()
    const routable = new Set(runtime.publicModelRows().map(entry => entry.id))
    return {
      ...info(),
      channels: channels?.state(),
      eacAuth: eac?.cached(),
      settings: managementSettings(stores.settings.get()),
      catalogSyncedAt: stores.settings.get().catalogSyncedAt ?? 0,
      probedAt: available.at ?? 0,
      catalog: state.catalog.map(entry => {
        const measured = modelAvailability(entry.id, available, Boolean(entry.channel))
        return ({
        id: entry.id, name: entry.name, channel: entry.channel ?? 'anonymous',
        vision: entry.vision === true, reasoning: entry.reasoning === true || (entry.reasoning !== null && typeof entry.reasoning === 'object'),
        contextWindow: entry.contextWindow ?? entry.context_window, maxOutput: entry.maxOutput ?? entry.max_tokens,
        routable: routable.has(entry.id),
        hiddenByUser: isModelHidden(entry, state.settings),
        hiddenByGroup: isModelHidden(entry, { ...state.settings, hiddenModelIds: [] }),
        ...measured, availability: measured.availabilitySource === 'listing' ? 'listed' : measured.availability,
      }) }),
    }
  }

  async function route(req, res, pathname) {
    const method = req.method ?? 'GET'
    if (method === 'POST' && pathname === `${PREFIX}/login/terminal`) {
      // 此入口发生在登录前，必须有浏览器的同源 Origin，拒绝跨站和无来源调用。
      if (req.headers.origin !== new URL(`http://${req.headers.host}`).origin ||
          req.headers['sec-fetch-site'] !== 'same-origin') {
        throw fail(403, '请从本机登录页面点击获取令牌')
      }
      const body = await readBody(req)
      if (Object.keys(body).length !== 0) throw fail(400, '获取令牌不接受路径或命令参数')
      if (terminalOpening || (terminalOpenedAt !== null && Date.now() - terminalOpenedAt < 30_000)) {
        throw fail(429, '已请求打开终端，请检查弹出的窗口，30 秒后可重试')
      }
      terminalOpening = true
      try {
        await loginTerminal(info().dataDir)
        terminalOpenedAt = Date.now()
        json(res, 200, { ok: true })
      } finally { terminalOpening = false }
      return
    }
    if (method === 'POST' && pathname === `${PREFIX}/session`) {
      const body = await readBody(req)
      const validBootstrap = bootstrap !== null && bootstrap.until > Date.now() && matches(body.bootstrapToken, bootstrap.token)
      if (!validBootstrap && !matches(body.key, stores.settings.get().forwardKey)) throw fail(401, '登录链接已失效或 API Key 不正确')
      pruneSessions()
      if (sessions.size >= 64) throw fail(429, '管理会话过多，请稍后重试')
      if (validBootstrap) bootstrap = null
      const id = crypto.randomBytes(32).toString('base64url')
      sessions.set(id, Date.now() + SESSION_MS)
      json(res, 200, { ok: true }, {
        'set-cookie': `${cookieName}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}`,
      })
      return
    }
    if (!authenticated(req)) throw fail(401, '请先登录管理页面')
    if (method === 'POST' && pathname === `${PREFIX}/logout`) {
      await readBody(req)
      sessions.delete(cookie(req))
      json(res, 200, { ok: true }, { 'set-cookie': clearCookie() })
    } else if (method === 'GET' && pathname === `${PREFIX}/summary`) {
      json(res, 200, summary())
    } else if (method === 'GET' && pathname === `${PREFIX}/stats`) {
      json(res, 200, buildStats(stores.stats.get(), runtime.catalog))
    } else if (method === 'POST' && pathname === `${PREFIX}/channels/rpc` && channels) {
      // 渠道备份导入包含多账号凭据，仍限制总大小，但不能套设置表单的 16KB。
      const body = await readBody(req, 8 * 1024 * 1024)
      if (body.method === 'gateway.getEnabled' || body.method === 'gateway.setEnabled') {
        if (body.method === 'gateway.setEnabled') {
          if (typeof body.payload?.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值')
          persist({ enabled: body.payload.enabled })
          await onSettingsChanged()
        }
        const base = new URL(info().baseUrl)
        json(res, 200, { ok: true, value: {
          enabled: stores.settings.get().enabled !== false, running: stores.settings.get().enabled !== false,
          blockedByEnv: false, address: { host: base.hostname, port: Number(base.port) },
          apiKey: { value: stores.settings.get().forwardKey, path: `${info().dataDir}/settings.json`, fromEnv: false },
          models: runtime.publicModelRows(), modelsSource: 'catalog',
        } })
      } else {
        const controller = new AbortController()
        const abort = () => controller.abort()
        res.once('close', abort)
        try { json(res, 200, await channels.rpc(body, controller.signal)) }
        finally { res.removeListener('close', abort) }
      }
    } else if (eac && pathname.startsWith(`${PREFIX}/eac/`)) {
      const params = new URL(req.url, 'http://localhost').searchParams
      const route = pathname.slice(PREFIX.length)
      let result
      if (method === 'GET' && route === '/eac/status') result = await eac.status()
      else if (method === 'GET' && route === '/eac/login/poll') result = await eac.poll(params.get('link') ?? '')
      else if (method === 'GET' && route === '/eac/pool') result = await eac.pool()
      else if (method === 'POST') {
        await readBody(req)
        if (route === '/eac/login/start') result = await eac.start()
        else if (route === '/eac/login/cancel') result = eac.cancel(params.get('link') ?? '')
        else if (route === '/eac/logout') result = await eac.logout()
      }
      if (result === undefined) throw fail(404, 'EAC 接口不存在')
      if (result.error) throw fail(502, result.error)
      if (result.ok === false) throw fail(500, '无法移除本地授权')
      json(res, 200, result)
    } else if (method === 'GET' && pathname === `${PREFIX}/combos`) {
      // 桌面版同款契约：前端「路由」页读 combos（settings 里的链定义）+ models
      // （可挂链的候选清单）+ usable（每条链当前真实可用的成员交集）。
      const combos = normalizeCombos(stores.settings.get().combos)
      const members = runtime.catalog.filter(entry => entry.channel !== 'combo')
      const models = members.map(entry => ({
        id: entry.id, name: entry.name, channel: entry.channel ?? 'free',
        vision: entry.vision === true,
        contextWindow: entry.contextWindow ?? 0, maxOutput: entry.maxOutput ?? 0,
      }))
      const usable = buildComboCatalog(combos, runtime.catalog).map(entry => ({
        id: entry.id, models: entry.combo, lanes: entry.lanes ?? [],
      }))
      json(res, 200, { combos, models, usable })
    } else if (method === 'POST' && pathname === `${PREFIX}/combos`) {
      const body = await readBody(req)
      if (!Array.isArray(body?.combos)) throw fail(400, 'combos 必须是数组')
      if (body.combos.length > 200) throw fail(400, '最多 200 条链')
      // 先在「会是什么」的影子目录上校验：桌面版的行为是名字转 id、成员必须
      // 真实存在（否则该链条目会在清单里悄悄消失）。这里把同样的规则提前成
      // 400，用户在页面上就能看到原因，而不是保存成功后发现链不见了。
      const incoming = []
      const seenIds = new Set()
      for (const row of body.combos) {
        if (row === null || typeof row !== 'object' || Array.isArray(row)) throw fail(400, '每条链必须是对象')
        const name = typeof row.name === 'string' ? row.name.trim() : ''
        if (name === '' || name.length > 80) throw fail(400, '链名称必须是非空且不超过 80 字')
        const id = typeof row.id === 'string' && row.id.startsWith('combo:') ? row.id : comboId(name)
        if (seenIds.has(id)) throw fail(400, `链名称重复：${name}`)
        seenIds.add(id)
        if (!Array.isArray(row.models) || row.models.length === 0) throw fail(400, `链「${name}」至少要有一个成员模型`)
        if (row.models.length > 32) throw fail(400, `链「${name}」成员最多 32 个`)
        for (const member of row.models) {
          if (typeof member !== 'string' || member.trim() === '') throw fail(400, `链「${name}」包含无效的成员模型 id`)
          if (member === id) throw fail(400, `链「${name}」不能把自己作为成员`)
          if (!runtime.catalog.some(entry => entry.id === member && entry.channel !== 'combo')) {
            throw fail(400, `链「${name}」的成员不在当前清单中：${member}`)
          }
        }
        const strategy = row.strategy === 'round-robin' ? 'round-robin' : 'fallback'
        const sticky = Number(row.stickyLimit)
        const enabled = row.enabled === undefined ? true : row.enabled === true
        if (row.enabled !== undefined && typeof row.enabled !== 'boolean') throw fail(400, 'enabled 必须是布尔值')
        incoming.push({
          id, name,
          models: [...new Set(row.models.map(value => value.trim()))],
          strategy,
          stickyLimit: Number.isFinite(sticky) && sticky > 0 ? Math.min(Math.trunc(sticky), 100) : 1,
          enabled,
        })
      }
      // 桌面版契约是全量替换：前端每次都发完整列表（新增时 [...l, row]，
      // 删除时 l.filter(...)），照单全收才能让删除生效。已按 id 转换过，
      // 保存结果与前端发出的顺序一致，不做洗牌。
      persist({ combos: incoming })
      await onSettingsChanged()
      const combos = normalizeCombos(stores.settings.get().combos)
      const usable = buildComboCatalog(combos, runtime.catalog).map(entry => ({
        id: entry.id, models: entry.combo, lanes: entry.lanes ?? [],
      }))
      json(res, 200, { combos, usable })
    } else if (method === 'GET' && pathname === `${PREFIX}/combos/preview`) {
      const params = new URL(req.url, 'http://localhost').searchParams
      const ids = (params.get('models') ?? '').split(',').map(value => value.trim()).filter(value => value !== '')
      const members = ids
        .map(id => runtime.catalog.find(entry => entry.id === id && entry.channel !== 'combo'))
        .filter(entry => entry !== undefined)
      const capacity = members.length === 0 ? null : {
        contextWindow: Math.min(...members.map(entry => entry.contextWindow ?? 131072)),
        maxOutput: Math.min(...members.map(entry => entry.maxOutput ?? 32768)),
        vision: members.every(entry => entry.vision === true),
      }
      json(res, 200, { capacity })
    } else if (method === 'POST' && pathname === `${PREFIX}/quota`) {
      // 限额页专用写口：比全量 settings 端口多给「删除单模型规则」和「清空
      // 当日用量」两个动作，免得页面每次小改都重发整份 models 表。
      const body = await readBody(req)
      const current = normalizeQuota(stores.settings.get().quota)
      if (body.action === 'resetDay') {
        if (typeof body.model !== 'string' || body.model.trim() === '') throw fail(400, 'resetDay 需要模型 id')
        const modelId = body.model.trim()
        const day = dayKey()
        // JsonStore.update 是浅合并：传 { days: { [day]: … } } 会把其他天的
        // 账本整个冲掉。这里的语义是只删今天这一格，必须走 edit 读改写。
        let removed = false
        stores.stats.edit(value => {
          const row = value?.days?.[day]?.models
          if (row === undefined || !Object.hasOwn(row, modelId)) return undefined
          delete row[modelId]
          removed = true
          return value
        })
        if (removed) stores.stats.flush()
        json(res, 200, { ok: true, removed })
        return
      }
      if (body.action === 'removeModel') {
        if (typeof body.model !== 'string' || body.model.trim() === '') throw fail(400, 'removeModel 需要模型 id')
        const models = { ...current.models }
        delete models[body.model.trim()]
        persist({ quota: { ...current, models } })
      } else {
        const patch = validateQuota(body.quota ?? body)
        persist({ quota: { ...current, ...patch } })
      }
      await onSettingsChanged()
      json(res, 200, { quota: normalizeQuota(stores.settings.get().quota) })
    } else if (method === 'POST' && pathname === `${PREFIX}/settings`) {
      const patch = validateSettings(await readBody(req))
      persist(patch)
      await onSettingsChanged()
      json(res, 200, { settings: managementSettings(stores.settings.get()), lan: info().lan })
    } else if (method === 'GET' && pathname === `${PREFIX}/lan/key`) {
      json(res, 200, { key: stores.settings.get().standaloneLanKey ?? '' })
    } else if (method === 'POST' && pathname === `${PREFIX}/lan/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true || Object.keys(body).length !== 1) throw fail(400, 'LAN key rotation requires only confirm: true')
      persist({ standaloneLanKey: generateKey() })
      json(res, 200, { key: stores.settings.get().standaloneLanKey })
    } else if (method === 'GET' && pathname === `${PREFIX}/key`) {
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/key/rotate`) {
      const body = await readBody(req)
      if (body.confirm !== true) throw fail(400, '请确认轮换 API Key')
      const id = cookie(req)
      persist({ forwardKey: generateKey() })
      // 仅当前管理会话保留；旧密钥与其他会话立即失效。
      const until = sessions.get(id)
      sessions.clear()
      if (until) sessions.set(id, until)
      bootstrap = null
      json(res, 200, { key: stores.settings.get().forwardKey })
    } else if (method === 'POST' && pathname === `${PREFIX}/models/refresh`) {
      const body = await readBody(req)
      if (body.probe !== undefined && typeof body.probe !== 'boolean') throw fail(400, 'probe 必须是布尔值')
      await runtime.refreshCatalog({ probe: body.probe === true, force: body.probe === true })
      json(res, 200, summary())
    } else if (method === 'POST' && pathname === `${PREFIX}/models/test`) {
      const body = await readBody(req)
      if (stores.settings.get().enabled === false) throw fail(503, '推理服务已暂停，请先在服务设置中启用')
      if (typeof body.model !== 'string' || body.model.length > 300) throw fail(400, '请选择有效模型')
      const controller = new AbortController()
      const abort = () => controller.abort()
      res.once('close', abort)
      try {
        const result = await runtime.testModel(body.model, undefined, { signal: controller.signal })
        if (!controller.signal.aborted) json(res, 200, result)
      } catch (error) {
        if (!controller.signal.aborted) throw fail(error.status === 404 ? 404 : error.code === 'TIMEOUT' ? 504 : 502, String(error.message ?? '模型测试失败'))
      } finally {
        res.removeListener('close', abort)
      }
    } else throw fail(404, '管理接口不存在')
  }

  return {
    setPort(port) { cookieName = `ofm_management_${port}` },
    get bootstrapFragment() { return bootstrap === null ? '' : `#login=${bootstrap.token}` },
    async handleRequest(req, res) {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      const asset = assets.get(pathname)
      const isApi = pathname === PREFIX || pathname.startsWith(`${PREFIX}/`)
      if (!asset && !isApi) return false
      // 不接受插件专用 dsh-app Referer；独立管理只允许本页面的 HTTP 来源。
      const referer = req.headers.referer
      const origin = req.headers.origin
      const malformedSource = [referer, origin].some(value => value !== undefined && (
        typeof value !== 'string' || !value.startsWith('http://')
      ))
      if (closed || !cookieName) json(res, 503, { error: '服务正在停止或启动' })
      else if (malformedSource || structuralRejection(req) !== undefined) json(res, 403, { error: '管理接口仅允许本机同源访问' })
      else if (asset) {
        if (req.method !== 'GET' && req.method !== 'HEAD') json(res, 405, { error: '资源仅支持 GET 或 HEAD' })
        else {
          res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': asset.type })
          res.end(req.method === 'HEAD' ? undefined : asset.body)
        }
      } else {
        try { await route(req, res, pathname) } catch (error) {
          if (!res.destroyed && !res.headersSent) json(res, error.statusCode ?? 500, {
            error: error.statusCode ? error.message : '管理操作失败，请查看服务日志',
          })
        }
      }
      return true
    },
    dispose() { closed = true; bootstrap = null; sessions.clear() },
  }
}
