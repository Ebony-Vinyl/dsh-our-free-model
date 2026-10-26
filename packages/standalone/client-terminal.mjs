import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import net from 'node:net'
import os from 'node:os'
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { promisify } from 'node:util'

const runFile = promisify(execFile)
const encode = value => Buffer.from(value, 'utf16le').toString('base64')
const psQuote = value => `'${value.replaceAll("'", "''")}'`
const shQuote = value => `'${value.replaceAll("'", "'\\''")}'`
const fail = (message, code = 'TERMINAL_ERROR') => Object.assign(new Error(message), { code, statusCode: 409 })
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const FILES = ['plan.json', 'console.ps1', 'supervisor.ps1', 'runner.mjs', 'go', 'ready.json', 'ready.tmp', 'error.json', 'control.sock']
const MAX_PLAN = 1024 * 1024

function safeDirectory(directory, create = false) {
  const absolute = path.resolve(directory)
  const root = path.parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let info
    try { info = fs.lstatSync(current) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      if (!create) return false
      fs.mkdirSync(current, { mode: 0o700 })
      info = fs.lstatSync(current)
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Terminal storage must not contain symlinks or junctions')
  }
  return true
}

function privateFile(file, contents) {
  safeDirectory(path.dirname(file))
  fs.writeFileSync(file, contents, { mode: 0o600, flag: 'wx' })
}

function validate(plan, platform, profileDir) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) throw fail('Invalid terminal plan')
  for (const field of ['executable', 'cwd']) {
    if (typeof plan[field] !== 'string' || !path.isAbsolute(plan[field]) || /[\0\r\n]/.test(plan[field])) throw fail(`Terminal ${field} must be an absolute path`)
  }
  if (!fs.statSync(plan.executable).isFile() || !fs.statSync(plan.cwd).isDirectory()) throw fail('Terminal executable or working directory is unavailable')
  if (platform === 'win32' && !/\.exe$/i.test(plan.executable)) {
    throw fail('Interactive Windows launch requires an .exe; resolve npm shims to node.exe and a CLI script', 'UNSUPPORTED_SHIM')
  }
  const args = plan.args ?? []
  if (!Array.isArray(args) || args.length > 256 || args.some(arg => typeof arg !== 'string' || arg.length > 32768 || arg.includes('\0'))) throw fail('Invalid terminal arguments')
  if (!plan.env || typeof plan.env !== 'object' || Array.isArray(plan.env)) throw fail('Terminal environment is required')
  for (const [key, value] of Object.entries(plan.env)) {
    if (!key || /[=\0\r\n]/.test(key) || typeof value !== 'string' || value.includes('\0')) throw fail('Invalid terminal environment')
  }
  if (platform === 'win32') {
    const keys = Object.keys(plan.env).map(key => key.toUpperCase())
    if (new Set(keys).size !== keys.length) throw fail('Windows environment names must be unique without case distinctions')
  }
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir) || /[\0\r\n]/.test(profileDir)) throw fail('An owned absolute profileDir is required')
  const value = JSON.stringify({ executable: plan.executable, cwd: plan.cwd, args, env: plan.env })
  if (Buffer.byteLength(value) > MAX_PLAN) throw fail('Terminal plan is too large')
  return value
}

const WINDOWS_JOB = String.raw`
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
public static class OfmTerminalJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr Min, Max;
    public uint Active;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct Counters {
    public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct Extended {
    public Basic Basic;
    public Counters IO;
    public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int type, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool QueryInformationJobObject(IntPtr job, int type, IntPtr data, uint size, IntPtr length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    Extended limits = new Extended();
    limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE; no breakaway.
    int size = Marshal.SizeOf(typeof(Extended));
    IntPtr buffer = Marshal.AllocHGlobal(size);
    try {
      Marshal.StructureToPtr(limits, buffer, false);
      if (!SetInformationJobObject(job, 9, buffer, (uint)size)) throw new Win32Exception();
      return job;
    } catch { CloseHandle(job); throw; }
    finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void Assign(IntPtr job, IntPtr process) {
    if (!AssignProcessToJobObject(job, process)) throw new Win32Exception();
  }
  public static void Stop(IntPtr job) {
    if (!TerminateJobObject(job, 130)) throw new Win32Exception();
  }
  public static uint Active(IntPtr job) {
    IntPtr buffer = Marshal.AllocHGlobal(48);
    try {
      if (!QueryInformationJobObject(job, 1, buffer, 48, IntPtr.Zero)) throw new Win32Exception();
      return (uint)Marshal.ReadInt32(buffer, 40);
    } finally { Marshal.FreeHGlobal(buffer); }
  }
  public static void Close(IntPtr job) { CloseHandle(job); }
  // Console.In's synchronized reader can implement ReadLineAsync synchronously on .NET Framework.
  public static Task<string> ReadLine() {
    return Task.Factory.StartNew(() => Console.In.ReadLine(), CancellationToken.None,
      TaskCreationOptions.LongRunning, TaskScheduler.Default);
  }
}
`

