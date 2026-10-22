/**
 * Community "lawyer letter" template — the *shape* of the kind of letter that
 * circulates in a repository's issue tracker, with every substantive part left
 * as a placeholder.
 *
 * This module renders a markdown skeleton and nothing else. What it deliberately
 * does not contain, and what `scripts/draft-letter-test.mjs` audits:
 *
 *   - no firm, lawyer, seal or signature block that could be filled in and used;
 *     every authority slot is a `〔待填〕` marker;
 *   - no imperative demand. The "requirements" section is written as a *proposal*
 *     ("拟请对方采取以下措施"), and every item is a placeholder;
 *   - no rightsholder name, no legal characterisation, no deadline that reads as
 *     enforceable — the day counts are parameters whose presence is marked as a
 *     template field rather than an instruction;
 *   - a fixed header stating the document is a template and cannot be signed or
 *     sent as-is.
 *
 * The point is to give a maintainer a reproducible structure — the metadata
 * table, the evidence ledger E1..En, the byte-and-sha evidence index — without
 * handing them a tool that manufactures a threatening document.
 *
 * @module src/letter-template.js
 */

/**
 * A template field. Anything the author must write themselves is one of these.
 *
 * The marker is deliberately conspicuous: a filled-in template still reads as a
 * template until every one of these is gone, which is exactly the property a
 * ready-to-send document must not have.
 */
export const FIELD = '〔待填〕'

/** A short banner that travels with every rendering. */
export const BANNER = [
  '> **这是一份模板，不是律师函。**',
  '> 文中所有 `〔待填〕` 必须由填写人自行完成；在全部占位符被替换、且由具备相应资格的执业者',
  '> 审阅并签章之前，本文不具备任何法律效力，也不应作为文书送达。',
  '> 本模板不构成法律意见，不针对任何具体主体，不包含任何权利主张或事实陈述。',
].join('\n')

/** Section headings, fixed so the output keeps the same shape as its model. */
const HEADINGS = {
  facts: '一、经查证的事实',
  analysis: '二、法律分析',
  request: '三、拟请对方采取的措施',
  closing: '四、说明',
}

/**
 * Render the template.
 *
 * `fields` may override any key of TEMPLATE_FIELDS; anything omitted stays a
 * placeholder, so an empty call is a valid, entirely unfilled skeleton.
 */
export function renderTemplate(fields = {}) {
  const value = key => {
    const given = fields[key]
    return given === undefined || given === '' ? FIELD : String(given)
  }
  const evidence = Array.isArray(fields.evidence) ? fields.evidence : []
  const probes = Array.isArray(fields.probeRows) ? fields.probeRows : []
  const lines = []

  lines.push('# 律师函（模板）')
  lines.push('')
  lines.push(BANNER)
  lines.push('')
  lines.push(`**【函号】** ${value('letterNo')}`)
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('| --- | --- |')
  lines.push(`| 致 | ${value('recipient')} |`)
  lines.push(`| 抄送 | ${value('cc')} |`)
  lines.push(`| 事由 | ${value('matter')} |`)
  lines.push(`| 送达方式 | ${value('service')} |`)
  lines.push('| 期限 | 〔待填：按实际情况分项列出，本模板不预设可执行的期限〕 |')
  lines.push('| 签发 | 〔待填：受托代理机构名称〕（此处为模板占位，非签章位置） |')
  lines.push('| 审核 | 〔待填：承办律师姓名与执业证号〕 |')
  lines.push('')

  lines.push('## 致 〔待填：收件主体〕')
  lines.push('')
  lines.push(`就 ${value('product')} 相关事宜，现将拟核实的事实与拟提出的措施列明如下。`)
  lines.push('')
  lines.push(`### ${HEADINGS.facts}`)
  lines.push('')
  lines.push('> 本节的每一句都应是可被证据固定的事实陈述；未取得证据的，不要写入本节。')
  lines.push('')
  lines.push(`1. 〔待填：事实一，注明日期、来源与可核验的定位坐标〕`)
  lines.push(`2. 〔待填：事实二〕`)
  lines.push(`3. 〔待填：事实三〕`)
  lines.push('')

  lines.push('**条件—结果对照（如适用，逐行填实测结果）：**')
  lines.push('')
  lines.push('| 探针 | 输入 | 结果 |')
  lines.push('| --- | --- | --- |')
  if (probes.length === 0) {
    lines.push('| 〔待填〕 | 〔待填〕 | 〔待填〕 |')
  } else {
    for (const row of probes) lines.push(`| ${row.probe ?? FIELD} | ${row.input ?? FIELD} | ${row.result ?? FIELD} |`)
  }
  lines.push('')

  lines.push(`### ${HEADINGS.analysis}`)
  lines.push('')
  lines.push('> 本节只列条文与构成要件的对应关系，不预设结论。')
  lines.push('')
  lines.push(`1. 〔待填：法律依据名称与条款序号〕——〔待填：与第一节何项事实对应〕`)
  lines.push(`2. 〔待填：法律依据名称与条款序号〕——〔待填：对应事实〕`)
  lines.push('')

  lines.push(`### ${HEADINGS.request}`)
  lines.push('')
  lines.push('> 以下为**拟请**事项，属于建议而非指令；是否提出、以何种方式提出，由填写人自行决定。')
  lines.push('')
  lines.push('1. 〔待填：拟请对方采取的第一项措施〕')
  lines.push('2. 〔待填：拟请对方采取的第二项措施〕')
  lines.push('3. 〔待填：拟请对方就上述事项作出答复〕')
  lines.push('')

  lines.push(`### ${HEADINGS.closing}`)
  lines.push('')
  lines.push(`- 本文所列 ${evidence.length === 0 ? '〔待填〕' : String(evidence.length)} 项证据，均应以可复核的方式固定；`)
  lines.push('- 〔待填：本文的发送范围与知悉人员〕；')
  lines.push('- 〔待填：其他需要说明的事项〕。')
  lines.push('')

  lines.push('## 证据索引')
  lines.push('')
  lines.push('> 证据条目一律列出**定位坐标**（路径 / 行号 / 提交 SHA / 抓取时间），不列结论。')
  lines.push('')
  lines.push('| 编号 | 证据 | 定位坐标 | 证明事项 |')
  lines.push('| --- | --- | --- | --- |')
  if (evidence.length === 0) {
    lines.push(`| E1 | ${FIELD} | ${FIELD} | ${FIELD} |`)
  } else {
    evidence.forEach((row, index) => {
      lines.push(`| E${index + 1} | ${row.what ?? FIELD} | ${row.where ?? FIELD} | ${row.proves ?? FIELD} |`)
    })
  }
  lines.push('')

  lines.push('## 落款')
  lines.push('')
  lines.push('| 项目 | 内容 |')
  lines.push('| --- | --- |')
  lines.push('| 受托代理机构 | 〔待填：机构全称〕 |')
  lines.push('| 承办律师 | 〔待填：姓名〕 |')
  lines.push('| 执业证号 | 〔待填：执业证号〕 |')
  lines.push('| 联系方式 | 〔待填：地址 / 电话 / 电子邮箱〕 |')
  lines.push('| 签章 | 〔待填：由具备资格的机构与执业者签章后，本文方才成立〕 |')
  lines.push('')

  return `${lines.join('\n')}`
}

/**
 * Count the placeholders a rendering still carries.
 *
 * A renderer is not done when it has printed text; it is done when a reader can
 * see how much of the document is still a template. This is that number, and it
 * is the only statistic the template publishes about itself.
 */
export function countFields(rendered) {
  return (String(rendered).match(/〔待填[^〕]*〕/g) ?? []).length
}
