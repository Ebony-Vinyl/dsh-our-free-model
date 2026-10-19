/**
 * Anggaran ukuran body jalur gratis (400 ModelProtocolUnsupported).
 *
 * Diukur 2026-10-19: 699.974 byte lolos, 765.000 byte ditolak, dengan model
 * dan riwayat yang sama. Yang berubah hanya ukuran daftar tool. Tes ini
 * memastikan pemangkasan menurunkan body tanpa membuang tool lebih dulu, dan
 * hanya menjatuhkan tool saat percakapan sendiri sudah mendekati plafon.
 *
 * Run: node scripts/request-budget-test.mjs
 */
import { applyRequestBudget, payloadBytes, DEFAULT_REQUEST_BUDGET_BYTES } from '../src/request-budget.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

/** A schema deep enough that depth limiting has something to remove. */
function deepSchema(levels = 8) {
  const leaf = { type: 'string', description: 'x'.repeat(1200) }
  let node = leaf
  for (let index = 0; index < levels; index += 1) {
    node = {
      type: 'object',
      description: 'level '.repeat(20),
      properties: { [`level${index}`]: node, sibling: { type: 'number' } },
      required: [`level${index}`],
      additionalProperties: false,
    }
  }
  return node
}

/** Roughly the shape Zed sends: 227 tools, each with a fat nested schema. */
function zedShapedBody() {
  const tools = []
  for (let index = 0; index < 227; index += 1) {
    tools.push({
      type: 'function',
      function: {
        name: `tool_${index}`,
        description: `Tool number ${index}. `.repeat(30),
        parameters: {
          type: 'object',
          properties: {
            input: deepSchema(8),
            mode: { type: 'string', enum: ['fast', 'slow', 'auto'] },
          },
          required: ['input'],
          additionalProperties: false,
        },
      },
    })
  }
  return {
    model: 'deepseek-v4.1-flash-free',
    messages: [
      { role: 'system', content: 's'.repeat(20000) },
      { role: 'user', content: 'u'.repeat(120000) },
    ],
    tools,
    stream: true,
    max_tokens: 32768,
    temperature: 1,
    reasoning_effort: 'high',
  }
}

// --- 1. A payload already inside the budget is untouched. ---
{
  const body = {
    model: 'deepseek-v4.1-flash-free',
    messages: [{ role: 'user', content: 'halo' }],
    tools: [{ type: 'function', function: { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }],
  }
  const before = JSON.stringify(body)
  const report = applyRequestBudget(body, { budgetBytes: DEFAULT_REQUEST_BUDGET_BYTES })
  check('small body is not trimmed', report.trimmed, false)
  check('small body is byte-identical', JSON.stringify(body), before)
}

// --- 2. The real shape: over budget, and tools survive. ---
{
  const body = zedShapedBody()
  const before = payloadBytes(body)
  check('fixture starts above the proven-failing size', before > 765000, true)

  const originalTool = body.tools[0]
  const originalDescription = originalTool.function.description
  const report = applyRequestBudget(body, { budgetBytes: DEFAULT_REQUEST_BUDGET_BYTES })
  const after = payloadBytes(body)

  check('trimmed', report.trimmed, true)
  check('fits the budget', report.fits, true)
  check('after is under the budget', after <= DEFAULT_REQUEST_BUDGET_BYTES, true)
  check('after is reported accurately', report.after, after)
  check('every tool is still declared', body.tools.length, 227)
  check('no tool was dropped', report.toolsDropped, 0)
  check('the caller declaration is not mutated', originalTool.function.description === originalDescription, true)
  check('top-level descriptions are capped', body.tools.every(tool => tool.function.description.length <= 200), true)

  // Structure survives near the root; only deep tails collapse.
  const input = body.tools[0].function.parameters.properties.input
  check('root properties survive', Object.hasOwn(input.properties ?? {}, 'level7'), true)
  let node = input
  let levels = 0
  while (node?.properties && Object.keys(node.properties).length > 0 && levels < 32) {
    const child = Object.values(node.properties).find(value => value && value.properties !== undefined)
    if (child === undefined) break
    node = child
    levels += 1
  }
  check('the schema tail is cut within MAX_DEPTH', levels <= 6, true)
  check('required survives', Array.isArray(input.required), true)
}

// --- 3. Flat and Claude tool spellings. ---
{
  const flat = {
    model: 'x',
    messages: [{ role: 'user', content: 'y'.repeat(300000) }],
    tools: [
      { type: 'function', name: 'flat_tool', description: 'd'.repeat(1000), parameters: deepSchema(9) },
    ],
  }
  const report = applyRequestBudget(flat, { budgetBytes: 302000 })
  check('flat spelling is trimmed', report.trimmed, true)
  check('flat tool survives', flat.tools.length, 1)
  check('flat parameters still an object', typeof flat.tools[0].parameters, 'object')

  const claude = {
    model: 'x',
    messages: [{ role: 'user', content: 'y'.repeat(300000) }],
    tools: [
      { name: 'claude_tool', description: 'd'.repeat(1000), input_schema: deepSchema(9) },
    ],
  }
  const claudeReport = applyRequestBudget(claude, { budgetBytes: 302000 })
  check('claude spelling is trimmed', claudeReport.trimmed, true)
  check('claude tool survives', claude.tools.length, 1)
  check('claude input_schema still an object', typeof claude.tools[0].input_schema, 'object')
}

// --- 4. Last resort: the conversation alone is near the ceiling. ---
{
  const body = {
    model: 'x',
    messages: [{ role: 'user', content: 'z'.repeat(654000) }],
    tools: Array.from({ length: 20 }, (_, index) => ({
      type: 'function',
      function: { name: `tool_${index}`, description: 'd'.repeat(800), parameters: { type: 'object', properties: { v: { type: 'string' } } } },
    })),
  }
  const report = applyRequestBudget(body, { budgetBytes: 655360 })
  check('last resort drops tools', report.toolsDropped > 0, true)
  check('last resort still fits', report.fits, true)
  check('dropped tools are really gone', body.tools.length < 20, true)
}

// --- 5. Bytes, not UTF-16 units. ---
{
  const text = '漢'.repeat(1000)
  check('payloadBytes counts UTF-8 bytes', payloadBytes({ text }), Buffer.byteLength(JSON.stringify({ text }), 'utf8'))
  check('payloadBytes exceeds .length for CJK', payloadBytes({ text }) > JSON.stringify({ text }).length, true)
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall request-budget checks passed')
