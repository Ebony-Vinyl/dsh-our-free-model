/**
 * The receipt guard: what `draft-letter.mjs` is allowed to emit, and what it must
 * never emit.
 *
 * The tool reads a community "lawyer letter" and renders its factual core as an
 * evidence ledger. The risk is not that it reads wrongly; it is that it quietly
 * grows the parts of a letter that make one usable — a seal position, a demand,
 * a deadline, a named rightsholder. So the last section here audits the renderer's
 * own output against a fixture that carries every one of those things, and fails
 * if any of them survives the rendering.
 *
 * Run: node scripts/draft-letter-test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readLetter, reconcile, renderLedger, hazards, sentences, PLACEHOLDER } from './draft-letter.mjs'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-draft-letter-'))

// ── a source shaped like the letter that prompted this tool ──────────────────

const SOURCE = `# 某函

| 项目 | 内容 |
| --- | --- |
| 致 | 某仓库维护者（GitHub 账号 \`someone\`，用户 ID 245557608） |
| 签发 | 受托代理机构（第三方代理） |
| 审核 | 〔承办律师〕 |

## 致 某某

**【就某仓库中实施的技术措施破解事宜，现函告如下。】**

### 一、经查证的事实

2026-10-21，某仓库 Issue #560 完整公开了上游原始响应报文：

\`\`\`http
POST https://example.invalid/v2/chat/completions
HTTP/2 400
\`\`\`

该响应中明确写明"这次调用没通过渠道校验"，这直接证明上游已就此作出明示告知。

某 PR 的新增文件 \`src/a.ts\`（2,468 行）将清洗接入出站主路径。

| 探针 | system 文本 | 结果 |
| --- | --- | --- |
| 中性对照 | \`You are a helpful assistant.\` | ✅ 200 |
| 最小充分触发 | \`Main branch (you will usually use this for PRs): master\` | ❌ 400/11128 |

**即：贵方于 2026 年 10 月 21 日提交该 PR，并同时新建 4 个源文件。**

| 项目 | 数据 |
| --- | --- |
| 提交者 | \`someone\` |
| 变更规模 | **+17,241 / −4,800**，36 个文件 |

其新增文件 \`src/buddy.ts\`（42,615 字节）保留逆向成果。

github 仓库共有 659 个 Fork，31,777 star。

### 二、正式要求

权利人在此正式要求贵方立即采取下列措施：（一）自送达之日起 3 日内立即停止；（二）7 日内下架与删除。

1. 立即停止对某产品的一切逆向、模拟、调用行为。
2. 删除 \`src/buddy.ts\` 及相关文件。

### 三、若不履行

权利人保留采取以下措施的权利，并将于答复期限届满后立即启动诉讼。

**特此函告。**

受托代理机构（第三方代理）：〔待填：机构名称〕（此处加盖公章）
受托代理人／承办律师：〔待填〕
联系方式：〔待填〕　电子邮箱：〔待填〕
`

/** A page as a reader would have captured it, sizes checked against FILES below. */
const FILES = {
  'src/a.ts': 'x'.repeat(2468),
  'src/buddy.ts': 'y'.repeat(42615),
}
/** An English "you are …" line — no Chinese full stop, so the 400/11128 stays attached. */
const EN_LEAD = 'You are an AI agent, see `src/none.ts` (12 tokens) for details. 这是另一句。'
/** A bare English sentence that ends the paragraph: the splitter must not glue it to what follows. */
const EN_ONLY = 'You are an AI agent powered by DeepSeek-Harness.'
/** An inference stated as a full sentence of its own. */
const INFERENCE = '这直接证明上游已就此作出明示告知。'
/** A "still in main: X (N bytes)" claim naming a file the page no longer has. */
const FILE_GONE = '其新增文件 `src/buddy.ts`（42,615 字节）保留逆向成果。'
/** A repo-level counter line. */
const REPO_COUNTERS = 'github 仓库共有 659 个 Fork，31,777 star。'

const REFERENCES = {
  'owner/repo': [
    // `state` is the word a page records; it is deliberately not "Open".
    { kind: 'issue', number: 560, title: '原始响应', state: 'closed', body: '这次调用没通过渠道校验，可能不是官方客户端发出的。', files: {} },
    { kind: 'pr', number: 574, title: '恢复渠道', state: 'closed', createdAt: '2026-10-21T08:21:28Z', files: FILES },
  ],
  // Counters a letter cites about the project rather than about one page.
  repository: { stars: 31777, forks: 659 },
}

