<div align="center">
  <img src="icon.svg" alt="Our Free Model — free model provider plugin for DeepSeek Harness" width="120">

# dsh-our-free-model

[简体中文](README.md) | **English**

  <img alt="license" src="https://img.shields.io/badge/license-MIT-263146?style=flat-square">
  <img alt="zero dependencies" src="https://img.shields.io/badge/dependencies-zero-4b6fff?style=flat-square">
  <img alt="build step" src="https://img.shields.io/badge/build%20step-none-7da1de?style=flat-square">
  <img alt="dsh kernels" src="https://img.shields.io/badge/dsh-0.1.5--0.1.7--rc.2-2f6f4f?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-beta-f0a441?style=flat-square">
  <br>
  <a href="https://trendshift.io/repositories/261203"><img alt="GITHUB TRENDING #1, Repository Of The Day" src="docs/images/trendshift-daily-laurel-gold.svg" width="250" height="55"></a>
  <a href="https://trendshift.io/weekly?language=JavaScript"><img alt="Trendshift JavaScript Weekly #1 (October 5-11, 2026; ranking in progress)" src="docs/images/trendshift-weekly-2026-10-11-first-gold.svg" width="250" height="55"></a>
  <br>
  <sub>Trendshift JavaScript Weekly #1 · October 5-11, 2026 · Ranking in progress, as of October 11, 2026</sub>

</div>

<div align="center">

> All you do is install this plugin in dsh — no login, no sign-up, no API key, no other
> step of any kind. The frontier models are simply there, DeepSeek V4.1 Flash and
> Kimi K3 among them. Completely free, with no usage cap.
>
> 你只需在 dsh 里装上这个插件，无需登录、注册、填 API Key 或任何其它操作，就能用上包括
> DeepSeek V4.1 Flash、Kimi K3 在内的前沿模型——完全免费，不限量。
>
> The roster follows upstream, availability is measured from **your own** network
> egress, the thinking-effort control sends a real budget instead of a prompt hint, and
> a local OpenAI-compatible forward port comes included.
>
> It mounts as a pure plugin: no core changes, no build step, zero dependencies.

</div>

---

## Community

<div align="center">
  <img src="docs/images/qq-group-qr.png" alt="AI technology community group QR code" width="300">
  <br>
  <b>QQ group: 386179533 (AI technology community)</b>
  <br>
  Scan to join — share how you use the plugin, report problems, swap ideas.
</div>

---
## Highlights

### Ready out of the box

- **No account, no key, no quota dashboard** — install, restart, pick a model. The upstreams are named: the free lane is OpenCode's Zen gateway (`https://opencode.ai`) and the Kilo channel is Kilo AI's public gateway (`https://kilo.ai`); both are dialled directly, **with no third party relaying your traffic** (see [Development and upstream](docs/development-and-upstream.md) and the [Disclaimer](docs/appendix.md)).

### Six lanes

