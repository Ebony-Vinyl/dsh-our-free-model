import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { selfReload } from '../src/reload.js'
import { Context, Service } from '@deepseek-ai/cordis'

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-reload-'))
let checks = 0
try {
  for (const identity of ['callback', 'namespace']) {
    const directory = path.join(scratch, identity)
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}')
    const entry = pathToFileURL(path.join(directory, 'index.js')).href
    const dependency = path.join(directory, 'dependency.js')
    fs.writeFileSync(dependency, 'export const value = "old"\n')
    fs.writeFileSync(path.join(directory, 'lazy.js'), 'export const value = "old-lazy"\n')
    const source = version => `import { value } from './dependency.js'
export const version = '${version}'
export function apply() { return value }
export const lazy = () => import('./lazy.js')
`
    fs.writeFileSync(path.join(directory, 'index.js'), source('1.0.0'))
    const previous = await import(entry)
    await previous.lazy()
    const callback = identity === 'callback' ? previous.apply : previous
    fs.writeFileSync(dependency, 'export const value = "new"\n')
    fs.writeFileSync(path.join(directory, 'lazy.js'), 'export const value = "new-lazy"\n')
    fs.writeFileSync(path.join(directory, 'index.js'), source('1.1.0'))
    let registered, disposals = 0
    const fiber = {
      uid: 1, _config: {}, await: async () => {},
      parent: { registry: { plugin(module) {
        registered = module
        return { ctx: { fiber: { await: async () => {} } } }
      } } },
    }
    const context = {
      fiber: { runtime: { callback } },
      registry: { get: () => ({ fibers: [fiber] }), delete() { disposals++ } },
      loader: { unwrapExports: value => value, import: url => import(url) },
    }
    const result = await selfReload(context, {
      packageUrl: pathToFileURL(`${directory}${path.sep}`).href, entryUrl: entry,
      expectedVersion: '1.1.0', logger: {},
    })
    assert.equal(result.ok, true, result.error)
    assert.equal(disposals, 1)
    assert.equal(registered.version, '1.1.0')
    assert.equal(registered.apply(), 'new', 'dependencies must belong to the new generation')
    assert.equal((await registered.lazy()).value, 'new-lazy', 'lazy dependencies must also be fresh')
    console.log(`ok ${++checks} cache-hidden host reloads ${identity} identity and its static/lazy dependencies (#348)`)
    context.fiber.runtime.callback = identity === 'callback' ? registered.apply : registered
    fs.writeFileSync(dependency, 'export const value = "newest"\n')
    fs.writeFileSync(path.join(directory, 'index.js'), source('1.2.0'))
    const next = await selfReload(context, {
      packageUrl: pathToFileURL(`${directory}${path.sep}`).href, entryUrl: entry,
      expectedVersion: '1.2.0', logger: {},
    })
    assert.equal(next.ok, true, next.error)
    assert.equal(registered.version, '1.2.0')
    assert.equal(registered.apply(), 'newest')
    console.log(`ok ${++checks} repeated ${identity} reload never returns the original cached entry`)
  }
  const root = new Context()
  try {
    class Llm extends Service {
      constructor(ctx) { super(ctx, 'llm') }
    }
    await root.plugin(Llm)
    let current, starts = 0
    const original = { name: 'reload-fixture', inject: ['llm'], apply(ctx) {
      assert.ok(ctx.llm)
      current = ctx
      starts++
    } }
    await root.plugin(original)
    const replacement = { version: '2.0.0', inject: ['llm'], apply() { throw new Error('controlled startup failure') } }
    Object.defineProperty(current, 'loader', { value: {
      unwrapExports: value => value, import: async () => replacement,
    } })
    const restored = await selfReload(current, { logger: {}, expectedVersion: '2.0.0' })
    assert.equal(restored.ok, false)
    assert.equal(restored.restored, true, restored.error)
    assert.equal(starts, 2, 'rollback must re-run the old module with its declared injection')
    assert.ok(current.llm)
    console.log(`ok ${++checks} real Cordis startup rollback preserves module injection metadata`)
  } finally { await root.fiber.dispose() }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`${checks}/${checks} reload regressions passed`)
