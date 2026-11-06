// `watch`: re-run a scoped `check` whenever source files are saved. Long-running; prints
// NDJSON (one compact object per event) to stdout and appends the same lines to
// .agent/watch.ndjson so an agent can tail the file instead of holding a shell open.
// Each check runs in a child CLI process (same code path as `npm run agent -- check`), one at
// a time; saves that land while a check runs are batched into the next one.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT, AGENT_DIR, ensureDir } from "./paths.mjs";

export const WATCH_ROOTS = ["src", "open-sse", "tests", "scripts/agent", "custom-server.js"];
const IGNORE = /(^|[\\/])(node_modules|\.next[^\\/]*|\.agent|\.git|__baseline__)([\\/]|$)|\.(log|sqlite|sqlite-wal|sqlite-shm|json\.tmp)$|~$/;
const RELEVANT = /\.(js|mjs|cjs|jsx|css|json)$/;
export const WATCH_LOG = path.join(AGENT_DIR, "watch.ndjson");

export function relevant(rel) {
  const f = rel.split(path.sep).join("/");
  return RELEVANT.test(f) && !IGNORE.test(f);
}

// Pure: turn a check result into the one-line watch event.
export function toEvent(files, result, ms) {
  if (!result) return { event: "check", ok: false, files, error: "check produced no JSON", ms };
  return {
    event: "check",
    ok: result.ok !== false,
    files: files.slice(0, 20),
    summary: result.summary || result.error,
    ...(result.failures?.length ? { failures: result.failures.slice(0, 5) } : {}),
    ...(result.runDir ? { runDir: result.runDir } : {}),
    ms,
  };
}

function runCheck(files, { server }) {
  return new Promise((resolve) => {
    const args = [path.join(REPO_ROOT, "scripts", "agent", "cli.mjs"), "check", "--files", files.join(","), ...(server ? [] : ["--no-server"])];
    const child = spawn(process.execPath, args, { cwd: REPO_ROOT, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.resume();
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve(null);
      }
    });
  });
}

export async function watch({ intervalMs = 800, server = false, once = false } = {}) {
  ensureDir(AGENT_DIR);
  const write = (obj) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...obj });
    process.stdout.write(`${line}\n`);
    try {
      fs.appendFileSync(WATCH_LOG, `${line}\n`);
    } catch {
      /* best effort */
    }
  };

  const pending = new Set();
  let timer = null;
  let running = false;
  const watchers = [];

  const flush = async () => {
    timer = null;
    if (running || !pending.size) return;
    running = true;
    const files = [...pending].sort();
    pending.clear();
    write({ event: "change", files: files.slice(0, 20), count: files.length });
    const t0 = Date.now();
    const result = await runCheck(files, { server });
    write(toEvent(files, result, Date.now() - t0));
    running = false;
    if (once) return stop(0);
    if (pending.size) schedule();
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, intervalMs);
  };
  const onEvent = (base) => (_type, name) => {
    if (!name) return;
    const rel = path.relative(REPO_ROOT, path.join(base, String(name)));
    if (!relevant(rel) || !fs.existsSync(path.join(REPO_ROOT, rel))) return;
    pending.add(rel.split(path.sep).join("/"));
    schedule();
  };

  for (const root of WATCH_ROOTS) {
    const abs = path.join(REPO_ROOT, root);
    if (!fs.existsSync(abs)) continue;
    const isDir = fs.statSync(abs).isDirectory();
    try {
      // recursive fs.watch: native on Windows/macOS, supported on Linux since Node 20.
      watchers.push(fs.watch(abs, { recursive: isDir }, onEvent(isDir ? abs : path.dirname(abs))));
    } catch (e) {
      write({ event: "warn", root, error: e.message });
    }
  }

  function stop(code = 0) {
    for (const w of watchers) w.close();
    write({ event: "stopped" });
    process.exit(code);
  }
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  write({ event: "ready", roots: WATCH_ROOTS, server, log: WATCH_LOG, hint: "save a file to trigger a scoped check; Ctrl+C to stop" });
  return new Promise(() => {});
}
