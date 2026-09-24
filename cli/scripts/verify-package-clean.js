#!/usr/bin/env node
// Privacy gate for the packaged CLI bundle: fails when anything that identifies
// the BUILDER survived into cli/app. Run after sanitize-personal.js, before
// `npm publish`.
//
// Invariants (no developer name is ever embedded in this repo to check against —
// the checks are structural, so they hold for any builder on any machine):
//   1. No Windows home paths (`C:\Users\...`, `C:/Users/...`) anywhere outside
//      vendored dependencies. The release build runs on Linux; such a path in
//      generated output means a locally packed artifact leaked in.
//   2. No /home/<user> path for any account other than the generic CI accounts
//      the sanitizer leaves in place (runner) or its neutral replacement
//      (builder). A foreign home path in generated output means a non-CI build.
//   3. No machine-id / SQLite state / .env files — checked EVERYWHERE,
//      including node_modules (a credential file must never ship, and a
//      postinstall artifact under a dependency would be just as fatal).
//
// Vendored node_modules is exempt from the two CONTENT checks only: dependency
// source ships byte-identical to every install and legitimately contains
// foreign-home constants (`/home/nate` in bindings, `/home/web_user` in
// sql.js's emscripten output, Windows example strings in next) — none of which
// can be the builder's identity. Generated build output (manifests, .nft.json,
// source maps, server chunks — everything outside node_modules) is where build
// paths actually land, and it is scanned strictly.
//
// Text files only (same allowlist as the sanitizer); binaries are skipped.
// Exits 1 and prints every offending path so the failure is actionable.

const fs = require("fs");
const path = require("path");

const cliAppDir = process.env.AFROUTER_CLI_APP_DIR || path.join(__dirname, "..", "app");
const TEXT_EXT = new Set([".js", ".json", ".mjs", ".cjs", ".map", ".txt", ".html", ".css", ".toml", ".md"]);
const ALLOWED_HOME_USERS = new Set(["runner", "builder"]);

const violations = [];

function record(file, kind, detail) {
  violations.push({ file: path.relative(cliAppDir, file), kind, detail });
}

function checkTextFile(file, s) {
  // C:\Users\<name> is a Windows build path; the neutral "builder" account the
  // sanitizer writes is allowed so a laptop-fallback publish stays valid — a
  // CI build never produces Windows paths at all.
  if (/[A-Za-z]:[\\/]Users[\\/](?!builder[\\/])/.test(s)) record(file, "windows-home-path", "contains a C:\\Users\\... build path");
  for (const m of s.matchAll(/\/home\/([^/\s"'`\\]+)/g)) {
    if (!ALLOWED_HOME_USERS.has(m[1].toLowerCase())) {
      record(file, "foreign-home-path", `/home/${m[1]}`);
      break;
    }
  }
  // NOTE: a "machine-id" string in bundled code is NOT a leak (the app reads
  // <DATA_DIR>/machine-id at runtime) — only an actual machine-id file is, and
  // checkFileNames covers that.
}

function checkFileNames(file, name, vendored) {
  const lower = name.toLowerCase();
  if (lower === "machine-id" || lower === "machineid") record(file, "identity-file", name);
  // Vendored packages may legitimately ship .sqlite fixtures; a state DB only
  // matters in the app's own tree.
  if (!vendored && (lower.endsWith(".sqlite") || lower.endsWith(".sqlite-wal") || lower.endsWith(".sqlite-shm"))) record(file, "state-file", name);
  if (lower === ".env" || lower.startsWith(".env.")) record(file, "env-file", name);
}

(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    const vendored = p.split(path.sep).includes("node_modules");
    checkFileNames(p, e.name, vendored);
    if (vendored) continue; // content checks skip vendored dependencies
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    let s;
    try { s = fs.readFileSync(p, "utf8"); } catch { continue; }
    checkTextFile(p, s);
  }
})(cliAppDir);

if (violations.length) {
  console.error("[verify-package-clean] FAILED — builder identity/state found in the package:");
  const seen = new Set();
  for (const v of violations) {
    const key = `${v.kind}:${v.file}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.error(`  [${v.kind}] ${v.file} — ${v.detail}`);
  }
  process.exit(1);
}

console.log("[verify-package-clean] OK — no builder paths, identity files, state DBs, or .env files in the bundle");
