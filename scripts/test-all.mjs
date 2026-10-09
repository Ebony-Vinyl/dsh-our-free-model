/**
 * Run every offline suite in one command.
 *
 *     node scripts/test-all.mjs [--mode all|contributor|release] [--only <name>]
 *
 * These are the checks that need no network and spend no free-lane quota: each
 * one mounts the real module against a local stand-in. The live end-to-end run
 * against the gateway is separate and costs minutes and quota, so it stays a
 * deliberate act: `node scripts/host-selftest.mjs`.
 *
 * The default includes the manifest check because shipping a manifest that
 * disagrees with its files breaks the in-app upgrade for every user at once
 * (issue #1), and nothing else fails when that happens.
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptsDir = fileURLToPath(new URL('.', import.meta.url))
const options = { mode: 'all', only: null }
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index]
  if (!['--mode', '--only'].includes(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    console.error(`usage: node scripts/test-all.mjs [--mode all|contributor|release] [--only <name>] (invalid ${flag})`)
    process.exit(1)
  }
  options[flag.slice(2)] = process.argv[++index]
}
if (!['all', 'contributor', 'release'].includes(options.mode)) {
  console.error(`unknown test mode "${options.mode}"`)
  process.exit(1)
}
const { mode, only } = options
const releaseSuites = new Set(['manifest', 'release', 'catalog'])

const suites = [
  ['manifest', 'build-manifest.mjs', ['--check']],
  ['release', 'release-e2e.mjs', []],
  ['release-preparation', 'release-preparation-test.mjs', []],
  ['client-lint', 'client-lint.mjs', []],
  ['heatmap', 'heatmap-test.mjs', []],
  ['trust', 'trust-test.mjs', []],
  ['sanitize', 'sanitize-test.mjs', []],
  ['feed', 'feed-test.mjs', []],
  ['updater', 'updater-test.mjs', []],
  ['upgrade-ui', 'upgrade-ui-test.mjs', []],
  ['forward', 'forward-test.mjs', []],
  ['chan-relay', 'chan-relay-test.mjs', []],
  ['channel-pack', 'channel-pack-test.mjs', []],
  ['forward-boot', 'forward-boot-test.mjs', []],
  ['standalone', 'standalone-test.mjs', []],
  ['standalone-management', 'standalone-management-test.mjs', []],
  ['standalone-frontend', 'standalone-frontend-test.mjs', []],
  ['standalone-channels', 'standalone-channels-test.mjs', []],
  ['egress', 'egress-test.mjs', []],
  ['effort', 'effort-test.mjs', []],
  ['projection', 'projection-test.mjs', []],
  ['fingerprint', 'fingerprint-test.mjs', []],
  ['sniff', 'sniff-test.mjs', []],
  ['truncation', 'truncation-test.mjs', []],
  ['recovery', 'recovery-test.mjs', []],
  ['retry-safety', 'retry-safety-test.mjs', []],
  ['speed-stat', 'speed-stat-test.mjs', []],
  ['picker', 'picker-test.mjs', []],
  ['tui', 'tui-test.mjs', []],
  ['catalog', 'catalog-test.mjs', mode === 'contributor' ? ['--contributor'] : []],
  ['vault', 'vault-test.mjs', []],
  ['eac-auth', 'eac-auth-test.mjs', []],
  ['eac-login', 'eac-login-test.mjs', []],
  ['kilo', 'kilo-test.mjs', []],
  // The promo plumbing: contract projection, four producer shapes, the client
  // render in all four scenarios. Six of these load real TypeScript and need
  // esbuild; without an install they print a visible SKIP line instead of
  // silently not existing — the CI `promo` job installs the toolchain and
  // (via OFM_REQUIRE_ESBUILD=1) turns any skip into a failure.
  ['promo-contract', 'promo-contract-test.mjs', []],
  ['promo-buddy', 'promo-buddy-test.mjs', []],
  ['promo-qoder', 'promo-qoder-test.mjs', []],
  ['promo-raccoon', 'promo-raccoon-test.mjs', []],
  ['promo-trae', 'promo-trae-test.mjs', []],
  ['promo-trae-transport', 'promo-trae-transport-test.mjs', []],
  ['promo-badge-remote', 'promo-badge-test.mjs', ['remote']],
  ['promo-badge-fallback', 'promo-badge-test.mjs', ['fallback']],
  ['promo-badge-legacy', 'promo-badge-test.mjs', ['legacy']],
  ['promo-badge-none', 'promo-badge-test.mjs', ['none']],
  ['offline', 'offline-test.mjs', []],
].filter(([name]) => (mode === 'contributor' ? !['manifest', 'release'].includes(name)
  : mode === 'release' ? releaseSuites.has(name) : true)
  && (only === null || name.startsWith(only)))

if (only !== null && suites.length === 0) {
  console.error(`--only "${only}" selected no suite`)
  process.exit(1)
}

/**
 * A suite that hangs must leave enough output to identify where it stopped.
 *
 * One of these bound a fixed port, lost the race to a suite running beside it, and
 * then sat in a `fetch` whose socket nobody answered — three minutes of the
 * runner's own ceiling, after which it printed six `ok` lines as the "failure
 * detail" because buffered child output was unavailable. The deadline is well
 * above the slowest suite, and live output now identifies the last check seen.
 */
