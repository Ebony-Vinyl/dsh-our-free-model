/**
 * Trusted, data-only release preparation. Run this script from reviewed main;
 * candidate files are read with git show, never checked out or imported.
 *
 * OFM_RELEASE_SIGNING_KEY contains the existing publisher's PEM (not a path).
 * Output is a candidate-bound patch and receipt, with no commits or pushes.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  compareVersions, parseManifest, parseVersion, signManifest,
  verifyManifestSignature, PINNED_MANIFEST_PUBLIC_KEYS,
} from '../src/updater.js'
import { publishedBytes } from './lib/published-bytes.mjs'

const SHA = /^[0-9a-f]{40}$/
const OUTPUT_FILES = ['feed/manifest.json', 'catalog/integrity.json', 'catalog/dsh-plugin.json', 'catalog/provenance.json']
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const safePath = rel => typeof rel === 'string' && rel !== '' && rel === rel.trim()
  && !/[\\:\0\r\n]/.test(rel)
  && rel.split('/').every(part => part !== '' && part !== '.' && part !== '..')
  && !rel.startsWith('/')

/**
 * verificationKey is injectable only through this testable API. The CLI always
 * uses the trusted checkout's pinned public key; it has no public-key override.
 */
export function prepareRelease({ repo, base, candidate, signingKey, output, verificationKey = PINNED_MANIFEST_PUBLIC_KEYS }) {
  if (!SHA.test(base) || !SHA.test(candidate)) throw new Error('base and candidate must be full lowercase commit SHAs')
  if (!signingKey) throw new Error('the existing release signing key is required')
  const git = args => execFileSync('git', args, { cwd: repo, maxBuffer: 8 * 1024 * 1024 })
  for (const revision of [base, candidate]) {
    if (git(['rev-parse', `${revision}^{commit}`]).toString().trim() !== revision) throw new Error('revision must identify a commit')
  }
  git(['merge-base', '--is-ancestor', base, candidate])
  const treeAt = revision => {
    const entries = new Map()
    for (const row of git(['ls-tree', '-r', '-z', '--full-tree', revision]).toString().split('\0').filter(Boolean)) {
      const match = /^(\d+) (\w+) ([a-f0-9]+)\t(.+)$/s.exec(row)
      if (!match) throw new Error('unrecognized Git tree entry')
      entries.set(match[4], { mode: match[1], type: match[2] })
    }
    return entries
  }
  const candidateTree = treeAt(candidate)
  const baseTree = treeAt(base)
  const read = (revision, tree, rel) => {
    const entry = tree.get(rel)
    if (!safePath(rel) || !entry || !['100644', '100755'].includes(entry.mode) || entry.type !== 'blob') {
      throw new Error(`expected a tracked regular file: ${rel}`)
    }
    const bytes = git(['show', `${revision}:${rel}`])
    if (bytes.length > 4 * 1024 * 1024) throw new Error(`file exceeds release size limit: ${rel}`)
    return bytes
  }
  const readJson = (revision, tree, rel) => JSON.parse(read(revision, tree, rel).toString('utf8'))
  const pkg = readJson(candidate, candidateTree, 'package.json')
  const previous = readJson(base, baseTree, 'feed/manifest.json')
  if (typeof pkg.version !== 'string' || pkg.version !== pkg.version.trim() || parseVersion(pkg.version) === null) {
    throw new Error('candidate package has no valid version')
  }
  if (compareVersions(pkg.version, previous.version) < 0) throw new Error('refusing a release version downgrade')
  if (!Array.isArray(pkg.files) || pkg.files.length === 0 || pkg.files.length > 80) throw new Error('invalid package files list')
  const shipped = ['package.json', ...pkg.files]
  const selected = new Set()
  for (const rel of shipped) {
    if (!safePath(rel) || rel.split('/').some(part => part.startsWith('.') || part === 'node_modules')) {
      throw new Error(`unsafe package files entry: ${rel}`)
    }
    const matches = candidateTree.has(rel) ? [rel] : [...candidateTree.keys()].filter(file =>
      file.startsWith(`${rel}/`) && !file.slice(rel.length + 1).split('/').some(part => part.startsWith('.') || part === 'node_modules'))
    if (matches.length === 0) throw new Error(`package files entry does not exist: ${rel}`)
    for (const file of matches) {
      if (OUTPUT_FILES.includes(file)) throw new Error('release metadata must not be part of the signed file set')
      if (selected.has(file)) throw new Error(`overlapping package files entry: ${file}`)
      selected.add(file)
    }
  }
  const files = [...selected].map(rel => {
    const bytes = publishedBytes(read(candidate, candidateTree, rel))
    return { path: rel, size: bytes.length, sha256: sha256(bytes) }
  }).sort((a, b) => a.path.localeCompare(b.path))
  const candidateManifest = readJson(candidate, candidateTree, 'feed/manifest.json')
  const manifest = {
    version: pkg.version,
    base: '../',
    publishedAt: new Date().toISOString(),
    notes: candidateManifest.version === pkg.version && typeof candidateManifest.notes === 'string' ? candidateManifest.notes : '',
    files,
  }
  manifest.signature = signManifest(parseManifest(manifest), signingKey)
  if (!verifyManifestSignature(parseManifest(manifest), verificationKey)) {
    throw new Error('the signing key does not match the trusted pinned release key')
  }
  // Literal pathspecs prevent candidate package data from being Git options or
  // pathspec magic. Metadata is not published content, so this pointer remains
  // valid after a separate signature/catalog commit.
  const contentRevision = git(['log', '-1', '--format=%H', candidate, '--', ...shipped.map(rel => `:(literal)${rel}`)]).toString().trim()
  if (!SHA.test(contentRevision)) throw new Error('could not resolve the content revision')
  const catalog = readJson(candidate, candidateTree, 'catalog/dsh-plugin.json')
  const provenance = readJson(candidate, candidateTree, 'catalog/provenance.json')
  if (!catalog.source || !provenance.subject) throw new Error('missing catalog source or provenance subject')
  catalog.version = pkg.version
  catalog.source.revision = contentRevision
  provenance.subject.version = pkg.version
  provenance.subject.sourceRevision = contentRevision
  const documents = [
    manifest,
    { version: pkg.version, algorithm: 'sha256', files },
    catalog,
    provenance,
  ]
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-signature-'))
  const changedPaths = []
  let patch
  try {
    for (let index = 0; index < OUTPUT_FILES.length; index += 1) {
      const rel = OUTPUT_FILES[index]
      const before = read(candidate, candidateTree, rel)
      const after = jsonBytes(documents[index])
      if (!before.equals(after)) changedPaths.push(rel)
      for (const side of ['a', 'b']) fs.mkdirSync(path.dirname(path.join(scratch, side, rel)), { recursive: true })
      fs.writeFileSync(path.join(scratch, 'a', rel), before)
      fs.writeFileSync(path.join(scratch, 'b', rel), after)
    }
    const diff = spawnSync('git', ['diff', '--no-index', '--no-renames', '--no-ext-diff', '--no-textconv', '--src-prefix=', '--dst-prefix=', 'a', 'b'], {
      cwd: scratch, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024,
    })
    if (diff.error || ![0, 1].includes(diff.status)) throw new Error('could not create the release patch')
    patch = diff.stdout
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
  const receipt = {
    version: 1, base, candidate, contentRevision,
    releaseVersion: pkg.version, files: files.length,
    patchSha256: sha256(patch),
    changedPaths,
  }
  // Never overwrite an older artifact, even when the new candidate is valid.
  fs.mkdirSync(output, { recursive: false })
  fs.writeFileSync(path.join(output, 'release.patch'), patch)
  fs.writeFileSync(path.join(output, 'receipt.json'), jsonBytes(receipt))
  return receipt
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = {}
    for (let index = 2; index < process.argv.length; index += 1) {
      const flag = process.argv[index]
      if (!['--base', '--candidate', '--output'].includes(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
        throw new Error('usage: node scripts/prepare-release.mjs --base SHA --candidate SHA --output NEW_DIRECTORY')
      }
      options[flag.slice(2)] = process.argv[++index]
    }
    const repo = fileURLToPath(new URL('..', import.meta.url))
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    if (head !== options.base) throw new Error('run the signer from the trusted base checkout')
    const key = process.env.OFM_RELEASE_SIGNING_KEY
    delete process.env.OFM_RELEASE_SIGNING_KEY
    const receipt = prepareRelease({ repo, ...options, signingKey: key })
    console.log(`prepared ${receipt.releaseVersion}: ${receipt.files} files for ${receipt.candidate}; no commits or pushes`)
  } catch (error) {
    console.error(`release preparation failed: ${error.message}`)
    process.exitCode = 1
  }
}
