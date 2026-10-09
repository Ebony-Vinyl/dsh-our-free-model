/**
 * TRAE 促销探针 —— 验证 `traePromoBadge` 按 TRAE 自己的上游结构产出 `promo`。
 *
 * 为什么单起一条：TRAE 与 buddy / qoder 共用同一个契约，但上游结构第三种
 * （`activity_discount` 藏在 `display_contact_config` 这个 **JSON 字符串**里，
 * 需二次 parse）。共享探针驱动的是 buddy 的生产端，覆盖不到这里。
 *
 * 本探针走**完整解析链**：喂一份上游 wire 形态的 body → `parseTraeModelList`
 * → `traePromoBadge`。这样"折扣在解析层被判为不生效"与"徽标不渲染"两件事
 * 一起被验证，而不是只测后半段。
 *
 * 覆盖 TRAE 特有的坑（均在源码注释里标为实测）：
 *   - `discount_type: "none"` 且 before === after（off_peak 无折扣态）→ **无徽标**
 *     （照显会得到 `x0.13→x0.13` 这种假活动）；
 *   - `limited` 型带 `end_at` → `validUntil`；`off_peak` 型没有窗口 → 不编造；
 *   - 免费（rate 0）→ `x0.80→x0`；
 *   - 已过期的 `end_at` → 无徽标（解析层已排除）。
 *
 * Run: node scripts/promo-trae-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('..', import.meta.url)))

const require = (await import('node:module')).createRequire(import.meta.url)
const esbuildPath = require.resolve('esbuild', {
  paths: [process.env.OF_ESBUILD_DIR, process.env.OFM_ESBUILD_DIR, process.cwd(), repoRoot].filter(Boolean),
})
const esbuild = await import(pathToFileURL(esbuildPath).href)
const built = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'vendor/channel-pack/src/trae-adapter.ts')],
  bundle: true, format: 'esm', platform: 'node', target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*'], write: false, logLevel: 'warning',
  banner: {
    js: [
      "import { createRequire as __ofmCreateRequire } from 'node:module'",
      'const require = __ofmCreateRequire(import.meta.url)',
    ].join('\n'),
  },
})
const tmpDir = mkdtempSync(path.join(repoRoot, '.ofm-trae-'))
// Clean up even when a check throws (an uncaught error skips the tail of the
// script and leaves a scratch dir in the repo, polluting `git status`).
process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })
const tmp = path.join(tmpDir, 'trae.mjs')
writeFileSync(tmp, built.outputFiles[0].text)
const traeAdapter = await import(pathToFileURL(tmp).href)
// `parseTraeModelList` lives in trae.ts, not the adapter — bundle the parser too.
const built2 = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'vendor/channel-pack/src/trae.ts')],
  bundle: true, format: 'esm', platform: 'node', target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*'], write: false, logLevel: 'warning',
  banner: {
    js: [
      "import { createRequire as __ofmCreateRequire } from 'node:module'",
      'const require = __ofmCreateRequire(import.meta.url)',
    ].join('\n'),
  },
})
const tmp2 = path.join(tmpDir, 'trae-parse.mjs')
writeFileSync(tmp2, built2.outputFiles[0].text)
const trae = await import(pathToFileURL(tmp2).href)

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log(`ok  ${label}`) }
  else { failures++; console.error(`FAIL ${label} — ${detail}`) }
}

/**
 * One upstream config entry. `display_contact_config` is a JSON **string** on the
 * wire (the adapter double-parses it) — encoding it that way here is what makes
 * this a wire-shape test rather than an object-shape one.
 *
 * The fixture shapes below are transcribed VERBATIM from a real capture of
 * `batch_get_detail_param` (605 entries, 2026-10-09): both discount blocks, the
 * `subKey` values, `time_windows` in minutes, and the member block's
 * `original_consumption_rate` / `is_discount_matched` fields.
 */
function entry(id, { rate, activityDiscount, memberDiscount } = {}) {
  const contact = {
    ...rate === undefined ? {} : { consumption_rate: { enable: true, data: { rate } } },
    ...activityDiscount === undefined ? {} : { activity_discount: activityDiscount },
    ...memberDiscount === undefined ? {} : { discount: memberDiscount },
  }
  return {
    config_name: id,
    display_config: { display_name: id, multimodal: false },
    config_switch: true,
    usage: 'chat_completion',
    display_contact_config: JSON.stringify(contact),
  }
}
const parseOne = (e) => trae.parseTraeModelList({ config_info_list: [e] })[0]

