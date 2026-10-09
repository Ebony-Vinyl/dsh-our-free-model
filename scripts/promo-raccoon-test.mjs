/**
 * Raccoon（小浣熊）促销探针 —— 验证 `raccoonPromoBadge` 按网关自己的计费字段产出 `promo`。
 *
 * 为什么单起一条：Raccoon 是第四个生产者，上游结构第四种——网关**同时下发**
 * 原价与生效价，还带一个自由文本状态说明：
 *
 * ```json
 * { "name": "glm-5-3", "billing_status": "discount" | "limited_free" | "normal",
 *   "billing_multiplier": 0.5, "billing_effective_multiplier": 0.25,
 *   "billing_status_note": "限免一个月" }
 * ```
 *
 * 本探针走**完整解析链**：喂网关 wire 形态的 payload → `parseRaccoonModelCatalog`
 * → `raccoonPromoBadge`，验证"解析层是否把 billing 带出来"与"徽标是否该画"两件事。
 *
 * 覆盖的三个判据（源码注释里逐条给了理由）：
 *   - `status: "normal"` → **无徽标**（不能把常态说成活动）；
 *   - 两端同价（`discount` 但无实际降价）→ **无徽标**（否则是 `x0.5→x0.5` 假折扣）；
 *   - `limited_free` + 生效价 0 → `x0→`，状态词「限免」；
 *   - 网关**不下发时段**，`billing_status_note` 是自由文本 → 进 `hoverText`，
 *     且**不得编造** `windows` / `validUntil`。
 *
 * Run: node scripts/promo-raccoon-test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEsbuildOrSkip, ESM_REQUIRE_BANNER } from './lib/esbuild-loader.mjs'

const repoRoot = path.join(fileURLToPath(new URL('..', import.meta.url)))

const esbuild = await loadEsbuildOrSkip('promo-raccoon-test')

/** Bundle a pack module for import (same banner the real pack build uses). */
async function loadModule(relPath, name) {
  const built = await esbuild.build({
    entryPoints: [path.join(repoRoot, 'vendor/channel-pack/src', relPath)],
    bundle: true, format: 'esm', platform: 'node', target: ['node22'],
    external: ['@deepseek-ai/*', 'node:*'], write: false, logLevel: 'warning',
    banner: { js: ESM_REQUIRE_BANNER },
  })
  const file = path.join(tmpDir, name)
  writeFileSync(file, built.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

const tmpDir = mkdtempSync(path.join(repoRoot, '.ofm-raccoon-'))
// Clean up even when a check throws (an uncaught error skips the tail of the
// script and leaves a scratch dir in the repo, polluting `git status`).
process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })
const raccoon = await loadModule('raccoon.ts', 'raccoon.mjs')
const auth = await loadModule('raccoon-auth.ts', 'raccoon-auth.mjs')

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log(`ok  ${label}`) }
  else { failures++; console.error(`FAIL ${label} — ${detail}`) }
}

/** One gateway entry; wrap in the envelope `parseRaccoonModelCatalog` expects. */
function catalogOne(entry) {
  return { code: 0, data: { categories: [{ type: 'chat', models: [entry] }] } }
}
function badgeFor(entry) {
  const models = auth.parseRaccoonModelCatalog(catalogOne(entry))
  const meta = models[0]?.meta
  return { model: models[0], badge: meta === undefined ? undefined : raccoon.raccoonPromoBadge(meta) }
}

