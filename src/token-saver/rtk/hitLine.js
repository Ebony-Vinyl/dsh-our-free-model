/**
 * One search hit — `file:N:content` — and whether a line really is one.
 *
 * This module is the single place that answers "is this line a grep hit?",
 * because two callers need that answer and they must never disagree: the
 * autodetector (`autodetect.js`) decides whether a whole blob *is* search
 * output, and the grep compactor (`filters/grep.js`) rewrites it. While each
 * split the line itself, every change had to be made twice and the two halves
 * could drift — which is how the same predicate ended up both too wide and too
 * narrow at once.
 *
 * Both failure directions are live in the shipped code:
 *
 * - **Too wide.** `splitn(3, ':')` plus "the middle field is numeric" accepts
 *   any line carrying `:<digits>:`. An ordinary prose line —
 *   `Python.org · en · charset provider-decoded · 2026-10-15T00:00:00+00:00` —
 *   qualifies. One such line among the first five then hands the entire blob to
 *   the grep compactor, which replaces the body with a one-line summary and the
 *   model never sees the page. Issue #280.
 * - **Too narrow.** A drive-absolute path has a colon at index 1, so the same
 *   split read the file as `C` and the line number as `\dir\a.js`, failed the
 *   numeric test, and discarded *every* hit — after which the find heuristic
 *   claimed the blob and answered `N files in 1 dirs` about a search result.
 *
 * The fix for both is the same: stop assuming the file field and validate it.
 * A real hit separates a path from a line number with a colon, and a path is
 * path-shaped — it has a separator or a dot-extension, and no spaces. That
 * admits `src/a.js:12:x`, `C:\p\a.js:12:x` and `./x.js:3:y`, while rejecting
 * prose, ISO timestamps and `host:port` pairs.
 *
 * @module src/token-saver/rtk/hitLine.js
 */

/** A leading `C:` / `c:\` / `C:/` — a drive letter, not a file name. */
const RE_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/

/** A path separator or a dot-extension: what makes the file field path-shaped. */
const RE_PATH_SHAPE = /[\\/.]/

/** A path this compactor will trust carries no whitespace. */
const RE_PATH_REJECT = /\s/

/**
 * Split one candidate line into its three fields without judging whether they
 * are plausible. Callers that care use {@link isGrepHit}.
 *
 * Starting the search past a drive prefix is what makes the split work on
 * Windows; the two colons it then finds are the real field separators.
 *
 * @param {string} line - one line of tool output
 * @returns {{file: string, line: string, content: string} | null} the fields, or
 *   null when the line has fewer than two colons and cannot be a hit
 */
export function splitGrepHit(line) {
  const start = RE_DRIVE_PREFIX.test(line) ? 2 : 0
  const first = line.indexOf(':', start)
  if (first === -1) return null
  const second = line.indexOf(':', first + 1)
  if (second === -1) return null
  return {
    file: line.slice(0, first),
    line: line.slice(first + 1, second),
    content: line.slice(second + 1),
  }
}

/**
 * Is this line `file:N:content`, with a numeric line number and a file field
 * that could actually name a file?
 *
 * All three tests are necessary. The number alone accepts prose (issue #280);
 * the path shape alone accepts `2026/10/15` and `foo.py`… anything with a
 * separator or a dot. Together they describe what a search tool prints, and
 * nothing else in a tool's output has that shape.
 *
 * @param {string} line
 * @returns {boolean}
 */
export function isGrepHit(line) {
  const hit = splitGrepHit(line)
  if (hit === null) return false
  if (!/^\d+$/.test(hit.line)) return false
  if (hit.file === '' || RE_PATH_REJECT.test(hit.file)) return false
  return RE_PATH_SHAPE.test(hit.file)
}
