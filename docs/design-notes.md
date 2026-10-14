# Design notes

How it is built, the trade-offs behind it, and how the aggregate lane, token savers, routing and the local gateway work.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

### How it works

```text
index.js      host half: adapter registration, catalog + availability probes,
              settings/stats stores, webServer API routes, forward lifecycle,
              announcement / upgrade / hot-reload wiring
adapter/      kernel seam: the only module in the package allowed to import
              @deepseek-ai/* (kernel.js: attribution User-Agent with a literal fallback)
src/adapter.js  structural LlmAdapter: providerInfo, listModels, resolveModel,
                prepareCall, stream, providerRetryPolicy
src/upstream.js gateway identity: credentials, session/request id minting,
                tool fingerprint, endpoint selection per wire
src/stream.js   three wire decoders (chat / messages / responses) normalised to
                harness StreamChunks, with disjoint token accounting
src/messages.js harness messages -> wire shapes, plus tool-pairing repair
src/effort.js   effort level -> output budget
src/forward.js  standalone OpenAI-compatible listener (plus the Anthropic Messages endpoints)
src/providers/registry.json aggregate-lane registry: 76 providers, category, auth, wire
                format and endpoints
src/providers/index.js registry access and provider/model composite id parsing
src/aggregate.js aggregate lane: catalog rows, credential resolution, key redaction,
                listing probes, per-wire posting
src/anthropic.js Anthropic Messages codec for /v1/messages, plus the local token estimate
src/token-saver/index.js compaction pipeline: prompt injection -> tool-output compaction,
                byte accounting, fail-open
src/token-saver/inject.js idempotent injection and stripping on the chat / messages /
                responses wires
src/token-saver/prompts.js the caveman and ponytail prompt families and their levels
src/token-saver/rtk/ tool-output filters: git diff/status/log, grep, find, ls, tree,
                build logs, numbered dumps, search listings, duplicate log lines
src/local-optimize.js the five local answers: quota, prefix, title, suggestion, filepath
src/combos.js fallback chains: virtual catalog rows, two strategies, intersected capacities
src/route/classify.js one failure vocabulary and cooldown policy for every lane
src/trust.js    request trust fence for the plugin's routes (connection bridge
                + structural fallback)
src/push.js     SSE push hub: arrivals, update availability, upgrade done
src/feed.js     remote announcement feed: multi-source fetch, validation, cache,
                arrival detection
src/updater.js  in-app upgrade: manifest validation, SHA-256 checks, backup,
                atomic replace, rollback
src/reload.js   self hot reload: mirrors the kernel HMR sequence (cache purge,
                re-import, re-register, rollback)
client.js       browser half: hand-written ModuleLoader bundle, no build step
```

Design decisions worth knowing:

- **One adapter, two provider routes.** The harness groups the model picker strictly by provider route, and the catalog wire has no group/tag/badge field. Publishing a second route is therefore the only way to render a separate `region-limited` heading — and because the client drops empty groups, the two collapse into one automatically once geography stops blocking.
- **Structural adapter, no `@deepseek-ai/dsh-llm` import.** The kernel never checks `instanceof`, so the adapter is duck-typed. This keeps the plugin from pinning itself to one kernel version and is what lets the same code run on both 0.1.5 and 0.1.7.
- **Own JSON store instead of the settings seam.** The settings registration API differs between kernels; a private JSON store under `DSH_HOME` behaves identically on both and keeps the forward key in a `0600` file that never enters any shared settings document.
- **The token savers run on the single choke point, and they fail open.** Prompt injection and tool-output compaction run after every other mutation has been applied — the fingerprint rename, the effort patch, the sealed lane's pacing hint — at `payloadFor()`, the one place both the adapter's own dispatch and the local gateway (which dials through the adapter) pass through, so every lane and every recovery segment is compacted. Every step fails open: a saver that throws is skipped, a filter that throws passes the original text through, an unrecognised body shape is left alone — a request must never fail over the thing that was supposed to make it cheaper.
- **A combo is a virtual catalog row, so failover is resolved in the adapter.** A chain joins the merged catalog as `channel:'combo'` plus a list of real model ids, which is why the picker advertises it and the gateway dials it by name like any other row; the chain is expanded and advanced inside the adapter's `runStream()`, so neither caller has to know about failover.


