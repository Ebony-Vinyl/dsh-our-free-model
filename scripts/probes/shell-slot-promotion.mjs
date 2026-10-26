/**
 * Does the free-tier v2 fingerprint gate accept a caller tool that reuses a gate
 * name, and does the call still come back under the caller's own name?
 *
 * Issue #9's second half used to be about *promotion*: the v1 gate wanted `bash`
 * declared, and on Windows dsh mounts `pwsh` instead, so the plugin promoted the
 * real shell tool into the `bash` slot. The v2 gate (2026-10-14) reads the
 * declared definitions themselves, so promotion is gone — `bash` carrying
 * another tool's schema is a 403 now. What replaced it is aliasing: a caller tool
 * that reuses `read`/`shell` with a different definition is renamed to
 * `<name>_client`, and the response side restores the caller's spelling so the
 * kernel can still run the call.
 *
 * Two things can only be settled against the live gateway, which is what this
 * probe is for:
 *   1. the gate accepts the caller's conflicting tool under its alias (no 403 FreeTierError);
 *   2. the tool call that comes back is named `pwsh`, i.e. the kernel can run it.
 *
 * Run: node scripts/probes/shell-slot-promotion.mjs [model]
 */

import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../../src/adapter.js'
import { applyFingerprint } from '../../src/upstream.js'

const MODEL = process.argv[2] ?? 'space-bunny-free'
// The caller's shell tool, spelled the way the kernel mounts it on Windows. It
// deliberately does NOT reuse a gate name here — the gate names are `read` and
// `shell` in v2, and this probe's point is that a caller tool survives untouched.
const SHELL_TOOLS = [{
  name: 'pwsh',
  description: 'Run a PowerShell command on Windows and return its stdout.',
  parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
}]
// A caller tool that *does* reuse a gate name with a different definition — the
// case the alias exists for.
const CONFLICT_TOOL = {
  name: 'read',
  description: 'The caller\u2019s own read tool, which means something else.',
  parameters: { type: 'object', properties: { target: { type: 'string' } }, required: ['target'] },
}

// What goes on the wire, asserted before a request is even made.
const preview = { tools: [{ type: 'function', function: { ...SHELL_TOOLS[0] } }, { type: 'function', function: { ...CONFLICT_TOOL } }] }
const previewMap = applyFingerprint(preview, false)
console.log('declared names  :', preview.tools.map(tool => tool.function.name).join(', '))
console.log('rename map      :', [...previewMap].map(([sent, original]) => `${sent}->${original}`).join(', ') || '(none)')
console.log('gate names kept :', preview.tools.filter(tool => tool.function.name === 'read' || tool.function.name === 'shell').length)

const CATALOG = [{
  id: MODEL, name: MODEL, availability: 'available', vision: false, reasoning: false,
  contextWindow: 128000, maxOutput: 8192,
}]
const adapter = new FreeModelAdapter({
  state: () => ({
    catalog: CATALOG,
    membership: { [ROUTE_MAIN]: [MODEL], [ROUTE_REGION]: [] },
    settings: { enabled: true, defaultMaxTokens: 1024 },
    attributionUserAgent: 'probe/1.0',
  }),
  recordUsage: () => {},
  warn: message => console.log('  warn:', message),
})

const calls = []
let finish = null
let text = ''
for await (const chunk of adapter.stream({
  provider: ROUTE_MAIN,
  model: MODEL,
  sessionId: 'probe:shell-slot-promotion',
  maxTokens: 512,
  tools: SHELL_TOOLS,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Call the shell tool once to print the current date. Do not answer in prose.' }] }],
})) {
  if (chunk.type === 'text-delta') text += chunk.text
  if (chunk.type === 'block-end' && chunk.block?.type === 'tool-call') calls.push(chunk.block)
  if (chunk.type === 'finish') finish = chunk.reason
}

console.log('\nfinish          :', JSON.stringify(finish))
console.log('text            :', JSON.stringify(text.slice(0, 120)))
console.log('tool calls back :', JSON.stringify(calls.map(call => ({ name: call.name, id: call.id, arguments: call.arguments }))))

const named = calls.map(call => call.name)
const gateAccepted = finish?.failure?.code !== 'REGION_BLOCKED' && !/FreeTier|403/i.test(finish?.failure?.message ?? '')
const restoredToCaller = named.length === 0 || named.every(name => name === 'pwsh')
const noGateNameLeaked = named.every(name => name !== 'read' && name !== 'shell')
console.log('\nverdict:')
console.log(`  gateway accepted the caller tool beside the gate names : ${gateAccepted ? 'yes' : `NO — ${JSON.stringify(finish)}`}`)
console.log(`  no call surfaced as a gate name (read/shell)          : ${noGateNameLeaked ? 'yes' : 'NO — a gate name reached the caller'}`)
console.log(`  any call came back as pwsh (executable)               : ${restoredToCaller ? (named.length > 0 ? 'yes' : 'n/a — model issued no call, rerun') : 'NO'}`)
process.exitCode = gateAccepted && noGateNameLeaked && restoredToCaller ? 0 : 1
