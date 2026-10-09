/**
 * Badge probe — renders the 白嫖接入 settings tab offline, opens the WorkBuddy
 * (buddy) card's model fold, and asserts which rows get an `ofm_tagpill promo`
 * pill: every shape of the promo annotation, and **nothing else**.
 *
 * Why this exists: the badge went missing across several rounds because each fix
 * was reasoned about but never rendered; the regression was *data plumbing*, and
 * only a render shows whether the merge reached the row. It now also pins the
 * opposite failure — Cline / lobsterai pass an upstream model blurb through the
 * same `description` field (`cline-product.ts`, `lobsterai-adapter.ts`), and
 * painting a pill for those was reported as "其他供应商出现奇怪的标签".
 *
 * Scenarios:
 *   remote   — new pack: rows carry the structured `promo` field AND the response
 *              declares the `promoTransport` capability bit (see channel-pack-rpc.ts).
 *              The card must render `promo` WITHOUT a single catalog/route read —
 *              even though several rows genuinely have no promo (that is the norm).
 *   fallback — same rows and same capability bit, no `remote` service at all;
 *              still zero compat reads.
 *   legacy   — old pack: no `promo` on rows and NO capability bit; the annotation
 *              lives only in `description`. The card must run the compat read,
 *              apply the shape check, badge the note and refuse the blurb.
 *   none     — negative control: old pack, and BOTH carriers emptied — no badge
 *              may be painted.
 *
 * Run: node scripts/promo-badge-test.mjs [remote|fallback|legacy|none]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const source = fs.readFileSync(path.join(root, 'client.js'), 'utf8')
const scenario = process.argv[2] ?? 'remote'
if (!['remote', 'fallback', 'legacy', 'none'].includes(scenario)) {
  console.log(`PROBE: unknown scenario ${scenario} (expected remote|fallback|legacy|none)`)
  process.exit(2)
}

/**
 * The long annotation the buddy adapter writes into `description`, in **all
 * three shapes** `buildPromotionNote` can produce (the LEGACY path).
 */
const NOTE = '错峰时段23:00-08:00·限免·至11月1日' // window + free + deadline
const NOTE_DISCOUNT = '错峰时段09:00-12:00/14:00-18:00·非高峰x0.32·至10月31日' // window + off-peak price
const NOTE_DATE_ONLY = '限免·至11月1日' // free campaign with no daily window
/**
 * …and one `description` that is NOT an annotation: Cline's adapter passes the
 * upstream `recommended-models` blurb through verbatim (`cline-product.ts`), and
 * lobsterai does the same. Painting a promo pill for these is the regression this
 * probe pins (user report: "其他供应商出现奇怪的标签").
 */
const BLURB = 'Mixture-of-Experts architecture with 309B total parameters'
/**
 * The STRUCTURED promo the new independent `promo` field carries — what
 * `model.list` transports and the card renders. Three shapes mirroring the note
 * strings above, including the two things a string never expressed: multiple
 * windows and a dual (list → effective) price.
 */
const PROMO_FREE = {
  kind: 'discount', displayMode: 'strikethrough',
  price: { effective: 'x0', original: 'x0.29' },
  windows: [{ start: '23:00', end: '08:00' }],
  timezone: 'Asia/Shanghai', validFrom: '2026-10-01', validUntil: '2026-11-01',
  active: false, status: '常时', note: NOTE, priority: 100,
}
const PROMO_DISCOUNT = {
  kind: 'discount', displayMode: 'replace',
  price: { effective: 'x0.32', original: 'x0.79' },
  // Two windows — the reason `windows` stays an array instead of a joined string.
  windows: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  timezone: 'Asia/Shanghai', validUntil: '2026-10-31',
  active: true, status: '错峰', note: NOTE_DISCOUNT, priority: 100,
}
const PROMO_DATE_ONLY = {
  kind: 'discount', price: { effective: 'x0' },
  validUntil: '2026-11-01', active: true, status: '限免', note: NOTE_DATE_ONLY,
}
/**
 * Upstream-LABELLED badge with no price — the shape three real activities have
 * (`glm-52...daytime` / `hy4...daytime` / `ds-discount...daytime`). It exists to
 * hang a badge during the daytime half of a complementary pair, so it must
 * render even though it carries no `price` at all.
 */
