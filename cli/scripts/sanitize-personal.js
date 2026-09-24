#!/usr/bin/env node
// Privacy scrub for the packaged CLI bundle. Runs between build and npm pack.
//
// Two kinds of build artifacts leak the builder's identity:
//
//  1. Throwaway state. The MITM sub-build creates a home dir under app/ with a
//     real machine-id file and a runtime-generated database — never ship it.
//  2. Absolute build-time paths. Next.js build manifests (required-server-files.json,
//     *_client-reference-manifest.js, *.nft.json, source maps) embed the absolute
//     build directory, which contains the OS account name.
//
// Scrubbing rules:
//   - The full home path is ALWAYS replaced (e.g. "/home/runner" -> "/home/builder").
//     A path string cannot appear in prose, so this is safe everywhere.
//   - The bare account name is replaced globally ONLY when it is distinctive.
//     Generic CI/dev accounts ("runner", "root", "user", ...) also occur in
//     ordinary words - replacing "runner" everywhere would corrupt code
//     identifiers, docs and user-visible strings in the shipped package.
//   - AFROUTER_SANITIZE_TOKEN overrides the derived name (used by CI to scrub a
//     known token explicitly, and by tests).
//
// Replacing keeps every path internally consistent (same depth) while removing
// the personal identifier.

const fs = require("fs");
const path = require("path");
const os = require("os");

const cliAppDir = process.env.AFROUTER_CLI_APP_DIR || path.join(__dirname, "..", "app");

// OS accounts whose names collide with ordinary words; only their home PATH is
// scrubbed, never the bare word.
const GENERIC_ACCOUNT_NAMES = new Set([
  "runner", "root", "user", "ubuntu", "build", "builder", "node", "nobody",
  "vscode", "codespace", "host", "admin", "docker", "ci",
]);

// 1. Throwaway build state — remove before anything else.
for (const junk of ["cli", ".build-home"]) {
  const p = path.join(cliAppDir, junk);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    console.log(`[sanitize] removed build-artifact dir app/${junk}`);
  }
}

// Defensive sweep: a machine-id or SQLite file directly in the bundle means a
// build ran with the real profile. machine identity must never ship.
function removeIdentityFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue; // runtime deps, no build state
      removeIdentityFiles(p);
      continue;
    }
    const lower = entry.name.toLowerCase();
    if (lower === "machine-id" || lower === "machineid" || lower.endsWith(".sqlite") || lower.endsWith(".sqlite-wal") || lower.endsWith(".sqlite-shm")) {
      fs.rmSync(p, { force: true });
      console.log(`[sanitize] removed identity/state file ${path.relative(cliAppDir, p)}`);
    }
  }
}
if (fs.existsSync(cliAppDir)) {
  removeIdentityFiles(cliAppDir);
}

// 2. Path / name scrubbing.
const override = String(process.env.AFROUTER_SANITIZE_TOKEN || "").trim();
const home = os.homedir(); // e.g. C:\Users\<name> or /home/<name>
const derivedName = path.basename(path.dirname(home)) === "Users"
  ? path.basename(home)           // Windows: C:\Users\<name>
  : path.basename(home);
const username = override || derivedName;

if (!username) {
  console.log("[sanitize] could not derive username, skipping");
  process.exit(0);
}

// Neutral homes of the same shape — derived from the platform, never from the
// real one (string-replacing inside the real path can put it straight back).
const isWindowsHome = /^[A-Za-z]:/.test(home);
const windowsReplacementHome = "C:\\Users\\builder";
const posixReplacementHome = "/home/builder";
const replacementHome = isWindowsHome ? windowsReplacementHome : posixReplacementHome;

// Every home-path form to scrub: the real home (both separators) plus the
// effective account's canonical homes in both styles. Deduplicated.
const homeForms = [];
{
  const add = (form, windows) => {
    if (!form || homeForms.some((h) => h.form === form)) return;
    homeForms.push({ form, windows });
  };
  add(home, isWindowsHome);
  add(home.replace(/\\/g, "/"), isWindowsHome);
  if (username) {
    add(`/home/${username}`, false);
    add(`C:\\Users\\${username}`, true);
    add(`C:/Users/${username}`, true);
  }
}

const TEXT_EXT = new Set([".js", ".json", ".mjs", ".cjs", ".map", ".txt", ".html", ".css", ".toml", ".md"]);

let files = 0;
let homeHits = 0;
let nameHits = 0;

function replaceIn(text, needle, replacement, flags) {
  if (!needle) return { text, count: 0 };
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  const count = (text.match(re) || []).length;
  return count ? { text: text.replace(re, replacement), count } : { text, count: 0 };
}

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let s;
    try { s = fs.readFileSync(p, "utf8"); } catch { continue; }
    const before = s;
    let touched = false;

    // (a) home paths, both separators, always safe to replace. The set covers
    // the real home plus the effective account's canonical home forms, so an
    // override (CI rehearsal, fallback publish, tests) scrubs that account's
    // paths even when the host's real home differs.
    for (const { form, windows } of homeForms) {
      const r = replaceIn(s, form, windows ? windowsReplacementHome : posixReplacementHome, "g");
      if (r.count) { s = r.text; homeHits += r.count; touched = true; }
    }

    // (b) bare account name — only when distinctive. Generic CI/dev accounts
    // ("runner", "root", ...) also occur in ordinary words, so replacing them
    // everywhere would corrupt the shipped bundle; their home path (a) already
    // covers the only place they appear in build output. An explicit override
    // replaces the derived NAME, not this decision: override a generic name and
    // you still get path-only scrubbing.
    if (!GENERIC_ACCOUNT_NAMES.has(username.toLowerCase())) {
      const r = replaceIn(s, username, "builder", "gi");
      if (r.count) { s = r.text; nameHits += r.count; touched = true; }
    }

    if (touched && s !== before) {
      try { fs.writeFileSync(p, s, "utf8"); files++; } catch { /* best effort */ }
    }
  }
})(cliAppDir);

const mode = override
  ? `token '${username}' from AFROUTER_SANITIZE_TOKEN`
  : GENERIC_ACCOUNT_NAMES.has(username.toLowerCase())
    ? `account '${username}' is generic — scrubbed home paths only, bare name left intact (it occurs in ordinary words)`
    : `account '${username}'`;
console.log(
  `[sanitize] ${mode}: replaced ${homeHits} home-path and ${nameHits} bare-name occurrence(s) in ${files} file(s) under app/`,
);
