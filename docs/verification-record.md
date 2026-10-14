# Verification record

Round-by-round records measured against the live upstream on Windows.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

### Verification

Tested on Windows against the live upstream. The table is kept per release round,
and each row says which way it was checked — only the rows marked *live upstream*
or *hands-on* are behaviour a user sees in the interface.

### Issue #12: verification status

Implementation, offline regression and live results are tracked separately in
[`docs/issue-12-recovery.md`](issue-12-recovery.md). Recovery 99/99,
truncation 35/35, 11 new fingerprint checks and typecheck have passed. Twelve
checks use the real plugin over local HTTP to verify forward success, failures,
client disconnection and stored statistics. The technical record carries the
final full-suite result. In a live MiMo Deep run, the first
stream reached natural EOF at 304.161 seconds; recovery took 32.777 seconds and
produced 4264 characters of answer text, ending with `stop`, usage and `[DONE]`.
There were two requests over 336.942 seconds. The first segment had no usage
report, so the summary contains only known counts. The earlier failed
480-second attempt remains in the technical record. Real dsh UI and other
models have not been individually accepted.

### Historical: v1.3.2 (issues #11, #13, #19, #20, #21)

| Item | Fix | Verification |
| --- | --- | --- |
| #19 self-update trust chain | Ed25519-signed manifests (public key pinned in the plugin, private key out of the repo), the update channel fully decoupled from `feedUrl`, manifest `base` restricted to relative paths | updater-test: four new cases (signature, tamper, foreign key, feedUrl not followed); release-e2e's negative control now refuses at the signature |
| #19 forward surface | `localhost` binds resolve first and require all-loopback answers; a 1 MB cap (413) on plugin API bodies; the forward endpoint answers 400 for a non-JSON body and 404 for an unknown model | forward-test `resolveLoopbackBind` cases; offline-test 404 case |
| #20/#21 tools unusable through the forward port (#21's `Unknown tool 'bash'/'read'/'grep'` is exactly the fingerprint decoy quartet: the lane forces those names to be declared, the model dials them, the forwarded client never registered them) | streaming `tool_calls[].index` renumbered from 0 (no longer shares the block counter with reasoning); fingerprint-decoy calls suppressed per block on the forward wire (unnamed blocks have their arguments held); a ceiling-cut turn finishes as `length` on the stream too | forward-test: four streaming/non-streaming cases against the real listener with a scripted lane |
| #20 dsh-side decoy hazard | `stream.js` keys parallel tool calls without an `index` by call id; bare argument continuations join the preceding call | existing truncation/fingerprint suites stay green |
| #13 quota experience | 429 removed from the retryable codes (no more three automatic retries of the same wall); a probe round answered by nothing but 429s backs the next periodic round off 30→120 minutes (manual reprobe, egress change and the boot round are exempt); the probe recognizes in-stream error frames inside a 200; the bench button uses the default effort and a realistic client timeout | retry-safety-test assertion updated; probe logic covered by the offline suites |
| #13 concentrated forward quota | 429 no longer auto-retried (above); the forward session key stays derived from `user`/`conversation` (deliberate: the lane accounts per session) | behavior unchanged, no new spend |
| #11 heatmap | cell gap removed and corners tightened for a GitHub contribution-graph ribbon; the layout was already column-major week-aligned | client-lint green |
| Other | per-route client timeouts (bench 240 s, upgrade 600 s — the 8 s guard now covers only fast routes); EventSource reconnects with backoff (30 s → 5 min) instead of closing forever; a completed upgrade clears the stale error banner; the speed-scope copy now says what the panel really averages (last 40 calls); a failed store flush is logged once | client-lint; speed-stat green |

All 20 offline suites (including the new `forward-test`) and `tsc --noEmit` pass; `host-selftest` costs real network and real free-lane quota, so it did not run with this round.

### Historical: v1.3.1 (issues #8, #9, #10)

