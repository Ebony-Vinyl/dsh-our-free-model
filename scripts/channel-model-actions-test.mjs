import assert from 'node:assert/strict'
import fs from 'node:fs'

/** 挂载实际共享渠道卡片，检查批量操作及加载、失败、重复点击路径。 */
export async function verifyChannelModelActions() {
  let bundle
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('exports.__test = {', 'exports.__test = { ChannelCard, DICT,')
  const window = { __ModuleLoader__: { load: value => { bundle = value } } }
  new Function('window', source)(window)
  let cursor = 0
  const cells = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    Fragment: 'fragment',
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], value => { cells[index] = typeof value === 'function' ? value(cells[index]) : value }]
    },
    useRef(initial) {
      const index = cursor++
      return cells[index] ??= { current: initial }
    },
    useEffect() {},
    useMemo: callback => callback(),
    useCallback: callback => callback,
  }
  const { ChannelCard, DICT } = bundle.factory(() => react).__test
  let rows = [{ id: 'one', disabled: false }, { id: 'two', disabled: true }]
  let changed = 0
  const calls = [], errors = []
  let fail = false, release
  let hold = false
  const props = {
    channel: { id: 'codearts', name: 'CodeArts', org: '测试', accent: '#C7000B' },
    status: { accounts: { total: 0, enabled: 0 }, models: { total: 2, disabled: 1 } },
    t: key => DICT.zh[key],
    onChanged: () => { changed++ },
    onError: (_channel, error) => errors.push(error.message),
    rpc: async (method, payload) => {
      calls.push({ method, payload })
      if (method === 'model.setAllDisabled') {
        if (hold) await new Promise(resolve => { release = resolve })
        if (fail) throw new Error('批量更新失败')
        rows = rows.map(row => ({ ...row, disabled: payload.disabled }))
        return {}
      }
      assert.equal(method, 'model.list')
      return { models: rows }
    },
  }
  const render = () => { cursor = 0; return ChannelCard(props) }
  render()
  cells[0] = 'models'
  cells[2] = rows
  const buttons = tree => {
    const result = []
    const visit = node => {
      if (Array.isArray(node)) { node.forEach(visit); return }
      if (!node || typeof node !== 'object') return
      if (node.type === 'button') result.push(node)
      visit(node.children)
    }
    visit(tree)
    return result
  }
  const button = (label, tree = render()) => buttons(tree).find(node => node.children.includes(label))
  const settle = () => new Promise(resolve => setImmediate(resolve))
  assert.equal(button('全部开启').props.disabled, false)
  assert.equal(button('全部关闭').props.disabled, false)
  assert.ok(button('开启') && button('关闭'), '单模型按钮应说明将执行的动作，不能将动作伪装成当前状态')
  hold = true
  button('全部关闭').props.onClick()
  button('全部开启').props.onClick()
  assert.equal(calls.length, 1, '同一批操作完成前重复点击只能发送一次请求')
  assert.deepEqual(calls[0], { method: 'model.setAllDisabled', payload: { provider: 'codearts', disabled: true } })
  const busy = render()
  assert.ok(buttons(busy).every(node => node.props.className === 'ofm_foldtoggle' || node.props.disabled),
    '批量请求期间禁用单模型和其他写入按钮')
  assert.equal(button('全部关闭', busy).props['aria-busy'], 'true')
  release()
  await settle()
  assert.ok(cells[2].every(row => row.disabled === true))
  assert.equal(changed, 1)
  assert.equal(calls.filter(call => call.method === 'model.list').length, 1)
  assert.equal(button('全部关闭').props.disabled, false)
  hold = false
  button('全部开启').props.onClick()
  await settle()
  assert.ok(cells[2].every(row => row.disabled === false))
  assert.equal(changed, 2)
  assert.equal(calls.filter(call => call.method === 'model.setDisabled').length, 0, '禁止逐模型循环写入')
  fail = true
  button('全部关闭').props.onClick()
  await settle()
  assert.deepEqual(errors, ['批量更新失败'])
  assert.ok(cells[2].every(row => row.disabled === false), '失败后不能虚构新的开关状态')
  assert.equal(changed, 2)
  assert.equal(button('全部开启').props.disabled, false, '失败后恢复操作能力')
  cells[2] = undefined
  assert.equal(button('全部开启'), undefined, '加载中不能批量修改')
  cells[2] = []
  assert.equal(button('全部关闭'), undefined, '空目录不能批量修改')
}
