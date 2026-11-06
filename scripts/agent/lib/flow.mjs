// Flow scripts: a small JSON step language shared by the happy-dom engine (default, no
// browser) and the browser engine (Layer 2). Pure functions only, so it is unit-testable.
//
// { "name": "create key", "route": "/dashboard/endpoint", "steps": [
//     { "click": "role=button[name=Create Key]" },
//     { "fill": "label=Key Name", "value": "ci" },
//     { "press": "Enter" },
//     { "expectText": "ci" },
//     { "api": { "path": "/api/keys", "status": 200, "json": { "keys.length": 1 } } },
//     { "snap": true } ] }
//
// Targets: "role=button[name=Save]", "text=Save", "label=Name", "placeholder=Search",
// "testid=save", "css=.btn", or a bare string (= text). Object form: { role, name, exact,
// text, label, placeholder, testId, css, nth }. Names match case-insensitively as a
// substring unless exact: true.

export const ACTIONS = {
  goto: { value: "route" },
  click: { target: true },
  dblclick: { target: true },
  hover: { target: true },
  fill: { target: true, needs: "value" },
  select: { target: true, needs: "value" },
  check: { target: true },
  uncheck: { target: true },
  press: { value: "key" },
  wait: { value: "msOrTarget" },
  waitGone: { target: true },
  expect: { target: true },
  expectNo: { target: true },
  expectText: { value: "text" },
  expectNoText: { value: "text" },
  expectUrl: { value: "route" },
  api: { value: "api" },
  snap: { value: "any" },
  shot: { value: "any" },
};

const TARGET_KINDS = ["role", "text", "label", "placeholder", "testid", "css"];

export function parseTarget(input) {
  if (input === undefined || input === null || input === "") throw new Error("missing target");
  if (typeof input === "object") {
    const t = { ...input };
    if (t.testid && !t.testId) t.testId = t.testid;
    delete t.testid;
    const kinds = ["role", "text", "label", "placeholder", "testId", "css"].filter((k) => t[k] !== undefined);
    if (kinds.length !== 1) throw new Error(`target needs exactly one of role/text/label/placeholder/testId/css, got ${kinds.join(",") || "none"}`);
    if (t.nth !== undefined && !(Number.isInteger(t.nth) && t.nth >= 0)) throw new Error("nth must be a non-negative integer");
    return t;
  }
  const s = String(input).trim();
  const m = s.match(/^([a-z]+)=(.*)$/i);
  if (!m || !TARGET_KINDS.includes(m[1].toLowerCase())) return { text: s };
  const kind = m[1].toLowerCase();
  const rest = m[2].trim();
  if (kind === "role") {
    const r = rest.match(/^([a-z]+)\s*(?:\[(.*)\])?$/i);
    if (!r) throw new Error(`bad role target "${s}"`);
    const t = { role: r[1].toLowerCase() };
    if (r[2]) {
      for (const part of r[2].split(/\]\s*\[/)) {
        const kv = part.match(/^\s*([a-z]+)\s*=\s*"?(.*?)"?\s*$/i);
        if (!kv) throw new Error(`bad role attribute "${part}" in "${s}"`);
        const key = kv[1].toLowerCase();
        if (key === "name") t.name = kv[2];
        else if (key === "exact") t.exact = kv[2] !== "false";
        else if (key === "nth") t.nth = Number(kv[2]);
        else throw new Error(`unknown role attribute "${key}" in "${s}"`);
      }
    }
    return t;
  }
  if (kind === "testid") return { testId: rest };
  return { [kind]: rest };
}

export function describeTarget(t) {
  if (!t) return "";
  const nth = t.nth !== undefined ? ` #${t.nth}` : "";
  if (t.role) return `${t.role}${t.name ? ` "${t.name}"` : ""}${nth}`;
  const [k] = ["text", "label", "placeholder", "testId", "css"].filter((x) => t[x] !== undefined);
  return `${k}="${t[k]}"${nth}`;
}

