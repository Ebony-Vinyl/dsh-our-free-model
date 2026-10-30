# OC free inference transport (local fork)

## Scope

Only `https://opencode.ai:443/inference/*` uses the Bun worker. Other providers, catalog URLs and local test servers keep the prior transport. This is direct upstream access, not a bridge through OpenCode. A running OpenCode installation is not required.

The free-lane payload includes a short environment block containing the actual process working directory and platform, unless the caller already supplies an `<env>...</env>` system block. Caller instructions and array-valued system blocks are preserved. The existing canonical session ID and tool alias/placeholder handling are retained. No copied OC persona, skills catalog, user conversation or tracing headers are added.

## Stable session IDs

The old `canonicalizeSession(seed)` hash produced a plausible shape but not a real creation timestamp. An identical gateway request failed with both its old ID and a fresh hash-derived ID, then succeeded twice using the same real-timestamp ID (2026-10-28). `sessionForConversation()` now mints once with `mintSessionId()` and persists it. Existing IDs exactly matching the legacy hash mapping are migrated once on use; other canonical remembered/caller IDs stay unchanged. No error or retry rotates the session. Map version2 remains compatible with the prior `sessions` object shape.

## Runtime prerequisite

Install Bun independently or point `OUR_FREE_MODEL_BUN` at a native Bun executable. Nothing is downloaded by this plugin. Discovery checks the explicit path, `BUN_INSTALL/bin`, `~/.bun/bin`, PATH, and the Windows npm Bun executable directory. Windows `.cmd` and `.ps1` shell shims are not executed as subprocess binaries.

`OUR_FREE_MODEL_FREE_TRANSPORT` accepts:

- `auto` (default) / `bun`: use the native Bun worker for official OC inference. If Bun is absent, report a transport configuration error.
- `node`: restore the previous Node transport for diagnosis/rollback. This does not guarantee upstream acceptance.

## Streaming, proxy and cleanup

Node sends request metadata and body to a bounded-lifetime Bun child over stdin; stdout carries one response metadata line followed by streamed response bytes. Credentials and request bodies are not placed in command-line arguments or error messages. No implicit retry is performed.

Without a configured OFM outlet, Bun uses its normal proxy environment. With an OFM outlet, an authenticated loopback CONNECT tunnel carries Bun's TLS unchanged through the existing HTTP/HTTPS/SOCKS5 or managed-mihomo outlet. The tunnel only admits `opencode.ai:443` and requires the per-start relay secret. The secret is not sent upstream.

Abort before headers, abort during response reading, consumer cancellation and abnormal worker exit terminate the child and settle the response appropriately. Automatic decompression removes stale encoding/length headers.

## Verification

Offline checks:

```powershell
node scripts/bun-fetch-test.mjs
node scripts/free-lane-compat-test.mjs
node scripts/test-all.mjs --mode contributor
```

The offline suite runner pins the legacy Node path for its mocked network fixtures. The Bun helper has separate actual loopback streaming/cancellation tests.

Explicit live checks (spend quota):

```powershell
node scripts/oc-free-live-test.mjs --live
node scripts/oc-free-live-test.mjs --live --proxy http://127.0.0.1:7897
```

2026-10-28: integrated source path returned HTTP200, `PONG`, `billing_source: free`. A later configured-outlet attempt returned429, followed by429 on the default path too; this is not sufficient to blame the proxy. Live acceptance is time-dependent and must be checked separately from offline protocol correctness. After adding the persistent real-timestamp session mapping, the installed DSH gateway was verified on 2026-10-29 07:05:49 UTC+8: `our-free-model/nemotron-3.5-lightning-free`, HTTP200, `PONG`, 1.723s. A gateway SSE request immediately after that returned upstream429. After the user reported the free-lane quota refreshed, both were re-verified on 2026-10-29 08:22 UTC+8: nonstream HTTP200 `PONG` in 1.721s, and streaming HTTP200 with `PONG`, `[DONE]`, `finish_reason: stop`, 37 chunks, first byte 1587ms, 2528ms total. The earlier stream 429 therefore reflected the quota window, not a streaming defect. Runtime/artifact hashes matched, the existing image-gateway bundle was unchanged, and no Bun workers remained.

The first contributor run passed95/98 suites. Two changes needed in this patch were corrected (environment expectation in fingerprint tests and new worker files in standalone packaging) and those suites passed individually. The remaining `magpie-policy` market-filter assertion is unresolved and is not a success claim for the full suite.
