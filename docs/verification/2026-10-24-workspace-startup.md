# Workbench startup repair

The active desktop profile reported `Magpie engine readiness timed out`.
During retry, the owned executable was running and both loopback ports were
listening. An independent `node:http` request reached its authenticated
management endpoint and received HTTP 401, while the plugin's shared-fetch
health check never reached readiness.

Private engine traffic now uses `src/loopback-fetch.js`: `node:http` with
`agent: false`, restricted to HTTP on 127.0.0.1. Readiness, authenticated
management calls, model catalog refresh and streaming inference all use this
transport. Other plugins' fetch replacements and global proxy dispatchers
cannot route these calls away from the owned process.

Validation passed:

- `node scripts/engine-transport-test.mjs`: replaced global fetch with a
  throwing function; actual binary startup, management, catalog refresh and
  streaming inference still succeeded without calling it. Multipart bodies,
  empty responses, redirect rejection and cancellation also passed. Independent
  review identified buffered response data surviving cancellation; the response
  stream now stays bound to abort until consumption ends. Regression checks
  cover both queued SSE chunks and a fully buffered, closed-socket response.
- `node scripts/magpie-engine-test.mjs`
- `node scripts/magpie-models-test.mjs`
- `node scripts/magpie-plugin-test.mjs` (8 integration groups)
- `node scripts/magpie-sandbox-test.mjs`
- `node scripts/magpie-native-ui-test.mjs` (64 native captures; no layout,
  JavaScript or asset failures)

Native package evidence: `.verify/magpie-native-ui/run-GDiVxE/result.json`.
The installer now also verifies the accepted hashes of the transport and
engine model bridge before copying the package.

The actual active desktop installation was backed up, updated and hot
reloaded. Its engine start endpoint returned HTTP 200 with `state: ready`
and no error; the existing workspace rendered the provider page with working
navigation. Evidence:

- `.verify/local-plugin-install/latest.json`
- `.verify/local-plugin-install/startup-repair.json`
- `.verify/local-plugin-install/workspace-started.png`
