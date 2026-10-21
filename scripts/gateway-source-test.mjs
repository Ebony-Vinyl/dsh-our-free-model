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
