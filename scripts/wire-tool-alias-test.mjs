import assert from 'node:assert/strict'
import { applyFingerprint, restoreToolName } from '../src/upstream.js'
import { clientToolWireName } from '../src/o2a/tool-renames.js'
import { V2_OFFICIAL_TOOL_ORDER } from '../src/o2a/official-tools.js'

/** The opaque wire names the shaper gives the caller tools under test. */
const WIRE = Object.fromEntries(['subagent_fork', 'working_directory', 'read_image'].map(name => [name, clientToolWireName(name)]))
const schema = { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] }
const names = ['subagent_fork', 'working_directory', 'read_image', 'conversation_delegate', 'workspace_directory']
for (const style of [false, true, 'claude']) {
  const tools = names.map(name => style === true
    ? { type: 'function', name, description: `Caller ${name}`, parameters: schema }
    : style === 'claude' ? { name, description: `Caller ${name}`, input_schema: schema }
      : { type: 'function', function: { name, description: `Caller ${name}`, parameters: schema } })
  const original = structuredClone(tools)
  const body = { tools }
  if (style === true) {
    body.instructions = 'Preserve caller instructions'
    body.input = [{ type: 'function_call', call_id: 'call1', name: 'subagent_fork', arguments: '{"prompt":"x"}' }, { type: 'function_call_output', call_id: 'call1', output: 'result' }]
    body.tool_choice = { type: 'function', name: 'subagent_fork' }
  } else if (style === 'claude') {
    body.system = [{ type: 'text', text: 'Preserve caller instructions' }]
    body.messages = [{ role: 'assistant', content: [{ type: 'tool_use', id: 'call1', name: 'working_directory', input: { prompt: 'x' } }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'result' }] }]
    body.tool_choice = { type: 'tool', name: 'working_directory' }
  } else {
    body.messages = [{ role: 'system', content: 'Preserve caller instructions' }, { role: 'assistant', content: [], tool_calls: [{ id: 'call1', type: 'function', function: { name: 'working_directory', arguments: '{"prompt":"x"}' } }] }, { role: 'tool', tool_call_id: 'call1', content: 'result' }]
    body.tool_choice = { type: 'function', function: { name: 'working_directory' } }
  }
  const map = applyFingerprint(body, style)
  assert.equal(map.get(WIRE.subagent_fork), 'subagent_fork')
  assert.equal(map.get(WIRE.working_directory), 'working_directory')
  assert.equal(restoreToolName(WIRE.subagent_fork, map), 'subagent_fork')
  assert.equal(restoreToolName(WIRE.working_directory, map), 'working_directory')
  // The vocabulary gate is opaque-name based, so read_image rides along with
  // the two names the 2026-10-30 probe pinned — everything is renamed.
  assert.equal(restoreToolName(WIRE.read_image, map), 'read_image')
  const definitions = body.tools.map(t => t.function ?? t)
  assert.equal(definitions.length, names.length + V2_OFFICIAL_TOOL_ORDER.length) // renamed callers + full official set
  assert.equal(new Set(definitions.map(t => t.name)).size, definitions.length)
  assert.ok(!definitions.some(t => t.name === 'subagent_fork' || t.name === 'working_directory'))
  for (const [wire, source] of [[WIRE.subagent_fork, 'subagent_fork'], [WIRE.working_directory, 'working_directory']]) {
    const t = definitions.find(t => t.name === wire)
    assert.equal(t.description, `Caller ${source}`)
    assert.deepEqual(t.parameters ?? t.input_schema, schema)
  }
  assert.deepEqual(tools, original, 'caller definitions must not be mutated')
  if (style === true) {
    assert.equal(body.input[0].name, WIRE.subagent_fork)
    assert.equal(body.input[1].call_id, 'call1')
    assert.equal(body.input[1].output, 'result')
    assert.equal(body.tool_choice.name, WIRE.subagent_fork)
    // OFM context precedes the preserved caller instructions.
    assert.ok(body.instructions.startsWith("You are assisting with a user's software project through OFM."))
    assert.ok(body.instructions.includes('Preserve caller instructions'))
  } else if (style === 'claude') {
    assert.equal(body.messages[0].content[0].name, WIRE.working_directory)
    assert.equal(body.messages[1].content[0].tool_use_id, 'call1')
    assert.equal(body.tool_choice.name, WIRE.working_directory)
    // OFM context occupies its own block; the caller block follows.
    assert.equal(body.system[0].text.startsWith("You are assisting with a user's software project through OFM."), true)
    assert.equal(body.system[1].text, 'Preserve caller instructions')
  } else {
    const history = body.messages.find(m => m.tool_calls)
    assert.equal(history.tool_calls[0].function.name, WIRE.working_directory)
    assert.deepEqual(history.content, [])
    assert.equal(body.messages.at(-1).tool_call_id, 'call1')
    assert.equal(body.messages.at(-1).content, 'result')
    assert.equal(body.tool_choice.function.name, WIRE.working_directory)
  }
  console.log('PASS aliases, collisions, schema preservation, tool choice, history/result pairing:', style)
}
const untouched = { tools: [{ type: 'function', function: { name: 'unrelated_tool', parameters: schema, description: 'original' } }] }
const untouchedMap = applyFingerprint(untouched, false)
assert.equal(untouched.tools[0].function.name, clientToolWireName('unrelated_tool'))
assert.equal(restoreToolName(clientToolWireName('unrelated_tool'), untouchedMap), 'unrelated_tool')
console.log('PASS unrelated tool names renamed opaquely and restored')

