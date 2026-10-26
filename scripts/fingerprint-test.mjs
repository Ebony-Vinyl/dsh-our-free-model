/**
 * The free tier's **v2** tool fingerprint.
 *
 * Since 2026-10-14 the gateway reads the declared tools themselves: `read` and
 * `shell` must be present **with OpenCode's own definitions** (description and
 * parameter schema, verbatim), `tool_choice: 'none'` is refused outright, and a
 * caller tool that reuses one of those names with a different definition has to
 * move aside. The v1 contract this file used to encode — four names, each with
 * any non-empty schema, decoys allowed — is gone; every case below is one of the
 * refusals the new gate produces.
 *
 * Run: node scripts/fingerprint-test.mjs
 */

import { applyFingerprint, FINGERPRINT_TOOLS, restoreToolName } from '../src/upstream.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

const chatTool = (name, extra = {}) => ({
  type: 'function',
  function: { name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra },
})
const flatTool = (name, extra = {}) => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: { x: { type: 'string' } } }, ...extra })
const claudeTool = name => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: { command: { type: 'string' } } } })
const declared = body => (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)
const schemaOf = tool => tool.function?.parameters ?? tool.parameters ?? tool.input_schema
const noteOf = body => JSON.stringify(body.messages?.[0]?.content ?? body.system ?? body.instructions ?? '')
/** An official declaration as the gate itself produces it, for "already correct" cases. */
const official = (style, name) => {
  const body = {}
  applyFingerprint(body, style)
  return body.tools.find(tool => (tool.function?.name ?? tool.name) === name)
}

