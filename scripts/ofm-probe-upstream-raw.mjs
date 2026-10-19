/**
 * Probe the free lane's upstream directly, bypassing the local gateway, so the
 * raw 400 body is visible. The gateway folds an upstream error envelope into a
 * classified failure and, when the envelope carries no string `message`, prints
 * only "upstream HTTP 400" — which hides the one line that explains the refusal.
 *
 * Usage:
 *   node scripts/ofm-probe-upstream-raw.mjs [model]
 *
 * Nothing here writes settings or changes the gateway; it is a read-only probe.
 */
import { applyFingerprint, endpointFor, gatewayHeaders, sessionForConversation, UPSTREAM_BASE } from '../src/upstream.js'

const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free'
const URL = `${UPSTREAM_BASE}${endpointFor(MODEL)}`
const session = sessionForConversation(`probe-raw-${MODEL}`)

const sys = 'You are a coding agent. Answer briefly.'

const realTools = [
  ['read_file', 'Reads the content of the given file in the project.', { path: { type: 'string', description: 'The relative path of the file to read.' }, start_line: { type: ['integer', 'null'], description: 'Optional line number to start reading on.' }, end_line: { type: ['integer', 'null'], description: 'Optional line number to end reading on.' } }, ['path']],
  ['edit_file', 'This is a tool for applying edits to an existing file.', { path: { type: 'string', description: 'The full path of the file to edit in the project.' }, edits: { type: 'array', description: 'List of edit operations to apply sequentially.', items: { type: 'object', properties: { old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['old_text', 'new_text'], additionalProperties: false } } }, ['path', 'edits']],
  ['write_file', 'This is a tool for creating a new file or overwriting an existing file with completely new contents.', { path: { type: 'string', description: 'The full path of the file to create.' }, content: { type: 'string', description: 'The entire content for the file.' } }, ['path', 'content']],
  ['terminal', 'Executes a shell one-liner and returns the combined output.', { command: { type: 'string', description: 'The one-liner command to execute.' }, cd: { type: 'string', description: 'Working directory.' }, timeout_ms: { type: ['integer', 'null'], description: 'Optional maximum runtime.' } }, ['command', 'cd']],
  ['grep', 'Searches the contents of files in the project with a regular expression', { regex: { type: 'string', description: 'A regex pattern to search for.' }, include_pattern: { type: ['string', 'null'], description: 'A glob pattern.' }, case_sensitive: { type: 'boolean', default: false }, offset: { type: 'integer', minimum: 0 } }, ['regex']],
  ['find_path', 'Find file paths that match a given pattern.', { glob: { type: 'string', description: 'The glob to match against every path in the project.' }, offset: { type: 'integer', minimum: 0 } }, ['glob']],
  ['list_directory', 'Lists files and directories in a given path.', { path: { type: 'string', description: 'The fully-qualified path of the directory to list in the project.' } }, ['path']],
  ['diagnostics', 'Get errors and warnings for the project or a specific file.', { path: { type: ['string', 'null'], description: 'The path to get diagnostics for.' } }, []],
  ['fetch', 'Fetches a URL and returns the content as Markdown.', { url: { type: 'string', description: 'The URL to fetch.' } }, ['url']],
  ['create_directory', 'Creates a new directory at the specified path, and all necessary parent directories.', { path: { type: 'string', description: 'The path of the new directory.' }, reason: { type: ['string', 'null'], description: 'Unused on this platform.' } }, ['path']],
  ['delete_path', 'Deletes the file or directory at the specified path in the project.', { path: { type: 'string', description: 'The path of the file or directory to delete.' } }, ['path']],
  ['copy_path', 'Copies a file or directory in the project.', { source_path: { type: 'string', description: 'The source path.' }, destination_path: { type: 'string', description: 'The destination path.' } }, ['source_path', 'destination_path']],
  ['move_path', 'Moves or rename a file or directory in the project.', { source_path: { type: 'string', description: 'The source path.' }, destination_path: { type: 'string', description: 'The destination path.' } }, ['source_path', 'destination_path']],
  ['skill', 'Retrieves the content and resources of a skill by name.', { name: { type: 'string', description: 'The name of the skill to retrieve.' } }, ['name']],
  ['spawn_agent', 'Spawn a sub-agent for a well-scoped task.', { label: { type: 'string', description: 'Short label displayed in the UI while the agent runs.' }, message: { type: 'string', description: 'The prompt for the agent.' }, model: { type: ['string', 'null'], description: 'Optional model override.' }, session_id: { type: ['string', 'null'], description: 'Session ID of an existing agent session to continue.' } }, ['label', 'message']],
].map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
}))

const colonTools = [
  ['mcp:rea:open_binary', 'Open a local executable after validation.', { path: { type: 'string', description: 'Absolute path.' } }, ['path']],
  ['mcp:rea:analyze_function', 'Build a dossier for one native function.', { procedure: { type: 'string', description: 'A procedure name or address.' } }, ['procedure']],
  ['mcp:rea:inspect_artifact', 'Inspect an active archive in one call.', { integrity_policy: { type: 'string', enum: ['fail', 'record-and-continue'] } }, ['integrity_policy']],
].map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
}))

const longTools = [
  ['a'.repeat(64), 'A tool with a 64-character name.', { path: { type: 'string' } }, ['path']],
  ['b'.repeat(65), 'A tool with a 65-character name.', { path: { type: 'string' } }, ['path']],
  ['c'.repeat(128), 'A tool with a 128-character name.', { path: { type: 'string' } }, ['path']],
].map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
}))

const user = { role: 'user', content: 'Baca file README.md lalu ringkas 3 baris.' }

const base = { model: MODEL, messages: [{ role: 'system', content: sys }, user], stream: true, max_tokens: 4096 }

function variant(name, body) {
  return [name, body]
}

const variants = [
  variant('minimal', { ...base }),
  variant('tools', { ...base, tools: realTools, tool_choice: 'auto', parallel_tool_calls: true }),
  variant('tools-no-parallel', { ...base, tools: realTools, tool_choice: 'auto' }),
  variant('tools-no-choice', { ...base, tools: realTools }),
  variant('stubs-only', { ...base, tools: [] }),
  variant('tools-colon', { ...base, tools: colonTools, tool_choice: 'auto' }),
  variant('tools-long-name', { ...base, tools: longTools, tool_choice: 'auto' }),
]

for (const [name, raw] of variants) {
  // The gateway runs applyFingerprint before posting; mirror that so the probe
  // measures the bytes the upstream actually receives.
  const body = JSON.parse(JSON.stringify(raw))
  applyFingerprint(body, false)
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch(URL, {
      method: 'POST',
      headers: gatewayHeaders({ session, stream: true }),
      body: JSON.stringify(body),
      redirect: 'error',
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    text = `fetch error: ${error?.message ?? error}`
  }
  const tools = Array.isArray(body.tools) ? body.tools.length : 0
  console.log(`\n=== ${name} -> HTTP ${status} (${Date.now() - started}ms, ${tools} tools) ===`)
  console.log(text.slice(0, 2500).replace(/\n/g, '\\n'))
  await new Promise(r => setTimeout(r, 2500))
}
