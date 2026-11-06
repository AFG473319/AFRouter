// `check`: the one command to run after every change. Browserless. Runs, in order of cost:
//   lint (changed lines only) -> related unit tests (+ DOM tests) vs the known-fails baseline
//   -> isolated server: Next /_next/mcp errors, health/API smoke, a chat through the fake
//      upstream, SSR outline of affected pages, happy-dom render of affected client pages,
//      server log errors caused by this check, temp DB integrity.
import path from "node:path";
import { changedFiles, defaultBase } from "./changed.mjs";
import { lintFiles } from "./lint.mjs";
import { runVitest } from "./vitest.mjs";
import { requireServer } from "./server.mjs";
import { request } from "./http.mjs";
import { chat } from "./chat.mjs";
import { checkPage } from "./page.mjs";
import { nextErrors } from "./nextMcp.mjs";
import { logSize, readSince, classify } from "./logs.mjs";
import { routesForChangedFiles, apiRoutesForChangedFiles } from "./routes.mjs";
import { inspect } from "./state.mjs";

const SOURCE = /^(src|open-sse|custom-server\.js|scripts\/agent)\b.*\.(js|mjs|cjs|jsx)$/;
const TEST_FILE = /^tests\/.*\.test\.js$/;
const VISUAL = /(\.css$|tailwind|className=|globals\.css|\/components\/)/;