| Lane | What it is |
| --- | --- |
| **Free lane** | Works out of the box, no sign-in. The roster is re-fetched on every refresh rather than frozen into the plugin. |
| **Kilo channel** | The free model pool of Kilo AI's public gateway (the listing's `isFree` slice, fetched live, including the `kilo-auto/free` auto-router) is built in — no account, no key; model cards carry a Kilo badge. ⚠️ The pool is the upstream's free offer and its cards state that prompts may be logged to improve their services — **never send sensitive content** (see the [Disclaimer](docs/appendix.md)). |
| **EAC lane** (desktop hosts) | A co-paid lane that unlocks in the DeepSeek Harness desktop app and DSHEAC AIO, with models prefixed `EAC `; the credential is sealed and guarded by a host-fingerprint gate, and **turns are checked server-side against a GitHub authorization (sign in and star the repository)**. It does not exist in the CLI or any other host. See the [usage guide](docs/usage-guide.md). |
| **Thirteen account channels** | CodeArts (Huawei Cloud), CodeBuddy / WorkBuddy (Tencent), LobsterAI (NetEase Youdao), Qoder / Qoder China (Alibaba), TRAE (ByteDance), Cline, Loomy (iFlytek), Raccoon (SenseTime), MiniMax Code, ZCode (Zhipu), Gemini (Google Code Assist) and more work out of the box; sign-in flows, account pools, daily credit claims, model blocklists and their local OpenAI gateways mount as-is. Credentials go only to the host credential store — **the browser never sees plaintext**. |
| **Aggregate lane** (your own key) | The registry ships **76 providers** (NVIDIA NIM, OpenRouter, Groq, Cerebras, SambaNova, Gemini, DeepSeek, Mistral, Together, Fireworks, SiliconFlow, Nebius, Chutes, Hugging Face, Cloudflare, Z.ai, Kimi, MiniMax, QwenCloud/Alibaba, Bedrock, Vertex, Vercel AI Gateway, Azure OpenAI, plus the no-account Ollama / LM Studio / llama.cpp). Keys stay in the local `0600` `settings.json`; the API echoes only `hasKey` and a `…abcd` fingerprint. Per provider: enable/disable, Test (a *listing* probe — it verifies a key without spending a generation), Discover, a base-URL override, a model-list override and Remove. OAuth/ADC providers are listed but marked not drivable here. |
| **Fallback chains (combo)** | Chain models from any lane into one named chain that appears as the virtual model `combo:<name>`. `fallback` always starts at the head; `round-robin` rotates the start and stays there for N turns. A link that fails **before any answer delta** is discarded whole, so **the switch is invisible to the caller**. |

### The roster reflects reality

| Behaviour | What it does |
| --- | --- |
| **A roster that tracks upstream** | Model set, context length and capabilities are re-fetched on every refresh rather than frozen into the plugin. |
| **The picker offers only what actually answers** | A model the upstream names but the gateway refuses to route (`Model is unavailable`, a 404 for that id) leaves the dropdown and stays in the settings page with its refusal recorded. Everything that is *not* a statement about the model keeps it reachable: a 5xx, a 429 quota window, a timeout, a dropped connection. Region-gated ones move to their own `region-limited` group. If a whole round refuses everything, nothing is hidden — **the picker never goes empty**. |
| **Thinking effort that actually binds** | `Light / Balanced / Deep` map to output-token budgets of **2 048 / 8 192 / capacity**, recorded per call; a model that cannot switch thinking off gets the whole ladder doubled to 4 096 / 16 384 / capacity. Implemented as a **hard output ceiling**, not a `reasoning_effort` string thrown at an endpoint that ignores it (see [Design notes](docs/design-notes.md)). |
| **The body decides what it is, not the header** | Under load this gateway answers 200 with a JSON `Content-Type` over an ordinary SSE frame stream. The plugin sniffs the first bytes and replays them into the stream — the turn keeps streaming, and a working model is never demoted to `unavailable` because one header lied. |
| **Works without a browser UI** | Only `llm` is a hard dependency, so the plugin activates on a headless composition such as `dsh-tui` and still serves its models; the dashboard half lives on its own fiber and mounts when `webServer` appears. |

### Token savers and local forwarding

| Capability | What it does |
| --- | --- |
| **Tool-output compaction (RTK)** | Rewrites `tool_result` content in place before the request is sent (git diff / status / log, grep, find, ls, tree, build logs, numbered dumps, search listings, duplicate log lines). Measured live: a 40 KB `git diff` lost **90%** of its bytes and the model still answered about it. |
| **Prompt shaping** | The `caveman` and `ponytail` families with several levels, **all off by default**; injection is idempotent and reversible. |
| **Five local answers** (no upstream request is spent on them; each has its own switch) | No upstream request is spent on them; each has its own switch. |
| **OpenAI-compatible forward port** | Expose these models to any other local tool through a base URL plus a generated key; the local gateway **speaks Anthropic natively** (`POST /v1/messages` streaming and non-streaming, `count_tokens`), and the gateway page generates copy-ready recipes for Claude Code / Codex / the OpenAI and Anthropic SDKs / curl from the port that actually bound. |
| **LAN relay** | The channel gateways bind loopback only; this plugin opens its own door — callers use a relay key the plugin issues and rotates, the relay hop swaps in the gateway credential (**which never leaves the host process**), and only `/v1/*` is allowed through, with loop protection. |