const PROMO_LABEL_ONLY = {
  kind: 'discount',
  windows: [{ start: '0:00', end: '23:59' }],
  timezone: 'Asia/Shanghai',
  active: true,
  badgeLabel: '夜间折扣',
  badgeColor: '#1E90FF',
  hoverText: '周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折',
  hoverActionLabel: '去使用',
  id: 'ds-discount-daytime-badge-202608',
}
/**
 * Membership tier (`modelTiers`) — a SECOND source, not a promotion: no price,
 * no status, no displayMode. Rendered as a dashed pill so it never reads as a
 * discount.
 */
const PROMO_TIER = {
  kind: 'tier', active: true,
  badgeLabel: '订阅优先', hoverText: '资源紧张，旗舰版及高级版会员享优先调度。',
  hoverActionLabel: '去升级', tier: 'standard', requiredUserType: 'standard', priority: 20,
  id: 'tier-standard-2026q3',
}
/**
 * Qoder's shape: ONE window (not an array of many) and the upstream `badgeZh`
 * corner label mapped to `badgeLabel`. Proves the shared renderer handles a
 * second producer's output without provider-specific branches.
 */
const PROMO_QODER = {
  kind: 'discount',
  price: { effective: 'x0.2', original: 'x0.5' },
  windows: [{ start: '22:00', end: '08:00' }],
  timezone: 'Asia/Shanghai',
  active: true, status: '错峰',
  badgeLabel: '错峰 4 折',
}
/**
 * TRAE's shape: a dual price with NO time window at all (its `off_peak` type
 * carries only "currently discounted") and a `validUntil` deadline instead.
 * Third producer, same renderer — and the case that proves the pill does not
 * demand a window to render.
 */
const PROMO_TRAE = {
  kind: 'discount',
  price: { effective: 'x0.08', original: 'x0.8' },
  active: true, status: '错峰',
}
/**
 * TRAE with the official label its client hardcodes for `discount_type:
 * off_peak` — that label is NOT in the response, it is mapped locally (see
 * `traeDiscountLabel`). Label + dual price, still no window.
 */
const PROMO_TRAE_LABELLED = {
  kind: 'discount',
  price: { effective: 'x0.08', original: 'x0.15' },
  active: true, status: '错峰',
  badgeLabel: '闲时折扣',
}
/**
 * The membership fold label (`会员5折`) — derived locally from the before/after
 * ratio because the official `{fold}` variable is not in the response either.
 */
const PROMO_TRAE_MEMBER = {
  kind: 'discount',
  price: { effective: 'x0.395', original: 'x0.79' },
  active: true, status: '错峰',
  badgeLabel: '会员5折',
  hoverText: '会员专享5折',
}
/**
 * Upstream label + TWO windows — workbuddy splits the cross-midnight slot
 * (`23:00-8:00`) into `23:00-23:59` + `0:00-8:00`. A pill that shows only the
 * first slot tells the user the other half has no promotion.
 */
const PROMO_LABEL_MULTI = {
  kind: 'discount',
  price: { effective: 'x0', original: 'x0.29' },
  windows: [{ start: '23:00', end: '23:59' }, { start: '0:00', end: '8:00' }],
  timezone: 'Asia/Shanghai',
  active: true, status: '错峰',
  badgeLabel: '夜间免费',
}
/**
 * Raccoon's shape: a dual price plus a FREE-TEXT status note (its gateway ships
 * `billing_status_note` like「限免一个月」instead of a machine-readable window).
 * The note must reach the tooltip while `windows` stays absent.
 */
