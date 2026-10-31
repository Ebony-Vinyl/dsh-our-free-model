/**
 * Private subscription sidecar. Only resolve() returns secrets, for server-side
 * routing; never serialize that result into a management response.
 *
 * Protocol facts checked against MIT references magpie (internal/provider) and
 * cc-switch (src-tauri/src/services/subscription.rs). No AGPL code is used.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { restrictPermissions as privatePermissions } from './open-external.js'

const PROVIDERS = ['codex', 'claude', 'gemini', 'api']
const FORMATS = ['openai-chat', 'openai-responses', 'anthropic-messages']
const NATIVE = {
  codex: ['.codex', 'auth.json'],
  claude: ['.claude', '.credentials.json'],
  gemini: ['.gemini', 'oauth_creds.json'],
}
const ENDPOINTS = {
  codexQuota: 'https://chatgpt.com/backend-api/wham/usage',
  codexToken: 'https://auth.openai.com/oauth/token',
  codexResponses: 'https://chatgpt.com/backend-api/codex/responses',
  claudeQuota: 'https://api.anthropic.com/api/oauth/usage',
  claudeMessages: 'https://api.anthropic.com/v1/messages',
  geminiLoad: 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
  geminiQuota: 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota',
  geminiGenerate: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse',
  geminiToken: 'https://oauth2.googleapis.com/token',
}
const GEMINI_CLIENT_ID = '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com'
// Installed-app client identifier, published by Gemini CLI, not a user secret.
const GEMINI_CLIENT_SECRET = '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'
const MAX_BYTES = 4 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const numeric = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const nonnegative = value => numeric(value) !== null && value >= 0 ? value : null
const percent = value => numeric(value) !== null && value >= 0 && value <= 100 ? value : null
const clone = value => structuredClone(value)

function fail(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function text(value, name, { optional = false, max = 32768 } = {}) {
  if (optional && value === undefined) return undefined
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) {
    throw fail('INVALID_INPUT', `Invalid ${name}`)
  }
  return value.trim()
}

function url(value, allowSearch = false) {
  let parsed
  try { parsed = new URL(value) } catch { throw fail('INVALID_INPUT', 'Invalid subscription endpoint') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash
    || (!allowSearch && parsed.search)) {
    throw fail('INVALID_INPUT', 'Invalid subscription endpoint')
  }
  return parsed.href
}

function models(value = []) {
  if (!Array.isArray(value) || value.length > 200) throw fail('INVALID_INPUT', 'Invalid models')
  return [...new Set(value.map(item => {
    const name = text(item, 'model', { max: 240 })
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(name) || name.startsWith('subscription:')) {
      throw fail('INVALID_INPUT', 'Invalid model')
    }
    return name
  }))]
}

function expiry(value) {
  if (value === undefined) return null
  if (nonnegative(value) === null || value > 8.64e15) throw fail('INVALID_INPUT', 'Invalid credential expiry')
  return value
}

function jwt(token) {
  try {
    const parsed = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'))
    return object(parsed) ? parsed : {}
  } catch { return {} }
}

function normalize(input) {
  if (!object(input) || !PROVIDERS.includes(input.provider) || !object(input.credentials)) {
    throw fail('INVALID_INPUT', 'Invalid subscription credentials')
  }
  const { provider, credentials: raw } = input
  if (provider !== 'api' && (input.baseUrl !== undefined || input.format !== undefined)) {
    throw fail('INVALID_INPUT', 'Official subscriptions use fixed provider endpoints')
  }
  const normalized = {
    provider, label: text(input.label, 'label', { optional: true, max: 120 }) ?? provider,
    models: models(input.models),
  }
  if (provider === 'api') {
    const key = raw.apiKey ?? raw.api_key ?? raw.key
    normalized.credentials = { apiKey: text(key, 'API key') }
    normalized.baseUrl = url(text(input.baseUrl, 'base URL', { max: 2048 })).replace(/\/$/, '')
    if (input.format !== undefined && !FORMATS.includes(input.format)) throw fail('INVALID_INPUT', 'Invalid API format')
    normalized.format = input.format ?? 'openai-chat'
  } else if (provider === 'codex') {
    if (!object(raw.tokens)) throw fail('INVALID_INPUT', 'Expected Codex auth.json tokens')
    const accessToken = text(raw.tokens.access_token, 'Codex access token')
    const claims = jwt(accessToken)
    const identity = jwt(raw.tokens.id_token ?? '')['https://api.openai.com/auth']
    const accessIdentity = claims['https://api.openai.com/auth']
    normalized.credentials = {
      accessToken,
      refreshToken: text(raw.tokens.refresh_token, 'refresh token', { optional: true }) ?? null,
      idToken: text(raw.tokens.id_token, 'ID token', { optional: true }) ?? null,
      accountId: text(raw.tokens.account_id ?? identity?.chatgpt_account_id ?? accessIdentity?.chatgpt_account_id,
        'Codex account ID', { optional: true, max: 256 }) ?? null,
      expiresAt: nonnegative(claims.exp) !== null ? expiry(claims.exp * 1000) : null,
    }
  } else if (provider === 'claude') {
    if (!object(raw.claudeAiOauth)) throw fail('INVALID_INPUT', 'Expected Claude .credentials.json claudeAiOauth')
    const oauth = raw.claudeAiOauth
    normalized.credentials = {
      accessToken: text(oauth.accessToken, 'Claude access token'),
      refreshToken: text(oauth.refreshToken, 'refresh token', { optional: true }) ?? null,
      expiresAt: expiry(oauth.expiresAt),
      plan: text(oauth.subscriptionType, 'subscription type', { optional: true, max: 120 }) ?? null,
    }
  } else {
    normalized.credentials = {
      accessToken: text(raw.access_token, 'Gemini access token', { optional: true }) ?? null,
      refreshToken: text(raw.refresh_token, 'refresh token', { optional: true }) ?? null,
      expiresAt: expiry(raw.expiry_date),
      project: text(raw.project, 'Gemini project', { optional: true, max: 256 }) ?? null,
    }
    if (!normalized.credentials.accessToken && !normalized.credentials.refreshToken) {
      throw fail('INVALID_INPUT', 'Expected Gemini oauth_creds.json tokens')
    }
  }
  return normalized
}

function blankQuota() {
  return { status: 'unknown', checkedAt: null, plan: null, balance: null, fiveHour: null, weekly: null, windows: [], error: null }
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(value)) return null
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

function secondsDate(value) {
  return nonnegative(value) !== null && value * 1000 <= 8.64e15 ? new Date(value * 1000).toISOString() : null
}

function windowRow(id, kind, seconds, usedPercent, resetsAt, extra = {}) {
  return {
    id, name: id, kind, windowSeconds: seconds, usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    resetsAt, ...extra,
  }
}

function parseQuota(provider, body, now, plan = null) {
  const quota = { ...blankQuota(), checkedAt: new Date(now).toISOString(), plan }
  if (!object(body)) throw fail('INVALID_RESPONSE', 'Invalid provider quota response', 502)
  if (provider === 'codex') {
    quota.plan = typeof body.plan_type === 'string' ? body.plan_type : null
    for (const slot of ['primary_window', 'secondary_window']) {
      const item = body.rate_limit?.[slot]
      if (!object(item)) continue
      const seconds = nonnegative(item.limit_window_seconds)
      const kind = seconds === 18000 ? 'five_hour' : seconds === 604800 ? 'weekly' : 'other'
      const reset = secondsDate(item.reset_at)
        ?? (nonnegative(item.reset_after_seconds) === null ? null : secondsDate(now / 1000 + item.reset_after_seconds))
      quota.windows.push(windowRow(kind === 'other' ? slot : kind, kind, seconds, percent(item.used_percent), reset))
    }
    if (object(body.credits)) {
      const balance = body.credits.balance
      const amount = typeof balance === 'number' ? nonnegative(balance)
        : typeof balance === 'string' && /^\d+(\.\d+)?$/.test(balance.trim()) ? nonnegative(Number(balance)) : null
      quota.balance = {
        amount, unit: 'credits',
        unlimited: typeof body.credits.unlimited === 'boolean' ? body.credits.unlimited : null,
        available: typeof body.credits.has_credits === 'boolean' ? body.credits.has_credits : null,
      }
    }
  } else if (provider === 'claude') {
    for (const key of ['five_hour', 'seven_day', 'seven_day_fable', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps']) {
      const item = body[key]
      if (!object(item)) continue
      const kind = key === 'five_hour' ? 'five_hour' : 'weekly'
      quota.windows.push(windowRow(key, kind, kind === 'five_hour' ? 18000 : 604800,
        percent(item.utilization), date(item.resets_at)))
    }
    // Model-scoped weekly limits supersede the corresponding legacy field.
    for (const item of Array.isArray(body.limits) ? body.limits : []) {
      if (item?.kind !== 'weekly_scoped' || item.group !== 'weekly' || item.scope?.surface != null) continue
      const model = item.scope?.model?.display_name?.toLowerCase?.()
      if (!['fable', 'opus', 'sonnet'].includes(model)) continue
      const used = percent(item.percent)
      if (used === null) continue
      const id = `seven_day_${model}`
      quota.windows = quota.windows.filter(row => row.id !== id)
      quota.windows.push(windowRow(id, 'weekly', 604800, used, date(item.resets_at)))
    }
    const extra = body.extra_usage
    if (object(extra)) {
      // Anthropic reports these monetary values in cents. They are spending,
      // not a prepaid account balance.
      quota.extraUsage = {
        enabled: typeof extra.is_enabled === 'boolean' ? extra.is_enabled : null,
        used: nonnegative(extra.used_credits), limit: nonnegative(extra.monthly_limit), unit: 'cents',
      }
    }
  } else if (provider === 'gemini') {
    for (const [index, item] of (Array.isArray(body.buckets) ? body.buckets : []).entries()) {
      if (!object(item)) continue
      const fraction = numeric(item.remainingFraction)
      const used = fraction !== null && fraction >= 0 && fraction <= 1 ? (1 - fraction) * 100 : null
      quota.windows.push(windowRow(`bucket:${index}`, 'model', null, used, date(item.resetTime), {
        model: typeof item.modelId === 'string' ? item.modelId : null,
        remainingAmount: nonnegative(item.remainingAmount),
        unit: typeof item.tokenType === 'string' ? item.tokenType : null,
      }))
    }
  }
  quota.fiveHour = quota.windows.find(row => row.kind === 'five_hour') ?? null
  quota.weekly = quota.windows.find(row => row.id === 'seven_day' || row.id === 'weekly') ?? null
  quota.status = quota.windows.some(row => row.usedPercent !== null || row.remainingAmount != null)
    || quota.balance?.amount != null || quota.balance?.unlimited === true ? 'ok' : 'unknown'
  return quota
}

function readPrivate(file) {
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw fail('STORAGE_ERROR', 'Cannot read subscription credentials', 500)
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

/**
 * Mutations are synchronous and durable before returning. Quota refresh and
 * resolve are async. Endpoints/transport/timeouts are injectable only here,
 * never through import(). dataDir and home are trusted server configuration.
 *
 * list().models are raw upstream IDs. The completion runtime exposes them as
 * subscription:<uuid>/<model> in publicModelRows().
 * No guessed model catalog is added when models is omitted.
 */
