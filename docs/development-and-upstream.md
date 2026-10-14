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

Back to [README](../README_EN.md)
