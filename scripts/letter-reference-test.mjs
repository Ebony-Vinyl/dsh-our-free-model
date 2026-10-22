/**
 * The GitHub reference reader: what it will fetch, and what it refuses even when
 * asked politely.
 *
 * The URL parser is a security boundary, so most of this suite is negative: a
 * scheme that is not https, a host that is not github.com, a path that is not an
 * issue or a pull request, a port that is not 443, and a redirect that would move
 * the request somewhere else must all be refused *before* a request is built. The
 * positive half proves the shape is the one the ledger expects, and that one bad
 * URL does not take the others down with it.
 *
 * No network: every fetch is a stub.
 *
 * Run: node scripts/letter-reference-test.mjs
 */
import assert from 'node:assert/strict'
import { parseReferenceUrl, apiPaths, referenceFrom, readGitHubReference, readGitHubReferences } from '../src/letter-reference.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}
const checkAsync = async (name, fn) => {
  try { await fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

/** A fetch stub: answers by path, records what was asked. */
function stubFetch(answers) {
  const calls = []
  const impl = async (url, init) => {
    calls.push({ url, init })
    const path = new URL(url).pathname + new URL(url).search
    const answer = answers[path]
    if (answer === undefined) return { ok: false, status: 404, text: async () => '' }
    if (answer instanceof Error) throw answer
    return {
      ok: answer.status === undefined || (answer.status >= 200 && answer.status < 300),
      status: answer.status ?? 200,
      text: async () => typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body),
    }
  }
  return { impl, calls }
}

// ── the URL boundary ─────────────────────────────────────────────────────────

console.log('url boundary')

check('an issue URL parses', () => {
  assert.deepEqual(parseReferenceUrl('https://github.com/octo/repo/issues/560'), { kind: 'issue', owner: 'octo', repo: 'repo', number: 560 })
})

check('a pull-request URL parses as a pr', () => {
  assert.deepEqual(parseReferenceUrl('https://github.com/octo/repo/pull/574'), { kind: 'pr', owner: 'octo', repo: 'repo', number: 574 })
})

check('a trailing slash and a trailing query are tolerated', () => {
  assert.equal(parseReferenceUrl('https://github.com/octo/repo/issues/560/')?.number, 560)
  assert.equal(parseReferenceUrl('https://github.com/octo/repo/issues/560#issuecomment-1')?.number, 560)
})

check('a non-https scheme is refused', () => {
  for (const url of ['http://github.com/octo/repo/issues/1', 'file:///etc/passwd', 'javascript:alert(1)', 'ftp://github.com/a/b/issues/1']) {
    assert.equal(parseReferenceUrl(url), null, url)
  }
})

check('a host that merely contains github.com is refused', () => {
  for (const url of [
    'https://github.com.evil.test/octo/repo/issues/1',
    'https://notgithub.com/octo/repo/issues/1',
    'https://api.github.com/repos/octo/repo',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1:8080/octo/repo/issues/1',
    'https://localhost/octo/repo/issues/1',
  ]) {
    assert.equal(parseReferenceUrl(url), null, url)
  }
})

check('a non-standard port is refused', () => {
  assert.equal(parseReferenceUrl('https://github.com:8443/octo/repo/issues/1'), null)
  assert.equal(parseReferenceUrl('https://github.com:443/octo/repo/issues/1')?.number, 1)
})

check('a path that is not an issue or pull request is refused', () => {
  for (const url of [
    'https://github.com/octo/repo',
    'https://github.com/octo/repo/discussions/12',
    'https://github.com/octo/repo/issues',
    'https://github.com/octo/repo/issues/abc',
    'https://github.com/octo/repo/issues/0',
    'https://github.com/octo/repo/issues/-1',
    'https://github.com/octo/repo/pull/1/files',
    'https://github.com/octo/repo/../../other/repo/issues/1',
  ]) {
    assert.equal(parseReferenceUrl(url), null, url)
  }
})

check('an empty or non-string input is refused', () => {
  for (const value of ['', '   ', null, undefined, 42, {}]) assert.equal(parseReferenceUrl(value), null, String(value))
})

check('the API path is built from validated parts only', () => {
  const paths = apiPaths({ kind: 'pr', owner: 'octo', repo: 'repo', number: 574 })
  assert.equal(paths.subject, '/repos/octo/repo/pulls/574')
  assert.ok(paths.files.startsWith('/repos/octo/repo/pulls/574/files'))
  assert.ok(!paths.subject.includes('//'))
})

// ── reading a page ───────────────────────────────────────────────────────────

console.log('reading')

const SUBJECT = { title: '恢复渠道', state: 'closed', created_at: '2026-10-21T08:21:28Z', closed_at: '2026-10-21T09:08:06Z' }

await checkAsync('a pull request contributes its metadata and its files', async () => {
  const stub = stubFetch({
    '/repos/octo/repo/pulls/574': { body: SUBJECT },
    '/repos/octo/repo/pulls/574/files?per_page=40': {
      body: [
        { filename: 'src/a.ts', status: 'added', size: 2468, patch: '@@' },
        { filename: 'src/gone.ts', status: 'removed', size: 10, patch: '@@' },
        { filename: 'assets/logo.png', status: 'modified', size: 900000, patch: '@@' },
        { filename: 'src/big.ts', status: 'modified', size: 999999 },
      ],
    },
  })
  const read = await readGitHubReference('https://github.com/octo/repo/pull/574', { fetchImpl: stub.impl })
  assert.equal(read.ok, true)
  assert.equal(read.repo, 'octo/repo')
  assert.equal(read.reference.kind, 'pr')
  assert.equal(read.reference.state, 'closed')
  assert.equal(read.reference.createdAt, '2026-10-21T08:21:28Z')
  // Only the small added file survives; a removed file, an oversized binary and
  // a file with no patch are all excluded.
  assert.deepEqual(Object.keys(read.reference.files), ['src/a.ts'])
  // The size is stored as a number, not as a string of that many characters.
  assert.equal(read.reference.files['src/a.ts'], 2468)
})

await checkAsync('an issue reads metadata only, with no files request', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/560': { body: SUBJECT } })
  const read = await readGitHubReference('https://github.com/octo/repo/issues/560', { fetchImpl: stub.impl })
  assert.equal(read.ok, true)
  assert.deepEqual(read.reference.files, {})
  assert.equal(stub.calls.length, 1)
  assert.ok(!stub.calls.some(call => call.url.includes('/files')))
})

