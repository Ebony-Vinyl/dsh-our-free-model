import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mintWorkerSeal } from './mint-eac-seal.mjs'
import { openSealFrom, detectSealedHost } from '../src/vault.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ofm-mint-test-'))
const cli = fileURLToPath(new URL('./mint-eac-seal.mjs', import.meta.url))
const config = { workerBase: 'https://gateway.test/eac/v1', signingSecret: crypto.randomBytes(32).toString('hex') }
const input = path.join(root, 'private.json')
const run = (source, destination) => spawnSync(process.execPath, [cli, source, destination], { encoding: 'utf8' })
const privateOutputAbsent = result => {
  const output = `${result.stdout}${result.stderr}`
  assert.equal(output.includes(config.signingSecret), false)
  assert.equal(output.includes(config.workerBase), false)
  assert.equal(output.includes(input), false)
}
try {
  // BOM is common in JSON written by Windows PowerShell.
  await fs.writeFile(input, `\uFEFF${JSON.stringify(config)}`)
  const output = path.join(root, 'generated')
  const generated = run(input, output)
  privateOutputAbsent(generated)
  assert.equal(generated.status, 0)
  const data = await import(pathToFileURL(path.join(output, 'vault-data.js')).href)
  const anchor = await import(pathToFileURL(path.join(output, 'vault-anchor.js')).href)
  assert.deepEqual(openSealFrom([...data.LANE_SHARDS, anchor.LANE_ANCHOR], data.LANE_SEAL), {
    mode: 'worker', base: config.workerBase, signingSecret: config.signingSecret,
  })
  const source = await fs.readFile(path.join(output, 'vault-data.js'), 'utf8') + await fs.readFile(path.join(output, 'vault-anchor.js'), 'utf8')
  assert.equal(source.includes(config.signingSecret), false)
  assert.equal(source.includes(config.workerBase), false)
  const overwrite = run(input, output)
  assert.equal(overwrite.status, 1)
  privateOutputAbsent(overwrite)
  assert.equal(source, await fs.readFile(path.join(output, 'vault-data.js'), 'utf8') + await fs.readFile(path.join(output, 'vault-anchor.js'), 'utf8'))
  const second = mintWorkerSeal(config)
  const commonjs = path.join(root, 'commonjs')
  await fs.mkdir(commonjs)
  await fs.writeFile(path.join(commonjs, 'package.json'), JSON.stringify({ type: 'commonjs' }))
  const commonjsOutput = path.join(commonjs, 'generated')
  const commonjsResult = run(input, commonjsOutput)
  privateOutputAbsent(commonjsResult)
  assert.equal(commonjsResult.status, 0)
  assert.equal(commonjsResult.stderr, '')
  assert.equal(`${commonjsResult.stdout}${commonjsResult.stderr}`.includes(commonjsOutput), false)
  const readModule = async file => import(`data:text/javascript;base64,${(await fs.readFile(file)).toString('base64')}`)
  const commonjsData = await readModule(path.join(commonjsOutput, 'vault-data.js'))
  const commonjsAnchor = await readModule(path.join(commonjsOutput, 'vault-anchor.js'))
  assert.deepEqual(openSealFrom([...commonjsData.LANE_SHARDS, commonjsAnchor.LANE_ANCHOR], commonjsData.LANE_SEAL), {
    mode: 'worker', base: config.workerBase, signingSecret: config.signingSecret,
  })
  assert.notEqual(second.seal, data.LANE_SEAL)
  assert.notDeepEqual(second.rows.slice(0, 2), data.LANE_SHARDS)
  assert.equal(openSealFrom([...data.LANE_SHARDS, second.rows[2]], data.LANE_SEAL), null)
  const bytes = Buffer.from(second.seal, 'base64')
  bytes[12] ^= 1
  assert.equal(openSealFrom(second.rows, bytes.toString('base64')), null)
  for (const workerBase of ['http://gateway.test/eac/v1', 'https://gateway.test/eac', 'https://user:pass@gateway.test/v1', 'https://gateway.test/v1?key=x', 'https://gateway.test/v1#x']) {
    assert.throws(() => mintWorkerSeal({ ...config, workerBase }))
  }
  for (const signingSecret of ['', 'too-short', ` ${config.signingSecret}`, `${config.signingSecret}\n`]) {
    assert.throws(() => mintWorkerSeal({ ...config, signingSecret }))
  }
  await fs.writeFile(input, `{"invalid":"${config.signingSecret}`)
  const invalid = run(input, path.join(root, 'invalid'))
  assert.equal(invalid.status, 1)
  privateOutputAbsent(invalid)
  await assert.rejects(fs.stat(path.join(root, 'invalid')))
  const missing = run(path.join(root, 'missing.json'), path.join(root, 'missing'))
  assert.equal(missing.status, 1)
  privateOutputAbsent(missing)
  const inCheckout = run(cli, path.join(root, 'in-checkout'))
  assert.equal(inCheckout.status, 1)
  await assert.rejects(fs.stat(path.join(root, 'in-checkout')))
  assert.equal(detectSealedHost({ env: {}, argv: [], execPath: '/usr/bin/node' }), null)
  console.log('mint-eac-seal-test: all checks passed (round trip, disk exports, randomness, tamper, validation, no overwrite, redacted failures, host gate)')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
