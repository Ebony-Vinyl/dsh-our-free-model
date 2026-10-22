/**
 * Reference receipt for a community "lawyer letter" — reads a markdown letter and
 * renders the factual core as an evidence ledger. It is not a letter generator.
 *
 * A letter whose legal shell is assembled (placeholders for the institution, the
 * signing lawyer and the seal; a term it cannot execute) still carries a factual
 * core that can be checked, and this turns that core into an itemised ledger:
 * every claim becomes a row that is either CONFIRMED, CONTRADICTED, UNVERIFIED or
 * NOT_A_FACT, with the text it cites quoted back. Reading the ledger is the whole
 * point — a single number in a formula table is harder to argue with than a
 * paragraph of assertions.
 *
 * What this deliberately does not do
 * ----------------------------------
 * The output carries, by construction and by the audit in `draft-letter-test.mjs`:
 *
 *   - no signature block, no seal position, no firm/lawyer name field;
 *   - no request, deadline, demand or threat of action;
 *   - no letter number, and no rightsholder name in the ledger;
 *   - every authority placeholder the source letter carried is preserved
 *     verbatim as a placeholder, so the artefact cannot be mistaken for signed.
 *
 * Claim counts are derived, never typed: a bare number in the source is found in
 * the rendered output by construction (it is what the sentence quotes), a number
 * stated in prose as W+W is resolved against the ledger, and a claim only resolves
 * against a fact a page *publishes*, never against a coincidence of its prose.
 *
 * This module is pure: no filesystem, no clock, no network. The file-reading CLI
 * wrapper lives in `scripts/draft-letter.mjs`; the settings page calls this module
 * through the Host API so the browser half never carries the classifier.
 *
 * @module src/letter-ledger.js
 */

// ── vocabulary ───────────────────────────────────────────────────────────────

export const PLACEHOLDER = /〔\s*待填[^〕]*〕/g

/**
 * The lead-in of a claim sentence. A claim is a digit-bearing sentence whose
 * lead-in reads as a factual statement; a sentence that begins like this one
 * is an assertion of harm and is classified as NOT_A_FACT, because it cannot be
 * checked against a page that has already been mutated by the events it rests on.
 */
const SPECULATIVE = /^(这直接证明|这意味着|这表明|这说明|因此|由此|可见|足见|亦即|这就|足以证明|此即|显然|无疑|极有可能|可能)/

/** A sentence that is not a fact but also not speculative: a demand, a warning. */
const DIRECTIVE = /(要求|应于|须于|特此|函告|保留.{0,6}权利|逾期|否则)/

const STATUSES = ['CONFIRMED', 'CONTRADICTED', 'UNVERIFIED', 'NOT_A_FACT']

// ── parsing ──────────────────────────────────────────────────────────────────

/**
 * Split prose into sentences.
 *
 * Three shapes must not become one sentence, or a claim quotes material it does
 * not own and resolves against the wrong page:
 *
 *   - table rows are dropped (a separator would glue the caption to the row);
 *   - fenced blocks are dropped (a header block carries status codes and dates);
 *   - a heading on its own line ends the previous sentence — `### 一、事实` is a
 *     section marker, not a lead-in to the claim beneath it.
 *
 * Every block separator is written as a sentence terminator, not a space. Joining
 * with a space let a heading that follows a dropped table run into the paragraph
 * before it, producing one "sentence" that began with a letter number and ended
 * in a file claim — a row that quoted two unrelated paragraphs and resolved
 * against neither.
 */
