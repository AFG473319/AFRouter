// Agent harness: the pure parts of `watch` (which files count, event shape). No server, no child processes.
import { describe, it, expect } from "vitest";
import { relevant, toEvent } from "../../scripts/agent/lib/watch.mjs";

describe("watch", () => {
  it("only reacts to source files outside build/run dirs", () => {
    expect(relevant("src/app/page.js")).toBe(true);
    expect(relevant("src/app/globals.css")).toBe(true);
    expect(relevant("open-sse/handlers/chatCore.js")).toBe(true);
    expect(relevant("tests/node_modules/x/index.js")).toBe(false);
    expect(relevant(".next-agent/server/app.js")).toBe(false);
    expect(relevant(".agent/runs/x/result.json")).toBe(false);
    expect(relevant("src/data.sqlite")).toBe(false);
    expect(relevant("src/README.md")).toBe(false);
  });

  it("turns a check result into a compact event", () => {
    const ev = toEvent(["src/a.js"], { ok: false, summary: "1 problem(s)", failures: ["a", "b", "c", "d", "e", "f"], runDir: "/r" }, 1234);
    expect(ev).toEqual({ event: "check", ok: false, files: ["src/a.js"], summary: "1 problem(s)", failures: ["a", "b", "c", "d", "e"], runDir: "/r", ms: 1234 });
    expect(toEvent(["x.js"], null, 5).ok).toBe(false);
    expect(toEvent(["x.js"], { ok: true, summary: "ok" }, 5)).toEqual({ event: "check", ok: true, files: ["x.js"], summary: "ok", ms: 5 });
  });
});
