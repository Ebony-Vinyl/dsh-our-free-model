/**
 * Fetch a GitHub issue or pull request as a reference page for the receipt.
 *
 * The receipt compares a letter's numeric claims against pages the reader
 * supplies. Typing that JSON is tedious, so this turns two things a reader
 * already has — a GitHub URL and a token — into the same structure, over
 * `api.github.com` only.
 *
 * The URL parser is the security boundary, and it is deliberately narrow:
 *
 *   - only `https://github.com/<owner>/<repo>/{issues|pull}/<n>` is accepted;
 *     every other scheme, host, path shape and query is refused before a request
 *     is built. There is no redirect following — a redirect is how an allowlisted
 *     host becomes an arbitrary one — and the request host is a constant, not
 *     something derived from the input string.
 *   - the API base is fixed at construction (a seam for tests, not a request
 *     parameter), so a caller cannot point it at an internal address.
 *   - file contents are capped in count and size: a listing tells us what the
 *     pull request touched, and a file only enters the reference set when it is
 *     small enough to compare against, so a branch with a binary or a huge file
 *     does not turn into a multi-megabyte fetch.
 *
 * Failure is explicit but never fatal: a page that cannot be read is reported as
 * such, and the caller still gets a ledger for whatever did resolve.
 *
 * @module src/letter-reference.js
 */

/** The only host a reference may be read from, and the only API base used. */
export const GITHUB_WEB_HOST = 'github.com'
export const GITHUB_API_BASE = 'https://api.github.com'

/** How many files a pull request may contribute to the reference set. */
const MAX_FILES = 40
/** A file larger than this is skipped: it cannot be compared anyway. */
const MAX_FILE_BYTES = 200 * 1024
/**
 * The largest API answer accepted. A pull-request file list with forty patches
 * fits comfortably; anything past this is not a page a receipt can use, and is
 * refused while it is being read rather than after.
 */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
/** One request's ceiling; a hung GitHub must not hang the route. */
const REQUEST_TIMEOUT_MS = 12_000
/** How many URLs one call may read. */
const MAX_URLS = 10
/**
 * How long the whole list may take. Every request has its own timeout, but a
 * list of them must still fit inside the time a browser will wait for a POST —
 * the caller is a person watching a spinner, not a crawler.
 */
const TOTAL_BUDGET_MS = 25_000

/**
 * Parse a GitHub issue or pull-request URL.
 *
 * Returns `{ kind, owner, repo, number }` or `null`. Nothing about the result is
 * passed through unchecked: owner/repo are re-validated against the character set
 * GitHub allows, and the number must be a positive integer, so a crafted path
 * cannot smuggle a different API route.
 */
export function parseReferenceUrl(input) {
  const raw = String(input ?? '').trim()
  // A dot segment is refused rather than silently normalised away: `URL` would
  // resolve `…/octo/repo/../../other/repo/issues/1` to a perfectly valid path,
  // which means the URL a reader sees and the page fetched are not the same
  // string. Refusing keeps "what you pasted" and "what was read" identical.
  if (/(^|\/)\.\.?(\/|$)/.test(raw) || /%2e/i.test(raw)) return null
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.protocol !== 'https:') return null
  if (url.hostname !== GITHUB_WEB_HOST) return null
  if (url.port !== '' && url.port !== '443') return null
  // A query or fragment means the reader pasted a deep link (a comment anchor,
  // a `?tab=` view). The page is still the same page, so it is ignored rather
  // than refused — but nothing downstream reads it.
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/(\d+)\/?$/.exec(url.pathname)
  if (match === null) return null
  const number = Number(match[4])
  if (!Number.isSafeInteger(number) || number <= 0) return null
  return { kind: match[3] === 'pull' ? 'pr' : 'issue', owner: match[1], repo: match[2], number }
}

/** The API path for a parsed reference. Built from validated parts, never from raw input. */
export function apiPaths({ kind, owner, repo, number }) {
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  return {
    subject: `${base}/${kind === 'pr' ? 'pulls' : 'issues'}/${number}`,
    files: `${base}/pulls/${number}/files?per_page=${MAX_FILES}`,
  }
}

/** A fetch that can be swapped in tests; production never changes it. */
const defaultFetch = (input, init) => fetch(input, init)

