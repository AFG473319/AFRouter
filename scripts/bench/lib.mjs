// Shared helpers for the AFRouter benchmark suites (zero-dependency by convention —
// scripts/ hand-rolls its own argv and measurement, no extra libraries).
//
// Run: npm run bench          (dispatcher: scripts/bench/index.mjs)
//      npm run bench -- --help

import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RESULTS_DIR = path.join(ROOT, "benchmarks", "results");
export const SUITES = ["build", "startup", "request", "unit"];

// Must match src/dashboardGuard.js (CLI_TOKEN_SALT) + src/shared/utils/machineId.js:
// token = sha256(rawMachineId + "afr-cli-auth" + cliSecret).hex.substring(0, 16),
// where rawMachineId/cliSecret live at <DATA_DIR>/machine-id and <DATA_DIR>/auth/cli-secret.
export const CLI_TOKEN_SALT = "afr-cli-auth";

// The port npm scripts pin for dev/start (repo convention).
export const DEFAULT_PORT = 20128;

// Bench builds get their OWN dist dir (next.config.mjs reads NEXT_DIST_DIR, and
// scripts/copy-standalone-assets.mjs honors it too) so a benchmark never
// overwrites — or is skewed by — the repo's real `.next` / a running dev server.
export const BENCH_DIST_DIR = ".next-bench";

const IS_WIN = process.platform === "win32";

/* ── console (repo style: emoji markers + [prefix]) ─────────────────────── */
export const log = (...a) => console.log("[bench]", ...a);
export const logOk = (...a) => console.log("✅ [bench]", ...a);
export const logWarn = (...a) => console.log("⚠️ [bench]", ...a);
export const logErr = (...a) => console.error("❌ [bench]", ...a);

/* ── statistics ─────────────────────────────────────────────────────────── */
// Nearest-rank percentile over an already-sorted array.
export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

// Uniform metric shape so every suite's numbers compare the same way.
// `samples` are raw measurements in ms; derived fields keep full precision in
// JSON and are only rounded for display.
export function stats(samples, unit = "ms") {
  if (!samples.length) throw new Error("stats() needs at least one sample");
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  return {
    unit,
    n: sorted.length,
    samples: sorted,
    min: sorted[0],
    median: percentile(sorted, 50),
    mean: sum / sorted.length,
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
  };
}

// Median of a raw array (used where a suite aggregates sub-calls itself).
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Readable numbers without losing sub-ms precision (unit benches run in µs).
export function fmtNum(v) {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 100) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(4);
  return String(Number(v.toPrecision(3)));
}

export function roundTrip(fn) {
  const t0 = performance.now();
  const out = fn();
  return { ms: performance.now() - t0, out };
}

export async function roundTripAsync(fn) {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

/* ── environment metadata (stored in every results file) ────────────────── */
export function machineInfo() {
  const cpus = os.cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    cpu: cpus[0]?.model || "unknown",
    cpuCount: cpus.length,
    totalMemGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    node: process.version,
  };
}

export function gitInfo() {
  const sha = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8", windowsHide: true });
  if (sha.status !== 0) return null;
  return {
    sha: sha.stdout.trim(),
    branch: branch.status === 0 ? branch.stdout.trim() : null,
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : null,
  };
}

/* ── ports ──────────────────────────────────────────────────────────────── */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

export function isPortListening(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: "127.0.0.1" });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    setTimeout(() => done(false), 1000).unref?.();
  });
}

export async function waitPortFree(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isPortListening(port))) return;
    await sleep(50);
  }
  throw new Error(`port ${port} still in use after ${timeoutMs}ms`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ── isolated fixture DATA_DIR ──────────────────────────────────────────── */
// Fresh temp DATA_DIR so a benchmark run never touches the real ~/.afrouter.
// Pre-writes machine-id + cli-secret so the CLI token (guard auth for the
// seeding APIs) is computable here without importing app code (the `@/` path
// alias is bundler-only and won't resolve from a plain .mjs script).
export function makeDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afrouter-bench-"));
  const rawMachineId = crypto.randomBytes(16).toString("hex");
  const cliSecret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.join(dir, "auth"), { recursive: true });
  fs.writeFileSync(path.join(dir, "machine-id"), rawMachineId, "utf8");
  fs.writeFileSync(path.join(dir, "auth", "cli-secret"), cliSecret, "utf8");
  const cliToken = crypto
    .createHash("sha256")
    .update(rawMachineId + CLI_TOKEN_SALT + cliSecret)
    .digest("hex")
    .substring(0, 16);
  return {
    dir,
    cliToken,
    cleanup() {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    },
  };
}

