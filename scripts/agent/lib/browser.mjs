// Layer 2: a real headless browser, opt-in. playwright-core drives an installed Chromium-family
// browser (see browsers.mjs; nothing is downloaded). One browser, one page per command, closed
// at the end. Output mirrors T3 Code's preview snapshot: AI aria snapshot + console + network
// + page errors in one bounded object; pixels go to files and only their paths are returned.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { BASELINES_DIR, ensureDir } from "./paths.mjs";
import { pickBrowser, launchBrowser, clearCache, isPathSpec, chooseSpec } from "./browsers.mjs";
import { requireServer } from "./server.mjs";
import { nextErrors } from "./nextMcp.mjs";
import { parseFlow, describeTarget, checkApiExpectations } from "./flow.mjs";
import { which } from "./proc.mjs";
import { HarnessError } from "./out.mjs";
import { diffPng } from "./diff.mjs";

const MAX_ARIA_CHARS = 8000;
const REMINDER = "Layer 2 is for visual changes or explicit requests; prefer `check`/`render`/`flow` otherwise.";

async function withBrowser({ flag, config }, fn) {
  const excluded = [];
  const { spec } = chooseSpec({ flag, config });
  for (let attempt = 0; attempt < 3; attempt++) {
    const choice = await pickBrowser({ flag, config, exclude: excluded });
    let browser;
    try {
      browser = await launchBrowser(choice, { extraArgs: config?.browserArgs || [] });
    } catch (e) {
      // A cached/auto choice that stopped working (browser updated, removed): forget it, try the next.
      clearCache();
      excluded.push(choice.path);
      if (isPathSpec(spec) || attempt === 2) throw new HarnessError(`browser failed to launch: ${String(e.message).split("\n")[0]}`, { browser: choice.path });
      continue;
    }
    try {
      return await fn(browser, choice);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  throw new HarnessError("no browser could be launched");
}

async function newPage(browser, state, { width = 1280, height = 800, dark = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: dark ? "dark" : "light", baseURL: state.baseUrl, deviceScaleFactor: 1 });
  await context.addCookies([{ name: "auth_token", value: state.token, url: state.baseUrl }]);
  // Never let the page reach the internet (providers, analytics); the sandbox server only.
  const diag = { console: [], pageErrors: [], failedRequests: [], requests: 0, blockedExternal: 0 };
  await context.route((url) => !url.href.startsWith(state.baseUrl) && !url.href.startsWith("data:"), (route) => {
    diag.blockedExternal++;
    return route.abort();
  });
  const page = await context.newPage();
  page.on("console", (m) => {
    if (m.type() !== "error" && m.type() !== "warning") return;
    // The aborted external requests above surface as this generic line; it is not an app error.
    if (diag.blockedExternal && /^Failed to load resource: net::ERR_FAILED$/.test(m.text())) return;
    diag.console.push({ level: m.type(), text: m.text().slice(0, 500) });
  });
  page.on("pageerror", (e) => diag.pageErrors.push(String(e.message).slice(0, 500)));
  page.on("request", () => diag.requests++);
  page.on("requestfailed", (r) => {
    const failure = r.failure()?.errorText || "failed";
    if (!r.url().startsWith(state.baseUrl)) return; // blocked external requests are expected
    diag.failedRequests.push(`${r.method()} ${r.url().replace(state.baseUrl, "")} ${failure}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(state.baseUrl)) diag.failedRequests.push(`${r.request().method()} ${r.url().replace(state.baseUrl, "")} ${r.status()}`);
  });
  return { context, page, diag };
}

async function settle(page, ms = 8000) {
  await page.waitForLoadState("networkidle", { timeout: ms }).catch(() => {});
}

export async function ariaAi(page) {
  try {
    return await page.ariaSnapshot({ mode: "ai", timeout: 15_000 });
  } catch {
    return page.locator("body").ariaSnapshot({ timeout: 15_000 });
  }
}

function slug(s) {
  return String(s).replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root";
}

export async function shot({ route, runDir, flag, config = {}, full = false, width, height, dark = false, jpeg = false, baseline, updateBaseline = false }) {
  const state = await requireServer();
  const vp = { width: width || config.viewport?.width || 1280, height: height || config.viewport?.height || 800 };
  return withBrowser({ flag, config }, async (browser, choice) => {
    const { context, page, diag } = await newPage(browser, state, { ...vp, dark });
    const t0 = Date.now();
    const res = await page.goto(route, { waitUntil: "load", timeout: 240_000 });
    await settle(page);
    const loadMs = Date.now() - t0;
    const file = path.join(runDir, `${slug(route)}${dark ? "-dark" : ""}.${jpeg ? "jpg" : "png"}`);
    await page.screenshot({ path: file, fullPage: full, type: jpeg ? "jpeg" : "png", ...(jpeg ? { quality: 70 } : {}), scale: "css" });
    const aria = await ariaAi(page);
    const ariaFile = path.join(runDir, `${slug(route)}.aria.yml`);
    fs.writeFileSync(ariaFile, aria);
    const out = {
      ok: (res?.status() ?? 0) < 400 && diag.pageErrors.length === 0,
      route, url: page.url(), status: res?.status(), title: await page.title(), loadMs,
      browser: { id: choice.id, path: choice.path, version: choice.version, cached: !!choice.cached },
      viewport: vp,
      screenshot: file,
      aria: aria.length > MAX_ARIA_CHARS ? `${aria.slice(0, MAX_ARIA_CHARS)}\n…[cut, full: ${ariaFile}]` : aria,
      ariaFile,
      pageErrors: diag.pageErrors,
      console: diag.console.slice(-30),
      failedRequests: diag.failedRequests.slice(-20),
      requests: diag.requests,
      blockedExternal: diag.blockedExternal,
    };
    const nx = await nextErrors(state);
    if (nx.available && nx.errors.length) {
      out.nextErrors = nx.errors;
      out.ok = false;
    }
    if (baseline) {
      ensureDir(BASELINES_DIR);
      const base = path.join(BASELINES_DIR, `${slug(baseline)}${dark ? "-dark" : ""}-${vp.width}x${vp.height}${full ? "-full" : ""}.png`);
      if (jpeg) out.baseline = { skipped: "baselines need PNG (drop --jpeg)" };
      else if (!fs.existsSync(base) || updateBaseline) {
        fs.copyFileSync(file, base);
        out.baseline = { saved: base };
      } else {
        const d = diffPng(base, file, { out: path.join(runDir, `${slug(route)}.diff.png`) });
        out.baseline = { file: base, ...d };
        if (!d.ok) out.ok = false;
      }
    }
    out.note = REMINDER;
    await context.close();
    return out;
  });
}

function locate(page, t) {
  let loc;
  if (t.role) loc = page.getByRole(t.role, t.name === undefined ? {} : { name: t.name, exact: !!t.exact });
  else if (t.text !== undefined) loc = page.getByText(t.text, { exact: !!t.exact });
  else if (t.label !== undefined) loc = page.getByLabel(t.label, { exact: !!t.exact });
  else if (t.placeholder !== undefined) loc = page.getByPlaceholder(t.placeholder, { exact: !!t.exact });
  else if (t.testId !== undefined) loc = page.getByTestId(t.testId);
  else loc = page.locator(t.css);
  return t.nth !== undefined ? loc.nth(t.nth) : loc;
}

async function one(page, t, timeout) {
  const loc = locate(page, t);
  const target = t.nth !== undefined ? loc : loc.first();
  await target.waitFor({ state: "visible", timeout });
  const count = t.nth !== undefined ? 1 : await loc.count();
  return { loc: target, count };
}

class FrameRecorder {
  constructor(dir) {
    this.dir = ensureDir(path.join(dir, "frames"));
    this.n = 0;
    this.last = 0;
    this.max = 150;
    this.frames = [];
  }
  async start(context, page) {
    this.cdp = await context.newCDPSession(page);
    this.cdp.on("Page.screencastFrame", ({ data, sessionId }) => {
      this.cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      const now = Date.now();
      if (now - this.last < 250 || this.n >= this.max) return;
      this.last = now;
      this.write(Buffer.from(data, "base64"), "screencast");
    });
    await this.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 1024, maxHeight: 768, everyNthFrame: 1 });
  }
  write(buf, label) {
    if (this.n >= this.max) return null;
    const file = path.join(this.dir, `${String(++this.n).padStart(4, "0")}.jpg`);
    fs.writeFileSync(file, buf);
    this.frames.push({ file, label });
    return file;
  }
  async stop() {
    await this.cdp?.send("Page.stopScreencast").catch(() => {});
  }
}

async function contactSheet(browser, frames, outFile) {
  if (!frames.length) return null;
  const stepFrames = frames.filter((f) => f.label !== "screencast");
  const pool = stepFrames.length >= 4 ? stepFrames : frames;
  const max = 16;
  const pick = pool.length <= max ? pool : Array.from({ length: max }, (_, i) => pool[Math.round((i * (pool.length - 1)) / (max - 1))]);
  const cells = pick.map((f) => `<figure><img src="data:image/jpeg;base64,${fs.readFileSync(f.file).toString("base64")}"><figcaption>${path.basename(f.file)} ${String(f.label).replace(/[<>&]/g, "")}</figcaption></figure>`).join("");
  const page = await browser.newPage({ viewport: { width: 1600, height: 200 } });
  await page.setContent(`<html><body style="margin:0;background:#111;font:12px sans-serif;color:#ddd"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;padding:6px">${cells}</div><style>figure{margin:0}img{width:100%;display:block;border:1px solid #333}figcaption{padding:2px 0}</style></body></html>`);
  await page.screenshot({ path: outFile, fullPage: true, type: "jpeg", quality: 70 });
  await page.close();
  return outFile;
}

function encodeWebm(framesDir, out) {
  const ffmpeg = which("ffmpeg");
  if (!ffmpeg) return { skipped: "ffmpeg not on PATH; frames + contact sheet were written instead" };
  const r = spawnSync(ffmpeg, ["-y", "-loglevel", "error", "-framerate", "4", "-i", path.join(framesDir, "%04d.jpg"), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-pix_fmt", "yuv420p", out], { encoding: "utf8", timeout: 180_000, windowsHide: true });
  return r.status === 0 ? { file: out } : { error: (r.stderr || "ffmpeg failed").slice(0, 300) };
}

export async function runBrowserFlow({ file, runDir, flag, config = {}, frames = false, webm = false, width, height }) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new HarnessError(`flow file not found: ${file}`);
  let flow;
  try {
    flow = parseFlow(fs.readFileSync(abs, "utf8"));
  } catch (e) {
    throw new HarnessError(`invalid flow: ${e.message}`);
  }
  const state = await requireServer();
  const vp = { width: width || flow.viewport?.width || config.viewport?.width || 1280, height: height || flow.viewport?.height || config.viewport?.height || 800 };
  return withBrowser({ flag, config }, async (browser, choice) => {
    const { context, page, diag } = await newPage(browser, state, vp);
    const rec = frames || webm ? new FrameRecorder(runDir) : null;
    if (rec) await rec.start(context, page);
    const result = { ok: true, name: flow.name, route: flow.route, browser: { id: choice.id, version: choice.version }, viewport: vp, steps: [] };
    const t0 = Date.now();
    try {
      await page.goto(flow.route, { waitUntil: "load", timeout: 240_000 });
      await settle(page);
      for (const step of flow.steps) {
        const s0 = Date.now();
        const r = { i: step.i, action: step.action, target: describeTarget(step.target) || step.value || step.api?.path };
        const timeout = step.timeout || 5000;
        try {
          switch (step.action) {
            case "goto":
              await page.goto(step.value, { waitUntil: "load", timeout: 240_000 });
              await settle(page);
              break;
            case "click":
            case "dblclick":
            case "hover": {
              const { loc, count } = await one(page, step.target, timeout);
              if (count > 1) r.note = `${count} matches, used the first`;
              await loc[step.action]({ timeout });
              break;
            }
            case "fill":
              await (await one(page, step.target, timeout)).loc.fill(step.value, { timeout });
              break;
            case "select":
              await (await one(page, step.target, timeout)).loc.selectOption(step.value, { timeout });
              break;
            case "check":
            case "uncheck":
              await (await one(page, step.target, timeout)).loc[step.action]({ timeout });
              break;
            case "press":
              await page.keyboard.press(step.value);
              break;
            case "wait":
              if (step.ms !== undefined) await page.waitForTimeout(step.ms);
              else await one(page, step.target, timeout);
              break;
            case "waitGone":
              await locate(page, step.target).first().waitFor({ state: "hidden", timeout });
              break;
            case "expect": {
              const { count } = await one(page, step.target, timeout);
              r.count = count;
              if (step.count !== undefined && count !== step.count) throw new Error(`expected ${step.count} × ${describeTarget(step.target)}, found ${count}`);
              break;
            }
            case "expectNo":
              await page.waitForTimeout(250);
              if (await locate(page, step.target).count()) throw new Error(`${describeTarget(step.target)} is present`);
              break;
            case "expectText":
              await page.getByText(step.value).first().waitFor({ state: "visible", timeout });
              break;
            case "expectNoText":
              await page.waitForTimeout(250);
              if (await page.getByText(step.value).count()) throw new Error(`text "${step.value}" is present`);
              break;
            case "expectUrl": {
              const p = new URL(page.url()).pathname;
              if (!p.startsWith(step.value)) throw new Error(`url is ${p}, expected ${step.value}`);
              break;
            }
            case "api": {
              const res = await page.request.fetch(new URL(step.api.path, state.baseUrl).href, {
                method: step.api.method,
                data: step.api.body,
                headers: /^\/(v1|api\/v1)/.test(step.api.path) ? { authorization: `Bearer ${state.apiKey}` } : {},
              });
              let json;
              try {
                json = await res.json();
              } catch {
                /* not json */
              }
              r.status = res.status();
              const problems = checkApiExpectations(step, { status: res.status(), json });
              if (problems.length) throw new Error(problems.join("; "));
              break;
            }
            case "snap":
              r.aria = (await ariaAi(page)).slice(0, 4000);
              break;
            case "shot": {
              const f = path.join(runDir, `step-${step.i}${step.value ? `-${slug(step.value)}` : ""}.png`);
              await page.screenshot({ path: f, scale: "css" });
              r.screenshot = f;
              break;
            }
            default:
              throw new Error(`unsupported action ${step.action}`);
          }
          await settle(page, 2500);
          r.ok = true;
        } catch (e) {
          r.ok = false;
          r.error = String(e.message || e).split("\n")[0].slice(0, 400);
          if (!step.optional) {
            result.ok = false;
            result.failedStep = step.i;
          }
        }
        if (rec) r.frame = rec.write(await page.screenshot({ type: "jpeg", quality: 60, scale: "css" }), `step ${step.i} ${step.action}`);
        r.ms = Date.now() - s0;
        result.steps.push(r);
        if (!r.ok && !step.optional) break;
      }
    } finally {
      if (rec) await rec.stop();
    }
    if (!result.ok) {
      const aria = await ariaAi(page).catch(() => "");
      result.ariaAtFailure = aria.slice(0, 6000);
      result.advice = "Fix the failing step (see steps[].error and ariaAtFailure). If the same step fails twice, stop and report.";
    }
    result.pageErrors = diag.pageErrors;
    result.console = diag.console.slice(-30);
    result.failedRequests = diag.failedRequests.slice(-20);
    if (diag.pageErrors.length) result.ok = false;
    if (rec) {
      result.frames = { dir: rec.dir, count: rec.n };
      result.contactSheet = await contactSheet(browser, rec.frames, path.join(runDir, "contact-sheet.jpg"));
      if (webm) result.video = encodeWebm(rec.dir, path.join(runDir, "flow.webm"));
    }
    result.ms = Date.now() - t0;
    result.note = REMINDER;
    await context.close();
    return result;
  });
}
