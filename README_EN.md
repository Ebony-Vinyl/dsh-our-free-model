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

- **Nothing to configure** — install, restart, pick a model. No account, no key, no quota dashboard to register on.
- **The upstreams are named** — the free lane is OpenCode's Zen gateway at `https://opencode.ai`, and the Kilo channel is Kilo AI's public gateway at `https://kilo.ai`; both are dialled directly, with no third party relaying your traffic. Who serves your requests, and where your data goes, is spelled out in [Where the models come from](#where-the-models-come-from) and the [Disclaimer](#disclaimer).
- **A roster that tracks upstream** — model set, context length and capabilities are re-fetched on every refresh rather than frozen into the plugin.
- **The picker offers only what actually answers** — a model the upstream listing names but the gateway refuses to route outright (`Model is unavailable`, a 404 for that id) leaves the dropdown and stays visible in the settings page with its refusal recorded. Everything that is *not* a statement about the model keeps its model reachable: a 5xx from the gateway, a 429 quota window, a timeout or a dropped connection. Region-gated ones move to their own `region-limited` group. If a whole round refuses everything, nothing is hidden: the picker never goes empty.
- **Announcement center with live push** — the repository owner edits one JSON file and pushes; every installation receives it within one poll cycle. Bodies are HTML rendered through a strict allowlist; `urgent` items open a full-screen modal; optional OS-level notifications.
- **In-app upgrades** — one click in the settings page: download → SHA-256 verification → backup → atomic replace → read-back verification → hot reload, with automatic rollback if any step fails.
- **Hot reload** — upgrades and code changes take effect immediately, no app restart; also available as a manual button and an optional file watcher.
- **Region-aware, per egress** — models gated by geography are separated into their own `region-limited` group instead of failing mid-turn. Switch your network exit and the next probe reclassifies them automatically.
- **The body decides what it is, not the header** — under load this gateway answers 200 with a JSON `Content-Type` over a perfectly ordinary SSE frame stream. The plugin sniffs the first bytes and replays them into the stream, so the turn keeps streaming instead of being thrown away — and a working model is never demoted to `unavailable` because one header lied.
- **Thinking effort that actually binds** — `Light / Balanced / Deep` map to output-token budgets of 2 048 / 8 192 / the model's full capacity, and are recorded per call. A model that cannot switch thinking off (MiMo V2.6 among them) gets the whole ladder doubled to 4 096 / 16 384 / capacity, because there thinking and the visible answer compete for the one ceiling; every model card in the settings page prints the number it will actually send. This is not a `reasoning_effort` string thrown at an endpoint that ignores it (see [Why a budget](#why-a-budget-and-not-reasoning_effort)).
- **Works without a browser UI** — only `llm` is a hard dependency, so the plugin activates on a headless composition such as dsh-tui and still serves its models. The dashboard half lives on its own fiber and mounts itself when `webServer` appears, so a composition that loads plugins before its HTTP server exists still gets its settings page. Availability probing and the background loops run on plain timers.
- **Usage dashboard, local only** — token heatmap, cumulative curve by total or per model, output speed and time-to-first-token sampled per call. Nothing is uploaded.
- **OpenAI-compatible forward port** — expose these models to any other local tool through a base URL plus a generated API key.
- **EAC lane (desktop hosts)** — a co-paid lane that unlocks in the DeepSeek Harness desktop app and DSHEAC AIO, with models prefixed `EAC`; its credential is sealed and guarded by a host-fingerprint gate, and turns are checked server-side against a GitHub authorization (sign in and star the repository). It does not exist in the CLI or any other host.
- **The Kilo channel (keyless free pool)** — the free model pool of Kilo AI's public gateway (the listing's `isFree` slice, fetched live, including the `kilo-auto/free` auto-router) is built in; no account, no key. Model cards carry a Kilo badge. Thinking effort works like the EAC lane: the model's own level menu (Off / Low / Medium / High, default High), sent for real through the gateway's unified `reasoning` parameter — Off was verified family by family to zero out thinking (nemotron, ling, dots, poolside, apodex, cohere); the stepfun and liquid endpoints refuse to disable thinking (HTTP 400) and the two auto-routers ignore it, so those models' menus omit the Off rung. The pool is the upstream's free offer, and its model cards state that prompts may be logged to improve their services — never send sensitive content; see the [Disclaimer](#disclaimer).
- **The aggregate lane — your own key, 76 providers** — a new settings tab brings third-party endpoints into the same roster: the registry ships 76 providers (NVIDIA NIM, OpenRouter, Groq, Cerebras, SambaNova, Gemini, DeepSeek, Mistral, Together, Fireworks, SiliconFlow, Nebius, Chutes, Hugging Face, Cloudflare, Z.ai, Kimi, MiniMax, QwenCloud/Alibaba, Bedrock, Vertex, Vercel AI Gateway, Azure OpenAI, plus the no-account Ollama, LM Studio and llama.cpp). Configuring a provider (a key for the ones that need one; the local no-account ones need none) turns each of its models into a `provider/model` row in the picker and on the local gateway. Keys stay in the local `0600` settings.json; the API echoes only `hasKey` and a `…abcd` fingerprint. Per provider: enable/disable, Test (a *listing* probe — it verifies a key without spending a generation), Discover, a base-URL override, a model-list override and Remove. OAuth/ADC providers are listed but marked not drivable here.
- **Token savers** — three things: tool-output compaction (RTK) rewrites `tool_result` content in place before the request is sent (git diff / status / log, grep, find, ls, tree, build logs, numbered file dumps, search listings, duplicate log lines) — measured live, a 40 KB `git diff` lost 90% of its bytes and the model still answered about it; prompt shaping offers the caveman and ponytail families, every level off by default; and five local answers that never call a provider. The settings page reports bytes before/after, percent saved, blocks compacted and calls measured, from the same stats rows the usage charts read.
- **Routing (fallback chains)** — chain models from any lane into one named chain that appears in the picker and on the gateway as the virtual model `combo:<name>`. `fallback` always starts at the head; `round-robin` rotates the starting point and stays there for N turns. A link that fails *before any answer delta* is discarded whole, so the switch is invisible to the caller — and reasoning deltas deliberately do not count as content, so "thought for a minute, then hit a quota wall" is the case failover exists for.
- **The local gateway speaks Anthropic natively** — new `POST /v1/messages` (streaming and non-streaming, with `thinking`/`tool_use` blocks, a real `stop_reason` and an in-stream `error` event when a turn fails after the headers went out) and `POST /v1/messages/count_tokens` (a local estimate — the plugin ships no tokenizer); `/v1/models` now advertises every lane, the aggregate rows and the chains included. The gateway page's new *Connect a client* section generates copy-ready recipes — Claude Code, Codex `config.toml`, the OpenAI and Anthropic SDKs, curl, and a LAN variant when the relay is up — from the port that actually bound and the key that is actually required.
- **Nine tabs beside the old six** — Aggregate, Token savers and Routing join Free models, EAC models, Free channels, Dashboard, Request log and Gateway; the motion pass (card rise on mount, page fade on tab switch, an animated savings meter, hover lifts) respects `prefers-reduced-motion` and collapses to one column at panel width.
- **Clean names in the UI** — no mojibake, no upstream vendor strings leaking into your model picker.


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
| Model selection, thinking rungs, local forward, LAN, EAC, announcements | [docs/usage-guide.md](docs/usage-guide.md) |
| Known limitations (latency, quota, trust boundary) | [docs/troubleshooting.md](docs/troubleshooting.md) |
| How it is built, trade-offs, aggregate lane / token savers / routing / gateway | [docs/design-notes.md](docs/design-notes.md) |
| Offline test suites, release signing, upstream sources, security and privacy | [docs/development-and-upstream.md](docs/development-and-upstream.md) |
| Round-by-round verification record | [docs/verification-record.md](docs/verification-record.md) |
| Disclaimer, star history | [docs/appendix.md](docs/appendix.md) |
## License

MIT — see [LICENSE](LICENSE).

This project is an independent plugin and is not affiliated with, endorsed by, or
sponsored by any model provider. Using it to reach free tiers is subject to those
providers' own terms; check them before deploying anywhere beyond your own machine.
