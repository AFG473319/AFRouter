// Executes one harness job (render or flow) in happy-dom. Not a normal test file: the agent
// harness writes a job JSON, points AFR_HARNESS_JOB at it and reads AFR result JSON back.
// The vitest test always passes; the verdict is in the result file.
import fs from "node:fs";
import { test } from "vitest";
import { createElement, Component } from "react";
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { fetch as undiciFetch } from "undici";
import { harness } from "./state.js";
import { outline } from "../../../scripts/agent/lib/outline.mjs";
import { nameMatcher, describeTarget, checkApiExpectations } from "../../../scripts/agent/lib/flow.mjs";

const job = JSON.parse(fs.readFileSync(process.env.AFR_HARNESS_JOB, "utf8"));
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));

class Boundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error) {
    harness.pageErrors.push(`render error: ${String(error?.message || error).slice(0, 400)}`);
  }
  render() {
    return this.state.error ? createElement("div", { role: "alert" }, `Render error: ${this.state.error.message}`) : this.props.children;
  }
}

async function waitIdle(maxMs) {
  const end = Date.now() + maxMs;
  await sleep(30);
  while (Date.now() < end) {
    if (harness.inflight === 0 && Date.now() - harness.lastActivity > 350) return true;
    await sleep(60);
  }
  return false;
}

async function mount(target, route) {
  const url = new URL(route.path + (route.search || ""), job.baseUrl);
  harness.reset({ pathname: url.pathname, search: url.search, params: route.params || {} });
  try {
    window.happyDOM?.setURL?.(url.href);
  } catch {
    /* older happy-dom */
  }
  const mod = await import(target.file);
  const Comp = mod[target.exportName || "default"];
  if (typeof Comp !== "function") throw new Error(`${target.file} has no ${target.exportName || "default"} export component`);
  let element;
  if (Comp.constructor?.name === "AsyncFunction") {
    // Async server component: resolve it here, like Next would on the server.
    element = await Comp({ params: Promise.resolve(route.params || {}), searchParams: Promise.resolve(Object.fromEntries(new URLSearchParams(route.search || ""))) });
  } else {
    element = createElement(Comp, { ...(job.props || {}), params: Promise.resolve(route.params || {}) });
  }
  await act(async () => {
    render(createElement(Boundary, null, element));
  });
  return waitIdle(job.waitMs ?? 6000);
}

async function resolveTarget(t, timeout) {
  const opts = { timeout };
  const m = (v) => nameMatcher(v, t.exact);
  let els;
  if (t.role) els = await screen.findAllByRole(t.role, { name: t.name === undefined ? undefined : m(t.name) }, opts);
  else if (t.text !== undefined) els = await screen.findAllByText(m(t.text), {}, opts);
  else if (t.label !== undefined) els = await screen.findAllByLabelText(m(t.label), {}, opts);
  else if (t.placeholder !== undefined) els = await screen.findAllByPlaceholderText(m(t.placeholder), {}, opts);
  else if (t.testId !== undefined) els = await screen.findAllByTestId(t.testId, {}, opts);
  else if (t.css !== undefined) {
    els = await waitFor(() => {
      const found = [...document.querySelectorAll(t.css)];
      if (!found.length) throw new Error(`no element matches css "${t.css}"`);
      return found;
    }, opts);
  }
  const i = t.nth ?? 0;
  if (!els[i]) throw new Error(`only ${els.length} match(es) for ${describeTarget(t)}`);
  return { el: els[i], count: els.length };
}

function queryCount(t) {
  const m = (v) => nameMatcher(v, t.exact);
  if (t.role) return screen.queryAllByRole(t.role, { name: t.name === undefined ? undefined : m(t.name) }).length;
  if (t.text !== undefined) return screen.queryAllByText(m(t.text)).length;
  if (t.label !== undefined) return screen.queryAllByLabelText(m(t.label)).length;
  if (t.placeholder !== undefined) return screen.queryAllByPlaceholderText(m(t.placeholder)).length;
  if (t.testId !== undefined) return screen.queryAllByTestId(t.testId).length;
  return document.querySelectorAll(t.css).length;
}