export function sentences(text) {
  const blocks = []
  let fenced = false
  for (const line of String(text).split('\n')) {
    if (line.trim().startsWith('```')) { fenced = !fenced; continue }
    if (fenced) continue
    const trimmed = line.trim()
    // A separator, a table row and a heading are all block boundaries: the
    // pieces on either side must not become one sentence.
    if (trimmed.startsWith('|') || trimmed === '' || /^#{1,6}\s/.test(trimmed)) { blocks.push(null); continue }
    // Bold markers are inline decoration. An ordered-list marker is dropped too,
    // so "1. 立即停止…" is one sentence rather than a bare "1." plus a fragment.
    blocks.push(trimmed.replace(/\*\*/g, '').replace(/^\d+[.、)]\s*/, ''))
  }
  // Join with a terminator at every real block boundary. A trailing colon is an
  // accepted ending — "正文：" is a complete lead-in, and appending a full stop to
  // it produced "正文：。" while appending nothing glued the next paragraph onto it.
  const endsBlock = text => /[。！？!?：:]$/.test(text)
  let joined = ''
  for (const block of blocks) {
    if (block === null) {
      if (joined !== '' && !endsBlock(joined)) joined += '。'
      continue
    }
    if (joined !== '' && !endsBlock(joined)) joined += '。'
    joined += block
  }
  return joined
    .split(/(?<=[。！？!?:：])\s*|(?<=\.)\s+(?=[A-Z〔【(\[]|[\u4e00-\u9fff])|(?<=\.)$/)
    .flatMap(part => part.split(/(?<=[。！？!?])/))
    .map(sentence => sentence.trim())
    // A fragment of punctuation only is not a sentence.
    .filter(sentence => /[\p{L}\p{N}]/u.test(sentence))
}

/**
 * The cells of one table row, or null for a separator/blank row.
 *
 * A row is split on pipes that are not escaped (`\|`) — an evidence cell holding
 * `\|` from the source would otherwise shift every column after it.
 */
function rowCells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|')) return null
  const cells = trimmed.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim())
  if (cells.every(cell => /^:?-+:?$/.test(cell) || cell === '')) return null
  return cells
}

/** The evidence table: `| E1 | ... |` rows anywhere in the document. */
function evidenceRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const cells = rowCells(line)
    if (cells === null || cells.length < 3) continue
    const id = cells[0]
    if (!/^E\d+$/.test(id)) continue
    rows.push({ id, where: cells[1], supports: cells[cells.length - 1] })
  }
  return rows
}

/** `| project | value |` pairs from the first data table — the metadata block. */
function metadataRows(text) {
  const rows = []
  for (const line of text.split('\n')) {
    const cells = rowCells(line)
    if (cells === null || cells.length !== 2) continue
    if (cells[0] === '项目') continue
    rows.push(cells)
  }
  return rows
}

/** `xxx：12345` — a number stated in prose that should exist in the page. */
function proseNumbers(text) {
  const found = new Set()
  const re = /(\d{1,3}(?:,\d{3})+|\d{2,})(?=\s*(?:次|个|条|行|字节|bytes|star|fork|评论|文件|份))/gi
  for (const match of text.matchAll(re)) found.add(Number(match[1].replace(/,/g, '')))
  return [...found]
}

/**
 * Structural hazards, each named so the renderer can print them.
 *
 * A hazard is a statement about the shape of the document, never a quote from it:
 * the renderer prints these lines, so anything quoted here would land in the
 * output verbatim and smuggle a banned phrase past the renderer audit in
 * `draft-letter-test.mjs`. Describe the shape; do not reproduce the clause.
 */
export function hazards(source) {
  const out = []
  const placeholders = source.match(PLACEHOLDER) ?? []
  if (placeholders.length > 0) out.push(`落款存在 ${placeholders.length} 处未填占位符`)
  if (/签章后生效|加盖公章|盖章后生效/.test(source)) out.push('文书自述需签章方能生效，但未附任何签章')
  if (/自送达之日起/.test(source)) out.push('程序时限以送达日起算，但未记载可采信的送达方式与凭证')
  if (/保留.{0,12}权利/.test(source)) out.push('以单方声明保留后续措施，不构成可执行的请求')
  if (/在有限责任公司|涉嫌|可能构成|充分事实基础/.test(source)) out.push('对尚待认定的情形使用了定性动词')
  return out
}

