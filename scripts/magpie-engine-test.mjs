import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createMagpieEngine, MAGPIE_UI_PREFIX as prefix } from '../src/magpie-engine.js'

const root = fileURLToPath(new URL('../', import.meta.url))
await mkdir(path.join(root, '.verify'), { recursive: true })
const scratch = await mkdtemp(path.join(root, '.verify', 'magpie-test-'))
const engines = []
const servers = []
const fixture = String.raw`
import http from 'node:http';
import fs from 'node:fs';
const args = process.argv.slice(2);
const address = args[args.indexOf('--addr') + 1];
const port = Number(address.split(':').pop());
const key = process.env.MAGPIE_WEB_KEY;
fs.writeFileSync('fixture-trace.jsonl', JSON.stringify({port,pid:process.pid}) + '\n');
let cancelled = 0;
console.log('upstream secret: ' + key);
const server = http.createServer(async (req, res) => {
  fs.appendFileSync('fixture-trace.jsonl', JSON.stringify({path:req.url.split('?')[0], authenticated:req.headers.cookie === 'magpie_web_' + port + '=' + key}) + '\n');
  if (req.headers.cookie !== 'magpie_web_' + port + '=' + key) { res.writeHead(401); res.end(); return; }
  const url = new URL(req.url, 'http://' + address);
  if (url.pathname === '/api/settings') {
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,pid:process.pid,config:process.env.XDG_CONFIG_HOME,
      cache:process.env.XDG_CACHE_HOME,data:process.env.XDG_DATA_HOME,state:process.env.XDG_STATE_HOME,
      gateway:process.env.MAGPIE_ADDR, noAccountsEnv:process.env.MAGPIE_NO_ACCOUNTS || ''}));
  } else if (url.pathname === '/api/headers') {
    let body = ''; for await (const chunk of req) body += chunk;
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({headers:req.headers,body,url:req.url}));
  } else if (url.pathname === '/api/sse') {
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});
    res.write('data: first\n\n');
    const timer = setInterval(() => res.write('data: next\n\n'), 30);
    res.on('close', () => { clearInterval(timer); cancelled++; });
  } else if (url.pathname === '/api/hang') {
    res.writeHead(200,{'content-type':'text/event-stream'});
    res.flushHeaders();
  } else if (url.pathname === '/api/cancelled') {
    res.setHeader('content-type','application/json'); res.end(JSON.stringify({cancelled}));
  } else if (url.pathname === '/api/exit') { res.end('bye', () => process.exit(7));
  } else if (url.pathname === '/api/caller-keys' || url.pathname.startsWith('/api/caller-keys/')) {
    const file = process.env.XDG_CONFIG_HOME + '/magpie/caller-keys.json';
    let keys = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (req.method === 'POST') {
      let body = ''; for await (const chunk of req) body += chunk;
      const input = JSON.parse(body);
      if (url.pathname.endsWith('/remove-key')) keys = keys.filter(row => row.id !== input.key);
      if (url.pathname.endsWith('/rotate-key')) {
        for (const row of keys) if (row.id === input.key) row.secret = 'fixture-rotated-key';
      }
      fs.writeFileSync(file, JSON.stringify(keys));
    }
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({keys:keys.map(({secret,...row}) => row),accountNames:{}}));
  } else if (url.pathname === '/redirect') {
    res.writeHead(302,{location:'http://' + address + '/?mode=window&view=providers&k=' + key,
      'set-cookie':['bad=secret','magpie_web_' + port + '=' + key]}); res.end();
  } else if (url.pathname === '/raw') {
    res.writeHead(206,{'content-type':'application/octet-stream','content-range':'bytes 0-3/4',
      'content-disposition':'attachment; filename="probe.bin"','content-length':4}); res.end(Buffer.from([0,255,1,2]));
  } else if (url.pathname === '/download') {
    res.writeHead(200,{'content-type':'text/html','content-disposition':'attachment; filename="probe.html"'});
    res.end('<a href="/raw">raw</a>');
  } else if (url.pathname.startsWith('/_magpie/plugin/')) {
    const source = address + '/_magpie/plugin/token/';
    res.writeHead(200,{'content-type':'text/html',
      'content-security-policy':"sandbox allow-scripts; default-src 'none'; script-src " + source +
      "; style-src " + source + " 'unsafe-inline'; connect-src 'none'; base-uri 'none'; frame-ancestors 'self'"});
    res.end('<!doctype html><script src="_magpie/bridge.js"></script><script src="app.js"></script>');
  } else if (url.pathname === '/') {
    res.writeHead(200,{'content-type':'text/html','etag':'"original"','last-modified':new Date().toUTCString()});
    res.end('<!doctype html><html><head><script src="boot.js"></script><link href="/app.css"></head><body>fixture</body></html>');
  } else { res.writeHead(404); res.end(); }
});
server.listen(port, '127.0.0.1');
`

