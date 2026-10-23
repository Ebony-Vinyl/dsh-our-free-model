/** Exercise the actual TypeScript gateway converters without host services or network. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import { fileURLToPath } from 'node:url'
const sourceRoot = new URL('../vendor/channel-pack/src/', import.meta.url).href
const kernel = new URL('./lib/channel-pack-kernel.mjs', import.meta.url).href
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@deepseek-ai/')) return { url: kernel, shortCircuit: true }
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
try {
  const { toGenerateOptions } = await import('../vendor/channel-pack/src/openai-gateway/messages.ts')
  const { toResponsesGenerateOptions } = await import('../vendor/channel-pack/src/openai-gateway/responses.ts')
  const signal = new AbortController().signal
  const chat = await toGenerateOptions({ model: 'test/model', messages: [
    { role: 'system', content: 'system one' }, { role: 'system', content: 'system two' },
    { role: 'user', content: 'hello' }, { role: 'assistant', content: 'answer' },
    { role: 'tool', tool_call_id: 'call-1', content: 'tool output' },
  ] }, signal)
  const responses = await toResponsesGenerateOptions({ model: 'test/model', instructions: 'instructions', input: [
    { role: 'system', content: 'response system' }, { role: 'developer', content: 'response developer' },
    { role: 'user', content: 'hello' },
  ] }, signal)
  const systemMessages = [...chat.messages, ...responses.messages].filter(m => m.role === 'system')
  assert.equal(systemMessages.length, 5)
  for (const message of systemMessages) assert.deepEqual(message.source, { kind: 'plugin:dsh-openai-gateway' })
  assert.equal(new Set(systemMessages.map(m => m.source)).size, 5, 'source objects must not be shared')
  assert.equal(new Set(systemMessages.map(m => m.id)).size, 5, 'message identities stay distinct')
  assert.deepEqual(chat.messages.slice(2).map(m => m.source.kind), ['user', 'model', 'tool'])
  assert.equal(responses.messages.at(-1).source.kind, 'user')
  assert.deepEqual(systemMessages.map(m => m.content[0].text), ['system one', 'system two', 'instructions', 'response system', 'response developer'])
  assert.equal(chat.signal, signal)
  assert.equal(responses.signal, signal)

  // A tool answer must arrive as the first-class `tool` message (DSH 0.1.7+ shape),
  // not as a `user` message wrapping a `tool-result` block. External providers get no
  // `normalizeHarnessMessages()` fallback: `dsh-llm-pi-ai` reads only `role === 'tool'`
  // and otherwise drops the result (pi-ai then fabricates "No result provided"), and
  // `dsh-llm-deepseek` rejects the wrapper block as UNSUPPORTED_CONTENT.
  const toolMessage = chat.messages.find(m => m.role === 'tool')
  assert.ok(toolMessage, 'chat tool answer must be a tool message')
  assert.equal(toolMessage.toolCallId, 'call-1')
  assert.deepEqual(toolMessage.source, { kind: 'tool', callId: 'call-1' })
  assert.equal(JSON.stringify(chat.messages).includes('"tool-result"'), false, 'chat must not wrap the result in a tool-result block')

  const responsesTool = await toResponsesGenerateOptions({ model: 'test/model', input: [
    { type: 'message', role: 'user', content: 'hello' },
    { type: 'function_call', call_id: 'call-9', name: 'bash', arguments: '{}' },
    { type: 'function_call_output', call_id: 'call-9', output: 'clean' },
  ] }, signal)
  const responsesToolMessage = responsesTool.messages.find(m => m.role === 'tool')
  assert.ok(responsesToolMessage, 'Responses tool answer must be a tool message')
  assert.equal(responsesToolMessage.toolCallId, 'call-9')
  assert.equal(JSON.stringify(responsesTool.messages).includes('"tool-result"'), false, 'Responses must not wrap the result in a tool-result block')

  // An error result carries its flag, and a legacy history with no tool answer is untouched.
  const failed = await toGenerateOptions({ model: 'test/model', messages: [
    { role: 'tool', tool_call_id: 'call-err', content: 'boom', is_error: true },
  ] }, signal)
  assert.equal(failed.messages[0].role, 'tool')
  const plain = await toGenerateOptions({ model: 'test/model', messages: [
    { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' },
  ] }, signal)
  assert.deepEqual(plain.messages.map(m => m.role), ['user', 'assistant'])

  const echoed = await toGenerateOptions({ model: 'deepseek/deepseek-v4.1-flash-free', messages: [
    { role: 'user', content: '看一下仓库' },
    {
      role: 'assistant',
      content: '',
      reasoning_content: '先跑 git status。',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'bash', arguments: '{"command":"git status"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'clean' },
    { role: 'assistant', content: '仓库是干净的。', reasoning: '不需要再查了。' },
    { role: 'assistant', content: '这条没有思考。' },
    { role: 'assistant', content: null, reasoning_content: ' ' , tool_calls: [
      { id: 'call-2', type: 'function', function: { name: 'bash', arguments: '{}' } },
    ] },
  ] }, signal)
  const assistants = echoed.messages.filter(m => m.role === 'assistant')
  assert.deepEqual(assistants[0].content.map(block => block.type), ['reasoning', 'tool-call'])
  assert.equal(assistants[0].content[0].text, '先跑 git status。')
  assert.equal(assistants[1].content.find(block => block.type === 'reasoning').text, '不需要再查了。')
  assert.equal(assistants[1].content.some(block => block.type === 'text' && block.text === '仓库是干净的。'), true)
  assert.equal(assistants[2].content.some(block => block.type === 'reasoning'), false)
  assert.equal(assistants[3].content.find(block => block.type === 'reasoning').text, ' ')
  console.log('ok gateway source: chat system, Responses system/developer/instructions, independent identities and unchanged other roles')
  console.log('ok gateway reasoning: chat history keeps reasoning_content / reasoning, including a single-space placeholder')
} finally { hooks.deregister() }
