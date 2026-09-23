// AFRouter benchmark dispatcher.
//
// Run:  npm run bench
//       npm run bench -- --only startup,request
//       npm run bench -- --compare            (vs benchmarks/baseline.json)
//
// Suites (run in this order — build first so startup/request measure a fresh
// production build):
//   build    wall-clock `npm run build` (same command CI times as BUILD_SECONDS)
//   startup  gateway boot: ready / first-route / warm-route (fresh process each run)
//   request  full-pipeline request latency against a local stub upstream
//   unit     in-process hot functions via `vitest bench` (translator, RTK, parse)
//
// Results: benchmarks/results/<stamp>-<label>.json (machine + git metadata,
// per-metric min/median/mean/p95/max + raw samples). Comparison is ADVISORY —
// nothing here fails a build; machine noise makes hard gates lie.

import path from "node:path";
import {
  ROOT, SUITES, compareResults, gitInfo, log, logErr, logOk, logWarn,
  parseArgs, printTable, printUsage, writeResults,
} from "./lib.mjs";
import { runBuild } from "./build.mjs";
import { runStartup } from "./startup.mjs";
import { runRequest } from "./request.mjs";
import { runUnit } from "./unit.mjs";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printUsage();
    return 0;
  }

  let only = SUITES;
  if (args.only) {
    only = args.only.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = only.filter((s) => !SUITES.includes(s));
    if (unknown.length || !only.length) {
      console.error(`❌ unknown suite(s): ${unknown.join(", ") || "(empty)"}`);
      printUsage();
      return 2;
    }
  }

  const label = args.label || gitInfo()?.sha || "run";
  const params = { runs: args.runs, iterations: args.iterations };
  const metrics = {};
  const errors = {};
  const suiteMs = {};

  const runners = {
    build: () => runBuild({ runs: args.runs ?? 1 }),
    startup: () => runStartup({ runs: args.runs ?? 3, keep: args.keep }),
    request: () => runRequest({ iterations: args.iterations ?? 30, keep: args.keep }),
    unit: () => runUnit(),
  };

  for (const suite of only) {
    console.log(`\n━━━ ${suite} ━━━`);
    const t0 = performance.now();
    try {
      Object.assign(metrics, await runners[suite]());
      suiteMs[suite] = Math.round(performance.now() - t0);
      logOk(`${suite} finished in ${(suiteMs[suite] / 1000).toFixed(1)}s`);
    } catch (err) {
      suiteMs[suite] = Math.round(performance.now() - t0);
      errors[suite] = String(err?.message || err);
      logErr(`${suite} FAILED: ${errors[suite]}`);
      // Suites after a failed build can't work (no production build) — stop early.
      if (suite === "build") {
        logWarn("stopping: remaining suites need the production build");
        break;
      }
    }
  }

  const failed = Object.keys(errors).length > 0;

  if (Object.keys(metrics).length) {
    printTable(metrics);
    const file = writeResults({ label, suites: only, params, metrics, errors, suiteMs });
    logOk(`results → ${path.relative(ROOT, file).replace(/\\/g, "/")}`);

    if (args.compare !== undefined) {
      const baseline = args.compare === null ? path.join(ROOT, "benchmarks", "baseline.json") : args.compare;
      compareResults(baseline, file);
    } else {
      log(`set a baseline: copy that file to benchmarks/baseline.json, then use --compare`);
    }
  } else {
    logErr("no metrics collected");
  }

  if (failed) logErr(`completed with suite failure(s): ${Object.keys(errors).join(", ")}`);
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    logErr(err?.stack || String(err));
    process.exit(1);
  }
);
