// Layer 2 browser discovery. Finds an installed Chromium-family browser (Edge, Chrome, Brave,
// Chromium, or a Playwright-cached build), proves it works by launching it headless and taking
// a 1x1 screenshot, and caches the winner. No browser is ever downloaded.
//
// Choice precedence: --browser flag > AFROUTER_HARNESS_BROWSER_PATH > AFROUTER_HARNESS_BROWSER
//   > config "browser" > "auto". A value is "auto", an id (chrome|edge|chromium|brave|playwright),
//   or a path to an executable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BROWSER_CACHE_FILE, ensureDir, AGENT_DIR } from "./paths.mjs";
import { which as whichBin } from "./proc.mjs";
import { HarnessError } from "./out.mjs";

export const BROWSER_IDS = ["edge", "chrome", "chromium", "brave", "playwright"];
const ALIASES = { msedge: "edge", "microsoft-edge": "edge", "google-chrome": "chrome", "chrome-headless-shell": "playwright" };

export const SET_PATH_HINT = {
  flag: "npm run agent -- shot /dashboard --browser <chrome|edge|chromium|brave|C:\\path\\to\\browser.exe>",
  env: "AFROUTER_HARNESS_BROWSER_PATH=/path/to/chrome   (or AFROUTER_HARNESS_BROWSER=edge)",
  config: "agent-harness.config.json or .agent/config.json: { \"browser\": \"/path/to/chrome\" }",
};

const ORDER = {
  win32: ["edge", "chrome", "brave", "chromium", "playwright"],
  darwin: ["chrome", "edge", "chromium", "brave", "playwright"],
  linux: ["chrome", "chromium", "edge", "brave", "playwright"],
};

function globDirs(readdir, dir, prefix, p) {
  try {
    return readdir(dir).filter((n) => n.startsWith(prefix)).sort().reverse().map((n) => p.join(dir, n));
  } catch {
    return [];
  }
}

