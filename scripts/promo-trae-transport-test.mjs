/**
 * TRAE 促销端到端探针 —— 复刻设置页读模型的那条路，找出 promo 为什么没到行上。
 *
 * ## 为什么要单起一条
 *
 * `promo-trae-test.mjs` 证明的是「解析 → `traePromoBadge`」这一段正确（24 项全过）。
 * 但用户页面上**看不到**促销，说明断点在别处。本探针把**整条链**接起来：
 *
 *     TraeAdapter（真实实例）
 *       ├─ listModels()      ← 异步，内部会 ensureRemoteModels()（真的去拉）
 *       └─ listAllModels()   ← **同步**，remoteModels 未填充时退回静态表
 *     → model.list 的投影（只搬 id/name/disabled/dead/isFree/promo）
 *     → 设置页的行
 *
 * 关键怀疑点：`model.list` 走的是 `listAllModels()`（同步、不触发拉取），
 * 而 `ensureRemoteModels()` 只在 `listModels()` 里被调用。若两者调用顺序不对，
 * 设置页拿到的就是**静态兜底表**——而 trae 的静态表里没有倍率、也没有促销。
 *
 * Run: node scripts/promo-trae-transport-test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('..', import.meta.url)))

// ── bundle the real sources ─────────────────────────────────────────────────
const require = (await import('node:module')).createRequire(import.meta.url)
const esbuildPath = require.resolve('esbuild', {
  paths: [process.env.OF_ESBUILD_DIR, process.env.OFM_ESBUILD_DIR, process.cwd(), repoRoot].filter(Boolean),
})
const esbuild = await import(pathToFileURL(esbuildPath).href)
const tmpDir = mkdtempSync(path.join(repoRoot, '.ofm-traet-'))
// Clean up even when a check throws (an uncaught error skips the tail of the
// script and leaves a scratch dir in the repo, polluting `git status`).
process.on('exit', () => { try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* best effort */ } })
const load = async (entry, name) => {
  const built = await esbuild.build({
    entryPoints: [path.join(repoRoot, entry)],
    bundle: true, format: 'esm', platform: 'node', target: ['node22'],
    external: ['@deepseek-ai/*', 'node:*'], write: false, logLevel: 'warning',
    banner: {
      js: [
        "import { createRequire as __ofmCreateRequire } from 'node:module'",
        'const require = __ofmCreateRequire(import.meta.url)',
      ].join('\n'),
    },
  })
  const file = path.join(tmpDir, `${name}.mjs`)
  writeFileSync(file, built.outputFiles[0].text)
  return import(pathToFileURL(file).href)
}

// ── a realistic upstream payload (shapes transcribed from a real capture) ───
/**
 * Build one `config_info_list` entry. The two discount blocks are passed
 * through verbatim so each fixture can be the REAL shape the server sends —
 * `activity_discount` (with `subKey` + window blocks) and `discount` (the
 * member block with `original_consumption_rate` / `is_discount_matched`).
 */
function remoteEntry(id, name, { rate, activityDiscount, memberDiscount } = {}) {
  const contact = {
    ...rate === undefined ? {} : { consumption_rate: { enable: true, data: { rate } } },
    ...activityDiscount === undefined ? {} : { activity_discount: activityDiscount },
    ...memberDiscount === undefined ? {} : { discount: memberDiscount },
  }
  return {
    config_name: id,
    display_config: { display_name: name, multimodal: false },
    config_switch: true,
    usage: 'chat_completion',
    display_contact_config: JSON.stringify(contact),
  }
}
const WINDOWS = [
  { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 0, end_minute: 480 },
  { weekdays: [1, 2, 3, 4, 5, 6, 7], start_minute: 1320, end_minute: 1440 },
]
/**
 * Each row below mirrors what THIS machine's TRAE actually serves (renderer log
 * + a captured `batch_get_detail_param` response):
 *   glm-5.2 / glm-5.3   → the `discount` member block, is_discount_matched:false
 *   deepseek-v4.1-flash → off_peak_member_discount (current = none)
 *   DeepSeek-V4-Pro     → off_peak_discount (current = none)
 *   Doubao-Seed-2.1-Turbo → subsidy_member_discount (current active)
 *   kimi-k3             → no discount at all
 */