function engine(options) {
  const owned = createMagpieEngine(options)
  engines.push(owned)
  return owned
}

async function makeFixture(name) {
  const dataDir = path.join(scratch, name)
  await mkdir(path.join(dataDir, 'magpie'), { recursive: true })
  await writeFile(path.join(dataDir, 'magpie', 'web'), fixture)
  return dataDir
}

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(Number(port), '127.0.0.1', resolve)
  })
  servers.push(server)
  return `http://127.0.0.1:${server.address().port}`
}

async function mount(owned, { outer = '', stripOuter = false, proxyOptions } = {}) {
  return listen(http.createServer((req, res) => {
    // Simulates the main app's already-admitted prefix routing. Path validation
    // remains the owner's responsibility even when a caller passes raw escapes.
    const external = outer + prefix
    const subpath = req.url.startsWith(external) ? req.url.slice(external.length) : req.url
    if (stripOuter && outer) req.url = req.url.slice(outer.length)
    owned.proxy(req, res, subpath, proxyOptions).catch(() => { res.destroy() })
  }))
}

async function check(name, fn) {
  await fn()
  console.log(`ok ${name}`)
}

const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
async function eventually(fn) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await fn()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail('condition did not settle')
}

function browserHarness(html, href) {
  const calls = []
  const notifications = []
  let fetchOK = true
  const base = { href: html.match(/<base href="([^"]+)"/)?.[1] }
  class Element { setAttribute(name, value) { this[name] = value } }
  const context = {
    URL, Request, Element, document: { querySelector() { return base } },
    location: { href, origin: new URL(href).origin },
    XMLHttpRequest: class { open(...args) { calls.push(args) } },
    history: { pushState() {}, replaceState() {} },
  }
  for (const name of ['HTMLIFrameElement', 'HTMLImageElement', 'HTMLScriptElement', 'HTMLLinkElement',
    'HTMLAnchorElement', 'HTMLFormElement', 'HTMLSourceElement', 'HTMLMediaElement', 'HTMLVideoElement', 'HTMLObjectElement']) {
    const Type = class extends Element {}
    for (const prop of ['src', 'href', 'action', 'poster', 'data']) Object.defineProperty(Type.prototype, prop, {
      configurable: true, get() { return this['_' + prop] }, set(value) { this['_' + prop] = value },
    })
    context[name] = Type
  }
  context.window = {
    fetch(input) { calls.push(input); return Promise.resolve({ ok: fetchOK }) },
    EventSource: class { constructor(input) { calls.push(input) } },
    open(input) { calls.push(input) },
    parent: { postMessage(message, origin) { notifications.push({ message: JSON.parse(JSON.stringify(message)), origin }) } },
  }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context)
  return { calls, notifications, context, base, setFetchOK(value) { fetchOK = value } }
}

