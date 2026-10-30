import assert from 'node:assert/strict';
import http from 'node:http';
import { gzipSync } from 'node:zlib';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { bunFetch, findBunExecutable } from '../src/bun-fetch.js';

const server = http.createServer();
const sockets = new Set();
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
let release;
let hits = 0;
server.on('request', async (req, res) => {
  hits++;
  if (req.url === '/wait') return;
  if (req.url === '/stream' || req.url === '/broken') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first');
    release = () => req.url === '/broken' ? res.destroy() : res.end('second');
    return;
  }
  if (req.url === '/empty') { res.writeHead(204); res.end(); return; }
  if (req.url === '/redirect') { res.writeHead(302, { location: '/echo' }); res.end(); return; }
  if (req.url === '/gzip') {
    const data = gzipSync('decoded ✓');
    res.writeHead(200, { 'content-encoding': 'gzip', 'content-length': data.length }); res.end(data); return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  res.writeHead(req.url === '/error' ? 418 : 200, { 'x-observed': req.headers['x-test'] || '', 'content-type': 'application/octet-stream' });
  res.end(Buffer.concat(chunks));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log(`ok ${passed} - ${name}`);
}
const nodeOptions = { executable: process.execPath };
const call = (path, init = {}, options = nodeOptions) => bunFetch(base + path, init, options);
const deadline = setTimeout(() => { console.error('Test deadline exceeded'); process.exit(1); }, 30000);
try {
  await test('string and byte bodies / request and response headers', async () => {
    for (const body of ['hello ✓\u0000', Uint8Array.from([0, 255, 128, 10, 13])]) {
      const response = await call('/echo', { method: 'POST', headers: { 'x-test': 'kept', authorization: 'Bearer PRIVATE' }, body });
      assert(response instanceof Response);
      assert.equal(response.headers.get('x-observed'), 'kept');
      assert.equal(response.headers.get('transfer-encoding'), null);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(body));
    }
  });
  await test('non-200 and empty response', async () => {
    const response = await call('/error', { method: 'POST', body: 'teapot' });
    assert.equal(response.status, 418); assert.equal(await response.text(), 'teapot');
    const empty = await call('/empty'); assert.equal(empty.status, 204); assert.equal(empty.body, null);
    const head = await call('/echo', { method: 'HEAD' }); assert.equal(head.body, null);
  });
  await test('automatic decompression removes stale headers', async () => {
    const response = await call('/gzip');
    assert.equal(response.headers.get('content-encoding'), null);
    assert.equal(response.headers.get('content-length'), null);
    assert.equal(await response.text(), 'decoded ✓');
  });
  await test('real streaming: first read precedes releasing second chunk', async () => {
    const response = await call('/stream');
    const reader = response.body.getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'first');
    release();
    assert.equal(Buffer.from((await reader.read()).value).toString(), 'second');
    assert.equal((await reader.read()).done, true);
  });
  await test('redirect defaults to error; explicit follow works', async () => {
    await assert.rejects(call('/redirect'), /Bun worker/);
    const response = await call('/redirect', { redirect: 'follow' });
    assert.equal(response.status, 200); await response.text();
  });
  await test('abort before spawn never sends a request', async () => {
    const count = hits;
    const controller = new AbortController(); controller.abort();
    await assert.rejects(call('/echo', { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(hits, count);
  });
  await test('timeout before headers and in-flight abort', async () => {
    await assert.rejects(call('/wait', { signal: AbortSignal.timeout(150) }), { name: 'TimeoutError' });
    const controller = new AbortController();
    const request = call('/wait', { signal: controller.signal });
    setTimeout(() => controller.abort(), 150);
    await assert.rejects(request, { name: 'AbortError' });
  });
  await test('midstream abort errors response body', async () => {
    const controller = new AbortController();
    const response = await call('/stream', { signal: controller.signal });
    const reader = response.body.getReader(); await reader.read(); controller.abort();
    await assert.rejects(reader.read(), { name: 'AbortError' });
  });
  await test('timeout while consuming response body', async () => {
    const response = await call('/stream', { signal: AbortSignal.timeout(500) });
    const reader = response.body.getReader(); await reader.read();
    await assert.rejects(reader.read(), { name: 'TimeoutError' });
  });
  await test('Response.body.cancel terminates worker without retry', async () => {
    const count = hits;
    const response = await call('/stream'); await response.body.cancel();
    await delay(150); assert.equal(hits, count + 1);
  });
  await test('failure after headers errors body', async () => {
    const response = await call('/broken'); const reader = response.body.getReader();
    await reader.read(); release(); await assert.rejects(reader.read(), /Bun worker/);
  });
  await test('worker early exit / stdin EPIPE and spawn errors are redacted', async () => {
    const old = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = '--import=data:text/javascript,process.exit(7)';
      await assert.rejects(call('/echo', { method: 'POST', body: 'PRIVATE'.repeat(200000), headers: { authorization: 'SECRET' } },
        { executable: process.execPath, proxy: 'http://user:PASSWORD@127.0.0.1:1' }), error => {
        assert.match(error.message, /Bun worker/);
        assert.doesNotMatch(error.message, /PRIVATE|SECRET|PASSWORD|user/); return true;
      });
    } finally { if (old === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = old; }
    await assert.rejects(call('/echo', {}, { executable: 'missing-bun-executable-123456' }), /Bun worker failed to start/);
  });
  const bun = findBunExecutable();
  if (bun) {
    await test('native Bun loopback byte and streaming verification', async () => {
      const response = await call('/echo', { method: 'POST', body: Uint8Array.from([0, 255, 123]), headers: { 'x-test': 'bun' } }, { executable: bun });
      assert.equal(response.headers.get('x-observed'), 'bun');
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0, 255, 123]));
      const decoded = await call('/gzip', {}, { executable: bun });
      assert.equal(decoded.headers.get('content-encoding'), null);
      assert.equal(decoded.headers.get('content-length'), null);
      assert.equal(await decoded.text(), 'decoded ✓');
      const stream = await call('/stream', {}, { executable: bun });
      const reader = stream.body.getReader();
      assert.equal(Buffer.from((await reader.read()).value).toString(), 'first'); release();
      assert.equal(Buffer.from((await reader.read()).value).toString(), 'second'); assert.equal((await reader.read()).done, true);
    });
    console.log(`Native executable: ${bun}`);
  } else console.log('SKIP native Bun loopback: no executable found');
  await test('all workers and server connections released', async () => {
    for (let i = 0; i < 100; i++) {
      if (!process._getActiveHandles().some(h => h.constructor?.name === 'ChildProcess') && sockets.size === 0) break;
      await delay(20);
    }
    assert.equal(process._getActiveHandles().filter(h => h.constructor?.name === 'ChildProcess').length, 0);
    assert.equal(sockets.size, 0);
  });
  console.log(`PASS ${passed} tests. Loopback only; no upstream TLS claim.`);
} finally {
  clearTimeout(deadline);
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
