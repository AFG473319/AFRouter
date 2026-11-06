// Changed files (committed on the branch + staged + unstaged + untracked) and the exact
// lines touched, so lint can report only problems the change introduced.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "./paths.mjs";

function git(args) {
  const r = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : "";
}

export function defaultBase() {
  for (const ref of ["origin/master", "master", "origin/main", "main"]) {
    if (git(["rev-parse", "--verify", "--quiet", ref]).trim()) {
      const mb = git(["merge-base", "HEAD", ref]).trim();
      if (mb) return mb;
    }
  }
  return "HEAD";
}

export function changedFiles(base = defaultBase()) {
  const set = new Set();
  const add = (out) => out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((f) => set.add(f));
  if (base !== "HEAD") add(git(["diff", "--name-only", "--diff-filter=ACMR", `${base}...HEAD`]));
  add(git(["diff", "--name-only", "--diff-filter=ACMR"]));
  add(git(["diff", "--name-only", "--diff-filter=ACMR", "--cached"]));
  add(git(["ls-files", "--others", "--exclude-standard"]));
  return [...set].filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).sort();
}

// Parse `git diff -U0` hunks into { file: [[start, end], ...] } for the new side.
export function parseHunks(diffText) {
  const out = {};
  let file = null;
  for (const line of diffText.split(/\r?\n/)) {
    const f = line.match(/^\+\+\+ b\/(.+)$/);
    if (f) {
      file = f[1];
      out[file] = out[file] || [];
      continue;
    }
    const h = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (h && file) {
      const start = Number(h[1]);
      const count = h[2] === undefined ? 1 : Number(h[2]);
      if (count > 0) out[file].push([start, start + count - 1]);
    }
  }
  return out;
}

export function changedLines(files, base = defaultBase()) {
  const ranges = parseHunks(git(["diff", "-U0", base === "HEAD" ? "HEAD" : base, "--", ...files]));
  const untracked = new Set(git(["ls-files", "--others", "--exclude-standard", "--", ...files]).split(/\r?\n/).filter(Boolean));
  for (const f of untracked) ranges[f] = [[1, Number.MAX_SAFE_INTEGER]];
  return ranges;
}

export function inRanges(ranges, line) {
  return (ranges || []).some(([a, b]) => line >= a && line <= b);
}