---

### Why a budget, and not `reasoning_effort`

Passing a reasoning-effort string upstream was measured to be a no-op on this
lane: repeated samples at three different nominal effort levels produced
statistically indistinguishable reasoning tokens. Shipping a control that does
nothing is worse than shipping no control, so effort is implemented as a hard
output-token ceiling, which does bind — recorded reasoning tokens rise
monotonically with the level.

### Three kernel behaviours that cost real debugging time

These are recorded here because they will bite any provider plugin:

1. **`providerRetryPolicy()` is stored verbatim.** Neither kernel resolves it, and
   the backoff scheduler reads `initialDelayMs / maxDelayMs / jitterRatio` off the
   **top level**. Returning them nested under `backoff` yields `undefined * 2ⁿ =
   NaN`, and the durable session log rejects non-finite numbers — so a recoverable
   transient failure becomes an aborted turn. Return an already-resolved, flat policy.
2. **One interrupted tool call poisons the whole session.** A tool call with no
   matching result replays as `400 invalid_request_error`, after which *every*
   request in that session fails. The plugin repairs pairing before sending, on all
   three wires.
3. **A service you did not name in `inject` throws when read as a property, and
   `ctx.get()` answers `undefined` for one that is merely not provided yet.** Both
   bit this round: after `inject` was reduced to `['llm']`, `typeof ctx.interval ===
   'function'` threw `cannot get property "timer" without inject` (`ctx.interval` is
   a mixin over the `timer` service) and the plugin stopped activating on *every*
   composition. Switching that one to `ctx.get('webServer')` then answered
   `undefined` — not because the composition had no web server, but because plugins
   load before the browser half publishes it — so the settings routes were never
   registered and the dashboard had no data source behind a server that was busy
   serving the app. The shape that works is `ctx.inject(deps, callback)`: give the
   services you need their own fiber and let *it* wait, instead of guessing once at
   load time.

### Why the response is read by body shape, not by `Content-Type`

Under load this lane answers 200 with `application/json` over a normal SSE frame
stream. Trusting the header meant `await response.text()` swallowed the live stream,
`JSON.parse` failed, and the turn was lost — and because that error carried
`status: 200`, the availability probe read the perfectly working model as
unroutable and dropped it from the picker for a round. The first bytes (≤4 KB) are
now sniffed and classified, then replayed into the stream, so nothing is buffered and
no token arrives late; `sniffBody` in `src/http.js` is the only discriminator.

### Why the speed panel can say `—`

An early build published 2 941 tok/s for a lane really doing ~40. The gateway was
not at fault — a raw-read probe shows 64 frames spread over 5.6 s — but the
numerator and the denominator described different intervals: one call billed 422
output tokens of which 291 were reasoning that **never streamed a single frame**,
and the window began at the first visible token anyway. Dividing the whole
completion by the seconds the answer text took is not a decode rate.

So a rate is published only over a window that can carry it: `windowTokens()`
removes unstreamed reasoning tokens from the numerator, `decodeWindow()` rejects
windows too short to time and rates too fast to be real, and both the panel and
the per-model table sum tokens over sum seconds instead of averaging per-call
ratios — one 1 ms window was enough to move a 26-call average by three orders of
magnitude. A model whose answer lands in two frames therefore has no measurable
output speed, and says so.

### Automatic recovery after a long reasoning stream is cut (issue #12)

Every model enables one bounded recovery attempt by default, across the Chat
Completions, Messages and Responses upstream protocols. It requires a first
stream that delivered nonempty reasoning, no answer text or tool call, and then
either reached EOF without a normal terminal frame, or received a normal `stop`
terminal carrying reasoning only with no answer text — a turn the host would
classify as an empty response. Cancellation, a normal ending that already
delivered answer text or a tool call, an output ceiling and an explicit upstream
error do not trigger recovery.

