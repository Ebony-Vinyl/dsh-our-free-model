import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { privateWrite } from './workbench.mjs'

const MAX_CONTENT = 1024 * 1024
const MAX_STORE = 16 * MAX_CONTENT
const MAX_PROFILES = 100
const MAX_RESOURCES = 500
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const SERVER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i
const FORMATS = {
  codex: { context: 'AGENTS.md', skills: 'skills', codex: true },
  'codex-desktop': { context: 'AGENTS.md', skills: 'skills', codex: true },
  claude: { context: 'CLAUDE.md', skills: 'skills', agents: 'agents', config: '.claude.json' },
  gemini: { context: '.gemini/GEMINI.md', skills: '.gemini/skills', agents: '.gemini/agents', config: '.gemini/settings.json' },
}
const MANIFEST = '.workbench-library.json'
const FRAGMENT = 'ofm-mcp.toml'
const error = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode })
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const clone = value => structuredClone(value)
const json = value => JSON.stringify(value, null, 2) + '\n'
const digest = value => crypto.createHash('sha256').update(value).digest('hex')

function fields(value, allowed) {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) throw error('Unsupported fields')
}

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw error('Invalid ID')
  return value
}

function nameOf(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 80 ||
    /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) || value.endsWith('.') || value.includes('..') ||
    RESERVED.test(value) || ['__proto__', 'prototype', 'constructor'].includes(value)) throw error('Invalid name')
  return value
}

function text(value, max = 4096, multiline = false) {
  if (typeof value !== 'string' || value.length > max || (multiline ? /\0/ : /[\0\r\n]/).test(value)) throw error('Invalid text')
  return value
}

function serverName(value) {
  if (typeof value !== 'string' || !SERVER_NAME.test(value)) throw error('Invalid MCP server name')
  return nameOf(value)
}