export function createSubscriptions({
  dataDir, home = os.homedir(), fetchImpl = globalThis.fetch,
  endpoints: overrides = {}, timeoutMs = 15000,
} = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof home !== 'string' || !home
    || typeof fetchImpl !== 'function' || !object(overrides)
    || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw fail('INVALID_INPUT', 'Invalid subscription configuration')
  }
  const endpoints = { ...ENDPOINTS }
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(endpoints, key)) throw fail('INVALID_INPUT', 'Invalid subscription endpoint override')
    endpoints[key] = url(value, true)
  }
  const directory = path.join(path.resolve(dataDir), 'subscriptions')
  const file = path.join(directory, 'credentials.json')
  let accounts = []
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error()
    privatePermissions(directory, true)
    if (fs.existsSync(file)) {
      const stored = readPrivate(file)
      if (stored?.version !== 1 || !Array.isArray(stored.accounts)) throw new Error()
      const ids = new Set()
      for (const account of stored.accounts) {
        if (!object(account) || !/^[0-9a-f-]{36}$/.test(account.id) || ids.has(account.id)
          || !PROVIDERS.includes(account.provider) || !object(account.credentials)
          || typeof account.enabled !== 'boolean' || !Array.isArray(account.models)) throw new Error()
        // Revalidate private records through exactly the same input boundary.
        const c = account.credentials
        const raw = account.provider === 'api' ? { apiKey: c.apiKey }
          : account.provider === 'codex' ? { tokens: {
            access_token: c.accessToken, refresh_token: c.refreshToken ?? undefined,
            id_token: c.idToken ?? undefined, account_id: c.accountId ?? undefined,
          } }
            : account.provider === 'claude' ? { claudeAiOauth: {
              accessToken: c.accessToken, refreshToken: c.refreshToken ?? undefined,
              expiresAt: c.expiresAt ?? undefined, subscriptionType: c.plan ?? undefined,
            } }
              : { access_token: c.accessToken ?? undefined, refresh_token: c.refreshToken ?? undefined,
                expiry_date: c.expiresAt ?? undefined, project: c.project ?? undefined }
        const valid = normalize({
          provider: account.provider, credentials: raw, label: account.label, models: account.models,
          ...(account.provider === 'api' ? { baseUrl: account.baseUrl, format: account.format } : {}),
        })
        ids.add(account.id)
        accounts.push({ ...valid, id: account.id, enabled: account.enabled,
          createdAt: date(account.createdAt), updatedAt: date(account.updatedAt),
          quota: blankQuota() })
      }
      privatePermissions(file)
    }
  } catch { throw fail('STORAGE_ERROR', 'Cannot read private subscription storage', 500) }

  const knownSecrets = new Set()
  const secretValues = () => {
    for (const account of accounts) {
      const c = account.credentials
      for (const value of [c.apiKey, c.accessToken, c.refreshToken, c.idToken, c.accountId]) {
        if (typeof value === 'string' && value) knownSecrets.add(value)
      }
    }
    return [...knownSecrets].sort((a, b) => b.length - a.length)
  }
  secretValues()
  const redact = value => {
    const secrets = secretValues()
    const walk = item => {
      if (typeof item === 'string') {
        for (const secret of secrets) item = item.replaceAll(secret, '[redacted]')
        return item
      }
      if (Array.isArray(item)) return item.map(walk)
      if (object(item)) return Object.fromEntries(Object.entries(item).map(([key, val]) => [key, walk(val)]))
      return item
    }
    return walk(value)
  }
  const publicRow = account => redact({
    id: account.id, provider: account.provider, label: account.label, enabled: account.enabled,
    createdAt: account.createdAt, updatedAt: account.updatedAt,
    ...(account.provider === 'api' ? { baseUrl: account.baseUrl, format: account.format } : {}),
    models: [...account.models],
    quota: clone(account.quota),
  })
  const find = id => {
    if (typeof id !== 'string') throw fail('INVALID_INPUT', 'Invalid subscription ID')
    const account = accounts.find(row => row.id === id)
    if (!account) throw fail('NOT_FOUND', 'Subscription account not found', 404)
    return account
  }
  const persist = next => {
    secretValues()
    const temp = path.join(directory, `.credentials-${crypto.randomUUID()}.tmp`)
    let fd
    try {
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error()
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error()
      fd = fs.openSync(temp, 'wx', 0o600)
      privatePermissions(temp)
      const body = JSON.stringify({ version: 1, accounts: next.map(({ quota, ...account }) => account) })
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error()
      fs.writeFileSync(fd, body)
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fd = undefined
      fs.renameSync(temp, file)
      accounts = next
    } catch { throw fail('STORAGE_ERROR', 'Cannot persist private subscription storage', 500) }
    finally {
      if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
      try { fs.unlinkSync(temp) } catch {}
    }
  }
  const update = (id, transform) => {
    const prior = find(id)
    const next = transform(prior)
    persist(accounts.map(row => row === prior ? next : row))
    return next
  }
  const requestJson = async (endpoint, { signal, token, headers, body, form } = {}) => {
    const controller = new AbortController()
    const abort = () => controller.abort()
    const abortError = () => fail(signal?.aborted ? 'ABORTED' : 'TIMEOUT',
      signal?.aborted ? 'Subscription request aborted' : 'Subscription request timed out', signal?.aborted ? 499 : 504)
    if (signal?.aborted) throw abortError()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, timeoutMs)
    let rejectAbort
    const interrupted = new Promise((_, reject) => { rejectAbort = () => reject(abortError()) })
    controller.signal.addEventListener('abort', rejectAbort, { once: true })
    let response
    try {
      return await Promise.race([interrupted, (async () => {
        response = await fetchImpl(endpoint, {
          method: body === undefined && form === undefined ? 'GET' : 'POST',
          redirect: 'error', signal: controller.signal,
          headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            ...(form === undefined ? {} : { 'content-type': 'application/x-www-form-urlencoded' }), ...headers },
          ...(body === undefined && form === undefined ? {} : {
            body: form === undefined ? JSON.stringify(body) : new URLSearchParams(form).toString(),
          }),
        })
        if (!response.ok) throw fail(
          response.status === 401 || response.status === 403 ? 'AUTH_REQUIRED' : 'PROVIDER_ERROR',
          'Subscription provider rejected the request', response.status === 401 || response.status === 403 ? 401 : 502)
        // Bound streamed bodies as well as content-length; never retain raw
        // error bodies, which can echo Authorization headers or credentials.
        const length = Number(response.headers?.get?.('content-length'))
        if (length > MAX_BYTES) throw fail('INVALID_RESPONSE', 'Invalid provider quota response', 502)
        const chunks = []
        let size = 0
        for await (const chunk of response.body ?? []) {
          const bytes = Buffer.from(chunk)
          size += bytes.length
          if (size > MAX_BYTES) throw fail('INVALID_RESPONSE', 'Invalid provider quota response', 502)
          chunks.push(bytes)
        }
        let payload
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
        catch { throw fail('INVALID_RESPONSE', 'Invalid provider quota response', 502) }
        if (!object(payload)) throw fail('INVALID_RESPONSE', 'Invalid provider quota response', 502)
        return payload
      })()])
    } catch (error) {
      if (controller.signal.aborted) throw abortError()
      if (['AUTH_REQUIRED', 'PROVIDER_ERROR', 'INVALID_RESPONSE'].includes(error?.code)) {
        // Do not trust arbitrary errors from the injected transport.
        throw fail(error.code, error.code === 'INVALID_RESPONSE' ? 'Invalid provider quota response'
          : 'Subscription provider rejected the request', error.code === 'AUTH_REQUIRED' ? 401 : 502)
      }
      throw fail('NETWORK_ERROR', 'Subscription provider request failed', 502)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', rejectAbort)
      controller.abort()
      try { void Promise.resolve(response?.body?.cancel?.()).catch(() => {}) } catch {}
    }
  }
  const refreshes = new Map()
  const waitForRefresh = async (pending, signal) => {
    if (signal?.aborted) throw fail('ABORTED', 'Subscription request aborted', 499)
    let onAbort
    const interrupted = new Promise((_, reject) => {
      onAbort = () => reject(fail('ABORTED', 'Subscription request aborted', 499))
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    try {
      const token = await Promise.race([pending, interrupted])
      if (signal?.aborted) throw fail('ABORTED', 'Subscription request aborted', 499)
      return token
    } finally { signal?.removeEventListener('abort', onAbort) }
  }
  const getToken = async (account, signal, force = false) => {
    const c = account.credentials
    const due = force || !c.accessToken || (c.expiresAt !== null && c.expiresAt <= Date.now() + 30000)
    if (!due) return c.accessToken
    // Claude's native CLI owns its refresh flow. An expired credential is an
    // explicit auth-required state, rather than a request to a guessed endpoint.
    if (!c.refreshToken || account.provider === 'claude') {
      throw fail('AUTH_REQUIRED', 'Subscription credentials require re-import', 401)
    }
    if (signal?.aborted) throw fail('ABORTED', 'Subscription request aborted', 499)
    if (refreshes.has(account.id)) {
      return waitForRefresh(refreshes.get(account.id), signal)
    }
    const pending = (async () => {
      const form = {
        grant_type: 'refresh_token', refresh_token: c.refreshToken,
        client_id: account.provider === 'codex' ? 'app_EMoamEEZ73f0CkXaXp7hrann' : GEMINI_CLIENT_ID,
        ...(account.provider === 'gemini' ? { client_secret: GEMINI_CLIENT_SECRET } : {}),
      }
      // Rotation belongs to the account, not its first caller. requestJson's
      // own deadline bounds it even after every individual waiter has aborted.
      const fresh = await requestJson(account.provider === 'codex' ? endpoints.codexToken : endpoints.geminiToken, { form })
      let token, refresh, idToken
      try {
        token = text(fresh.access_token, 'access token')
        refresh = text(fresh.refresh_token, 'refresh token', { optional: true })
        idToken = text(fresh.id_token, 'ID token', { optional: true })
      } catch { throw fail('INVALID_RESPONSE', 'Invalid provider token response', 502) }
      if (fresh.expires_in !== undefined && nonnegative(fresh.expires_in) === null) {
        throw fail('INVALID_RESPONSE', 'Invalid provider token response', 502)
      }
      const expiresAt = nonnegative(fresh.expires_in) !== null ? (Date.now() + fresh.expires_in * 1000) : null
      if (expiresAt !== null && expiresAt > 8.64e15) throw fail('INVALID_RESPONSE', 'Invalid provider token response', 502)
      update(account.id, current => ({
        ...current, updatedAt: new Date().toISOString(),
        credentials: { ...current.credentials, accessToken: token,
          refreshToken: refresh ?? current.credentials.refreshToken, expiresAt,
          ...(current.provider === 'codex' && idToken ? { idToken } : {}) },
      }))
      return token
    })()
    refreshes.set(account.id, pending)
    const cleanup = () => {
      if (refreshes.get(account.id) === pending) refreshes.delete(account.id)
    }
    void pending.then(cleanup, cleanup)
    return waitForRefresh(pending, signal)
  }
  const query = async (account, signal) => {
    let token = await getToken(account, signal)
    const ask = async () => {
      const current = find(account.id)
      if (account.provider === 'codex') {
        return parseQuota('codex', await requestJson(endpoints.codexQuota, {
          token, signal, headers: current.credentials.accountId ? { 'chatgpt-account-id': current.credentials.accountId } : {},
        }), Date.now())
      }
      if (account.provider === 'claude') {
        return parseQuota('claude', await requestJson(endpoints.claudeQuota, {
          token, signal, headers: { 'anthropic-beta': 'oauth-2025-04-20' },
        }), Date.now(), current.credentials.plan)
      }
      const load = await requestJson(endpoints.geminiLoad, {
        token, signal, body: { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } },
      })
      const projectValue = load.cloudaicompanionProject
      const project = typeof projectValue === 'string' ? projectValue : projectValue?.id ?? projectValue?.projectId
      if (typeof project === 'string' && project.trim() && project.length <= 256 && !/[\x00-\x1f]/.test(project)) {
        update(account.id, row => ({ ...row, credentials: { ...row.credentials, project } }))
      }
      const selectedProject = find(account.id).credentials.project
      const body = await requestJson(endpoints.geminiQuota, { token, signal,
        body: selectedProject ? { project: selectedProject } : {} })
      const tier = load.paidTier ?? load.currentTier
      return parseQuota('gemini', body, Date.now(), typeof tier?.name === 'string' ? tier.name
        : typeof tier?.id === 'string' ? tier.id : null)
    }
    try { return await ask() } catch (error) {
      if (error.code !== 'AUTH_REQUIRED' || !account.credentials.refreshToken || account.provider === 'claude') throw error
      token = await getToken(find(account.id), signal, true)
      return ask()
    }
  }
  return {
    list() { return accounts.map(publicRow) },
    import(input) {
      const valid = normalize(input)
      const now = new Date().toISOString()
      const account = { ...valid, id: crypto.randomUUID(), enabled: true, createdAt: now, updatedAt: now, quota: blankQuota() }
      persist([...accounts, account])
      return publicRow(account)
    },
    discover() {
      const candidates = []
      for (const [provider, parts] of Object.entries(NATIVE)) {
        try {
          normalize({ provider, credentials: readPrivate(path.join(home, ...parts)) })
          candidates.push({ id: `local:${provider}`, provider })
        } catch { /* Missing, malformed and unreadable native files expose no content or paths. */ }
      }
      return candidates
    },
    importLocal(input) {
      if (!object(input) || !Object.hasOwn(NATIVE, input.provider) || Object.hasOwn(input, 'path')
        || Object.hasOwn(input, 'file') || Object.hasOwn(input, 'credentials')) {
        throw fail('INVALID_INPUT', 'Invalid local subscription import')
      }
      let credentials
      try { credentials = readPrivate(path.join(home, ...NATIVE[input.provider])) }
      catch { throw fail('LOCAL_AUTH_UNAVAILABLE', 'Native subscription credentials unavailable', 404) }
      return this.import({ provider: input.provider, credentials, label: input.label, models: input.models })
    },
    async refreshQuota({ id, signal } = {}) {
      const account = find(id)
      if (signal?.aborted) throw fail('ABORTED', 'Subscription request aborted', 499)
      if (account.provider === 'api') {
        // There is no universal third-party subscription quota endpoint.
        const quota = { ...blankQuota(), checkedAt: new Date().toISOString() }
        update(id, row => ({ ...row, quota }))
        return publicRow(find(id))
      }
      let quota
      try { quota = await query(account, signal) } catch (error) {
        if (error.code === 'NOT_FOUND') throw error
        const code = ['AUTH_REQUIRED', 'ABORTED', 'TIMEOUT', 'INVALID_RESPONSE', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'STORAGE_ERROR']
          .includes(error?.code) ? error.code : 'PROVIDER_ERROR'
        quota = { ...blankQuota(), status: 'error', checkedAt: new Date().toISOString(),
          error: { code, message: ({
            AUTH_REQUIRED: 'Subscription credentials require re-import',
            ABORTED: 'Subscription request aborted', TIMEOUT: 'Subscription request timed out',
            INVALID_RESPONSE: 'Invalid provider quota response', NETWORK_ERROR: 'Subscription provider request failed',
            STORAGE_ERROR: 'Cannot persist private subscription storage',
          })[code] ?? 'Subscription provider rejected the request' } }
      }
      update(id, row => ({ ...row, quota }))
      return publicRow(find(id))
    },
    remove({ id } = {}) {
      find(id)
      persist(accounts.filter(row => row.id !== id))
      return { id, removed: true }
    },
    setEnabled({ id, enabled } = {}) {
      if (typeof enabled !== 'boolean') throw fail('INVALID_INPUT', 'Invalid subscription enabled state')
      return publicRow(update(id, row => ({ ...row, enabled, updatedAt: new Date().toISOString() })))
    },
    async resolve(id, { signal } = {}) {
      if (typeof id !== 'string') throw fail('INVALID_INPUT', 'Invalid subscription ID')
      let model
      if (id.startsWith('subscription:')) {
        const slash = id.indexOf('/')
        if (slash < 0) throw fail('NOT_FOUND', 'Subscription model not found', 404)
        model = id.slice(slash + 1)
        id = id.slice('subscription:'.length, slash)
      }
      let account = find(id)
      if (!account.enabled) throw fail('DISABLED', 'Subscription account disabled', 409)
      if (model !== undefined && !account.models.includes(model)) throw fail('NOT_FOUND', 'Subscription model not found', 404)
      if (signal?.aborted) throw fail('ABORTED', 'Subscription request aborted', 499)
      const token = account.provider === 'api' ? account.credentials.apiKey : await getToken(account, signal)
      account = find(id)
      if (!account.enabled) throw fail('DISABLED', 'Subscription account disabled', 409)
      if (account.provider === 'gemini' && !account.credentials.project) {
        const load = await requestJson(endpoints.geminiLoad, {
          token, signal, body: { metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } },
        })
        const value = load.cloudaicompanionProject
        const project = typeof value === 'string' ? value : value?.id ?? value?.projectId
        if (typeof project === 'string' && project.trim() && project.length <= 256 && !/[\x00-\x1f]/.test(project)) {
          account = update(id, row => ({ ...row, credentials: { ...row.credentials, project } }))
        }
      }
      const format = account.provider === 'api' ? account.format : account.provider === 'codex' ? 'openai-responses'
        : account.provider === 'claude' ? 'anthropic-messages' : 'gemini-code-assist'
      const baseUrl = account.provider === 'api' ? account.baseUrl
        : account.provider === 'codex' ? 'https://chatgpt.com/backend-api/codex'
          : account.provider === 'claude' ? 'https://api.anthropic.com' : 'https://cloudcode-pa.googleapis.com'
      const endpoint = account.provider === 'api' ? `${baseUrl}${format === 'openai-chat' ? '/chat/completions'
        : format === 'openai-responses' ? '/responses' : '/messages'}`
        : account.provider === 'codex' ? endpoints.codexResponses
          : account.provider === 'claude' ? endpoints.claudeMessages : endpoints.geminiGenerate
      return {
        id, provider: account.provider, model, models: [...account.models], baseUrl, endpoint, format,
        wire: format === 'openai-chat' ? 'chat' : format === 'openai-responses' ? 'responses'
          : format === 'anthropic-messages' ? 'messages' : 'gemini-code-assist',
        headers: {
          ...(account.provider === 'api' && format === 'anthropic-messages' ? { 'x-api-key': token }
            : { authorization: `Bearer ${token}` }),
          ...(format === 'anthropic-messages' ? { 'anthropic-version': '2023-06-01' } : {}),
          ...(account.provider === 'claude' ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
          ...(account.provider === 'codex' && account.credentials.accountId ? { 'chatgpt-account-id': account.credentials.accountId } : {}),
        },
        // Code Assist needs { model, project, request: <Gemini contents> }.
        ...(account.provider === 'gemini' ? { project: account.credentials.project } : {}),
        redirect: 'error', expiresAt: account.credentials.expiresAt ?? null,
      }
    },
  }
}