{
  // 1. discount: both ends present → dual price, note → hoverText.
  const { badge } = badgeFor({
    name: 'glm-5-3', description: 'GLM-5-3',
    billing_status: 'discount', billing_multiplier: 0.5, billing_effective_multiplier: 0.25,
    billing_status_note: '限时 5 折',
  })
  check('discount → 双段价 x0.5→x0.25',
    badge?.price?.original === 'x0.5' && badge?.price?.effective === 'x0.25', JSON.stringify(badge?.price))
  check('状态说明进 hoverText（自由文本原文）',
    badge?.hoverText === '限时 5 折', JSON.stringify(badge?.hoverText))
  check('非免费折扣 → 状态词「错峰」', badge?.status === '错峰', JSON.stringify(badge?.status))
  check('网关不下发时段 → 不得编造 windows/validUntil',
    badge?.windows === undefined && badge?.validUntil === undefined, JSON.stringify(badge))
  check('kind=discount / active=true', badge?.kind === 'discount' && badge?.active === true, JSON.stringify(badge))
}
{
  // 2. limited_free with effective 0 → x0, 限免.
  const { badge } = badgeFor({
    name: 'sn-sensenova-6-8-flash', description: 'SenseNova-6.8-Flash',
    billing_status: 'limited_free', billing_multiplier: 1, billing_effective_multiplier: 0,
    billing_status_note: '限免一个月',
  })
  check('limited_free 生效价 0 → x1→x0（折后价写作 x0）',
    badge?.price?.original === 'x1' && badge?.price?.effective === 'x0', JSON.stringify(badge?.price))
  check('免费促销 → 状态词「限免」', badge?.status === '限免', JSON.stringify(badge?.status))
  check('限免文案原样进 hoverText', badge?.hoverText === '限免一个月', JSON.stringify(badge?.hoverText))
}
{
  // 3. THE TRAP: status says discount but the two ends are EQUAL — no real cut.
  const { badge } = badgeFor({
    name: 'no-real-cut', description: 'No Real Cut',
    billing_status: 'discount', billing_multiplier: 0.5, billing_effective_multiplier: 0.5,
    billing_status_note: '占了位',
  })
  check('两端同价 → 无徽标（不得显示 x0.5→x0.5 假折扣）', badge === undefined, JSON.stringify(badge))
}
{
  // 4. normal rows are not promotions at all.
  const { badge } = badgeFor({
    name: 'glm-5-3', description: 'GLM-5-3',
    billing_status: 'normal', billing_multiplier: 1, billing_effective_multiplier: 1,
  })
  check('status=normal → 无徽标（常态不是活动）', badge === undefined, JSON.stringify(badge))
}
{
  // 5. missing billing fields entirely → no badge, no crash.
  const { badge, model } = badgeFor({ name: 'bare', description: 'Bare' })
  check('完全没有计费字段 → 无徽标', badge === undefined, JSON.stringify(badge))
  check('且模型本身仍被解析出来（不缺行）', model?.id === 'bare', JSON.stringify(model?.id))
}
{
  // 6. the raw meta must survive parsing (that is what makes the badge possible).
  const models = auth.parseRaccoonModelCatalog(catalogOne({
    name: 'glm-5-3', description: 'GLM-5-3',
    billing_status: 'discount', billing_multiplier: 0.5, billing_effective_multiplier: 0.25,
    billing_status_note: '限时 5 折',
  }))
  check('解析层把 billing meta 带出来了（不再只压进 name）',
    models[0]?.meta?.status === 'discount' && models[0]?.meta?.baseMultiplier === 0.5,
    JSON.stringify(models[0]?.meta))
  check('展示名仍是原来的形态（x0.5→x0.25，行为不变）',
    models[0]?.name === 'GLM-5-3 · x0.5→x0.25', JSON.stringify(models[0]?.name))
}

// The shipped bundle must carry this producer.
{
  const pack = readFileSync(path.join(repoRoot, 'vendor/channel-pack/pack.js'), 'utf8')
  check('pack.js 里有 raccoon 的促销生产者（已重新打包）',
    pack.includes('raccoonPromoBadge'), 'run: node scripts/build-channel-pack.mjs')
}

rmSync(tmpDir, { recursive: true, force: true })

if (failures === 0) {
  console.log('\nALL PASS — raccoon promo producer honours its own billing shape')
  process.exit(0)
}
console.error(`\n${failures} FAILURE(S)`)
process.exit(1)
