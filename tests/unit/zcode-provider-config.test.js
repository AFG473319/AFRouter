/**
 * Unit tests for the ZCode Personal layer
 * (src/lib/zcodeProviderConfig.js + src/lib/zcodeReasoningLevels.js
 * + the /api/cli-tools/zcode-settings wiring).
 *
 * ZCode 3.14+ imports the legacy ~/.zcode/v2/config.json into a
 * Personal layer (~/.zcode/v2/provider_config.json) exactly once,
 * and the importer drops reasoning variants — so the selectable
 * thinking efforts must be written to provider_config.json as
 * optionSpecs.reasoningLevel.values.
 *
 * Covers:
 *  - the AFRouter → ZCode level mapper (pure): GPT-style ladder,
 *    Claude-style with max, DeepSeek high/max, on/off models,
 *    non-reasoning models, de-dup, none-only
 *  - the writer against a temp "home": fresh install, legacy-file
 *    only, both files, an existing provider_config.json made by
 *    ZCode with other providers (preserved byte-for-byte), manual
 *    overrides (win + reported), idempotent re-apply, DELETE
 *    cleanup scoped to owned ids, lock wait + clean timeout,
 *    stale/ownerless lock reclamation, corrupt-file refusal
 *  - the route: POST creates/updates the Personal layer, GET
 *    reports it, DELETE cleans it, corrupt Personal config 409s
 *    before anything is written
 *
 * os.homedir and DATA_DIR are redirected to per-test temp dirs;
 * global.fetch is rejected so spec resolution takes the
 * deterministic static-registry path (same harness as
 * zcode-settings.test.js).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mapReasoningLevels,
  zcodeReasoningValues,
} from "../../src/lib/zcodeReasoningLevels.js";
import {
  getPersonalConfigPath,
  readPersonalConfig,
  upsertPersonalProviderConfig,
  removePersonalProviderModels,
  readPersonalProviderStatus,
  validatePersonalConfigShape,
  PersonalConfigCorruptError,
  PersonalConfigInvalidError,
  ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE,
} from "../../src/lib/zcodeProviderConfig.js";

const state = vi.hoisted(() => ({ home: null, dataDir: null }));

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

// Ids in this table resolve; everything else returns NaN so it takes
// the conservative-fallback path (reasoning: false, unverified).
const RESOLVABLE = new Set([
  "cl/z-ai/glm-5.3-flash",
  "oc/mimo-v2.5-free",
  "cl/z-ai/glm-5.3",
  "cx/gpt-5.6",
  "ds/deepseek-v4-pro",
  "zai/glm-5.3",
  "nx/gemini-3-pro",
]);

// Per-model capabilities standing in for the live /v1/models catalog.
// reasoningLevels mirrors the ladders models.dev publishes for each
// family (GPT-style, Claude-style, DeepSeek, zai on/off, Gemini).
const MOCK_CAPS = {
  "cl/z-ai/glm-5.3-flash": { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: false },
  "oc/mimo-v2.5-free": { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: false },
  "cl/z-ai/glm-5.3": { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: false, reasoningLevels: ["low", "medium", "high", "max"] },
  "cx/gpt-5.6": { contextWindow: 1050000, maxOutput: 128000, reasoning: true, vision: true, reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
  "ds/deepseek-v4-pro": { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: false, reasoningLevels: ["none", "high", "max"] },
  "zai/glm-5.3": { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: false, reasoningLevels: ["none", "thinking"] },
  "nx/gemini-3-pro": { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: true, reasoningLevels: ["minimal", "low", "medium", "high"], thinkingCanDisable: false },
};

vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => {
    const key = provider ? `${provider}/${model}` : model;
    if (!RESOLVABLE.has(key)) {
      return { contextWindow: Number.NaN, maxOutput: Number.NaN };
    }
    return { ...MOCK_CAPS[key] };
  },
}));

// Reject every fetch so the live catalog is unavailable (deterministic).
const realFetch = global.fetch;
global.fetch = () => Promise.reject(new Error("offline test"));

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/zcode-settings/route.js");

const configPath = () => path.join(state.home, ".zcode", "v2", "config.json");
const personalPath = () => path.join(state.home, ".zcode", "v2", "provider_config.json");
const ledgerPath = () => path.join(state.dataDir, "zcode-model-ownership.json");

function writeConfigFixture(obj) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

function writePersonalFixture(obj) {
  fs.mkdirSync(path.dirname(personalPath()), { recursive: true });
  fs.writeFileSync(personalPath(), JSON.stringify(obj, null, 2));
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

function readPersonalFile() {
  return JSON.parse(fs.readFileSync(personalPath(), "utf-8"));
}

function findEntry(config) {
  return Object.values(config.provider).find((v) => v.name === "AFRouter" && v.source === "custom");
}

function entryKeyOf(config) {
  return Object.keys(config.provider).find((k) => config.provider[k].name === "AFRouter" && config.provider[k].source === "custom");
}

function post(body) {
  return POST({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

// The AFRouter entry as ZCode leaves it after a restart: every model
// entry rebuilt from ZCode's own key list, so our `afrouter` marker
// is gone.
function entryFixture(models) {
  return {
    provider: {
      e1: {
        name: "AFRouter",
        source: "custom",
        kind: "openai-compatible",
        options: { apiKey: "k", baseURL: "http://127.0.0.1:20128/v1" },
        models,
      },
    },
  };
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-personal-test-"));
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-personal-data-"));
  process.env.DATA_DIR = state.dataDir;
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_DATA_BASE_DIR;
});

afterAll(() => {
  global.fetch = realFetch;
  delete process.env.DATA_DIR;
  delete process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
  delete process.env.ZCODE_DATA_BASE_DIR;
  state.home = null;
  state.dataDir = null;
});

// ---------------------------------------------------------------------------
// Level mapper (pure)
// ---------------------------------------------------------------------------

describe("mapReasoningLevels", () => {
  it("maps a GPT-style ladder, dropping none and prepending disabled", () => {
    expect(
      mapReasoningLevels(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
    ).toEqual(["disabled", "minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("maps a Claude-style ladder with max", () => {
    expect(mapReasoningLevels(["none", "low", "medium", "high", "max"])).toEqual(
      ["disabled", "low", "medium", "high", "max"]
    );
  });

  it("maps a DeepSeek high/max ladder", () => {
    expect(mapReasoningLevels(["none", "high", "max"])).toEqual(["disabled", "high", "max"]);
  });

  it("maps an on/off model to disabled/enabled", () => {
    expect(mapReasoningLevels(["none", "thinking"])).toEqual(["disabled", "enabled"]);
  });

  it("keeps a no-disable ladder unchanged (gemini)", () => {
    expect(mapReasoningLevels(["minimal", "low", "medium", "high"])).toEqual(
      ["minimal", "low", "medium", "high"]
    );
  });

  it("de-duplicates while keeping order, strongest last", () => {
    expect(mapReasoningLevels(["none", "low", "low", "high", "high"])).toEqual(
      ["disabled", "low", "high"]
    );
  });

  it("maps a none-only ladder to the single disabled tier", () => {
    expect(mapReasoningLevels(["none"])).toEqual(["disabled"]);
  });

  it("passes provider-specific top tiers (ultra) through verbatim", () => {
    expect(mapReasoningLevels(["none", "low", "medium", "high", "xhigh", "max", "ultra"])).toEqual(
      ["disabled", "low", "medium", "high", "xhigh", "max", "ultra"]
    );
  });

  it("returns null for non-reasoning models (no rule is written)", () => {
    expect(mapReasoningLevels(null)).toBeNull();
    expect(mapReasoningLevels(undefined)).toBeNull();
    expect(mapReasoningLevels([])).toBeNull();
    expect(mapReasoningLevels(["none"])).not.toBeNull();
  });
});

describe("zcodeReasoningValues", () => {
  it("returns null for specs without reasoning", () => {
    expect(zcodeReasoningValues({ reasoning: false, reasoningLevels: ["low", "high"] })).toBeNull();
    expect(zcodeReasoningValues(null)).toBeNull();
  });

  it("returns null for reasoning specs with no ladder (ZCode default toggle is inherited)", () => {
    expect(zcodeReasoningValues({ reasoning: true })).toBeNull();
    expect(zcodeReasoningValues({ reasoning: true, reasoningLevels: [] })).toBeNull();
  });

  it("maps reasoning specs with a ladder", () => {
    expect(zcodeReasoningValues({ reasoning: true, reasoningLevels: ["none", "thinking"] })).toEqual(
      ["disabled", "enabled"]
    );
  });
});

// ---------------------------------------------------------------------------
// Writer (direct module calls, explicit temp paths)
// ---------------------------------------------------------------------------

describe("upsertPersonalProviderConfig", () => {
  const SPECS = {
    "cx/gpt-5.6": { context: 1050000, output: 128000, input: ["text", "image"], reasoning: true, reasoningLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max"] },
    "zai/glm-5.3": { context: 1000000, output: 131072, input: ["text"], reasoning: true, reasoningLevels: ["none", "thinking"] },
    "plain/model": { context: 200000, output: 32000, input: ["text"], reasoning: false },
  };

  it("creates the file on a fresh install, mirroring ZCode's import", async () => {
    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_afrouter",
      models: [{ id: "cx/gpt-5.6", spec: SPECS["cx/gpt-5.6"] }],
    });
    expect(result.created).toBe(true);
    expect(result.providerCreated).toBe(true);
    expect(result.applied).toEqual(["cx/gpt-5.6"]);
    expect(result.manualOverrides).toEqual([]);

    const doc = readPersonalFile();
    expect(doc.schemaVersion).toBe(1);
    expect(doc.config.providerOrder).toEqual(["6ba7b810-9dad-11d1-80b4-00c04fd430c8"]);
    const rule = doc.config.providerConfigRules.providerRules[0];
    expect(rule.providerId).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(rule.providerName).toBe("AFRouter");
    expect(rule.config.group).toBe("standard-personal");
    expect(rule.config.access).toEqual({ type: "api-key", apiKey: "sk_afrouter" });
    expect(rule.config.api).toEqual({ type: "openai-chat-completions", baseUrl: "http://127.0.0.1:20128/v1" });
    expect(rule.config.personalModelIds).toEqual(["cx/gpt-5.6"]);
    expect(rule.config.modelOrder).toEqual(["cx/gpt-5.6"]);

    const modelRule = doc.config.modelConfigRules.providerModelRules[0];
    expect(modelRule.providerId).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
    expect(modelRule.modelId).toBe("cx/gpt-5.6");
    expect(modelRule.config.properties.contextWindow).toBe(1050000);
    expect(modelRule.config.properties.inputFormat).toEqual({ supportsText: true, supportsImage: true });
    expect(modelRule.config.optionSpecs.reasoningLevel.values).toEqual(
      ["disabled", "minimal", "low", "medium", "high", "xhigh", "max"]
    );
    expect(modelRule.config.optionSpecs.maxOutputTokens).toEqual({ max: 128000 });
  });

  it("writes no reasoningLevel rule for a non-reasoning model", async () => {
    await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "p1",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [{ id: "plain/model", spec: SPECS["plain/model"] }],
    });
    const modelRule = readPersonalFile().config.modelConfigRules.providerModelRules[0];
    expect(modelRule.config.properties.contextWindow).toBe(200000);
    expect(modelRule.config.optionSpecs.maxOutputTokens).toEqual({ max: 32000 });
    expect(modelRule.config.optionSpecs.reasoningLevel).toBeUndefined();
  });

  it("preserves an existing ZCode-made file's other providers byte-for-byte", async () => {
    const otherProvider = {
      providerId: "11111111-2222-3333-4444-555555555555",
      providerName: "My Custom Provider",
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "other-key" },
        api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
        personalModelIds: ["foo/bar"],
        modelOrder: ["foo/bar"],
      },
    };
    const otherModelRule = {
      providerId: "11111111-2222-3333-4444-555555555555",
      modelId: "foo/bar",
      config: {
        properties: { contextWindow: 123456, inputFormat: { supportsText: true } },
        optionSpecs: { reasoningLevel: { values: ["a", "b"] }, maxOutputTokens: { max: 999 } },
      },
    };
    const otherManualRule = {
      providerId: "11111111-2222-3333-4444-555555555555",
      modelId: "foo/baz",
      config: {
        properties: { contextWindow: 42 },
        optionSpecs: { reasoningLevel: { values: ["x"] } },
      },
    };
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: ["11111111-2222-3333-4444-555555555555"],
        providerConfigRules: { providerRules: [otherProvider] },
        modelConfigRules: {
          providerModelRules: [otherModelRule],
          manualProviderModelRules: [otherManualRule],
        },
        defaultModelSelection: { providerId: "11111111-2222-3333-4444-555555555555", modelId: "foo/bar" },
      },
    };
    writePersonalFixture(doc);

    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_afrouter",
      models: [
        { id: "cx/gpt-5.6", spec: SPECS["cx/gpt-5.6"] },
        { id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] },
      ],
    });
    expect(result.created).toBe(false);
    expect(result.providerCreated).toBe(true);

    const after = readPersonalFile();
    // Other provider's rule, model rules, manual rule, order and
    // default selection survive untouched.
    expect(after.config.providerConfigRules.providerRules[0]).toEqual(otherProvider);
    expect(after.config.modelConfigRules.providerModelRules[0]).toEqual(otherModelRule);
    expect(after.config.modelConfigRules.manualProviderModelRules[0]).toEqual(otherManualRule);
    expect(after.config.providerOrder).toEqual([
      "11111111-2222-3333-4444-555555555555",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ]);
    expect(after.config.defaultModelSelection).toEqual(doc.config.defaultModelSelection);
    // Our rule was appended with both models.
    const ourRule = after.config.providerConfigRules.providerRules[1];
    expect(ourRule.providerName).toBe("AFRouter");
    expect(ourRule.config.personalModelIds).toEqual(["cx/gpt-5.6", "zai/glm-5.3"]);
    expect(after.config.modelConfigRules.providerModelRules).toHaveLength(3);
  });

  it("applies cleanly when another provider has a half-typed baseUrl and a zhipu-account access entry", async () => {
    // ZCode's personal schema accepts ANY string (or null) as a
    // personal provider's baseUrl — it stages in-progress endpoint
    // edits — and zhipu-account is a first-class access type with
    // its own keys. Neither may block AFRouter's Apply.
    const zhipuProvider = {
      providerId: "22222222-3333-4444-5555-666666666666",
      providerName: "Zhipu Account Provider",
      config: {
        group: "standard-personal",
        access: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
        // No scheme: a half-typed endpoint ZCode itself accepts.
        api: { type: "openai-chat-completions", baseUrl: "api.z.ai/v1" },
        personalModelIds: ["glm-4.6"],
        modelOrder: ["glm-4.6"],
      },
    };
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: ["22222222-3333-4444-5555-666666666666"],
        providerConfigRules: { providerRules: [zhipuProvider] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: {
          providerId: "22222222-3333-4444-5555-666666666666",
          modelId: "glm-4.6",
          options: { reasoningLevel: "thinking" },
        },
      },
    };
    writePersonalFixture(doc);

    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_afrouter",
      models: [{ id: "cx/gpt-5.6", spec: SPECS["cx/gpt-5.6"] }],
    });
    expect(result.created).toBe(false);
    expect(result.providerCreated).toBe(true);
    expect(result.applied).toEqual(["cx/gpt-5.6"]);

    const after = readPersonalFile();
    // The Zhipu provider's rule and the default selection
    // (with its reasoning option) survive untouched.
    expect(after.config.providerConfigRules.providerRules[0]).toEqual(zhipuProvider);
    expect(after.config.providerOrder).toEqual([
      "22222222-3333-4444-5555-666666666666",
      "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    ]);
    expect(after.config.defaultModelSelection).toEqual(doc.config.defaultModelSelection);
    // The file still reads as a valid layer with our levels.
    const status = await readPersonalProviderStatus({
      filePath: personalPath(),
      providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
    });
    expect(status.corrupt).toBe(false);
    expect(status.levelsByModel).toEqual({
      "cx/gpt-5.6": ["disabled", "minimal", "low", "medium", "high", "xhigh", "max"],
    });
  });

  it("repairs a half-typed baseUrl on the AFRouter rule on apply", async () => {
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
              providerName: "AFRouter",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "old" },
                api: { type: "openai-chat-completions", baseUrl: "api.z.ai/v1" },
                personalModelIds: [],
                modelOrder: [],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
    writePersonalFixture(doc);

    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
    });
    expect(result.applied).toEqual(["zai/glm-5.3"]);
    const rule = readPersonalFile().config.providerConfigRules.providerRules[0];
    expect(rule.config.api.baseUrl).toBe("http://127.0.0.1:20128/v1");
  });

  it("refuses to write when the AFRouter endpoint itself is not a valid URL", async () => {
    await expect(
      upsertPersonalProviderConfig({
        filePath: personalPath(),
        providerId: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        baseUrl: "not-a-url",
        models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
      })
    ).rejects.toThrow(PersonalConfigInvalidError);
    // Nothing was written.
    expect(() => readPersonalFile()).toThrow();
  });

  it("matches the existing AFRouter rule by providerId and refreshes endpoint + key", async () => {
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: ["p-router"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "p-router",
              providerName: "AFRouter",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "old-key" },
                api: { type: "openai-chat-completions", baseUrl: "http://old:1/v1" },
                personalModelIds: ["cx/gpt-5.6"],
                modelOrder: ["cx/gpt-5.6"],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
    writePersonalFixture(doc);

    await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "p-router",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "new-key",
      models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
    });

    const after = readPersonalFile();
    const rule = after.config.providerConfigRules.providerRules[0];
    expect(after.config.providerConfigRules.providerRules).toHaveLength(1);
    expect(rule.config.access).toEqual({ type: "api-key", apiKey: "new-key" });
    expect(rule.config.api).toEqual({ type: "openai-chat-completions", baseUrl: "http://127.0.0.1:20128/v1" });
    expect(rule.config.personalModelIds).toEqual(["cx/gpt-5.6", "zai/glm-5.3"]);
    expect(rule.config.modelOrder).toEqual(["cx/gpt-5.6", "zai/glm-5.3"]);
  });

  it("matches the existing AFRouter rule by name + group when the id is unknown", async () => {
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: ["some-other-id"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "some-other-id",
              providerName: "AFRouter",
              config: {
                group: "standard-personal",
                access: { type: "api-key" },
                api: { type: "openai-chat-completions", baseUrl: "http://old:1/v1" },
                personalModelIds: [],
                modelOrder: [],
              },
            },
          ],
        },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
    writePersonalFixture(doc);

    await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "fresh-uuid",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
    });

    const after = readPersonalFile();
    expect(after.config.providerConfigRules.providerRules).toHaveLength(1);
    expect(after.config.providerConfigRules.providerRules[0].providerId).toBe("some-other-id");
    expect(after.config.providerConfigRules.providerRules[0].config.personalModelIds).toEqual(["zai/glm-5.3"]);
    expect(after.config.providerOrder).toEqual(["some-other-id"]);
  });

  it("skips models with a manual rule and reports them as manualOverrides", async () => {
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "p1",
              providerName: "AFRouter",
              config: {
                group: "standard-personal",
                access: { type: "api-key" },
                api: { type: "openai-chat-completions", baseUrl: "http://x/v1" },
                personalModelIds: ["zai/glm-5.3"],
                modelOrder: ["zai/glm-5.3"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [],
          manualProviderModelRules: [
            {
              providerId: "p1",
              modelId: "zai/glm-5.3",
              config: {
                properties: { contextWindow: 777 },
                optionSpecs: { reasoningLevel: { values: ["user", "picked"] } },
              },
            },
          ],
        },
      },
    };
    writePersonalFixture(doc);

    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "p1",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [
        { id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] },
        { id: "cx/gpt-5.6", spec: SPECS["cx/gpt-5.6"] },
      ],
    });

    expect(result.applied).toEqual(["cx/gpt-5.6"]);
    expect(result.manualOverrides).toEqual(["zai/glm-5.3"]);

    const after = readPersonalFile();
    const manual = after.config.modelConfigRules.manualProviderModelRules[0];
    // The user's manual rule is untouched and still wins.
    expect(manual.config.properties.contextWindow).toBe(777);
    expect(manual.config.optionSpecs.reasoningLevel.values).toEqual(["user", "picked"]);
    // No smart rule was written for the manual model; the other model was.
    const smart = after.config.modelConfigRules.providerModelRules;
    expect(smart).toHaveLength(1);
    expect(smart[0].modelId).toBe("cx/gpt-5.6");
    // The manual model stays a member of the provider.
    expect(after.config.providerConfigRules.providerRules[0].config.personalModelIds).toEqual([
      "zai/glm-5.3",
      "cx/gpt-5.6",
    ]);
  });

  it("re-apply is idempotent — no duplicate ids or rules", async () => {
    const models = [
      { id: "cx/gpt-5.6", spec: SPECS["cx/gpt-5.6"] },
      { id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] },
    ];
    const args = {
      filePath: personalPath(),
      providerId: "p1",
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_afrouter",
      models,
    };
    await upsertPersonalProviderConfig(args);
    await upsertPersonalProviderConfig(args);
    await upsertPersonalProviderConfig(args);

    const doc = readPersonalFile();
    const rules = doc.config.providerConfigRules.providerRules;
    expect(rules).toHaveLength(1);
    expect(rules[0].config.personalModelIds).toEqual(["cx/gpt-5.6", "zai/glm-5.3"]);
    expect(rules[0].config.modelOrder).toEqual(["cx/gpt-5.6", "zai/glm-5.3"]);
    const smart = doc.config.modelConfigRules.providerModelRules;
    expect(smart).toHaveLength(2);
    expect(new Set(smart.map((r) => r.modelId)).size).toBe(2);
  });

  it("writes a timestamped backup next to an existing file before overwriting", async () => {
    const doc = {
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    };
    writePersonalFixture(doc);

    await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "p1",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
    });

    const siblings = fs.readdirSync(path.dirname(personalPath()));
    expect(siblings.some((f) => /^provider_config\.json\.bak-\d{8}-\d{6}$/.test(f))).toBe(true);
  });

  it("refuses a corrupt file and leaves it untouched", async () => {
    fs.mkdirSync(path.dirname(personalPath()), { recursive: true });
    fs.writeFileSync(personalPath(), "{not json");

    await expect(
      upsertPersonalProviderConfig({
        filePath: personalPath(),
        providerId: "p1",
        baseUrl: "http://127.0.0.1:20128/v1",
        models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
      })
    ).rejects.toBeInstanceOf(PersonalConfigCorruptError);
    expect(fs.readFileSync(personalPath(), "utf-8")).toBe("{not json");
  });

  it("refuses a shape-invalid file (wrong schemaVersion) and leaves it untouched", async () => {
    writePersonalFixture({ schemaVersion: 99, config: {} });

    await expect(
      upsertPersonalProviderConfig({
        filePath: personalPath(),
        providerId: "p1",
        baseUrl: "http://127.0.0.1:20128/v1",
        models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
      })
    ).rejects.toBeInstanceOf(PersonalConfigCorruptError);
    expect(readPersonalFile().schemaVersion).toBe(99);
  });

  it("waits for a lock held by a live process, then times out cleanly", async () => {
    // Simulate ZCode holding the lock: owner file names our own
    // (alive) pid, so the lock is neither stale nor reclaimable.
    const lockDir = `${personalPath()}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(
      path.join(lockDir, "owner-zcode.json"),
      JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: "zcode" })
    );
    fs.mkdirSync(path.dirname(personalPath()), { recursive: true });
    fs.writeFileSync(personalPath(), JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: [],
        providerConfigRules: { providerRules: [] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }));

    const before = fs.readFileSync(personalPath(), "utf-8");
    await expect(
      upsertPersonalProviderConfig({
        filePath: personalPath(),
        providerId: "p1",
        baseUrl: "http://127.0.0.1:20128/v1",
        models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
        lockOptions: { maxWaitMs: 500 },
      })
    ).rejects.toMatchObject({ code: ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE });
    // Nothing was written while the lock was held.
    expect(fs.readFileSync(personalPath(), "utf-8")).toBe(before);
    // Our writer released its own queue slot; the held lock is intact.
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("reclaims a lock whose owner process has exited", async () => {
    const lockDir = `${personalPath()}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    // INT32_MAX is effectively never a live pid.
    fs.writeFileSync(
      path.join(lockDir, "owner-dead.json"),
      JSON.stringify({ pid: 2147483647, createdAt: Date.now(), token: "dead" })
    );

    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "p1",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
      lockOptions: { maxWaitMs: 2000 },
    });
    expect(result.applied).toEqual(["zai/glm-5.3"]);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("reclaims an ownerless lock past the grace period", async () => {
    const lockDir = `${personalPath()}.lock`;
    fs.mkdirSync(lockDir, { recursive: true });
    // No pid: ownerless. Created 10s ago, far past the grace window.
    fs.writeFileSync(
      path.join(lockDir, "owner-orphan.json"),
      JSON.stringify({ createdAt: Date.now() - 10000, token: "orphan" })
    );

    const result = await upsertPersonalProviderConfig({
      filePath: personalPath(),
      providerId: "p1",
      baseUrl: "http://127.0.0.1:20128/v1",
      models: [{ id: "zai/glm-5.3", spec: SPECS["zai/glm-5.3"] }],
      lockOptions: { maxWaitMs: 2000 },
    });
    expect(result.applied).toEqual(["zai/glm-5.3"]);
    expect(fs.existsSync(lockDir)).toBe(false);
  });
});

describe("removePersonalProviderModels", () => {
  function seededDoc() {
    return {
      schemaVersion: 1,
      config: {
        providerOrder: ["p1", "other"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "p1",
              providerName: "AFRouter",
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "k" },
                api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:20128/v1" },
                personalModelIds: ["cx/gpt-5.6", "zai/glm-5.3", "plain/model"],
                modelOrder: ["cx/gpt-5.6", "zai/glm-5.3", "plain/model"],
              },
            },
            {
              providerId: "other",
              providerName: "Someone Else",
              config: {
                group: "standard-personal",
                access: { type: "api-key" },
                api: { type: "openai-chat-completions", baseUrl: "https://example.invalid/v1" },
                personalModelIds: ["foo/bar"],
                modelOrder: ["foo/bar"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "p1",
              modelId: "cx/gpt-5.6",
              config: { optionSpecs: { reasoningLevel: { values: ["disabled", "low"] } } },
            },
            {
              providerId: "p1",
              modelId: "zai/glm-5.3",
              config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } },
            },
            {
              providerId: "other",
              modelId: "foo/bar",
              config: { optionSpecs: { reasoningLevel: { values: ["a"] } } },
            },
          ],
          manualProviderModelRules: [
            {
              providerId: "p1",
              modelId: "plain/model",
              config: { properties: { contextWindow: 5 } },
            },
          ],
        },
      },
    };
  }

  it("removes only the owned models; manual rules and other providers survive", async () => {
    writePersonalFixture(seededDoc());

    const result = await removePersonalProviderModels({
      filePath: personalPath(),
      providerId: "p1",
      modelIds: ["cx/gpt-5.6", "zai/glm-5.3"],
    });

    expect(result.removed).toEqual(["cx/gpt-5.6", "zai/glm-5.3"]);
    expect(result.providerRemoved).toBe(false);

    const after = readPersonalFile();
    const ourRule = after.config.providerConfigRules.providerRules.find((r) => r.providerId === "p1");
    expect(ourRule.config.personalModelIds).toEqual(["plain/model"]);
    expect(ourRule.config.modelOrder).toEqual(["plain/model"]);
    // Smart rules for the removed ids are gone; the other provider's
    // rule and our manual rule are untouched.
    expect(
      after.config.modelConfigRules.providerModelRules.map((r) => `${r.providerId}/${r.modelId}`)
    ).toEqual(["other/foo/bar"]);
    expect(after.config.modelConfigRules.manualProviderModelRules).toHaveLength(1);
    expect(after.config.providerOrder).toEqual(["p1", "other"]);
  });

  it("removes the provider rule and its providerOrder entry when no models are left", async () => {
    writePersonalFixture(seededDoc());

    const result = await removePersonalProviderModels({
      filePath: personalPath(),
      providerId: "p1",
      modelIds: ["cx/gpt-5.6", "zai/glm-5.3", "plain/model"],
    });

    expect(result.providerRemoved).toBe(true);

    const after = readPersonalFile();
    expect(after.config.providerConfigRules.providerRules.map((r) => r.providerId)).toEqual(["other"]);
    expect(after.config.providerOrder).toEqual(["other"]);
    // No smart rules for the removed provider remain either.
    expect(
      after.config.modelConfigRules.providerModelRules.map((r) => r.providerId)
    ).toEqual(["other"]);
    // Manual rules are never touched — even when their provider rule
    // goes away (ZCode's schema allows an orphaned manual rule, and
    // the user's hand-tuned settings must survive a Reset).
    expect(after.config.modelConfigRules.manualProviderModelRules).toHaveLength(1);
  });

  it("is a no-op when nothing matches", async () => {
    writePersonalFixture(seededDoc());
    const result = await removePersonalProviderModels({
      filePath: personalPath(),
      providerId: "p1",
      modelIds: ["never/added"],
    });
    expect(result.removed).toEqual([]);
    expect(readPersonalFile()).toEqual(seededDoc());
  });

  it("is a no-op success when the file is missing", async () => {
    const result = await removePersonalProviderModels({
      filePath: personalPath(),
      providerId: "p1",
      modelIds: ["cx/gpt-5.6"],
    });
    expect(result.present).toBe(false);
    expect(result.removed).toEqual([]);
    expect(fs.existsSync(personalPath())).toBe(false);
  });

  it("is a no-op success on a corrupt file (ZCode already runs an empty layer)", async () => {
    fs.mkdirSync(path.dirname(personalPath()), { recursive: true });
    fs.writeFileSync(personalPath(), "{corrupt");
    const result = await removePersonalProviderModels({
      filePath: personalPath(),
      providerId: "p1",
      modelIds: ["cx/gpt-5.6"],
    });
    expect(result.present).toBe(true);
    expect(result.removed).toEqual([]);
    expect(fs.readFileSync(personalPath(), "utf-8")).toBe("{corrupt");
  });
});

describe("readPersonalProviderStatus", () => {
  it("reports not-installed when the file is missing", async () => {
    const status = await readPersonalProviderStatus({ filePath: personalPath() });
    expect(status.present).toBe(false);
    expect(status.corrupt).toBe(false);
    expect(status.levelsByModel).toEqual({});
  });

  it("reports corrupt files", async () => {
    fs.mkdirSync(path.dirname(personalPath()), { recursive: true });
    fs.writeFileSync(personalPath(), "{corrupt");
    const status = await readPersonalProviderStatus({ filePath: personalPath() });
    expect(status.present).toBe(true);
    expect(status.corrupt).toBe(true);
  });

  it("reports levels and manual models for the AFRouter provider", async () => {
    writePersonalFixture({
      schemaVersion: 1,
      config: {
        providerOrder: ["p1"],
        providerConfigRules: {
          providerRules: [
            {
              providerId: "p1",
              providerName: "AFRouter",
              config: {
                group: "standard-personal",
                personalModelIds: ["cx/gpt-5.6", "zai/glm-5.3", "hand/tuned"],
                modelOrder: ["cx/gpt-5.6", "zai/glm-5.3", "hand/tuned"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "p1",
              modelId: "cx/gpt-5.6",
              config: { optionSpecs: { reasoningLevel: { values: ["disabled", "low", "high"] } } },
            },
            {
              providerId: "p1",
              modelId: "zai/glm-5.3",
              config: { optionSpecs: { reasoningLevel: { values: ["disabled", "enabled"] } } },
            },
          ],
          manualProviderModelRules: [
            {
              providerId: "p1",
              modelId: "hand/tuned",
              config: { optionSpecs: { reasoningLevel: { values: ["user"] } } },
            },
          ],
        },
      },
    });

    const status = await readPersonalProviderStatus({ filePath: personalPath(), providerId: "p1" });
    expect(status.present).toBe(true);
    expect(status.providerId).toBe("p1");
    expect(status.modelIds).toEqual(["cx/gpt-5.6", "zai/glm-5.3", "hand/tuned"]);
    expect(status.levelsByModel).toEqual({
      "cx/gpt-5.6": ["disabled", "low", "high"],
      "zai/glm-5.3": ["disabled", "enabled"],
    });
    expect(status.manualModels).toEqual(["hand/tuned"]);
  });
});

describe("validatePersonalConfigShape", () => {
  const valid = () => ({
    schemaVersion: 1,
    config: {
      providerOrder: ["p1"],
      providerConfigRules: {
        providerRules: [
          {
            providerId: "p1",
            providerName: "AFRouter",
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: "k" },
              api: { type: "openai-chat-completions", baseUrl: "http://127.0.0.1:20128/v1" },
              personalModelIds: ["m"],
              modelOrder: ["m"],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: "p1",
            modelId: "m",
            config: {
              properties: { contextWindow: 100, inputFormat: { supportsText: true } },
              optionSpecs: {
                reasoningLevel: { values: ["disabled", "low"] },
                maxOutputTokens: { max: 1000 },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
    },
  });

  it("accepts a valid document", () => {
    expect(validatePersonalConfigShape(valid())).toEqual([]);
  });

  it("accepts any-string baseUrl on other providers (ZCode stages in-progress edits)", () => {
    const doc = valid();
    doc.config.providerConfigRules.providerRules.push({
      providerId: "other",
      config: {
        group: "standard-personal",
        access: { type: "api-key" },
        // No scheme: a half-typed endpoint ZCode itself accepts.
        api: { baseUrl: "api.example.com/v1" },
        personalModelIds: [],
        modelOrder: [],
      },
    });
    // Pure ZCode semantics: nothing to reject.
    expect(validatePersonalConfigShape(doc)).toEqual([]);
    // With our own id declared, only THAT endpoint is checked.
    expect(validatePersonalConfigShape(doc, "p1")).toEqual([]);
  });

  it("requires a valid URL only for the provider being written", () => {
    const doc = valid();
    doc.config.providerConfigRules.providerRules[0].config.api.baseUrl = "half-typed/v1";
    // Someone else's id: the endpoint is not ours to judge.
    expect(validatePersonalConfigShape(doc, "someone-else")).toEqual([]);
    // Our own id: we are about to write it, so it must be valid.
    expect(validatePersonalConfigShape(doc, "p1").length).toBeGreaterThan(0);
  });

  it("accepts a zhipu-account access entry with its own keys", () => {
    const doc = valid();
    doc.config.providerConfigRules.providerRules.push({
      providerId: "zhipu",
      config: {
        group: "standard-personal",
        access: {
          type: "zhipu-account",
          accountType: "bigmodel",
          mode: "team-coding-plan",
          entitled: false,
        },
        personalModelIds: [],
        modelOrder: [],
      },
    });
    expect(validatePersonalConfigShape(doc)).toEqual([]);
  });

  it("rejects unknown zhipu-account field values", () => {
    const doc = valid();
    doc.config.providerConfigRules.providerRules.push({
      providerId: "zhipu",
      config: {
        access: { type: "zhipu-account", accountType: "nope" },
      },
    });
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);

    const doc2 = valid();
    doc2.config.providerConfigRules.providerRules.push({
      providerId: "zhipu",
      config: {
        access: { type: "zhipu-account", mode: "no-such-plan", entitled: "yes" },
      },
    });
    expect(validatePersonalConfigShape(doc2).length).toBeGreaterThan(0);
  });

  it("accepts an absent api.type and null on sparse fields", () => {
    const doc = valid();
    delete doc.config.providerConfigRules.providerRules[0].config.api.type;
    const modelRule = doc.config.modelConfigRules.providerModelRules[0];
    modelRule.config.enabled = null;
    modelRule.config.properties.contextWindow = null;
    modelRule.config.properties.inputFormat.supportsText = null;
    modelRule.config.optionSpecs.reasoningLevel.values = null;
    modelRule.config.optionSpecs.maxOutputTokens.max = null;
    expect(validatePersonalConfigShape(doc)).toEqual([]);
  });

  it("accepts a defaultModelSelection with reasoning options", () => {
    const doc = valid();
    doc.config.defaultModelSelection = {
      providerId: "p1",
      modelId: "m",
      options: { reasoningLevel: "high" },
    };
    expect(validatePersonalConfigShape(doc)).toEqual([]);

    const doc2 = valid();
    doc2.config.defaultModelSelection = {
      providerId: "p1",
      modelId: "m",
      options: { reasoningLevel: "" },
    };
    expect(validatePersonalConfigShape(doc2).length).toBeGreaterThan(0);
  });

  it("rejects unknown top-level keys", () => {
    const doc = valid();
    doc.afrouter = true;
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);
  });

  it("rejects unknown keys inside a model rule (no marker may be written)", () => {
    const doc = valid();
    doc.config.modelConfigRules.providerModelRules[0].config.zcode = { afrouter: true };
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);
  });

  it("rejects duplicate providerIds", () => {
    const doc = valid();
    doc.config.providerConfigRules.providerRules.push(doc.config.providerConfigRules.providerRules[0]);
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);
  });

  it("rejects a model declared in both rule lists", () => {
    const doc = valid();
    doc.config.modelConfigRules.manualProviderModelRules.push(
      doc.config.modelConfigRules.providerModelRules[0]
    );
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);
  });

  it("rejects empty, duplicate or blank reasoningLevel values", () => {
    const doc = valid();
    doc.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel.values = [];
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);

    const doc2 = valid();
    doc2.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel.values = ["low", "low"];
    expect(validatePersonalConfigShape(doc2).length).toBeGreaterThan(0);

    const doc3 = valid();
    doc3.config.modelConfigRules.providerModelRules[0].config.optionSpecs.reasoningLevel.values = ["low", ""];
    expect(validatePersonalConfigShape(doc3).length).toBeGreaterThan(0);
  });

  it("rejects a wrong schemaVersion", () => {
    const doc = valid();
    doc.schemaVersion = 2;
    expect(validatePersonalConfigShape(doc).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Route integration (same harness as zcode-settings.test.js)
// ---------------------------------------------------------------------------

describe("route: Personal layer wiring", () => {
  it("GET reports personalConfig with the file in use and levels by model", async () => {
    writeConfigFixture(entryFixture({
      "cx/gpt-5.6": { zcode: { modalitiesConfigured: true } },
      "zai/glm-5.3": { zcode: { modalitiesConfigured: true, afrouter: true } },
    }));
    // Ownership ledger knows both (zai/glm-5.3 marked, cx/gpt-5.6 recorded).
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ [configPath()]: { models: ["cx/gpt-5.6", "zai/glm-5.3"], updatedAt: "x" } })
    );

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.personalConfig.present).toBe(false); // no provider_config.json yet
    expect(res.body.personalConfig.path).toBe(personalPath());

    // After an apply, GET reports the levels ZCode will offer.
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6", "zai/glm-5.3"] });
    const status = await GET();
    expect(status.body.personalConfig.present).toBe(true);
    expect(status.body.personalConfig.levelsByModel).toEqual({
      "cx/gpt-5.6": ["disabled", "minimal", "low", "medium", "high", "xhigh", "max"],
      "zai/glm-5.3": ["disabled", "enabled"],
    });
    expect(status.body.personalConfig.manualModels).toEqual([]);
  });

  it("POST creates provider_config.json on a fresh install (legacy file only)", async () => {
    writeConfigFixture({ provider: {} });
    const res = await post({
      baseUrl: "http://127.0.0.1:20128/v1",
      apiKey: "sk_afrouter",
      models: ["cx/gpt-5.6"],
    });
    expect(res.status).toBe(200);
    expect(res.body.personalConfig.present).toBe(true);
    expect(res.body.personalConfig.providerCreated).toBe(true);
    expect(res.body.personalConfig.applied).toEqual(["cx/gpt-5.6"]);

    const doc = readPersonalFile();
    expect(doc.schemaVersion).toBe(1);
    const entryKey = entryKeyOf(readConfigFile());
    const rule = doc.config.providerConfigRules.providerRules[0];
    // Same UUID providerId as the config.json entry, mirroring
    // ZCode's own one-time import.
    expect(rule.providerId).toBe(entryKey);
    expect(rule.providerName).toBe("AFRouter");
    expect(rule.config.access).toEqual({ type: "api-key", apiKey: "sk_afrouter" });
    expect(rule.config.api.baseUrl).toBe("http://127.0.0.1:20128/v1");
    expect(rule.config.personalModelIds).toEqual(["cx/gpt-5.6"]);
    const modelRule = doc.config.modelConfigRules.providerModelRules[0];
    expect(modelRule.config.optionSpecs.reasoningLevel.values).toEqual(
      ["disabled", "minimal", "low", "medium", "high", "xhigh", "max"]
    );
  });

  it("POST keeps the legacy config.json reasoning block AND writes the Personal layer", async () => {
    writeConfigFixture({ provider: {} });
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["zai/glm-5.3"] });

    // Legacy block: still there for older ZCode versions, in AFRouter's
    // own vocabulary (the on/off "thinking" state).
    const legacyModel = findEntry(readConfigFile()).models["zai/glm-5.3"];
    expect(legacyModel.reasoning.enabled).toBe(true);
    expect(legacyModel.reasoning.variants).toEqual(["thinking"]);

    // Personal layer: same ladder as reasoningLevel.values.
    const personalRule = readPersonalFile().config.modelConfigRules.providerModelRules[0];
    expect(personalRule.config.optionSpecs.reasoningLevel.values).toEqual(["disabled", "enabled"]);
  });

  it("POST preserves an existing ZCode-made provider_config.json with other providers", async () => {
    const otherRule = {
      providerId: "99999999-aaaa-bbbb-cccc-dddddddddd",
      providerName: "Hand-made Provider",
      config: {
        group: "standard-personal",
        access: { type: "api-key", apiKey: "hand-key" },
        api: { type: "openai-chat-completions", baseUrl: "https://hand-made.invalid/v1" },
        personalModelIds: ["hand/model"],
        modelOrder: ["hand/model"],
      },
    };
    writePersonalFixture({
      schemaVersion: 1,
      config: {
        providerOrder: ["99999999-aaaa-bbbb-cccc-dddddddddd"],
        providerConfigRules: { providerRules: [otherRule] },
        modelConfigRules: {
          providerModelRules: [
            {
              providerId: "99999999-aaaa-bbbb-cccc-dddddddddd",
              modelId: "hand/model",
              config: {
                properties: { contextWindow: 555 },
                optionSpecs: { reasoningLevel: { values: ["one", "two"] } },
              },
            },
          ],
          manualProviderModelRules: [],
        },
      },
    });
    writeConfigFixture({ provider: {} });

    const res = await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6"] });
    expect(res.status).toBe(200);

    const doc = readPersonalFile();
    // The hand-made provider survives byte-for-byte (same key order).
    expect(doc.config.providerConfigRules.providerRules[0]).toEqual(otherRule);
    expect(doc.config.modelConfigRules.providerModelRules[0].modelId).toBe("hand/model");
    expect(doc.config.providerOrder).toEqual([
      "99999999-aaaa-bbbb-cccc-dddddddddd",
      entryKeyOf(readConfigFile()),
    ]);
  });

  it("POST applies cleanly when another provider has a non-URL baseUrl and a zhipu-account entry", async () => {
    // A file ZCode itself accepts: the other provider stages a
    // half-typed endpoint (any string is valid there) and logs
    // in with a zhipu-account access entry. Apply must not 409.
    const zhipuRule = {
      providerId: "22222222-3333-4444-5555-666666666666",
      providerName: "Zhipu Account Provider",
      config: {
        group: "standard-personal",
        access: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
        api: { type: "openai-chat-completions", baseUrl: "api.z.ai/v1" },
        personalModelIds: ["glm-4.6"],
        modelOrder: ["glm-4.6"],
      },
    };
    writePersonalFixture({
      schemaVersion: 1,
      config: {
        providerOrder: ["22222222-3333-4444-5555-666666666666"],
        providerConfigRules: { providerRules: [zhipuRule] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
        defaultModelSelection: {
          providerId: "22222222-3333-4444-5555-666666666666",
          modelId: "glm-4.6",
          options: { reasoningLevel: "thinking" },
        },
      },
    });
    writeConfigFixture({ provider: {} });

    const res = await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6"] });
    expect(res.status).toBe(200);
    expect(res.body.personalConfig.applied).toEqual(["cx/gpt-5.6"]);

    const doc = readPersonalFile();
    expect(doc.config.providerConfigRules.providerRules[0]).toEqual(zhipuRule);
    expect(doc.config.defaultModelSelection.options).toEqual({ reasoningLevel: "thinking" });
    expect(doc.config.providerOrder).toEqual([
      "22222222-3333-4444-5555-666666666666",
      entryKeyOf(readConfigFile()),
    ]);
  });

  it("POST reports manual overrides and leaves the manual rule in charge", async () => {
    writeConfigFixture({ provider: {} });
    const first = await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6", "zai/glm-5.3"] });
    expect(first.status).toBe(200);
    const entryKey = entryKeyOf(readConfigFile());

    // The user tunes one model by hand inside ZCode: ZCode moves the
    // rule from providerModelRules to manualProviderModelRules (the
    // same id in both lists would be a schema error).
    const doc = readPersonalFile();
    doc.config.modelConfigRules.providerModelRules =
      doc.config.modelConfigRules.providerModelRules.filter((r) => r.modelId !== "zai/glm-5.3");
    doc.config.modelConfigRules.manualProviderModelRules.push({
      providerId: entryKey,
      modelId: "zai/glm-5.3",
      config: {
        properties: { contextWindow: 424242 },
        optionSpecs: { reasoningLevel: { values: ["user", "choice"] } },
      },
    });
    writePersonalFixture(doc);

    const second = await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6", "zai/glm-5.3"] });
    expect(second.status).toBe(200);
    expect(second.body.personalConfig.applied).toEqual(["cx/gpt-5.6"]);
    expect(second.body.personalConfig.manualOverrides).toEqual(["zai/glm-5.3"]);

    const after = readPersonalFile();
    const manual = after.config.modelConfigRules.manualProviderModelRules[0];
    expect(manual.config.properties.contextWindow).toBe(424242);
    expect(manual.config.optionSpecs.reasoningLevel.values).toEqual(["user", "choice"]);
    // No smart rule for the manual model; the other model's rule remains.
    expect(after.config.modelConfigRules.providerModelRules.map((r) => r.modelId)).toEqual(["cx/gpt-5.6"]);
  });

  it("POST returns 409 and writes nothing when provider_config.json is corrupt", async () => {
    writeConfigFixture({ provider: {} });
    fs.mkdirSync(path.dirname(personalPath()), { recursive: true });
    fs.writeFileSync(personalPath(), "{corrupt");

    const res = await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6"] });
    expect(res.status).toBe(409);
    // Neither file was touched.
    expect(fs.readFileSync(personalPath(), "utf-8")).toBe("{corrupt");
    expect(readConfigFile()).toEqual({ provider: {} });
    expect(fs.readdirSync(path.dirname(configPath())).some((f) => f.startsWith("config.json.bak-"))).toBe(false);
  });

  it("DELETE removes owned models from the Personal layer and drops the empty provider", async () => {
    writeConfigFixture({ provider: {} });
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6", "zai/glm-5.3"] });
    expect(readPersonalFile().config.modelConfigRules.providerModelRules).toHaveLength(2);

    const res = await del(null);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(2);
    expect(res.body.entryRemoved).toBe(true);
    expect(res.body.personalConfig.providerRemoved).toBe(true);

    const doc = readPersonalFile();
    expect(doc.config.providerConfigRules.providerRules).toEqual([]);
    expect(doc.config.providerOrder).toEqual([]);
    expect(doc.config.modelConfigRules.providerModelRules).toEqual([]);
  });

  it("DELETE single model removes only that model from the Personal layer", async () => {
    writeConfigFixture({ provider: {} });
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6", "zai/glm-5.3"] });

    const res = await del("zai/glm-5.3");
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect(res.body.personalConfig.removed).toEqual(["zai/glm-5.3"]);
    expect(res.body.personalConfig.providerRemoved).toBe(false);

    const doc = readPersonalFile();
    const rule = doc.config.providerConfigRules.providerRules[0];
    expect(rule.config.personalModelIds).toEqual(["cx/gpt-5.6"]);
    expect(doc.config.modelConfigRules.providerModelRules.map((r) => r.modelId)).toEqual(["cx/gpt-5.6"]);
  });

  it("DELETE never touches manual rules in the Personal layer", async () => {
    writeConfigFixture({ provider: {} });
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cx/gpt-5.6"] });
    const entryKey = entryKeyOf(readConfigFile());

    const doc = readPersonalFile();
    doc.config.modelConfigRules.manualProviderModelRules.push({
      providerId: entryKey,
      modelId: "cx/gpt-5.6",
      config: { optionSpecs: { reasoningLevel: { values: ["user"] } } },
    });
    // Remove the smart rule so only the manual one remains.
    doc.config.modelConfigRules.providerModelRules = [];
    writePersonalFixture(doc);

    const res = await del("cx/gpt-5.6");
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);

    // The manual rule itself is preserved (the provider rule is gone
    // from config.json, but ZCode's manual layer is the user's).
    const after = readPersonalFile();
    expect(after.config.modelConfigRules.manualProviderModelRules).toHaveLength(1);
  });
});
