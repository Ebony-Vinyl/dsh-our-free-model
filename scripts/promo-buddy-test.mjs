/**
 * Promo render e2e — proves the web model selector would actually render the
 * promo price, and that it is computed LIVE at display time (flips at the window
 * boundary instead of being frozen at config-fetch time — the "大白天显示免费"
 * bug from #155).
 *
 * What it verifies:
 *   1. parseModelsFromConfig attaches the raw `promotion` record to each model.
 *   2. promotionView(model, now) returns the right { effectiveRate, status, note }
 *      for night / day / date-only-free / no-promo scenarios.
 *   3. The model name the composer shows is the concise `name · rate (status)`
 *      form, and the long annotation lives in `description` (the /model popup
 *      sub-row) — NOT crammed into the name.
 *   4. Emits promo-render.html: a visual snapshot of the selector rows as the
 *      host would render them (name + description sub-row), as the "screenshot".
 *
 * Run: node scripts/promo-buddy-test.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(scriptDir, '..')

// ── transpile buddy.ts on the fly (zero runtime deps) ───────────────────────
const require = createRequire(import.meta.url)
const esbuildPath = require.resolve('esbuild', {
  paths: [process.env.OFM_ESBUILD_DIR, process.cwd(), repoRoot].filter(Boolean),
})
const esbuild = await import(pathToFileURL(esbuildPath).href)
const src = readFileSync(path.join(repoRoot, 'vendor/channel-pack/src/buddy.ts'), 'utf8')
const { code } = await esbuild.transform(src, { loader: 'ts', format: 'esm', target: 'node22' })
const tmp = path.join(mkdtempSync(path.join(os.tmpdir(), 'ofm-promo-')), 'buddy.mjs')
writeFileSync(tmp, code)
const buddy = await import(pathToFileURL(tmp).href)

// ── synthetic /v3/config with promotions ────────────────────────────────────
// Hy4: nightly-free (daily window 23:00–08:00, factor 0). Hy3: date-only free
// (no daily window, factor 0, valid until 2026-11-01). DeepSeek: no promo.
// GLM-5.3: off-peak *discount* (two daytime slots, factor 0.4) — the branch that
// must say「非高峰x…」after the window, not before it.
const config = {
  data: {
    agents: [{ name: 'craft', models: ['hy4-preview', 'hy3', 'deepseek-v4.1-flash', 'glm-5.3'] }],
    models: [
      { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29' },
      { id: 'hy3', name: 'Hy3', credits: 'x0.00' },
      { id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash', credits: 'x0.03' },
      { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' },
    ],
    modelPromotions: [
      {
        enabled: true, priority: 0, modelIds: ['hy4-preview'],
        discount: { factor: 0, discountedCredits: 'x0' },
        schedule: {
          daily: [{ start: '23:00', end: '08:00' }],
          timezone: 'Asia/Shanghai',
          validFrom: '2026-10-01', validUntil: '2026-11-01',
        },
      },
      {
        enabled: true, priority: 0, modelIds: ['hy3'],
        discount: { factor: 0, discountedCredits: 'x0.00' },
        schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-10-01', validUntil: '2026-11-01' },
      },
      {
        enabled: true, priority: 0, modelIds: ['glm-5.3'],
        discount: { factor: 0.4, discountedCredits: 'x0.32' },
        schedule: {
          daily: [{ start: '09:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
          timezone: 'Asia/Shanghai',
          validFrom: '2026-10-01', validUntil: '2026-10-31',
        },
      },
    ],
  },
}

const models = buddy.parseModelsFromConfig(config)
const byId = Object.fromEntries(models.map((m) => [m.id, m]))

// ── helpers that mirror the adapter's listModels row assembly ───────────────
// (displayNameFor / promotionView live in buddy-adapter; we replicate the exact
//  name+description contract the host consumes here, driven by promotionView.)
function row(model, now) {
  const v = buddy.promotionView(model, now)
  const rate = v.effectiveRate ?? model.creditsRate
  const parts = []
  if (rate !== undefined) parts.push(rate)
  if (v.status !== undefined) parts.push(`(${v.status})`)
  const name = parts.length > 0 ? `${model.name} · ${parts.join(' ')}` : model.name
  return { name, description: v.note, badge: v.badge }
}

const NIGHT = new Date('2026-10-09T23:30:00+08:00') // 23:30 Asia/Shanghai
const DAY = new Date('2026-10-09T12:00:00+08:00') // 12:00 Asia/Shanghai

// ── assertions ───────────────────────────────────────────────────────────────
let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log(`ok  ${label}`) }
  else { failures++; console.error(`FAIL ${label} — ${detail}`) }
}

// 1. raw promotion record attached (so display-time recompute is possible)
check('Hy4 carries raw promotion record', byId['hy4-preview']?.promotion !== undefined,
  `promotion=${JSON.stringify(byId['hy4-preview']?.promotion)}`)
check('Hy3 carries raw promotion record', byId['hy3']?.promotion !== undefined)

// 2a. night: Hy4 is free inside the window → (错峰), long note in description
{
  const r = row(byId['hy4-preview'], NIGHT)
  check('night Hy4 name = "Hy4 preview · x0 (错峰)"', r.name === 'Hy4 preview · x0 (错峰)', r.name)
  check('night Hy4 description = "错峰时段23:00-08:00·限免·至11月1日"',
    r.description === '错峰时段23:00-08:00·限免·至11月1日', r.description)
}

// 2b. DAY: Hy4 is paid (outside window) → (常时) with normal rate, note still shown
{
  const r = row(byId['hy4-preview'], DAY)
  check('day Hy4 name = "Hy4 preview · x0.29 (常时)"', r.name === 'Hy4 preview · x0.29 (常时)', r.name)
  // Same note in and out of the window: the window is named first, so a reader
  // never mistakes the "限免" for "free at any time" (which is what the name's
  // "(常时)" would contradict).
  check('day Hy4 description = "错峰时段23:00-08:00·限免·至11月1日"',
    r.description === '错峰时段23:00-08:00·限免·至11月1日', r.description)
  // the freezing bug would have shown "免费"/"x0" in daytime — assert it does NOT.
  check('day Hy4 is NOT frozen as free', !r.name.includes('免费') && !r.name.includes('x0 (错峰)'), r.name)
}

// 2c. Hy3 date-only free → (限免) any time during campaign
{
  const r = row(byId['hy3'], DAY)
  check('Hy3 name = "Hy3 · x0.00 (限免)"', r.name === 'Hy3 · x0.00 (限免)', r.name)
  check('Hy3 description = "限免·至11月1日" (no window to name)', r.description === '限免·至11月1日', r.description)
}

// 2e. the STRUCTURED badge (independent `promo` field) — the parts a note string
//     cannot express: multi-window (kept as an array, not joined) and the dual
//     list→effective price.
{
  const r = row(byId['hy4-preview'], DAY)
  const b = r.badge
  check('Hy4 badge exists', b !== undefined, JSON.stringify(b))
  check('Hy4 badge carries both windows as an array',
    Array.isArray(b?.windows) && b.windows.length === 1 && b.windows[0].start === '23:00' && b.windows[0].end === '08:00',
    JSON.stringify(b?.windows))
  check('Hy4 badge carries the DUAL price (original + effective)',
    b?.price?.original === 'x0.29' && b?.price?.effective === 'x0', JSON.stringify(b?.price))
  check('Hy4 badge keeps until / status / priority',
    b?.validUntil === '2026-11-01' && b?.status === '常时' && b?.priority === 0,
    JSON.stringify(b))
  // `kind` / `displayMode` are only written when the upstream declares them —
  // this fixture declares neither, so their ABSENCE is the correct behaviour
  // (never invent a field the promotion did not carry).
  check('Hy4 badge omits kind / displayMode when upstream did not declare them',
    b?.kind === undefined && b?.displayMode === undefined, JSON.stringify(b))
  check('Hy4 badge is marked inactive outside the window', b?.active === false, String(b?.active))
}
{
  const r = row(byId['glm-5.3'], DAY)
  const b = r.badge
  check('GLM-5.3 badge keeps BOTH windows',
    Array.isArray(b?.windows) && b.windows.length === 2
    && b.windows[0].start === '09:00' && b.windows[1].start === '14:00',
    JSON.stringify(b?.windows))
  check('GLM-5.3 badge dual price = x0.79→x0.32',
    b?.price?.original === 'x0.79' && b?.price?.effective === 'x0.32', JSON.stringify(b?.price))
}
{
  const r = row(byId['hy3'], DAY)
  check('Hy3 badge has NO windows key (date-only campaign)',
    r.badge !== undefined && r.badge.windows === undefined, JSON.stringify(r.badge))
  check('Hy3 badge price has no redundant original (both ends are x0.00)',
    r.badge?.price?.effective === 'x0.00' && r.badge?.price?.original === undefined, JSON.stringify(r.badge?.price))
}
{
  const r = row(byId['deepseek-v4.1-flash'], DAY)
  check('no-promo model has no badge at all', r.badge === undefined, JSON.stringify(r.badge))
}

// 2d. no-promo model → just rate, no status, no description
{
  const r = row(byId['deepseek-v4.1-flash'], DAY)
  check('DeepSeek name = "DeepSeek V4.1 Flash · x0.03"', r.name === 'DeepSeek V4.1 Flash · x0.03', r.name)
  check('DeepSeek has no status / no description', r.description === undefined, String(r.description))
}

// 2d-bis. off-peak discount OUTSIDE its window: window first, then the price.
{
  const r = row(byId['glm-5.3'], DAY) // 12:00 — between the two slots
  check('GLM-5.3 description = "错峰时段09:00-12:00/14:00-18:00·非高峰x0.32·至10月31日"',
    r.description === '错峰时段09:00-12:00/14:00-18:00·非高峰x0.32·至10月31日', r.description)
}

// 2e. expired campaign (after 2026-11-01) → promo info fully gone, normal rate
{
  const after = new Date('2026-11-02T23:30:00+08:00')
  const r = row(byId['hy4-preview'], after)
  check('post-campaign Hy4 shows normal rate, no status',
    r.name === 'Hy4 preview · x0.29' && r.description === undefined, r.name)
}

// ── 真身数据（fixture）──────────────────────────────────────────────────────
// Transcribed verbatim from the machine's own WorkBuddy product config:
//   C:\Users\zhujieling11\.workbuddy\cache\acc-product-config-v3.json
// (see docs/workbuddy-promo-reference.md for the field-by-field provenance).
//
// Why a second fixture: the synthetic block above encodes what we *assumed* the
// upstream looks like. The real config disproves three of those assumptions, and
// each one silently deleted a badge the user can see in the desktop app:
//   1. three activities carry `badge` with NO `discount`
//      (glm-52...daytime / hy4...daytime / ds-discount...daytime) — they exist to
//      hang a badge during the *daytime* half of a complementary pair;
//   2. glm-5.2 and hy4-preview each have TWO activities split by priority and by
//      non-overlapping `daily` windows (night 100 / day 50);
//   3. `modelTiers` (订阅优先) is a SEPARATE top-level source, not a promotion.
const realConfig = {
  modelPromotions: [
    {
      id: 'glm-52-night-discount-202607', kind: 'discount', enabled: true, priority: 100,
      modelIds: ['glm-5.2'],
      discount: { discountedCredits: '0.50x', displayMode: 'strikethrough', factor: 0.5 },
      badge: { color: '#1E90FF', label: '夜间折扣' },
      hover: { textZh: '每晚 23:00—次日 8:00 积分限时立减，错峰用更省', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: { daily: [{ start: '23:00', end: '7:50' }], timezone: 'Asia/Shanghai' },
    },
    {
      id: 'glm-52-night-discount-daytime-badge-202607', kind: 'discount', enabled: true, priority: 50,
      modelIds: ['glm-5.2'],
      badge: { color: '#1E90FF', label: '夜间折扣' },
      hover: { textZh: '每晚 23:00—次日 8:00 积分限时立减，错峰用更省', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: { daily: [{ start: '7:50', end: '23:00' }], timezone: 'Asia/Shanghai' },
    },
    {
      id: 'hy3-free-trial-202608', kind: 'discount', enabled: true, priority: 200,
      modelIds: ['hy3', 'hy3-b', 'hy3-c'],
      discount: { discountedCredits: '0x', displayMode: 'replace', factor: 0 },
      badge: { color: '#FF0000', display: 'activeOnly', label: '限时免费' },
      hover: { textZh: '7月6日–10月31日，每日赠送免费额度。', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-07-06T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00' },
    },
    {
      id: 'hy4-night-discount-badge-202609', kind: 'discount', enabled: true, priority: 50,
      modelIds: ['hy4-preview', 'hy4-preview-dev'],
      badge: { color: '#1E90FF', label: '夜间免费' },
      hover: { textZh: '9月11日–10月31日，每晚 23:00—次日 8:00 享免费额度。', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: {
        daily: [{ start: '8:00', end: '23:00' }], timezone: 'Asia/Shanghai',
        validFrom: '2026-09-11T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00',
      },
    },
    {
      id: 'hy4-night-discount-daytime-badge-202609', kind: 'discount', enabled: true, priority: 50,
      modelIds: ['hy4-preview', 'hy4-preview-dev'],
      discount: { discountedCredits: '0.00x', displayMode: 'strikethrough', factor: 0 },
      badge: { color: '#1E90FF', label: '夜间免费' },
      hover: { textZh: '9月11日–10月31日，每晚 23:00—次日 8:00 享免费额度。', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: {
        // Upstream splits the cross-midnight window into two slots rather than
        // writing 23:00-8:00 — the array must survive to display time.
        daily: [{ start: '23:00', end: '23:59' }, { start: '0:00', end: '8:00' }],
        timezone: 'Asia/Shanghai',
        validFrom: '2026-09-11T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00',
      },
    },
    {
      id: 'ds-discount-daytime-badge-202608', kind: 'discount', enabled: true, priority: 50,
      modelIds: ['deepseek-v4-flash-ioa', 'deepseek-v4.1-flash', 'deepseek-v4-pro-ioa', 'deepseek-v4-flash', 'deepseek-v4-pro'],
      badge: { color: '#1E90FF', label: '夜间折扣' },
      // The upstream itself is inconsistent here: the label says 夜间折扣 while the
      // tooltip describes weekday-peak pricing. We transcribe it, never "fix" it.
      hover: { textZh: '周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: { daily: [{ start: '0:00', end: '23:59' }], timezone: 'Asia/Shanghai' },
    },
    {
      id: 'space-bunny-discount-202610', kind: 'discount', enabled: true, priority: 100,
      modelIds: ['space-bunny'],
      badge: { color: '#009273', label: '限时折扣', shortLabel: '折扣' },
      hover: { textZh: '10月2日-10月7日，享限时折扣。', action: { labelZh: '去使用', type: 'selectModel' } },
      schedule: { timezone: 'Asia/Shanghai', validFrom: '2026-10-02T00:00:00+08:00', validUntil: '2026-10-08T00:00:00+08:00' },
    },
  ],
  modelTiers: [
    {
      id: 'tier-standard-2026q3', enabled: true, tier: 'standard', requiredUserType: 'standard',
      priority: 20, trackKey: 'model_tier_standard',
      modelIds: ['glm-5.3', 'glm-5.3-flash', 'kimi-k2.8-preview'],
      badge: { label: '订阅优先' },
      hover: { textZh: '资源紧张，旗舰版及高级版会员享优先调度。', action: { labelZh: '去升级', labelEn: 'Upgrade', type: 'upgrade' } },
    },
  ],
}
// The real `models[]` table carries `credits` (list price) per model.
const REAL_MODELS = [
  { id: 'glm-5.2', name: 'GLM-5.2', credits: 'x0.79' },
  { id: 'glm-5.3', name: 'GLM-5.3', credits: 'x0.79' },
  { id: 'hy3', name: 'Hy3', credits: 'x0.00' },
  { id: 'hy4-preview', name: 'Hy4 preview', credits: 'x0.29' },
  { id: 'deepseek-v4.1-flash', name: 'Deepseek-V4.1-Flash', credits: 'x0.11' },
  { id: 'space-bunny', name: 'Space-Bunny', credits: 'x1.00' },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', credits: 'x0.52' },
]
const realModels = REAL_MODELS.map((m) => ({ ...m }))
/**
 * Drive the **production** path, not a re-implementation of it.
 *
 * An earlier version of this section picked the active activity *inside the
 * test*, mirroring what `parsePromotions` was supposed to do — so the guard was
 * vacuous: reverting the production selection to priority-only still passed.
 * Now the selection under test IS `parsePromotions`, and the tie-break it
 * implements is the thing asserted.
 */