const NOW_SEC = Math.floor(new Date('2026-10-09T12:00:00+08:00').getTime() / 1000)

/** The two off-peak windows the server actually sends (00:00-08:00 + 22:00-24:00). */
const OFF_PEAK_WINDOWS = [
  { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 480 },
  { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 1320, end_minute: 1440 },
]

{
  // 1. off_peak (DeepSeek-V4-Pro, real): current is `none` (outside the window),
  //    the real discount lives in `data.off_peak` → badge with window + dual price.
  const model = parseOne(entry('DeepSeek-V4-Pro', {
    rate: 0.72,
    activityDiscount: {
      enable: true, subKey: 'off_peak_discount',
      data: {
        current: { discount_type: 'none', before_consumption_rate: 0.72, consumption_rate: 0.72, discount: 100 },
        off_peak: { before_consumption_rate: 0.72, after_consumption_rate: 0.36, discount: 50, time_windows: OFF_PEAK_WINDOWS },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('off_peak 有徽标（current=none 也不能挡，折扣在 data.off_peak 里）',
    badge !== undefined, JSON.stringify(badge))
  check('off_peak 双段价 = x0.72→x0.36（窗口定义价）',
    badge?.price?.original === 'x0.72' && badge?.price?.effective === 'x0.36', JSON.stringify(badge?.price))
  check('off_peak 时段窗口转成 HH:MM（00:00-08:00/22:00-24:00）',
    Array.isArray(badge?.windows) && badge.windows.length === 2
      && badge.windows[0].start === '00:00' && badge.windows[0].end === '08:00'
      && badge.windows[1].start === '22:00' && badge.windows[1].end === '24:00',
    JSON.stringify(badge?.windows))
  check('off_peak 标签 = 闲时折扣', badge?.badgeLabel === '闲时折扣', JSON.stringify(badge?.badgeLabel))
  check('off_peak 无 end_at → 不得编造 validUntil', badge?.validUntil === undefined, JSON.stringify(badge?.validUntil))
  // ⚠️ `current` said `none`, so the cut is NOT applied right now: the pill must
  // grey out. An un-greyed `x0.72→x0.36` reads as "I pay 0.36 now" while the
  // server bills 0.72 — the exact failure this repo has fought repeatedly.
  check('off_peak 时段外 → active=false / 常时（灰显，不得按折后价预期）',
    badge?.active === false && badge?.status === '常时',
    JSON.stringify({ active: badge?.active, status: badge?.status }))
}
{
  // 1b. the SAME activity inside its window: `current` carries a real cut, so
  //     the pill is NOT greyed. Both halves must be asserted or a parser that
  //     always greys (or never greys) would pass.
  const model = parseOne(entry('DeepSeek-V4-Pro-in', {
    rate: 0.36,
    activityDiscount: {
      enable: true, subKey: 'off_peak_discount',
      data: {
        current: { discount_type: 'off_peak', before_consumption_rate: 0.72, consumption_rate: 0.36, discount: 50 },
        off_peak: { before_consumption_rate: 0.72, after_consumption_rate: 0.36, discount: 50, time_windows: OFF_PEAK_WINDOWS },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('off_peak 时段内（current 真降价）→ active=true / 错峰',
    badge?.active === true && badge?.status === '错峰',
    JSON.stringify({ active: badge?.active, status: badge?.status }))
}
{
  // 2. off_peak_member (DeepSeek-V4.1-Flash, real): a `member` block sits beside
  //    `off_peak`; the current window price wins for display.
  const model = parseOne(entry('deepseek-v4.1-flash', {
    rate: 0.15,
    activityDiscount: {
      enable: true, subKey: 'off_peak_member_discount',
      data: {
        current: { discount_type: 'none', before_consumption_rate: 0.15, consumption_rate: 0.15, discount: 100 },
        member: { before_consumption_rate: 0.15, after_consumption_rate: 0.08, discount: 50 },
        off_peak: { before_consumption_rate: 0.15, after_consumption_rate: 0.08, discount: 50, time_windows: OFF_PEAK_WINDOWS },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('off_peak_member 标签 = 闲时折扣（给非会员看的那档）',
    badge?.badgeLabel === '闲时折扣', JSON.stringify(badge?.badgeLabel))
  check('off_peak_member 双段价 = x0.15→x0.08',
    badge?.price?.original === 'x0.15' && badge?.price?.effective === 'x0.08', JSON.stringify(badge?.price))
}
{
  // 3. limited (Seed-Evolving, real): `current` IS active here, plus end_at.
  const endsAt = NOW_SEC + 86400
  const model = parseOne(entry('Seed-Evolving', {
    rate: 0.08,
    activityDiscount: {
      enable: true, subKey: 'limited_discount',
      data: {
        current: { discount_type: 'limited', before_consumption_rate: 0.8, consumption_rate: 0.08, discount: 10 },
        limited: { before_consumption_rate: 0.8, after_consumption_rate: 0.08, discount: 10, end_at: endsAt },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('limited 型把 end_at 带成 validUntil',
    typeof badge?.validUntil === 'string' && Date.parse(badge.validUntil) === endsAt * 1000,
    JSON.stringify(badge?.validUntil))
  check('limited 型双段价 = x0.8→x0.08（0.8→0.08 = 1 折）',
    badge?.price?.original === 'x0.8' && badge?.price?.effective === 'x0.08', JSON.stringify(badge?.price))
  check('limited 标签 = 限时1折', badge?.badgeLabel === '限时1折', JSON.stringify(badge?.badgeLabel))
}
{
  // 4. subsidy_member (Doubao-Seed-2.1-Turbo, real): current IS active (subsidy
  //    applies now), `member` block holds the member-only price.
  const model = parseOne(entry('Doubao-Seed-2.1-Turbo', {
    rate: 0.2,
    activityDiscount: {
      enable: true, subKey: 'subsidy_member_discount',
      data: {
        current: { discount_type: 'subsidy', before_consumption_rate: 0.4, consumption_rate: 0.2, discount: 50 },
        member: { before_consumption_rate: 0.4, after_consumption_rate: 0.1, discount: 25 },
        subsidy: { before_consumption_rate: 0.4, after_consumption_rate: 0.2, discount: 50 },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('subsidy_member 标签 = 专属补贴（豆包那条）', badge?.badgeLabel === '专属补贴',
    JSON.stringify(badge?.badgeLabel))
  check('subsidy_member 双段价取 current（x0.4→x0.2，当前生效的补贴价）',
    badge?.price?.original === 'x0.4' && badge?.price?.effective === 'x0.2', JSON.stringify(badge?.price))
}
{
  // 5. member_discount (GLM-5.2, real): the SECOND block, `discount`, with
  //    `is_discount_matched: false` (this account is NOT a member).
  const model = parseOne(entry('glm-5.2', {
    rate: 0.78,
    memberDiscount: {
      enable: true, subKey: 'member_discount',
      data: { original_consumption_rate: 0.78, consumption_rate: 0.39, member_discount: 50, is_discount_matched: false },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('member_discount 有徽标（is_discount_matched:false 不阻止展示）',
    badge !== undefined, JSON.stringify(badge))
  check('member_discount 标签 = 会员5折（0.78→0.39 反推）', badge?.badgeLabel === '会员5折',
    JSON.stringify(badge?.badgeLabel))
  check('member_discount 双段价 = x0.78→x0.39（member 块的 original_consumption_rate）',
    badge?.price?.original === 'x0.78' && badge?.price?.effective === 'x0.39', JSON.stringify(badge?.price))
  check('member_discount 无时段窗口（不是时段类活动）', badge?.windows === undefined, JSON.stringify(badge?.windows))
  // ⚠️ `is_discount_matched: false` = 当前账号拿不到这个价（实付 0.78）。徽标照挂
  // （官方也挂，文案本就是"升级会员享…"），但**必须灰显** —— 否则会被读成
  // "我现在付 0.39"。
  check('member 未匹配（is_discount_matched:false）→ active=false / 常时',
    badge?.active === false && badge?.status === '常时',
    JSON.stringify({ active: badge?.active, status: badge?.status }))
}
{
  // The same block with the account matched: the cut really applies → not greyed.
  const model = parseOne(entry('glm-matched', {
    rate: 0.39,
    memberDiscount: {
      enable: true, subKey: 'member_discount',
      data: { original_consumption_rate: 0.78, consumption_rate: 0.39, member_discount: 50, is_discount_matched: true },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('member 已匹配 → active=true / 错峰', badge?.active === true && badge?.status === '错峰',
    JSON.stringify({ active: badge?.active, status: badge?.status }))
}
{
  // 6. expired campaign → parser drops it, so no badge.
  const model = parseOne(entry('expired', {
    rate: 0.2,
    activityDiscount: {
      enable: true, subKey: 'limited_discount',
      data: {
        current: { discount_type: 'limited', before_consumption_rate: 1.0, consumption_rate: 0.2, discount: 20 },
        limited: { before_consumption_rate: 1.0, after_consumption_rate: 0.2, discount: 20, end_at: NOW_SEC - 86400 },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('已过期活动 → 无徽标（不得按折扣价预期）', badge === undefined, JSON.stringify(badge))
}
{
  // 7. No discount block at all → no badge key.
  const model = parseOne(entry('plain', { rate: 0.5 }))
  check('无折扣块 → 不产出 promo', traeAdapter.traePromoBadge(model) === undefined, 'expected undefined')
}
{
  // 8. enable:false → 无徽标.
  const model = parseOne(entry('disabled', {
    rate: 0.5,
    activityDiscount: { enable: false, subKey: 'off_peak_discount', data: { off_peak: { before_consumption_rate: 0.5, after_consumption_rate: 0.25, time_windows: OFF_PEAK_WINDOWS } } },
  }))
  check('enable:false → 无徽标', traeAdapter.traePromoBadge(model) === undefined, 'expected undefined')
}
{
  // 9. 倍率推不出整数折 → 不给标签，不编造「1.9折」（官方 {fold} 是运营配的整数）。
  const model = parseOne(entry('odd-fold', {
    rate: 0.15,
    memberDiscount: {
      enable: true, subKey: 'member_discount',
      data: { original_consumption_rate: 0.8, consumption_rate: 0.15, member_discount: 19, is_discount_matched: false },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('member 推不出整数折（0.8→0.15）→ 不给标签，但徽标仍出（靠双段价）',
    badge?.badgeLabel === undefined && badge?.price?.original === 'x0.8', JSON.stringify(badge))
}
{
  // 10. 未知 subKey → 不猜标签，但仍按普通折扣渲染.
  const model = parseOne(entry('future-kind', {
    rate: 0.3,
    activityDiscount: { enable: true, subKey: 'brand_new_discount', data: { brand_new: { before_consumption_rate: 0.6, after_consumption_rate: 0.3 } } },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('未知 subKey → 不给标签（宁可没有，也不编官方没说的说法）',
    badge?.badgeLabel === undefined, JSON.stringify(badge?.badgeLabel))
  check('未知 subKey 仍按普通折扣渲染（有双段价）', badge?.price?.original === 'x0.6', JSON.stringify(badge?.price))
}
{
  // 11. 免费折后价（after=0）→ 写作 x0.
  const model = parseOne(entry('free-after', {
    rate: 0,
    activityDiscount: {
      enable: true, subKey: 'limited_discount',
      data: {
        current: { discount_type: 'limited', before_consumption_rate: 0.5, consumption_rate: 0, discount: 0 },
        limited: { before_consumption_rate: 0.5, after_consumption_rate: 0, discount: 0, end_at: NOW_SEC + 86400 },
      },
    },
  }))
  const badge = traeAdapter.traePromoBadge(model)
  check('折后价为 0 → effective 写作 x0（不是 x0.00 或省略）',
    badge?.price?.effective === 'x0' && badge?.price?.original === 'x0.5', JSON.stringify(badge?.price))
  check('折后价为 0 → 标签「限时免费」', badge?.badgeLabel === '限时免费', JSON.stringify(badge?.badgeLabel))
}

// The shipped bundle must carry this producer.
{
  const pack = readFileSync(path.join(repoRoot, 'vendor/channel-pack/pack.js'), 'utf8')
  check('pack.js 里有 trae 的促销生产者（已重新打包）',
    pack.includes('traePromoBadge'), 'run: node scripts/build-channel-pack.mjs')
}

rmSync(tmpDir, { recursive: true, force: true })

if (failures === 0) {
  console.log('\nALL PASS — trae promo producer honours its own upstream shape')
  process.exit(0)
}
console.error(`\n${failures} FAILURE(S)`)
process.exit(1)
