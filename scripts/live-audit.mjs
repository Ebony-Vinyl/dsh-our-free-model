/**
 * After-publish audit: does an installed user actually get *this* release?
 *
 * `docs/RELEASING.md`'s purge step used to name only the two feed files, which
 * leaves a worse state than an unpurged CDN: the manifest goes fresh while the
 * files beside it stay on the previous commit, so every digest in a correct
 * manifest mismatches a stale byte. Measured on 2026-09-27 right after pushing
 * v1.3.1 — `…@main/index.js` answered 56 999 bytes (v1.3.0) against a manifest
 * declaring 60 224, while the same CDN under `@v1.3.1` and the commit sha both
 * answered 60 224. The upgrade fails safe (staging aborts, the old version stays
 * installed), but it fails.
 *
 * So the gate is the consumer's own path, not a curl of the manifest: download
 * the manifest from each source in order, stage every file the manifest names
 * with the plugin's own size-and-hash verification, and read it back. A source
 * that cannot be reached is reported as such — on the networks this plugin most
 * serves, `raw.githubusercontent.com` is the one that fails, which is exactly
 * why the jsDelivr leg has to be the one that proves it.
 *
 * Run: node scripts/live-audit.mjs [--source <url>]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_MANIFEST_SOURCES, downloadManifest, stageRelease, verifyStaged } from '../src/updater.js'

const only = process.argv.includes('--source') ? [process.argv[process.argv.indexOf('--source') + 1]] : DEFAULT_MANIFEST_SOURCES
let broken = 0
let unreachable = 0
let verified = 0

for (const source of only) {
  const host = new URL(source).hostname
  try {
    const { manifest, source: snapshot } = await downloadManifest([source])
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-live-audit-'))
    try {
      const staged = await stageRelease({ manifest, manifestUrl: snapshot, stageDir: stage })
      verifyStaged(stage, manifest)
      verified++
      console.log(`OK   ${host}: version=${manifest.version}, ${staged.files} files, ${staged.bytes} bytes — 全部 SHA-256 与回读校验通过 (${snapshot})`)
    } finally {
      fs.rmSync(stage, { recursive: true, force: true })
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    // A transport that never answered is this machine's network, not a bad
    // publication; a digest mismatch is the opposite and must not be excused.
    const dead = /fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|TLS|certificate|socket/i.test(message) && !/size|sha256|drift|missing/i.test(message)
    if (dead) unreachable++
    else broken++
    console.log(`${dead ? 'SKIP' : 'FAIL'} ${host}: ${message.slice(0, 400)}`)
  }
}

if (broken > 0) {
  console.log(`\n${broken} source(s) served a release that does not verify${unreachable > 0 ? ` (${unreachable} unreachable, skipped)` : ''}.`)
  console.log('A `size … != manifest …` on jsDelivr means the CDN still resolves `@main` to the')
  console.log('previous commit — purge it. The whole-tree purge is the documented first move,')
  console.log('but when it leaves individual files stale (measured 2026-10-05: the manifest')
  console.log('refreshed while four files did not), purge each path the failure named:')
  console.log('  curl "https://purge.jsdelivr.net/gh/<repo>@main"')
  console.log('  curl "https://purge.jsdelivr.net/gh/<repo>@main/<path>"   # per stale file')
  console.log('then re-run this script. Publishing to users is not done until it prints OK.')
  process.exitCode = 1
} else if (verified > 0) {
  // The jsDelivr leg is the one that has to prove it on the networks this
  // plugin most serves; raw being unreachable here is this machine's network,
  // not a publication fault, and must not turn a verified release red.
  console.log(`\n${verified} source(s) verified${unreachable > 0 ? ` (${unreachable} unreachable on this network, skipped)` : ''}; none served a bad release.`)
} else if (unreachable > 0) {
  console.log(`\nNo published copy verified from this machine: ${unreachable} source(s) unreachable, 0 served a bad release.`)
  console.log('This network is known to break raw.githubusercontent.com — run it again where it does not,')
  console.log('or against the immutable ref: --source https://cdn.jsdelivr.net/gh/<repo>@v<version>/feed/manifest.json')
  process.exitCode = 1
}
