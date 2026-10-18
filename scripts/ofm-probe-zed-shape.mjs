import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.our-free-model', 'settings.json'), 'utf8'))
const KEY = settings.forwardKey
const URL = 'http://127.0.0.1:18900/v1/chat/completions'
const MODEL = process.argv[2] ?? 'deepseek-v4.1-flash-free'

const sys = [
  'You are the Zed coding agent running inside the Zed editor. You help users complete software engineering tasks by understanding their codebase, making careful changes, and explaining your work clearly.',
  '## Communication',
  '- Default to a tone that is concise, direct, and friendly.',
  '- Format responses in markdown. Use backticks for file paths, directories, commands, functions, classes, and other code identifiers.',
  '- To display an image to the user, use standard markdown image syntax.',
  '## Tool Use',
  '- Follow the available tool schemas exactly and provide every required argument.',
  '- Use only the tools that are currently available.',
  '- You can call multiple tools in a single response.',
  '## Task Execution',
  '- Keep going until the user\'s task is completely resolved before ending your turn.',
  '- Autonomously resolve the task to the best of your ability with the tools available.',
].join('\n') + '\n' + 'Filler context line for size. '.repeat(400)

const tools = [
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
  ['list_agents_and_models', 'List the agents and models available for use with the create_thread and spawn_agent tools.', { type: 'object', properties: {}, required: [] }, []],
  ['mcp:rea:open_binary', 'Open a local executable, application bundle, archive, JavaScript, source map, plist, or analysis database after validation.', { path: { type: 'string', description: 'Absolute local filesystem path for the analysis target.' }, format: { type: ['string', 'null'], description: 'Explicit headerless interpretation.' }, provider_id: { type: ['string', 'null'], description: 'Exact deep-analysis provider ID.' }, snapshot_path: { type: ['string', 'null'], description: 'Absolute local filesystem path for the analysis snapshot.' } }, ['path']],
  ['mcp:rea:analyze_function', 'Build a dossier for one native function identified by symbol or provider-returned address.', { procedure: { type: 'string', description: 'A procedure name or address.' } }, ['procedure']],
  ['mcp:rea:search_procedures', 'Search every analyzed procedure name using literal matching by default or regex when requested.', { pattern: { type: 'string', description: 'The literal text or regex pattern to search for.' }, mode: { type: 'string', enum: ['literal', 'regex'], default: 'literal' }, case_sensitive: { type: 'boolean', default: false }, document: { type: ['string', 'null'], description: 'The document name.' } }, ['pattern']],
  ['mcp:rea:inspect_artifact', 'Inspect an active archive or application package in one call.', { integrity_policy: { type: 'string', enum: ['fail', 'record-and-continue'] }, detail: { type: 'string', enum: ['complete', 'summary'] } }, ['integrity_policy', 'detail']],
].map(([name, description, properties, required]) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
}))

const user = { role: 'user', content: 'Baca file README.md lalu ringkas 3 baris.' }

const variants = []
variants.push(['minimal', { model: MODEL, messages: [{ role: 'system', content: sys }, user], stream: true, max_tokens: 32768, reasoning_effort: 'medium' }])
variants.push(['tools', { model: MODEL, messages: [{ role: 'system', content: sys }, user], stream: true, max_tokens: 32768, reasoning_effort: 'medium', tools, tool_choice: 'auto', parallel_tool_calls: true }])
variants.push(['stream_options', { model: MODEL, messages: [{ role: 'system', content: sys }, user], stream: true, stream_options: { include_usage: true }, max_tokens: 32768, reasoning_effort: 'medium', tools, tool_choice: 'auto' }])
variants.push(['history', { model: MODEL, messages: [
  { role: 'system', content: sys },
  { role: 'user', content: 'Baca package.json' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json"}' } }] },
  { role: 'tool', tool_call_id: 'call_1', content: '{\n  "name": "dsh-our-free-model",\n  "version": "2.5.3"\n}' },
  { role: 'user', content: 'Sekarang ringkas.' },
], stream: true, max_tokens: 32768, reasoning_effort: 'medium', tools, tool_choice: 'auto' }])
variants.push(['full', { model: MODEL, messages: [
  { role: 'system', content: sys },
  { role: 'user', content: 'Halo, cek repo ini.' },
  { role: 'assistant', content: 'Baik, saya cek dulu.', tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'terminal', arguments: '{"command":"git status --short","cd":"D:\\\\Aset\\\\dsh-ofm"}' } }] },
  { role: 'tool', tool_call_id: 'call_a', content: '?? HANDOVER.md\n?? backup-data.bat' },
  { role: 'user', content: 'Lanjutkan.' },
], stream: true, stream_options: { include_usage: true }, max_tokens: 32768, temperature: 0.3, reasoning_effort: 'medium', tools, tool_choice: 'auto', parallel_tool_calls: true }])

for (const [name, body] of variants) {
  const started = Date.now()
  let status = 0
  let text = ''
  try {
    const response = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body) })
    status = response.status
    text = await response.text()
  } catch (error) {
    text = `fetch error: ${error?.message ?? error}`
  }
  console.log(`\n=== ${name} -> HTTP ${status} (${Date.now() - started}ms) ===`)
  console.log(text.slice(0, 700).replace(/\n/g, '\\n'))
  if (name !== 'full') await new Promise(r => setTimeout(r, 1500))
}