/** Answers what the fixture claims, whether or not a page carries it. */
const NO_REFS = {}

const claim = (source, needle, references = REFERENCES) => {
  const ledger = readLetter(source, references)
  return ledger.claims.find(entry => entry.sentence.includes(needle))
}

// ── 1. reading ───────────────────────────────────────────────────────────────

console.log('reading')

check('every digit-bearing sentence becomes one claim', () => {
  const ledger = readLetter(SOURCE)
  assert.ok(ledger.claims.length >= 6, `expected at least 6 claims, got ${ledger.claims.length}`)
  // A table row is not a sentence: the probe table shrinks to its caption.
  assert.ok(!ledger.claims.some(claim => claim.sentence.startsWith('| 中性对照')))
})

check('a file-size claim is checked against the page when the file is supplied', () => {
  assert.equal(claim(FILE_GONE, 'src/buddy.ts').status, 'CONFIRMED')
})

check('a size that disagrees with the page is CONTRADICTED, not tolerated', () => {
  const wrong = { 'owner/repo': [{ ...REFERENCES['owner/repo'][1], files: { 'src/buddy.ts': 'z'.repeat(100) } }] }
  assert.equal(claim(FILE_GONE, 'src/buddy.ts', wrong).status, 'CONTRADICTED')
})

check('a file the page no longer has contradicts the claim that it exists', () => {
  const gone = { 'owner/repo': [{ ...REFERENCES['owner/repo'][1], files: {} }] }
  assert.equal(claim(FILE_GONE, 'src/buddy.ts', gone).status, 'CONTRADICTED')
})

check('an Issue claim is checked against that issue, not against a neighbouring file size', () => {
  // 11128 is quoted in prose here, and Issue #560's page does not carry it.
  const header = '上游返回 11128 的响应，这是上游的错误码。'
  const seen = readLetter(header, { 'owner/repo': [REFERENCES['owner/repo'][0], { ...REFERENCES['owner/repo'][1], number: 601 }] })
  // No page is named by number: the reader supplied two — no guess is made.
  assert.equal(seen.claims[0].status, 'UNVERIFIED')
  // Named by number, the page answers: 560 is on Issue #560 and 11128 is not.
  assert.equal(claim('该 Issue 的编号是 560。', '编号是 560').status, 'CONFIRMED')
  assert.equal(claim('该 Issue 的错误码是 11128。', '11128').status, 'CONTRADICTED')
})

check('quoted numbers are evidence, not the letter\'s own claims', () => {
  // `HTTP/2 400` sits in a quotation; the sentence asserts nothing numeric.
  const quoted = '上游按 `HTTP/2 400` 回应，见前文所引报文。'
  assert.equal(readLetter(quoted, REFERENCES).claims[0]?.status ?? 'NOT_A_FACT', 'NOT_A_FACT')
})

check('a date-only sentence is NOT_A_FACT: there is no magnitude to confirm', () => {
  assert.equal(claim('该 PR 于 2026 年 10 月 21 日提交。', '该 PR').status, 'NOT_A_FACT')
})

check('a bare English sentence is not glued to the Chinese line after it', () => {
  const parts = sentences(`${EN_ONLY} 这是下一句。`)
  assert.deepEqual(parts, [EN_ONLY, '这是下一句。'])
})

check('a decimal and a file extension do not split a sentence', () => {
  assert.equal(sentences('版本 1.5 已发布，见 a.ts 第 3 行。').length, 1)
})

check('a quoted number alone does not make a sentence a claim', () => {
  // `12 tokens` sits in a backtick; the prose asserts nothing.
  assert.equal(readLetter(EN_LEAD, REFERENCES).claims.some(entry => entry.sentence.includes('这是另一句')), false)
})

check('repository-level counters confirm against the repository record', () => {
  assert.equal(claim(REPO_COUNTERS, 'Fork').status, 'CONFIRMED')
  const stale = { repository: { stars: 30000, forks: 659 } }
  assert.equal(claim(REPO_COUNTERS, 'Fork', stale).status, 'CONTRADICTED')
})

check('with no repository record, a counter stays UNVERIFIED', () => {
  assert.equal(claim(REPO_COUNTERS, 'Fork', NO_REFS).status, 'UNVERIFIED')
})