await checkAsync('the request carries no token when none is given', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/1': { body: SUBJECT } })
  await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub.impl })
  assert.equal(stub.calls[0].init.headers.authorization, undefined)
})

await checkAsync('a token is sent to the API host and nowhere else', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/1': { body: SUBJECT } })
  await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub.impl, token: 'ghp_secret' })
  assert.equal(stub.calls[0].init.headers.authorization, 'Bearer ghp_secret')
  assert.ok(stub.calls[0].url.startsWith('https://api.github.com/'), stub.calls[0].url)
})

await checkAsync('the production entry point cannot be pointed at another host', async () => {
  // `apiBase` used to be an option. It is gone: a caller-supplied base is a
  // server-side request to an arbitrary host, and the only guard would have been
  // every future caller's discipline. There is no such option to pass now.
  const calls = []
  const stub = async url => { calls.push(url); return { ok: true, status: 200, text: async () => JSON.stringify(SUBJECT) } }
  await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub, apiBase: 'http://127.0.0.1:9' })
  assert.ok(calls[0].startsWith('https://api.github.com/'), `reached ${calls[0]}`)

  const listed = []
  const listStub = async url => { listed.push(url); return { ok: true, status: 200, text: async () => JSON.stringify(SUBJECT) } }
  await readGitHubReferences(['https://github.com/octo/repo/issues/1'], { fetchImpl: listStub, apiBase: 'http://127.0.0.1:9' })
  assert.ok(listed[0].startsWith('https://api.github.com/'), `reached ${listed[0]}`)
})

await checkAsync('redirects are refused, not followed', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/1': { status: 302, body: '' } })
  const read = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub.impl })
  assert.equal(read.ok, false)
  assert.equal(read.error, 'redirect-refused')
})

await checkAsync('an unsupported URL never reaches fetch', async () => {
  const stub = stubFetch({})
  const read = await readGitHubReference('https://evil.test/octo/repo/issues/1', { fetchImpl: stub.impl })
  assert.equal(read.ok, false)
  assert.equal(read.error, 'unsupported-url')
  assert.equal(stub.calls.length, 0)
})