console.log('=== 1. the gate names are read + shell, with the official definitions ===')
{
  const body = { tools: [chatTool('pwsh'), chatTool('Read'), chatTool('write')] }
  const map = applyFingerprint(body, false)
  check('read and shell are declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['read', 'shell'])
  check('the caller tools are left alone', declared(body), ['pwsh', 'Read', 'write', 'read', 'shell'])
  check('case variants are not renamed', declared(body).filter(name => name === 'Read' || name === 'read'), ['Read', 'read'])
  check('nothing was aliased', map.size, 0)
  const read = body.tools.find(tool => tool.function.name === 'read')
  check('the read schema is the official one', read.function.parameters.required, ['path'])
  check('…and is closed to extra properties', read.function.parameters.additionalProperties, false)
  const shell = body.tools.find(tool => tool.function.name === 'shell')
  check('the shell schema is the official one', shell.function.parameters.required, ['command'])
  check('the model is told the injected tools are placeholders', /placeholders that do nothing/.test(noteOf(body)), true)
  check('…and no tool_choice is claimed', body.tool_choice, undefined)
}

console.log('\n=== 2. a caller tool that reuses a gate name moves to an alias ===')
{
  const body = { tools: [chatTool('read'), chatTool('read_client'), chatTool('Edit')] }
  const map = applyFingerprint(body, false)
  check('the caller read is aliased past the taken name', declared(body), ['read_client2', 'read_client', 'Edit', 'read', 'shell'])
  check('the alias maps back to the caller name', restoreToolName('read_client2', map), 'read')
  check('the official read is the last declaration of that name', body.tools.filter(tool => tool.function.name === 'read').length, 1)
}

console.log('\n=== 3. a caller tool that already carries the official definition is kept ===')
{
  const body = { tools: [official(false, 'read'), official(false, 'shell')] }
  const map = applyFingerprint(body, false)
  check('no duplicate and no alias', declared(body), ['read', 'shell'])
  check('nothing was aliased', map.size, 0)
  check('no placeholder note is added', noteOf(body), '""')
}

console.log('\n=== 4. duplicate declarations of one gate name keep the first ===')
{
  const body = { tools: [chatTool('shell'), chatTool('shell')] }
  applyFingerprint(body, false)
  check('the duplicate moves aside instead of repeating', declared(body), ['shell_client', 'read', 'shell'])
}

console.log('\n=== 5. tool_choice: never none, retargeted to an alias, auto on Responses ===')
{
  const chat = { tools: [chatTool('write')], tool_choice: 'none' }
  applyFingerprint(chat, false)
  check('a caller none is dropped (the gate refuses it)', chat.tool_choice, undefined)

  const claude = { tools: [claudeTool('write')], tool_choice: { type: 'none' } }
  applyFingerprint(claude, 'claude')
  check('the Messages shape drops it too', claude.tool_choice, undefined)

  const named = { tools: [chatTool('read')], tool_choice: { type: 'function', function: { name: 'read' } } }
  applyFingerprint(named, false)
  check('a choice naming an aliased tool follows the alias', named.tool_choice.function.name, 'read_client')

  const flat = { tools: [flatTool('write')] }
  applyFingerprint(flat, true)
  check('Responses defaults to auto', flat.tool_choice, 'auto')
}

console.log('\n=== 6. history calls to an aliased tool are renamed with it ===')
{
  const body = {
    tools: [chatTool('read')],
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'ok' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => Array.isArray(message.tool_calls))
  check('the prior call follows the alias', assistant.tool_calls[0].function.name, 'read_client')
  check('the caller message itself is untouched', body.messages.at(-2) === assistant || body.messages.at(-1) === assistant, true)
}

console.log('\n=== 7. the Messages (Claude) shape carries input_schema, not parameters ===')
{
  const body = {}
  applyFingerprint(body, 'claude')
  check('both gate names are declared', declared(body), ['read', 'shell'])
  check('every declaration uses input_schema', body.tools.every(tool => tool.input_schema?.type === 'object' && tool.function === undefined && tool.parameters === undefined), true)
  check('the read schema is still the official one', body.tools.find(tool => tool.name === 'read').input_schema.required, ['path'])
  check('the placeholder note lands in system', /placeholders that do nothing/.test(noteOf(body)), true)

  const caller = { tools: [claudeTool('read')] }
  applyFingerprint(caller, 'claude')
  check('a conflicting caller read is aliased here too', declared(caller), ['read_client', 'read', 'shell'])
}

console.log('\n=== 8. the Responses (flat) shape carries a flat declaration ===')
{
  const body = {}
  applyFingerprint(body, true)
  check('both gate names are declared', declared(body), ['read', 'shell'])
  check('the declarations are flat', body.tools.every(tool => tool.function === undefined && typeof tool.name === 'string'), true)
  check('the shell schema is the official one', body.tools.find(tool => tool.name === 'shell').parameters.required, ['command'])
  check('the placeholder note lands in instructions', /placeholders that do nothing/.test(String(body.instructions)), true)

  const caller = { tools: [flatTool('shell')] }
  applyFingerprint(caller, true)
  check('a conflicting caller shell is aliased here too', declared(caller), ['shell_client', 'read', 'shell'])
}

console.log('\n=== 9. the injected definitions are byte-for-byte the official ones ===')
{
  // The gate compares description and parameters, so a reworded copy is a 403
  // even though the name is right. These are the invariants a careless edit breaks.
  const body = {}
  applyFingerprint(body, false)
  const read = body.tools.find(tool => tool.function.name === 'read').function
  const shell = body.tools.find(tool => tool.function.name === 'shell').function
  check('read description opens the official way', read.description.startsWith('Read the contents of a file or directory.'), true)
  check('read properties are exactly path/offset/limit', Object.keys(read.parameters.properties), ['path', 'offset', 'limit'])
  check('shell description opens the official way', shell.description.startsWith('Execute a shell command and return its output.'), true)
  check('shell properties are exactly command/workdir/timeout/background', Object.keys(shell.parameters.properties), ['command', 'workdir', 'timeout', 'background'])
  check('the two names are the gate set', [...FINGERPRINT_TOOLS], ['read', 'shell'])
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
