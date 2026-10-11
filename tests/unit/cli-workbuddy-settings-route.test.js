import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/workbuddy-settings/route.js";

vi.mock("../../src/app/api/cli-tools/resolveApiKey.js", () => ({
  resolveCliApiKey: async (key) => (key && key.trim() ? key.trim() : ""),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

let temporaryHome;

afterEach(async () => {
  // Restore the homedir spy first so cleanup cannot run under a mocked home.
  vi.restoreAllMocks();
  if (temporaryHome) {
    const resolved = path.resolve(temporaryHome);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error("Unsafe test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

const setup = async ({ withNewDir = false } = {}) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-workbuddy-"));
  temporaryHome = home;
  vi.spyOn(os, "homedir").mockReturnValue(home);
  if (withNewDir) await fs.mkdir(path.join(home, ".workbuddy-ai"), { recursive: true });
  return {
    home,
    newPath: path.join(home, ".workbuddy-ai", "models.json"),
    oldPath: path.join(home, ".workbuddy", "models.json"),
  };
};

const post = (body) => POST({ json: async () => body, url: "http://localhost/api" });

const read = (p) => JSON.parse(require("node:fs").readFileSync(p, "utf8"));

it("writes ~/.workbuddy-ai/models.json with resolved specs", async () => {
  const { newPath } = await setup({ withNewDir: true });
  const response = await post({
    baseUrl: "http://localhost:20128",
    apiKey: "test-only-key",
    models: ["codex/gpt-5.6-sol", "openai/gpt-4o"],
  });
  expect(response.status).toBe(200);
  const config = read(newPath);
  const [sol, gpt4o] = config.models;
  expect(sol).toMatchObject({
    id: "codex/gpt-5.6-sol",
    vendor: "AFRouter",
    apiKey: "test-only-key",
    url: "http://localhost:20128/v1/chat/completions",
    supportsToolCall: true,
    supportsImages: true,
    maxInputTokens: 372000,
    maxOutputTokens: 128000,
    supportsReasoning: true,
  });
  // max/xhigh must be declared or CodeBuddy downgrades them to high.
  expect(sol.reasoning.supportedEfforts).toEqual(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
  // A non-reasoning model gets no reasoning block and no vision claim.
  expect(gpt4o.supportsReasoning).toBeUndefined();
  expect(gpt4o.reasoning).toBeUndefined();
  expect(gpt4o.maxInputTokens).toBe(128000);
});

it("writes ~/.workbuddy/models.json when that is the directory that exists", async () => {
  const { oldPath } = await setup();
  await fs.mkdir(path.dirname(oldPath), { recursive: true });
  await fs.writeFile(oldPath, JSON.stringify({ models: [] }));
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(200);
  expect(read(oldPath).models).toHaveLength(1);
});

it("returns 409 and leaves the file untouched when models.json cannot be parsed", async () => {
  const { newPath } = await setup({ withNewDir: true });
  await fs.writeFile(newPath, '{ "models": ');
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(409);
  expect(require("node:fs").readFileSync(newPath, "utf8")).toBe('{ "models": ');
});

it("keeps user models and reset removes only ours", async () => {
  const { newPath } = await setup({ withNewDir: true });
  await fs.writeFile(newPath, JSON.stringify({ models: [{ id: "mine", vendor: "Mine", url: "http://m" }] }, null, 2));
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] });
  expect(response.status).toBe(200);
  let config = read(newPath);
  expect(config.models.map((m) => m.id)).toEqual(["mine", "openai/gpt-4o"]);

  const reset = await DELETE();
  expect(reset.status).toBe(200);
  config = read(newPath);
  expect(config.models).toEqual([{ id: "mine", vendor: "Mine", url: "http://m" }]);
});

it("never claims a user model that shares an id", async () => {
  const { newPath } = await setup({ withNewDir: true });
  await fs.writeFile(newPath, JSON.stringify({ models: [{ id: "shared/id", vendor: "Mine", url: "http://m" }] }, null, 2));
  const response = await post({ baseUrl: "http://x", apiKey: "k", models: ["shared/id"] });
  expect(response.status).toBe(200);
  expect(read(newPath).models.find((m) => m.id === "shared/id").vendor).toBe("Mine");
});

it("reports the configured state and file path", async () => {
  const { newPath } = await setup({ withNewDir: true });
  await post({ baseUrl: "http://localhost:20128", apiKey: "k", models: ["openai/gpt-4o"] });
  const response = await GET();
  const body = response.body;
  expect(body.hasAFRouter).toBe(true);
  expect(body.workbuddy.afrouterModels).toEqual(["openai/gpt-4o"]);
  expect(body.configPath).toBe(newPath);
});
