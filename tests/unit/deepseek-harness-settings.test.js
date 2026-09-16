/**
 * Unit tests for /api/cli-tools/deepseek-harness-settings (DeepSeek Harness integration).
 *
 * Covers the destructive config-write paths against a temp DSH_HOME:
 *  - GET never 500s on missing/corrupt settings (SC-004)
 *  - POST writes llm-pi-ai.providers.afrouter + refs.AFROUTER_API_KEY
 *  - POST preserves unrelated settings sections and other providers (FR-005)
 *  - POST merges models additively without duplicating ids
 *  - input/reasoningEfforts declared only when the catalog says so (FR-006)
 *  - DELETE removes the route; the credential ref goes only when it is the default (D4)
 *  - DELETE ?model= removes one model and deletes the route when it empties
 *
 * DSH_HOME and os.homedir are redirected to per-test temp dirs; global.fetch is
 * rejected so spec resolution takes the deterministic static-registry path.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYAML } from "confbox/yaml";

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

// Only ids in this table resolve.
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

const { GET, POST, DELETE } = await import(
  "../../src/app/api/cli-tools/deepseek-harness-settings/route.js"
);

const settingsPath = () => path.join(state.home, "settings.yaml");
const credentialsPath = () => path.join(state.home, ".credentials.yaml");

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(obj));
}

function readSettings() {
  return parseYAML(fs.readFileSync(settingsPath(), "utf-8"));
}

function readCredentials() {
  return parseYAML(fs.readFileSync(credentialsPath(), "utf-8"));
}

function post(body) {
  return POST({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  // The route resolves paths from DSH_HOME (honoring it over ~/.dsh), so point
  // it at the per-test temp dir.
  process.env.DSH_HOME = state.home;
});

afterAll(() => {
  delete process.env.DSH_HOME;
});

describe("GET", () => {
  it("reports not-installed without throwing when the home and dsh binary are absent", async () => {
    delete process.env.DSH_HOME;
    state.home = path.join(os.tmpdir(), `dsh-missing-${Date.now()}`);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.harness).toBeNull();
  });

  it("never 500s on corrupt settings.yaml", async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), "llm-pi-ai: [unclosed\n");
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.corrupt).toBe(true);
    expect(res.body.harness).toBeNull();
  });

  it("reports configured status and never leaks the credential value", async () => {
    writeSettings({
      "llm-pi-ai": {
        providers: {
          afrouter: { api: "openai-completions", baseURL: "http://127.0.0.1:20128/v1", models: [{ id: "a/b" }] },
        },
      },
    });
    fs.writeFileSync(credentialsPath(), "version: 1\nrefs:\n  AFROUTER_API_KEY: sk_secret\n");
    const res = await GET();
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.harness.models).toEqual(["a/b"]);
    expect(res.body.harness.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk_secret");
  });
});

describe("POST", () => {
  it("creates the afrouter route and the credential ref", async () => {
    const res = await post({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-4-5"],
    });
    expect(res.body.success).toBe(true);
    expect(res.body.written).toEqual(["cc/claude-sonnet-4-5"]);

    const settings = readSettings();
    const route = settings["llm-pi-ai"].providers.afrouter;
    expect(route.api).toBe("openai-completions");
    expect(route.baseURL).toBe("http://127.0.0.1:20128/v1");
    expect(route.apiKeyEnv).toBe("AFROUTER_API_KEY");
    expect(route.models[0].id).toBe("cc/claude-sonnet-4-5");
    expect(route.models[0].contextWindow).toBe(200000);
    expect(route.models[0].maxTokens).toBe(64000);
    // vision model -> input declared; non-reasoning -> no reasoningEfforts
    expect(route.models[0].input).toEqual(["text", "image"]);
    expect(route.models[0].reasoningEfforts).toBeUndefined();

    const creds = readCredentials();
    expect(creds.version).toBe(1);
    expect(creds.refs.AFROUTER_API_KEY).toBe("sk_afrouter");
  });

  it("declares reasoningEfforts only for reasoning models", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });
    const route = readSettings()["llm-pi-ai"].providers.afrouter;
    expect(route.models[0].reasoningEfforts.high).toBe("high");
    expect(route.models[0].input).toBeUndefined();
  });

  it("preserves unrelated sections and other providers", async () => {
    writeSettings({
      "llm-deepseek": { reasoningEffort: "max" },
      "llm-pi-ai": { providers: { anthropic: { baseURL: "https://api.anthropic.com" } } },
    });
    await post({ baseUrl: "http://127.0.0.1:20128", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const settings = readSettings();
    expect(settings["llm-deepseek"].reasoningEffort).toBe("max");
    expect(settings["llm-pi-ai"].providers.anthropic.baseURL).toBe("https://api.anthropic.com");
    expect(settings["llm-pi-ai"].providers.afrouter).toBeTruthy();
  });

  it("merges models additively without duplicating ids", async () => {
    await post({ baseUrl: "http://127.0.0.1:20128", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"],
    });
    const route = readSettings()["llm-pi-ai"].providers.afrouter;
    expect(route.models.map((m) => m.id)).toEqual(["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"]);
  });

  it("marks unresolvable models unverified without inventing specs", async () => {
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["unknown/model"] });
    expect(res.body.unverified).toEqual(["unknown/model"]);
    const route = readSettings()["llm-pi-ai"].providers.afrouter;
    expect(route.models[0].contextWindow).toBe(200000);
  });

  it("refuses to write corrupt settings and leaves the file untouched", async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), "llm-pi-ai: [unclosed\n");
    const before = fs.readFileSync(settingsPath(), "utf-8");
    const res = await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("400s without baseUrl or models", async () => {
    const res = await post({ baseUrl: "", models: [] });
    expect(res.status).toBe(400);
  });

  it("writes a timestamped backup on apply", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post({ baseUrl: "http://x", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });
    const backups = fs.readdirSync(state.home).filter((f) => f.startsWith("settings.yaml.bak-"));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe("DELETE", () => {
  it("removes the route and a default credential ref", async () => {
    await post({ baseUrl: "http://x", apiKey: "sk_afrouter", models: ["cc/claude-sonnet-4-5"] });
    const res = await del();
    expect(res.body.entryRemoved).toBe(true);
    const settings = readSettings();
    expect(settings["llm-pi-ai"]).toBeUndefined();
    expect(readCredentials().refs?.AFROUTER_API_KEY).toBeUndefined();
  });

  it("preserves a real user key on reset (D4)", async () => {
    await post({ baseUrl: "http://x", apiKey: "sk_real_dashboard_key", models: ["cc/claude-sonnet-4-5"] });
    await del();
    expect(readCredentials().refs.AFROUTER_API_KEY).toBe("sk_real_dashboard_key");
  });

  it("removes one model and keeps the rest", async () => {
    await post({
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"],
    });
    const res = await del("cc/claude-sonnet-4-5");
    expect(res.body.removed).toBe(1);
    const route = readSettings()["llm-pi-ai"].providers.afrouter;
    expect(route.models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("removes the route when the last model is removed", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const res = await del("cc/claude-sonnet-4-5");
    expect(res.body.entryRemoved).toBe(true);
    expect(readSettings()["llm-pi-ai"]).toBeUndefined();
  });

  it("is idempotent when nothing is configured", async () => {
    const res = await del();
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
