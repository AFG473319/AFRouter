// In-process hot-function benchmark: shells out to `vitest bench` in tests/
// (tinybench ships with vitest 4 — no new dependency) and folds the JSON
// output into this suite's metric format.
//
// What runs: tests/benchmarks/*.bench.js — translator request/response
// translation, RTK tool_result compression, model parsing. Sub-millisecond
// steady-state costs that a full request can't resolve (thousands of
// iterations instead of 30).
//
// Caveat (documented in benchmarks/README.md): benches import
// tests/translator/registerAll.js so translators are PRE-REGISTERED — this
// measures steady-state translation, not the one-time lazy module load.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, log, logOk, runToCompletion, tailText } from "./lib.mjs";

const TESTS_DIR = path.join(ROOT, "tests");
const VITEST_BIN = path.join(TESTS_DIR, "node_modules", "vitest", "vitest.mjs");
const TIMEOUT_MS = 10 * 60 * 1000;

// Metric-name segment: keep the words, spaces → dashes, drop punctuation
// (so "openai → claude (rich body)" → "openai-claude-rich-body",
//  "provider/model id" → "provider/model-id").
function metricSegment(s) {
  return String(s)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\w./-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// Preferred path: vitest's bench JSON is {files:[{filepath, groups:[{fullName,
// benchmarks:[…]}]}]} — parse it directly so metric keys keep their
// file/describe ancestry (unit.<file>.<describe>.<name>).
function extractFromFiles(parsed) {
  const out = [];
  if (!Array.isArray(parsed?.files)) return out;
  for (const file of parsed.files) {
    // filepath may be absolute (vitest resolves it) → keep just the basename.
    const base = String(file.filepath || "").split(/[\\/]/).pop() || "file";
    const fileSeg = metricSegment(base.replace(/\.bench\.(js|mjs|ts)$/i, "")) || "file";
    for (const group of file.groups || []) {
      const fullName = String(group.fullName || "");
      // fullName is "<filepath> > describe…" — drop the duplicated filepath part.
      const segs = (fullName.includes(" > ") ? fullName.split(" > ").slice(1) : fullName.split(" > "))
        .map(metricSegment)
        .filter(Boolean);
      for (const b of group.benchmarks || []) {
        out.push({
          key: ["unit", fileSeg, ...segs, metricSegment(b.name)].filter(Boolean).join("."),
          bench: b,
        });
      }
    }
  }
  return out;
}

// tinybench result → our uniform metric shape. Raw samples are NOT exported by
// vitest's JSON reporter (only aggregate stats), so samples stays empty and n
// is the iteration count; median/min/max/mean come from tinybench's own
// distribution over those iterations. p95 is left null — tinybench exports
// p75/p99/p995 and we won't relabel one as another.
function metricFromBench(b) {
  const m = {
    unit: "ms",
    n: Number.isFinite(b.sampleCount) ? b.sampleCount : (Array.isArray(b.samples) && b.samples.length) || 1,
    samples: [],
    min: b.min ?? b.mean,
    median: b.median ?? b.mean,
    mean: b.mean,
    p95: Number.isFinite(b.p95) ? b.p95 : null,
    max: b.max ?? b.mean,
  };
  if (Number.isFinite(b.hz)) m.opsPerSec = b.hz;
  if (Number.isFinite(b.rme)) m.rmePct = b.rme;
  return m;
}

// Fallback for an unexpected reporter shape: walk the whole tree and adopt any
// object that looks like a tinybench result (string `name` + `mean`/`hz`).
function collectBenches(node, names, out) {
  if (Array.isArray(node)) {
    for (const n of node) collectBenches(n, names, out);
    return;
  }
  if (!node || typeof node !== "object") return;

  const isResult =
    typeof node.name === "string" &&
    (typeof node.mean === "number" || typeof node.hz === "number");

  if (isResult) {
    const full = [...names, node.name].map(metricSegment).filter(Boolean).join(".");
    out.push({ key: `unit.${full}`, bench: node });
    return;
  }

  const next = typeof node.name === "string" && node.name && names.length < 4 ? [...names, node.name] : names;
  for (const [k, v] of Object.entries(node)) {
    if (v && typeof v === "object") collectBenches(v, next, out);
  }
}

export async function runUnit() {
  if (!fs.existsSync(VITEST_BIN)) {
    throw new Error("vitest not installed in tests/ — run `cd tests && npm install` first");
  }

  const outJson = path.join(os.tmpdir(), `afrouter-bench-unit-${Date.now()}.json`);
  log("running vitest bench (tests/benchmarks/*.bench.js) …");
  const { code, stdout, stderr } = await runToCompletion(
    process.execPath,
    [VITEST_BIN, "bench", "--run", "--outputJson", outJson],
    { cwd: TESTS_DIR, timeoutMs: TIMEOUT_MS }
  );

  if (code !== 0 || !fs.existsSync(outJson)) {
    throw new Error(
      `vitest bench failed (exit ${code})\n--- output tail ---\n${tailText(`${stdout}\n${stderr}`, 50)}`
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(outJson, "utf8"));
  } finally {
    try { fs.rmSync(outJson, { force: true }); } catch { /* best-effort */ }
  }

  const found = extractFromFiles(parsed);
  if (!found.length) collectBenches(parsed, [], found);
  if (!found.length) {
    throw new Error(`no benchmark results found in vitest JSON output — unexpected shape`);
  }

  const metrics = {};
  for (const { key, bench } of found) {
    metrics[key] = metricFromBench(bench);
  }
  logOk(`collected ${found.length} in-process benchmark(s)`);
  return metrics;
}