function playwrightCandidates({ platform, env, home, readdir }) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const roots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") roots.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (platform === "win32") roots.push(p.join(env.LOCALAPPDATA || p.join(home, "AppData", "Local"), "ms-playwright"));
  else if (platform === "darwin") roots.push(p.join(home, "Library", "Caches", "ms-playwright"));
  else roots.push(p.join(env.XDG_CACHE_HOME || p.join(home, ".cache"), "ms-playwright"));
  const rel = {
    win32: [["chromium-", ["chrome-win64", "chrome.exe"]], ["chromium-", ["chrome-win", "chrome.exe"]], ["chromium_headless_shell-", ["chrome-headless-shell-win64", "chrome-headless-shell.exe"]], ["chromium_headless_shell-", ["chrome-win", "headless_shell.exe"]]],
    darwin: [["chromium-", ["chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"]], ["chromium-", ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"]], ["chromium_headless_shell-", ["chrome-headless-shell-mac-arm64", "chrome-headless-shell"]], ["chromium_headless_shell-", ["chrome-mac", "headless_shell"]]],
    linux: [["chromium-", ["chrome-linux64", "chrome"]], ["chromium-", ["chrome-linux", "chrome"]], ["chromium_headless_shell-", ["chrome-headless-shell-linux64", "chrome-headless-shell"]], ["chromium_headless_shell-", ["chrome-linux", "headless_shell"]]],
  }[platform] || [];
  const out = [];
  for (const root of roots) {
    for (const [prefix, tail] of rel) {
      for (const dir of globDirs(readdir, root, prefix, p)) out.push({ id: "playwright", path: p.join(dir, ...tail), source: "playwright-cache" });
    }
  }
  return out;
}

/** Windows "App Paths" registry lookup; returns the default value or null. */
export function regAppPath(exe) {
  for (const hive of ["HKCU", "HKLM"]) {
    const r = spawnSync("reg", ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"], { encoding: "utf8", windowsHide: true });
    const m = r.stdout && r.stdout.match(/REG_SZ\s+(.+)\s*$/m);
    if (m) return m[1].trim().replace(/^"|"$/g, "");
  }
  return null;
}

/**
 * Every place a Chromium-family browser usually lives, in preference order, filtered to
 * files that exist. All system access is injectable for tests.
 */
export function candidates({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
  exists = (p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  },
  readdir = (d) => fs.readdirSync(d),
  realpath = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return p;
    }
  },
  regQuery = platform === "win32" ? regAppPath : () => null,
  which = (bin) => whichBin(bin, env, platform),
} = {}) {
  const list = [];
  const add = (id, p, source) => p && list.push({ id, path: p, source });

  if (platform === "win32") {
    const w = path.win32;
    const pf = env.ProgramFiles || "C:\\Program Files";
    const pf86 = env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const lad = env.LOCALAPPDATA || w.join(home, "AppData", "Local");
    for (const root of [pf86, pf, lad]) add("edge", w.join(root, "Microsoft", "Edge", "Application", "msedge.exe"), "standard");
    add("edge", regQuery("msedge.exe"), "registry");
    for (const root of [pf, pf86, lad]) add("chrome", w.join(root, "Google", "Chrome", "Application", "chrome.exe"), "standard");
    add("chrome", regQuery("chrome.exe"), "registry");
    for (const root of [pf, pf86, lad]) add("brave", w.join(root, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), "standard");
    add("brave", regQuery("brave.exe"), "registry");
    add("chromium", w.join(lad, "Chromium", "Application", "chrome.exe"), "standard");
    add("edge", which("msedge"), "PATH");
    add("chrome", which("chrome"), "PATH");
    add("chromium", which("chromium"), "PATH");
  } else if (platform === "darwin") {
    const p = path.posix;
    for (const root of ["/Applications", p.join(home, "Applications")]) {
      add("chrome", p.join(root, "Google Chrome.app", "Contents", "MacOS", "Google Chrome"), "standard");
      add("edge", p.join(root, "Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"), "standard");
      add("chromium", p.join(root, "Chromium.app", "Contents", "MacOS", "Chromium"), "standard");
      add("brave", p.join(root, "Brave Browser.app", "Contents", "MacOS", "Brave Browser"), "standard");
    }
    add("chrome", which("google-chrome"), "PATH");
    add("chromium", which("chromium"), "PATH");
  } else {
    const p = path.posix;
    for (const [id, bins] of [["chrome", ["google-chrome-stable", "google-chrome"]], ["chromium", ["chromium", "chromium-browser"]], ["edge", ["microsoft-edge-stable", "microsoft-edge"]], ["brave", ["brave-browser", "brave"]]]) {
      for (const b of bins) add(id, which(b), "PATH");
    }
    add("chrome", "/opt/google/chrome/chrome", "standard");
    add("chromium", "/usr/bin/chromium", "standard");
    add("chromium", "/usr/lib/chromium/chromium", "standard");
    add("edge", "/opt/microsoft/msedge/msedge", "standard");
    add("brave", "/opt/brave.com/brave/brave", "standard");
    add("chromium", "/snap/bin/chromium", "snap");
    add("brave", "/snap/bin/brave", "snap");
    for (const root of ["/var/lib/flatpak/exports/bin", p.join(home, ".local", "share", "flatpak", "exports", "bin")]) {
      add("chrome", p.join(root, "com.google.Chrome"), "flatpak");
      add("chromium", p.join(root, "org.chromium.Chromium"), "flatpak");
      add("edge", p.join(root, "com.microsoft.Edge"), "flatpak");
      add("brave", p.join(root, "com.brave.Browser"), "flatpak");
    }
  }
  list.push(...playwrightCandidates({ platform, env, home, readdir }));

  const seen = new Set();
  const order = ORDER[platform] || ORDER.linux;
  const rank = (c) => order.indexOf(c.id) * 10 + (c.source === "flatpak" ? 5 : 0);
  return list
    .filter((c) => {
      if (!exists(c.path)) return false;
      const real = realpath(c.path);
      const key = platform === "win32" ? real.toLowerCase() : real;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c, i) => ({ ...c, _i: i }))
    .sort((a, b) => rank(a) - rank(b) || a._i - b._i)
    .map(({ _i, ...c }) => c);
}

export function normalizeSpec(spec) {
  if (spec === undefined || spec === null || spec === true || spec === "") return "auto";
  const s = String(spec).trim();
  const lower = s.toLowerCase();
  if (lower === "auto") return "auto";
  if (ALIASES[lower]) return ALIASES[lower];
  if (BROWSER_IDS.includes(lower)) return lower;
  return s; // a path
}

export function isPathSpec(spec) {
  return spec !== "auto" && !BROWSER_IDS.includes(spec);
}

/** Decide which spec applies and where it came from. */
export function chooseSpec({ flag, env = process.env, config = {} } = {}) {
  if (flag !== undefined && flag !== true) return { spec: normalizeSpec(flag), from: "flag" };
  if (env.AFROUTER_HARNESS_BROWSER_PATH) return { spec: env.AFROUTER_HARNESS_BROWSER_PATH, from: "env:AFROUTER_HARNESS_BROWSER_PATH" };
  if (env.AFROUTER_HARNESS_BROWSER) return { spec: normalizeSpec(env.AFROUTER_HARNESS_BROWSER), from: "env:AFROUTER_HARNESS_BROWSER" };
  if (config.browser) return { spec: normalizeSpec(config.browser), from: `config:${config._file || "config"}` };
  return { spec: "auto", from: "default" };
}

