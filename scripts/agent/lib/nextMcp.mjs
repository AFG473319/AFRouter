// Next 16's built-in dev MCP endpoint (/_next/mcp). Plain JSON-RPC over HTTP POST; the
// response may be SSE-framed ("event: message\ndata: {...}"). Dev server only.
import { truncateString } from "./bound.mjs";

export async function callNextMcp(baseUrl, tool, args = {}, timeoutMs = 30_000) {
  const res = await fetch(`${baseUrl}/_next/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`/_next/mcp HTTP ${res.status}`);
  const text = await res.text();
  const payload = parseRpc(text);
  if (payload?.error) throw new Error(payload.error.message || "rpc error");
  const content = payload?.result?.content || [];
  const joined = content.map((c) => c.text || "").join("\n");
  try {
    return JSON.parse(joined);
  } catch {
    return joined;
  }
}

export function parseRpc(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
  for (let i = dataLines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(dataLines[i]);
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Reduce get_errors output to a short list. Shape varies across Next versions, so be lenient.
export function summarizeNextErrors(value) {
  if (!value) return [];
  if (typeof value === "string") {
    if (/no errors/i.test(value)) return [];
    return [truncateString(value, 1500)];
  }
  const out = [];
  const visit = (v, depth) => {
    if (depth > 6 || out.length >= 20) return;
    if (Array.isArray(v)) return v.forEach((x) => visit(x, depth + 1));
    if (v && typeof v === "object") {
      if (typeof v.message === "string") {
        out.push(truncateString([v.type || v.name, v.message, v.source || v.file].filter(Boolean).join(": "), 800));
        return;
      }
      for (const x of Object.values(v)) visit(x, depth + 1);
    }
  };
  visit(value, 0);
  return out;
}

export async function nextErrors(state) {
  if (state.mode === "prod") return { available: false, reason: "prod mode has no /_next/mcp" };
  try {
    const raw = await callNextMcp(state.baseUrl, "get_errors");
    return { available: true, errors: summarizeNextErrors(raw) };
  } catch (e) {
    return { available: false, reason: e.message };
  }
}
