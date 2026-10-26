import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { createWorkbenchLibrary } from '../packages/standalone/library.mjs'
import { prepareClientLaunch, privateWrite } from '../packages/standalone/workbench.mjs'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-library-'))
const dataDir = path.join(scratch, 'state')
const profileDir = id => path.join(dataDir, 'clients', id)
const read = file => fs.readFileSync(file, 'utf8')
const readJSON = file => JSON.parse(read(file))
const clientIds = ['codex', 'claude', 'gemini', 'codex-desktop', 'cc-switch', 'codex-plus-plus']
let clients = clientIds.map(id => ({
  id, mode: id === 'cc-switch' || id === 'codex-plus-plus' ? 'native' : 'gateway',
  nativeOnly: id === 'cc-switch' || id === 'codex-plus-plus',
  model: 'test/model', cwd: scratch, executable: process.execPath, running: false,
  apiKey: 'never-snapshot-this', env: { TOKEN: 'never-snapshot-that' },
}))
let batches = 0
let persistFailure = false
const workbench = {
  clients: () => structuredClone(clients),
  saveBatch(patches) {
    batches++
    if (persistFailure) throw new Error('simulated batch persistence failure')
    const next = clients.map(client => ({ ...client, ...patches.find(patch => patch.id === client.id) }))
    privateWrite(path.join(dataDir, 'batch.json'), JSON.stringify(next.map(({ id, model }) => ({ id, model }))))
    clients = next
    return workbench.clients()
  },
}
let checks = 0
const check = (name, run) => { run(); checks++; console.log(`ok ${name}`) }
let library
let savedProfile
let mcp
let prompt
let skill
let agent
try {
  check('empty library, profile snapshot allowlist and detached public values', () => {
    library = createWorkbenchLibrary({ dataDir, workbench })
    assert.deepEqual(library.list(), { profiles: [], resources: [] })
    savedProfile = library.saveProfile({ name: 'Daily setup' })
    assert.equal(savedProfile.clients.length, 6)
    assert.equal(JSON.stringify(savedProfile).includes('never-snapshot'), false)
    assert.deepEqual(Object.keys(savedProfile.clients[0]).sort(), ['cwd', 'executable', 'id', 'mode', 'model'])
    const view = library.list()
    view.profiles[0].clients[0].model = 'mutated'
    assert.equal(library.list().profiles[0].clients[0].model, 'test/model')
    assert.throws(() => library.saveProfile({ name: 'Daily setup' }), /Duplicate/)
  })
  check('apply validates every client before invoking batch and handles persistence failure', () => {
    clients[0].model = 'changed'
    clients[5].running = true
    assert.throws(() => library.applyProfile({ id: savedProfile.id }), /Stop all/)
    assert.equal(clients[0].model, 'changed')
    assert.equal(batches, 0)
    clients[5].running = false
    const before = structuredClone(clients)
    const diskBefore = read(path.join(dataDir, 'workbench-library.json'))
    persistFailure = true
    assert.throws(() => library.applyProfile({ id: savedProfile.id }), /persistence failure/)
    assert.deepEqual(clients, before)
    assert.equal(read(path.join(dataDir, 'workbench-library.json')), diskBefore)
    persistFailure = false
    assert.equal(library.applyProfile({ id: savedProfile.id }).ok, true)
    assert.equal(clients[0].model, 'test/model')
    const singleOnly = createWorkbenchLibrary({ dataDir, workbench: { clients: workbench.clients, save() { assert.fail('must never save individually') } } })
    assert.throws(() => singleOnly.applyProfile({ id: savedProfile.id }), /saveBatch/)
  })
  check('profile validates stale paths and unknown clients before any save', () => {
    const staleDirectory = path.join(scratch, 'stale')
    fs.mkdirSync(staleDirectory)
    clients[5].cwd = staleDirectory
    const stale = library.saveProfile({ name: 'Stale setup' })
    fs.rmdirSync(staleDirectory)
    const before = batches
    assert.throws(() => library.applyProfile({ id: stale.id }), /does not exist/)
    assert.equal(batches, before)
    clients[5].cwd = scratch
    const removed = clients.pop()
    assert.throws(() => library.applyProfile({ id: savedProfile.id }), /unknown client/)
    assert.equal(batches, before)
    clients.push(removed)
    library.removeProfile({ id: stale.id })
    assert.throws(() => library.removeProfile({ id: stale.id }), /not found/)
  })
  check('resource CRUD persists public intentional content and never executes commands', () => {
    mcp = library.saveResource({
      kind: 'mcp', name: 'Tools', enabled: true,
      content: JSON.stringify({ mcpServers: {
        local: { command: 'never-execute-this-command', args: ['--literal', '$(touch nope)', 'quote"\\'],
          env: { PRIVATE_TOKEN: 'intentional-resource-secret' } },
        remote: { type: 'http', url: 'https://tools.example.test/mcp', headers: { Authorization: 'Bearer resource-secret' } },
      } }),
    })
    prompt = library.saveResource({ kind: 'prompt', name: 'Team instructions', content: 'Keep changes focused.', enabled: true })
    skill = library.saveResource({ kind: 'skill', name: 'Code review', content: 'Review correctness first.', enabled: true })
    agent = library.saveResource({ kind: 'agent', name: 'Reviewer', content: 'Inspect edge cases.', enabled: true })
    const reloaded = createWorkbenchLibrary({ dataDir, workbench })
    assert.deepEqual(reloaded.list(), library.list())
    assert.ok(reloaded.list().resources[0].content.includes('intentional-resource-secret'))
    const edited = library.saveResource({ ...prompt, content: 'Updated instructions.' })
    assert.equal(edited.id, prompt.id)
    assert.equal(library.list().resources.length, 4)
    prompt = edited
    const view = library.list()
    view.resources[0].content = 'tampered'
    assert.equal(library.list().resources[0].content, mcp.content)
  })
  check('malformed inputs, traversal, schema violations and limits leave state untouched', () => {
    const before = read(path.join(dataDir, 'workbench-library.json'))
    for (const name of ['../escape', 'a/b', 'a\\b', ' bad', 'x..y', 'CON', 'a:', 'constructor', 'a\nb']) {
      assert.throws(() => library.saveResource({ kind: 'prompt', name, content: 'x', enabled: true }))
      assert.throws(() => library.saveProfile({ name }))
    }
    for (const content of [
      '{', 'null', '[]', '{}', '{"command":""}', '{"command":"x","url":"https://example.test"}',
      '{"command":"x","args":"bad"}', '{"command":"x","env":{"TOKEN":7}}',
      '{"command":"x","env":{"BAD-KEY":"x"}}', '{"url":"file:///secret"}',
      '{"url":"https://user:secret@example.test"}', '{"url":"https://example.test","headers":{"X":"a\\nb"}}',
      '{"url":"https://example.test","env":{}}', '{"mcpServers":{}}',
      '{"mcpServers":{"../x":{"command":"x"}}}', '{"command":"x","arbitrary":true}',
      '{"command":"x","type":"http"}', '{"command":"x","cwd":"relative"}',
    ]) assert.throws(() => library.saveResource({ kind: 'mcp', name: 'Invalid', content, enabled: true }))
    for (const patch of [
      { ...prompt, id: '../escape' }, { ...prompt, kind: 'unsupported' }, { ...prompt, enabled: 'yes' },
      { ...prompt, content: 'x'.repeat(1024 * 1024 + 1) }, { ...prompt, extra: true },
      { ...prompt, id: crypto.randomUUID() },
    ]) assert.throws(() => library.saveResource(patch))
    assert.throws(() => library.saveResource({ kind: 'mcp', name: 'Duplicate server', enabled: true, content: '{"mcpServers":{"local":{"command":"x"}}}' }), /Duplicate/)
    assert.equal(read(path.join(dataDir, 'workbench-library.json')), before)
  })
  check('materialize restricts exact client directory and rejects native managers', () => {
    for (const clientId of ['../codex', 'unknown', 'constructor', 'cc-switch', 'codex-plus-plus']) {
      assert.throws(() => library.materialize({ clientId, profileDir: profileDir(clientId) }))
    }
    for (const directory of [scratch, path.join(scratch, '.codex'), profileDir('claude'), path.join(profileDir('codex'), 'nested'), '../relative']) {
      assert.throws(() => library.materialize({ clientId: 'codex', profileDir: directory }), /private managed/)
    }
    assert.equal(fs.existsSync(profileDir('codex')), false)
  })
  check('exact client formats preserve routing and unrelated files', () => {
    for (const clientId of ['codex', 'codex-desktop', 'claude', 'gemini']) {
      prepareClientLaunch({
        client: { id: clientId, mode: 'gateway', model: 'routing/model', executable: process.execPath, cwd: scratch },
        profileDir: profileDir(clientId), baseUrl: 'http://127.0.0.1:18900', key: 'routing-secret', env: {},
      })
      const context = path.join(profileDir(clientId), clientId === 'claude' ? 'CLAUDE.md' : clientId === 'gemini' ? '.gemini/GEMINI.md' : 'AGENTS.md')
      privateWrite(context, 'Existing native-independent instructions\n')
      privateWrite(path.join(profileDir(clientId), 'unrelated.txt'), 'keep')
      if (clientId === 'claude' || clientId === 'gemini') {
        const config = path.join(profileDir(clientId), clientId === 'claude' ? '.claude.json' : '.gemini/settings.json')
        const contents = readJSON(config)
        contents.mcpServers = { unrelated: { command: 'keep' } }
        privateWrite(config, JSON.stringify(contents))
      }
      const routing = path.join(profileDir(clientId), clientId === 'gemini' ? '.gemini/settings.json' : clientId === 'claude' ? 'settings.json' : 'config.toml')
      const routingBefore = read(routing)
      const result = library.materialize({ clientId, profileDir: profileDir(clientId) })
      assert.equal(result.ok, true)
      assert.ok(read(context).startsWith('Existing native-independent instructions\n'))
      assert.ok(read(context).includes('Updated instructions.'))
      assert.equal(result.skillPaths.length, 1)
      assert.match(read(result.skillPaths[0]), /^---\nname: ofm-/)
      assert.ok(read(result.skillPaths[0]).includes('Review correctness first.'))
      assert.equal(read(path.join(profileDir(clientId), 'unrelated.txt')), 'keep')
      if (clientId.startsWith('codex')) {
        assert.equal(read(routing), routingBefore)
        assert.match(result.codexConfigFragment, /\[mcp_servers\."local"\]/)
        assert.match(result.codexConfigFragment, /http_headers = \{ "Authorization" = "Bearer resource-secret" \}/)
        assert.equal(read(result.codexFragmentPath), result.codexConfigFragment)
        assert.ok(read(context).includes('Inspect edge cases.'))
        assert.equal(fs.existsSync(path.join(profileDir(clientId), 'agents')), false)
      } else {
        const config = readJSON(path.join(profileDir(clientId), clientId === 'claude' ? '.claude.json' : '.gemini/settings.json'))
        assert.equal(config.mcpServers.unrelated.command, 'keep')
        assert.equal(config.mcpServers.local.env.PRIVATE_TOKEN, 'intentional-resource-secret')
        if (clientId === 'claude') {
          assert.equal(read(routing), routingBefore)
          assert.equal(config.hasCompletedOnboarding, true)
          assert.equal(config.mcpServers.remote.type, 'http')
        } else {
          assert.equal(config.security.auth.selectedType, 'gemini-api-key')
          assert.equal(config.model.name, 'routing/model')
          assert.equal(config.mcpServers.remote.httpUrl, 'https://tools.example.test/mcp')
          assert.equal(config.mcpServers.remote.url, undefined)
        }
        const agents = path.join(profileDir(clientId), clientId === 'gemini' ? '.gemini/agents' : 'agents')
        assert.ok(read(path.join(agents, `ofm-${agent.id}.md`)).includes('Inspect edge cases.'))
        if (clientId === 'gemini') assert.match(read(path.join(agents, `ofm-${agent.id}.md`)), /^---\nkind: local\n/)
      }
      const contentsBefore = result.files.map(file => [file, read(file)])
      library.materialize({ clientId })
      for (const [file, contents] of contentsBefore) assert.equal(read(file), contents)
    }
  })
  check('MCP collisions and user-modified generated files fail before changing any file', () => {
    const configFile = path.join(profileDir('claude'), '.claude.json')
    const config = readJSON(configFile)
    config.mcpServers.local.command = 'user-modified'
    privateWrite(configFile, JSON.stringify(config))
    const before = read(configFile)
    assert.throws(() => library.materialize({ clientId: 'claude' }), /modified MCP/)
    assert.equal(read(configFile), before)
    config.mcpServers.local.command = 'never-execute-this-command'
    privateWrite(configFile, JSON.stringify(config))
    const file = path.join(profileDir('codex'), 'skills', `ofm-${skill.id}`, 'SKILL.md')
    privateWrite(file, 'user-modified skill')
    assert.throws(() => library.materialize({ clientId: 'codex' }), /modified file/)
  })
  check('atomic library persistence failure rolls back disk and in-memory resources', () => {
    const before = library.list()
    const store = path.join(dataDir, 'workbench-library.json')
    const bytes = read(store)
    const original = fs.chmodSync
    let failed = false
    fs.chmodSync = function (file, mode) {
      if (String(file).startsWith(`${store}.`) && String(file).endsWith('.tmp') && !failed) {
        failed = true; throw new Error('simulated chmod failure before rename')
      }
      return original(file, mode)
    }
    try {
      assert.throws(() => library.saveResource({ ...prompt, content: 'must roll back' }), /chmod failure/)
    } finally { fs.chmodSync = original }
    assert.equal(failed, true)
    assert.deepEqual(library.list(), before)
    assert.equal(read(store), bytes)
  })
  check('materialization rolls back earlier files and the file whose rename succeeded', () => {
    library.saveResource({ ...prompt, content: 'new instructions' })
    const directory = profileDir('codex-desktop')
    const targets = ['ofm-mcp.toml', `skills/ofm-${skill.id}/SKILL.md`, 'AGENTS.md', '.workbench-library.json']
    const before = targets.map(relative => [path.join(directory, relative), read(path.join(directory, relative))])
    const original = fs.chmodSync
    let failed = false
    fs.chmodSync = function (file, mode) {
      const target = path.join(directory, 'AGENTS.md')
      if ((file === target || String(file).startsWith(`${target}.`)) && !failed) {
        failed = true; throw new Error('simulated materialization failure')
      }
      return original(file, mode)
    }
    try {
      assert.throws(() => library.materialize({ clientId: 'codex-desktop' }), /materialization failure/)
    } finally { fs.chmodSync = original }
    assert.equal(failed, true)
    for (const [file, contents] of before) assert.equal(read(file), contents)
    assert.equal(fs.readdirSync(directory).some(name => name.endsWith('.tmp')), false)
  })
  check('disable removes only unchanged managed files and merges out owned MCP entries', () => {
    for (const resource of library.list().resources) library.saveResource({ ...resource, enabled: false })
    for (const clientId of ['codex', 'codex-desktop', 'claude', 'gemini']) {
      library.materialize({ clientId })
      assert.equal(read(path.join(profileDir(clientId), 'unrelated.txt')), 'keep')
      const context = path.join(profileDir(clientId), clientId === 'claude' ? 'CLAUDE.md' : clientId === 'gemini' ? '.gemini/GEMINI.md' : 'AGENTS.md')
      assert.equal(read(context), 'Existing native-independent instructions\n')
      const skillFile = path.join(profileDir(clientId), clientId === 'gemini' ? '.gemini/skills' : 'skills', `ofm-${skill.id}`, 'SKILL.md')
      if (clientId === 'codex') assert.equal(read(skillFile), 'user-modified skill')
      else assert.equal(fs.existsSync(skillFile), false)
      assert.equal(fs.existsSync(path.join(profileDir(clientId), 'ofm-mcp.toml')), false)
      if (clientId === 'claude' || clientId === 'gemini') {
        const config = readJSON(path.join(profileDir(clientId), clientId === 'claude' ? '.claude.json' : '.gemini/settings.json'))
        assert.deepEqual(config.mcpServers, { unrelated: { command: 'keep' } })
        const agents = path.join(profileDir(clientId), clientId === 'gemini' ? '.gemini/agents' : 'agents', `ofm-${agent.id}.md`)
        assert.equal(fs.existsSync(agents), false)
      }
    }
  })
  check('remove cleans generated content on next materialize; unrelated MCP survives edits', () => {
    library.saveResource(mcp)
    library.materialize({ clientId: 'claude' })
    const configFile = path.join(profileDir('claude'), '.claude.json')
    const config = readJSON(configFile)
    config.mcpServers.local.command = 'user-owned-now'
    privateWrite(configFile, JSON.stringify(config))
    library.removeResource({ id: mcp.id })
    library.materialize({ clientId: 'claude' })
    const cleaned = readJSON(configFile)
    assert.equal(cleaned.mcpServers.local.command, 'user-owned-now')
    assert.equal(cleaned.mcpServers.remote, undefined)
    assert.equal(cleaned.mcpServers.unrelated.command, 'keep')
    for (const resource of library.list().resources) library.removeResource({ id: resource.id })
    assert.deepEqual(library.list().resources, [])
    assert.throws(() => library.removeResource({ id: mcp.id }), /not found/)
  })
  check('unrelated skill collision and forged manifest paths cannot be overwritten or deleted', () => {
    const added = library.saveResource({ kind: 'skill', name: 'New skill', content: 'new', enabled: true })
    const file = path.join(profileDir('claude'), 'skills', `ofm-${added.id}`, 'SKILL.md')
    privateWrite(file, 'unrelated')
    assert.throws(() => library.materialize({ clientId: 'claude' }), /unrelated/)
    assert.equal(read(file), 'unrelated')
    library.removeResource({ id: added.id })
    const manifest = path.join(profileDir('gemini'), '.workbench-library.json')
    const before = read(manifest)
    const forged = JSON.parse(before)
    forged.files['../../unrelated.txt'] = '0'.repeat(64)
    privateWrite(manifest, JSON.stringify(forged))
    assert.throws(() => library.materialize({ clientId: 'gemini' }), /managed filename/)
    privateWrite(manifest, before)
  })
  check('JSON config created by library is deleted only when it contains no unrelated settings', () => {
    const isolated = path.join(scratch, 'isolated')
    const instance = createWorkbenchLibrary({ dataDir: isolated, workbench })
    const resource = instance.saveResource({ kind: 'mcp', name: 'remote', content: '{"url":"http://localhost:1234/mcp"}', enabled: true })
    instance.materialize({ clientId: 'claude' })
    const config = path.join(isolated, 'clients/claude/.claude.json')
    assert.equal(fs.existsSync(config), true)
    instance.removeResource({ id: resource.id })
    instance.materialize({ clientId: 'claude' })
    assert.equal(fs.existsSync(config), false)
    assert.equal(fs.existsSync(path.join(isolated, 'clients/claude/CLAUDE.md')), false)
  })
  check('SSE is adapted for Claude and Gemini and explicitly rejected for Codex', () => {
    const isolated = path.join(scratch, 'sse')
    const instance = createWorkbenchLibrary({ dataDir: isolated, workbench })
    instance.saveResource({ kind: 'mcp', name: 'events', content: '{"type":"sse","url":"https://tools.example.test/sse"}', enabled: true })
    assert.throws(() => instance.materialize({ clientId: 'codex' }), /SSE/)
    assert.equal(fs.existsSync(path.join(isolated, 'clients/codex')), false)
    instance.materialize({ clientId: 'claude' })
    assert.equal(readJSON(path.join(isolated, 'clients/claude/.claude.json')).mcpServers.events.type, 'sse')
    instance.materialize({ clientId: 'gemini' })
    assert.equal(readJSON(path.join(isolated, 'clients/gemini/.gemini/settings.json')).mcpServers.events.url, 'https://tools.example.test/sse')
  })
  check('cleanup preserves pre-existing empty context files but removes library-created ones', () => {
    const isolated = path.join(scratch, 'empty-context')
    const instance = createWorkbenchLibrary({ dataDir: isolated, workbench })
    const resource = instance.saveResource({ kind: 'prompt', name: 'Instructions', content: 'Managed instructions', enabled: true })
    const existing = path.join(isolated, 'clients/claude/CLAUDE.md')
    const created = path.join(isolated, 'clients/codex/AGENTS.md')
    privateWrite(existing, '')
    instance.materialize({ clientId: 'claude' })
    instance.materialize({ clientId: 'codex' })
    instance.removeResource({ id: resource.id })
    instance.materialize({ clientId: 'claude' })
    instance.materialize({ clientId: 'codex' })
    assert.equal(read(existing), '')
    assert.equal(fs.existsSync(created), false)
  })
  check('symlink and hardlink files plus ancestor directory junctions are rejected', () => {
    const outside = path.join(scratch, 'outside')
    fs.mkdirSync(outside)
    privateWrite(path.join(outside, 'sentinel'), 'outside')
    const isolated = path.join(scratch, 'linked')
    fs.mkdirSync(isolated)
    fs.symlinkSync(outside, path.join(isolated, 'clients'), process.platform === 'win32' ? 'junction' : 'dir')
    const instance = createWorkbenchLibrary({ dataDir: isolated, workbench })
    assert.throws(() => instance.materialize({ clientId: 'codex' }), /Symlinks/)
    assert.deepEqual(fs.readdirSync(outside), ['sentinel'])
    assert.throws(() => createWorkbenchLibrary({ dataDir: path.join(isolated, 'clients', 'nested'), workbench }), /Symlinks/)
    const linkedStore = path.join(scratch, 'linked-store')
    fs.mkdirSync(linkedStore)
    fs.linkSync(path.join(dataDir, 'workbench-library.json'), path.join(linkedStore, 'workbench-library.json'))
    assert.throws(() => createWorkbenchLibrary({ dataDir: linkedStore, workbench }), /unlinked file/)
    fs.unlinkSync(path.join(linkedStore, 'workbench-library.json'))
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(dataDir, 'workbench-library.json'), path.join(linkedStore, 'workbench-library.json'))
      assert.throws(() => createWorkbenchLibrary({ dataDir: linkedStore, workbench }), /Symlinks/)
    }
  })
  check('stored secrets and generated files have private POSIX permissions', () => {
    if (process.platform === 'win32') return
    for (const file of [
      path.join(dataDir, 'workbench-library.json'),
      path.join(profileDir('claude'), '.claude.json'),
      path.join(profileDir('gemini'), '.gemini/settings.json'),
      path.join(profileDir('codex'), '.workbench-library.json'),
    ]) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  })
  check('corrupt persistence is rejected; remove profile persists', () => {
    library.removeProfile({ id: savedProfile.id })
    assert.deepEqual(createWorkbenchLibrary({ dataDir, workbench }).list().profiles, [])
    const malformed = path.join(scratch, 'malformed')
    fs.mkdirSync(malformed)
    privateWrite(path.join(malformed, 'workbench-library.json'), '{"version":1,"profiles":[],"resources":[{}]}')
    assert.throws(() => createWorkbenchLibrary({ dataDir: malformed, workbench }))
    privateWrite(path.join(malformed, 'workbench-library.json'), '{broken')
    assert.throws(() => createWorkbenchLibrary({ dataDir: malformed, workbench }), /Invalid JSON/)
  })
} finally {
  const resolved = fs.realpathSync(scratch)
  assert.ok(resolved.startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  // Remove the test junction itself before recursive cleanup; never traverse its target.
  const junction = path.join(scratch, 'linked', 'clients')
  if (fs.existsSync(junction) && fs.lstatSync(junction).isSymbolicLink()) fs.unlinkSync(junction)
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`workbench-library: ${checks} checks passed`)
