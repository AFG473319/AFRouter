// One JSON object on stdout per command, always. Full (unbounded) result goes to
// <runDir>/result.json when a run dir exists; stdout carries the bounded copy.
import fs from "node:fs";
import path from "node:path";
import { bound, MAX_BYTES } from "./bound.mjs";

export function emit(result, { pretty = false, runDir, maxBytes = MAX_BYTES } = {}) {
  let fullPath;
  if (runDir) {
    fullPath = path.join(runDir, "result.json");
    try {
      fs.writeFileSync(fullPath, JSON.stringify(result, null, 2));
    } catch {
      fullPath = undefined;
    }
  }
  const bounded = bound(result, { maxBytes, fullPath });
  if (runDir && !bounded.runDir) bounded.runDir = runDir;
  const text = pretty ? JSON.stringify(bounded, null, 2) : JSON.stringify(bounded);
  process.stdout.write(`${text}\n`);
  if (result.ok === false && !process.exitCode) process.exitCode = 1;
  return bounded;
}

export class HarnessError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.extra = extra;
  }
}
