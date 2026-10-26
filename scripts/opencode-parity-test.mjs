/**
 * The OpenCode v2 fingerprint exists twice — once in this plugin's own free lane
 * (`src/upstream.js`) and once in the vendored channel pack
 * (`vendor/channel-pack/src/opencode*.ts`), because the pack is upstream's code
 * and cannot import ours. Two copies of a fingerprint that must be
 * byte-identical is exactly the shape that rots: one side gets the next upstream
 * change and the other keeps answering 403 FreeTierError.
 *
 * This suite is the drift guard. It imports both implementations and asserts
 * they agree on the four things the gate reads: the tool names, the tool
 * definitions themselves, the User-Agent, and the header set (including the v1
 * header neither may send).
 *
 * Run: node scripts/opencode-parity-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'

const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const undiciStub = new URL('./lib/undici-stub.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
    if (specifier === 'undici') return { url: undiciStub, shortCircuit: true }
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
      const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (fs.existsSync(target)) return { url: target.href, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot) && url.endsWith('.ts')) return {
      format: 'module', shortCircuit: true,
      source: stripTypeScriptTypes(fs.readFileSync(fileURLToPath(url), 'utf8'), { mode: 'transform', sourceUrl: url }),
    }
    return nextLoad(url, context)
  },
})

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       got      ${JSON.stringify(actual)}\n       expected ${JSON.stringify(expected)}`}`)
}

try {
  const up = await import('../src/upstream.js')
  const messages = await import('../vendor/channel-pack/src/opencode-messages.ts')
  const product = await import('../vendor/channel-pack/src/opencode-product.ts')
  const identity = await import('../vendor/channel-pack/src/opencode.ts')

  const chatShape = tools => tools.map(tool => tool.function ?? tool)
  const laneBody = {}
  up.applyFingerprint(laneBody, false)
  const laneTools = chatShape(laneBody.tools)
  const packBody = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }] }).payload
  const packTools = chatShape(packBody.tools)

  console.log('=== 1. the gate names agree ===')
  check('gate names', [...messages.FREE_LANE_GATE_TOOLS], [...up.FINGERPRINT_TOOLS])
  check('the pack injects both', packTools.map(tool => tool.name), ['read', 'shell'])
  check('the lane injects both', laneTools.map(tool => tool.name), ['read', 'shell'])

  console.log('\n=== 2. the injected definitions are identical, verbatim ===')
  for (const name of ['read', 'shell']) {
    const lane = laneTools.find(tool => tool.name === name)
    const pack = packTools.find(tool => tool.name === name)
    check(`${name}: description`, pack.description, lane.description)
    check(`${name}: parameters`, JSON.stringify(pack.parameters), JSON.stringify(lane.parameters))
  }

  console.log('\n=== 3. the User-Agent is the same canonical v2 token ===')
  check('the lane sends the v2 token', up.CLIENT_UA, 'opencode/latest/2.0.26/cli')
  check('the pack defaults to the same token', product.OPENCODE.defaultUserAgent, up.CLIENT_UA)
  check('a detected v1 install version is refused', identity.opencodeUserAgentForVersion('1.18.31'), undefined)
  check('a detected v2 install version becomes the v2 shape', identity.opencodeUserAgentForVersion('2.0.29'), 'opencode/latest/2.0.29/cli')
  check('an arbitrary UA override falls back to the token', identity.opencodeUserAgent('opencode/1.18.31'), up.CLIENT_UA)
  check('a v2 override passes through', identity.opencodeUserAgent('opencode/latest/2.0.29/desktop'), 'opencode/latest/2.0.29/desktop')

  console.log('\n=== 4. the header sets agree, and neither sends the v1 request header ===')
  const session = 'ses_0123456789abABCDEFGHIJKLMN'
  const laneHeaders = up.gatewayHeaders({ session, stream: true })
  const packHeaders = identity.opencodeHeaders({ projectId: 'a'.repeat(40), generation: 1 }, session, up.CLIENT_UA)
  for (const name of ['x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id']) {
    check(`both send ${name}`, [laneHeaders[name], packHeaders[name]], [session, session])
  }
  check('both report the cli client', [laneHeaders['x-opencode-client'], packHeaders['x-opencode-client']], ['cli', 'cli'])
  check('both carry the v2 UA', [laneHeaders['user-agent'], packHeaders['user-agent']], [up.CLIENT_UA, up.CLIENT_UA])
  check('neither sends x-opencode-request', ['x-opencode-request' in laneHeaders, 'x-opencode-request' in packHeaders], [false, false])

  console.log('\n=== 5. the channel pack lists the free models this change added ===')
  const free = new Map(product.OPENCODE_FALLBACK_MODELS.map(model => [model.id, model]))
  check('deepseek-v4.1-flash-free is free and reachable', [free.has('deepseek-v4.1-flash-free'), free.get('deepseek-v4.1-flash-free')?.isFree], [true, true])
  check('glm-5.3-flash-free is free and reachable', [free.has('glm-5.3-flash-free'), free.get('glm-5.3-flash-free')?.isFree], [true, true])
  check('both carry a positive context window', [free.get('deepseek-v4.1-flash-free').contextWindow > 0, free.get('glm-5.3-flash-free').contextWindow > 0], [true, true])

  console.log('\n=== 6. a caller tool on a gate name is aliased on both sides ===')
  const conflict = { type: 'function', function: { name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } } }
  const laneConflict = { tools: [conflict] }
  const laneMap = up.applyFingerprint(laneConflict, false)
  check('the lane aliases it', up.restoreToolName('read_client', laneMap), 'read')
  const packConflict = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } }] })
  check('the pack aliases it', packConflict.toolNameMap.get('read_client'), 'read')
  check('the pack keeps one official read', packConflict.payload.tools.filter(tool => tool.function?.name === 'read').length, 1)

  // The alias has to reach the conversation history too, not just the declaration
  // list: the model reads its own earlier `read` call as a call to the official
  // tool of that name otherwise, and the two definitions disagree. Both sides
  // must rewrite the same rows — this is the drift the suite exists to catch.
  console.log('\n=== 6b. an aliased tool is renamed in the history on both sides ===')
  const history = [
    { role: 'user', content: 'do it' },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]
  const laneHistory = { tools: [conflict], messages: JSON.parse(JSON.stringify(history)) }
  up.applyFingerprint(laneHistory, false)
  const laneName = laneHistory.messages.find(message => Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
  check('the lane rewrites the prior call', laneName, 'read_client')
  const packHistory = messages.buildOpencodePayloadWithToolMap({ model: 'big-pickle', messages: JSON.parse(JSON.stringify(history)), tools: [{ name: 'read', description: 'the caller read', parameters: { type: 'object', properties: { x: { type: 'string' } } } }] })
  const packName = packHistory.payload.messages.find(message => Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
  check('the pack rewrites the prior call', packName, 'read_client')
  check('both sides agree on the history spelling', packName, laneName)

  console.log('\n=== 7. neither side sends tool_choice none ===')
  const laneNone = { tools: [], tool_choice: 'none' }
  up.applyFingerprint(laneNone, false)
  check('the lane drops it', laneNone.tool_choice, undefined)
  const packNone = messages.ensureFreeLaneShape({ messages: [{ role: 'user', content: 'hi' }], tools: [], tool_choice: 'none' })
  check('the pack drops it', packNone.tool_choice, undefined)

  console.log('\n=== 8. the channel pack clamps an effort onto the model\'s declared levels ===')
  const adapter = await import('../vendor/channel-pack/src/opencode-adapter.ts')
  const cap = (id, efforts) => ({ id, name: id, modalities: ['text'], contextWindow: 200000, maxOutputTokens: 64000, reasoning: efforts.length > 0, efforts, toolCall: true, isFree: true })
  const deepseek = cap('deepseek-v4.1-flash-free', ['low', 'high', 'max'])
  const toggleOnly = cap('longcat-2.5-preview-free', [])
  check('a declared level goes out unchanged', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'high', [deepseek]), { effort: 'high', outcome: 'exact' })
  // xhigh(7) is nearest to max(8) among low(3)/high(5)/max(8).
  check('an undeclared level lands on the nearest declared one', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'xhigh', [deepseek]), { effort: 'max', outcome: 'mapped' })
  // medium(4) sits between low(3) and high(5); the ladder breaks the tie upward.
  check('a tie resolves to the stronger level', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', 'medium', [deepseek]), { effort: 'high', outcome: 'mapped' })
  check('a model that declares no menu drops the field', adapter.resolveOpencodeEffort('longcat-2.5-preview-free', 'low', [toggleOnly]), { outcome: 'dropped' })
  check('an unknown model passes the caller value through', adapter.resolveOpencodeEffort('never-seen', 'high', []), { effort: 'high', outcome: 'passthrough' })
  check('no effort asked for, nothing sent', adapter.resolveOpencodeEffort('deepseek-v4.1-flash-free', undefined, [deepseek]), { outcome: 'passthrough' })
} finally {
  hooks.deregister()
}

console.log(failures === 0 ? '\nall opencode parity checks passed' : `\n${failures} opencode parity check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