const PROMO_RACCOON = {
  kind: 'discount',
  price: { effective: 'x0.25', original: 'x0.5' },
  active: true, status: '错峰',
  badgeLabel: '限时折扣',
  hoverText: '限时 5 折',
}
/** What each pill must READ: the upstream label when given, else price / note. */
const PROMO_FREE_TEXT = 'x0.29→x0'
const PROMO_DISCOUNT_TEXT = 'x0.79→x0.32'
const ROWS = [
  { id: 'hy4-preview', name: 'Hy4 preview · x0.29 (常时)', disabled: false, dead: false, isFree: true, promo: PROMO_FREE, badge: PROMO_FREE_TEXT },
  { id: 'glm-5.3', name: 'GLM-5.3 · x0.79', disabled: false, dead: false, promo: PROMO_DISCOUNT, badge: PROMO_DISCOUNT_TEXT },
  { id: 'hy3', name: 'Hy3 · x0.00 (限免)', disabled: false, dead: false, isFree: true, promo: PROMO_DATE_ONLY, badge: NOTE_DATE_ONLY },
  // Upstream label is authoritative for WHAT the badge says, and a full-day
  // window (`0:00-23:59`) is a placeholder upstream uses for "badge all day" —
  // it must NOT be echoed as a time range.
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash · x0.11', disabled: false, dead: false, promo: PROMO_LABEL_ONLY, badge: '夜间折扣' },
  { id: 'kimi-k2.8-preview', name: 'Kimi-K2.8-Preview · x0.52', disabled: false, dead: false, promo: PROMO_TIER, badge: '订阅优先' },
  // …and qoder's own producer output, rendered by the SAME code path.
  // Its pill must carry BOTH the upstream label and the time window: the label
  // says how much cheaper, the window says when — dropping either one is the
  // regression the user hit ("咋没有时段显示呢").
  { id: 'qmodel_38max', name: 'Qwen3.8-Max · x0.5→x0.2', disabled: false, dead: false, promo: PROMO_QODER, badge: `${PROMO_QODER.badgeLabel} · ${PROMO_QODER.windows[0].start}-${PROMO_QODER.windows[0].end}` },
  // Label + MULTIPLE windows (workbuddy's cross-midnight pair) must show both.
  { id: 'hy4-labeled', name: 'Hy4 preview · x0.29', disabled: false, dead: false, promo: PROMO_LABEL_MULTI, badge: `${PROMO_LABEL_MULTI.badgeLabel} · 23:00-23:59/0:00-8:00` },
  // TRAE: dual price, no window at all (must still render — a window is not required).
  { id: 'doubao-seed-2.1-pro', name: 'Doubao-Seed-2.1-Pro · x0.80→x0.08', disabled: false, dead: false, promo: PROMO_TRAE, badge: 'x0.8→x0.08' },
  // …and TRAE with the locally-mapped official label: label + price together.
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash · x0.15→x0.08', disabled: false, dead: false, promo: PROMO_TRAE_LABELLED, badge: '闲时折扣 · x0.15→x0.08' },
  // …and the membership fold label, which is derived from the price ratio.
  { id: 'glm-5.2-t', name: 'GLM-5.2 · x0.79→x0.395', disabled: false, dead: false, promo: PROMO_TRAE_MEMBER, badge: '会员5折 · x0.79→x0.395' },
  // Raccoon: label + dual price + a free-text note (no window).
  { id: 'glm-5-3', name: 'GLM-5-3 · x0.5→x0.25', disabled: false, dead: false, promo: PROMO_RACCOON, badge: `${PROMO_RACCOON.badgeLabel} · ${PROMO_RACCOON.price.original}→${PROMO_RACCOON.price.effective}` },
  // No promo at all — and, crucially, no `description` either.
  { id: 'cline-free/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash · 免费', disabled: false, dead: false, isFree: true, badge: null },
  { id: 'glm-5.2-day', name: 'GLM-5.2 · x0.79', disabled: false, dead: false, badge: null },
]
/**
 * LEGACY scenario: rows carry NO `promo`, only the annotation in `description`
 * (what an old pack's `model.list` looks like). The card must still badge them
 * through the shape check — and must still refuse the blurb.
 */
const LEGACY_ROWS = [
  { id: 'hy4-preview', name: 'Hy4 preview · x0.29 (常时)', disabled: false, dead: false, isFree: true, description: NOTE, badge: NOTE },
  { id: 'cline-free/mimo-v2.6-flash', name: 'MiMo-V2.6-Flash · 免费', disabled: false, dead: false, isFree: true, description: BLURB, badge: null },
]
/** `legacy` swaps in the description-only rows; every other scenario uses `promo`. */
const activeRows = scenario === 'legacy' ? LEGACY_ROWS : ROWS

