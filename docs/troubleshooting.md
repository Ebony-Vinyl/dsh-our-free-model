# Known limitations

Completion, latency, quota and trust-boundary facts.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

### Known limitations

- **"No usage cap" means no cap to buy.** There is no balance, no plan and no per-token billing; the lane is metered by session rate, though, and hammering it surfaces as `429`. The plugin marks the model *quota reached* rather than hiding it, and the next probe clears the state.
- **Some upstream models are slow.** `nemotron-3.5-lightning-free` measured over 30 s to first token in one run. That is upstream latency, and the dashboard reports it rather than hiding it.
- **Output speed is sometimes `—`.** A model that answers in one or two large frames, or whose thinking never streams, has no window worth dividing. The panel says so instead of publishing the model's thinking time as decoding speed.
- **Thinking is a silent wait, and it shares the output budget.** `mimo-v2.6-flash-free` measured 60–70 s of silence while the lane billed 3024 reasoning tokens and streamed not one reasoning frame; such a turn ends as `stop` with nothing visible, which clients report as an empty response. The forward endpoint and the LAN relay keep the connection alive with heartbeats — but that protects the connection, not the timeout: the SSE parser skips comment frames, and pi-ai's idle watchdog (`streamIdleTimeoutMs`, default 300 s) resets only when real content frames arrive, so a stall past 300 s on the wire still fails (issue #34). Only the caller can give it **budget**: raise the per-call output ceiling past 16k, or use a model the catalogue marks `reasoning: false`.
- **Automatic recovery has request, time and context limits.** It handles only reasoning-only EOF and reasoning-only silent stops (a normal `stop` ending with no answer text) and adds at most one request. Answer text, tool calls, cancellation and explicit errors exclude recovery. A checkpoint request cannot preserve internal upstream state that was never sent, and success is not guaranteed. Usage with a missing report is only the known part.
- **Capabilities are what probes can confirm.** Anything the public listing and a live probe do not evidence is left unlabelled.
- **Source is plain JavaScript.** It has to be, to load as a local plugin. Anyone with the folder can read the gateway logic; treat that as an accepted property of this distribution form, not as something obfuscation would fix.
- **Desktop installs need a real directory**, for the reason given in [Install](#install).
- **Upgrade and hot-reload trust boundary**: as of v1.3.2 the in-app upgrader's trust root is the Ed25519 public key pinned inside the plugin, not "HTTPS to the repository" — a manifest must carry the release key's signature before anything is installed, so a poisoned mirror (jsDelivr included) fails the upgrade instead of executing code. Whoever holds the **release private key** can push arbitrary code, the same trust model as whoever can push the repository, but a repository account takeover is now a failed-upgrade outage for every user rather than a direct RCE. File integrity is enforced by signature + SHA-256 manifest; content safety by the client-side allowlist renderer and the host's plugin isolation.
- **The AIO build's WebView2 permission policy may deny notification permission** (measured `denied` on this machine). The announcement center says so plainly; plain-browser access to dsh web is unaffected.
- **The forward port is not required to be 18899.** When the port is taken the listener moves to the next free one and writes that port back into the settings (the settings page carries the note). That is deliberate: a port change beats a forward listener that silently stays down. Which process holds the port is the operating system's answer to give; the plugin only reports what it said.
- **The plugin routes' auth depends on the composition**: with a connection service mounted (dsh web, the AIO desktop) it matches the kernel's `/api` (the app's own cookie/token); in minimal compositions without one, a structural fence applies (loopback + same-origin), and other local processes can still reach the routes — the same behaviour the kernel has in those compositions. **This covers `/forward/key` and `/forward/lan/key` too**: in such a composition any local process can fetch both keys with one request and spend the machine's free quota from another machine. Treat the two keys as local-process-readable files there (same trust level as `settings.json`), or mount a connection service at deploy time when you need more isolation.


---

Back to [README](../README_EN.md)