async function reviewTests() {
  const failures = []
  async function repro(name, fn) {
    try { await check(name, fn) } catch (error) {
      failures.push(name)
      console.error(`FAIL ${name}: ${error.message}`)
    }
  }
  await repro('unexpected ready child exit cancels streams, releases lease and restarts the same owner', async () => {
    const dataDir = await makeFixture('review-exit')
    const owned = engine({ dataDir, binary: process.execPath })
    try {
      await owned.start()
      const initial = await (await owned.request('GET', '/api/settings')).json()
      const previousGateway = owned.gateway()
      const stream = await owned.request('GET', '/api/sse')
      const reader = stream.body.getReader()
      await reader.read()
      await owned.request('GET', '/api/exit').then(response => response.text()).catch(() => {})
      await eventually(() => owned.status().state === 'error')
      await assert.rejects(reader.read())
      const other = engine({ dataDir, binary: process.execPath })
      await eventually(async () => {
        try { await other.start(); return true } catch { return false }
      })
      await other.close()
      const restart = owned.start()
      assert.equal(owned.start(), restart)
      assert.equal((await restart).state, 'ready')
      const current = await (await owned.request('GET', '/api/settings')).json()
      assert.notEqual(current.pid, initial.pid)
      assert.equal(alive(initial.pid), false)
      assert.equal(owned.gateway().url, previousGateway.url)
      assert(owned.gateway().key === previousGateway.key, 'adapter key must survive a child restart')
    } finally { await owned.close() }
  })
  await repro('internal caller key is reserved against mutations and hidden from public listings', async () => {
    const dataDir = await makeFixture('review-keys')
    const owned = engine({ dataDir, binary: process.execPath })
    try {
      await owned.start()
      const url = await mount(owned)
      const file = path.join(dataDir, 'magpie/config/magpie/caller-keys.json')
      const before = await readFile(file, 'utf8')
      for (const action of ['rotate-key', 'remove-key', 'off-key', 'limit-key', 'models-key',
        'accounts-key', 'quotas-key', 'rename-key', 'copy-key']) {
        const response = await fetch(url + prefix + 'api/caller-keys/' + action, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'our-free-model-engine' }),
        })
        assert.equal(response.status, 409, 'internal gateway key mutation must return 409')
        assert.match(await response.text(), /managed by the application/i)
        await assert.rejects(owned.request('POST', '/api/caller-keys/' + action, {
          body: { key: 'our-free-model-engine' },
        }), error => error.statusCode === 409)
      }
      for (const route of ['api/%63aller-keys/rotate-key', 'api/caller-keys/%72emove-key']) {
        const response = await fetch(url + prefix + route, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: '{"Key":"our-free-model-engine"}',
        })
        assert.equal(response.status, 409)
        await response.text()
      }
      assert((await readFile(file, 'utf8')) === before, 'reserved key store must not change')
      const listed = await (await fetch(url + prefix + 'api/caller-keys')).json()
      assert(!listed.keys.some(row => row.id === 'our-free-model-engine'), 'internal adapter key must not be offered for editing')
      const direct = await (await owned.request('GET', '/api/caller-keys')).json()
      assert(!direct.keys.some(row => row.id === 'our-free-model-engine'))
      const stored = JSON.parse(before)
      stored.push({ id: 'ordinary', name: 'User key', secret: 'fixture-user-key' })
      await writeFile(file, JSON.stringify(stored))
      const updated = await fetch(url + prefix + 'api/caller-keys/rotate-key', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'ordinary' }),
      })
      assert.equal(updated.status, 200)
      const rows = await updated.json()
      assert.deepEqual(rows.keys.map(row => row.id), ['ordinary'])
      assert(JSON.parse(await readFile(file, 'utf8')).find(row => row.id === 'ordinary').secret === 'fixture-rotated-key')
      const removed = await owned.request('POST', '/api/caller-keys/remove-key', { body: { key: 'ordinary' } })
      assert.equal(removed.status, 200)
      assert.deepEqual((await removed.json()).keys, [])
      const oversized = await fetch(url + prefix + 'api/caller-keys/rotate-key', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: ' '.repeat(65 * 1024),
      })
      assert.equal(oversized.status, 413)
      await oversized.text()
    } finally { await owned.close() }
  })
  await repro('outer /dsh prefix reaches HTML base, browser bridge, redirects and plugin CSP', async () => {
    const owned = engine({ dataDir: await makeFixture('review-prefix'), binary: process.execPath })
    try {
      const url = await mount(owned, { outer: '/dsh' })
      const visible = '/dsh' + prefix
      const response = await fetch(url + visible + '?mode=window&view=providers')
      const html = await response.text()
      assert(html.includes('<base href="' + visible + '">'), 'HTML base must preserve the outer mount')
      assert(html.includes(JSON.stringify(visible)), 'browser bridge must share the visible mount')
      const redirect = await fetch(url + visible + 'redirect', { redirect: 'manual' })
      assert.equal(redirect.headers.get('location'), visible + '?mode=window&view=providers')
      const plugin = await fetch(url + visible + '_magpie/plugin/token/index.html', { headers: { origin: 'null' } })
      assert(plugin.headers.get('content-security-policy').includes(new URL(url).host + visible + '_magpie/plugin/token/'))
      await plugin.text()
      const browser = browserHarness(html, url + visible + '?mode=window&view=providers')
      await browser.context.window.fetch('/api/providers')
      assert.equal(browser.calls.pop(), visible + 'api/providers')
      assert.equal(browser.base.href, visible)
    } finally { await owned.close() }
  })
  await repro('stripped outer mount uses browser path for relative assets, requests, redirects and plugin CSP', async () => {
    const owned = engine({ dataDir: await makeFixture('review-stripped'), binary: process.execPath })
    try {
      const visible = '/dsh' + prefix
      for (const proxyOptions of [undefined, { prefix: visible }]) {
        const url = await mount(owned, { outer: '/dsh', stripOuter: true, proxyOptions })
        const href = url + visible + '?mode=window&view=providers'
        const html = await (await fetch(href)).text()
        const browser = browserHarness(html, href)
        assert.equal(browser.base.href, visible)
        const stylesheet = html.match(/<link href="([^"]+)"/)[1]
        assert.equal(new URL(stylesheet, url + browser.base.href).pathname, visible + 'app.css')
        await browser.context.window.fetch('/api/headers')
        const target = browser.calls.pop()
        assert.equal(new URL(target, url).pathname, visible + 'api/headers')
        const headers = await (await fetch(new URL(target, url))).json()
        assert.equal(headers.url, '/api/headers', 'mount hint must not be forwarded upstream')
        browser.context.window.open('/redirect')
        const redirect = await fetch(new URL(browser.calls.pop(), url), { redirect: 'manual' })
        assert.equal(redirect.headers.get('location'), visible + '?mode=window&view=providers')
        const frame = new browser.context.HTMLIFrameElement()
        frame.src = '/_magpie/plugin/token/index.html'
        const plugin = await fetch(new URL(frame.src, url), { headers: { origin: 'null', 'sec-fetch-site': 'cross-site' } })
        assert.equal(plugin.status, 200)
        const csp = plugin.headers.get('content-security-policy')
        assert(csp.includes(new URL(url).host + visible + '_magpie/plugin/token/'))
        assert(csp.includes("connect-src 'none'"))
        assert((await plugin.text()).includes('src="_magpie/bridge.js"'))
        const forbidden = await fetch(url + visible + 'api/settings', { headers: { origin: 'null' } })
        assert.equal(forbidden.status, 403)
        await forbidden.text()
      }
      const invalidMount = await mount(owned, { proxyOptions: { prefix: 'https://external.invalid/' } })
      const invalid = await fetch(invalidMount + prefix)
      assert.equal(invalid.status, 400)
      await invalid.text()
    } finally { await owned.close() }
  })
  if (failures.length) throw new Error(`${failures.length} reviewer regression checks failed`)
}

