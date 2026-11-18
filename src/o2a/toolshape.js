/** Keep tool declarations, choices and history consistent across protocol shapes. */
import { ToolRenameMap, CLIENT_TOOL_PREFIX, clientToolWireName, officialForClientName } from './tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER, officialTool, officialToolDefinition, renamableToolName } from './official-tools.js'

export function renameAndCompleteTools(payload, shape, { keep } = {}) {
  const renames = new ToolRenameMap(), injected = [], known = new Set()
  if (!['chat', 'flat', 'claude'].includes(shape)) return { renames, injected, known }
  const preserved = keep instanceof Set ? keep : new Set()
  const officials = new Set(preserved), allocated = new Set()
  const entries = Array.isArray(payload.tools) ? payload.tools.slice() : []
  if (shape !== 'claude' && Array.isArray(payload.functions)) {
    for (const entry of convertLegacyFunctions(payload.functions, shape, renames, allocated)) entries.push(entry)
    delete payload.functions
  }
  let declared = 0
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    const name = renamableToolName(shape, entry)
    if (name === null) continue
    declared++
    if (preserved.has(name) || name.startsWith(CLIENT_TOOL_PREFIX)) continue
    const target = officialForClientName(name)
    let wire
    if (target !== null && !officials.has(target) && officialToolDefinition(target) !== undefined) {
      officials.add(target)
      wire = target
      renames.add(name, wire)
    } else {
      wire = renames.wireOf(name)
      if (wire === undefined) {
        wire = clientToolWireName(name, allocated)
        renames.add(name, wire)
      }
    }
    if (wire !== name) entries[index] = withToolName(shape, entry, wire)
  }
  for (const name of V2_OFFICIAL_TOOL_ORDER) {
    if (officials.has(name)) continue
    entries.push(officialTool(shape, name))
    officials.add(name)
    injected.push(name)
  }
  for (const name of officials) known.add(name)
  for (const name of renames.keys()) known.add(name)
  payload.tools = entries
  rewriteToolReferences(payload, shape, renames)
  if (declared) sanitizeToolHistory(payload, shape, known)
  dropDanglingToolChoice(payload, shape, known)
  return { renames, injected, known }
}

/** Remove unavailable calls and subsequent paired results without repeated splices. */
function chatMessageHasContent(message) {
  return ['content', 'reasoning_content', 'reasoning'].some(key => {
    const value = message[key]
    if (value === null || value === undefined) return false
    if (typeof value === 'string' || Array.isArray(value)) return value.length > 0
    return typeof value !== 'object' || Object.keys(value).length > 0
  })
}

function sanitizeToolHistory(payload, shape, known) {
  const served = name => {
    if (typeof name !== 'string' || !name) return null
    if (known.has(name)) return name
    const alias = officialForClientName(name)
    return alias !== null && known.has(alias) ? alias : null
  }
  const field = shape === 'flat' ? 'input' : 'messages'
  const records = payload[field]
  if (!Array.isArray(records)) return
  const removed = new Set(), removedFunctions = new Set()
  let write = 0, changed = false
  for (const original of records) {
    let row = original, drop = false
    if (shape === 'flat') {
      if (row?.type === 'function_call') {
        const name = served(row.name)
        if (name === null) {
          if (typeof row.call_id === 'string' && row.call_id) removed.add(row.call_id)
          drop = true
        } else if (name !== row.name) row = { ...row, name }
      } else if (row?.type === 'function_call_output' && removed.has(row.call_id)) drop = true
    } else if (shape === 'chat' && row && typeof row === 'object') {
      let emptied = false
      if (Array.isArray(row.tool_calls)) {
        const calls = []
        let touched = row.tool_calls.length === 0
        for (const call of row.tool_calls) {
          const name = served(call?.function?.name)
          if (name === null) {
            if (typeof call?.id === 'string' && call.id) removed.add(call.id)
            touched = true
          } else if (name === call.function.name) calls.push(call)
          else { calls.push({ ...call, function: { ...call.function, name } }); touched = true }
        }
        if (touched) {
          emptied = calls.length === 0 && row.tool_calls.length > 0 && row.function_call === undefined
          row = { ...row }
          if (calls.length) row.tool_calls = calls
          else delete row.tool_calls
        }
      }
      if (row.function_call && typeof row.function_call === 'object') {
        const name = served(row.function_call.name)
        if (name === null) {
          if (typeof row.function_call.name === 'string') removedFunctions.add(row.function_call.name)
          row = { ...row }
          delete row.function_call
        } else if (name !== row.function_call.name) row = { ...row, function_call: { ...row.function_call, name } }
      }
      drop = (row.role === 'tool' && removed.has(row.tool_call_id))
        || (row.role === 'function' && removedFunctions.has(row.name))
        || (emptied && !chatMessageHasContent(row))
    } else if (shape === 'claude' && Array.isArray(row?.content)) {
      const blocks = []
      let touched = false
      for (const block of row.content) {
        if (block?.type === 'tool_use') {
          const name = served(block.name)
          if (name === null) {
            if (typeof block.id === 'string' && block.id) removed.add(block.id)
            touched = true
          } else if (name === block.name) blocks.push(block)
          else { blocks.push({ ...block, name }); touched = true }
        } else if (block?.type === 'tool_result' && removed.has(block.tool_use_id)) touched = true
        else blocks.push(block)
      }
      if (touched) { row = { ...row, content: blocks }; drop = blocks.length === 0 }
    }
    if (drop || row !== original) changed = true
    if (!drop) records[write++] = row
  }
  records.length = write
  if (changed && shape === 'claude') payload[field] = records.filter(row => row !== null)
}

