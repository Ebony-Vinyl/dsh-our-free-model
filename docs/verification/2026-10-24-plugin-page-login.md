# Compact plugin page and subscription login

The embedded plugin marketplace hides its introductory card and section
headings, keeping search, plugin results and installation controls. Its main
navigation entry uses the existing puzzle icon, with a localized accessible
name and tooltip.

The reported login failure was caused by the active engine setting
`noAccountDiscovery: true`. Upstream uses this switch for both reading local
accounts and starting subscription logins, including installed auth plugins.
Enable it through `POST /api/settings/account-discovery` with `{"off": false}`;
the engine saves the choice and invalidates the account cache immediately.
The application keeps its existing default and respects saved privacy choices.

Regression checks cover the compact page in English and Chinese, search and
installation controls on desktop and mobile, and the real engine's login gate
before and after the settings change in an isolated account environment.
These checks do not establish successful authentication with a live vendor.

Passed checks:

- `node scripts/engine-appearance-test.mjs`
- `node scripts/magpie-engine-test.mjs`
- `node scripts/magpie-native-ui-test.mjs`: 64 captures at four widths in
  light and dark, including visible plugin navigation icons at narrow widths.
- `git diff --check` for the edited engine and verification scripts.

Final native evidence: `.verify/magpie-native-ui/run-i9Te4T/result.json`.
Only `src/magpie-engine.js` was copied into the current desktop installation;
its hash matches the accepted package. The live settings endpoint was used
to enable subscription accounts, and a bounded invalid-provider login probe
confirmed that the discovery-off gate was removed. The final on-disk settings
also retain the enabled choice. No vendor authorization was completed.

At the final follow-up the desktop application and engine were no longer
running, and port 9433 refused connections. The installed file hash and saved
setting were verified again; live UI verification could not be repeated after
that shutdown.
