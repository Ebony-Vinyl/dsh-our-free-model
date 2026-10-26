import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import vm from 'node:vm'
import { EventEmitter, once } from 'node:events'
import { Duplex, PassThrough, Writable } from 'node:stream'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { launchClientTerminal } from '../packages/standalone/client-terminal.mjs'

const exec = promisify(execFile)
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "ofm \u6d4b\u8bd5 terminal's $100 % &-"))
const profileDir = path.join(scratch, 'managed profile')
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const encode = value => Buffer.from(value, 'utf16le').toString('base64')
const psQuote = value => `'${value.replaceAll("'", "''")}'`
const powershell = path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
let checks = 0
const check = async (name, run) => { await run(); checks++; console.log(`ok ${name}`) }
const plan = extra => ({
  executable: process.execPath, args: [], cwd: scratch,
  env: { ...process.env, OFM_TEST_SECRET: 'private-terminal-value-$%&"\'-not-an-argument' }, ...extra,
})
const handles = []
let unrelated

async function waitFor(predicate, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (await predicate()) return
    await pause(50)
  }
  throw new Error('Timed out waiting for disposable terminal fixture')
}

function fakeSupervisor({ ready = true } = {}) {
  const calls = []
  let child, currentDirectory
  const options = {
    platform: 'win32', profileDir,
    async exec(file, args, settings) {
      calls.push({ type: 'exec', file, args, settings })
      assert.equal(settings.windowsHide, true)
      assert.ok(!JSON.stringify(args).includes('private-terminal-value'))
      assert.match(Buffer.from(args.at(-1), 'base64').toString('utf16le'), /SetAccessRuleProtection\(\$true, \$false\)/)
      return { stdout: '', stderr: '' }
    },
    spawn(file, args, settings) {
      calls.push({ type: 'spawn', file, args, settings })
      const parent = path.join(profileDir, '.client-terminals')
      currentDirectory = path.join(parent, fs.readdirSync(parent).at(-1))
      const source = fs.readFileSync(path.join(currentDirectory, 'supervisor.ps1'), 'utf8')
      assert.match(source, /Start-Process .* -WindowStyle Normal /)
      assert.match(source, /Assign\(\$ofmJob, \$ofmHandle\)/)
      assert.match(source, /TerminateJobObject/)
      assert.ok(!source.includes('private-terminal-value'))
      assert.ok(!JSON.stringify(args).includes('private-terminal-value'))
      assert.equal(settings.windowsHide, true)
      assert.equal(settings.shell, false)
      child = new EventEmitter()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      let buffer = '', closed = false
      const finish = () => {
        if (closed) return
        closed = true
        queueMicrotask(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0) })
      }
      child.stdin = new Writable({
        write(chunk, encoding, callback) {
          buffer += chunk.toString()
          let index
          while ((index = buffer.indexOf('\n')) >= 0) {
            const message = JSON.parse(buffer.slice(0, index))
            buffer = buffer.slice(index + 1)
            if (message.action === 'status') child.stdout.write(JSON.stringify({ event: 'response', id: message.id, running: true }) + '\n')
            if (message.action === 'stop') finish()
          }
          callback()
        },
        final(callback) { finish(); callback() },
      })
      if (ready) queueMicrotask(() => {
        fs.unlinkSync(path.join(currentDirectory, 'plan.json'))
        child.stdout.write(JSON.stringify({
          event: 'ready', pid: 43210, childPid: 43211, birth: '1234567890', startedAt: '2026-10-23T12:00:00Z',
          tty: { input: true, output: true, error: true },
        }) + '\n')
      })
      return child
    },
  }
  return { calls, options, directory: () => currentDirectory }
}

