// HTTP against the isolated server. Dashboard/API calls carry the minted session cookie;
// /v1 calls carry the seeded API key. Bodies are summarised so one call stays small.
import fs from "node:fs";
import path from "node:path";
import { truncateString } from "./bound.mjs";

const KEEP_HEADERS = ["content-type", "location", "retry-after", "x-request-id", "cache-control"];
const SECRET_KEY = /(api[-_]?key|password|secret|token|authorization|cookie|refresh|access[-_]?token|private)/i;

export function isLlmPath(p) {
  return /^\/(v1|v1beta|api\/v1|api\/v1beta|codex|responses)(\/|$)/.test(p);
}

export function authHeaders(state, pathname, mode = "auto") {
  const h = {};
  const useKey = mode === "key" || (mode === "auto" && isLlmPath(pathname));
  const useSession = mode === "session" || (mode === "auto" && !isLlmPath(pathname));
  if (useKey && state.apiKey) h.authorization = `Bearer ${state.apiKey}`;
  if (useSession && state.token) h.cookie = `auth_token=${state.token}`;
  return h;
}

// Redact secrets and shrink big payloads so a list endpoint doesn't flood the context.
export function summarize(value, depth = 0) {
  if (typeof value === "string") return truncateString(value, 300);
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => summarize(v, depth + 1));
    if (value.length > 20) head.push(`…[+${value.length - 20} items]`);
    return head;
  }
  if (value && typeof value === "object") {
    if (depth > 5) return "{…}";
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && (typeof v === "string" && v.length > 0) ? "[redacted]" : summarize(v, depth + 1);
    }
    return out;
  }
  return value;
}

export async function request(state, method, pathname, { body, auth = "auto", headers = {}, timeoutMs = 120_000, origin } = {}) {
  const url = new URL(pathname, state.baseUrl);
  const init = {
    method: method.toUpperCase(),
    headers: { ...authHeaders(state, url.pathname, auth), ...headers },
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (origin) init.headers.origin = origin;
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    if (!Object.keys(init.headers).some((k) => k.toLowerCase() === "content-type")) init.headers["content-type"] = "application/json";
  }
  const t0 = Date.now();
  const res = await fetch(url, init);
  const text = await res.text();
  const ms = Date.now() - t0;
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  const keep = {};
  for (const h of KEEP_HEADERS) {
    const v = res.headers.get(h);
    if (v) keep[h] = v;
  }
  return { status: res.status, ms, headers: keep, json, text, bytes: Buffer.byteLength(text) };
}

export function parseBodyArg(v) {
  if (v === undefined || v === true) return undefined;
  const s = String(v);
  if (s.startsWith("@")) return fs.readFileSync(path.resolve(s.slice(1)), "utf8");
  return s;
}
