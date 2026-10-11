import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual } };
});
vi.mock("child_process", () => ({
  exec: (_cmd, _opts, cb) => cb(new Error("not found"), "", ""),
}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ myStatus: init?.status, body }),
  },
}));

const { GET } = await import("../../src/app/api/cli-tools/openclaw-settings/route.js");

it("direct", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-d-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  process.env.OPENCLAW_HOME = path.join(home, ".openclaw");
  const p = path.join(home, ".openclaw", "openclaw.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "{ broken");
  const res = await GET();
  throw new Error("DIRECT " + JSON.stringify(res).slice(0, 400));
});
