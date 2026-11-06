// happy-dom setup for the agent harness DOM lane.
// - fetch: relative URLs go to the live isolated server (AFR_HARNESS_BASE_URL) with the
//   harness session cookie, through Node's real fetch, and every call is logged.
// - console.error/warn and uncaught errors are captured for the result.
import { fetch as undiciFetch, Response } from "undici";
import { harness } from "./state.js";

const base = process.env.AFR_HARNESS_BASE_URL;
const cookie = process.env.AFR_HARNESS_COOKIE;

async function harnessFetch(input, init = {}) {
  const raw = typeof input === "string" ? input : input?.url || String(input);
  const url = new URL(raw, base || window.location.href);
  const local = !!base && url.origin === new URL(base).origin;
  const entry = { method: (init.method || "GET").toUpperCase(), url: local ? url.pathname + url.search : url.href };
  if (!local) {
    // Never let a render reach the internet (real providers, cloud sync, analytics).
    entry.status = 599;
    entry.error = base ? "blocked: external request" : "no harness server (run: npm run agent -- up)";
    harness.network.push(entry);
    return new Response(JSON.stringify({ error: entry.error }), { status: 599, headers: { "content-type": "application/json" } });
  }
  const headers = new Headers(init.headers || (typeof input === "object" ? input.headers : undefined));
  if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
  if (!headers.has("origin")) headers.set("origin", url.origin);
  const t0 = Date.now();
  harness.pending.add(entry);
  harness.inflight++;
  harness.lastActivity = Date.now();
  try {
    const res = await undiciFetch(url, { ...init, headers, redirect: "manual" });
    entry.status = res.status;
    return res;
  } catch (e) {
    entry.error = String(e.message || e).slice(0, 200);
    throw e;
  } finally {
    entry.ms = Date.now() - t0;
    harness.network.push(entry);
    harness.pending.delete(entry);
    harness.inflight--;
    harness.lastActivity = Date.now();
  }
}

globalThis.fetch = harnessFetch;
if (typeof window !== "undefined") window.fetch = harnessFetch;

for (const level of ["error", "warn"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    const text = args.map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "string" ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(" ");
    harness.console.push({ level, text: text.slice(0, 500) });
    if (process.env.AFR_HARNESS_VERBOSE) orig(...args);
  };
}

if (typeof window !== "undefined") {
  window.addEventListener("error", (e) => harness.pageErrors.push(String(e.error?.message || e.message).slice(0, 500)));
  window.addEventListener("unhandledrejection", (e) => harness.pageErrors.push(`unhandled rejection: ${String(e.reason?.message || e.reason).slice(0, 400)}`));
}

// Browser APIs happy-dom leaves out that dashboard code touches.
if (typeof window !== "undefined") {
  window.matchMedia ||= (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false });
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
  globalThis.IntersectionObserver ||= class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  if (!navigator.clipboard) Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => {}, readText: async () => "" }, configurable: true });
  globalThis.EventSource ||= class { constructor() { this.readyState = 2; } close() {} addEventListener() {} removeEventListener() {} };
}
