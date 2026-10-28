import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'playwright')
const linkFile = process.env.OFM_WORKBENCH_URL_FILE ?? '.verify/ui-phase1-url.txt'
const address = fs.readFileSync(linkFile, 'utf8').trim()
const outputDir = path.resolve('.verify/workbench-ui')
fs.mkdirSync(outputDir, { recursive: true })
const browser = await chromium.launch({ headless: true })
const errors = []
let checks = 0
const check = async (name, action) => { await action(); checks++; console.log(`ok ${name}`) }
try {
  const context = await browser.newContext()
  await context.addInitScript(() => {
    const now = new Date()
    localStorage.setItem('ofm.sponsor.last-shown.v1', `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`)
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(address)
  await page.waitForFunction(() => document.querySelector('#login-screen') || document.querySelector('nav.console-nav'))
  if (await page.getByTestId('login-screen').isVisible()) {
    const data = JSON.parse(fs.readFileSync('.verify/ui-phase1-data/settings.json', 'utf8'))
    await page.locator('#login-key').fill(data.managementKey ?? data.forwardKey)
    await page.locator('#login-form button[type=submit]').click()
  }
  const nav = async name => {
    const advertisement = page.locator('dialog.ofm-sponsor[open]')
    if (await advertisement.count()) await advertisement.getByRole('button', { name: /收起|关闭/ }).first().click()
    await page.getByRole('navigation', { name: '管理导航' }).getByRole('button', { name, exact: true }).click()
  }
  const api = async (endpoint, body) => page.evaluate(async ({ endpoint, body }) => {
    const response = await fetch('/api/management' + endpoint, {
      method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    return { status: response.status, body: await response.json() }
  }, { endpoint, body })
  await page.getByRole('navigation', { name: '管理导航' }).waitFor()
  const runningSummary = await api('/summary')
  assert.equal(runningSummary.body.networkMode, 'fixture', 'UI fixture verification requires the isolated preview service')
  for (const account of (await api('/subscriptions')).body.accounts) {
    if (account.label === 'UI fixture subscription') await api('/subscriptions/remove', { id: account.id })
  }
  await check('all provider presets render before credentials are configured', async () => {
    await nav('聚合渠道')
    await page.locator('.pd-row').first().waitFor()
    const result = await api('/providers')
    assert.equal(result.status, 200)
    assert.equal(result.body.registry.length, 76)
    assert.ok(await page.getByText('未连接', { exact: true }).count() > 0)
    await page.screenshot({ path: path.join(outputDir, 'providers-desktop.png'), fullPage: true })
  })
  await check('provider search and editor operate on real management API', async () => {
    const search = page.getByRole('textbox', { name: /搜索/ })
    await search.fill('DeepSeek')
    await page.waitForFunction(() => document.querySelectorAll('.pd-row').length === 1)
    assert.equal(await page.locator('.pd-row').count(), 1)
    await page.getByRole('button', { name: '连接', exact: true }).click()
    await page.getByRole('dialog').waitFor()
    await page.getByRole('dialog').getByLabel('API Key', { exact: true }).fill('fixture-workbench-key')
    await page.getByRole('dialog').getByRole('button', { name: /保存|连接/ }).last().click()
    await page.waitForFunction(async () => {
      const value = await (await fetch('/api/management/providers')).json()
      return value.configured.deepseek?.hasKey === true
    })
    const saved = await api('/providers')
    assert.equal(JSON.stringify(saved.body).includes('fixture-workbench-key'), false)
    await api('/providers/remove', { providerId: 'deepseek' })
    await page.keyboard.press('Escape')
  })
  await check('subscription import, quota unknown and immediate model publication are real', async () => {
    const account = await api('/subscriptions/import', {
      provider: 'api', label: 'UI fixture subscription', credentials: { apiKey: 'fixture-subscription-key' },
      baseUrl: 'http://127.0.0.1:1/v1', models: ['ui-model'], format: 'openai-chat',
    })
    assert.equal(account.status, 200)
    const row = account.body.accounts.find(item => item.label === 'UI fixture subscription')
    assert.ok(row)
    assert.equal(JSON.stringify(account.body).includes('fixture-subscription-key'), false)
    const summary = await api('/summary')
    assert.ok(summary.body.catalog.some(model => model.id === `subscription:${row.id}/ui-model`))
    await nav('客户端与订阅')
    await page.getByText('UI fixture subscription', { exact: true }).waitFor()
    assert.ok(await page.getByText(/未知|未查询/).count() > 0)
    await page.screenshot({ path: path.join(outputDir, 'agents-desktop.png'), fullPage: true })
    await api('/subscriptions/remove', { id: row.id })
    assert.ok(!(await api('/summary')).body.catalog.some(model => model.id === `subscription:${row.id}/ui-model`))
  })
  await check('EAC router shows retained channels and no removed providers', async () => {
    await nav('EAC router')
    await page.getByLabel('搜索渠道').waitFor()
    assert.equal(await page.getByRole('heading', { name: 'EAC router', exact: true }).count(), 1)
    const names = await page.locator('.channel-directory-row h2, .provider-card h2').allTextContents()
    assert.ok(names.length >= 10)
    assert.equal(names.some(name => /CodeBuddy|WorkBuddy/i.test(name)), false)
    await page.screenshot({ path: path.join(outputDir, 'eac-router-desktop.png'), fullPage: true })
  })
  await check('resource editor and saved client profiles persist through real management APIs', async () => {
    const existing = (await api('/library')).body
    for (const resource of existing.resources) {
      if (resource.name === 'UI review instructions') await api('/library/resources/remove', { id: resource.id })
    }
    for (const profile of existing.profiles) {
      if (profile.name === 'UI client profile') await api('/library/profiles/remove', { id: profile.id })
    }
    await nav('资源库')
    await page.getByRole('button', { name: '新建资源', exact: true }).first().click()
    const editor = page.getByRole('dialog')
    await editor.getByLabel('名称', { exact: true }).fill('UI review instructions')
    await editor.getByRole('combobox').selectOption('prompt')
    await editor.getByLabel('Markdown 内容', { exact: true }).fill('Read the existing project conventions before making changes.')
    await editor.getByRole('button', { name: '保存资源', exact: true }).click()
    await page.getByText('UI review instructions', { exact: true }).waitFor()
    let resource = (await api('/library')).body.resources.find(row => row.name === 'UI review instructions')
    assert.ok(resource?.enabled)
    await page.getByRole('switch', { name: '启用资源 UI review instructions', exact: true }).click()
    await page.waitForFunction(async () => {
      const value = await (await fetch('/api/management/library')).json()
      return value.resources.some(row => row.name === 'UI review instructions' && !row.enabled)
    })
    await page.getByRole('tab', { name: /配置方案/ }).click()
    await page.getByRole('button', { name: '保存当前配置', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('textbox').fill('UI client profile')
    await page.getByRole('dialog').getByRole('button', { name: /保存/ }).last().click()
    await page.getByText('UI client profile', { exact: true }).waitFor()
    const profile = (await api('/library')).body.profiles.find(row => row.name === 'UI client profile')
    assert.ok(profile?.clients.length === 6)
    await page.getByRole('button', { name: '应用', exact: true }).first().click()
    await page.getByText(/配置方案.*已应用|已应用.*配置|配置方案已生效/).first().waitFor()
    await page.screenshot({ path: path.join(outputDir, 'library-profiles.png'), fullPage: true })
    assert.equal((await api('/library/resources/remove', { id: resource.id })).status, 200)
    assert.equal((await api('/library/profiles/remove', { id: profile.id })).status, 200)
  })
  await check('routing editor saves ordered members and previews actual group capacity', async () => {
    const list = (await api('/routing')).body
    for (const group of list.combos) if (group.name === 'UI routing group') await api('/routing/remove', { id: group.id })
    await nav('路由组')
    await page.getByRole('button', { name: '新建路由组', exact: true }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: /名称|路由组名称/ }).first().fill('UI routing group')
    await dialog.getByRole('combobox', { name: '选择策略', exact: true }).selectOption('smart')
    await dialog.getByRole('button', { name: /^添加成员 / }).first().click()
    await dialog.getByRole('button', { name: /预览/ }).first().click()
    await dialog.getByText(/上下文/).first().waitFor()
    await dialog.getByRole('button', { name: '保存路由组', exact: true }).click()
    await page.getByText('UI routing group', { exact: true }).waitFor()
    const group = (await api('/routing')).body.combos.find(row => row.name === 'UI routing group')
    assert.equal(group.strategy, 'smart')
    assert.ok(group.models.length)
    await page.screenshot({ path: path.join(outputDir, 'routing-desktop.png'), fullPage: true })
    assert.equal((await api('/routing/remove', { id: group.id })).status, 200)
  })
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }], ['narrow', { width: 320, height: 740 }],
  ]) {
    await page.setViewportSize(viewport)
    for (const title of ['客户端与订阅', '聚合渠道', 'EAC router', '资源库', '路由组']) {
      await check(`${title} ${name} fits viewport`, async () => {
        await nav(title)
        await page.waitForTimeout(250)
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${title} overflow`)
        await page.screenshot({ path: path.join(outputDir, `${title === '聚合渠道' ? 'providers' : title === 'EAC router' ? 'router' : title === '资源库' ? 'library' : title === '路由组' ? 'routing' : 'agents'}-${name}.png`), fullPage: true })
      })
    }
  }
  await check('dark workbench headings and controls remain quiet and readable', async () => {
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark' })
    await nav('客户端与订阅')
    await page.locator('.wb-client').first().waitFor()
    const style = await page.locator('.wb-heading h1').evaluate(element => ({
      before: getComputedStyle(element, '::before').content,
      spacing: getComputedStyle(element).letterSpacing,
      shadow: getComputedStyle(element).textShadow,
    }))
    assert.ok(['none', 'normal', '""'].includes(style.before))
    assert.equal(style.spacing, 'normal' === style.spacing ? 'normal' : '0px')
    assert.equal(style.shadow, 'none')
    await page.screenshot({ path: path.join(outputDir, 'agents-dark-desktop.png') })
  })
  assert.deepEqual(errors, [])
  console.log(`workbench UI: ${checks} checks passed; real service and built assets; screenshots ${outputDir}`)
} finally { await browser.close() }
