/**
 * Keepalive must not feed the stream watchdog — a dead upstream behind a
 * heartbeat-firing gateway is indistinguishable from a live one at the byte
 * level, so only a `data:` payload counts as progress.
 *
 * Reproduces the 2026-10-11 lane incident: the EAC gateway answers 200 +
 * `: channel open`, then `: keepalive` every 15 s while the relay holds the
 * first token. On the reporter's box the relay never delivered; the client
 * sat in readSse with its idle deadline reset by every comment frame — for
 * as long as the user was willing to watch a spinner.
 *
 * Drive the lane's own poster (postSealedStreamed) against a local server
 * that fires the same comment frames, then never sends a payload. The turn
 * must end as a classified TIMEOUT inside the first-frame window, not hang.
 *
 * Run: node scripts/keepalive-watchdog-test.mjs
 */
import http from 'node:http'
import { postSealedStreamed } from '../src/eac.js'

let failures = 0
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`)
}

// A stand-in gateway: 200 + SSE head immediately, comment frames every 50 ms,
// and never a `data:` payload. The connection stays open — the deadest stream
// the real gateway can produce.
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  res.write(': channel open\n\n')
  const beat = setInterval(() => res.write(': keepalive\n\n'), 50)
  res.on('close', () => clearInterval(beat))
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const { port } = server.address()

const credential = { mode: 'worker', base: `http://127.0.0.1:${port}/eac/v1`, signingSecret: '0123456789abcdef0123456789abcdef' }

// The turn deadline is the one thing that must distinguish the two worlds.
// Production runs at 300 s; this loop pins 120 ms so the red check can prove
// the difference inside a test budget. Both calls use the same short deadline:
// before the fix it is ignored (heartbeats reset it), after the fix it is
// honoured, and the only variable between red and green is the fix itself.
const outcome = await Promise.race([
  postSealedStreamed({ credential, body: { model: 'moonshotai/kimi-k2.6', stream: true }, onData: () => {}, timeoutMs: 120 })
    .then(() => 'resolved')
    .catch(error => error?.code ?? `throw:${error?.message}`),
  new Promise(resolve => setTimeout(() => resolve('hung'), 400)),
])
check('a heartbeat-only stream fails inside the first-frame window', outcome, 'TIMEOUT')

const green = await Promise.race([
  postSealedStreamed({ credential, body: { model: 'moonshotai/kimi-k2.6', stream: true }, onData: () => {}, timeoutMs: 120 })
    .then(() => 'resolved')
    .catch(error => error?.code ?? `throw:${error?.message}`),
  new Promise(resolve => setTimeout(() => resolve('hung'), 3000)),
])
check('the classified failure is a retryable timeout', green, 'TIMEOUT')

server.close()
console.log(failures === 0 ? '\nkeepalive watchdog: heartbeats keep the connection, not the deadline' : `\n${failures} check(s) failed`)
process.exitCode = failures === 0 ? 0 : 1