### Reliability and interface

| Capability | What it does |
| --- | --- |
| **In-app upgrades** | One click: download → SHA-256 verification → backup → atomic replace → read-back verification → hot reload, with **automatic rollback** if any step fails. |
| **Hot reload** | Upgrades and code changes take effect immediately, no app restart; also a manual button and an optional file watcher. |
| **Announcement centre with live push** | The owner edits one JSON file and pushes; every installation receives it within one poll cycle. Bodies are HTML through a strict allowlist; `urgent` items open a full-screen modal; optional OS notifications. |
| **Usage dashboard, local only** | Token heatmap, cumulative curve by total or per model, output speed and time-to-first-token sampled per call. **Nothing is uploaded.** |
| **Nine tabs** | Free models, EAC models, Free channels, Dashboard, Request log, Gateway, plus Aggregate, Token savers and Routing. Card rise, page fade and hover lifts respect `prefers-reduced-motion`. Every tab carries a Star button for the repository. |
| **Clean names in the UI** | No mojibake, no upstream vendor strings leaking into your model picker. |
| **A trust fence on the plugin's own routes** | The plugin's HTTP routes outrank the kernel's `/api`, so they carry the same trust checks as the kernel (the composition's connection service when present, a structural fence when not). |


---

## Quick start

**Prerequisite**: Node.js `^22.19.0 || >=24.0.0` (see `engines` in `package.json`).

```
dsh plugin --profile web add /absolute/path/to/dsh-our-free-model
```

Restart the app once afterwards, then open a new conversation — the model picker in the composer should show the **Our Free Model** group.

> **Desktop builds (DSHEAC AIO / DeepSeek Harness desktop) read this first**: see the [usage guide](docs/usage-guide.md). The desktop host runs a profile gate — **do not install with a `link:` dependency and do not create a junction**, or the app refuses to boot with `PROFILE_UPGRADE_REQUIRED`.

> Install-failure remedies (`ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`, `git ls-remote`, the reserved desktop profile, …) and the full guide to model selection, thinking rungs, the local forward listener, LAN access, the EAC lane and announcements all live in the [usage guide](docs/usage-guide.md).

### Documentation

| To learn about | Read |
| --- | --- |
| Install, the desktop gate, self-check, install-failure remedies | [docs/usage-guide.md](docs/usage-guide.md) |
| Model selection, thinking rungs, local forward, LAN, announcements | [docs/usage-guide.md](docs/usage-guide.md) |
| The EAC lane (desktop only) | [docs/eac-lane.md](docs/eac-lane.md) |
| Known limitations (latency, quota, trust boundary) | [docs/troubleshooting.md](docs/troubleshooting.md) |
| How it is built, trade-offs, aggregate lane / token savers / routing / gateway | [docs/design-notes.md](docs/design-notes.md) |
| Offline test suites, release signing, upstream sources, security and privacy | [docs/development-and-upstream.md](docs/development-and-upstream.md) |
| Round-by-round verification record | [docs/verification-record.md](docs/verification-record.md) |
| Disclaimer | [docs/appendix.md](docs/appendix.md) |
## Disclaimer

- **This plugin is a client, not a model provider.** Every model response is
  generated and delivered by the third-party upstreams named above (OpenCode's
  Zen gateway, Kilo AI's public gateway, and the EAC gateway you or the
  maintainer deploy); the plugin hosts, modifies and filters none of it. Models
  can produce wrong, outdated or biased content — verify before you rely on it.
- **Free does not mean unlimited, and it does not mean private.** The free
  allowances are the upstreams' unilateral offer and can be throttled, priced or
  withdrawn at any time; Kilo's free pool states that prompts may be logged and
  used to improve their services. **Never send passwords, keys, personal data,
  trade secrets, or anything you would not hand to a third party through this
  plugin's free lanes**; for production and sensitive work, use your own paid
  API.
