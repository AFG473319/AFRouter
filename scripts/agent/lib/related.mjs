// Which test files exercise the changed files? A cheap static import graph (regex over
// import/require specifiers, resolving relative paths and the "@/" + "open-sse" aliases),
// walked in reverse from each changed file. `vitest related` does the same with a full
// module graph and costs minutes on a slow disk; this takes well under a second.
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";

const ROOTS = ["src", "open-sse", "tests"];
const EXT = /\.(js|mjs|cjs|jsx)$/;
const SPEC_RE = /(?:import|export)\s[^'"]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\(\s*["']([^"']+)["']\s*\)|import\s+["']([^"']+)["']/g;

function walk(dir, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXT.test(e.name)) out.push(p);
  }
}

export function resolveSpec(spec, fromFile, exists = fs.existsSync) {
  let base;
  if (spec.startsWith("./") || spec.startsWith("../")) base = path.resolve(path.dirname(fromFile), spec);
  else if (spec.startsWith("@/")) base = path.join(REPO_ROOT, "src", spec.slice(2));
  else if (spec === "open-sse" || spec.startsWith("open-sse/")) base = path.join(REPO_ROOT, spec);
  else return null;
  for (const cand of [base, `${base}.js`, `${base}.mjs`, `${base}.jsx`, path.join(base, "index.js")]) {
    if (EXT.test(cand) && exists(cand)) return cand;
  }
  return null;
}

export function buildReverseGraph(files) {
  const reverse = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(SPEC_RE)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      const target = resolveSpec(spec, file);
      if (!target) continue;
      if (!reverse.has(target)) reverse.set(target, new Set());
      reverse.get(target).add(file);
    }
  }
  return reverse;
}

export function isTestFile(f) {
  return /\.test\.js$/.test(f);
}

/** @returns {{ tests: string[], dom: string[], total: number }} repo-relative test paths */
export function relatedTests(changed, { maxDepth = 6 } = {}) {
  const files = [];
  for (const r of ROOTS) walk(path.join(REPO_ROOT, r), files);
  const reverse = buildReverseGraph(files);
  const found = new Map(); // test file -> import distance (closest first)
  const seen = new Set();
  let frontier = changed.map((f) => path.resolve(REPO_ROOT, f));
  for (const f of frontier) if (isTestFile(f)) found.set(f, 0);
  for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
    const next = [];
    for (const f of frontier) {
      if (seen.has(f)) continue;
      seen.add(f);
      for (const importer of reverse.get(f) || []) {
        if (isTestFile(importer)) {
          if (!found.has(importer)) found.set(importer, depth + 1);
        }
        else next.push(importer);
      }
    }
    frontier = next;
  }
  const ordered = [...found.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([f]) => f);
  const rel = ordered.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/")).filter((f) => !/translator\/real\/|embeddings\.cloud|xai-oauth-service|mimo-free\.live/.test(f));
  return { tests: rel.filter((f) => !f.endsWith(".dom.test.js")), dom: rel.filter((f) => f.endsWith(".dom.test.js")), total: rel.length };
}
