/**
 * The free lane's fingerprint as the reference gateway shapes it — the port of
 * opencode2api v1.4.7 (`src/o2a/`), tracked 2026-11-07.
 *
 * The 2026-10-16 v2 gate contract (read + shell verbatim, `tool_choice: 'none'`
 * refused) still holds, and on top of it the reference adds the facts its
 * releases verified: **no foreign client tool name may reach the wire** (another
 * client's vocabulary — Claude Code's `ReportFindings` + `ScheduleWakeup` — is
 * refused), so every named client tool either **binds to an official name**
 * (v1.4.7 `BindOfficial`: a folded-name match rides the wire under the
 * official spelling with the caller's own definition) or is renamed to an
 * opaque `clint_<digest>`; the **full 13-tool official CLI set** is appended
 * from the captured `opencode_tools.json` minus whatever is already served;
 * and **ghost call history is dropped** (calls naming tools this request no
 * longer serves, with their paired results). Each case below is one of the
 * behaviors the shaping must keep.
 *
 * Run: node scripts/fingerprint-test.mjs
 */

import fs from 'node:fs'
import { applyFingerprint, FINGERPRINT_TOOLS, restoreToolName, O2A_PORTED_VERSION } from '../src/upstream.js'
import { clientToolWireName, CLIENT_TOOL_PREFIX } from '../src/o2a/tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER } from '../src/o2a/official-tools.js'

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
/** An official declaration as the shaper itself produces it, for "already correct" cases. */
const official = (style, name) => {
  const body = {}
  applyFingerprint(body, style)
  return body.tools.find(tool => (tool.function?.name ?? tool.name) === name)
}
/** The opaque wire name the shaper gives a client tool. */
const wireNameOf = name => clientToolWireName(name)