- **You agree to the upstreams' terms by using them.** Using a channel means you
  accept that upstream's terms of service and usage policy; throttling, bans or
  other consequences of violating them are yours to own. The plugin makes no
  promise about any upstream's availability, accuracy or continuity.
- **The EAC lane is a shared, co-paid offer.** Its gateway is deployed by the
  repository maintainer and unlocked by a GitHub login plus a star; it is for
  authorized users only. Do not try to bypass the gate, resell, or share access —
  abuse tightens the lane for everyone.
- **The plugin is not affiliated with, nor endorsed by, any of the upstreams.**
  Vendor names and trademarks belong to their owners and are cited only to name
  the source.

---

## Security and privacy

- All state lives in `DSH_HOME/our-free-model/`; usage and settings stay local, nothing is uploaded.
- **The aggregate lane's keys never leave the machine.** They are written only into the plugin's own `0600` `settings.json`, requests go only to the provider you configured, and the plugin's API echoes `hasKey` plus a `…abcd` fingerprint rather than the key itself; the Test and Discover probes redact the credential out of anything a provider answers back.
- The forward listener binds a **loopback address only**, `127.0.0.1` by default, and rejects keyless requests. Widening it to a routable interface is refused: `POST /settings` answers 400 with the reason, and on a composition with no web server a hand-written `settings.json` simply does not start the listener. That traffic is spent from this machine's free lane; one string in a settings file should not put a whole subnet on it.
- **Network access is a second door, not a relaxation of the rule above.** The local listener still binds loopback only and still refuses a routable address; reaching another machine takes an explicit switch, and then **every** request must carry the network key — `/` and `/health` included, unlike the local listener, because an unauthenticated liveness answer tells the whole subnet that this machine is here and proxying. The relay carries five whitelisted paths (`/v1/models`, `/v1/chat/completions`, `/v1/responses`, `/v1/messages`, `/v1/messages/count_tokens`, each also accepted without its `/v1` prefix) and is not a general proxy for whatever else answers on loopback; it swaps the network key for the local one at the door, so the two are never interchangeable; a request that already carries the relay's hop marker is refused with `508`, so a relay port equal to the local one cannot spin. The network key is minted by `crypto`, compared with `timingSafeEqual`, stored in the same `0600` file, and rotated on its own from the panel.

