// Where the harness keeps things. Everything bulky lives under <repo>/.agent (gitignored);
// the isolated server's data and fake HOME live in the OS temp dir so Next's file watcher
// never sees SQLite WAL churn.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const AGENT_DIR = process.env.AFROUTER_HARNESS_DIR
  ? path.resolve(process.env.AFROUTER_HARNESS_DIR)
  : path.join(REPO_ROOT, ".agent");
export const RUNS_DIR = path.join(AGENT_DIR, "runs");
export const SERVER_FILE = path.join(AGENT_DIR, "server.json");
export const CAPABILITIES_FILE = path.join(AGENT_DIR, "capabilities.json");
export const BROWSER_CACHE_FILE = path.join(AGENT_DIR, "browser.json");
export const BASELINES_DIR = path.join(AGENT_DIR, "baselines");
export const CONFIG_FILES = [
  process.env.AFROUTER_HARNESS_CONFIG,
  path.join(REPO_ROOT, "agent-harness.config.json"),
  path.join(AGENT_DIR, "config.json"),
].filter(Boolean);

// One sandbox per checkout (worktrees get their own), stable across runs.
export function sandboxRoot() {
  const hash = crypto.createHash("sha1").update(REPO_ROOT.toLowerCase()).digest("hex").slice(0, 10);
  return path.join(os.tmpdir(), "afrouter-agent", hash);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const MAX_RUNS = 25;

export function newRunDir(cmd) {
  ensureDir(RUNS_DIR);
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
  const dir = path.join(RUNS_DIR, `${stamp}-${String(cmd).replace(/[^a-z0-9-]/gi, "")}`);
  ensureDir(dir);
  pruneRuns();
  return dir;
}

function pruneRuns() {
  try {
    const entries = fs.readdirSync(RUNS_DIR).sort();
    for (const name of entries.slice(0, Math.max(0, entries.length - MAX_RUNS))) {
      fs.rmSync(path.join(RUNS_DIR, name), { recursive: true, force: true });
    }
  } catch {
    /* pruning is best effort */
  }
}
