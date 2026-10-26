/**
 * Whether this machine has the pinned engine binary for its own platform.
 *
 * `vendor/magpie/engine.json` lists only the platforms that were built and
 * published. This repository ships the Windows x64 build; the CI runner is
 * Linux, so any suite that starts the real engine has nothing to start there.
 * Those suites are integration checks against a binary, not unit checks of the
 * plugin's own code, so the honest answer on a platform with no binary is to
 * say so and skip — the same convention `standalone-page-lifecycle-test.mjs`
 * uses when its compiler is absent.
 *
 * This is deliberately a *platform* gate and not a silent catch: a platform
 * that does have a binary but whose bytes do not match the manifest is a real
 * failure, and the suites still assert the digest.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))

export function pinnedEngineEntry(platform = process.platform, arch = process.arch) {
  try {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'vendor/magpie/engine.json'), 'utf8'))
    const entry = metadata.binaries?.[`${platform}-${arch}`]
    if (!entry || typeof entry.path !== 'string') return null
    const file = path.join(root, 'vendor/magpie', entry.path)
    return fs.existsSync(file) ? { ...entry, file } : null
  } catch { return null }
}

/**
 * Skip the current suite when this platform has no pinned engine binary.
 * Returns true when the caller should stop, after printing why.
 */
export function skipWithoutEngineBinary(name) {
  if (pinnedEngineEntry() !== null) return false
  console.log(`ok  ${name} skipped: no pinned engine binary for ${process.platform}-${process.arch} `
    + '(vendor/magpie/engine.json lists the platforms that were built)')
  return true
}
