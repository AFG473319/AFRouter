import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/copilot-settings/route.js";
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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-copilot-"));
  temporaryHome = home;
  const configDir = path.join(home, ".config", "Code", "User");
  vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
  vi.spyOn(os, "platform").mockReturnValue("linux");
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return { configDir, configPath: path.join(configDir, "chatLanguageModels.json") };
};

const post = (body) => POST({ json: async () => body, url: "http://localhost/api" });

it("writes the documented customendpoint entry with resolved specs", async () => {
  const { configPath } = await setup();
  const response = await post({ baseUrl: "http://localhost:20128", apiKey: "k", models: ["codex/gpt-5.6-sol"] });
  expect(response.status).toBe(200);
  const config = parseConfigText(await fs.readFile(configPath, "utf8"), "json", "chatLanguageModels.json");
  const entry = config.find((e) => e.name === "AFRouter");
  expect(entry.vendor).toBe("customendpoint");
  expect(entry.apiType).toBe("chat-completions");
  expect(entry.models[0]).toMatchObject({
    id: "codex/gpt-5.6-sol",
    url: "http://localhost:20128/v1/chat/completions",
    maxInputTokens: 372000,
    maxOutputTokens: 128000,
    thinking: true,
    supportsReasoningEffort: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
  });
});

it("keeps other BYOK providers when the file has trailing commas", async () => {
  const { configPath } = await setup();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, '[\n  { "name": "Mine", "vendor": "customendpoint" },\n]\n');
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(200);
  const text = await fs.readFile(configPath, "utf8");
  expect(text).toContain('"Mine"');
  expect(text).toContain("AFRouter");
});

it("returns 409 and leaves the file untouched when it cannot be parsed", async () => {
  const { configPath } = await setup();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const broken = "[ { \"name\": ";
  await fs.writeFile(configPath, broken);
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(409);
  expect(await fs.readFile(configPath, "utf8")).toBe(broken);
});

it("re-Apply is idempotent and reset removes only our entry", async () => {
  const { configPath } = await setup();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify([{ name: "Mine" }], null, 2));
  const body = { baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] };
  await post(body);
  const first = await fs.readFile(configPath, "utf8");
  await post(body);
  expect(await fs.readFile(configPath, "utf8")).toBe(first);
  const response = await DELETE();
  expect(response.status).toBe(200);
  const config = parseConfigText(await fs.readFile(configPath, "utf8"), "json", "chatLanguageModels.json");
  expect(config).toEqual([{ name: "Mine" }]);
});

it("does not report a non-reasoning model as thinking", async () => {
  const { configPath } = await setup();
  await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  const config = parseConfigText(await fs.readFile(configPath, "utf8"), "json", "chatLanguageModels.json");
  const entry = config.find((e) => e.name === "AFRouter");
  expect(entry.models[0].thinking).toBeUndefined();
  expect(entry.models[0].supportsReasoningEffort).toBeUndefined();
});

it("GET reports the configured state without throwing", async () => {
  await setup();
  const response = await GET();
  const body = await response.json();
  expect(body.hasAFRouter).toBe(false);
  expect(body.configPath).toContain("chatLanguageModels.json");
});