/* ── process helpers ────────────────────────────────────────────────────── */
export function tailText(text, lines = 40) {
  const all = String(text || "").trimEnd().split(/\r?\n/);
  return all.slice(-lines).join("\n");
}

export function tailFile(file, lines = 40) {
  try { return tailText(fs.readFileSync(file, "utf8"), lines); } catch { return "(no log)"; }
}

// Resolve npm's CLI the way the npm.cmd/npm.ps1 shims do, WITHOUT cmd.exe:
// the shims first run npm-prefix.js to learn npm's global prefix (which on
// machines with a global prefix points at e.g. AppData\Roaming\npm — a NEWER
// npm than the copy bundled with node.exe), then run that copy's CLI. Running
// the bundled copy directly would silently benchmark a different npm than the
// one the user/CI actually invokes.
const NPM_CLI_CACHE = new Map();
function resolveNpmCli(cmd) {
  const key = cmd.toLowerCase();
  if (NPM_CLI_CACHE.has(key)) return NPM_CLI_CACHE.get(key);
  const bundledBin = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin");
  let cli = null;
  const prefixJs = path.join(bundledBin, "npm-prefix.js");
  if (fs.existsSync(prefixJs)) {
    try {
      const r = spawnSync(process.execPath, [prefixJs], { encoding: "utf8", windowsHide: true });
      const prefix = String(r.stdout || "").trim();
      if (r.status === 0 && prefix) {
        const candidate = path.join(prefix, "node_modules", "npm", "bin", `${key}-cli.js`);
        if (fs.existsSync(candidate)) cli = candidate;
      }
    } catch { /* fall through to bundled */ }
  }
  if (!cli) {
    const bundled = path.join(bundledBin, `${key}-cli.js`);
    if (fs.existsSync(bundled)) cli = bundled;
  }
  NPM_CLI_CACHE.set(key, cli);
  return cli;
}

// Spawn a command to completion. npm/npx are .cmd shims on Windows (unspawnable
// without a shell), so we invoke the resolved CLI directly with node — identical
// semantics to `npm run …` (npm sets up node_modules/.bin itself), no shell.
export function runToCompletion(cmd, args, { cwd = ROOT, env = {}, timeoutMs = 0, shell = false } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const opts = { cwd, env: { ...process.env, ...env }, windowsHide: true };
    const npmish = !path.extname(cmd) && /^(npm|npx)$/i.test(cmd);
    let child;
    if (npmish) {
      const cli = resolveNpmCli(cmd.toLowerCase());
      if (cli) {
        child = spawn(process.execPath, [cli, ...args], { ...opts, shell: false });
      } else {
        child = spawn(IS_WIN ? `${cmd}.cmd` : cmd, args, { ...opts, shell: IS_WIN });
      }
    } else {
      child = spawn(cmd, args, { ...opts, shell: shell || (IS_WIN && /\.(cmd|bat)$/i.test(cmd)) });
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => { stdout += d; });
    child.stderr?.on("data", (d) => { stderr += d; });
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        stderr += `\n[bench] timed out after ${timeoutMs}ms`;
        // Kill the whole tree: with shell:true the build is a CHILD of cmd.exe,
        // and killing only the shell would orphan it.
        if (IS_WIN) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        } else {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }
      }, timeoutMs);
    }
    child.once("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${err.message}`, durationMs: performance.now() - t0 });
    });
    child.once("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: performance.now() - t0 });
    });
  });
}

