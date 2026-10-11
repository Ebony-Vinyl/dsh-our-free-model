#!/usr/bin/env node
// 获取桌面版内嵌的官方 Node 运行时。
//
// 桌面壳以子进程方式运行 packages/standalone，闭包自带 Node，
// 不要求用户机器安装任何运行时。SHA-256 固定官方发行物，防止供应链替换。
//
//   node scripts/fetch-desktop-runtime.mjs
//
// 产物：build-cache/node.exe（由 scripts/build-desktop.mjs 打进安装包）。

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cache = path.join(repo, 'build-cache')
const nodeVersion = 'v22.21.1'
const zipName = `node-${nodeVersion}-win-x64.zip`
const zipPath = path.join(cache, zipName)
const nodePath = path.join(cache, 'node.exe')

// 官方 v22.21.1 win-x64 发行 zip 的 SHA-256；升级版本时同步更新。
const EXPECTED_SHA256 = '3c624e9fbe07e3217552ec52a0f84e2bdc2e6ffa7348f3fdfb9fbf8f42e23fcf'

if (fs.existsSync(nodePath)) {
  process.stdout.write(`[runtime] 已存在：${nodePath}\n`)
  process.exit(0)
}
fs.mkdirSync(cache, { recursive: true })

if (!fs.existsSync(zipPath)) {
  process.stdout.write(`[runtime] 下载 ${zipName} …\n`)
  const url = `https://nodejs.org/dist/${nodeVersion}/${zipName}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载失败：${response.status} ${response.statusText}`)
  fs.writeFileSync(zipPath, Buffer.from(await response.arrayBuffer()))
}

const digest = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')
if (digest !== EXPECTED_SHA256) {
  fs.rmSync(zipPath, { force: true })
  throw new Error(`SHA-256 不匹配：期望 ${EXPECTED_SHA256}，实际 ${digest}（已删除损坏的下载）`)
}
process.stdout.write(`[runtime] SHA-256 校验通过\n`)

// 用 PowerShell 解压（Node 无内置 unzip；Windows 10+ 自带）。
const extract = spawnSync('powershell', [
  '-NoProfile', '-Command',
  `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${path.join(cache, '_node')}' -Force`,
], { stdio: 'inherit' })
if (extract.status !== 0) throw new Error('解压失败')
fs.copyFileSync(path.join(cache, '_node', `node-${nodeVersion}-win-x64`, 'node.exe'), nodePath)
fs.rmSync(path.join(cache, '_node'), { recursive: true, force: true })
process.stdout.write(`[runtime] 就绪：${nodePath}\n`)
