/**
 * Point the catalog's revision fields at the last commit that touched the
 * release content — package.json plus everything in the `files` list, the
 * exact set the integrity digests describe. scripts/catalog-test.mjs computes
 * the same pointer with the same git invocation and refuses to pass a release
 * when the records disagree with it, so this script and that suite cannot
 * drift apart silently.
 *
 *     node scripts/refresh-revision.mjs
 *
 * The records travel beside the content but are not part of it: a commit that
 * only touches catalog/ and feed/ never moves the pointer, so rewriting the
 * fields here is idempotent and the suite stays green on the very commit that
 * writes them. This is the refresh step of the two-step convention in
 * docs/RELEASING.md ("Catalog records and the revision convention").
 *
 * Writes nothing when the fields already match; exits non-zero when git or the
 * catalog files are unusable rather than guessing at a revision.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

let revision
try {
  revision = execFileSync('git', ['log', '-1', '--format=%H', '--', 'package.json', ...(pkg.files ?? [])], { cwd: root, encoding: 'utf8' }).trim()
} catch (error) {
  console.error(`could not walk the git history for the release content (${error?.message ?? error})`)
  process.exit(1)
}
if (!/^[0-9a-f]{40}$/.test(revision)) {
  console.error('the release content has no commit to point at yet')
  process.exit(1)
}

const targets = [
  { file: 'catalog/dsh-plugin.json', read: doc => doc.source?.revision, write: (doc, value) => { doc.source.revision = value } },
  { file: 'catalog/provenance.json', read: doc => doc.subject?.sourceRevision, write: (doc, value) => { doc.subject.sourceRevision = value } },
]

let changed = false
for (const target of targets) {
  const file = path.join(root, target.file)
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (target.read(doc) === revision) continue
  target.write(doc, revision)
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`)
  console.log(`${target.file}: revision -> ${revision}`)
  changed = true
}
if (!changed) console.log(`catalog revision already points at ${revision}`)
