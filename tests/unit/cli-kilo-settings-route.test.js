import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/kilo-settings/route.js";
import { parseConfigText } from "../../src/lib/cliConfigIO.js";

vi.mock("../../src/app/api/models/route.js", () => ({ GET: async () => Response.json({ models: [] }) }));

let temporaryHome;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporaryHome) {
    const resolved = path.resolve(temporaryHome);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("afrouter-cli-kilo-")) throw new Error("Unsafe test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

const setup = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-kilo-"));
  temporaryHome = home;
  const configDir = path.join(home, "kilo-config");
  vi.stubEnv("KILO_CONFIG_DIR", configDir);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return { configDir, configPath: path.join(configDir, "kilo.jsonc") };
};

const post = (body) => POST(new Request("http://localhost/api/cli-tools/kilo-settings", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
}));

it("writes the afrouter provider and model into kilo.jsonc on a fresh install", async () => {
  const { configDir, configPath } = await setup();
  await fs.mkdir(configDir, { recursive: true });
  const response = await post({ baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" });
  expect(response.status).toBe(200);
  const config = parseConfigText(await fs.readFile(configPath, "utf8"), "json", "kilo.jsonc");
  expect(config.model).toBe("afrouter/test/model");
  expect(config.provider.afrouter.options).toEqual({
    baseURL: "http://localhost:20128/v1",
    apiKey: "test-only-key",
  });
  expect(config.provider.afrouter.models["test/model"]).toBeDefined();
});

it("preserves comments and existing keys in a user-edited kilo.jsonc", async () => {
  const { configDir, configPath } = await setup();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, '{\n  // my note\n  "theme": "dark",\n}\n');
  const response = await post({ baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" });
  expect(response.status).toBe(200);
  const text = await fs.readFile(configPath, "utf8");
  expect(text).toContain("// my note");
  expect(text).toContain('"theme": "dark"');
});

it("returns 409 and leaves the file untouched when kilo.jsonc cannot be parsed", async () => {
  const { configDir, configPath } = await setup();
  await fs.mkdir(configDir, { recursive: true });
  const broken = '{ "theme": ';
  await fs.writeFile(configPath, broken);
  const response = await post({ baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" });
  expect(response.status).toBe(409);
  expect(await fs.readFile(configPath, "utf8")).toBe(broken);
});

it("re-applying the same settings does not duplicate the provider", async () => {
  const { configDir, configPath } = await setup();
  await fs.mkdir(configDir, { recursive: true });
  const body = { baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" };
  await post(body);
  const first = await fs.readFile(configPath, "utf8");
  await post(body);
  expect(await fs.readFile(configPath, "utf8")).toBe(first);
});

it("reset removes the afrouter provider and model but keeps user settings", async () => {
  const { configDir, configPath } = await setup();
  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, '{\n  "theme": "dark"\n}\n');
  await post({ baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" });
  const response = await DELETE();
  expect(response.status).toBe(200);
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  expect(config.provider?.afrouter).toBeUndefined();
  expect(config.model).toBeUndefined();
  expect(config.theme).toBe("dark");
});

it("reports the configured state from kilo.jsonc", async () => {
  const { configDir } = await setup();
  await fs.mkdir(configDir, { recursive: true });
  await post({ baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" });
  const response = await GET();
  const body = await response.json();
  expect(body.hasAFRouter).toBe(true);
  expect(body.settings.model).toBe("afrouter/test/model");
});