const WINDOWS_ARGV = String.raw`
using System;
using System.Text;
public static class OfmTerminalArgv {
  static string Quote(string value) {
    StringBuilder output = new StringBuilder("\"");
    int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { output.Append('\\', slashes * 2 + 1); output.Append(c); slashes = 0; continue; }
      output.Append('\\', slashes); slashes = 0; output.Append(c);
    }
    output.Append('\\', slashes * 2); output.Append('"');
    return output.ToString();
  }
  public static string Join(string[] args) {
    string[] quoted = new string[args.Length];
    for (int i = 0; i < args.Length; i++) quoted[i] = Quote(args[i]);
    return String.Join(" ", quoted);
  }
}
`

function consoleScript(directory, timeoutMs) {
  return `
$ErrorActionPreference = 'Stop'
$ofmDirectory = ${psQuote(directory)}
$ofmClient = $null
try {
  $ofmGateDeadline = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
  while (-not [IO.File]::Exists([IO.Path]::Combine($ofmDirectory, 'go'))) {
    if ([DateTime]::UtcNow -gt $ofmGateDeadline) { throw 'SUPERVISOR_UNAVAILABLE' }
    Start-Sleep -Milliseconds 30
  }
  if ([Console]::IsInputRedirected -or [Console]::IsOutputRedirected -or [Console]::IsErrorRedirected) { throw 'NO_CONSOLE' }
  Add-Type -TypeDefinition @'
${WINDOWS_ARGV}
'@
  $ofmPlanPath = [IO.Path]::Combine($ofmDirectory, 'plan.json')
  $ofmPlan = [IO.File]::ReadAllText($ofmPlanPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
  [IO.File]::Delete($ofmPlanPath)
  $ofmStart = New-Object Diagnostics.ProcessStartInfo
  $ofmStart.FileName = $ofmPlan.executable
  $ofmStart.Arguments = [OfmTerminalArgv]::Join([string[]]@($ofmPlan.args))
  $ofmStart.WorkingDirectory = $ofmPlan.cwd
  $ofmStart.UseShellExecute = $false
  $ofmStart.CreateNoWindow = $false
  $ofmStart.RedirectStandardInput = $false
  $ofmStart.RedirectStandardOutput = $false
  $ofmStart.RedirectStandardError = $false
  $ofmStart.EnvironmentVariables.Clear()
  foreach ($ofmEntry in $ofmPlan.env.PSObject.Properties) { $ofmStart.EnvironmentVariables[$ofmEntry.Name] = [string]$ofmEntry.Value }
  $ofmPlan = $null
  $ofmClient = New-Object Diagnostics.Process
  $ofmClient.StartInfo = $ofmStart
  if (-not $ofmClient.Start()) { throw 'CLIENT_START_FAILED' }
  $ofmReady = @{
    pid = $PID
    birth = ([Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().ToFileTimeUtc()).ToString()
    childPid = $ofmClient.Id
    tty = @{ input = $true; output = $true; error = $true }
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText([IO.Path]::Combine($ofmDirectory, 'ready.tmp'), $ofmReady, (New-Object Text.UTF8Encoding($false)))
  [IO.File]::Move([IO.Path]::Combine($ofmDirectory, 'ready.tmp'), [IO.Path]::Combine($ofmDirectory, 'ready.json'))
  $ofmClient.WaitForExit()
  exit $ofmClient.ExitCode
} catch {
  [IO.File]::WriteAllText([IO.Path]::Combine($ofmDirectory, 'error.json'), '{"error":"CONSOLE_START_FAILED"}')
  Write-Host 'The managed client could not start. Check its executable and terminal settings.'
  exit 1
} finally { if ($null -ne $ofmClient) { $ofmClient.Dispose() } }
`
}

