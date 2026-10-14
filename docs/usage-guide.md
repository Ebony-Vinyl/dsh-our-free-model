# Usage guide

Install, the desktop gate, self-check and install-failure remedies, plus model selection, thinking rungs, the local forward listener, LAN access, the EAC lane and announcements.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

```text
PROFILE_UPGRADE_REQUIRED: offline dependency migration is not yet available
```

So on desktop builds: **do not install with a `link:` dependency and do not
create a junction.** Use the in-app plugin manager, or place a real directory.

To install manually as a real directory, in `<DSH_HOME>/profiles/<profile>/`:

1. Copy the published files into `node_modules/dsh-our-free-model/`
   (`index.js`, `client.js`, `adapter/`, `src/`, `locale/`, `icon.svg`, `cordis.patch.yml`, `package.json` — do not skip `adapter/`: `index.js` imports it on the first line)
2. Add `"dsh-our-free-model": "2.1.0"` to `dependencies` — that number **tracks the repo's `package.json` `version`** (bump it together; 2.1.0 as of this line), never copy a stale one, and a version spec, not `link:`
3. Append `"dsh-our-free-model"` to `dsh.profile.bundles`

> Do **not** also add an entry to `cordis.patch.yml`. A bundle referenced from
> `dsh.profile.bundles` already applies its own patch layer, and registering it
> twice fails with `duplicate loader entry id: our-free-model`.

#### Integration packs (managed installation)

When the plugin arrives through an integration pack (an EAC pack, Mojobox, …),
the *pack* owns update timing and bytes: install with the bundle config
`distribution: 'managed'` (or write the same field into settings.json), and the
in-app updater, the announcement feed and the hot reload all stand down — two
writers to one installed directory corrupt it; the model lane is unaffected.
Acceptance lives in `scripts/offline-test.mjs`; the catalog-ready records
(manifest 0.15 / provenance / license / integrity) are under `catalog/`.

### Verify before launching the desktop app

Run the desktop host's own gate against your profile instead of blind-retrying:

```bash
node -e "
const g = require('<APP_ROOT>/sidecar/dist/lib/profile-upgrade.js');
const app = '<APP_ROOT>', profile = '<DSH_HOME>/profiles/<profile>';
console.log(g.planProfileUpgrade(app, profile));
g.assertProfileStartup(app, profile);
console.log('startup gate: PASS');
"
```

Expect `status: 'compatible'`, an empty `mismatches` array, then `PASS`.
To check bundle composition only, without booting:

```bash
DSH_HOME=<DSH_HOME> dsh --profile <profile> --dump-config | grep our-free-model
```

You should see exactly **one** `id: our-free-model` entry.

### Install failure: `ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF`

This is a **pnpm state problem in the target profile, not the plugin repo** (it fires
before the plugin is even downloaded): the profile's existing `node_modules` was
created by an older pnpm, and after a dsh update the bundled pnpm refuses to keep
using it. Close dsh, delete the profile's `node_modules` and `pnpm-lock.yaml` to
let pnpm rebuild them, then install again:

```bash
rd /s /q "%DSH_HOME%\profiles\web\node_modules"
del "%DSH_HOME%\profiles\web\pnpm-lock.yaml"
```

The accompanying `Ignoring broken lockfile` warnings disappear with the rebuild.


---

### What you get

**Composer model picker**

| Group | Contents |
| --- | --- |
| `Our Free Model` | Models usable from your current network exit |
| `Our Free Model · region-limited` | Models the upstream refuses for this region, kept visible but separated |

A model the gateway names but refuses to route appears in neither group. It stays listed under
**Not in the picker** in the settings page, with the refusal and the probe time, and returns to
the picker by itself as soon as a probe gets through.

**Settings page — `Settings → Our Free Model`**, seven sections:

1. **Model roster** — per-model availability, vision vs text-only, context window, max output, the output ceiling each effort rung really sends, measured time-to-first-token, and an on-demand single-call benchmark.
2. **EAC lane authorization** — one-click GitHub sign-in (the browser does the work; nothing to paste), the signed-in name and star verdict, a re-check button and sign-out; model cards carry a lock until authorized. The free lane is unaffected.
2. **Announcement center** — the owner-pushed feed: unread counter, urgency badges, mark-read (single/all), check-now button, OS-notification toggle. Bodies render HTML through the allowlist.
3. **Usage board** — headline counters, a 17-week token heatmap, a cumulative curve switchable between tokens and request counts and between total and any single model, speed sparklines, and a per-model table.
4. **Local forward** — enable/disable, bind host and port, copy base URL, show / copy / rotate the API key, and a ready-to-run `curl` example.
5. **Plugin settings** — master switch, whether region-limited models are exposed, probe interval, default output ceiling, plus the detected egress IP and country.
6. **Plugin upgrade** — installed/latest version, check for updates, one-click upgrade with progress and failure reasons, last-upgrade history, hot-reload button and file-watcher switch.

**First-run announcement** — a five-page walkthrough (preamble, model roster, how to use, what it does, news & upgrades) that acknowledges once and never reappears until the copy version is bumped.


---

### Usage

**Pick a model.** Open the model selector in the composer and choose anything
under `Our Free Model`. The selection is durable per session.

**Change thinking depth.** The same menu exposes `Effort` with `Light`,
`Balanced` and `Deep`. Higher levels spend more of the output budget on
deliberation; the ceiling is enforced on the request, so the difference is
measurable rather than cosmetic. It is **one** ceiling shared by deliberation and
the visible answer, which is why a model that cannot switch thinking off gets
the whole ladder doubled (the model cards in `Settings → Our Free Model` print the
number each rung will really send). If answers keep getting cut off, move to
`Deep`, or raise the per-call output ceiling in the settings.

