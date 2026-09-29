/**
 * Unit tests for /api/cli-tools/omp-settings (Oh My Pi integration).
 *
 * Covers the destructive config-write paths against a temp agent dir:
 *  - GET never 500s on missing/corrupt models.yml
 *  - GET never leaks the api key value
 *  - POST writes providers.afrouter with an explicit `api` and real per-model specs
 *  - POST preserves unrelated providers and provider fields we do not own
 *  - POST merges models additively without duplicating ids
 *  - input/reasoning declared only when the catalog says so
 *  - input NEVER contains video/pdf/audio (OMP's schema is a closed union of
 *    "text"|"image"; a foreign modality fails validation for the WHOLE
 *    models.yml and OMP then drops every custom model)
 *  - slash-bearing model ids survive verbatim, which is what makes the
 *    `afrouter/kilo/stealth/space-bunny-alpha` selector resolve
 *  - config.yml modelRoles.default pins the startup model, with a `:level`
 *    suffix, and other roles/settings are preserved
 *  - a `default` role pointing at another provider is never claimed or clobbered
 *  - ownership: a ledger record makes hand-added ids candidates that DELETE spares
 *  - DELETE removes the provider and clears our startup pin only
 *  - DELETE of one model repoints the pin only when the pinned model went away
 *  - DELETE is idempotent when nothing is configured
 *
 * PI_CODING_AGENT_DIR and DATA_DIR are redirected to per-test temp dirs;
 * os.homedir is mocked so the ~/.omp/agent fallback never reads this machine's
 * real OMP config; the `omp` PATH probe and global.fetch are stubbed so spec
 * resolution is deterministic and never touches the real machine.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYAML } from "confbox/yaml";

const state = vi.hoisted(() => ({ agentDir: null, dataDir: null, home: null, ompOnPath: false }));

// Redirect os.homedir so the route's ~/.omp/agent fallback never probes this
// machine's real OMP install (the tests must pass on a box that has omp).
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => (state.home ? state.home : actual.homedir());
  return { ...actual, default: { ...actual, homedir } };
});

// `omp` is looked up on PATH for install detection; make that deterministic
// instead of depending on whether the host machine has Oh My Pi installed.
vi.mock("child_process", () => ({
  exec: (_cmd, _opts, callback) => {
    if (state.ompOnPath) return callback(null, { stdout: "omp", stderr: "" });
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
  ["kilo/stealth/space-bunny-alpha", { contextWindow: 262144, maxOutput: 65536, reasoning: true, vision: false }],
  // Claims every modality models.dev tracks — OMP may only ever receive text/image.
  [
    "gemini/gemini-3-pro",
    {
      name: "Gemini 3 Pro",
      contextWindow: 1048576,
      maxOutput: 65536,
      reasoning: true,
      vision: true,
      pdf: true,
      audioInput: true,
      videoInput: true,
    },
  ],
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

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/omp-settings/route.js");

const modelsPath = () => path.join(state.agentDir, "models.yml");
const configPath = () => path.join(state.agentDir, "config.yml");

function writeModels(obj) {
  fs.mkdirSync(state.agentDir, { recursive: true });
  fs.writeFileSync(modelsPath(), YAML.stringify(obj));
}
function readModels() {
  return parseYAML(fs.readFileSync(modelsPath(), "utf-8"));
}
function writeConfig(obj) {
  fs.mkdirSync(state.agentDir, { recursive: true });
  fs.writeFileSync(configPath(), YAML.stringify(obj));
}
function readConfig() {
  return parseYAML(fs.readFileSync(configPath(), "utf-8"));
}

const provider = () => readModels().providers?.afrouter;

function post(body) {
  return POST({ json: async () => body, url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
}

function del(model) {
  return DELETE({
    url: `http://127.0.0.1:20128/api/cli-tools/omp-settings${model ? `?model=${encodeURIComponent(model)}` : ""}`,
  });
}

const YAML = { stringify: (v) => `${JSON.stringify(v, null, 2)}\n` };

beforeEach(() => {
  state.agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-agent-"));
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-data-"));
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-home-"));
  state.ompOnPath = false;
  // Oh My Pi resolves the agent dir from $PI_CODING_AGENT_DIR; DATA_DIR holds
  // the ownership ledger. Both must point at the per-test temp dirs.
  process.env.PI_CODING_AGENT_DIR = state.agentDir;
  process.env.DATA_DIR = state.dataDir;
});

afterAll(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.DATA_DIR;
});

describe("GET", () => {
  it("reports not-installed without throwing when no agent dir and no omp binary", async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.omp).toBeNull();
  });

  it("treats an omp binary on PATH as installed even with no config yet", async () => {
    delete process.env.PI_CODING_AGENT_DIR;
    state.ompOnPath = true;
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(false);
  });

  it("never 500s on unparseable models.yml", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(modelsPath(), "providers:\n  afrouter:\n   - broken: [unclosed\n");
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.status).toBe(200);
    expect(res.body.corrupt).toBe(true);
    expect(res.body.omp).toBeNull();
  });

  // OMP itself rejects a non-mapping settings root (moves the file to
  // `.broken-*` and exits), so treating one as `{}` and overwriting it would
  // destroy a file OMP considers load-bearing.
  it("treats a config.yml that parses but is not a mapping as corrupt", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(configPath(), "- just\n- a\n- list\n");
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.body.settingsCorrupt).toBe(true);
  });

  it("treats a models.yml that parses but is not a mapping as corrupt", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(modelsPath(), "- not\n- a\n- mapping\n");
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.body.corrupt).toBe(true);
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
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.omp.models).toEqual(["a/b"]);
    expect(res.body.omp.hasApiKey).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk_secret_value");
  });

  it("surfaces the pinned modelRoles.default so the card can reflect it", async () => {
    writeModels({ providers: { afrouter: { baseUrl: "x", api: "openai-completions", models: [] } } });
    writeConfig({
      modelRoles: { default: "afrouter/cc/claude-sonnet-4-5:high" },
      theme: { dark: "titanium" },
    });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.body.omp.isDefault).toBe(true);
    expect(res.body.omp.defaultModel).toBe("cc/claude-sonnet-4-5");
    expect(res.body.omp.thinkingLevel).toBe("high");
  });

  it("does not claim the default role when it points at another provider", async () => {
    writeModels({ providers: { afrouter: { baseUrl: "x", api: "openai-completions", models: [] } } });
    writeConfig({ modelRoles: { default: "kilo/other-model" } });
    const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
    expect(res.body.omp.isDefault).toBe(false);
    expect(res.body.omp.defaultSelector).toBe("kilo/other-model");
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

  it("never writes authHeader, which OMP does not need for openai-completions", async () => {
    // OMP's resolveOpenAIRequestSetup sets `Authorization ??= Bearer <apiKey>` on
    // every openai-completions request. authHeader only re-derives the header
    // for discovered models cached without headers, which never applies to the
    // models we declare — so writing it would be cargo cult from the proxy docs.
    await post({ baseUrl: "http://x", apiKey: "sk_afrouter", models: ["cc/claude-sonnet-4-5"] });
    expect(provider().authHeader).toBeUndefined();
    expect(provider().transport).toBeUndefined();
  });

  it("keeps slash-bearing model ids verbatim so the provider/modelId selector resolves", async () => {
    // OMP splits a selector on the FIRST "/" (parseModelString uses indexOf), so
    // `afrouter/kilo/stealth/space-bunny-alpha` must survive the round trip
    // byte-for-byte or the model is unreachable.
    await post({ baseUrl: "http://x", apiKey: "k", models: ["kilo/stealth/space-bunny-alpha"] });
    const [model] = provider().models;
    expect(model.id).toBe("kilo/stealth/space-bunny-alpha");
    expect(model.reasoning).toBe(true);
    expect(model.contextWindow).toBe(262144);

    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["kilo/stealth/space-bunny-alpha"],
      setDefault: true,
    });
    expect(readConfig().modelRoles.default).toBe("afrouter/kilo/stealth/space-bunny-alpha");
  });

  it("declares reasoning only for reasoning models", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["kilo/stealth/space-bunny-alpha"] });
    const [reasoning] = provider().models;
    expect(reasoning.reasoning).toBe(true);
    expect(reasoning.input).toEqual(["text"]);
  });

  it("omits reasoning entirely for a model the catalog does not mark as reasoning", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(provider().models[0].reasoning).toBeUndefined();
  });

  // Regression shape: a foreign modality makes OMP's schema validation fail for
  // the ENTIRE models.yml, so it drops every custom model — not just the bad one.
  it("never writes video/pdf/audio modalities even when the catalog claims them", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["gemini/gemini-3-pro"] });
    const [model] = provider().models;
    expect(model.input).toEqual(["text", "image"]);
    expect(JSON.stringify(model)).not.toMatch(/video|audio|pdf/);
  });

  it("writes the catalog display name for the /model picker", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["gemini/gemini-3-pro"] });
    expect(provider().models[0].name).toBe("Gemini 3 Pro");
  });

  it("sanitizes invalid modalities on preserved entries", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    models.providers.afrouter.models.push({
      id: "hand/typed-model",
      contextWindow: 1,
      maxTokens: 1,
      input: ["text", "image", "video", "pdf"],
    });
    writeModels(models);

    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const handAdded = provider().models.find((m) => m.id === "hand/typed-model");
    expect(handAdded.input).toEqual(["text", "image"]);
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
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5", "kilo/stealth/space-bunny-alpha"] });
    expect(provider().models.map((m) => m.id)).toEqual([
      "cc/claude-sonnet-4-5",
      "kilo/stealth/space-bunny-alpha",
    ]);
  });

  it("marks unresolvable models unverified without inventing specs", async () => {
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["unknown/model"] });
    expect(res.body.unverified).toEqual(["unknown/model"]);
    expect(provider().models[0].contextWindow).toBe(128000);
    expect(provider().models[0].maxTokens).toBe(16384);
  });

  it("refuses to write an unparseable models.yml and leaves the file untouched", async () => {
    fs.mkdirSync(state.agentDir, { recursive: true });
    fs.writeFileSync(modelsPath(), "providers:\n  afrouter:\n   - broken: [unclosed\n");
    const before = fs.readFileSync(modelsPath(), "utf-8");
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(modelsPath(), "utf-8")).toBe(before);
  });

  it("refuses to pin the default when config.yml is unparseable", async () => {
    writeModels({});
    fs.writeFileSync(configPath(), "modelRoles: [unclosed\n");
    const before = fs.readFileSync(configPath(), "utf-8");
    const res = await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
    });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe(before);
  });

  it("requires baseUrl and at least one model", async () => {
    expect((await post({ baseUrl: "http://x", models: [] })).status).toBe(400);
    expect((await post({ models: ["cc/claude-sonnet-4-5"] })).status).toBe(400);
  });

  describe("modelRoles.default", () => {
    it("pins the requested model with a thinking suffix", async () => {
      const res = await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5", "kilo/stealth/space-bunny-alpha"],
        setDefault: true,
        defaultModel: "kilo/stealth/space-bunny-alpha",
        thinkingLevel: "high",
      });
      expect(res.body.defaultModel.model).toBe("kilo/stealth/space-bunny-alpha");
      expect(readConfig().modelRoles.default).toBe("afrouter/kilo/stealth/space-bunny-alpha:high");
    });

    it("omits the suffix when no thinking level is given", async () => {
      await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: true });
      expect(readConfig().modelRoles.default).toBe("afrouter/cc/claude-sonnet-4-5");
    });

    it("preserves other roles and unrelated settings", async () => {
      writeConfig({
        modelRoles: { slow: "kilo/other-model" },
        theme: { dark: "titanium" },
        shellPath: "/bin/bash",
      });
      await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: true });
      const config = readConfig();
      expect(config.modelRoles.slow).toBe("kilo/other-model");
      expect(config.theme.dark).toBe("titanium");
      expect(config.shellPath).toBe("/bin/bash");
    });

    // An explicit Apply with the toggle ON is a deliberate user request, so it
    // does repoint a `default` role that pointed elsewhere — the card's toggle
    // is derived from that role, so it only ever reads ON when the user put it
    // there. (Only `setDefault: false` is guarded; see the clear-paths below.)
    it("repoints a foreign default role on an explicit apply, and then reports it as ours", async () => {
      writeConfig({ modelRoles: { default: "kilo/other-model" } });
      const res = await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5"],
        setDefault: true,
      });
      expect(readConfig().modelRoles.default).toBe("afrouter/cc/claude-sonnet-4-5");
      expect(res.body.defaultModel.model).toBe("cc/claude-sonnet-4-5");

      // The status must agree with what was written, or the toggle would
      // render OFF while the file points at us.
      const status = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
      expect(status.body.omp.isDefault).toBe(true);
      expect(status.body.omp.defaultModel).toBe("cc/claude-sonnet-4-5");
    });

    // Regression: a foreign selector that merely *ends* in a level-shaped
    // suffix (`kilo/poolside/laguna-2.1:free:xhigh`) is not our role, so
    // reporting "xhigh" would make the card show a thinking level for a
    // startup model it does not own. (Seen on a real config.)
    it("does not report a thinking level for a foreign default role", async () => {
      writeModels({ providers: { afrouter: { baseUrl: "x", api: "openai-completions", models: [] } } });
      writeConfig({ modelRoles: { default: "kilo/poolside/laguna-2.1:free:xhigh" } });
      const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
      expect(res.body.omp.isDefault).toBe(false);
      expect(res.body.omp.thinkingLevel).toBeNull();
    });

    it("falls back to the first model when defaultModel is not in the selection", async () => {
      await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5", "kilo/stealth/space-bunny-alpha"],
        setDefault: true,
        defaultModel: "not/in-this-apply",
      });
      expect(readConfig().modelRoles.default).toBe("afrouter/cc/claude-sonnet-4-5");
    });

    it("leaves config.yml untouched when no setDefault flag is sent", async () => {
      writeConfig({ theme: { dark: "titanium" } });
      await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
      expect(readConfig().modelRoles).toBeUndefined();
      expect(readConfig().theme.dark).toBe("titanium");
    });

    it("clears our own pin when setDefault is false", async () => {
      writeConfig({ modelRoles: { default: "afrouter/cc/claude-sonnet-4-5" }, theme: { dark: "x" } });
      const res = await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5"],
        setDefault: false,
      });
      expect(res.body.defaultCleared).toBe(true);
      const config = readConfig();
      expect(config.modelRoles).toBeUndefined();
      expect(config.theme.dark).toBe("x");
    });

    it("leaves a foreign default role alone when setDefault is false", async () => {
      writeConfig({ modelRoles: { default: "kilo/other-model" } });
      const res = await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5"],
        setDefault: false,
      });
      expect(res.body.defaultCleared).toBe(false);
      expect(readConfig().modelRoles.default).toBe("kilo/other-model");
    });
  });
});

describe("DELETE", () => {
  it("is a no-op when nothing is configured", async () => {
    const res = await del();
    expect(res.body.success).toBe(true);
    expect(res.body.removed).toBe(0);
  });

  it("removes the whole provider and clears our pin, preserving other settings", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "kilo/stealth/space-bunny-alpha"],
      setDefault: true,
    });
    writeConfig({ ...readConfig(), theme: { dark: "titanium" } });

    const res = await del();
    expect(res.body.entryRemoved).toBe(true);
    expect(res.body.removed).toBe(2);
    expect(res.body.defaultCleared).toBe(true);
    expect(readModels().providers).toBeUndefined();
    expect(readConfig().modelRoles).toBeUndefined();
    expect(readConfig().theme.dark).toBe("titanium");
  });

  it("keeps other providers when the afrouter entry is dropped", async () => {
    writeModels({ providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [] } } });
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await del();
    const models = readModels();
    expect(models.providers.afrouter).toBeUndefined();
    expect(models.providers.anthropic.baseUrl).toBe("https://api.anthropic.com");
  });

  it("leaves a foreign default role intact when the provider is removed", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    writeConfig({ modelRoles: { default: "kilo/other-model" } });
    const res = await del();
    expect(res.body.defaultCleared).toBe(false);
    expect(readConfig().modelRoles.default).toBe("kilo/other-model");
  });

  it("repoints the pin only when the pinned model itself is removed", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "kilo/stealth/space-bunny-alpha"],
      setDefault: true,
      defaultModel: "cc/claude-sonnet-4-5",
      thinkingLevel: "high",
    });

    // Removing the OTHER model must not disturb the pin.
    await del("kilo/stealth/space-bunny-alpha");
    expect(readConfig().modelRoles.default).toBe("afrouter/cc/claude-sonnet-4-5:high");

    // Removing the pinned one repoints to a survivor, keeping the level.
    await del("cc/claude-sonnet-4-5");
    expect(readModels().providers).toBeUndefined();
    expect(readConfig().modelRoles).toBeUndefined();
  });

  it("repoints the pin to a surviving model at the same thinking level", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "kilo/stealth/space-bunny-alpha"],
      setDefault: true,
      defaultModel: "cc/claude-sonnet-4-5",
      thinkingLevel: "high",
    });
    await del("cc/claude-sonnet-4-5");
    expect(readConfig().modelRoles.default).toBe("afrouter/kilo/stealth/space-bunny-alpha:high");
  });

  it("refuses to remove a model that AFRouter does not own", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const models = readModels();
    models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1 });
    writeModels(models);

    const res = await del("hand/typed-model");
    expect(res.body.removed).toBe(0);
    expect(provider().models.map((m) => m.id)).toContain("hand/typed-model");
  });

  describe("ownership ledger", () => {
    it("pre-ledger, treats a pasted provider as wholly ours so it can be reset", async () => {
      writeModels({
        providers: {
          afrouter: {
            baseUrl: "http://x/v1",
            apiKey: "k",
            api: "openai-completions",
            models: [{ id: "hand/typed-model", contextWindow: 1, maxTokens: 1 }],
          },
        },
      });
      const res = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
      expect(res.body.omp.afrouterModels).toEqual(["hand/typed-model"]);
      expect(res.body.omp.bootstrapCandidates).toEqual([]);
    });

    it("spares a hand-added model from a full reset once a ledger exists", async () => {
      await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
      const models = readModels();
      models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1 });
      writeModels(models);

      const status = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
      expect(status.body.omp.afrouterModels).toEqual(["cc/claude-sonnet-4-5"]);
      expect(status.body.omp.bootstrapCandidates).toEqual(["hand/typed-model"]);

      const res = await del();
      expect(res.body.removed).toBe(1);
      expect(provider().models.map((m) => m.id)).toEqual(["hand/typed-model"]);
      expect(res.body.skippedCandidates).toEqual(["hand/typed-model"]);
    });

    it("does not let a plain re-Apply silently adopt a candidate", async () => {
      await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
      const models = readModels();
      models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1 });
      writeModels(models);

      // The card re-sends its whole hydrated chip list; that must not convert a
      // hand-added model into a deletable one.
      const res = await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5", "hand/typed-model"],
      });
      expect(res.body.skippedCandidates).toEqual(["hand/typed-model"]);

      const status = await GET({ url: "http://127.0.0.1:20128/api/cli-tools/omp-settings" });
      expect(status.body.omp.bootstrapCandidates).toEqual(["hand/typed-model"]);
    });

    it("adopts a candidate only when the user explicitly asks", async () => {
      await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
      const models = readModels();
      models.providers.afrouter.models.push({ id: "hand/typed-model", contextWindow: 1, maxTokens: 1 });
      writeModels(models);

      await post({
        baseUrl: "http://x",
        apiKey: "k",
        models: ["cc/claude-sonnet-4-5", "hand/typed-model"],
        adoptBootstrap: true,
      });
      const res = await del();
      expect(res.body.removed).toBe(2);
      expect(res.body.entryRemoved).toBe(true);
    });
  });
});
