/**
 * Prose trimming for outbound message text.
 *
 * The model never needs the politeness it wrote (`谢谢`, `请`, `please`, …) or
 * the mark that closes a sentence in the request it reads back. This saver
 * removes those from user and assistant text on all three wires. Tool results
 * are left to RTK: the guards below reject code, diffs, paths, URLs, versions
 * and decimals, so a tool result that happens to be prose is the only thing it
 * touches.
 *
 * It is deliberately fail-open: an unrecognised shape changes nothing.
 *
 * @module src/token-saver/prose.js
 */

const DIFF_LINE = /^[+-](?![+-])/
const CODE_START = /^(?:[{[]|<\/?[A-Za-z])/
const CODE_END = /[;{}=]$/
const URL = /(?:https?|ftp):\/\//i
const VERSION = /\b(?:v|version\s*)?\d+\.\d+(?:\.\d+)*\b/i
const EMAIL = /^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/
const FILE_EXTENSION = /\.(?:md|markdown|txt|log|json|jsonl|ya?ml|toml|ini|lock|ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|kts|cs|c|h|cpp|hpp|cc|rb|php|sh|bash|ps1|bat|cmd|html|htm|css|scss|sass|xml|sql|proto|vue|svelte|swift|dart|lua|r|scala|ex|exs|erl|hs|clj)$/i

function proseGuards(line) {
  const value = String(line)
  const trimmed = value.trim()
  if (trimmed === '') return false
  if (/^(?:```|~~~)/.test(trimmed)) return false
  if (DIFF_LINE.test(trimmed)) return false
  if (CODE_START.test(trimmed)) return false
  if (CODE_END.test(trimmed)) return false
  if (URL.test(trimmed)) return false
  const marked = trimmed.replace(/[.。]$/, '')
  if (EMAIL.test(marked)) return false
  if (FILE_EXTENSION.test(marked)) return false
  if (VERSION.test(trimmed)) return false
  if (/^[\w.-]+:\d+/.test(trimmed)) return false
  if (/^\s*[+*]\s/.test(trimmed)) return false
  if (trimmed.endsWith('...') || trimmed.endsWith('…')) return false
  if (/(?:\be\.g\.|\bi\.e\.)$/i.test(trimmed)) return false
  if (!/[A-Za-z\u4e00-\u9fff]/.test(trimmed)) return false
  if (/[，,]\s*$/.test(value) && /[=();{}[\]]/.test(trimmed)) return false
  return true
}

function looksLikeCode(text) {
  const trimmed = text.trim()
  if (/[=;{}]/.test(trimmed)) return true
  return /^(?:const|let|var|function|class|import|export|return|if|for|while|switch|def|fn|public|private|protected|package|#include)\b/.test(trimmed)
}

const POLITE_EN = /\b(?:please|thanks|thank you|kindly)\b[ \t]*/gi
const POLITE_ZH = /谢谢|多谢|感谢|请问|麻烦(?:您)?|劳驾|拜托|辛苦了?|(?<!申|邀|聘|提|呈|报|敬|恭|恳|函|回|奏|咨|声|争|催|敦|籲|吁|要|寻|约|宴|延)请(?!求|示|教|假|柬|帖|缨|战|命|辞|罪|愿|客)/g

export function stripPoliteness(line) {
  const source = String(line)
  const withoutWords = source.replace(POLITE_EN, '').replace(POLITE_ZH, '')
  if (withoutWords === source) return source
  return withoutWords
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]*[，,、]+[ \t]*/, '')
    .replace(/[，,、]+[ \t]*$/, '')
}

/** Trim one text blob; a non-prose or code line is copied through untouched. */
export function trimProseText(text) {
  return String(text)
    .split('\n')
    .map((line) => {
      if (!proseGuards(line) || looksLikeCode(line)) return line
      return stripPoliteness(line).replace(/[.。,，]+(\s*)$/, '$1')
    })
    .join('\n')
}

const isChatRole = (role) => role === 'user' || role === 'assistant'

/**
 * Trim user and assistant prose in one request body, in place.
 *
 * @param {object} payload
 * @param {'chat'|'messages'|'responses'} wire
 * @returns {{bytesBefore: number, bytesAfter: number, saved: number, blocks: number}}
 */
export function trimRequestProse(payload, wire) {
  const stats = { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0 }
  if (payload === null || typeof payload !== 'object') return stats

  const apply = (owner, key) => {
    const content = owner?.[key]
    if (typeof content === 'string') {
      const next = trimProseText(content)
      if (next === content) return
      stats.bytesBefore += content.length
      stats.bytesAfter += next.length
      stats.blocks += 1
      owner[key] = next
      return
    }
    if (!Array.isArray(content)) return
    for (const part of content) {
      if (!part || typeof part.text !== 'string') continue
      const next = trimProseText(part.text)
      if (next === part.text) continue
      stats.bytesBefore += part.text.length
      stats.bytesAfter += next.length
      stats.blocks += 1
      part.text = next
    }
  }

  try {
    if (wire === 'chat') {
      for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
        if (message !== null && typeof message === 'object' && isChatRole(message.role)) apply(message, 'content')
      }
    } else if (wire === 'messages') {
      for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
        if (message === null || typeof message !== 'object' || !isChatRole(message.role)) continue
        apply(message, 'content')
      }
    } else if (wire === 'responses') {
      for (const item of Array.isArray(payload.input) ? payload.input : []) {
        if (item === null || typeof item !== 'object' || !isChatRole(item.role)) continue
        apply(item, 'content')
      }
    }
  } catch {
    // Fail-open: a body shape this saver cannot walk is left as it is.
  }

  stats.saved = stats.bytesBefore - stats.bytesAfter
  return stats
}
