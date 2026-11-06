// Output budget. Agents (Claude Code in particular) replace an oversized tool result with a
// truncation notice and lose everything, locators included, so every result is bounded well
// under 25k tokens: 20 KB of JSON (~5k tokens). Noise is shed first (logs, network, console),
// page text next, and the outline/refs an agent acts on last. Every cut is listed in
// `omitted` with how to get the rest. Same policy T3 Code converged on (MAX_SNAPSHOT_TEXT_BYTES).

export const MAX_BYTES = 20_000;
export const MAX_STRING = 1_500;
export const MAX_NAME = 200;

export const DEFAULT_SHED = [
  "logTail",
  "logs",
  "pages[].logTail",
  "network",
  "failedRequests",
  "pages[].failedRequests",
  "console",
  "pages[].console",
  "text",
  "pages[].text",
  "steps[].outline",
  "tests.failures",
  "lint.messages",
  "pages",
  "outline",
  "snapshot",
];

const KEEP_TAIL = new Set(["logTail", "logs", "console"]);

export function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

export function truncateString(s, max = MAX_STRING) {
  if (typeof s !== "string" || s.length <= max) return s;
  return `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

// Pre-pass: no single string or array may dominate the budget.
export function clampDeep(value, { maxString = MAX_STRING, maxArray = 300 } = {}, depth = 0, key = "") {
  if (typeof value === "string") return truncateString(value, maxString);
  if (Array.isArray(value)) {
    const tail = KEEP_TAIL.has(key);
    const kept = tail ? value.slice(-maxArray) : value.slice(0, maxArray);
    const arr = kept.map((v) => clampDeep(v, { maxString, maxArray }, depth + 1));
    if (value.length > maxArray) arr[tail ? "unshift" : "push"](`…[+${value.length - maxArray} more]`);
    return arr;
  }
  if (value && typeof value === "object") {
    if (depth > 12) return "[depth limit]";
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = clampDeep(v, { maxString, maxArray }, depth + 1, k);
    return out;
  }
  return value;
}

// Resolve "a.b", "pages[].outline" into [{ parent, key, label }].
function targets(root, pathExpr) {
  const parts = pathExpr.split(".");
  let level = [{ parent: null, key: null, value: root, label: "" }];
  for (const part of parts) {
    const each = part.endsWith("[]");
    const key = each ? part.slice(0, -2) : part;
    const next = [];
    for (const t of level) {
      const v = t.value;
      if (!v || typeof v !== "object" || !(key in v)) continue;
      const label = t.label ? `${t.label}.${key}` : key;
      if (each && Array.isArray(v[key])) {
        v[key].forEach((item, i) => next.push({ parent: v[key], key: i, value: item, label: `${label}[${i}]` }));
      } else if (!each) {
        next.push({ parent: v, key, value: v[key], label });
      }
    }
    level = next;
  }
  return level.filter((t) => t.parent !== null);
}

function shrink(t, omitted, hint, fieldName) {
  const v = t.parent[t.key];
  const rec = omitted.find((o) => o.field === t.label);
  if (Array.isArray(v)) {
    const total = rec ? rec.of : v.length;
    if (v.length <= 1) {
      delete t.parent[t.key];
      upsert(omitted, rec, { field: t.label, kept: 0, of: total, hint });
      return true;
    }
    const half = Math.floor(v.length / 2);
    t.parent[t.key] = KEEP_TAIL.has(fieldName) ? v.slice(v.length - half) : v.slice(0, half);
    upsert(omitted, rec, { field: t.label, kept: half, of: total, hint });
    return true;
  }
  if (typeof v === "string") {
    const total = rec ? rec.of : v.length;
    if (v.length < 200) {
      delete t.parent[t.key];
      upsert(omitted, rec, { field: t.label, kept: 0, of: total, unit: "chars", hint });
      return true;
    }
    const half = Math.floor(v.length / 2);
    t.parent[t.key] = `${v.slice(0, half)}…[cut]`;
    upsert(omitted, rec, { field: t.label, kept: half, of: total, unit: "chars", hint });
    return true;
  }
  if (v !== undefined) {
    delete t.parent[t.key];
    upsert(omitted, rec, { field: t.label, kept: 0, hint });
    return true;
  }
  return false;
}

function upsert(list, rec, next) {
  if (rec) Object.assign(rec, next);
  else list.push(next);
}

/**
 * Bound a result object to `maxBytes` of JSON.
 * @param {object} result
 * @param {{maxBytes?: number, shed?: string[], fullPath?: string}} opts
 */
export function bound(result, { maxBytes = MAX_BYTES, shed = DEFAULT_SHED, fullPath } = {}) {
  let out = clampDeep(result);
  const omitted = Array.isArray(out.omitted) ? [...out.omitted] : [];
  const hint = fullPath ? `full result: ${fullPath}` : "re-run the narrower command for more";
  const size = () => byteLength({ ...out, omitted });

  for (const expr of shed) {
    const fieldName = expr.split(".").pop().replace("[]", "");
    let guard = 0;
    while (size() > maxBytes && guard++ < 40) {
      const ts = targets(out, expr);
      if (!ts.length) break;
      // Shrink the largest instance first so one huge page doesn't starve the others.
      ts.sort((a, b) => byteLength(b.parent[b.key] ?? null) - byteLength(a.parent[a.key] ?? null));
      if (!shrink(ts[0], omitted, hint, fieldName)) break;
    }
    if (size() <= maxBytes) break;
  }

  if (size() > maxBytes) {
    // Last resort: keep only the verdict fields.
    const keep = {};
    for (const k of ["ok", "cmd", "error", "summary", "failures", "advice", "runDir", "full"]) {
      if (k in out) keep[k] = out[k];
    }
    if (Array.isArray(keep.failures)) keep.failures = keep.failures.slice(0, 10);
    omitted.push({ field: "*", kept: 0, hint });
    out = keep;
  }
  if (omitted.length) out.omitted = omitted;
  return out;
}
