// Compact role/text outline of a DOM: what a screen reader (and an agent) needs, in a few
// hundred tokens. Works on any standard DOM: happy-dom parsing server HTML (no scripts run),
// or the live happy-dom document inside a Vitest render.
//
//   - main
//     - heading[1] "Providers"
//     - button "Add provider"
//     - textbox "Search" value="op"
//     - text: 3 connected
import { computeAccessibleName } from "dom-accessibility-api";

const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "IFRAME", "OBJECT"]);
const CONTAINERS = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "form", "dialog", "alertdialog", "list", "table", "region", "group", "tablist", "menu", "listbox", "row", "search", "alert", "status"]);
const NAMED_FROM_CONTENT = new Set(["button", "link", "heading", "tab", "menuitem", "option", "cell", "columnheader", "listitem", "checkbox", "radio", "switch", "summary"]);
// Block elements end a run of text, so paragraphs and labels stay on their own lines.
const BLOCK = new Set(["P", "DIV", "LABEL", "SECTION", "ARTICLE", "HEADER", "FOOTER", "LI", "TD", "TH", "TR", "PRE", "BLOCKQUOTE", "FIGCAPTION", "DT", "DD", "LEGEND", "BR", "HR"]);
const LANDMARK_TAGS = { NAV: "navigation", MAIN: "main", ASIDE: "complementary", FORM: "form", DIALOG: "dialog", UL: "list", OL: "list", MENU: "list", LI: "listitem", TABLE: "table", TR: "row", TH: "columnheader", TD: "cell", PROGRESS: "progressbar", SUMMARY: "button", DETAILS: "group", FIELDSET: "group", OPTION: "option", SEARCH: "search" };

export function implicitRole(el) {
  const tag = el.tagName;
  const explicit = el.getAttribute("role");
  if (explicit) return explicit.split(/\s+/)[0];
  if (/^H[1-6]$/.test(tag)) return "heading";
  if (tag === "A") return el.hasAttribute("href") ? "link" : null;
  if (tag === "BUTTON") return "button";
  if (tag === "TEXTAREA") return "textbox";
  if (tag === "SELECT") return el.multiple || Number(el.getAttribute("size")) > 1 ? "listbox" : "combobox";
  if (tag === "IMG") return el.getAttribute("alt") ? "img" : null;
  if (tag === "INPUT") {
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return ({ checkbox: "checkbox", radio: "radio", range: "slider", number: "spinbutton", search: "searchbox", button: "button", submit: "button", reset: "button", image: "button", hidden: null, file: "button" })[type] ?? "textbox";
  }
  if (tag === "HEADER") return el.closest("main,article,section,aside,nav") ? null : "banner";
  if (tag === "FOOTER") return el.closest("main,article,section,aside,nav") ? null : "contentinfo";
  if (tag === "SECTION") return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
  return LANDMARK_TAGS[tag] || null;
}

function isHidden(el) {
  if (el.hasAttribute("hidden") || el.getAttribute("aria-hidden") === "true") return true;
  if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "hidden") return true;
  const style = el.getAttribute("style") || "";
  return /display\s*:\s*none|visibility\s*:\s*hidden/i.test(style);
}

const clean = (s, max = 200) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

// Material Symbols draw icons from ligature text ("dns", "expand_more"). Inside a control that
// also has real text they are noise; alone they are the only label, so keep them then.
const ICON_CLASS = /\bmaterial-(symbols|icons)/;
const isIcon = (el) => ICON_CLASS.test(el.getAttribute?.("class") || "");

function stripIcons(el, name) {
  if (!name || !el.querySelectorAll) return name;
  const icons = [...el.querySelectorAll("[class*='material-']")].filter(isIcon).map((i) => i.textContent.trim()).filter(Boolean);
  if (isIcon(el)) return name;
  let out = ` ${name} `;
  for (const word of icons) out = out.replace(` ${word} `, " ");
  out = out.replace(/\s+/g, " ").trim();
  return out || name;
}

function nameOf(el, role) {
  let name = "";
  try {
    name = computeAccessibleName(el);
  } catch {
    /* fall through */
  }
  if (!name) name = el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("placeholder") || "";
  if (!name && NAMED_FROM_CONTENT.has(role)) name = el.textContent || "";
  return clean(stripIcons(el, clean(name, 400)));
}

