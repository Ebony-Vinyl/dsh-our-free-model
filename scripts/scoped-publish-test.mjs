/**
 * Regression suite for the scoped npm publish rename (issue #725).
 *
 * The scoped tarball shipped 2.7.4 and 2.8.0 with the bare registration name
 * still baked into client.js and cordis.patch.yml. On a desktop profile the
 * host half then imported under one name and the browser half registered its
 * factory under another: boot died with `1 entry did not activate` plus
 * `duplicate factory registration`. The maintainer's off-repo rename had no
 * script and no test, so nothing between the reviewed tree and the published
 * artifact checked that the three self-naming literals followed the new name.
 *
 * This suite pins that boundary three ways:
 *   1. the bare tree carries the bare trio (the anchors have not moved);
 *   2. the scoped build carries the scoped trio and no bare leftover;
 *   3. a drifted anchor fails the build loudly instead of shipping half-renamed.
 *
 * It also pins the two manifest fields a scoped publish needs (name, no
 * `private`, public access) and that everything else rides along untouched —
 * the artifact must be the reviewed tree modulo the rename, or the byte hashes
 * the upgrader promises would no longer describe it.
 *
 * Run: node scripts/scoped-publish-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  bareNameOf, scopedNameOf, transformRegistrationFile, scopedManifest,
  buildScopedPackage, verifyScopedRename,
} from './publish-scoped.mjs'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)), '')
let failures = 0
const check = (name, fn) => {
  try { fn(); console.log(`  ok  ${name}`) }
  catch (error) { failures += 1; console.error(`FAIL  ${name} — ${error.message}`) }
}

const BARE = 'dsh-our-free-model'
const SCOPED = '@ebony-vinyl/dsh-our-free-model'

check('the repository tree is the bare package the upgrader ships', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(bareNameOf(pkg), BARE)
  assert.equal(pkg.private, true, 'the bare tree stays private: npm publishes only the scoped artifact')
})

check('the scoped name is the bare name under the repository scope', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  assert.equal(scopedNameOf(pkg), SCOPED)
  // Idempotent: an already-scoped manifest is not double-scoped.
  assert.equal(scopedNameOf({ name: SCOPED }), SCOPED)
})

check('each registration file renames its own literal and nothing else', () => {
  const cases = [
    ['client.js', `  id: '${BARE}',`, `  id: '${SCOPED}',`],
    ['cordis.patch.yml', `      name: '${BARE}'`, `      name: '${SCOPED}'`],
    ['src/updater.js', `const PACKAGE_NAME = '${BARE}'`, `const PACKAGE_NAME = '${SCOPED}'`],
  ]
  for (const [rel, from, to] of cases) {
    assert.equal(transformRegistrationFile(rel, `${from}\n`, BARE, SCOPED), `${to}\n`, rel)
  }
})

check('the wire identity and cosmetic spellings are never renamed', () => {
  // A User-Agent token is what the free-lane gateway keys on; renaming it with
  // the package would break requests, so the transform must leave it alone.
  const source = `const USER_AGENT = '${BARE}'\nstyle.setAttribute('data-plugin', '${BARE}')\n`
  assert.equal(transformRegistrationFile('src/aggregate.js', source, BARE, SCOPED), source)
  assert.equal(transformRegistrationFile('src/eac.js', source, BARE, SCOPED), source)
})

check('a moved registration anchor fails instead of shipping a half-rename', () => {
  // This is the exact class of drift that let #725 through: the literal the
  // rename looks for is gone, so a silent pass would publish the bare id.
  assert.throws(
    () => transformRegistrationFile('client.js', 'id: "changed-shape",\n', BARE, SCOPED),
    /registration literal .* not found/,
  )
})

check('the scoped manifest drops private and goes public, keeping the rest', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const next = scopedManifest(pkg, SCOPED)
  assert.equal(next.name, SCOPED)
  assert.equal(next.private, undefined)
  assert.equal(next.publishConfig.access, 'public')
  assert.equal(next.version, pkg.version)
  assert.deepEqual(next.files, pkg.files, 'the shipped file list must not drift with the rename')
  assert.deepEqual(next.dsh, pkg.dsh)
  assert.deepEqual(next.peerDependencies, pkg.peerDependencies)
})

check('a full scoped build renames all three and copies the rest verbatim', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-scoped-build-'))
  try {
    const { scoped, files } = buildScopedPackage({ repo: root, outDir })
    assert.equal(scoped, SCOPED)
    const wanted = {
      'client.js': `id: '${SCOPED}',`,
      'cordis.patch.yml': `name: '${SCOPED}'`,
      'src/updater.js': `const PACKAGE_NAME = '${SCOPED}'`,
    }
    const stale = {
      'client.js': `id: '${BARE}',`,
      'cordis.patch.yml': `name: '${BARE}'`,
      'src/updater.js': `const PACKAGE_NAME = '${BARE}'`,
    }
    for (const rel of Object.keys(wanted)) {
      const built = fs.readFileSync(path.join(outDir, rel), 'utf8')
      assert.ok(built.includes(wanted[rel]), `${rel} registers under the scoped name`)
      assert.ok(!built.includes(stale[rel]), `${rel} carries no bare registration literal`)
    }
    // The cosmetic DOM attribute and the wire User-Agent keep the bare spelling:
    // renaming those would change behaviour, not identity.
    const client = fs.readFileSync(path.join(outDir, 'client.js'), 'utf8')
    assert.ok(client.includes(`data-plugin', '${BARE}'`), 'the cosmetic data-plugin attribute is left alone')
    const aggregate = fs.readFileSync(path.join(outDir, 'src/aggregate.js'), 'utf8')
    assert.ok(aggregate.includes(`USER_AGENT = '${BARE}'`), 'the request User-Agent is left alone')
    // Binary and vendored bytes ride along untouched.
    const wasm = 'vendor/channel-pack/qoder-auth-wasm.wasm'
    assert.ok(files.includes(wasm))
    assert.deepEqual(
      fs.readFileSync(path.join(outDir, wasm)),
      fs.readFileSync(path.join(root, wasm)),
      'a wasm payload is copied byte-for-byte',
    )
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

check('the registration files differ from the tree only in their own literal', () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-scoped-diff-'))
  try {
    buildScopedPackage({ repo: root, outDir })
    const cases = [
      ['client.js', `id: '${BARE}',`, `id: '${SCOPED}',`],
      ['cordis.patch.yml', `name: '${BARE}'`, `name: '${SCOPED}'`],
      ['src/updater.js', `PACKAGE_NAME = '${BARE}'`, `PACKAGE_NAME = '${SCOPED}'`],
    ]
    for (const [rel, from, to] of cases) {
      const before = fs.readFileSync(path.join(root, rel), 'utf8')
      const after = fs.readFileSync(path.join(outDir, rel), 'utf8')
      assert.equal(after, before.replace(from, to), `${rel}: exactly one substitution, no other byte moves`)
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true })
  }
})

check('the invariant holds end to end against the real tree', () => {
  const { bare, scoped } = verifyScopedRename({ repo: root })
  assert.deepEqual([bare, scoped], [BARE, SCOPED])
})

check('a bare tree that lost an anchor is reported, not silently accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-scoped-drift-'))
  try {
    for (const rel of ['package.json', 'client.js', 'cordis.patch.yml', 'src/updater.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
      name: BARE, version: '9.9.9', private: true, files: ['client.js', 'cordis.patch.yml', 'src/updater.js'],
    }))
    // client.js never registers under the bare name: the anchor moved.
    fs.writeFileSync(path.join(dir, 'client.js'), 'id: "elsewhere",\n')
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `      name: '${BARE}'\n`)
    fs.writeFileSync(path.join(dir, 'src/updater.js'), `const PACKAGE_NAME = '${BARE}'\n`)
    assert.throws(() => verifyScopedRename({ repo: dir }), /registration literal .* not found|missing .* registration/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.error(`\nscoped-publish: ${failures} failure(s)`)
  process.exit(1)
}
console.log('\nscoped-publish: the scoped artifact renames every self-naming literal and nothing else')