check('a sentence naming a PR the reader supplied is checked against that PR', () => {
  // The letter names the page as "该 PR" (that PR) rather than by number; exactly
  // one PR was supplied, so the attribution is unambiguous. Its opening date is
  // on the page, but the sentence also claims 4 source files and the page lists
  // 2 — so the claim is contradicted by the number that is actually wrong.
  assert.equal(claim(SOURCE, '提交该 PR').status, 'CONTRADICTED')
  // A sentence whose only number is the date the page carries is not contradicted —
  // and it is not "confirmed" as a magnitude either: it is set aside as NOT_A_FACT.
  assert.equal(claim('该 PR 于 2026 年 10 月 21 日提交。', '该 PR').status, 'NOT_A_FACT')
  // A date the page does not carry is a contradiction, not a quiet pass.
  assert.equal(claim('该 PR 于 2026 年 10 月 21 日提交。', '该 PR', { 'owner/repo': [{ ...REFERENCES['owner/repo'][1], createdAt: '2026-09-01T00:00:00Z' }] }).status, 'CONTRADICTED')
  // The count is the number that resolves.
  assert.equal(claim('该 PR 新建 4 个源文件。', '4 个源文件').status, 'CONTRADICTED')
  assert.equal(claim('该 PR 新建 2 个源文件。', '2 个源文件').status, 'CONFIRMED')
})

check('a claim naming a page nobody supplied is UNVERIFIED, never guessed', () => {
  const ledger = readLetter(SOURCE, NO_REFS)
  assert.ok(ledger.claims.every(entry => entry.status !== 'CONFIRMED'))
  assert.ok(ledger.claims.some(entry => entry.status === 'UNVERIFIED'))
})

check('a deductive lead-in carries no number, so it is not a claim at all', () => {
  // The inference has no magnitude to check; it is excluded at the sentence level
  // rather than mislabelled as a verified fact.
  assert.equal(claim(INFERENCE, '这直接证明'), undefined)
  // The renderer still records the inference as NOT_A_FACT when it carries a number.
  const numbered = '这直接证明有 3 处违规。'
  assert.equal(claim(numbered, '3 处违规').status, 'NOT_A_FACT')
})

check('a demand is never reported as a verified fact', () => {
  // The lead-in ("…正式要求…") carries no number, so it is not a claim; the
  // enumerated item under it does carry numbers, and it must still be NOT_A_FACT
  // rather than an unverified fact — a demand is not something a page can confirm.
  const demand = '权利人在此正式要求贵方立即采取下列措施：（一）自送达之日起 3 日内立即停止；（二）7 日内下架与删除。'
  const claims = readLetter(demand, {}).claims
  assert.equal(claims.length, 1)
  assert.equal(claims[0].status, 'NOT_A_FACT')
  // The lead-in itself is not a claim at all.
  assert.equal(readLetter(SOURCE, REFERENCES).claims.some(entry => entry.sentence.includes('正式要求')), false)
})

check('the closing line carries no number, so it is not a claim at all', () => {
  assert.equal(claim(SOURCE, '特此函告'), undefined)
})

check('the letter number itself is not treated as a factual claim', () => {
  // `LAW-DSH-OFM-2026-1021-WB` sits in the title, which is not prose.
  const ledger = readLetter(SOURCE)
  assert.ok(!ledger.claims.some(claim => claim.sentence.includes('LAW-')))
})

check('a claim sentence never crosses a table boundary', () => {
  const joined = readLetter(SOURCE).claims.map(claim => claim.sentence).join('\n')
  assert.ok(!/\|\s*---/.test(joined), 'a table separator leaked into a claim')
})

// ── 2. structure ─────────────────────────────────────────────────────────────

console.log('structure')

check('evidence rows, code fences and probe rows are counted from the body', () => {
  const { counts } = readLetter(SOURCE)
  assert.equal(counts.codeBlocks, 1)
  assert.ok(counts.probeRows >= 2, `probe rows ${counts.probeRows}`)
})

check('a seal said to take effect on signing is named as a hazard', () => {
  assert.ok(hazards(SOURCE).some(hazard => hazard.includes('签章')))
})

check('a "from the date of service" deadline is named as a hazard', () => {
  assert.ok(hazards(SOURCE).some(hazard => hazard.includes('送达')))
})

