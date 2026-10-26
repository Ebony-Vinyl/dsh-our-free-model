# Magpie integration acceptance

Status: **not accepted for an "all features work" release**. Implementation and
local validation are separate from live vendor/account acceptance.

## What changed

The DSH plugin includes the complete Magpie web engine and its original web
management interface, pinned to commit
`c551a229975653b7ae5b6a35e2278c983a272e06`. This is an engine integration,
not a new collection of provider-name placeholders. The original OFM anonymous,
EAC, account-channel, aggregate, imported-account and token-saving surfaces remain.

- `src/magpie-engine.js` owns an authenticated loopback child, private XDG
  directories, persistent inference address/key, shutdown and crash recovery.
- `client.js` adds the model workspace, grouped navigation, a narrow-panel
  navigation selector and embedded long-label/path wrapping.
- `src/magpie-models.js` publishes the engine's models and groups into the
  existing DSH adapter, including image, context/output and reasoning metadata.
- The engine's management surface is proxied through the existing DSH admission
  boundary. Sandboxed extension assets use only their engine-issued, per-run
  capability path; ordinary management APIs remain authenticated.
- Internal adapter keys are hidden from ordinary key management and protected
  from mutation. Other gateway keys retain normal CRUD and rotation.
- The engine binary is checksum-verified before execution. Its source revision,
  build inputs and dependency notices are retained in `vendor/magpie/`.

The source inventory is in `2026-10-23-magpie-parity.md`: 58 built-in presets,
60 region/plan choices across 14 presets, and 19 reserved subscription IDs.
Some subscription implementations are supplied by installable community auth
packages. Their presence in the marketplace is not proof of successful login.

## Recorded checks

Reproducible commands:

```text
node scripts/build-magpie-engine.mjs
node scripts/magpie-engine-test.mjs
node scripts/magpie-plugin-test.mjs
node scripts/magpie-sandbox-test.mjs
node scripts/magpie-native-ui-test.mjs
node scripts/subscription-ui-test.mjs
node scripts/test-all.mjs --mode contributor
node scripts/magpie-live-test.mjs --run
```

The engine suite covers startup, coalescing, credential stripping, prefixed
assets/redirects, sandbox CSP, downloads/ranges, streaming/cancellation,
concurrent request limits, private state, ownership, crash recovery, stable
gateway credentials, internal-key protection, ordinary key rotation and the
actual compiled executable.

The plugin integration suite exercises the actual engine through production
management routes, model publication into the production DSH adapter, image
input, a streamed tool call, the subsequent tool result and final text,
single usage accounting, disable/re-enable/delete, persistence and data-root
isolation. These are controlled loopback upstreams.

The sandbox regression runs a real browser and engine with a local page-only
extension. Its opaque-origin HTML and scripts load, parent DOM access remains
blocked, invented capability tokens return no files, and management APIs reject
unauthenticated or cross-origin calls.

Native UI evidence uses a separately installed copy inside the actual installed
DeepSeek Harness Electron application. It verifies executed client bytes,
provider preset reachability and CRUD, real compositor pixels, themes and
multiple viewport widths. The report, screenshots and failure history are under
`.verify/magpie-native-ui/`. The currently active user installation and account
files are not replaced by these tests.

Full runner output is retained in `.verify/magpie-regression-final.log`.
Individual engine, plugin, updater, forward, LAN and subscription UI logs are
also retained under `.verify/magpie-*-final.log` or
`.verify/magpie-engine-reviewed.log`. Only inspect the final result of a run;
earlier failed runs are intentionally preserved as diagnostic evidence.

## Live upstream blocker

The opt-in live check sent a real, bounded request for
`mimo-v2.6-flash-free` through OFM and the bundled engine. The external provider
returned HTTP 403 with code `LANE_LOCKED`: it reports that the current public IP
has been blocked for detected abusive traffic and explicitly says this is
unrelated to the account. No native account credentials were imported or read.

The reproducible result is `.verify/magpie-live/latest.json`. This is **not a
passing live-inference check**. Switching to a local fixture cannot close it.
The adapter now describes upstream access refusal without incorrectly telling
the user to re-import a subscription.

## Remaining acceptance

- Authorized live login, refresh, quota reads, migration and inference for every
  subscription and vendor, including installed community auth packages.
- All non-Chat upstream protocol combinations, generated media, search services,
  middleware, federation, synchronization and installed-agent workflows.
- Native OS surfaces excluded by the `nogui` build: tray, native application
  windows and native folder dialogs. The upstream web interface's alternatives
  are available; this does not establish native GUI parity.
- Linux/macOS/ARM executable builds and acceptance. The bundled executable
  currently targets Windows x64.
- Signed release and upgrade migration. This checkout's parser accepts the
  bounded engine binary and larger file inventory, but older clients still have
  their existing 4 MB / 80-file limits. They need a compatible bootstrap release
  or a full local package install before this larger payload can be upgraded.
  No release manifest has been signed or published in this task.

Consequently, this work must not be described as every channel and feature
having passed live verification, nor silently installed as a fully accepted
replacement.