const REMOTE = [
  remoteEntry('glm-5.2', 'GLM-5.2', {
    rate: 0.78,
    memberDiscount: { enable: true, subKey: 'member_discount', data: { original_consumption_rate: 0.78, consumption_rate: 0.39, member_discount: 50, is_discount_matched: false } },
  }),
  remoteEntry('glm-5.3', 'GLM-5.3', {
    rate: 0.78,
    memberDiscount: { enable: true, subKey: 'member_discount', data: { original_consumption_rate: 0.78, consumption_rate: 0.39, member_discount: 50, is_discount_matched: false } },
  }),
  remoteEntry('deepseek-v4.1-flash', 'DeepSeek-V4.1-Flash', {
    rate: 0.15,
    activityDiscount: {
      enable: true, subKey: 'off_peak_member_discount',
      data: {
        current: { discount_type: 'none', before_consumption_rate: 0.15, consumption_rate: 0.15, discount: 100 },
        member: { before_consumption_rate: 0.15, after_consumption_rate: 0.08, discount: 50 },
        off_peak: { before_consumption_rate: 0.15, after_consumption_rate: 0.08, discount: 50, time_windows: WINDOWS },
      },
    },
  }),
  remoteEntry('DeepSeek-V4-Pro', 'DeepSeek-V4-Pro', {
    rate: 0.72,
    activityDiscount: {
      enable: true, subKey: 'off_peak_discount',
      data: {
        current: { discount_type: 'none', before_consumption_rate: 0.72, consumption_rate: 0.72, discount: 100 },
        off_peak: { before_consumption_rate: 0.72, after_consumption_rate: 0.36, discount: 50, time_windows: WINDOWS },
      },
    },
  }),
  remoteEntry('Doubao-Seed-2.1-Turbo', 'Doubao-Seed-2.1-Turbo', {
    rate: 0.2,
    activityDiscount: {
      enable: true, subKey: 'subsidy_member_discount',
      data: {
        current: { discount_type: 'subsidy', before_consumption_rate: 0.4, consumption_rate: 0.2, discount: 50 },
        member: { before_consumption_rate: 0.4, after_consumption_rate: 0.1, discount: 25 },
        subsidy: { before_consumption_rate: 0.4, after_consumption_rate: 0.2, discount: 50 },
      },
    },
  }),
  remoteEntry('kimi-k3', 'Kimi-K3', { rate: 1.83 }),
]

let failures = 0
function check(label, cond, detail) {
  if (cond) { console.log(`ok  ${label}`) }
  else { failures++; console.error(`FAIL ${label} — ${detail}`) }
}

const { TraeAdapter } = await load('vendor/channel-pack/src/trae-adapter.ts', 'trae-adapter')
const trae = await load('vendor/channel-pack/src/trae.ts', 'trae')

// ── the projection `model.list` applies (copied from channel-pack-rpc.ts) ───
function project(rows, disabledIds = new Set(), deadIds = new Set()) {
  return rows.map((model) => ({
    id: model.id,
    name: model.name,
    disabled: disabledIds.has(model.id),
    dead: deadIds.has(model.id),
    ...model.isFree === undefined ? {} : { isFree: model.isFree },
    ...model.promo === undefined ? {} : { promo: model.promo },
  }))
}

function makeAdapter() {
  return new TraeAdapter({
    accountPool: undefined,
    fetchRemoteModels: async () => trae.parseTraeBatchModelList({
      function_configs: [{ function: 'solo_agent', config_info_list: REMOTE }],
    }),
  })
}

console.log('')
console.log('── 1. 冷启动：model.list 走 listAllModels()（同步，不触发拉取）──')
{
  const adapter = makeAdapter()
  const rows = project(adapter.listAllModels())
  const promoted = rows.filter((row) => row.promo !== undefined)
  console.log(`   rows=${rows.length}  rows-with-promo=${promoted.length}`)
  check('冷启动时 listAllModels() 不产出任何 promo（因为它读静态表、且不拉远端）',
    promoted.length === 0, `promoted=${promoted.length}`)
  const withRate = rows.filter((row) => /x\d/.test(row.name))
  check('冷启动的行名里没有倍率（静态表没有 creditsRate）',
    withRate.length === 0, `rows-with-rate=${withRate.length} e.g. ${rows[0]?.name}`)
}

console.log('')
console.log('── 1b. 修复：model.list 先 await ensureCatalog()，冷启动也能拿到促销 ──')
{
  const adapter = makeAdapter()
  // Exactly what model.list now does: hydrate first, then read the sync rows.
  check('适配器提供 ensureCatalog 钩子（model.list 靠它补齐冷启动）',
    typeof adapter.ensureCatalog === 'function', typeof adapter.ensureCatalog)
  await adapter.ensureCatalog()
  const rows = project(adapter.listAllModels())
  const promoted = rows.filter((row) => row.promo !== undefined)
  console.log(`   rows=${rows.length}  rows-with-promo=${promoted.length}`)
  check('**冷启动 + ensureCatalog 后设置页能看到促销**（本缺陷的验收条件）',
    promoted.length === 5, `promoted=${promoted.length}`)
  check('冷启动的行也带倍率了（静态表 → 远端目录）',
    rows.some((row) => /x\d/.test(row.name)), rows[0]?.name)
}