/** Candidates for a spec: a path is taken as-is; an id filters the detected list. */
export function candidatesFor(spec, detectOpts = {}) {
  if (isPathSpec(spec)) return [{ id: "custom", path: spec, source: "user" }];
  const all = candidates(detectOpts);
  return spec === "auto" ? all : all.filter((c) => c.id === spec);
}

export const LAUNCH_ARGS = ["--disable-gpu", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio", "--hide-scrollbars", "--disable-background-networking", "--disable-component-update", "--disable-sync"];

export async function loadPlaywright() {
  try {
    const mod = await import("playwright-core");
    return mod.chromium || mod.default?.chromium;
  } catch (e) {
    throw new HarnessError("playwright-core is not installed (it is a devDependency; run npm install). Layer 1 commands still work.", { cause: e.message });
  }
}

export async function launchBrowser(candidate, { timeoutMs = 45_000, extraArgs = [] } = {}) {
  const chromium = await loadPlaywright();
  return chromium.launch({ executablePath: candidate.path, headless: true, timeout: timeoutMs, args: [...LAUNCH_ARGS, ...extraArgs] });
}

/** Launch headless and capture a 1x1 PNG; proves the binary really works on this machine. */
export async function probe(candidate, { timeoutMs = 45_000 } = {}) {
  const t0 = Date.now();
  if (!fs.existsSync(candidate.path)) return { ...candidate, ok: false, error: "file not found" };
  let browser;
  try {
    browser = await launchBrowser(candidate, { timeoutMs });
    const page = await browser.newPage({ viewport: { width: 8, height: 8 } });
    await page.setContent("<html><body style='margin:0;background:#123456'></body></html>");
    const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1, height: 1 }, timeout: timeoutMs });
    const isPng = png.length > 8 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47;
    if (!isPng) throw new Error("screenshot was not a PNG");
    return { ...candidate, ok: true, ms: Date.now() - t0, version: browser.version() };
  } catch (e) {
    return { ...candidate, ok: false, ms: Date.now() - t0, error: String(e.message || e).split("\n")[0].slice(0, 300) };
  } finally {
    await browser?.close().catch(() => {});
  }
}

export function readCache() {
  try {
    return JSON.parse(fs.readFileSync(BROWSER_CACHE_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeCache(entry) {
  ensureDir(AGENT_DIR);
  let mtimeMs;
  try {
    mtimeMs = fs.statSync(entry.path).mtimeMs;
  } catch {
    /* ignore */
  }
  fs.writeFileSync(BROWSER_CACHE_FILE, JSON.stringify({ ...entry, mtimeMs, cachedAt: new Date().toISOString() }, null, 2));
}

export function clearCache() {
  fs.rmSync(BROWSER_CACHE_FILE, { force: true });
}

export function cacheMatches(cache, spec) {
  if (!cache?.path || !cache.ok) return false;
  try {
    if (fs.statSync(cache.path).mtimeMs !== cache.mtimeMs) return false;
  } catch {
    return false;
  }
  if (spec === "auto") return true;
  if (isPathSpec(spec)) return path.resolve(spec) === path.resolve(cache.path);
  return cache.id === spec;
}

/**
 * Resolve a working browser. Uses the cache when it still matches; otherwise probes
 * candidates in order and caches the first that works. `exclude` skips paths that just failed.
 */
export async function pickBrowser({ flag, env = process.env, config = {}, useCache = true, exclude = [] } = {}) {
  const { spec, from } = chooseSpec({ flag, env, config });
  const cache = useCache ? readCache() : null;
  if (cache && !exclude.includes(cache.path) && cacheMatches(cache, spec)) return { ...cache, spec, from, cached: true };
  const list = candidatesFor(spec).filter((c) => !exclude.includes(c.path));
  const tried = [];
  for (const c of list) {
    const r = await probe(c);
    tried.push({ id: r.id, path: r.path, source: r.source, ok: r.ok, ms: r.ms, error: r.error });
    if (r.ok) {
      writeCache(r);
      return { ...r, spec, from, cached: false, tried };
    }
  }
  throw new HarnessError(
    list.length ? `no working browser for "${spec}" (${list.length} tried)` : `no browser found for "${spec}"`,
    { spec, from, tried, howToSet: SET_PATH_HINT, note: "Layer 1 (check/page/api/chat/render/flow) works without a browser." },
  );
}
