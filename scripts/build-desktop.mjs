#!/usr/bin/env node
// 组装桌面版资源闭包并调用 tauri build。
//
// standalone 的 ESM import 以「仓库根」为基准上跳（如 packages/standalone →
// ../../src/...），因此闭包必须完整镜像仓库根布局。安装后的结构：
//   <install>/resources/app/packages/standalone/   服务本体（进程 cwd）
//   <install>/resources/app/src/                   核心模块
//   <install>/resources/app/adapter/               免费车道适配器
//   <install>/resources/app/vendor/channel-pack/   qoder 认证 WASM
//   <install>/resources/runtime/node.exe           官方 Node 运行时

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktop = path.join(repo, 'desktop')
const resources = path.join(desktop, 'resources')
const appDir = path.join(resources, 'app')
const serviceDir = path.join(appDir, 'packages', 'standalone')
const runtimeDir = path.join(resources, 'runtime')
const assembleOnly = process.argv.includes('--assemble-only')
const VERSION = '1.0.0'
const PRODUCT_NAME = 'OurFreeModel'

const log = message => process.stdout.write(`[desktop] ${message}\n`)

/** 删除并重建目录。 */
function resetDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

/** 递归复制目录，可选排除。 */
function copyTree(from, to, { exclude = [] } = {}) {
  fs.cpSync(from, to, { recursive: true, filter: source => {
    const relative = path.relative(from, source)
    return !exclude.some(pattern => relative === pattern || relative.startsWith(pattern + path.sep))
  } })
}

function assemble() {
  log('组装服务闭包（镜像仓库根布局）…')
  resetDir(resources)
  fs.mkdirSync(runtimeDir, { recursive: true })

  copyTree(path.join(repo, 'src'), path.join(appDir, 'src'))
  copyTree(path.join(repo, 'adapter'), path.join(appDir, 'adapter'))
  fs.mkdirSync(path.join(appDir, 'packages'), { recursive: true })
  copyTree(path.join(repo, 'packages', 'standalone'), serviceDir, {
    exclude: ['node_modules', 'package-lock.json', 'tsconfig.json', 'vite.config.mjs', 'components.json'],
  })
  // channels/business.mjs 通过 ../../../vendor/... 定位 WASM，镜像布局下天然成立。
  fs.mkdirSync(path.join(appDir, 'vendor', 'channel-pack'), { recursive: true })
  fs.copyFileSync(
    path.join(repo, 'vendor', 'channel-pack', 'qoder-auth-wasm.wasm'),
    path.join(appDir, 'vendor', 'channel-pack', 'qoder-auth-wasm.wasm'),
  )

  // 独立服务的 web 资源是提交的构建产物，直接随闭包走；校验关键文件存在。
  const required = [
    path.join(serviceDir, 'cli.mjs'),
    path.join(serviceDir, 'service.mjs'),
    path.join(serviceDir, 'web', 'index.html'),
    path.join(serviceDir, 'web', 'assets.json'),
    path.join(appDir, 'src', 'core', 'runtime.js'),
    path.join(appDir, 'src', 'adapter.js'),
    path.join(appDir, 'vendor', 'channel-pack', 'qoder-auth-wasm.wasm'),
  ]
  for (const file of required) {
    if (!fs.existsSync(file)) throw new Error(`闭包缺少关键文件：${file}`)
  }

  const nodeSource = path.join(repo, 'build-cache', 'node.exe')
  if (!fs.existsSync(nodeSource)) {
    throw new Error('缺少 build-cache/node.exe，请先执行：node scripts/fetch-desktop-runtime.mjs')
  }
  fs.copyFileSync(nodeSource, path.join(runtimeDir, 'node.exe'))
  log(`服务闭包就绪：${serviceDir}`)
}

function countFiles(dir) {
  let count = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    count += entry.isDirectory() ? countFiles(path.join(dir, entry.name)) : 1
  }
  return count
}

assemble()
log(`闭包文件数：${countFiles(serviceDir)}`)
if (!assembleOnly) {
  // 确保 desktop 依赖（tauri CLI）就绪。
  if (!fs.existsSync(path.join(desktop, 'node_modules', '@tauri-apps', 'cli'))) {
    log('安装 @tauri-apps/cli …')
    const install = spawnSync('npm', ['install', '--no-fund', '--no-audit'], { cwd: desktop, stdio: 'inherit', shell: true })
    if (install.status !== 0) throw new Error('npm install 失败')
  }

  log('执行 tauri build（NSIS 安装包）…')
  const tauri = spawnSync('npx', ['tauri', 'build'], { cwd: desktop, stdio: 'inherit', shell: true })
  if (tauri.status !== 0) throw new Error('tauri build 失败')

  // 便携版：把安装级布局（exe + resources）压成 zip，解压即用。
  log('生成便携版 zip …')
  await makePortable()

  const bundleDir = path.join(targetReleaseDir(), 'bundle')
  log('构建完成，产物在：')
  for (const entry of walk(bundleDir)) {
    if (/\.(exe|zip)$/.test(entry)) log('  ' + path.relative(repo, entry))
  }
  if (fs.existsSync(path.join(desktop, 'target', 'release', 'portable'))) {
    log(`  desktop\\target\\release\\portable\\${PRODUCT_NAME}-${VERSION}-portable-win64.zip`)
  }
}

/** cargo 目标目录：设置了 CARGO_BUILD_TARGET 时位于三元组子目录。 */
function targetReleaseDir() {
  const triple = process.env.CARGO_BUILD_TARGET
  return path.join(desktop, 'target', ...(triple ? [triple] : []), 'release')
}

async function makePortable() {
  const releaseDir = targetReleaseDir()
  const exe = path.join(releaseDir, 'our-free-model-desktop.exe')
  const appResources = path.join(releaseDir, 'resources')
  if (!fs.existsSync(exe)) throw new Error('未找到构建出的主程序 exe')
  const outDir = path.join(releaseDir, 'portable')
  fs.mkdirSync(outDir, { recursive: true })
  // PowerShell Compress-Archive 系统自带，无需额外依赖。
  const staging = path.join(outDir, PRODUCT_NAME)
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  fs.copyFileSync(exe, path.join(staging, 'OurFreeModel.exe'))
  fs.cpSync(appResources, path.join(staging, 'resources'), { recursive: true })
  const zip = path.join(outDir, `${PRODUCT_NAME}-${VERSION}-portable-win64.zip`)
  fs.rmSync(zip, { force: true })
  const ps = spawnSync('powershell', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path '${staging}\\*' -DestinationPath '${zip}' -Force`,
  ], { stdio: 'inherit', shell: false })
  if (ps.status !== 0) throw new Error('便携版压缩失败')
  fs.rmSync(staging, { recursive: true, force: true })
}

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield* walk(full)
    else yield full
  }
}
