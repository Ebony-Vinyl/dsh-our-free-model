/**
 * Port of opencode2api `gateway.setV2Headers` — the OpenCode 2.x CLI header set
 * the v2 gates fingerprint.
 *
 * Upstream facts (each one is a refusal on its own, see the reference):
 * - `x-opencode-session` (conversation affinity), `x-session-affinity` and
 *   `X-Session-Id` carry the canonical session; `x-opencode-session-id` carries
 *   the client's child session when one exists (a subagent keeps its child id
 *   while affinity stays on the parent) and the session itself otherwise.
 * - `x-opencode-project` is a bare 40-character hex id. A canonical `prj_*`
 *   style project is rejected, so any caller project that is not the literal
 *   `global` or a 40-hex git commit is hashed into the shape (`projectID`).
 *   `projectID` is stable: one project maps to one upstream id, masking the
 *   caller's spelling.
 * - `x-opencode-request` is the v1 lane's header; the v2 gate rejects it, so
 *   it is never sent.
 * - Anthropic requests on the v2 lane carry the `anthropic-beta` header and a
 *   `beta=true` query on the endpoint (`upstreamRequest.withAnthropicBeta`).
 *
 * The plugin adds the lane's own transport fields around the port: the pooled
 * keyless credential `Authorization: Bearer public` (`upstreamRequest`), the
 * JSON content type, the W3C trace pair the official 2.2.3 client emits
 * (`traceHeaders`), and the `accept` value the caller's streaming needs.
 *
 * @module src/o2a/headers.js
 */

import crypto from 'node:crypto'
import { ANONYMOUS_CREDENTIAL, CLIENT_UA } from './version.js'

/** The 40-hex shape of a git root commit, which `projectID` keeps verbatim. */
const GIT_COMMIT_RE = /^[0-9a-f]{40}$/

/**
 * Render one project signal into the upstream project id (`gateway.projectID`):
 * a genuine git commit hash or `global` is kept verbatim, any other project is
 * hashed into the same 40-character lowercase hex shape. The value itself is
 * not checked upstream, only its shape.
 */
export function projectID(project) {
  if (project === 'global' || GIT_COMMIT_RE.test(String(project))) return project
  const sum = crypto.createHash('sha256').update(`opencode-project\0${project}`).digest()
  return sum.subarray(0, 20).toString('hex')
}

/**
 * The stable project id for one conversation (`stableProjectID`).
 *
 * The reference mints a fresh project per request — a quota spread that makes
 * sense behind its rotating proxy pool, and the opposite of what a single-IP
 * client wants: every retry, continuation and catalog refresh then lands in a
 * fresh bucket, so one conversation's usage is scattered across identities the
 * upstream cannot correlate (our PR #757). Deriving the project from the
 * session id instead keeps one conversation on one bucket — the shape stays
 * the 40-hex id the gate checks, the value stays stable for the conversation's
 * life, and a caller-named project still wins (passed through `projectID`).
 *
 * @param {string} session - the canonical conversation-affinity session
 * @returns {string} a 40-character lowercase hex project id
 */
export function stableProjectID(session) {
  return projectID(String(session ?? ''))
}

/**
 * One W3C Trace Context pair for one request (`traceHeaders`).
 *
 * The official 2.2.3 client carries `traceparent` and `b3` on every inference
 * request (captured live, issue #708's HTTP-Toolkit trace) — the distributed
 * trace propagation every OTel-instrumented client emits. The trace was named
 * in #708 as the header most likely to distinguish a genuine client; whatever
 * the gate does with it, a third-party client that omits both looks less like
 * the real thing, so the lane sends a well-formed pair: one trace id, one span
 * id, both sampled, the `b3` single-header form carrying the same ids plus the
 * parent span the zipkin shape expects.
 *
 * Fresh ids per request on purpose: a span is one request's work, and reusing
 * a trace across requests is the fingerprint of a broken instrumented client.
 *
 * @returns {{ 'traceparent': string, 'b3': string }}
 */
export function traceHeaders() {
  const traceId = crypto.randomBytes(16).toString('hex')
  const spanId = crypto.randomBytes(8).toString('hex')
  const parentId = crypto.randomBytes(8).toString('hex')
  return {
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${parentId}`,
  }
}

/**
 * The v2 header set for one request (`setV2Headers`).
 *
 * Aligned with the official 2.2.3 client's outbound bytes (issue #708's
 * HTTP-Toolkit trace, 2026-10-30): the trace pair rides every request, and the
 * client's fetch stack emits an `accept: asterisk-slash-asterisk` wildcard —
 * the earlier reference capture that omitted `accept` described the
 * *reference's* Go client, not the official one.
 *
 * @param {object} options
 * @param {string} options.session - the canonical conversation-affinity session
 * @param {string} [options.childSession] - the client's own child session for
 *   `x-opencode-session-id`; defaults to `session`
 * @param {string} [options.project] - caller project signal; defaults to a
 *   stable id derived from the session ({@link stableProjectID}), so one
 *   conversation's retries/continuations/refreshes share one quota bucket
 *   instead of scattering across per-request identities
 * @param {boolean} [options.stream] - unused for the header set (the accept
 *   value no longer depends on it); kept for signature compatibility
 * @param {string} [options.accept] - explicit `accept` override; the wildcard
 *   the wildcard by default (the official client's fetch default), `null` to
 *   omit the header entirely
 * @param {boolean} [options.anthropic] - add the Messages-lane beta header
 * @param {string} [options.userAgent] - UA override; the lane pins
 *   {@link CLIENT_UA} (the attribution hook in src/http.js resolves to it)
 * @returns {Record<string, string>}
 */
export function gatewayHeaders({ session, childSession, project, stream, accept, anthropic, userAgent } = {}) {
  const headers = {
    'content-type': 'application/json',
    'authorization': `Bearer ${ANONYMOUS_CREDENTIAL}`,
    'user-agent': userAgent ?? CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-session': session,
    'x-opencode-session-id': childSession ?? session,
    'x-opencode-project': projectID(project ?? stableProjectID(session)),
    ...traceHeaders(),
  }
  if (accept !== null) headers['accept'] = accept ?? '*/*'
  if (anthropic) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  return headers
}
