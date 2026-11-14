import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function mintSession() {
  const value = ~(BigInt(Date.now()) * 0x1000n + 1n)
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  let rand = ''
  const rb = crypto.randomBytes(14)
  for (let i = 0; i < 14; i += 1) rand += B62[rb[i] % 62]
  return `ses_${hex}${rand}`
}

const session = mintSession()
const BS = String.fromCharCode(92)
const cwd = process.cwd().split(BS).join('/')
const tmp = path.join(os.tmpdir(), 'opencode').split(BS).join('/')

const READ_DESC = 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.'
const SHELL_DESC = 'Execute a shell command and return its output. Commands run on Windows using powershell. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.'

const envBlock = [
  'Here is some useful information about the environment you are running in:',
  '<env>',
  `  Working directory: ${cwd}`,
  `  Workspace root folder: ${cwd}`,
  '  Is directory a git repo: no',
  `  Platform: ${os.platform()}`,
  `  Prefer ${tmp} over generic system temporary directories such as /tmp; it is pre-created and approved for external access.`,
  '</env>',
].join('\n')

const body = {
  model: 'deepseek-v4.1-flash-free',
  stream: true,
  max_tokens: 32,
  messages: [
    { role: 'system', content: envBlock },
    { role: 'user', content: 'ping' },
  ],
  tools: [
    {
      type: 'function',
      function: {
        name: 'read',
        description: READ_DESC,
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File or directory to read' },
            offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
            limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
          },
          required: ['path'],
          additionalProperties: false,
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'shell',
        description: SHELL_DESC,
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'Shell command string to execute' },
            workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
            timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
            background: { type: 'boolean', description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
          },
          required: ['command'],
          additionalProperties: false,
        },
      },
    },
  ],
}

const resp = await fetch('https://opencode.ai/inference/v1/chat/completions', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/latest/2.1.4/cli',
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-session-id': session,
    accept: 'text/event-stream',
  },
  body: JSON.stringify(body),
})
console.log('RUNTIME', Bun.version, 'session', session)
console.log('STATUS', resp.status)
console.log('BODY', (await resp.text()).slice(0, 600))
