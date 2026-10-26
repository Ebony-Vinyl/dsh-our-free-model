/** Real bundled UI: host themes, core copy, data preservation and sandbox scope. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { createMagpieEngine, MAGPIE_UI_PREFIX as prefix } from '../src/magpie-engine.js'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.OFM_PLAYWRIGHT_MODULE ?? 'D:/Cache/npm-global/node_modules/playwright')
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-engine-appearance-'))
const config = path.join(scratch, 'data/magpie/config/magpie')
const plugin = path.join(scratch, 'fixture-plugin')
fs.mkdirSync(config, { recursive: true })
fs.mkdirSync(path.join(plugin, 'page'), { recursive: true })
fs.writeFileSync(path.join(config, 'settings.json'), JSON.stringify({
  noAccountDiscovery: true, noStats: true, noUsageStats: true, noWSLAgents: true,
  noAutoUpdate: true, noAutoDownload: true, autoRestart: false, lang: 'en', theme: 'light',
}))
fs.writeFileSync(path.join(plugin, 'package.json'), JSON.stringify({
  name: 'ofm-appearance-fixture', version: '1.0.0',
  magpie: { page: { title: 'Plugin magpie content', file: 'page/index.html' } },
}))
fs.writeFileSync(path.join(plugin, 'page/index.html'),
  '<!doctype html><html><head></head><body><p>Plugin magpie content</p><script src="app.js"></script></body></html>')
fs.writeFileSync(path.join(plugin, 'page/app.js'), 'document.body.dataset.loaded="yes"')
fs.writeFileSync(path.join(config, 'plugins.json'), JSON.stringify({ plugins: [{ spec: plugin }] }))
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data') })
let server, browser
try {
  await engine.start()
  const before = fs.readFileSync(path.join(config, 'settings.json'), 'utf8')
  const upstream = await (await engine.request('GET', '/')).text()
  assert.match(upstream, /<title>magpie<\/title>/)
  const pages = await (await engine.request('GET', '/api/plugin-pages')).json()
  const extension = pages.find(row => row.title === 'Plugin magpie content')
  assert.ok(extension)
  server = http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><html><body style="margin:0"><iframe id="engine" style="width:100%;height:100vh;border:0" src="${prefix}?mode=window&view=providers"></iframe><iframe id="sibling" hidden></iframe></body></html>`)
    } else if (req.url.startsWith(prefix)) {
      void engine.proxy(req, res, req.url.slice(prefix.length)).catch(() => res.destroy())
    } else { res.writeHead(404); res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
  browser = await chromium.launch({ headless: true, ...(fs.existsSync(edge) ? { executablePath: edge } : {}) })
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(origin)
  const frame = await page.locator('#engine').elementHandle().then(handle => handle.contentFrame())
  await frame.locator('#view-providers').waitFor({ state: 'visible' })
  await frame.locator('#addSheet input.find').waitFor({ state: 'visible' })
  assert.equal(await frame.title(), 'Our Free Model')
  assert.equal(await frame.locator('.brand:visible').count(), 0)
  assert.equal(await frame.locator('link[rel=icon]').count(), 0)
  assert.doesNotMatch(await frame.locator('#view-providers').innerText(), /\bmagpie\b/i)
  assert.equal(await frame.getByText('Plugin magpie content', { exact: true }).isVisible(), true)
  assert.equal(await frame.getByText('Remote Our Free Model', { exact: true }).isVisible(), true)
  assert.equal(await frame.evaluate(() => providers.presets.find(preset => preset.id === 'remote-magpie')?.name), 'Remote magpie')
  console.log('ok main UI hides upstream brand and preserves real provider controls')

  const theme = {
    type: 'ofm:engine-theme', fontFamily: '"Arial", sans-serif', colorScheme: 'light',
    variables: {
      '--dsw-alias-bg-layer-1': '#f6f7f8', '--dsw-alias-bg-layer-2': '#eef0f2',
      '--dsw-alias-bg-layer-3': '#ffffff', '--dsw-alias-label-primary': '#202124',
      '--dsw-alias-label-secondary': '#50545a', '--dsw-alias-label-tertiary': '#737880',
      '--dsw-alias-border-l1': '#e0e3e6', '--dsw-alias-border-l2': '#cdd1d6',
      '--dsw-alias-state-business-primary': '#267157', '--dsw-alias-state-success-primary': '#147d49',
      '--dsw-alias-state-error-primary': '#b82d40', '--dsw-alias-state-warning-primary': '#9f640c',
    },
  }
  const send = data => page.evaluate(data => {
    document.querySelector('#engine').contentWindow.postMessage(data, location.origin)
  }, data)
  const appearance = () => frame.evaluate(() => {
    const style = getComputedStyle(document.documentElement)
    const body = getComputedStyle(document.body)
    return {
      scheme: document.documentElement.getAttribute('data-ofm-engine-theme'),
      bg: body.backgroundColor, fg: body.color, font: body.fontFamily, colorScheme: style.colorScheme,
      accent: style.getPropertyValue('--accent').trim(),
      warning: style.getPropertyValue('--amber').trim(),
    }
  })
  await page.frames().find(item => item !== page.mainFrame() && item !== frame).evaluate(theme => {
    parent.document.querySelector('#engine').contentWindow.postMessage(theme, parent.location.origin)
  }, theme)
  await frame.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal((await appearance()).scheme, null, 'same-origin siblings cannot style the engine')
  await frame.evaluate(theme => window.dispatchEvent(new MessageEvent('message', {
    data: theme, origin: 'https://untrusted.invalid', source: parent,
  })), theme)
  assert.equal((await appearance()).scheme, null, 'a mismatched origin must be rejected')
  await send(theme)
  await frame.waitForFunction(() => document.documentElement.dataset.ofmEngineTheme === 'light')
  assert.deepEqual(await appearance(), {
    scheme: 'light', bg: 'rgb(246, 247, 248)', fg: 'rgb(32, 33, 36)',
    font: 'Arial, sans-serif', colorScheme: 'light', accent: '#267157', warning: '#9f640c',
  })
  const light = await appearance()
  for (const invalid of [
    { ...theme, variables: [] },
    { ...theme, variables: { '--bg': 'red' } },
    { ...theme, variables: { '--dsw-alias-bg-layer-1': 'red;display:none' } },
    { ...theme, variables: { '--dsw-alias-bg-layer-1': 'url(https://untrusted.invalid)' } },
    { ...theme, colorScheme: 'invalid' },
    { ...theme, fontFamily: 'Arial;display:none' },
  ]) {
    await send(invalid)
    await frame.evaluate(() => new Promise(requestAnimationFrame))
    assert.deepEqual(await appearance(), light)
  }
  const dark = {
    type: theme.type, colorScheme: 'dark', fontFamily: '"Segoe UI", sans-serif',
    variables: {
      '--dsw-alias-bg-layer-1': '#17191c', '--dsw-alias-bg-layer-3': '#282b30',
      '--dsw-alias-label-primary': '#f1f3f5', '--dsw-alias-state-business-primary': '#77c6aa',
    },
  }
  await send(dark)
  await frame.waitForFunction(() => document.documentElement.dataset.ofmEngineTheme === 'dark')
  assert.equal((await appearance()).bg, 'rgb(23, 25, 28)')
  assert.equal((await appearance()).fg, 'rgb(241, 243, 245)')
  assert.equal((await appearance()).colorScheme, 'dark')
  assert.equal(await frame.evaluate(() => document.documentElement.style.getPropertyValue('--dsw-alias-state-warning-primary')), '')
  await frame.evaluate(() => { document.documentElement.dataset.theme = 'light' })
  await frame.waitForFunction(() => document.documentElement.dataset.theme === 'dark')
  console.log('ok parent-only theme messages apply live; malformed values are rejected and stale tokens removed')

  await frame.locator('#prefs').click()
  await frame.locator('#setPage-general').waitFor({ state: 'visible' })
  const copy = await frame.evaluate(() => {
    const label = document.querySelector('#view-settings [data-en*="Menu bar magpie"]')
    const templated = t('Add a provider or subscription in magpie first, then connect {agent}', { agent: 'my magpie provider' })
    const preserved = t('{name}', { name: 'User magpie record' })
    const technical = t('magpie quota or accounts')
    const providerSlot = t("Switch an agent on and the models you set up in magpie show up as the {magpie} provider in its own model list; or pick its model right here.", { magpie: 'magpie' })
    // A late plugin's own template is deliberately outside the core snapshot.
    I18N.en ??= {}
    I18N.en['Plugin magpie message'] = 'Plugin magpie message'
    const pluginCopy = t('Plugin magpie message')
    const english = label?.textContent
    setLocale('zh')
    const chinese = label?.textContent
    setLocale('en')
    return { english, chinese, templated, preserved, technical, pluginCopy, providerSlot }
  })
  assert.match(copy.english, /Our Free Model/)
  assert.match(copy.chinese, /Our Free Model/)
  assert.equal(copy.templated, 'Add a provider or subscription in Our Free Model first, then connect my magpie provider')
  assert.equal(copy.preserved, 'User magpie record')
  assert.equal(copy.technical, 'magpie quota or accounts')
  assert.equal(copy.pluginCopy, 'Plugin magpie message')
  assert.match(copy.providerSlot, /in Our Free Model show up as the magpie provider/)
  assert.doesNotMatch(await frame.locator('#setPage-general').innerText(), /\bmagpie\b/i)
  await frame.locator('#setTab-about:visible,[data-of="setTab-about"]:visible').click()
  await frame.locator('#setPage-about').waitFor({ state: 'visible' })
  assert.equal(await frame.locator('#about .discord:visible,#about .github:visible').count(), 0)
  assert.match(await frame.locator('#about .update-auto-row .sub').innerText(), /Our Free Model/)
  assert.equal(await frame.locator('#openMain').isVisible(), false)
  console.log('ok settings copy follows language changes; user values, commands and plugin copy are preserved')

  for (const locale of ['en', 'zh']) {
    await frame.evaluate(locale => setLocale(locale), locale)
    await frame.locator('#nav button[data-view=routing]').click()
    const hub = frame.locator('#view-routing .rt-hub')
    await hub.getByText('Our Free Model', { exact: true }).waitFor()
    assert.equal(await hub.locator('svg.rt-bird').count(), 0)
    await frame.waitForFunction(() => {
      const image = document.querySelector('#view-routing .rt-hub img.ofm-brand-icon')
      return image?.complete && image.naturalWidth > 0
    })
    await frame.locator('#view-routing .rt-mode').filter({ hasText: 'Our Free Model' }).waitFor()
    assert.doesNotMatch(await frame.locator('#view-routing').innerText(), /\bmagpie\b/i)
    assert.match(await hub.locator('small').innerText(), /^127\.0\.0\.1:\d+$/)
    assert.equal(await frame.evaluate(() => t('{name}', { name: 'User magpie record' })), 'User magpie record')
  }
  await frame.evaluate(() => setLocale('en'))
  console.log('ok routing uses the host name/icon and bundled page translations in both languages; user values and gateway address are preserved')

  await frame.locator('#nav button[data-view=providers]').click()
  await frame.locator('#view-providers').waitFor({ state: 'visible' })
  await frame.locator('#view-providers[aria-busy=true]').waitFor({ state: 'hidden' })
  await frame.evaluate(() => {
    // Exercise the exact upstream paid-section DOM without a remote sponsor feed.
    const sheet = document.querySelector('#addSheet')
    sheet.hidden = false
    const tiles = document.createElement('div')
    tiles.className = 'tiles'
    const heading = document.createElement('div')
    heading.className = 'kind'
    const name = document.createElement('b')
    name.textContent = t('Partners')
    heading.append(name)
    const grid = document.createElement('div')
    grid.className = 'grid'
    grid.textContent = 'Paid promotion fixture'
    tiles.append(heading, grid)
    sheet.append(tiles)
    const user = document.createElement('div')
    user.id = 'ofm-user-fixture'
    user.className = 'row'
    user.textContent = 'User magpie provider'
    const providersList = document.querySelector('#providers')
    providersList.hidden = false
    providersList.append(user)
  })
  await frame.locator('[data-ofm-promotion]').first().waitFor({ state: 'attached' })
  assert.equal(await frame.getByText('Paid promotion fixture', { exact: true }).isVisible(), false)
  assert.equal(await frame.getByText('User magpie provider', { exact: true }).isVisible(), true)
  console.log('ok paid discovery section is hidden while user provider content remains visible')

  await page.route('**/api/plugins/listings*', route => route.fulfill({
    json: { listings: [{
      package: 'ofm-plugin-search-fixture', name: 'Searchable fixture', community: true,
      summary: { en: 'Fixture subscription plugin', zh: 'Fixture subscription plugin' },
    }, {
      package: 'ofm-plugin-other-fixture', name: 'Different fixture', community: true,
      summary: { en: 'Another subscription plugin', zh: 'Another subscription plugin' },
    }] },
  }))
  await page.route('**/api/plugins/github*', route => route.fulfill({ json: { repos: [] } }))
  await page.route('**/api/plugins/npm*', route => route.fulfill({ json: { npm: {} } }))
  await page.route('**/api/plugins/search*', route => route.fulfill({ json: { hits: [] } }))
  await frame.locator('#nav button[data-view=plugins]').click()
  await frame.evaluate(() => window.pluginQuery(''))
  await frame.locator('#view-plugins .pm-intro').waitFor({ state: 'attached' })
  for (const locale of ['en', 'zh']) {
    await frame.evaluate(locale => setLocale(locale), locale)
    const nav = frame.locator('#nav button[data-view=plugins]')
    await frame.waitForFunction(() => document.querySelector('#nav button[data-view=plugins]').title === t('Plugins'))
    assert.equal(await nav.getAttribute('aria-label'), locale === 'zh' ? '插件' : 'Plugins')
    assert.equal(await nav.locator('span').isVisible(), false)
    assert.equal(await nav.locator('svg').isVisible(), true)
    assert.equal(await frame.locator('#view-plugins .pm-intro').isVisible(), false)
    assert.equal(await frame.locator('#view-plugins .pm-sechead:visible').count(), 0)
    assert.equal(await frame.locator('#view-plugins .pm-find input').isVisible(), true)
    assert.equal(await frame.locator('#view-plugins .pm-manual button[type=submit]').isVisible(), true)
    await frame.locator('#view-plugins .pm-card').filter({ hasText: 'Searchable fixture' }).waitFor()
    // The market is the magpie community's, and the page says so in the
    // reader's language on every tab that offers third-party code.
    const source = frame.locator('#view-plugins > .ofm-plugin-source')
    await source.waitFor({ state: 'visible' })
    assert.match(await source.innerText(), /magpie 社区|magpie community/)
    assert.match(await source.innerText(), /Our Free Model/)
    assert.equal(await source.evaluate(node => node.parentElement.id), 'view-plugins')
  }
  await frame.evaluate(() => document.querySelectorAll('#view-plugins .lib-tabs .opt')[0].click())
  await frame.locator('#view-plugins .pm-body').waitFor({ state: 'attached' })
  assert.equal(await frame.locator('#view-plugins > .ofm-plugin-source').count(), 0,
    'the built-in switches are the engine\'s own, not the community market')
  await frame.evaluate(() => document.querySelectorAll('#view-plugins .lib-tabs .opt')[1].click())
  await frame.locator('#view-plugins > .ofm-plugin-source').waitFor({ state: 'visible' })
  await frame.locator('#view-plugins .pm-find input').fill('Searchable')
  await frame.locator('#view-plugins .pm-card').filter({ hasText: 'Searchable fixture' }).waitFor()
  await frame.waitForFunction(() => document.querySelectorAll('#view-plugins .pm-card').length === 1)
  assert.equal(await frame.locator('#view-plugins .pm-card').count(), 1)
  await frame.locator('#view-plugins .pm-find input').fill('')
  await frame.locator('#view-plugins .pm-manual').waitFor()
  await send({ ...theme, externalControls: true })
  await frame.locator('html[data-ofm-external-controls]').waitFor()
  for (const [name, width, height] of [['desktop', 1200, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await frame.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name)
    assert.equal(await frame.locator('#view-plugins .pm-find input').isVisible(), true, name)
    assert.equal(await frame.locator('#view-plugins .pm-manual button[type=submit]').isVisible(), true, name)
    assert.equal(await frame.locator('#nav button[data-view=plugins] > .nav-ic').isVisible(), true, name)
    await page.screenshot({ path: path.join(scratch, `plugins-${name}.png`) })
  }
  await frame.evaluate(() => setLocale('en'))
  await frame.locator('#nav button[data-view=providers]').click()
  console.log('ok compact plugin page keeps accessible navigation, search, results and installation in both languages and viewport sizes')

  for (const [name, width, height] of [['desktop', 1200, 900], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height })
    await frame.evaluate(() => window.dispatchEvent(new Event('resize')))
    await frame.evaluate(() => new Promise(requestAnimationFrame))
    assert.equal(await frame.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name)
    await page.screenshot({ path: path.join(scratch, `${name}.png`) })
    assert.equal(await frame.locator('#addSheet input.find').isVisible(), true, name)
  }
  await send({ ...theme, externalControls: true })
  await frame.locator('html[data-ofm-external-controls]').waitFor()
  assert.equal(await frame.locator('#prefs').isVisible(), false)
  assert.equal(await frame.locator('#sync').isVisible(), false)
  const restoreRefresh = await frame.evaluateHandle(() => {
    const button = document.querySelector('#sync')
    const original = button.onclick
    button.onclick = () => { document.body.dataset.ofmRefreshInvoked = 'yes' }
    return () => { button.onclick = original }
  })
  await page.frames().find(item => item !== page.mainFrame() && item !== frame).evaluate(() => {
    parent.document.querySelector('#engine').contentWindow.postMessage({ type: 'ofm:engine-action', action: 'refresh' }, parent.location.origin)
  })
  await frame.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await frame.locator('body').getAttribute('data-ofm-refresh-invoked'), null)
  await send({ type: 'ofm:engine-action', action: 'refresh' })
  await frame.locator('body[data-ofm-refresh-invoked=yes]').waitFor()
  await restoreRefresh.evaluate(restore => restore())
  await restoreRefresh.dispose()
  await send({ type: 'ofm:engine-action', action: 'settings' })
  await frame.locator('#view-settings').waitFor({ state: 'visible' })
  console.log('ok external toolbar hides duplicate controls; parent refresh/settings actions work and sibling messages are rejected')
  const asset = prefix.slice(0, -1) + extension.url
  const sandboxHTML = await (await fetch(origin + asset)).text()
  assert.doesNotMatch(sandboxHTML, /ofm-engine-appearance|ofm:engine-theme|Our Free Model|<base/)
  await page.evaluate(asset => {
    const iframe = document.createElement('iframe')
    iframe.id = 'plugin'
    iframe.sandbox = 'allow-scripts'
    iframe.src = asset
    document.body.append(iframe)
  }, asset)
  const sandbox = page.frameLocator('#plugin')
  await sandbox.locator('body[data-loaded=yes]').waitFor()
  assert.equal(await sandbox.locator('p').innerText(), 'Plugin magpie content')
  assert.equal(await sandbox.locator('[data-ofm-engine]').count(), 0)
  assert.equal(fs.readFileSync(path.join(config, 'settings.json'), 'utf8'), before)
  assert.equal(await (await engine.request('GET', '/')).text(), upstream)
  assert.deepEqual(errors, [])
  console.log('ok desktop/mobile layouts, unmodified upstream HTML/preferences and isolated plugin scripts')
  console.log('engine-appearance: all browser checks passed')
} finally {
  await browser?.close()
  await engine.close()
  server?.closeAllConnections()
  if (server?.listening) await new Promise(resolve => server.close(resolve))
  assert.equal(path.dirname(scratch), fs.realpathSync(os.tmpdir()))
  fs.rmSync(scratch, { recursive: true, force: true })
}
