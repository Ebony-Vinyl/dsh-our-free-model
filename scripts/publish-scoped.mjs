/**
 * Build the scoped npm artifact from the bare repository tree.
 *
 * The repository ships a bare package (`dsh-our-free-model`, `private: true`):
 * the in-app upgrader downloads these exact bytes, and `client-lint` /
 * `catalog-test` pin the bare name, so the tree must stay bare. The npm channel
 * is a *rename* of that same reviewed tree to the scoped name the repository
 * publishes under (`@ebony-vinyl/dsh-our-free-model`), per README.
 *
 * A rename is only safe when every place the package names *itself as a loader
 * row* follows the new name. There are exactly three such registration literals,
 * and they are the three that a hand-rolled rename historically missed (issue
 * #725: the scoped 2.7.4/2.8.0 tarball shipped with the bare id still baked in,
 * so a desktop boot threw `duplicate factory registration` and `1 entry did not
 * activate`):
 *
 *   - client.js         `id: '<bare>',`               — the browser factory id
 *   - cordis.patch.yml  `name: '<bare>'`              — the host loader mount row
 *   - src/updater.js    `const PACKAGE_NAME = '<bare>'` — the pnpm-ownership key
 *
 * The last one is subtler than a boot failure: `isPackageManagerOwned` reads the
 * profile lockfile / `.modules.yaml` under `PACKAGE_NAME`. A scoped install is
 * recorded under the *scoped* key, so with the bare constant it never matches —
 * the in-app updater then treats a package-manager-owned install as self-owned
 * and rewrites it under the pack's feet. Renaming PACKAGE_NAME with the artifact
 * is what keeps that guard honest for the scoped channel.
 *
 * Everything else that spells the bare name is deliberately NOT renamed: the
 * `dsh-our-free-model` User-Agent tokens (aggregate/eac/kilo/picks) are wire
 * identity the upstream gateways key on, and `data-plugin` is a cosmetic DOM
 * attribute. Only the three registration literals above are the loader's own
 * naming of itself.
 *
 * `--check` runs the transform into a temp tree and asserts the result, without
 * writing anything; that is the mode the regression suite uses.
 *
 * Run (produce an installable scoped tarball directory):
 *
 *     node scripts/publish-scoped.mjs --out <dir>
 *
 * Run (verify the transform agrees, no writes):
 *
 *     node scripts/publish-scoped.mjs --check
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.join(fileURLToPath(new URL('..', import.meta.url)))

/** The repository's own bare package name, read from the tree — never hardcoded. */
export function bareNameOf(pkg) {
  return String(pkg.name)
}

/** The scoped name the repository publishes under: its owner scope + bare name. */
export function scopedNameOf(pkg, scope = '@ebony-vinyl') {
  const bare = bareNameOf(pkg)
  if (bare.startsWith(`${scope}/`)) return bare
  return `${scope}/${bare}`
}

/**
 * The three registration literals, as exact source substrings keyed by the file
 * they live in. Matching the whole literal (not a bare substring) is what keeps
 * the User-Agent and DOM-attribute spellings untouched.
 * @param {string} name
 */
function registrationLiterals(name) {
  return {
    'client.js': [`id: '${name}',`],
    'cordis.patch.yml': [`name: '${name}'`],
    'src/updater.js': [`const PACKAGE_NAME = '${name}'`],
  }
}

/**
 * Rewrite one shipped file's registration literals from `from` to `to`.
 * Throws when a file that must carry a literal does not, so a refactor that
 * moves or renames a registration fails loudly here instead of shipping a
 * half-renamed artifact.
 * @param {string} rel - path relative to the repository root.
 * @param {string} text - the file's source.
 * @param {string} from - the bare name to replace.
 * @param {string} to - the scoped name to write.
 * @returns {string} the transformed source.
 */
export function transformRegistrationFile(rel, text, from, to) {
  const literals = registrationLiterals(from)[rel]
  if (literals === undefined) return text
  let out = text
  for (const literal of literals) {
    const replacement = literal.split(from).join(to)
    if (!out.includes(literal)) throw new Error(`${rel}: registration literal ${JSON.stringify(literal)} not found — the rename anchor moved`)
    out = out.split(literal).join(replacement)
  }
  return out
}

/**
 * The scoped package.json: the reviewed bare manifest with the three fields a
 * scoped npm publish needs, and nothing else changed. `private` is dropped (npm
 * refuses a private publish), `access` is made public, and `name` is scoped. The
 * `files` list, `dsh` declaration, and every other field ride along untouched,
 * so the artifact is byte-for-byte the reviewed tree modulo the rename.
 * @param {object} pkg - the parsed bare package.json.
 * @param {string} scoped - the scoped name.
 */
export function scopedManifest(pkg, scoped) {
  const next = structuredClone(pkg)
  next.name = scoped
  delete next.private
  next.publishConfig = { ...(next.publishConfig ?? {}), access: 'public' }
  return next
}

