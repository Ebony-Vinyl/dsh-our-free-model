import assert from 'node:assert/strict'
import { applyFingerprint, restoreToolName } from '../src/upstream.js'
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
  assert.equal(map.get('conversation_delegate2'), 'subagent_fork')
  assert.equal(map.get('workspace_directory2'), 'working_directory')
  assert.equal(restoreToolName('conversation_delegate2', map), 'subagent_fork')
  assert.equal(restoreToolName('workspace_directory2', map), 'working_directory')
  assert.equal(restoreToolName('read_image', map), 'read_image')
  const definitions = body.tools.map(t => t.function ?? t)
  assert.equal(definitions.length, names.length + 2) // only existing official read/shell injection
  assert.equal(new Set(definitions.map(t => t.name)).size, definitions.length)
  assert.ok(!definitions.some(t => t.name === 'subagent_fork' || t.name === 'working_directory'))
  for (const [wire, source] of [['conversation_delegate2', 'subagent_fork'], ['workspace_directory2', 'working_directory']]) {
    const t = definitions.find(t => t.name === wire)
    assert.equal(t.description, `Caller ${source}`)
    assert.deepEqual(t.parameters ?? t.input_schema, schema)
  }
  assert.deepEqual(tools, original, 'caller definitions must not be mutated')
  if (style === true) {
    assert.equal(body.input[0].name, 'conversation_delegate2')
    assert.equal(body.input[1].call_id, 'call1')
    assert.equal(body.input[1].output, 'result')
    assert.equal(body.tool_choice.name, 'conversation_delegate2')
    assert.ok(body.instructions.startsWith('Preserve caller instructions'))
  } else if (style === 'claude') {
    assert.equal(body.messages[0].content[0].name, 'workspace_directory2')
    assert.equal(body.messages[1].content[0].tool_use_id, 'call1')
    assert.equal(body.tool_choice.name, 'workspace_directory2')
    assert.equal(body.system[0].text, 'Preserve caller instructions')
  } else {
    const history = body.messages.find(m => m.tool_calls)
    assert.equal(history.tool_calls[0].function.name, 'workspace_directory2')
    assert.deepEqual(history.content, [])
    assert.equal(body.messages.at(-1).tool_call_id, 'call1')
    assert.equal(body.messages.at(-1).content, 'result')
    assert.equal(body.tool_choice.function.name, 'workspace_directory2')
  }
  console.log('PASS aliases, collisions, schema preservation, tool choice, history/result pairing:', style)
}
const untouched = { tools: [{ type: 'function', function: { name: 'unrelated_tool', parameters: schema, description: 'original' } }] }
applyFingerprint(untouched, false)
assert.equal(untouched.tools[0].function.name, 'unrelated_tool')
console.log('PASS unrelated tool names unchanged')

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
    assert.ok(payload.tools.some(t => t.function?.name === 'workspace_directory'))
    assert.ok(!payload.tools.some(t => t.function?.name === 'working_directory'))
    const frames = [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call1', type: 'function', function: { name: 'workspace_directory', arguments: '{}' } }] }, finish_reason: null }] },
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