The plugin sends **one new request** containing the original input and the
received reasoning as a text checkpoint, asking for the answer directly. This is
not a native upstream resume, and already displayed reasoning is not replayed.
Tools are disabled for the recovery request. A cut after answer text or a tool
call has started is not recovered, to avoid duplicate content or execution.

To avoid another long reasoning pass, the continuation prompt asks for the
conclusion first and at most 800 words. This is a prompt instruction, not a hard
token limit, and the model may ignore it. Recovery is a degraded answer: an
original request for a long or step-by-step analysis may be shortened.

One logical turn makes at most two physical requests: the original and one
recovery. The default total deadline is 900 seconds (15 minutes); recovery gets
at most 300 seconds, bounded by the remaining total time. Recovery output is
capped at 8192 tokens and still respects the user's and model's ceilings. Known
output tokens from the first segment are subtracted from the original budget;
recovery does not start if fewer than 512 tokens remain. The checkpoint is
limited to 131072 characters and must pass a conservative text-byte estimate of
context capacity.
That estimate does not count image tokens and is not an exact tokenizer check.
Exceeding a limit stops recovery. Success requires a normal ending with answer
text that is not only whitespace. Recovery failure returns `STREAM_CUT`, which
the harness does not resend as a whole turn; user cancellation keeps
`aborted` / `ABORTED`.

Set `streamRecovery: false` in the local settings.json to disable it. An object
can also supply an `enabled` switch and lower numeric limits; limits cannot
exceed the defaults. There is no model allowlist.

The local dashboard keeps **physical requests** and **logical turns** separate.
Upstream requests and request failures count each HTTP request actually sent;
conversation turns, turn failures and recovered turns count one adapter
invocation by its final outcome. A first segment cut short and a successful
continuation therefore show 2 upstream requests and 1 request failure, while
remaining at 1 conversation turn with 0 turn failures and 1 recovered turn.
Each segment still has its own sample with recovery identity, attempt index and
`noUsage` markers. A shared `recoveryId` associates those markers to identify
missing usage. Final usage sent to the harness sums only counts the upstream
actually reported; if one segment has no usage report, this is not the full
turn's token total. Reasoning checkpoints are not written to the statistics
file.

Pre-upgrade history has only physical request records, so migrated turn and
failure counts are estimates and the dashboard labels them. Turns recorded
after the upgrade use the final outcome and are exact.
Requests, turns and token totals are lifetime values; speed, first-frame and
heatmap details use the locally retained history window.

One live MiMo V2.6 Flash · Deep request recovered successfully; an earlier
attempt failed at the 480-second deadline. This does not establish live coverage
of every model or guarantee completion of every long reasoning turn. The
v1.3.1 records below describe behaviour before recovery was added.


---

### The aggregate lane, token savers, routing and the local gateway

### The aggregate lane: bring your own key for 76 providers

The **Aggregate** tab brings third-party endpoints into the same roster. The provider registry ships 76 entries (`src/providers/registry.json`, categorised `free | free-tier | apikey | oauth | local`): NVIDIA NIM, OpenRouter, Groq, Cerebras, SambaNova, Gemini, DeepSeek, Mistral, Together, Fireworks, SiliconFlow, Nebius, Chutes, Hugging Face, Cloudflare, Z.ai, Kimi, MiniMax, QwenCloud/Alibaba, Bedrock, Vertex, Vercel AI Gateway, Azure OpenAI, and the local no-account ones — Ollama, LM Studio and llama.cpp. The data comes from free-claude-code's provider catalogue and 9router's provider registry.

Once a provider is configured (a key for the ones that need one; the local no-account ones need none), each of its models becomes a catalog row named `provider/model`: selectable in the model picker and dialable through the local gateway. A provider's own wire format decides how it is served — OpenAI Chat Completions, OpenAI Responses, or Anthropic Messages (the last two for the providers that only speak those).