function stringMap(value, type) {
  if (!record(value) || Object.keys(value).length > 128) throw error(`Invalid MCP ${type}`)
  for (const [key, item] of Object.entries(value)) {
    const valid = type === 'env' ? /^[A-Za-z_][A-Za-z0-9_]*$/ : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
    if (!valid.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw error(`Invalid MCP ${type} key`)
    text(item, 16384)
  }
  return value
}

// Accept one server definition or the common { mcpServers: { name: definition } } import shape.
function mcpServers(resource) {
  let value
  try { value = JSON.parse(resource.content) } catch { throw error('MCP content must be valid JSON') }
  if (!record(value)) throw error('MCP content must be an object')
  let entries
  if (Object.hasOwn(value, 'mcpServers')) {
    fields(value, ['mcpServers'])
    if (!record(value.mcpServers)) throw error('Invalid mcpServers')
    entries = Object.entries(value.mcpServers)
  } else entries = [[resource.name, value]]
  if (!entries.length || entries.length > 64) throw error('MCP resource must contain 1 to 64 servers')
  return entries.map(([name, server]) => {
    serverName(name)
    fields(server, ['type', 'command', 'args', 'env', 'cwd', 'url', 'httpUrl', 'headers'])
    const stdio = Object.hasOwn(server, 'command')
    const remote = Object.hasOwn(server, 'url') || Object.hasOwn(server, 'httpUrl')
    if (stdio === remote || (Object.hasOwn(server, 'url') && Object.hasOwn(server, 'httpUrl'))) throw error('MCP requires exactly one transport')
    if (stdio) {
      if (server.type !== undefined && server.type !== 'stdio') throw error('Invalid MCP transport')
      if (!text(server.command).trim()) throw error('MCP command is required')
      if (server.headers !== undefined) throw error('Headers require an HTTP MCP server')
      if (server.args !== undefined) {
        if (!Array.isArray(server.args) || server.args.length > 256) throw error('Invalid MCP args')
        server.args.forEach(arg => text(arg, 16384))
      }
      if (server.env !== undefined) stringMap(server.env, 'env')
      if (server.cwd !== undefined && (!path.isAbsolute(text(server.cwd)) || !server.cwd)) throw error('MCP cwd must be absolute')
      return [name, { type: 'stdio', command: server.command,
        ...(server.args !== undefined ? { args: server.args } : {}),
        ...(server.env !== undefined ? { env: server.env } : {}),
        ...(server.cwd !== undefined ? { cwd: server.cwd } : {}) }]
    }
    if (['args', 'env', 'cwd'].some(key => Object.hasOwn(server, key))) throw error('Stdio fields require an MCP command')
    const type = server.type ?? 'http'
    if (!['http', 'streamable-http', 'sse'].includes(type) || (server.httpUrl !== undefined && type === 'sse')) throw error('Invalid MCP transport')
    const url = text(server.httpUrl ?? server.url)
    let parsed
    try { parsed = new URL(url) } catch { throw error('Invalid MCP URL') }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw error('MCP URL must use HTTP(S) without userinfo or fragment')
    if (server.headers !== undefined) stringMap(server.headers, 'headers')
    return [name, { type: type === 'sse' ? 'sse' : 'http', url,
      ...(server.headers !== undefined ? { headers: server.headers } : {}) }]
  })
}

function validateResource(value) {
  fields(value, ['id', 'kind', 'name', 'content', 'enabled'])
  identifier(value.id)
  nameOf(value.name)
  if (!['mcp', 'prompt', 'skill', 'agent'].includes(value.kind) || typeof value.enabled !== 'boolean') throw error('Invalid resource')
  text(value.content, MAX_CONTENT, true)
  if (Buffer.byteLength(value.content) > MAX_CONTENT) throw error('Resource content is too large', 413)
  if (value.kind === 'mcp') mcpServers(value)
  return value
}

function validatePatch(value) {
  fields(value, ['id', 'mode', 'model', 'cwd', 'executable'])
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value.id)) throw error('Invalid client ID')
  if (!['native', 'gateway'].includes(value.mode)) throw error('Invalid client mode')
  for (const key of ['model', 'cwd', 'executable']) text(value[key])
  return value
}

function unique(rows, key) {
  if (new Set(rows.map(key)).size !== rows.length) throw error('Duplicate library entry', 409)
}

function validateState(value) {
  fields(value, ['version', 'profiles', 'resources'])
  if (value.version !== 1 || !Array.isArray(value.profiles) || !Array.isArray(value.resources)) throw error('Invalid library state')
  if (value.profiles.length > MAX_PROFILES || value.resources.length > MAX_RESOURCES) throw error('Library limit exceeded', 413)
  for (const profile of value.profiles) {
    fields(profile, ['id', 'name', 'clients'])
    identifier(profile.id)
    nameOf(profile.name)
    if (!Array.isArray(profile.clients) || !profile.clients.length || profile.clients.length > 32) throw error('Invalid profile clients')
    profile.clients.forEach(validatePatch)
    unique(profile.clients, row => row.id)
  }
  value.resources.forEach(validateResource)
  unique(value.profiles, row => row.id)
  unique(value.profiles, row => row.name.toLowerCase())
  unique(value.resources, row => row.id)
  unique(value.resources, row => `${row.kind}:${row.name.toLowerCase()}`)
  const servers = value.resources.filter(row => row.kind === 'mcp' && row.enabled).flatMap(mcpServers)
  unique(servers, ([name]) => name.toLowerCase())
  return value
}

function stat(file) {
  try { return fs.lstatSync(file) } catch (failure) { if (failure.code === 'ENOENT') return null; throw failure }
}

