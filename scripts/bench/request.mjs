// Request-latency benchmark: real requests through the full production
// pipeline, with provider latency removed (Problem 1 of the design):
//
//   client → Next route → middleware/auth → chat.js (settings, combo, key)
//         → chatCore → translator → executor → [local stub ≈ 0ms]
//         → stream/non-stream translation → response
//
// Isolation (Problem 5): fresh temp DATA_DIR (never ~/.afrouter), an ephemeral
// port (never 20128), a bench-only "bench" openai-compatible node + connection
// seeded via the real APIs with a computed CLI token, and an API key created
// into the fixture. Everything is deleted afterwards unless --keep.
//
// Scenarios (the "overhead ladder" — each adds one more layer of our code):
//   request.healthMs        GET /api/health              HTTP+Next only
//   request.authStatusMs    GET /api/auth/status         + DB settings/session read
//   request.modelsMs        GET /v1/models (internal)    + rewrite/middleware + model assembly (DB-only)
//   request.chatNonStreamMs POST /v1/chat/completions    + full routing/translator/executor, JSON
//   request.chatStreamMs    POST /v1/chat/completions    + the same, SSE end-to-end
//
// Method: warm-up iterations are executed and DISCARDED (first hits pay lazy
// route/translator/DB warm-up), then `iterations` timed samples per scenario,
// round-robin so drift affects all scenarios equally.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { startStub } from "./stub.mjs";
import {
  freePort, killGateway, log, logOk, makeDataDir, resolveDistDir,
  spawnGateway, stats, tailFile, waitHealth, waitPortFree,
} from "./lib.mjs";

const BOOT_TIMEOUT_MS = 180000;
const REQ_TIMEOUT_MS = 30000;
const WARMUP = 3;

const CHAT_BODY = {
  model: "bench/stub-model",
  messages: [
    { role: "system", content: "AFRouter benchmark stub." },
    { role: "user", content: "ping" },
  ],
  max_tokens: 16,
  stream: false,
};

async function json(url, opts = {}) {
  const res = await fetch(url, { signal: AbortSignal.timeout(REQ_TIMEOUT_MS), ...opts });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* fall through to error */ }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${url} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  return body;
}

export async function runRequest({ iterations = 30, keep = false } = {}) {
  const distDir = resolveDistDir();

  const stub = await startStub();
  const fixture = makeDataDir();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "afrouter-bench-request-"));
  const logPath = path.join(logDir, "gateway.log");
  const port = await freePort();
  let child = null;
  let failed = false;

  try {
    /* boot isolated gateway */
    child = spawnGateway({ port, dataDir: fixture.dir, logPath, distDir });
    await waitHealth({ port, child, logPath, timeoutMs: BOOT_TIMEOUT_MS });
    const base = `http://127.0.0.1:${port}`;
    const admin = { "content-type": "application/json", "x-afr-cli-token": fixture.cliToken };

    /* seed the fixture: node → connection → api key (all through real APIs) */
    const { node } = await json(`${base}/api/provider-nodes`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        name: "bench-stub",
        prefix: "bench",
        apiType: "chat",
        baseUrl: stub.baseUrl,
        type: "openai-compatible",
      }),
    });
    await json(`${base}/api/providers`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({
        provider: node.id,
        apiKey: "bench-upstream-key",
        name: "bench-stub-1",
        priority: 1,
        testStatus: "unknown",
      }),
    });
    const keyResp = await json(`${base}/api/keys`, {
      method: "POST",
      headers: admin,
      body: JSON.stringify({ name: "bench" }),
    });
    const apiKey = keyResp.key;
    if (!apiKey) throw new Error(`key seeding failed: ${JSON.stringify(keyResp)}`);
    logOk(`fixture ready: node=${node.id} stub=${stub.baseUrl} port=${port}`);

    /* scenario definitions — each returns after the FULL response is consumed */
    const auth = { authorization: `Bearer ${apiKey}` };
    const scenarios = {
      health: () => json(`${base}/api/health`),
      authStatus: () => json(`${base}/api/auth/status`),
      models: () => json(`${base}/v1/models`, { headers: { ...auth, "x-afr-internal-models-fetch": "1" } }),
      chatNonStream: async () => {
        const body = await json(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify(CHAT_BODY),
        });
        if (!body?.choices?.[0]?.message?.content) {
          throw new Error(`chatNonStream: unexpected payload: ${JSON.stringify(body).slice(0, 500)}`);
        }
        return body;
      },
      chatStream: async () => {
        const res = await fetch(`${base}/v1/chat/completions`, {
          method: "POST",
          headers: { ...auth, "content-type": "application/json" },
          body: JSON.stringify({ ...CHAT_BODY, stream: true }),
          signal: AbortSignal.timeout(REQ_TIMEOUT_MS),
        });
        const text = await res.text();
        if (!res.ok || !text.includes("data:")) {
          throw new Error(`chatStream: HTTP ${res.status}: ${text.slice(0, 500)}`);
        }
        return text;
      },
    };

    /* warm-up (discarded) — validates every scenario works before timing */
    for (let i = 0; i < WARMUP; i++) {
      for (const [name, fn] of Object.entries(scenarios)) {
        try {
          await fn();
        } catch (err) {
          throw new Error(`warm-up "${name}" failed: ${err.message}\n--- gateway log ---\n${tailFile(logPath)}`);
        }
      }
    }
    logOk(`warm-up done (${WARMUP} rounds, stub served ${stub.hits.chat} chat calls)`);

    /* timed rounds */
    const samples = Object.fromEntries(Object.keys(scenarios).map((k) => [k, []]));
    for (let i = 0; i < iterations; i++) {
      for (const [name, fn] of Object.entries(scenarios)) {
        const t0 = performance.now();
        try {
          await fn();
        } catch (err) {
          throw new Error(`iteration ${i + 1} "${name}" failed: ${err.message}\n--- gateway log ---\n${tailFile(logPath)}`);
        }
        samples[name].push(performance.now() - t0);
      }
    }
    logOk(`collected ${iterations} samples × ${Object.keys(scenarios).length} scenarios`);

    return {
      "request.healthMs": stats(samples.health),
      "request.authStatusMs": stats(samples.authStatus),
      "request.modelsMs": stats(samples.models),
      "request.chatNonStreamMs": stats(samples.chatNonStream),
      "request.chatStreamMs": stats(samples.chatStream),
    };
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    await killGateway(child);
    await waitPortFree(port).catch(() => {});
    await stub.close();
    fixture.cleanup();
    if (keep || failed) {
      log(`logs kept at ${logDir}${failed ? " (failed run — see log tails above)" : ""}`);
    } else {
      try { fs.rmSync(logDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }
}
