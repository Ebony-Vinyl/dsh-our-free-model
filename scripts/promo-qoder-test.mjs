/**
 * Qoder 促销探针 —— 验证 `qoderPromoBadge` 按 Qoder 自己的语义产出独立 `promo`。
 *
 * 为什么单独一条：buddy 与 qoder 是**同一契约、各自生产**（上游结构不同：
 * buddy 是 `modelPromotions[].discount.factor` + `daily[]`，qoder 是单条
 * `promotion.discountFactor` + `windowStart/windowEnd`）。共享的 `promo-buddy-test`
 * 驱动的是 buddy 的生产端，覆盖不到这里的翻译逻辑，故单起一条。
 *
 * 覆盖 Qoder 特有的三件事：
 *   1. `active` 必须**本地按窗口推算**，不能用目录快照（快照会过期）；
 *   2. 双段价格取 `beforePromotionPriceFactor`，且**两端相同就不给 original**；
 *   3. `badgeZh`（上游角标「错峰 4 折」）映射到 `badgeLabel`；免费模型优先「免费」。
 *
 * Run: node scripts/promo-qoder-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEsbuildOrSkip, ESM_REQUIRE_BANNER } from './lib/esbuild-loader.mjs'

const repoRoot = path.join(fileURLToPath(new URL('..', import.meta.url)))

// ── load the REAL source (not a copy of its logic) ───────────────────────────
const esbuild = await loadEsbuildOrSkip('promo-qoder-test')
const built = await esbuild.build({
  entryPoints: [path.join(repoRoot, 'vendor/channel-pack/src/qoder-adapter.ts')],
  bundle: true, format: 'esm', platform: 'node', target: ['node22'],
  external: ['@deepseek-ai/*', 'node:*'], write: false, logLevel: 'warning',
  banner: { js: ESM_REQUIRE_BANNER },
})
const tmpDir = mkdtempSync(path.join(repoRoot, '.ofm-qoder-'))
// Clean up even when a check throws (an uncaught error skips the tail of the
// script and leaves a scratch dir in the repo, polluting `git status`).
process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })
const tmp = path.join(tmpDir, 'qoder.mjs')
writeFileSync(tmp, built.outputFiles[0].text)
const qoder = await import(pathToFileURL(tmp).href)

// ── assertions ───────────────────────────────────────────────────────────────
let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log(`ok  ${label}`) }
  else { failures++; console.error(`FAIL ${label} — ${detail}`) }
}

// The models below mirror `qoder-product.ts`'s real fallback table verbatim
// (qmodel_38max = 4折, qmodel_latest = 2折, qfmodel = free, kmodel = no promo).
const DEEP_NIGHT = new Date('2026-10-09T23:30:00+08:00') // inside 22:00-08:00
const DAYTIME = new Date('2026-10-09T12:00:00+08:00') // outside

const MAX_PROMO = {
  active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5,
  windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折',
}
const LATE_PROMO = {
  active: true, discountFactor: 0.2, beforePromotionPriceFactor: 0.5,
  windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 2 折',
}

{
  // 1. inside the window: dual price = before → before*discount, 错峰 label.
  const badge = qoder.qoderPromoBadge(
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', priceFactor: 0.2, promotion: MAX_PROMO },
    DEEP_NIGHT,
  )
  check('窗口内 active=true（本地推算，非快照）', badge?.active === true, JSON.stringify(badge))
  check('窗口内双段价 = x0.5→x0.2（原价 before，折后 before×discount）',
    badge?.price?.original === 'x0.5' && badge?.price?.effective === 'x0.2', JSON.stringify(badge?.price))
  check('窗口内状态词 = 错峰', badge?.status === '错峰', JSON.stringify(badge?.status))
  check('badgeZh 映射到 badgeLabel（上游角标「错峰 4 折」）',
    badge?.badgeLabel === '错峰 4 折', JSON.stringify(badge?.badgeLabel))
  check('时段保留数组形态（与 buddy 契约统一）',
    Array.isArray(badge?.windows) && badge.windows.length === 1
      && badge.windows[0].start === '22:00' && badge.windows[0].end === '08:00',
    JSON.stringify(badge?.windows))
}
{
  // 2. OUTSIDE the window: the discount must NOT apply; price is the list price.
  const badge = qoder.qoderPromoBadge(
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', priceFactor: 0.2, promotion: MAX_PROMO },
    DAYTIME,
  )
  check('窗口外 active=false', badge?.active === false, JSON.stringify(badge))
  check('窗口外不给错误的折后价（effective = 原价 x0.5）',
    badge?.price?.effective === 'x0.5', JSON.stringify(badge?.price))
  check('窗口外无 original（两端同值不带）',
    badge?.price?.original === undefined, JSON.stringify(badge?.price))
  check('窗口外状态词 = 常时', badge?.status === '常时', JSON.stringify(badge?.status))
}
{
  // 3. 2折 model — the arrow must reflect ITS discount, not a shared constant.
  const badge = qoder.qoderPromoBadge(
    { id: 'qmodel_latest', name: 'Qwen3.7-Max', priceFactor: 0.1, promotion: LATE_PROMO },
    DEEP_NIGHT,
  )
  check('2 折模型窗口内 = x0.5→x0.1',
    badge?.price?.original === 'x0.5' && badge?.price?.effective === 'x0.1', JSON.stringify(badge?.price))
}
{
  // 4. free model: priceFactor 0 wins over the upstream badge text.
  const badge = qoder.qoderPromoBadge(
    { id: 'qfmodel', name: 'Qwen3.8-Flash', priceFactor: 0, originalPriceFactor: 0.1 },
    DAYTIME,
  )
  check('无 promotion 的免费模型 → 无徽标（促销只由 promotion 产生）',
    badge === undefined, JSON.stringify(badge))
}
{
  // 5. no promotion at all → no badge key (omitted, not null).
  const badge = qoder.qoderPromoBadge({ id: 'kmodel', name: 'Kimi-K2.8-Preview', priceFactor: 0.8 }, DAYTIME)
  check('无促销的模型不产出 promo', badge === undefined, JSON.stringify(badge))
}
{
  // 6. snapshot `active` must NOT override a window that says otherwise —
  //    the catalogue flag goes stale, the window does not.
  const staleSnapshot = {
    active: true, discountFactor: 0.4, beforePromotionPriceFactor: 0.5,
    windowStart: '22:00', windowEnd: '08:00', badgeZh: '错峰 4 折',
  }
  const badge = qoder.qoderPromoBadge(
    { id: 'qmodel_38max', name: 'Qwen3.8-Max', priceFactor: 0.2, promotion: staleSnapshot },
    DAYTIME,
  )
  check('目录快照 active=true 但当前是白天 → 仍按窗口判为不在窗口内',
    badge?.active === false, JSON.stringify(badge))
}

for (const [name, expected] of [
  ['qoderPromoBadge', 'function'],
]) {
  check(`qoder-adapter exports ${name} as a ${expected}`, typeof qoder[name] === expected, typeof qoder[name])
}

// The bundle the host actually loads must carry this producer too.
{
  const pack = readFileSync(path.join(repoRoot, 'vendor/channel-pack/pack.js'), 'utf8')
  check('pack.js 里有 qoder 的促销生产者（已重新打包）',
    pack.includes('qoderPromoBadge'), 'run: node scripts/build-channel-pack.mjs')
}

rmSync(tmpDir, { recursive: true, force: true })

if (failures === 0) {
  console.log('\nALL PASS — qoder promo producer honours its own upstream shape')
  process.exit(0)
}
console.error(`\n${failures} FAILURE(S)`)
process.exit(1)