// ── status resolution ────────────────────────────────────────────────────────

/**
 * The prose of a letter, with every fence and every code span removed.
 *
 * A sentence that carries a claim is prose. Quoted material — a request header,
 * a code snippet, a file name — is evidence, and the numbers inside it (status
 * codes, line counts, dates in a sample) are not the letter's own claims. Reading
 * them as claims would turn "HTTP/2 400" in a quoted block into something to
 * verify against a page that never mentioned it.
 */
function prose(text) {
  return String(text).replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
}

/** Numeric tokens a sentence asserts, stated in prose rather than quoted. */
function assertedNumbers(sentence) {
  return [...prose(sentence).matchAll(/\d{1,3}(?:,\d{3})+|\d+/g)].map(match => Number(match[0].replace(/,/g, '')))
}

/**
 * Every number in a sentence, quotes included.
 *
 * Used only where a quoted token genuinely is the claim: "`src/a.ts`（2,468 行）"
 * states a line count, and a page carrying that file is the thing that answers it.
 */
function numbersIncludingQuotes(sentence) {
  return [...String(sentence).matchAll(/\d{1,3}(?:,\d{3})+|\d+/g)].map(match => Number(match[0].replace(/,/g, '')))
}

/**
 * A file's size the way a page (or a letter) reports it: the byte length.
 * Claims are compared against this, not against `length`, so a page that says
 * 42,615 bytes and a letter that says 42,615 bytes agree even when the file
 * holds multi-byte text.
 *
 * A number is taken at its word. A reader who already knows the size (the GitHub
 * reader does — the API reports it) should not have to materialise a string of
 * that many characters just to say so: forty files at the size cap would be an
 * eight-megabyte string built to carry forty integers.
 */
function byteLength(content) {
  if (typeof content === 'number' && Number.isFinite(content) && content >= 0) return content
  return new TextEncoder().encode(String(content)).byteLength
}

/**
 * Every page a reference file supplies, flattened.
 *
 * The file also carries non-page records at the top level (`repository` holds the
 * counters a letter cites about the project). Only arrays are pages; anything else
 * would be walked as a page list and fail on `.flat()`.
 */
function pagesOf(references) {
  return Object.values(references).filter(entry => Array.isArray(entry)).flat()
}

/**
 * The one page in the reference file, across all repos, when there is exactly
 * one *of each kind*. A letter often names a page without its number; if the
 * reader supplied a single page, the attribution is unambiguous. With more than
 * one candidate the answer is "unknown", never a guess.
 */
function solePage(references, needle) {
  const candidates = pagesOf(references).filter(entry => (needle ?? '').includes(entry.kind))
  return candidates.length === 1 ? candidates[0] : null
}

/** A file path the claim names, if it names one. */
function fileOf(sentence, references) {
  for (const page of pagesOf(references)) {
    for (const rel of Object.keys(page.files ?? {})) {
      if (sentence.includes(rel)) return { rel, page }
    }
  }
  return null
}

/**
 * The file path a sentence names, whether or not a supplied page carries it.
 *
 * `fileOf` answers "which supplied file does this sentence talk about"; this
 * answers "does this sentence name a path at all". The difference matters for the
 * claim "X is still in main": if the reader supplied the page that would hold X
 * and that page holds no such file, the claim is contradicted — that is the
 * single most useful finding a ledger can report.
 */
const PATH_LIKE = /(?<![\w/.-])([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z][A-Za-z0-9]{0,9})(?![\w/-])/g

function pathNamed(sentence) {
  for (const match of sentence.matchAll(PATH_LIKE)) {
    const candidate = match[1]
    // A version number or a domain is not a repository path.
    if (/^\d+\.\d+/.test(candidate)) continue
    if (/\.(com|org|net|io|ai|cn|dev)$/i.test(candidate)) continue
    return candidate
  }
  return null
}

