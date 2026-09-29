/**
 * Unit tests for /api/cli-tools/mimocode-settings (MiMo Code / Desktop integration).
 *
 * The regression this suite exists to pin down: the route used to write every
 * model as `{ name, modalities: { input: ["text","image"] } }`, which (a) lied
 * about vision support on text-only models, (b) omitted pdf/audio/video that
 * MiMoCode's `/modalities` TUI does support, and (c) left `limit`/`reasoning`/
 * `tool_call` unset so MiMoCode could not size context or gate thinking/tools.
 * Model specs must now be resolved from the capability tables and written in
 * MiMoCode's documented shape (limit/reasoning/tool_call/modalities).
 *
 * Also covers:
 *  - GET never 500s on missing/corrupt config (SC-004)
 *  - GET detects AFRouter provider + active model
 *  - POST writes provider.afrouter + preserves unrelated sections (FR-005)
 *  - POST preserves a custom display `name` while refreshing machine-readable specs
 *  - POST reports unverified ids
 *  - PATCH clearActiveModel
 *  - DELETE removes the provider; DELETE ?model= removes one model
 *
 * os.homedir / MIMOCODE_HOME are redirected to a per-test temp dir; global.fetch
 * is rejected so spec resolution takes the deterministic static-registry path.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: null }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => (state.home ? state.home : actual.homedir());
  return { ...actual, default: { ...actual, homedir } };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

// Reject the binary-install probe so detection always takes the config-path fallback.
vi.mock("child_process", async (importOriginal) => {
  const util = await import("node:util");
  const exec = (cmd, opts, cb) => {
    if (typeof opts === "function") { cb = opts; }
    cb(new Error("not found"), null, null);
  };
  return { exec, promisify: util.promisify };
});

// Only ids in this table resolve; everything else takes the fallback path.
// vision:false on the first is deliberate — the old route claimed image support.
vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => {
    const key = provider ? `${provider}/${model}` : model;
    if (key === "cl/z-ai/glm-5.3-flash") {
      return {
        contextWindow: 1000000,
        maxOutput: 131072,
        reasoning: true,
        vision: true,
        pdf: true,
        videoInput: true,
        tools: true,
      };
    }
    if (key === "cl/text-only-model") {
      return { contextWindow: 200000, maxOutput: 32000, reasoning: false, vision: false, tools: true };
    }
    return { contextWindow: Number.NaN, maxOutput: Number.NaN };
  },
}));

vi.mock("open-sse/services/model.js", () => ({
  resolveProviderAlias: (alias) => alias,
}));

const realFetch = global.fetch;
global.fetch = () => Promise.reject(new Error("offline test"));

const { GET, POST, PATCH, DELETE } = await import(
  "../../src/app/api/cli-tools/mimocode-settings/route.js"
);

const configPath = () => path.join(state.home, "mimocode.jsonc");

function writeConfig(obj) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

function readConfigRaw() {
  return fs.readFileSync(configPath(), "utf-8");
}

function readConfig() {
  return JSON.parse(readConfigRaw());
}

function post(body) {
  return POST({ url: "http://127.0.0.1:20128/api/cli-tools/mimocode-settings", json: async () => body });
}

function patch(body) {
  return PATCH({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-home-"));
  process.env.MIMOCODE_HOME = state.home;
  // Redirect Desktop-app detection away from the real %APPDATA%\Xiaomi MiMo AI.
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-appdata-"));
});

afterAll(() => {
  global.fetch = realFetch;
  delete process.env.MIMOCODE_HOME;
  delete process.env.APPDATA;
});

describe("GET", () => {
  it("reports not-installed without throwing when home and binary are absent", async () => {
    delete process.env.MIMOCODE_HOME;
    state.home = path.join(os.tmpdir(), `mimocode-missing-${Date.now()}`);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
  });

  it("reads an existing config and detects the afrouter provider", async () => {
    writeConfig({
      $schema: "https://mimo.xiaomi.com/mimocode/config.json",
      model: "afrouter/cc/claude-sonnet-5",
      provider: {
        afrouter: {
          name: "AFRouter",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:20128/v1", apiKey: "sk-test" },
          models: { "cc/claude-sonnet-5": { name: "Sonnet" } },
        },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.mimocode.activeModel).toBe("cc/claude-sonnet-5");
    expect(res.body.mimocode.models).toEqual(["cc/claude-sonnet-5"]);
    expect(res.body.mimocode.baseURL).toBe("http://localhost:20128/v1");
  });

  it("handles JSONC config with comments and trailing commas", async () => {
    const jsonc =
      `{\n` +
      `  // schema for the config\n` +
      `  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",\n` +
      `  "model": "afrouter/cc/claude-sonnet-5",\n` +
      `  "provider": {\n` +
      `    "afrouter": {\n` +
      `      "name": "AFRouter",\n` +
      `      "options": { "baseURL": "http://localhost:20128/v1", /* keep */ "apiKey": "sk-test", },\n` +
      `      "models": { "cc/claude-sonnet-5": { "name": "Sonnet" }, },\n` +
      `    },\n` +
      `  },\n` +
      `}`;
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), jsonc);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.mimocode.activeModel).toBe("cc/claude-sonnet-5");
  });

  it("reports not_configured when no afrouter provider exists", async () => {
    writeConfig({ model: "some/other", provider: {} });
    const res = await GET();
    expect(res.body.hasAFRouter).toBe(false);
    expect(res.body.mimocode.models).toEqual([]);
  });
});

describe("POST", () => {
  it("writes the afrouter provider and active model", async () => {
    const res = await post({
      baseUrl: "http://localhost:20128",
      apiKey: "sk-abc",
      models: ["cl/text-only-model", "cl/z-ai/glm-5.3-flash"],
      activeModel: "cl/z-ai/glm-5.3-flash",
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const config = readConfig();
    expect(config.provider.afrouter.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider.afrouter.only_configured_models).toBe(true);
    expect(config.provider.afrouter.options.baseURL).toBe("http://localhost:20128/v1");
    expect(config.model).toBe("afrouter/cl/z-ai/glm-5.3-flash");
    expect(Object.keys(config.provider.afrouter.models)).toEqual(["cl/text-only-model", "cl/z-ai/glm-5.3-flash"]);
  });

  it("writes full model specs (limit/reasoning/tool_call/modalities)", async () => {
    const res = await post({
      baseUrl: "http://localhost:20128",
      models: ["cl/z-ai/glm-5.3-flash"],
      activeModel: "cl/z-ai/glm-5.3-flash",
    });
    expect(res.status).toBe(200);
    expect(res.body.unverified).toEqual([]);

    const entry = readConfig().provider.afrouter.models["cl/z-ai/glm-5.3-flash"];
    expect(entry.limit).toEqual({ context: 1000000, output: 131072 });
    expect(entry.reasoning).toBe(true);
    expect(entry.tool_call).toBe(true);
    expect(entry.modalities.input).toEqual(["text", "image", "pdf", "video"]);
    expect(entry.modalities.output).toEqual(["text"]);
  });

  it("does not claim image support on text-only models", async () => {
    await post({
      baseUrl: "http://localhost:20128",
      models: ["cl/text-only-model"],
      activeModel: "cl/text-only-model",
    });

    const entry = readConfig().provider.afrouter.models["cl/text-only-model"];
    expect(entry.modalities.input).toEqual(["text"]);
    expect(entry.reasoning).toBe(false);
    expect(entry.tool_call).toBe(true);
    expect(entry.limit).toEqual({ context: 200000, output: 32000 });
  });

  it("reports unverified ids and writes conservative specs", async () => {
    const res = await post({
      baseUrl: "http://localhost:20128",
      models: ["unknown/never-heard-of-it"],
      activeModel: "unknown/never-heard-of-it",
    });
    expect(res.status).toBe(200);
    expect(res.body.unverified).toEqual(["unknown/never-heard-of-it"]);

    const entry = readConfig().provider.afrouter.models["unknown/never-heard-of-it"];
    expect(entry.limit.context).toBeGreaterThan(0);
    expect(entry.modalities.input).toEqual(["text"]);
  });

  it("preserves unrelated provider sections and a custom display name (FR-005)", async () => {
    writeConfig({
      model: "9router/cc/claude-sonnet-5",
      provider: {
        userprovider: { npm: "@ai-sdk/x", options: { baseURL: "https://x/y" }, models: { "m/1": { name: "Keep" } } },
        afrouter: {
          npm: "@ai-sdk/openai-compatible",
          options: {},
          models: { "cl/text-only-model": { name: "keep-me", limit: { context: 1, output: 1 } } },
        },
      },
    });
    await post({
      baseUrl: "http://localhost:20128",
      models: ["cl/text-only-model", "cl/z-ai/glm-5.3-flash"],
      activeModel: "cl/z-ai/glm-5.3-flash",
    });

    const config = readConfig();
    expect(config.provider.userprovider).toBeDefined();
    expect(config.provider.userprovider.models["m/1"].name).toBe("Keep");
    expect(config.provider.afrouter.models["cl/text-only-model"].name).toBe("keep-me");
    // Machine-readable specs are refreshed even when the display name is kept.
    expect(config.provider.afrouter.models["cl/text-only-model"].limit).toEqual({ context: 200000, output: 32000 });
    expect(Object.keys(config.provider.afrouter.models).sort()).toEqual(["cl/text-only-model", "cl/z-ai/glm-5.3-flash"]);
  });

  it("rejects when baseUrl or models are missing", async () => {
    const res = await post({ apiKey: "sk" });
    expect(res.status).toBe(400);
  });

  it("accepts a JSONC existing file and writes clean JSON", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), `{\n  // comment\n  "model": "x/y",\n}`);
    const res = await post({ baseUrl: "http://localhost:20128", models: ["cl/text-only-model"], activeModel: "cl/text-only-model" });
    expect(res.status).toBe(200);
    const parsed = readConfig();
    expect(parsed.provider.afrouter.options.baseURL).toBe("http://localhost:20128/v1");
  });
});

