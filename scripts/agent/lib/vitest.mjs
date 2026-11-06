// Vitest in tests/ (an independent package), 2 workers, JSON reporter, judged against
// tests/__baseline__/known-fails.txt so the ~26 pre-existing failures never read as regressions.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT } from "./paths.mjs";
import { HarnessError } from "./out.mjs";
import { relatedTests } from "./related.mjs";

const TESTS_DIR = path.join(REPO_ROOT, "tests");
const VITEST = path.join(TESTS_DIR, "node_modules", "vitest", "vitest.mjs");
// Same exclusions as .github/workflows/test.yml: live-provider and out-of-repo suites.
export const ALWAYS_EXCLUDE = ["**/translator/real/**", "**/embeddings.cloud.test.js", "**/xai-oauth-service.test.js", "**/mimo-free.live.test.js", "**/harness/**/*.dom.test.js"];

export function loadKnownFails() {
  try {
    return new Set(fs.readFileSync(path.join(TESTS_DIR, "__baseline__", "known-fails.txt"), "utf8").split("\n").map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function summarizeResults(json, known = loadKnownFails()) {
  const failures = [];
  for (const file of json.testResults || []) {
    const m = String(file.name).replace(/\\/g, "/").match(/tests\/.*$/);
    const rel = m ? m[0] : String(file.name);
    const failed = (file.assertionResults || []).filter((a) => a.status === "failed");
    for (const a of failed) {
      const id = `${rel} :: ${a.fullName}`;
      failures.push({ id, known: known.has(id), message: String((a.failureMessages || [])[0] || "").split("\n")[0].slice(0, 300) });
    }
    if (!failed.length && file.status === "failed") {
      // Collection error (import failure, syntax error): no assertions ran.
      failures.push({ id: `${rel} :: (file failed to load)`, known: false, message: String(file.message || "").split("\n")[0].slice(0, 300) });
    }
  }
  const regressions = failures.filter((f) => !f.known);
  return {
    passed: json.numPassedTests ?? 0,
    failed: json.numFailedTests ?? failures.length,
    total: json.numTotalTests ?? 0,
    files: (json.testResults || []).length,
    knownFailures: failures.length - regressions.length,
    regressions: regressions.length,
    failures: [...regressions, ...failures.filter((f) => f.known).map((f) => ({ id: f.id, known: true }))],
  };
}

function run(args, { cwd, timeoutMs, inherit = false }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [VITEST, ...args], { cwd, env: { ...process.env, CI: process.env.CI || "1", FORCE_COLOR: "0", NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || path.join(REPO_ROOT, ".agent", "compile-cache") }, stdio: inherit ? "inherit" : "pipe", windowsHide: true });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

/**
 * @param {{files?: string[], related?: string[], testName?: string, watch?: boolean, dom?: boolean, runDir: string, timeoutMs?: number}} o
 */
export async function runVitest({ files = [], related = [], testName, watch = false, dom = false, runDir, timeoutMs = 600_000, maxFiles = 30 }) {
  if (!fs.existsSync(VITEST)) throw new HarnessError("tests/node_modules missing", { fix: "npm install && cd tests && npm install" });
  let relatedInfo;
  if (related.length) {
    // Resolve related tests with our static import graph (fast), then run them directly.
    const r = relatedTests(related);
    const pick = dom ? r.dom : r.tests;
    relatedInfo = { found: pick.length, ran: Math.min(pick.length, maxFiles) };
    if (!pick.length) return { ok: true, dom, files: 0, note: "no tests import the changed files", related: relatedInfo };
    files = pick.slice(0, maxFiles);
    related = [];
  }
  const config = dom ? ["--config", "harness/vitest.dom.config.js"] : [];
  const abs = (f) => path.resolve(REPO_ROOT, f);
  if (watch) {
    await run([...config, ...(related.length ? ["related", ...related.map(abs)] : files.map(abs)), "--maxWorkers=2", ...(testName ? ["-t", testName] : [])], { cwd: TESTS_DIR, inherit: true });
    return { ok: true, watch: true };
  }
  const outFile = path.join(runDir, dom ? "vitest-dom.json" : "vitest.json");
  const args = [
    ...(related.length ? ["related", ...related.map(abs), "--run"] : ["run", ...files.map(abs)]),
    ...config,
    "--reporter=json", `--outputFile=${outFile}`, "--maxWorkers=2", "--passWithNoTests",
    ...(dom ? [] : ALWAYS_EXCLUDE.flatMap((e) => ["--exclude", e])),
    ...(testName ? ["-t", testName] : []),
  ];
  const t0 = Date.now();
  const { code, out } = await run(args, { cwd: TESTS_DIR, timeoutMs });
  fs.writeFileSync(path.join(runDir, dom ? "vitest-dom.log" : "vitest.log"), out);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(outFile, "utf8"));
  } catch {
    const tail = out.split(/\r?\n/).filter((l) => l.trim()).slice(-20).map((l) => l.slice(0, 300));
    return { ok: false, dom, error: `vitest produced no JSON (exit ${code})`, logTail: tail, ms: Date.now() - t0 };
  }
  const summary = summarizeResults(json);
  return { ok: summary.regressions === 0, dom, ...(relatedInfo ? { related: relatedInfo, testFiles: files } : {}), ms: Date.now() - t0, ...summary, ...(summary.files === 0 ? { note: related.length ? "no tests import the changed files" : "no test files matched" } : {}), log: path.join(runDir, dom ? "vitest-dom.log" : "vitest.log") };
}
