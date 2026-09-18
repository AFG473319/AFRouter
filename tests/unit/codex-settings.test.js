import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseTOML } from "confbox";

vi.mock("../../src/app/api/models/route.js", () => ({ GET: async () => Response.json({ models: [
  { fullModel: "test/alpha", name: "Alpha", caps: { contextWindow: 64000, maxOutput: 4096, vision: true, reasoning: false } },
  { fullModel: "test/beta", name: "Beta", caps: { contextWindow: 128000, maxOutput: 8192, vision: false, reasoning: true } },
  { fullModel: "nous/stealth/union-alpha", name: "stealth/union-alpha", caps: { contextWindow: 200000, maxOutput: 64000, vision: true, reasoning: true, reasoningEfforts: [] } },
] }) }));

import { POST, GET, DELETE } from "../../src/app/api/cli-tools/codex-settings/route.js";
import { buildCodexCatalog, codexProvider, stringifyCodexConfig, normalizeCodexBaseUrl } from "../../src/shared/codexCatalog.js";

let home;
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-codex-integration-"));
  vi.stubEnv("CODEX_HOME", home);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  const resolved = path.resolve(home);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("afrouter-codex-integration-")) throw new Error("Unsafe test cleanup path");
  await fs.rm(resolved, { recursive: true, force: true });
});

const apply = (overrides = {}) => POST(new Request("http://localhost/api/cli-tools/codex-settings", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ baseUrl: "http://127.0.0.1:20128/v1/", apiKey: "test-key", models: ["test/alpha", "test/beta"], activeModel: "test/alpha", ...overrides }),
}));

it("detects config.toml in the default home without CODEX_HOME", async () => {
  vi.stubEnv("CODEX_HOME", "");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  const configDir = path.join(home, ".codex");
  await fs.mkdir(configDir);
  await fs.writeFile(path.join(configDir, "config.toml"), 'model = "test/alpha"\n');
  const response = await GET();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ installed: true, configPath: path.join(configDir, "config.toml") });
});

it("writes a BOM-free multi-model catalog and selects the requested provider and model", async () => {
  expect((await apply({ activeModel: "test/beta" })).status).toBe(200);
  const config = parseTOML(await fs.readFile(path.join(home, "config.toml"), "utf8"));
  expect(config.model_provider).toBe("afrouter");
  expect(config.model).toBe("test/beta");
  expect(config.model_providers.afrouter.wire_api).toBe("responses");
  const raw = await fs.readFile(config.model_catalog_json, "utf8");
  expect(raw.charCodeAt(0)).not.toBe(0xfeff);
  const catalog = JSON.parse(raw);
  expect(catalog.models.map((model) => model.slug)).toEqual(["test/alpha", "test/beta"]);
  expect(catalog.models[0].context_window).toBe(64000);
  expect(catalog.models[0].input_modalities).toEqual(["text", "image"]);
  expect(catalog.models[1].input_modalities).toEqual(["text"]);
  expect(catalog.models[0].experimental_supported_tools).toEqual([]);
  expect(catalog.models[0].supports_parallel_tool_calls).toBe(false);
});

it("preserves unrelated TOML and credentials, redacts status, and restores owned settings", async () => {
  const original = 'model = "original"\nmodel_provider = "other"\nmodel_context_window = 90000\n[agents]\ndefault_subagent_model = "my-agent"\n[model_providers.other]\nname = "Other"\n[profiles.review]\nmodel = "review"\n';
  await fs.writeFile(path.join(home, "config.toml"), original);
  await fs.writeFile(path.join(home, "auth.json"), '{"OPENAI_API_KEY":"private"}');
  expect((await apply()).status).toBe(200);
  const status = await (await GET()).json();
  expect(status.codex.models).toEqual(["test/alpha", "test/beta"]);
  expect(JSON.stringify(status)).not.toMatch(/test-key|private/);
  const saved = parseTOML(await fs.readFile(path.join(home, "config.toml"), "utf8"));
  expect(saved.model_context_window).toBeUndefined();
  expect(saved.model_providers.afrouter.base_url).toBe("http://127.0.0.1:20128/v1");
  expect((await DELETE()).status).toBe(200);
  expect(parseTOML(await fs.readFile(path.join(home, "config.toml"), "utf8"))).toEqual(parseTOML(original));
  expect(await fs.readFile(path.join(home, "auth.json"), "utf8")).toBe('{"OPENAI_API_KEY":"private"}');
  expect((await fs.readdir(home)).some((file) => file.startsWith("config.toml.bak-"))).toBe(true);
});