/**
 * Build the scoped package into `outDir`, copying every file the package ships
 * (`package.json` + the `files` list) and rewriting the three registration
 * literals. Binary files are copied verbatim; the rename only ever touches the
 * three text anchors.
 * @param {{ repo?: string, outDir: string, pkg?: object, scope?: string }} options
 * @returns {{ scoped: string, files: string[] }} what was written.
 */
export function buildScopedPackage({ repo = root, outDir, pkg, scope } = {}) {
  const manifest = pkg ?? JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const bare = bareNameOf(manifest)
  const scoped = scopedNameOf(manifest, scope)
  const shipped = ['package.json', ...(manifest.files ?? [])]
  const written = []
  const ensure = (rel, body) => {
    const target = path.join(outDir, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, body)
    written.push(rel)
  }
  for (const rel of shipped) {
    const absolute = path.join(repo, rel)
    let stat
    try { stat = fs.statSync(absolute) } catch { throw new Error(`package files entry does not exist: ${rel}`) }
    if (stat.isDirectory()) {
      for (const [childRel, childAbs] of walkShipped(absolute, rel)) ensure(childRel, fs.readFileSync(childAbs))
      continue
    }
    if (rel === 'package.json') {
      ensure(rel, `${JSON.stringify(scopedManifest(manifest, scoped), null, 2)}\n`)
      continue
    }
    if (isRegistrationFile(rel)) {
      const text = fs.readFileSync(absolute, 'utf8')
      ensure(rel, transformRegistrationFile(rel, text, bare, scoped))
      continue
    }
    ensure(rel, fs.readFileSync(absolute))
  }
  return { scoped, files: written }
}

function isRegistrationFile(rel) {
  return rel === 'client.js' || rel === 'cordis.patch.yml' || rel === 'src/updater.js'
}

/** Every regular file under a shipped directory, as [rel, absolute] pairs. */
function* walkShipped(absolute, rel) {
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const childAbs = path.join(absolute, entry.name)
    const childRel = `${rel}/${entry.name}`
    if (entry.isDirectory()) yield* walkShipped(childAbs, childRel)
    else if (entry.isFile()) yield [childRel, childAbs]
  }
}

/**
 * Assert the bare tree and the scoped build each carry a self-consistent trio of
 * registration names. This is the invariant the hand-rolled rename kept breaking.
 * @param {{ repo?: string, scope?: string }} options
 * @throws {Error} on any drift, with the offending file.
 */
export function verifyScopedRename({ repo = root, scope } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'))
  const bare = bareNameOf(manifest)
  const scoped = scopedNameOf(manifest, scope)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-scoped-'))
  try {
    buildScopedPackage({ repo, outDir: dir, pkg: manifest, scope })
    for (const [rel, name] of [['client.js', scoped], ['cordis.patch.yml', scoped], ['src/updater.js', scoped]]) {
      const built = fs.readFileSync(path.join(dir, rel), 'utf8')
      for (const literal of registrationLiterals(name)[rel]) {
        if (!built.includes(literal)) throw new Error(`scoped ${rel} is missing ${JSON.stringify(literal)}`)
      }
      for (const stale of registrationLiterals(bare)[rel]) {
        if (built.includes(stale)) throw new Error(`scoped ${rel} still carries the bare literal ${JSON.stringify(stale)}`)
      }
    }
    const builtManifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (builtManifest.name !== scoped) throw new Error(`scoped package.json name is ${builtManifest.name}, want ${scoped}`)
    if (builtManifest.private !== undefined) throw new Error('scoped package.json must drop private')
    if (builtManifest.publishConfig?.access !== 'public') throw new Error('scoped package.json must set publishConfig.access=public')
    // The bare tree must still be self-consistent: the rename is the only path
    // to a scoped artifact, and the reviewed tree is what the upgrader ships.
    for (const rel of ['client.js', 'cordis.patch.yml', 'src/updater.js']) {
      const source = fs.readFileSync(path.join(repo, rel), 'utf8')
      for (const literal of registrationLiterals(bare)[rel]) {
        if (!source.includes(literal)) throw new Error(`bare ${rel} is missing ${JSON.stringify(literal)} — the rename anchor moved`)
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  return { bare, scoped }
}

function main() {
  const argv = process.argv.slice(2)
  const flag = name => argv.includes(name)
  const valueOf = (name, dflt) => {
    const at = argv.indexOf(name)
    return at === -1 ? dflt : argv[at + 1]
  }
  if (flag('--check')) {
    const { bare, scoped } = verifyScopedRename()
    console.log(`publish-scoped: OK — bare ${JSON.stringify(bare)} renames to scoped ${JSON.stringify(scoped)}; all three registration literals agree in both trees`)
    return
  }
  const outDir = valueOf('--out', null)
  if (!outDir) {
    console.error('usage: node scripts/publish-scoped.mjs --out <dir> | --check')
    process.exit(1)
  }
  const { scoped, files } = buildScopedPackage({ outDir: path.resolve(outDir) })
  console.log(`publish-scoped: wrote ${files.length} files for ${scoped} into ${path.resolve(outDir)}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()
