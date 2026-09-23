// Startup-time benchmark. Three definitions are recorded per run (they can
// differ by seconds, so we refuse to pick just one):
//
//   startup.readyMs      spawn → /api/health returns {"ok":true}
//                        (the readiness definition the CI smoke test polls)
//   startup.firstRouteMs spawn → first GET /api/auth/status 200
//                        (a DB-touching route: includes the LAZY adapter init
//                        + schema migration that health does not trigger)
//   startup.warmRouteMs  median latency of 5 further /api/auth/status calls
//                        (steady-state once the DB is warm)
//
// Method: one fresh process per run against a single pre-primed fixture
// DATA_DIR. A discarded prime run creates/migrates the DB first, so measured
// runs carry only per-boot work (PRAGMA quick_check + version check), never
// one-time legacy imports — matching what repeated restarts cost a user.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  killGateway, log, logOk, makeDataDir, median, resolveDistDir,
  spawnGateway, stats, waitHealth, waitPortFree, freePort, sleep, tailFile,
} from "./lib.mjs";

const HEALTHY_TIMEOUT_MS = 180000;
const WARM_CALLS = 5;

async function timedFetch(url, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { signal: AbortSignal.timeout(30000), ...opts });
  await res.text(); // measure the full response, headers alone lie
  return { ms: performance.now() - t0, status: res.status };
}

async function bootOnce({ port, dataDir, logPath, label, distDir }) {
  const child = spawnGateway({ port, dataDir, logPath, distDir });
  try {
    const t0 = performance.now();
    await waitHealth({ port, child, logPath, timeoutMs: HEALTHY_TIMEOUT_MS });
    const readyMs = performance.now() - t0;

    const first = await timedFetch(`http://127.0.0.1:${port}/api/auth/status`);
    if (first.status !== 200) {
      throw new Error(`${label}: first /api/auth/status → HTTP ${first.status}\n--- gateway log ---\n${tailFile(logPath)}`);
    }
    const firstRouteMs = performance.now() - t0;

    const warm = [];
    for (let i = 0; i < WARM_CALLS; i++) {
      const w = await timedFetch(`http://127.0.0.1:${port}/api/auth/status`);
      if (w.status !== 200) throw new Error(`${label}: warm /api/auth/status → HTTP ${w.status}`);
      warm.push(w.ms);
    }
    return { readyMs, firstRouteMs, warmRouteMs: median(warm) };
  } finally {
    await killGateway(child);
    await waitPortFree(port);
  }
}

export async function runStartup({ runs = 3, keep = false } = {}) {
  const distDir = resolveDistDir();

  const fixture = makeDataDir();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "afrouter-bench-startup-"));
  const port = await freePort();
  let failed = false;

  try {
    // Prime run (discarded): creates + migrates the fixture DB so every
    // measured run starts from a warm, already-migrated database.
    log("priming fixture DB (discarded run) …");
    await bootOnce({ port, dataDir: fixture.dir, logPath: path.join(logDir, "prime.log"), label: "prime", distDir });
    logOk("prime run complete");

    const ready = [];
    const firstRoute = [];
    const warmRoute = [];
    for (let i = 1; i <= runs; i++) {
      const r = await bootOnce({
        port,
        dataDir: fixture.dir,
        logPath: path.join(logDir, `run-${i}.log`),
        label: `run ${i}`,
        distDir,
      });
      ready.push(r.readyMs);
      firstRoute.push(r.firstRouteMs);
      warmRoute.push(r.warmRouteMs);
      log(`run ${i}/${runs}: ready ${r.readyMs.toFixed(0)}ms · first-route ${r.firstRouteMs.toFixed(0)}ms · warm ${r.warmRouteMs.toFixed(1)}ms`);
      await sleep(100); // settle between runs
    }

    return {
      "startup.readyMs": stats(ready),
      "startup.firstRouteMs": stats(firstRoute),
      "startup.warmRouteMs": stats(warmRoute),
    };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    fixture.cleanup();
    if (keep || failed) {
      log(`logs kept at ${logDir}${failed ? " (failed run — see log tails above)" : ""}`);
    } else {
      try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