function supervisorScript(directory, powershell, timeoutMs) {
  const bootstrap = encode(`& ${psQuote(path.join(directory, 'console.ps1'))}`)
  return `
$ErrorActionPreference = 'Stop'
$ofmDirectory = ${psQuote(directory)}
$ofmJob = [IntPtr]::Zero
$ofmConsole = $null
$ofmAssigned = $false
function Send-Ofm($ofmValue) { [Console]::Out.WriteLine(($ofmValue | ConvertTo-Json -Compress -Depth 5)); [Console]::Out.Flush() }
try {
  Add-Type -TypeDefinition @'
${WINDOWS_JOB}
'@
  $ofmInput = [OfmTerminalJob]::ReadLine()
  if ($ofmInput.IsCompleted) { throw 'LAUNCH_CANCELLED' }
  $ofmJob = [OfmTerminalJob]::Create()
  $ofmConsole = Start-Process -FilePath ${psQuote(powershell)} -WindowStyle Normal -ArgumentList '-NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${bootstrap}' -PassThru -ErrorAction Stop
  # Retain the process handle before it can exit or its numeric PID can be reused.
  $ofmHandle = $ofmConsole.Handle
  $ofmBirth = $ofmConsole.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
  [OfmTerminalJob]::Assign($ofmJob, $ofmHandle)
  $ofmAssigned = $true
  if ($ofmInput.IsCompleted) { throw 'LAUNCH_CANCELLED' }
  [IO.File]::WriteAllText([IO.Path]::Combine($ofmDirectory, 'go'), '')
  $ofmUntil = [DateTime]::UtcNow.AddMilliseconds(${timeoutMs})
  while (-not [IO.File]::Exists([IO.Path]::Combine($ofmDirectory, 'ready.json'))) {
    if ($ofmInput.IsCompleted -or $ofmConsole.HasExited -or [IO.File]::Exists([IO.Path]::Combine($ofmDirectory, 'error.json')) -or [DateTime]::UtcNow -gt $ofmUntil) { throw 'CONSOLE_NOT_READY' }
    Start-Sleep -Milliseconds 30
  }
  $ofmReady = [IO.File]::ReadAllText([IO.Path]::Combine($ofmDirectory, 'ready.json')) | ConvertFrom-Json
  if ($ofmReady.pid -ne $ofmConsole.Id -or $ofmReady.birth -ne $ofmBirth) { throw 'CONSOLE_IDENTITY_MISMATCH' }
  Send-Ofm @{ event = 'ready'; pid = $ofmConsole.Id; birth = $ofmBirth; childPid = $ofmReady.childPid; startedAt = $ofmConsole.StartTime.ToUniversalTime().ToString('o'); tty = $ofmReady.tty }
  while (-not $ofmConsole.HasExited) {
    if ($ofmInput.IsCompleted) {
      $ofmLine = $ofmInput.Result
      if ($null -eq $ofmLine) { break }
      $ofmRequest = $ofmLine | ConvertFrom-Json
      if ($ofmRequest.action -eq 'stop') { [OfmTerminalJob]::Stop($ofmJob); break }
      if ($ofmRequest.action -eq 'status') { Send-Ofm @{ event = 'response'; id = $ofmRequest.id; running = (-not $ofmConsole.HasExited) } }
      $ofmInput = [OfmTerminalJob]::ReadLine()
    }
    Start-Sleep -Milliseconds 30
  }
} catch { Send-Ofm @{ event = 'failure'; error = 'TERMINAL_START_FAILED' } }
finally {
  if ($ofmJob -ne [IntPtr]::Zero) {
    try {
      [OfmTerminalJob]::Stop($ofmJob)
      $ofmDrain = [DateTime]::UtcNow.AddSeconds(5)
      while ([OfmTerminalJob]::Active($ofmJob) -gt 0 -and [DateTime]::UtcNow -lt $ofmDrain) { Start-Sleep -Milliseconds 20 }
    } finally { [OfmTerminalJob]::Close($ofmJob) }
  }
  if ($null -ne $ofmConsole) {
    if (-not $ofmAssigned -and -not $ofmConsole.HasExited) { $ofmConsole.Kill() }
    $ofmConsole.Dispose()
  }
}
`
}

