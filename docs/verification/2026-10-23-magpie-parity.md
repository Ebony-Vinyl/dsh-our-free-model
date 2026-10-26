# Magpie Plugin Parity Verification - 2026-10-23

## Scope And Evidence

This record distinguishes the original JavaScript channel inventory, native
Magpie engine source reuse, and behavior actually exercised through the plugin.
Including upstream runtime source does not certify every external provider,
subscription login, operating-system integration, or native desktop workflow.
The reference is the local Magpie checkout; its instruction files are reference
material, not user instructions.

The bundled full web engine is pinned to
`c551a229975653b7ae5b6a35e2278c983a272e06` and checked against
`vendor/magpie/engine.json`. The inventory audit used reference checkout
`bf2e067ef6ddcdc3ce9b15f32143cd2113e6af72`; these are distinct revisions.
The 58 preset IDs and 19 subscription IDs were compared between these revisions
and are identical.

The latest requested scope is ALL Magpie channels and features, including UI.
The older `docs/plans/2026-10-23-workbench-parity.md:33` exclusion of CodeBuddy and
WorkBuddy conflicts with that scope. These products must be counted, not silently
excluded. Upstream lists CodeBuddy as an agent; it is not an additional preset or
subscription ID in the inventories below. WorkBuddy has two subscription IDs.

## Integration Acceptance

Run `node scripts/build-magpie-engine.mjs` before
`node scripts/magpie-plugin-test.mjs`.

The test uses the actual bundled engine, `createApiRoutes`, the engine model
facade, `createModelRuntime`, and the production `FreeModelAdapter`. Its local
HTTP upstream supplies model discovery, image input, streamed tool calls, tool
results, and final text. It supplies `MAGPIE_NO_ACCOUNTS=1`, checks the engine's
persisted `noAccountDiscovery=true` setting (the owner strips inherited Magpie
environment overrides), redirects home/config/cache directories to a temporary
workspace, and supplies only synthetic API credentials. It does not authenticate
against a vendor or import the machine's accounts.

Acceptance checks:

- Authentication and cross-origin rejection on status, start, refresh, and proxy routes.
- Actual process startup and redacted ready status.
- Real proxied HTML and upstream provider management API, including all 58
  built-in presets and 60 choices across 14 region/plan collections.
- Saving a provider through `/engine/ui/api/provider/save`, then refreshing the
  `subscription:magpie/provider/model` namespace into core and DSH model lists.
- A DSH image/tool-call turn and a subsequent tool-result/text turn through the
  real engine, with upstream call identity and usage accounting.
- Namespace priority ahead of the imported-subscription catch-all.
- Dynamic provider disable, re-enable, and removal.
- Persisted configuration after restart and isolation between two data roots.
- Discovery of the actual persisted provider-file location, rather than an
  assumed Windows directory layout.

Execution result: **8/8 real-engine integration groups passed** using the
ordinary `node scripts/magpie-plugin-test.mjs` command and the bundled pinned
Windows x64 executable. No loader override or substituted engine/facade was
used in the passing stock run. Integration exposed two implementation
mismatches that main corrected: engine/facade `ready` state agreement and native
`display_name`/`modalities.input` mapping. The test and this document are the
only files owned by this focused verification task.

The actual engine API reports its config directory in `/api/settings.dir`.
The persisted provider path is
`<dataDir>/magpie/config/magpie/providers.json`; settings are beside it at
`settings.json`. The test compares the reported directory to the files written
by the engine instead of guessing an OS-specific config path.

## Original JavaScript Preset Inventory

Upstream `internal/provider/presets.go:117` defines 58 built-in presets:
35 vendor, 18 relay, four local, and one remote. Fourteen presets define 60
region/plan choices, including ten Bedrock runtime and 17 Mantle regions.
Dynamic partners and arbitrary installed plugin providers extend this inventory;
58 is not a bound on Magpie's extensibility.

The original `src/providers/registry.json` contains 76 providers and 502 model IDs.
There are 32 identifiable Magpie analogues; this counts partial and blocked
entries and is not a successful-provider count.

| Magpie IDs | Plugin IDs, respectively |
| --- | --- |
| anthropic, deepseek, xai, minimax, minimax-cn, mistral, groq, kilo, together, fireworks, siliconflow, ollama, lmstudio | Same IDs |
| openai, google, google-vertex, moonshot, kimi-code-cn, zhipu, zai | openai_api, gemini, vertex, kimi, kimi_code, glm-cn, zai_api + zai |
| xiaomi, baidu-qianfan, volcengine, qwen, bedrock-mantle, azure | xiaomi-tokenplan, baidu, volcengine-ark, alibaba_cloud, bedrock, azure_openai |
| ollama-cloud, openrouter, opencode-go, clinepass, opencode-zen, nvidia | ollama_cloud, open_router, opencode_go, cline_pass, opencode_zen, nvidia_nim |

Twenty-six Magpie defaults have no matching built-in definition in that registry.
The numbers below are lines in upstream `internal/provider/presets.go`.

