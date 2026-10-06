<div align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">

# dsh-our-free-model

[简体中文](README.md) | **English**

  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">

  <p><strong>Trending · recorded 2026-10-06</strong></p>
  <!-- Self-hosted static cards record verified ranks; the images ship in the repo. Click through to the charts. -->
  <a href="https://trendshift.io/?language=JavaScript"><img alt="Trendshift JavaScript daily #14, recorded 2026-10-06" src="docs/images/trendshift-daily-2026-10-06.svg" width="300" height="118"></a>
  <a href="https://gittrend.io/trending/ai-infrastructure"><img alt="GitTrend AI Infrastructure daily #14, recorded 2026-10-06, chart updated 2026-10-05" src="docs/images/gittrend-daily-2026-10-06.svg" width="300" height="118"></a>
  <p><sub>#14 on both the JavaScript daily chart and the AI Infrastructure daily chart. GitTrend's chart data is current as of 2026-10-05.</sub></p>
</div>

<div align="center">

> All you do is install this plugin in dsh — no login, no sign-up, no API key, no other
> step of any kind. The frontier models are simply there, DeepSeek V4.1 Flash and
> Kimi K3 among them. Completely free, with no usage cap.
>
> 你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括
> DeepSeek V4.1 Flash、Kimi K3 在内的前沿模型——完全免费、不限量。
>
> The roster follows upstream, availability is measured from **your own** network
> egress, the thinking-effort control sends a real budget instead of a prompt hint, and
> a local OpenAI-compatible forward port comes included.
>
> It mounts as a pure plugin: no core changes, no build step, zero dependencies.
> Current version: v1.4.6.

</div>

---

## Highlights

- **Nothing to configure** — install, restart, pick a model. No account, no key, no quota dashboard to register on.
- **The upstream is named** — one source, nothing else: OpenCode's Zen gateway at `https://opencode.ai`, with no third party relaying your traffic. Who serves your requests, and where your data goes, is spelled out in [Where the models come from](#where-the-models-come-from).
- **A roster that tracks upstream** — model set, context length and capabilities are re-fetched on every refresh rather than frozen into the plugin.
- **The picker offers only what actually answers** — a model the upstream lists but the gateway refuses to route outright (`Model is unavailable`, a 404 for that id) leaves the dropdown and stays visible on the settings page with its refusal recorded. Everything that is *not* a statement about the model — a gateway 5xx, a 429 quota window, a timeout, a dropped connection — keeps the model reachable. Region-gated ones move to their own `region-limited` group, and a whole round that answers nothing is never hidden: the picker never goes empty.
- **Announcement center with live push** — the repository owner edits one JSON file and pushes; every installation receives it within one poll cycle. Bodies are HTML rendered through a strict allowlist; `urgent` items open a full-screen modal; optional OS-level notifications.
- **In-app upgrades + hot reload** — one click in the settings page: download → SHA-256 verify → backup → atomic replace → verify-readback → hot reload, with automatic rollback on any failure. Upgrades and code changes take effect immediately, no app restart.
- **The body decides what it is, not the header** — under load this gateway answers 200 with a JSON `Content-Type` over a perfectly ordinary SSE frame stream. The plugin sniffs the first bytes and replays them into the stream, so the turn keeps streaming instead of being thrown away, and a working model is never demoted to `unavailable` because one header lied.
- **Thinking effort that actually binds** — `Light / Balanced / Deep` map to output-token budgets of 2 048 / 8 192 / the model's full capacity (doubled for models that cannot switch thinking off), recorded per call; every model card prints the number each rung will really send. This is a hard output budget, not a `reasoning_effort` string aimed at the endpoint (see [Why a budget](#why-a-budget-and-not-reasoning_effort)).
- **Works without a browser UI** — only `llm` is a hard dependency, so the plugin activates on a headless composition such as dsh-tui and still serves its models; the dashboard routes register once `webServer` appears, so load order cannot lose them.
- **Usage dashboard, local only** — token heatmap, cumulative curve by total or per model, output speed and time-to-first-token sampled per call. Nothing is uploaded.
- **OpenAI-compatible forward port** — expose these models to any other local tool through a base URL plus a generated API key; a LAN relay serves the rest of your network with a key of its own.
- **EAC lane (desktop only)** — DSHEAC AIO and the DeepSeek Harness desktop host unlock a co-paid channel automatically, prefixed on the model names; credentials are sealed and guarded by a host fingerprint gate. In the CLI and every other host the channel simply does not exist.
- **An auth fence on your API routes** — the plugin's routes outrank the kernel's `/api`, so they carry a trust check that matches the kernel's (connection service admission first, a structural fence as fallback).

