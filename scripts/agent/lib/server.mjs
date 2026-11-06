// Isolated AFRouter server for agents: own DATA_DIR, own fake HOME (so CLI-tool config
// routes never touch the user's real ~/.claude, ~/.codex, ...), own Next dist dir, a free
// loopback port (never 20128), and a fake OpenAI-compatible upstream. Warm between calls:
// `up` returns in milliseconds when the recorded server is still healthy.
//
// Auth: no production bypass. The harness writes the temp DATA_DIR's jwt-secret before
// boot, mints a dashboard JWT with it (same HS256 claims as src/lib/auth/dashboardSession.js),
// then uses the real settings API to set requireLogin=false inside the temp DB only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SignJWT } from "jose";
import { REPO_ROOT, AGENT_DIR, SERVER_FILE, ensureDir, sandboxRoot } from "./paths.mjs";
import { freePort, isAlive, killTreeAndWait, spawnDetached, waitFor, RESERVED_PORTS } from "./proc.mjs";
import { HarnessError } from "./out.mjs";
import { loadConfig } from "./config.mjs";

const PASS_ENV = [
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "ComSpec", "COMSPEC", "SystemDrive",
  "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TERM", "TZ", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
  "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "ProgramData",
  "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy",
  "CI", "GITHUB_ACTIONS",
];

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(SERVER_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeState(state) {
  ensureDir(AGENT_DIR);
  fs.writeFileSync(SERVER_FILE, JSON.stringify(state, null, 2));
}

// Mirror of src/lib/dataDir.js defaultDir(): the real user data dir we must never use.
export function realDataDir(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === "win32") {
    return path.win32.join(env.APPDATA || path.win32.join(home, "AppData", "Roaming"), "afrouter");
  }
  return path.posix.join(home, ".afrouter");
}