console.log('=== 1. client tools bind or rename; the official set completes the wire ===')
{
  const body = { tools: [chatTool('pwsh'), chatTool('Read'), chatTool('write')] }
  const map = applyFingerprint(body, false)
  check('read and shell are declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['read', 'shell'])
  check('no client name survives the wire', declared(body).some(name => !name.startsWith(CLIENT_TOOL_PREFIX) && !V2_OFFICIAL_TOOL_ORDER.includes(name)), false)
  // v1.4.7 BindOfficial: `Read` and `write` fold onto the official spellings
  // and ride the wire under them with the caller's own definitions; `pwsh`
  // has no official and takes the opaque rename.
  check('case variants bind instead of renaming', declared(body).includes(wireNameOf('Read')), false)
  check('Read rides the official read name', declared(body).includes('read'), true)
  check('write binds to itself', declared(body).filter(name => name === 'write').length, 1)
  check('every bound call maps back to the caller spelling', restoreToolName('read', map), 'Read')
  check('the opaque rename still maps back', restoreToolName(wireNameOf('pwsh'), map), 'pwsh')
  check('one binding and one rename were recorded', map.size, 2)
  check('the full official set follows', V2_OFFICIAL_TOOL_ORDER.every(name => declared(body).includes(name)), true)
  const read = body.tools.find(tool => tool.function.name === 'read')
  check('the bound read keeps the caller schema', read.function.parameters.properties.x, { type: 'string' })
  const appendedRead = body.tools.filter(tool => tool.function.name === 'read')
  check('the official read is not appended a second time', appendedRead.length, 1)
  check('official chat tools carry the client strict flag', body.tools.filter(tool => V2_OFFICIAL_TOOL_ORDER.includes(tool.function?.name) && tool.function.strict !== undefined).every(tool => tool.function.strict === false), true)
  check('renamed caller tools keep the caller’s shape', body.tools.find(tool => tool.function.name === wireNameOf('pwsh')).function.strict, undefined)
  check('the model is told the injected tools are placeholders', /placeholders in this session/.test(noteOf(body)), true)
  check('…and no tool_choice is claimed', body.tool_choice, undefined)
}

console.log('\n=== 2. a caller tool reusing a gate name binds to it, not an opaque ===')
{
  const body = { tools: [chatTool('read'), chatTool('read_client'), chatTool('Edit')] }
  const map = applyFingerprint(body, false)
  check('the bound read is singular', body.tools.filter(tool => tool.function.name === 'read').length, 1)
  check('the caller read maps back as itself', restoreToolName('read', map), 'read')
  check('Edit binds to the official edit', declared(body).includes('edit'), true)
  check('the official read is the only read', declared(body).filter(name => name === 'read').length, 1)
  check('the unmatched spelling still renames opaquely', declared(body).includes(wireNameOf('read_client')), true)
  check('no caller name survives unbound', declared(body).slice(0, 3).every(name => name.startsWith(CLIENT_TOOL_PREFIX) || V2_OFFICIAL_TOOL_ORDER.includes(name)), true)
}

console.log('\n=== 3. a caller tool that already carries the official definition is the official declaration ===')
{
  const body = { tools: [official(false, 'read'), official(false, 'shell')] }
  const map = applyFingerprint(body, false)
  check('no duplicate and no rename — kept officials stay, the rest appends', declared(body), ['read', 'shell', ...V2_OFFICIAL_TOOL_ORDER.filter(name => name !== 'read' && name !== 'shell')])
  check('nothing was aliased', map.size, 0)
  check('the note never defames the caller\u2019s own tools', /`read`|`shell`/.test(noteOf(body)), false)
  check('environment context is still supplied', /<env>/.test(noteOf(body)), true)
}

console.log('\n=== 4. duplicate declarations: the first binds, the second renames opaquely ===')
{
  const body = { tools: [chatTool('shell'), chatTool('shell')] }
  applyFingerprint(body, false)
  const shellWires = declared(body).filter(name => name.startsWith(CLIENT_TOOL_PREFIX))
  check('the second copy lands on one opaque name', new Set(shellWires).size, 1)
  check('the official shell is still singular', declared(body).filter(name => name === 'shell').length, 1)
}

console.log('\n=== 5. tool_choice: never none, retargeted to the wire name, auto on Responses ===')
{
  const chat = { tools: [chatTool('write')], tool_choice: 'none' }
  applyFingerprint(chat, false)
  check('a caller none is dropped (the gate refuses it)', chat.tool_choice, undefined)

  const claude = { tools: [claudeTool('write')], tool_choice: { type: 'none' } }
  applyFingerprint(claude, 'claude')
  check('the Messages shape drops it too', claude.tool_choice, undefined)

  const named = { tools: [chatTool('read')], tool_choice: { type: 'function', function: { name: 'read' } } }
  applyFingerprint(named, false)
  check('a choice naming a bound tool keeps the official name', named.tool_choice.function.name, 'read')

  const dangling = { tools: [chatTool('pwsh')], tool_choice: { type: 'function', function: { name: 'ghost_tool' } } }
  applyFingerprint(dangling, false)
  check('a choice naming an unserved tool is dropped (v1.4.7)', dangling.tool_choice, undefined)

  const flat = { tools: [flatTool('write')] }
  applyFingerprint(flat, true)
  check('Responses defaults to auto', flat.tool_choice, 'auto')
}

console.log('\n=== 6. history calls follow the wire name; ghosts are dropped ===')
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'pwsh', arguments: '{}' } }, { id: 'c2', function: { name: 'vanished_tool', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: 'orphan' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => Array.isArray(message.tool_calls))
  check('the prior call follows the wire name', assistant.tool_calls[0].function.name, wireNameOf('pwsh'))
  check('the ghost call is dropped (v1.4.7)', assistant.tool_calls.length, 1)
  const results = body.messages.filter(message => message.role === 'tool')
  check('the orphaned result is dropped with it', results.length, 1)
  check('the kept result keeps its call', results[0].tool_call_id, 'c1')
  check('the caller message object is not mutated in place', assistant.tool_calls.length === 2, false)
}