**Serve other local tools.** `Settings → Our Free Model → Local forward`, enable
it, then copy the base URL and generate a key. Supported routes:

```text
GET  /v1/models
POST /v1/chat/completions        streaming and non-streaming
POST /v1/responses
POST /v1/messages                streaming and non-streaming (Anthropic Messages)
POST /v1/messages/count_tokens   local estimate; the plugin ships no tokenizer
```

If another program holds the port, the listener does not die: it retries the same
port for a few rounds (a listener that just closed, or a portproxy rule that was
just removed, frees its port within a few hundred milliseconds), then walks to the
next free port and says so on the settings page — *requested 18899 is not available,
listening on 18900* — and the port written back into the settings is the real one.
On Windows the most common owner is a `netsh interface portproxy` rule (served by IP
Helper): its listener on `0.0.0.0` makes the loopback bind fail with `EACCES` rather
than `EADDRINUSE`. `netsh interface portproxy show all` lists the rules and
`netsh interface portproxy reset` clears them.

The forward endpoint streams in full: besides the `data:` frames, a lane that is
thinking gets periodic SSE comment frames (a `:` line), so a client's idle
timeout cannot read "the upstream is still thinking" as "the socket is dead".
Thinking is recognised under `reasoning`, `reasoning_content` and
`reasoning_text` — a gateway that repeats one thought under two of them is
counted once — and the `reasoning_details` array as well. A model whose thinking
never streams upstream still sends no reasoning frames here; see
[Known limitations](#known-limitations).

**Serve other devices on your network.** The same panel carries a *Network
access* section. It is off by default; switched on, the relay binds a routable
address (`0.0.0.0` by default) and demands **a key of its own** — separate from
the local key, so a leak on either side costs a rotation on that side only and
the tools already wired to the local port never notice. The relay re-issues to
the local listener, so the model roster, streaming and error semantics are the
same ones the local port serves. A port of `0` means "pick one" (18899 is often
already taken on a machine that runs something else); the panel then shows the
port and the network address it settled on. While it is on, anyone who can reach
this machine can spend its free quota with that key — enable it only on a
network you trust, and narrow the sources with a firewall if you can.

**Send requests through a proxy outlet.** `Settings → Our Free Model → Egress
proxy`. Optional and off by default — with it off, requests go direct. Two modes:

- **Subscription mode**: paste a Clash/V2Ray subscription URL; the plugin spawns
  mihomo locally (auto-detected — e.g. Clash Verge's `verge-mihomo.exe` — or set
  the path yourself) with a built-in url-test group that re-measures every five
  minutes and sends traffic to the fastest node, health-checking dead nodes out.
  **The subscription URL is treated as a credential** — the path of a
  subscription link *is* its token — so it lives at the same standard as the two
  forward keys: kept in the local settings file, never sent with a request, and
  never echoed in a settings payload. The panel shows the masked host only
  (`https://host/…`); "Show" and "Copy" fetch the value from the settings page
  itself (`GET /egress/url`), an empty input means "keep the stored address", and
  "Clear" removes it and takes the outlet down with it.
- **Single-proxy mode**: type an `http://` / `https://` / `socks5://` /
  `socks5h://` proxy address and every handled request dials through it.

**At rest.** mihomo has to read that address out of a config file (the plugin
writes a throwaway `mihomo.yaml` into its data directory and spawns mihomo from
there), so the on-disk copy stays plain text. What this treatment removes is the
payload echo, the log line and the shoulder — not another process on the same
machine.

Only three kinds of traffic are taken over: model inference, the model listing
fetch, and the egress IP probe; announcements, upgrades, and the EAC lane stay
direct so the subscription identity never mixes into the release channel.

**Scope.** The outlet serves this plugin's opencode traffic and nothing else on
this machine. The mihomo it spawns runs from a throwaway config of the plugin's
own: `bind-address: 127.0.0.1` with `allow-lan: false`, no `tun:` section, no
system proxy, no system-level proxy registration and no virtual adapter — the
listener is a temporary free loopback port. Your browser, shell tools and other
IDE extensions never go through it; only requests this plugin sends to the
opencode gateway are rerouted. Single-proxy mode works the same way: the rewrite
happens inside the plugin.

**Live status.** While the outlet is on, the settings page adds three lines below
it: the current outlet (masked host · mode), the **best node** (the node url-test
picked, with the delay that won it the rank), and **opencode access** (the last
model-listing round trip, in seconds). Node and latency are readings, refreshed
every 15 seconds by asking mihomo's own controller; when a reading is missing the
line says "measuring…" and outbound traffic is unaffected.

**What it can and cannot buy you**: per-IP rate limits and region gates move
with the outlet; per-session rate limits and fingerprint gates do not care
which outlet you use. Toggling the outlet re-probes on its own — a cold outlet
needs a few seconds before it carries traffic, and the plugin waits for the new
exit to answer before regrouping, so region-gated models follow the new exit.
Reprobe (below) does the same on demand.

**Re-check geography.** `重新探测可用性` (Reprobe) re-runs availability against
your current exit. Toggling a VPN and re-probing moves region-gated models
between the two groups on its own.

**Receive announcements.** Everything is automatic: after the owner pushes, a
running installation picks the item up within one poll cycle (30 minutes by
default, or immediately via *Check for new announcements*). Regular items raise
a toast, `urgent` items open a full-screen modal, and both land in the
announcement center with an unread marker. Enable *OS notifications* there to
also get system-level toasts.

**Upgrade the plugin.** `Settings → Our Free Model → Plugin upgrade` →
*Check for updates* → *Upgrade now*. The whole flow runs inside the app
(download → verify → backup → replace → hot reload); no reinstall, no restart.
A failed upgrade restores the previous version and reports why.

---

Back to [README](../README_EN.md)
