/**
 * Which upstream reference this directory ports, in one place.
 *
 * Every file in `src/o2a/` is a JavaScript port of the matching Go file of the
 * opencode2api gateway (see SYNC.md for the file-by-file map). When the
 * upstream project releases a new version, bump the three constants below
 * together with the diff you port, so a stale port can never hide behind a
 * current assets file. The embedded assets in `assets/` are copied verbatim
 * from the upstream `internal/gateway` embeds and must never be edited here.
 *
 * @module src/o2a/version.js
 */

/** The opencode2api release this port mirrors. */
export const O2A_VERSION = '1.4.7'

/** The exact upstream commit the port was checked against. */
export const O2A_COMMIT = 'b296a61d0e3ef93b4df58e298be2c4e34e397322'

/** Where the reference lives. */
export const O2A_REFERENCE = 'https://github.com/jasonxu114514/opencode2api'

/**
 * The OpenCode 2.x CLI version the reference impersonates (`httpx.v2ClientVersion`).
 * The v2 gate fingerprints `opencode/latest/<version>/cli`; the upstream project
 * keeps this current with the official client.
 *
 * 2.2.3 was captured live from the official client on 2026-10-30 (issue #708's
 * HTTP-Toolkit trace): the 2.1.1 spelling this port pinned before then is an
 * older client than the one the gate now sees most often, and the same trace
 * shows the client carrying `traceparent`/`b3` — see `headers.js`.
 */
export const V2_CLIENT_VERSION = '2.2.3'

/** The v2 User-Agent (`httpx.V2UserAgent`). Must be sent alone, unmodified. */
export const CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`

/**
 * The `max_completion_tokens` a 2.x client puts on every chat body
 * (`gateway.v2CompletionLimit`), added when the caller named no ceiling.
 */
export const V2_COMPLETION_LIMIT = 32000

/** The keyless anonymous credential (`gateway.upstreamRequest`): literal "public". */
export const ANONYMOUS_CREDENTIAL = 'public'
