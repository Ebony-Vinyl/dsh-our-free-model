/**
 * The free tier's tool fingerprint: four names must be declared, and every one of
 * them must be something the caller can actually execute.
 *
 * The gateway refuses a request that does not declare `bash`, `glob`, `grep` and
 * `read` in `body.tools` (403 FreeTierError), so the plugin fills any gap. Filling
 * it with a decoy is what issue #9's second half is about: dsh names its shell
 * tool `pwsh` on Windows, so `bash` was declared as a tool whose own description
 * said "must not be used" — and models called it anyway, 24 times in one recorded
 * session, every call returning unknown tool. Promoting the real shell into the
 * slot satisfies the same gate and answers the call with a tool that exists.
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

const chatTool = name => ({ type: 'function', function: { name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} } } })
const flatTool = name => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} } })
const declared = body => (body.tools ?? []).map(tool => tool.function?.name ?? tool.name)

console.log('=== 1. the Windows session: pwsh stands in for the bash slot ===')
{
  const body = { tools: [chatTool('pwsh'), chatTool('read'), chatTool('glob'), chatTool('grep')] }
  const map = applyFingerprint(body, false)
  check('all four quartet names are declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['bash', 'glob', 'grep', 'read'])
  check('no decoy was needed', body.tools.filter(tool => tool.function?.description?.includes('must not be used')).map(tool => tool.function.name), [])
  check('the slot carries the real tool description', body.tools.find(tool => tool.function?.name === 'bash')?.function?.description, 'the pwsh tool')
  check('the rename map sends bash back to pwsh', map.get('bash'), 'pwsh')
  check('a model call for bash is executable downstream', restoreToolName('bash', map), 'pwsh')
  check('unrelated names pass through the map untouched', restoreToolName('write', map), 'write')
}

console.log('\n=== 2. the same holds on the flat Responses shape ===')
{
  const body = { tools: [flatTool('pwsh'), flatTool('read'), flatTool('glob'), flatTool('grep')] }
  const map = applyFingerprint(body, true)
  check('quartet declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['bash', 'glob', 'grep', 'read'])
  check('pwsh promoted, not duplicated', declared(body).filter(name => name === 'pwsh' || name === 'bash'), ['bash'])
  check('map restored', restoreToolName('bash', map), 'pwsh')
}

console.log('\n=== 3. a real bash wins over the donor, and nothing is duplicated ===')
{
  const body = { tools: [chatTool('bash'), chatTool('pwsh')] }
  const map = applyFingerprint(body, false)
  check('bash stays bash', declared(body).filter(n => n === 'bash' || n === 'pwsh'), ['bash', 'pwsh'])
  check('bash is not remapped to pwsh', map.has('bash'), false)
  const cased = { tools: [chatTool('Bash'), chatTool('Grep'), chatTool('Glob'), chatTool('Read')] }
  const casedMap = applyFingerprint(cased, false)
  check('case variants are canonicalised once, not duplicated', declared(cased), ['bash', 'grep', 'glob', 'read'])
  check('…and each is restored to the caller spelling', ['bash', 'grep', 'glob', 'read'].map(name => restoreToolName(name, casedMap)), ['Bash', 'Grep', 'Glob', 'Read'])
}

console.log('\n=== 4. with nothing to promote, the decoy still clears the gate ===')
{
  const body = { tools: [chatTool('browser_navigate')] }
  const map = applyFingerprint(body, false)
  check('every quartet name is still declared', FINGERPRINT_TOOLS.filter(name => declared(body).includes(name)), ['bash', 'glob', 'grep', 'read'])
  check('the four decoys say what they are', body.tools.filter(tool => tool.function?.description?.includes('must not be used')).map(tool => tool.function.name), ['bash', 'glob', 'grep', 'read'])
  check('a decoy is not in the rename map, so it is never called a real tool', map.has('bash'), false)
}

console.log('\n=== 5. a caller with no tools at all ===')
{
  const body = {}
  applyFingerprint(body, false)
  check('the gate is still satisfied', FINGERPRINT_TOOLS.every(name => declared(body).includes(name)), true)
  check('and no tool_choice is claimed', body.tool_choice, 'none')
  const withTools = { tools: [chatTool('write')] }
  applyFingerprint(withTools, false)
  check('a caller that brought tools keeps tool_choice unset so the model decides', withTools.tool_choice, undefined)
}

// Messages 使用自己的工具结构，不能把 Chat 的 function 包装发到上游。
console.log('\n=== 6. Messages 工具指纹和 Windows Shell 回译 ===')
{
  const body = {}
  applyFingerprint(body, 'claude')
  check('Messages 无工具时仍声明四个指纹工具', declared(body), ['bash', 'glob', 'grep', 'read'])
  check('Messages 无工具时禁止工具选择', body.tool_choice, { type: 'none' })
  check('Messages 补齐工具使用 input_schema', body.tools.every(tool => tool.input_schema?.type === 'object' && tool.function === undefined && tool.parameters === undefined), true)

  const claudeTool = name => ({ name, description: `the ${name} tool`, input_schema: { type: 'object', properties: { command: { type: 'string' } } } })
  const partial = { tools: [claudeTool('read')] }
  applyFingerprint(partial, 'claude')
  check('Messages 部分工具只补缺项', declared(partial).filter(name => name === 'read').length, 1)
  check('Messages 部分工具补齐四个指纹工具', FINGERPRINT_TOOLS.every(name => declared(partial).includes(name)), true)
  check('Messages 调用者携带工具时保留自主工具选择', partial.tool_choice, undefined)

  const original = claudeTool('pwsh')
  const promoted = { tools: [original, claudeTool('read'), claudeTool('glob'), claudeTool('grep')] }
  const map = applyFingerprint(promoted, 'claude')
  check('Messages 的 pwsh 推广为 bash', declared(promoted), ['bash', 'read', 'glob', 'grep'])
  check('Messages 推广保留真实 Shell 的 schema', promoted.tools[0].input_schema, original.input_schema)
  check('Messages 推广保留真实 Shell 的描述', promoted.tools[0].description, 'the pwsh tool')
  check('Messages 工具名能回译为 pwsh', restoreToolName('bash', map), 'pwsh')
  check('Messages 推广不增加假 Shell', promoted.tools.some(tool => tool.description?.includes('must not be used')), false)
}

console.log('\n=== 7. the gate reads a tool as declared only with a real property ===')
{
  // Measured 2026-10-14: `bash` + `read` with `properties: {}` are refused
  // (403 FreeTierError) exactly like an undeclared name, so a decoy has to carry
  // one property and a caller tool that declares none has to be stamped.
  const propertiesOf = tool => (tool.function?.parameters ?? tool.parameters ?? tool.input_schema)?.properties ?? {}
  const decoys = {}
  applyFingerprint(decoys, false)
  check('every decoy declares a property', decoys.tools.every(tool => Object.keys(propertiesOf(tool)).length > 0), true)
  check('bash and read both declare one', ['bash', 'read'].map(name => Object.keys(propertiesOf(decoys.tools.find(tool => tool.function.name === name))).length > 0), [true, true])

  const caller = { tools: [chatTool('bash')] }
  applyFingerprint(caller, false)
  check('a caller bash with an empty schema is stamped, not duplicated', caller.tools.filter(tool => tool.function.name === 'bash').length, 1)
  check('…and keeps the caller description', caller.tools.find(tool => tool.function.name === 'bash').function.description, 'the bash tool')
  check('…and now declares a property', Object.keys(propertiesOf(caller.tools.find(tool => tool.function.name === 'bash'))).length > 0, true)

  const claudeDecoys = {}
  applyFingerprint(claudeDecoys, 'claude')
  check('Messages decoys declare a property too', claudeDecoys.tools.every(tool => Object.keys(propertiesOf(tool)).length > 0), true)
}

console.log(failures === 0 ? '\nall fingerprint checks passed' : `\n${failures} fingerprint check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