export function assertSafeDataDir(dataDir, { platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  if (!p.isAbsolute(dataDir)) throw new HarnessError(`DATA_DIR must be absolute: ${dataDir}`);
  // dataDir.js silently falls back to the real dir when given a Unix path on Windows.
  if (platform === "win32" && /^\//.test(dataDir)) throw new HarnessError(`DATA_DIR is a Unix path on Windows: ${dataDir}`);
  const real = realDataDir(platform, env, home);
  const norm = (x) => p.resolve(x).toLowerCase();
  if (norm(dataDir) === norm(real) || norm(dataDir).startsWith(norm(real) + p.sep)) {
    throw new HarnessError(`refusing to use the real AFRouter data dir: ${real}`);
  }
  return true;
}

export function sandboxPaths(root = sandboxRoot()) {
  return {
    root,
    dataDir: path.join(root, "data"),
    homeDir: path.join(root, "home"),
    logFile: path.join(root, "server.log"),
    upstreamLog: path.join(root, "upstream.log"),
    upstreamRecord: path.join(root, "upstream-requests.jsonl"),
  };
}

export function buildEnv({ parentEnv = process.env, paths, port, platform = process.platform, mode = "dev" }) {
  const env = {};
  for (const k of PASS_ENV) if (parentEnv[k] !== undefined) env[k] = parentEnv[k];
  const local = ["127.0.0.1", "localhost", "::1"];
  const noProxy = [parentEnv.NO_PROXY || parentEnv.no_proxy, ...local].filter(Boolean).join(",");
  env.NO_PROXY = noProxy;
  env.no_proxy = noProxy;
  const home = paths.homeDir;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    DATA_DIR: paths.dataDir,
    PORT: String(port),
    HOSTNAME: "127.0.0.1",
    NODE_ENV: mode === "prod" ? "production" : "development",
    NEXT_TELEMETRY_DISABLED: "1",
    BASE_URL: `http://127.0.0.1:${port}`,
    NEXT_PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    INITIAL_PASSWORD: crypto.randomBytes(12).toString("hex"),
    AFROUTER_AGENT_HARNESS: "1",
  });
  if (mode !== "prod") env.NEXT_DIST_DIR = ".next-agent";
  if (platform === "win32") {
    env.APPDATA = path.join(home, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(home, "AppData", "Local");
  }
  return env;
}

export async function mintToken(dataDir) {
  const secret = fs.readFileSync(path.join(dataDir, "jwt-secret"), "utf8").trim();
  return new SignJWT({ authenticated: true, harness: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(new TextEncoder().encode(secret));
}

async function fetchJson(url, init = {}, timeoutMs = 120_000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}

export async function health(state, timeoutMs = 3000) {
  if (!state?.baseUrl) return false;
  try {
    const res = await fetch(`${state.baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

export function logTail(file, lines = 40, maxLen = 500) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return text.split(/\r?\n/).filter(Boolean).slice(-lines).map((l) => l.slice(0, maxLen));
  } catch {
    return [];
  }
}

export async function status() {
  const state = readState();
  if (!state) return { running: false };
  const alive = isAlive(state.pid);
  const healthy = alive && (await health(state));
  return { running: healthy, alive, ...publicState(state) };
}

export function publicState(state) {
  if (!state) return {};
  const { token: _t, apiKey: _k, ...rest } = state;
  return rest;
}

export async function down({ clean = false } = {}) {
  const state = readState();
  const stopped = [];
  if (state) {
    for (const pid of [state.pid, state.upstreamPid]) {
      if (pid && isAlive(pid)) {
        await killTreeAndWait(pid);
        stopped.push(pid);
      }
    }
    fs.rmSync(SERVER_FILE, { force: true });
  }
  if (clean) fs.rmSync(sandboxPaths().root, { recursive: true, force: true });
  return { ok: true, stopped, cleaned: clean };
}

/**
 * Start (or reuse) the isolated server.
 * opts: { fresh, cleanBuild, prod, webpack, port, bootTimeoutSec, keepData }
 */
export async function up(opts = {}) {
  const t0 = Date.now();
  const existing = readState();
  if (existing && !opts.fresh && isAlive(existing.pid) && (await health(existing))) {
    return { ok: true, reused: true, ms: Date.now() - t0, ...publicState(existing) };
  }
  if (existing) await down();
  let cleanedBuild = false;
  if (opts.cleanBuild) {
    // Only ever the harness's own dist dir; never .next (the user's build).
    fs.rmSync(path.join(REPO_ROOT, ".next-agent"), { recursive: true, force: true });
    cleanedBuild = true;
  }

  const mode = opts.prod ? "prod" : "dev";
  if (mode === "prod" && !fs.existsSync(path.join(REPO_ROOT, ".next", "BUILD_ID"))) {
    throw new HarnessError("no production build: run `npm run build` first, or drop --prod", { hint: "npm run build" });
  }
  const paths = sandboxPaths();
  assertSafeDataDir(paths.dataDir);
  if (!opts.keepData) fs.rmSync(paths.dataDir, { recursive: true, force: true });
  for (const d of [paths.root, paths.dataDir, paths.homeDir, path.join(paths.homeDir, "AppData", "Roaming"), path.join(paths.homeDir, "AppData", "Local")]) ensureDir(d);
  for (const f of [paths.logFile, paths.upstreamLog, paths.upstreamRecord]) fs.writeFileSync(f, "");
  const secretFile = path.join(paths.dataDir, "jwt-secret");
  if (!fs.existsSync(secretFile)) fs.writeFileSync(secretFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const secretBefore = fs.readFileSync(secretFile, "utf8");

  const port = opts.port ? Number(opts.port) : await freePort();
  if (RESERVED_PORTS.has(port)) throw new HarnessError(`port ${port} is reserved for the user's real AFRouter`);
  const upstreamPort = await freePort();
  const env = buildEnv({ paths, port, mode });

  const upstreamPid = spawnDetached(process.execPath, [path.join(REPO_ROOT, "scripts", "agent", "lib", "fakeUpstream.mjs"), "--port", String(upstreamPort), "--record", paths.upstreamRecord], {
    env: { PATH: env.PATH, Path: env.Path, SystemRoot: env.SystemRoot }, cwd: REPO_ROOT, logFile: paths.upstreamLog,
  });

  const nextBin = path.join(REPO_ROOT, "node_modules", "next", "dist", "bin", "next");
  const args = mode === "prod"
    ? [path.join(REPO_ROOT, "custom-server.js"), "--port", String(port), "--hostname", "127.0.0.1"]
    : [nextBin, "dev", "--port", String(port), "--hostname", "127.0.0.1", ...(opts.webpack ? ["--webpack"] : [])];
  const pid = spawnDetached(process.execPath, args, { env, cwd: REPO_ROOT, logFile: paths.logFile });

  const baseUrl = `http://127.0.0.1:${port}`;
  const state = {
    pid, upstreamPid, port, upstreamPort, baseUrl, upstreamUrl: `http://127.0.0.1:${upstreamPort}/v1`, mode,
    dataDir: paths.dataDir, homeDir: paths.homeDir, logFile: paths.logFile, upstreamRecord: paths.upstreamRecord,
    distDir: mode === "prod" ? ".next" : ".next-agent", startedAt: new Date().toISOString(),
  };
  writeState(state);

  // First boot on a slow disk compiles the proxy + health route cold (minutes in a VM);
  // override with up --timeout, AFROUTER_HARNESS_BOOT_TIMEOUT or config bootTimeoutSec.
  const bootTimeoutMs = (opts.bootTimeoutSec || Number(process.env.AFROUTER_HARNESS_BOOT_TIMEOUT) || Number(loadConfig().bootTimeoutSec) || 600) * 1000;
  let died = false;
  const ready = await waitFor(() => health(state, 5000), {
    timeoutMs: bootTimeoutMs,
    intervalMs: 700,
    onTick: () => {
      if (!isAlive(pid)) {
        died = true;
        return false;
      }
      return true;
    },
  });
  if (!ready) {
    const tail = logTail(paths.logFile, 30);
    await down();
    throw new HarnessError(died ? "server process exited during boot" : `server not healthy after ${bootTimeoutMs / 1000}s`, { logTail: tail, logFile: paths.logFile });
  }
  const bootMs = Date.now() - t0;

  // Seed through the app's own APIs.
  const token = await mintToken(paths.dataDir);
  const auth = { cookie: `auth_token=${token}`, "content-type": "application/json" };
  const seed = {};
  const s1 = await fetchJson(`${baseUrl}/api/settings`, { method: "PATCH", headers: auth, body: JSON.stringify({ requireLogin: false }) });
  seed.settings = s1.status;
  if (s1.status !== 200) {
    const tail = logTail(paths.logFile, 30);
    await down();
    throw new HarnessError(`seeding settings failed (HTTP ${s1.status}); the minted token was rejected or the API is broken`, { body: s1.body, logTail: tail });
  }

  // DATA_DIR guard: the app must have used our secret and created its DB under our dir.
  const dbFile = path.join(paths.dataDir, "db", "data.sqlite");
  if (!fs.existsSync(dbFile) || fs.readFileSync(secretFile, "utf8") !== secretBefore) {
    await down();
    throw new HarnessError("DATA_DIR was not honoured by the server (no DB under the sandbox); aborting so the real data dir is never touched", { dataDir: paths.dataDir, realDataDir: realDataDir() });
  }

  const key = await fetchJson(`${baseUrl}/api/keys`, { method: "POST", headers: auth, body: JSON.stringify({ name: "agent-harness" }) });
  seed.apiKey = key.status;
  const node = await fetchJson(`${baseUrl}/api/provider-nodes`, {
    method: "POST", headers: auth,
    body: JSON.stringify({ name: "Fake Upstream", prefix: "fake", apiType: "chat", baseUrl: state.upstreamUrl, type: "openai-compatible" }),
  });
  seed.providerNode = node.status;
  let providerId = node.body?.node?.id;
  if (providerId) {
    const conn = await fetchJson(`${baseUrl}/api/providers`, {
      method: "POST", headers: auth,
      body: JSON.stringify({ provider: providerId, apiKey: "sk-fake-harness", name: "fake-harness", defaultModel: "fake-ok" }),
    });
    seed.connection = conn.status;
    state.connectionId = conn.body?.connection?.id;
  }
  Object.assign(state, {
    token,
    apiKey: key.body?.key,
    providerId,
    model: "fake/fake-ok",
    seed,
    bootMs,
    readyAt: new Date().toISOString(),
  });
  writeState(state);
  return { ok: true, reused: false, ...(cleanedBuild ? { cleanedBuild: ".next-agent" } : {}), ms: Date.now() - t0, ...publicState(state) };
}

export async function requireServer({ autoStart = true, ...opts } = {}) {
  const state = readState();
  if (state && isAlive(state.pid) && (await health(state))) return state;
  if (!autoStart) throw new HarnessError("no harness server running", { hint: "npm run agent -- up" });
  await up(opts);
  return readState();
}
