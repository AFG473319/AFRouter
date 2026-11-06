// `doctor`: which lanes work on this machine, measured rather than assumed. Writes
// .agent/capabilities.json so other commands can skip a lane instead of failing in it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { REPO_ROOT, CAPABILITIES_FILE, ensureDir, AGENT_DIR, sandboxRoot } from "./paths.mjs";
import { candidates, chooseSpec, candidatesFor, probe, writeCache, readCache, SET_PATH_HINT } from "./browsers.mjs";
import { which } from "./proc.mjs";
import { status, realDataDir } from "./server.mjs";

const require = createRequire(import.meta.url);

function pkgVersion(name, from = REPO_ROOT) {
  try {
    return JSON.parse(fs.readFileSync(require.resolve(`${name}/package.json`, { paths: [from] }), "utf8")).version;
  } catch {
    return null;
  }
}

function cpuFlags() {
  if (process.platform !== "linux" || process.arch !== "x64") return null;
  try {
    const flags = fs.readFileSync("/proc/cpuinfo", "utf8").match(/^flags\s*:\s*(.*)$/m)?.[1].split(/\s+/) || [];
    return { avx: flags.includes("avx"), avx2: flags.includes("avx2"), popcnt: flags.includes("popcnt"), sse4_2: flags.includes("sse4_2") };
  } catch {
    return null;
  }
}

function timed(fn) {
  const t0 = Date.now();
  try {
    const value = fn();
    return { ok: true, ms: Date.now() - t0, value };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e.message || e).split("\n")[0].slice(0, 300) };
  }
}

export async function doctor({ probeBrowsers = true, flag, config = {} } = {}) {
  const testsDir = path.join(REPO_ROOT, "tests");
  const lanes = {};

  lanes.next = { ok: !!pkgVersion("next"), version: pkgVersion("next") };
  lanes.eslint = { ok: !!pkgVersion("eslint"), version: pkgVersion("eslint") };

  const vitestBin = path.join(testsDir, "node_modules", "vitest", "vitest.mjs");
  if (fs.existsSync(vitestBin)) {
    // Loading vitest also loads Vite's native bindings: the thing most likely to trap on old CPUs.
    const r = timed(() => spawnSync(process.execPath, [vitestBin, "--version"], { cwd: testsDir, encoding: "utf8", timeout: 60_000 }));
    const out = r.value;
    lanes.vitest = { ok: r.ok && out?.status === 0, ms: r.ms, version: (out?.stdout || "").match(/vitest\/(\S+)/)?.[1] || pkgVersion("vitest", testsDir), vite: pkgVersion("vite", testsDir) };
    if (!lanes.vitest.ok) lanes.vitest.error = (out?.stderr || r.error || "").slice(0, 300);
  } else {
    lanes.vitest = { ok: false, error: "tests/node_modules missing", fix: "cd tests && npm install" };
  }
  lanes.testingLibrary = { ok: !!pkgVersion("@testing-library/react", testsDir), version: pkgVersion("@testing-library/react", testsDir), happyDom: pkgVersion("happy-dom", testsDir) };

  const hd = await (async () => {
    const t0 = Date.now();
    try {
      const { outlineHtml } = await import("./page.mjs");
      const o = outlineHtml("<main><h1>ok</h1><button>Go</button></main>");
      return { ok: o.lines.length === 3, ms: Date.now() - t0, version: pkgVersion("happy-dom") };
    } catch (e) {
      return { ok: false, ms: Date.now() - t0, error: e.message };
    }
  })();
  lanes.happyDom = hd;

  const sqlite = timed(() => {
    const { DatabaseSync } = require("node:sqlite");
    new DatabaseSync(":memory:").close();
    return "node:sqlite";
  });
  lanes.sqliteRead = sqlite.ok ? { ok: true, driver: "node:sqlite" } : { ok: !!pkgVersion("sql.js"), driver: "sql.js" };

  lanes.playwrightCore = { ok: !!pkgVersion("playwright-core"), version: pkgVersion("playwright-core") };

  const { spec, from } = chooseSpec({ flag, config });
  const found = candidates();
  const browsers = { spec, from, found: found.map((c) => ({ id: c.id, path: c.path, source: c.source })) };
  if (probeBrowsers && lanes.playwrightCore.ok) {
    const list = candidatesFor(spec);
    const results = [];
    for (const c of list) results.push(await probe(c));
    browsers.probed = results.map((r) => ({ id: r.id, path: r.path, source: r.source, ok: r.ok, ms: r.ms, version: r.version, error: r.error }));
    const best = results.find((r) => r.ok);
    if (best) writeCache(best);
    browsers.selected = best ? { id: best.id, path: best.path, version: best.version } : null;
  } else {
    const cache = readCache();
    browsers.selected = cache?.ok ? { id: cache.id, path: cache.path, version: cache.version, cached: true } : null;
  }
  if (!browsers.selected) browsers.howToSet = SET_PATH_HINT;
  lanes.browser = { ok: !!browsers.selected, ...browsers };
  lanes.ffmpeg = { ok: !!which("ffmpeg"), path: which("ffmpeg"), note: "only needed for flow --webm" };

  const flags = cpuFlags();
  const machine = {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    cpu: os.cpus()[0]?.model,
    cores: os.cpus().length,
    memGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeMemGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    ...(flags ? { cpuFlags: flags } : {}),
  };

  const advice = [];
  if (Number(process.versions.node.split(".")[0]) < 20) advice.push("Node >= 20 required (22 LTS recommended).");
  if (!lanes.vitest.ok) advice.push("Unit/DOM test lane unavailable: cd tests && npm install. If vitest crashes on load (old CPU), report it; do not switch to Bun.");
  if (!lanes.browser.ok) advice.push("No working browser: Layer 2 (shot/record) is off; Layer 1 still works. Set a path with --browser, AFROUTER_HARNESS_BROWSER_PATH, or config.");
  if (machine.memGB && machine.memGB <= 8) advice.push("8 GB machine: keep one harness server (`up` reuses it) and run `down` when done.");
  if (flags && !flags.avx2) advice.push("CPU has no AVX2: never use Bun here.");

  const caps = {
    ok: lanes.next.ok && lanes.happyDom.ok,
    machine,
    lanes,
    sandbox: { root: sandboxRoot(), realDataDir: realDataDir(), port: "free port (never 20128)" },
    server: await status(),
    advice,
    writtenAt: new Date().toISOString(),
  };
  ensureDir(AGENT_DIR);
  fs.writeFileSync(CAPABILITIES_FILE, JSON.stringify(caps, null, 2));
  return { ...caps, capabilitiesFile: CAPABILITIES_FILE };
}