console.log('')
console.log('── 2. 先跑一次 listModels()（真的拉远端），再读 listAllModels() ──')
{
  const adapter = makeAdapter()
  const listed = await adapter.listModels('trae')
  const listedPromoted = listed.filter((row) => row.promo !== undefined)
  console.log(`   listModels rows=${listed.length}  with-promo=${listedPromoted.length}`)
  check('listModels() 自己就带 promo（它内部 ensureRemoteModels 了）',
    listedPromoted.length > 0, `with-promo=${listedPromoted.length}`)

  const rows = project(adapter.listAllModels())
  const promoted = rows.filter((row) => row.promo !== undefined)
  console.log(`   listAllModels rows=${rows.length}  with-promo=${promoted.length}`)
  check('拉过一次之后，listAllModels() 也有 promo 了（remoteModels 已填充）',
    promoted.length > 0, `with-promo=${promoted.length}`)
  for (const row of promoted) console.log(`     ${row.name.padEnd(34)} ${row.promo.badgeLabel ?? '(无标签)'}`)
}

console.log('')
console.log('── 3. 设置页读到的行（model.list 的投影）必须带 badgeLabel ──')
{
  const adapter = makeAdapter()
  await adapter.listModels('trae')
  const rows = project(adapter.listAllModels())
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]))
  check('GLM-5.2 → 会员5折', byId['glm-5.2']?.promo?.badgeLabel === '会员5折',
    JSON.stringify(byId['glm-5.2']?.promo))
  check('GLM-5.3 → 会员5折', byId['glm-5.3']?.promo?.badgeLabel === '会员5折',
    JSON.stringify(byId['glm-5.3']?.promo))
  check('DeepSeek-V4.1-Flash → 闲时折扣',
    byId['deepseek-v4.1-flash']?.promo?.badgeLabel === '闲时折扣',
    JSON.stringify(byId['deepseek-v4.1-flash']?.promo))
  check('DeepSeek-V4-Pro → 闲时折扣', byId['DeepSeek-V4-Pro']?.promo?.badgeLabel === '闲时折扣',
    JSON.stringify(byId['DeepSeek-V4-Pro']?.promo))
  check('Doubao-Seed-2.1-Turbo → 专属补贴',
    byId['Doubao-Seed-2.1-Turbo']?.promo?.badgeLabel === '专属补贴',
    JSON.stringify(byId['Doubao-Seed-2.1-Turbo']?.promo))
  // The off-peak rows carry the server's minute windows as HH:MM — the pill
  // needs them, since the label alone never says WHEN it is cheap.
  check('DeepSeek-V4-Pro 带时段窗口（00:00-08:00/22:00-24:00）',
    JSON.stringify(byId['DeepSeek-V4-Pro']?.promo?.windows) === JSON.stringify([
      { start: '00:00', end: '08:00' }, { start: '22:00', end: '24:00' },
    ]), JSON.stringify(byId['DeepSeek-V4-Pro']?.promo?.windows))
  check('会员行的价取自 member 块（x0.78→x0.39）',
    byId['glm-5.2']?.promo?.price?.original === 'x0.78' && byId['glm-5.2']?.promo?.price?.effective === 'x0.39',
    JSON.stringify(byId['glm-5.2']?.promo?.price))
  check('无折扣的 kimi-k3 → 无 promo 键', byId['kimi-k3']?.promo === undefined,
    JSON.stringify(byId['kimi-k3']?.promo))
}

console.log('')
console.log('── 4. 顺序反过来（先读卡、后拉目录）——修复前的核心缺陷 ──')
{
  const fixed = makeAdapter()
  // With the hook: reading rows first is no longer lossy, because model.list
  // hydrates before it reads.
  await fixed.ensureCatalog()
  const promoted = project(fixed.listAllModels()).filter((row) => row.promo !== undefined).length
  check('修复后：先读设置页也能拿到全部促销（不再依赖别处碰巧拉过目录）',
    promoted === 5, `promoted=${promoted}`)

  // And the underlying ordering hazard still exists at the raw adapter level
  // (documented, not a regression): a bare sync read on a cold adapter is empty.
  const cold = makeAdapter()
  const coldCount = project(cold.listAllModels()).filter((row) => row.promo !== undefined).length
  check('（记录既有契约）裸的同步 listAllModels() 冷启动仍为空 —— 故 RPC 层必须 await ensureCatalog',
    coldCount === 0, `cold=${coldCount}`)
}

rmSync(tmpDir, { recursive: true, force: true })
if (failures === 0) console.log('\nALL PASS')
else console.error(`\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
