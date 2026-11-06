// Layer 1 UI lane: mount a dashboard page/component in happy-dom (Vitest + Testing Library)
// with fetch wired to the live isolated server, let its effects load data, then return an
// outline plus console/network/page errors. Flows run steps against that same DOM.
// No browser, no layout: CSS, hydration and pixels are out of scope (see `shot`).
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT } from "./paths.mjs";
import { requireServer, assertSafeDataDir } from "./server.mjs";
import { listPages, resolveRoute } from "./routes.mjs";
import { parseFlow } from "./flow.mjs";
import { HarnessError } from "./out.mjs";

const TESTS_DIR = path.join(REPO_ROOT, "tests");
const VITEST = path.join(TESTS_DIR, "node_modules", "vitest", "vitest.mjs");

function pagesIndex(state) {
  return listPages().map((p) => {
    const resolved = resolveRoute(p.route, state);
    const params = {};
    if (resolved && p.dynamic) {
      const names = [...p.route.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]);
      const values = resolved.split("/");
      p.route.split("/").forEach((seg, i) => {
        const n = seg.match(/^\[([^\]]+)\]$/);
        if (n && names.includes(n[1])) params[n[1]] = decodeURIComponent(values[i]);
      });
    }
    return { route: p.route, resolved, params, dynamic: p.dynamic, abs: path.join(REPO_ROOT, p.file) };
  });
}

export function resolveTarget(target, state, { params } = {}) {
  const pages = pagesIndex(state);
  if (target.startsWith("/")) {
    const [pathPart, search = ""] = target.split("?");
    const page = pages.find((p) => p.route === pathPart || p.resolved === pathPart)
      || pages.find((p) => p.dynamic && matchDynamic(p.route, pathPart));
    if (!page) throw new HarnessError(`no page.js for route ${pathPart}`, { routes: pages.map((p) => p.route) });
    const routeParams = { ...page.params, ...matchDynamic(page.route, pathPart), ...(params || {}) };
    return { target: { file: page.abs }, route: { path: pathPart, search: search ? `?${search}` : "", params: routeParams }, pages };
  }
  const [file, exportName] = target.split("#");
  const abs = path.resolve(REPO_ROOT, file);
  if (!fs.existsSync(abs)) throw new HarnessError(`file not found: ${file}`);
  return { target: { file: abs, exportName }, route: { path: "/dashboard", search: "", params: params || {} }, pages };
}

function matchDynamic(pattern, actual) {
  const a = pattern.split("/");
  const b = actual.split("/");
  if (a.length !== b.length) return null;
  const params = {};
  for (let i = 0; i < a.length; i++) {
    const m = a[i].match(/^\[([^\]]+)\]$/);
    if (m) params[m[1]] = decodeURIComponent(b[i]);
    else if (a[i] !== b[i]) return null;
  }
  return params;
}

function parseJsonArg(v, name) {
  if (v === undefined || v === true) return undefined;
  try {
    return JSON.parse(String(v));
  } catch {
    throw new HarnessError(`--${name} must be JSON`);
  }
}

export async function runJob(job, state, { runDir, timeoutMs = 240_000 } = {}) {
  if (!fs.existsSync(VITEST)) throw new HarnessError("tests/node_modules missing: cd tests && npm install");
  assertSafeDataDir(state.dataDir);
  const jobFile = path.join(runDir, "job.json");
  job.resultFile = path.join(runDir, "dom-result.json");
  job.srcRoot = path.join(REPO_ROOT, "src") + path.sep;
  fs.writeFileSync(jobFile, JSON.stringify(job, null, 2));
  const env = {
    ...process.env,
    AFR_HARNESS_JOB: jobFile,
    AFR_HARNESS_BASE_URL: state.baseUrl,
    AFR_HARNESS_COOKIE: `auth_token=${state.token}`,
    AFR_HARNESS_URL: new URL(job.route.path + (job.route.search || ""), state.baseUrl).href,
    // In-process imports of src/lib/* resolve DATA_DIR at import time: point them at the sandbox.
    DATA_DIR: state.dataDir,
    HOME: state.homeDir,
    USERPROFILE: state.homeDir,
    NODE_ENV: "test",
  };
  if (process.platform === "win32") {
    env.APPDATA = path.join(state.homeDir, "AppData", "Roaming");
    env.LOCALAPPDATA = path.join(state.homeDir, "AppData", "Local");
  }
  const t0 = Date.now();
  const { code, output } = await new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, "run", "--config", "harness/vitest.dom.config.js", "--reporter=dot", "--no-color"], { cwd: TESTS_DIR, env, windowsHide: true });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (c) => {
      clearTimeout(timer);
      resolve({ code: c, output: out });
    });
  });
  fs.writeFileSync(path.join(runDir, "vitest.log"), output);
  let result;
  try {
    result = JSON.parse(fs.readFileSync(job.resultFile, "utf8"));
  } catch {
    const tail = output.split(/\r?\n/).filter((l) => l.trim()).slice(-25).map((l) => l.slice(0, 300));
    throw new HarnessError(`DOM runner produced no result (vitest exit ${code})`, { logTail: tail, log: path.join(runDir, "vitest.log") });
  }
  return { ...result, totalMs: Date.now() - t0 };
}

export async function render({ target, props, params, search, runDir, waitMs }) {
  const state = await requireServer();
  const resolved = resolveTarget(search ? `${target}?${search}` : target, state, { params: parseJsonArg(params, "params") });
  const job = {
    kind: "render",
    baseUrl: state.baseUrl,
    cookie: `auth_token=${state.token}`,
    apiKey: state.apiKey,
    target: resolved.target,
    route: resolved.route,
    pages: resolved.pages,
    props: parseJsonArg(props, "props"),
    waitMs,
    steps: [],
  };
  const r = await runJob(job, state, { runDir });
  return { ok: r.ok, engine: "happy-dom", target, file: path.relative(REPO_ROOT, resolved.target.file).split(path.sep).join("/"), ...r, notCovered: ["css/layout", "hydration", "pixels"] };
}

export async function runDomFlow({ file, runDir }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new HarnessError(`flow file not found: ${file}`);
  let flow;
  try {
    flow = parseFlow(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new HarnessError(`invalid flow: ${e.message}`);
  }
  const state = await requireServer();
  const resolved = resolveTarget(flow.route, state);
  const job = {
    kind: "flow",
    name: flow.name,
    baseUrl: state.baseUrl,
    cookie: `auth_token=${state.token}`,
    apiKey: state.apiKey,
    target: resolved.target,
    route: resolved.route,
    pages: resolved.pages,
    steps: flow.steps,
  };
  const r = await runJob(job, state, { runDir });
  const out = { ok: r.ok, name: flow.name, route: flow.route, ...r };
  if (!r.ok) out.advice = "Fix the failing step (see steps[].error and outline). If the same step fails twice, stop and report.";
  return out;
}
