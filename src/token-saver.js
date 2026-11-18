// src/token-saver/rtk/constants.js
var RAW_CAP = 10 * 1024 * 1024;
var MIN_COMPRESS_SIZE = 500;
var DETECT_WINDOW = 1024;
var GIT_DIFF_HUNK_MAX_LINES = 100;
var GIT_LOG_MAX_LINES = 200;
var DEDUP_LINE_MAX = 2e3;
var GREP_PER_FILE_MAX = 10;
var FIND_PER_DIR_MAX = 10;
var FIND_TOTAL_DIR_MAX = 20;
var STATUS_MAX_FILES = 10;
var STATUS_MAX_UNTRACKED = 10;
var LS_EXT_SUMMARY_TOP = 5;
var LS_NOISE_DIRS = [
  "node_modules",
  ".git",
  "target",
  "__pycache__",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
  ".vercel",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  "env",
  // Python legacy virtualenv; .env (dotenv) intentionally excluded
  "coverage",
  ".nyc_output",
  ".DS_Store",
  "Thumbs.db",
  ".idea",
  ".vscode",
  ".vs",
  "*.egg-info",
  ".eggs"
];
var TREE_MAX_LINES = 200;
var SEARCH_LIST_PER_DIR_MAX = 10;
var SEARCH_LIST_TOTAL_DIR_MAX = 20;
var SMART_TRUNCATE_HEAD = 120;
var SMART_TRUNCATE_TAIL = 60;
var SMART_TRUNCATE_MIN_LINES = 250;
var READ_NUMBERED_MIN_HIT_RATIO = 0.7;

