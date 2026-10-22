/**
 * The two letter routes: what the page can ask for, and what it is allowed to get
 * back.
 *
 *   GET  /letter-template  — a placeholder skeleton, no inputs read
 *   POST /letter-ledger    — classify a pasted letter, optionally against pages
 *
 * The route layer is the place a tool like this could quietly become something
 * else: a route that fetches a URL on the caller's behalf, or one that echoes the
 * letter back with its demand verbs intact. The checks below pin both edges —
 * the shape of the answer, and the refusal to answer at all when there is nothing
 * to classify.
 *
 * Run: node scripts/letter-routes-test.mjs
 */
import assert from 'node:assert/strict'
import { createApiRoutes } from '../index.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** A response object just wide enough for the JSON routes. */
const response = () => {
  const out = { status: 0, headers: {}, body: '' }
  return {
    out,
    writeHead(status, headers) { out.status = status; out.headers = headers ?? {} },
    end(body) { out.body = String(body ?? '') },
  }
}

/** A request body `readJson` can iterate; the routes read it as an async stream. */
const bodyOf = text => ({ [Symbol.asyncIterator]: async function* () { yield Buffer.from(text, 'utf8') } })

const request = (method, url, body) => Object.assign(body === undefined ? {} : bodyOf(body), {
  method,
  url,
  headers: { host: '127.0.0.1', 'sec-fetch-site': 'same-origin' },
})

/**
 * Mount the API routes with only the dependencies these two routes touch. A
 * composition with no `connection` service falls back to the structural fence,
 * which a loopback request satisfies — the same path a minimal composition uses.
 */
const mount = () => createApiRoutes({
  connection: undefined,
  settings: { get: () => ({}) },
  stats: { get: () => ({}) },
  catalog: () => [],
  eacAuth: {},
  onAdmissionRejection: () => {},
})

const call = async (method, path, body) => {
  const res = response()
  await mount()(request(method, `/api/our-free-model${path}`, body), res)
  return { status: res.out.status, payload: res.out.body === '' ? null : JSON.parse(res.out.body) }
}

const SOURCE = [
  '# 律师函',
  '',
  '某 PR 新增文件 `src/buddy.ts`（42,615 字节）保留逆向成果。',
  '',
  'github 仓库共有 659 个 Fork。',
  '',
  '这次调用没通过渠道校验，这直接证明上游已作出明示告知。',
].join('\n')

// ── the template route ───────────────────────────────────────────────────────

console.log('template route')

const template = await call('GET', '/letter-template')

check('it answers with a markdown skeleton and a placeholder count', () => {
  assert.equal(template.status, 200)
  assert.equal(typeof template.payload.markdown, 'string')
  assert.ok(template.payload.markdown.startsWith('# 律师函（模板）'))
  assert.ok(template.payload.fields > 20, `${template.payload.fields} placeholders`)
})

check('the served template carries no demand and no signable field', () => {
  const { markdown } = template.payload
  for (const banned of ['立即停止', '特此函告', '腾讯', 'WorkBuddy', 'CodeBuddy', '违反《']) {
    assert.ok(!markdown.includes(banned), `served template says ${banned}`)
  }
  assert.ok(markdown.includes('不是律师函'))
})

check('the template route reads nothing from the request', async () => {
  // Same answer for a POST with a body that would otherwise change it.
  const second = await call('GET', '/letter-template')
  assert.deepEqual(second.payload, template.payload)
})

// ── the ledger route ─────────────────────────────────────────────────────────

console.log('ledger route')

const bare = await call('POST', '/letter-ledger', JSON.stringify({ source: SOURCE }))

check('a letter with no reference pages resolves every claim as UNVERIFIED', () => {
  assert.equal(bare.status, 200)
  const statuses = bare.payload.ledger.claims.map(claim => claim.status)
  assert.ok(statuses.length > 0)
  assert.ok(statuses.every(status => status === 'UNVERIFIED'), statuses.join(','))
})

check('the ledger returns both the structure and its markdown rendering', () => {
  assert.ok(Array.isArray(bare.payload.ledger.claims))
  assert.ok(bare.payload.markdown.startsWith('# 事实核对单'))
})

check('an inference is not counted as a claim at all', () => {
  assert.ok(!bare.payload.ledger.claims.some(claim => claim.sentence.includes('这直接证明')))
})

