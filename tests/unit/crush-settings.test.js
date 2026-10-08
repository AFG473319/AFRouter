import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ configHome: null }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, default: { ...actual } };
});

vi.mock("child_process", () => ({
  exec: (_cmd, _opts, callback) => {
    const error = new Error("not found");
    error.code = 1;
    callback(error, "", "");
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

vi.mock("../../src/app/api/cli-tools/resolveApiKey.js", () => ({
  resolveCliApiKey: async (key) => (key && key.trim() ? key.trim() : ""),
}));

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/crush-settings/route.js");

const configPath = () => path.join(state.configHome, "crush", "crush.json");
const readConfig = () => JSON.parse(fs.readFileSync(configPath(), "utf-8"));

beforeEach(() => {
  state.configHome = fs.mkdtempSync(path.join(os.tmpdir(), "crush-home-"));
  process.env.XDG_CONFIG_HOME = state.configHome;
});

describe("crush-settings", () => {
  it("writes resolved context windows, not the hardcoded floor", async () => {
    const res = await POST({
      json: async () => ({
        baseUrl: "http://127.0.0.1:20128",
        apiKey: "k",
        models: ["codex/gpt-5.6-sol", "openai/gpt-4o"],
      }),
    });
    expect(res.body.success).toBe(true);
    const models = readConfig().providers["9router"].models;
    expect(models).toEqual([
      { id: "codex/gpt-5.6-sol", name: "codex/gpt-5.6-sol", context_window: 372000 },
      { id: "openai/gpt-4o", name: "openai/gpt-4o", context_window: 128000 },
    ]);
    expect(res.body.written).toEqual(["codex/gpt-5.6-sol", "openai/gpt-4o"]);
  });

  it("falls back to the capability floor for ids the registry does not know", async () => {
    // getCapabilitiesForModel always returns a finite safe floor — the same
    // convention every other tool route uses for unresolvable ids.
    const res = await POST({
      json: async () => ({ baseUrl: "http://x", apiKey: "k", models: ["nope/unknown-model-zzz"] }),
    });
    expect(res.body.written).toEqual(["nope/unknown-model-zzz"]);
    expect(readConfig().providers["9router"].models[0].context_window).toBe(200000);
  });

  it("merges models additively and refreshes specs on re-Apply", async () => {
    await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] }) });
    const cfg = readConfig();
    cfg.providers["9router"].models.push({ id: "hand/typed", name: "hand", context_window: 1 });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
    const res = await POST({
      json: async () => ({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o", "codex/gpt-5.6-sol"] }),
    });
    const ids = readConfig().providers["9router"].models.map((m) => m.id);
    expect(ids).toEqual(["openai/gpt-4o", "hand/typed", "codex/gpt-5.6-sol"]);
    expect(res.body.backupPath).toBeTruthy();
  });

  it("DELETE removes only our provider", async () => {
    await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }) });
    const res = await DELETE();
    expect(res.body.success).toBe(true);
    expect(readConfig().providers?.["9router"]).toBeUndefined();
  });

  it("GET reports install state without throwing when absent", async () => {
    const res = await GET();
    expect(res.body.installed).toBe(false);
  });
});
