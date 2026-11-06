// src/o2a/version.js
var O2A_VERSION = "1.4.7";
var O2A_COMMIT = "b296a61d0e3ef93b4df58e298be2c4e34e397322";
var O2A_REFERENCE = "https://github.com/jasonxu114514/opencode2api";
var V2_CLIENT_VERSION = "2.2.3";
var CLIENT_UA = `opencode/latest/${V2_CLIENT_VERSION}/cli`;
var V2_COMPLETION_LIMIT = 32e3;
var ANONYMOUS_CREDENTIAL = "public";

// src/o2a/identity.js
import crypto from "node:crypto";
var CANONICAL_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
var DESCENDING_TIME_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;
var BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
var SESSION_TIMESTAMP_WINDOW_MS = 30 * 24 * 60 * 60 * 1e3;
var BOOT_NONCE = crypto.randomBytes(16);
function isOfficialSessionID(signal) {
  return typeof signal === "string" && CANONICAL_SESSION_RE.test(signal) && DESCENDING_TIME_RE.test(signal.slice(4, 16));
}
function canonicalSessionID(signal, now = Date.now()) {
  if (isOfficialSessionID(signal)) return signal;
  const digest = crypto.createHash("sha256").update(Buffer.concat([Buffer.from("ses\0"), BOOT_NONCE, Buffer.from([0]), Buffer.from(String(signal))])).digest();
  const timePart = descendingTimePart(now, digest);
  const randomPart = base62Fixed(digest.subarray(6, 16), 14);
  return `ses_${timePart}${randomPart}`;
}
var SESSION_PHASE_MS = 2n ** 36n;
function sessionPhaseMs(id) {
  if (!isOfficialSessionID(id)) return null;
  const inverted = BigInt(`0x${id.slice(4, 16)}`);
  const current = ~inverted & 0xffffffffffffn;
  return Number(current >> 12n);
}
function currentTimePhaseMs(now = Date.now()) {
  return now % Number(SESSION_PHASE_MS);
}
function phaseAgeMs(phase, now = Date.now()) {
  const nowPhase = BigInt(now % Number(SESSION_PHASE_MS));
  const age = (nowPhase - BigInt(phase)) % SESSION_PHASE_MS;
  return Number((age + SESSION_PHASE_MS) % SESSION_PHASE_MS);
}
function descendingTimePart(now = Date.now(), hash) {
  const offset = ((hash[0] << 24 | hash[1] << 16 | hash[2] << 8 | hash[3]) >>> 0) % SESSION_TIMESTAMP_WINDOW_MS;
  const midnight = Math.floor(now / 864e5) * 864e5;
  const base = midnight - offset;
  const inverted = ~(BigInt(base) << 12n | 1n) & 0xffffffffffffn;
  return inverted.toString(16).padStart(12, "0");
}
function base62Fixed(bytes, width) {
  let n = 0n;
  for (const byte of bytes) n = n << 8n | BigInt(byte);
  const out = new Array(width);
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = BASE62_ALPHABET[Number(n % 62n)];
    n /= 62n;
  }
  return out.join("");
}
function randomID(prefix, size) {
  return `${prefix}_${crypto.randomBytes(size).toString("hex")}`;
}
function randomProjectID() {
  return crypto.randomBytes(20).toString("hex");
}

// src/o2a/tool-renames.js
import crypto2 from "node:crypto";
var CLIENT_TOOL_PREFIX = "clint_";
var CLIENT_TOOL_DIGEST_LENGTH = 12;
var TOOL_WIRE_NAME_LIMIT = 64;
var TOOL_NAME_SEPARATORS = "_.- 	\r\n";
var SEPARATOR_SET = new Set(TOOL_NAME_SEPARATORS);
function foldToolName(name) {
  let out = "";
  for (const char of String(name ?? "").toLowerCase()) {
    if (!SEPARATOR_SET.has(char)) out += char;
  }
  return out;
}
function clientToolWireName(name, used) {
  const taken = used instanceof Set ? used : /* @__PURE__ */ new Set();
  const digest = crypto2.createHash("sha256").update(String(name)).digest("hex");
  let clean = digest.slice(0, CLIENT_TOOL_DIGEST_LENGTH);
  const max = TOOL_WIRE_NAME_LIMIT - CLIENT_TOOL_PREFIX.length;
  if (clean.length > max) clean = clean.slice(0, max);
  const base = CLIENT_TOOL_PREFIX + clean;
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let suffix = 2; ; suffix += 1) {
    const tag = `_${suffix}`;
    const cut = Math.min(TOOL_WIRE_NAME_LIMIT - tag.length, base.length);
    const candidate = base.slice(0, cut) + tag;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}