it("refuses malformed TOML and foreign catalogs without overwriting them", async () => {
  for (const original of ['[broken', 'model_catalog_json = "custom.json"']) {
    await fs.writeFile(path.join(home, "config.toml"), original);
    expect((await apply()).status).toBe(409);
    expect(await fs.readFile(path.join(home, "config.toml"), "utf8")).toBe(original);
  }
});

it("supports additive models and explicit removal while preserving subsequent user edits", async () => {
  expect((await apply()).status).toBe(200);
  expect((await apply({ models: ["test/beta"], activeModel: "test/beta", removeModels: ["test/alpha"] })).status).toBe(200);
  expect((await (await GET()).json()).codex.models).toEqual(["test/beta"]);
  const file = path.join(home, "config.toml");
  await fs.writeFile(file, (await fs.readFile(file, "utf8")).replace('model = "test/beta"', 'model = "user-edit"'));
  expect((await DELETE()).status).toBe(200);
  expect(parseTOML(await fs.readFile(file, "utf8")).model).toBe("user-edit");
});

it("rolls back the catalog and ownership record when the config rename fails", async () => {
  expect((await apply()).status).toBe(200);
  const files = ["config.toml", "afrouter-models.json", "afrouter-integration.json"];
  const before = await Promise.all(files.map((file) => fs.readFile(path.join(home, file), "utf8")));
  const rename = fs.rename.bind(fs);
  const failure = vi.spyOn(fs, "rename").mockImplementation(async (source, target) => {
    if (target === path.join(home, "config.toml")) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return rename(source, target);
  });
  expect((await apply({ activeModel: "test/beta" })).status).toBe(409);
  failure.mockRestore();
  expect(await Promise.all(files.map((file) => fs.readFile(path.join(home, file), "utf8")))).toEqual(before);
});

it("refuses externally edited catalogs and preserves them during Reset", async () => {
  expect((await apply()).status).toBe(200);
  const file = path.join(home, "afrouter-models.json");
  const custom = '{"models":[{"slug":"user/model"}]}';
  await fs.writeFile(file, custom);
  expect((await apply()).status).toBe(409);
  expect((await DELETE()).status).toBe(200);
  expect(await fs.readFile(file, "utf8")).toBe(custom);
});

it("rejects invalid input without creating files", async () => {
  for (const input of [{ models: [] }, { models: ["bad\nmodel"] }, { baseUrl: "file:///tmp/file" }, { apiKey: "key\nheader" }, { models: "not-an-array" }]) {
    expect((await apply(input)).status).toBe(400);
  }
  expect(await fs.readdir(home)).toEqual([]);
});

it("adds an explicit subagent to the catalog and labels unknown specs", async () => {
  const response = await apply({ subagentModel: "custom/unknown" });
  expect(response.status).toBe(200);
  expect((await response.json()).unverified).toEqual(["custom/unknown"]);
  const config = parseTOML(await fs.readFile(path.join(home, "config.toml"), "utf8"));
  expect(config.agents.default_subagent_model).toBe("custom/unknown");
  const catalog = JSON.parse(await fs.readFile(config.model_catalog_json, "utf8"));
  expect(catalog.models.at(-1)).toMatchObject({ slug: "custom/unknown", context_window: 128000, input_modalities: ["text"] });
});

