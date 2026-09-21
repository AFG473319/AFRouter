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
 * Two further regressions are pinned here:
 * - The subagent model is optional. An explicit empty value must remove
 *   AFRouter's `explorer` override so OpenCode resolves the subagent model
 *   itself, while an omitted value leaves an existing override untouched.
 * - OpenCode 2 reads V1 files but uses a different native shape (providers /
 *   agents / package / settings / capabilities). Apply must write whichever
 *   shape applies and never leave both shapes on one provider.
 *
 * os.homedir is redirected to a per-test temp dir; global.fetch is rejected so
 * spec resolution takes the deterministic static-registry path; `opencode
 * --version` fails, so format detection falls back to config shape/default.
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

function providerOf(config, mapKey = "provider") {
  return config[mapKey]?.["afrouter"];
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

describe("POST /api/cli-tools/opencode-settings — OpenCode 2 config shape", () => {
  it("writes the native V2 shape when the config already uses providers/agents", async () => {
    writeFixture({ $schema: "https://opencode.ai/config.json", providers: {} });
    const res = await post({
      baseUrl: "http://localhost:20128",
      apiKey: "sk_x",
      models: ["cl/z-ai/glm-5.3-flash"],
      activeModel: "cl/z-ai/glm-5.3-flash",
    });
    expect(res.status).toBe(200);
    expect(res.body.format).toBe("v2");
    expect(res.body.formatSource).toBe("config");

    const cfg = readConfigFile();
    const provider = providerOf(cfg, "providers");
    expect(provider.package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(provider.settings).toEqual({ baseURL: "http://localhost:20128/v1", apiKey: "sk_x" });
    // The V1 spelling must not survive next to the V2 one.
    expect(cfg.provider).toBeUndefined();
    expect(provider.npm).toBeUndefined();
    expect(provider.options).toBeUndefined();

    const entry = provider.models["cl/z-ai/glm-5.3-flash"];
    expect(entry.limit).toEqual({ context: 200000, output: 128000 });
    expect(entry.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] });
    // V2 retired these V1 model fields — writing them only earns a warning.
    expect(entry.modalities).toBeUndefined();
    expect(entry.tool_call).toBeUndefined();
    expect(entry.attachment).toBeUndefined();
    expect(entry.reasoning).toBeUndefined();

    expect(cfg.model).toBe("afrouter/cl/z-ai/glm-5.3-flash");
  });

  it("advertises V2 vision/pdf as capabilities.input", async () => {
    writeFixture({ providers: {} });
    await post({ baseUrl: "http://localhost:20128/v1", models: ["cl/vision-model"] });
    const entry = providerOf(readConfigFile(), "providers").models["cl/vision-model"];
    expect(entry.capabilities).toEqual({ tools: true, input: ["text", "image", "pdf"], output: ["text"] });
  });

  it("migrates a V1 config to V2 while keeping other providers and the subagent", async () => {
    writeFixture({
      provider: {
        afrouter: {
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://old:20128/v1", apiKey: "sk_old" },
          models: { "cl/z-ai/glm-5.3-flash": { name: "Keep me" } },
        },
        anthropic: { options: { apiKey: "a" } },
      },
      agent: { explorer: { model: "afrouter/cl/z-ai/glm-5.3-flash", mode: "subagent" } },
    });
    const res = await post({
      baseUrl: "http://localhost:20128",
      apiKey: "sk_x",
      models: ["cl/z-ai/glm-5.3-flash"],
      subagentModel: "cl/vision-model",
      format: "v2",
    });
    expect(res.body.format).toBe("v2");
    expect(res.body.formatSource).toBe("manual");

    const cfg = readConfigFile();
    expect(cfg.provider).toEqual({ anthropic: { options: { apiKey: "a" } } });
    expect(providerOf(cfg, "providers").package).toBe("aisdk:@ai-sdk/openai-compatible");
    expect(providerOf(cfg, "providers").settings.baseURL).toBe("http://localhost:20128/v1");
    expect(providerOf(cfg, "providers").models["cl/z-ai/glm-5.3-flash"].name).toBe("Keep me");
    expect(cfg.agent).toBeUndefined();
    expect(cfg.agents.explorer.model).toBe("afrouter/cl/vision-model");
    expect(cfg.agents.explorer.mode).toBe("subagent");
  });

  it("converts a V2 config back to V1 without losing untouched models", async () => {
    writeFixture({
      providers: {
        afrouter: {
          package: "aisdk:@ai-sdk/openai-compatible",
          settings: { baseURL: "http://old:20128/v1", apiKey: "sk_old" },
          models: {
            "cl/vision-model": {
              name: "v",
              limit: { context: 1, output: 1 },
              capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            },
            "legacy/kept": {
              name: "Kept",
              limit: { context: 5, output: 5 },
              capabilities: { tools: false, input: ["text"], output: ["text"] },
            },
          },
        },
      },
      agents: { explorer: { model: "afrouter/cl/vision-model", mode: "subagent" } },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/vision-model"], format: "v1" });

    const cfg = readConfigFile();
    expect(cfg.providers).toBeUndefined();
    expect(providerOf(cfg).npm).toBe("@ai-sdk/openai-compatible");
    expect(providerOf(cfg).options.baseURL).toBe("http://localhost:20128/v1");
    expect(cfg.agents).toBeUndefined();
    expect(cfg.agent.explorer.model).toBe("afrouter/cl/vision-model");

    // A model the user did not re-select keeps its values, converted losslessly.
    const kept = providerOf(cfg).models["legacy/kept"];
    expect(kept.limit).toEqual({ context: 5, output: 5 });
    expect(kept.capabilities).toBeUndefined();
    expect(kept.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(kept.tool_call).toBe(false);

    const refreshed = providerOf(cfg).models["cl/vision-model"];
    expect(refreshed.tool_call).toBe(true);
    expect(refreshed.attachment).toBe(true);
    expect(refreshed.modalities.input).toEqual(["text", "image", "pdf"]);
  });

  it("GET reports the detected format so the card can default its selector", async () => {
    writeFixture({ providers: {} });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.opencode.format).toBe("v2");
    expect(res.body.opencode.formatSource).toBe("config");
  });
});

describe("POST /api/cli-tools/opencode-settings — subagent override", () => {
  it("writes no agent entry at all when the subagent model is left blank", async () => {
    writeFixture({ provider: {} });
    const res = await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(cfg.agent).toBeUndefined();
    expect(cfg.agents).toBeUndefined();
  });

  it("removes a stale AFRouter subagent when the field is cleared", async () => {
    writeFixture({
      provider: {},
      agent: {
        explorer: {
          description: "Fast explorer subagent for codebase exploration",
          mode: "subagent",
          model: "afrouter/cl/z-ai/glm-5.3-flash",
        },
      },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"], subagentModel: "   " });
    expect(readConfigFile().agent).toBeUndefined();
  });

  it("leaves an existing override alone when the field is omitted entirely", async () => {
    writeFixture({
      provider: {},
      agent: { explorer: { model: "afrouter/cl/vision-model", mode: "subagent" } },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(readConfigFile().agent.explorer.model).toBe("afrouter/cl/vision-model");
  });

  it("never touches a user-owned explorer agent", async () => {
    const mine = { prompt: "mine", model: "anthropic/claude-sonnet-4-5" };
    writeFixture({ provider: {}, agent: { explorer: { ...mine } } });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(readConfigFile().agent.explorer).toEqual(mine);
  });

  it("keeps other agents when clearing ours", async () => {
    writeFixture({
      provider: {},
      agent: {
        explorer: { model: "afrouter/cl/z-ai/glm-5.3-flash", mode: "subagent" },
        reviewer: { model: "anthropic/claude-sonnet-4-5", mode: "subagent" },
      },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cl/z-ai/glm-5.3-flash"], subagentModel: "" });
    const cfg = readConfigFile();
    expect(cfg.agent.explorer).toBeUndefined();
    expect(cfg.agent.reviewer.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("DELETE clears the V2 subagent as well as the V2 provider", async () => {
    writeFixture({
      providers: { afrouter: { models: { a: {} } } },
      agents: { explorer: { model: "afrouter/a", mode: "subagent" } },
    });
    const res = await del();
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    expect(cfg.providers).toBeUndefined();
    expect(cfg.agents).toBeUndefined();
  });
});

describe("format resolution", () => {
  it("prefers an explicit choice, then the config shape, then the CLI version", async () => {
    const { resolveFormat } = await import("../../src/lib/opencodeConfig.js");
    expect(resolveFormat({ requested: "v2", config: { provider: {} }, version: "1.4.0" })).toEqual({ format: "v2", source: "manual" });
    expect(resolveFormat({ config: { providers: {} }, version: "1.4.0" })).toEqual({ format: "v2", source: "config" });
    expect(resolveFormat({ config: {}, version: "2.1.0" })).toEqual({ format: "v2", source: "version" });
    expect(resolveFormat({ config: {}, version: "1.4.0" })).toEqual({ format: "v1", source: "version" });
    expect(resolveFormat({ config: {}, version: null })).toEqual({ format: "v1", source: "default" });
    // Both shapes present is ambiguous, so the version probe decides.
    expect(resolveFormat({ config: { provider: {}, providers: {} }, version: "2.1.0" })).toEqual({
      format: "v2",
      source: "version",
    });
  });

  it("parses the major version out of `opencode --version` output", async () => {
    const { parseVersionMajor } = await import("../../src/lib/opencodeConfig.js");
    expect(parseVersionMajor("2.1.0")).toBe(2);
    expect(parseVersionMajor("opencode 0.4.7")).toBe(0);
    expect(parseVersionMajor("1.0.0-beta.3")).toBe(1);
    expect(parseVersionMajor("")).toBeNull();
    expect(parseVersionMajor(null)).toBeNull();
  });
});
