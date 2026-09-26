/**
 * Unit tests for /api/cli-tools/pi-settings (Pi coding agent integration).
 *
 * Covers the destructive config-write paths against a temp agent dir:
 *  - GET never 500s on missing/corrupt models.json
 *  - GET never leaks the api key value
 *  - POST writes providers.afrouter with an explicit `api` and real per-model specs
 *  - POST preserves unrelated providers and provider fields we do not own
 *  - POST merges models additively without duplicating ids
 *  - input/reasoning declared only when the catalog says so
 *  - POST setDefault pins defaultProvider/defaultModel and preserves other settings
 *  - ownership: a ledger record makes hand-added ids candidates that DELETE spares
 *  - DELETE removes the provider and clears our startup pin only
 *  - DELETE is idempotent when nothing is configured
 *
 * PI_CODING_AGENT_DIR and DATA_DIR are redirected to per-test temp dirs; the
 * `pi` PATH probe and global.fetch are stubbed so spec resolution is
 * deterministic and never touches the real machine.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ agentDir: null, dataDir: null, piOnPath: false }));

// `pi` is looked up on PATH for install detection; make that deterministic
// instead of depending on whether the host machine has Pi installed.
vi.mock("child_process", () => ({
  exec: (_cmd, _opts, callback) => {
    if (state.piOnPath) return callback(null, { stdout: "pi", stderr: "" });
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

// Only ids in this table resolve through the static registry.
const RESOLVABLE = new Map([
  ["cc/claude-sonnet-4-5", { contextWindow: 200000, maxOutput: 64000, reasoning: false, vision: true }],
  ["deepseek/deepseek-v4-pro", { contextWindow: 1000000, maxOutput: 256000, reasoning: true, vision: false }],
]);

vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => {
    const key = provider ? `${provider}/${model}` : model;
    return RESOLVABLE.get(key) || { contextWindow: Number.NaN, maxOutput: Number.NaN };
  },
}));

vi.mock("open-sse/services/model.js", () => ({
  resolveProviderAlias: (alias) => alias,
}));

// Reject every fetch so the live catalog is unavailable (deterministic).
global.fetch = () => Promise.reject(new Error("offline test"));

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/pi-settings/route.js");

const modelsPath = () => path.join(state.agentDir, "models.json");
const settingsPath = () => path.join(state.agentDir, "settings.json");

function writeModels(obj) {
  fs.mkdirSync(state.agentDir, { recursive: true });
  fs.writeFileSync(modelsPath(), JSON.stringify(obj, null, 2));
}

function readModels() {
  return JSON.parse(fs.readFileSync(modelsPath(), "utf-8"));
}

function writeSettings(obj) {
  fs.mkdirSync(state.agentDir, { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
}

function readSettings() {
  return JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
}

const provider = () => readModels().providers?.afrouter;

function post(body) {
  return POST({ json: async () => body, url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
}

function del(model) {
  return DELETE({ url: `http://127.0.0.1:20128/api/cli-tools/pi-settings${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-"));
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-data-"));
  state.piOnPath = false;
  // Pi resolves the agent dir from $PI_CODING_AGENT_DIR; DATA_DIR holds the
  // ownership ledger. Both must point at the per-test temp dirs.
  process.env.PI_CODING_AGENT_DIR = state.agentDir;
  process.env.DATA_DIR = state.dataDir;
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.DATA_DIR;
});

describe("GET", () => {
  it("reports not-installed without throwing when no agent dir and no pi binary", async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    state.agentDir = path.join(os.tmpdir(), `pi-missing-${Date.now()}`);
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.pi).toBeNull();
  });

  it("treats a pi binary on PATH as installed even with no config yet", async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    state.piOnPath = true;
    state.agentDir = path.join(os.tmpdir(), `pi-pathonly-${Date.now()}`);
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(false);
  });

  it("never 500s on corrupt models.json", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(modelsPath(), "{ not json\n");
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.status).toBe(200);
    expect(res.body.corrupt).toBe(true);
    expect(res.body.pi).toBeNull();
  });

  it("reports status without ever leaking the api key value", async () => {
    writeModels({
      providers: {
        afrouter: {
          baseUrl: "http://127.0.0.1:20128/v1",
          api: "openai-completions",
          apiKey: "sk_secret_value",
          models: [{ id: "a/b" }],
        },
      },
    });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.pi.models).toEqual(["a/b"]);
    expect(res.body.pi.hasApiKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk_secret_value");
  });

  it("surfaces Pi's startup pin so the card can reflect it", async () => {
    writeModels({ providers: { afrouter: { baseUrl: "x", api: "openai-completions", models: [] } } });
    writeSettings({ defaultProvider: "afrouter", defaultModel: "cc/claude-sonnet-4-5", theme: "dark" });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.pi.isDefault).toBe(true);
    expect(res.body.pi.defaultModel).toBe("cc/claude-sonnet-4-5");
  });

  it("does not claim Pi's default when it points at another provider", async () => {
    writeModels({ providers: { afrouter: { baseUrl: "x", api: "openai-completions", models: [] } } });
    writeSettings({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5" });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.pi.isDefault).toBe(false);
    expect(res.body.pi.defaultProvider).toBe("anthropic");
  });
});

describe("POST", () => {
  it("creates the afrouter provider with an explicit api and real model specs", async () => {
    const res = await post({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-4-5"],
    });
    expect(res.body.success).toBe(true);
    expect(res.body.written).toEqual(["cc/claude-sonnet-4-5"]);

    const entry = provider();
    expect(entry.api).toBe("openai-completions");
    expect(entry.baseUrl).toBe("http://127.0.0.1:20128/v1");
    expect(entry.apiKey).toBe("sk_afrouter");
    expect(entry.models).toEqual([
      { id: "cc/claude-sonnet-4-5", contextWindow: 200000, maxTokens: 64000, input: ["text", "image"] },
    ]);
  });

  it("does not normalise an already-/v1 baseUrl twice", async () => {
    await post({ baseUrl: "http://127.0.0.1:20128/v1", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(provider().baseUrl).toBe("http://127.0.0.1:20128/v1");
  });

  it("declares reasoning only for reasoning models", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });
    const [model] = provider().models;
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBe(1000000);
    expect(model.input).toEqual(["text"]);
  });

  it("preserves unrelated providers", async () => {
    writeModels({ providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [] } } });
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    expect(models.providers.anthropic.baseUrl).toBe("https://api.anthropic.com");
    expect(models.providers.afrouter).toBeTruthy();
  });

  it("preserves provider fields it does not own (user headers, overrides)", async () => {
    writeModels({
      providers: {
        afrouter: {
          baseUrl: "http://old",
          api: "openai-completions",
          headers: { "x-custom": "keep-me" },
          modelOverrides: { "some/other": { name: "kept" } },
          models: [{ id: "cc/claude-sonnet-4-5" }],
        },
      },
    });
    await post({ baseUrl: "http://new", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const entry = provider();
    expect(entry.headers["x-custom"]).toBe("keep-me");
    expect(entry.modelOverrides["some/other"].name).toBe("kept");
    expect(entry.baseUrl).toBe("http://new/v1");
  });

  it("merges models additively without duplicating ids", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"] });
    expect(provider().models.map((m) => m.id)).toEqual([
      "cc/claude-sonnet-4-5",
      "deepseek/deepseek-v4-pro",
    ]);
  });

  it("marks unresolvable models unverified without inventing specs", async () => {
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["unknown/model"] });
    expect(res.body.unverified).toEqual(["unknown/model"]);
    expect(provider().models[0].contextWindow).toBe(200000);
  });

  it("refuses to write corrupt models.json and leaves the file untouched", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(modelsPath(), "{ not json\n");
    const before = fs.readFileSync(modelsPath(), "utf-8");
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(modelsPath(), "utf-8")).toBe(before);
  });

  it("refuses to write corrupt settings.json when pinning the default", async () => {
    writeModels({});
    // Raw text, not writeSettings(): JSON.stringify of a string is valid JSON.
    fs.writeFileSync(settingsPath(), "{ not json\n");
    const before = fs.readFileSync(settingsPath(), "utf-8");
    const res = await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
    });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("treats a settings.json that parses but is not an object as corrupt", async () => {
    // Pi writes a settings object; a bare array means the file is malformed and
    // must never be silently replaced with {}.
    writeModels({});
    fs.writeFileSync(settingsPath(), JSON.stringify(["not", "a", "settings", "object"]));
    const before = fs.readFileSync(settingsPath(), "utf-8");
    const res = await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
    });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("treats a models.json that parses but is not an object as corrupt", async () => {
    fs.writeFileSync(modelsPath(), JSON.stringify(["not", "an", "object"]));
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.corrupt).toBe(true);
  });

  it("400s without baseUrl or models", async () => {
    expect((await post({ baseUrl: "", models: [] })).status).toBe(400);
    expect((await post({ baseUrl: "http://x", models: [] })).status).toBe(400);
  });

  it("writes a timestamped backup on apply", async () => {
    writeModels({});
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post({ baseUrl: "http://y", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });
    const backups = fs.readdirSync(state.agentDir).filter((f) => f.startsWith("models.json.bak-"));
    expect(backups.length).toBeGreaterThan(0);
  });

  it("creates the agent dir on first apply", async () => {
    fs.rmSync(state.agentDir, { recursive: true, force: true });
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(res.body.success).toBe(true);
    expect(fs.existsSync(modelsPath())).toBe(true);
  });
});

describe("POST startup pin", () => {
  it("pins defaultProvider and defaultModel in settings.json", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"],
      setDefault: true,
      defaultModel: "deepseek/deepseek-v4-pro",
    });
    const settings = readSettings();
    expect(settings.defaultProvider).toBe("afrouter");
    expect(settings.defaultModel).toBe("deepseek/deepseek-v4-pro");
  });

  it("falls back to the first model when none is chosen", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: true });
    expect(readSettings().defaultModel).toBe("cc/claude-sonnet-4-5");
  });

  it("preserves unrelated settings", async () => {
    writeSettings({ theme: "dark", packages: ["pi-skills"] });
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: true });
    const settings = readSettings();
    expect(settings.theme).toBe("dark");
    expect(settings.packages).toEqual(["pi-skills"]);
  });

  it("does not touch settings.json when the pin is not requested", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});

describe("ownership", () => {
  it("treats every model under afrouter as owned before any ledger record", async () => {
    // Config pasted from another machine: no ledger, but the block is ours.
    writeModels({
      providers: {
        afrouter: {
          baseUrl: "http://x",
          api: "openai-completions",
          models: [{ id: "cc/claude-sonnet-4-5" }, { id: "hand/typed-model" }],
        },
      },
    });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.pi.afrouterModels).toEqual(["cc/claude-sonnet-4-5", "hand/typed-model"]);
    expect(res.body.pi.bootstrapCandidates).toEqual([]);
  });

  it("spares a model added after the ledger was written, and reports it", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    // User types another model straight into models.json.
    const models = readModels();
    models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1, input: ["text"] });
    writeModels(models);

    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.pi.afrouterModels).toEqual(["cc/claude-sonnet-4-5"]);
    expect(res.body.pi.bootstrapCandidates).toEqual(["hand/typed-model"]);
  });

  it("does not delete a candidate on reset", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1, input: ["text"] });
    writeModels(models);

    const res = await del();
    expect(res.body.removed).toBe(1);
    expect(res.body.entryRemoved).toBe(false);
    expect(res.body.skippedCandidates).toEqual(["hand/typed-model"]);
    expect(provider().models.map((m) => m.id)).toEqual(["hand/typed-model"]);
  });

  it("does not let a plain re-Apply claim a candidate", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1, input: ["text"] });
    writeModels(models);

    // Re-sending the whole hydrated chip list must not silently adopt it.
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5", "hand/typed-model"] });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/pi-settings" });
    expect(res.body.pi.bootstrapCandidates).toEqual(["hand/typed-model"]);
  });

  it("adopts a candidate when explicitly asked, then manages it", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1, input: ["text"] });
    writeModels(models);

    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "hand/typed-model"],
      adoptBootstrap: true,
    });
    const res = await del("hand/typed-model");
    expect(res.body.removed).toBe(1);
    expect(provider().models.map((m) => m.id)).toEqual(["cc/claude-sonnet-4-5"]);
  });

  it("refuses to delete a single unowned model", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1, input: ["text"] });
    writeModels(models);

    const res = await del("hand/typed-model");
    expect(res.body.removed).toBe(0);
    expect(provider().models.map((m) => m.id)).toContain("hand/typed-model");
  });
});

describe("DELETE", () => {
  it("removes the provider and the providers map when it empties", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const res = await del();
    expect(res.body.entryRemoved).toBe(true);
    expect(readModels().providers).toBeUndefined();
  });

  it("keeps other providers when the afrouter entry is removed", async () => {
    writeModels({ providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [] } } });
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await del();
    const models = readModels();
    expect(models.providers.anthropic).toBeTruthy();
    expect(models.providers.afrouter).toBeUndefined();
  });

  it("removes one model and keeps the rest", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"],
    });
    const res = await del("cc/claude-sonnet-4-5");
    expect(res.body.removed).toBe(1);
    expect(provider().models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("removes the provider when the last model is removed", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const res = await del("cc/claude-sonnet-4-5");
    expect(res.body.entryRemoved).toBe(true);
    expect(readModels().providers).toBeUndefined();
  });

  it("clears the startup pin it owns", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
      defaultModel: "cc/claude-sonnet-4-5",
    });
    const res = await del();
    expect(res.body.defaultCleared).toBe(true);
    const settings = readSettings();
    expect(settings.defaultProvider).toBeUndefined();
    expect(settings.defaultModel).toBeUndefined();
  });

  it("never clears a startup pin the user repointed elsewhere", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: true });
    writeSettings({ defaultProvider: "anthropic", defaultModel: "claude-sonnet-5", theme: "light" });
    await del();
    const settings = readSettings();
    expect(settings.defaultProvider).toBe("anthropic");
    expect(settings.defaultModel).toBe("claude-sonnet-5");
    expect(settings.theme).toBe("light");
  });

  it("leaves a defaultModel alone when the provider was already repointed", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: true });
    // User kept our model but switched the provider to something else.
    writeSettings({ defaultProvider: "ollama", defaultModel: "llama3.1:8b" });
    await del();
    expect(readSettings().defaultProvider).toBe("ollama");
    expect(readSettings().defaultModel).toBe("llama3.1:8b");
  });

  it("is idempotent when nothing is configured", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.removed).toBe(0);
  });

  it("is idempotent on a corrupt config", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(modelsPath(), "{ not json\n");
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
