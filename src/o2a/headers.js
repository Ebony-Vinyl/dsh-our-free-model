/** Construct transport metadata without retaining request-specific state. */
import { createHash, randomBytes } from 'node:crypto'
import { ANONYMOUS_CREDENTIAL, CLIENT_UA } from './version.js'

export function projectID(project) {
  if (project === 'global' || /^[0-9a-f]{40}$/.test(String(project))) return project
  return createHash('sha256').update(`opencode-project\0${project}`).digest('hex').slice(0, 40)
}

export function stableProjectID(session) {
  return projectID(String(session ?? ''))
}

export function traceHeaders() {
  const entropy = randomBytes(32).toString('hex')
  const trace = entropy.slice(0, 32), span = entropy.slice(32, 48), parent = entropy.slice(48)
  return { traceparent: `00-${trace}-${span}-01`, b3: `${trace}-${span}-1-${parent}` }
}

export function gatewayHeaders({ session, childSession, project, accept, anthropic, userAgent } = {}) {
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${ANONYMOUS_CREDENTIAL}`,
    'user-agent': userAgent ?? CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session-id': childSession ?? session,
    'x-opencode-project': project === null || project === undefined ? stableProjectID(session) : projectID(project),
    ...traceHeaders(),
  }
  for (const key of ['x-session-affinity', 'x-session-id', 'x-opencode-session']) headers[key] = session
  if (accept !== null) headers.accept = accept ?? '*/*'
  if (anthropic) headers['anthropic-beta'] = 'interleaved-thinking-2025-05-14'
  return headers
}
