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
const releaseSuites = new Set(['manifest', 'release', 'catalog', 'legacy-upgrade', 'engine-payload'])

const suites = [
  ['manifest', 'build-manifest.mjs', ['--check']],
  ['release', 'release-e2e.mjs', []],
  ['legacy-upgrade', 'legacy-upgrade-test.mjs', mode === 'contributor' ? [] : ['--production']],
  ['engine-payload', 'engine-payload-test.mjs', []],
  ['release-preparation', 'release-preparation-test.mjs', []],
  ['client-lint', 'client-lint.mjs', []],
  ['sponsor', 'sponsor-test.mjs', []],
  ['heatmap', 'heatmap-test.mjs', []],
  ['trust', 'trust-test.mjs', []],
  ['sanitize', 'sanitize-test.mjs', []],
  ['feed', 'feed-test.mjs', []],
  ['picks', 'picks-test.mjs', []],
  ['picks-ui', 'picks-ui-test.mjs', []],
  ['stat-bucket-ui', 'stat-bucket-ui-test.mjs', []],
  ['free-pool', 'free-pool-test.mjs', []],
  ['updater', 'updater-test.mjs', []],
  ['upgrade-ui', 'upgrade-ui-test.mjs', []],
  ['reload', 'reload-test.mjs', []],
  ['forward', 'forward-test.mjs', []],
  ['gemini-gateway', 'gemini-gateway-test.mjs', []],
  ['subscriptions', 'subscriptions-test.mjs', []],
  ['subscription-completion', 'subscription-completion-test.mjs', []],
  ['subscription-wiring', 'subscription-wiring-test.mjs', []],
  ['magpie-engine', 'magpie-engine-test.mjs', []],
  ['engine-transport', 'engine-transport-test.mjs', []],
  ['magpie-models', 'magpie-models-test.mjs', []],
  ['magpie-policy', 'magpie-policy-test.mjs', []],
  ['magpie-plugin', 'magpie-plugin-test.mjs', []],
  ['workbench', 'workbench-test.mjs', []],
  ['workbench-library', 'workbench-library-test.mjs', []],
  ['workbench-management', 'workbench-management-test.mjs', []],
  ['client-terminal', 'client-terminal-test.mjs', []],
  ['quota-routing', 'quota-routing-test.mjs', []],
  ['turn-accounting', 'turn-accounting-test.mjs', []],
  ['chan-relay', 'chan-relay-test.mjs', []],
  ['channel-pack', 'channel-pack-test.mjs', []],
  ['channel-pack-gate', 'channel-pack-gate-test.mjs', []],
  ['channel-source', 'channel-pack-test.mjs', ['--source', '--channels-only']],
  ['channel-network', 'channel-network-test.mjs', []],
  ['channel-credits-rpc', 'channel-credits-rpc-test.mjs', []],
  ['channel-credits-ui', 'channel-credits-ui-test.mjs', []],
  ['channel-model-actions', 'channel-model-actions-test.mjs', []],
  ['channel-login', 'channel-login-test.mjs', []],
  ['open-external', 'open-external-test.mjs', []],
  ['channel-image-pricing', 'channel-image-pricing-test.mjs', []],
  ['forward-boot', 'forward-boot-test.mjs', []],
  ['standalone', 'standalone-test.mjs', []],
  ['desktop', 'desktop-test.mjs', []],
  ['desktop-update', 'desktop-update-test.mjs', []],
  ['standalone-desktop-regression', 'standalone-desktop-regression-test.mjs', []],
  ['standalone-page-lifecycle', 'standalone-page-lifecycle-test.mjs', []],
  ['standalone-management', 'standalone-management-test.mjs', []],
  ['standalone-lan', 'standalone-lan-test.mjs', []],
  ['standalone-frontend', 'standalone-frontend-test.mjs', []],
  ['standalone-client-regression', 'standalone-client-regression-test.mjs', []],
  ['standalone-channels', 'standalone-channels-test.mjs', []],
  ['standalone-channel-filter', 'standalone-channel-filter-test.mjs', []],
  ['standalone-model-operation', 'standalone-model-operation-test.mjs', []],
  ['standalone-settings-host', 'standalone-settings-host-test.mjs', []],
  ['standalone-login-terminal', 'standalone-login-terminal-test.mjs', []],
  ['standalone-package', 'standalone-package-test.mjs', ['--sources-only']],
  ['bun-fetch', 'bun-fetch-test.mjs', []],
  ['free-lane-compat', 'free-lane-compat-test.mjs', []],
  ['stable-session', 'stable-session-test.mjs', []],
  ['egress', 'egress-test.mjs', []],
  ['egress-availability', 'egress-availability-test.mjs', []],
  ['effort', 'effort-test.mjs', []],
  ['projection', 'projection-test.mjs', []],
  ['fingerprint', 'fingerprint-test.mjs', []],
  ['opencode-parity', 'opencode-parity-test.mjs', []],
  ['free-lane-wire', 'free-lane-wire-test.mjs', []],
  ['freetier-gate', 'freetier-gate-test.mjs', []],
  ['sniff', 'sniff-test.mjs', []],
  ['stream-failure', 'stream-failure-test.mjs', []],
  ['truncation', 'truncation-test.mjs', []],
  ['recovery', 'recovery-test.mjs', []],
  ['retry-safety', 'retry-safety-test.mjs', []],
  ['usage-sanitize', 'usage-sanitize-test.mjs', []],
  ['speed-stat', 'speed-stat-test.mjs', []],
  ['picker', 'picker-test.mjs', []],
  ['tui', 'tui-test.mjs', []],
  ['catalog', 'catalog-test.mjs', mode === 'contributor' ? ['--contributor'] : []],
  ['vault', 'vault-test.mjs', []],
  ['mint-eac-seal', 'mint-eac-seal-test.mjs', []],
  ['eac-auth', 'eac-auth-test.mjs', []],
  ['eac-abort', 'eac-abort-test.mjs', []],
  ['eac-login', 'eac-login-test.mjs', []],
  ['kilo', 'kilo-test.mjs', []],
  ['offline', 'offline-test.mjs', []],
  // The aggregated feature set: the token savers ported from the upstream
  // routers, the provider registry, the failure/chain brain, the Anthropic
  // wire, the local answers, and the aggregate lane driver. Each is a pure
  // module with its own offline suite; `aggregate-wiring` is the one that
  // proves the host actually reaches them.
  ['rtk', 'rtk-test.mjs', []],
  ['rtk-shape', 'rtk-shape-test.mjs', []],
  ['local-optimize', 'local-optimize-test.mjs', []],
  ['registry', 'registry-test.mjs', []],
  ['route', 'route-test.mjs', []],
  ['combo-advance', 'combo-advance-test.mjs', []],
  ['prompt-saver', 'prompt-saver-test.mjs', []],
  ['anthropic', 'anthropic-test.mjs', []],
  ['aggregate', 'aggregate-test.mjs', []],
  ['aggregate-wiring', 'aggregate-wiring-test.mjs', []],
  ['model-test', 'model-test-test.mjs', []],
  ['model-test-probe-race', 'model-test-probe-race-test.mjs', []],
  ['model-test-finish-integration', 'model-test-finish-integration-test.mjs', []],
  ['bench-integration', 'bench-integration-test.mjs', []],
  ['plugin-bench-ui', 'plugin-bench-ui-test.mjs', []],
  ['gateway-source', 'gateway-source-test.mjs', []],
  ['gateway-disconnect', 'gateway-disconnect-test.mjs', []],
  ['standalone-nav', 'standalone-nav-test.mjs', []],
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
      // Offline suites mock Node fetch. The Bun protocol has its own loopback
      // tests; never let an existing mock accidentally send a live request.
      env: { ...process.env, OUR_FREE_MODEL_FREE_TRANSPORT: 'node' },
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
  results.push({ name, ok, ms: run.ms, output })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(14)} ${String(run.ms).padStart(5)} ms`)
  if (!ok) {
    if (run.timedOut) console.log(`       killed at the ${SUITE_TIMEOUT_MS / 1000}s deadline — the live output above is the last diagnostic from the suite`)
    else if (hung) console.log(`       never finished (${run.error?.message ?? `signal ${run.signal}`})`)
    const detail = output.filter(line => /^(FAIL|✗|Error|error:)/.test(line.trim())).slice(0, 6)
    for (const line of (detail.length > 0 ? detail : output.slice(-12))) console.log(`       ${line}`)
  }
}

const failed = results.filter(result => !result.ok)
console.log(`\n${results.length - failed.length}/${results.length} suites passed${failed.length > 0 ? ` — ${failed.map(f => f.name).join(', ')} failed` : ''}`)
process.exitCode = failed.length === 0 ? 0 : 1