/** Remove a named `tool_choice` that names a tool the shaped body no longer serves. */
function dropDanglingToolChoice(payload, shape, known) {
  const choice = payload?.tool_choice
  if (choice === null || typeof choice !== 'object') return
  const name = shape === 'chat' && choice.function && typeof choice.function === 'object'
    ? choice.function.name
    : choice.name
  if (typeof name === 'string' && name !== '' && !known.has(name)) delete payload.tool_choice
}

/** Copy a tool declaration with its assigned wire name. */
function withToolName(shape, entry, name) {
  if (shape === 'chat') {
    return { ...entry, function: { ...entry.function, name } }
  }
  return { ...entry, name }
}

/** Normalize legacy function declarations at the external request boundary. */
function convertLegacyFunctions(entries, shape, renames, used) {
  const converted = []
  for (const entry of entries) {
    if (!entry || Array.isArray(entry) || typeof entry !== 'object'
      || typeof entry.name !== 'string' || !entry.name) continue
    let name = renames.wireOf(entry.name)
    if (name === undefined) {
      name = clientToolWireName(entry.name, used)
      renames.add(entry.name, name)
    }
    const declaration = {
      name,
      description: typeof entry.description === 'string' ? entry.description : undefined,
      parameters: entry.parameters ?? { type: 'object', properties: {} }
    }
    if (entry.strict !== undefined) declaration.strict = entry.strict
    converted.push(shape === 'chat'
      ? { type: 'function', function: declaration }
      : { type: 'function', ...declaration })
  }
  return converted
}

/** Rewrite only named tool references, cloning changed caller-owned records. */
function rewriteToolReferences(payload, shape, renames) {
  if (!renames.size) return
  const rename = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string') return value
    const name = renames.wireOf(value.name)
    return name === undefined || name === value.name ? value : { ...value, name }
  }
  const renameFunction = value => {
    if (!value || typeof value !== 'object') return value
    const fn = rename(value.function)
    return fn === value.function ? value : { ...value, function: fn }
  }
  const mapChanged = (owner, key, convert) => {
    if (!Array.isArray(owner[key])) return owner
    const original = owner[key]
    let replacement
    for (let index = 0; index < original.length; index++) {
      const next = convert(original[index])
      if (next !== original[index]) {
        replacement ??= original.slice()
        replacement[index] = next
      }
    }
    return replacement ? { ...owner, [key]: replacement } : owner
  }

  const choice = payload.tool_choice
  if (choice && typeof choice === 'object' && !Array.isArray(choice)) {
    if (shape === 'chat') {
      payload.tool_choice = choice.function && typeof choice.function === 'object'
        ? renameFunction(choice) : rename(choice)
    } else {
      const named = rename(choice)
      payload.tool_choice = shape === 'flat' ? mapChanged(named, 'allowed_tools', rename) : named
    }
  }
  if (shape === 'chat') {
    if (payload.function_call && typeof payload.function_call === 'object') payload.function_call = rename(payload.function_call)
    if (!Array.isArray(payload.messages)) return
    for (let index = 0; index < payload.messages.length; index++) {
      const message = payload.messages[index]
      if (!message || typeof message !== 'object') continue
      const fn = rename(message.function_call)
      const next = fn === message.function_call ? message : { ...message, function_call: fn }
      payload.messages[index] = mapChanged(next, 'tool_calls', renameFunction)
    }
  } else if (shape === 'flat') {
    if (!Array.isArray(payload.input)) return
    for (let index = 0; index < payload.input.length; index++) {
      const item = payload.input[index]
      if (item?.type === 'function_call' || item?.type === 'custom_tool_call') payload.input[index] = rename(item)
    }
  } else {
    if (!Array.isArray(payload.messages)) return
    for (let index = 0; index < payload.messages.length; index++) {
      const message = payload.messages[index]
      if (message && typeof message === 'object') {
        payload.messages[index] = mapChanged(message, 'content', block => block?.type === 'tool_use' ? rename(block) : block)
      }
    }
  }
}
