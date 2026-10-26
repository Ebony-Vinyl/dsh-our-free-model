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
function gitDiff(diff, maxLines = 500) {
  const result2 = [];
  let currentFile = "";
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let hunkShown = 0;
  let hunkSkipped = 0;
  let wasTruncated = false;
  const maxHunkLines = GIT_DIFF_HUNK_MAX_LINES;
  const lines = diff.split("\n");
  outer: for (const line of lines) {
    if (line.startsWith("diff --git")) {
      if (hunkSkipped > 0) {
        result2.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      if (currentFile && (added > 0 || removed > 0)) {
        result2.push(`  +${added} -${removed}`);
      }
      const parts = line.split(" b/");
      currentFile = parts.length > 1 ? parts.slice(1).join(" b/") : "unknown";
      result2.push(`
${currentFile}`);
      added = 0;
      removed = 0;
      inHunk = false;
      hunkShown = 0;
    } else if (line.startsWith("@@")) {
      if (hunkSkipped > 0) {
        result2.push(`  ... (${hunkSkipped} lines truncated)`);
        wasTruncated = true;
        hunkSkipped = 0;
      }
      inHunk = true;
      hunkShown = 0;
      result2.push(`  ${line}`);
    } else if (inHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) {
        added += 1;
        if (hunkShown < maxHunkLines) {
          result2.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removed += 1;
        if (hunkShown < maxHunkLines) {
          result2.push(`  ${line}`);
          hunkShown += 1;
        } else {
          hunkSkipped += 1;
        }
      } else if (hunkShown < maxHunkLines && !line.startsWith("\\")) {
        if (hunkShown > 0) {
          result2.push(`  ${line}`);
          hunkShown += 1;
        }
      }
    }
    if (result2.length >= maxLines) {
      result2.push("\n... (more changes truncated)");
      wasTruncated = true;
      break outer;
    }
  }
  if (hunkSkipped > 0) {
    result2.push(`  ... (${hunkSkipped} lines truncated)`);
    wasTruncated = true;
  }
  if (currentFile && (added > 0 || removed > 0)) {
    result2.push(`  +${added} -${removed}`);
  }
  if (wasTruncated) {
    result2.push("[full diff: rtk git diff --no-compact]");
  }
  return result2.join("\n");
}
gitDiff.filterName = "git-diff";

// src/token-saver/rtk/filters/gitStatus.js
function gitStatus(input) {
  const lines = input.split("\n");
  if (lines.length === 0 || lines.length === 1 && !lines[0].trim()) {
    return "Clean working tree";
  }
  let branch = "";
  const stagedFiles = [];
  const modifiedFiles = [];
  const untrackedFiles = [];
  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;
  for (const raw of lines) {
    if (!raw.trim()) continue;
    const longBranch = raw.match(/^On branch (\S+)/);
    if (longBranch) {
      branch = longBranch[1];
      continue;
    }
    if (raw.startsWith("##")) {
      branch = raw.replace(/^##\s*/, "");
      continue;
    }
    if (raw.length >= 3 && /^[ MADRCU?!][ MADRCU?!] /.test(raw)) {
      const x = raw[0];
      const y = raw[1];
      const file = raw.slice(3);
      if (raw.slice(0, 2) === "??") {
        untracked++;
        untrackedFiles.push(file);
        continue;
      }
      if ("MADRC".includes(x)) {
        staged++;
        stagedFiles.push(file);
      } else if (x === "U") {
        conflicts++;
      }
      if (y === "M" || y === "D") {
        modified++;
        modifiedFiles.push(file);
      }
      continue;
    }
    const longMatch = raw.match(/^\s*(modified|new file|deleted|renamed|both modified):\s+(.+)$/);
    if (longMatch) {
      const kind = longMatch[1];
      const path = longMatch[2].trim();
      if (kind === "both modified") {
        conflicts++;
      } else if (kind === "modified" || kind === "deleted") {
        modified++;
        modifiedFiles.push(path);
      } else if (kind === "new file" || kind === "renamed") {
        staged++;
        stagedFiles.push(path);
      }
      continue;
    }
  }
  let out = "";
  if (branch) out += `* ${branch}
`;
  if (staged > 0) {
    out += `+ Staged: ${staged} files
`;
    for (const f of stagedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}
`;
    if (stagedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${stagedFiles.length - STATUS_MAX_FILES} more
`;
    }
  }
  if (modified > 0) {
    out += `~ Modified: ${modified} files
`;
    for (const f of modifiedFiles.slice(0, STATUS_MAX_FILES)) out += `   ${f}
`;
    if (modifiedFiles.length > STATUS_MAX_FILES) {
      out += `   ... +${modifiedFiles.length - STATUS_MAX_FILES} more
`;
    }
  }
  if (untracked > 0) {
    out += `? Untracked: ${untracked} files
`;
    for (const f of untrackedFiles.slice(0, STATUS_MAX_UNTRACKED)) out += `   ${f}
`;
    if (untrackedFiles.length > STATUS_MAX_UNTRACKED) {
      out += `   ... +${untrackedFiles.length - STATUS_MAX_UNTRACKED} more
`;
    }
  }
  if (conflicts > 0) {
    out += `conflicts: ${conflicts} files
`;
  }
  if (staged === 0 && modified === 0 && untracked === 0 && conflicts === 0) {
    out += "clean \u2014 nothing to commit\n";
  }
  return out.replace(/\n+$/, "");
}
gitStatus.filterName = "git-status";

// src/token-saver/rtk/filters/gitLog.js
function gitLog(text, maxLines = GIT_LOG_MAX_LINES) {
  if (!text) return "";
  const input = String(text);
  const lines = input.split("\n");
  const out = [];
  let skipped = 0;
  let inCommit = false;
  let subjectSeen = false;
  function pushLine(l) {
    if (out.length < maxLines) {
      out.push(l);
      return true;
    }
    skipped++;
    return false;
  }
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (/^commit [0-9a-f]{7,40}$/i.test(trimmed) || /^[*|/\\ ]+commit [0-9a-f]{7,40}/i.test(trimmed)) {
      inCommit = true;
      subjectSeen = false;
      pushLine(line);
      continue;
    }
    if (inCommit) {
      if (/^[*|/\\ ]*(Author|Date):/i.test(trimmed)) {
        pushLine(trimmed);
        continue;
      }
      if (trimmed === "") continue;
      if (!subjectSeen && /^[*|/\\ ]*    \S/.test(line)) {
        pushLine("  Subject: " + trimmed);
        subjectSeen = true;
        continue;
      }
      if (/^\d+ file\w* changed/.test(trimmed)) {
        pushLine("  " + trimmed);
        continue;
      }
      if (/^diff --git /.test(trimmed)) {
        pushLine("  ... diff body omitted");
        continue;
      }
      continue;
    }
    const graphMatch = trimmed.match(/^[*|/\\ ]+([0-9a-f]{7,40}\s+.+)/i);
    if (graphMatch) {
      pushLine(graphMatch[1]);
      continue;
    }
    if (/^[0-9a-f]{7,40}\s+/.test(trimmed)) {
      pushLine(trimmed);
      continue;
    }
    if (/^[*|/\\ ]+$/.test(trimmed) && /[*|/\\]/.test(trimmed)) {
      continue;
    }
    pushLine(trimmed);
  }
  if (skipped > 0) out.push(`... (${skipped} more lines)`);
  const result2 = out.join("\n");
  if (!result2 && input) return input;
  if (result2.length > input.length) return input;
  return result2;
}
gitLog.filterName = "git-log";

