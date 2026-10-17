/**
 * Shared esbuild resolver for the offline suites that must load the REAL
 * TypeScript sources (the vendored channel-pack adapters).
 *
 * Why it exists: `src/` is TypeScript with `.js`-style specifiers that Node
 * cannot resolve on its own, so loading the real module (instead of a copy of
 * its logic) means bundling it with esbuild first — the same tool
 * `build-channel-pack.mjs` uses. The resolution itself has to survive three
 * environments: an install-free checkout (`npm install` never ran, e.g. the CI
 * `offline` job, which stays install-free by design), a dev checkout with
 * `node_modules/`, and an ecosystem pack that keeps esbuild in a sibling
 * checkout (`OFM_ESBUILD_DIR`/`OF_ESBUILD_DIR`, per build-channel-pack.mjs).
 *
 * A suite that needs the toolchain calls `loadEsbuild()` and, when it returns
 * `null`, prints a SKIP line and exits 0 — the suite is not silently missing
 * from the runner's list, it declares why it could not run. `test-all` turns
 * skips into a visible counter, and `--mode release` fails on them: a release
 * may not ship with promo plumbing unverified.
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = path.join(fileURLToPath(new URL('../..', import.meta.url)))

/** Resolve esbuild against env overrides, the cwd, and the repo root. */
export function resolveEsbuildPath() {
  const require = createRequire(import.meta.url)
  const candidates = [process.env.OF_ESBUILD_DIR, process.env.OFM_ESBUILD_DIR, process.cwd(), repoRoot].filter(Boolean)
  try {
    return require.resolve('esbuild', { paths: candidates })
  } catch {
    return null
  }
}

/**
 * Import the real esbuild module, or return `null` when the toolchain is not
 * installed. Callers decide whether that is a skip (offline dev/CI without
 * `npm install`) or a failure (`OFM_REQUIRE_ESBUILD=1`).
 */
export async function loadEsbuild() {
  const esbuildPath = resolveEsbuildPath()
  if (esbuildPath === null) return null
  return import(pathToFileURL(esbuildPath).href)
}

/**
 * The skip protocol every esbuild-dependent offline suite shares: load the
 * toolchain, and when it is missing print `SKIP <name> (<reason>)` and exit —
 * unless the run declares the suites non-optional (`OFM_REQUIRE_ESBUILD=1`,
 * which the CI promo job sets), where the missing toolchain is a failure.
 *
 * Why skip-instead-of-fail: the CI `offline` job is install-free by design
 * (plain Node suites, nothing that could spend free-lane quota). A hard fail
 * there would force an install step onto a job whose whole comment says it does
 * not have one; a silent omission would be exactly the hole this protocol is
 * closing — tests that exist but nobody runs. A visible SKIP line plus the
 * runner's skip counter is the honest middle, and the dedicated promo job (with
 * `npm install`) is where they actually gate.
 */
export async function loadEsbuildOrSkip(name) {
  const esbuild = await loadEsbuild()
  if (esbuild !== null) return esbuild
  if (process.env.OFM_REQUIRE_ESBUILD === '1') {
    console.error(`${name}: esbuild is required (OFM_REQUIRE_ESBUILD=1) but not installed`)
    process.exit(1)
  }
  console.log(`SKIP ${name} (esbuild not installed — run \`npm install\` or set OFM_ESBUILD_DIR)`)
  process.exit(0)
}

/**
 * The banner every bundled-CJS graph needs: undici/jose call `require()` for
 * node builtins, and esbuild's ESM output has no `require` in scope without it.
 * Same two lines `build-channel-pack.mjs` emits.
 */
export const ESM_REQUIRE_BANNER = [
  "import { createRequire as __ofmCreateRequire } from 'node:module'",
  'const require = __ofmCreateRequire(import.meta.url)',
].join('\n')