describe("PATCH", () => {
  it("clears the active model without removing the provider", async () => {
    writeConfig({ model: "afrouter/cc/claude-sonnet-5", provider: { afrouter: { models: { "cc/claude-sonnet-5": {} } } } });
    const res = await patch({ clearActiveModel: true });
    expect(res.status).toBe(200);
    expect(readConfig().model).toBe("");
  });

  it("is a no-op when no config exists", async () => {
    const res = await patch({ clearActiveModel: true });
    expect(res.status).toBe(200);
  });
});

describe("DELETE", () => {
  it("removes the whole afrouter provider", async () => {
    writeConfig({ model: "afrouter/cc/claude-sonnet-5", provider: { afrouter: { models: { "cc/claude-sonnet-5": {} } } } });
    const res = await del();
    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.provider.afrouter).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it("removes a single model and stays put when others remain", async () => {
    writeConfig({
      model: "afrouter/gemini/gemini-3-pro",
      provider: { afrouter: { models: { "cc/claude-sonnet-5": {}, "gemini/gemini-3-pro": {} } } },
    });
    const res = await del("cc/claude-sonnet-5");
    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.provider.afrouter.models["cc/claude-sonnet-5"]).toBeUndefined();
    expect(config.provider.afrouter.models["gemini/gemini-3-pro"]).toBeDefined();
    expect(config.model).toBe("afrouter/gemini/gemini-3-pro");
  });

  it("switches the active model when removing the current one", async () => {
    writeConfig({
      model: "afrouter/cc/claude-sonnet-5",
      provider: { afrouter: { models: { "cc/claude-sonnet-5": {}, "gemini/gemini-3-pro": {} } } },
    });
    const res = await del("cc/claude-sonnet-5");
    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.model).toBe("afrouter/gemini/gemini-3-pro");
  });
});