export function parseStep(raw, i) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`step ${i + 1}: must be an object`);
  const keys = Object.keys(raw).filter((k) => ACTIONS[k]);
  if (keys.length !== 1) {
    throw new Error(`step ${i + 1}: needs exactly one action (${Object.keys(ACTIONS).join(", ")}); got ${Object.keys(raw).join(", ") || "nothing"}`);
  }
  const action = keys[0];
  const spec = ACTIONS[action];
  const v = raw[action];
  const step = { i: i + 1, action };
  if (raw.timeout !== undefined) step.timeout = Number(raw.timeout);
  if (raw.optional) step.optional = true;
  try {
    if (spec.target) step.target = parseTarget(v);
    if (spec.needs) {
      if (raw[spec.needs] === undefined) throw new Error(`"${action}" needs "${spec.needs}"`);
      step.value = String(raw[spec.needs]);
    }
    if (action === "expect" && raw.count !== undefined) step.count = Number(raw.count);
    if (spec.value === "route") {
      if (typeof v !== "string" || !v.startsWith("/")) throw new Error(`"${action}" needs a route starting with /`);
      step.value = v;
    } else if (spec.value === "key" || spec.value === "text") {
      if (typeof v !== "string" || !v) throw new Error(`"${action}" needs a string`);
      step.value = v;
    } else if (spec.value === "msOrTarget") {
      if (typeof v === "number") step.ms = v;
      else step.target = parseTarget(v);
    } else if (spec.value === "api") {
      if (!v || typeof v !== "object" || typeof v.path !== "string") throw new Error(`"api" needs { path, method?, body?, status?, json? }`);
      step.api = { method: (v.method || "GET").toUpperCase(), path: v.path, body: v.body, status: v.status, json: v.json };
    } else if (spec.value === "any") {
      step.value = v === true ? undefined : v;
    }
  } catch (e) {
    throw new Error(`step ${i + 1} (${action}): ${e.message}`);
  }
  return step;
}

export function parseFlow(input) {
  const flow = typeof input === "string" ? JSON.parse(input) : input;
  if (!flow || typeof flow !== "object") throw new Error("flow must be a JSON object");
  if (!Array.isArray(flow.steps) || !flow.steps.length) throw new Error("flow needs a non-empty steps array");
  if (flow.route !== undefined && (typeof flow.route !== "string" || !flow.route.startsWith("/"))) throw new Error("flow.route must start with /");
  const steps = flow.steps.map((s, i) => parseStep(s, i));
  return {
    name: flow.name || "flow",
    route: flow.route || "/dashboard",
    viewport: flow.viewport,
    steps,
  };
}

// Dotted-path lookup for api assertions: "keys.0.name", "keys.length".
export function getPath(obj, p) {
  return String(p).split(".").reduce((acc, k) => (acc === undefined || acc === null ? undefined : acc[k]), obj);
}

export function checkApiExpectations(step, res) {
  const problems = [];
  const want = step.api;
  if (want.status !== undefined && res.status !== want.status) problems.push(`status ${res.status} != ${want.status}`);
  else if (want.status === undefined && res.status >= 400) problems.push(`status ${res.status}`);
  for (const [p, expected] of Object.entries(want.json || {})) {
    const actual = getPath(res.json, p);
    const ok = typeof expected === "object" && expected !== null
      ? (expected.gte !== undefined ? actual >= expected.gte : true) && (expected.lte !== undefined ? actual <= expected.lte : true) && (expected.contains !== undefined ? String(actual).includes(expected.contains) : true) && (expected.exists !== undefined ? (actual !== undefined) === expected.exists : true)
      : actual === expected;
    if (!ok) problems.push(`${p}: got ${JSON.stringify(actual)?.slice(0, 80)}, want ${JSON.stringify(expected)}`);
  }
  return problems;
}

// Name matcher used by both engines: substring, case-insensitive, unless exact.
export function nameMatcher(name, exact) {
  if (name === undefined) return undefined;
  if (exact) return name;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(esc, "i");
}