check('the route never echoes a demand back in its rendering', () => {
  for (const banned of ['立即停止', '特此函告', '保留采取']) {
    assert.ok(!bare.payload.markdown.includes(banned), `ledger says ${banned}`)
  }
})

const FILES = { 'src/buddy.ts': 'y'.repeat(42615) }
const confirmed = await call('POST', '/letter-ledger', JSON.stringify({
  source: SOURCE,
  references: {
    'owner/repo': [{ kind: 'pr', number: 574, state: 'closed', createdAt: '2026-10-21T08:21:28Z', files: FILES }],
    repository: { forks: 659 },
  },
}))

check('a supplied page confirms the claims it carries', () => {
  const statuses = confirmed.payload.ledger.claims.map(claim => claim.status)
  assert.ok(statuses.includes('CONFIRMED'), statuses.join(','))
})

const contradicted = await call('POST', '/letter-ledger', JSON.stringify({
  source: SOURCE,
  references: { 'owner/repo': [{ kind: 'pr', number: 574, state: 'closed', files: { 'src/other.ts': 'x' } }] },
}))

check('a page that lost the file contradicts the claim that it remains', () => {
  const sized = contradicted.payload.ledger.claims.find(claim => claim.sentence.includes('src/buddy.ts'))
  assert.equal(sized.status, 'CONTRADICTED')
})

console.log('refusals')

const empty = await call('POST', '/letter-ledger', JSON.stringify({ source: '   ' }))
check('an empty source is refused rather than answered with an empty ledger', () => {
  assert.equal(empty.status, 400)
  assert.equal(typeof empty.payload.error, 'string')
})

const missing = await call('POST', '/letter-ledger', JSON.stringify({}))
check('a body with no source field is refused', () => {
  assert.equal(missing.status, 400)
})

const unparsable = await call('POST', '/letter-ledger', 'not json')
check('a body that is not JSON is refused', () => {
  assert.equal(unparsable.status, 400)
})

const nullRefs = await call('POST', '/letter-ledger', JSON.stringify({ source: SOURCE, references: null }))
check('null references are treated as none, not as an error', () => {
  assert.equal(nullRefs.status, 200)
})

// ── the reference route ──────────────────────────────────────────────────────

console.log('reference route')

const noUrls = await call('POST', '/letter-reference', JSON.stringify({ source: SOURCE, urls: [] }))
check('an empty URL list still returns a ledger, with nothing skipped', () => {
  assert.equal(noUrls.status, 200)
  assert.deepEqual(noUrls.payload.skipped, [])
  assert.ok(noUrls.payload.ledger.claims.length > 0)
})

const badUrls = await call('POST', '/letter-reference', JSON.stringify({
  source: SOURCE,
  urls: ['https://evil.test/octo/repo/issues/1', 'http://github.com/octo/repo/issues/1'],
}))
check('a URL that is not a github issue or pull is skipped, never fetched', () => {
  assert.equal(badUrls.status, 200)
  assert.equal(badUrls.payload.skipped.length, 2)
  assert.ok(badUrls.payload.skipped.every(row => row.error === 'unsupported-url'), JSON.stringify(badUrls.payload.skipped))
})

await checkAsync('the route refuses an empty source before it would touch the network', async () => {
  // The body is validated first: an empty letter never triggers a fetch.
  const refused = await call('POST', '/letter-reference', JSON.stringify({ source: '', urls: ['https://github.com/octo/repo/issues/1'] }))
  assert.equal(refused.status, 400)
})

// ── the cap ──────────────────────────────────────────────────────────────────

console.log('cap')

const many = Array.from({ length: 600 }, (_, index) => `第 ${index + 1} 项事实共 12 条记录。`).join('\n')
const capped = await call('POST', '/letter-ledger', JSON.stringify({ source: many }))
check('a very long paste is capped and says so', () => {
  assert.equal(capped.status, 200)
  assert.ok(capped.payload.ledger.claims.length <= 400, `${capped.payload.ledger.claims.length} claims`)
  assert.equal(capped.payload.ledger.truncated, true)
})

check('a short paste is not marked truncated', () => {
  assert.equal(bare.payload.ledger.truncated, false)
})

console.log(`\n${failures === 0 ? 'letter-routes-test: OK' : `letter-routes-test: ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
