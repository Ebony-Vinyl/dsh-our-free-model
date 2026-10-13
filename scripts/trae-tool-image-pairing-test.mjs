/**
 * TRAE 适配器：工具结果内嵌图片 × 并行工具调用的配对回归。
 *
 * ## 上游为什么拒绝
 *
 * SOLO 按「带 `tool_calls` 的 assistant 之后必须紧跟**它每一个** `tool_call_id`
 * 的**连续** tool 消息」校验。一轮里出现**并行工具调用**（例如一次读两张图）
 * 且结果内嵌图片时，图片不能塞进 `role:'tool'`（该角色 content 只能是字符串），
 * 必须挂起为独立 user 消息。这条 user 消息一旦插在两条 tool 消息**之间**，
 * 第二个 tool_call 的应答就被隔断，上游回：
 *
 *     code=4027 An assistant message with 'tool_calls' must be followed by tool
 *     messages responding to each 'tool_call_id'.
 *     (insufficient tool messages following tool_calls message)
 *
 * 症状不是「这一轮失败」而是**整条会话报废**：坏报文进了历史，此后每次请求
 * 原样重放，5 次重试与「继续」全部无效，只有换 provider 才能恢复。
 *
 * ## 这个测试怎么保证测的是真实实现
 *
 * 断言对象是 **`vendor/channel-pack/pack.js`**（实际发布、实际加载的产物），
 * 函数体按大括号配对从该文件提取后求值 —— 不经 TypeScript、不依赖 esbuild、
 * 不依赖网络，与仓库里其它 `scripts/*-test.mjs` 一样是纯 Node 脚本。
 *
 * 因此 `pack.js` 未随 `src/` 重新构建时，本测试会失败：这正是我们要拦住的状态。
 *
 * Run: node scripts/trae-tool-image-pairing-test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const packPath = path.join(here, '..', 'vendor', 'channel-pack', 'pack.js')
const pack = fs.readFileSync(packPath, 'utf8')

/** 按大括号配对提取一个顶层函数声明，保留原文（含注释）。 */
function extractFunction(source, name) {
  const pattern = new RegExp(`(?:^|\\n)function ${name}\\s*\\(`)
  const match = pattern.exec(source)
  if (match === null) throw new Error(`pack.js 里找不到 function ${name} —— 产物结构变了，请更新本测试`)
  const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
  const open = source.indexOf('{', start)
  let depth = 0
  for (let i = open; i < source.length; i++) {
    const ch = source[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`pack.js 里 function ${name} 的大括号不配对`)
}

/** 提取一个顶层 `var NAME = <字面量>` 声明。 */
function extractVar(source, name) {
  const pattern = new RegExp(`(?:^|\\n)var ${name} = [^\\n]*`)
  const match = pattern.exec(source)
  if (match === null) throw new Error(`pack.js 里找不到 var ${name}`)
  return match[0].trim()
}

/**
 * 组装被测的 `serializeTraeMessages`。
 *
 * 真实依赖（归一化 / 配对剔除 / 内容展平 / 参数规范化 / 图片 parts）都取自
 * `pack.js` 本身；只有 `stripCourseLeakFromHistoryContent` 用恒等桩 ——
 * 它处理的是历史里 `course` 行首泄漏，与工具配对无关（未触发时即恒等）。
 */
function loadSerializer() {
  const pieces = [
    extractVar(pack, 'TOOL_RESULT_IMAGE_TEXT4'),
    extractFunction(pack, 'contentToText6'),
    extractFunction(pack, 'normalizeToolArguments'),
    extractFunction(pack, 'userContentParts4'),
    extractFunction(pack, 'isToolRoleMessage'),
    extractFunction(pack, 'isWrappedToolResult'),
    extractFunction(pack, 'detectMessageShape'),
    extractFunction(pack, 'normalizeHarnessMessages'),
    extractFunction(pack, 'hasUsableToolName'),
    extractFunction(pack, 'resolveToolPairing'),
    extractFunction(pack, 'serializeTraeMessages'),
  ].join('\n\n')

  const factory = new Function(
    'stripCourseLeakFromHistoryContent',
    `${pieces}\nreturn serializeTraeMessages`,
  )
  return factory((_role, content) => content)
}

const serializeTraeMessages = loadSerializer()

/**
 * 复刻上游的配对判据：assistant 的每个 tool_call_id 都必须在紧随其后的连续
 * tool 消息里得到应答；中间出现任何非 tool 消息即判「应答不足」。
 * @returns 违规数组；为空表示通过。
 */
function pairingViolations(wire) {
  const violations = []
  for (let i = 0; i < wire.length; i++) {
    const message = wire[i]
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue
    if (message.tool_calls.length === 0) continue
    const needed = message.tool_calls.map(call => String(call.id))
    const answered = []
    let j = i + 1
    while (j < wire.length && wire[j].role === 'tool') {
      answered.push(String(wire[j].tool_call_id))
      j++
    }
    const missing = needed.filter(id => !answered.includes(id))
    if (missing.length > 0) {
      violations.push({
        index: i,
        needed,
        answered,
        missing,
        interruptedBy: wire[j] === undefined ? '(history end)' : wire[j].role,
      })
    }
  }
  return violations
}

const image = id => ({ type: 'image', attachment: { attachmentId: id, mediaType: 'image/png', bytes: 1024 } })
const calls = (...pairs) => ({
  role: 'assistant',
  content: pairs.map(([id, name, args]) => ({ type: 'tool-call', id, name, arguments: args ?? '{}' })),
})

let failures = 0
const check = (name, ok, detail) => {
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `\n       ${detail}`}`)
}

// ── 1. 并行工具调用，每条结果都内嵌图片（线上触发 4027 的形状）──────────────
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '看看这两张图' }] },
    calls(['call_A', 'read_image'], ['call_B', 'read_image']),
    { role: 'tool', toolCallId: 'call_A', content: [{ type: 'text', text: 'a.png' }, image('sha256:a')] },
    { role: 'tool', toolCallId: 'call_B', content: [{ type: 'text', text: 'b.png' }, image('sha256:b')] },
  ]
  const urls = new Map([
    ['sha256:a', 'data:image/png;base64,AAAA'],
    ['sha256:b', 'data:image/png;base64,BBBB'],
  ])
  const wire = serializeTraeMessages(messages, urls)
  const violations = pairingViolations(wire)

  check(
    '并行调用 ×2 均含图：tool_calls 的应答不被图片消息隔断',
    violations.length === 0,
    `${JSON.stringify(violations)}\n       roles=${JSON.stringify(wire.map(m => m.role))}`,
  )

  const indexA = wire.findIndex(m => m.role === 'tool' && m.tool_call_id === 'call_A')
  const indexB = wire.findIndex(m => m.role === 'tool' && m.tool_call_id === 'call_B')
  check(
    '并行调用 ×2 均含图：两条 tool 消息相邻',
    indexA >= 0 && indexB >= 0 && Math.abs(indexA - indexB) === 1,
    `call_A@${indexA} call_B@${indexB} roles=${JSON.stringify(wire.map(m => m.role))}`,
  )

  const imageCount = wire
    .filter(m => m.role === 'user' && Array.isArray(m.content))
    .reduce((sum, m) => sum + m.content.filter(p => p.type === 'image_url').length, 0)
  check('并行调用 ×2 均含图：两张图都在（没被丢弃）', imageCount === 2, `实际 ${imageCount} 张`)
}

// ── 2. 并行工具调用，只有其中一条结果含图 ───────────────────────────────────
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '一图一文' }] },
    calls(['call_img', 'read_image'], ['call_txt', 'bash']),
    { role: 'tool', toolCallId: 'call_img', content: [{ type: 'text', text: 'a.png' }, image('sha256:a')] },
    { role: 'tool', toolCallId: 'call_txt', content: [{ type: 'text', text: 'a.png\nb.png' }] },
  ]
  const wire = serializeTraeMessages(messages, new Map([['sha256:a', 'data:image/png;base64,AAAA']]))
  const violations = pairingViolations(wire)
  check(
    '并行调用其一含图：配对不被破坏',
    violations.length === 0,
    `${JSON.stringify(violations)}\n       roles=${JSON.stringify(wire.map(m => m.role))}`,
  )
}

// ── 3. 单条工具结果含图（修复前已是正确的路径，不得改坏）────────────────────
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '看看' }] },
    calls(['call_A', 'read_image']),
    { role: 'tool', toolCallId: 'call_A', content: [{ type: 'text', text: 'a.png' }, image('sha256:a')] },
    { role: 'user', content: [{ type: 'text', text: '然后呢' }] },
  ]
  const wire = serializeTraeMessages(messages, new Map([['sha256:a', 'data:image/png;base64,AAAA']]))
  check('单条结果含图：配对通过', pairingViolations(wire).length === 0, JSON.stringify(pairingViolations(wire)))
  check('单条结果含图：图片以多模态 parts 发出', JSON.stringify(wire).includes('data:image/png'))
}

// ── 4. 含图结果之后的对话：图片不得漂到后续轮次 ─────────────────────────────
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
    calls(['call_A', 'read_image']),
    { role: 'tool', toolCallId: 'call_A', content: [{ type: 'text', text: 'a.png' }, image('sha256:a')] },
    { role: 'assistant', content: [{ type: 'text', text: '我看到图了' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] },
  ]
  const wire = serializeTraeMessages(messages, new Map([['sha256:a', 'data:image/png;base64,AAAA']]))
  const toolAt = wire.findIndex(m => m.role === 'tool')
  const imageAt = wire.findIndex(m => m.role === 'user' && Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'))
  const assistantAt = wire.findIndex(m => m.role === 'assistant' && m.content === '我看到图了')
  check(
    '图片排在 tool 之后、下一条 assistant 之前',
    toolAt < imageAt && imageAt < assistantAt,
    `tool@${toolAt} image@${imageAt} assistant@${assistantAt}`,
  )
}

// ── 5. 整个请求无图片：不得产生多余的 user 消息 ─────────────────────────────
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: '跑个命令' }] },
    calls(['call_A', 'bash']),
    { role: 'tool', toolCallId: 'call_A', content: [{ type: 'text', text: 'ok' }] },
  ]
  const wire = serializeTraeMessages(messages, undefined)
  check('无图片：不产生「Attached image(s)」占位消息', !JSON.stringify(wire).includes('Attached image'), JSON.stringify(wire))
  check('无图片：配对通过', pairingViolations(wire).length === 0)
}

// ── 6. 孤儿工具结果仍被剔除（既有防线不得回退）──────────────────────────────
{
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'x' }] },
    { role: 'user', content: [{ type: 'tool-result', toolCallId: 'call_orphan', content: [{ type: 'text', text: 'orphan' }] }] },
  ]
  const wire = serializeTraeMessages(messages, undefined)
  check('孤儿工具结果被剔除', !JSON.stringify(wire).includes('call_orphan'), JSON.stringify(wire))
}

console.log(failures === 0
  ? '\ntrae tool-result image pairing: all checks passed'
  : `\ntrae tool-result image pairing: ${failures} check(s) failed`)
assert.equal(failures, 0)