/** One JSON request with a deadline, no redirects, and a size ceiling. */
async function getJson(fetchImpl, base, path, { token = '', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-our-free-model' }
    // A token only raises the rate limit; it is never required, and it is sent to
    // the fixed API host only. It is not logged and not returned.
    if (token !== '') headers.authorization = `Bearer ${token}`
    const response = await fetchImpl(`${base}${path}`, {
      headers,
      redirect: 'manual',
      signal: controller.signal,
    })
    if (response.status >= 300 && response.status < 400) return { error: 'redirect-refused', status: response.status }
    if (!response.ok) return { error: `github-${response.status}`, status: response.status }
    // Refuse on the advertised length first: reading the body and *then* checking
    // it means an oversized answer is already in memory by the time it is refused.
    const declared = Number(response.headers?.get?.('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) return { error: 'response-too-large' }
    const text = await readBounded(response, MAX_RESPONSE_BYTES)
    if (text === null) return { error: 'response-too-large' }
    try { return { value: JSON.parse(text) } } catch { return { error: 'invalid-json' } }
  } catch (error) {
    return { error: controller.signal.aborted ? 'timeout' : `network-${error?.code ?? 'error'}` }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read a response body up to `limit` bytes, or `null` once it exceeds that.
 *
 * Streamed rather than `text()`ed so an answer that keeps growing is cut while
 * it is being read: the cap has to apply to the bytes that actually arrive, not
 * to a length the server merely declared.
 */
async function readBounded(response, limit) {
  if (typeof response.body?.getReader !== 'function') {
    // A stub or an unusual runtime: fall back to text(), still bounded after.
    const text = await response.text()
    return text.length > limit ? null : text
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value?.byteLength ?? 0
      if (size > limit) { await reader.cancel().catch(() => {}); return null }
      text += decoder.decode(value, { stream: true })
    }
    return text + decoder.decode()
  } finally {
    reader.releaseLock?.()
  }
}

/** The reference record the ledger understands, from a subject + its file list. */
export function referenceFrom(parsed, subject, files) {
  const sizeOf = entry => Number(entry?.size)
  const wanted = (Array.isArray(files) ? files : [])
    .filter(entry => typeof entry?.filename === 'string' && entry.filename !== '')
    .filter(entry => entry.status !== 'removed')
    .filter(entry => Number.isFinite(sizeOf(entry)) && sizeOf(entry) <= MAX_FILE_BYTES)
    .filter(entry => typeof entry.patch === 'string')
  return {
    kind: parsed.kind,
    number: parsed.number,
    title: typeof subject?.title === 'string' ? subject.title : '',
    state: String(subject?.state ?? ''),
    createdAt: typeof subject?.created_at === 'string' ? subject.created_at : '',
    closedAt: typeof subject?.closed_at === 'string' ? subject.closed_at : '',
    // The ledger compares against byte length, and it accepts a number directly:
    // storing the size itself keeps forty files at a few dozen bytes instead of
    // materialising a string of that many characters per file.
    files: Object.fromEntries(wanted.map(entry => [entry.filename, sizeOf(entry)])),
  }
}

/**
 * Read one GitHub page into a reference record.
 *
 * The API base is *not* a parameter. It was during development, as a test seam —
 * but a caller-supplied base is a server-side request to an arbitrary host, and
 * the only thing standing between that and the user's own network is the
 * discipline of every future caller. `createReferenceReader` is the seam instead:
 * it binds the base once, at construction, where a test can point it at a stub
 * and production never can.
 *
 * @param {string} url - the GitHub issue or pull-request URL
 * @param {object} [options]
 * @param {string} [options.token] - optional; raises the API rate limit
 * @param {typeof fetch} [options.fetchImpl] - test seam
 * @returns {Promise<{ok: true, reference: object, repo: string} | {ok: false, error: string}>}
 */
export async function readGitHubReference(url, { token = '', fetchImpl = defaultFetch } = {}) {
  return readWith(GITHUB_API_BASE, url, { token, fetchImpl })
}

/** The shared body of a read, against a base the caller already fixed. */
async function readWith(apiBase, url, { token, fetchImpl }) {
  const parsed = parseReferenceUrl(url)
  if (parsed === null) return { ok: false, error: 'unsupported-url' }
  const paths = apiPaths(parsed)
  const repo = `${parsed.owner}/${parsed.repo}`

  const subject = await getJson(fetchImpl, apiBase, paths.subject, { token })
  if (subject.error !== undefined) return { ok: false, error: subject.error }

  // Only a pull request has a files endpoint; an issue contributes its own
  // metadata and nothing else, which is the honest answer.
  let files = []
  if (parsed.kind === 'pr') {
    const listed = await getJson(fetchImpl, apiBase, paths.files, { token })
    // A pull request whose file list cannot be read still contributes its
    // metadata: the date and the state are facts the page publishes either way.
    if (listed.error === undefined && Array.isArray(listed.value)) files = listed.value
  }

  return { ok: true, repo, reference: referenceFrom(parsed, subject.value, files) }
}

/**
 * A reader bound to one API base. Tests use this to point at a local stub; the
 * exported `readGitHubReference` is the production entry point and has no way to
 * name a different host.
 */
export function createReferenceReader({ apiBase = GITHUB_API_BASE, fetchImpl = defaultFetch } = {}) {
  return {
    read: (url, { token = '' } = {}) => readWith(apiBase, url, { token, fetchImpl }),
    readAll: (urls, options = {}) => readAllWith(readWith, apiBase, fetchImpl, urls, options),
  }
}

/**
 * Read a list of URLs into `{ references, skipped }`.
 *
 * Every URL is independent and they are read in parallel: a serial loop made the
 * route's worst case the *sum* of every page's timeout (ten links, each with a
 * subject and a file request, is a five-minute request that no browser will wait
 * for). Parallel reads bound it at one page's cost.
 *
 * The whole list also shares a deadline. A page that has not answered by then is
 * reported as skipped rather than left to hold the response open, so the caller
 * always gets a ledger — the reason this route exists is a paste the user is
 * waiting on, not a complete crawl.
 */
export async function readGitHubReferences(urls, { fetchImpl = defaultFetch, ...options } = {}) {
  return readAllWith(readWith, GITHUB_API_BASE, fetchImpl, urls, options)
}

/** The shared body of a list read, against a base the caller already fixed. */
async function readAllWith(readWithImpl, apiBase, fetchImpl, urls, options = {}) {
  const { budgetMs = TOTAL_BUDGET_MS, token = '' } = options
  const requested = (Array.isArray(urls) ? urls : []).slice(0, MAX_URLS)
    .filter(url => typeof url === 'string' && url.trim() !== '')
    .map(url => url.trim())
  if (requested.length === 0) return { references: {}, skipped: [] }

  const deadline = Budget(budgetMs)
  let results
  try {
    results = await Promise.all(requested.map(async url => {
      // A budget already spent means no further request is started: the caller
      // gets an answer now rather than a promise about a page it cannot show.
      if (deadline.expired()) return { url, error: 'budget-exhausted' }
      const read = await Promise.race([
        readWithImpl(apiBase, url, { token, fetchImpl }),
        deadline.reached.then(() => ({ ok: false, error: 'timeout' })),
      ])
      return read.ok === true ? { url, read } : { url, error: read.error }
    }))
  } finally {
    deadline.settle()
  }

  const references = {}
  const skipped = []
  for (const result of results) {
    if (result.error !== undefined) {
      skipped.push({ url: result.url, error: result.error })
      continue
    }
    const pages = references[result.read.repo] ?? (references[result.read.repo] = [])
    if (pages.some(page => page.kind === result.read.reference.kind && page.number === result.read.reference.number)) continue
    pages.push(result.read.reference)
  }
  return { references, skipped }
}

/** A shared deadline that answers `reached` when it expires, and never leaks a timer. */
function Budget(ms) {
  let fired = false
  let resolve
  const reached = new Promise(done => { resolve = done })
  const timer = setTimeout(() => { fired = true; resolve() }, ms)
  // The timer must not keep the process alive once the list has resolved.
  if (typeof timer.unref === 'function') timer.unref()
  return {
    reached,
    expired: () => fired,
    settle: () => { clearTimeout(timer) },
  }
}