await checkAsync('a 404 is reported, not thrown', async () => {
  const stub = stubFetch({})
  const read = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub.impl })
  assert.equal(read.ok, false)
  assert.equal(read.error, 'github-404')
})

await checkAsync('a network failure is reported, not thrown', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/1': Object.assign(new Error('boom'), { code: 'ECONNREFUSED' }) })
  const read = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub.impl })
  assert.equal(read.ok, false)
  assert.equal(read.error, 'network-ECONNREFUSED')
})

await checkAsync('a malformed body is reported, not thrown', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/1': { body: 'not json' } })
  const read = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl: stub.impl })
  assert.equal(read.ok, false)
  assert.equal(read.error, 'invalid-json')
})

/** A streaming response, so the bounded reader (not the text() fallback) runs. */
function streamingResponse(chunks, headers = {}) {
  const encoder = new TextEncoder()
  let index = 0
  return {
    ok: true,
    status: 200,
    headers: { get: name => (name === 'content-length' ? (headers['content-length'] ?? null) : null) },
    body: {
      getReader: () => ({
        read: async () => {
          if (index >= chunks.length) return { done: true, value: undefined }
          return { done: false, value: encoder.encode(chunks[index++]) }
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  }
}

await checkAsync('a body is read in chunks and parsed', async () => {
  const body = JSON.stringify(SUBJECT)
  const half = Math.floor(body.length / 2)
  const fetchImpl = async () => streamingResponse([body.slice(0, half), body.slice(half)])
  const read = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl })
  assert.equal(read.ok, true)
  assert.equal(read.reference.state, 'closed')
})

await checkAsync('a declared length over the cap is refused without reading the body', async () => {
  let reads = 0
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => String(64 * 1024 * 1024) },
    body: { getReader: () => ({ read: async () => { reads += 1; return { done: true, value: undefined } }, cancel: async () => {}, releaseLock: () => {} }) },
    text: async () => { reads += 1; return '{}' },
  })
  const read = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl })
  assert.equal(read.ok, false)
  assert.equal(read.error, 'response-too-large')
  assert.equal(reads, 0, 'the body was read despite an oversized declared length')
})

await checkAsync('a body that grows past the cap mid-stream is cut, not accumulated', async () => {
  const chunk = 'x'.repeat(1024 * 1024)
  let produced = 0
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: {
      getReader: () => ({
        read: async () => {
          produced += 1
          // An endless body: the reader must stop before the cap is exceeded.
          return { done: false, value: new TextEncoder().encode(chunk) }
        },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  })
  const bounded = await readGitHubReference('https://github.com/octo/repo/issues/1', { fetchImpl })
  assert.equal(bounded.ok, false)
  assert.equal(bounded.error, 'response-too-large')
  assert.ok(produced <= 6, `read ${produced} MB before stopping`)
})

await checkAsync('a pull request whose file list fails still contributes metadata', async () => {
  const stub = stubFetch({ '/repos/octo/repo/pulls/2': { body: SUBJECT } })
  const read = await readGitHubReference('https://github.com/octo/repo/pull/2', { fetchImpl: stub.impl })
  assert.equal(read.ok, true)
  assert.equal(read.reference.createdAt, '2026-10-21T08:21:28Z')
  assert.deepEqual(read.reference.files, {})
})

// ── the list ─────────────────────────────────────────────────────────────────

console.log('list')

await checkAsync('one bad URL does not take the others down', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/560': { body: SUBJECT } })
  const { references, skipped } = await readGitHubReferences([
    'https://github.com/octo/repo/issues/560',
    'https://evil.test/x',
    'https://github.com/octo/repo/issues/999',
  ], { fetchImpl: stub.impl })
  assert.deepEqual(Object.keys(references), ['octo/repo'])
  assert.equal(references['octo/repo'].length, 1)
  assert.equal(skipped.length, 2)
  assert.ok(skipped.some(row => row.error === 'unsupported-url'))
  assert.ok(skipped.some(row => row.error === 'github-404'))
})

await checkAsync('the same page twice is stored once', async () => {
  const stub = stubFetch({ '/repos/octo/repo/issues/1': { body: SUBJECT } })
  const { references } = await readGitHubReferences([
    'https://github.com/octo/repo/issues/1',
    'https://github.com/octo/repo/issues/1/',
  ], { fetchImpl: stub.impl })
  assert.equal(references['octo/repo'].length, 1)
})

