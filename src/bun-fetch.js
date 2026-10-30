import { accessSync, constants, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough, Readable } from 'node:stream';

/**
 * The worker source, inlined so the published package stays inside the
 * historical updater's 80-file ceiling (adding a second file overran it).
 * It is written once to a private temporary directory and reused for the
 * process lifetime. It speaks one JSON line on stdin and returns one metadata
 * line plus raw response bytes on stdout; no request content is evaluated.
 */
const WORKER_SOURCE = `import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
try {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const init = { method: request.method, headers: request.headers, redirect: request.redirect ?? 'error' };
  if (request.body !== null) init.body = Buffer.from(request.body, 'base64');
  if (request.proxy !== undefined) init.proxy = request.proxy;
  const response = await fetch(request.url, init);
  const headers = [...response.headers].filter(([key]) => ![
    'content-encoding', 'content-length', 'transfer-encoding', 'connection',
    'keep-alive', 'trailer', 'upgrade',
  ].includes(key.toLowerCase()));
  const metadata = Buffer.from(JSON.stringify({ status: response.status, statusText: response.statusText, headers }) + '\\n');
  await pipeline(Readable.from((async function* () {
    yield metadata;
    if (response.body) for await (const chunk of response.body) yield chunk;
  })()), process.stdout);
} catch {
  process.exitCode = 1;
}
`;

let workerPath;

/** Materialize the inlined worker once; never executes request content. */
export function bunWorkerPath() {
  if (workerPath !== undefined) return workerPath;
  const dir = mkdtempSync(join(tmpdir(), 'ofm-bun-worker-'));
  const file = join(dir, 'worker.mjs');
  writeFileSync(file, WORKER_SOURCE, { mode: 0o600 });
  workerPath = file;
  return workerPath;
}

/** Locate a native executable, never a shell shim. No installation or download. */
export function findBunExecutable() {
  const name = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const candidates = [process.env.OUR_FREE_MODEL_BUN,
    process.env.BUN_INSTALL && join(process.env.BUN_INSTALL, 'bin', name),
    join(homedir(), '.bun', 'bin', name),
    ...(process.env.PATH || '').split(delimiter).filter(Boolean).map(p => join(p.replace(/^"|"$/g, ''), name)),
    process.env.APPDATA && join(process.env.APPDATA, 'npm', 'node_modules', 'bun', 'bin', name)];
  for (const candidate of candidates.filter(Boolean)) {
    try {
      const path = resolve(candidate);
      if (process.platform === 'win32' && !path.toLowerCase().endsWith('.exe')) continue;
      if (!statSync(path).isFile()) continue;
      accessSync(path, constants.X_OK);
      return path;
    } catch { /* try next native executable */ }
  }
  return undefined;
}

/** String/Uint8Array request bodies; init.signal controls the entire response lifetime.
 * options.proxy is passed only over stdin. Omit it to retain Bun's environment proxy.
 * Redirects default to error; no retries. Errors never include worker stderr or input.
 */
export async function bunFetch(url, init = {}, options = {}) {
  const { signal } = init;
  signal?.throwIfAborted();
  const executable = options.executable || findBunExecutable();
  if (!executable) throw new Error('Bun executable not found; set OUR_FREE_MODEL_BUN to a native executable.');
  if (init.body != null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array)) {
    throw new TypeError('bunFetch body must be a string or Uint8Array.');
  }
  let payload;
  try {
    payload = JSON.stringify({ url: String(url), method: init.method || 'GET',
      headers: [...new Headers(init.headers)],
      body: init.body == null ? null : Buffer.from(init.body).toString('base64'),
      proxy: options.proxy, redirect: init.redirect ?? 'error' });
  } catch { throw new TypeError('Invalid bunFetch request.'); }
  return new Promise((resolveResponse, reject) => {
    let child;
    let body;
    let header = Buffer.alloc(0);
    let receivedHeaders = false;
    let stopped = false;
    const stop = () => { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); };
    const fail = error => {
      if (stopped) return;
      stopped = true;
      reject(error);
      body?.destroy(error);
      stop();
    };
    const onAbort = () => fail(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    try { child = spawn(executable, [bunWorkerPath()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); }
    catch { reject(new Error('Bun worker failed to start.')); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', () => fail(new Error('Bun worker failed to start.')));
    child.stdin.on('error', () => fail(new Error('Bun worker input failed.')));
    child.stderr.resume(); // Never surface diagnostics containing URLs, credentials or bodies.
    child.stdout.on('error', () => fail(new Error('Bun worker output failed.')));
    child.on('close', code => {
      signal?.removeEventListener('abort', onAbort);
      if (!stopped) {
        if (code !== 0 || !receivedHeaders) fail(new Error('Bun worker failed before completing the response.'));
        else { stopped = true; body?.end(); }
      }
    });
    const onData = chunk => {
      if (stopped) return;
      header = Buffer.concat([header, chunk]);
      const newline = header.indexOf(10);
      if (newline > 1024 * 1024 || (newline < 0 && header.length > 1024 * 1024)) {
        fail(new Error('Invalid Bun worker response headers.'));
        return;
      }
      if (newline < 0) return;
      child.stdout.pause();
      child.stdout.removeListener('data', onData);
      try {
        const meta = JSON.parse(header.subarray(0, newline).toString('utf8'));
        if (!Number.isInteger(meta.status) || meta.status < 200 || meta.status > 599 || !Array.isArray(meta.headers)) throw new Error();
        const headers = new Headers(meta.headers);
        for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'trailer', 'upgrade']) headers.delete(key);
        const empty = init.method?.toUpperCase() === 'HEAD' || [204, 205, 304].includes(meta.status);
        const rest = header.subarray(newline + 1);
        header = null;
        if (!empty) {
          body = new PassThrough();
          // toWeb propagates cancel() to destroy(); destroy terminates the worker.
          body.on('close', () => { if (!stopped) { stopped = true; stop(); } });
          const webBody = Readable.toWeb(body, { strategy: { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength } });
          const response = new Response(webBody, { status: meta.status, statusText: meta.statusText, headers });
          receivedHeaders = true;
          if (rest.length) child.stdout.unshift(rest);
          child.stdout.pipe(body, { end: false });
          resolveResponse(response);
        } else {
          receivedHeaders = true;
          resolveResponse(new Response(null, { status: meta.status, statusText: meta.statusText, headers }));
          child.stdout.resume();
        }
      } catch { fail(new Error('Invalid Bun worker response headers.')); }
    };
    child.stdout.on('data', onData);
    if (signal?.aborted) onAbort();
    if (!stopped) child.stdin.end(payload);
  });
}