console.log('\n=== 6b. a bound tool keeps its history under the official name ===')
{
  const body = {
    tools: [chatTool('read')],
    messages: [
      { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => Array.isArray(message.tool_calls))
  check('the bound history call already speaks the wire name', assistant.tool_calls[0].function.name, 'read')
  check('its result survives', body.messages.filter(message => message.role === 'tool').length, 1)
}

console.log('\n=== 6c. an emptied tool_calls field is removed, not forwarded (#787) ===')
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'nothing to call', tool_calls: [] },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('a caller tool_calls: [] is removed', Object.hasOwn(assistant, 'tool_calls'), false)
  check('the rest of the message survives', assistant.content, 'nothing to call')
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'ghost-1', type: 'function', function: { name: 'vanished_tool', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'ghost-1', content: 'orphan' },
    ],
  }
  applyFingerprint(body, false)
  check('a turn whose calls are all ghosts is dropped', body.messages.some(message => message.role === 'assistant'), false)
  check('the orphan result goes with the call', body.messages.filter(message => message.role === 'tool').length, 0)
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      {
        role: 'assistant',
        content: 'still here',
        tool_calls: [{ id: 'ghost-2', type: 'function', function: { name: 'vanished_tool', arguments: '{}' } }],
      },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('a turn with text keeps its row after the field is removed', assistant.content, 'still here')
  check('its emptied tool_calls field is gone', Object.hasOwn(assistant, 'tool_calls'), false)
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'assistant', content: null, tool_calls: [{ id: 'keep-1', type: 'function', function: { name: 'pwsh', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'keep-1', content: 'ok' },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('a served call keeps its array', Array.isArray(assistant.tool_calls), true)
  check('the kept call follows the wire name', assistant.tool_calls[0].function.name, wireNameOf('pwsh'))
  check('the kept result stays paired', body.messages.filter(message => message.role === 'tool').length, 1)
}
{
  const body = {
    tools: [chatTool('pwsh')],
    messages: [
      { role: 'assistant', content: null, tool_calls: [], function_call: { name: 'Bash', arguments: '{}' } },
    ],
  }
  applyFingerprint(body, false)
  const assistant = body.messages.find(message => message.role === 'assistant')
  check('the legacy function_call is retargeted', assistant.function_call?.name, 'shell')
  check('the removed tool_calls array is not carried back', Object.hasOwn(assistant, 'tool_calls'), false)
}

console.log('\n=== 7. the Messages (Claude) shape carries input_schema, not parameters ===')
{
  const body = {}
  applyFingerprint(body, 'claude')
  check('the official set is declared', V2_OFFICIAL_TOOL_ORDER.every(name => declared(body).includes(name)), true)
  check('every declaration uses input_schema', body.tools.every(tool => tool.input_schema?.type === 'object' && tool.function === undefined && tool.parameters === undefined), true)
  check('the read schema is still the official one', body.tools.find(tool => tool.name === 'read').input_schema.required, ['path'])
  check('the placeholder note lands in system', /placeholders in this session/.test(noteOf(body)), true)

  const caller = { tools: [claudeTool('read')] }
  applyFingerprint(caller, 'claude')
  check('a conflicting caller read binds here too', declared(caller).includes('read'), true)
  check('the official read is not duplicated', declared(caller).filter(name => name === 'read').length, 1)
  check('the bound declaration keeps the caller schema', caller.tools.find(tool => tool.name === 'read').description, 'the read tool')
}

console.log('\n=== 8. the Responses (flat) shape carries a flat declaration ===')
{
  const body = {}
  applyFingerprint(body, true)
  check('the official set is declared', V2_OFFICIAL_TOOL_ORDER.every(name => declared(body).includes(name)), true)
  check('the declarations are flat', body.tools.every(tool => tool.function === undefined && typeof tool.name === 'string'), true)
  check('the shell schema is the official one', body.tools.find(tool => tool.name === 'shell').parameters.required, ['command'])
  check('the placeholder note lands in instructions', /placeholders in this session/.test(String(body.instructions)), true)

  const caller = { tools: [flatTool('shell')] }
  applyFingerprint(caller, true)
  check('a conflicting caller shell binds here too', declared(caller).filter(name => name === 'shell').length, 1)
  check('the second spelling is the caller schema, not the capture', caller.tools.find(tool => tool.name === 'shell').description, 'the shell tool')
}

console.log('\n=== 9. the injected definitions are byte-for-byte the official ones ===')
{
  // The gate compares description and parameters, so a reworded copy is a 403
  // even though the name is right. The definitions must equal the captured
  // asset (whose property order the reference also emits — Go serialises its
  // maps alphabetically).
  const captured = JSON.parse(fs.readFileSync(new URL('../src/o2a/assets/opencode_tools.json', import.meta.url), 'utf8'))
  const body = {}
  applyFingerprint(body, false)
  const read = body.tools.find(tool => tool.function.name === 'read').function
  const shell = body.tools.find(tool => tool.function.name === 'shell').function
  check('read equals the captured definition', JSON.stringify({ description: read.description, parameters: read.parameters }), JSON.stringify(captured.read))
  check('shell equals the captured definition (unix host)', shell.description === captured.shell.description, process.platform !== 'win32')
  check('shell schema equals the captured one', JSON.stringify(shell.parameters), JSON.stringify(captured.shell.parameters))
  const win32Shell = captured.shell.description.replace('on Linux using bash', 'on Windows using powershell')
  check('every official tool equals its capture', V2_OFFICIAL_TOOL_ORDER.every(name => {
    const sent = body.tools.find(tool => tool.function.name === name).function
    const wantDescription = name === 'shell' && process.platform === 'win32' ? win32Shell : captured[name].description
    return sent.description === wantDescription && JSON.stringify(sent.parameters) === JSON.stringify(captured[name].parameters)
  }), true)
  check('the gate names are read + shell', [...FINGERPRINT_TOOLS], ['read', 'shell'])
  check('the official order is the captured order', declared(body).slice(-V2_OFFICIAL_TOOL_ORDER.length), V2_OFFICIAL_TOOL_ORDER)
}

console.log('\n=== 10. shaping twice is a no-op (idempotence) ===')
{
  const body = { tools: [chatTool('pwsh')] }
  applyFingerprint(body, false)
  const once = JSON.stringify(body)
  const secondMap = applyFingerprint(body, false)
  check('the second pass changes nothing', JSON.stringify(body), once)
  // A re-shaped body carries only wire names and officials, so the second
  // pass legitimately renames nothing — the payload that ships always decodes
  // with the map from the pass that built it.
  check('the second pass renames nothing', secondMap.size, 0)

  const bound = { tools: [chatTool('Bash'), chatTool('pwsh')] }
  applyFingerprint(bound, false)
  const boundOnce = JSON.stringify(bound)
  applyFingerprint(bound, false)
  check('a bound body reshapes identically', JSON.stringify(bound), boundOnce)
}

console.log('\n=== 10b. title requests ship unshaped (v1.4.7) ===')
{
  const title = {
    messages: [
      { role: 'system', content: 'You generate conversation titles.' },
      { role: 'user', content: 'Generate a title for this conversation: help me fix a build' },
    ],
  }
  const marker = applyFingerprint(title, false)
  check('a title request is left untouched', JSON.stringify(title), JSON.stringify({
    messages: [
      { role: 'system', content: 'You generate conversation titles.' },
      { role: 'user', content: 'Generate a title for this conversation: help me fix a build' },
    ],
  }))
  check('…and renames nothing', marker.size, 0)

  const chat = { messages: [{ role: 'user', content: 'Generate a title for this conversation: hello' }], tools: [chatTool('read')] }
  applyFingerprint(chat, false)
  check('a title-shaped body with tools is still shaped', /opencode, an interactive CLI tool|You are opencode/.test(noteOf(chat)), true)

  const plain = { messages: [{ role: 'user', content: 'hello' }] }
  applyFingerprint(plain, false)
  check('a plain toolless turn is still shaped', /You are opencode/.test(noteOf(plain)), true)
}

console.log('\n=== 11. the port names the release it mirrors ===')
{
  check('the ported reference version is pinned', /^\d+\.\d+\.\d+$/.test(O2A_PORTED_VERSION), true)
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
