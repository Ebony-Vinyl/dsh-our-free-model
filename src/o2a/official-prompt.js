/** Assemble OFM request context while retaining the caller's instruction blocks. */
import { officialPromptText } from './asset-source.js'

export const OFFICIAL_PROMPT_MARKER = "You are assisting with a user's software project through OFM."
export const OFFICIAL_SKILLS = 'Use only skills explicitly provided by the host; do not assume built-in skills are available.'
let cachedDirectory

export function officialPrompt() {
  return officialPromptText()
}

export function officialEnvironment(model, directory) {
  if (directory === undefined) {
    if (cachedDirectory === undefined) {
      // cwd can disappear when the containing directory is removed externally.
      try { cachedDirectory = process.cwd().trim() || '/workspace' }
      catch { cachedDirectory = '/workspace' }
    }
    directory = cachedDirectory
  }
  const id = String(model ?? '').replace(/^opencode\//, '').trim() || 'unknown'
  const now = new Date()
  const date = now.toUTCString().slice(0, 16).replace(',', '')
  return `Model: ${id}\n<env>\n  Working directory: ${directory}\n  Workspace root folder: ${directory}\n  Platform: ${process.platform}\n  Today's date: ${date}\n</env>`
}

export function officialSystemPrompt(model, directory) {
  const base = officialPrompt()
  return base === '' ? '' : `${base}${officialEnvironment(model, directory)}\n${OFFICIAL_SKILLS}`
}

export function textFragments(value) {
  const result = [], pending = [value]
  while (pending.length) {
    const item = pending.pop()
    if (typeof item === 'string') { if (item.trim()) result.push(item) }
    else if (Array.isArray(item)) {
      for (let index = item.length - 1; index >= 0; index--) pending.push(item[index])
    } else if (item && typeof item === 'object') {
      if (typeof item.text === 'string') pending.push(item.text)
      else if (item.content !== undefined) pending.push(item.content)
    }
  }
  return result
}

export function carriesOpenCodePrompt(value) {
  return textFragments(value).some(text => text.includes(OFFICIAL_PROMPT_MARKER))
}

export function injectOfficialPrompt(payload, shape, { workDir, model } = {}) {
  if (!payload || typeof payload !== 'object' || !['chat', 'flat', 'claude'].includes(shape)) return false
  const prompt = officialSystemPrompt(model ?? payload.model, workDir)
  if (!prompt) return false
  const prepend = (value, blocks) => {
    if (blocks && Array.isArray(value)) return [{ type: 'text', text: prompt }, ...value]
    return typeof value === 'string' && value.trim() ? `${prompt}\n\n${value}` : prompt
  }
  if (shape !== 'chat') {
    const key = shape === 'flat' ? 'instructions' : 'system'
    if (carriesOpenCodePrompt(payload[key])) return false
    payload[key] = prepend(payload[key], shape === 'claude')
    return true
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : []
  let anchor = -1
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message?.role !== 'system' && message?.role !== 'developer') continue
    if (carriesOpenCodePrompt(message.content)) return false
    if (anchor < 0) anchor = index
  }
  if (anchor < 0) payload.messages = [{ role: 'system', content: prompt }, ...messages]
  else messages[anchor] = { ...messages[anchor], content: prepend(messages[anchor].content, true) }
  return true
}