function posixRunner(directory, socketPath, token, timeoutMs) {
  return `
import fs from 'node:fs'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
const directory = ${JSON.stringify(directory)}
const socketPath = ${JSON.stringify(socketPath)}
const token = ${JSON.stringify(token)}
let client, connection, stopping = false, ownedGroup = false
const send = value => connection?.write(JSON.stringify(value) + '\\n')
function stop() {
  if (stopping) return
  if (!ownedGroup) { process.exit(1); return }
  stopping = true
  // This runner replaces the fresh terminal shell and must lead its own group.
  process.kill(-process.pid, 'SIGTERM')
  setTimeout(() => process.kill(-process.pid, 'SIGKILL'), 700)
}
process.on('SIGTERM', () => { if (!stopping) stop() })
try {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stderr.isTTY) throw new Error()
  const identity = execFileSync('/bin/ps', ['-p', String(process.pid), '-o', 'pgid=', '-o', 'tty=', '-o', 'lstart='], { encoding: 'utf8' }).trim()
  const match = /^(\\d+)\\s+(\\S+)\\s+(.+)$/.exec(identity)
  if (!match || Number(match[1]) !== process.pid || /^\\?+$/.test(match[2])) throw new Error()
  ownedGroup = true
  const ready = { event: 'ready', pid: process.pid, birth: match[3], tty: match[2], startedAt: new Date().toISOString(), processGroup: process.pid }
  const startup = setTimeout(stop, ${timeoutMs})
  function start() {
    if (client || stopping) return
    try {
      const plan = JSON.parse(fs.readFileSync(directory + '/plan.json', 'utf8'))
      fs.unlinkSync(directory + '/plan.json')
      client = spawn(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env, stdio: 'inherit', shell: false })
      client.once('spawn', () => {
        clearTimeout(startup)
        ready.childPid = client.pid
        send(ready)
      })
      client.once('error', () => stop())
      client.once('exit', () => stop())
    } catch { stop() }
  }
  const server = net.createServer(socket => {
    if (connection) { socket.destroy(); return }
    let buffer = '', authenticated = false
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', data => {
      buffer += data
      if (buffer.length > 4096) { socket.destroy(); return }
      let index
      while ((index = buffer.indexOf('\\n')) >= 0) {
        let message
        try { message = JSON.parse(buffer.slice(0, index)) } catch { socket.destroy(); return }
        buffer = buffer.slice(index + 1)
        if (!authenticated) {
          if (message.token !== token) { socket.destroy(); return }
          authenticated = true; connection = socket; continue
        }
        if (message.action === 'start') start()
        else if (message.action === 'status') send({ event: 'response', id: message.id, running: !stopping })
        else if (message.action === 'stop') stop()
      }
    })
    socket.on('close', () => { if (authenticated) stop() })
  })
  server.listen(socketPath, () => { fs.chmodSync(socketPath, 0o600) })
} catch {
  fs.writeFileSync(directory + '/error.json', '{"error":"TERMINAL_START_FAILED"}', { mode: 0o600 })
  process.exitCode = 1
}
`
}

