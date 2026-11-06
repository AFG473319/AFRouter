#!/usr/bin/env node
// AFRouter agent harness. Usage: npm run agent -- <command> [args]
// Every command prints ONE JSON object (≤20 KB) on stdout; bulky output goes to .agent/runs/.
import { parseArgs, num, list } from "./lib/args.mjs";
import { emit, HarnessError } from "./lib/out.mjs";
import { newRunDir } from "./lib/paths.mjs";
import { loadConfig } from "./lib/config.mjs";

// node:sqlite (read-only state inspection) prints an ExperimentalWarning on Node 22; agents
// parse stdout only, but keep stderr quiet too.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (/SQLite is an experimental feature/.test(String(warning?.message || warning))) return;
  emitWarning.call(process, warning, ...rest);
};

const HELP = `AFRouter agent harness: npm run agent -- <command>
Layer 1 (default, no browser):
  doctor                 what works on this machine (run once)
  up | down | status     isolated server (temp DATA_DIR + HOME, free port, fake upstream); up reuses a warm one
                         up --clean-build wipes .next-agent first (stale/corrupt dev build)
  check [--changed]      lint + related tests (baseline-aware) + Next errors + server log + pages + chat smoke
  page <route..>|--all   server HTML -> role/text outline (SSR view)
  render <file|route>    mount a client page/component in happy-dom against the live API; outline after data loads
  flow <file.json>       scripted UI steps (goto/click/fill/expect/api...) in happy-dom (default) or --engine browser
  api <METHOD> <path>    one HTTP call (session cookie for /api, API key for /v1) [--data JSON|@file]
  chat                   request through the gateway to the fake upstream [--format openai|anthropic|responses] [--model fake/fake-429]
  test [files] [-t name] vitest in tests/ (2 workers, known-fails aware) [--related a.js,b.js] [--dom] [--watch]
  errors | logs | state  Next /_next/mcp errors, server log, temp DB / sandbox files (read-only)
  watch                  re-check on every save; NDJSON to stdout and .agent/watch.ndjson [--server] [--once]
Layer 2 (only for visual changes or when asked; headless system browser, nothing downloaded):
  shot <route>           screenshot + AI aria snapshot + console/network errors [--full] [--width] [--dark] [--baseline name]
  record <flow.json>     run a flow in the browser with frames + contact sheet [--webm needs ffmpeg]
  diff <a.png> <b.png>   pixel diff
Browser choice: --browser auto|edge|chrome|chromium|brave|<path>, AFROUTER_HARNESS_BROWSER_PATH, or "browser" in agent-harness.config.json.
Global: --pretty. Exit 0 ok, 1 check failed, 2 harness error.`;

