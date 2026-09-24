// The release privacy gate only matters if it actually holds: these tests pin
// the two rules that protect the published package.
//   1. Distinctive account names are scrubbed everywhere (the Windows laptop case).
//   2. Generic CI accounts ("runner") only get their home PATH scrubbed — the
//      bare word occurs in ordinary prose/code and replacing it would corrupt
//      the shipped bundle.
// The scripts run as child processes because their failure path calls
// process.exit, which would take a vitest worker down if required in-process.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = path.resolve(fileURLToPath(new URL("../../cli/scripts/", import.meta.url)));
const SANITIZE = path.join(SCRIPTS, "sanitize-personal.js");
const VERIFY = path.join(SCRIPTS, "verify-package-clean.js");

let appDir;

const write = (rel, content) => {
  const p = path.join(appDir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
  return p;
};

const read = (rel) => fs.readFileSync(path.join(appDir, rel), "utf8");

const run = (script, env = {}) =>
  execFileSync(process.execPath, [script], {
    env: { ...process.env, AFROUTER_CLI_APP_DIR: appDir, ...env },
    encoding: "utf8",
  });

const runExpectingFailure = (script, env = {}) => {
  let failed = false;
  try {
    run(script, env);
  } catch {
    failed = true;
  }
  return failed;
};

beforeEach(() => {
  appDir = fs.mkdtempSync(path.join(os.tmpdir(), "afrouter-privacy-"));
});

afterEach(() => {
  fs.rmSync(appDir, { recursive: true, force: true });
});

describe("release package privacy", () => {
  it("scrubs a distinctive account name everywhere and keeps the bundle gate green", () => {
    write("server/chunk.js", 'const home = "C:/Users/Jane-Doe/9router"; const note = "built by Jane-Doe";');
    write("server/manifest.json", JSON.stringify({ buildDir: "/home/jane-doe/AFRouter" }));

    run(SANITIZE, { AFROUTER_SANITIZE_TOKEN: "Jane-Doe" });

    const chunk = read("server/chunk.js");
    expect(chunk).not.toContain("Jane-Doe");
    expect(chunk).toContain("builder");
    expect(read("server/manifest.json")).not.toContain("jane-doe");
    expect(run(VERIFY).length).toBeGreaterThan(0); // gate passes
  });

  it("scrubs only the home path for a generic CI account and leaves the word intact", () => {
    write("server/chunk.js", 'const label = "test runner"; const root = "/home/runner/work/AFRouter/AFRouter";');

    run(SANITIZE, { AFROUTER_SANITIZE_TOKEN: "runner" });

    const chunk = read("server/chunk.js");
    expect(chunk).toContain('"test runner"');           // ordinary word untouched
    expect(chunk).not.toContain("/home/runner");         // build path scrubbed
    expect(chunk).toContain("/home/builder");
  });

  it("removes throwaway build state and identity files", () => {
    write("cli/home/machine-id", "raw-machine-id-value");
    write("db/data.sqlite", "sqlite-bytes");
    write(".env", "JWT_SECRET=nope\n");

    run(SANITIZE, { AFROUTER_SANITIZE_TOKEN: "builder" });

    expect(fs.existsSync(path.join(appDir, "cli"))).toBe(false);
    expect(fs.existsSync(path.join(appDir, "db/data.sqlite"))).toBe(false);
    expect(runExpectingFailure(VERIFY)).toBe(true); // .env still there -> gate fails
  });

  it("fails the gate on a Windows home path (a locally packed artifact)", () => {
    write("server/old.js", 'const p = "C:\\Users\\Someone\\afrouter\\app";');

    expect(runExpectingFailure(VERIFY)).toBe(true);
  });

  it("fails the gate on a foreign home path", () => {
    write("server/old.json", JSON.stringify({ dir: "/home/someone-else/app" }));

    expect(runExpectingFailure(VERIFY)).toBe(true);
  });

  it("passes a clean, CI-built bundle", () => {
    write("server/chunk.js", 'const root = "/home/builder/app"; const note = "test runner";');
    write("server/manifest.json", JSON.stringify({ ok: true }));

    expect(runExpectingFailure(VERIFY)).toBe(false);
  });
});