function transport(child, { signal, timeoutMs, cleanup, readyInput, startInput } = {}) {
  let readyResolve, readyReject, closeResolve
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closed = new Promise(resolve => { closeResolve = resolve })
  const pending = new Map()
  let buffer = '', identity, ended = false, sequence = 0, stopPromise
  const timer = setTimeout(() => {
    readyReject(fail('The interactive console did not become ready', 'TERMINAL_TIMEOUT'))
    child.stdin.end(JSON.stringify({ action: 'stop' }) + '\n')
  }, timeoutMs)
  const abort = () => {
    readyReject(fail('Terminal launch was cancelled', 'ABORTED'))
    child.stdin.end(JSON.stringify({ action: 'stop' }) + '\n')
  }
  signal?.addEventListener('abort', abort, { once: true })
  const finish = () => {
    if (ended) return
    ended = true
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    readyReject(fail('The terminal supervisor exited before the console was ready'))
    for (const resolve of pending.values()) resolve(false)
    pending.clear()
    closeResolve()
  }
  child.once('close', finish)
  child.once('error', finish)
  child.stdin.on('error', () => {})
  child.stderr?.resume()
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    if (buffer.length > 16384) { child.stdin.end(); return }
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      let message
      try { message = JSON.parse(buffer.slice(0, end).replace(/^\uFEFF/, '')) } catch { child.stdin.end(); return }
      buffer = buffer.slice(end + 1)
      if (message.event === 'ready') {
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0 || typeof message.birth !== 'string' || !message.birth) {
          child.stdin.end(); continue
        }
        identity = message
        clearTimeout(timer)
        readyResolve(message)
      } else if (message.event === 'response') {
        pending.get(message.id)?.(message.running === true)
        pending.delete(message.id)
      } else if (message.event === 'failure') {
        readyReject(fail('The interactive console could not start'))
        child.stdin.end()
      }
    }
  })
  if (readyInput) child.stdin.write(readyInput)
  if (signal?.aborted) abort()
  else if (startInput) child.stdin.write(startInput)
  async function stop() {
    if (stopPromise) return stopPromise
    stopPromise = (async () => {
      if (!ended) child.stdin.end(JSON.stringify({ action: 'stop' }) + '\n')
      let deadline
      try {
        await Promise.race([closed, new Promise((_, reject) => {
          deadline = setTimeout(() => reject(fail('Terminal shutdown did not complete', 'STOP_TIMEOUT')), 10000)
        })])
      } finally { clearTimeout(deadline) }
      await cleanup()
      return { ok: true }
    })()
    return stopPromise
  }
  return {
    ready, closed, stop,
    async isRunning() {
      if (ended || stopPromise || !identity) return false
      const id = ++sequence
      return new Promise((resolve, reject) => {
        const limit = setTimeout(() => { pending.delete(id); reject(fail('The terminal supervisor did not answer', 'STATUS_TIMEOUT')) }, 3000)
        pending.set(id, value => { clearTimeout(limit); resolve(value) })
        child.stdin.write(JSON.stringify({ action: 'status', id }) + '\n')
      })
    },
  }
}

async function posixTerminal({ platform, directory, socketPath, exec, spawn, env, nodePath, terminal, signal, timeoutMs }) {
  const token = crypto.randomBytes(32).toString('hex')
  privateFile(path.join(directory, 'runner.mjs'), posixRunner(directory, socketPath, token, timeoutMs))
  const runner = path.join(directory, 'runner.mjs')
  let launcher
  if (signal?.aborted) throw fail('Terminal launch was cancelled', 'ABORTED')
  if (platform === 'darwin') {
    const script = 'on run argv\n tell application "Terminal"\n do script (item 1 of argv)\n activate\n end tell\nend run'
    await exec('/usr/bin/osascript', ['-e', script, `exec ${shQuote(nodePath)} ${shQuote(runner)}`], { timeout: timeoutMs, env })
  } else {
    const candidates = terminal ? [terminal] : String(env.PATH ?? '').split(path.delimiter)
      .flatMap(folder => ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm'].map(name => path.join(folder, name)))
    const executable = candidates.find(file => {
      try { return path.isAbsolute(file) && fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true) } catch { return false }
    })
    if (!executable) throw fail('No supported interactive terminal was found')
    const name = path.basename(executable)
    const flags = name === 'gnome-terminal' ? ['--wait', '--'] : name === 'konsole' ? ['--nofork', '-e'] : ['-e']
    launcher = spawn(executable, [...flags, nodePath, runner], { env, stdio: 'ignore', shell: false })
    launcher.on('error', () => {})
  }
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (fs.existsSync(path.join(directory, 'error.json'))) throw fail('The terminal does not provide an owned interactive process group')
    if (launcher?.exitCode !== null && launcher?.exitCode !== undefined && launcher.exitCode !== 0) throw fail('The terminal application could not start')
    if (fs.existsSync(socketPath)) {
      const socket = net.createConnection(socketPath)
      try {
        await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
        const channel = { stdin: socket, stdout: socket, once: (...args) => socket.once(...args) }
        return { channel, readyInput: JSON.stringify({ token }) + '\n', startInput: '{"action":"start"}\n' }
      } catch { socket.destroy() }
    }
    await pause(40)
  }
  throw fail('The interactive terminal did not become ready', 'TERMINAL_TIMEOUT')
}

/**
 * Open a real user-facing terminal, scoped to an owned profileDir.
 * Windows requires .exe (npm shims must be resolved by the controller).
 * stop()/dispose() await owned-tree shutdown; AbortSignal also stops a running terminal.
 * Windows holds a Job and process handle. POSIX uses a private socket to the actual group leader.
 */