const COMMANDS = {
  async doctor(a, ctx) {
    const { doctor } = await import("./lib/doctor.mjs");
    return { cmd: "doctor", ...(await doctor({ probeBrowsers: a.probe !== false, flag: a.browser, config: ctx.config })) };
  },
  async up(a) {
    const { up } = await import("./lib/server.mjs");
    return { cmd: "up", ...(await up({ cleanBuild: !!a.cleanBuild, fresh: !!a.fresh || !!a.cleanBuild, prod: !!a.prod, webpack: !!a.webpack, port: a.port, keepData: !!a.keepData, bootTimeoutSec: num(a.timeout, undefined) })) };
  },
  async down(a) {
    const { down } = await import("./lib/server.mjs");
    return { cmd: "down", ...(await down({ clean: !!a.clean })) };
  },
  async status() {
    const { status } = await import("./lib/server.mjs");
    const s = await status();
    return { cmd: "status", ok: true, ...s };
  },
  async api(a) {
    const [method, pathName] = a._;
    if (!method || !pathName) throw new HarnessError("usage: api <METHOD> <path> [--data JSON|@file] [--auth auto|session|key|none]");
    const { requireServer } = await import("./lib/server.mjs");
    const { request, parseBodyArg, summarize } = await import("./lib/http.mjs");
    const { logSize, readSince, classify } = await import("./lib/logs.mjs");
    const state = await requireServer();
    const headers = {};
    for (const h of list(a.header)) {
      const i = h.indexOf(":");
      if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
    }
    const before = logSize(state.logFile);
    const res = await request(state, method, pathName, { body: parseBodyArg(a.data), auth: a.auth || "auto", headers, origin: a.origin });
    const serverErrors = classify(readSince(state.logFile, before)).errors;
    const out = { cmd: "api", ok: res.status < 400, method: method.toUpperCase(), path: pathName, status: res.status, ms: res.ms, headers: res.headers, bytes: res.bytes };
    if (res.json !== undefined) out.body = a.raw ? res.json : summarize(res.json);
    else out.text = res.text.slice(0, 2000);
    if (serverErrors.length) out.serverErrors = serverErrors;
    return out;
  },
  async chat(a) {
    const { requireServer } = await import("./lib/server.mjs");
    const { chat } = await import("./lib/chat.mjs");
    const state = await requireServer();
    return { cmd: "chat", ...(await chat(state, { model: a.model, prompt: a.prompt, stream: a.stream !== false, format: a.format || "openai", tools: !!a.tools })) };
  },
  async page(a, ctx) {
    const { requireServer } = await import("./lib/server.mjs");
    const { checkPage } = await import("./lib/page.mjs");
    const { listPages, resolveRoute } = await import("./lib/routes.mjs");
    const state = await requireServer();
    let routes = a._;
    const skipped = [];
    if (a.all) {
      routes = [];
      for (const p of listPages()) {
        const r = resolveRoute(p.route, state);
        if (r) routes.push(r);
        else skipped.push(p.route);
      }
    }
    if (!routes.length) throw new HarnessError("usage: page <route...> | page --all");
    const runDir = newRunDir("page");
    ctx.runDir = runDir;
    const pages = [];
    for (const r of routes) pages.push(await checkPage(state, r, { runDir, maxLines: routes.length > 3 ? 60 : 250 }));
    const failed = pages.filter((p) => !p.ok);
    return { cmd: "page", ok: failed.length === 0, ssrOnly: true, pages, ...(skipped.length ? { skipped } : {}), ...(failed.length ? { failures: failed.map((p) => `${p.route}: ${p.error || (p.errors || []).join("; ") || `HTTP ${p.status}`}`) } : {}) };
  },
  async errors() {
    const { requireServer } = await import("./lib/server.mjs");
    const { nextErrors } = await import("./lib/nextMcp.mjs");
    const { classify, readSince } = await import("./lib/logs.mjs");
    const state = await requireServer({ autoStart: false });
    const next = await nextErrors(state);
    const log = classify(readSince(state.logFile, 0), { limit: 20 });
    return { cmd: "errors", ok: !(next.errors?.length) && !log.errors.length, nextMcp: next, serverLog: log, logFile: state.logFile };
  },
  async logs(a) {
    const { readState, logTail } = await import("./lib/server.mjs");
    const { classify, readSince } = await import("./lib/logs.mjs");
    const state = readState();
    if (!state) throw new HarnessError("no harness server state", { hint: "npm run agent -- up" });
    if (a.all || a.grep) {
      let lines = logTail(state.logFile, num(a.tail, 400));
      if (a.grep) {
        const re = new RegExp(String(a.grep), "i");
        lines = lines.filter((l) => re.test(l));
      }
      return { cmd: "logs", ok: true, logFile: state.logFile, logTail: lines.slice(-num(a.tail, 60)) };
    }
    const c = classify(readSince(state.logFile, 0));
    return { cmd: "logs", ok: true, logFile: state.logFile, errors: c.errors, warnings: c.warnings.slice(-10), logTail: logTail(state.logFile, num(a.tail, 15)) };
  },
  async state(a) {
    const { readState } = await import("./lib/server.mjs");
    const st = await import("./lib/state.mjs");
    const state = readState();
    if (!state) throw new HarnessError("no harness server state", { hint: "npm run agent -- up" });
    if (a.files) return { cmd: "state", ok: true, files: st.listFiles(state) };
    if (a.file) return { cmd: "state", ok: true, ...st.readSandboxFile(state, a.file) };
    return { cmd: "state", ok: true, dataDir: state.dataDir, ...(await st.inspect(state, { table: a._[0], sql: a.sql, limit: num(a.limit, 20) })) };
  },
  async test(a, ctx) {
    const { runVitest } = await import("./lib/vitest.mjs");
    const runDir = newRunDir("test");
    ctx.runDir = runDir;
    return { cmd: "test", ...(await runVitest({ files: a._, related: list(a.related), testName: a.testName, watch: !!a.watch, dom: !!a.dom, runDir })) };
  },
  async check(a, ctx) {
    const { check } = await import("./lib/check.mjs");
    const runDir = newRunDir("check");
    ctx.runDir = runDir;
    return { cmd: "check", ...(await check({
      changed: a.changed !== false,
      base: a.base,
      files: list(a.files),
      server: a.server !== false,
      tests: a.tests !== false,
      lint: a.lint !== false,
      render: a.render !== false,
      routes: list(a.routes),
      allRoutes: !!a.allRoutes,
      runDir,
    })) };
  },
  async render(a, ctx) {
    const { render } = await import("./lib/dom.mjs");
    const target = a._[0];
    if (!target) throw new HarnessError("usage: render <component-file|route> [--props JSON] [--params JSON]");
    const runDir = newRunDir("render");
    ctx.runDir = runDir;
    return { cmd: "render", ...(await render({ target, props: a.props, params: a.params, search: a.search, runDir, waitMs: num(a.wait, undefined) })) };
  },
  async flow(a, ctx) {
    const file = a._[0];
    if (!file) throw new HarnessError("usage: flow <file.json> [--engine dom|browser]");
    const runDir = newRunDir("flow");
    ctx.runDir = runDir;
    const engine = a.engine || (a.frames || a.webm ? "browser" : "dom");
    if (engine === "browser") {
      const { runBrowserFlow } = await import("./lib/browser.mjs");
      return { cmd: "flow", engine, ...(await runBrowserFlow({ file, runDir, flag: a.browser, config: ctx.config, frames: !!a.frames, webm: !!a.webm, width: num(a.width, undefined), height: num(a.height, undefined) })) };
    }
    const { runDomFlow } = await import("./lib/dom.mjs");
    return { cmd: "flow", engine, ...(await runDomFlow({ file, runDir })) };
  },
  async record(a, ctx) {
    return COMMANDS.flow({ ...a, engine: "browser", frames: true }, ctx);
  },
  async shot(a, ctx) {
    const route = a._[0];
    if (!route) throw new HarnessError("usage: shot <route> [--full] [--width W] [--height H] [--dark] [--jpeg] [--baseline name]");
    const { shot } = await import("./lib/browser.mjs");
    const runDir = newRunDir("shot");
    ctx.runDir = runDir;
    return { cmd: "shot", ...(await shot({ route, runDir, flag: a.browser, config: ctx.config, full: !!a.full, width: num(a.width, undefined), height: num(a.height, undefined), dark: !!a.dark, jpeg: !!a.jpeg, baseline: a.baseline === true ? route : a.baseline, updateBaseline: !!a.updateBaseline })) };
  },
  async diff(a, ctx) {
    const [x, y] = a._;
    if (!x || !y) throw new HarnessError("usage: diff <a.png> <b.png> [--threshold 0.1]");
    const { diffPng } = await import("./lib/diff.mjs");
    const runDir = newRunDir("diff");
    ctx.runDir = runDir;
    return { cmd: "diff", ...(diffPng(x, y, { out: `${runDir}/diff.png`, threshold: num(a.threshold, 0.1) })) };
  },
  async watch(a) {
    const { watch } = await import("./lib/watch.mjs");
    await watch({ intervalMs: num(a.debounce, 800), server: !!a.server, once: !!a.once });
    return null;
  },
};