async function fixtureTests() {
  const logs = []
  const dataDir = await makeFixture('fixture')
  const owned = engine({ dataDir, binary: process.execPath, logger: { info: (...args) => logs.push(args) } })
  assert.equal(owned.status().state, 'stopped')
  const starts = await Promise.all([owned.start(), owned.start(), owned.start()])
  assert(starts.every(status => status.state === 'ready'))
  const settings = await (await owned.request('GET', '/api/settings')).json()
  const gateway = owned.gateway()
  for (const key of ['config', 'cache', 'data', 'state']) assert(settings[key].startsWith(path.join(dataDir, 'magpie')))
  assert.equal(settings.noAccountsEnv, '')
  assert(!JSON.stringify(starts).includes(gateway.key))
  assert.deepEqual(Object.keys(starts[0]).sort(), ['available', 'error', 'revision', 'state', 'version'])
  assert.equal(logs.length, 1)
  assert.deepEqual(logs[0], ['Magpie engine started'])
  const url = await mount(owned)
  await check('lazy/coalesced start, private XDG directories and secret-free status/logging', async () => {
    const prefs = JSON.parse(await readFile(path.join(settings.config, 'magpie', 'settings.json'), 'utf8'))
    assert.equal(prefs.noAccountDiscovery, true)
    assert.equal(prefs.noAutoUpdate, true)
    assert.equal(prefs.noAutoDownload, true)
    assert.equal(prefs.autoRestart, false)
  })
  await check('proxy strips caller credentials, forwards raw POST and uses private web cookie/origin', async () => {
    const response = await fetch(url + prefix + 'api/headers?k=attacker&keep=1', {
      method: 'POST', body: 'raw-body',
      headers: { authorization: 'Bearer external', cookie: 'user=external', 'x-api-key': 'external',
        'x-goog-api-key': 'external', forwarded: 'external', 'x-forwarded-host': 'external',
        origin: 'https://external.invalid', referer: 'https://external.invalid/path' },
    })
    assert.equal(response.status, 200)
    const got = await response.json()
    assert.equal(got.body, 'raw-body')
    assert.equal(got.url, '/api/headers?keep=1')
    assert.match(got.headers.cookie, /^magpie_web_\d+=[a-f0-9]{64}$/)
    assert(!JSON.stringify(got).includes('external'))
    assert.equal(got.headers.origin, `http://${got.headers.host}`)
    assert.equal(got.headers.referer, got.headers.origin + '/')
  })
  let html
  await check('prefix HTML injection precedes boot scripts and preserves mode/view', async () => {
    const response = await fetch(url + prefix + '?mode=window&view=providers')
    html = await response.text()
    assert(html.indexOf('<base href="' + prefix + '">') < html.indexOf('src="boot.js"'))
    const stylesheet = html.match(/<link href="([^"]+)"/)[1]
    assert.equal(new URL(stylesheet, url + prefix).pathname, prefix + 'app.css')
    assert.equal(response.headers.get('etag'), null)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const redirect = await fetch(url + prefix + 'redirect', { redirect: 'manual' })
    assert.equal(redirect.headers.get('location'), prefix + '?mode=window&view=providers')
    assert.equal(redirect.headers.get('set-cookie'), null)
  })
  await check('browser bridge rewrites URLs and notifies parent only for successful mutations without secrets', async () => {
    const { calls, notifications, context, setFetchOK } = browserHarness(html, url + prefix + '?mode=window&view=providers')
    await context.window.fetch('/api/providers')
    assert.equal(calls.pop(), prefix + 'api/providers')
    await context.window.fetch(new Request(url + '/api/settings'))
    assert.equal(calls.pop().url, url + prefix + 'api/settings')
    new context.window.EventSource('/api/events')
    assert.equal(calls.pop(), prefix + 'api/events')
    const frame = new context.HTMLIFrameElement()
    frame.src = '/_magpie/plugin/token/index.html'
    assert.equal(frame.src, prefix + '_magpie/plugin/token/index.html')
    const anchor = new context.HTMLAnchorElement()
    anchor.href = '/api/backup/export'
    assert.equal(anchor.href, prefix + 'api/backup/export')
    context.window.open('https://external.invalid/')
    assert.equal(calls.pop(), 'https://external.invalid/')
    assert.equal(notifications.length, 0)
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await context.window.fetch('/api/settings', {
        method: method.toLowerCase(), body: 'private-body',
        headers: { authorization: 'private-credential' },
      })
    }
    await context.window.fetch(new Request(url + '/api/settings', { method: 'POST', body: 'private-body' }))
    assert.equal(notifications.length, 5)
    for (const notification of notifications) {
      assert.deepEqual(notification, { message: { type: 'ofm:engine-changed' }, origin: url })
    }
    setFetchOK(false)
    await context.window.fetch('/api/settings', { method: 'POST' })
    assert.equal(notifications.length, 5)
    setFetchOK(true)
    await context.window.fetch(new Request(url + '/api/settings', { method: 'POST' }), { method: 'GET' })
    assert.equal(notifications.length, 5)
  })
  await check('sandbox plugin CSP remains scoped to its prefixed token folder and bridge stays relative', async () => {
    const response = await fetch(url + prefix + '_magpie/plugin/token/index.html', { headers: { origin: 'null' } })
    assert.equal(response.status, 200)
    const policy = response.headers.get('content-security-policy')
    assert(policy.includes(`script-src ${new URL(url).host}${prefix}_magpie/plugin/token/`))
    for (const directive of ['sandbox allow-scripts', "connect-src 'none'", "base-uri 'none'", "frame-ancestors 'self'"]) assert(policy.includes(directive))
    const text = await response.text()
    assert(text.includes('src="_magpie/bridge.js"'))
    assert(!text.includes('<base') && !text.includes('<script>'))
    assert.equal((await fetch(url + prefix + 'api/settings', { headers: { origin: 'null' } })).status, 403)
    assert.equal((await fetch(url + prefix + 'api/settings', { headers: { 'sec-fetch-dest': 'iframe' } })).status, 403)
  })
  await check('binary ranges/downloads stream without HTML transformation', async () => {
    const response = await fetch(url + prefix + 'raw', { headers: { range: 'bytes=0-3' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 0-3/4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 1, 2]))
    assert.equal(await (await fetch(url + prefix + 'download')).text(), '<a href="/raw">raw</a>')
  })
  await check('SSE delivers before completion and disconnect cancels upstream', async () => {
    const controller = new AbortController()
    const response = await fetch(url + prefix + 'api/sse', { signal: controller.signal })
    const reader = response.body.getReader()
    assert(Buffer.from((await reader.read()).value).toString().includes('data: first'))
    controller.abort()
    await reader.cancel().catch(() => {})
    await eventually(async () => (await (await owned.request('GET', '/api/cancelled')).json()).cancelled > 0)
  })
  await check('path traversal and binary updater POSTs are rejected', async () => {
    for (const bad of ['http://outside.invalid/', '//outside.invalid/', '/%2e%2e/api', '/%252e%252e/api', '/a\\b', '/a/../api']) {
      await assert.rejects(owned.request('GET', bad), /Invalid engine path/)
    }
    const escape = await new Promise(resolve => {
      http.get(url + prefix + '%252e%252e/api', res => { res.resume(); resolve(res.statusCode) })
    })
    assert.equal(escape, 400)
    assert.equal((await fetch(url + prefix + 'api/update/install', { method: 'POST' })).status, 409)
    await assert.rejects(owned.request('POST', '/api/update/check'), /managed by the application/)
  })
  await check('128 concurrent streams bound both management and UI proxy requests', async () => {
    const held = []
    try {
      for (let i = 0; i < 128; i++) held.push(await owned.request('GET', '/api/hang'))
      await assert.rejects(owned.request('GET', '/api/settings'), /request limit reached/)
      const rejected = await fetch(url + prefix + 'api/settings')
      assert.equal(rejected.status, 503)
      await rejected.text()
    } finally {
      await Promise.allSettled(held.map(response => response.body.cancel()))
    }
    const resumed = await owned.request('GET', '/api/settings')
    assert.equal(resumed.status, 200)
    await resumed.json()
  })
  await check('same data directory has one owner; close is coalesced and kills only its child', async () => {
    const second = engine({ dataDir, binary: process.execPath })
    await assert.rejects(second.start(), /already has an owner/)
    await second.close()
    const firstClose = owned.close()
    assert.equal(owned.close(), firstClose)
    assert.equal((await firstClose).state, 'closed')
    assert.equal(alive(settings.pid), false)
    assert.throws(() => owned.gateway(), /not running/)
    await assert.rejects(owned.start(), /closed/)
  })
  await check('restart preserves gateway port/key and account consent; occupied saved port moves instead of failing', async () => {
    const prefsPath = path.join(settings.config, 'magpie', 'settings.json')
    const prefs = JSON.parse(await readFile(prefsPath, 'utf8'))
    await writeFile(prefsPath, JSON.stringify({ ...prefs, noAccountDiscovery: false, theme: 'dark' }))
    const restart = engine({ dataDir, binary: process.execPath })
    try { await restart.start() } catch (error) {
      console.error(await readFile(path.join(dataDir, 'magpie', 'fixture-trace.jsonl'), 'utf8'))
      throw error
    }
    assert.deepEqual(restart.gateway(), gateway)
    const saved = JSON.parse(await readFile(prefsPath, 'utf8'))
    assert.equal(saved.noAccountDiscovery, false)
    assert.equal(saved.theme, 'dark')
    await restart.close()
    const occupied = net.createServer()
    await listen(occupied, new URL(gateway.url).port)
    const conflict = engine({ dataDir, binary: process.execPath })
    try { await conflict.start() } catch (error) {
      console.error(await readFile(path.join(dataDir, 'magpie', 'fixture-trace.jsonl'), 'utf8'))
      throw error
    }
    // The saved port is a preference, not a requirement: a listener that took
    // it (or a Windows reserved range that drifted, #688) must not block
    // startup — the engine moves to a fresh port and persists it.
    const savedPort = Number(new URL(gateway.url).port)
    const movedPort = Number(new URL(conflict.gateway().url).port)
    assert.notEqual(movedPort, savedPort, 'the occupied port was abandoned')
    assert.notEqual(movedPort, occupied.address().port, 'the new port is really free')
    const movedPrefs = JSON.parse(await readFile(prefsPath, 'utf8'))
    assert.equal(movedPrefs.port, movedPort, 'the moved port is persisted for the next boot')
    await conflict.close()
    await new Promise(resolve => occupied.close(resolve))
  })
  await check('owner OS lease recovers after a parent process crash', async () => {
    const crashDir = await makeFixture('crash')
    const ownerScript = `
      import { createMagpieEngine } from ${JSON.stringify(new URL('../src/magpie-engine.js', import.meta.url).href)};
      const engine = createMagpieEngine({ dataDir: ${JSON.stringify(crashDir)}, binary: process.execPath });
      await engine.start();
      const response = await engine.request('GET', '/api/settings');
      const {pid} = await response.json();
      await engine.request('GET', '/api/exit').then(r => r.text()).catch(() => {});
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `
    const parent = spawn(process.execPath, ['--input-type=module', '-e', ownerScript], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    })
    const exited = new Promise(resolve => parent.once('exit', resolve))
    try {
      await new Promise((resolve, reject) => {
        parent.stdout.once('data', resolve)
        parent.once('exit', () => reject(new Error('crash fixture failed')))
      })
      parent.kill('SIGKILL')
      await exited
      const recovered = engine({ dataDir: crashDir, binary: process.execPath })
      await recovered.start()
      assert.equal(recovered.status().state, 'ready')
      await recovered.close()
    } finally { if (parent.exitCode === null && parent.signalCode === null) { parent.kill('SIGKILL'); await exited } }
  })
  await check('close cancels in-flight streaming and startup without unhandled rejection', async () => {
    const dir = await makeFixture('races')
    const races = engine({ dataDir: dir, binary: process.execPath })
    await races.start()
    const response = await races.request('GET', '/api/sse')
    const reader = response.body.getReader()
    await reader.read()
    await races.close()
    await assert.rejects(reader.read())
    const early = engine({ dataDir: await makeFixture('early'), binary: process.execPath })
    const outcome = early.start().catch(error => error)
    await early.close()
    assert((await outcome) instanceof Error)
    assert.equal(early.status().state, 'closed')
  })
}

