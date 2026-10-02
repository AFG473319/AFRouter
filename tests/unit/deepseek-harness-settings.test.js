/**
 * Unit tests for the DeepSeek Harness (dsh) integrations.
 *
 * dsh composes per Cordis profile and each profile owns its own
 * `$DSH_HOME/profiles/<name>/cordis.patch.yml`; the legacy `$DSH_HOME/settings.yaml`
 * is imported ONCE and then renamed, so it is NOT the live surface any more.
 * These tests pin that: every write must land in the right profile's patch.
 *
 * Covers:
 *  - the CLI card writes the `web` profile; the Desktop card writes `desktop`
 *  - GET never 500s on missing/corrupt config (SC-004)
 *  - POST writes llm-pi-ai.providers.afrouter + refs.AFROUTER_API_KEY
 *  - POST preserves other providers and other config keys in the same row
 *    (a patch replaces the row's whole config — the writer must rebuild it)
 *  - POST merges models additively without duplicating ids
 *  - input/reasoningEfforts declared only when the catalog says so (FR-006)
 *  - the default-model pin is opt-in, and Reset only clears it while it points
 *    at afrouter
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

const web = await import("../../src/app/api/cli-tools/deepseek-harness-settings/route.js");
const desktop = await import("../../src/app/api/cli-tools/deepseek-harness-desktop-settings/route.js");

const profilesDir = () => path.join(state.home, "profiles");
const patchPath = (profile) => path.join(profilesDir(), profile, "cordis.patch.yml");
const credentialsPath = () => path.join(state.home, ".credentials.yaml");

function writePatch(profile, patchList) {
  fs.mkdirSync(path.dirname(patchPath(profile)), { recursive: true });
  // JSON is valid YAML, so this exercises the same parse path.
  fs.writeFileSync(patchPath(profile), JSON.stringify(patchList, null, 2));
}

function readPatch(profile) {
  return parseYAML(fs.readFileSync(patchPath(profile), "utf-8"));
}

function readRoute(profile = "web") {
  const row = readPatch(profile).find((r) => r.id === "llm-pi-ai");
  return row?.config?.providers?.afrouter;
}

function readDefaultRow(profile = "web") {
  return readPatch(profile).find((r) => r.id === "agent-default-model");
}

function readCredentials() {
  return parseYAML(fs.readFileSync(credentialsPath(), "utf-8"));
}

function post(handlers, body) {
  return handlers.POST({ json: async () => body });
}

function del(handlers, model) {
  return handlers.DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
  process.env.DSH_HOME = state.home;
});

afterAll(() => {
  delete process.env.DSH_HOME;
});

describe("profile targeting", () => {
  it("writes the web profile from the CLI card and never the desktop one", async () => {
    const res = await post(web, {
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-4-5"],
    });
    expect(res.body.success).toBe(true);
    expect(res.body.profile).toBe("web");
    expect(readRoute("web")).toBeTruthy();
    expect(fs.existsSync(patchPath("desktop"))).toBe(false);
  });

  it("writes the desktop profile from the Desktop card", async () => {
    const res = await post(desktop, {
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-4-5"],
    });
    expect(res.body.profile).toBe("desktop");
    expect(readRoute("desktop")).toBeTruthy();
    expect(fs.existsSync(patchPath("web"))).toBe(false);
  });

  it("keeps each profile's config independent", async () => {
    await post(web, { baseUrl: "http://a", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post(desktop, { baseUrl: "http://b", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });

    expect(readRoute("web").baseURL).toBe("http://a/v1");
    expect(readRoute("web").models.map((m) => m.id)).toEqual(["cc/claude-sonnet-4-5"]);
    expect(readRoute("desktop").baseURL).toBe("http://b/v1");
    expect(readRoute("desktop").models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("shares one credential store between profiles", async () => {
    await post(web, { baseUrl: "http://x", apiKey: "sk_shared", models: ["cc/claude-sonnet-4-5"] });
    await post(desktop, { baseUrl: "http://x", apiKey: "sk_shared", models: ["cc/claude-sonnet-4-5"] });
    expect(readCredentials().refs.AFROUTER_API_KEY).toBe("sk_shared");
  });
});

describe("GET", () => {
  it("reports not-installed without throwing when nothing exists", async () => {
    delete process.env.DSH_HOME;
    state.home = path.join(os.tmpdir(), `dsh-missing-${Date.now()}`);
    const res = await web.GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
    expect(res.body.harness).toBeNull();
  });

  it("never 500s on a patch file that is not a top-level array", async () => {
    fs.mkdirSync(path.dirname(patchPath("web")), { recursive: true });
    // dsh rejects a non-array ("config file must be a top-level array of entries").
    fs.writeFileSync(patchPath("web"), "llm-pi-ai: [unclosed\n");
    const res = await web.GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.corrupt).toBe(true);
    expect(res.body.harness).toBeNull();
  });

  it("reports configured status and never leaks the credential value", async () => {
    writePatch("web", [
      {
        id: "llm-pi-ai",
        config: {
          providers: {
            afrouter: { api: "openai-completions", baseURL: "http://127.0.0.1:20128/v1", models: [{ id: "a/b" }] },
          },
        },
      },
    ]);
    fs.writeFileSync(credentialsPath(), "version: 1\nrefs:\n  AFROUTER_API_KEY: sk_secret\n");
    const res = await web.GET();
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.harness.models).toEqual(["a/b"]);
    expect(res.body.harness.hasCredential).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain("sk_secret");
  });

  it("flags a legacy imported settings.yaml", async () => {
    fs.mkdirSync(state.home, { recursive: true });
    fs.writeFileSync(path.join(state.home, "settings.yaml.imported"), "llm-pi-ai: {}\n");
    writePatch("web", []);
    const res = await web.GET();
    expect(res.body.legacyImported).toBe(true);
    expect(res.body.hasAFRouter).toBe(false);
  });

  // Layer order is bundles -> profile patch -> $DSH_HOME/cordis.patch.yml, and a
  // patch replaces a row's whole config. A home-level `llm-pi-ai` row therefore
  // erases the profile row's providers, so Apply would silently do nothing.
  it("detects a home-level cordis.patch.yml that shadows the profile row", async () => {
    fs.mkdirSync(state.home, { recursive: true });
    fs.writeFileSync(
      path.join(state.home, "cordis.patch.yml"),
      JSON.stringify([{ id: "llm-pi-ai", config: { providers: { other: {} } } }]),
    );
    writePatch("web", []);
    const res = await web.GET();
    expect(res.body.homePatchShadows).toBe(true);
  });

  it("does not flag a home patch without an llm-pi-ai row", async () => {
    fs.mkdirSync(state.home, { recursive: true });
    fs.writeFileSync(
      path.join(state.home, "cordis.patch.yml"),
      JSON.stringify([{ id: "ui-chat", config: {} }]),
    );
    writePatch("web", []);
    const res = await web.GET();
    expect(res.body.homePatchShadows).toBe(false);
  });

  it("does not flag a missing home patch", async () => {
    writePatch("web", []);
    const res = await web.GET();
    expect(res.body.homePatchShadows).toBe(false);
  });
});

describe("POST", () => {
  it("creates the afrouter route and the credential ref", async () => {
    const res = await post(web, {
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-4-5"],
    });
    expect(res.body.success).toBe(true);
    expect(res.body.written).toEqual(["cc/claude-sonnet-4-5"]);

    const route = readRoute("web");
    expect(route.api).toBe("openai-completions");
    expect(route.baseURL).toBe("http://127.0.0.1:20128/v1");
    expect(route.apiKeyEnv).toBe("AFROUTER_API_KEY");
    expect(route.displayName).toBe("AFRouter");
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
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });
    const route = readRoute("web");
    expect(route.models[0].reasoningEfforts.high).toBe("high");
    expect(route.models[0].input).toBeUndefined();
  });

  it("declares per-model compat only when the thinking toggle is on", async () => {
    await post(web, {
      baseUrl: "http://x",
      apiKey: "k",
      models: ["deepseek/deepseek-v4-pro"],
      compat: { thinkingFormat: "deepseek" },
    });
    expect(readRoute("web").compat.thinkingFormat).toBe("deepseek");
    expect(readRoute("web").models[0].compat.thinkingFormat).toBe("deepseek");
  });

  it("preserves another provider and other config keys in the same row", async () => {
    // A patch replaces the row's entire config, so the writer must rebuild it.
    writePatch("web", [
      { id: "agent-default-model", config: { provider: "deepseek-account", model: "deepseek-flash" } },
      {
        id: "llm-pi-ai",
        config: {
          defaultContextWindow: 262144,
          providers: { anthropic: { baseURL: "https://api.anthropic.com" } },
        },
      },
    ]);

    await post(web, { baseUrl: "http://127.0.0.1:20128", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });

    const patch = readPatch("web");
    const row = patch.find((r) => r.id === "llm-pi-ai");
    expect(row.config.defaultContextWindow).toBe(262144);
    expect(row.config.providers.anthropic.baseURL).toBe("https://api.anthropic.com");
    expect(row.config.providers.afrouter).toBeTruthy();
    // Rows we do not own are untouched.
    expect(readDefaultRow("web").config.provider).toBe("deepseek-account");
  });

  it("leaves unrelated rows and their order intact", async () => {
    writePatch("web", [
      { id: "ui-chat", config: { transcriptView: "verbose" } },
      { id: "tinyfish-mcp", disabled: false },
    ]);
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });

    const ids = readPatch("web").map((r) => r.id);
    expect(ids.slice(0, 2)).toEqual(["ui-chat", "tinyfish-mcp"]);
    expect(ids).toContain("llm-pi-ai");
  });

  it("merges models additively without duplicating ids", async () => {
    await post(web, { baseUrl: "http://127.0.0.1:20128", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post(web, {
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"],
    });
    expect(readRoute("web").models.map((m) => m.id)).toEqual([
      "cc/claude-sonnet-4-5",
      "deepseek/deepseek-v4-pro",
    ]);
  });

  it("marks unresolvable models unverified without inventing specs", async () => {
    const res = await post(web, { baseUrl: "http://x", apiKey: "k", models: ["unknown/model"] });
    expect(res.body.unverified).toEqual(["unknown/model"]);
    expect(readRoute("web").models[0].contextWindow).toBe(200000);
  });

  it("refuses to write a corrupt patch file and leaves it untouched", async () => {
    fs.mkdirSync(path.dirname(patchPath("web")), { recursive: true });
    const corrupt = "{ not: an array }\n";
    fs.writeFileSync(patchPath("web"), corrupt);
    const res = await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(res.status).toBe(409);
    expect(fs.readFileSync(patchPath("web"), "utf-8")).toBe(corrupt);
  });

  it("400s without baseUrl or models", async () => {
    const res = await post(web, { baseUrl: "", models: [] });
    expect(res.status).toBe(400);
  });

  it("writes a timestamped backup on apply", async () => {
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["deepseek/deepseek-v4-pro"] });
    const backups = fs
      .readdirSync(path.dirname(patchPath("web")))
      .filter((f) => f.startsWith("cordis.patch.yml.bak-"));
    expect(backups.length).toBeGreaterThan(0);
  });
});

describe("default model pin (opt-in)", () => {
  it("does not write the pin when the toggle is absent", async () => {
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    expect(readDefaultRow("web")).toBeUndefined();
  });

  it("writes provider/model/reasoningEffort when enabled", async () => {
    await post(web, {
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
      reasoningEffort: "high",
    });
    const row = readDefaultRow("web");
    expect(row.config).toEqual({ provider: "afrouter", model: "cc/claude-sonnet-4-5", reasoningEffort: "high" });
  });

  it("omits reasoningEffort rather than nulling it", async () => {
    await post(web, {
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
    });
    expect(readDefaultRow("web").config.reasoningEffort).toBeUndefined();
    expect(Object.keys(readDefaultRow("web").config)).toEqual(["provider", "model"]);
  });

  it("reports the pin through GET", async () => {
    await post(web, {
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
      reasoningEffort: "medium",
    });
    const res = await web.GET();
    expect(res.body.harness.defaultModel).toBe("cc/claude-sonnet-4-5");
    expect(res.body.harness.defaultReasoningEffort).toBe("medium");
  });

  it("does not report a pin that points at another provider", async () => {
    writePatch("web", [{ id: "agent-default-model", config: { provider: "deepseek-account", model: "deepseek-flash" } }]);
    const res = await web.GET();
    expect(res.body.harness.defaultModel).toBeNull();
  });

  it("explicit setDefault:false only clears a pin that points at afrouter", async () => {
    writePatch("web", [
      { id: "agent-default-model", config: { provider: "deepseek-account", model: "deepseek-flash" } },
    ]);
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"], setDefault: false });
    expect(readDefaultRow("web").config.provider).toBe("deepseek-account");
  });
});

describe("DELETE", () => {
  it("removes the route and a default credential ref", async () => {
    await post(web, { baseUrl: "http://x", apiKey: "sk_afrouter", models: ["cc/claude-sonnet-4-5"] });
    const res = await del(web);
    expect(res.body.entryRemoved).toBe(true);
    expect(readPatch("web").find((r) => r.id === "llm-pi-ai")).toBeUndefined();
    expect(readCredentials().refs?.AFROUTER_API_KEY).toBeUndefined();
  });

  it("preserves a real user key on reset (D4)", async () => {
    await post(web, { baseUrl: "http://x", apiKey: "sk_real_dashboard_key", models: ["cc/claude-sonnet-4-5"] });
    await del(web);
    expect(readCredentials().refs.AFROUTER_API_KEY).toBe("sk_real_dashboard_key");
  });

  it("keeps the row when another provider still lives in it", async () => {
    writePatch("web", [{ id: "llm-pi-ai", config: { providers: { anthropic: { baseURL: "https://api.anthropic.com" } } } }]);
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await del(web);

    const row = readPatch("web").find((r) => r.id === "llm-pi-ai");
    expect(row).toBeTruthy();
    expect(row.config.providers.afrouter).toBeUndefined();
    expect(row.config.providers.anthropic.baseURL).toBe("https://api.anthropic.com");
  });

  it("clears a default pin that points at afrouter", async () => {
    await post(web, {
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5"],
      setDefault: true,
    });
    const res = await del(web);
    expect(res.body.defaultCleared).toBe(true);
    expect(readDefaultRow("web")).toBeUndefined();
  });

  it("removes one model and keeps the rest", async () => {
    await post(web, {
      baseUrl: "http://x",
      apiKey: "k",
      models: ["cc/claude-sonnet-4-5", "deepseek/deepseek-v4-pro"],
    });
    const res = await del(web, "cc/claude-sonnet-4-5");
    expect(res.body.removed).toBe(1);
    expect(readRoute("web").models.map((m) => m.id)).toEqual(["deepseek/deepseek-v4-pro"]);
  });

  it("removes the route when the last model is removed", async () => {
    await post(web, { baseUrl: "http://x", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    const res = await del(web, "cc/claude-sonnet-4-5");
    expect(res.body.entryRemoved).toBe(true);
    expect(readPatch("web").find((r) => r.id === "llm-pi-ai")).toBeUndefined();
  });

  it("is idempotent when nothing is configured", async () => {
    const res = await del(web);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("never touches the other profile", async () => {
    await post(web, { baseUrl: "http://a", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });
    await post(desktop, { baseUrl: "http://b", apiKey: "k", models: ["cc/claude-sonnet-4-5"] });

    await del(desktop);
    expect(readRoute("web")).toBeTruthy();
    expect(readRoute("desktop")).toBeUndefined();
  });
});