// Check every ancestor too: checking just the final filename misses junctions and linked directories.
function inspect(file, kind = 'file') {
  const absolute = path.resolve(file)
  const { root } = path.parse(absolute)
  const parts = absolute.slice(root.length).split(path.sep).filter(Boolean)
  let current = root
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part)
    const info = stat(current)
    if (!info) return null
    if (info.isSymbolicLink()) throw error('Symlinks are not allowed in managed storage', 409)
    const leaf = index === parts.length - 1
    if (!leaf || kind === 'directory') {
      if (!info.isDirectory()) throw error('Managed directory is not a directory', 409)
    } else if (!info.isFile() || info.nlink !== 1) throw error('Managed file must be a regular, unlinked file', 409)
  }
  return stat(absolute)
}

function ensureDirectory(directory) {
  if (inspect(directory, 'directory')) return
  const parent = path.dirname(directory)
  if (parent === directory) throw error('Invalid managed directory')
  ensureDirectory(parent)
  fs.mkdirSync(directory, { mode: 0o700 })
  inspect(directory, 'directory')
}

function read(file) {
  const info = inspect(file)
  if (!info) return null
  if (info.size > MAX_STORE) throw error('Managed file is too large', 413)
  return fs.readFileSync(file, 'utf8')
}

function readJSON(file, fallback) {
  const contents = read(file)
  if (contents === null) return fallback
  try { return JSON.parse(contents) } catch { throw error('Invalid JSON in managed storage', 409) }
}

function write(file, value) {
  ensureDirectory(path.dirname(file))
  inspect(file)
  privateWrite(file, value)
}

// Each replacement is atomic. Restore every attempted replacement, including a write that failed after rename.
function transact(changes) {
  const snapshots = changes.map(([file, value]) => {
    if (value !== null && Buffer.byteLength(value) > MAX_STORE) throw error('Managed file is too large', 413)
    return { file, value, previous: read(file) }
  })
  const attempted = []
  try {
    for (const change of snapshots) {
      attempted.push(change)
      if (change.value === null) {
        inspect(change.file)
        if (change.previous !== null) fs.unlinkSync(change.file)
      } else write(change.file, change.value)
    }
  } catch (failure) {
    const failures = [failure]
    for (const change of attempted.reverse()) {
      try {
        if (read(change.file) === change.previous) continue
        if (change.previous === null) {
          inspect(change.file)
          fs.unlinkSync(change.file)
        } else write(change.file, change.previous)
      } catch (rollbackFailure) { failures.push(rollbackFailure) }
    }
    if (failures.length > 1) throw Object.assign(new AggregateError(failures, 'Managed storage rollback failed'), { statusCode: 500 })
    throw failure
  }
}

function tomlString(value) {
  // JSON's \b and \f escapes are not TOML escapes; escape all controls as Unicode instead.
  return '"' + Array.from(value, char => {
    if (char === '"' || char === '\\') return '\\' + char
    const code = char.codePointAt(0)
    if (code < 0x20 || code === 0x7f) return '\\u' + code.toString(16).padStart(4, '0')
    return char
  }).join('') + '"'
}

function codexFragment(servers) {
  return servers.map(([name, server]) => {
    if (server.type === 'sse') throw error('Codex does not support SSE MCP servers; use a streamable HTTP endpoint', 409)
    const lines = [`[mcp_servers.${tomlString(name)}]`]
    for (const key of ['command', 'cwd', 'url']) if (server[key] !== undefined) lines.push(`${key} = ${tomlString(server[key])}`)
    if (server.args !== undefined) lines.push(`args = [${server.args.map(tomlString).join(', ')}]`)
    for (const [source, target] of [['env', 'env'], ['headers', 'http_headers']]) {
      if (server[source] !== undefined) {
        lines.push(`${target} = { ${Object.entries(server[source]).map(([key, value]) => `${tomlString(key)} = ${tomlString(value)}`).join(', ')} }`)
      }
    }
    return lines.join('\n') + '\n'
  }).join('\n')
}

function generatedName(resource) { return `ofm-${resource.id}` }
function markdown(resource, clientId) {
  const kind = resource.kind === 'agent' && clientId === 'gemini' ? 'kind: local\n' : ''
  return `---\n${kind}name: ${generatedName(resource)}\ndescription: ${JSON.stringify(resource.name)}\n---\n\n${resource.content}\n`
}