Keys live only in the plugin's own `0600` `settings.json`, and the API never echoes them: the page shows `hasKey` plus a `…abcd` fingerprint. An absent field keeps the stored key; an empty string clears it. Per provider the page offers enable/disable, a Test button, a Discover button, a base-URL override (needed for Azure, Cloudflare and Vertex, which have no usable default), a model-list override and Remove. Test is a *listing* probe — it verifies a key through the provider's model listing without spending a generation, and says so when the provider declares no listing. Providers whose auth is OAuth or ADC (Google ADC) are listed but marked *not drivable* here, because this lane cannot complete those flows.

### Token savers: tool-output compaction, prompt shaping and local answers

**Tool-output compaction (RTK)** rewrites `tool_result` / `role:"tool"` content in place before the request is sent: git diff, git status, git log, grep, find, ls, tree, build and package-manager logs, numbered file dumps, Cursor search listings, and runs of duplicate log lines. Measured live: a 40 KB `git diff` lost 90% of its bytes and the model still answered about the diff. The safety rules: error tool results are never touched, bodies below a size floor are left alone, the replacement is never larger than the input, a filter that throws passes the original through, and the pass is idempotent. It applies to every lane, the local gateway included, and is on by default.

**Prompt shaping** offers two families with levels — `caveman` (terse replies: `off/lite/full/ultra/wenyan-lite/wenyan/wenyan-ultra`) and `ponytail` (YAGNI-minimal replies: `off/lite/full/ultra`). They change how the assistant talks, so every level starts `off`. Injection is idempotent and format-aware (a system message on chat, Anthropic's `system` including the block-array form and inserted before the last `cache_control`, `instructions`/input item on Responses), and it is reversible.

**The savings dashboard** shows bytes before → after, bytes saved, percent, blocks compacted and the number of calls measured — read from the same stats rows the usage charts use.

**Five local answers** (ported from free-claude-code, each individually switchable, all on by default) never call a provider: a quota probe (`max_tokens:1` plus "quota" → `Quota check passed.`), shell command-prefix detection (`<policy_spec>` plus `Command:` → the prefix, refusing command injection), session-title generation (→ `Conversation`), suggestion mode (→ the empty string) and filepath extraction (→ a `<filepaths>` block). The local gateway answers them in-process.

### Routing: named fallback chains (combos)

A named, ordered list of model ids across every lane, which appears in the picker and on the gateway as `combo:<name>` — a virtual model. Two strategies: `fallback` (always start at the head) and `round-robin` (rotate the starting point, sticky for N turns). The chain walks its links until one produces output; a link that fails *before any content delta* is discarded whole, so the switch is invisible to the caller. Reasoning deltas deliberately do not count as content — "thought for a minute, then hit a quota wall" is the highest-value case to fail over. Once an answer delta has been delivered, a later failure ends the turn normally (the single-model checkpoint recovery still gets its continuation attempt first). Capacities are the intersection of the links (a chain advertises vision only if every link has it, and the smallest context window), and a chain whose links are all currently unavailable is stored and marked not usable rather than silently dropped.

### The local gateway: a native Anthropic surface and connect recipes

Two new endpoints: `POST /v1/messages` (streaming and non-streaming, with correct `message_start` / `content_block_*` / `message_delta` / `message_stop` framing, `thinking` blocks, `tool_use` blocks, a real `stop_reason`, and an in-stream `error` event when a turn fails after the headers went out) and `POST /v1/messages/count_tokens` (a documented local estimate — the plugin ships no tokenizer). Claude Code and the Anthropic SDKs can therefore point straight at the plugin. The existing `/v1/chat/completions` and `/v1/responses` are unchanged, and `/v1/models` now advertises every lane, the aggregate rows and the chains included. A new *Connect a client* section on the gateway page renders ready-to-copy recipes generated from the port that actually bound and the key that is actually required: Claude Code environment variables, Codex `config.toml`, the OpenAI SDK, the Anthropic SDK, curl, and a LAN variant when the relay is up.

One false success was fixed along the way: a turn whose only output was a tool call the caller never declared used to answer as a clean empty success; it now reports what happened, because the token saver's own `[full diff: rtk git diff --no-compact]` hint can make a model ask for a tool the caller does not have.


---

Back to [README](../README_EN.md)