// src/token-saver/rtk/filters/gitDiff.js
function gitDiff(input, maxLines = 500) {
  const output = [];
  let file = "", added = 0, removed = 0, shown = 0, omitted = 0;
  let inHunk = false, truncated = false, offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const boundary = row.startsWith("diff --git") ? "file" : row.startsWith("@@") ? "hunk" : "";
    if (boundary) {
      if (omitted) {
        output.push(`  ... (${omitted} lines truncated)`);
        truncated = true;
        omitted = 0;
      }
      shown = 0;
      inHunk = boundary === "hunk";
      if (inHunk) output.push(`  ${row}`);
      else {
        if (file && (added || removed)) output.push(`  +${added} -${removed}`);
        const separator = row.indexOf(" b/");
        file = separator < 0 ? "unknown" : row.slice(separator + 3);
        output.push(`
${file}`);
        added = removed = 0;
      }
    } else if (inHunk) {
      const addition = row[0] === "+" && !row.startsWith("+++");
      const deletion = row[0] === "-" && !row.startsWith("---");
      if (addition) added++;
      if (deletion) removed++;
      if (addition || deletion) {
        if (shown < GIT_DIFF_HUNK_MAX_LINES) {
          output.push(`  ${row}`);
          shown++;
        } else omitted++;
      } else if (shown > 0 && shown < GIT_DIFF_HUNK_MAX_LINES && row[0] !== "\\") {
        output.push(`  ${row}`);
        shown++;
      }
    }
    if (output.length >= maxLines) {
      output.push("\n... (more changes truncated)");
      truncated = true;
      break;
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (omitted) {
    output.push(`  ... (${omitted} lines truncated)`);
    truncated = true;
  }
  if (file && (added || removed)) output.push(`  +${added} -${removed}`);
  if (truncated) output.push("[diff truncated by OFM; disable tool-output compression and request the diff again]");
  return output.join("\n");
}
gitDiff.filterName = "git-diff";

// src/token-saver/rtk/filters/gitStatus.js
function gitStatus(input) {
  if (!input.includes("\n") && !input.trim()) return "Clean working tree";
  const sections = [
    { label: "+ Staged", limit: STATUS_MAX_FILES, count: 0, paths: [] },
    { label: "~ Modified", limit: STATUS_MAX_FILES, count: 0, paths: [] },
    { label: "? Untracked", limit: STATUS_MAX_UNTRACKED, count: 0, paths: [] }
  ];
  let branch = "";
  let conflicts = 0;
  let offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const heading = /^On branch (\S+)/.exec(row);
    const categories = [];
    let path = "";
    if (heading) branch = heading[1];
    else if (row.startsWith("##")) branch = row.slice(2).trimStart();
    else if (/^[ MADRCU?!][ MADRCU?!] /.test(row)) {
      path = row.slice(3);
      if (row.startsWith("??")) categories.push(2);
      else {
        if ("MADRC".includes(row[0])) categories.push(0);
        else if (row[0] === "U") conflicts++;
        if (row[1] === "M" || row[1] === "D") categories.push(1);
      }
    } else {
      const detail = /^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/.exec(row);
      if (detail) {
        path = detail[2].trim();
        if (detail[1] === "both modified") conflicts++;
        else categories.push(detail[1] === "modified" || detail[1] === "deleted" ? 1 : 0);
      }
    }
    for (const index of categories) {
      const section = sections[index];
      section.count++;
      if (section.paths.length < section.limit) section.paths.push(path);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  const output = branch ? [`* ${branch}`] : [];
  for (const { label, count, paths } of sections) {
    if (!count) continue;
    output.push(`${label}: ${count} files`);
    for (const path of paths) output.push(`   ${path}`);
    if (count > paths.length) output.push(`   ... +${count - paths.length} more`);
  }
  if (conflicts) output.push(`conflicts: ${conflicts} files`);
  if (!conflicts && sections.every((section) => section.count === 0)) output.push("clean \u2014 nothing to commit");
  return output.join("\n");
}
gitStatus.filterName = "git-status";

// src/token-saver/rtk/filters/gitLog.js
function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return "";
  const input = String(text);
  const output = [];
  let inCommit = false, subject = false, skipped = 0, offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end).trimEnd();
    const trimmed = row.trim();
    let selected;
    if (/^(?:commit [0-9a-f]{7,40}$|[*|/\\ ]+commit [0-9a-f]{7,40})/i.test(trimmed)) {
      inCommit = true;
      subject = false;
      selected = row;
    } else if (inCommit) {
      if (/^[*|/\\ ]*(?:Author|Date):/i.test(trimmed)) selected = trimmed;
      else if (trimmed) {
        if (!subject && /^[*|/\\ ]*    \S/.test(row)) {
          selected = `  Subject: ${trimmed}`;
          subject = true;
        } else if (/^\d+ file\w* changed/.test(trimmed)) selected = `  ${trimmed}`;
        else if (trimmed.startsWith("diff --git ")) selected = "  ... diff body omitted";
      }
    } else {
      const graph = /^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i.exec(trimmed);
      if (graph) selected = graph[1];
      else if (!/^[*|/\\ ]+$/.test(trimmed) || !/[*|/\\]/.test(trimmed)) selected = trimmed;
    }
    if (selected !== void 0) {
      if (output.length < maxLines) output.push(selected);
      else skipped++;
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (skipped) output.push(`... (${skipped} more lines)`);
  const result2 = output.join("\n");
  return result2 && result2.length <= input.length ? result2 : input;
}
gitLog.filterName = "git-log";

// src/token-saver/rtk/filters/buildOutput.js
var summaryPattern = /^(?:(?:added|removed|changed|audited|installed)\s+\d+\s+package|Finished\s+|BUILD SUCCESS|\d+\s+(?:vulnerabilities|packages?|warnings?|errors?)|Successfully (?:installed|built)|To address .* issues|Run `npm (?:audit|fund)`)|packages are looking for funding/i;
function buildOutput(input) {
  const errors = [], warnings = [], deprecated = [], summaries = [];
  let warningCount = 0, deprecatedCount = 0, compiled = 0, downloaded = 0;
  let diagnostic = false, offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const text = row.trim();
    const continuation = diagnostic && text !== "" && /^\s*(?:-->|\||\d+\s*\||=)/.test(row);
    if (continuation) errors.push(row);
    else {
      diagnostic = false;
      if (/^(?:npm (?:ERR!|error)|yarn error|\[ERROR\]|BUILD FAILED)/i.test(text)) errors.push(row);
      else if (/^npm warn deprecated/i.test(text)) {
        deprecatedCount++;
        if (deprecated.length < 3) deprecated.push(row);
      } else if (/^(?:npm warn|yarn warn|\[WARNING\])/i.test(text)) {
        warningCount++;
        if (warnings.length < 5) warnings.push(row);
      } else if (/^error(?:\[|:)/i.test(text) || text.startsWith("error -->")) {
        errors.push(row);
        diagnostic = true;
      } else if (/^warning(?:\[|:)/i.test(text) || text.startsWith("warning -->")) {
        warningCount++;
        if (warnings.length < 5) warnings.push(row);
        diagnostic = true;
      } else if (/^Compiling\s+\S+/i.test(text)) compiled++;
      else if (/^(?:Downloading\s+\S+|Fetching\s+)/i.test(text)) downloaded++;
      else if (summaryPattern.test(text)) summaries.push(row);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  const output = deprecated;
  if (deprecatedCount > 3) output.push(`... +${deprecatedCount - 3} more deprecated packages`);
  if (compiled) output.push(`Compiled ${compiled} packages`);
  if (downloaded) output.push(`Downloaded ${downloaded} packages`);
  let result2 = output.join("\n");
  for (const row of errors) result2 += `${result2 ? "\n" : ""}${row}`;
  for (const row of warnings) result2 += `${result2 ? "\n" : ""}${row}`;
  if (warningCount > 5) result2 += `${result2 ? "\n" : ""}... +${warningCount - 5} more warnings`;
  for (const row of summaries) result2 += `${result2 ? "\n" : ""}${row}`;
  return result2 || input;
}
buildOutput.filterName = "build-output";

// src/token-saver/rtk/hitLine.js
function splitGrepHit(row) {
  const drive = /^[A-Za-z]:[\\/]/.test(row);
  const delimiter = row.indexOf(":", drive ? 2 : 0);
  const valueStart = delimiter < 0 ? -1 : row.indexOf(":", delimiter + 1);
  return valueStart < 0 ? null : {
    file: row.substring(0, delimiter),
    line: row.substring(delimiter + 1, valueStart),
    content: row.substring(valueStart + 1)
  };
}
function isGrepHit(row) {
  const hit = splitGrepHit(row);
  return hit !== null && /^\d+$/.test(hit.line) && /[\\/.]/.test(hit.file) && !/\s/.test(hit.file);
}
function parseGrepOutput(text) {
  const hits = [];
  let offset = 0;
  while (offset <= text.length) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const row = text.slice(offset, end);
    if (row.trim()) {
      const hit = splitGrepHit(row);
      if (hit === null || !hit.file.trim() || !/^\d+$/.test(hit.line)) return null;
      hits.push(hit);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  return hits.length ? hits : null;
}

// src/token-saver/rtk/filters/grep.js
function grep(input) {
  const groups = /* @__PURE__ */ new Map();
  let total = 0;
  let offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    if (row.trim()) {
      const hit = splitGrepHit(row);
      if (!hit || !hit.file.trim() || !/^\d+$/.test(hit.line)) return input;
      total++;
      let group = groups.get(hit.file);
      if (!group) {
        group = { count: 0, samples: [] };
        groups.set(hit.file, group);
      }
      group.count++;
      if (group.samples.length < GREP_PER_FILE_MAX) {
        group.samples.push(`  ${hit.line.padStart(4)}: ${hit.content.trim()}
`);
      }
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (!total) return input;
  const output = [`${total} matches in ${groups.size}F:

`];
  for (const file of [...groups.keys()].sort()) {
    const { count, samples } = groups.get(file);
    output.push(`[file] ${file} (${count}):
`, ...samples);
    if (count > samples.length) output.push(`  +${count - samples.length}
`);
    output.push("\n");
  }
  return output.join("");
}
grep.filterName = "grep";

// src/token-saver/rtk/filters/find.js
function find(input) {
  const groups = /* @__PURE__ */ new Map();
  let total = 0;
  let start = 0;
  while (start <= input.length) {
    const newline = input.indexOf("\n", start);
    const end = newline < 0 ? input.length : newline;
    const path = input.slice(start, end);
    if (path.trim()) {
      total++;
      const separator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
      const directory = separator < 0 ? "." : path.slice(0, separator) || "/";
      let group = groups.get(directory);
      if (!group) {
        group = { count: 0, names: [] };
        groups.set(directory, group);
      }
      group.count++;
      if (group.names.length < FIND_PER_DIR_MAX) group.names.push(path.slice(separator + 1));
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  if (!total) return input;
  const directories = [...groups.keys()].sort();
  const output = [`${total} files in ${directories.length} dirs:

`];
  for (const directory of directories.slice(0, FIND_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory);
    output.push(`${directory.replace(/\\/g, "/")}/  (${count})
`);
    for (const name of names) output.push(`  ${name}
`);
    if (count > names.length) output.push(`  +${count - names.length}
`);
  }
  if (directories.length > FIND_TOTAL_DIR_MAX) output.push(`
+${directories.length - FIND_TOTAL_DIR_MAX} more dirs
`);
  return output.join("");
}
find.filterName = "find";

// src/token-saver/rtk/filters/dedupLog.js
function dedupLog(input) {
  const output = [];
  let offset = 0;
  let previous;
  let duplicates = 0;
  let blank = false;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const empty = row.trim() === "";
    if (!empty && row === previous) duplicates++;
    else {
      if (empty && !blank) output.push(row);
      if (duplicates) output.push(`  ... (${duplicates} duplicate lines)`);
      duplicates = 0;
      previous = empty ? void 0 : row;
      if (!empty) {
        output.push(row);
        if (output.length >= DEDUP_LINE_MAX) {
          output.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
          return output.join("\n");
        }
      }
    }
    blank = empty;
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (duplicates) output.push(`  ... (${duplicates} duplicate lines)`);
  return output.join("\n");
}
dedupLog.filterName = "dedup-log";

// src/token-saver/rtk/filters/ls.js
var excluded = new Set(LS_NOISE_DIRS);
var dateColumn = /\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(?:\d{4}|\d{2}:\d{2})\s+/;
function ls(input) {
  let directories = "", files = "", directoryCount = 0, fileCount = 0;
  const extensions = /* @__PURE__ */ new Map();
  let offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const date = row.startsWith("total ") ? null : dateColumn.exec(row);
    if (date) {
      const name = row.slice(date.index + date[0].length);
      const columns = row.slice(0, date.index).trim().split(/\s+/);
      if (columns.length >= 4 && name !== "." && name !== ".." && !excluded.has(name)) {
        const type = columns[0][0];
        if (type === "d") {
          directories += `${name}/
`;
          directoryCount++;
        } else if (type === "-" || type === "l") {
          let bytes = 0;
          for (let index = columns.length - 1; index >= 0; index--) {
            const number = Number(columns[index]);
            if (Number.isInteger(number) && String(number) === columns[index]) {
              bytes = number;
              break;
            }
          }
          const size = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)}M` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}K` : `${bytes}B`;
          files += `${name}  ${size}
`;
          fileCount++;
          const dot = name.lastIndexOf(".");
          const extension = dot > 0 ? name.slice(dot) : "no ext";
          extensions.set(extension, (extensions.get(extension) ?? 0) + 1);
        }
      }
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (!directoryCount && !fileCount) return input;
  let summary = `
Summary: ${fileCount} files, ${directoryCount} dirs`;
  if (extensions.size) {
    const ranked = [...extensions].sort((a, b) => b[1] - a[1]);
    const labels = ranked.slice(0, LS_EXT_SUMMARY_TOP).map(([extension, count]) => `${count} ${extension}`);
    if (ranked.length > LS_EXT_SUMMARY_TOP) labels.push(`+${ranked.length - LS_EXT_SUMMARY_TOP} more`);
    summary += ` (${labels.join(", ")})`;
  }
  return directories + files + summary;
}
ls.filterName = "ls";

// src/token-saver/rtk/filters/tree.js
function tree(input) {
  const retained = [];
  let count = 0;
  let lastContent = 0;
  let offset = 0;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end);
    const content = row.trim() !== "";
    if (!(row.includes("director") && row.includes("file")) && (count > 0 || content)) {
      count++;
      if (content) lastContent = count;
      if (retained.length < TREE_MAX_LINES) retained.push(row);
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  retained.length = Math.min(retained.length, lastContent);
  if (lastContent > TREE_MAX_LINES) retained.push(`... +${lastContent - TREE_MAX_LINES} more lines`);
  return retained.join("\n");
}
tree.filterName = "tree";

// src/token-saver/rtk/filters/smartTruncate.js
function truncateWindow(input, suffix) {
  let count = 1;
  let headEnd = input.length;
  let position = input.indexOf("\n");
  while (position !== -1) {
    if (count === SMART_TRUNCATE_HEAD) headEnd = position;
    count++;
    position = input.indexOf("\n", position + 1);
  }
  if (count < SMART_TRUNCATE_MIN_LINES) return input;
  let tailStart = input.length;
  for (let line = 0; line < SMART_TRUNCATE_TAIL; line++) {
    tailStart = input.lastIndexOf("\n", tailStart - 1);
  }
  const removed = count - SMART_TRUNCATE_HEAD - SMART_TRUNCATE_TAIL;
  return `${input.slice(0, headEnd)}
... +${removed} lines truncated${suffix}
${input.slice(tailStart + 1)}`;
}
function smartTruncate(input) {
  return truncateWindow(input, "");
}
smartTruncate.filterName = "smart-truncate";

// src/token-saver/rtk/filters/readNumbered.js
var READ_NUMBERED_LINE_RE = /^\s*\d+\|/;
function readNumbered(input) {
  return truncateWindow(input, " (file continues)");
}
readNumbered.filterName = "read-numbered";

// src/token-saver/rtk/filters/searchList.js
var SEARCH_LIST_HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;
function searchList(input) {
  const firstBreak = input.indexOf("\n");
  if (firstBreak < 0) return input;
  const groups = /* @__PURE__ */ new Map();
  let total = 0;
  let offset = firstBreak + 1;
  while (offset <= input.length) {
    const newline = input.indexOf("\n", offset);
    const end = newline < 0 ? input.length : newline;
    const row = input.slice(offset, end).trim();
    if (row.startsWith("- ")) {
      const path = row.slice(2);
      const slash = path.lastIndexOf("/");
      const directory = slash < 0 ? "." : path.slice(0, slash) || "/";
      let group = groups.get(directory);
      if (!group) {
        group = { count: 0, names: [] };
        groups.set(directory, group);
      }
      total++;
      group.count++;
      if (group.names.length < SEARCH_LIST_PER_DIR_MAX) group.names.push(path.slice(slash + 1));
    }
    if (newline < 0) break;
    offset = newline + 1;
  }
  if (!total) return input;
  const output = [input.slice(0, firstBreak), `${total} files in ${groups.size} dirs:`, ""];
  for (const directory of [...groups.keys()].sort().slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const { count, names } = groups.get(directory);
    output.push(`${directory}/ (${count}):`);
    for (const name of names) output.push(`  ${name}`);
    if (count > names.length) output.push(`  +${count - names.length}`);
    output.push("");
  }
  if (groups.size > SEARCH_LIST_TOTAL_DIR_MAX) output.push(`+${groups.size - SEARCH_LIST_TOTAL_DIR_MAX} more dirs`);
  return output.join("\n").replace(/\n+$/, "");
}
searchList.filterName = "search-list";

// src/token-saver/rtk/autodetect.js
function autoDetectFilter(text) {
  const head = text.slice(0, DETECT_WINDOW);
  if (/^[*|/\\ ]*commit [0-9a-f]{7,40}$/m.test(head)) return gitLog;
  if (/^(?:diff --git |@@ )/m.test(head)) return gitDiff;
  if (/^(?:On branch |nothing to commit|Changes (?:not |to be )|Untracked files:)/m.test(head)) return gitStatus;
  if (/^(?:npm (?:warn|error|ERR!)|yarn (?:warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (?:SUCCESS|FAILED)|\s*Finished\s+|Successfully (?:installed|built)|ERROR:)/im.test(head)) return buildOutput;
  const lines = head.split("\n");
  let nonempty = 0, porcelain = 0, paths = 0, listings = 0, numbered = 0, sample = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (index < 100 && line.length) {
      sample++;
      if (READ_NUMBERED_LINE_RE.test(line)) numbered++;
    }
    if (/^[-dlbcps][rwx-]{9}/.test(line)) listings++;
    if (!trimmed) continue;
    nonempty++;
    if (/^(?!  )[ MADRCU?!][ MADRCU?!] \S/.test(line)) porcelain++;
    if (/^[A-Za-z]:[\\/]/.test(trimmed) || !trimmed.includes(":") && (trimmed.startsWith(".") || trimmed.includes("/"))) paths++;
  }
  if (nonempty >= 3 && porcelain / nonempty >= 0.6) return gitStatus;
  let sampled = 0, candidate = false, pathCandidate = false;
  for (let offset = 0; offset < text.length && sampled < 5; ) {
    const newline = text.indexOf("\n", offset);
    const end = newline < 0 ? text.length : newline;
    const line = text.slice(offset, end);
    if (line.trim()) {
      sampled++;
      const hit = splitGrepHit(line);
      if (hit && /^\d+$/.test(hit.line)) candidate = true;
      if (isGrepHit(line)) pathCandidate = true;
    }
    offset = end + 1;
  }
  if (candidate) return pathCandidate && parseGrepOutput(text) !== null ? grep : null;
  if (nonempty >= 3 && paths === nonempty) return find;
  if (/[├└]──|│  /.test(head)) return tree;
  if (/^total \d+$/m.test(head) || listings >= 3) return ls;
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && sample >= 5 && numbered / sample >= READ_NUMBERED_MIN_HIT_RATIO) return readNumbered;
  if (nonempty >= 5) return dedupLog;
  let count = 1, position = -1;
  while (count < SMART_TRUNCATE_MIN_LINES) {
    position = text.indexOf("\n", position + 1);
    if (position < 0) return null;
    count++;
  }
  return smartTruncate;
}

// src/token-saver/rtk/applyFilter.js
function safeApply(filter, text) {
  if (typeof filter !== "function") return text;
  try {
    const result2 = filter(text);
    return typeof result2 === "string" ? result2 : text;
  } catch (error) {
    console.warn(`[rtk] warning: filter '${filter.filterName || filter.name || "anonymous"}' panicked \u2014 passing through raw output: ${error?.message || error}`);
    return text;
  }
}

// src/token-saver/rtk/index.js
function compressText(text, stats, shape) {
  const before = text.length;
  stats.bytesBefore += before;
  let result2 = text;
  if (before >= MIN_COMPRESS_SIZE && before <= RAW_CAP) {
    const filter = autoDetectFilter(text);
    if (filter) {
      const candidate = safeApply(filter, text);
      if (candidate.length > 0 && candidate.length < before) {
        result2 = candidate;
        stats.hits.push({ shape, filter: filter.filterName || filter.name, saved: before - candidate.length });
      }
    }
  }
  stats.bytesAfter += result2.length;
  return result2;
}
function transform(owner, key, partType, stringShape, arrayShape, stats) {
  const content = owner[key];
  if (typeof content === "string") owner[key] = compressText(content, stats, stringShape);
  else if (Array.isArray(content)) {
    for (const part of content) {
      if (part && (partType === null || part.type === partType) && typeof part.text === "string") {
        part.text = compressText(part.text, stats, arrayShape);
      }
    }
  }
}
function walk(items, mode, stats) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (!item) continue;
    if ((mode === "auto" || mode === "responses") && item.type === "function_call_output") {
      transform(item, "output", "input_text", "openai-responses-string", "openai-responses-array", stats);
    } else if ((mode === "auto" || mode === "chat") && item.role === "tool") {
      transform(item, "content", "text", "openai-tool", "openai-tool-array", stats);
    } else if ((mode === "auto" || mode === "messages") && Array.isArray(item.content)) {
      for (const block of item.content) {
        if (block?.type === "tool_result" && block.is_error !== true) {
          transform(block, "content", "text", "claude-string", "claude-array", stats);
        }
      }
    }
  }
}
function compressRequest(payload, wire, options = true) {
  const enabled = options !== false && (options === null || typeof options !== "object" || options.enabled !== false);
  const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] };
  if (enabled && payload !== null && typeof payload === "object") {
    try {
      if (wire === "chat" || wire === "messages") walk(payload.messages, wire, stats);
      else if (wire === "responses") walk(payload.input, wire, stats);
    } catch (error) {
      console.warn("[rtk] compressRequest error:", error?.message ?? error);
      stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0);
    }
  }
  stats.saved = stats.bytesBefore - stats.bytesAfter;
  return { payload, stats };
}

// src/token-saver/prompts.js
var CAVEMAN_LEVELS = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"];
var PONYTAIL_LEVELS = ["off", "lite", "full", "ultra"];
var answerBoundary = "Keep code, identifiers, paths, commands, error text and URLs unchanged. Use complete, clear language for security guidance, irreversible decisions and ordered procedures; clarity takes priority over brevity. Do not invent abbreviations. Follow the user's language except when a classical Chinese level is selected. Do not announce this style or add decorative emoji. Apply the selected level throughout the conversation while respecting explicit user instructions.";
var answerLevels = new Map([
  ["lite", "Use short grammatical sentences. Remove filler while retaining the explanation needed to act."],
  ["full", "Prefer compact phrases and direct conclusions. Keep technical detail and necessary reasoning."],
  ["ultra", "Give the smallest unambiguous answer that satisfies the request. Omit repetition, never required facts."],
  ["wenyan-lite", "Use readable Chinese with a light classical register and short sentences."],
  ["wenyan", "Use concise classical Chinese for prose; keep technical material precise and readily understandable."],
  ["wenyan-ultra", "Use very brief classical Chinese prose. Expand whenever compression would make an action ambiguous."]
].map(([level, text]) => [level, `${text} ${answerBoundary}`]));
var codeBoundary = "Implement only the requested behavior. Reuse existing project code, standard libraries and installed dependencies before adding code. Keep responsibility in the relevant module. Avoid speculative abstractions, options and future scaffolding. Preserve validation at trust boundaries, data-loss prevention, security, accessibility and explicit requirements. Verify meaningful behavior with a focused runnable check; trivial changes need no artificial test. Explain material limitations without claiming unperformed verification. Continue this discipline across turns.";
var codeLevels = new Map([
  ["lite", "Make the requested change with minimal additions; mention a simpler alternative only when useful."],
  ["full", "Choose the smallest maintainable implementation and keep the diff focused on the requested capability."],
  ["ultra", "Actively remove unnecessary work and duplication before adding code; preserve every required behavior."]
].map(([level, text]) => [level, `${text} ${codeBoundary}`]));
function cavemanPrompt(level) {
  return answerLevels.get(level) ?? null;
}
function ponytailPrompt(level) {
  return codeLevels.get(level) ?? null;
}
function activePrompts({ caveman, ponytail } = {}) {
  const result2 = [];
  for (const [id, level, lookup] of [["caveman", caveman, cavemanPrompt], ["ponytail", ponytail, ponytailPrompt]]) {
    const text = lookup(level);
    if (text !== null) result2.push({ id, level, text });
  }
  return result2;
}

// src/token-saver/inject.js
var INJECT_MARKER = "<!-- ofm-token-saver -->";
var MARKER_END = "<!-- /ofm-token-saver -->";
var SEP = "\n\n";
var result = (payload, injected, reason) => ({ payload, injected, reason });
function injectSystem(payload, wire, text) {
  try {
    if (payload === null || typeof payload !== "object") return result(payload, false, "shape-not-recognised");
    if (typeof text !== "string" || text === "") return result(payload, false, "no-text");
    const segment = `${INJECT_MARKER}${SEP}${text}${SEP}${MARKER_END}`;
    if (wire === "chat") return injectChat(payload, segment);
    if (wire === "messages") return injectMessages(payload, segment);
    if (wire === "responses") return injectResponses(payload, segment);
    return result(payload, false, "shape-not-recognised");
  } catch {
    return result(payload, false, "inject-failed");
  }
}
var isSystem = (message) => message !== null && typeof message === "object" && (message.role === "system" || message.role === "developer");
var isResponsesSystem = (item) => isSystem(item) && item.type === "message";
function contentHasSegment(content, segment) {
  if (typeof content === "string") return content.includes(segment);
  if (Array.isArray(content)) {
    return content.some((block) => block !== null && typeof block === "object" && typeof block.text === "string" && block.text.includes(segment));
  }
  return false;
}
function injectChat(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, "shape-not-recognised");
  let target;
  for (const message of payload.messages) {
    if (!isSystem(message)) continue;
    if (contentHasSegment(message.content, segment)) return result(payload, false, "already-injected");
    target ??= message;
  }
  if (!target) payload.messages.unshift({ role: "system", content: segment });
  else if (Array.isArray(target.content)) target.content.push({ type: "text", text: segment });
  else target.content = typeof target.content === "string" && target.content ? `${target.content}${SEP}${segment}` : segment;
  return result(payload, true, "injected");
}
function injectMessages(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, "shape-not-recognised");
  const system = payload.system;
  if (contentHasSegment(system, segment)) return result(payload, false, "already-injected");
  if (Array.isArray(system)) {
    let position = system.length;
    for (let i = system.length - 1; i >= 0; i--) {
      if (system[i]?.cache_control) {
        position = i;
        break;
      }
    }
    system.splice(position, 0, { type: "text", text: segment });
  } else if (system == null || typeof system === "string") {
    payload.system = system ? `${system}${SEP}${segment}` : segment;
  } else return result(payload, false, "shape-not-recognised");
  return result(payload, true, "injected");
}
function injectResponses(payload, segment) {
  if (typeof payload.instructions === "string") {
    if (payload.instructions.includes(segment)) return result(payload, false, "already-injected");
    payload.instructions = payload.instructions ? `${payload.instructions}${SEP}${segment}` : segment;
    return result(payload, true, "injected");
  }
  if (!Array.isArray(payload.input)) return result(payload, false, "shape-not-recognised");
  let target;
  for (const item of payload.input) {
    if (!isResponsesSystem(item)) continue;
    if (contentHasSegment(item.content, segment)) return result(payload, false, "already-injected");
    target ??= item;
  }
  const block = { type: "input_text", text: segment };
  if (!target) payload.input.unshift({ type: "message", role: "system", content: [block] });
  else if (Array.isArray(target.content)) target.content.push(block);
  else if (typeof target.content === "string") target.content = target.content ? `${target.content}${SEP}${segment}` : segment;
  else target.content = [block];
  return result(payload, true, "injected");
}