// Spawn the gateway (repo root custom-server.js → next start fallback) with an
// isolated DATA_DIR. Server output goes to logPath for diagnostics.
export function spawnGateway({ port, dataDir, logPath, distDir = BENCH_DIST_DIR }) {
  const fd = fs.openSync(logPath, "a");
  const child = spawn(process.execPath, ["custom-server.js", "--port", String(port)], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      PORT: String(port),
      // Point `next start` (via next.config.mjs) at the chosen build.
      NEXT_DIST_DIR: distDir,
      // Cut the background token-refresh scheduler out of the noise window.
      DISABLE_BACKGROUND_TOKEN_REFRESH: "1",
    },
    stdio: ["ignore", fd, fd],
    windowsHide: true,
    detached: !IS_WIN, // POSIX: own process group → kill(-pid) reaps children too
  });
  // Do NOT child.unref() here. The suites `await` plenty of promises while the
  // gateway is alive; if the child handle is unref'ed, there are moments (e.g.
  // inside killGateway, after the last fetch's sockets are gone) where the loop
  // holds ONLY unref'ed handles — Node then drains it and exits 0 silently,
  // abandoning every pending promise (no cleanup, no error, seen in the wild).
  // A refed child handle keeps the parent alive exactly as long as the gateway
  // runs; finally-blocks + killGateway's fallback timer guarantee termination.
  child.spawnError = null;
  child.once("error", (err) => {
    child.spawnError = err;
    try {
      fs.appendFileSync(logPath, `\n[bench] gateway spawn error: ${err.message}\n`);
    } catch { /* best-effort */ }
  });
  return child;
}

// Kill the gateway (and its tree on Windows) and wait for it to be gone.
export function killGateway(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    const done = () => resolve();
    child.once("exit", done);
    if (IS_WIN) {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true })
        .once("error", () => { try { child.kill(); } catch { /* ignore */ } });
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* ignore */ } }
    }
    setTimeout(resolve, 10000).unref?.();
  });
}

/* ── readiness ──────────────────────────────────────────────────────────── */
// Poll /api/health until {"ok":true} — the same readiness definition the CI
// smoke test uses (beta.yml). Fails fast (with the server log tail) if the
// process dies, and hard-fails on timeout.
export async function waitHealth({ port, child, logPath, timeoutMs = 180000, pollMs = 50 }) {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child?.spawnError) {
      throw new Error(`gateway failed to spawn: ${child.spawnError.message}\n--- gateway log ---\n${tailFile(logPath)}`);
    }
    if (child && child.exitCode !== null) {
      throw new Error(`gateway exited early (code ${child.exitCode})\n--- gateway log ---\n${tailFile(logPath)}`);
    }
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const body = await res.json();
        if (body?.ok === true) return;
      }
    } catch { /* not up yet */ }
    await sleep(pollMs);
  }
  throw new Error(`gateway not healthy within ${timeoutMs}ms\n--- gateway log ---\n${tailFile(logPath)}`);
}

// Prefer the bench build; fall back to the repo's own production build so
// `--only startup,request` also works against a plain `npm run build`.
export function resolveDistDir() {
  for (const dir of [BENCH_DIST_DIR, ".next"]) {
    if (fs.existsSync(path.join(ROOT, dir, "BUILD_ID"))) return dir;
  }
  throw new Error(
    `No production build found (neither ${BENCH_DIST_DIR}/BUILD_ID nor .next/BUILD_ID). ` +
    "Run `npm run bench --only build` first."
  );
}

/* ── results I/O ────────────────────────────────────────────────────────── */
export function writeResults({ label, suites, params, metrics, errors, suiteMs }) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const file = path.join(RESULTS_DIR, `${stamp}-${label}.json`);
  const payload = {
    tool: "afrouter-bench",
    version: 1,
    timestamp: new Date().toISOString(),
    label,
    suites,
    params,
    machine: machineInfo(),
    git: gitInfo(),
    suiteMs,
    errors,
    metrics,
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return file;
}