// ── fake same-origin JSON API (the plugin's own routes) ─────────────────────
const summary = {
  catalog: [{ id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', availability: 'available', vision: false, route: 'our-free-model', contextWindow: 1000000, maxOutput: 32768, reasoning: true }],
  settings: { enabled: true, forward: { enabled: false, host: '127.0.0.1', port: 18899, lan: { enabled: false, port: 0 } }, egress: { enabled: false }, probeIntervalMinutes: 15, defaultMaxTokens: 32768, notifyOs: false, autoReloadWatch: false, updateCheckHours: 6, reloadCount: 0, reloadedAt: 0 },
  egress: { country: 'CN' }, outlet: { running: false }, probedAt: Date.now(),
  announcementVersion: 'x', version: '2.0.0', distribution: 'self',
  announcements: { unread: 0, fetchedAt: 0 },
  laneAvailable: true,
  eacAuth: { available: true, authorized: true, login: 'probe', required: true, lastCheck: Date.now() },
  channels: { state: 'ready', error: '' },
  update: { available: false, latest: '', current: '2.0.0', checkedAt: 0, applying: false, managed: false },
}
const routes = {
  '/summary': summary,
  '/stats': { requests: 0, requestFailures: 0, turns: 0, failedTurns: 0, days: [], models: [], samples: [], grand: { input: 0, output: 0, reasoning: 0, calls: 0, failed: 0 } },
  '/meta': { version: '2.0.0', reloadedAt: 0, reloadCount: 0, distribution: 'self', feed: { fetchedAt: 0, source: '', error: '' }, update: { available: false } },
  '/eac/status': summary.eacAuth,
  '/chan-gateway': { relay: { enabled: false, running: false, host: '127.0.0.1', port: 0, hasKey: false, error: '' }, gateway: { port: 8326, enabledByEnv: false, keyFound: false, keyFromEnv: false, keyPath: '' } },
  '/announcement': { version: 'x', acknowledged: true },
  '/announcements': { items: [], unread: 0, fetchedAt: 0, notifyOs: false },
  // The plugin's own route: the pre-`promo` compat source. In `legacy`/`none`
  // (old pack, no capability bit) the card falls back to it; in `remote`/
  // `fallback` (new pack declares promoTransport) it must NEVER be called.
  '/models': { provider: 'buddy', models: activeRows.map(row => ({ id: row.id, description: scenario === 'none' ? '' : (row.description ?? '') })) },
}
let modelRouteHits = 0
globalThis.fetch = url => {
  const path = String(url).replace(/^.*?\/api\/our-free-model/, '').split('?')[0]
  if (path === '/models') modelRouteHits += 1
  const payload = routes[path] ?? {}
  return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(payload), json: async () => payload })
}

// ── window/document stubs ────────────────────────────────────────────────────
globalThis.window = {
  __ModuleLoader__: { load: r => { globalThis.__registered = r } },
  localStorage: { getItem: () => 'channels', setItem: () => {} },
  dispatchEvent: () => {}, addEventListener: () => {}, removeEventListener: () => {}, open: () => {},
  confirm: () => true,
}
globalThis.document = {
  baseURI: 'http://127.0.0.1:19387/',
  createElement: () => ({ setAttribute() {}, style: {}, remove() {}, appendChild() {}, addEventListener() {} }),
  head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} },
  querySelector: () => null, querySelectorAll: () => [], addEventListener: () => {},
  execCommand: () => true, documentElement: { lang: 'zh' },
}
globalThis.Notification = undefined
globalThis.EventSource = class { addEventListener() {} close() {} }
globalThis.CustomEvent = class { constructor(type, opts) { this.type = type; this.detail = opts?.detail } }
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true })

// ── stub React: enough state for async data to re-render ─────────────────────
let seq = 0
let dirty = false
let callKey = ''
let hookIdx = 0
const hookState = new Map()
const isEl = v => v !== null && typeof v === 'object' && v.__el === true

const stubReact = {
  createElement(type, props, ...children) {
    const kids = children.flat(Infinity).filter(c => c !== undefined && c !== false && c !== true)
    return { __el: true, id: seq += 1, type, props: props ?? {}, children: kids }
  },
  Fragment: 'fragment',
  useState(initial) {
    const key = `${callKey}#${hookIdx += 1}`
    if (!hookState.has(key)) hookState.set(key, typeof initial === 'function' ? initial() : initial)
    const set = value => {
      const prev = hookState.get(key)
      const next = typeof value === 'function' ? value(prev) : value
      if (JSON.stringify(next) !== JSON.stringify(prev)) { hookState.set(key, next); dirty = true }
    }
    return [hookState.get(key), set]
  },
  useRef: () => ({ current: null }),
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useEffect(fn) { void (async () => { try { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup) } catch { /* effects must not break the probe */ } })() },
}