/** Any page the claim names by kind: an issue, a PR, or the repository itself. */
function pageOf(sentence, references) {
  const issue = /Issue\s+#(\d+)|#(\d+)\s*（/i.exec(sentence)
  if (issue) {
    const number = Number(issue[1] ?? issue[2])
    const hit = pagesOf(references).find(page => page.kind === 'issue' && page.number === number)
    if (hit !== undefined) return hit
  }
  const pr = /PR\s+#(\d+)/i.exec(sentence)
  if (pr) {
    const number = Number(pr[1])
    const hit = pagesOf(references).find(page => page.kind === 'pr' && page.number === number)
    if (hit !== undefined) return hit
  }
  return null
}

/**
 * The numbers a reference page publishes: its identity, the dates it was opened
 * and closed, and the size of every file it carries.
 *
 * Deliberately not the page body. A body is arbitrary prose, so harvesting its
 * digits would "confirm" almost any number a letter happens to share with it —
 * the cheap way to make a ledger green. A claim resolves against a fact the page
 * publishes, never against a coincidence of prose.
 */
function pageNumbers(page, extra = []) {
  const seen = new Set()
  const absorb = value => {
    if (value === undefined || value === null) return
    for (const match of String(value).matchAll(/\d{1,3}(?:,\d{3})+|\d+/g)) seen.add(Number(match[0].replace(/,/g, '')))
  }
  absorb(page.number)
  // A date claim cites Y/M/D as separate tokens, so each is observable alone.
  for (const key of ['createdAt', 'closedAt']) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(page[key] ?? ''))
    if (parts) for (const part of parts.slice(1)) seen.add(Number(part))
  }
  for (const content of Object.values(page.files ?? {})) absorb(byteLength(content))
  for (const value of extra) absorb(value)
  return seen
}

/**
 * Classify one sentence.
 *
 * `references` may also carry a top-level `repository` record — the counters a
 * letter cites about the project itself (star, fork, releases). Those live at the
 * repo level rather than on a page, so they are merged for sentences that talk
 * about the repository and about nothing else.
 */