var OFFICIAL_TOOL_ALIASES = Object.freeze({
  edit: ["edit"],
  glob: ["glob"],
  grep: ["grep"],
  question: ["question", "askuserquestion"],
  read: ["read", "view"],
  shell: ["shell", "bash"],
  skill: ["skill"],
  subagent: ["subagent", "agent", "task"],
  webfetch: ["webfetch", "fetch"],
  websearch: ["websearch"],
  write: ["write"],
  patch: ["patch", "applypatch"]
});
var FOLDED_OFFICIAL_ALIASES = (() => {
  const index = /* @__PURE__ */ new Map();
  for (const [official, spellings] of Object.entries(OFFICIAL_TOOL_ALIASES)) {
    for (const spelling of spellings) {
      const folded = foldToolName(spelling);
      if (!index.has(folded)) index.set(folded, official);
    }
  }
  return index;
})();
function officialForClientName(name) {
  if (typeof name !== "string" || name === "") return null;
  return FOLDED_OFFICIAL_ALIASES.get(foldToolName(name)) ?? null;
}
var ToolRenameMap = class extends Map {
  constructor() {
    super();
    this.#byClient = /* @__PURE__ */ new Map();
    this.#byCase = /* @__PURE__ */ new Map();
    this.#byShape = /* @__PURE__ */ new Map();
  }
  /** Records one client→wire mapping (`Add`). Conflicts keep the first allocation. */
  add(client, wire) {
    if (!client || !wire || client === wire) return;
    if (this.#byClient.has(client)) return;
    if (this.has(wire)) return;
    this.#byClient.set(client, wire);
    this.set(wire, client);
    bindFolded(this.#byCase, String(client).toLowerCase(), client);
    bindFolded(this.#byShape, foldToolName(client), client);
  }
  /** The wire name registered for an exact client name (`Wire`). */
  wireOf(client) {
    return this.#byClient.get(client);
  }
  /** Whether any wire name starts with `prefix` (`HasPrefix`). */
  hasPrefix(prefix) {
    if (!prefix) return false;
    for (const wire of this.keys()) {
      if (wire.startsWith(prefix)) return true;
    }
    return false;
  }
  /** Whether a wire name is longer than `prefix` and starts with it (`HasLongerPrefix`). */
  hasLongerPrefix(prefix) {
    if (!prefix) return false;
    for (const wire of this.keys()) {
      if (wire.length > prefix.length && wire.startsWith(prefix)) return true;
    }
    return false;
  }
  /**
   * Map a name the upstream reported back to the name the client declared
   * (`Resolve`): an exact wire name restores; a `clint_` prefix is stripped as
   * best-effort recovery; a name that differs from exactly one declared client
   * tool in case, or in case and separators, folds onto that tool. A name two
   * tools fold to is never guessed between.
   */
  resolve(wire) {
    if (!wire) return wire;
    const exact = this.get(wire);
    if (exact !== void 0) return exact;
    let client = wire;
    if (client.startsWith(CLIENT_TOOL_PREFIX)) {
      const rest = client.slice(CLIENT_TOOL_PREFIX.length);
      if (rest !== "") client = rest;
    }
    if (this.#byClient.has(client)) return client;
    const caseMatch = this.#byCase.get(client.toLowerCase());
    if (caseMatch !== void 0) return caseMatch !== "" ? caseMatch : client;
    const shapeMatch = this.#byShape.get(foldToolName(client));
    if (shapeMatch !== void 0 && shapeMatch !== "") return shapeMatch;
    return client;
  }
  #byClient;
  #byCase;
  #byShape;
};
function bindFolded(folded, key, client) {
  if (!key) return;
  const existing = folded.get(key);
  if (existing === void 0) {
    folded.set(key, client);
    return;
  }
  if (existing !== client) folded.set(key, "");
}

// src/o2a/asset-source.js
var OFFICIAL_PROMPT_V2 = `You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below and the tools available to you to assist the user.

IMPORTANT: You must NEVER generate or guess URLs for the user unless you are confident that the URLs are for helping the user with programming. You may use URLs provided by the user in their messages or local files.

If the user asks for help or wants to give feedback inform them of the following:
- /help: Get help with using opencode
- To give feedback, users should report the issue at https://github.com/anomalyco/opencode/issues

When the user directly asks about opencode (eg 'can opencode do...', 'does opencode have...') or asks in second person (eg 'are you able...', 'can you do...'), first use the webfetch tool to gather information to answer the question from opencode docs at https://opencode.ai

# Tone and style
You should be concise, direct, and to the point. When you run a non-trivial bash command, you should explain what the command does and why you are running it, to make sure the user understands what you are doing (this is especially important when you are running a command that will make changes to the user's system).
Remember that your output will be displayed on a command line interface. Your responses can use GitHub-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.
Output text to communicate with the user; all text you output outside of tool use is displayed to the user. Only use tools to complete tasks. Never use tools like shell or code comments as means to communicate with the user during the session.
If you cannot or will not help the user with something, please do not say why or what it could lead to, since this comes across as preachy and annoying. Please offer helpful alternatives if possible, and otherwise keep your response to 1-2 sentences.
Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.
IMPORTANT: You should minimize output tokens as much as possible while maintaining helpfulness, quality, and accuracy. Only address the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request. If you can answer in 1-3 sentences or a short paragraph, please do.
IMPORTANT: You should NOT answer with unnecessary preamble or postamble (such as explaining your code or summarizing your action), unless the user asks you to.
IMPORTANT: Keep your responses short, since they will be displayed on a command line interface. You MUST answer concisely with fewer than 4 lines (not including tool use or code generation), unless user asks for detail. Answer the user's question directly, without elaboration, explanation, or details. One word answers are best. Avoid introductions, conclusions, and explanations. You MUST avoid text before/after your response, such as "The answer is <answer>.", "Here is the content of the file..." or "Based on the information provided, the answer is..." or "Here is what I will do next...". Here are some examples to demonstrate appropriate verbosity:
<example>
user: what is 2+2?
assistant: 4
</example>

<example>
user: is 11 a prime number?
assistant: Yes
</example>

<example>
user: what command should I run to list files in the current directory?
assistant: ls
</example>

<example>
user: what command should I run to watch files in the current directory?
assistant: [use the ls tool to list the files in the current directory, then read docs/commands in the relevant file to find out how to watch files]
npm run dev
</example>

<example>
user: what files are in the directory src/?
assistant: [runs ls and sees foo.c, bar.c, baz.c]
user: which file contains the implementation of foo?
assistant: src/foo.c
</example>

<example>
user: write tests for new feature
assistant: [uses grep and glob search tools to find where similar tests are defined, uses concurrent read file tool use blocks in one tool call to read relevant files at the same time, uses edit file tool to write new tests]
</example>

# Proactiveness
You are allowed to be proactive, but only when the user asks you to do something. You should strive to strike a balance between:
1. Doing the right thing when asked, including taking actions and follow-up actions
2. Not surprising the user with actions you take without asking
For example, if the user asks you how to approach something, you should do your best to answer their question first, and not immediately jump into taking actions.
3. Do not add additional code explanation summary unless requested by the user. After working on a file, just stop, rather than providing an explanation of what you did.

# Following conventions
When making changes to files, first understand the file's code conventions. Mimic code style, use existing libraries and utilities, and follow existing patterns.
- NEVER assume that a given library is available, even if it is well known. Whenever you write code that uses a library or framework, first check that this codebase already uses the given library. For example, you might look at neighboring files, or check the package.json (or cargo.toml, and so on depending on the language).
- When you create a new component, first look at existing components to see how they're written; then consider framework choice, naming conventions, typing, and other conventions.
- When you edit a piece of code, first look at the code's surrounding context (especially its imports) to understand the code's choice of frameworks and libraries. Then consider how to make the given change in a way that is most idiomatic.
- Always follow security best practices. Never introduce code that exposes or logs secrets and keys. Never commit secrets or keys to the repository.

# Code style
- IMPORTANT: DO NOT ADD ***ANY*** COMMENTS unless asked

# Doing tasks
The user will primarily request you perform software engineering tasks. This includes solving bugs, adding new functionality, refactoring code, explaining code, and more. For these tasks the following steps are recommended:
- Use the available search tools to understand the codebase and the user's query. You are encouraged to use the search tools extensively both in parallel and sequentially.
- Implement the solution using all tools available to you
- Verify the solution if possible with tests. NEVER assume specific test framework or test script. Check the README or search codebase to determine the testing approach.
- VERY IMPORTANT: When you have completed a task, you MUST run the lint and typecheck commands (e.g. npm run lint, npm run typecheck, ruff, etc.) with shell if they were provided to you to ensure your code is correct. If you are unable to find the correct command, ask the user for the command to run and if they supply it, proactively suggest writing it to AGENTS.md so that you will know to run it next time.
NEVER commit changes unless the user explicitly asks you to. It is VERY IMPORTANT to only commit when explicitly asked, otherwise the user will feel that you are being too proactive.

- Tool results and user messages may include <system-reminder> tags. <system-reminder> tags contain useful information and reminders. They are NOT part of the user's provided input or the tool result.

# Tool usage policy
- When doing file search, prefer to use the subagent tool in order to reduce context usage.
- You have the capability to call multiple tools in a single response. When multiple independent pieces of information are requested, batch your tool calls together for optimal performance. When making multiple bash tool calls, you MUST send a single message with multiple tools calls to run the calls in parallel. For example, if you need to run "git status" and "git diff", send a single message with two tool calls to run the calls in parallel.

You MUST answer concisely with fewer than 4 lines of text (not including tool use or code generation), unless user asks for detail.

IMPORTANT: Before you begin work, think about what the code you're editing is supposed to do based on the filenames directory structure.

# Code References

When referencing specific functions or pieces of code include the pattern \`file_path:line_number\` to allow the user to easily navigate to the source code location.

<example>
user: Where are errors from the client handled?
assistant: Clients are marked as failed in the \`connectToServer\` function in src/services/process.ts:712.
</example>

`;
var OFFICIAL_TOOLS_V2 = '{\n  "edit": {\n    "description": "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\\\n; the file\'s existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\\\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "newString": {\n          "description": "Text to replace oldString with (must differ from oldString)",\n          "type": "string"\n        },\n        "oldString": {\n          "description": "Exact text to find and replace",\n          "type": "string"\n        },\n        "path": {\n          "description": "File to edit",\n          "type": "string"\n        },\n        "replaceAll": {\n          "description": "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",\n          "type": "boolean"\n        }\n      },\n      "required": ["path", "oldString", "newString"],\n      "type": "object"\n    }\n  },\n  "execute": {\n    "description": "Run JavaScript in a confined Code Mode runtime to script tool calls and HTTP requests and compose their results.\\n`fetch` is available for HTTP requests. Imports, direct filesystem access, and timers are unavailable; all other external access goes through `tools`.\\nWithin `{ code }`, the only callable tools are those explicitly listed in the Code Mode catalog instructions or returned by the `search` function. Inside `{ code }`, ignore tools shown outside the Code Mode catalog. They are not available in the Code Mode runtime.\\nCall tools through `tools` using only exact paths and signatures from the catalog. Do not infer or normalize tool names; preserve bracket notation such as `tools.<namespace>[\\"tool-name\\"](input)`.\\nPrefer an explicit `return`; if omitted, the final top-level expression becomes the result.\\nAwait every call whose completion matters; pending calls are interrupted when execution ends. Run independent calls concurrently with `Promise.allSettled`.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "code": {\n          "type": "string"\n        }\n      },\n      "required": ["code"],\n      "type": "object"\n    }\n  },\n  "glob": {\n    "description": "Search file paths using a glob pattern (examples: \\"**/*.ts\\", \\"src/**/*.tsx\\").",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "hidden": {\n          "description": "Include hidden files and directories (default: false).",\n          "type": "boolean"\n        },\n        "limit": {\n          "description": "Maximum number of matching files to return (default: 100)",\n          "exclusiveMinimum": 0,\n          "type": "integer"\n        },\n        "path": {\n          "description": "Directory to search. Defaults to the current working directory.",\n          "type": "string"\n        },\n        "pattern": {\n          "description": "Glob pattern to match files against",\n          "type": "string"\n        }\n      },\n      "required": ["pattern"],\n      "type": "object"\n    }\n  },\n  "grep": {\n    "description": "Search file contents using ripgrep\'s regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with `path` or `include`. Returns matching file paths, line numbers, and line previews.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "caseSensitive": {\n          "description": "Use case-sensitive matching (default: true).",\n          "type": "boolean"\n        },\n        "include": {\n          "description": "Glob pattern to filter files (for example, \\"*.js\\" or \\"*.{ts,tsx}\\")",\n          "type": "string"\n        },\n        "limit": {\n          "description": "Maximum number of matching lines to return (default: 100)",\n          "exclusiveMinimum": 0,\n          "type": "integer"\n        },\n        "literal": {\n          "description": "Treat `pattern` as exact text instead of a regular expression (default: false).",\n          "type": "boolean"\n        },\n        "path": {\n          "description": "File or directory to search. Defaults to the current working directory.",\n          "type": "string"\n        },\n        "pattern": {\n          "description": "Regular expression or literal text to match in file contents.",\n          "minLength": 1,\n          "type": "string"\n        }\n      },\n      "required": ["pattern"],\n      "type": "object"\n    }\n  },\n  "question": {\n    "description": "Use this tool when you need to ask the user questions during execution. This allows you to:\\n1. Gather user preferences or requirements\\n2. Clarify ambiguous instructions\\n3. Get decisions on implementation choices as you work\\n4. Offer choices to the user about what direction to take.\\n\\nUsage notes:\\n- A \\"Type your own answer\\" option is added automatically; don\'t include a separate option for free form answers\\n- Set `multiple: true` to allow selecting more than one option\\n- If you recommend a specific option, make that the first option in the list and add \\"(Recommended)\\" at the end of the label",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "questions": {\n          "description": "Questions to ask",\n          "items": {\n            "additionalProperties": false,\n            "properties": {\n              "header": {\n                "description": "Very short label (max 30 chars)",\n                "type": "string"\n              },\n              "multiple": {\n                "type": "boolean"\n              },\n              "options": {\n                "description": "Available choices",\n                "items": {\n                  "additionalProperties": false,\n                  "properties": {\n                    "description": {\n                      "description": "Explanation of choice",\n                      "type": "string"\n                    },\n                    "label": {\n                      "description": "Display text (1-5 words, concise)",\n                      "type": "string"\n                    }\n                  },\n                  "required": ["label", "description"],\n                  "type": "object"\n                },\n                "type": "array"\n              },\n              "question": {\n                "description": "Complete question",\n                "type": "string"\n              }\n            },\n            "required": ["question", "header", "options"],\n            "type": "object"\n          },\n          "minItems": 1,\n          "type": "array"\n        }\n      },\n      "required": ["questions"],\n      "type": "object"\n    }\n  },\n  "read": {\n    "description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "limit": {\n          "description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)",\n          "minimum": 0,\n          "type": "integer"\n        },\n        "offset": {\n          "description": "The line or directory entry to start reading from (1-based)",\n          "minimum": 0,\n          "type": "integer"\n        },\n        "path": {\n          "description": "File or directory to read",\n          "type": "string"\n        }\n      },\n      "required": ["path"],\n      "type": "object"\n    }\n  },\n  "shell": {\n    "description": "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "background": {\n          "description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use \'&\' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion.",\n          "type": "boolean"\n        },\n        "command": {\n          "description": "Shell command string to execute",\n          "type": "string"\n        },\n        "timeout": {\n          "description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.",\n          "minimum": 0,\n          "type": "integer"\n        },\n        "workdir": {\n          "description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.",\n          "type": "string"\n        }\n      },\n      "required": ["command"],\n      "type": "object"\n    }\n  },\n  "skill": {\n    "description": "Load a specialized skill\'s instructions and resources into the current conversation when the task at hand matches its description.\\n\\nThe skill ID must match an available skill or a skill explicitly referenced by the user.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "id": {\n          "description": "The ID of an available skill or a skill explicitly referenced by the user",\n          "type": "string"\n        }\n      },\n      "required": ["id"],\n      "type": "object"\n    }\n  },\n  "subagent": {\n    "description": "Spawns an agent in a child session to work on the specified task.\\nThe output includes a sessionID you can pass back later to continue that specific conversation with the subagent.\\nNew child sessions start with fresh context, so include all relevant context and instructions when you don\'t pass a sessionID.\\nForeground (default) runs the subagent to completion and returns its final response.\\nBackground mode (background=true) launches it asynchronously and returns immediately; you are notified when it finishes.\\nUse background only for independent work that can run while you continue elsewhere.\\n\\nAvailable subagents:\\n- explore: Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. \\"src/components/**/*.tsx\\"), search code for keywords (eg. \\"API endpoints\\"), or answer questions about the codebase (eg. \\"how do API endpoints work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"very thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n- general: General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "agent": {\n          "description": "The type of specialized agent to use for this task. If the user asks for a subagent by a name that is not one of the available subagents, they most likely mean a model: pick a suitable agent and pass the name through the model parameter instead.",\n          "type": "string"\n        },\n        "background": {\n          "description": "Run the subagent in the background and return immediately. You will be notified when it completes. DO NOT sleep, poll, or proactively check on its progress.",\n          "type": "boolean"\n        },\n        "description": {\n          "description": "A short 3-5 word label for the task, displayed to the user",\n          "type": "string"\n        },\n        "model": {\n          "description": "NEVER set this unless the user explicitly asks for a particular model or variant. The value is written as \\"providerID/modelID\\", or \\"providerID/modelID#variant\\" to include a variant. Do not guess the ID: look the model up with the models tool, filtering to your own provider first.",\n          "type": "string"\n        },\n        "prompt": {\n          "description": "The task for the subagent to perform",\n          "type": "string"\n        },\n        "sessionID": {\n          "description": "Continue a specific previous subagent conversation by passing its sessionID. Calls without a sessionID start a new conversation.",\n          "pattern": "^ses",\n          "type": "string"\n        }\n      },\n      "required": ["agent", "description", "prompt"],\n      "type": "object"\n    }\n  },\n  "webfetch": {\n    "description": "Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default.\\n\\nUse a more targeted tool when one is available. This tool is read-only. Large text results may be replaced with a preview while the complete output is retained in managed storage.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "format": {\n          "description": "The format to return the content in. Defaults to markdown.",\n          "enum": ["text", "markdown", "html"],\n          "type": "string"\n        },\n        "timeout": {\n          "description": "Optional timeout in seconds (maximum: 120)",\n          "exclusiveMinimum": 0,\n          "maximum": 120,\n          "type": "number"\n        },\n        "url": {\n          "description": "The HTTP or HTTPS URL to fetch content from",\n          "type": "string"\n        }\n      },\n      "required": ["url"],\n      "type": "object"\n    }\n  },\n  "websearch": {\n    "description": "Search the web using the user\'s selected search integration. Use this for current information beyond knowledge cutoff.\\n\\nThe current year is 2026. Use this year when searching for recent information or current events.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "query": {\n          "description": "Websearch query",\n          "type": "string"\n        }\n      },\n      "required": ["query"],\n      "type": "object"\n    }\n  },\n  "write": {\n    "description": "Writes a file to the local filesystem, overwriting if one exists.\\n\\nMissing parent directories are created automatically.\\n\\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead.",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "content": {\n          "description": "Content to write to the file",\n          "type": "string"\n        },\n        "path": {\n          "description": "Path to the file to write to",\n          "type": "string"\n        }\n      },\n      "required": ["path", "content"],\n      "type": "object"\n    }\n  },\n  "patch": {\n    "description": "Use the `patch` tool to edit files. Your patch language is a stripped\u2011down, file\u2011oriented diff format designed to be easy to parse and safe to apply. You can think of it as a high\u2011level envelope:\\n\\n*** Begin Patch\\n[ one or more file sections ]\\n*** End Patch\\n\\nWithin that envelope, you get a sequence of file operations.\\nYou MUST include a header to specify the action you are taking.\\nEach operation starts with one of three headers:\\n\\n*** Add File: <path> - create a new file. Every following line is a + line (the initial contents).\\n*** Delete File: <path> - remove an existing file. Nothing follows.\\n*** Update File: <path> - patch an existing file in place (optionally with a rename).\\n\\nExample patch:\\n\\n```\\n*** Begin Patch\\n*** Add File: hello.txt\\n+Hello world\\n*** Update File: src/app.py\\n*** Move to: src/main.py\\n@@ def greet():\\n-print(\\"Hi\\")\\n+print(\\"Hello, world!\\")\\n*** Delete File: obsolete.txt\\n*** End Patch\\n```\\n\\nIt is important to remember:\\n\\n- You must include a header with your intended action (Add/Delete/Update)\\n- You must prefix new lines with `+` even when creating a new file",\n    "parameters": {\n      "additionalProperties": false,\n      "properties": {\n        "patchText": {\n          "description": "The full patch text describing add, update, and delete operations",\n          "type": "string"\n        }\n      },\n      "required": ["patchText"],\n      "type": "object"\n    }\n  }\n}\n';
function officialPromptText() {
  return OFFICIAL_PROMPT_V2;
}
function officialToolsText() {
  return OFFICIAL_TOOLS_V2;
}

// src/o2a/official-tools.js
var V2_OFFICIAL_TOOL_ORDER = Object.freeze([
  "edit",
  "execute",
  "glob",
  "grep",
  "question",
  "read",
  "shell",
  "skill",
  "subagent",
  "webfetch",
  "websearch",
  "write",
  "patch"
]);
var officialTools;
function loadOfficialTools() {
  if (officialTools !== void 0) return officialTools;
  officialTools = /* @__PURE__ */ new Map();
  try {
    const parsed = JSON.parse(officialToolsText());
    for (const [name, definition] of Object.entries(parsed)) {
      if (definition && typeof definition.description === "string" && definition.parameters) {
        officialTools.set(name, definition);
      }
    }
  } catch {
  }
  return officialTools;
}
function officialToolDefinition(name) {
  return loadOfficialTools().get(name);
}
function v2ShellDescription(base, platform = process.platform) {
  if (platform !== "win32") return base;
  return base.replace("on Linux using bash", "on Windows using powershell");
}
function officialTool(shape, name) {
  let description = `Agent tool ${name}`;
  let parameters = { type: "object", properties: {} };
  const definition = officialToolDefinition(name);
  if (definition !== void 0) {
    description = definition.description;
    if (definition.parameters != null) parameters = structuredClone(definition.parameters);
  }
  if (name === "shell") description = v2ShellDescription(description);
  if (shape === "claude") {
    return { name, description, input_schema: parameters };
  }
  if (shape === "flat") {
    return { type: "function", name, description, parameters };
  }
  return {
    type: "function",
    function: { name, description, parameters, strict: false }
  };
}
function officialToolset(shape) {
  return V2_OFFICIAL_TOOL_ORDER.map((name) => officialTool(shape, name));
}
function renamableToolName(shape, entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  if (shape === "chat") {
    const name2 = entry.function?.name;
    return typeof name2 === "string" && name2 !== "" ? name2 : null;
  }
  const type = typeof entry.type === "string" ? entry.type : "";
  if (shape === "flat") {
    if (type !== "" && type !== "function" && type !== "custom") return null;
  } else if (shape === "claude") {
    if (type !== "" && type !== "custom") return null;
  }
  const name = entry.name;
  return typeof name === "string" && name !== "" ? name : null;
}

// src/o2a/official-prompt.js
var promptCache;
function officialPrompt() {
  if (promptCache !== void 0) return promptCache;
  promptCache = officialPromptText();
  return promptCache;
}
var OFFICIAL_PROMPT_MARKER = "You are opencode, an interactive CLI tool";
var OFFICIAL_SKILLS = `Skills provide specialized instructions and workflows for specific tasks.
Use the skill tool to load a skill when a task matches its description.
<available_skills>
  <skill>
    <name>customize-opencode</name>
    <description>Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself.</description>
    <location>&lt;built-in&gt;</location>
  </skill>
</available_skills>`;
var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
var WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
var cachedWorkDir;
function workDir() {
  if (cachedWorkDir !== void 0) return cachedWorkDir;
  let directory = "";
  try {
    directory = process.cwd();
  } catch {
    directory = "";
  }
  directory = String(directory).trim();
  if (directory === "" || directory === ".") directory = "/workspace";
  cachedWorkDir = directory;
  return directory;
}
function officialEnvironment(model, directory = workDir()) {
  const apiModel = String(model ?? "").replace(/^opencode\//, "").trim() || "unknown";
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const now = /* @__PURE__ */ new Date();
  const date = `${WEEKDAYS[now.getUTCDay()]} ${MONTHS[now.getUTCMonth()]} ${String(now.getUTCDate()).padStart(2, "0")} ${now.getUTCFullYear()}`;
  return [
    `You are powered by the model named ${apiModel}. The exact model ID is opencode/${apiModel}`,
    "Here is some useful information about the environment you are running in:",
    "<env>",
    `  Working directory: ${directory}`,
    `  Workspace root folder: ${directory}`,
    "  Is directory a git repo: yes",
    `  Platform: ${platform}`,
    `  Today's date: ${date}`,
    "</env>"
  ].join("\n");
}
function officialSystemPrompt(model, directory) {
  const base = officialPrompt();
  if (base === "") return "";
  return `${base}${officialEnvironment(model, directory)}
${OFFICIAL_SKILLS}`;
}
function textFragments(value) {
  if (typeof value === "string") return value.trim() === "" ? [] : [value];
  if (Array.isArray(value)) return value.flatMap((item) => textFragments(item));
  if (value && typeof value === "object") {
    if (typeof value.text === "string") return textFragments(value.text);
    if (value.content !== void 0) return textFragments(value.content);
  }
  return [];
}
function carriesOpenCodePrompt(value) {
  return textFragments(value).some((part) => part.includes(OFFICIAL_PROMPT_MARKER));
}
function injectOfficialPrompt(payload, shape, { workDir: workDir2, model } = {}) {
  if (!payload || typeof payload !== "object") return false;
  if (shape !== "chat" && shape !== "flat" && shape !== "claude") return false;
  const prompt = officialSystemPrompt(model ?? payload.model, workDir2);
  if (prompt === "") return false;
  if (shape === "claude") return injectAnthropicPrompt(payload, prompt);
  if (shape === "flat") return injectResponsesPrompt(payload, prompt);
  return injectChatPrompt(payload, prompt);
}
function injectChatPrompt(payload, prompt) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  let anchorIndex = -1;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") continue;
    const role = message.role;
    if (role !== "system" && role !== "developer") continue;
    if (carriesOpenCodePrompt(message.content)) return false;
    if (anchorIndex === -1) anchorIndex = i;
  }
  if (anchorIndex === -1) {
    payload.messages = [{ role: "system", content: prompt }, ...messages];
    return true;
  }
  const anchor = messages[anchorIndex];
  if (Array.isArray(anchor.content)) {
    messages[anchorIndex] = { ...anchor, content: [{ type: "text", text: prompt }, ...anchor.content] };
  } else if (typeof anchor.content === "string" && anchor.content.trim() !== "") {
    messages[anchorIndex] = { ...anchor, content: `${prompt}

${anchor.content}` };
  } else {
    messages[anchorIndex] = { ...anchor, content: prompt };
  }
  return true;
}
function injectAnthropicPrompt(payload, prompt) {
  const exists = payload.system !== void 0;
  if (exists && carriesOpenCodePrompt(payload.system)) return false;
  if (!exists) {
    payload.system = prompt;
    return true;
  }
  if (Array.isArray(payload.system)) {
    payload.system = [{ type: "text", text: prompt }, ...payload.system];
  } else if (typeof payload.system === "string" && payload.system.trim() !== "") {
    payload.system = `${prompt}

${payload.system}`;
  } else {
    payload.system = prompt;
  }
  return true;
}
function injectResponsesPrompt(payload, prompt) {
  const exists = payload.instructions !== void 0;
  if (exists && carriesOpenCodePrompt(payload.instructions)) return false;
  if (exists && typeof payload.instructions === "string" && payload.instructions.trim() !== "") {
    payload.instructions = `${prompt}

${payload.instructions}`;
    return true;
  }
  payload.instructions = prompt;
  return true;
}

// src/o2a/gateway-body.js
function ensureChatUsage(payload, shape) {
  if (shape !== "chat") return false;
  if (payload.stream !== true) return false;
  if (payload.stream_options && typeof payload.stream_options === "object" && !Array.isArray(payload.stream_options)) {
    if (payload.stream_options.include_usage === true) return false;
    payload.stream_options = { ...payload.stream_options, include_usage: true };
    return true;
  }
  payload.stream_options = { include_usage: true };
  return true;
}
function ensureV2CompletionLimit(payload, shape) {
  if (shape !== "chat") return false;
  if (payload.max_completion_tokens !== void 0) return false;
  if (payload.max_tokens !== void 0) return false;
  payload.max_completion_tokens = V2_COMPLETION_LIMIT;
  return true;
}

// src/o2a/headers.js
import crypto3 from "node:crypto";
var GIT_COMMIT_RE = /^[0-9a-f]{40}$/;
function projectID(project) {
  if (project === "global" || GIT_COMMIT_RE.test(String(project))) return project;
  const sum = crypto3.createHash("sha256").update(`opencode-project\0${project}`).digest();
  return sum.subarray(0, 20).toString("hex");
}
function stableProjectID(session) {
  return projectID(String(session ?? ""));
}
function traceHeaders() {
  const traceId = crypto3.randomBytes(16).toString("hex");
  const spanId = crypto3.randomBytes(8).toString("hex");
  const parentId = crypto3.randomBytes(8).toString("hex");
  return {
    "traceparent": `00-${traceId}-${spanId}-01`,
    "b3": `${traceId}-${spanId}-1-${parentId}`
  };
}
function gatewayHeaders({ session, childSession, project, stream, accept, anthropic, userAgent } = {}) {
  const headers = {
    "content-type": "application/json",
    "authorization": `Bearer ${ANONYMOUS_CREDENTIAL}`,
    "user-agent": userAgent ?? CLIENT_UA,
    "x-opencode-client": "cli",
    "x-session-affinity": session,
    "x-session-id": session,
    "x-opencode-session": session,
    "x-opencode-session-id": childSession ?? session,
    "x-opencode-project": projectID(project ?? stableProjectID(session)),
    ...traceHeaders()
  };
  if (accept !== null) headers["accept"] = accept ?? "*/*";
  if (anthropic) headers["anthropic-beta"] = "interleaved-thinking-2025-05-14";
  return headers;
}

// src/o2a/toolshape.js
function renameAndCompleteTools(payload, shape, { keep } = {}) {
  if (shape !== "chat" && shape !== "flat" && shape !== "claude") {
    return { renames: new ToolRenameMap(), injected: [], known: /* @__PURE__ */ new Set() };
  }
  const renames = new ToolRenameMap();
  const used = /* @__PURE__ */ new Set();
  const keepNames = keep instanceof Set ? keep : /* @__PURE__ */ new Set();
  const officialUsed = new Set(keepNames);
  let items = Array.isArray(payload.tools) ? [...payload.tools] : [];
  if ((shape === "chat" || shape === "flat") && Array.isArray(payload.functions)) {
    items = items.concat(convertLegacyFunctions(payload.functions, shape, renames, used));
    delete payload.functions;
  }
  const shaped = [];
  for (const item of items) {
    const name = renamableToolName(shape, item);
    if (name === null) {
      shaped.push(item);
      continue;
    }
    if (keepNames.has(name) || name.startsWith(CLIENT_TOOL_PREFIX)) {
      shaped.push(item);
      continue;
    }
    const official = officialForClientName(name);
    if (official !== null && officialUsed.has(official) === false && officialToolDefinition(official) !== void 0) {
      officialUsed.add(official);
      renames.add(name, official);
      shaped.push(withToolName(shape, item, official));
      continue;
    }
    let wireName = renames.wireOf(name);
    if (wireName === void 0) {
      wireName = clientToolWireName(name, used);
      renames.add(name, wireName);
    }
    shaped.push(wireName !== name ? withToolName(shape, item, wireName) : item);
  }
  const injected = [];
  for (const name of V2_OFFICIAL_TOOL_ORDER) {
    if (officialUsed.has(name)) continue;
    shaped.push(officialTool(shape, name));
    injected.push(name);
    officialUsed.add(name);
  }
  payload.tools = shaped;
  rewriteToolReferences(payload, shape, renames);
  const known = new Set(officialUsed);
  for (const wire of renames.keys()) known.add(wire);
  sanitizeToolHistory(payload, shape, known);
  dropDanglingToolChoice(payload, shape, known);
  return { renames, injected, known };
}
function sanitizeToolHistory(payload, shape, known) {
  const fateOf = (name) => {
    if (typeof name !== "string" || name === "") return { verdict: "drop" };
    if (known.has(name)) return { verdict: "keep" };
    const official = officialForClientName(name);
    if (official !== null && known.has(official)) return { verdict: "rename", official };
    return { verdict: "drop" };
  };
  if (shape === "chat") {
    const messages2 = Array.isArray(payload.messages) ? payload.messages : null;
    if (messages2 === null) return;
    const droppedCalls2 = /* @__PURE__ */ new Set();
    const droppedFunctions = /* @__PURE__ */ new Set();
    let changed2 = false;
    for (let i = 0; i < messages2.length; i += 1) {
      const message = messages2[i];
      if (!message || typeof message !== "object") continue;
      if (Array.isArray(message.tool_calls)) {
        const kept = [];
        let touched = false;
        for (const call of message.tool_calls) {
          const fate = fateOf(call?.function?.name);
          if (fate.verdict === "keep") {
            kept.push(call);
            continue;
          }
          if (fate.verdict === "rename") {
            const fn = call.function ?? {};
            kept.push({ ...call, function: { ...fn, name: fate.official } });
            touched = true;
            continue;
          }
          if (typeof call?.id === "string" && call.id !== "") droppedCalls2.add(call.id);
          touched = true;
        }
        if (touched) {
          messages2[i] = { ...message, tool_calls: kept };
          changed2 = true;
        }
      }
      if (message.function_call && typeof message.function_call === "object") {
        const fate = fateOf(message.function_call.name);
        if (fate.verdict === "rename") {
          messages2[i] = { ...message, function_call: { ...message.function_call, name: fate.official } };
          changed2 = true;
        } else if (fate.verdict === "drop") {
          if (typeof message.function_call.name === "string") droppedFunctions.add(message.function_call.name);
          const { function_call: _dropped, ...rest } = messages2[i];
          messages2[i] = rest;
          changed2 = true;
        }
      }
      if (message.role === "tool" && typeof message.tool_call_id === "string" && droppedCalls2.has(message.tool_call_id)) {
        messages2.splice(i, 1);
        i -= 1;
        changed2 = true;
      }
      if (message.role === "function" && typeof message.name === "string" && droppedFunctions.has(message.name)) {
        messages2.splice(i, 1);
        i -= 1;
        changed2 = true;
      }
    }
    if (changed2 && messages2.length === 0) payload.messages = [];
    return;
  }
  if (shape === "flat") {
    const input = Array.isArray(payload.input) ? payload.input : null;
    if (input === null) return;
    const droppedCalls2 = /* @__PURE__ */ new Set();
    let changed2 = false;
    for (let i = 0; i < input.length; i += 1) {
      const item = input[i];
      const type = typeof item?.type === "string" ? item.type : "";
      if (type === "function_call") {
        const fate = fateOf(item.name);
        if (fate.verdict === "rename") {
          input[i] = { ...item, name: fate.official };
          changed2 = true;
        } else if (fate.verdict === "drop") {
          if (typeof item.call_id === "string" && item.call_id !== "") droppedCalls2.add(item.call_id);
          input.splice(i, 1);
          i -= 1;
          changed2 = true;
        }
        continue;
      }
      if (type === "function_call_output" && typeof item.call_id === "string" && droppedCalls2.has(item.call_id)) {
        input.splice(i, 1);
        i -= 1;
        changed2 = true;
      }
    }
    if (changed2 && input.length === 0) payload.input = [];
    return;
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : null;
  if (messages === null) return;
  const droppedCalls = /* @__PURE__ */ new Set();
  let changed = false;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) continue;
    const kept = [];
    let touched = false;
    for (const block of message.content) {
      if (block?.type === "tool_use") {
        const fate = fateOf(block.name);
        if (fate.verdict === "keep") {
          kept.push(block);
          continue;
        }
        if (fate.verdict === "rename") {
          kept.push({ ...block, name: fate.official });
          touched = true;
          continue;
        }
        if (typeof block.id === "string" && block.id !== "") droppedCalls.add(block.id);
        touched = true;
        continue;
      }
      if (block?.type === "tool_result" && typeof block.tool_use_id === "string" && droppedCalls.has(block.tool_use_id)) {
        touched = true;
        continue;
      }
      kept.push(block);
    }
    if (touched) {
      messages[i] = kept.length === 0 ? null : { ...message, content: kept };
      changed = true;
    }
  }
  if (changed) payload.messages = messages.filter((message) => message !== null);
}
function dropDanglingToolChoice(payload, shape, known) {
  const choice = payload?.tool_choice;
  if (choice === null || typeof choice !== "object") return;
  const name = shape === "chat" && choice.function && typeof choice.function === "object" ? choice.function.name : choice.name;
  if (typeof name === "string" && name !== "" && !known.has(name)) delete payload.tool_choice;
}
function withToolName(shape, entry, name) {
  if (shape === "chat") {
    return { ...entry, function: { ...entry.function, name } };
  }
  return { ...entry, name };
}
function convertLegacyFunctions(entries, shape, renames, used) {
  const converted = [];
  for (const raw of entries) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (name === "") continue;
    let wireName = renames.wireOf(name);
    if (wireName === void 0) {
      wireName = clientToolWireName(name, used);
      renames.add(name, wireName);
    }
    const description = typeof raw.description === "string" ? raw.description : void 0;
    const parameters = raw.parameters ?? { type: "object", properties: {} };
    if (shape === "chat") {
      const fn = { name: wireName, description, parameters };
      if (raw.strict !== void 0) fn.strict = raw.strict;
      converted.push({ type: "function", function: fn });
    } else {
      const tool = { type: "function", name: wireName, description, parameters };
      if (raw.strict !== void 0) tool.strict = raw.strict;
      converted.push(tool);
    }
  }
  return converted;
}
function rewriteToolReferences(payload, shape, renames) {
  if (renames.size === 0) return;
  const renamed = (container) => {
    if (!container || typeof container !== "object") return null;
    const name = container.name;
    if (typeof name !== "string") return null;
    const wireName = renames.wireOf(name);
    return wireName !== void 0 && wireName !== name ? wireName : null;
  };
  if (shape === "chat") {
    const choice2 = objectOf(payload.tool_choice);
    if (choice2) {
      if (choice2.function && typeof choice2.function === "object") {
        const wire = renamed(choice2.function);
        if (wire !== null) payload.tool_choice = { ...choice2, function: { ...choice2.function, name: wire } };
      } else {
        const wire = renamed(choice2);
        if (wire !== null) payload.tool_choice = { ...choice2, name: wire };
      }
    }
    const call = objectOf(payload.function_call);
    if (call) {
      const wire = renamed(call);
      if (wire !== null) payload.function_call = { ...call, name: wire };
    }
    const messages2 = Array.isArray(payload.messages) ? payload.messages : [];
    for (let i = 0; i < messages2.length; i += 1) {
      const message = messages2[i];
      if (!message || typeof message !== "object") continue;
      let next = null;
      const fnCall = objectOf(message.function_call);
      if (fnCall) {
        const wire = renamed(fnCall);
        if (wire !== null) next = { ...message, function_call: { ...fnCall, name: wire } };
      }
      if (Array.isArray(message.tool_calls)) {
        const calls = message.tool_calls.map((entry) => {
          const fn = objectOf(entry?.function);
          if (!fn) return entry;
          const wire = renamed(fn);
          return wire !== null ? { ...entry, function: { ...fn, name: wire } } : entry;
        });
        if (calls.some((entry, j) => entry !== message.tool_calls[j])) {
          next = { ...next ?? message, tool_calls: calls };
        }
      }
      if (next !== null) messages2[i] = next;
    }
    return;
  }
  if (shape === "flat") {
    const choice2 = objectOf(payload.tool_choice);
    if (choice2) {
      let next = null;
      const wire = renamed(choice2);
      if (wire !== null) next = { ...choice2, name: wire };
      if (Array.isArray(choice2.allowed_tools)) {
        const allowed = choice2.allowed_tools.map((entry) => {
          if (!entry || typeof entry !== "object") return entry;
          const entryWire = renamed(entry);
          return entryWire !== null ? { ...entry, name: entryWire } : entry;
        });
        if (allowed.some((entry, j) => entry !== choice2.allowed_tools[j])) {
          next = { ...next ?? choice2, allowed_tools: allowed };
        }
      }
      if (next !== null) payload.tool_choice = next;
    }
    const input = Array.isArray(payload.input) ? payload.input : [];
    for (let i = 0; i < input.length; i += 1) {
      const item = input[i];
      const type = typeof item?.type === "string" ? item.type : "";
      if (type !== "function_call" && type !== "custom_tool_call") continue;
      const wire = renamed(item);
      if (wire !== null) input[i] = { ...item, name: wire };
    }
    return;
  }
  const choice = objectOf(payload.tool_choice);
  if (choice) {
    const wire = renamed(choice);
    if (wire !== null) payload.tool_choice = { ...choice, name: wire };
  }
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!message || typeof message !== "object" || !Array.isArray(message.content)) continue;
    const content = message.content.map((block) => {
      if (block?.type !== "tool_use") return block;
      const wire = renamed(block);
      return wire !== null ? { ...block, name: wire } : block;
    });
    if (content.some((block, j) => block !== message.content[j])) {
      messages[i] = { ...message, content };
    }
  }
}
function objectOf(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
export {
  ANONYMOUS_CREDENTIAL,
  BASE62_ALPHABET,
  CANONICAL_SESSION_RE,
  CLIENT_TOOL_DIGEST_LENGTH,
  CLIENT_TOOL_PREFIX,
  CLIENT_UA,
  DESCENDING_TIME_RE,
  O2A_COMMIT,
  O2A_REFERENCE,
  O2A_VERSION,
  OFFICIAL_PROMPT_MARKER,
  OFFICIAL_SKILLS,
  OFFICIAL_TOOL_ALIASES,
  SESSION_PHASE_MS,
  SESSION_TIMESTAMP_WINDOW_MS,
  TOOL_WIRE_NAME_LIMIT,
  ToolRenameMap,
  V2_CLIENT_VERSION,
  V2_COMPLETION_LIMIT,
  V2_OFFICIAL_TOOL_ORDER,
  base62Fixed,
  canonicalSessionID,
  carriesOpenCodePrompt,
  clientToolWireName,
  currentTimePhaseMs,
  descendingTimePart,
  ensureChatUsage,
  ensureV2CompletionLimit,
  foldToolName,
  gatewayHeaders,
  injectOfficialPrompt,
  isOfficialSessionID,
  officialEnvironment,
  officialForClientName,
  officialPrompt,
  officialSystemPrompt,
  officialTool,
  officialToolDefinition,
  officialToolset,
  phaseAgeMs,
  projectID,
  randomID,
  randomProjectID,
  renamableToolName,
  renameAndCompleteTools,
  sessionPhaseMs,
  stableProjectID,
  textFragments,
  traceHeaders,
  v2ShellDescription
};
