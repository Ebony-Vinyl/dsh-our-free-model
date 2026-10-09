/**
 * Local development packaging only. No version changes, signing or publishing.
 *
 * Decision log: preserve the existing module/Worker/WASM paths and ship a local
 * Node executable. A source-only ZIP needs a separate Node installation; a
 * desktop installer adds an application shell and signing outside this scope.
 * This first target is the build machine's macOS architecture.
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const repositoryRoot = fileURLToPath(new URL('..', import.meta.url))
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const json = value => `${JSON.stringify(value, null, 2)}\n`
const sourceFiles = [
  'LICENSE',
  'scripts/standalone-third-party.txt',
  'packages/standalone/package.json',
  'packages/standalone/cli.mjs',
  'packages/standalone/service.mjs',
  'packages/standalone/management.mjs',
  'packages/standalone/login-terminal.mjs',
  'packages/standalone/eac.mjs',
  ...['business', 'contracts', 'credentials', 'images', 'runtime', 'worker']
    .map(name => `packages/standalone/channels/${name}.mjs`),
  ...['index.html', 'app.js', 'app.css', 'channels.js', 'channels.css']
    .map(name => `packages/standalone/web/${name}`),
  ...['adapter', 'catalog', 'channel', 'eac', 'eac-login', 'eac-user', 'effort',
    'egress', 'forward', 'http', 'kilo', 'messages', 'probe', 'recovery',
    'store', 'stream', 'trust', 'upstream', 'vault', 'vault-data', 'vault-anchor']
    .map(name => `src/${name}.js`),
  ...['completion', 'runtime', 'stats'].map(name => `src/core/${name}.js`),
  'vendor/channel-pack/qoder-auth-wasm.wasm',
  'vendor/channel-pack/LICENSE',
  'vendor/channel-pack/NOTICE.md',
].sort()

function regularBytes(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error(`Only regular files can be packaged: ${file}`)
  return fs.readFileSync(file)
}

function ensureDirectory(directory) {
  if (fs.existsSync(directory)) {
    if (!fs.lstatSync(directory).isDirectory()) throw new Error(`Not a real directory: ${directory}`)
  } else fs.mkdirSync(directory)
}

export function buildStandalonePackage({ nodeExecutable = process.execPath, nodeLicense, outputName } = {}) {
  if (process.platform !== 'darwin') throw new Error('This local package builder currently supports macOS only')
  if (!nodeLicense) throw new Error('--node-license is required; supply the complete LICENSE for the bundled Node version')
  const executable = fs.realpathSync(nodeExecutable)
  const binary = regularBytes(executable)
  const license = regularBytes(path.resolve(nodeLicense))
  if (!license.toString().startsWith('Node.js is licensed for use as follows:') || license.length < 20000) {
    throw new Error('The Node license must include its third-party license notices')
  }
  const cleanEnv = { ...process.env }
  delete cleanEnv.NODE_OPTIONS
  delete cleanEnv.NODE_PATH
  const node = JSON.parse(execFileSync(executable, ['-p',
    'JSON.stringify({version:process.version,platform:process.platform,arch:process.arch})'],
  { env: cleanEnv, encoding: 'utf8', timeout: 10000 }))
  const [major, minor] = node.version.slice(1).split('.').map(Number)
  if (!(major === 22 && minor >= 19 || major >= 24)) throw new Error(`Unsupported Node version: ${node.version}`)
  if (node.platform !== process.platform || node.arch !== process.arch) throw new Error('Node must match the build machine platform and architecture')
  // Homebrew-style Node builds can require libraries not present on another Mac.
  const linked = execFileSync('/usr/bin/otool', ['-L', executable], { encoding: 'utf8', timeout: 10000 })
    .trim().split('\n').slice(1).map(line => line.trim().split(' (')[0])
  if (linked.length === 0 || linked.some(file => !file.startsWith('/usr/lib/') && !file.startsWith('/System/Library/'))) {
    throw new Error('Node depends on non-system libraries; use a self-contained Node distribution')
  }
  const sources = sourceFiles.map(file => ({ file, bytes: regularBytes(path.join(repositoryRoot, file)) }))
  const product = JSON.parse(sources.find(item => item.file === 'packages/standalone/package.json').bytes)
  const sourceDigest = hash(Buffer.concat(sources.flatMap(({ file, bytes }) => [Buffer.from(`${file}\0${bytes.length}\0`), bytes])))
  const nodeDigest = hash(binary)
  const name = outputName ?? `ofm-standalone-${product.version}-${node.platform}-${node.arch}-dev-${sourceDigest.slice(0, 10)}`
  if (!/^[a-z0-9][a-z0-9.-]{0,150}$/.test(name)) throw new Error('Output name must be a single lowercase filename')
  const dist = path.join(repositoryRoot, 'dist')
  ensureDirectory(dist)
  const destination = path.join(dist, name)
  const archive = `${destination}.zip`
  if (fs.existsSync(destination) || fs.existsSync(archive)) throw new Error(`Output already exists: ${name}`)
  const staging = fs.mkdtempSync(path.join(dist, '.package-stage-'))
  const root = path.join(staging, name)
  fs.mkdirSync(root)
  try {
    const files = []
    const write = (file, bytes, mode = 0o644) => {
      const target = path.join(root, file)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, bytes, { flag: 'wx', mode })
      fs.chmodSync(target, mode)
      files.push({ path: file, bytes: Buffer.byteLength(bytes), sha256: hash(bytes), mode })
    }
    for (const { file, bytes } of sources) write(file === 'scripts/standalone-third-party.txt' ? 'THIRD_PARTY_NOTICES.txt' : file, bytes)
    write('runtime/node', binary, 0o755)
    write('runtime/LICENSE', license)
    write('package.json', json({ name: product.name, version: product.version, private: true, type: 'module' }))
    write('start.command', `#!/bin/sh
set -eu
ofm_package_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ofm_package_dir/runtime/node" "$ofm_package_dir/packages/standalone/cli.mjs" "$@"
`, 0o755)
    write('README.txt', `Our Free Model 独立服务：本地开发验证包

产品版本：${product.version}
运行平台：macOS ${node.arch}
内置 Node：${node.version}

双击 start.command，或在终端执行：
  ./start.command
  ./start.command --port 0 --data-dir "/绝对路径/独立数据目录"

无需安装 Node、npm、DSH 或项目依赖。终端会打印一次性管理登录链接。
默认只监听本机回环地址，端口 18900；冲突时自动选用可用端口。
默认数据目录 ~/.our-free-model；OFM_HOME 或 --data-dir 可以覆盖。
停止服务请在运行终端按 Ctrl+C。替换程序包时保留数据目录即可。
本包不包含用户账号、API Key、历史记录或本机配置。不要共用正在运行的数据目录。

本包只用于开发验证，未经发布签名，不是正式安装包。
仅验证构建机器的 macOS 架构；未验证其它 macOS 版本、Intel Mac 或 Windows/Linux。
本包不会设置系统代理，也不会修改其它客户端的接入配置。
完整性记录见 package-manifest.json；该记录不是签名或发布授权。
许可证见 LICENSE、vendor/channel-pack/、THIRD_PARTY_NOTICES.txt 和 runtime/LICENSE。
`)
    const manifest = {
      format: 'ofm-local-package/v1', purpose: 'development-validation-only',
      product: { name: product.name, version: product.version },
      source: {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot, encoding: 'utf8' }).trim(),
        worktreeDirty: execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'],
          { cwd: repositoryRoot, encoding: 'utf8' }).trim() !== '',
        snapshotSha256: sourceDigest,
      },
      packagerSha256: hash(regularBytes(fileURLToPath(import.meta.url))),
      runtime: { ...node, sha256: nodeDigest, licenseSha256: hash(license), origin: 'local-executable' },
      files: files.sort((left, right) => left.path.localeCompare(right.path)),
    }
    write('package-manifest.json', json(manifest))
    const temporaryZip = path.join(staging, 'package.zip')
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--noextattr', '--keepParent', root, temporaryZip], { timeout: 120000 })
    execFileSync('/usr/bin/unzip', ['-tqq', temporaryZip], { timeout: 120000 })
    fs.renameSync(root, destination)
    fs.renameSync(temporaryZip, archive)
    return { directory: destination, archive, files: files.length, sourceSha256: sourceDigest, node: node.version }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = {}
    for (let index = 2; index < process.argv.length; index++) {
      const flag = process.argv[index]
      if (flag === '--help') {
        console.log('Local macOS package: node scripts/pack-standalone.mjs --node-license <Node LICENSE> [--node <executable>] [--name <output-name>]')
        process.exit(0)
      }
      if (!['--node-license', '--node', '--name'].includes(flag) || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
        throw new Error(`Unknown option or missing value: ${flag}`)
      }
      const fields = { '--node-license': 'nodeLicense', '--node': 'nodeExecutable', '--name': 'outputName' }
      options[fields[flag]] = process.argv[++index]
    }
    console.log(JSON.stringify(buildStandalonePackage(options), null, 2))
  } catch (error) {
    console.error(`Local packaging failed: ${error.message}`)
    process.exitCode = 1
  }
}
