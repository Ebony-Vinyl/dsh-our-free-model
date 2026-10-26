# Excluded account channels: WorkBuddy and Huawei Cloud

Status: **enforced at this application's management boundary on both surfaces
(plugin and desktop); engine regression, the policy suite and the turn-accounting
suite pass.** This is a product exclusion, not a defect report about the upstream
project.

## What is excluded and why

WorkBuddy's China build (`workbuddy`, sold as the CodeBuddy plan) and its
international build (`workbuddy-ai`) are not offered. The community plugin that
serves them signs requests as WorkBuddy's own desktop client, which carries a
risk this product does not want to put in front of users. The exclusion already
existed as policy for the plugin surface
(`docs/plans/2026-10-23-workbench-parity.md`: "CodeBuddy and WorkBuddy must
remain removed"); embedding the Magpie engine reintroduced the channel through
the engine's own plugin market, which is what this change closes.

Huawei Cloud MaaS (`huaweicloud`, its Token Plan preset) is excluded on the same
terms: this build carries no Huawei channel, and the engine's pinned preset list
is the one surface that would otherwise reintroduce it as an addable vendor.
Both exclusions are decided in one place — `src/magpie-policy.js` — and the
desktop provider directory reads that same decision (`src/providers/index.js`
exports `OFFERED_PROVIDERS`), so the two surfaces cannot disagree about which
channels this product offers.

## The disclaimer both surfaces show

Because an unexplained absence reads as a fault, `src/disclaimer.js` holds one
copy of what the product says about it: the two excluded channels, that a user's
use of any third-party channel is their own responsibility and unrelated to this
project's authors, that credentials stay on the user's machine and remain their
responsibility, and that nothing is warranted. The plugin's settings page shows
it once on the first visit and keeps a reopen link in its footer; the desktop
console shows it on the first ready load and keeps a reopen link in its sidebar.
Acknowledgement is a settings write (`disclaimerAck`, compared against
`DISCLAIMER_VERSION`) and never gates inference — bumping the version re-shows
the copy.

## Where the engine exposed it

The engine is a pinned binary (`vendor/magpie/engine.json`, revision
`c551a229…`) whose plugin market is fetched from GitHub at run time, so the
list cannot be edited in the engine. Measured against the pinned executable,
the channel appeared on eight management answers and accepted nine mutations:

| Surface | What it showed |
| --- | --- |
| `GET /api/plugins/listings`, `/api/plugins/market` | the listing `@magpie-community/opencode-workbuddy-auth`, providers `workbuddy` and `workbuddy-ai` |
| `GET /api/plugins/search`, `/api/plugins/npm` | the same package from npm, 15k weekly downloads |
| `GET /api/plugins/page?name=…` | the plugin's readme |
| `GET /api/plugins`, `/api/plugins/check`, `/api/plugins/updates`, `/api/plugins/github` | the installed row and its update state |
| `GET /api/providers` | `movable` and `movesTo` pointing at the excluded package |
| `GET /api/importapps` | provider entries an app import could bring in |
| `POST /api/plugins/{add,upgrade,off,options,prefer}` | install and enable |
| `POST /api/plugin-signin`, `/api/plugin-signin/prompt` | sign in through the plugin |
| `POST /api/signin`, `/api/signin/import`, `/api/login/{action}` | the built-in subscription sign-in |
| `POST /api/provider/{move,moveback}` | moving accounts onto the plugin |
| gateway `GET /v1/models` | models the plugin served, `owned_by` the channel |

## How it is enforced

`src/magpie-policy.js` is the single decision point. It denies by subscription
id (`workbuddy`, `workbuddy-ai`), by package name, and by any name carrying
"WorkBuddy", because a third-party plugin can sign in to the same provider under
any package name. `src/magpie-engine.js` applies it on both paths the
application owns — `request()` for adapters and `proxy()` for the embedded UI:

- JSON answers for the routes above are filtered before they reach the page;
  every other route and content type passes through untouched.
- Mutations on the routes above have their body buffered and are refused with
  `403` before forwarding. Those are the only bodies buffered; every other
  request still streams.
- `src/magpie-models.js` drops a gateway model whose `owned_by` is the channel,
  so a plugin installed before this change cannot keep serving it.

`/api/providers`' `movable` list is deliberately left whole. The engine's add
sheet hides a deprecated built-in only while it has no account, and reads that
test from this list; dropping the id would surface the very tile the filter is
meant to hide. `/api/state` is also left whole: it describes how a client is
configured, not a way to obtain or sign in to the channel.

Switching the channel off and removing it are **not** refused. A plugin
installed before this change must stay removable; refusing the way out would
trap it behind a hidden row.

## Whose plugins these are

The plugin market is the magpie community's (`github.com/magpie-community/plugins`),
not this product's. The plugin page now says so, in the reader's language, on
every tab that offers third-party code — Discover and Installed — and not on
Built-in, which lists the engine's own switches. The notice is inserted by the
same injected script that owns the page's presentation (`src/magpie-engine.js`)
and is restored when the page redraws its children. It states that Our Free
Model neither provides these plugins nor is responsible for them, so a reader
does not take a community plugin for a supported feature.

## Recorded checks

```text
node scripts/magpie-policy-test.mjs
node scripts/magpie-engine-test.mjs
node scripts/magpie-models-test.mjs
node scripts/magpie-plugin-test.mjs
node scripts/engine-transport-test.mjs
node scripts/engine-appearance-test.mjs
node scripts/turn-accounting-test.mjs
node scripts/workbench-management-test.mjs
node scripts/test-all.mjs
npx tsc --noEmit -p tsconfig.json
```

`magpie-policy-test.mjs` runs the real pinned executable and covers thirteen
groups: the market and npm answers, installed/update listings, provider move
routes, the import picker, nine refused mutations, the way out of an earlier
install staying open, the same refusals through the browser proxy, unrelated
work on the same routes still reaching the engine, the published catalog
staying clean, the filter as a pure function, the Huawei Cloud preset being
absent from the provider list and vendor status, and a provider save built from
that preset being refused while an unrelated save still passes.
`magpie-plugin-test.mjs` now asserts 57 offered built-in presets (58 pinned minus
Huawei Cloud) and that no preset names the channel.
`engine-appearance-test.mjs` adds the source notice in both languages, its
absence on the Built-in tab and its return on Discover.
`turn-accounting-test.mjs` pins one logical turn per turn across the combo and
subscription lanes and the disclaimer's own contract.
`workbench-management-test.mjs` covers the desktop disclaimer route end to end.
The default run is 96/96.

## Not covered

- The exclusion is a management-boundary filter, not an engine patch. The
  engine's own binary still contains the channel's code and its built-in
  `workbuddy` adapters; a caller with direct access to the private loopback
  engine port would not be filtered. The port is bound to `127.0.0.1` and its
  web key is generated per run, and the application's own routes are the only
  documented way in.
- An account signed in before this change is not deleted. It stays listed and
  working, and only the routes onto the excluded plugin are withdrawn. The same
  holds for a Huawei Cloud account: its rows keep answering, and the exclusion
  removes the ways onto it rather than the account.
- No live WorkBuddy or Huawei Cloud authorization was performed or is intended.
