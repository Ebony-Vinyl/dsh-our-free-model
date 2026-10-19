/**
 * The free tier's **legacy `/zen/v1`** tool fingerprint.
 *
 * 2026-10-18: `/inference/v1` began answering 403 FreeTierError for every free
 * id, while `/zen/v1` still accepts the pre-2.x (v1.3.7) shape. That gate only
 * checks tool *names*: `bash` and `read` must be declared, stubs with an empty
 * `properties` object pass, and the caller's own definitions are left alone.
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
const noteOf = body => JSON.stringify(body.messages?.[0]?.content ?? body.system ?? body.instructions ?? '')

console.log('=== 1. the legacy gate names are bash/edit/glob/grep/read, as stubs ===')
{
  const body = { tools: [chatTool('pwsh'), chatTool('Read'), chatTool('write')] }
  const map = applyFingerprint(body, false)
  check('the gate names are declared', declared(body), ['pwsh', 'Read', 'write', 'bash', 'edit', 'glob', 'grep', 'read'])
  check('the caller tools are left alone', declared(body).slice(0, 3), ['pwsh', 'Read', 'write'])
  check('case variants are not renamed', declared(body).filter(name => name === 'Read' || name === 'read'), ['Read', 'read'])
  check('nothing was aliased', map.size, 0)
  const read = body.tools.find(tool => tool.function.name === 'read')
  check('the stub schema is empty', read.function.parameters, { type: 'object', properties: {} })
  const bash = body.tools.find(tool => tool.function.name === 'bash')
  check('bash is a stub too', bash.function.parameters, { type: 'object', properties: {} })
  check('the model is told the injected tools are placeholders', /placeholders that do nothing/.test(noteOf(body)), true)
  check('…and no tool_choice is claimed', body.tool_choice, undefined)
}

console.log('\n=== 2. a caller tool named like a gate tool keeps its own definition ===')
{
  const body = { tools: [chatTool('read'), chatTool('bash')] }
  const map = applyFingerprint(body, false)
  check('the caller declarations survive verbatim', declared(body), ['read', 'bash', 'edit', 'glob', 'grep'])
  check('the caller read schema is untouched', body.tools[0].function.parameters.properties.x, { type: 'string' })
  check('nothing was aliased', map.size, 0)
  check('no duplicate was injected', body.tools.filter(tool => tool.function.name === 'read').length, 1)
}

console.log('\n=== 3. already declared gate names are not injected twice ===')
{
  const body = { tools: FINGERPRINT_TOOLS.map(name => chatTool(name)) }
  applyFingerprint(body, false)
  check('every gate name appears once', declared(body), FINGERPRINT_TOOLS)
  check('no placeholder note is added', noteOf(body), '""')
}

console.log('\n=== 4. tool_choice is left exactly as the caller sent it ===')
{
  const chat = { tools: [chatTool('write')], tool_choice: 'none' }
  applyFingerprint(chat, false)
  check('the caller choice survives', chat.tool_choice, 'none')

  const named = { tools: [chatTool('read')], tool_choice: { type: 'function', function: { name: 'read' } } }
  applyFingerprint(named, false)
  check('a choice naming a gate tool is not retargeted', named.tool_choice.function.name, 'read')
}

console.log('\n=== 5. the Messages (Claude) shape carries input_schema, not parameters ===')
{
  const body = {}
  applyFingerprint(body, 'claude')
  check('every gate name is declared', declared(body), FINGERPRINT_TOOLS)
  check('every declaration uses input_schema', body.tools.every(tool => tool.input_schema?.type === 'object' && tool.function === undefined && tool.parameters === undefined), true)
  check('the placeholder note lands in system', /placeholders that do nothing/.test(noteOf(body)), true)
}

console.log('\n=== 6. the Responses (flat) shape carries a flat declaration ===')
{
  const body = {}
  applyFingerprint(body, true)
  check('every gate name is declared', declared(body), FINGERPRINT_TOOLS)
  check('the declarations are flat', body.tools.every(tool => tool.function === undefined && typeof tool.name === 'string'), true)
  check('the placeholder note lands in instructions', /placeholders that do nothing/.test(String(body.instructions)), true)
}

console.log('\n=== 7. the injected definitions are the v1.3.7 stubs ===')
{
  const body = {}
  applyFingerprint(body, false)
  check('the gate set is the legacy one', [...FINGERPRINT_TOOLS], ['bash', 'edit', 'glob', 'grep', 'read'])
  check('every stub has an empty schema', body.tools.every(tool => JSON.stringify(tool.function.parameters) === '{"type":"object","properties":{}}'), true)
  check('every description is the generic stub text', body.tools.every(tool => tool.function.description === `Agent tool ${tool.function.name}`), true)
  check('restoring with an empty map is a no-op', restoreToolName('read', new Map()), 'read')
}

console.log('\n=== 8. names outside the gate alphabet are rewritten, not dropped ===')
{
  const body = {
    tools: [chatTool('mcp:rea:read_file'), chatTool('read_file')],
    messages: [
      { role: 'user', content: 'baca' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'mcp:rea:read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'isi' },
    ],
    tool_choice: { type: 'function', function: { name: 'mcp:rea:read_file' } },
  }
  const map = applyFingerprint(body, false)
  check('the colon name becomes an accepted spelling', declared(body).slice(0, 2), ['mcp_rea_read_file', 'read_file'])
  check('the caller name that was already valid is untouched', declared(body)[1], 'read_file')
  check('the history refers to the same wire name', body.messages.find(message => message.role === 'assistant').tool_calls[0].function.name, 'mcp_rea_read_file')
  check('a pinned tool_choice is retargeted', body.tool_choice.function.name, 'mcp_rea_read_file')
  check('the map restores the caller spelling', restoreToolName('mcp_rea_read_file', map), 'mcp:rea:read_file')
  check('a valid name is not aliased', map.has('read_file'), false)
  check('every declaration is accepted by the gate', declared(body).every(name => /^[A-Za-z0-9_-]{1,128}$/.test(name)), true)
}

console.log('\n=== 9. two names that flatten alike stay distinct ===')
{
  const body = { tools: [chatTool('a:b'), chatTool('a_b'), chatTool('a b')] }
  const map = applyFingerprint(body, false)
  const names = declared(body).slice(0, 3)
  check('three declarations, three distinct wire names', new Set(names).size, 3)
  check('the caller-declared a_b keeps its spelling', names.includes('a_b'), true)
  check('each rewritten name restores to its own original', [restoreToolName(names[0], map), restoreToolName(names[2], map)].sort(), ['a b', 'a:b'])
  check('the mapping is stable across calls', (() => {
    const again = { tools: [chatTool('a:b'), chatTool('a_b'), chatTool('a b')] }
    applyFingerprint(again, false)
    return JSON.stringify(declared(again).slice(0, 3)) === JSON.stringify(names)
  })(), true)
}

console.log('\n=== 10. the Claude and Responses wires rewrite their own shapes ===')
{
  const claude = {
    tools: [claudeTool('mcp:rea:grep')],
    messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'mcp:rea:grep', input: {} }] }],
    tool_choice: { type: 'tool', name: 'mcp:rea:grep' },
  }
  const claudeMap = applyFingerprint(claude, 'claude')
  check('claude declarations are rewritten', declared(claude)[0], 'mcp_rea_grep')
  check('claude history blocks are rewritten', claude.messages[0].content[0].name, 'mcp_rea_grep')
  check('claude tool_choice is rewritten', claude.tool_choice.name, 'mcp_rea_grep')
  check('claude restores the caller spelling', restoreToolName('mcp_rea_grep', claudeMap), 'mcp:rea:grep')

  const flat = {
    tools: [flatTool('mcp:rea:skill')],
    input: [{ type: 'function_call', call_id: 'c1', name: 'mcp:rea:skill', arguments: '{}' }],
    tool_choice: { type: 'function', name: 'mcp:rea:skill' },
  }
  const flatMap = applyFingerprint(flat, true)
  check('responses declarations are rewritten', declared(flat)[0], 'mcp_rea_skill')
  check('responses input items are rewritten', flat.input[0].name, 'mcp_rea_skill')
  check('responses tool_choice is rewritten', flat.tool_choice.name, 'mcp_rea_skill')
  check('responses restores the caller spelling', restoreToolName('mcp_rea_skill', flatMap), 'mcp:rea:skill')
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
