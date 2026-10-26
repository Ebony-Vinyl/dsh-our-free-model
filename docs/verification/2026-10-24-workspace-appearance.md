# Workspace appearance verification

Reference: `origin/main` at `38e0a9437e3a37c8c1a030c165de8cf8c7c0b7e8`.

- Restored the horizontal, wrapping plugin navigation and selection glider.
- Unified subscription accounts and the embedded workbench under one entry.
  Existing `ofm.tab=subscriptions` preferences open the accounts section.
  Switching sections preserves the account editor and engine view.
- Embedded content follows the host font, colors and light/dark preference.
  Narrow windows stay embedded unless the user explicitly expands them.
- Removed upstream product branding and paid discovery content from the UI.
  Provider records, protocol IDs, plugin sandbox content and third-party
  license/notice files remain intact.
- Removed the added iframe Escape handler after independent review: editor
  cancellation and discard confirmation remain owned by the embedded UI.

Validation:

- `node scripts/client-lint.mjs`
- `node scripts/plugin-bench-ui-test.mjs` (9 checks)
- `node scripts/subscription-ui-test.mjs` (14 browser checks)
- `node scripts/workspace-appearance-ui-test.mjs` (24 screenshots plus account
  editor retention, preference migration and iframe Escape checks)
- `node scripts/engine-appearance-test.mjs`
- `node scripts/magpie-engine-test.mjs`
- `node scripts/magpie-sandbox-test.mjs`
- `node scripts/standalone-client-regression-test.mjs`
- `node scripts/build-standalone-ui.mjs --check`
- `node scripts/magpie-native-ui-test.mjs`

Final native evidence: `.verify/magpie-native-ui/run-bzmX0k/result.json`.
The actual installed DSH executable rendered the packaged plugin in an isolated
profile. All 64 captures across 1280/714/390/320px and light/dark passed layout
checks, with no JavaScript exceptions or missing assets. Loopback provider
creation, editing, removal and expansion/collapse also passed.

The installer follows the active desktop profile junction, backs up the
resolved package directory, and skips identical files so a running unchanged
engine executable is not overwritten. Installation and activation evidence
are recorded in `.verify/local-plugin-install/`.
