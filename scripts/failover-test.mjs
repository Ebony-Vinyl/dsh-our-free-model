/**
 * Offline checks for the egress lane's failover ladder (src/egress.js).
 *
 * The outlet here is a CONNECT proxy the test switches between "carries the
 * tunnel" and three ways of failing, and the gateway is an echo server on
 * loopback — so every rung is driven end to end, through the real relay, with no
 * network and no mihomo. What is being pinned:
 *
 *   - a request the outlet could not carry comes back answered, not lost: the
 *     tunnel never opened, the gateway never saw it, so it is replayed once over
 *     the direct path while the strike is recorded;
 *   - one strike asks the host for another node, a benchful of them takes the
 *     outlet out of the path entirely, and the bench window doubles per failed
 *     trial until it settles on the cap;
 *   - the repaired outlet is picked up on the next trial request and the whole
 *     ladder — strikes, bench, doubling — is cleared by the first answer that
 *     comes back through the relay;
 *   - what must *not* count: a caller that walked away, and a body that was
 *     already consumed by the attempt that failed;
 *   - what must not be re-sent even though it counts: a failure that landed
 *     after the request had been handed to the tunnel, which may have been
 *     served upstream.
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { startEgressRelay, egressFetch, egressActive, egressLane } from '../src/egress.js'

let checks = 0
let failures = 0

function check(ok, message) {
  checks += 1
  if (!ok) {
    failures += 1
    console.log(`  ✗ ${message}`)
  }
}

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)))
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** The gateway: answers what it saw. */
function startTarget() {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url, body: Buffer.concat(chunks).toString('utf8') }))
    })
  })
  return listen(server)
}

/**
 * The outlet: a CONNECT proxy whose behaviour is a switch this test flips.
 *
 *   `ok`    — open the tunnel and splice both directions.
 *   `cut`   — close before answering CONNECT: a node that is not there, so the
 *             failure lands on the dial.
 *   `stall` — answer CONNECT, then drop the tunnel: a node that accepts the
 *             connection and carries nothing, so the failure lands on the
 *             request, after it had been handed over. Same 502, marked apart.
 *   `refuse`— answer CONNECT with 407: an outlet whose verdict is about this
 *             plugin, not about its own health.
 */