async function main() {
  const argv = process.argv.slice(2);
  const a = parseArgs(argv);
  const cmd = a._.shift();
  if (!cmd || a.help || cmd === "help") {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  const fn = COMMANDS[cmd];
  const ctx = { config: loadConfig(), runDir: undefined };
  if (!fn) {
    emit({ ok: false, cmd, error: `unknown command "${cmd}"`, commands: Object.keys(COMMANDS) }, { pretty: !!a.pretty });
    process.exitCode = 2;
    return;
  }
  const t0 = Date.now();
  try {
    const result = await fn(a, ctx);
    if (result) {
      if (result.ms === undefined) result.ms = Date.now() - t0;
      emit(result, { pretty: !!a.pretty, runDir: ctx.runDir });
    }
  } catch (e) {
    const extra = e instanceof HarnessError ? e.extra : { stack: String(e.stack || "").split("\n").slice(0, 4).join(" | ") };
    emit({ ok: false, cmd, error: e.message, ...extra, advice: "If this fails twice the same way, stop retrying and report the error." }, { pretty: !!a.pretty, runDir: ctx.runDir });
    process.exitCode = 2;
  }
}

// Exit as soon as the JSON is flushed: keep-alive sockets and child pipes must not hold an
// agent's shell for extra seconds.
main().finally(() => {
  const cmd = process.argv.slice(2).find((x) => !x.startsWith("-"));
  if (cmd !== "watch") process.stdout.write("", () => process.exit());
});
