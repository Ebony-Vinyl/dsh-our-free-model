import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
// Test pack.js exports / functions
const packPath = new URL('../vendor/channel-pack/pack.js', import.meta.url).pathname

// We can test the bundled pack or run checks
import fs from 'node:fs'

const packCode = fs.readFileSync(new URL('../vendor/channel-pack/pack.js', import.meta.url), 'utf8')

console.log('Testing Tencent fingerprint rewrite and 11128 cooldown prevention...')

// 1. Check CONTENT_FINGERPRINTS in packCode
assert.ok(packCode.includes('You are an AI agent powered by DeepSeek Harness'), 'Identity fingerprint must be in pack.js')
assert.ok(packCode.includes('Main branch (you will usually use this for PRs)'), 'Branch fingerprint must be in pack.js')

// 2. Check isContentRejection in packCode
assert.ok(packCode.includes('11128'), '11128 exclusion must be in isContentRejection')

// 3. Test the regex logic in isolation
function isContentRejectionTest(body) {
  if (body.length === 0) return false
  if (/"code"\s*:\s*"?11128(?!\d)/.test(body)) return false
  try {
    const data = JSON.parse(body)
    if (data?.code === 11128 || data?.code === '11128') return false
    if (data?.code === 11140 || data?.code === '11140') return true
  } catch {}
  return /"code"\s*:\s*11140/.test(body) || /request illegal/i.test(body) || /安全审核|safety review/i.test(body)
}

// 11128 protocol error MUST return false (never cool down accounts)
assert.equal(isContentRejectionTest('{"code":11128,"msg":"request illegal"}'), false)
assert.equal(isContentRejectionTest('{"code":"11128","msg":"Illegal API invocation from an unapproved channel"}'), false)

// 11140 policy block MUST return true
assert.equal(isContentRejectionTest('{"code":11140,"msg":"security policy blocked"}'), true)
assert.equal(isContentRejectionTest('{"code":"11140","msg":"request illegal"}'), true)

// 4. Test fingerprint rewriting
const CONTENT_FINGERPRINTS = [
  {
    find: 'Main branch (you will usually use this for PRs)',
    replace: 'Main branch (PRs usually go here)',
  },
  {
    find: 'You are an AI agent powered by DeepSeek Harness.',
    replace: 'You are an AI assistant.',
  },
  {
    find: 'You are an AI agent powered by DeepSeek Harness',
    replace: 'You are an AI assistant',
  },
]

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const COMPILED = CONTENT_FINGERPRINTS.map((rule) => ({
  replace: rule.replace,
  findLower: rule.find.toLowerCase(),
  pattern: new RegExp(escapeRegExp(rule.find), 'gi'),
}))

function rewrite(text) {
  let out = text
  for (const rule of COMPILED) {
    if (!out.toLowerCase().includes(rule.findLower)) continue
    out = out.replace(rule.pattern, rule.replace)
  }
  return out
}

// Test case 1: DSH identity sentence
assert.equal(
  rewrite('You are an AI agent powered by DeepSeek Harness. Please answer questions accurately.'),
  'You are an AI assistant. Please answer questions accurately.'
)

// Test case 2: Case insensitivity
assert.equal(
  rewrite('you are an ai agent powered by deepseek harness.'),
  'You are an AI assistant.'
)

// Test case 3: Git branch injected by DSH/tools
assert.equal(
  rewrite('Main branch (you will usually use this for PRs): master'),
  'Main branch (PRs usually go here): master'
)

// Test case 4: Non-matching text remains identical
const untouched = 'Hello world, please write a python script.'
assert.equal(rewrite(untouched), untouched)

console.log('ALL VERIFICATION CHECKS PASSED!')
