import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/cline-settings/route.js";
import { parseConfigText } from "../../src/lib/cliConfigIO.js";

vi.mock("../../src/app/api/cli-tools/resolveApiKey.js", () => ({
  resolveCliApiKey: async (key) => (key && key.trim() ? key.trim() : ""),
}));

let temporaryHome;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporaryHome) {
    const resolved = path.resolve(temporaryHome);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

const setup = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-cline-"));
  temporaryHome = home;
  const dataDir = path.join(home, ".cline", "data");
  vi.stubEnv("CLINE_DATA_DIR", dataDir);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return { dataDir, providersPath: path.join(dataDir, "settings", "providers.json") };
};

const post = (body) => POST({ json: async () => body, url: "http://localhost/api/cli-tools/cline-settings" });

it("writes the openai-compatible provider into settings/providers.json on a fresh install", async () => {
  const { providersPath } = await setup();
  const response = await post({ baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" });
  expect(response.status).toBe(200);
  const config = parseConfigText(await fs.readFile(providersPath, "utf8"), "json", "providers.json");
  expect(config.lastUsedProvider).toBe("openai-compatible");
  expect(config.providers["openai-compatible"].settings).toMatchObject({
    provider: "openai-compatible",
    apiKey: "test-only-key",
    model: "test/model",
    baseUrl: "http://localhost:20128/v1",
  });
});

it("preserves other providers on re-apply and is idempotent", async () => {
  const { providersPath } = await setup();
  const body = { baseUrl: "http://localhost:20128", apiKey: "test-only-key", model: "test/model" };
  await post(body);
  const raw = await fs.readFile(providersPath, "utf8");
  const config = parseConfigText(raw, "json", "providers.json");
  config.providers.other = { settings: { provider: "other" } };
  await fs.writeFile(providersPath, JSON.stringify(config, null, 2));
  await post(body);
  const first = await fs.readFile(providersPath, "utf8");
  await post(body);
  expect(await fs.readFile(providersPath, "utf8")).toBe(first);
  expect(parseConfigText(first, "json", "providers.json").providers.other).toBeTruthy();
});

it("returns 409 and leaves the file untouched when providers.json cannot be parsed", async () => {
  const { dataDir, providersPath } = await setup();
  await fs.mkdir(path.join(dataDir, "settings"), { recursive: true });
  const broken = '{ "version": ';
  await fs.writeFile(providersPath, broken);
  const response = await post({ baseUrl: "http://localhost:20128", apiKey: "k", model: "test/model" });
  expect(response.status).toBe(409);
  expect(await fs.readFile(providersPath, "utf8")).toBe(broken);
});

it("reset removes only the openai-compatible provider", async () => {
  const { providersPath } = await setup();
  await post({ baseUrl: "http://localhost:20128", apiKey: "k", model: "test/model" });
  const response = await DELETE();
  expect(response.status).toBe(200);
  const config = parseConfigText(await fs.readFile(providersPath, "utf8"), "json", "providers.json");
  expect(config.providers?.["openai-compatible"]).toBeUndefined();
});

it("reports the configured state from providers.json", async () => {
  await setup();
  await post({ baseUrl: "http://localhost:20128", apiKey: "k", model: "test/model" });
  const response = await GET();
  const body = await response.json();
  expect(body.hasAFRouter).toBe(true);
  expect(body.settings.model).toBe("test/model");
  expect(body.settings.baseUrl).toBe("http://localhost:20128/v1");
});
