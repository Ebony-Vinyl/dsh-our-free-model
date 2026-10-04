#!/usr/bin/env node
/**
 * Deployment self-check for the EAC gateway — run this AFTER the gateway is
 * up, from the machine that holds the lane's private credential file:
 *
 *     node worker/verify-deployment.mjs <gateway-base> <private-json>
 *     node worker/verify-deployment.mjs https://eac.example.com/v1 "D:\our free model\eac-channel.private.json"
 *
 * Signs the same two routes the plugin speaks (listing + one tiny turn) with
 * the plugin's own signing code, and prints one verdict per step. Secrets
 * stay in the private file and are never printed.
 */

import fs from 'node:fs'
import { signSealedRequest } from '../src/eac.js'

const gatewayBase = String(process.argv[2] ?? '').replace(/\/+$/, '')
const privateFile = process.argv[3]
// Production gateways are https; a loopback http address is allowed so a
// pre-deployment drill can verify the exact same files locally.
if ((!/^https:\/\//.test(gatewayBase) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(gatewayBase)) || privateFile === undefined) {
  console.error('usage: node worker/verify-deployment.mjs <gateway-base ending in /v1> <private-json>')
  process.exit(1)
}
const credential = JSON.parse(fs.readFileSync(privateFile, 'utf8'))
const signingSecret = String(credential.signingSecret ?? '')
if (signingSecret.length < 32) {
  console.error('the private file has no signingSecret — mint/deploy needs it (see worker/README.md)')
  process.exit(1)
}

let failures = 0
// Closed before exit: undici's keep-alive sockets otherwise race process
// teardown on Windows and trip a libuv assertion after the verdict prints.
const kill = new AbortController()
const step = async (name, fn) => {
  const started = Date.now()
  try {
    const verdict = await fn()
    console.log(`${verdict.ok ? 'ok  ' : 'FAIL'} ${name} (${Date.now() - started} ms)${verdict.detail === undefined ? '' : ' — ' + verdict.detail}`)
    if (!verdict.ok) failures += 1
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name} (${Date.now() - started} ms) — ${String(error?.message ?? error).slice(0, 200)}`)
  }
}

const signed = (method, suffix, body = '') => {
  // The signature covers the full URL pathname, exactly what the gateway
  // recomputes on its side ('/v1/models', '/v1/chat/completions').
  const path = new URL(gatewayBase + suffix).pathname
  return {
    method,
    headers: {
      'content-type': 'application/json',
      'accept': method === 'POST' ? 'text/event-stream' : 'application/json',
      ...signSealedRequest(signingSecret, { method, path, body }),
    },
    body: body === '' ? undefined : body,
    signal: kill.signal,
  }
}

let rosterId
await step('signed listing round', async () => {
  const response = await fetch(`${gatewayBase}/models`, signed('GET', '/models'))
  if (response.status !== 200) return { ok: false, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}` }
  const payload = await response.json()
  const ids = (payload.data ?? payload.models ?? []).map(row => row?.id).filter(Boolean)
  if (ids.length === 0) return { ok: false, detail: 'listing carried no model ids' }
  rosterId = ids[0]
  return { ok: true, detail: `${ids.length} models, first: ${rosterId}` }
})

if (rosterId !== undefined) {
  await step('signed streaming turn', async () => {
    const body = JSON.stringify({ model: rosterId, messages: [{ role: 'user', content: 'Reply with exactly: OK' }], stream: true, max_tokens: 64 })
    const response = await fetch(`${gatewayBase}/chat/completions`, signed('POST', '/chat/completions', body))
    if (response.status !== 200) return { ok: false, detail: `HTTP ${response.status}: ${(await response.text()).slice(0, 120)}` }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let sawDone = false
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      text += decoder.decode(value, { stream: true })
      if (text.includes('[DONE]')) { sawDone = true; break }
    }
    // Await the cancel: an un-awaited reader release has crashed process exit
    // on Windows (libuv async-handle assertion) before the verdict printed.
    await reader.cancel().catch(() => {})
    if (!sawDone) return { ok: false, detail: `stream ended without [DONE]; head: ${text.slice(0, 120)}` }
    return { ok: true, detail: 'SSE reached [DONE]' }
  })
}

await step('unsigned request refused', async () => {
  const response = await fetch(`${gatewayBase}/models`, { signal: kill.signal })
  return response.status === 401 ? { ok: true, detail: `HTTP ${response.status}` } : { ok: false, detail: `expected 401, got HTTP ${response.status}` }
})

kill.abort()
console.log(failures === 0 ? '\ngateway verified — put its /v1 address into the private file (workerBase) and re-mint.' : `\n${failures} step(s) failed — see worker/README.md for troubleshooting.`)
// Let the process exit naturally once the aborted sockets drain: a hard
// process.exit() here trips a libuv teardown assertion on Windows.
const code = failures === 0 ? 0 : 1
if (failures > 0) setTimeout(() => process.exit(code), 100).unref?.()