export async function check({ changed = true, base, files = [], server = true, tests = true, lint = true, render = true, routes = [], allRoutes = false, runDir }) {
  const t0 = Date.now();
  const baseRef = base || defaultBase();
  const list = files.length ? files : changed ? changedFiles(baseRef) : [];
  const result = { ok: true, base: baseRef, changed: list.slice(0, 60), changedCount: list.length, failures: [] };
  const fail = (msg) => {
    result.ok = false;
    result.failures.push(msg);
  };

  // Lint loads ~300 rule modules (slow cold start); run it alongside everything else.
  const lintPromise = lint ? lintFiles(list, { base: baseRef, runDir }) : null;

  if (tests) {
    const related = list.filter((f) => SOURCE.test(f) || TEST_FILE.test(f) || f.endsWith(".dom.test.js"));
    if (related.length) {
      result.tests = await runVitest({ related, runDir });
      if (!result.tests.ok) fail(`tests: ${result.tests.regressions ?? "?"} regression(s)${result.tests.error ? ` (${result.tests.error})` : ""}`);
      const dom = await runVitest({ related, dom: true, runDir });
      if (dom.files) {
        result.domTests = dom;
        if (!dom.ok) fail(`dom tests: ${dom.regressions ?? "?"} failure(s)${dom.error ? ` (${dom.error})` : ""}`);
      }
    } else result.tests = { ok: true, note: "no changed source/test files" };
  }

  let state = null;
  if (server) {
    // A server that fails to boot is one failure among the others, not a reason to lose the
    // lint and test results already gathered.
    try {
      state = await requireServer();
    } catch (e) {
      result.server = { ok: false, error: e.message, ...(e.extra?.logTail ? { logTail: e.extra.logTail.slice(-15) } : {}), ...(e.extra?.logFile ? { logFile: e.extra.logFile } : {}) };
      fail(`server: ${e.message}`);
    }
  }
  if (state) {
    const offset = logSize(state.logFile);
    result.server = { baseUrl: state.baseUrl, mode: state.mode };

    const nx = await nextErrors(state);
    result.nextErrors = nx.available ? nx.errors : { unavailable: nx.reason };
    if (nx.available && nx.errors.length) fail(`next: ${nx.errors.length} error(s) reported by /_next/mcp get_errors`);

    const smoke = [];
    const probes = [["GET", "/api/health"], ["GET", "/v1/models"], ...apiRoutesForChangedFiles(list).filter((p) => !p.includes("[")).slice(0, 6).map((p) => ["GET", p])];
    for (const [m, p] of probes) {
      try {
        const r = await request(state, m, p, { timeoutMs: 180_000 });
        smoke.push(`${m} ${p} ${r.status} ${r.ms}ms`);
        if (r.status >= 500) fail(`api: ${m} ${p} -> ${r.status}`);
      } catch (e) {
        smoke.push(`${m} ${p} ERR ${e.message}`);
        fail(`api: ${m} ${p} -> ${e.message}`);
      }
    }
    result.api = smoke;

    try {
      const c = await chat(state, { stream: true });
      result.chat = { status: c.status, ms: c.ms, chunks: c.chunks, text: c.text, finish: c.finish, upstreamCalls: c.upstream?.length };
      if (!c.ok) fail(`chat: gateway -> fake upstream failed (HTTP ${c.status}${c.errors?.length ? `: ${c.errors[0]}` : ""})`);
    } catch (e) {
      fail(`chat: ${e.message}`);
    }

    const pageRoutes = routes.length ? routes : routesForChangedFiles(list);
    if (allRoutes || !pageRoutes.includes("/dashboard")) pageRoutes.unshift("/dashboard");
    result.pages = [];
    for (const r of [...new Set(pageRoutes)].slice(0, 8)) {
      const p = await checkPage(state, r, { runDir, maxLines: 25 });
      result.pages.push(p);
      if (!p.ok) fail(`page ${r}: ${p.error || (p.errors || []).join("; ") || `HTTP ${p.status}`}`);
    }

    const renderRoutes = pageRoutes.filter((r) => r !== "/dashboard" || list.some((f) => /^src\/app\/\(dashboard\)\/dashboard\/(page|endpoint)/.test(f))).slice(0, 2);
    if (render && renderRoutes.length) {
      const { render: renderPage } = await import("./dom.mjs");
      result.renders = [];
      for (const r of renderRoutes) {
        try {
          const rr = await renderPage({ target: r, runDir: path.join(runDir) });
          result.renders.push({ route: r, ok: rr.ok, error: rr.error, pageErrors: rr.pageErrors, failedRequests: rr.failedRequests, consoleErrors: (rr.console || []).filter((c) => c.level === "error").slice(0, 5), outline: (rr.outline || []).slice(0, 25) });
          if (!rr.ok) fail(`render ${r}: ${rr.error || (rr.pageErrors || [])[0] || "failed"}`);
        } catch (e) {
          result.renders.push({ route: r, ok: false, error: e.message });
          fail(`render ${r}: ${e.message}`);
        }
      }
    }

    const logs = classify(readSince(state.logFile, offset), { limit: 20 });
    result.serverLog = { errors: logs.errors, warnings: logs.warnings.slice(-5), file: state.logFile };
    if (logs.errors.length) fail(`server log: ${logs.errors.length} error line(s) during this check`);

    try {
      const db = await inspect(state);
      result.db = { integrity: db.integrity, tables: Object.keys(db.tables || {}).length };
      if (db.integrity !== "ok") fail(`db: integrity ${db.integrity}`);
    } catch (e) {
      result.db = { error: e.message };
    }
  }

  if (lintPromise) {
    result.lint = await lintPromise;
    if (!result.lint.ok) fail(`lint: ${result.lint.newErrors ?? "?"} new error(s)${result.lint.error ? ` (${result.lint.error})` : ""}`);
  }

  result.notCovered = ["css/layout", "hydration", "pixels"];
  if (list.some((f) => VISUAL.test(f))) {
    result.suggest = "Visual files changed: if the change is meant to look different, run `npm run agent -- shot <route>` once (Layer 2).";
  }
  result.summary = result.ok ? `ok: ${list.length} changed file(s) checked in ${Math.round((Date.now() - t0) / 1000)}s` : `${result.failures.length} problem(s): ${result.failures.slice(0, 3).join(" | ")}`;
  if (!result.ok) result.advice = "Fix the first failure, then re-run check. If the same failure repeats twice, stop and report it.";
  result.ms = Date.now() - t0;
  return result;
}
