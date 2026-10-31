import assert from 'node:assert/strict'
import { BUN_PROFILE, HEADER_ORDER, configureTlsTransport, egressFetch, freeLaneTransport, splitSseFrames } from '../src/egress.js'

// Frame slicing: the whole point of the buffered transport is that a caller
// sees the same frames it would have seen from a live stream.
assert.deepEqual(splitSseFrames('data: a\n\ndata: b\n\n'), ['data: a\n\n', 'data: b\n\n'])
assert.deepEqual(splitSseFrames('data: a\r\n\r\ndata: b\r\n\r\n'), ['data: a\r\n\r\n', 'data: b\r\n\r\n'])
assert.deepEqual(splitSseFrames('data: a\n\ndata: par'), ['data: a\n\n', 'data: par'])
assert.deepEqual(splitSseFrames('data: only'), ['data: only'])
assert.deepEqual(splitSseFrames(''), [])
assert.deepEqual(splitSseFrames('data: a\n\ndata: b'), ['data: a\n\n', 'data: b'])
console.log('PASS sse frames: LF, CRLF, trailing partial, empty')

// The profile is transcribed from a measurement; a typo in the ja3 string is
// silent at runtime and only shows up as an upstream refusal.
const groups = BUN_PROFILE.ja3String.split(',')
assert.equal(groups.length, 5, 'ja3 is version, ciphers, extensions, curves, point formats')
assert.equal(groups[0], '771')
assert.equal(groups[4], '0')
assert.ok(groups[1].split('-').length > 10)
assert.deepEqual(BUN_PROFILE.alpnProtocols, ['http/1.1'])
assert.ok(BUN_PROFILE.keyShareCurves.includes('X25519MLKEM768'))
assert.equal(HEADER_ORDER.length, 13)
assert.equal(HEADER_ORDER[0], 'authorization')
assert.equal(HEADER_ORDER.at(-1), 'accept-encoding')
console.log('PASS profile: ja3 groups, alpn, curves, header order')

const savedTransport = process.env.OUR_FREE_MODEL_FREE_TRANSPORT
const savedLib = process.env.OUR_FREE_MODEL_TLS_LIB
try {
  configureTlsTransport({ dataDir: '', log: () => {}, fetch: () => { throw new Error('offline') } })

  process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'bogus'
  await assert.rejects(
    () => egressFetch('https://opencode.ai/inference/v1/models'),
    /must be auto, bun, tls, or node/,
  )
  // The settings page reads this field; an unrecognised value must read as the
  // default rather than label the lane with a transport it never uses.
  assert.equal(freeLaneTransport().mode, 'auto')
  process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'tls'
  assert.equal(freeLaneTransport().mode, 'tls')
  assert.equal(freeLaneTransport().ready, false)
  console.log('PASS transport: unknown value is rejected by name, and reads back as auto')

  // With the package absent, selecting tls must fail with an instruction rather
  // than a module-resolution stack. When it is installed, only the missing-file
  // branch is exercised — this suite never opens a client or downloads a dll.
  process.env.OUR_FREE_MODEL_FREE_TRANSPORT = 'tls'
  let installed = true
  try { await import('tlsclientwrapper') } catch { installed = false }
  if (!installed) {
    await assert.rejects(
      () => egressFetch('https://opencode.ai/inference/v1/models'),
      /needs tlsclientwrapper installed/,
    )
    console.log('PASS transport: missing package names the install command')
  } else {
    process.env.OUR_FREE_MODEL_TLS_LIB = '/nonexistent/tls-client-xgo.dll'
    await assert.rejects(
      () => egressFetch('https://opencode.ai/inference/v1/models'),
      /OUR_FREE_MODEL_TLS_LIB points at a missing file/,
    )
    delete process.env.OUR_FREE_MODEL_TLS_LIB
    console.log('PASS transport: missing native library names the override')
  }

  // Every other host keeps the plain fetch path regardless of the setting.
  const savedFetch = globalThis.fetch
  let reached = false
  globalThis.fetch = async () => { reached = true; return new Response('{}') }
  try {
    await egressFetch('https://api.kilo.ai/api/gateway/models')
    assert.equal(reached, true, 'a non-free-lane host must not enter the tls branch')
  } finally {
    globalThis.fetch = savedFetch
  }
  console.log('PASS transport: only the free lane is diverted')
} finally {
  if (savedTransport === undefined) delete process.env.OUR_FREE_MODEL_FREE_TRANSPORT
  else process.env.OUR_FREE_MODEL_FREE_TRANSPORT = savedTransport
  if (savedLib === undefined) delete process.env.OUR_FREE_MODEL_TLS_LIB
  else process.env.OUR_FREE_MODEL_TLS_LIB = savedLib
}

console.log('tls-client transport: all checks passed')
