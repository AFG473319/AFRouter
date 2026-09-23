// Build-time benchmark: wall-clock time of `npm run build`
// (= `next build --webpack` + postbuild standalone-asset copy), the same thing
// CI times as BUILD_SECONDS in .github/workflows/beta.yml — but locally, with
// repetitions and a recorded distribution.
//
// Builds into .next-bench/ (NEXT_DIST_DIR) so the repo's real `.next` — and any
// server serving from it — is never touched. Each run wipes that dir first:
// every measurement is a COLD build, like CI's fresh runner.

import fs from "node:fs";
import path from "node:path";
import {
  BENCH_DIST_DIR, ROOT, log, runToCompletion, stats,
  isPortListening, DEFAULT_PORT, tailText,
} from "./lib.mjs";

export async function runBuild({ runs = 1 } = {}) {
  if (await isPortListening(DEFAULT_PORT)) {
    log(`note: something is listening on ${DEFAULT_PORT} (a running instance) — harmless here,`);
    log(`bench builds into ${BENCH_DIST_DIR}/ and never touches the real .next`);
  }

  const samples = [];
  for (let i = 1; i <= runs; i++) {
    // Wipe the bench dist dir first: every run is a COLD build (empty webpack
    // cache), like CI's fresh runner — otherwise run 2+ would measure the cache.
    fs.rmSync(path.join(ROOT, BENCH_DIST_DIR), { recursive: true, force: true });
    log(`build ${i}/${runs} (cold): npm run build → ${BENCH_DIST_DIR} …`);
    const { code, stdout, stderr, durationMs } = await runToCompletion("npm", ["run", "build"], {
      cwd: ROOT,
      env: { NEXT_DIST_DIR: BENCH_DIST_DIR },
    });
    if (code !== 0) {
      throw new Error(`build failed (exit ${code})\n--- output tail ---\n${tailText(`${stdout}\n${stderr}`, 50)}`);
    }
    samples.push(durationMs);
    log(`build ${i}/${runs} done in ${(durationMs / 1000).toFixed(1)}s`);
  }

  return { "build.totalMs": stats(samples) };
}