async function verifyPosix(platform, groupLeader = true) {
  const originalConnect = net.createConnection
  const directory = path.join(scratch, `posix-${platform}-${groupLeader}`)
  const observations = { killed: [], spawned: 0 }
  let source, accept, serverSocket, wire
  const prepare = () => {
    const parent = path.join(directory, '.client-terminals')
    const run = path.join(parent, fs.readdirSync(parent)[0])
    source = fs.readFileSync(path.join(run, 'runner.mjs'), 'utf8')
    const socketPath = JSON.parse(/^const socketPath = (.+)$/m.exec(source)[1])
    fs.writeFileSync(socketPath, '')
    const runnerProcess = {
      pid: 52110, stdin: { isTTY: true }, stdout: { isTTY: true }, stderr: { isTTY: true },
      on() {}, exit(code) { observations.exitCode = code },
      kill(pid, signal) {
        observations.killed.push([pid, signal])
        if (signal === 'SIGKILL') wire?.destroy()
      },
    }
    const context = {
      fs,
      net: { createServer(callback) { accept = callback; return { listen(file, callback) { callback() } } } },
      execFileSync(file, args) {
        assert.equal(file, '/bin/ps')
        assert.ok(args.includes('52110'))
        return `${groupLeader ? 52110 : 99999} pts/7 Fri Oct 23 12:00:00 2026`
      },
      spawn(executable, args, options) {
        observations.spawned++
        assert.equal(executable, process.execPath)
        assert.equal(options.stdio, 'inherit')
        assert.equal(options.shell, false)
        assert.equal(options.env.OFM_TEST_SECRET, plan().env.OFM_TEST_SECRET)
        const child = new EventEmitter()
        child.pid = 52111
        queueMicrotask(() => child.emit('spawn'))
        return child
      },
      process: runnerProcess,
      setTimeout(callback, ms) { if (ms === 700) queueMicrotask(callback); return {} },
      clearTimeout() {},
    }
    vm.runInNewContext(source.replace(/^import .*\n/gm, ''), context)
    if (!groupLeader) assert.equal(runnerProcess.exitCode, 1)
  }
  net.createConnection = socketPath => {
    assert.equal(observations.spawned, 0, 'POSIX clients must not start before private-channel authentication')
    serverSocket = new EventEmitter()
    serverSocket.setEncoding = () => {}
    serverSocket.write = message => wire.push(message)
    serverSocket.destroy = () => wire.destroy()
    wire = new Duplex({
      read() {},
      write(chunk, encoding, callback) { serverSocket.emit('data', chunk.toString()); callback() },
      final(callback) { serverSocket.emit('close'); callback() },
    })
    accept(serverSocket)
    queueMicrotask(() => wire.emit('connect'))
    return wire
  }
  try {
    const options = {
      platform, profileDir: directory, terminal: process.execPath, nodePath: process.execPath,
      async exec(file, args) {
        assert.equal(file, '/usr/bin/osascript')
        assert.match(args[1], /do script \(item 1 of argv\)/)
        assert.ok(args[2].startsWith('exec '))
        assert.ok(args[2].includes("'\\''"))
        assert.ok(!JSON.stringify(args).includes(plan().env.OFM_TEST_SECRET))
        prepare()
        return { stdout: '' }
      },
      spawn(file, args, options) {
        assert.equal(file, process.execPath)
        assert.equal(options.shell, false)
        assert.equal(args[0], '-e')
        prepare()
        const child = new EventEmitter()
        child.exitCode = null
        return child
      },
    }
    if (!groupLeader) {
      await assert.rejects(launchClientTerminal(plan(), options))
      assert.equal(observations.spawned, 0)
      assert.deepEqual(observations.killed, [])
    } else {
      const handle = await launchClientTerminal(plan(), options)
      assert.equal(handle.pid, 52110)
      assert.equal(handle.childPid, 52111)
      assert.equal(handle.processGroup, 52110)
      assert.equal(handle.tty, 'pts/7')
      assert.equal(await handle.isRunning(), true)
      await handle.stop()
      assert.equal(await handle.isRunning(), false)
      assert.equal(observations.spawned, 1)
      assert.deepEqual(observations.killed, [[-52110, 'SIGTERM'], [-52110, 'SIGKILL']])
    }
  } finally {
    net.createConnection = originalConnect
    wire?.destroy()
  }
}