- **Network access is a second door, not a relaxation of the rule above.** The local listener still binds loopback only and still refuses a routable address; reaching another machine takes an explicit switch, and then **every** request must carry the network key — `/` and `/health` included, unlike the local listener, because an unauthenticated liveness answer tells the whole subnet that this machine is here and proxying. The relay carries three whitelisted paths (`/v1/models`, `/v1/chat/completions`, `/v1/responses`) and is not a general proxy for whatever else answers on loopback; it swaps the network key for the local one at the door, so the two are never interchangeable; a request that already carries the relay's hop marker is refused with `508`, so a relay port equal to the local one cannot spin. The network key is minted by `crypto`, compared with `timingSafeEqual`, stored in the same `0600` file, and rotated on its own from the panel. **The address to dial is re-read from this machine's interfaces** — the panel polls it every 15 s while the relay is on, so a laptop that changed networks, woke from sleep or brought a VPN up is not told where it used to be. A machine commonly holds several private addresses at once (the router's `192.168.x.y`, plus whatever a virtual switch, tunnel or VPN adapter has), so the physical interface leads and is the address the panel offers to copy, with the others listed below it; the relay binds every interface, but whether a given address answers from another machine depends on the network that adapter is on.
- **The EAC lane's per-user gate lives server-side.** The plugin carries only a shared signing secret, and any install can extract it — so the one place a per-person gate can actually hold is the gateway in front of the relay credential. A chat turn needs a token minted after a GitHub sign-in verified to have starred the repository; the star is re-checked on a configurable window (12 h by default), a removed star revokes at the next sweep, tokens are revocable at any time, and per-account rate and concurrency ceilings bound a shared token. The relay key never reaches the plugin, and the token never reaches the browser — the settings page sees a login name and a verdict.
- The forward key is minted at runtime by `crypto`, compared with `timingSafeEqual`, and stored in a `0600` file. No hardcoded credential ships in this repository. `/` and `/health` answer ahead of the key check because they are liveness probes — they answer only "is it there"; the model roster requires the key.
- The plugin's HTTP routes carry a **request trust fence** (fixed in v1.1): the plugin's `/api/our-free-model` prefix outranks the kernel's `/api` in webServer's longest-prefix dispatch and used to bypass kernel auth. Every request now goes through the composition's `connection` admission first (exactly the kernel's `/api` check: cookie/token); compositions without a connection service fall back to a structural fence — loopback Host, cross-site `sec-fetch-site` refused, `Origin`/`Referer` must match the Host authority and port, and a **missing or empty Host is refused too** (fail closed; there is no fallback to the socket's local address). Measured: foreign Host/Origin 403, cookieless loopback 401. `connection` is resolved per request, because the browser half provides it only after plugins load — reading it once at apply time silently degrades the fence to its structural layer for the life of the process.
- **Announcement HTML renders through a strict client-side allowlist**: `scripts/sanitize-test.mjs` runs an XSS corpus (script injection, event handlers, `javascript:`/`data:` URLs, iframe/svg/form, style injection, mangled tags) and asserts all of it is dropped; nothing ever reaches an `innerHTML` sink. The feed URL is user-overridable, so the renderer treats feed content as untrusted.
- **The in-app upgrade integrity chain (signed as of v1.3.2)**: manifest Ed25519 signature verification (public key pinned in `src/updater.js`; unsigned or unverified manifests are refused outright, so no mirror can serve an installable forgery) → manifest validation (semver, path traversal, hash shape, `base` restricted to manifest-relative paths) → per-file SHA-256 + byte size on download → read-back verification of staging → read-back verification after install → backup restore on any failure. The manifest is re-fetched immediately before installing so a stale one can never vouch for different bytes. Boundaries in [Known limitations](#known-limitations).
- **The update channel is fully decoupled from `feedUrl`** (v1.3.2): the setting redirects the announcement feed only, never the upgrade manifest — previously one settings value could point the update channel at any server with self-consistent hashes, turning "wrote a config field" into "executed arbitrary code in the host process". The announcement override itself is now restricted to https (loopback http excepted, so a locally-hosted mirror and the test suites still work) and may not carry credentials. **The target host is not restricted**: any https address may serve as `feedUrl`, and the plugin polls it on the `feedPollMinutes` period — so in a composition without a connection service (see the auth note above), a local caller who can edit settings can point the process at any external address indefinitely. This is trusted the same way as the plugin's other outbound calls: someone who can write `settings.json` can already install code.
- **The forward listener binds loopback by resolution, not by spelling** (v1.3.2): a hostname such as `localhost` is resolved with `dns.lookup` first and every answer must be loopback; the listener binds the resolved IP — so a hosts file or enterprise DNS pointing `localhost` at a routable interface can no longer pass the check while the listener hands the lane to the subnet.
- Uninstalling removes the bundle entry; the plugin leaves no patches behind. Its data directory is plain JSON you can delete.

---

## License

MIT — see [LICENSE](LICENSE).

This project is an independent plugin and is not affiliated with, endorsed by, or
sponsored by any model provider. Using it to reach free tiers is subject to those
providers' own terms; check them before deploying anywhere beyond your own machine.

---

## Star history

The chart is updated automatically by Star History — no image is committed by hand. Display can lag because of the service cache (24 hours) and GitHub's image cache; it is not live to the second. Click the chart to open the live trend.

<a href="https://www.star-history.com/?type=date&amp;repos=Ebony-Vinyl%2Fdsh-our-free-model">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Ebony-Vinyl/dsh-our-free-model&amp;type=Date&amp;theme=dark" />
    <img alt="dsh-our-free-model GitHub star growth" src="https://api.star-history.com/svg?repos=Ebony-Vinyl/dsh-our-free-model&amp;type=Date" />
  </picture>
</a>
