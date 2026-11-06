// Browserless page check: GET the route from the isolated server and turn the server HTML
// into a role/text outline. No scripts run, so this is the SSR view: client-side data
// loaded in effects is not there yet (use `render`/`flow` for that, `shot` for pixels).
import fs from "node:fs";
import path from "node:path";
import { Window } from "happy-dom";
import { request } from "./http.mjs";
import { outline, nextErrorMarkers } from "./outline.mjs";

export function parseHtml(html, url = "http://127.0.0.1/") {
  const window = new Window({
    url,
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      navigator: { userAgent: "afrouter-agent-harness" },
    },
  });
  const doc = new window.DOMParser().parseFromString(html, "text/html");
  return { window, doc };
}

export function outlineHtml(html, opts = {}) {
  const { window, doc } = parseHtml(html, opts.url);
  try {
    const title = doc.querySelector("title")?.textContent?.trim() || "";
    const lang = doc.documentElement?.getAttribute("lang") || undefined;
    const res = outline(doc, opts);
    return { title, lang, ...res };
  } finally {
    window.happyDOM?.close?.();
  }
}

export async function checkPage(state, route, { runDir, maxLines = 250, timeoutMs = 240_000 } = {}) {
  const t0 = Date.now();
  let res;
  try {
    res = await request(state, "GET", route, { timeoutMs, headers: { accept: "text/html" } });
  } catch (e) {
    return { route, ok: false, error: e.name === "TimeoutError" ? `timeout after ${timeoutMs / 1000}s (first compile can be slow)` : e.message, ms: Date.now() - t0 };
  }
  const html = res.text || "";
  const markers = nextErrorMarkers(html);
  const result = { route, status: res.status, ms: res.ms, bytes: res.bytes };
  if (res.headers.location) result.redirect = res.headers.location;
  if (runDir && html) {
    const file = path.join(runDir, `${route.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "root"}.html`);
    fs.writeFileSync(file, html);
    result.htmlFile = file;
  }
  if (/text\/html/.test(res.headers["content-type"] || "") && html) {
    const o = outlineHtml(html, { url: new URL(route, state.baseUrl).href, maxLines });
    result.title = o.title;
    result.counts = o.counts;
    result.outline = o.lines;
    if (o.truncated) result.outlineTruncated = true;
  } else if (res.json !== undefined) {
    result.json = res.json;
  }
  if (markers.length) result.errors = markers;
  const toLogin = res.status >= 300 && res.status < 400 && /\/login/.test(res.headers.location || "");
  if (toLogin) result.errors = [...(result.errors || []), "redirected to /login (auth not seeded?)"];
  result.ok = res.status < 400 && !markers.length && !toLogin;
  return result;
}
