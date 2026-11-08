import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const revision = 'eef99e4bbebaf363840847dce4a33ee72eb37945'
const upstream = 'https://github.com/yetone/magpie.git'
const version = `ofm-${revision.slice(0, 12)}`
const root = fileURLToPath(new URL('../', import.meta.url))
const scratch = path.join(root, '.verify')
const source = path.join(scratch, 'magpie-build')
const vendor = path.join(root, 'vendor', 'magpie')
const env = {
  ...process.env,
  GOOS: { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform],
  GOARCH: { x64: 'amd64', arm64: 'arm64', ia32: '386', arm: 'arm' }[process.arch],
  GOFLAGS: '',
  GOCACHE: path.join(scratch, 'magpie-go-cache'),
  GOMODCACHE: path.join(scratch, 'magpie-go-mod'),
  GOWORK: 'off',
}

function run(command, args, cwd = source, capture = true) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd, env, shell: false, windowsHide: true,
      stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'],
    })
    let output = ''
    child.stdout?.on('data', chunk => { output += chunk })
    child.once('error', reject)
    child.once('close', code => code === 0
      ? resolve(output.trim())
      : reject(new Error(`${command} ${args[0]} failed (${code})`)))
  })
}

async function exists(file) {
  try { await readFile(file); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function licenseFiles(dir, prefix = '', depth = 0) {
  const found = []
  for (const item of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const relative = path.join(prefix, item.name)
    if (item.isFile() && /^(licen[cs]e|copying|notice|copyright)([._-].*)?$/i.test(item.name)) {
      found.push(relative)
    } else if (item.isDirectory() && depth < 2 && !item.name.startsWith('.') &&
      !['testdata', 'tests', 'site', 'node_modules'].includes(item.name)) {
      found.push(...await licenseFiles(dir, relative, depth + 1))
    }
  }
  return found.sort()
}

async function main() {
  await mkdir(scratch, { recursive: true })
  if (!await exists(path.join(source, '.git', 'HEAD'))) {
    await mkdir(source, { recursive: true })
    await run('git', ['init', source], root)
  }
  // A previous build left the patch set applied (below): restore the pristine
  // tree first — the checkout is a disposable scratch clone the builder can
  // recreate from upstream, and a fresh init has nothing to restore — so the
  // dirty check below refuses only a restore that itself failed (a locked
  // file on Windows), not the patch state it expects.
  await run('git', ['reset', '--hard', 'HEAD'], source, false).catch(() => {})
  await run('git', ['clean', '-fd'], source, false).catch(() => {})
  // Never build from a checkout the restore could not clean.
  const dirty = await run('git', ['status', '--porcelain', '--untracked-files=all'])
  if (dirty) throw new Error('Refusing to build from a dirty .verify/magpie-build checkout')
  try { await run('git', ['cat-file', '-e', `${revision}^{commit}`]) } catch {
    await run('git', ['fetch', '--depth=1', upstream, revision], source, false)
  }
  await run('git', ['checkout', '--detach', revision], source, false)
  if (await run('git', ['rev-parse', 'HEAD']) !== revision) throw new Error('Revision mismatch')
  // The engine's own guard patches, applied after checkout so every build is
  // exactly upstream + the patch set — deterministically, and loudly: a patch
  // that no longer applies means upstream moved under it, and the patch needs
  // updating, not this build papering over it.
  const patchDir = path.join(root, 'scripts', 'magpie-engine-patches')
  const patches = (await readdir(patchDir).catch(() => []))
    .filter(name => name.endsWith('.patch')).sort()
    .map(name => ({ name, file: path.join(patchDir, name) }))
  for (const patch of patches) {
    await run('git', ['apply', '--whitespace=nowarn', patch.file], source, false)
  }
  if (patches.length > 0) console.log(`build-magpie-engine: ${patches.length} patch(es) applied: ${patches.map(patch => patch.name).join(', ')}`)
  console.log(`build-magpie-engine: ${revision}, full web engine (${process.platform}/${process.arch})`)
  const executable = `magpie-${process.platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`
  await mkdir(path.join(vendor, 'bin'), { recursive: true })
  const temporary = path.join(scratch, executable)
  // Upstream's own Makefile releases with `-s -w`; the stripped binary also
  // keeps its gzip payload small enough for the legacy updater's 80-file cap.
  const flags = ['-tags', 'nogui', '-trimpath', '-buildvcs=true', '-ldflags', `-s -w -X main.version=${version}`]
  await run('go', ['build', ...flags, '-o', temporary, '.'], source, false)
  const buildInfo = await run('go', ['version', '-m', temporary])
  if (!buildInfo.includes(`vcs.revision=${revision}`)) {
    throw new Error('Built executable has incorrect VCS provenance')
  }
  // The patch set is part of the build: a patched tree stamps vcs.modified,
  // a pristine one must not. Either mismatch means the provenance claim in
  // NOTICE.md and engine.json would not describe the binary.
  if (buildInfo.includes('vcs.modified=true') !== (patches.length > 0)) {
    throw new Error(patches.length > 0
      ? 'the guard patch did not reach the build (vcs.modified=false)'
      : 'the checkout carries changes no patch accounts for (vcs.modified=true)')
  }
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(temporary)) digest.update(chunk)
  const sha256 = digest.digest('hex')
  const modules = []
  const listed = await run('go', ['list', '-deps', '-tags', 'nogui', '-f',
    '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}', '.'])
  const notices = [
    '# Magpie engine notices',
    '',
    `Upstream: ${upstream}`,
    `Pinned revision: ${revision}`,
    `Source build version: ${version}`,
    '',
    ...(patches.length > 0 ? [
      `Built with ${patches.length} guard patch${patches.length === 1 ? '' : 'es'} applied on top of the pinned`,
      `revision (${patches.map(patch => patch.name).join(', ')} in scripts/magpie-engine-patches): an agent`,
      'sync that finds an empty catalog skips the write instead of emptying the',
      "agent's own model list — a provider-less engine must never wipe a wired",
      "agent's picker. Everything else is built without upstream modifications",
      'using the nogui tag, which excludes the native desktop shell and retains',
      'the complete embedded web UI and built-in plugins.',
    ] : [
      'Built without upstream modifications using the nogui tag. This excludes the native',
      'desktop shell and retains the complete embedded web UI and built-in plugins.',
    ]),
    'The owner disables automatic binary updates; upgrades go through this builder.',
    'The upstream MIT license is reproduced in LICENSE. Go dependency license and',
    'notice files below are copied verbatim from the modules linked into this build.',
    'The Go runtime license is included as well. Build inputs and hashes are in engine.json.',
    '',
  ]
  for (const row of [...new Set(listed.split(/\r?\n/).filter(Boolean))].sort()) {
    const [name, moduleVersion, dir] = row.split('|')
    if (name === 'github.com/yetone/magpie') continue
    const files = await licenseFiles(dir)
    if (!files.length) {
      // Some small Go modules declare their license only in the README.
      const readme = await readFile(path.join(dir, 'README.md'), 'utf8').catch(() => '')
      if (/^#+\s+Licen[cs]e\b/im.test(readme)) files.push('README.md')
    }
    if (!files.length) throw new Error(`Missing license notice for ${name}`)
    modules.push({ path: name, version: moduleVersion, licenses: files.map(f => f.replaceAll('\\', '/')) })
    notices.push(`## ${name} ${moduleVersion}`, '')
    for (const file of files) notices.push(`### ${file.replaceAll('\\', '/')}`, '',
      '```text', (await readFile(path.join(dir, file), 'utf8')).trimEnd(), '```', '')
  }
  const goroot = await run('go', ['env', 'GOROOT'])
  notices.push('## Go runtime', '', '```text', (await readFile(path.join(goroot, 'LICENSE'), 'utf8')).trimEnd(), '```', '')
  const upstreamLicense = await readFile(path.join(source, 'LICENSE'))
  await writeFile(path.join(vendor, 'LICENSE'), upstreamLicense)
  await writeFile(path.join(vendor, 'NOTICE.md'), notices.join('\n'))
  const target = path.join(vendor, 'bin', executable)
  await rename(temporary, target)
  if (process.platform !== 'win32') await chmod(target, 0o755)
  let previous = {}
  try { previous = JSON.parse(await readFile(path.join(vendor, 'engine.json'), 'utf8')) } catch {}
  const patchDigests = []
  for (const patch of patches) {
    const digest = createHash('sha256')
    digest.update(await readFile(patch.file))
    patchDigests.push({ name: patch.name, sha256: digest.digest('hex') })
  }
  const metadata = {
    schemaVersion: 1, name: 'magpie', upstream, revision, version, license: 'MIT',
    build: { command: ['go', 'build', ...flags, '.'], go: await run('go', ['version']) },
    ...(patchDigests.length > 0 ? { patches: patchDigests } : {}),
    binaries: {
      ...(previous.revision === revision ? previous.binaries : {}),
      [`${process.platform}-${process.arch}`]: { path: `bin/${executable}`, sha256 },
    },
    modules,
  }
  await writeFile(path.join(vendor, 'engine.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  console.log(`build-magpie-engine: ${path.relative(root, target)} sha256=${sha256}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