const cleanups = []
const renderErrors = []
let renderPass = 0

/**
 * Expand one element into a plain host-element tree: function components are
 * invoked (with stable hook keys) and replaced by what they returned, so the
 * assertions below see real nodes instead of unopened component references.
 */
function expand(el, pathName) {
  if (el === null || el === undefined || typeof el !== 'object' || !isEl(el)) return el
  if (typeof el.type === 'function') {
    const key = `${el.type.name ?? 'anon'}@${pathName}`
    const savedKey = callKey
    const savedIdx = hookIdx
    callKey = key
    hookIdx = 0
    let inner
    try {
      inner = el.type({ ...el.props, children: el.children })
    } catch (error) {
      renderErrors.push(`${key}: ${String(error?.message ?? error).slice(0, 200)}`)
      return null
    } finally {
      callKey = savedKey
      hookIdx = savedIdx
    }
    return expand(inner, `${pathName}/${el.type.name ?? 'anon'}`)
  }
  return { ...el, children: (el.children ?? []).map((child, index) => expand(child, `${pathName}/${String(el.type)}[${index}]`)) }
}

// ── boot the bundle ──────────────────────────────────────────────────────────
new Function('window', 'document', 'navigator', source)(globalThis.window, globalThis.document, globalThis.navigator)
const registered = globalThis.__registered
if (registered === undefined) { console.log('PROBE: bundle never registered'); process.exit(1) }
const exports = registered.factory(name => {
  if (name === 'react') return stubReact
  throw new Error(`asked for ${name}`)
})

const sections = []
const rpcMethods = {
  // Only buddy is connected; the other twelve cards render as empty but present.
  'provider.status': { statuses: { buddy: { models: { total: activeRows.length, disabled: 0 }, accounts: { total: 1, enabled: 1 }, closed: false } } },
  'account.list': { accounts: [{ id: 'buddy-1', provider: 'buddy', nickname: 'probe', enabled: true, refreshable: true, expiresAt: Date.now() + 86400000 }] },
  // ⚠️ This is the whole point of the new path: `model.list` now TRANSPORTS
  // `promo`. (A real pack also carries `name` with the rate suffix; the shape
  // that matters here is that `promo` survives the row projection.)
  'model.list': { models: activeRows.map(row => ({ id: row.id, name: row.name, disabled: row.disabled, dead: row.dead, ...row.isFree === undefined ? {} : { isFree: row.isFree }, ...row.promo === undefined ? {} : { promo: row.promo } })), promoTransport: true },
  'credits.status': { accounts: [] },
  'credits.balances': { accounts: [] },
  'usage.autoCheckin': { autoCheckin: { enabled: false, dismissed: true } },
}
const ctx = {
  locale: { register: () => {}, bind: () => key => (typeof key === 'string' ? key : String(key)) },
  effect: fn => { try { fn() } catch { /* degrade */ } return { [Symbol.dispose]() {} } },
  get: () => undefined,
  connection: {
    rpc: {
      call: (mount, endpoint, payload) => {
        if (mount !== '/api' || endpoint !== 'channel-pack') return Promise.resolve({ ok: false, error: { message: 'unknown endpoint' } })
        const value = rpcMethods[payload?.method]
        return value === undefined
          ? Promise.resolve({ ok: false, error: { code: 'no-handler', message: `probe has no stub for ${payload?.method}` } })
          : Promise.resolve({ ok: true, value })
      },
    },
  },
  slots: {
    inject: (name, register) => { if (name === 'settings.section') register() },
    register: (options, render) => sections.push({ options, render }),
  },
}
// The `remote` service mirrors the host catalog: `description` only, never
// `promo` (the host's `listModels` shape has no such field). It is present in
// `remote` (so the legacy branch's FIRST source answers) and absent in `legacy`
// (so the branch falls through to the plugin's own `/models` route).
let catalogReads = 0
if (scenario === 'remote') {
  ctx.remote = {
    session: {
      modelCatalog: () => {
        catalogReads += 1
        return Promise.resolve({
          ok: true,
          value: {
            default: {}, routableProviders: ['buddy'], failures: [],
            groups: [{ id: 'buddy', name: 'WorkBuddy', models: activeRows.map(row => ({ id: row.id, name: row.name, ...row.description === undefined ? {} : { description: row.description } })) }],
          },
        })
      },
    },
  }
}
// `legacy`/`none` simulate an OLD pack: rows carry no `promo` AND the response
// lacks the `promoTransport` capability bit — that combination is what the card
// keys its compat read on. `legacy` keeps the description annotations (the read
// must badge them); `none` strips both carriers, so nothing may render.
if (scenario === 'legacy' || scenario === 'none') {
  const base = rpcMethods['model.list']
  rpcMethods['model.list'] = { models: base.models.map(({ promo, ...rest }) => rest) }
}
exports.apply(ctx)

