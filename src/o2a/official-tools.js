/** Render authored transport tool contracts in each supported wire format. */
import { officialToolsText } from './asset-source.js'

export const V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  'edit', 'execute', 'glob', 'grep', 'question', 'read', 'shell',
  'skill', 'subagent', 'webfetch', 'websearch', 'write', 'patch',
])
let definitions
export function officialToolDefinition(name) {
  definitions ??= new Map(Object.entries(JSON.parse(officialToolsText())))
  return definitions.get(name)
}

export function v2ShellDescription(base, platform = process.platform) {
  return platform === 'win32' ? base.replace('on Linux using bash', 'on Windows using powershell') : base
}

export function officialTool(shape, name) {
  const definition = officialToolDefinition(name)
  let description = definition?.description ?? `Agent tool ${name}`
  const parameters = definition?.parameters == null ? { type: 'object', properties: {} } : structuredClone(definition.parameters)
  if (name === 'shell') description = v2ShellDescription(description)
  if (shape === 'claude') return { name, description, input_schema: parameters }
  const fn = { name, description, parameters }
  return shape === 'flat' ? { type: 'function', ...fn } : { type: 'function', function: { ...fn, strict: false } }
}

export function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map(name => officialTool(shape, name))
}

export function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  if (shape !== 'chat') {
    const type = typeof entry.type === 'string' ? entry.type : ''
    if (shape === 'flat' && !['', 'function', 'custom'].includes(type)) return null
    if (shape === 'claude' && !['', 'custom'].includes(type)) return null
  }
  const name = shape === 'chat' ? entry.function?.name : entry.name
  return typeof name === 'string' && name.length > 0 ? name : null
}
