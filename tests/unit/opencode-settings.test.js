/**
 * Unit tests for /api/cli-tools/opencode-settings (OpenCode integration).
 *
 * The regression this suite exists to pin down: the route used to write every
 * model as `{ name, modalities: { input: ["text","image"] } }`, which (a) lied
 * about vision support on text-only models and (b) left context/output at
 * OpenCode's 0 default, breaking compaction. Model specs must now be resolved
 * from the capability tables and written in OpenCode's ConfigProviderV1.Model
 * shape (limit/reasoning/tool_call/attachment/modalities).
 *
 * os.homedir is redirected to a per-test temp dir; global.fetch is rejected so
 * spec resolution takes the deterministic static-registry path.
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

// `where opencode` must fail so install detection falls back to config-file
// existence (the tests create the config, so GET reports installed:true).
vi.mock("child_process", () => ({
  exec: (cmd, opts, cb) => {
    const done = typeof opts === "function" ? opts : cb;
    done(new Error("not found"));
  },
}));

// Only ids in this table resolve; everything else takes the fallback path.
// vision:false is deliberate — the old route claimed image support for these.
vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => {
    const key = provider ? `${provider}/${model}` : model;
    if (key === "cl/z-ai/glm-5.3-flash") {
      return { contextWindow: 200000, maxOutput: 128000, reasoning: true, vision: false, tools: true };
    }
    if (key === "cl/vision-model") {
      return { contextWindow: 1000000, maxOutput: 65536, reasoning: true, vision: true, pdf: true, tools: true };
    }
    return { contextWindow: Number.NaN, maxOutput: Number.NaN };
  },
}));

const realFetch = global.fetch;
global.fetch = () => Promise.reject(new Error("offline test"));

const { GET, POST, PATCH, DELETE } = await import("../../src/app/api/cli-tools/opencode-settings/route.js");

const configPath = () => path.join(state.home, ".config", "opencode", "opencode.json");

function writeFixture(obj) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

function writeFixtureRaw(text) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), text);
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

function providerOf(config) {
  return config.provider?.["afrouter"];
}

function post(body) {
  return POST({ url: "http://localhost:20128/api/cli-tools/opencode-settings", json: async () => body });
}

function patch(body) {
  return PATCH({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api/cli-tools/opencode-settings${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-settings-test-"));
});

afterAll(() => {
  global.fetch = realFetch;
  state.home = null;
});

describe("GET /api/cli-tools/opencode-settings", () => {
  it("returns installed:false (never 500) when no config and no CLI", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.config).toBeNull();
  });

  it("returns config:null (never 500) when the config file is invalid JSON", async () => {
    writeFixtureRaw("{not json");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.config).toBeNull();
    expect(res.body.hasAFRouter).toBe(false);
  });
});

describe("POST /api/cli-tools/opencode-settings", () => {
  it("rejects missing baseUrl or models with 400", async () => {
    const res = await post({ baseUrl: "", models: [] });
    expect(res.status).toBe(400);
  });

  it("writes full model specs (limit/reasoning/tool_call/attachment/modalities)", async () => {
    writeFixture({ $schema: "https://opencode.ai/config.json", provider: {} });
    const res = await post({
      baseUrl: "http://localhost:20128",
      apiKey: "sk_x",
      models: ["cl/z-ai/glm-5.3-flash"],
      activeModel: "cl/z-ai/glm-5.3-flash",
    });
    expect(res.status).toBe(200);
    expect(res.body.unverified).toEqual([]);

    const entry = providerOf(readConfigFile()).models["cl/z-ai/glm-5.3-flash"];
    expect(entry.limit).toEqual({ context: 200000, output: 128000 });
    expect(entry.reasoning).toBe(true);
    expect(entry.tool_call).toBe(true);
    // Regression: text-only model must NOT claim image support.
    expect(entry.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(entry.attachment).toBe(false);
  });

  it("advertises vision/pdf modalities and attachment for multimodal models", async () => {
    writeFixture({ provider: {} });
    await post({ baseUrl: "http://localhost:20128/v1", models: ["cl/vision-model"] });
    const entry = providerOf(readConfigFile()).models["cl/vision-model"];
    expect(entry.modalities.input).toEqual(["text", "image", "pdf"]);
    expect(entry.attachment).toBe(true);
  });

  it("writes unknown models with conservative fallback specs and flags them unverified", async () => {
    writeFixture({ provider: {} });
    const res = await post({ baseUrl: "http://localhost:20128/v1", models: ["unknown/model-x"] });
    expect(res.body.unverified).toEqual(["unknown/model-x"]);
    const entry = providerOf(readConfigFile()).models["unknown/model-x"];
    expect(entry.limit).toEqual({ context: 200000, output: 64000 });
    expect(entry.modalities).toEqual({ input: ["text"], output: ["text"] });
  });

  it("preserves other providers and the rest of the config", async () => {
    writeFixture({
      $schema: "https://opencode.ai/config.json",
      provider: { anthropic: { options: { apiKey: "a" } } },
      permission: { edit: "ask" },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    const cfg = readConfigFile();
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(cfg.provider.anthropic).toEqual({ options: { apiKey: "a" } });
    expect(cfg.permission).toEqual({ edit: "ask" });
  });

  it("preserves a hand-set display name while refreshing spec fields", async () => {
    writeFixture({
      provider: {
        afrouter: {
          models: {
            "cl/z-ai/glm-5.3-flash": { name: "GLM 5.3 Flash", limit: { context: 1, output: 1 } },
          },
        },
      },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    const entry = providerOf(readConfigFile()).models["cl/z-ai/glm-5.3-flash"];
    expect(entry.name).toBe("GLM 5.3 Flash");
    expect(entry.limit).toEqual({ context: 200000, output: 128000 });
  });

  it("refuses to overwrite a corrupt config (409) instead of wiping it", async () => {
    writeFixtureRaw("{not json");
    const res = await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{not json");
  });

  it("reads a JSONC config with trailing commas without wiping it", async () => {
    writeFixtureRaw('{\n  "$schema": "https://opencode.ai/config.json",\n  "provider": {},\n}\n');
    const res = await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(cfg.$schema).toBe("https://opencode.ai/config.json");
    expect(providerOf(cfg).models["cl/z-ai/glm-5.3-flash"]).toBeTruthy();
  });
});

describe("PATCH/DELETE /api/cli-tools/opencode-settings", () => {
  it("PATCH clears the active model without touching the model list", async () => {
    writeFixture({
      model: "afrouter/cl/z-ai/glm-5.3-flash",
      provider: { afrouter: { models: { "cl/z-ai/glm-5.3-flash": { name: "x" } } } },
    });
    const res = await patch({ clearActiveModel: true });
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(cfg.model).toBe("");
    expect(providerOf(cfg).models["cl/z-ai/glm-5.3-flash"]).toBeTruthy();
  });

  it("DELETE removes one model and switches the active model to a remaining one", async () => {
    writeFixture({
      model: "afrouter/b",
      provider: { afrouter: { models: { a: {}, b: {} } } },
    });
    const res = await del("b");
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(Object.keys(providerOf(cfg).models)).toEqual(["a"]);
    expect(cfg.model).toBe("afrouter/a");
  });

  it("DELETE removes the whole afrouter provider and subagent config", async () => {
    writeFixture({
      model: "afrouter/a",
      provider: { afrouter: { models: { a: {} } }, anthropic: {} },
      agent: { explorer: { model: "afrouter/a", mode: "subagent" } },
    });
    const res = await del();
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(providerOf(cfg)).toBeUndefined();
    expect(cfg.model).toBeUndefined();
    expect(cfg.agent).toBeUndefined();
    expect(cfg.provider.anthropic).toEqual({});
  });
});