## What the UI shows

**Composer model picker**

| Group | Contents |
| --- | --- |
| Our Free Model | Models usable from your current network exit |
| Our Free Model · region-limited | Models upstream refuses for this region, kept visible but separated |

A model judged "listed but not routed" appears in neither group — it stays under
**Not in the picker** on the settings page with its refusal and probe time, and returns
to the picker by itself once a probe gets through again.

**Settings → Our Free Model, six sections:**

- **Model roster** — per-model availability, vision vs text-only, context window, max
  output, the output ceiling each effort rung really sends, measured time-to-first-token,
  plus an on-demand single-call benchmark button.
- **Announcement center** — the push feed: unread counter, urgency badges, mark-read
  single/all, check-now, OS-notification toggle. Bodies render allowlisted HTML.
- **Usage board** — headline counters, a 17-week token heatmap, cumulative curves
  (tokens or requests, total or per model), speed sparklines, per-model table.
- **Local forward** — on/off, bind host and port, copy base URL, show / copy / rotate
  the key, a ready-to-run curl example.
- **Plugin settings** — master switch, whether region-limited models are exposed, probe
  interval, default output ceiling, plus the currently detected egress IP and country.
- **Plugin upgrade** — installed/latest version, check for updates, one-click upgrade
  (progress and failure reasons), upgrade history, hot-reload button, file-watcher
  switch.

A five-page first-run walkthrough (intro / roster / how to use / what it does / news &
upgrades) acknowledges once and never reappears until the copy version is bumped.

## Install

**Command line (plain dsh web)**

```
dsh plugin --profile web add /absolute/path/to/dsh-our-free-model
```

Install, then restart the app once. `--profile` should name the profile you actually use.

**DSHEAC AIO / desktop builds — read this first**

Before it starts the web app, the desktop host runs a profile gate whose scanner accepts
only the symlinks dsh generates itself under `.dsh-module-fallback`; any other symlink
or directory junction anywhere in the profile makes the app refuse to boot with:

```
PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
```

So on desktop builds: **do not install with a `link:` dependency and do not create a
junction.** Use the in-app plugin manager, or place a real directory.

To install manually as a real directory, under the profile:

1. Copy the published files into `node_modules/dsh-our-free-model/`
   (`index.js`, `client.js`, `adapter/`, `src/`, `locale/`, `icon.svg`,
   `cordis.patch.yml`, `package.json` — do not skip `adapter/`: `index.js` imports it
   on its first line).
2. Add `"dsh-our-free-model": "1.4.6"` to `dependencies` — that number tracks the
   repo's `package.json` `version`; bump them together, never copy a stale one, and use
   a version spec, not `link:`.
3. Append `"dsh-our-free-model"` to `dsh.profile.bundles`.

Do **not** also add an entry to `cordis.patch.yml`: a bundle referenced from
`dsh.profile.bundles` already applies its own patch layer, and registering it twice
fails with `duplicate loader entry id: our-free-model`.

**Integration packs (managed installation)**

When the plugin arrives through an integration pack (an EAC pack, Mojobox, …), the
pack owns update timing and bytes: install with the bundle config
`distribution: 'managed'` (or write the same field into settings.json), and the in-app
updater, the announcement feed and hot reload all stand down — two writers to one
installed directory corrupt it. The model lane is unaffected. Acceptance lives in
`scripts/offline-test.mjs`.

**Install failure: `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`**

