/** 从当前 TSX 源码在内存构建，使用真实 React、虚拟表格和本机管理摘要；无需生成 web 资源。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createRuntimeStores, createModelRuntime } from '../src/core/runtime.js'
import { createManagement } from '../packages/standalone/management.mjs'
import { standaloneSharedUi } from './lib/standalone-shared-ui.mjs'

const require = createRequire(import.meta.url)
const standaloneRequire = createRequire(new URL('../packages/standalone/package.json', import.meta.url))
const { build } = standaloneRequire('esbuild')
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const frontend = fileURLToPath(new URL('../packages/standalone/frontend/', import.meta.url))
const key = 'isolated-model-row-fixture'
const logger = { warn() {} }
const failure = '上游连接中断：' + 'ConnectionReset'.repeat(20)
const stop = { type: 'finish', reason: { kind: 'stop' } }
const answer = async function* () { yield { type: 'text-delta', text: 'OK' }; yield stop }

test('standalone 真实模型行保留持久化实测结果、原因和原有筛选/路由', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-model-row-'))
  let stores, runtime, management, server, browser
  try {
    stores = createRuntimeStores({ dataDir, logger })
    stores.settings.update({ enabled: true, exposeRegionModels: true, combos: [], forwardKey: key })
    // 额外清单使窗口确实发生虚拟化；所有上游推理都由本机异步生成器提供。
    stores.catalogStore.update({ sealIds: Array.from({ length: 140 }, (_, i) => 'fixture/listed-' + i) })
    runtime = createModelRuntime({ ...stores, logger, sealedCredential: () => ({}) })
    const [failedId, successId, untouchedId, probedId] = runtime.catalog.map(row => row.id)
    const listedId = runtime.catalog.find(row => row.channel === 'eac').id
    const lastId = runtime.catalog.at(-1).id
    const routesBefore = runtime.publicModelRows().map(row => row.id)
    runtime.adapter.stream = answer
    await runtime.testModel(failedId)
    await runtime.testModel(successId)
    runtime.adapter.stream = async function* () { throw new Error(failure) }
    await assert.rejects(runtime.testModel(failedId), /ConnectionReset/)
    stores.availability.edit(value => ({ ...value, results: { ...value.results, [probedId]: { state: 'available', at: Date.now() } } }))
    stores.availability.flush()
    stores.settings.flush(); stores.catalogStore.flush()
    const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'availability.json'), 'utf8'))
    const detail = saved.manualResults[failedId].detail
    assert.equal(saved.manualResults[failedId].state, 'unknown')
    assert.equal(saved.manualResults[failedId].source, 'manual')
    assert.equal(saved.manualResults[failedId].ttftMs, undefined, '失败覆盖成功后不保留旧速度')
    assert.equal(detail, failure.slice(0, 200))
    runtime.dispose(); stores.dispose()
    stores = createRuntimeStores({ dataDir, logger })
    runtime = createModelRuntime({ ...stores, logger, sealedCredential: () => ({}) })
    runtime.adapter.stream = async function* () { throw new Error(failure) }
    assert.deepEqual(stores.availability.get(), saved, '必须从磁盘重新读取真实失败记录')
    assert.deepEqual(runtime.publicModelRows().map(row => row.id), routesBefore, '失败模型保留原有路由')
    const settingsBefore = structuredClone(stores.settings.get())

    const shared = standaloneSharedUi()
    const bundle = await build({
      stdin: { resolveDir: frontend, sourcefile: 'model-row-fixture.tsx', loader: 'tsx', contents: [
        "import { createRoot } from 'react-dom/client'",
        "import { Models } from './models'",
        "const root = createRoot(document.getElementById('root'))",
        'async function request(endpoint, body, signal) {',
        '  const response = await fetch("/api/management" + endpoint, { signal, headers: { authorization: "Bearer " + ' + JSON.stringify(key) + ', "content-type": "application/json" }, ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }) })',
        '  const value = await response.json(); if (!response.ok) throw new Error(value.error); return value',
        '}',
        'const host = { refresh, refreshModels: refresh, testModel: (model, signal) => request("/models/test", { model }, signal), copy: async () => {}, saveSettings: async () => { throw new Error("unexpected settings write") }, error: error => { throw error } }',
        'async function refresh() { const summary = await request("/summary"); window.rowSummary = summary; root.render(<Models summary={summary} host={host} active={true} />) }',
        'void refresh()',
      ].join('\n') },
      bundle: true, write: false, outfile: path.join(frontend, 'model-row-fixture.js'), format: 'iife', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'actual-standalone-provider-list', setup(builder) {
        builder.onResolve({ filter: /^ofm-provider-list$/ }, () => ({ path: 'ofm-provider-list', namespace: 'shared' }))
        builder.onLoad({ filter: /.*/, namespace: 'shared' }, () => ({ contents: shared.load('\0ofm-provider-list'), loader: 'js' }))
      } }],
    })
    const script = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents
    const modelCss = bundle.outputFiles.find(file => file.path.endsWith('.css')).text
    const baseCss = fs.readFileSync(path.join(frontend, 'app.css'), 'utf8').replace(/^@import[^\n]*\n/, '')
    const css = baseCss + '\n' + modelCss
    management = createManagement({ stores, runtime, info: () => ({ version: 'row-test', dataDir, networkMode: 'fixture' }) })
    let summaryReads = 0
    server = http.createServer((req, res) => {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/row-test.css"></head><body><div id="root"></div><script src="/row-test.js"></script></body></html>') }
      if (req.url === '/row-test.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(script) }
      if (req.url === '/row-test.css') { res.writeHead(200, { 'content-type': 'text/css' }); return res.end(css) }
      if (req.url === '/api/management/summary') summaryReads++
      void management.handleRequest(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end() } })
    })
    server.listen(0, '127.0.0.1'); await once(server, 'listening')
    management.setPort(server.address().port)
    const origin = 'http://127.0.0.1:' + server.address().port
    browser = await chromium.launch({ headless: true, ...(process.env.OFM_BROWSER_PATH ? { executablePath: process.env.OFM_BROWSER_PATH } : {}) })
    const errors = [], externalRequests = []
    const rowFor = (page, id) => page.locator('[data-model-id=' + JSON.stringify(id) + ']')
    const findRow = async (page, id) => {
      await page.getByRole('searchbox', { name: '搜索模型' }).fill(id)
      const row = rowFor(page, id)
      await row.waitFor()
      return row
    }
    const failedRow = async page => {
      const row = rowFor(page, failedId)
      await row.waitFor()
      const state = row.locator('.model-state')
      assert.equal(await state.locator('.ui-badge').textContent(), '实测失败')
      assert.equal(await state.locator('.ui-badge-warning').count(), 1, '失败必须使用警示色')
      assert.equal(await state.locator('.ui-badge-success').count(), 0, '失败不得误标绿色可用')
      assert.equal(await state.locator('small[title]').textContent(), detail)
      assert.equal(await state.locator('small[title]').getAttribute('title'), detail)
      assert.ok((await row.ariaSnapshot()).includes(detail), '读屏树必须保留完整失败原因')
      assert.equal(await row.getByRole('button', { name: '测试模型：' + failedId, exact: true }).isEnabled(), true, '失败模型仍可发起测试')
      return row
    }

    for (const [name, width] of [['桌面', 1280], ['窄屏', 390]]) {
      await t.test(name + '：磁盘重载、真实摘要、可访问原因、筛选和虚拟化', async () => {
        const context = await browser.newContext({ viewport: { width, height: 900 } })
        await context.route('**/*', route => {
          if (new URL(route.request().url()).origin !== origin) { externalRequests.push(route.request().url()); return route.abort() }
          return route.continue()
        })
        try {
          const page = await context.newPage()
          page.setDefaultTimeout(8000)
          page.on('pageerror', error => errors.push(error.message))
          await page.goto(origin)
          await failedRow(page)
          const summary = await page.evaluate(() => window.rowSummary)
          const measured = summary.catalog.find(row => row.id === failedId)
          assert.equal(measured.availabilitySource, 'manual')
          assert.equal(measured.availability, 'unknown')
          assert.equal(measured.detail, detail)
          assert.equal(measured.routable, true)

          for (const [id, label, tone] of [[successId, '实测可用', 'success'], [untouchedId, '未探测', 'neutral'], [probedId, '已探测可用', 'success'], [listedId, '清单已收录', 'neutral']]) {
            const row = await findRow(page, id)
            assert.equal(await row.locator('.model-state .ui-badge').textContent(), label)
            assert.equal(await row.locator('.model-state .ui-badge-' + tone).count(), 1)
          }
          await page.getByRole('searchbox', { name: '搜索模型' }).fill('')
          await page.getByRole('combobox', { name: '筛选可用状态' }).selectOption('unknown')
          await failedRow(page)
          const unknown = summary.catalog.filter(row => (row.availability ?? 'unknown') === 'unknown')
          await page.waitForFunction(count => document.querySelector('[role=table]').getAttribute('aria-rowcount') === String(count + 1), unknown.length)
          await page.getByRole('combobox', { name: '筛选可用状态' }).selectOption('available')
          await page.waitForFunction(id => !document.querySelector('[data-model-id=' + JSON.stringify(id) + ']'), failedId)
          assert.equal(await rowFor(page, successId).count(), 1)
          await page.getByRole('combobox', { name: '筛选可用状态' }).selectOption('all')
          await page.getByRole('button', { name: '可接入', exact: true }).click()
          await failedRow(page)
          await page.getByRole('button', { name: '未公开', exact: true }).click()
          assert.equal(await rowFor(page, failedId).count(), 0)
          await page.getByRole('button', { name: '全部模型', exact: true }).click()
          await failedRow(page)
          await page.getByRole('combobox', { name: '筛选渠道' }).selectOption('eac')
          const listed = await findRow(page, listedId)
          assert.equal(await listed.locator('.model-state .ui-badge').textContent(), '清单已收录')
          await page.getByRole('combobox', { name: '筛选渠道' }).selectOption('all')
          await page.getByRole('searchbox', { name: '搜索模型' }).fill('')

          const readsBefore = summaryReads
          await page.reload()
          const row = await failedRow(page)
          assert.ok(summaryReads > readsBefore, '刷新必须重新读取真实管理摘要')
          await row.getByRole('button', { name: '测试模型：' + failedId, exact: true }).click()
          const result = page.getByRole('region', { name: '模型测试结果' })
          await result.locator('p').waitFor()
          assert.ok((await result.textContent()).includes(detail))
          assert.equal(await result.locator('pre').count(), 0, '失败测试不能渲染成功回答')
          await page.reload()
          await failedRow(page)
          assert.ok(await page.locator('[data-model-id]').count() < summary.catalog.length, '必须使用真实虚拟化，不能挂载全部模型')
          assert.equal(await row.evaluate(element => element.scrollWidth <= element.clientWidth), true, '长错误不能撑宽模型行')
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '页面不能产生横向溢出')
          const scroll = page.getByRole('rowgroup', { name: '滚动模型列表' })
          await scroll.press('End')
          await rowFor(page, lastId).waitFor()
          assert.equal(await rowFor(page, lastId).locator('.model-state .ui-badge').textContent(), '清单已收录')
          const bounds = await page.locator('[data-model-id]').evaluateAll(rows => rows.map(row => ({ top: row.getBoundingClientRect().top, bottom: row.getBoundingClientRect().bottom })))
          for (let i = 1; i < bounds.length; i++) assert.ok(bounds[i].top >= bounds[i - 1].bottom - 1, '虚拟行测量后不得互相重叠')
        } finally { await context.close() }
      })
    }
    await t.test('旧摘要把 listing 写成 available 时仍不冒充实测成功', async () => {
      const context = await browser.newContext()
      try {
        const page = await context.newPage()
        await page.route('**/api/management/summary', async route => {
          const response = await route.fetch()
          const summary = await response.json()
          summary.catalog.find(row => row.id === listedId).availability = 'available'
          await route.fulfill({ response, json: summary })
        })
        await page.goto(origin)
        await page.getByTestId('models-ready').waitFor()
        const row = await findRow(page, listedId)
        assert.equal(await row.locator('.model-state .ui-badge').textContent(), '清单已收录')
        assert.equal(await row.locator('.model-state .ui-badge-success').count(), 0)
      } finally { await context.close() }
    })
    assert.deepEqual(errors, [], '真实 React 不得出现运行错误')
    assert.deepEqual(externalRequests, [], '测试仅访问本机')
    assert.deepEqual(stores.settings.get(), settingsBefore, '筛选和渲染不得改写设置')
    assert.deepEqual(runtime.publicModelRows().map(row => row.id), routesBefore, '测试和筛选后失败模型仍保留在原路由')
  } finally {
    await browser?.close()
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    management?.dispose(); runtime?.dispose(); stores?.dispose()
    // 递归清理仅限本测试刚创建的临时目录。
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()))
    assert.ok(path.basename(dataDir).startsWith('ofm-model-row-'))
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