function startOutlet() {
  const counts = { connect: 0 }
  let mode = 'ok'
  const server = http.createServer((req, res) => { res.writeHead(405); res.end() })
  server.on('connect', (req, socket, head) => {
    counts.connect += 1
    if (mode === 'cut') { socket.destroy(); return }
    if (mode === 'refuse') {
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nproxy-authenticate: Basic realm="ofm"\r\n\r\n')
      return
    }
    if (mode === 'stall') {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      setTimeout(() => socket.destroy(), 20)
      return
    }
    const [host, port] = req.url.split(':')
    const upstream = net.connect({ host, port: Number(port) })
    upstream.on('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
  })
  return listen(server).then(port => ({
    port,
    counts,
    setMode: next => { mode = next },
    close: () => new Promise(resolve => server.close(() => resolve())),
  }))
}

const BENCH = { strikes: 2, bypassMs: 150, bypassMaxMs: 1200 }

/** A relay generation with the ladder's own thresholds and both callbacks recorded. */
async function startLane({ dataDir, outlet, config }) {
  const faults = []
  const lanes = []
  const relay = await startEgressRelay({
    config: config ?? (() => ({ mode: 'client', url: `http://127.0.0.1:${outlet.port}` })),
    dataDir,
    policy: BENCH,
    onFault: error => faults.push(String(error?.message ?? error)),
    onLane: event => lanes.push(event.transition),
  })
  return { relay, faults, lanes }
}

let stage = 'boot'
async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-failover-'))
  stage = 'target'
  const targetPort = await startTarget()
  const base = `http://127.0.0.1:${targetPort}`
  const post = () => egressFetch(`${base}/echo`, { method: 'POST', body: 'hello' })

  stage = 'outlet'
  const outlet = await startOutlet()
  check(egressLane().state === 'off', 'with no relay the lane is off')

  stage = 'start'
  const lane = await startLane({ dataDir, outlet })
  check(egressActive() === true && egressLane().state === 'relay', 'a fresh relay starts on the relay path')

  // 1 — carrying. Nothing is counted against an outlet that answers.
  stage = 'carrying'
  const carried = await post()
  check(carried.status === 200 && (await carried.json()).body === 'hello', 'the outlet carries a request')
  check(outlet.counts.connect === 1, 'and the request went through the outlet')
  check(egressLane().strikes === 0 && egressLane().direct === 0, 'with nothing counted against it')

  // 2 — one strike. The tunnel never opened, so nothing reached the gateway and
  // the same request can simply be sent again from this machine's own address.
  stage = 'strike'
  outlet.setMode('cut')
  const saved = await post()
  check(saved.status === 200 && (await saved.json()).body === 'hello', 'a request the outlet could not carry still gets an answer')
  check(outlet.counts.connect === 2, 'the outlet was tried exactly once for it')
  const strained = egressLane()
  check(strained.state === 'strained' && strained.strikes === 1, 'one failure is recorded, the outlet is not benched yet')
  check(strained.direct === 1, 'and the dropped request is counted as a direct one')
  check(lane.faults.length === 1 && strained.reason.length > 0, 'the host is told about the strike')
  check(lane.lanes.length === 0, 'and no path change is announced over a single strike')

  // 3 — a caller that walked away. The harness aborts turns routinely and not
  // one of those aborts says the exit is down.
  stage = 'abort'
  const controller = new AbortController()
  controller.abort()
  await egressFetch(`${base}/echo`, { method: 'POST', body: 'hello', signal: controller.signal }).catch(() => null)
  check(lane.faults.length === 1 && egressLane().strikes === 1, 'an aborted request is not a strike')

  // 4 — the bench. The outlet is out of the path, so no turn pays a dial timeout
  // before it is allowed to answer.
  stage = 'bench'
  const dropped = await post()
  check(dropped.status === 200, 'the request that benches it is answered direct too')
  const bench = egressLane()
  const firstWindow = bench.benchUntil - Date.now()
  check(bench.state === 'direct' && bench.benched === 1, 'the next failure benches the outlet')
  check(firstWindow > 100 && firstWindow <= BENCH.bypassMs, 'for the base window')
  check(lane.lanes.join(',') === 'bench', 'and the path change is announced')
  stage = 'benched'
  const spent = outlet.counts.connect
  check((await post()).status === 200, 'a benched outlet is bypassed, not waited on')
  check(outlet.counts.connect === spent, 'so the outlet is not dialled at all')
  check(egressLane().direct === 3, 'and the request is counted as a direct one')

  // 5 — the trial. The first request after the window is the probe; a probe that
  // fails is an answer, so it re-opens the bench on a wider one.
  stage = 'trial'
  await wait(Math.max(0, egressLane().benchUntil - Date.now()) + 20)
  check(egressLane().state === 'probing', 'once the window closes the lane is back on trial')
  check((await post()).status === 200, 'the trial request is answered whichever way it goes')
  const reopened = egressLane()
  check(reopened.state === 'direct' && reopened.benched === 2, 'a failed trial re-opens the bench at once')
  check(reopened.strikes === 0, 'and is not counted as a fresh strike against a bench that is already open')
  const doubled = reopened.benchUntil - Date.now()
  check(doubled > 250 && doubled <= BENCH.bypassMs * 2, 'on a doubled window')

  // 6 — the repair. The first answer that comes back through the relay clears
  // the strikes, the bench and the doubling together.
  stage = 'recover'
  await wait(Math.max(0, egressLane().benchUntil - Date.now()) + 20)
  outlet.setMode('ok')
  const back = await post()
  const healed = egressLane()
  check(back.status === 200 && (await back.json()).body === 'hello', 'the repaired outlet carries the request again')
  check(healed.state === 'relay' && healed.strikes === 0 && healed.benched === 0 && healed.benchUntil === 0,
    'and the whole ladder is cleared')
  check(lane.lanes.join(',') === 'bench,bench,relay', 'the return to the relay is announced')

  // 7 — the cap. Each failed trial doubles the window until it settles, so an
  // outlet that stays dead is re-tried at a settling rate, not on every turn.
  stage = 'cap'
  outlet.setMode('cut')
  await post()
  await post()
  const windows = [egressLane().benchUntil - Date.now()]
  for (let attempt = 0; attempt < 3; attempt++) {
    await wait(Math.max(0, egressLane().benchUntil - Date.now()) + 20)
    await post()
    windows.push(egressLane().benchUntil - Date.now())
  }
  // Ceiling rather than rounding: the window is read a few milliseconds after it
  // was written, and every rung of this ladder is a multiple of the base.
  check(windows.map(ms => Math.ceil(ms / 50) * 50).join(',') === '150,300,600,1200', 'the window doubles per failed trial')
  check(egressLane().benched === 4, 'and the ladder counts the reopens')

  // 8 — a failure that landed after the request had been handed to the tunnel.
  // The outlet is held to account for it like any other, but this request is not
  // sent again: it may have been served upstream, and one turn charged twice is
  // worse than the 502 the caller is handed instead. Same for a body that cannot
  // be re-sent verbatim — half a stream would be worse still.
  stage = 'no-replay'
  await lane.relay.close()
  check(egressLane().state === 'off', 'closing the relay takes the lane off')
  const second = await startLane({ dataDir, outlet })
  outlet.setMode('stall')
  const stalled = await post()
  check(stalled.status === 502, 'a node that accepts the tunnel and carries nothing fails the request')
  check(stalled.headers.get('x-ofm-egress-fault') === 'sent', 'marked as a failure that landed after the request went out')
  check(second.faults.length === 1 && egressLane().strikes === 1, 'and it is the same strike as a refused dial')
  check(egressLane().direct === 0, 'with nothing re-sent from this machine')
  outlet.setMode('cut')
  const unplayable = await egressFetch(`${base}/echo`, { method: 'POST', body: new URLSearchParams('a=1') })
  check(unplayable.status === 502, 'a body that cannot be re-sent comes back as the outlet\'s failure')
  check(unplayable.headers.get('x-ofm-egress-fault') === 'tunnel', 'marked as the tunnel, not as an upstream 502')
  check(egressLane().direct === 0, 'and it is not counted as a direct request')
  check(second.lanes.length === 1 && second.lanes[0] === 'bench', 'a restarted relay keeps its own ladder')
  await second.relay.close()

  // 9 — an outlet that refuses the credential. Not a bad moment: a verdict about
  // this plugin's own configuration, and one that must stay loud — failing over
  // from it would send the owner's traffic out of the address they routed away.
  stage = 'refused'
  const gated = await startOutlet()
  gated.setMode('refuse')
  const third = await startLane({ dataDir, outlet: gated })
  const rejected = await egressFetch(`${base}/echo`, { method: 'POST', body: 'hello' })
  check(rejected.status === 502, 'a credentialless outlet still fails the request')
  check(rejected.headers.get('x-ofm-egress-fault') === 'refused', 'marked as the outlet\'s own refusal')
  check(third.faults.length === 0 && egressLane().state === 'relay' && egressLane().direct === 0,
    'and it is neither a strike nor a reason to go direct')
  await third.relay.close()
  await gated.close()
  await outlet.close()
  fs.rmSync(dataDir, { recursive: true, force: true })

  console.log(`${failures === 0 ? 'PASS' : 'FAIL'}: failover ${checks - failures}/${checks} checks`)
  // The fake gateway is still open; exit directly.
  process.exit(failures > 0 ? 1 : 0)
}

await main().catch(error => {
  console.error(`FATAL at stage "${stage}":`, error)
  process.exit(1)
})