// Exercise the real adapter decoder, not just restoreToolName in isolation.
const fs = await import('node:fs')
const os = await import('node:os')
const path = await import('node:path')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-wire-alias-'))
const oldHome = process.env.DSH_HOME
const oldMode = process.env.OUR_FREE_MODEL_FREE_TRANSPORT
const oldFetch = globalThis.fetch
process.env.DSH_HOME = scratch
process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'node'
try {
  const { FreeModelAdapter } = await import('../src/adapter.js')
  const { buildCatalog } = await import('../src/catalog.js')
  const model = 'deepseek-v4.1-flash-free'
  const catalog = buildCatalog([model])
  const snapshot = { catalog, membership: {}, settings: { enabled: true, streamRecovery: false } }
  const adapter = new FreeModelAdapter({ state: () => snapshot, recordUsage() {} })
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body)
    assert.ok(payload.tools.some(t => t.function?.name === WIRE.working_directory))
    assert.ok(!payload.tools.some(t => t.function?.name === 'working_directory'))
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: WIRE.working_directory, arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ].map(j => 'data: ' + JSON.stringify(j) + '\n\n').join('') + 'data: [DONE]\n\n'
    return new Response(frames, { headers: { 'content-type': 'text/event-stream' } })
  }
  const chunks = []
  for await (const chunk of adapter.runSingle({ model, messages: [{ role: 'user', content: [{ type: 'text', text: 'Check directory' }] }], tools: [{ name: 'working_directory', description: 'Read or change directory', parameters: { type: 'object', properties: {} } }], sessionId: 'wire-alias-offline', signal: AbortSignal.timeout(5000) }, catalog[0], snapshot)) chunks.push(chunk)
  const tool = chunks.find(c => c.block?.type === 'tool-call')?.block
  assert.ok(tool, 'adapter must emit the actual tool call')
  assert.equal(tool.name, 'working_directory')
  assert.equal(tool.id, 'call1')
  assert.equal(tool.arguments, '{}')
  console.log('PASS actual adapter streaming tool-call name restored for host dispatch')
} finally {
  globalThis.fetch = oldFetch
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  if (oldMode === undefined) delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT; else process.env.OUR_FREE_MODEL_FREE_TRANSPORT = oldMode
  fs.rmSync(scratch, { recursive: true, force: true })
}
