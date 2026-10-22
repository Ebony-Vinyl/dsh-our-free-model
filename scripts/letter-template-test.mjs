/**
 * The template's contract: it must look like the letter it is modelled on, and it
 * must not be usable as one.
 *
 * Two halves, and the second is the important one:
 *
 *   1. shape — the metadata table, the four sections, the E1..En evidence index and
 *      the signature block are all present, with the same headings as the model;
 *   2. safety — no commitment device, no imperative demand, no rightsholder, no
 *      fillable seal or firm slot, and a banner that says so. A rendering that
 *      passes one and fails the other is a failure, not a partial success.
 *
 * Run: node scripts/letter-template-test.mjs
 */
import assert from 'node:assert/strict'
import { renderTemplate, countFields, FIELD, BANNER } from '../src/letter-template.js'

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const plain = renderTemplate()
const filled = renderTemplate({
  recipient: '某仓库维护者',
  matter: '示例事由',
  product: '示例产品',
  letterNo: 'XX-0000',
  evidence: [{ what: '提交记录', where: 'abc1234', proves: '时间顺序' }],
  probeRows: [{ probe: '对照', input: '中性文本', result: '200' }],
})

console.log('shape')

check('the letter opens with a title and the template banner', () => {
  assert.ok(plain.startsWith('# 律师函（模板）'))
  assert.ok(plain.includes(BANNER.split('\n')[0]))
})

check('the metadata table carries the fields the model letter carries', () => {
  for (const key of ['致', '抄送', '事由', '送达方式', '期限', '签发', '审核']) {
    assert.ok(plain.includes(`| ${key} |`), `metadata row ${key} missing`)
  }
})

check('the four sections are the model letter\'s sections', () => {
  for (const heading of ['一、经查证的事实', '二、法律分析', '三、拟请对方采取的措施', '四、说明']) {
    assert.ok(plain.includes(`### ${heading}`), `section ${heading} missing`)
  }
})

check('the evidence index is a table with an E1 row even when empty', () => {
  assert.ok(plain.includes('| 编号 | 证据 | 定位坐标 | 证明事项 |'))
  assert.ok(plain.includes('| E1 |'))
})

check('evidence supplied becomes E1..En rows', () => {
  assert.ok(filled.includes('| E1 | 提交记录 | abc1234 | 时间顺序 |'))
})

check('the probe table renders supplied rows instead of the placeholder row', () => {
  assert.ok(filled.includes('| 对照 | 中性文本 | 200 |'))
})

check('an empty call is a valid skeleton, entirely placeholder', () => {
  assert.ok(countFields(plain) > 20, `only ${countFields(plain)} placeholders`)
})

check('filling a field removes exactly its placeholder group', () => {
  assert.ok(countFields(filled) < countFields(plain))
})

console.log('safety')

check('the requirements section is a proposal, not an instruction', () => {
  assert.ok(plain.includes('拟请'))
  for (const banned of ['立即停止', '立即删除', '本函要求', '特此函告', '若不履行', '逾期将', '保留采取']) {
    assert.ok(!plain.includes(banned), `template still says ${banned}`)
  }
})

check('there is no deadline that reads as enforceable', () => {
  // A day count is a template field with no number attached to an instruction.
  assert.ok(plain.includes('本模板不预设可执行的期限'))
  assert.ok(!/自送达之日起/.test(plain))
})

check('no firm, lawyer or seal can be filled in place', () => {
  // The rows exist so an author knows they are needed, but the value slot is a
  // marker, never an underline or a blank to type into.
  assert.ok(plain.includes('| 承办律师 | 〔待填：姓名〕 |'))
  assert.ok(plain.includes('非签章位置'))
  assert.ok(!/_{4,}/.test(plain), 'template contains an underline to write on')
})

check('no rightsholder is named anywhere', () => {
  for (const banned of ['腾讯', 'WorkBuddy', 'CodeBuddy', '字节', '阿里', '智谱', '讯飞', '商汤', 'Google', 'OpenAI']) {
    assert.ok(!plain.includes(banned), `template names ${banned}`)
  }
})

check('no legal characterisation is asserted', () => {
  for (const banned of ['构成侵权', '涉嫌', '违反《', '应当承担', '赔偿']) {
    assert.ok(!plain.includes(banned), `template asserts ${banned}`)
  }
})

check('the letter number slot is a placeholder unless the caller supplies one', () => {
  assert.ok(plain.includes(`**【函号】** ${FIELD}`))
  assert.ok(filled.includes('**【函号】** XX-0000'))
})

check('the banner states it is not a letter, not legal advice, and not sendable', () => {
  assert.ok(BANNER.includes('不是律师函'))
  assert.ok(BANNER.includes('不构成法律意见'))
  assert.ok(BANNER.includes('不应作为文书送达'))
})

check('counting fields counts every placeholder group', () => {
  assert.equal(countFields('〔待填〕'), 1)
  assert.equal(countFields('〔待填：姓名〕 与 〔待填：证号〕'), 2)
  assert.equal(countFields('没有占位符'), 0)
})

console.log(`\n${failures === 0 ? 'letter-template-test: OK' : `letter-template-test: ${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