// src/token-saver/index.js
var PROMPT_FAMILIES = ["caveman", "ponytail"];
function saverConfig(settings) {
  const section = settings?.tokenSaver ?? {};
  const prompts = section.prompts ?? {};
  return {
    enabled: section.enabled !== false,
    rtk: section.rtk !== false,
    caveman: PROMPT_FAMILIES.includes("caveman") ? String(prompts.caveman ?? "off") : "off",
    ponytail: String(prompts.ponytail ?? "off")
    /** Per-request header/query opt-out is handled by the caller; this is the
     *  stored preference only. */
  };
}
function applyTokenSavers(payload, wire, config) {
  const report = { prompt: null, rtk: null, saved: 0, bytesBefore: 0, bytesAfter: 0, notes: [] };
  if (config?.enabled === false || payload === null || typeof payload !== "object") return report;
  if (config.caveman !== "off" || config.ponytail !== "off") {
    try {
      const prompts = activePrompts({ caveman: config.caveman, ponytail: config.ponytail });
      if (prompts.length > 0) {
        const text = prompts.map((entry) => entry.text).join("\n\n");
        const result2 = injectSystem(payload, wire, text);
        report.prompt = { injected: result2.injected === true, reason: result2.reason ?? "", families: prompts.map((entry) => `${entry.id}:${entry.level}`) };
        if (result2.injected !== true && result2.reason !== void 0) report.notes.push(`prompt:${result2.reason}`);
      }
    } catch (error) {
      report.notes.push(`prompt-failed:${error?.message ?? error}`);
    }
  }
  if (config.rtk !== false) {
    try {
      const result2 = compressRequest(payload, wire, true);
      report.rtk = result2.stats;
      report.saved = Number(result2.stats?.saved) || 0;
      report.bytesBefore = Number(result2.stats?.bytesBefore) || 0;
      report.bytesAfter = Number(result2.stats?.bytesAfter) || 0;
    } catch (error) {
      report.notes.push(`rtk-failed:${error?.message ?? error}`);
    }
  }
  return report;
}
function emptySavings() {
  return { bytesBefore: 0, bytesAfter: 0, saved: 0, blocks: 0, calls: 0, promptCalls: 0 };
}
function addSavings(total, report) {
  const base = total ?? emptySavings();
  const blocks = Array.isArray(report?.rtk?.hits) ? report.rtk.hits.length : 0;
  return {
    bytesBefore: base.bytesBefore + (Number(report?.bytesBefore) || 0),
    bytesAfter: base.bytesAfter + (Number(report?.bytesAfter) || 0),
    saved: base.saved + (Number(report?.saved) || 0),
    blocks: base.blocks + blocks,
    calls: base.calls + 1,
    promptCalls: base.promptCalls + (report?.prompt?.injected === true ? 1 : 0)
  };
}
function savingsPercent(total) {
  const before = Number(total?.bytesBefore) || 0;
  const saved = Number(total?.saved) || 0;
  if (before <= 0) return 0;
  return Math.round(saved / before * 100);
}
function describeSavingsTotal(total) {
  const safe = total ?? emptySavings();
  const percent = savingsPercent(safe);
  if (safe.calls === 0) return "token saver: no requests measured yet";
  return `token saver: ${formatBytes(safe.saved)} saved over ${safe.calls} request(s) (${percent}%), ${safe.blocks} block(s) compacted`;
}
function formatBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
export {
  CAVEMAN_LEVELS,
  PONYTAIL_LEVELS,
  PROMPT_FAMILIES,
  activePrompts,
  addSavings,
  applyTokenSavers,
  cavemanPrompt,
  describeSavingsTotal,
  emptySavings,
  formatBytes,
  ponytailPrompt,
  saverConfig,
  savingsPercent
};