function realRowAt(id, now) {
  const base = realModels.find((m) => m.id === id)
  if (base === undefined) return undefined
  const promotions = buddy.parsePromotions(realConfig, now)
  const tiers = buddy.parseModelTiers(realConfig, now)
  return row({
    ...base,
    ...promotions.get(id) === undefined ? {} : { promotion: promotions.get(id).promo },
    ...tiers.get(id) === undefined ? {} : { modelTier: tiers.get(id) },
  }, now)
}

console.log('')
console.log('── 真身数据（.workbuddy/acc-product-config-v3.json）──')
{
  // 0. parsePromotions itself must pick the activity that is ACTIVE now, not
  //    merely the highest priority. glm-5.2 has night(100) + day(50) with
  //    non-overlapping windows; a priority-only rule loses the daytime one.
  const night = buddy.parsePromotions(realConfig, NIGHT).get('glm-5.2')
  const day = buddy.parsePromotions(realConfig, DAY).get('glm-5.2')
  check('parsePromotions 夜间选中带折扣那条（priority 100）',
    night?.promo?.id === 'glm-52-night-discount-202607', JSON.stringify(night?.promo?.id))
  check('parsePromotions 白天选中挂标那条（priority 50，过去被 100 压掉）',
    day?.promo?.id === 'glm-52-night-discount-daytime-badge-202607', JSON.stringify(day?.promo?.id))
  const hy4day = buddy.parsePromotions(realConfig, DAY).get('hy4-preview')
  check('parsePromotions 白天为 hy4 选中「白天挂标」那条',
    hy4day?.promo?.id === 'hy4-night-discount-badge-202609', JSON.stringify(hy4day?.promo?.id))
  // A badge-only activity has no price → no rate may be invented for it.
  check('白天那条无 discount → rate 必须为 null（不得编造折扣价）',
    day?.rate === null, JSON.stringify(day?.rate))
}
{
  // 1. daytime badge: the complementary pair must keep a badge during the day.
  const night = realRowAt('glm-5.2', NIGHT)
  const day = realRowAt('glm-5.2', DAY)
  check('glm-5.2 夜间命中带折扣的那条（strikethrough 双段价）',
    night?.badge?.id === 'glm-52-night-discount-202607' && night?.badge?.displayMode === 'strikethrough',
    JSON.stringify(night?.badge))
  check('glm-5.2 白天仍挂「夜间折扣」标（过去整条消失）',
    day?.badge?.badgeLabel === '夜间折扣' && day?.badge?.id === 'glm-52-night-discount-daytime-badge-202607',
    JSON.stringify(day?.badge))
  check('glm-5.2 白天那条不带价格（它本就没有 discount）',
    day?.badge?.price === undefined && day?.badge?.displayMode === undefined,
    JSON.stringify(day?.badge?.price))
}
{
  // 2. cross-midnight window split into two slots survives as an array.
  const night = realRowAt('hy4-preview', NIGHT)
  check('hy4 跨零点窗口保留两段（23:00-23:59 + 0:00-8:00），不压成字符串',
    Array.isArray(night?.badge?.windows) && night.badge.windows.length === 2
      && night.badge.windows[0].start === '23:00' && night.badge.windows[0].end === '23:59'
      && night.badge.windows[1].start === '0:00' && night.badge.windows[1].end === '8:00',
    JSON.stringify(night?.badge?.windows))
  check('hy4 夜间 tag = 夜间免费（上游标签，非自编状态词）',
    night?.badge?.badgeLabel === '夜间免费', JSON.stringify(night?.badge?.badgeLabel))
  const day = realRowAt('hy4-preview', DAY)
  check('hy4 白天仍挂「夜间免费」标（8:00-23:00 那条）',
    day?.badge?.badgeLabel === '夜间免费' && day?.badge?.price === undefined,
    JSON.stringify(day?.badge))
}
{
  // 3. hy3: date-only free campaign, badge.display = activeOnly, replace mode.
  const r = realRowAt('hy3', DAY)
  check('hy3 带 badgeDisplay=activeOnly（仅在活动生效时显示）',
    r?.badge?.badgeDisplay === 'activeOnly', JSON.stringify(r?.badge?.badgeDisplay))
  check('hy3 用上游标签「限时免费」+ replace 模式',
    r?.badge?.badgeLabel === '限时免费' && r?.badge?.displayMode === 'replace', JSON.stringify(r?.badge))
}
{
  // 4. deepseek: badge-only daytime activity, upstream's own inconsistency passed through.
  const r = realRowAt('deepseek-v4.1-flash', DAY)
  check('deepseek-v4.1-flash 拿到「夜间折扣」标（过去完全没有）',
    r?.badge?.badgeLabel === '夜间折扣', JSON.stringify(r?.badge))
  check('deepseek hover 原样透传上游那句（含其自身的不一致）',
    r?.badge?.hoverText === '周一至周五 09:00–12:00、14:00–18:00 属高峰原价，非高峰期积分5折',
    JSON.stringify(r?.badge?.hoverText))
  check('deepseek 那条无价格 → 不得编造 price/status',
    r?.badge?.price === undefined && r?.badge?.status === undefined, JSON.stringify(r?.badge))
}
{
  // 5. modelTiers — a separate source that never produced a badge before.
  const r = realRowAt('glm-5.3', DAY)
  check('glm-5.3 从 modelTiers 拿到「订阅优先」标（第二套来源）',
    r?.badge?.badgeLabel === '订阅优先' && r?.badge?.kind === 'tier', JSON.stringify(r?.badge))
  check('档位标不带价格/状态词（它是调度优先级，不是折扣）',
    r?.badge?.price === undefined && r?.badge?.status === undefined && r?.badge?.displayMode === undefined,
    JSON.stringify(r?.badge))
  check('档位标带 tier / requiredUserType / 升级动作',
    r?.badge?.tier === 'standard' && r?.badge?.requiredUserType === 'standard'
      && r?.badge?.hoverActionLabel === '去升级',
    JSON.stringify(r?.badge))
}
{
  // 6. a model that hits neither source must stay clean.
  const r = realRowAt('kimi-k2.6', DAY)
  check('kimi-k2.6 无任何活动 → 无徽标', r?.badge === undefined, JSON.stringify(r?.badge))
}

