import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  .replace('exports.__test = {', 'exports.__test = { ChannelCard, CHANNEL_PROVIDERS, localeTag,')
const expected = [
  ['lobsterai', 'LobsterAI', 'Youdao', 'Lobster · daily check-in credits'],
  ['qoder', 'Qoder', 'Alibaba', '100 Credits daily, encrypted inference endpoint'],
  ['qodercn', 'Qoder China', 'Alibaba', 'China endpoints and model pool'],
  ['trae', 'TRAE', 'ByteDance', 'Phone number sign-in'],
  ['cline', 'Cline', 'Cline', 'Free quota with a Cline account'],
  ['loomy', 'Loomy', 'iFlytek', 'Scan with WeChat, or use an SMS code'],
  ['raccoon', 'Raccoon', 'SenseTime', 'Phone number sign-in'],
  ['minimax', 'MiniMax Code', 'MiniMax', 'Device code + PKCE, daily check-in'],
  ['zcode', 'ZCode', 'Zhipu', 'Browser sign-in (requires a local browser)'],
  ['gemini', 'Gemini', 'Google Code Assist', 'Free OAuth lane with a local callback'],
]
const originals = [
  ['LobsterAI', '有道', '龙虾 · 每日签到积分'],
  ['Qoder', '阿里系', '每日 100 Credits，加密推理端点'],
  ['Qoder 中国版', '阿里系', '中国版端点与模型池'],
  ['TRAE', '字节', '手机号登录'],
  ['Cline', 'Cline', 'Cline 账号免费额度'],
  ['Loomy', '讯飞', '微信扫码，或短信验证码备用'],
  ['Raccoon', '商汤', '手机号登录'],
  ['MiniMax Code', 'MiniMax', '设备码 + PKCE，每日签到'],
  ['ZCode', '智谱', '浏览器登录（需本机可开浏览器）'],
  ['Gemini', 'Google Code Assist', '本地回调 OAuth 免费线'],
]

function mount(active = 'en') {
  let record, cursor = 0
  let cells = []
  const storage = new Map([['external-language', 'zh'], ['ofm:zcode:login-provider', 'zai']])
  const beforeStorage = [...storage]
  const window = {
    __ModuleLoader__: { load: value => { record = value } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value) },
    },
  }
  const document = { documentElement: { lang: 'zh-CN' } }
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef: initial => cells[cursor++] ??= { current: initial },
    useEffect() {},
    useMemo: fn => fn(),
    useCallback: fn => fn,
  }
  new Function('window', 'document', source)(window, document)
  const plugin = record.factory(() => react)
  let dictionaries
  const locale = {
    getLocale: () => ({ active }),
    bind(namespace) {
      assert.equal(namespace, 'settings.ourFreeModel')
      return key => {
        const language = /^zh/i.test(active) ? 'zh' : 'en'
        assert.ok(key in dictionaries[language], `missing ${language} translation: ${key}`)
        return dictionaries[language][key]
      }
    },
    register(namespace, value) {
      assert.equal(namespace, 'settings.ourFreeModel')
      dictionaries = value
    },
  }
  const ctx = {
    locale,
    effect: (fn, label) => { if (label === 'our-free-model: dictionaries') fn() },
    slots: { inject() {} },
  }
  plugin.apply(ctx)
  const t = locale.bind('settings.ourFreeModel')
  const render = (component, props, fresh = false) => {
    cursor = 0
    if (fresh) cells = []
    return component(props)
  }
  return { ...plugin.__test, ctx, t, render, storage, beforeStorage, language: value => { active = value } }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  return tree && typeof tree === 'object' ? text(tree.children) : typeof tree === 'string' ? tree : ''
}
function card(app, channel) {
  return app.render(app.ChannelCard, { channel, t: app.t, rpc: null, compact: true }, true)
}

for (const [index, [id, ...copy]] of expected.entries()) {
  test(`channel ${id} renders English via the host dictionary and retains Chinese`, () => {
    const app = mount()
    const channel = app.CHANNEL_PROVIDERS[index]
    assert.equal(channel.id, id)
    const before = structuredClone(channel)
    const english = card(app, channel)
    for (const value of copy) assert.ok(text(english).includes(value), `missing English copy: ${value}`)
    assert.doesNotMatch(text(english), /\p{Script=Han}/u)
    assert.equal(nodes(english).find(node => node.type === 'article').props['data-channel'], id)
    app.language('zh-CN')
    for (const value of originals[index]) assert.ok(text(card(app, channel)).includes(value), `changed Chinese copy: ${value}`)
    assert.deepEqual(channel, before, 'localization must not mutate provider descriptors')
    assert.deepEqual([...app.storage], app.beforeStorage, 'rendering must not rewrite preferences')
  })
}

test('channel directory searches translated labels, original labels and stable IDs', () => {
  const app = mount()
  const props = { t: app.t, ctx: {}, summary: {} }
  const find = query => {
    const tree = app.render(app.ChannelsPage, props)
    nodes(tree).find(node => node.type === 'input' && node.props.type === 'search').props.onChange({ target: { value: query } })
    return nodes(app.render(app.ChannelsPage, props)).filter(node => node.type === app.ChannelCard).map(node => node.props.channel.id)
  }
  assert.deepEqual(find('Alibaba'), ['qoder', 'qodercn'])
  assert.deepEqual(find('Qoder China'), ['qodercn'])
  assert.deepEqual(find('阿里系'), ['qoder', 'qodercn'])
  assert.deepEqual(find('qodercn'), ['qodercn'])
  app.language('zh-CN')
  assert.deepEqual(find('中国版'), ['qodercn'])
})

test('hot badge and announcement use consistent localized copy', () => {
  const app = mount()
  assert.equal(app.t('tag.hot'), 'HOT')
  assert.ok(app.t('ann.n2').includes('NEW / HOT'))
  assert.doesNotMatch(app.t('ann.n2'), /\p{Script=Han}/u)
  app.language('zh-CN')
  assert.equal(app.t('tag.hot'), '爆')
  assert.ok(app.t('ann.n2').includes('NEW / 爆'))
})

test('host locale wins over browser language without saving a plugin preference', () => {
  const app = mount('en')
  assert.equal(app.localeTag(app.ctx), 'en')
  app.language('zh-CN')
  assert.equal(app.localeTag(app.ctx), 'zh-CN')
  assert.deepEqual([...app.storage], app.beforeStorage)
})