function classify(sentence, references) {
  // A lead-in that states a conclusion from the evidence is an inference, not a
  // fact — and it is one before any page is consulted.
  if (SPECULATIVE.test(sentence)) return 'NOT_A_FACT'
  const nums = assertedNumbers(sentence)
  if (nums.length === 0) return 'NOT_A_FACT'
  if (DIRECTIVE.test(sentence)) return 'NOT_A_FACT'
  // A sentence whose only numbers are years states what happened, not how much:
  // there is no magnitude to confirm, so labelling it CONFIRMED would overclaim.
  // A full date (year + month + day) is different — a page publishes one, so it
  // is left for the page rules below, which can say whether it matches.
  const yearsOnly = nums.every(value => value >= 1900 && value <= 2100)
  const fullDate = /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日|\d{4}-\d{2}-\d{2}/.test(sentence)
  if (yearsOnly && !fullDate) return 'NOT_A_FACT'

  const own = fileOf(sentence, references)
  if (own !== null) {
    const blob = own.page.files?.[own.rel]
    // The size a sentence states is a magnitude, whatever was in a backtick.
    const stated = numbersIncludingQuotes(sentence)
    return stated.includes(byteLength(blob)) ? 'CONFIRMED' : 'CONTRADICTED'
  }

  // A path the reader's page would have held, but no longer does. The page that
  // answers for it is either the one the sentence names or — when it names none —
  // the only page supplied. A sentence that also names a page by number ("this PR")
  // resolves against that page, where a file count is a published figure.
  const named = pathNamed(sentence)
  if (named !== null) {
    const holder = pageOf(sentence, references) ?? solePage(references, 'pr issue')
    if (holder?.files !== undefined) {
      // An empty listing is a real answer: the page carries no files, so it does
      // not carry this one. Only a page with no `files` key leaves it unknown.
      if (!Object.keys(holder.files).includes(named)) return 'CONTRADICTED'
      return 'CONFIRMED'
    }
    return 'UNVERIFIED'
  }

  const page = pageOf(sentence, references)
  if (page !== null) {
    const observable = pageNumbers(page)
    // A count of files is something a page publishes even when the sentence does
    // not name any one file: "it created 4 source files".
    if (page.files !== undefined) observable.add(Object.keys(page.files).length)
    const missing = nums.filter(value => !observable.has(value))
    if (missing.length > 0) return 'CONTRADICTED'
    // A date the page carries is matched, but it states what happened rather than
    // how much: it is reported as NOT_A_FACT, never as a magnitude "confirmed".
    return fullDate ? 'NOT_A_FACT' : 'CONFIRMED'
  }

  // The page is named by title rather than ID (a PR the letter describes but does
  // not number). Only a single candidate makes the attribution unambiguous; with
  // several to choose from, guessing would be the one thing this tool must not do.
  const bare = /(该|此|本)\s*(PR|Issue)/i.exec(sentence)
  if (bare !== null) {
    const kind = bare[2].toLowerCase()
    const candidates = pagesOf(references).filter(entry => entry.kind === kind)
    if (candidates.length === 1) {
      // A count of files is something a page publishes even when it carries no
      // individual file, so it is checked here rather than left as a size.
      const observable = pageNumbers(candidates[0])
      if (candidates[0].files !== undefined) observable.add(Object.keys(candidates[0].files).length)
      const missing = nums.filter(value => !observable.has(value))
      if (missing.length > 0) return 'CONTRADICTED'
      // Same rule as a numbered page: a matched date is not a confirmed magnitude.
      return fullDate ? 'NOT_A_FACT' : 'CONFIRMED'
    }
  }

  // Repository-level counters: only when the sentence speaks of the repository
  // and mentions no individual page, so an Issue/PR number is never checked here.
  const repository = references.repository
  if (repository !== undefined && !/#\d+/.test(sentence) && /仓库|repo|repository/i.test(sentence)) {
    const missing = nums.filter(value => !pageNumbers({}, Object.values(repository).flat()).has(value))
    return missing.length === 0 ? 'CONFIRMED' : 'CONTRADICTED'
  }

  // A claim about a page nobody supplied is not wrong; it is unread.
  return 'UNVERIFIED'
}

/**
 * Read a letter into a ledger. `references` is `{ 'owner/repo': [page, ...] }`;
 * an empty map leaves every numbered claim UNVERIFIED, which is the honest
 * answer when the reader has no page to put beside it.
 */
