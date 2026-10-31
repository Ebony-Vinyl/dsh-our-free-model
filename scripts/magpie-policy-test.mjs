/**
 * The excluded account channel stays out of the model workspace.
 *
 * WorkBuddy's China and international builds are not offered by this build.
 * The engine is a pinned binary whose plugin market is fetched at run time, so
 * the exclusion is enforced on this application's own management boundary:
 * market and provider answers are filtered, mutations are refused, and a model
 * the engine serves through the channel never reaches the published catalog.
 *
 * Runs against the real pinned executable, like magpie-engine-test.
 * Build first: node scripts/build-magpie-engine.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createMagpieEngine, MAGPIE_UI_PREFIX as prefix } from '../src/magpie-engine.js'
import { createMagpieModels } from '../src/magpie-models.js'
import { assertEngineMutation, deniedModel, filterEngineJSON, POLICY_REFUSED } from '../src/magpie-policy.js'
import { pinnedEngineEntry } from './lib/engine-binary.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-magpie-policy-'))
const saved = new Map()
for (const [name, value] of Object.entries({
  HOME: path.join(scratch, 'native-home'),
  USERPROFILE: path.join(scratch, 'native-home'),
  XDG_CONFIG_HOME: path.join(scratch, 'native-config'),
  XDG_CACHE_HOME: path.join(scratch, 'native-cache'),
  XDG_DATA_HOME: path.join(scratch, 'native-data'),
  XDG_STATE_HOME: path.join(scratch, 'native-state'),
})) {
  saved.set(name, process.env[name])
  process.env[name] = value
  fs.mkdirSync(value, { recursive: true })
}

const PACKAGE = '@magpie-community/opencode-workbuddy-auth'
const IDS = ['workbuddy', 'workbuddy-ai']
const engine = createMagpieEngine({ dataDir: path.join(scratch, 'data'), logger: {} })
let checks = 0
const check = async (name, run) => {
  await run()
  checks++
  console.log(`ok ${checks} - ${name}`)
}
const server = http.createServer((req, res) => {
  const subpath = req.url.startsWith(prefix) ? req.url.slice(prefix.length) : req.url
  engine.proxy(req, res, subpath).catch(() => { try { res.destroy() } catch {} })
})
const listen = () => new Promise((resolve, reject) => {
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`))
})
const mentions = value => JSON.stringify(value).toLowerCase().includes('workbuddy')
const denied = async (method, route, body) => {
  try {
    await engine.request(method, route, body === undefined ? {} : { body })
    return false
  } catch (error) {
    return error.statusCode === 403 && error.message === POLICY_REFUSED
  }
}

try {
  // The engine-backed groups need this platform's pinned binary; the pure-function
  // group at the end does not, so it still runs on a platform with no binary.
  const hasEngine = pinnedEngineEntry() !== null
  if (hasEngine) await engine.start()
  else console.log(`ok  engine-backed policy groups skipped: no pinned engine binary for ${process.platform}-${process.arch}`)
  const origin = hasEngine ? await listen() : null
  const base = origin === null ? null : origin + prefix
  const read = async route => {
    const response = await fetch(base + route)
    assert.equal(response.status, 200, route)
    return response.json()
  }
  const post = async (route, body) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  const engineCheck = async (name, run) => {
    if (!hasEngine) return
    await check(name, run)
  }

  await engineCheck('the plugin market no longer offers the channel', async () => {
    const listings = await read('api/plugins/listings')
    assert(!mentions(listings.listings), 'listings must not name the channel')
    assert(listings.listings.length > 5, 'other listings stay')
    const market = await read('api/plugins/market')
    assert(!mentions(market.listings), 'market listings must not name the channel')
    assert(market.listings.length > 5, 'other market listings stay')
    assert(Array.isArray(market.state.plugins), 'market state stays intact')
  })

  await engineCheck('npm search and metadata answers leave the package out', async () => {
    const search = await read('api/plugins/search?q=' + encodeURIComponent('workbuddy'))
    assert(!search.hits.some(hit => mentions(hit.package)), 'search hits must not name the package')
    const npm = await read('api/plugins/npm?names=' + encodeURIComponent(`${PACKAGE},@magpie-community/opencode-zcode-auth`))
    assert(!Object.keys(npm.npm).some(name => mentions(name)), 'npm metadata must not name the package')
    assert(Object.keys(npm.npm).some(name => /zcode/i.test(name)), 'other packages still answered')
    const page = await fetch(base + 'api/plugins/page?name=' + encodeURIComponent(PACKAGE))
    assert.equal(page.status, 403)
    assert.match(await page.text(), /not offered by this build/)
  })

  await engineCheck('installed-plugin and update listings stay clean', async () => {
    for (const route of ['api/plugins', 'api/plugins/updates', 'api/plugin-pages', 'api/plugin-panels',
      'api/plugins/github', 'api/usage/quotas', 'api/login/usage']) {
      assert(!mentions(await read(route)), route)
    }
    const checked = await (await post('api/plugins/check', {})).json()
    assert(!mentions(checked), 'a version check must not name the channel')
  })

  await engineCheck('providers keep the channel out of every route onto its plugin', async () => {
    const providers = await read('api/providers')
    assert(!Object.keys(providers.movesTo || {}).some(id => IDS.includes(id)), 'no move target')
    assert(!(providers.plugins || []).some(row => mentions(row)), 'no plugin subscription row')
    assert(!(providers.unmoved || []).some(row => IDS.includes(row.id)), 'no unmoved row')
    for (const provider of providers.providers || []) assert(!mentions(provider.move), 'no move offer')
    // The add sheet hides a deprecated built-in only while it has no account,
    // and reads that from this list: dropping the id would surface the tile.
    assert(IDS.every(id => providers.movable.includes(id)), 'movable stays whole')
    assert.equal(providers.presets.length > 5, true, 'presets stay')
  })

  await engineCheck('the Huawei Cloud channel is absent from the provider presets', async () => {
    const providers = await read('api/providers')
    assert(!providers.presets.some(preset => preset.id === 'huaweicloud'), 'no Huawei Cloud preset')
    assert(!JSON.stringify(providers.presets).toLowerCase().includes('huawei'), 'no Huawei Cloud name')
    assert(providers.presets.some(preset => preset.id === 'tencent-cloud'), 'other regional presets stay')
    const upstream = await read('api/upstream')
    assert(!Object.hasOwn(upstream.providers ?? {}, 'huaweicloud'), 'vendor status leaves the id out')
  })

  await engineCheck('all three excluded channels are absent, under every name they are sold as', async () => {
    // The China build is listed as "CodeBuddy" as often as "WorkBuddy", and the
    // international one as "workbuddy-ai"; a package, preset or provider row
    // could use any of them. None may reach a surface a user can act on.
    const spellings = /workbuddy|codebuddy|huaweicloud|huawei[\s-]*cloud|modelarts|codearts|华为云|码道/i
    const actionable = ['api/plugins', 'api/plugins/listings', 'api/plugins/market',
      'api/plugins/updates', 'api/plugin-pages', 'api/plugin-panels', 'api/importapps', 'api/upstream',
      'api/login/usage', 'api/usage/quotas']
    for (const route of actionable) {
      const answer = await read(route)
      assert(!spellings.test(JSON.stringify(answer)), `${route} must not name an excluded channel`)
    }
    // /api/providers keeps the engine's own deprecation list whole. That list is
    // what marks a built-in as deprecated and hides its add-sheet tile; removing
    // an id from it would surface the tile. What matters is that no route onto
    // the channel survives: no preset, no move target, no plugin row.
    const providers = await read('api/providers')
    assert(!providers.presets.some(preset => spellings.test(preset.id) || spellings.test(preset.name)),
      'no preset offers an excluded channel')
    assert(!Object.keys(providers.movesTo ?? {}).some(id => spellings.test(id)),
      'no move target reaches an excluded plugin')
    assert(!(providers.plugins ?? []).some(row => spellings.test(JSON.stringify(row))),
      'no plugin row offers an excluded channel')
    assert(!(providers.unmoved ?? []).some(row => spellings.test(JSON.stringify(row))),
      'no retired built-in is offered')
    // And each alias is refused where a mutation could enable one.
    for (const [route, body] of [
      ['/api/provider/save', { preset: 'codebuddy', key: 'fixture' }],
      ['/api/provider/save', { id: 'codebuddy', name: 'CodeBuddy', key: 'fixture' }],
      ['/api/provider/save', { preset: 'workbuddy-ai', key: 'fixture' }],
      ['/api/provider/save', { preset: 'codearts', key: 'fixture' }],
      ['/api/plugins/add', { spec: '@magpie-community/opencode-codebuddy-auth' }],
      ['/api/plugins/add', { spec: '@magpie-community/opencode-codearts-auth' }],
      ['/api/signin', { agent: 'codebuddy' }],
      ['/api/signin', { agent: 'codearts' }],
    ]) assert(await denied('POST', route, body), `${route} ${JSON.stringify(body)}`)
  })

  await check('the disclaimer names all three channels and states the responsibility boundary', async () => {
    const { DISCLAIMER, EXCLUDED_CHANNELS } = await import('../src/disclaimer.js')
    const named = EXCLUDED_CHANNELS.join(' ').toLowerCase()
    for (const channel of ['workbuddy', 'workbuddy-ai', 'codebuddy', 'huaweicloud']) {
      assert.match(named, new RegExp(channel), `the disclaimer names ${channel}`)
    }
    const body = DISCLAIMER.sections.map(section => section.body).join(' ')
    assert.match(body, /不包含、也不提供/, 'it says the build does not provide them')
    assert.match(body, /与本项目作者及团队无关/, 'it states the team is not responsible')
    assert.match(body, /个人学习/, 'it states the project purpose')
    assert.match(body, /自行承担/, 'it places the consequences on the user')
  })

  await engineCheck('saving a provider from the excluded preset is refused', async () => {
    assert(await denied('POST', '/api/provider/save', { preset: 'huaweicloud', key: 'fixture' }), 'preset save')
    assert(await denied('POST', '/api/provider/save', { id: 'huaweicloud', name: 'Huawei Cloud', key: 'fixture' }), 'named save')
    const other = await post('api/provider/save', { preset: 'moonshot-cn', key: 'fixture', name: 'OFM policy fixture' })
    assert.notEqual(other.status, 403, 'an unrelated preset save is not refused by policy')
    await other.text()
  })

  await engineCheck('an import picker does not offer the channel', async () => {
    const sources = await read('api/importapps')
    for (const source of sources) {
      assert(!(source.items || []).some(item => IDS.includes(item?.provider?.id)), source.id)
    }
  })

  await engineCheck('the engine refuses to install, enable or sign in the channel', async () => {
    assert(await denied('POST', '/api/plugins/add', { spec: PACKAGE }), 'add')
    assert(await denied('POST', '/api/plugins/upgrade', { spec: PACKAGE }), 'upgrade')
    assert(await denied('POST', '/api/plugins/off', { spec: PACKAGE, off: false }), 're-enable')
    assert(await denied('POST', '/api/plugin-signin', { provider: IDS[0], method: 0 }), 'plugin sign-in')
    assert(await denied('POST', '/api/plugin-signin/prompt', { provider: IDS[1], method: 0 }), 'plugin prompt')
    assert(await denied('POST', '/api/signin', { agent: IDS[0] }), 'subscription sign-in')
    assert(await denied('POST', '/api/signin', { agent: IDS[1] }), 'international sign-in')
    assert(await denied('POST', '/api/login/use', { agent: IDS[0], user: 'fixture' }), 'account switch')
    assert(await denied('POST', '/api/provider/move', { id: IDS[0] }), 'move')
  })

  await engineCheck('the way out of an earlier install is left open', async () => {
    // Hiding the channel must not trap a plugin installed before this change:
    // switching it off and removing it are not refused by policy (the engine
    // answers for a plugin it doesn't have, which is a different failure).
    for (const [route, body] of [
      ['/api/plugins/off', { spec: PACKAGE, off: true }],
      ['/api/plugins/remove', { spec: PACKAGE }],
    ]) {
      try {
        const response = await engine.request('POST', route, { body })
        assert.notEqual(response.status, 403, route)
        await response.text()
      } catch (error) {
        assert.notEqual(error.message, POLICY_REFUSED, route)
      }
    }
  })

  await engineCheck('the refusal is enforced through the browser proxy too', async () => {
    for (const [route, body] of [
      ['api/plugins/add', { spec: PACKAGE }],
      ['api/signin', { agent: IDS[0] }],
      ['api/plugin-signin', { provider: IDS[1], method: 0 }],
      ['api/provider/move', { id: IDS[1] }],
    ]) {
      const response = await post(route, body)
      assert.equal(response.status, 403, route)
      assert.match(await response.text(), /not offered by this build/, route)
    }
    const page = await fetch(base + 'api/plugins/page?name=' + encodeURIComponent(PACKAGE))
    assert.equal(page.status, 403)
  })

  await engineCheck('unrelated work on the same routes still reaches the engine', async () => {
    const other = await post('api/plugins/add', { spec: '@ofm-absent-package' })
    assert.notEqual(other.status, 403, 'an unrelated install is not refused by policy')
    const discovery = await post('api/settings/account-discovery', { off: true })
    assert.equal(discovery.status, 200, 'settings still writable')
    const unknown = await post('api/signin', { agent: 'ofm-missing-login-fixture' })
    assert.doesNotMatch(await unknown.text(), /not offered by this build/)
    const settings = await read('api/settings')
    assert.equal(typeof settings.noAccountDiscovery, 'boolean', 'settings still answered')
  })

  await engineCheck('a model served through the channel never reaches the published catalog', async () => {
    const published = []
    const models = createMagpieModels({
      engine,
      stats: { record() {} },
      logger: {},
      onChanged: () => published.push(models?.catalog?.().length ?? 0),
    })
    try {
      assert.equal(deniedModel({ id: 'glm-5.3-flash', owned_by: 'workbuddy' }), true, 'by provider')
      assert.equal(deniedModel({ id: 'workbuddy/glm-5.3-flash', owned_by: 'x' }), true, 'by id')
      assert.equal(deniedModel({ id: 'gpt-6.1-sol', owned_by: 'codex' }), false, 'others stay')
      await models.refresh()
      assert(!mentions(models.catalog()), 'published catalog stays clean')
    } finally { models.close() }
  })

  await check('the filter is a pure function of the route and the answer', async () => {
    const listings = { listings: [
      { package: PACKAGE, name: 'WorkBuddy', providers: IDS },
      { package: '@magpie-community/opencode-zcode-auth', name: 'ZCode', providers: ['zcode'] },
    ] }
    const filtered = filterEngineJSON('/api/plugins/listings', structuredClone(listings))
    assert.deepEqual(filtered.listings.map(row => row.package), ['@magpie-community/opencode-zcode-auth'])
    const unknown = { anything: 1 }
    assert.equal(filterEngineJSON('/api/settings', unknown), unknown, 'other routes pass through')
    assert.throws(() => assertEngineMutation('POST', '/api/plugins/add', { spec: PACKAGE }), /not offered/)
    assert.doesNotThrow(() => assertEngineMutation('GET', '/api/plugins/add', { spec: PACKAGE }))
  })

  await check('third-party prose that names an excluded channel is rewritten, not dropped', async () => {
    // A real market listing (Agent Office) reads the session files of many
    // desktop tools and its summary names the excluded ones. It is not the
    // channel: it stays, but no spelling of the names survives the boundary.
    const agentOffice = {
      package: '@magpie-community/page-agent-office', name: 'Agent Office', community: true, kind: 'page',
      summary: {
        en: 'Reads the session files of Claude Code, Codex, WorkBuddy and CodeBuddy on this computer.',
        zh: '读取本机 Claude Code、Codex、WorkBuddy、CodeBuddy 的会话文件。',
      },
    }
    const filtered = filterEngineJSON('/api/plugins/listings', {
      listings: [structuredClone(agentOffice), { package: PACKAGE, name: 'WorkBuddy', providers: IDS }],
    })
    assert.equal(filtered.listings.length, 1, 'the channel listing is dropped')
    assert.equal(filtered.listings[0].package, agentOffice.package, 'the unrelated listing stays')
    assert.equal(filtered.listings[0].name, 'Agent Office')
    assert.match(filtered.listings[0].summary.en, /a desktop coding tool/)
    assert.doesNotMatch(filtered.listings[0].summary.en, /workbuddy|codebuddy/i)
    assert.match(filtered.listings[0].summary.zh, /某桌面编码工具/)
    assert.doesNotMatch(filtered.listings[0].summary.zh, /workbuddy|codebuddy/i)
    assert.equal(filterEngineJSON('/api/plugins/npm', { npm: { [agentOffice.package]: { description: agentOffice.summary.en } } })
      .npm[agentOffice.package].description.includes('WorkBuddy'), false, 'npm prose is rewritten too')
    // Id-bearing surfaces stay untouched: the deprecation list needs exact ids.
    const providers = { movable: ['workbuddy', 'workbuddy-ai', 'zcode'], presets: [{ id: 'zcode', name: 'ZCode' }] }
    assert.deepEqual(filterEngineJSON('/api/providers', structuredClone(providers)).movable,
      ['workbuddy', 'workbuddy-ai', 'zcode'], 'provider ids are not redacted')
  })

  console.log(`magpie-policy: ${checks} checks passed`)
} finally {
  await engine.close()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  fs.rmSync(scratch, { recursive: true, force: true })
}