function managedFile(relative, format) {
  const leaf = 'ofm-[a-f0-9-]{36}'
  return (format.codex && relative === FRAGMENT) ||
    new RegExp(`^${format.skills.replaceAll('.', '\\.')}/${leaf}/SKILL\\.md$`).test(relative) ||
    (format.agents && new RegExp(`^${format.agents.replaceAll('.', '\\.')}/${leaf}\\.md$`).test(relative))
}

function validateManifest(value, clientId, format) {
  fields(value, ['version', 'clientId', 'files', 'mcp', 'configCreated', 'hadMcpServers', 'contextBlock', 'contextCreated'])
  if (value.version !== 1 || value.clientId !== clientId || !record(value.files) || !record(value.mcp) ||
    typeof value.configCreated !== 'boolean' || typeof value.hadMcpServers !== 'boolean' ||
    typeof value.contextCreated !== 'boolean' || typeof value.contextBlock !== 'string') throw error('Invalid resource manifest', 409)
  if (Object.keys(value.files).length > MAX_RESOURCES + 1) throw error('Invalid resource manifest', 409)
  for (const [file, hash] of Object.entries(value.files)) {
    if (!managedFile(file, format) || !/^[a-f0-9]{64}$/.test(hash)) throw error('Invalid managed filename', 409)
  }
  Object.keys(value.mcp).forEach(serverName)
  return value
}

/**
 * Synchronous, private library. The controller calls materialize after generating routing configuration.
 * Profile application requires workbench.saveBatch(patches): prevalidate all, persist once, publish on success.
 * Codex materialization returns codexConfigFragment for appending to a freshly generated config.toml.
 * Claude/Gemini JSON is merged in place; returned skillPaths also allow explicit controller registration.
 */