export function readLetter(source, references = {}) {
  const text = Array.isArray(source) ? source.join('\n') : String(source)

  const claims = []
  // A demand is often split across a lead-in and its enumerated items
  // ("…立即采取下列措施：" followed by "（一）自送达之日起 3 日内…"). The lead-in
  // carries no number, so it never becomes a claim — and the item that follows
  // does, without the word "要求" in it. Tracking the lead-in here keeps an item
  // of a demand from being reported as an unverified *fact*.
  let afterDirective = false
  for (const sentence of sentences(text)) {
    const directive = DIRECTIVE.test(sentence)
    if (!/[0-9]/.test(sentence)) {
      afterDirective = directive || (afterDirective && /^[（(]/.test(sentence))
      continue
    }
    if (sentence.length < 12) continue
    const status = directive || (afterDirective && /^[（(]/.test(sentence))
      ? 'NOT_A_FACT'
      : classify(sentence, references)
    claims.push({ sentence, status })
    afterDirective = directive
  }

  const rows = evidenceRows(text)
  const meta = metadataRows(text)

  // Structural counts, derived from the source body rather than its title.
  const fenced = text.match(/```[\s\S]*?```/g) ?? []
  const probeReport = /(探针|probe)[^\n]*\|[\s\S]{0,80}?(200|400)/i.test(text) ? (text.match(/\n\s*\|[^\n]*(?:200|400)[^\n]*\|/g) ?? []).length : 0
  const requirements = (text.match(/^\s*\d+\.\s*(立即停止|删除|停止|撤回|关闭|将涉案仓库)/gm) ?? []).length

  const hazardsFound = hazards(text)
  // An authority placeholder is preserved verbatim; the count is published so a
  // reader can see there is exactly one per authority slot and no more.
  const authoritySlots = [...new Set(text.match(PLACEHOLDER) ?? [])]

  return {
    counts: {
      claims: claims.length,
      evidence: rows.length,
      codeBlocks: fenced.length,
      probeRows: probeReport,
      requirements,
      hazards: hazardsFound.length,
      authoritySlots: authoritySlots.length,
    },
    claims,
    evidence: rows,
    metadata: meta,
    hazards: hazardsFound,
    authoritySlots,
    numbers: proseNumbers(text),
  }
}

// ── arithmetic reconciliation ────────────────────────────────────────────────

/**
 * The source states a diff as `+X / −Y` and a changed-file count. A second copy
 * of those two numbers lives in a summary line further down. Each is a claim the
 * renderer can resolve against the other, so reconcile them rather than repeat
 * them: a source that disagrees with itself is the finding.
 */
export function reconcile(ledger, source) {
  const text = String(source)
  const results = []
  const pairs = [...text.matchAll(/\+([\d,]+)\s*[\/／]\s*[−-]([\d,]+)/g)].map(m => [Number(m[1].replace(/,/g, '')), Number(m[2].replace(/,/g, ''))])
  if (pairs.length >= 2) {
    const first = pairs[0]
    const second = pairs[1]
    results.push({
      what: '变更规模 +/−',
      stated: `${first[0].toLocaleString('en-US')} / ${first[1].toLocaleString('en-US')}`,
      restated: `${second[0].toLocaleString('en-US')} / ${second[1].toLocaleString('en-US')}`,
      agrees: first[0] === second[0] && first[1] === second[1],
    })
  }
  const files = [...text.matchAll(/([\d,]+)\s*个?文件/g)].map(m => Number(m[1].replace(/,/g, '')))
  if (files.length >= 2) {
    results.push({ what: '变更文件数', stated: String(files[0]), restated: String(files[1]), agrees: files[0] === files[1] })
  }
  // The letter's own clock: a PR it calls `Open` that the page records as closed.
  for (const page of pagesOf(ledger.references ?? {})) {
    if (page.kind !== 'pr') continue
    if (/状态\s*\|\s*\*{0,2}Open/i.test(text) && page.state === 'closed') {
      results.push({ what: `PR #${page.number} 状态`, stated: 'Open', restated: page.state, agrees: false })
    }
  }
  return results
}

// ── rendering ────────────────────────────────────────────────────────────────

/** Markdown-escape a quoted cell so a pipe in the source cannot break the table. */
const cell = value => String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim()

/**
 * A quoted claim keeps its numbers and its subject, but not its imperative voice.
 *
 * The ledger quotes claims so a reader can check them; it must not thereby
 * re-issue them. A sentence like "于 … 3 日内立即停止，7 日内下架与删除" is a
 * deadline, and printing it verbatim would put a deadline back into the artefact
 * this tool is careful not to be. Substituting a descriptive phrase keeps the
 * chronology ("what it said was to be done, and when") while dropping the demand.
 */
const DESCRIPTIVE = [
  [/立即停止/g, '（表述为停止）'],
  [/立即删除/g, '（表述为删除）'],
  [/下架与删除/g, '（表述为移除）'],
  [/正式要求[^，。；]{0,12}?采取下列措施/g, '（列出措施）'],
  [/保留采取[^，。；]{0,30}?的权利/g, '（声明保留措施）'],
  [/自送达之日起/g, '（自其声称的送达日起）'],
  [/特此函告/g, '（函件结束语）'],
  [/现函告如下/g, '（函件主旨陈述）'],
  [/若不履行/g, '（若其条件未满足）'],
]

function quote(sentence) {
  return cell(DESCRIPTIVE.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), String(sentence)))
}