const SUITE_TIMEOUT_MS = 60_000

/**
 * Run a suite while forwarding its output as it arrives. Keeping the output
 * live is important here: a timeout kills the child before a buffered pipe can
 * be read, which used to erase the last check printed by recovery-test.mjs.
 */
function runSuite(script, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(scriptsDir, script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let forceKillTimer
    let spawnError = null
    const started = Date.now()
    const forward = (stream, chunk) => {
      const text = chunk.toString()
      stream === 'stdout' ? stdout += text : stderr += text
      process[stream].write(text)
    }
    child.stdout.on('data', chunk => forward('stdout', chunk))
    child.stderr.on('data', chunk => forward('stderr', chunk))
    const deadline = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return
      timedOut = true
      child.kill()
      forceKillTimer = setTimeout(() => child.kill('SIGKILL'), 500)
    }, SUITE_TIMEOUT_MS)
    child.once('error', error => {
      spawnError = error
    })
    child.once('close', (status, signal) => {
      clearTimeout(deadline)
      if (forceKillTimer !== undefined) clearTimeout(forceKillTimer)
      resolve({ error: spawnError, signal, status, stdout, stderr, ms: Date.now() - started, timedOut })
    })
  })
}

const results = []
console.log(`test mode: ${mode}${mode === 'contributor' ? ' — code checks only; release readiness is checked separately' : ''}`)
for (const [name, script, args] of suites) {
  const run = await runSuite(script, args)
  const output = `${run.stdout}${run.stderr}`.trimEnd().split('\n')
  const hung = run.timedOut || run.error !== null || run.signal !== null
  const ok = !hung && run.status === 0
  // The skip protocol: a suite that could not run for a declared environmental
  // reason prints `SKIP <name> (<reason>)` and exits 0. It is neither a pass
  // (nothing was verified) nor a failure (the reason is legitimate in an
  // install-free checkout) — but it must be VISIBLE, and the summary says so.
  const skipped = ok && output.some(line => line.startsWith('SKIP '))
  results.push({ name, ok, skipped: skipped === true, ms: run.ms, output })
  console.log(`${ok ? (skipped ? 'SKIP' : 'ok  ') : 'FAIL'} ${name.padEnd(22)} ${String(run.ms).padStart(5)} ms`)
  if (!ok) {
    if (run.timedOut) console.log(`       killed at the ${SUITE_TIMEOUT_MS / 1000}s deadline — the live output above is the last diagnostic from the suite`)
    else if (hung) console.log(`       never finished (${run.error?.message ?? `signal ${run.signal}`})`)
    const detail = output.filter(line => /^(FAIL|✗|Error|error:)/.test(line.trim())).slice(0, 6)
    for (const line of (detail.length > 0 ? detail : output.slice(-12))) console.log(`       ${line}`)
  }
}

const failed = results.filter(result => !result.ok)
const skipped = results.filter(result => result.skipped)
const notes = []
if (failed.length > 0) notes.push(` — ${failed.map(f => f.name).join(', ')} failed`)
// A skip is not a pass. In an install-free checkout it is expected and honest;
// where the runner declares the suites non-optional (OFM_REQUIRE_ESBUILD=1 —
// the CI `promo` job), the suite itself already failed, so reaching this line
// with skips means the environment lied, and saying it loudly is the point.
if (skipped.length > 0) notes.push(` — ${skipped.length} skipped (${skipped.map(f => f.name).join(', ')}) — not verified in this environment`)
console.log(`\n${results.length - failed.length - skipped.length}/${results.length} suites passed${notes.join('')}`)
process.exitCode = failed.length === 0 ? 0 : 1
