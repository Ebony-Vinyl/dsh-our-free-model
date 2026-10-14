# Development and upstream

Offline test suites and the release signing flow, plus where the models come from and the security and privacy boundary.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

### Development

```bash
npm test                            # every offline suite below, plus the manifest check
node scripts/client-lint.mjs        # browser half: copy/style key coverage, bundle executes
node scripts/sanitize-test.mjs      # announcement HTML allowlist renderer vs an XSS corpus
node scripts/trust-test.mjs         # request trust fence for the plugin's routes
node scripts/feed-test.mjs          # announcement feed: parsing, failover, cache, arrivals
node scripts/updater-test.mjs       # in-app upgrade: manifests, SHA-256, backup/rollback
node scripts/build-manifest.mjs     # release: regenerate feed/manifest.json
node scripts/retry-safety-test.mjs  # failures, retry policy and usage counts are durable-log safe
node scripts/speed-stat-test.mjs    # no call can average its way into a fake tok/s
node scripts/effort-test.mjs        # a rung is the max_tokens that goes out, and is recorded as itself
node scripts/sniff-test.mjs         # a 2xx body is read by shape: SSE frames, single JSON, empty, split mid-codepoint, abort
node scripts/release-e2e.mjs        # upgrade against the real manifest, and prove a lying one is refused
node scripts/picker-test.mjs        # only usable models are advertised, and the picker never goes empty
node scripts/tui-test.mjs           # the plugin activates and serves with no web server in the composition
node scripts/host-selftest.mjs      # host half end to end against the live upstream
```

Release manifests must be signed with the release private key (`--key <pem-path>`
or the `OFM_MANIFEST_KEY` environment variable); the builder refuses to write an
unsigned one — the in-app upgrader installs only manifests whose signature
matches the public key pinned in the plugin, as of v1.3.2. The private key lives
in neither the repository nor any artifact; rotating it means rotating the trust
root: change the pinned key in `src/updater.js` and cut a full release.

`scripts/probes/` holds the one-off evidence scripts behind the findings report —
capability matrix, region gate, the `reasoning_effort` no-op sampling, budget
dialects, dangling tool calls, tool-name charset rules, raw read timestamps
(`batch-delivery`), per-frame arrival against final usage (`decode-window`),
and whether a long answer survives its ceiling (`long-answer`). Six of them
exercise this plugin's own code and run from the repo root
(`node scripts/probes/pairing-repair.mjs`); the rest reach the upstream through a
third-party SSE client and assume that checkout's module paths, so they are
recorded as evidence rather than offered as a test suite. None of them is wired
into `npm test`, which runs the offline checks above — no network, no free-lane
quota spent.

Requires Node `^22.19.0 || >=24.0.0`. No install step, no dependencies.


---

### Where the models come from

Two public keyless upstreams, both dialled directly with no third party in the
middle; the fourth destination (the EAC lane) is your own or the maintainer's
deployed gateway, covered in its own section.

**The free lane: OpenCode's Zen gateway**, `https://opencode.ai/zen/v1/*`.
Every fact lives in `src/upstream.js`, and each one was checked by direct
request against the live gateway on 2026-09-24:

| What | Where | Credentials sent |
| --- | --- | --- |
| Inference | `POST …/zen/v1/chat/completions`, `…/zen/v1/responses`, `…/zen/v1/messages` (per model, see `endpointFor`) | `Authorization: Bearer public` — this lane is a public, key-free allowance; the plugin holds no secret of yours |
| Model list | `GET …/zen/v1/models` | same |
| Announcements and the update manifest | this repository's `feed/*.json`: `raw.githubusercontent.com` first, `cdn.jsdelivr.net` as fallback | none |
| Egress region check | `api.ipify.org` / `ipinfo.io` / `ipapi.co`, only to read back your own public IP and country code | none |

**The Kilo channel: Kilo AI's public gateway**, `https://api.kilo.ai/api/gateway`
(added 2026-10-06). The code is `src/kilo.js`; each row was checked by direct
request on the day it was wired in:

| What | Where | Credentials sent |
| --- | --- | --- |
| Inference | `POST …/api/gateway/chat/completions` (OpenAI Chat Completions compatible, SSE streaming) | **none** — the gateway's free pool (the listing's `isFree: true` models, including the `kilo-auto/free` auto-router) needs no account, key or login state |
| Model list | `GET …/api/gateway/models` | none |

On privacy and trust, plainly:

- **No account pool, no relay, no reseller.** The tables above are the complete
  set of destinations the plugin can contact. `npm test` touches no network at
  all — the shared test scaffolding points both keyless upstreams at closed
  loopback ports by default, so no suite can "incidentally" reach a real gateway —
  and the only things that do are `scripts/host-selftest.mjs` and
  `scripts/probes/`, which you run by hand. If another source is ever added, this
  section is updated before the feature is.
- **Your prompts, tool results and any attached images go to the upstream that
  serves the model you picked, as an ordinary inference request** — the same as
  calling any model API. Nothing else leaves the machine: the usage dashboard's
  data, settings and the forwarding key all stay in `DSH_HOME/our-free-model/`.
- **Key-free is not unmanaged.** The free lane fingerprints clients through
  `x-opencode-*` headers, accounts free usage per session, answers 403 for a
  disallowed region and 429 once the allowance is spent. **Kilo's free pool
  states on its model cards that prompts may be logged by the upstream provider
  and used to improve their services** (verbatim from the `kilo-auto/free` card:
  "Prompts may be logged by the upstream provider and used to improve their
  services. Not suitable for production or sensitive data workloads."). The model
  set and the quota policy belong to the upstream and can change at any time; all
  the plugin can do is withdraw an unavailable model from the picker and say why.
- This section is repository documentation. Inside the app — picker, settings
  page, error copy — the upstreams' names still do not appear (the convention is
  recorded under [Verification](#verification)), except that the Kilo badge's
  tooltip does say prompts may be logged — that is information you need while
  choosing a model.



---

### Security and privacy

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

Back to [README](../README_EN.md)