// src/token-saver/rtk/filters/buildOutput.js
var RE_CARGO_ERR_CONT = /^\s*(-->|\||\d+\s*\||=)/;
var DEPRECATION_KEEP = 3;
function buildOutput(input) {
  const lines = input.split("\n");
  if (lines.length === 0) return input;
  const errors = [];
  const warnings = [];
  const deprecations = [];
  let summary = null;
  let compilingCount = 0;
  let downloadingCount = 0;
  let inCargoError = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (inCargoError) {
      if (!trimmed) {
        inCargoError = false;
        continue;
      }
      if (RE_CARGO_ERR_CONT.test(line)) {
        errors.push(line);
        continue;
      }
      inCargoError = false;
    }
    if (!trimmed) continue;
    if (/^npm (ERR!|error)/i.test(trimmed) || /^yarn error/i.test(trimmed)) {
      errors.push(line);
      continue;
    }
    if (/^npm warn deprecated/i.test(trimmed)) {
      deprecations.push(line);
      continue;
    }
    if (/^npm warn/i.test(trimmed) || /^yarn warn/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }
    if (/^error(\[|:)/i.test(trimmed) || trimmed.startsWith("error -->")) {
      errors.push(line);
      inCargoError = true;
      continue;
    }
    if (/^warning(\[|:)/i.test(trimmed) || trimmed.startsWith("warning -->")) {
      warnings.push(line);
      inCargoError = true;
      continue;
    }
    if (/^ERROR:/i.test(trimmed)) {
      errors.push(line);
      continue;
    }
    if (/^\[ERROR\]/i.test(trimmed) || /^BUILD FAILED/i.test(trimmed)) {
      errors.push(line);
      continue;
    }
    if (/^\[WARNING\]/i.test(trimmed)) {
      warnings.push(line);
      continue;
    }
    if (/^\s*Compiling\s+\S+/i.test(trimmed)) {
      compilingCount++;
      continue;
    }
    if (/^\s*Downloading\s+\S+/i.test(trimmed) || /^Fetching\s+/i.test(trimmed)) {
      downloadingCount++;
      continue;
    }
    if (/^(added|removed|changed|audited|installed)\s+\d+\s+package/i.test(trimmed) || /^\s*Finished\s+/i.test(trimmed) || /^BUILD SUCCESS/i.test(trimmed) || /^\d+\s+(vulnerabilities|packages?|warnings?|errors?)/i.test(trimmed) || /^Successfully (installed|built)/i.test(trimmed) || /^To address .* issues/i.test(trimmed) || /^Run `npm (audit|fund)`/i.test(trimmed) || /packages are looking for funding/i.test(trimmed)) {
      summary = summary ? `${summary}
${line}` : line;
      continue;
    }
  }
  let out = "";
  const keepDep = deprecations.slice(0, DEPRECATION_KEEP);
  for (const d of keepDep) out += `${d}
`;
  if (deprecations.length > DEPRECATION_KEEP) {
    out += `... +${deprecations.length - DEPRECATION_KEEP} more deprecated packages
`;
  }
  if (compilingCount > 0) {
    out += `Compiled ${compilingCount} packages
`;
  }
  if (downloadingCount > 0) {
    out += `Downloaded ${downloadingCount} packages
`;
  }
  for (const e of errors) out += `${e}
`;
  const keepWarnings = warnings.slice(0, 5);
  for (const w of keepWarnings) out += `${w}
`;
  if (warnings.length > 5) {
    out += `... +${warnings.length - 5} more warnings
`;
  }
  if (summary) out += `${summary}
`;
  return out.replace(/\n+$/, "") || input;
}
buildOutput.filterName = "build-output";

// src/token-saver/rtk/hitLine.js
var RE_DRIVE_PREFIX = /^[A-Za-z]:[\\/]/;
var RE_PATH_SHAPE = /[\\/.]/;
var RE_PATH_REJECT = /\s/;
function splitGrepHit(line) {
  const start = RE_DRIVE_PREFIX.test(line) ? 2 : 0;
  const first = line.indexOf(":", start);
  if (first === -1) return null;
  const second = line.indexOf(":", first + 1);
  if (second === -1) return null;
  return {
    file: line.slice(0, first),
    line: line.slice(first + 1, second),
    content: line.slice(second + 1)
  };
}
function isGrepHit(line) {
  const hit = splitGrepHit(line);
  if (hit === null) return false;
  if (!/^\d+$/.test(hit.line)) return false;
  if (hit.file === "" || RE_PATH_REJECT.test(hit.file)) return false;
  return RE_PATH_SHAPE.test(hit.file);
}
function parseGrepOutput(text) {
  const hits = [];
  for (const row of text.split("\n")) {
    if (row.trim() === "") continue;
    const hit = splitGrepHit(row);
    if (hit === null || hit.file.trim() === "" || !/^\d+$/.test(hit.line)) return null;
    hits.push(hit);
  }
  return hits.length > 0 ? hits : null;
}

// src/token-saver/rtk/filters/grep.js
function grep(input) {
  const hits = parseGrepOutput(input);
  if (hits === null) return input;
  const byFile = /* @__PURE__ */ new Map();
  const total = hits.length;
  for (const { file, line: lineNumStr, content } of hits) {
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push([lineNumStr, content]);
  }
  const files = Array.from(byFile.keys()).sort();
  let out = `${total} matches in ${files.length}F:

`;
  for (const file of files) {
    const matches = byFile.get(file);
    out += `[file] ${file} (${matches.length}):
`;
    const show = matches.slice(0, GREP_PER_FILE_MAX);
    for (const [lineNum, content] of show) {
      out += `  ${lineNum.padStart(4)}: ${content.trim()}
`;
    }
    if (matches.length > GREP_PER_FILE_MAX) {
      out += `  +${matches.length - GREP_PER_FILE_MAX}
`;
    }
    out += "\n";
  }
  return out;
}
grep.filterName = "grep";

// src/token-saver/rtk/filters/find.js
function find(input) {
  const lines = input.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return input;
  const byDir = /* @__PURE__ */ new Map();
  for (const path of lines) {
    const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    let dir;
    let basename;
    if (lastSep === -1) {
      dir = ".";
      basename = path;
    } else {
      dir = path.slice(0, lastSep) || "/";
      basename = path.slice(lastSep + 1);
    }
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(basename);
  }
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${lines.length} files in ${dirs.length} dirs:

`;
  const showDirs = dirs.slice(0, FIND_TOTAL_DIR_MAX);
  for (const dir of showDirs) {
    const files = byDir.get(dir);
    const dirLabel = dir.replace(/\\/g, "/");
    out += `${dirLabel}/  (${files.length})
`;
    const showFiles = files.slice(0, FIND_PER_DIR_MAX);
    for (const f of showFiles) out += `  ${f}
`;
    if (files.length > FIND_PER_DIR_MAX) {
      out += `  +${files.length - FIND_PER_DIR_MAX}
`;
    }
  }
  if (dirs.length > FIND_TOTAL_DIR_MAX) {
    out += `
+${dirs.length - FIND_TOTAL_DIR_MAX} more dirs
`;
  }
  return out;
}
find.filterName = "find";

// src/token-saver/rtk/filters/dedupLog.js
function dedupLog(input) {
  const lines = input.split("\n");
  const out = [];
  let prev = null;
  let runCount = 0;
  let blankStreak = 0;
  const flushRun = () => {
    if (prev !== null && runCount > 1) {
      out.push(`  ... (${runCount - 1} duplicate lines)`);
    }
  };
  for (const line of lines) {
    if (line.trim() === "") {
      if (blankStreak < 1) out.push(line);
      blankStreak += 1;
      flushRun();
      prev = null;
      runCount = 0;
      continue;
    }
    blankStreak = 0;
    if (line === prev) {
      runCount += 1;
      continue;
    }
    flushRun();
    out.push(line);
    prev = line;
    runCount = 1;
    if (out.length >= DEDUP_LINE_MAX) {
      out.push(`... (truncated at ${DEDUP_LINE_MAX} lines)`);
      return out.join("\n");
    }
  }
  flushRun();
  return out.join("\n");
}
dedupLog.filterName = "dedup-log";

// src/token-saver/rtk/filters/ls.js
var LS_DATE_RE = /\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+(\d{4}|\d{2}:\d{2})\s+/;
function humanSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)}M`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${bytes}B`;
}
function parseLsLine(line) {
  const m = LS_DATE_RE.exec(line);
  if (!m) return null;
  const name = line.slice(m.index + m[0].length);
  const beforeDate = line.slice(0, m.index);
  const beforeParts = beforeDate.split(/\s+/).filter(Boolean);
  if (beforeParts.length < 4) return null;
  const perms = beforeParts[0];
  const fileType = perms.charAt(0);
  let size = 0;
  for (let i = beforeParts.length - 1; i >= 0; i--) {
    const n = Number(beforeParts[i]);
    if (Number.isInteger(n) && String(n) === beforeParts[i]) {
      size = n;
      break;
    }
  }
  return { fileType, size, name };
}
function ls(input) {
  const dirs = [];
  const files = [];
  const byExt = /* @__PURE__ */ new Map();
  for (const line of input.split("\n")) {
    if (line.startsWith("total ") || line.length === 0) continue;
    const parsed = parseLsLine(line);
    if (!parsed) continue;
    if (parsed.name === "." || parsed.name === "..") continue;
    if (LS_NOISE_DIRS.includes(parsed.name)) continue;
    if (parsed.fileType === "d") {
      dirs.push(parsed.name);
    } else if (parsed.fileType === "-" || parsed.fileType === "l") {
      const dot = parsed.name.lastIndexOf(".");
      const ext = dot > 0 ? parsed.name.slice(dot) : "no ext";
      byExt.set(ext, (byExt.get(ext) || 0) + 1);
      files.push([parsed.name, humanSize(parsed.size)]);
    }
  }
  if (dirs.length === 0 && files.length === 0) return input;
  let out = "";
  for (const d of dirs) out += `${d}/
`;
  for (const [name, size] of files) out += `${name}  ${size}
`;
  let summary = `
Summary: ${files.length} files, ${dirs.length} dirs`;
  if (byExt.size > 0) {
    const ext = Array.from(byExt.entries()).sort((a, b) => b[1] - a[1]);
    const parts = ext.slice(0, LS_EXT_SUMMARY_TOP).map(([e, c]) => `${c} ${e}`);
    summary += ` (${parts.join(", ")}`;
    if (ext.length > LS_EXT_SUMMARY_TOP) {
      summary += `, +${ext.length - LS_EXT_SUMMARY_TOP} more`;
    }
    summary += ")";
  }
  return out + summary;
}
ls.filterName = "ls";

// src/token-saver/rtk/filters/tree.js
function tree(input) {
  const lines = input.split("\n");
  if (lines.length === 0) return input;
  const filtered = [];
  for (const line of lines) {
    if (line.includes("director") && line.includes("file")) continue;
    if (line.trim() === "" && filtered.length === 0) continue;
    filtered.push(line);
  }
  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop();
  }
  if (filtered.length > TREE_MAX_LINES) {
    const cut = filtered.length - TREE_MAX_LINES;
    return filtered.slice(0, TREE_MAX_LINES).join("\n") + `
... +${cut} more lines`;
  }
  return filtered.join("\n");
}
tree.filterName = "tree";

// src/token-saver/rtk/filters/smartTruncate.js
function smartTruncate(input) {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [...head, `... +${cut} lines truncated`, ...tail].join("\n");
}
smartTruncate.filterName = "smart-truncate";

// src/token-saver/rtk/filters/readNumbered.js
var LINE_RE = /^\s*\d+\|/;
function readNumbered(input) {
  const lines = input.split("\n");
  if (lines.length < SMART_TRUNCATE_MIN_LINES) return input;
  const head = lines.slice(0, SMART_TRUNCATE_HEAD);
  const tail = lines.slice(lines.length - SMART_TRUNCATE_TAIL);
  const cut = lines.length - head.length - tail.length;
  return [
    ...head,
    `... +${cut} lines truncated (file continues)`,
    ...tail
  ].join("\n");
}
readNumbered.filterName = "read-numbered";
var READ_NUMBERED_LINE_RE = LINE_RE;

// src/token-saver/rtk/filters/searchList.js
var HEADER_RE = /^Result of search in '[^']*' \(total (\d+) files?\):/;
function searchList(input) {
  const lines = input.split("\n");
  if (lines.length === 0) return input;
  const header = lines[0] || "";
  const rest = lines.slice(1);
  const paths = [];
  for (const raw of rest) {
    const t = raw.trim();
    if (!t.startsWith("- ")) continue;
    paths.push(t.slice(2));
  }
  if (paths.length === 0) return input;
  const byDir = /* @__PURE__ */ new Map();
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const dir = slash === -1 ? "." : p.slice(0, slash) || "/";
    const name = slash === -1 ? p : p.slice(slash + 1);
    if (!byDir.has(dir)) byDir.set(dir, []);
    byDir.get(dir).push(name);
  }
  const dirs = Array.from(byDir.keys()).sort();
  let out = `${header}
${paths.length} files in ${dirs.length} dirs:

`;
  for (const dir of dirs.slice(0, SEARCH_LIST_TOTAL_DIR_MAX)) {
    const names = byDir.get(dir);
    out += `${dir}/ (${names.length}):
`;
    for (const n of names.slice(0, SEARCH_LIST_PER_DIR_MAX)) out += `  ${n}
`;
    if (names.length > SEARCH_LIST_PER_DIR_MAX) {
      out += `  +${names.length - SEARCH_LIST_PER_DIR_MAX}
`;
    }
    out += "\n";
  }
  if (dirs.length > SEARCH_LIST_TOTAL_DIR_MAX) {
    out += `+${dirs.length - SEARCH_LIST_TOTAL_DIR_MAX} more dirs
`;
  }
  return out.replace(/\n+$/, "");
}
searchList.filterName = "search-list";
var SEARCH_LIST_HEADER_RE = HEADER_RE;

// src/token-saver/rtk/autodetect.js
var RE_GIT_DIFF = /^diff --git /m;
var RE_GIT_DIFF_HUNK = /^@@ /m;
var RE_GIT_STATUS = /^On branch |^nothing to commit|^Changes (not |to be )|^Untracked files:/m;
var RE_GIT_LOG = /^[*|/\\ ]*commit [0-9a-f]{7,40}$/m;
var RE_PORCELAIN = /^(?!  )[ MADRCU?!][ MADRCU?!] \S/m;
var RE_BUILD_OUTPUT = /^(npm (warn|error|ERR!)|yarn (warn|error)|\s*Compiling\s+\S+|\s*Downloading\s+\S+|added \d+ package|\[ERROR\]|BUILD (SUCCESS|FAILED)|\s*Finished\s+|Successfully (installed|built)|ERROR:)/im;
var RE_TREE_GLYPH = /[├└]──|│  /;
var RE_LS_ROW = /^[-dlbcps][rwx-]{9}/m;
var RE_LS_TOTAL = /^total \d+$/m;
function autoDetectFilter(text) {
  const head = text.length > DETECT_WINDOW ? text.slice(0, DETECT_WINDOW) : text;
  if (RE_GIT_LOG.test(head)) return gitLog;
  if (RE_GIT_DIFF.test(head) || RE_GIT_DIFF_HUNK.test(head)) return gitDiff;
  if (RE_GIT_STATUS.test(head)) return gitStatus;
  if (RE_BUILD_OUTPUT.test(head)) return buildOutput;
  if (isMostlyPorcelain(head)) return gitStatus;
  const lines = head.split("\n");
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const first5 = [];
  for (let start = 0; start < text.length && first5.length < 5; ) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const line = text.slice(start, end);
    if (line.trim()) first5.push(line);
    start = end + 1;
  }
  const hasCandidate = first5.some((line) => {
    const hit = splitGrepHit(line);
    return hit !== null && /^\d+$/.test(hit.line);
  });
  if (hasCandidate) {
    return first5.some(isGrepHit) && parseGrepOutput(text) !== null ? grep : null;
  }
  if (nonEmpty.length >= 3 && nonEmpty.every(isPathLike)) return find;
  if (RE_TREE_GLYPH.test(head)) return tree;
  if (RE_LS_TOTAL.test(head) || countMatches(head, RE_LS_ROW) >= 3) return ls;
  if (SEARCH_LIST_HEADER_RE.test(head)) return searchList;
  if (lines.length >= SMART_TRUNCATE_MIN_LINES && isLineNumbered(lines)) {
    return readNumbered;
  }
  if (nonEmpty.length >= 5) return dedupLog;
  if (text.split("\n").length >= SMART_TRUNCATE_MIN_LINES) return smartTruncate;
  return null;
}
function isPathLike(line) {
  const t = line.trim();
  if (t.length === 0) return false;
  if (/^[A-Za-z]:[\\/]/.test(t)) return true;
  if (t.includes(":")) return false;
  return t.startsWith(".") || t.startsWith("/") || t.includes("/");
}
function isMostlyPorcelain(head) {
  const lines = head.split("\n").filter((l) => l.trim());
  if (lines.length < 3) return false;
  const hits = lines.filter((l) => RE_PORCELAIN.test(l)).length;
  return hits / lines.length >= 0.6;
}
function isLineNumbered(lines) {
  let hits = 0;
  let nonEmpty = 0;
  const sample = lines.slice(0, 100);
  for (const l of sample) {
    if (l.length === 0) continue;
    nonEmpty++;
    if (READ_NUMBERED_LINE_RE.test(l)) hits++;
  }
  if (nonEmpty < 5) return false;
  return hits / nonEmpty >= READ_NUMBERED_MIN_HIT_RATIO;
}
function countMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) || []).length;
}

// src/token-saver/rtk/applyFilter.js
function safeApply(fn, text) {
  if (typeof fn !== "function") return text;
  try {
    const out = fn(text);
    if (typeof out !== "string") return text;
    return out;
  } catch (err) {
    const name = fn.filterName || fn.name || "anonymous";
    console.warn(`[rtk] warning: filter '${name}' panicked \u2014 passing through raw output: ${err?.message || err}`);
    return text;
  }
}

// src/token-saver/rtk/index.js
function compressText(text, stats, shape) {
  const bytesIn = text.length;
  stats.bytesBefore += bytesIn;
  if (bytesIn < MIN_COMPRESS_SIZE || bytesIn > RAW_CAP) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  const fn = autoDetectFilter(text);
  if (!fn) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  const out = safeApply(fn, text);
  if (!out || out.length === 0 || out.length >= bytesIn) {
    stats.bytesAfter += bytesIn;
    return text;
  }
  stats.bytesAfter += out.length;
  stats.hits.push({ shape, filter: fn.filterName || fn.name, saved: bytesIn - out.length });
  return out;
}
function compressRequest(payload, wire, options = true) {
  const enabled = resolveEnabled(options);
  const stats = { enabled, bytesBefore: 0, bytesAfter: 0, saved: 0, hits: [] };
  if (!enabled) return { payload, stats };
  if (payload === null || typeof payload !== "object") return { payload, stats };
  try {
    if (wire === "chat") compressChatPayload(payload, stats);
    else if (wire === "messages") compressMessagesPayload(payload, stats);
    else if (wire === "responses") compressResponsesPayload(payload, stats);
  } catch (error) {
    console.warn("[rtk] compressRequest error:", error?.message ?? error);
    stats.bytesAfter = stats.bytesBefore - stats.hits.reduce((sum, hit) => sum + hit.saved, 0);
  }
  stats.saved = stats.bytesBefore - stats.bytesAfter;
  return { payload, stats };
}
function compressChatPayload(payload, stats) {
  const items = Array.isArray(payload.messages) ? payload.messages : [];
  for (const msg of items) {
    if (!msg) continue;
    if (msg.role !== "tool") continue;
    if (typeof msg.content === "string") {
      msg.content = compressText(msg.content, stats, "openai-tool");
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (part && part.type === "text" && typeof part.text === "string") {
        part.text = compressText(part.text, stats, "openai-tool-array");
      }
    }
  }
}
function compressMessagesPayload(payload, stats) {
  const items = Array.isArray(payload.messages) ? payload.messages : [];
  for (const msg of items) {
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || block.type !== "tool_result") continue;
      if (block.is_error === true) continue;
      if (typeof block.content === "string") {
        block.content = compressText(block.content, stats, "claude-string");
        continue;
      }
      if (!Array.isArray(block.content)) continue;
      for (const part of block.content) {
        if (part && part.type === "text" && typeof part.text === "string") {
          part.text = compressText(part.text, stats, "claude-array");
        }
      }
    }
  }
}
function compressResponsesPayload(payload, stats) {
  const items = Array.isArray(payload.input) ? payload.input : [];
  for (const item of items) {
    if (!item || item.type !== "function_call_output") continue;
    if (typeof item.output === "string") {
      item.output = compressText(item.output, stats, "openai-responses-string");
      continue;
    }
    if (!Array.isArray(item.output)) continue;
    for (const part of item.output) {
      if (part && part.type === "input_text" && typeof part.text === "string") {
        part.text = compressText(part.text, stats, "openai-responses-array");
      }
    }
  }
}
function resolveEnabled(options) {
  if (options === void 0 || options === null) return true;
  if (typeof options === "object") return options.enabled !== false;
  return options !== false;
}

// src/token-saver/prompts.js
var CAVEMAN_LEVELS = ["off", "lite", "full", "ultra", "wenyan-lite", "wenyan", "wenyan-ultra"];
var PONYTAIL_LEVELS = ["off", "lite", "full", "ultra"];
var SHARED_BOUNDARIES = "Code blocks, file paths, commands, errors, URLs: keep exact. Security warnings, irreversible action confirmations, multi-step ordered sequences: write normal. Resume terse style after.";
var SHARED_EXAMPLES = 'Not: "Sure! I\'d be happy to help you with that. The issue you\'re experiencing is likely caused by..." Yes: "Bug in auth middleware. Token expiry check use `<` not `<=`. Fix:"';
var SHARED_AUTO_CLARITY = "Auto-Clarity: drop caveman for security warnings, irreversible actions, multi-step sequences where fragment ambiguity risks misread, or when user repeats a question. Resume after the clear part.";
var SHARED_PERSISTENCE = "ACTIVE EVERY RESPONSE. No revert after many turns. No filler drift. Still active if unsure.";
var SHARED_NO_INVENTED_ABBREV = "No invented abbreviations. Standard well-known tech acronyms (DB, API, HTTP, URL, JSON, ID, OS, CPU) OK. Names of code symbols, function names, API names, error strings: keep verbatim.";
var SHARED_PRESERVE_LANGUAGE = "Preserve the user's dominant language. User wrote Vietnamese, reply Vietnamese. User wrote English, reply English. Wenyan/classical-Chinese levels override this language-preservation rule. Code identifiers, error strings, file paths, commands: keep in their original form regardless of language.";
var SHARED_NO_SELF_REFERENCE = 'No self-reference. Do not name or announce the style (no "caveman mode", no "me caveman think", no "compressed mode active"). Just respond.';
var SHARED_NO_DECORATION = `No decorative emoji. No narrating tool calls ("I will now search", "I used X to find Y"). No status phrases ("Sure!", "Of course!", "I'd be happy to"). No causal arrow shorthand ("A -> B -> fails"). State the thing, the action, the reason. Then next step.`;
var CAVEMAN_PROMPTS = {
  lite: [
    "Respond tersely. Keep grammar and full sentences but drop filler, hedging and pleasantries (just/really/basically/sure/of course/I'd be happy to).",
    "Pattern: state the thing, the action, the reason. Then next step.",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION
  ].join(" "),
  full: [
    "Respond like terse caveman. All technical substance stay exact, only fluff die.",
    "Drop: articles (a/an/the), filler (just/really/basically/actually/simply), pleasantries, hedging. Fragments OK. Short synonyms (big not extensive, fix not implement a solution for).",
    "Pattern: [thing] [action] [reason]. [next step].",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION
  ].join(" "),
  ultra: [
    "Respond ultra-terse. Maximum compression. Telegraphic.",
    "Strip conjunctions. One word when one word enough.",
    "Pattern: [thing] [action] [reason]. [next step].",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION
  ].join(" "),
  "wenyan-lite": [
    "Respond semi-classical. Drop filler/hedging but keep grammar structure, classical register.",
    "Use classical Chinese sentence patterns where natural. Keep English for technical terms.",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION
  ].join(" "),
  wenyan: [
    "Respond classical Chinese (\u6587\u8A00\u6587). Maximum classical terseness. 80-90% character reduction.",
    "Classical sentence patterns, verbs precede objects, subjects often omitted, classical particles (\u4E4B/\u4E43/\u70BA/\u5176).",
    "Keep English for code, commands, function names, API names, error strings.",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION
  ].join(" "),
  "wenyan-ultra": [
    "Respond extreme classical compression (\u6587\u8A00\u6587 ultra). Maximum compression, ultra terse.",
    "Same classical rules as wenyan-full but even more compressed. One classical particle per clause.",
    SHARED_EXAMPLES,
    SHARED_BOUNDARIES,
    SHARED_AUTO_CLARITY,
    SHARED_PERSISTENCE,
    SHARED_NO_INVENTED_ABBREV,
    SHARED_PRESERVE_LANGUAGE,
    SHARED_NO_SELF_REFERENCE,
    SHARED_NO_DECORATION
  ].join(" ")
};
var SHARED_PERSONA = "You are a lazy senior developer. Lazy means efficient, not careless. The best code is the code never written.";
var SHARED_LADDER = "Before writing code, stop at the first rung that holds: 1) Does this need to exist at all? (YAGNI) 2) Stdlib does it? Use it. 3) Native platform feature covers it? Use it (CSS over JS, DB constraint over app code). 4) Already-installed dependency solves it? Use it; never add a new one for what a few lines can do. 5) Can it be one line? One line. 6) Only then: the minimum code that works.";
var SHARED_RULES = 'No unrequested abstractions (no interface with one implementation, no factory for one product, no config for a value that never changes). No boilerplate or scaffolding "for later". Deletion over addition. Boring over clever. Fewest files possible; shortest working diff wins. Two stdlib options the same size: take the edge-case-correct one. Mark deliberate simplifications with a `ponytail:` comment naming the ceiling and upgrade path.';
var SHARED_OUTPUT = "Code first. Then at most three short lines: what was skipped, when to add it. No essays or design notes. Pattern: `[code] \u2192 skipped: [X], add when [Y].`";
var SHARED_NOT_LAZY = "Never simplify away: input validation at trust boundaries, error handling that prevents data loss, security, accessibility, anything explicitly requested. Non-trivial logic leaves ONE runnable check behind (an assert-based self-check or one small test file; no frameworks). Trivial one-liners need no test.";
var SHARED_PONYTAIL_PERSISTENCE = "ACTIVE EVERY RESPONSE. No drift back to over-building. Still active if unsure.";
var PONYTAIL_PROMPTS = {
  lite: [
    SHARED_PERSONA,
    "Lite: build what's asked, but name the lazier alternative in one line. User picks.",
    SHARED_LADDER,
    SHARED_RULES,
    SHARED_OUTPUT,
    SHARED_NOT_LAZY,
    SHARED_PONYTAIL_PERSISTENCE
  ].join(" "),
  full: [
    SHARED_PERSONA,
    "Full: the ladder enforced. Stdlib and native first. Shortest diff, shortest explanation.",
    SHARED_LADDER,
    SHARED_RULES,
    SHARED_OUTPUT,
    SHARED_NOT_LAZY,
    SHARED_PONYTAIL_PERSISTENCE
  ].join(" "),
  ultra: [
    SHARED_PERSONA,
    "Ultra: YAGNI extremist. Deletion before addition. Ship the one-liner and challenge the rest of the requirement in the same response.",
    SHARED_LADDER,
    SHARED_RULES,
    SHARED_OUTPUT,
    SHARED_NOT_LAZY,
    SHARED_PONYTAIL_PERSISTENCE
  ].join(" ")
};
function cavemanPrompt(level) {
  if (typeof level !== "string" || level === "off") return null;
  return Object.hasOwn(CAVEMAN_PROMPTS, level) ? CAVEMAN_PROMPTS[level] : null;
}
function ponytailPrompt(level) {
  if (typeof level !== "string" || level === "off") return null;
  return Object.hasOwn(PONYTAIL_PROMPTS, level) ? PONYTAIL_PROMPTS[level] : null;
}
function activePrompts({ caveman, ponytail } = {}) {
  const active = [];
  const cavemanText = cavemanPrompt(caveman);
  if (cavemanText !== null) active.push({ id: "caveman", level: caveman, text: cavemanText });
  const ponytailText = ponytailPrompt(ponytail);
  if (ponytailText !== null) active.push({ id: "ponytail", level: ponytail, text: ponytailText });
  return active;
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
  const messages = payload.messages;
  if (!Array.isArray(messages)) return result(payload, false, "shape-not-recognised");
  if (messages.some((message) => isSystem(message) && contentHasSegment(message.content, segment))) {
    return result(payload, false, "already-injected");
  }
  const target = chatSystemMessage(messages);
  if (target === void 0) {
    messages.unshift({ role: "system", content: segment });
    return result(payload, true, "injected");
  }
  appendChatSegment(target, segment);
  return result(payload, true, "injected");
}
function chatSystemMessage(messages) {
  const first = messages[0];
  if (isSystem(first)) return first;
  return messages.find((message) => isSystem(message));
}
function appendChatSegment(message, segment) {
  const content = message.content;
  if (typeof content === "string") {
    message.content = content === "" ? segment : `${content}${SEP}${segment}`;
    return;
  }
  if (Array.isArray(content)) {
    content.push({ type: "text", text: segment });
    return;
  }
  message.content = segment;
}
function injectMessages(payload, segment) {
  if (!Array.isArray(payload.messages)) return result(payload, false, "shape-not-recognised");
  const system = payload.system;
  if (typeof system === "string") {
    if (system.includes(segment)) return result(payload, false, "already-injected");
    payload.system = system === "" ? segment : `${system}${SEP}${segment}`;
    return result(payload, true, "injected");
  }
  if (Array.isArray(system)) {
    if (system.some((block2) => block2 !== null && typeof block2 === "object" && typeof block2.text === "string" && block2.text.includes(segment))) {
      return result(payload, false, "already-injected");
    }
    const block = { type: "text", text: segment };
    let lastCached = -1;
    for (let i = system.length - 1; i >= 0; i -= 1) {
      if (system[i]?.cache_control) {
        lastCached = i;
        break;
      }
    }
    if (lastCached >= 0) system.splice(lastCached, 0, block);
    else system.push(block);
    return result(payload, true, "injected");
  }
  if (system === void 0 || system === null) {
    payload.system = segment;
    return result(payload, true, "injected");
  }
  return result(payload, false, "shape-not-recognised");
}
function injectResponses(payload, segment) {
  if (typeof payload.instructions === "string") {
    if (payload.instructions.includes(segment)) return result(payload, false, "already-injected");
    payload.instructions = payload.instructions === "" ? segment : `${payload.instructions}${SEP}${segment}`;
    return result(payload, true, "injected");
  }
  const input = payload.input;
  if (!Array.isArray(input)) return result(payload, false, "shape-not-recognised");
  if (input.some((item) => isResponsesSystem(item) && contentHasSegment(item.content, segment))) {
    return result(payload, false, "already-injected");
  }
  const target = input.find((item) => isResponsesSystem(item));
  if (target === void 0) {
    input.unshift({ type: "message", role: "system", content: [{ type: "input_text", text: segment }] });
  } else {
    appendResponsesSegment(target, segment);
  }
  return result(payload, true, "injected");
}
function appendResponsesSegment(item, segment) {
  const content = item.content;
  if (typeof content === "string") {
    item.content = content === "" ? segment : `${content}${SEP}${segment}`;
    return;
  }
  if (Array.isArray(content)) {
    content.push({ type: "input_text", text: segment });
    return;
  }
  item.content = [{ type: "input_text", text: segment }];
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
