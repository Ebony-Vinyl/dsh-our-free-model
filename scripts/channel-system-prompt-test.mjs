/**
 * 系统提示词是否真的到达上游 —— 回归测试。
 *
 * ## 这测的是什么
 *
 * DSH 把系统提示词放在两个地方：`GenerateOptions.system`，以及
 * `options.messages` 首位的 `role:'system'` 消息。**后者才是稳定的那个** ——
 * `dsh-llm` 从不设置 `options.system`，只有 `dsh-llm-deepseek` 会把 system
 * 消息提升到该字段（`historySystem`）。
 *
 * Gemini / MiniMax 的序列化实现只读 `options.system`，并把 messages 里的
 * system 消息显式 `continue` 掉。回归前，只传 messages 时整段提示词从请求里
 * 消失，且没有任何报错 —— 模型照常回答，只是不遵守任何指令。
 *
 * ## 断言口径
 *
 * 用一句**只可能来自提示词**的哨兵文本，断言它出现在最终请求体的
 * `systemInstruction` / `system` 上；三种入参组合各测一次（只有 system 字段 /
 * 只有 system 消息 / 两者都有），确保提升逻辑既不漏也不重；再反向断言它
 * **没有**落进 `contents`（否则模型会把它当用户指令）。
 *
 * Run: node scripts/channel-system-prompt-test.mjs
 */
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

const { translateGeminiRequest } = await import('../vendor/channel-pack/src/gemini-messages.ts')
const { buildMinimaxMessagesPayload } = await import('../vendor/channel-pack/src/minimax-messages.ts')
const { collectHarnessSystem } = await import('../vendor/channel-pack/src/message-shape.ts')

/** 只可能来自提示词的一句话。 */
const SENTINEL = 'The operator wants replies in Bangla in this workspace.'
const USER = 'hello'

const systemMessage = text => ({ role: 'system', content: [{ type: 'text', text }] })
const userMessage = text => ({ role: 'user', content: [{ type: 'text', text }] })

const gemini = (messages, system) => translateGeminiRequest({
  modelId: 'gemini-test',
  spec: { upstream: 'gemini-test-upstream', includeThoughts: false, thinkingBudget: -1 },
  messages,
  requestId: 'test-request',
  ...system === undefined ? {} : { system },
}).request

const minimax = (messages, system) => buildMinimaxMessagesPayload({
  model: 'minimax-test',
  messages,
  ...system === undefined ? {} : { system },
})

const systemOf = request => request.systemInstruction?.parts?.map(part => part.text).join('\n') ?? ''

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL  ${name} — ${error.message}`)
  }
}

// ── collectHarnessSystem 本身 ────────────────────────────────────────────────
check('collects a system message', () => {
  assert.equal(collectHarnessSystem([systemMessage(SENTINEL), userMessage(USER)]), SENTINEL)
})
check('joins several system messages with a blank line', () => {
  assert.equal(collectHarnessSystem([systemMessage('a'), systemMessage('b')]), 'a\n\nb')
})
check('joins several text blocks with a newline and skips non-text', () => {
  assert.equal(
    collectHarnessSystem([{ role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: 'b' }] }]),
    'a\nb',
  )
})
check('ignores developer messages', () => {
  assert.equal(collectHarnessSystem([{ role: 'developer', content: [{ type: 'text', text: SENTINEL }] }]), '')
})
check('is empty when nothing is a system message', () => {
  assert.equal(collectHarnessSystem([userMessage(USER)]), '')
})
check('tolerates null, missing content and a bare string', () => {
  assert.equal(collectHarnessSystem([null, { role: 'system' }, { role: 'system', content: 'plain' }]), 'plain')
})

// ── Gemini：回归的核心 ───────────────────────────────────────────────────────
check('gemini carries a message-borne prompt (the regression)', () => {
  assert.equal(systemOf(gemini([systemMessage(SENTINEL), userMessage(USER)], undefined)), SENTINEL)
})
check('gemini still carries options.system', () => {
  assert.equal(systemOf(gemini([userMessage(USER)], SENTINEL)), SENTINEL)
})
check('gemini carries both, options.system first, exactly once each', () => {
  const text = systemOf(gemini([systemMessage('from-message'), userMessage(USER)], 'from-field'))
  assert.equal(text, 'from-field\n\nfrom-message')
  assert.equal(text.split('from-field').length - 1, 1)
  assert.equal(text.split('from-message').length - 1, 1)
})
check('gemini omits systemInstruction when there is no prompt', () => {
  assert.equal('systemInstruction' in gemini([userMessage(USER)], undefined), false)
})
check('gemini never lets a system message leak into contents as a user turn', () => {
  assert.equal(JSON.stringify(gemini([systemMessage(SENTINEL), userMessage(USER)], undefined).contents).includes(SENTINEL), false)
})
check('gemini keeps the conversation itself unchanged', () => {
  const request = gemini([systemMessage('s'), userMessage('first'), { role: 'assistant', content: [{ type: 'text', text: 'answer' }] }], undefined)
  assert.deepEqual(request.contents.map(c => c.role), ['user', 'model'])
  assert.equal(request.contents[0].parts[0].text, 'first')
})

// ── MiniMax：同一个缺陷，同一组断言 ──────────────────────────────────────────
check('minimax carries a message-borne prompt (the regression)', () => {
  assert.equal(minimax([systemMessage(SENTINEL), userMessage(USER)], undefined).system, SENTINEL)
})
check('minimax still carries options.system', () => {
  assert.equal(minimax([userMessage(USER)], SENTINEL).system, SENTINEL)
})
check('minimax carries both, options.system first, exactly once each', () => {
  assert.equal(minimax([systemMessage('from-message'), userMessage(USER)], 'from-field').system, 'from-field\n\nfrom-message')
})
check('minimax omits system when there is no prompt', () => {
  assert.equal('system' in minimax([userMessage(USER)], undefined), false)
})
check('minimax never lets a system message leak into messages', () => {
  assert.equal(JSON.stringify(minimax([systemMessage(SENTINEL), userMessage(USER)], undefined).messages).includes(SENTINEL), false)
})

hooks.deregister()

if (failures > 0) {
  console.error(`\nchannel-system-prompt-test: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nchannel-system-prompt-test: all checks passed')
