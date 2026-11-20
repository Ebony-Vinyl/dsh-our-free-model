/**
 * supervisor.mjs — liveness/readiness probing, attach-or-start semantics,
 * stale-lock recovery and bounded restart for the standalone service.
 *
 * Design notes (deliberate choices):
 * - If a healthy service already listens on the port, we ATTACH to it and
 *   never kill or restart it: several MCP clients may spawn several bridges
 *   in parallel, and every bridge must share the one local service instance.
 * - A spawned service keeps running after this bridge exits (it is a shared
 *   local daemon by design). Set OFM_BRIDGE_STOP_ON_EXIT=1 to opt into
 *   stopping the spawned service when the bridge's stdin closes.
 * - Stale locks are only removed after checking the recorded pid is dead.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function envConfig(env = process.env) {
  const port = String(env.OFM_PORT || "18900");
  return {
    port,
    url: env.OFM_URL || `http://127.0.0.1:${port}`,
    dataDir: env.OFM_DATA_DIR || path.join(env.HOME || "", ".our-free-model"),
    repo: env.OFM_REPO || "",
    bun: env.OUR_FREE_MODEL_BUN || env.OFM_BUN || "",
    stopOnExit: env.OFM_BRIDGE_STOP_ON_EXIT === "1",
    minServiceVersion: env.OFM_MIN_SERVICE_VERSION || "",
    maxRestarts: Number(env.OFM_MAX_SERVICE_RESTARTS || "3"),
    key: env.OFM_KEY || "",
  };
}

export function log(...args) {
  // stdout carries JSON-RPC only; everything else goes to stderr.
  process.stderr.write(`[ofm-mcp-bridge] ${args.join(" ")}\n`);
}

async function probeHealth(url) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { ok: false };
    const body = await r.json();
    return { ok: body?.ok === true, version: body?.version || "", body };
  } catch {
    return { ok: false };
  }
}

function staleLockPath(dataDir) {
  const lockPath = path.join(dataDir, "service.lock");
  if (!existsSync(lockPath)) return null;
  try {
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    const pid = Number(lock?.pid);
    if (!pid || Number.isNaN(pid)) return lockPath; // malformed -> stale
    try {
      process.kill(pid, 0); // alive -> not stale
      return null;
    } catch {
      return lockPath; // dead -> stale
    }
  } catch {
    return lockPath;
  }
}

export class Supervisor {
  constructor(cfg, logger = log) {
    this.cfg = cfg;
    this.log = logger;
    this.restarts = 0;
    this.child = null;
    this.starting = null;
  }

  /** Resolve when /health reports ok. `attach` is true when we did NOT spawn. */
  async ensure() {
    let probe = await probeHealth(this.cfg.url);
    if (probe.ok) {
      this.checkVersion(probe.version);
      return { attached: true, version: probe.version };
    }
    if (!this.cfg.repo || !existsSync(path.join(this.cfg.repo, "packages", "standalone", "cli.mjs"))) {
      throw new Error(
        `OFM service not reachable at ${this.cfg.url} and OFM_REPO is not set, cannot start it. ` +
          `Start manually: node packages/standalone/cli.mjs --port ${this.cfg.port}`
      );
    }
    if (this.restarts >= this.cfg.maxRestarts) {
      throw new Error(`Service failed to stay up after ${this.restarts} restarts; giving up (OFM_MAX_SERVICE_RESTARTS=${this.cfg.maxRestarts}).`);
    }
    if (!this.starting) {
      this.starting = this.spawnService()
        .then((r) => {
          this.starting = null;
          return r;
        })
        .catch((e) => {
          this.starting = null;
          throw e;
        });
    }
    return this.starting;
  }

  async spawnService() {
    const stale = staleLockPath(this.cfg.dataDir);
    if (stale) {
      this.log(`removing stale service lock: ${stale}`);
      try { rmSync(stale); } catch {}
    }
    const childEnv = { ...process.env };
    if (this.cfg.bun) childEnv.OUR_FREE_MODEL_BUN = this.cfg.bun;
    // Non-loopback / credential leaks must never happen by accident.
    childEnv.PATH = `${path.dirname(this.cfg.bun || "")}:${process.env.PATH || ""}`.replace(/^:/, "");
    const child = spawn(
      process.execPath,
      [
        path.join(this.cfg.repo, "packages", "standalone", "cli.mjs"),
        "--port", this.cfg.port,
        "--data-dir", this.cfg.dataDir,
      ],
      { detached: true, stdio: "ignore", env: childEnv }
    );
    child.unref();
    this.child = child;
    this.restarts += 1;
    this.log(`spawned standalone service (pid ${child.pid}), restart #${this.restarts}`);
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const probe = await probeHealth(this.cfg.url);
      if (probe.ok) {
        this.checkVersion(probe.version);
        return { attached: false, version: probe.version, pid: child.pid };
      }
      await sleep(500);
    }
    throw new Error(`OFM service did not become healthy within 30s at ${this.cfg.url}`);
  }

  checkVersion(version) {
    if (!this.cfg.minServiceVersion) return;
    const cmp = (v) => String(v).split(".").map((n) => parseInt(n, 10) || 0);
    const [a, b] = [cmp(this.cfg.minServiceVersion), cmp(version || "0.0.0")];
    for (let i = 0; i < 3; i++) {
      if ((b[i] || 0) < (a[i] || 0)) {
        this.log(`WARNING: service version ${version} < required ${this.cfg.minServiceVersion}; bridge may misbehave.`);
        break;
      }
      if ((b[i] || 0) > (a[i] || 0)) break;
    }
  }

  /** Called when the MCP client closes stdin. */
  async onClientExit() {
    if (!this.cfg.stopOnExit || !this.child?.pid) return;
    this.log("OFM_BRIDGE_STOP_ON_EXIT=1 -> stopping spawned service");
    try {
      process.kill(this.child.pid, "SIGTERM");
      rmSync(path.join(this.cfg.dataDir, "service.lock"), { force: true });
    } catch {}
  }
}
