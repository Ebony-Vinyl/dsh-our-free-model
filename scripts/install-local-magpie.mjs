/** Install the validated workspace into the existing local plugin, keeping peers. */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const source = fileURLToPath(new URL('../', import.meta.url))
const workspace = path.resolve(source, '..')
// Follow the active profile binding; development installs can live elsewhere.
const target = fs.realpathSync('C:/Users/HUAWEI/.dsh/profiles/desktop/node_modules/dsh-our-free-model')
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'))
const previous = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'))
if (pkg.name !== 'dsh-our-free-model' || previous.name !== pkg.name) throw new Error('Unexpected plugin installation')
const accepted = JSON.parse(fs.readFileSync(path.join(source, '.verify/magpie-native-ui/latest.json'), 'utf8'))
if (!accepted.passed) throw new Error('Native acceptance has not passed')
for (const [file, expected] of [
  ['client.js', accepted.package.clientSha256],
  ['index.js', accepted.package.indexSha256],
  ['src/magpie-engine.js', accepted.package.engineSha256],
  ['src/loopback-fetch.js', accepted.package.transportSha256],
  ['src/magpie-models.js', accepted.package.engineModelsSha256],
]) {
  if (hash(path.join(source, file)) !== expected) throw new Error(`Source changed since native acceptance: ${file}`)
}
const engine = JSON.parse(fs.readFileSync(path.join(source, 'vendor/magpie/engine.json'), 'utf8'))
const binary = engine.binaries[`${process.platform}-${process.arch}`]
if (!binary || hash(path.join(source, 'vendor/magpie', binary.path)) !== binary.sha256) {
  throw new Error('Engine checksum mismatch')
}

const files = []
function walk(relative) {
  const file = path.join(source, relative)
  if (!fs.lstatSync(file).isDirectory()) { files.push(relative); return }
  for (const child of fs.readdirSync(file, { withFileTypes: true })) {
    if (child.name.startsWith('.') || child.name === 'node_modules') continue
    walk(path.join(relative, child.name))
  }
}
for (const relative of ['package.json', 'README.md', ...pkg.files]) walk(relative)
const unique = [...new Set(files)]
const backup = path.join(workspace, '.aio-backup', `ofm-before-magpie-${Date.now()}`)
assertInside(backup, path.join(workspace, '.aio-backup'))
fs.mkdirSync(path.dirname(backup), { recursive: true })
fs.cpSync(target, backup, {
  recursive: true,
  filter: file => !path.relative(target, file).split(path.sep).includes('node_modules'),
})
let copied = 0
for (const relative of unique) {
  const destination = path.join(target, relative)
  assertInside(destination, target)
  // Unchanged engine binaries may be in use by the active desktop process.
  if (fs.existsSync(destination) && hash(path.join(source, relative)) === hash(destination)) continue
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.copyFileSync(path.join(source, relative), destination)
  copied++
}
for (const relative of unique) {
  if (hash(path.join(source, relative)) !== hash(path.join(target, relative))) {
    throw new Error(`Installed file mismatch: ${relative}`)
  }
}
const report = {
  installedAt: new Date().toISOString(), version: pkg.version, source, target, backup,
  files: unique.length, copied, clientSha256: hash(path.join(target, 'client.js')),
  engineRevision: engine.revision, nativeAcceptance: accepted.scratch,
}
const evidence = path.join(source, '.verify/local-plugin-install')
fs.mkdirSync(evidence, { recursive: true })
fs.writeFileSync(path.join(evidence, 'latest.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))

function assertInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('Installation path is outside its expected directory')
  }
}
