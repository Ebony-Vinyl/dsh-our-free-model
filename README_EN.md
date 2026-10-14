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
| Model selection, thinking rungs, local forward, LAN, EAC, announcements | [docs/usage-guide.md](docs/usage-guide.md) |
| Known limitations (latency, quota, trust boundary) | [docs/troubleshooting.md](docs/troubleshooting.md) |
| How it is built, trade-offs, aggregate lane / token savers / routing / gateway | [docs/design-notes.md](docs/design-notes.md) |
| Offline test suites, release signing, upstream sources, security and privacy | [docs/development-and-upstream.md](docs/development-and-upstream.md) |
| Round-by-round verification record | [docs/verification-record.md](docs/verification-record.md) |
| Disclaimer | [docs/appendix.md](docs/appendix.md) |
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