await checkAsync('at most ten URLs are read', async () => {
  const urls = Array.from({ length: 25 }, (_, index) => `https://github.com/octo/repo/issues/${index + 1}`)
  const stub = stubFetch(Object.fromEntries(urls.map((_, index) => [`/repos/octo/repo/issues/${index + 1}`, { body: SUBJECT }])))
  await readGitHubReferences(urls, { fetchImpl: stub.impl })
  assert.ok(stub.calls.length <= 10, `${stub.calls.length} requests`)
})

await checkAsync('an empty list is allowed', async () => {
  const { references, skipped } = await readGitHubReferences([], { fetchImpl: stubFetch({}).impl })
  assert.deepEqual(references, {})
  assert.deepEqual(skipped, [])
})

await checkAsync('the list is read in parallel, not one after another', async () => {
  // Four URLs, each taking 150 ms: serial would be 600 ms, parallel ~150 ms.
  const slow = async () => {
    await new Promise(resolve => setTimeout(resolve, 150))
    return { ok: true, status: 200, text: async () => JSON.stringify(SUBJECT) }
  }
  const urls = Array.from({ length: 4 }, (_, index) => `https://github.com/octo/repo/issues/${index + 1}`)
  const started = Date.now()
  const { references } = await readGitHubReferences(urls, { fetchImpl: slow })
  const elapsed = Date.now() - started
  assert.equal(references['octo/repo'].length, 4)
  assert.ok(elapsed < 400, `took ${elapsed}ms — looks serial`)
})

await checkAsync('a list that outruns its budget is answered, not left hanging', async () => {
  // A fetch that never resolves; the budget is the only thing that ends it.
  const hang = () => new Promise(() => {})
  const urls = Array.from({ length: 3 }, (_, index) => `https://github.com/octo/repo/issues/${index + 1}`)
  const started = Date.now()
  const { skipped } = await readGitHubReferences(urls, { fetchImpl: hang, budgetMs: 120 })
  const elapsed = Date.now() - started
  assert.ok(elapsed < 1000, `took ${elapsed}ms`)
  assert.equal(skipped.length, 3)
  assert.ok(skipped.every(row => row.error === 'timeout'), JSON.stringify(skipped))
})

// ── the record shape the ledger consumes ─────────────────────────────────────

console.log('record shape')

check('the record is what the ledger expects', () => {
  const record = referenceFrom({ kind: 'pr', number: 7 }, SUBJECT, [{ filename: 'a.ts', status: 'modified', size: 10, patch: '@' }])
  assert.deepEqual(Object.keys(record).sort(), ['closedAt', 'createdAt', 'files', 'kind', 'number', 'state', 'title'])
  assert.equal(record.files['a.ts'], 10)
})

check('a file is stored at its reported size, not at its patch length', () => {
  const record = referenceFrom({ kind: 'pr', number: 7 }, SUBJECT, [{ filename: 'a.ts', status: 'modified', size: 5000, patch: '@@' }])
  assert.equal(record.files['a.ts'], 5000)
})

check('the record holds a size, not a string of that size', () => {
  // Forty files at the cap would be ~8 MB of filler if sizes were materialised.
  const files = Array.from({ length: 40 }, (_, index) => ({ filename: `f${index}.ts`, status: 'modified', size: 200 * 1024, patch: '@' }))
  const record = referenceFrom({ kind: 'pr', number: 7 }, SUBJECT, files)
  const total = Object.values(record.files).reduce((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0)
  assert.equal(total, 0, 'a size was materialised as a string')
  assert.ok(JSON.stringify(record).length < 8000, `record is ${JSON.stringify(record).length} bytes`)
})

check('an entry with no filename or no size is dropped', () => {
  const record = referenceFrom({ kind: 'pr', number: 7 }, SUBJECT, [
    { status: 'modified', size: 10, patch: '@' },
    { filename: 'b.ts', status: 'modified', patch: '@' },
    { filename: 'c.ts', status: 'modified', size: 10, patch: '@' },
  ])
  assert.deepEqual(Object.keys(record.files), ['c.ts'])
})

console.log(`\n${failures === 0 ? 'letter-reference-test: OK' : `letter-reference-test: ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