export function createWorkbenchLibrary({ dataDir, workbench }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || !workbench || typeof workbench.clients !== 'function') throw error('Invalid library configuration')
  const root = path.resolve(dataDir)
  inspect(root, 'directory')
  const storeFile = path.join(root, 'workbench-library.json')
  let state = validateState(readJSON(storeFile, { version: 1, profiles: [], resources: [] }))

  function commit(next) {
    validateState(next)
    const contents = json(next)
    if (Buffer.byteLength(contents) > MAX_STORE) throw error('Library storage limit exceeded', 413)
    transact([[storeFile, contents]])
    state = next
  }
  function list() { return clone({ profiles: state.profiles, resources: state.resources }) }
  function saveProfile(input) {
    fields(input, ['name'])
    const profile = {
      id: crypto.randomUUID(), name: nameOf(input.name),
      clients: workbench.clients().map(({ id, mode, model, cwd, executable }) => ({ id, mode, model, cwd, executable })),
    }
    commit({ ...state, profiles: [...state.profiles, profile] })
    return clone(profile)
  }
  function applyProfile(input) {
    fields(input, ['id'])
    const profile = state.profiles.find(row => row.id === identifier(input.id))
    if (!profile) throw error('Profile not found', 404)
    const current = new Map(workbench.clients().map(client => [client.id, client]))
    for (const patch of profile.clients) {
      validatePatch(patch)
      const client = current.get(patch.id)
      if (!client) throw error('Profile contains an unknown client', 409)
      if (client.running || client.launching) throw error('Stop all profile clients before applying', 409)
      if (client.nativeOnly && patch.mode !== 'native') throw error('Client supports native mode only', 409)
      for (const [key, kind] of [['cwd', 'directory'], ['executable', 'file']]) {
        if (!patch[key]) continue
        if (!path.isAbsolute(patch[key])) throw error(`Profile ${key} must be absolute`)
        let info
        try { info = fs.statSync(patch[key]) } catch { throw error(`Profile ${key} does not exist`, 409) }
        if (kind === 'directory' ? !info.isDirectory() : !info.isFile()) throw error(`Invalid profile ${key}`, 409)
      }
      if (process.platform === 'win32' && patch.executable && !/\.(exe|cmd|bat)$/i.test(patch.executable)) throw error('Invalid Windows executable', 409)
    }
    if (typeof workbench.saveBatch !== 'function') throw error('Atomic profile application requires workbench.saveBatch(patches)', 409)
    const clients = workbench.saveBatch(clone(profile.clients))
    return { ok: true, id: profile.id, clients: clone(clients ?? workbench.clients()) }
  }
  function removeProfile(input) {
    fields(input, ['id'])
    const id = identifier(input.id)
    if (!state.profiles.some(row => row.id === id)) throw error('Profile not found', 404)
    commit({ ...state, profiles: state.profiles.filter(row => row.id !== id) })
    return { ok: true }
  }
  function saveResource(input) {
    fields(input, ['id', 'kind', 'name', 'content', 'enabled'])
    const id = input.id === undefined ? crypto.randomUUID() : identifier(input.id)
    const previous = state.resources.find(row => row.id === id)
    if (input.id !== undefined && !previous) throw error('Resource not found', 404)
    const resource = validateResource({ ...input, id })
    const resources = previous ? state.resources.map(row => row.id === id ? resource : row) : [...state.resources, resource]
    commit({ ...state, resources })
    return clone(resource)
  }
  function removeResource(input) {
    fields(input, ['id'])
    const id = identifier(input.id)
    if (!state.resources.some(row => row.id === id)) throw error('Resource not found', 404)
    commit({ ...state, resources: state.resources.filter(row => row.id !== id) })
    return { ok: true }
  }
  function materialize(input) {
    fields(input, ['clientId', 'profileDir'])
    const { clientId } = input
    if (typeof clientId !== 'string' || !Object.hasOwn(FORMATS, clientId)) throw error('Client does not support library resources')
    const format = FORMATS[clientId]
    const directory = path.join(root, 'clients', clientId)
    if (input.profileDir !== undefined && (typeof input.profileDir !== 'string' || !path.isAbsolute(input.profileDir) ||
      path.resolve(input.profileDir) !== directory)) throw error('Resources may only be materialized in the private managed client directory')
    inspect(directory, 'directory')
    const target = relative => path.join(directory, ...relative.split('/'))
    const previous = validateManifest(readJSON(target(MANIFEST), {
      version: 1, clientId, files: {}, mcp: {}, configCreated: false, hadMcpServers: false, contextBlock: '', contextCreated: false,
    }), clientId, format)
    const enabled = state.resources.filter(row => row.enabled)
    const servers = enabled.filter(row => row.kind === 'mcp').flatMap(mcpServers)
    const desired = new Map()
    let fragment = ''
    if (format.codex) {
      fragment = codexFragment(servers)
      if (fragment) desired.set(FRAGMENT, fragment)
    }
    const skillPaths = []
    for (const resource of enabled) {
      if (resource.kind === 'skill') {
        const relative = `${format.skills}/${generatedName(resource)}/SKILL.md`
        desired.set(relative, markdown(resource, clientId))
        skillPaths.push(target(relative))
      } else if (resource.kind === 'agent' && format.agents) {
        desired.set(`${format.agents}/${generatedName(resource)}.md`, markdown(resource, clientId))
      }
    }
    const changes = []
    for (const relative of new Set([...Object.keys(previous.files), ...desired.keys()])) {
      const file = target(relative)
      const current = read(file)
      const owned = current !== null && digest(current) === previous.files[relative]
      if (desired.has(relative)) {
        if (current !== null && !owned) throw error('A resource would overwrite an unrelated or modified file', 409)
        changes.push([file, desired.get(relative)])
      } else if (owned) changes.push([file, null])
    }
    const mcp = {}
    let configCreated = previous.configCreated
    let hadMcpServers = previous.hadMcpServers
    if (format.config) {
      const file = target(format.config)
      const raw = read(file)
      const config = readJSON(file, {})
      if (!record(config) || (config.mcpServers !== undefined && !record(config.mcpServers))) throw error('Invalid client JSON configuration', 409)
      if (!Object.keys(previous.mcp).length) {
        configCreated = raw === null
        hadMcpServers = Object.hasOwn(config, 'mcpServers')
      }
      const existing = { ...config.mcpServers }
      for (const [name, server] of Object.entries(previous.mcp)) {
        if (isDeepStrictEqual(existing[name], server)) delete existing[name]
      }
      for (const [name, server] of servers) {
        if (Object.hasOwn(existing, name)) throw error('A resource would overwrite an unrelated or modified MCP server', 409)
        const adapted = clientId === 'gemini'
          ? server.type === 'stdio'
            ? Object.fromEntries(Object.entries(server).filter(([key]) => key !== 'type'))
            : { [server.type === 'sse' ? 'url' : 'httpUrl']: server.url, ...(server.headers ? { headers: server.headers } : {}) }
          : server
        existing[name] = adapted
        mcp[name] = adapted
      }
      if (Object.keys(existing).length || hadMcpServers) config.mcpServers = existing
      else delete config.mcpServers
      if (servers.length || Object.keys(previous.mcp).length) {
        changes.push([file, configCreated && !Object.keys(config).length ? null : json(config)])
      }
    }
    const contextFile = target(format.context)
    const currentContext = read(contextFile)
    const contextCreated = previous.contextBlock ? previous.contextCreated : currentContext === null
    let baseContext = currentContext ?? ''
    if (previous.contextBlock) {
      const first = baseContext.indexOf(previous.contextBlock)
      if (first >= 0 && baseContext.indexOf(previous.contextBlock, first + previous.contextBlock.length) < 0) {
        baseContext = baseContext.slice(0, first) + baseContext.slice(first + previous.contextBlock.length)
      } else if (enabled.some(row => row.kind !== 'mcp')) {
        throw error('Managed client instructions were modified; preserve them before regenerating', 409)
      }
    }
    const instructions = enabled.filter(row => row.kind === 'prompt' || (row.kind === 'agent' && format.codex))
      .map(row => `## ${row.name}\n\n${row.content}`).join('\n\n')
    const skillsIndex = enabled.filter(row => row.kind === 'skill').map(row =>
      `- ${row.name}: ${target(`${format.skills}/${generatedName(row)}/SKILL.md`)}`).join('\n')
    const body = [instructions, skillsIndex && `## Skills\n\n${skillsIndex}`].filter(Boolean).join('\n\n')
    const contextBlock = body ? `\n\n<!-- ofm-workbench-library:begin -->\n${body}\n<!-- ofm-workbench-library:end -->\n` : ''
    if (contextBlock || (previous.contextBlock && baseContext !== currentContext)) {
      const contents = baseContext + contextBlock
      changes.push([contextFile, contents === '' && contextCreated ? null : contents])
    }
    const manifest = {
      version: 1, clientId, files: Object.fromEntries([...desired].map(([file, contents]) => [file, digest(contents)])),
      mcp, configCreated, hadMcpServers, contextBlock, contextCreated,
    }
    changes.push([target(MANIFEST), json(manifest)])
    transact(changes)
    return {
      ok: true, clientId, profileDir: directory,
      files: [...desired.keys(), ...(contextBlock ? [format.context] : []), ...(Object.keys(mcp).length ? [format.config] : [])].map(target),
      skillPaths, ...(format.codex ? { codexConfigFragment: fragment, codexFragmentPath: fragment ? target(FRAGMENT) : null } : {}),
    }
  }
  return { list, saveProfile, applyProfile, removeProfile, saveResource, removeResource, materialize }
}