export function printTable(metrics) {
  const rows = Object.entries(metrics).map(([name, m]) => [
    name,
    String(m.n ?? ""),
    fmtNum(m.median),
    fmtNum(m.p95),
    fmtNum(m.min),
    fmtNum(m.max),
  ]);
  const head = ["metric", "n", "median", "p95", "min", "max"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  console.log("");
  console.log(line(head));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
  console.log("");
}

/* ── comparison (advisory, never a hard gate — runner noise lies) ───────── */
function machineKey(m) {
  return m ? [m.platform, m.arch, m.cpu, m.cpuCount, m.node].join("|") : "unknown";
}

export function compareResults(baselineFile, currentFile) {
  let baseline;
  let current;
  try {
    baseline = JSON.parse(fs.readFileSync(baselineFile, "utf8"));
  } catch (err) {
    logWarn(`no baseline readable at ${path.relative(ROOT, baselineFile)} (${err.message}) — skipping comparison`);
    return;
  }
  current = current || JSON.parse(fs.readFileSync(currentFile, "utf8"));

  if (machineKey(baseline.machine) !== machineKey(current.machine)) {
    logWarn("baseline was recorded on a DIFFERENT machine/runtime — deltas below are not trustworthy:");
    logWarn(`  baseline: ${machineKey(baseline.machine)}`);
    logWarn(`  current : ${machineKey(current.machine)}`);
  }

  console.log("");
  console.log(["metric", "baseline", "current", "delta"].map((h, i) => h.padEnd(i === 0 ? 34 : 12)).join("").trimEnd());
  console.log("─".repeat(70));
  let comparable = 0;
  for (const [name, cur] of Object.entries(current.metrics || {})) {
    const base = baseline.metrics?.[name];
    if (!base) {
      console.log(`${name.padEnd(34)}${"(new)".padEnd(12)}${fmtNum(cur.median).padEnd(12)}${"—"}`);
      continue;
    }
    comparable++;
    const d = ((cur.median - base.median) / base.median) * 100;
    // Lower is better for every metric we record (times), so ▲ = slower.
    const arrow = Math.abs(d) < 3 ? "±" : d > 0 ? "▲" : "▼";
    console.log(
      `${name.padEnd(34)}${fmtNum(base.median).padEnd(12)}${fmtNum(cur.median).padEnd(12)}${`${arrow} ${d >= 0 ? "+" : ""}${d.toFixed(1)}%`}`
    );
  }
  console.log("");
  log(`compared ${comparable} metric(s) against ${path.relative(ROOT, baselineFile)}`);
  log("± = within ~3% (treat as noise). ▲ = slower than baseline, ▼ = faster.");
}

/* ── argv (hand-rolled — no arg-parsing library, per repo convention) ───── */
export function parseArgs(argv) {
  const out = {
    only: null,
    runs: undefined,      // build/startup repetitions
    iterations: undefined, // request-suite samples per scenario
    label: null,
    compare: undefined,   // undefined = off, null = default baseline, string = file
    keep: false,
    help: false,
  };
  // Shared cursor: the helpers below must outlive any single loop iteration,
  // so the index lives here, not in the `for` header.
  const cur = { i: 0 };
  const needValue = (flag) => {
    const v = argv[cur.i + 1];
    if (v === undefined || v.startsWith("--")) {
      console.error(`❌ ${flag} requires a value`);
      process.exit(2);
    }
    cur.i++;
    return v;
  };
  const needInt = (flag) => {
    const n = Number(needValue(flag));
    if (!Number.isInteger(n) || n < 1) {
      console.error(`❌ ${flag} must be a positive integer`);
      process.exit(2);
    }
    return n;
  };
  for (cur.i = 0; cur.i < argv.length; cur.i++) {
    const a = argv[cur.i];
    if (a === "--only") out.only = needValue(a);
    else if (a === "--runs") out.runs = needInt(a);
    else if (a === "--iterations") out.iterations = needInt(a);
    else if (a === "--label") out.label = needValue(a);
    else if (a === "--keep") out.keep = true;
    else if (a === "--compare") {
      const v = argv[cur.i + 1];
      if (v === undefined || v.startsWith("--")) out.compare = null;
      else { cur.i++; out.compare = v; }
    } else if (a === "--help" || a === "-h") out.help = true;
    else {
      console.error(`❌ unknown flag: ${a} (see --help)`);
      process.exit(2);
    }
  }
  return out;
}

export function printUsage() {
  console.log(`
AFRouter benchmarks — measure build, startup, request and hot-function times.

Usage: npm run bench [-- flags]

  --only <a,b>        run only these suites: ${SUITES.join(", ")}   (default: all)
  --runs <n>          repetitions for build/startup suites      (build: 1, startup: 3)
  --iterations <n>    samples per request scenario              (default: 30)
  --label <name>      results filename label                    (default: git sha)
  --compare [file]    print deltas vs a results file            (default: benchmarks/baseline.json)
  --keep              keep temp DATA_DIR + logs (for debugging)
  -h, --help          this text

Notes:
  • The build suite runs \`npm run build\` cold into ${BENCH_DIST_DIR}/ — the real .next is never touched.
  • startup/request suites need a production build (.next-bench/BUILD_ID, or a fallback .next/BUILD_ID).
  • Results are written to benchmarks/results/ — copy one to
    benchmarks/baseline.json to make it the default comparison target.
  • Comparison is advisory only: benchmarks never fail a build (machine noise).
`);
}