| Group | IDs and source lines |
| --- | --- |
| 17 key-based conversation presets | moonshot-cn:153, kimi-code:158, stepfun:192, stepfun-cn:199, tencent-cloud:267, huaweicloud:295, qwen-cn:337, qwen-token-plan:349, bailian-token-plan:358, nous:435, commandcode:486, modelscope:511, aihubmix:515, pipellm:522, 302ai:525, cherryin:528, yylx:531 |
| Bedrock runtime | bedrock:380 |
| Five decision presets | typesafe:542, vercel-jev:547, cloudflare-jev:553, bailian-decision:560, qwen-decision:573 |
| Two local presets | omlx:589, mlx-serve:595 |
| Remote | remote-magpie:603 |

Plugin `bedrock` is Mantle, not the runtime. Plugin `tencent` is a Hunyuan
endpoint, not the Tencent Cloud TokenHub/plan definitions. `kimi_code` selects
China's endpoint, not the global `kimi-code`. `qwencloud` uses a Singapore plan
endpoint, not the two missing Qwen/Bailian defaults.

Remaining direct-lane gaps before engine reuse:

- Azure sends Bearer authorization instead of the `api-key` header; its resource
  endpoint also needs normalization and deployment listing. Reproduced using
  `defaultHeaders` in `src/providers/index.js:158`; compare upstream `azure.go:11`.
- `src/aggregate.js:163,282` blocks both OAuth rows (`github_copilot`, `openai`)
  and both ADC rows (`vertex`, `vertex-partner`) regardless of supplied keys.
- Registry rows flatten regional choices and protocol endpoints into one base
  URL and format. Examples: Xiaomi Singapore only, Baidu pay-as-you-go only,
  Volcengine coding only, SiliconFlow international only, Mantle one region.
- Per-model native Responses/Messages selection and decision APIs are not
  represented by the original registry/transport contract.

Native engine reuse supplies upstream's runtime implementations for these
presets. The integration test exercises one synthetic Chat provider, not every
preset's endpoint, region, key scheme, account, or model.

## Original Subscription Auth Inventory

Upstream `internal/provider/provider.go:1077` reserves 19 subscription IDs:
six native and 13 retired/plugin-served.

| Original plugin coverage | IDs |
| --- | --- |
| Private sidecar, partial parity | codex, claude, gemini |
| Vendored implementation | qoder, qoder-cn, zcode |
| Existing under another name | antigravity, using the vendored Gemini OAuth client and daily backend |
| Twelve missing implementations | copilot, chatgpt-api, commandcode-plan, cursor, devin, factory, grok, kiro, mimo-app, workbuddy, workbuddy-ai, zed |

The ten mounted vendored account channels are LobsterAI, Qoder, Qoder CN, TRAE,
Cline, Loomy, Raccoon, MiniMax, Gemini, and ZCode. `index.js` explicitly disables
the pack's OpenCode adapter. Existing main OpenCode/free routing is separate.
The vendored Gemini client ID and daily backend match upstream Antigravity
(`vendor/channel-pack/src/gemini-oauth.ts:32`, `gemini.ts:65`).

The original sidecar lacks login start/poll/callback/cancel management; it imports
files for Codex, Claude, Gemini, or a generic API credential. Discovery checks
three fixed home-relative paths, missing `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and
native keychain stores. Codex/Gemini refresh is implemented; expired Claude
credentials require re-import. Claude completion uses direct OAuth HTTP, whereas
upstream uses the actual Claude Code binary for login, refresh, and inference.
Subscription model names are manually supplied; an empty list publishes nothing.

Magpie's bundled market has 12 auth packages declaring 13 provider IDs, plus
arbitrary installable OpenCode auth plugins. Its Qoder migration also supports
Qoder CN. Retired provider shims are not complete implementations of those
external packages. Reusing the native engine supplies the host/migration code,
not proof that every package installs and authenticates correctly.

## Prior Offline Validation

During the focused inventory audit, these existing suites passed:

- `scripts/registry-test.mjs`: registry shape, 76 providers, 502 models, wire paths.
- `scripts/subscriptions-test.mjs`: 38/38 checks.
- `scripts/subscription-completion-test.mjs`: 29/29 checks.
- `scripts/subscription-wiring-test.mjs`: 11 integration groups.
- Separate executable reproductions confirmed the four blocked OAuth/ADC rows
  and Azure's missing `api-key` header.

## Explicitly Unverified

- Live authentication, quota, refresh, inference, and account migration for all
  external vendors and all community auth packages.
- Browser visual/interaction acceptance for every embedded management view and
  all controls, redirects, downloads, streaming connections, and nested assets.
- Native Magpie GUI parity: WebView/OS windows, tray, platform dialogs, shell
  integration, native filesystem actions, and installed-agent behavior.
- Windows installed-package acceptance, signing/installer lifecycle, Linux/macOS
  packaging and native credential stores.
- Responses, Anthropic, Gemini, decision, image-generation, embedding, and other
  native routes beyond the synthetic Chat/image/tool path exercised here.

The embedded workspace is the actual upstream web management surface. Serving
that surface and reusing runtime source must not be reported as verified parity
for every native GUI feature or every external account/channel.