export async function launchClientTerminal(plan, {
  platform = process.platform, env = process.env, exec = runFile, spawn = spawnProcess,
  profileDir = plan?.profileDir, nodePath = process.execPath, terminal, signal, timeoutMs = 20000,
} = {}) {
  if (!['win32', 'darwin', 'linux'].includes(platform)) throw fail('Unsupported terminal platform')
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 60000) throw fail('Invalid terminal startup timeout')
  if (signal?.aborted) throw fail('Terminal launch was cancelled', 'ABORTED')
  const contents = validate(plan, platform, profileDir)
  if (platform !== 'win32' && (typeof nodePath !== 'string' || !path.isAbsolute(nodePath) || /[\0\r\n]/.test(nodePath))) throw fail('An absolute Node runtime is required')
  safeDirectory(profileDir, true)
  const parent = path.join(profileDir, '.client-terminals')
  safeDirectory(parent, true)
  const directory = path.join(parent, crypto.randomUUID())
  fs.mkdirSync(directory, { mode: 0o700 })
  let socketDirectory
  let socketPath
  async function cleanup() {
    if (!safeDirectory(directory)) return
    for (const name of FILES) {
      try { fs.unlinkSync(path.join(directory, name)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    try { fs.rmdirSync(directory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
    if (socketDirectory && safeDirectory(socketDirectory)) {
      try { fs.unlinkSync(socketPath) } catch (error) { if (error.code !== 'ENOENT') throw error }
      try { fs.rmdirSync(socketDirectory) } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error }
    }
  }
  let control
  try {
    let launch
    if (platform === 'win32') {
      const powershell = path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const acl = `
$ErrorActionPreference = 'Stop'
$ofmAcl = New-Object Security.AccessControl.DirectorySecurity
$ofmSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$ofmAcl.SetOwner($ofmSid)
$ofmAcl.SetAccessRuleProtection($true, $false)
$ofmRule = New-Object Security.AccessControl.FileSystemAccessRule($ofmSid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$ofmAcl.AddAccessRule($ofmRule)
Set-Acl -LiteralPath ${psQuote(directory)} -AclObject $ofmAcl
`
      await exec(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(acl)], {
        env, windowsHide: true, timeout: timeoutMs, signal,
      })
      if (signal?.aborted) throw fail('Terminal launch was cancelled', 'ABORTED')
      safeDirectory(directory)
      privateFile(path.join(directory, 'plan.json'), contents)
      privateFile(path.join(directory, 'console.ps1'), '\uFEFF' + consoleScript(directory, timeoutMs))
      privateFile(path.join(directory, 'supervisor.ps1'), '\uFEFF' + supervisorScript(directory, powershell, timeoutMs))
      launch = {
        channel: spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
          encode(`& ${psQuote(path.join(directory, 'supervisor.ps1'))}`)], {
          env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false,
        }),
      }
    } else {
      // macOS Unix-domain socket addresses have a short limit even when profile paths are long.
      socketDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ofm-terminal-'))
      fs.chmodSync(socketDirectory, 0o700)
      socketPath = path.join(socketDirectory, 'control.sock')
      if (Buffer.byteLength(socketPath) >= 100) throw fail('The temporary directory is too long for a private terminal socket')
      privateFile(path.join(directory, 'plan.json'), contents)
      launch = await posixTerminal({ platform, directory, socketPath, exec, spawn, env, nodePath, terminal, signal, timeoutMs })
    }
    control = transport(launch.channel, { signal, timeoutMs: timeoutMs + 2000, cleanup, readyInput: launch.readyInput, startInput: launch.startInput })
    const identity = await control.ready
    void control.closed.then(cleanup).catch(() => {})
    return {
      pid: identity.pid, startedAt: identity.startedAt, birth: identity.birth, childPid: identity.childPid,
      tty: identity.tty, ...(identity.processGroup ? { processGroup: identity.processGroup } : {}),
      isRunning: control.isRunning, stop: control.stop, dispose: control.stop,
    }
  } catch (error) {
    if (control) await control.stop().catch(() => {})
    await cleanup()
    if (signal?.aborted) throw fail('Terminal launch was cancelled', 'ABORTED')
    if (['ABORTED', 'UNSUPPORTED_SHIM', 'TERMINAL_TIMEOUT'].includes(error.code)) throw error
    throw fail('The interactive terminal could not start')
  }
}