const escapeType = (s) => s.replace(/[{[]/g, (c) => c + c);

async function runStep(step, user) {
  const timeout = step.timeout || 4000;
  const info = {};
  switch (step.action) {
    case "goto": {
      cleanup();
      const page = (job.pages || []).find((p) => p.route === step.value || p.resolved === step.value);
      if (!page) throw new Error(`no page file known for ${step.value}`);
      await mount({ file: page.abs }, { path: step.value, params: page.params });
      break;
    }
    case "click":
    case "dblclick":
    case "hover": {
      const { el, count } = await resolveTarget(step.target, timeout);
      if (count > 1 && step.target.nth === undefined) info.note = `${count} matches, used the first`;
      await user[step.action](el);
      break;
    }
    case "fill": {
      const { el } = await resolveTarget(step.target, timeout);
      await user.clear(el);
      if (step.value) await user.type(el, escapeType(step.value));
      break;
    }
    case "select": {
      const { el } = await resolveTarget(step.target, timeout);
      await user.selectOptions(el, step.value);
      break;
    }
    case "check":
    case "uncheck": {
      const { el } = await resolveTarget(step.target, timeout);
      const want = step.action === "check";
      const on = el.checked ?? el.getAttribute("aria-checked") === "true";
      if (on !== want) await user.click(el);
      break;
    }
    case "press":
      await user.keyboard(`{${step.value}}`);
      break;
    case "wait":
      if (step.ms !== undefined) await sleep(step.ms);
      else await resolveTarget(step.target, timeout);
      break;
    case "waitGone":
      await waitFor(() => {
        if (queryCount(step.target) > 0) throw new Error(`${describeTarget(step.target)} still present`);
      }, { timeout });
      break;
    case "expect": {
      const { count } = await resolveTarget(step.target, timeout);
      if (step.count !== undefined) {
        await waitFor(() => {
          const n = queryCount(step.target);
          if (n !== step.count) throw new Error(`expected ${step.count} × ${describeTarget(step.target)}, found ${n}`);
        }, { timeout });
      }
      info.count = count;
      break;
    }
    case "expectNo":
      await sleep(250);
      if (queryCount(step.target) > 0) throw new Error(`${describeTarget(step.target)} is present`);
      break;
    case "expectText":
      await screen.findAllByText(nameMatcher(step.value), {}, { timeout }).catch(async () => {
        // Text split across elements: fall back to the whole body text.
        await waitFor(() => {
          if (!document.body.textContent.toLowerCase().includes(step.value.toLowerCase())) throw new Error(`text "${step.value}" not found`);
        }, { timeout: 500 });
      });
      break;
    case "expectNoText":
      await sleep(250);
      if (document.body.textContent.toLowerCase().includes(step.value.toLowerCase())) throw new Error(`text "${step.value}" is present`);
      break;
    case "expectUrl": {
      const last = harness.navigations[harness.navigations.length - 1];
      const current = last ? last.href : harness.pathname;
      if (!String(current).startsWith(step.value)) throw new Error(`url is ${current}, expected ${step.value}`);
      break;
    }
    case "api": {
      const url = new URL(step.api.path, job.baseUrl);
      const headers = { cookie: job.cookie, origin: url.origin };
      if (/^\/(v1|api\/v1)/.test(url.pathname) && job.apiKey) headers.authorization = `Bearer ${job.apiKey}`;
      let body;
      if (step.api.body !== undefined) {
        body = typeof step.api.body === "string" ? step.api.body : JSON.stringify(step.api.body);
        headers["content-type"] = "application/json";
      }
      const res = await undiciFetch(url, { method: step.api.method, headers, body });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      const problems = checkApiExpectations(step, { status: res.status, json });
      info.status = res.status;
      if (problems.length) throw new Error(problems.join("; "));
      break;
    }
    case "snap":
    case "shot":
      info.outline = outline(document, { maxLines: job.maxLines || 150 }).lines;
      if (step.action === "shot") info.note = "dom engine: outline instead of pixels (use --engine browser for a screenshot)";
      break;
    default:
      throw new Error(`unsupported action ${step.action}`);
  }
  await waitIdle(2500);
  return info;
}

test("agent-harness job", async () => {
  const result = { ok: true, steps: [] };
  const t0 = Date.now();
  try {
    const idle = await mount(job.target, job.route);
    result.settled = idle;
    const user = userEvent.setup({ delay: null });
    for (const step of job.steps || []) {
      const s0 = Date.now();
      const rec = { i: step.i, action: step.action, target: describeTarget(step.target) || step.value || step.api?.path };
      try {
        Object.assign(rec, await runStep(step, user));
        rec.ok = true;
      } catch (e) {
        rec.ok = false;
        rec.error = String(e.message || e).split("\n")[0].slice(0, 400);
        if (!step.optional) {
          result.ok = false;
          result.failedStep = step.i;
        }
      }
      rec.ms = Date.now() - s0;
      result.steps.push(rec);
      if (!rec.ok && !step.optional) break;
    }
  } catch (e) {
    result.ok = false;
    result.error = String(e.message || e).split("\n")[0].slice(0, 600);
  }
  try {
    const o = outline(document, { maxLines: job.maxLines || 200 });
    result.outline = o.lines;
    if (o.truncated) result.outlineTruncated = true;
  } catch (e) {
    result.outlineError = e.message;
  }
  result.navigations = harness.navigations.slice(-10);
  result.requests = harness.network.length;
  if (harness.pending.size) result.pendingRequests = [...harness.pending].map((n) => `${n.method} ${n.url}`).slice(0, 10);
  result.failedRequests = harness.network.filter((n) => n.error || n.status >= 400).slice(-20);
  result.network = harness.network.slice(-30).map((n) => `${n.method} ${n.url} ${n.status ?? "ERR"} ${n.ms ?? "?"}ms`);
  result.console = harness.console.slice(-30);
  result.pageErrors = harness.pageErrors.slice(-20);
  if (result.pageErrors.length) result.ok = false;
  result.ms = Date.now() - t0;
  fs.writeFileSync(job.resultFile, JSON.stringify(result));
  cleanup();
});
