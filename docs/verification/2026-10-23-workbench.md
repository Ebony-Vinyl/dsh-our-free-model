# Workbench Integration Verification

Status: in progress. This document records implemented behavior and its limits;
it does not certify full Codex++, CC Switch, or magpie parity.

## Baseline

- Repository: `Ebony-Vinyl/dsh-our-free-model`.
- Working branch: `feat/eac-router-workbench-20261023`.
- Remote main fetched with pruning before implementation:
  `38e0a9437e3a37c8c1a030c165de8cf8c7c0b7e8`.
- Changes start directly from that main revision. The old local feature branch
  was not merged over it.
- The retained account-channel registry has ten entries. CodeBuddy and WorkBuddy
  remain excluded. The aggregate provider registry has 76 entries.
- The pinned reference inventory and remaining feature families are in
  `docs/plans/2026-10-23-workbench-parity.md`.

## Implemented Surface

| Requirement | Implementation | Evidence |
| --- | --- | --- |
| EAC router account directory | Plugin and standalone account-channel page renamed; search, connection-state filters, account/model counts, connect/manage actions | `scripts/eac-router-ui-test.mjs`, `scripts/workbench-ui-test.mjs` |
| Aggregate directory before configuration | All registry entries appear with an unconnected state; existing credential/configuration, test, discovery and removal actions remain available | `scripts/workbench-test.mjs`, `scripts/workbench-management-test.mjs`, browser UI checks |
| Subscription import | Codex auth.json, Claude credentials JSON, Gemini OAuth credentials, and API-key subscriptions; explicit fixed-path local discovery/import; multiple accounts | `scripts/subscriptions-test.mjs`, `scripts/subscription-ui-test.mjs` |
| Quotas | Provider-reported plan, five-hour/weekly windows, reset time and available balance fields; absent readings remain unknown | Synthetic provider responses covering the actual request/response contracts; no real paid account queried |
| Subscription routing | Imported model namespace reaches core/DSH adapter, fallback chains and local gateway; disabling/removing rebuilds advertised models | `scripts/subscription-wiring-test.mjs`, `scripts/workbench-management-test.mjs` |
| Gateway protocols | OpenAI Chat Completions, Responses, Anthropic Messages, Gemini native generation/streaming/counting | Existing forward/Anthropic suites and `scripts/gemini-gateway-test.mjs` |
| Client configuration | Six client entries; gateway/native mode; executable, project directory and model settings; isolated Codex/Claude/Gemini configuration | `scripts/workbench-test.mjs` |
| Shared resources | MCP, prompts, skills and agents; managed-directory materialization, enabled state and ownership-aware cleanup | `scripts/workbench-library-test.mjs` |
| Configuration profiles | Save, inspect, atomically apply and remove client configurations | Library and management HTTP suites, browser profile editor |
| Management boundary | New workbench/provider/subscription/library operations require a privileged local session; inference keys cannot gain that privilege by redeeming an ordinary session | `scripts/workbench-management-test.mjs` |

The independent management credential is `managementKey` in the private settings
file. Startup bootstrap links and sessions created with this credential have
workbench privileges. Legacy inference-key login can access its older compatible
surface, but does not authorize the new administrative endpoints. Managed clients
receive only the inference credential.

## Native Execution Evidence

| Runtime | Result | Important limit |
| --- | --- | --- |
| Installed Codex CLI | Passed: isolated pure API config, no official OAuth tokens, actual local Responses gateway, third-party Chat Completions fixture, visible `EAC_NATIVE_OK` output | The upstream is a controlled loopback fixture, not a production provider |
| Claude Code 2.1.309 | Passed: isolated config, API mode, actual Messages gateway and third-party fixture, `EAC_AGENT_OK` | Print mode checks inference, not interactive terminal input |
| Gemini CLI 0.65.0 | Passed: isolated config, API mode, actual Gemini gateway and third-party fixture, `EAC_AGENT_OK` | Managed aliases omit unsupported default sampling controls; not every Gemini extension is supported |
| OFM Tauri shell | Passed: built Rust shell and bundled Node start a private service; actual WebView2 renders six clients, 76 providers and ten retained channels | Development executable; no signed installer has been published |
| Installed Codex Desktop/MSIX | Partial: owned process, separate app/config directories and CDP page observed on some runs; first-run personalization observed | A complete desktop-generated model turn has not passed. Some isolated runs stalled during startup/rendering. Process spawn is not accepted as inference proof |

Reproducible native entry points:

```text
node scripts/workbench-native-test.mjs
node scripts/workbench-native-agents-test.mjs
node scripts/workbench-native-desktop-test.mjs --run
node scripts/workbench-tauri-test.mjs
```

The latter two require explicit installed executables/dependencies as described
in the scripts. Tests use owned temporary profiles, preserve the already running
Codex host and clean only their own processes. Screenshots and machine-specific
reports stay under the ignored `.verify/` directory.

## Regression Evidence

The contributor runner passed 86/86 suites before the subsequent independent
review fixes. New review corrections must be re-run before this number is
treated as current final acceptance.

Additional completed checks:

- Plugin subscription UI: 14/14 checks, both locales, both themes and
  desktop/390px/320px layouts.
- Standalone UI: 18 checks using the actual service and generated assets,
  including real provider writes, subscription publication, resource CRUD,
  profile application, four-page responsive layouts and dark-theme checks.
- Management HTTP: six integration groups, including inference-key privilege
  escalation rejection, redaction, actual subscription inference and usage
  counted once.
- Rust shell: four native unit tests passed, including paths containing spaces
  and Unicode.

## Independent Review Corrections

Completed and covered by targeted tests:

- Codex session database directory is isolated along with `CODEX_HOME`.
- Desktop detection does not accept a CLI executable found on PATH.
- Private writes set permissions before replacing the destination.
- Claude gateway preparation removes inherited cloud-provider selectors.
- Gemini configuration merges unrelated existing settings.
- Provider and subscription writes refresh the model picker immediately.
- Administrative sessions distinguish a management credential/bootstrap from
  an inference credential, including the session-exchange path.

Under verification:

- Interactive terminal input/output and ownership-safe stop on each platform.
- Credential redaction across arbitrary streamed chunk boundaries.
- DSH attachment resolution through every subscription wire.
- End-to-end tool-choice restrictions through the gateway and adapter.
- Shared token refresh surviving cancellation of its original caller.

## Remaining Full-Parity Work

The original scope is still open. In particular, the current implementation
does not establish the native Codex++ UI injection/enhancement system, native
session management, every CC Switch application adapter, all magpie plugin
hosts/markets/middleware, quota-aware nested routing, full search/image/video
MCP services, remote engine federation, encrypted cross-device synchronization,
or every native account sign-in/refresh flow.

Real provider entitlement/quota results require authorized live accounts.
Cross-platform native acceptance and production packaging also remain separate
gates. The feature matrix lists the broader work; passing local compatibility
tests must not be presented as completion of that entire matrix.