// This test process attaches only to the newly returned console and writes harmless fixture input.
async function sendConsoleInput(pid, value) {
  const source = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class OfmInputFixture {
  [StructLayout(LayoutKind.Explicit, CharSet=CharSet.Unicode, Size=20)]
  struct Input {
    [FieldOffset(0)] public ushort Type;
    [FieldOffset(4)] public int Down;
    [FieldOffset(8)] public ushort Repeat;
    [FieldOffset(10)] public ushort Key;
    [FieldOffset(14)] public char Char;
  }
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern bool WriteConsoleInput(SafeFileHandle input, Input[] events, uint length, out uint written);
  public static void Send(uint pid, string value) {
    FreeConsole();
    if (!AttachConsole(pid)) throw new Win32Exception();
    using (SafeFileHandle handle = CreateFile("CONIN$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception();
      Input[] events = new Input[value.Length * 2];
      for (int i = 0; i < value.Length; i++) {
        Input e = new Input();
        e.Type = 1; e.Down = 1; e.Repeat = 1; e.Char = value[i];
        e.Key = value[i] == '\r' ? (ushort)13 : (ushort)0;
        events[i*2] = e; e.Down = 0; events[i*2+1] = e;
      }
      uint written;
      if (!WriteConsoleInput(handle, events, (uint)events.Length, out written) || written != events.Length) throw new Win32Exception();
    }
    FreeConsole();
  }
}
`
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${source}\n'@\n[OfmInputFixture]::Send(${pid}, ${psQuote(value)})`
  await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)], { windowsHide: true, timeout: 15000 })
}

