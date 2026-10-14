# The EAC lane

The desktop-only co-pay lane: how it is unlocked, how its credentials are sealed, and the signed gateway.

> 本文件内容取自原 README，正文与原句一致；仅调整标题层级与相对路径。

---

### The EAC lane (desktop only)

Besides the free lane, the plugin carries a co-pay lane (EAC). It exists only in two desktop hosts:

DSHEAC AIO (Tauri shell): unlocked only when three signals line up — the kernel path, the embedded node, and the `web-desktop` profile;

The DeepSeek Harness desktop app (Electron shell): the `desktop` profile context the kernel itself provides (the CLI refuses that profile by design) plus the runtime marker the desktop shell sets for the kernel process.

In a terminal, in plain `dsh web`, and in any other way of running it, the lane simply does not exist: no models, no requests, no errors, and no decryption is ever attempted.

Display rule: a model shows only its own name with a lane prefix, such as EAC DeepSeek V4.1 Flash or EAC Kimi K3; the model cards in Settings carry a separate EAC lane badge.

Sealed at rest: the lane's credentials and endpoint never appear in readable form anywhere in the plugin — they exist only as AES-256-GCM ciphertext, and the decryption key is derived on the spot at unlock time from three mask fragments spread across two files. An unauthorised host never enters the derivation path, and to a search engine or a string scan the ciphertext is just noise.

Credentials never touch disk and never leave the process: unlocking happens per request, and plaintext exists only inside the single frame that builds the request — never written to a file, never in a log, never in an API response or an error message.

Signed gateway (the recommended shape): the `worker/` directory ships a Cloudflare Worker gateway. The plugin seals only the gateway address and an HMAC signing key; requests are signed as timestamp + HMAC-SHA256(method / path / body digest), and the real upstream key lives only in the Worker's environment variables. The replay window, the model allowlist and optional per-IP rate limiting all run at the gateway, so leaking the signing key only means rotating it there to revoke everyone. Deployment and rotation are covered in `worker/README.md`.

**The GitHub authorisation gate**: a self-hosted gateway (the BaoTa Node shape) adds a per-person gate — a conversation request needs not only the signature but a **personal token**, and that token is issued only to an account that "signed in with GitHub **and** starred this repository". The whole login happens in the browser: one click on "EAC lane authorisation" in Settings, the gateway callback page confirms the star, the token is issued and the plugin collects it automatically — no copy-paste. Without a star the page offers a ⭐ button and "I have starred, check again", so you never have to log in twice. The gateway re-checks the star every 12 hours using the saved authorisation, and unstarring revokes the token within that window; if GitHub is unreachable the existing verdict is kept, so authorised users are never punished by an outage. The gateway asks only for the minimal `read:user` scope, and the authorisation is used for the star re-check alone. The free lane (opencode) does not go through the gateway at all and is entirely unaffected.

---

---

Back to [README](../README_EN.md)