// 4. the shipped bundle must be in sync with this source.
//    Editing `buddy.ts` and forgetting `node scripts/build-channel-pack.mjs` is
//    exactly how a "fixed" wording never reaches the settings page: the host
//    reads `pack.js`, not the TypeScript. esbuild escapes non-ASCII, so the
//    needles are the \u-escaped forms.
{
  const bundle = readFileSync(path.join(repoRoot, 'vendor/channel-pack/pack.js'), 'utf8')
  check('pack.js carries the rebuilt note builder (错峰时段)',
    bundle.includes('\\u9519\\u5CF0\\u65F6\\u6BB5${slots.join("/")}'),
    'rebuild it: node scripts/build-channel-pack.mjs && node scripts/build-standalone-channels.mjs')
  check('pack.js has no stale wording (夜间/限至)',
    !bundle.includes('\\u591C\\u95F4') && !bundle.includes('\\u9650\\u81F3'),
    'the bundle still carries the pre-rewrite annotation')
}

// ── emit visual snapshot (the "screenshot") ─────────────────────────────────
function snapshotRows(now) {
  const all = models.map((m) => row(m, now))
  return all.map((r) => `
    <li class="model-row">
      <span class="model-name">${r.name.replace(/[<>]/g, '')}</span>
      ${r.description ? `<span class="model-badge" title="${r.description.replace(/[<>"]/g, '')}">${r.description.replace(/[<>]/g, '')}</span>` : ''}
    </li>`).join('\n')
}
const html = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<title>促销价渲染快照 · e2e</title>
<style>
  body { font: 14px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background:#0f1115; color:#e6e6e6; padding:24px; }
  h2 { font-weight:600; }
  .panel { background:#1a1d23; border:1px solid #2a2e37; border-radius:10px; padding:14px 16px; margin:12px 0; max-width:560px; }
  .model-row { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:8px; background:#21252e; margin:8px 0; }
  .model-name { font-weight:600; color:#fff; flex:1; min-width:0; }
  .model-badge { font-size:10px; padding:1px 7px; border-radius:999px; white-space:nowrap;
    color:#7aa2ff; border:1px solid rgba(122,162,255,.55); }
  .tag { color:#ffd479; }
</style></head><body>
  <h2>模型选择器渲染快照（促销价 e2e · 含徽标）</h2>
  <div class="panel"><b>夜间 23:30 (Asia/Shanghai)</b><ul style="list-style:none;padding:0;margin:0">
    ${snapshotRows(NIGHT)}
  </ul></div>
  <div class="panel"><b>白天 12:00 (Asia/Shanghai)</b><ul style="list-style:none;padding:0;margin:0">
    ${snapshotRows(DAY)}
  </ul></div>
  <p style="color:#8a8f98">倍率与状态词按<strong>当前时刻实时</strong>推算；长标注（活动截止日 + 时段窗口）渲染为<strong>徽标胶囊</strong>（本插件自绘 CSS，不依赖宿主透传），不塞进模型名。</p>
</body></html>`
const outHtml = path.join(repoRoot, 'scripts', 'promo-render.html')
writeFileSync(outHtml, html)
console.log(`\nwrote ${path.relative(repoRoot, outHtml)} (visual snapshot)`)

console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`)
process.exit(failures === 0 ? 0 : 1)
