// ESLint on changed JS files only, with problems split into "on lines this change touched"
// (the ones that count) and pre-existing noise elsewhere in the same files.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO_ROOT } from "./paths.mjs";
import { changedLines, inRanges } from "./changed.mjs";

const ESLINT = path.join(REPO_ROOT, "node_modules", "eslint", "bin", "eslint.js");
export const LINTABLE = /\.(js|mjs|cjs|jsx)$/;

export async function lintFiles(files, { base, runDir, timeoutMs = 900_000 } = {}) {
  const targets = files.filter((f) => LINTABLE.test(f) && fs.existsSync(path.join(REPO_ROOT, f)));
  if (!targets.length) return { ok: true, files: 0, note: "no JS files changed" };
  if (!fs.existsSync(ESLINT)) return { ok: true, skipped: "eslint not installed (npm install)" };
  const t0 = Date.now();
  const out = await new Promise((resolve) => {
        // --cache: unchanged files are skipped next time; the compile cache speeds cold plugin loads.
    const child = spawn(process.execPath, [ESLINT, "--format", "json", "--no-warn-ignored", "--cache", "--cache-location", path.join(REPO_ROOT, ".agent", "eslintcache"), ...targets], {
      cwd: REPO_ROOT,
      windowsHide: true,
      env: { ...process.env, NODE_COMPILE_CACHE: process.env.NODE_COMPILE_CACHE || path.join(REPO_ROOT, ".agent", "compile-cache") },
    });
    let s = "";
    let e = "";
    child.stdout.on("data", (d) => (s += d));
    child.stderr.on("data", (d) => (e += d));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, s, e });
    });
  });
  let results;
  try {
    results = JSON.parse(out.s);
  } catch {
    return { ok: false, error: out.code === null ? `eslint timed out after ${timeoutMs / 1000}s` : `eslint failed (exit ${out.code})`, stderr: out.e.slice(0, 1000), ms: Date.now() - t0 };
  }
  if (runDir) fs.writeFileSync(path.join(runDir, "eslint.json"), out.s);
  const ranges = changedLines(targets, base);
  const fresh = [];
  let preexistingErrors = 0;
  let preexistingWarnings = 0;
  for (const r of results) {
    const rel = path.relative(REPO_ROOT, r.filePath).split(path.sep).join("/");
    for (const m of r.messages) {
      const isNew = m.fatal || inRanges(ranges[rel], m.line || 0);
      const sev = m.severity === 2 ? "error" : "warning";
      if (isNew) fresh.push({ at: `${rel}:${m.line || 0}:${m.column || 0}`, severity: sev, rule: m.ruleId || "parse", message: m.message.slice(0, 200) });
      else if (sev === "error") preexistingErrors++;
      else preexistingWarnings++;
    }
  }
  const newErrors = fresh.filter((m) => m.severity === "error").length;
  return {
    ok: newErrors === 0,
    files: targets.length,
    newErrors,
    newWarnings: fresh.length - newErrors,
    preexisting: { errors: preexistingErrors, warnings: preexistingWarnings },
    messages: fresh.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1)).slice(0, 40),
    ms: Date.now() - t0,
  };
}