async function realTests() {
  const metadata = JSON.parse(await readFile(path.join(root, 'vendor/magpie/engine.json'), 'utf8'))
  const entry = metadata.binaries[`${process.platform}-${process.arch}`]
  // The pinned binary is per platform; a runner without one has nothing to start.
  if (!entry) {
    console.log(`ok  built-binary checks skipped: no pinned engine binary for ${process.platform}-${process.arch}`)
    return
  }
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path.join(root, 'vendor/magpie', entry.path))) digest.update(chunk)
  assert.equal(digest.digest('hex'), entry.sha256)
  const isolated = path.join(scratch, 'native-home')
  await mkdir(isolated, { recursive: true })
  const oldEnv = { ...process.env }
  try {
    // No native account or live inference tests: all native roots are private,
    // executable discovery is empty, and HTTP traffic goes to a refused proxy.
    for (const key of Object.keys(process.env)) {
      if (/(?:_HOME|_DIR|_CONFIG|_DATA_DIR|_CONFIG_DIR|_PATH)$/.test(key) && !['SystemRoot', 'WINDIR'].includes(key)) delete process.env[key]
    }
    Object.assign(process.env, {
      HOME: isolated, USERPROFILE: isolated, APPDATA: isolated, LOCALAPPDATA: isolated,
      PATH: '', HTTP_PROXY: 'http://127.0.0.1:1', HTTPS_PROXY: 'http://127.0.0.1:1',
      ALL_PROXY: 'http://127.0.0.1:1', NO_PROXY: '127.0.0.1,localhost',
      DO_NOT_TRACK: '1',
    })
    const owned = engine({ dataDir: path.join(scratch, 'real') })
    await check('real pinned full nogui binary starts; authenticated management API is ready', async () => {
      assert.equal((await owned.start()).state, 'ready')
      const response = await owned.request('GET', '/api/settings')
      assert.equal(response.status, 200)
      const settings = await response.json()
      assert.equal(settings.noAccountDiscovery, true)
      assert.equal(settings.noAutoUpdate, true)
      assert.equal(settings.noAutoDownload, true)
    })
    await check('subscription settings gate sign-in and can be enabled through the proxied settings API', async () => {
      const url = await mount(owned)
      const signIn = () => fetch(url + prefix + 'api/signin', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent: 'ofm-missing-login-fixture' }),
      }).then(response => response.json())
      const disabled = await signIn()
      assert.match(JSON.stringify(disabled), /subscription accounts are off/)
      try {
        const enabled = await fetch(url + prefix + 'api/settings/account-discovery', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ off: false }),
        })
        assert.equal(enabled.status, 200)
        assert.equal(Boolean((await enabled.json()).noAccountDiscovery), false)
        const prefs = JSON.parse(await readFile(path.join(scratch, 'real/magpie/config/magpie/settings.json'), 'utf8'))
        assert.equal(prefs.noAccountDiscovery, undefined)
        const allowed = await signIn()
        assert.doesNotMatch(JSON.stringify(allowed), /subscription accounts are off/)
        assert.equal(allowed.error, "magpie can't sign in to ofm-missing-login-fixture accounts")
      } finally {
        const restored = await owned.request('POST', '/api/settings/account-discovery', {
          headers: { 'content-type': 'application/json' }, body: JSON.stringify({ off: true }),
        })
        assert.equal((await restored.json()).noAccountDiscovery, true)
      }
    })
    await check('real UI providers page, boot scripts, all built-in plugin pages and downloads remain available', async () => {
      const url = await mount(owned)
      const html = await (await fetch(url + prefix + '?mode=window&view=providers')).text()
      assert(html.includes('<base href="' + prefix + '">'))
      assert(html.includes('id="view-providers"'))
      const resources = [...html.matchAll(/\bsrc="([^"]+\.js(?:\?[^"]*)?)"/g)].map(match => match[1])
      assert(resources.some(resource => resource.startsWith('plugins/routing/')))
      assert(resources.some(resource => resource.startsWith('plugins/library/')))
      assert(resources.some(resource => resource.startsWith('plugins/sessions/')))
      assert(resources.some(resource => resource.startsWith('plugins/usage/')))
      for (const resource of resources) {
        const response = await fetch(url + prefix + resource)
        assert.equal(response.status, 200, resource)
        assert((await response.text()).length > 20)
      }
      const response = await owned.request('GET', '/api/plugin-pages')
      assert.equal(response.status, 200)
      assert(Array.isArray(await response.json()))
      const gateway = owned.gateway()
      const models = await fetch(gateway.url + '/v1/models', { headers: { authorization: 'Bearer ' + gateway.key } })
      assert.equal(models.status, 200)
      assert(Array.isArray((await models.json()).data))
    })
    await check('real gateway keeps its internal adapter key while ordinary caller keys remain editable', async () => {
      const gateway = owned.gateway()
      const file = path.join(scratch, 'real/magpie/config/magpie/caller-keys.json')
      const original = JSON.parse(await readFile(file, 'utf8')).find(row => row.id === 'our-free-model-engine')
      const url = await mount(owned, { outer: '/dsh' })
      for (const action of ['rotate-key', 'remove-key', 'off-key']) {
        const rejected = await fetch(url + '/dsh' + prefix + 'api/caller-keys/' + action, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: 'our-free-model-engine' }),
        })
        assert.equal(rejected.status, 409)
        assert.match(await rejected.text(), /managed by the application/i)
      }
      const added = await owned.request('POST', '/api/caller-keys/add-key', { body: { name: 'Test user key' } })
      assert.equal(added.status, 200)
      const addition = await added.json()
      assert.equal(addition.keys.length, 1)
      const id = addition.keys[0].id
      assert.notEqual(id, 'our-free-model-engine')
      const rotated = await fetch(url + '/dsh' + prefix + 'api/caller-keys/rotate-key', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: id }),
      })
      assert.equal(rotated.status, 200)
      const rotation = await rotated.json()
      assert(rotation.secret && rotation.secret !== addition.secret, 'ordinary key rotation must remain functional')
      assert.equal(rotation.keys.length, 1)
      const removed = await owned.request('POST', '/api/caller-keys/remove-key', { body: { key: id } })
      assert.equal(removed.status, 200)
      assert.deepEqual((await removed.json()).keys, [])
      const current = JSON.parse(await readFile(file, 'utf8')).find(row => row.id === 'our-free-model-engine')
      assert(JSON.stringify(current) === JSON.stringify(original), 'real internal key must remain unchanged')
      assert(owned.gateway().key === gateway.key)
      const models = await fetch(gateway.url + '/v1/models', { headers: { authorization: 'Bearer ' + gateway.key } })
      assert.equal(models.status, 200)
      await models.json()
    })
    await check('real upstream quit is recoverable by start on the same engine owner', async () => {
      const gateway = owned.gateway()
      const quit = await owned.request('POST', '/api/window/quit', { body: {} })
      assert.equal(quit.status, 204)
      await eventually(() => owned.status().state === 'error')
      assert.equal((await owned.start()).state, 'ready')
      assert.equal(owned.gateway().url, gateway.url)
      assert(owned.gateway().key === gateway.key)
      assert.equal((await (await owned.request('GET', '/api/settings')).json()).noAccountDiscovery, true)
    })
    await check('real engine restart keeps its gateway address and key; close ends owned process', async () => {
      const gateway = owned.gateway()
      await owned.close()
      await assert.rejects(fetch(gateway.url + '/v1/models'))
      const restart = engine({ dataDir: path.join(scratch, 'real') })
      await restart.start()
      assert.deepEqual(restart.gateway(), gateway)
      await restart.close()
    })
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key]
    Object.assign(process.env, oldEnv)
  }
}

try {
  await reviewTests()
  if (process.argv.includes('--review-repro')) process.exitCode = 0
  else {
    await fixtureTests()
    await realTests()
    console.log('magpie-engine: all fixture and built-binary checks passed')
  }
} finally {
  await Promise.allSettled(engines.map(owned => owned.close()))
  for (const server of servers) {
    server.closeAllConnections?.()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  }
}