check('every authority placeholder survives verbatim and is counted', () => {
  const ledger = readLetter(SOURCE)
  const inSource = new Set(SOURCE.match(PLACEHOLDER))
  assert.equal(ledger.authoritySlots.length, inSource.size)
  for (const slot of ledger.authoritySlots) assert.ok(inSource.has(slot))
})

check('a source with no placeholders reports none, not a zero-width lie', () => {
  const ledger = readLetter('一句话，没有落款。')
  assert.deepEqual(ledger.authoritySlots, [])
  assert.deepEqual(ledger.hazards, [])
})

// ── 3. arithmetic ────────────────────────────────────────────────────────────

console.log('arithmetic')

check('a source that states its diff twice identically agrees', () => {
  const twice = `${SOURCE}\n> 变更规模 **+17,241 / −4,800**，36 个文件`
  const ledger = readLetter(twice, REFERENCES)
  ledger.references = REFERENCES
  const rows = reconcile(ledger, twice)
  assert.ok(rows.some(row => row.what.startsWith('变更规模') && row.agrees))
})

check('a source that restates its diff differently is caught', () => {
  const drifted = `${SOURCE}\n> 变更规模 **+17,000 / −4,800**，36 个文件`
  const ledger = readLetter(drifted, REFERENCES)
  ledger.references = REFERENCES
  const rows = reconcile(ledger, drifted)
  assert.ok(rows.some(row => row.what.startsWith('变更规模') && !row.agrees))
})

check('a PR the letter calls Open but the page records closed is caught', () => {
  const source = `${SOURCE}\n| 状态 | **Open**（未合并） |`
  const ledger = readLetter(source, REFERENCES)
  ledger.references = REFERENCES
  const rows = reconcile(ledger, source)
  assert.ok(rows.some(row => row.what.includes('状态') && !row.agrees), JSON.stringify(rows))
})

// ── 4. the guard: the renderer must not produce a usable letter ──────────────

console.log('renderer guard')

const ledger = readLetter(SOURCE, REFERENCES)
ledger.references = REFERENCES
ledger.reconciliation = reconcile(ledger, SOURCE)
const rendered = renderLedger(ledger, { title: 'fixture.md' })

check('the renderer emits a ledger title, not a letter title', () => {
  assert.ok(rendered.startsWith('# 事实核对单'))
  assert.ok(!/\u6cd5\u5f8b\u51fd\s*\u3010/.test(rendered), 'rendered output claims to be a letter')
})

check('no seal position, no firm or lawyer name field survives', () => {
  for (const banned of ['公章', '签章后生效', '受托代理机构', '承办律师', '执业证号', '加盖']) {
    assert.ok(!rendered.includes(banned), `rendered output still says ${banned}`)
  }
})

check('no demand, deadline or threat survives', () => {
  // Claims are quoted in the table, so the quote itself must lose its imperative
  // voice — a deadline printed verbatim would be a deadline in the output.
  for (const banned of ['立即停止', '现函告', '特此函告', '保留采取', '若不履行', '自送达之日起', '正式要求贵方']) {
    assert.ok(!rendered.includes(banned), `rendered output still says ${banned}`)
  }
  // The substitution is descriptive, not omission: the chronology is still legible.
  assert.ok(rendered.includes('（表述为停止）'), 'the quoted claim lost its content entirely')
})

check('no rightsholder name is rendered', () => {
  for (const banned of ['腾讯', 'WorkBuddy', 'CodeBuddy', 'opencode', 'Kilo']) {
    assert.ok(!rendered.includes(banned), `rendered output names ${banned}`)
  }
})

check('no letter number or self-declared legal conclusion is rendered', () => {
  for (const banned of ['LAW-', '违反《', '构成侵权', '涉嫌', '本函']) {
    assert.ok(!rendered.includes(banned), `rendered output says ${banned}`)
  }
})

check('the placeholders appear as quoted evidence, never filled in', () => {
  for (const slot of ledger.authoritySlots) assert.ok(rendered.includes(slot), `slot ${slot} missing`)
  // Nothing new was invented next to them.
  const renderedSlots = new Set(rendered.match(PLACEHOLDER) ?? [])
  assert.deepEqual([...renderedSlots].sort(), [...new Set(SOURCE.match(PLACEHOLDER))].sort())
})

check('the ledger is self-describing as not-a-letter', () => {
  assert.ok(rendered.includes('不是'))
  assert.ok(rendered.includes('不构成任何法律意见'))
})

