/**
 * Unit tests for /api/cli-tools/zcode-settings (ZCode integration).
 *
 * Covers the destructive config-write paths against a temp "home" dir:
 *  - GET never 500s on missing/corrupt config (SC-004)
 *  - POST creates the AFRouter entry (UUID key) and records ownership in the
 *    ~/.afrouter ledger as well as stamping the in-config marker
 *  - POST refresh preserves user-tuned fields (variants/name/priority, FR-005)
 *  - DELETE is ownership-scoped: user-added models survive (FR-008)
 *  - DELETE removes the whole entry only when its models map empties
 *  - Ownership survives ZCode rewriting config.json without the marker — the
 *    regression this suite exists to pin down.
 *
 * os.homedir and DATA_DIR are redirected to per-test temp dirs; global.fetch is
 * rejected so spec resolution takes the deterministic static-registry path.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Only ids in this table resolve; everything else returns NaN so it takes the
// conservative-fallback path. Drives both the FR-006 badge and the bootstrap
// ownership pass (a resolvable model inside the AFRouter entry is ours).
const RESOLVABLE = new Set([
  "cl/z-ai/glm-5.3-flash",
  "oc/mimo-v2.5-free",
]);

vi.mock("open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: (provider, model) => {
    const key = provider ? `${provider}/${model}` : model;
    return RESOLVABLE.has(key)
      ? { contextWindow: 1000000, maxOutput: 131072, reasoning: true, vision: false }
      : { contextWindow: Number.NaN, maxOutput: Number.NaN };
  },
}));

// Reject every fetch so the live catalog is unavailable (deterministic).
const realFetch = global.fetch;
global.fetch = () => Promise.reject(new Error("offline test"));

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/zcode-settings/route.js");

const configPath = () => path.join(state.home, ".zcode", "v2", "config.json");
const ledgerPath = () => path.join(state.dataDir, "zcode-model-ownership.json");

function writeFixture(obj) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

function readConfigFile() {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

function readLedger() {
  try {
    return JSON.parse(fs.readFileSync(ledgerPath(), "utf-8"));
  } catch {
    return {};
  }
}

function findEntry(config) {
  return Object.values(config.provider).find((v) => v.name === "AFRouter" && v.source === "custom");
}

function post(body) {
  return POST({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

function writeFixtureRaw(text) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), text);
}

// The AFRouter entry as ZCode leaves it after a restart: every model entry
// rebuilt from ZCode's own key list, so our `afrouter` marker is gone.
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
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-settings-test-"));
  state.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcode-data-test-"));
  process.env.DATA_DIR = state.dataDir;
});

afterAll(() => {
  global.fetch = realFetch;
  delete process.env.DATA_DIR;
  state.home = null;
  state.dataDir = null;
});

describe("GET /api/cli-tools/zcode-settings", () => {
  it("returns installed:false (never 500) when the config file is missing", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.zcode).toBeNull();
  });

  it("returns corrupt:true (never 500) when the config file is invalid JSON", async () => {
    writeFixtureRaw("{not json");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.corrupt).toBe(true);
    expect(res.body.zcode).toBeNull();
  });

  it("separates AFRouter-managed models from user-added ones", async () => {
    writeFixture(
      entryFixture({
        "mine/hand-added": { zcode: { modalitiesConfigured: true } },
        "cl/z-ai/glm-5.3-flash": { zcode: { modalitiesConfigured: true } },
      })
    );
    const res = await GET();
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.zcode.models).toHaveLength(2);
    // No ledger yet: bootstrap claims the resolvable id, leaves the unknown one.
    expect(res.body.zcode.afrouterModels).toEqual(["cl/z-ai/glm-5.3-flash"]);
    expect(res.body.ambiguousEntry).toBe(false);
  });

  it("keeps claiming models whose marker ZCode stripped once the ledger exists", async () => {
    writeFixture(entryFixture({ "cl/z-ai/glm-5.3-flash": { zcode: { modalitiesConfigured: true } } }));
    const ledger = readLedger();
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ ...ledger, [configPath()]: { models: ["cl/z-ai/glm-5.3-flash"], updatedAt: "x" } })
    );
    const res = await GET();
    expect(res.body.zcode.afrouterModels).toEqual(["cl/z-ai/glm-5.3-flash"]);
  });

  it("does not claim a model the ledger says the user added after removal", async () => {
    // Resolvable id, but the ledger explicitly records that we own nothing —
    // the authoritative case must beat the bootstrap heuristic.
    writeFixture(entryFixture({ "cl/z-ai/glm-5.3-flash": {} }));
    fs.writeFileSync(ledgerPath(), JSON.stringify({ [configPath()]: { models: [], updatedAt: "x" } }));
    const res = await GET();
    expect(res.body.zcode.afrouterModels).toEqual([]);
  });
});

describe("POST /api/cli-tools/zcode-settings", () => {
  it("rejects missing baseUrl or models with 400", async () => {
    const res = await post({ baseUrl: "", models: [] });
    expect(res.status).toBe(400);
  });

  it("creates the entry under a fresh UUID key with marker + fallback specs, never touching other providers", async () => {
    writeFixture({ provider: { "builtin:zai": { name: "Z.ai - Coding Plan", source: "builtin" } } });
    const res = await post({ baseUrl: "http://localhost:20128", apiKey: "sk_x", models: ["unknown/model-x"] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.unverified).toEqual(["unknown/model-x"]);

    const cfg = readConfigFile();
    const keys = Object.keys(cfg.provider);
    expect(keys).toContain("builtin:zai");
    const entryKey = keys.find((k) => cfg.provider[k].name === "AFRouter" && cfg.provider[k].source === "custom");
    expect(entryKey).toMatch(/^[0-9a-f-]{36}$/);
    const entry = cfg.provider[entryKey];
    expect(entry.kind).toBe("openai-compatible");
    expect(entry.options.baseURL).toBe("http://localhost:20128/v1");
    const m = entry.models["unknown/model-x"];
    expect(m.limit).toEqual({ context: 200000, output: 32000 });
    expect(m.modalities).toEqual({ input: ["text"], output: ["text"] });
    expect(m.reasoning).toBeUndefined();
    expect(m.zcode.afrouter).toBe(true);
  });

  it("records applied models in the ~/.afrouter ledger (survives config rewrites)", async () => {
    writeFixture({ provider: {} });
    await post({ baseUrl: "http://localhost:20128/v1", models: ["oc/mimo-v2.5-free"] });
    expect(readLedger()[configPath()].models).toEqual(["oc/mimo-v2.5-free"]);
  });

  it("omits the reasoning block for models without reasoning support", async () => {
    writeFixture({ provider: {} });
    await post({ baseUrl: "http://localhost:20128/v1", models: ["unknown/no-reasoning-model"] });
    const cfg = readConfigFile();
    expect(findEntry(cfg).models["unknown/no-reasoning-model"].reasoning).toBeUndefined();
  });

  it("refreshes limit/modalities of an existing model but preserves variants/name/priority (FR-005)", async () => {
    writeFixture({
      provider: {
        existing: {
          name: "AFRouter",
          source: "custom",
          kind: "openai-compatible",
          options: { apiKey: "old", baseURL: "http://old:1/v1" },
          models: {
            "cl/z-ai/glm-5.3-flash": {
              name: "My GLM",
              reasoning: { enabled: true, variants: ["enabled", "off"], defaultVariant: "enabled" },
              limit: { context: 1, output: 2 },
              modalities: { input: ["text"], output: ["text"] },
              zcode: { modalitiesConfigured: true, afrouter: true, priority: 100 },
            },
          },
        },
      },
    });
    const res = await post({ baseUrl: "http://localhost:20128/v1", models: ["cl/z-ai/glm-5.3-flash"] });
    expect(res.status).toBe(200);
    const cfg = readConfigFile();
    const entry = findEntry(cfg);
    const m = entry.models["cl/z-ai/glm-5.3-flash"];
    expect(m.name).toBe("My GLM");
    expect(m.reasoning.variants).toEqual(["enabled", "off"]);
    expect(m.reasoning.defaultVariant).toBe("enabled");
    expect(m.zcode.priority).toBe(100);
    expect(m.limit.output).toBe(131072);
    expect(entry.options.baseURL).toBe("http://localhost:20128/v1");
  });

  it("preserves pre-existing user-added models byte-identical (FR-004)", async () => {
    const userModel = { limit: { context: 999, output: 9 }, modalities: { input: ["text"], output: ["text"] } };
    writeFixture({
      provider: {
        existing: {
          name: "AFRouter",
          source: "custom",
          kind: "openai-compatible",
          options: { apiKey: "k", baseURL: "http://x/v1" },
          models: { "mine/hand-added": userModel },
        },
      },
    });
    await post({ baseUrl: "http://x/v1", models: ["unknown/new-model"] });
    const cfg = readConfigFile();
    expect(findEntry(cfg).models["mine/hand-added"]).toEqual(userModel);
  });

  it("does not claim an unresolvable pre-existing model when applying", async () => {
    writeFixture(entryFixture({ "mine/hand-added": { zcode: {} } }));
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["unknown/new-model"] });
    expect(readLedger()[configPath()].models).toEqual(["unknown/new-model"]);
  });

  it("refuses to write when the config is corrupt (file untouched)", async () => {
    writeFixtureRaw("{corrupt");
    const res = await post({ baseUrl: "http://x/v1", models: ["m"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("{corrupt");
  });
});

describe("DELETE /api/cli-tools/zcode-settings", () => {
  function deleteFixture() {
    return entryFixture({
      "af/one": { zcode: { afrouter: true } },
      "af/two": { zcode: { afrouter: true } },
      "mine/keep": { zcode: { modalitiesConfigured: true } },
    });
  }

  it("removes only AFRouter-owned models; user-added survive (FR-008)", async () => {
    writeFixture(deleteFixture());
    const res = await del(null);
    expect(res.body.removed).toBe(2);
    expect(res.body.entryRemoved).toBe(false);
    const entry = findEntry(readConfigFile());
    expect(Object.keys(entry.models)).toEqual(["mine/keep"]);
  });

  it("removes marker-stripped models that the ledger still records as ours", async () => {
    // ZCode already rewrote the config: no markers anywhere, no "af/" tail.
    writeFixture(entryFixture({ "cl/z-ai/glm-5.3-flash": { zcode: { modalitiesConfigured: true } } }));
    fs.writeFileSync(
      ledgerPath(),
      JSON.stringify({ [configPath()]: { models: ["cl/z-ai/glm-5.3-flash"], updatedAt: "x" } })
    );
    const res = await del(null);
    expect(res.body.removed).toBe(1);
    expect(res.body.entryRemoved).toBe(true);
    expect(findEntry(readConfigFile())).toBeUndefined();
  });

  it("single-model delete is idempotent for user-added models (removed: 0)", async () => {
    writeFixture(deleteFixture());
    const res = await del("mine/keep");
    expect(res.body.removed).toBe(0);
    expect(findEntry(readConfigFile()).models["mine/keep"]).toBeDefined();
  });

  it("removes a single owned model and drops it from the ledger", async () => {
    writeFixture(entryFixture({ "cl/z-ai/glm-5.3-flash": {}, "oc/mimo-v2.5-free": {} }));
    await post({ baseUrl: "http://127.0.0.1:20128/v1", models: ["cl/z-ai/glm-5.3-flash", "oc/mimo-v2.5-free"] });
    const res = await del("oc/mimo-v2.5-free");
    expect(res.body.removed).toBe(1);
    expect(readLedger()[configPath()].models).toEqual(["cl/z-ai/glm-5.3-flash"]);
    expect(Object.keys(findEntry(readConfigFile()).models)).toEqual(["cl/z-ai/glm-5.3-flash"]);
  });

  it("removes the entry only when its models map becomes empty", async () => {
    const f = deleteFixture();
    f.provider.e1.models = { "af/only": { zcode: { afrouter: true } } };
    writeFixture(f);
    const res = await del(null);
    expect(res.body.entryRemoved).toBe(true);
    expect(findEntry(readConfigFile())).toBeUndefined();
  });

  it("is a no-op success when there is no AFRouter entry", async () => {
    writeFixture({ provider: {} });
    const res = await del(null);
    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(0);
  });

  it("writes a timestamped backup next to the config before each write", async () => {
    writeFixture(deleteFixture());
    await del(null);
    const siblings = fs.readdirSync(path.dirname(configPath()));
    expect(siblings.some((f) => /^config\.json\.bak-\d{8}-\d{6}$/.test(f))).toBe(true);
  });
});
