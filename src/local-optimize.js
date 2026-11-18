/** Local answers for recognized client housekeeping requests; never runs commands. */
import { randomUUID } from 'node:crypto'

export const OPTIMIZATIONS = ['quota', 'prefix', 'title', 'suggestion', 'filepath']
const subcommands = new Set(['git', 'npm', 'docker', 'kubectl', 'cargo', 'go', 'pip', 'yarn'])
const readers = new Set(['cat', 'head', 'tail', 'less', 'more', 'bat', 'type'])
const argumentFlags = new Set(['-e', '-f', '-m', '-A', '-B', '-C', '--regexp'])
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=[^\n]*$/
const EMPTY_FILEPATHS = '<filepaths>\n</filepaths>'

function textOf(value) {
  if (typeof value === 'string') return value
  let result = ''
  if (Array.isArray(value)) for (const item of value) if (typeof item?.text === 'string') result += item.text
  return result
}

// Return null for unmatched quotes; callers have different malformed-input policies.
function shellWords(value) {
  if (!/[\\'"]/.test(value)) return value.match(/[^ \t\n\r\f\v]+/g) ?? []
  const words = []
  let token = '', quote = '', active = false
  for (let index = 0; index < value.length; index++) {
    const char = value[index], next = value[index + 1]
    if (quote && char === quote) { quote = ''; continue }
    if (!quote && /[ \t\n\r\f\v]/.test(char)) {
      if (active) words.push(token)
      token = ''; active = false
      continue
    }
    active = true
    if (!quote && (char === "'" || char === '"')) { quote = char; continue }
    const escaped = quote === '"' ? next !== undefined && '"\\$`'.includes(next)
      : !quote && next !== undefined && /[ \t\n\r\f\v'"]/.test(next)
    if (char === '\\' && escaped) { token += next; index++ }
    else token += char
  }
  if (quote) return null
  if (active) words.push(token)
  return words
}

export function extractCommandPrefix(command) {
  const text = typeof command === 'string' ? command : ''
  if (text.includes('`') || text.includes('$(')) return 'command_injection_detected'
  const parsed = shellWords(text)
  const words = parsed ?? text.match(/\S+/g) ?? []
  let start = 0
  while (start < words.length && assignment.test(words[start])) start++
  if (start === words.length) return 'none'
  const first = words[start], second = words[start + 1]
  if (parsed === null) return first
  if (subcommands.has(first) && second !== undefined) return second.startsWith('-') ? first : `${first} ${second}`
  return words.slice(0, start + 1).join(' ')
}

export function extractFilepathsFromCommand(command, output) {
  const words = shellWords(typeof command === 'string' ? command : '')
  if (words === null) return EMPTY_FILEPATHS
  let start = 0
  while (start < words.length && assignment.test(words[start])) start++
  if (start === words.length) return EMPTY_FILEPATHS
  const executable = words[start]
  const base = executable.slice(Math.max(executable.lastIndexOf('/'), executable.lastIndexOf('\\')) + 1).toLowerCase()
  const paths = []
  if (readers.has(base)) {
    for (let index = start + 1; index < words.length; index++) if (!words[index].startsWith('-')) paths.push(words[index])
  } else if (base === 'grep') {
    let suppliedPattern = false
    for (let index = start + 1; index < words.length; index++) {
      const word = words[index]
      if (!word.startsWith('-')) paths.push(word)
      else {
        if (word === '-e' || word === '-f' || word === '--regexp' || word.startsWith('--regexp=')) suppliedPattern = true
        if (argumentFlags.has(word)) index++
      }
    }
    if (!suppliedPattern) paths.shift()
  }
  return paths.length ? `<filepaths>\n${paths.join('\n')}\n</filepaths>` : EMPTY_FILEPATHS
}

/** Derive request facts once, then evaluate the five established local answers. */
function firstAnswer(request, enabled) {
  const messages = request?.messages ?? []
  let single, conversational = 0, suggestion = false
  const systems = []
  const top = textOf(request?.system)
  if (top) systems.push(top)
  for (const message of messages) {
    if (message?.role === 'system') {
      const content = textOf(message.content)
      if (content) systems.push(content)
    } else {
      conversational++
      if (message?.role === 'user') {
        single = message
        if (textOf(message.content).includes('[SUGGESTION MODE:')) suggestion = true
      }
    }
  }
  const content = conversational === 1 && single ? textOf(single.content) : null
  if (enabled?.quota !== false && content !== null && (request?.max_tokens === 1 || request?.max_tokens === '1') && content.toLowerCase().includes('quota')) {
    return { kind: 'quota', text: 'Quota check passed.', usage: { input: 10, output: 5 } }
  }
  if (enabled?.prefix !== false && content !== null && content.includes('<policy_spec>') && content.includes('Command:')) {
    return { kind: 'prefix', text: extractCommandPrefix(content.slice(content.lastIndexOf('Command:') + 8).trim()), usage: { input: 100, output: 5 } }
  }
  const system = systems.join('\n').toLowerCase()
  const tools = Array.isArray(request?.tools) ? request.tools.length > 0 : Boolean(request?.tools)
  if (enabled?.title !== false && !tools && system.includes('title') && (system.includes('sentence-case title')
    || (system.includes('return json') && system.includes('field') && (system.includes('coding session') || system.includes('this session'))))) {
    return { kind: 'title', text: 'Conversation', usage: { input: 100, output: 5 } }
  }
  if (enabled?.suggestion !== false && suggestion) return { kind: 'suggestion', text: '', usage: { input: 100, output: 1 } }
  if (enabled?.filepath !== false && content !== null && !tools && content.includes('Command:') && content.includes('Output:')
    && (content.toLowerCase().includes('filepaths') || system.includes('extract any file paths') || system.includes('file paths that this command'))) {
    const start = content.indexOf('Command:') + 8
    const end = content.indexOf('Output:', start)
    if (end >= 0) return { kind: 'filepath', text: extractFilepathsFromCommand(content.slice(start, end).trim()), usage: { input: 100, output: 10 } }
  }
  return null
}

export function detectOptimization(request, enabled) {
  return firstAnswer(request, enabled)?.kind ?? null
}

export function tryOptimizations(request, options = {}) {
  const answer = firstAnswer(request, options?.enabled)
  if (!answer) return null
  const model = options?.model ?? request?.model
  answer.model = typeof model === 'string' ? model : ''
  return answer
}

export function toMessagesResponse(result, { model, id } = {}) {
  return {
    type: 'message', role: 'assistant',
    id: typeof id === 'string' && id ? id : `msg_${randomUUID().replaceAll('-', '')}`,
    model: model ?? result?.model ?? '',
    content: [{ type: 'text', text: result?.text ?? '' }],
    stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: result?.usage?.input ?? 0, output_tokens: result?.usage?.output ?? 0 },
  }
}
