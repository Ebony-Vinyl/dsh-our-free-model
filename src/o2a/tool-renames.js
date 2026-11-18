/** Request-scoped reversible tool names, with ambiguity-aware client lookup. */
import { createHash } from 'node:crypto'

export const CLIENT_TOOL_PREFIX = 'clint_'
export const CLIENT_TOOL_DIGEST_LENGTH = 12
export const TOOL_WIRE_NAME_LIMIT = 64

export function foldToolName(name) {
  return String(name ?? '').toLowerCase().replace(/[_.\- \t\r\n]/g, '')
}

export function clientToolWireName(name, used) {
  const taken = used instanceof Set ? used : new Set()
  const base = CLIENT_TOOL_PREFIX + createHash('sha256').update(String(name)).digest('hex').slice(0, CLIENT_TOOL_DIGEST_LENGTH)
  let candidate = base
  for (let number = 2; taken.has(candidate); number++) {
    const suffix = `_${number}`
    candidate = base.slice(0, TOOL_WIRE_NAME_LIMIT - suffix.length) + suffix
  }
  taken.add(candidate)
  return candidate
}

// Existing protocol spellings are retained as data, not executable definitions.
export const OFFICIAL_TOOL_ALIASES = Object.freeze({
  edit: ['edit'], glob: ['glob'], grep: ['grep'],
  question: ['question', 'askuserquestion'], read: ['read', 'view'],
  shell: ['shell', 'bash'], skill: ['skill'],
  subagent: ['subagent', 'agent', 'task'], webfetch: ['webfetch', 'fetch'],
  websearch: ['websearch'], write: ['write'], patch: ['patch', 'applypatch'],
})
const aliases = new Map(Object.entries(OFFICIAL_TOOL_ALIASES)
  .flatMap(([target, spellings]) => spellings.map(spelling => [foldToolName(spelling), target])))

export function officialForClientName(name) {
  return typeof name === 'string' && name !== '' ? aliases.get(foldToolName(name)) ?? null : null
}

export class ToolRenameMap extends Map {
  #clients = new Map()
  #case = new Map()
  #shape = new Map()

  add(client, wire) {
    if (!client || !wire || client === wire || this.#clients.has(client) || this.has(wire)) return
    this.set(wire, client)
    this.#clients.set(client, wire)
    for (const [index, key] of [[this.#case, String(client).toLowerCase()], [this.#shape, foldToolName(client)]]) {
      if (!key) continue
      index.set(key, index.has(key) && index.get(key) !== client ? '' : client)
    }
  }

  wireOf(client) {
    return this.#clients.get(client)
  }

  hasPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) if (wire.startsWith(prefix)) return true
    return false
  }

  hasLongerPrefix(prefix) {
    if (!prefix) return false
    for (const wire of this.keys()) if (wire.length > prefix.length && wire.startsWith(prefix)) return true
    return false
  }

  resolve(wire) {
    if (!wire) return wire
    if (this.has(wire)) return this.get(wire)
    const client = wire.startsWith(CLIENT_TOOL_PREFIX) && wire.length > CLIENT_TOOL_PREFIX.length
      ? wire.slice(CLIENT_TOOL_PREFIX.length) : wire
    if (this.#clients.has(client)) return client
    const lower = client.toLowerCase()
    if (this.#case.has(lower)) return this.#case.get(lower) || client
    return this.#shape.get(foldToolName(client)) || client
  }
}