Unrelated to the plugin (the error fires before it is even downloaded): the profile's
existing `node_modules` was created by an older pnpm, and after a dsh update the
bundled pnpm refuses to keep using it. Close dsh, delete the profile's `node_modules`
and `pnpm-lock.yaml` so pnpm rebuilds them, then install again:

```
rd /s /q "%DSH_HOME%\profiles\web\node_modules"
del "%DSH_HOME%\profiles\web\pnpm-lock.yaml"
```

The accompanying `Ignoring broken lockfile` warnings disappear with the rebuild.

## Usage

**Pick a model** — choose anything under `Our Free Model` in the composer picker. The
selection persists per session.

**Set thinking depth** — the same menu's Effort, three rungs Light / Balanced / Deep.
Higher rungs spend more of the output budget on deliberation; the ceiling is enforced
on the request, so the difference is measurable. Deliberation and the visible answer
share the one ceiling, which is why models that cannot turn thinking off shift the whole
ladder up (the model cards print each rung's real number). If answers keep getting cut
off, switch to Deep, or raise the per-call output ceiling in settings.

**Serve other local tools** — Settings → Local forward, enable it, copy the base URL
and generate a key. Supported:

- `GET /v1/models`
- `POST /v1/chat/completions` (streaming and non-streaming)
- `POST /v1/responses`

If another program holds the port, the listener does not die: it retries the same port
for a few rounds (a listener that just closed, or a portproxy rule that was just
removed, frees its port within a few hundred milliseconds), then walks to the next free
port and says so on the settings page — *requested 18899 is not available, listening on
18900* — and the port written back into the settings is the real one. On Windows the
most common owner is a `netsh interface portproxy` rule (served by IP Helper): its
listener on `0.0.0.0` makes the loopback bind fail with `EACCES` rather than
`EADDRINUSE`. `netsh interface portproxy show all` lists the rules and
`netsh interface portproxy reset` clears them.

The forward endpoint streams in full: besides the `data:` frames, a lane that is
thinking gets periodic SSE comment frames (a `:` line) so a client's idle timeout cannot
read "the upstream is still thinking" as "the socket is dead". Thinking is recognised
under `reasoning` / `reasoning_content` / `reasoning_text` (one thought repeated under
two of them is counted once) and under the `reasoning_details` array. A model whose
thinking never streams upstream sends no reasoning frames here; see [Known
limitations](#known-limitations).

**Serve other devices on your network** — the same panel carries a *Network access*
section, off by default. Enabled, the relay binds a routable address (default `0.0.0.0`)
and demands **a key of its own**, separate from the local key so a leak on either side
costs a rotation on that side only. The relay re-issues to the local listener, so the
roster, streaming and error semantics are identical. A port of `0` means "pick one". While
enabled, anyone who can reach this machine can spend its free quota with that key —
enable it only on a network you trust, and narrow the sources with a firewall if you can.

**Re-check geography** — the *Reprobe* button re-runs availability against your current
exit. Toggling a VPN and re-probing moves region-limited models between the two groups.

**Change egress (optional)** — Settings → Egress proxy, off by default (off = direct).
Two modes:

- **Subscription mode**: paste a Clash/V2Ray subscription URL; the plugin spawns mihomo
  locally (auto-detected — e.g. Clash Verge's `verge-mihomo.exe` — or set the path
  yourself) with a built-in url-test group that re-measures every five minutes and sends
  traffic to the fastest node, health-checking dead nodes out. **The URL is treated as a
  credential** (the path of a subscription link *is* its token): kept in the local
  settings file, never echoed in a payload; the panel only shows the masked host. The
  plugin only dials the local mixed port and never parses vless/vmess itself.
- **Single-proxy mode**: type an `http://` / `https://` / `socks5://` / `socks5h://`
  address and every upstream request dials through it.

Only three kinds of traffic are taken over: model inference, the model listing fetch,
and the egress IP probe; announcements, upgrades and the EAC lane stay direct. The
outlet serves this plugin's opencode traffic and nothing else on this machine: the
mihomo it spawns runs with `bind-address: 127.0.0.1` and `allow-lan: false`, no system
proxy, no virtual adapter — your browser and other tools are unaffected. While the
outlet is on, the panel shows the current exit, the best node and opencode reachability.

**What it can and cannot buy you**: per-IP rate limits and region gates move with the
outlet; per-session rate limits and fingerprint gates do not care which outlet you use.
Toggling the outlet re-probes on its own, so region-limited models follow the new exit.

**Receive announcements** — fully automatic: after the owner pushes, a running
installation picks the item up within one poll cycle (30 minutes by default, or
immediately via *Check for new announcements*). Regular items raise a toast, `urgent`
items open a full-screen modal, and both land in the announcement center with an unread
marker.

**Upgrade the plugin** — Settings → Plugin upgrade → Check for updates → Upgrade now.
The whole flow runs inside the app (download → verify → backup → replace → hot reload),
no reinstall or restart; a failed upgrade restores the previous version and reports why.

## Implementation structure

```
index.js          Host half: adapter registration, roster + availability probes,
                  settings/stats stores, webServer routes, forward lifecycle,
                  announcement / upgrade / hot-reload wiring
adapter/          Kernel seam: the only module in the package allowed to import
                  @deepseek-ai/*
src/adapter.js    Structural LlmAdapter: providerInfo, listModels, resolveModel,
                  prepareCall, stream, providerRetryPolicy
src/upstream.js   Free-lane identity: credentials, session/request id minting,
                  tool fingerprint, endpoint selection per wire
src/eac.js        EAC lane egress: direct/worker modes, HMAC signing, its own transport
src/egress.js     Egress proxy: optionally reroutes upstream requests through mihomo
                  or a user proxy, everything else unchanged
src/stream.js     Three wire decoders (chat / messages / responses) normalised to
                  StreamChunks
src/messages.js   Harness messages -> wire shapes, plus tool-pairing repair
src/effort.js     Effort level -> output budget
src/forward.js    Standalone OpenAI-compatible listener + LAN relay
src/probe.js      Availability / egress probing
src/trust.js      Request trust fence for the plugin's routes
src/push.js       SSE push hub: arrivals, update availability, upgrade done
src/feed.js       Remote announcement feed: multi-source fetch, validation, cache,
                  arrival detection
src/updater.js    In-app upgrade: manifest validation, tiered SHA-256 checks, backup,
                  atomic replace, rollback
src/reload.js     Self hot reload: mirrors the kernel HMR cache-purge / re-import /
                  re-register / rollback sequence
client.js         Browser half: hand-written ModuleLoader bundle, no build step
```

Architecture decisions worth knowing:

**One adapter, two provider routes.** The harness groups the model picker strictly by
provider route, and the catalog wire has no group/tag/badge field. Publishing a second
route is the only way to render a separate `region-limited` heading — and because the
client drops empty groups, the two collapse into one automatically once geography stops
blocking.

**Structural adapter, no `@deepseek-ai/dsh-llm` import.** The kernel never checks
`instanceof`, so the adapter is duck-typed. That keeps the plugin from pinning itself to
one kernel version and is why the same code runs on both 0.1.5 and 0.1.7.

**Own JSON store instead of the settings seam.** The settings registration API differs
between kernels; a private JSON store under `DSH_HOME` behaves identically on both and
keeps the forward key in a `0600` file that never enters any shared settings document.

## Why a budget, and not `reasoning_effort`

Passing a reasoning-effort string upstream was measured to be a no-op on this lane:
repeated samples at three nominal effort levels produced statistically
indistinguishable reasoning-token counts. So effort is implemented as a hard
output-token ceiling, which does bind — recorded reasoning tokens rise monotonically
with the level.

## Why the response is read by body shape, not by `Content-Type`

Under load this lane answers 200 with `application/json` over a normal SSE frame stream.
The old implementation trusted the header: `await response.text()` swallowed the live
stream, `JSON.parse` failed, and the whole turn was lost — and because that error
carried `status: 200`, the availability probe read a perfectly working model as
unroutable and dropped it from the picker for a round. Now the first bytes (≤ 4 KB) are
sniffed and classified by shape, then replayed into the stream, so nothing is buffered
and no token arrives late; `sniffBody` in `src/http.js` is the only discriminator.

## Why the speed panel can say `—`

An early build published 2941 tok/s for a lane really doing ~40. The gateway was not at
fault — a raw-read probe shows 64 frames spread over 5.6 s — but the numerator and the
denominator described different intervals: one call billed 422 output tokens, of which
291 were reasoning that **never streamed a single frame**, finished before the first
visible token, which is where the window began anyway.

So a rate is published only over a window that can carry it: `windowTokens()` removes
unstreamed reasoning tokens from the numerator, `decodeWindow()` rejects windows too
short to time and rates too fast to be real; both the panel and the per-model table sum
tokens over sum-seconds instead of averaging per-call ratios. A model whose answer lands
in one or two big frames therefore has no measurable output speed — and says so.

## Automatic recovery after a long reasoning stream is cut

Every model enables one bounded recovery attempt by default, across all three upstream
protocols. It requires a first stream that delivered nonempty reasoning, no answer text
or tool call, and then either reached EOF without a normal terminal frame, or received a
normal `stop` terminal carrying reasoning only — a turn the host would classify as an
empty response. Cancellation, a normal ending that already delivered answer text or a
tool call, reaching the ceiling, and an explicit upstream error all do not trigger it.

The plugin sends **one new request** containing the original input and the received
reasoning as a text checkpoint, asking for the final answer directly. This is a
checkpoint-based re-request, unrelated to any native upstream resume, and already
displayed reasoning is not replayed. Tools are disabled for the recovery request; a cut
after answer text or a tool call has started is not recovered, to avoid duplicate
content or execution.

One logical turn makes at most two physical requests (the original plus one recovery).
The default total deadline is 480 seconds; recovery gets at most 180, bounded by the
remaining total time. Recovery output is capped at 8192 tokens and still respects the
user's and model's ceilings; known output tokens from the first segment are subtracted
from the original budget, and recovery does not start if fewer than 512 tokens remain.
The checkpoint is limited to 131072 characters and must pass a conservative context-margin
estimate. Recovery counts as successful only if it ends normally with a non-whitespace
answer; failure returns `STREAM_CUT`, which the harness does not re-send as a whole
turn, and user cancellation keeps `aborted`.

Set `streamRecovery: false` in the local settings.json to disable it; an object can also
supply an `enabled` switch and lower numeric limits. There is no model allowlist.

The dashboard keeps **physical requests** and **logical turns** separate: upstream
requests and request failures count each HTTP request actually sent; conversation turns,
turn failures and recovered turns count one adapter invocation by its final outcome. A
first segment cut short followed by a successful continuation therefore shows 2 upstream
requests and 1 request failure, while remaining at 1 conversation turn with 0 turn
failures and 1 recovered turn. Usage reported to the harness sums only what the upstream
actually reported; if one segment has no usage report, that is not the whole turn's token
total. Reasoning checkpoints are not written to the statistics file.

## Where the models come from

The free lane has exactly one source, and it is not a relay: OpenCode's Zen gateway
(`https://opencode.ai/zen/v1/*`). Your conversation goes straight from this machine to
that gateway, with no third party in between. The following destinations were verified
one by one by direct request on 2026-09-24:

| Purpose | Target | Credentials it carries |
| --- | --- | --- |
| Inference | `POST …/zen/v1/chat/completions`, `/zen/v1/responses`, `/zen/v1/messages` (chosen per model) | `Authorization: Bearer public` — the lane is a public, keyless quota by design; the plugin holds no key of yours |
| Model roster | `GET …/zen/v1/models` | Same as above |
| Announcements & upgrade manifest | This repo's `feed/*.json`: raw.githubusercontent.com first, cdn.jsdelivr.net as fallback | None |
| Egress region check | api.ipify.org / ipinfo.io / ipapi.co (reads only this machine's public IP and country code) | None |

On privacy and trust:

- No account pools, no relays, no middlemen. The four rows above are the complete
  set of outbound destinations in the current version; `npm test`'s offline suites make
  no network calls, and only `scripts/host-selftest.mjs` and `scripts/probes/` actively
  hit these addresses — they must be run by hand.
- Your prompts, tool results and attached images go to that upstream as ordinary
  inference requests, exactly as with any model API. Nothing else is uploaded: usage
  dashboard data, settings and forward keys stay in the local
  `DSH_HOME/our-free-model/`.
- Keyless does not mean unmanaged: the lane identifies clients by `x-opencode-*`
  fingerprint, meters the free quota per session, answers 403 for restricted regions and
  429 for overuse. The model set and quota policy belong to upstream and may change at
  any time; the plugin can only do the honest thing and remove unroutable models from
  the picker.

## EAC lane (desktop only)

Besides the free lane, the plugin carries a co-paid channel (EAC) that unlocks only in
the two desktop hosts:

- **DSHEAC AIO (Tauri shell)**: unlocked only when the kernel path, the embedded node
  and the web-desktop profile fire together.
- **DeepSeek Harness desktop (Electron shell)**: the desktop-profile context provided by
  the kernel (the CLI rejects that profile by design) plus the runtime marker the shell
  sets on the kernel process.

In the CLI, plain dsh web and every other runtime, the channel simply does not exist:
no models, no requests, no errors, no decryption attempts.

Display: model names show the bare model name with a channel prefix, e.g.
`EAC DeepSeek V4.1 Flash`; settings-page model cards carry a separate EAC badge. The
roster tracks upstream refreshes.

**Encrypted sealing**: channel credentials and endpoints never appear in readable form
in the plugin — only as AES-256-GCM ciphertext, with the decryption key derived at
unlock time from three masked shards spread across two files; non-authorized hosts never
enter the derivation path. Credentials are not persisted and never leave the process:
unlock happens on demand per request, and the plaintext exists only for that one frame —
not written to disk, not in logs, not in any API response or error message.

**Signed gateway (the recommended form)**: `worker/` ships a gateway implementation —
the plugin is sealed with only the gateway address and an HMAC signing key; requests are
signed as timestamp + HMAC-SHA256(method / path / body digest), and the relay's real key
lives only in the gateway's environment variables. Anti-replay window, model allowlist
and optional per-IP rate limiting all run at the gateway; a leaked signing key is revoked
for every client by rotating it gateway-side. Deployment and rotation live in
`worker/README.md`.

## Known limitations

- **"Unlimited" means no quota system**: no top-ups, no per-token billing, no plans.
  But the lane meters per session, and a short burst that saturates it returns 429. The
  plugin marks that model "quota reached" rather than hiding it; the next probe round
  recovers it automatically.
- **Some models are slow upstream.** A first token past 30 seconds has been measured;
  the thinking phase can stay silent for 60–70 seconds (billing reasoning tokens while
  sending no thinking frames). The dashboard shows this honestly. Such turns can end
  `stop` with an empty body, which clients report as an "empty response": raise the
  per-call output ceiling above 16k, or use a model the card marks `reasoning: false`.
- **Thinking and the answer share one output budget.** Ladders shift up whole for models
  that cannot turn thinking off; see "Set thinking depth".
- **Recovery is bounded in count, time and context.** It only covers a pure-thinking EOF
  and a pure-thinking empty stop, adds at most one request, is not guaranteed to
  succeed, and usage is only the known part when a segment reports none.
- **Capabilities are marked only where a probe can prove them.** Anything the public
  listing and live measurement both fail to evidence is left unmarked.
- **The source is plaintext JavaScript.** That is unavoidable for a local plugin; anyone
  who can read the directory can understand the gateway logic. Obfuscation would not
  fix this.
- **Desktop installs need a real directory** — see Install.
- **Trust boundary of upgrades and hot reload**: the trust root of in-app upgrades is
  the Ed25519 public key pinned in the plugin, not "HTTPS to the repo". A poisoned
  mirror (including jsDelivr) can only fail upgrades, never execute code. Whoever holds
  the release private key can push arbitrary code — which is equivalent to "whoever can
  push to the repo", but it downgrades a taken-over repo account from instant RCE to
  "everyone's upgrades fail".
- **DSHEAC AIO's WebView2 permission policy can deny notification grants** (observed
  locally as denied). The announcement center's toggle then says so honestly; plain
  browser access to dsh web is unaffected.
- **The auth level depends on the composition.** With a `connection` service mounted
  (dsh web, AIO desktop) the plugin's routes sit at the kernel `/api` level and require
  the app's own cookie/token; in a minimal composition without connection it falls back
  to a structural fence (loopback + same-origin checks), and other local processes can
  still reach it — same as the kernel behaves in such compositions. In that composition
  any local process can grab the forward and LAN keys with one request; treat those keys
  as locally-readable files (same trust level as settings.json) and mount a connection
  service if you need stronger isolation.

## Security & privacy

- All state lives under `DSH_HOME/our-free-model/`; usage and settings stay local and
  are never uploaded.
- The forward listener binds loopback only (default 127.0.0.1) and rejects every
  request without a key; binding a routable interface is refused outright (POST
  /settings answers 400 and says why). Names like `localhost` are resolved via
  `dns.lookup` and only accepted when every answer is loopback; the bind uses the
  resolved IP — when a hosts file or corporate DNS points localhost at a routable
  interface, the check and the bind cannot disagree.
- LAN access is a separate door that does not relax the above: the local listener still
  binds loopback; cross-machine use must explicitly enable Network access, the relay
  binds a routable address, and every request needs the LAN key — including `/` and
  `/health` liveness probes (only the loopback listener answers those keyless). The
  relay forwards only the three allowlisted paths (`/v1/models`,
  `/v1/chat/completions`, `/v1/responses`) and does not proxy arbitrary loopback
  services; it swaps the LAN key for the local key at the entrance (the two never
  cross), rejects hop-marked requests (508), and cannot loop back into itself even when
  configured with the machine's own port. The LAN key is generated by `crypto`,
  compared with `timingSafeEqual`, kept in the same `0600` file, and rotatable from the
  panel.
- The forward key is generated at runtime by `crypto`, compared with `timingSafeEqual`,
  and stored in a `0600` file. The repo contains no hardcoded credentials. `/` and
  `/health` are liveness probes answered before key checks, and only say whether the
  process is up.
- The plugin's HTTP routes sit behind a request trust fence: the
  `/api/our-free-model` prefix, under the webServer's longest-prefix dispatch, once
  outranked the kernel's `/api` and bypassed its auth. Every request now passes the
  composition's connection admission first (same level as the kernel `/api`); a
  composition without connection falls back to the structural fence — loopback Host,
  cross-site `sec-fetch-site` refused, Origin/Referer must match Host in scheme and
  port, and a missing or empty Host is refused (fail closed). The connection service is
  fetched per request, because the browser half only provides it after the plugin loads.
- Announcement HTML is rendered client-side through a strict allowlist (all XSS corpus
  discarded, no innerHTML sink); feedUrl may point anywhere, and the renderer treats it
  as untrusted input.
- The in-app upgrade integrity chain: Ed25519 signature verification of the manifest
  (public key pinned in `src/updater.js`) → manifest validation (semver, path escapes,
  hash formats, `base` restricted to manifest-relative paths) → per-file SHA-256 and
  byte-count checks → staging readback → post-install readback → backup restore on any
  failure; the manifest is force-re-fetched before install.
- The update channel is fully decoupled from feedUrl: feedUrl only ever redirects the
  announcement feed and can never point at upgrade manifests. Announcement overrides
  allow https only (except loopback http) and cannot embed credentials. In compositions
  without a connection service, a local caller who can change settings can make the
  process poll any external address — treated, like the rest of the plugin's outbound
  traffic, as "settings are trust": someone who can edit settings.json can already
  install code.
- Uninstalling is just removing the bundle entry; the plugin leaves no patch behind,
  and the data directory is plain JSON that can simply be deleted.

## Deploying and rotating the EAC gateway

The `worker/` directory contains the gateway implementations (Cloudflare Worker and a
self-hosted Node build share one logic) plus complete deployment/rotation docs — see
`worker/README.md`. The essentials:

- The gateway is the channel's **only holder of secrets**: the plugin holds only the
  gateway address and signing key in sealed form; the relay's real key lives only in the
  gateway's environment. What plugin reverse-engineering yields is only a revocable
  indirection.
- Signing contract: `x-ofm-timestamp` (unix ms) + `x-ofm-signature`
  `hex(HMAC-SHA256(secret, "<ts>\n<METHOD>\n<path>\n<hex(sha256(body))>"))`; timestamps
  outside the window are refused (anti-replay); only GET /v1/models and POST
  /v1/chat/completions are admitted.
- The self-hosted gateway carries three layers of self-defense (`.env` config): per-IP
  concurrency cap (CONCURRENCY_PER_IP=5), per-IP rate and daily quota
  (RATE_LIMIT_PER_MINUTE=60 / RATE_LIMIT_PER_DAY=1000), and an admin dashboard
  (ADMIN_TOKEN, `/eac/stats?t=…`: request heatmap, 72h curve, per-IP/per-model token
  donut, per-IP detail table; data in stats.json, IPs hashed with a salt).
- SSE pre-flush (SSE_PRELUDE_SECONDS=15): as soon as the signature passes, reply 200 +
  `text/event-stream` + comment frames, and only then feed real frames as tokens
  arrive — built for Cloudflare origin timeouts and nginx's default 60s read timeout,
  since reasoning models frequently take 30–140 seconds to first token.

## Development

```
npm test # all offline suites + manifest consistency, one command
node scripts/client-lint.mjs      # browser half: copy/style key coverage both ways, bundle executable
node scripts/retry-safety-test.mjs # failure objects, backoff and usage counts handed to the kernel
node scripts/speed-stat-test.mjs   # no single call may average into a fake tok/s
node scripts/sanitize-test.mjs     # announcement HTML allowlist renderer: all XSS corpus discarded
node scripts/trust-test.mjs        # request trust fence for the plugin's routes
node scripts/feed-test.mjs         # announcement feed: parse, failover, cache, arrival
node scripts/updater-test.mjs      # in-app upgrade: manifest, SHA-256, backup/rollback
node scripts/effort-test.mjs       # effort level = the max_tokens actually sent, matching the recorded level
node scripts/sniff-test.mjs        # 200 answered by body shape: SSE frames, single JSON, empty body, cross-chunk, mid-abort
node scripts/release-e2e.mjs       # a real upgrade off feed/manifest.json; a byte-lying manifest is refused
node scripts/picker-test.mjs       # the picker advertises only usable models, never an empty set
node scripts/tui-test.mjs          # the plugin starts and serves models in a web-serverless composition
node scripts/host-selftest.mjs     # host-half end to end; makes real network calls
node scripts/build-manifest.mjs    # release: regenerates feed/manifest.json (hash list of published files)
```

The release manifest must be signed with the release private key (`--key` or the
`OFM_MANIFEST_KEY` env var); an unsigned manifest is refused outright by the builder —
in-app upgrades have installed only manifests verifiable against the plugin's pinned
public key since v1.3.2. The private key never enters the repo or any artifact; rotating
it equals rotating the trust root, which means also changing the pinned public key in
`src/updater.js` and running a full release pass.

`scripts/probes/` holds one-shot forensics scripts from the reverse-engineering work
(capability matrix, region gate, `reasoning_effort` ineffectiveness sampling, budget
dialect, dangling tool calls, …). Those built on this plugin's own code can run from the
repo root (e.g. `node scripts/probes/pairing-repair.mjs`); the rest dial upstream with a
third-party SSE client, their module paths match the repo layout at forensics time, are
kept as records, are not part of the test suite and are not wired into npm test.

Requires Node `^22.19.0 || >=24.0.0`, no install step, no dependencies.
`npm run typecheck` (`tsc --noEmit`) does strict type checking (optional, needs
typescript).

## License

MIT, see LICENSE.

This project is an independent plugin and has no affiliation with, endorsement by, or
sponsorship from any model provider. Using this plugin to access free quota is subject
to each provider's own terms; confirm those terms before deploying it beyond a personal
machine.