it("generates valid manual provider TOML with one /v1 suffix and a real key", () => {
  const provider = codexProvider("http://localhost:20130/v1/", "test-key");
  expect(provider.base_url).toBe("http://localhost:20130/v1");
  expect(provider.http_headers.Authorization).toBe("Bearer test-key");
  const config = stringifyCodexConfig({ model: "test/alpha", catalogPath: "C:/x/catalog.json", provider, subagentModel: "test/alpha" });
  expect(config.match(/\/v1/g)).toHaveLength(1);
  expect(config).toContain('Authorization = "Bearer test-key"');
  expect(config).toContain('default_subagent_model = "test/alpha"');
  expect(() => codexProvider("http://localhost:20130/v1/", "")).toThrow();
});

it.each(["http://localhost:20130", "http://localhost:20130/", "http://localhost:20130/v1", "http://localhost:20130/v1/"])("normalizes %s idempotently", (input) => {
  expect(normalizeCodexBaseUrl(input)).toBe("http://localhost:20130/v1");
  expect(normalizeCodexBaseUrl(normalizeCodexBaseUrl(input))).toBe("http://localhost:20130/v1");
});

it("round-trips the actual manual TOML including Windows paths and quoted credentials", () => {
  const model = 'test/model"quoted';
  const catalogPath = 'C:\\Users\\Test Name\\.codex\\afrouter-models.json';
  const provider = codexProvider("http://localhost:20130/proxy/", 'key"with\\escapes');
  const config = stringifyCodexConfig({ model, catalogPath, provider, subagentModel: "test/subagent" });
  expect(parseTOML(config)).toEqual({ model, model_provider: "afrouter", model_catalog_json: catalogPath, model_providers: { afrouter: provider }, agents: { default_subagent_model: "test/subagent" } });
  expect(provider.base_url).toBe("http://localhost:20130/proxy/v1");
  expect(config).not.toContain("undefined");
});

it("keeps the browser catalog helper independent from Node-only imports", async () => {
  const helper = await fs.readFile(new URL("../../src/shared/codexCatalog.js", import.meta.url), "utf8");
  const card = await fs.readFile(new URL("../../src/app/(dashboard)/dashboard/cli-tools/components/CodexToolCard.js", import.meta.url), "utf8");
  expect(helper).not.toMatch(/\bimport\s/);
  expect(card).not.toMatch(/from\s+["'](?:confbox|node:)/);
  expect(buildCodexCatalog(["test/model"], { "test/model": { reasoningEfforts: "invalid" } }).models[0].supported_reasoning_levels).toEqual([{ effort: "none", description: "none" }]);
});

it("publishes a selectable default for nous/stealth/union-alpha with no declared effort ladder", async () => {
  const id = "nous/stealth/union-alpha";
  const response = await apply({ models: [id], activeModel: id });
  expect(response.status).toBe(200);
  const config = parseTOML(await fs.readFile(path.join(home, "config.toml"), "utf8"));
  const catalog = JSON.parse(await fs.readFile(config.model_catalog_json, "utf8"));
  expect(config.model).toBe(id);
  expect(catalog.models[0]).toMatchObject({
    slug: id,
    context_window: 200000,
    default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "medium" }],
  });
});

it("always includes the default in the selectable efforts without inventing a ladder", () => {
  for (const spec of [{}, { reasoning: true }, { reasoning: false }, { reasoning: true, reasoningEfforts: ["thinking"] }, { reasoning: true, reasoningEfforts: ["low", "high", "low"] }]) {
    const entry = buildCodexCatalog(["test/model"], { "test/model": spec }).models[0];
    expect(entry.supported_reasoning_levels.map((level) => level.effort)).toContain(entry.default_reasoning_level);
  }
  const entry = buildCodexCatalog(["test/model"], { "test/model": { reasoning: true, reasoningEfforts: ["low", "high", "low"] } }).models[0];
  expect(entry.supported_reasoning_levels.map((level) => level.effort)).toEqual(["low", "high"]);
});