const section = sections[0]
if (section === undefined) { console.log('PROBE: settings.section was never registered'); process.exit(1) }

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let tree
async function renderUntilStable(maxPasses = 12) {
  for (renderPass = 0; renderPass < maxPasses; renderPass += 1) {
    dirty = false
    tree = expand(section.render({ locale: 'zh', ctx, t: key => (typeof key === 'string' ? key : String(key)) }), 'root')
    await sleep(30)
    if (!dirty && renderPass >= 2) return
  }
}

/** Depth-first walk over the rendered tree, pushing every element it meets. */
function collect(el, out = []) {
  if (el === null || el === undefined || typeof el !== 'object' || !isEl(el)) return out
  out.push(el)
  for (const child of el.children ?? []) collect(child, out)
  return out
}
const textOf = el => (el.children ?? []).filter(c => typeof c === 'string' || typeof c === 'number').join('')

const problems = []
;(async () => {
  await renderUntilStable()
  if (process.env.OFM_BADGE_DEBUG === '1') {
    console.log(`DEBUG render=${typeof section.render} tree=${typeof tree} isEl=${isEl(tree)} type=${String(tree?.type)} keys=${tree === null || tree === undefined ? '-' : Object.keys(tree).join(',')}`)
    console.log(`DEBUG options=${JSON.stringify(section.options)?.slice(0, 300)}`)
    console.log(`DEBUG topChildren=${(tree?.children ?? []).map(c => (isEl(c) ? String(c.type) : typeof c)).join(',')}`)
  }

  const nodes = collect(tree)
  const foldButtons = nodes.filter(node => node.type === 'button'
    && node.props.className === 'ofm_foldtoggle'
    && (node.children ?? []).includes('chan.fold.models'))
  if (foldButtons.length !== 13) problems.push(`expected 13 model folds, saw ${foldButtons.length}`)
  // CHANNEL_PROVIDERS order: codearts, buddy, workbuddy, ... → buddy is index 1.
  const buddyFold = foldButtons[1]
  if (buddyFold === undefined) problems.push('the buddy card has no model fold button')
  else { buddyFold.props.onClick(); await sleep(60) }

  await renderUntilStable(8)

  const badgeText = row => {
    const pill = collect(row).find(node => String(node.props.className ?? '').includes('ofm_tagpill promo'))
    return pill === undefined ? undefined : textOf(pill)
  }
  const rows = collect(tree).filter(node => node.props.className === 'ofm_modelrow')
  if (rows.length !== activeRows.length) problems.push(`expected ${activeRows.length} model rows, saw ${rows.length}`)
  const rowFor = row => rows.find(candidate => collect(candidate).some(node => node.props.className === 'ofm_id' && String(node.props.title) === row.id))

  const painted = []
  for (const row of activeRows) {
    const node = rowFor(row)
    if (node === undefined) { problems.push(`${row.id} row missing`); continue }
    const text = badgeText(node)
    // `badge` is the expected pill text, or null when NO pill may be painted.
    if (row.badge === null || row.badge === undefined) {
      // A blurb (or no annotation at all) may never be painted as a promo pill.
      if (text !== undefined) problems.push(`${row.id} got a promo badge without an annotation: ${JSON.stringify(text)}`)
      continue
    }
    painted.push(text)
    if (scenario === 'none') continue
    if (text !== row.badge) problems.push(`${row.id} badge text ${JSON.stringify(text)} !== ${JSON.stringify(row.badge)}`)
  }
  // The dual-price form (`x0.29→x0`) is only producible from the STRUCTURED
  // `promo` field — a `description` string can never become it. So when a row
  // carries `promo`, seeing that text proves the new path rendered it, not the
  // legacy shape check.
  if (scenario === 'none') {
    if (painted.some(text => text !== undefined)) problems.push(`negative control painted ${painted.filter(Boolean).length} badge(s): [${painted.filter(Boolean).join(' | ')}]`)
  } else {
    // The expectation is per-scenario: `legacy` swapped in its own row set, so
    // the count of shapes that MUST render is a property of `activeRows`, never
    // of the structured ROWS table (quoting BADGE_ROWS here demanded 11 badges
    // from a 2-row legacy fixture).
    const expected = activeRows.filter(row => row.badge !== null && row.badge !== undefined).length
    if (painted.some(text => text === undefined) || painted.length !== expected) {
      problems.push(`expected all ${expected} annotation shapes to render, got [${painted.map(t => JSON.stringify(t)).join(', ')}]`)
    }
  }
  if (scenario !== 'legacy' && scenario !== 'none') {
    const fromPromo = ROWS.filter(row => row.badge !== null && row.badge.includes('→')).map(row => row.badge)
    for (const expected of fromPromo) {
      if (!painted.includes(expected)) problems.push(`structured-promo text ${JSON.stringify(expected)} never rendered (legacy path cannot produce it)`)
    }
  }
  // The compat read is keyed on the pack's **capability bit**, not on row
  // samples: a row without `promo` is the NORM (most models have no promo), and
  // mistaking it for an old pack would bill every fold open for a catalog read
  // that can never add anything. So the rule the probe pins is absolute:
  //   • `remote`/`fallback` — pack declared promoTransport → the catalog and the
  //     plugin route must BOTH stay untouched, hits must be ZERO;
  //   • `legacy` — old pack (no bit), annotation only in description → the read
  //     MUST happen and the shape check must badge the note but refuse the blurb.
  if ((scenario === 'remote' || scenario === 'fallback') && modelRouteHits !== 0) {
    problems.push(`promoTransport-capable pack still paid ${modelRouteHits} compat catalog read(s) — trigger must key on the capability bit, not on rows missing promo`)
  }
  if (scenario === 'remote' && catalogReads !== 0) {
    problems.push(`promoTransport-capable pack still read session.modelCatalog ${catalogReads} time(s)`)
  }
  if (scenario === 'legacy' && modelRouteHits === 0) {
    problems.push('legacy scenario never called /models')
  }

  for (const cleanup of cleanups) { try { cleanup() } catch { /* ignore */ } }
  if (problems.length === 0) {
    // Count from the ACTIVE row set: `legacy`/`none` swap in their own rows, so
    // quoting the structured-ROWS count here would claim "11 badged" while the
    // scenario actually paints one (or zero).
    const paintedCount = activeRows.filter(r => r.badge !== null && r.badge !== undefined).length
    const shapes = activeRows.filter(r => r.badge !== null && r.badge !== undefined).map(r => r.badge).join(' | ')
    console.log(scenario === 'none'
      ? `PROBE[none]: negative control held (no badge on any of ${activeRows.length} rows); compat reads: /models=${modelRouteHits} catalog=${catalogReads}`
      : `PROBE[${scenario}]: ${paintedCount}/${activeRows.length} badged (${shapes}); unpromoted rows clean; compat reads: /models=${modelRouteHits} catalog=${catalogReads}`)
  } else {
    for (const line of problems) console.log(`PROBE[${scenario}] ${line}`)
    const classes = new Map()
    for (const node of collect(tree)) {
      const name = node.props.className
      if (typeof name === 'string' && name !== '') classes.set(name, (classes.get(name) ?? 0) + 1)
    }
    console.log(`PROBE[${scenario}] classes: ${[...classes].map(([k, v]) => `${k}×${v}`).join(', ').slice(0, 900)}`)
    for (const line of [...new Set(renderErrors)].slice(0, 6)) console.log(`PROBE[${scenario}] threw ${line}`)
  }
  process.exit(problems.length === 0 ? 0 : 1)
})()