/** The status counters, used by both the report and the page above the table. */
export function tally(ledger) {
  return Object.fromEntries(STATUSES.map(status => [status, ledger.claims.filter(claim => claim.status === status).length]))
}

export function renderLedger(ledger, { title = '（未命名）' } = {}) {
  const lines = []
  const { counts } = ledger
  lines.push(`# 事实核对单 · ${title}`)
  lines.push('')
  lines.push('> 本单由核对器从公开文本生成，只记录可核验的事实与结构性问题。')
  lines.push('> 它**不是**律师函，不含签署栏、不含请求或时限，也不构成任何法律意见。')
  lines.push('')
  lines.push('## 一、结构性观察')
  lines.push('')
  lines.push('| 项目 | 结果 |')
  lines.push('| --- | --- |')
  lines.push(`| 可核验的数字主张 | ${counts.claims} 条 |`)
  lines.push(`| 证据清单条目 | ${counts.evidence} 项 |`)
  lines.push(`| 代码/报文引用块 | ${counts.codeBlocks} 处 |`)
  lines.push(`| 条件-结果对照行 | ${counts.probeRows} 行 |`)
  lines.push(`| 结构性程序要求 | ${counts.requirements} 项 |`)
  lines.push(`| 占位符 | ${counts.authoritySlots} 类 |`)
  lines.push('')
  lines.push('**结构性问题（描述文书形态，不引用原文条款）：**')
  lines.push('')
  for (const hazard of ledger.hazards) lines.push(`- ${hazard}`)
  lines.push('')
  if (ledger.authoritySlots.length > 0) {
    lines.push('**原文占位符（逐字保留，本单不补全）：**')
    lines.push('')
    for (const slot of ledger.authoritySlots) lines.push(`- \`${slot}\``)
    lines.push('')
  }

  lines.push('## 二、主张核对表')
  lines.push('')
  lines.push('| # | 主张（原文摘句） | 判定 |')
  lines.push('| --- | --- | --- |')
  ledger.claims.forEach((claim, index) => {
    lines.push(`| ${index + 1} | ${quote(claim.sentence)} | ${claim.status} |`)
  })
  lines.push('')

  if (Array.isArray(ledger.reconciliation) && ledger.reconciliation.length > 0) {
    lines.push('## 三、自述数字的两处对照')
    lines.push('')
    lines.push('| 项目 | 第一处 | 第二处 | 一致 |')
    lines.push('| --- | --- | --- | --- |')
    for (const row of ledger.reconciliation) {
      lines.push(`| ${cell(row.what)} | ${cell(row.stated)} | ${cell(row.restated)} | ${row.agrees ? '是' : '**否**'} |`)
    }
    lines.push('')
  }

  lines.push('## 四、判定统计')
  lines.push('')
  const byStatus = tally(ledger)
  lines.push('| 判定 | 数量 |')
  lines.push('| --- | --- |')
  for (const status of STATUSES) lines.push(`| ${status} | ${byStatus[status]} |`)
  lines.push('')
  lines.push('> CONFIRMED 表示与所给页面一致；CONTRADICTED 表示与所给页面不一致；')
  lines.push('> UNVERIFIED 表示未提供可供对照的页面；NOT_A_FACT 表示该句是评价性或要求性表述，不属于可核事实。')
  lines.push('')
  return lines.join('\n')
}

/**
 * Read a letter and attach what the renderer needs but the classifier does not
 * compute on its own: the references it was read against, and the arithmetic
 * reconciliation of a source that restates its own numbers.
 */
export function analyse(source, references = {}) {
  const ledger = readLetter(source, references)
  ledger.references = references
  ledger.reconciliation = reconcile(ledger, source)
  return ledger
}