try {
  await check('invalid plans, relative storage and cancellation are rejected before launching', async () => {
    for (const patch of [
      { executable: 'relative.exe' }, { cwd: 'relative' }, { args: ['bad\0argument'] },
      { args: 'not-an-array' }, { env: { 'BAD=NAME': 'value' } }, { env: { VALUE: 7 } },
      { env: { LONG: 'x'.repeat(1024 * 1024) } },
    ]) await assert.rejects(launchClientTerminal(plan(patch), { profileDir }))
    await assert.rejects(launchClientTerminal(plan(), { profileDir: 'relative' }))
    await assert.rejects(launchClientTerminal(plan(), { profileDir, signal: AbortSignal.abort() }), { code: 'ABORTED' })
    assert.equal(fs.existsSync(profileDir), false)
  })
  await check('macOS Terminal uses literal exec and the authenticated actual process-group owner', () => verifyPosix('darwin'))
  await check('Linux terminal tracks the actual wrapper rather than a detached emulator PID', () => verifyPosix('linux'))
  await check('POSIX refuses to start or stop a client in an unrelated process group', () => verifyPosix('darwin', false))
  if (process.platform === 'win32') {
    await check('Windows shims fail explicitly instead of invoking cmd expansion', async () => {
      const shim = path.join(scratch, 'npm client.cmd')
      fs.writeFileSync(shim, '@echo never run\r\n')
      await assert.rejects(launchClientTerminal(plan({ executable: shim }), { profileDir }), { code: 'UNSUPPORTED_SHIM' })
      assert.equal(fs.existsSync(profileDir), false)
    })
    await check('hidden supervisor uses a visible Job-owned console and exposes lifecycle identity', async () => {
      const fake = fakeSupervisor()
      const handle = await launchClientTerminal(plan({ args: ['spaces here', '"quotes"', '$dollar', '%PATH%', '&|^<>'] }), fake.options)
      assert.equal(handle.pid, 43210)
      assert.equal(handle.birth, '1234567890')
      assert.equal(await handle.isRunning(), true)
      assert.equal(fs.existsSync(path.join(fake.directory(), 'plan.json')), false)
      assert.deepEqual(await handle.stop(), { ok: true })
      assert.equal(await handle.isRunning(), false)
      assert.deepEqual(await handle.stop(), { ok: true })
      assert.equal(fs.existsSync(fake.directory()), false)
      assert.equal(fake.calls.length, 2)
    })
    await check('startup cancellation drains supervisor and removes the private plan', async () => {
      const controller = new AbortController()
      const fake = fakeSupervisor({ ready: false })
      const pending = launchClientTerminal(plan(), { ...fake.options, signal: controller.signal })
      await waitFor(() => Boolean(fake.directory()))
      controller.abort()
      await assert.rejects(pending, { code: 'ABORTED' })
      assert.equal(fs.existsSync(fake.directory()), false)
    })
    await check('active AbortSignal stops only the retained supervisor ownership', async () => {
      const controller = new AbortController()
      const fake = fakeSupervisor()
      const handle = await launchClientTerminal(plan(), { ...fake.options, signal: controller.signal })
      controller.abort()
      await waitFor(async () => !(await handle.isRunning()))
      await handle.dispose()
      assert.equal(fs.existsSync(fake.directory()), false)
    })
    await check('private storage rejects directory junctions before writing secrets', async () => {
      const outside = path.join(scratch, 'outside')
      fs.mkdirSync(outside)
      const linked = path.join(scratch, 'linked-profile')
      fs.symlinkSync(outside, linked, 'junction')
      try {
        await assert.rejects(launchClientTerminal(plan(), { profileDir: linked }), /symlinks or junctions/)
        assert.deepEqual(fs.readdirSync(outside), [])
      } finally { fs.unlinkSync(linked) }
    })
    if (process.argv.includes('--native')) {
    await check('actual Windows console has usable input/output, exact argv/env, ACLs and owned-tree stop', async () => {
      const fixture = path.join(scratch, "literal client $ & % ' fixture.cjs")
      const resultFile = path.join(scratch, 'console-result.json')
      fs.writeFileSync(fixture, `
const fs = require('node:fs')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const hash = value => crypto.createHash('sha256').update(value).digest('hex')
const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit', shell: false })
const result = {
  inputTTY: !!process.stdin.isTTY, outputTTY: !!process.stdout.isTTY, errorTTY: !!process.stderr.isTTY,
  argvHash: hash(JSON.stringify(process.argv.slice(2))), envHash: hash(process.env.OFM_TEST_SECRET),
  cwd: process.cwd(), childPid: process.pid, descendantPid: descendant.pid,
}
fs.writeFileSync(process.env.OFM_RESULT_PATH, JSON.stringify(result), { mode: 0o600 })
process.stdout.write('Managed terminal input/output fixture.\\n')
const input = Buffer.alloc(1024)
let text = ''
while (!/[\\r\\n]/.test(text)) {
  const length = fs.readSync(0, input, 0, input.length, null)
  if (!length) break
  text += input.subarray(0, length).toString()
  if (text.length > 4096) throw new Error('Console fixture input exceeded its bound')
}
result.inputText = text.trim()
result.inputHash = hash(result.inputText)
fs.writeFileSync(process.env.OFM_RESULT_PATH, JSON.stringify(result), { mode: 0o600 })
setInterval(() => {}, 1000)
`, { mode: 0o600 })
      const args = ['', 'two words', 'single\'quote', 'double"quote', '$HOME $(exit 99)', '%PATH% !VAR!',
        '& | < > ^ ( ) ; `', 'trailing\\', '\\\\"embedded', 'line\nbreak', '\u6d4b\u8bd5']
      const configured = plan({
        args: [fixture, ...args],
        env: { ...process.env, OFM_TEST_SECRET: 'secret-$%&"\'-fixture', OFM_RESULT_PATH: resultFile },
      })
      unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore', shell: false })
      await once(unrelated, 'spawn')
      const unrelatedPid = unrelated.pid
      const handle = await launchClientTerminal(configured, { profileDir, timeoutMs: 30000 })
      handles.push(handle)
      assert.ok(handle.pid > 0 && handle.pid !== handle.childPid)
      assert.match(handle.birth, /^\d+$/)
      assert.deepEqual(handle.tty, { input: true, output: true, error: true })
      await waitFor(() => fs.existsSync(resultFile))
      let result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      assert.equal(result.inputTTY, true)
      assert.equal(result.outputTTY, true)
      assert.equal(result.errorTTY, true)
      assert.equal(result.argvHash, hash(JSON.stringify(args)))
      assert.equal(result.envHash, hash(configured.env.OFM_TEST_SECRET))
      assert.equal(result.cwd, scratch)
      assert.equal(result.childPid, handle.childPid)
      assert.equal(await handle.isRunning(), true)
      const directory = path.join(profileDir, '.client-terminals', fs.readdirSync(path.join(profileDir, '.client-terminals'))[0])
      assert.equal(fs.existsSync(path.join(directory, 'plan.json')), false)
      const aclScript = `$ErrorActionPreference='Stop'\n$acl=Get-Acl -LiteralPath ${psQuote(directory)}\n$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n@{protected=$acl.AreAccessRulesProtected;onlyOwner=(@($acl.Access | Where-Object {$_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -ne $sid}).Count -eq 0)} | ConvertTo-Json -Compress`
      const acl = JSON.parse((await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(aclScript)], { windowsHide: true, timeout: 10000 })).stdout)
      assert.deepEqual(acl, { protected: true, onlyOwner: true })
      const line = 'literal terminal input $ % & test'
      await sendConsoleInput(handle.pid, line + '\r')
      await waitFor(() => Boolean(JSON.parse(fs.readFileSync(resultFile, 'utf8')).inputHash))
      result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      assert.equal(result.inputHash, hash(line), `Console fixture read ${JSON.stringify(result.inputText)}`)
      await handle.stop()
      assert.equal(await handle.isRunning(), false)
      for (const pid of [handle.pid, result.childPid, result.descendantPid]) {
        assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
      }
      assert.doesNotThrow(() => process.kill(unrelatedPid, 0))
      assert.equal(fs.existsSync(directory), false)
      assert.deepEqual(await handle.stop(), { ok: true })
    })
    await check('actual Windows cancellation terminates the owned console and consumes its private plan', async () => {
      const controller = new AbortController()
      const handle = await launchClientTerminal(plan({ args: ['-e', 'setInterval(() => {}, 1000)'] }), {
        profileDir, signal: controller.signal, timeoutMs: 30000,
      })
      handles.push(handle)
      assert.equal(await handle.isRunning(), true)
      controller.abort()
      await waitFor(async () => !(await handle.isRunning()))
      await handle.dispose()
      assert.throws(() => process.kill(handle.pid, 0), { code: 'ESRCH' })
      assert.throws(() => process.kill(handle.childPid, 0), { code: 'ESRCH' })
    })
    await check('actual Windows cancellation during private setup returns ABORTED without retaining plans', async () => {
      const controller = new AbortController()
      const pending = launchClientTerminal(plan(), { profileDir, signal: controller.signal, timeoutMs: 30000 })
      const timer = setTimeout(() => controller.abort(), 100)
      try { await assert.rejects(pending, { code: 'ABORTED' }) }
      finally { clearTimeout(timer) }
      assert.deepEqual(fs.readdirSync(path.join(profileDir, '.client-terminals')), [])
    })
    await check('actual Windows natural exit cleans descendants and reports no running client', async () => {
      const handle = await launchClientTerminal(plan({ args: ['-e', 'setTimeout(() => process.exit(0), 1200)'] }), { profileDir, timeoutMs: 30000 })
      handles.push(handle)
      // No status traffic: the supervisor must observe exit even while its control reader is idle.
      await waitFor(() => fs.readdirSync(path.join(profileDir, '.client-terminals')).length === 0)
      assert.equal(await handle.isRunning(), false)
      await handle.dispose()
      assert.throws(() => process.kill(handle.pid, 0), { code: 'ESRCH' })
      assert.throws(() => process.kill(handle.childPid, 0), { code: 'ESRCH' })
      assert.deepEqual(fs.readdirSync(path.join(profileDir, '.client-terminals')), [])
    })
    } else console.log('Native console acceptance is opt-in: run client-terminal-test.mjs --native on an idle desktop')
  } else {
    console.log('Windows console acceptance skipped: this host is not Windows')
  }
} finally {
  for (const handle of handles) await handle.dispose().catch(() => {})
  if (unrelated?.exitCode === null) {
    const exited = once(unrelated, 'exit')
    unrelated.kill()
    await exited
  }
  assert.ok(fs.realpathSync(scratch).startsWith(fs.realpathSync(os.tmpdir()) + path.sep))
  fs.rmSync(scratch, { recursive: true, force: true })
}
console.log(`client-terminal: ${checks} checks passed`)