| Item | How | Result |
| --- | --- | --- |
| Both tool-result vocabularies really reach the model | live upstream, `host-selftest.mjs` step 2 | Same model, same `get_weather` answer, sent once in the pre-V4 shape (`user` carrying a `tool-result` block) and once in the V4 shape (`role:'tool'`): both `finish=stop`, and both times the model repeated the `22°C / sunny` from the result. Before the fix the plugin did not recognise the first shape at all (`src/messages.js` never mentioned `tool-result`), so that request carried neither the call nor its answer |
| The shapes are taken from records, not imagined | every session root on this machine — 40 `session*.jsonl.zstd` across four homes (zstd, which needs splitting frame by frame) | `tool/result` events appear in exactly two shapes: **362** with `role:'user'` carrying a `tool-result` block (V1/V3 format — 336 written by AIO 6.9.3's v3 home, 26 by `~/.dsh`'s v1) and **27** V4 `role:'tool'` from the v4 session copies. Both generations are in live use and the plugin read only the latter — issue #9 was right, about a kernel older than the reporter's |
| Projection and pairing repair | offline `projection-test.mjs` (new, 40 assertions) | Three wires × two vocabularies: each call and its answer reach the wire, keyed by call id; three parallel calls each get their own answer, merged into one user turn on the Messages wire with `tool_result` first (the same rule the kernel's own adapter uses); images nested in a result survive instead of vanishing (Chat follows with a user turn, Messages nests them inside `tool_result`); **each answer appears exactly once on each wire** — counted in the bytes that go out, not by block type, because a block-type assertion cannot see a duplicate; answers with no call id, dangling calls and orphan results are still removed; already-valid history is returned byte for byte |
| `pwsh` filling the `bash` slot is accepted upstream | live upstream, `probes/shell-slot-promotion.mjs` (new) | Declares `bash, glob, grep, read`, where `bash` carries pwsh's real schema and no decoy is added: the gateway does not answer `FreeTierError`, the turn finishes `tool-calls`, and the call comes back renamed to **`pwsh`** (`{"command":"Get-Date"}`) — a tool the kernel can actually run. Offline, `fingerprint-test.mjs` (new, 20 assertions) pins no-duplicate declarations, a real `bash` winning over the donor, and the decoy surviving only when there is nothing to promote |
| A cut stream is no longer a completed turn | offline `truncation-test.mjs` (new, 22 assertions) | A local HTTP server really does `res.end()` a stream that never carries a finish token → `kind=error`, recorded `ok=false` and flagged `truncated`; checked on each of the three wires; genuine endings such as `message_stop` and `response.completed` are not caught; a turn that finishes without a usage frame is flagged `noUsage`, so `0/0` stops being indistinguishable from "produced nothing". **Re-sending now depends on what had already arrived**: a cut that delivered no token at all stays `TRANSPORT` (retryable), while one that had streamed content becomes `STREAM_CUT` (outside the retryable set, so the turn fails on the spot) — the reason is the next row |
| What retries cost, measured in a real kernel session | real `dsh` web kernel, one turn sent from the browser on MiMo V2.6 Flash · Deep | Taken event by event out of the durable session log: `llm/retry retry=1 delay=702ms code=TRANSPORT` at 304 s, `retry=2 delay=1124ms` at 608 s, `turn/end {kind:"error",code:"TRANSPORT"}` at 912 s; `stats.json` holds three `ok:false truncated:true` rows of 0/0, 304 s apart; the interface showed *turn failed* with the message and the code. The cut on this lane is a function of how long the turn thinks, so a retryable code only billed the same five minutes three times over — which is why content that already streamed is not re-sent |
| Re-reviewing this release found two defects in the above | offline `projection-test.mjs` section 7 and `truncation-test.mjs` section 12, plus one forwarded round trip in `tui-test.mjs` | (1) Once the Messages wire recognised V4's `role:'tool'`, it put the same answer inside `tool_result` *and* left it in the ordinary blocks after it — the text twice, and a returned image with its whole base64 payload twice. The message is now skipped once its result is emitted, and reverting that turns the assertion red. (2) `response.incomplete`, `response.failed` and `response.done` end that wire on purpose too; reading only `response.completed` as terminal turned a turn that hit its output ceiling into a cut stream and burned two retries on it. The status still decides the finish token, and a terminal frame naming no reason no longer erases one a previous frame gave. (3) The forwarded `/v1/responses` route had never been exercised with tool history; the outbound `messages` are now compared byte for byte against a stub gateway, call and result both present |
| What a normal ending looks like on this lane | live upstream, `probes/stream-terminal-frames.mjs` (new) | Raw SSE captured frame by frame: `finish_reason:"stop"` → the usage frame → `data: [DONE]` → `{"choices":[],"cost":"0"}`, identically on two models. So "no finish token ever arrived" is genuinely an anomaly rather than a second normal ending — which is the basis for #10's check |
| No false positives against the real lane | live upstream, `host-selftest.mjs`, full run | 11 models probed plus plain chat, two tool rounds, three effort rungs and vision input: every call landed on its own normal ending (`stop` / `tool-calls` / `max-tokens`), none read as truncated; the region-gated model still returns `REGION_BLOCKED` |
| The upstream is documented (#8) | every outbound destination in the code, checked one by one | New section [Where the models come from](#where-the-models-come-from): `opencode.ai/zen/v1/*` (inference and `/models`), this repository's `feed/*.json` (raw first, jsDelivr as fallback), and `api.ipify.org` / `ipinfo.io` / `ipapi.co` (only to read back this machine's egress IP and country code). No account pool, no relay |
| Offline suite | `npm test` (18 suites) | Green; `projection` and `fingerprint` added, still no network and no free-lane quota spent |

### v1.2.2 (issues #1–#4, #6)

Each row names how it was checked: *offline fake kernel* never leaves the machine,
*live upstream* means the plugin really calls the gateway but runs on a
hand-built cordis context, and *real kernel* means the plugin was installed and
started inside dsh. The distinction cost this round a ship-blocker — see the last
row.

| Check | How | Result |
| --- | --- | --- |
| Manifest describes the shipped files | offline, `build-manifest.mjs --check` + `release-e2e.mjs` | All 26 published files match. Before the fix, `main`'s published 1.2.1 manifest had drifted on **6** files (`index.js`, both READMEs, `src/catalog.js`, `src/store.js`, `src/upstream.js`) — one more recurrence than the 2 issue #1 reported, after the issue was filed. Regenerated with the version; `--check` and the new `release-e2e.mjs` (it installs the real release end to end, with a negative control proving a manifest that lies about one byte is refused) now run in `npm test` and in CI. This round closed two holes of the same family: digests are now computed over **LF-normalised** bytes (`.gitattributes` says `* text=auto eol=lf`, and an editor on Windows can leave the working tree CRLF while `git status` stays clean — which is exactly how issue #1 came back), and listed directories are walked **recursively** (the old one-level scan skipped `src/lib/x.js`: npm ships it, the manifest does not name it, and `installStaged` deletes whatever the manifest does not name from every installed copy). Both carry standing assertions, the first of which rewrites all 26 files to CRLF and runs `--check` |
| Offline suites | `npm test` (14 suites) | 14/14 pass; no network, no free-lane quota spent. Suite ports come from the ephemeral range (a hard-coded port loses a race with any other process: occupying the one `tui` used to write down made its own fetch hit somebody else's listener and hang to the runner's timeout, printing six `ok` lines as the "failure detail"), and the runner puts a 60 s deadline on every suite and says so when one hangs |
| The new tests actually bite | old behaviour patched back in, suite re-run | Reverting the `computeMembership` guard → picker fails with `Cannot read properties of undefined (reading 'state')` (2 checks); reverting the response sniff → sniff fails 7 checks. Restoring each fix turns both green again. Every assertion added this round went through the same treatment as a **mutation check**: 9 fixes reverted one at a time in throwaway copies, 9/9 turned their suite red |
| Probe verdicts → what the picker advertises | live upstream, `host-selftest.mjs` | 10 listed models → 7 on the main route plus 2 under `region-limited`, and the forward port's `/v1/models` follows at 9; `deepseek-v4-flash-free` (`Model is unavailable`) left the dropdown with its refusal recorded in the settings page. 5xx / 429 / dropped connections all keep their model |
| A model with no verdict is survivable | offline fake kernel, `picker-test.mjs` | With a newly listed model whose probe the test holds open, `listModels` and `/summary` both answer, the model is advertised and reads `availability=unknown` |
| Rungs still enforced | live upstream, MiMo V2.6 Flash | `light` now sends 4096 and the same prompt finished `stop` at 2 980 tokens; before the change `light` (2048) ended that same prompt with `length` |
| Long answers stop being cut | live upstream, `probes/long-answer.mjs` | `balanced` sent `max_tokens=16384`; the request produced **10 164** output tokens (19 914 characters, 194 s) and finished `stop`. The old 8192 ceiling cut the same turn with `length` — the symptom in issue #2. The model cards print each rung's real number (`默认档上限 16K`), read in the browser |
| The body decides, not the header (issue #6) | offline fake gateway, `sniff-test.mjs` | A 200 with `application/json` over SSE frames streams normally with no error; a Chinese character split across chunks, a 400-frame stream past the 4 K sniff window, a single JSON body, an empty body and an HTML junk body all route by shape. On the old code that same response also made the probe report a working model as `unavailable` |
| Composition with no web server | offline fake kernel, `scripts/tui-test.mjs` | With only `llm` mounted, `apply()` does not throw, both routes register, a full streamed turn completes, the forward port comes up and rejects keyless requests, and the background loops run on plain unref'd timers. The dashboard half waits, and mounts both routes the moment `webServer` appears. **Not yet verified on a real dsh-tui**: neither kernel on this machine (source build 0.1.7-rc.1, AIO 6.9.3) ships a tui profile |
| The plugin really installs and runs | **real kernel**, dsh 0.1.7-rc.1 web on port 3099 | No `did not activate` in the startup log; `/api/our-free-model/summary` 200 (10 models: 6 available, 2 region-blocked, 1 unknown, 1 unavailable), `/events` streams its hello; in the browser `Settings → Our Free Model` renders the 10 cards, the *Not in the picker* group, the `思考不可关` and `默认档上限 16K` tags, with an empty console. The first cut of this round **failed here**: with `inject` reduced to `['llm']`, reading `ctx.interval` threw `cannot get property "timer" without inject` and the plugin stopped activating on every composition |
| Two new problems the review itself caught | targeted repro + standing assertions | (1) Aborting during the head sniff threw the raw `AbortError` (numeric `code` 20), which `toFailure` cannot recognise and downgrades to `TRANSPORT` — a retryable code, i.e. a hole where a turn the user cancelled could be retried. All three read paths now share `classifyStreamFailure`, and sniff carries two abort assertions. (2) After committing, another `src/http.js` edit drifted the manifest, and `--check` plus the new `release-e2e.mjs` failed it on the spot - the gate works, and it is also the reminder that any edit means re-running it |
| This round, on the request path: two ways to lose or double-pay a turn | local fake gateway, targeted repro + standing assertions | (1) `readHead` filled its whole 4 KB window before deciding what the body was, so a **short answer the gateway had already finished typing** sat in the sniff until the deadline and was then discarded with the cancel — a completed turn reported as a retryable `TIMEOUT`, which the harness sends again and the lane pays for twice (the repro prints `frames delivered: 0`). The body is now allowed to declare itself a stream on the first frame, which also stops withholding the first 4 KB of every answer. (2) In-stream errors were classified into `llmCode`, and `toFailure` reads `code` — so every refusal inside a stream arrived as retryable `TRANSPORT` (re-sending a turn whose partial answer had already been forwarded), and a mid-turn `RegionError` could never reach the egress re-probe. In-stream errors now go through the same `classifyFailure` as an error envelope |
| This round, at the settings boundary | offline, `picker-test.mjs` + `effort-test.mjs` | `probeIntervalMinutes:'abc'` made `Math.max(1,'abc')` = NaN, and Node treats `setTimeout(fn, NaN)` as 1 ms — a full catalog probe every second. `defaultMaxTokens:0` (which is what clearing the settings-page field posts) became `min(capacity, 0)`, cutting every turn to the 512-token floor while the picker went on printing its 4 K/16 K/32 K ladder. Numbers are now coerced both where they are written and where they are read, and a non-positive value means "unset". The same assertions pin the forward listener to a loopback bind (`0.0.0.0` is refused with a 400 that says why) and pin that `connection` admission is read **per request**: patch the snapshot back in and the late-mount 401 check goes red on the spot |
| This round, three suites that only looked like tests | mutation check (revert one fix per throwaway copy) | `retry-safety-test.mjs`'s four cases all landed on the "model not on this route" early return — it passed `model:"our-free-model/test-model-free"`, and `baseModelId` strips a label, not a route — so the suite had never sent a request; against real calls its 7 cases now pin the code, whether it may be retried, and whether the region re-probe fired. `tui-test.mjs` compared the *counts* of two different populations, so deleting the 120 s loop's `unref()` stayed green; it now checks each period individually. And the hard-coded port in `tui` became an ephemeral one after it hung for 180 s against somebody else's listener |
| Usage accounting | offline, `retry-safety-test.mjs` | A `usage` object without `prompt_tokens_details` no longer computes `inputTokens: NaN`; the forward port answers in `prompt_tokens/completion_tokens` and reports a refused turn as an error instead of an empty 200. On the Messages wire `message_delta` carries only the output side, and the old whole-record overwrite zeroed the prompt tokens of every Claude turn; records are now merged field by field |
| This round: a 5xx reason phrase is no longer read as a verdict (the same regression issue #3 was about) | offline, `sniff-test.mjs` + revert check | `stateOf` matched its message fallback without regard for the status, and "Service Unavailable" is the reason phrase every reverse proxy answers a 503 with — so an overloaded gateway was read as the gateway naming each model refused, and those models left the picker one at a time (the cost issue #3 removed, back through the message fallback). The fallback now only speaks when the status has not already answered for the gateway; a body that names the model — including `type: ModelError` under a 5xx — is still a refusal. Four new assertions, two of which go red the moment the old implementation is restored |

### v1.1.2 (announcements, in-app upgrades, hot reload, trust fence)

Every v1.1.2 capability was **operated for real**, including click-through in a
browser and inside the DSHEAC AIO desktop window:

| Check | Result |
| --- | --- |
| `dsh` 0.1.7-rc.1 (source build) | Boots clean; picker shows both groups; multi-round tool calling completes |
| `dsh` 0.1.5-rc.2 (DSHEAC AIO 6.9.3 kernel) | Boots clean alongside the other installed third-party plugins |
| EAC startup gate | Run at install time **and after the in-app upgrade**: `compatible` / `PASS` |
| Model reachability | All 10 catalog models stayed invocable (behaviour at that round: even probe-failed ones remained in the picker; since v1.2.2 a model judged unroutable is not advertised); real chat, multi-round tools and vision input pass on both kernels |
| Real harness conversation | One real turn completed and answered in both dsh web and the AIO desktop window |
| Announcement feed | New items pushed on a local "repository server" arrived within one poll cycle on both surfaces |
| Announcement center UI | 4 items rendered (bold/code/links/lists), urgency badge, unread dots, mark-read single/all |
| Urgent announcement | An `urgent` push opened the full-screen modal; acknowledging persisted |
| Toast + OS notifications | Live toast on arrival; the desktop `window.Notification` channel exists (when the WebView2 permission policy denies the request, the UI says so) |
| In-app upgrade | 1.1.0 → 1.1.2 completed on both dsh web and AIO: 23 files downloaded, SHA-256 verified, backed up, replaced, hot-reloaded; `/meta` reported the new version immediately |
| Upgrade safety | A hash mismatch discards staging, leaves the installed package untouched and logs the failure; upgraded artifacts pass the EAC gate and a full restart |
| Hot reload | Button and API entry points; ESM cache purge + re-register + rollback sequence; `generation` increments, client notices once via localStorage |
| Client bundle hot swap | Replacing `client.js` reloaded the browser bundle automatically via the kernel's client-hmr (observed twice) |
| Trust fence | Non-loopback Host / cross-site `sec-fetch-site` / foreign `Origin` all 403; cookieless loopback requests 401 (same as the kernel's `/api`) |
| SSE push | `hello`/`announcements`/`update`/`upgraded` events verified; EventSource reconnects after a hot reload |
| Effort propagation | light/balanced/deep measured live: reasoning 2048 (budget-truncated) / 3386 / 3522, output rising monotonically |
| Region gating | Region-blocked model surfaces as `REGION_BLOCKED` and stays in its own group |
| Forward listener | `/v1/models`, streaming and non-streaming `/v1/chat/completions`, unauthenticated requests rejected `401` |
| UI strings | No mojibake; the upstream vendor name appears in exactly two places — the repository docs and the announcement body, since #8's disclosure needs a place a user can actually see. The model picker, the settings page and error copy still never name it |
Not verified, so stated plainly: the **final OS-level notification rendering**
was not visually confirmed — the AIO build's WebView2 permission policy denies
`Notification.requestPermission()` (the plugin's Tauri notification channel is
present, the plain-browser path works, and the settings page says plainly that
permission was denied). The AIO guard also runs a report-only heuristic scan
that logs one finding for the `env`-adjacent-URL pattern in `src/upstream.js`;
it never touches files.


---

Back to [README](../README_EN.md)
