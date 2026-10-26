/**
 * The recommendation page's rendering, without a browser.
 *
 * The page has one job — send the reader to a repository to press Star — so the
 * checks below are about exactly that: every card exists, each one's star button
 * and second action point at that project's own repository, and the numbers are
 * real or absent. A missing number must leave the row out rather than print a
 * placeholder, because a page whose whole argument is "these figures are live"
 * loses that argument the moment one of them is invented.
 *
 * Run: node scripts/picks-ui-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let record
let picksFixture
const react = {
  createElement: (type, props, ...children) => ({
    type, props: { ...props, ...children.length ? { children: children.length === 1 ? children[0] : children } : {} }, children,
  }),
  Fragment: 'fragment',
  useState: initial => {
    const value = typeof initial === 'function' ? initial() : initial
    return [picksFixture !== undefined && value?.status === 'loading'
      ? { status: 'ready', data: { repos: picksFixture }, error: '' } : value, () => {}]
  },
  useEffect: () => {},
  useMemo: factory => factory(),
  useCallback: fn => fn,
  useRef: () => ({ current: null }),
}
new Function('window', 'document', 'navigator', source)(
  { __ModuleLoader__: { load: value => { record = value } } },
  { createElement: () => ({ setAttribute() {}, style: {}, remove() {} }), head: { appendChild() {} }, body: { appendChild() {}, removeChild() {} } },
  { language: 'zh-CN' })
const { PicksPage, RecoCard, parseSafeHtml, DICT } = record.factory(name => {
  if (name === 'react') return react
  if (name === 'react-dom') return { createPortal: (children, container) => ({ type: 'portal', children, container }) }
  throw new Error(`the browser half may only require react or react-dom; it asked for "${name}"`)
}).__test

let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) } catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

function flatten(value, out = []) {
  if (Array.isArray(value)) { for (const child of value) flatten(child, out); return out }
  if (value === null || value === undefined || typeof value === 'boolean') return out
  if (typeof value === 'object') {
    out.push(value)
    // The stub React does not execute function components, so the walk does it:
    // a page made of cards can only be checked as a tree once the cards are in it.
    flatten(typeof value.type === 'function' ? value.type(value.props) : value.children, out)
  } else out.push(value)
  return out
}
const nodes = tree => flatten(tree)
const text = tree => nodes(tree).filter(node => typeof node === 'string').join(' ')
const withClass = (tree, className) => nodes(tree).filter(node => typeof node === 'object' && String(node.props?.className ?? '').split(/\s+/).includes(className))

/** The page's `t` carries the locale as a property; `ago()` reads it from there. */
const zh = key => key
zh.locale = 'zh-CN'

const CARD = {
  t: zh, index: 0, mark: 'M0 0', name: 'EAC-Desktop', repo: 'Ebony-Vinyl/EAC-Desktop',
  badge: 'badge', tagline: 'tagline', body: 'body', chips: ['c1', 'c2', 'c3', 'c4'],
  repoUrl: 'https://github.com/Ebony-Vinyl/EAC-Desktop', extraUrl: 'https://github.com/Ebony-Vinyl/EAC-Desktop/releases', extraLabel: 'Download',
}
const STAT = { id: 'eac-desktop', repo: 'Ebony-Vinyl/EAC-Desktop', stars: 2034, forks: 74, pushedAt: Date.now() - 3 * 24 * 60 * 60_000, stale: false }

check('a card carries the project, its four chips and both actions', () => {
  const tree = RecoCard({ ...CARD, stat: STAT })
  assert.equal(withClass(tree, 'ofm_reconame')[0].children[0], 'EAC-Desktop')
  assert.equal(withClass(tree, 'ofm_recorepo')[0].children[0], 'Ebony-Vinyl/EAC-Desktop')
  assert.equal(withClass(tree, 'ofm_recochip').length, 4)
  assert.equal(text(tree).includes('tagline'), true)
})

check('the star button is the project repository, opened safely', () => {
  const tree = RecoCard({ ...CARD, stat: STAT })
  const stars = withClass(tree, 'ofm_recostar')
  assert.equal(stars.length, 1)
  assert.equal(stars[0].props.href, 'https://github.com/Ebony-Vinyl/EAC-Desktop')
  assert.equal(stars[0].props.target, '_blank')
  assert.equal(stars[0].props.rel, 'noreferrer noopener')
  const extra = withClass(tree, 'ofm_recogo')
  assert.equal(extra[0].props.href, 'https://github.com/Ebony-Vinyl/EAC-Desktop/releases')
  assert.equal(extra[0].props.target, '_blank')
})

check('live numbers render with separators and their labels', () => {
  const tree = RecoCard({ ...CARD, stat: STAT })
  const facts = withClass(tree, 'ofm_recofact')
  assert.equal(facts.length, 3, 'stars, forks, last push')
  assert.equal(text(facts[0]).includes('2,034'), true)
  assert.equal(text(facts[1]).includes('74'), true)
  assert.equal(text(facts[2]).includes('3 天前'), true)
})

check('no numbers at all leaves no placeholder behind', () => {
  const tree = RecoCard({ ...CARD, stat: null })
  assert.equal(withClass(tree, 'ofm_recofact').length, 0)
  assert.equal(text(tree).includes('—'), false, 'no em-dash stand-in for a missing figure')
  assert.equal(withClass(tree, 'ofm_recostar').length, 1, 'the ask survives without the numbers')
})

