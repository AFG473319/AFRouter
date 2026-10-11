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
  delete process.env.CRUSH_GLOBAL_CONFIG;
  process.env.XDG_CONFIG_HOME = state.configHome;
});

describe("crush-settings", () => {
  it("writes the full catwalk Model fields from the resolved spec", async () => {
    const res = await POST({
      json: async () => ({
        baseUrl: "http://127.0.0.1:20128",
        apiKey: "k",
        models: ["codex/gpt-5.6-sol", "openai/gpt-4o"],
      }),
    });
    expect(res.body.success).toBe(true);
    const cfg = readConfig();
    const models = cfg.providers.afrouter.models;
    expect(models).toEqual([
      {
        id: "codex/gpt-5.6-sol",
        name: "codex/gpt-5.6-sol",
        cost_per_1m_in: 0,
        cost_per_1m_out: 0,
        cost_per_1m_in_cached: 0,
        cost_per_1m_out_cached: 0,
        context_window: 372000,
        default_max_tokens: 128000,
        can_reason: true,
        reasoning_levels: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
        default_reasoning_effort: "high",
        supports_attachments: true,
      },
      {
        id: "openai/gpt-4o",
        name: "openai/gpt-4o",
        cost_per_1m_in: 0,
        cost_per_1m_out: 0,
        cost_per_1m_in_cached: 0,
        cost_per_1m_out_cached: 0,
        context_window: 128000,
        default_max_tokens: 16384,
        can_reason: false,
        supports_attachments: true,
      },
    ]);
    // Selection + schema are written so Crush starts on our model.
    expect(cfg.models.large).toEqual({ model: "codex/gpt-5.6-sol", provider: "afrouter" });
    expect(cfg.$schema).toBe("https://charm.land/crush.json");
    expect(res.body.written).toEqual(["codex/gpt-5.6-sol", "openai/gpt-4o"]);
  });

  it("writes the toggle-only model's own two-level ladder verbatim", async () => {
    await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", models: ["zai/glm-5.1"] }) });
    const entry = readConfig().providers.afrouter.models[0];
    expect(entry.can_reason).toBe(true);
    // zai's on/off pair is a real ladder in the registry, so it is passed through.
    expect(entry.reasoning_levels).toEqual(["none", "thinking"]);
    expect(entry.default_reasoning_effort).toBe("thinking");
  });

  it("migrates a legacy 9router provider block to afrouter", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ providers: { "9router": { type: "openai-compat", base_url: "http://old/v1" } } }),
    );
    await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }) });
    const cfg = readConfig();
    expect(cfg.providers["9router"]).toBeUndefined();
    expect(cfg.providers.afrouter.base_url).toBe("http://x/v1");
  });

  it("merges models additively and refreshes specs on re-Apply", async () => {
    await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] }) });
    const cfg = readConfig();
    cfg.providers.afrouter.models.push({ id: "hand/typed", name: "hand", context_window: 1 });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
    const res = await POST({
      json: async () => ({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o", "codex/gpt-5.6-sol"] }) },
    );
    const ids = readConfig().providers.afrouter.models.map((m) => m.id);
    expect(ids).toEqual(["openai/gpt-4o", "hand/typed", "codex/gpt-5.6-sol"]);
    expect(res.body.backupPath).toBeTruthy();
  });

  it("returns 409 and writes nothing when crush.json cannot be parsed", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    const broken = '{ "providers": ';
    fs.writeFileSync(configPath(), broken);
    const res = await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", model: "m" }) });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(broken);
  });

  it("honours CRUSH_GLOBAL_CONFIG", async () => {
    const dir = path.join(state.configHome, "cr");
    process.env.CRUSH_GLOBAL_CONFIG = dir;
    const res = await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }) });
    expect(res.body.success).toBe(true);
    expect(fs.existsSync(path.join(dir, "crush.json"))).toBe(true);
  });

  it("DELETE removes only our provider, selection and schema", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({
        $schema: "https://charm.land/crush.json",
        providers: { other: { base_url: "http://o" } },
      }),
    );
    await POST({ json: async () => ({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }) });
    const res = await DELETE();
    expect(res.body.success).toBe(true);
    const cfg = readConfig();
    expect(cfg.providers.afrouter).toBeUndefined();
    expect(cfg.providers.other).toBeTruthy();
    expect(cfg.models).toBeUndefined();
    expect(cfg.$schema).toBeUndefined();
  });

  it("reports configured only for our own provider", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(
      configPath(),
      JSON.stringify({ providers: { other: { base_url: "http://127.0.0.1:20128/v1" } } }),
    );
    const res = await GET();
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(false);
  });

  it("GET reports install state without throwing when absent", async () => {
    const res = await GET();
    expect(res.body.installed).toBe(false);
  });
});
