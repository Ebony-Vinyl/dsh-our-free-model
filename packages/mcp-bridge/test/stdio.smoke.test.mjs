/**
 * Offline stdio smoke test — no network, no upstream.
 * Spawn the bridge, speak MCP over stdio, and assert:
 *   1. stdout carries ONLY valid JSON-RPC lines (no banner/log pollution)
 *   2. initialize + tools/list succeed, expected tools present
 *   3. ofm_usage degrades gracefully when stats.json is absent
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = mkdtempSync(path.join(tmpdir(), "ofm-bridge-test-"));

const child = spawn(process.execPath, [path.join(here, "..", "src", "index.mjs")], {
  env: {
    ...process.env,
    OFM_URL: "http://127.0.0.1:1", // unreachable on purpose: usage/models must not hang the protocol test
    OFM_DATA_DIR: dataDir,
    OFM_REPO: "", // disable auto-start
    OFM_MAX_SERVICE_RESTARTS: "0",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

let stdoutBuf = "";
let stderrBuf = "";
const jsonLines = [];
let failed = false;

child.stdout.on("data", (chunk) => {
  stdoutBuf += chunk.toString();
  let idx;
  while ((idx = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, idx).trim();
    stdoutBuf = stdoutBuf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error("FAIL: stdout carried non-JSON-RPC output:", line.slice(0, 200));
      failed = true;
      child.kill("SIGKILL");
      return;
    }
    jsonLines.push(msg);
  }
});
child.stderr.on("data", (c) => { stderrBuf += c.toString(); });

const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } });
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ofm_usage", arguments: {} } });

await wait(4000);

const byId = Object.fromEntries(jsonLines.filter((m) => m.id !== undefined).map((m) => [m.id, m]));
const results = [];

function check(name, cond, extra = "") {
  results.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
  if (!cond) failed = true;
}

const init = byId[1]?.result?.serverInfo;
check("initialize", Boolean(init), `server=${init?.name} v${init?.version}`);
const tools = byId[2]?.result?.tools?.map((t) => t.name) || [];
check("tools/list", tools.includes("ofm_models") && tools.includes("ofm_chat") && tools.includes("ofm_usage") && tools.includes("ofm_task"), `tools=${tools.join(",")}`);
const chatParams = byId[2]?.result?.tools?.find((t) => t.name === "ofm_chat")?.inputSchema?.properties || {};
check("ofm_chat exposes no max_tokens", !("max_tokens" in chatParams), `params=${Object.keys(chatParams).join(",")}`);
const usage = byId[3]?.result?.content?.[0]?.text || "";
check("ofm_usage graceful without stats", usage.includes("No usage stats yet"), usage.slice(0, 60));
check("stderr carries diagnostics only when needed", !/prompt|Bearer/i.test(stderrBuf));

child.kill("SIGKILL");
rmSync(dataDir, { recursive: true, force: true });

console.log(results.join("\n"));
process.exit(failed ? 1 : 0);