check('a stale count is shown, but marked as cached', () => {
  const tree = RecoCard({ ...CARD, stat: { ...STAT, stale: true } })
  const fact = withClass(tree, 'ofm_recofact')[0]
  assert.equal(text(fact).includes('2,034'), true)
  assert.equal(text(fact).includes('picks.stale'), true)
})

check('a repo whose numbers never arrived still renders its card', () => {
  const tree = RecoCard({ ...CARD, stat: { id: 'eac-desktop', repo: 'Ebony-Vinyl/EAC-Desktop', stale: true } })
  assert.equal(withClass(tree, 'ofm_recofact').length, 0)
  assert.equal(withClass(tree, 'ofm_recostar').length, 1)
})

check('the page renders all three projects and the ask', () => {
  const tree = PicksPage({ t: zh })
  assert.equal(withClass(tree, 'ofm_recocard').length, 3)
  assert.equal(withClass(tree, 'ofm_recostar').length, 3)
  const hrefs = withClass(tree, 'ofm_recostar').map(node => node.props.href)
  assert.deepEqual(hrefs, ['https://github.com/Ebony-Vinyl/EAC-Desktop', 'https://github.com/Ebony-Vinyl/EAC-Pack', 'https://github.com/Ebony-Vinyl/EAC-design-world'])
  assert.equal(text(tree).includes('picks.foot'), true)
})

check('the three projects are the ones the announcement names', () => {
  const tree = PicksPage({ t: zh })
  const page = text(tree)
  for (const name of ['EAC-Desktop', 'EAC-Pack', 'EAC-design-world']) assert.equal(page.includes(name), true, `${name} is on the page`)
})

check('translated totals count only projects with real star readings', () => {
  for (const locale of ['zh', 'en']) {
    const t = Object.assign(key => DICT[locale][key] ?? key, { locale })
    for (const [repos, count, total] of [
      [[{ id: 'eac-desktop', stars: 2056 }, { id: 'eac-pack', stars: 57 }, { id: 'eac-design-world', stars: 10 }], 3, 2123],
      [[{ id: 'eac-desktop', stars: 2056 }, { id: 'eac-pack', stars: 57 }, { id: 'eac-design-world' }], 2, 2113],
      [[{ id: 'eac-desktop', stars: 12 }, { id: 'eac-pack', stars: 0 }, { id: 'eac-design-world', stars: NaN }], 2, 12],
    ]) {
      picksFixture = repos
      const page = text(PicksPage({ t }))
      const expected = DICT[locale]['picks.totalStars'].replace('{c}', String(count)).replace('{n}', total.toLocaleString('en-US'))
      assert.ok(page.includes(expected), `${locale}: ${expected}`)
      assert.ok(!page.includes('{c}') && !page.includes('{n}'))
    }
    for (const repos of [[], [{ id: 'eac-desktop' }], [{ id: 'eac-desktop', stars: 0 }]]) {
      picksFixture = repos
      const page = text(PicksPage({ t }))
      assert.ok(!page.includes(locale === 'zh' ? '个推荐项目共' : 'stars across'))
      assert.equal(withClass(PicksPage({ t }), 'ofm_recocard').length, 3)
    }
    for (const key of ['picks.sub', 'picks.foot', 'picks.totalStars']) {
      assert.ok(!/两个|两张|\bboth\b|\btwo\b/i.test(DICT[locale][key]))
    }
  }
  picksFixture = undefined
})

// The announcement is the only thing that tells users the page exists, and it is
// published by a separate push — so it has to name the same repositories the
// page renders, and its HTML has to survive the client's allowlist parser with
// both links intact. A typo in one URL here is a broken promise, not a style nit.
check('the shipped announcement links every project through the sanitizer', () => {
  const feed = JSON.parse(fs.readFileSync(new URL('../feed/announcements.json', import.meta.url), 'utf8'))
  const item = feed.announcements.find(row => row.id === '2026-10-16-picks-page')
  assert.ok(item !== undefined, 'the picks announcement is in the feed')
  // The parser's virtual tree, not a rendered one: `{type:'el'}` nodes whose text
  // children are plain strings.
  const hrefs = []
  const words = []
  const walk = node => {
    if (typeof node === 'string') { words.push(node); return }
    if (node === null || typeof node !== 'object') return
    if (node.props?.href !== undefined) hrefs.push(node.props.href)
    for (const child of node.children ?? []) walk(child)
  }
  for (const node of parseSafeHtml(item.html)) walk(node)
  for (const repo of ['https://github.com/Ebony-Vinyl/EAC-Desktop', 'https://github.com/Ebony-Vinyl/EAC-Pack', 'https://github.com/Ebony-Vinyl/EAC-design-world']) {
    assert.equal(hrefs.includes(repo), true, `${repo} is linked`)
  }
  const body = words.join(' ')
  for (const name of ['EAC-Desktop', 'EAC-Pack', 'EAC-design-world']) assert.equal(body.includes(name), true, `${name} is named`)
})

console.log(failures === 0 ? '\npicks-ui: three cards, three working asks' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