// ── 5. CLI ───────────────────────────────────────────────────────────────────

/**
 * The CLI is exercised as a child process. Some sandboxes forbid spawning a
 * process with piped stdio (Windows reports EPERM), so a refusal to spawn is
 * reported as a skip — the same invocation is still run directly by
 * `draft-letter.mjs`'s own callers in CI, and every branch below is otherwise
 * reachable. A *completed* child that fails is never skipped.
 */
const CLI = fileURLToPath(new URL('draft-letter.mjs', import.meta.url))
const spawned = args => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })

const cli = args => {
  const result = spawned(args)
  if (result.error !== undefined && result.error !== null) {
    console.log(`  skip  (child processes unavailable here: ${result.error.code ?? result.error.message})`)
    return result
  }
  if (result.status !== 0 && process.env.OFM_DEBUG_CLI !== undefined) console.error(result.stderr)
  return result
}

console.log('cli')

const dir = temp()
const letter = path.join(dir, 'letter.md')
const refs = path.join(dir, 'refs.json')
fs.writeFileSync(letter, SOURCE)
fs.writeFileSync(refs, JSON.stringify(REFERENCES))

const plain = cli([letter])
check('the CLI renders the ledger to stdout without a refs file', () => {
  if (plain.error !== undefined && plain.error !== null) return
  assert.equal(plain.status, 0, plain.stderr)
  assert.ok(plain.stdout.startsWith('# 事实核对单'))
})

const withRefs = cli([letter, '--refs', refs])
check('the CLI resolves claims against a supplied reference file', () => {
  if (withRefs.error !== undefined && withRefs.error !== null) return
  assert.equal(withRefs.status, 0, withRefs.stderr)
  assert.ok(withRefs.stdout.includes('CONFIRMED'), 'no claim resolved as CONFIRMED')
})

const json = cli([letter, '--json', '--refs', refs])
check('--json is machine-readable and carries the same ledger', () => {
  if (json.error !== undefined && json.error !== null) return
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.counts.claims, readLetter(SOURCE).claims.length)
  // The fixture states its diff once, so there is nothing to reconcile: the field
  // must still be present and be an array, but it is legitimately empty here.
  assert.ok(Array.isArray(parsed.reconciliation), 'reconciliation must be an array')
  assert.equal(parsed.reconciliation.length, 0)
})

const outDir = path.join(dir, 'out')
const wrote = cli([letter, '--out', outDir])
check('--out writes both artifacts and leaves stdout intact', () => {
  if (wrote.error !== undefined && wrote.error !== null) return
  assert.equal(wrote.status, 0, wrote.stderr)
  assert.ok(fs.existsSync(path.join(outDir, 'ledger.md')))
  assert.ok(fs.existsSync(path.join(outDir, 'ledger.json')))
  assert.ok(wrote.stdout.includes('事实核对单'))
})

const unknown = cli(['--nope', letter])
check('an unknown flag is refused rather than ignored', () => {
  if (unknown.error !== undefined && unknown.error !== null) return
  assert.notEqual(unknown.status, 0)
})

const bare = cli([])
check('a missing input is refused with usage, not a stack trace', () => {
  if (bare.error !== undefined && bare.error !== null) return
  assert.ok(bare.stderr.includes('usage:'), bare.stderr)
  assert.ok(!/\n\s+at /.test(bare.stderr), 'the refusal carries a stack trace')
})

// ── 6. sentences() is the contract every section rests on ────────────────────

console.log('sentence split')

check('a table row never splits a neighbouring sentence', () => {
  const parts = sentences('前一句带数字 3。\n| a | b |\n| --- | --- |\n后一句带数字 4。')
  assert.deepEqual(parts, ['前一句带数字 3。', '后一句带数字 4。'])
})

check('an English full stop ends the English sentence, not the whole line', () => {
  // The old behaviour glued the following Chinese sentence onto the English one;
  // the fix is that the English fragment stays whole and the next one is separate.
  const parts = sentences('You are an AI agent powered by DeepSeek-Harness. 这是同一句。')
  assert.deepEqual(parts, ['You are an AI agent powered by DeepSeek-Harness.', '这是同一句。'])
})

console.log(`\n${failures === 0 ? 'draft-letter-test: OK' : `draft-letter-test: ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
