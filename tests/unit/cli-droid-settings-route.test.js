import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/droid-settings/route.js";
import { parseConfigText } from "../../src/lib/cliConfigIO.js";

vi.mock("../../src/app/api/cli-tools/resolveApiKey.js", () => ({
  resolveCliApiKey: async (key) => (key && key.trim() ? key.trim() : ""),
}));

let temporaryHome;

afterEach(async () => {
  vi.restoreAllMocks();
  if (temporaryHome) {
    const resolved = path.resolve(temporaryHome);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

const setup = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-droid-"));
  temporaryHome = home;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return { home, settingsPath: path.join(home, ".factory", "settings.json") };
};

const post = (body) => POST({ json: async () => body, url: "http://localhost/api" });

it("writes the chat-completions provider with resolved specs and a top-level model", async () => {
  const { settingsPath } = await setup();
  const response = await post({
    baseUrl: "http://localhost:20128",
    apiKey: "test-only-key",
    models: ["codex/gpt-5.6-sol", "openai/gpt-4o"],
    activeModel: "openai/gpt-4o",
  });
  expect(response.status).toBe(200);
  const settings = parseConfigText(await fs.readFile(settingsPath, "utf8"), "json", "settings.json");
  const ours = settings.customModels.filter((m) => String(m.id).startsWith("custom:AFRouter"));
  // docs.factory.ai/model-independence/byok: generic-chat-completion-api speaks
  // Chat Completions; "openai" means the Responses API on OpenAI's own endpoint.
  expect(ours.every((m) => m.provider === "generic-chat-completion-api")).toBe(true);
  expect(ours[0]).toMatchObject({
    model: "openai/gpt-4o",
    baseUrl: "http://localhost:20128/v1",
    noImageSupport: false,
  });
  expect(ours[0].maxOutputTokens).toBe(16384);
  // A never-write placeholder would be sent as a bearer token and 401.
  expect(ours[0].apiKey).toBe("test-only-key");
  expect(ours.some((m) => m.apiKey === "your_api_key")).toBe(false);
  expect(settings.model).toBe("openai/gpt-4o");
});

it("omits apiKey entirely when none resolves", async () => {
  const { settingsPath } = await setup();
  await post({ baseUrl: "http://x", apiKey: "", models: ["openai/gpt-4o"] });
  const settings = parseConfigText(await fs.readFile(settingsPath, "utf8"), "json", "settings.json");
  expect(settings.customModels[0].apiKey).toBeUndefined();
});

it("returns 409 and leaves the file untouched when settings.json cannot be parsed", async () => {
  const { settingsPath } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const broken = '{ "customModels": ';
  await fs.writeFile(settingsPath, broken);
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(409);
  expect(await fs.readFile(settingsPath, "utf8")).toBe(broken);
});

it("keeps user models and reset removes only ours", async () => {
  const { settingsPath } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ model: "mine", customModels: [{ id: "mine", model: "mine" }] }, null, 2),
  );
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(200);
  let settings = parseConfigText(await fs.readFile(settingsPath, "utf8"), "json", "settings.json");
  // Applying with an active model repoints the top-level key at it.
  expect(settings.model).toBe("openai/gpt-4o");

  const reset = await DELETE();
  expect(reset.status).toBe(200);
  settings = parseConfigText(await fs.readFile(settingsPath, "utf8"), "json", "settings.json");
  expect(settings.customModels).toEqual([{ id: "mine", model: "mine" }]);
  // Our active model is dropped, so Droid is not left pointing at a model that
  // no longer exists in its config.
  expect(settings.model).toBeUndefined();
});

it("leaves a user-pinned active model alone on reset", async () => {
  const { settingsPath } = await setup();
  await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  // The user repoints the active model at their own and keeps one of ours.
  const settings = parseConfigText(await fs.readFile(settingsPath, "utf8"), "json", "settings.json");
  await fs.writeFile(
    settingsPath,
    JSON.stringify({ ...settings, model: "theirs", customModels: [{ id: "theirs", model: "theirs" }] }, null, 2),
  );
  const reset = await DELETE();
  expect(reset.status).toBe(200);
  const after = parseConfigText(await fs.readFile(settingsPath, "utf8"), "json", "settings.json");
  expect(after.model).toBe("theirs");
  expect(after.customModels).toEqual([{ id: "theirs", model: "theirs" }]);
});

it("GET reports install state without throwing when absent", async () => {
  await setup();
  const response = await GET();
  const body = await response.json();
  expect(body.installed).toBe(false);
});