function describe(el, role) {
  const parts = [role];
  if (role === "heading") parts[0] = `heading[${el.getAttribute("aria-level") || el.tagName.slice(1) || "?"}]`;
  const name = nameOf(el, role);
  let line = name ? `${parts[0]} "${name.replace(/"/g, "'")}"` : parts[0];
  const flags = [];
  if (el.disabled || el.getAttribute("aria-disabled") === "true") flags.push("disabled");
  if (el.checked || el.getAttribute("aria-checked") === "true") flags.push("checked");
  if (el.getAttribute("aria-selected") === "true") flags.push("selected");
  if (el.getAttribute("aria-expanded") === "true") flags.push("expanded");
  if (el.getAttribute("aria-pressed") === "true") flags.push("pressed");
  if (el.required) flags.push("required");
  if (flags.length) line += ` [${flags.join(",")}]`;
  if ((role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "combobox") && el.value) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    const v = String(el.value);
    line += ` value="${type === "password" ? "••••" : /^(sk-|eyJ)[A-Za-z0-9._-]{12,}$/.test(v) ? `${v.slice(0, 6)}…${v.slice(-4)}` : clean(v, 60)}"`;
  }
  if (role === "link") {
    const href = el.getAttribute("href") || "";
    if (href && !href.startsWith("javascript:")) line += ` ${clean(href, 80)}`;
  }
  return line;
}

/**
 * @param {Document|Element} root
 * @param {{maxLines?: number, text?: boolean}} opts
 * @returns {{ lines: string[], counts: Record<string, number>, truncated: boolean }}
 */
export function outline(root, { maxLines = 300, text = true } = {}) {
  const lines = [];
  const counts = {};
  let truncated = false;
  let pendingText = [];
  let pendingDepth = 0;
  const seenBlocks = new Map();

  const push = (depth, line) => {
    if (lines.length >= maxLines) {
      truncated = true;
      return;
    }
    const entry = `${"  ".repeat(depth)}- ${line}`;
    const prev = lines[lines.length - 1];
    const m = prev && prev.match(/^(.*) ×(\d+)$/);
    if (prev === entry) lines[lines.length - 1] = `${entry} ×2`;
    else if (m && m[1] === entry) lines[lines.length - 1] = `${entry} ×${Number(m[2]) + 1}`;
    else lines.push(entry);
  };
  const flushText = () => {
    if (!pendingText.length) return;
    const t = clean(pendingText.join(" "), 200);
    if (t) push(pendingDepth, `text: ${t}`);
    pendingText = [];
  };

  const walk = (node, depth, insideNamed) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        if (!text || insideNamed) continue;
        const t = child.textContent.replace(/\s+/g, " ").trim();
        if (t.length > 1 || /\w/.test(t)) {
          if (!pendingText.length) pendingDepth = depth;
          pendingText.push(t);
        }
        continue;
      }
      if (child.nodeType !== 1) continue;
      if (SKIP.has(child.tagName) || child.tagName === "svg" || child.tagName === "SVG" || isHidden(child)) continue;
      if (isIcon(child) && !implicitRole(child)) continue;
      const role = implicitRole(child);
      if (role && role !== "presentation" && role !== "none" && role !== "generic") {
        flushText();
        counts[role] = (counts[role] || 0) + 1;
        const isContainer = CONTAINERS.has(role);
        const named = NAMED_FROM_CONTENT.has(role) && role !== "listitem" && role !== "cell";
        if (role === "listitem" || role === "cell" || role === "row") {
          // Lists/tables: descend without a line for the wrapper itself unless empty.
          walk(child, depth, insideNamed);
          flushText();
          continue;
        }
        push(depth, describe(child, role));
        if (isContainer) {
          const start = lines.length;
          walk(child, depth + 1, insideNamed);
          flushText();
          // Responsive layouts render the same nav twice (desktop + mobile drawer); CSS hides
          // one, which a DOM without layout can't see. Collapse exact repeats.
          const block = lines.slice(start).map((l) => l.trimStart()).join("\n");
          if (lines.length - start >= 4) {
            const prev = seenBlocks.get(block);
            if (prev) {
              const n = block.split("\n").length;
              lines.splice(start - 1);
              push(depth, `${describe(child, role)} (repeat of an earlier ${n}-line block, likely the responsive copy)`);
            } else seenBlocks.set(block, true);
          }
        } else if (!named && role !== "textbox" && role !== "combobox" && role !== "img") {
          walk(child, depth + 1, insideNamed);
          flushText();
        }
        continue;
      }
      if (BLOCK.has(child.tagName)) {
        flushText();
        walk(child, depth, insideNamed);
        flushText();
      } else walk(child, depth, insideNamed);
    }
  };

  const start = root.body || root;
  walk(start, 0, false);
  flushText();
  return { lines, counts, truncated };
}

// Next.js error markers in server HTML (dev overlay data, global error page, 404 page).
export function nextErrorMarkers(html) {
  const markers = [];
  if (/id="__next_error__"/.test(html)) markers.push("next-error-page");
  const msg = html.match(/data-next-error-message="([^"]{0,400})/);
  if (msg) markers.push(`error: ${msg[1]}`);
  const digest = html.match(/data-next-error-digest="([^"]{0,80})/);
  if (digest) markers.push(`digest: ${digest[1]}`);
  if (/Application error: a (server|client)-side exception/.test(html)) markers.push("application-error");
  return markers;
}
