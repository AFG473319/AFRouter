import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import JSON5 from "json5";
import { GET, POST, DELETE } from "../../src/app/api/cli-tools/openclaw-settings/route.js";

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
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-openclaw-"));
  temporaryHome = home;
  vi.stubEnv("OPENCLAW_HOME", path.join(home, ".openclaw"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  return {
    home,
    settingsPath: path.join(home, ".openclaw", "openclaw.json"),
    agentDir: path.join(home, ".openclaw", "agents", "main", "agent"),
    agentModels: path.join(home, ".openclaw", "agents", "main", "agent", "models.json"),
  };
};

const post = (body) => POST({ json: async () => body, url: "http://localhost/api" });

const parse = (p) => JSON5.parse(require("node:fs").readFileSync(p, "utf8"));

it("writes provider models with resolved specs and a JSON5-safe config", async () => {
  const { settingsPath, agentDir, agentModels } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    `{
  // OpenClaw config is JSON5
  "agents": { "entries": { "main": { "agentDir": "./agents/main/agent", "model": "openai/gpt-4o" } } },
}`,
  );
  await fs.mkdir(agentDir, { recursive: true });
  const response = await post({
    baseUrl: "http://localhost:20128",
    apiKey: "test-only-key",
    model: "codex/gpt-5.6-sol",
    agentModels: { main: "openai/gpt-4o" },
  });
  expect(response.status).toBe(200);
  const text = require("node:fs").readFileSync(settingsPath, "utf8");
  // The comment survives the JSON5-preserving write.
  expect(text).toContain("// OpenClaw config is JSON5");
  const settings = JSON5.parse(text);
  const entry = settings.models.providers.afrouter;
  expect(entry.baseUrl).toBe("http://localhost:20128/v1");
  expect(entry.api).toBe("openai-completions");
  expect(entry.apiKey).toBe("test-only-key");
  // contextWindow/maxTokens/reasoning/input all come from the spec, so OpenClaw
  // no longer assumes a 200k text-only non-reasoning model.
  const [first] = entry.models;
  expect(first).toMatchObject({ id: "codex/gpt-5.6-sol", contextWindow: 372000, reasoning: true, input: ["text", "image"] });
  expect(settings.agents.defaults.model.primary).toBe("afrouter/codex/gpt-5.6-sol");
  // The per-agent override is written under agents.entries, the current key.
  expect(settings.agents.entries.main.model).toBe("afrouter/openai/gpt-4o");
  // The per-agent models.json carries specs too.
  const agent = parse(agentModels);
  expect(agent.providers.afrouter.models[0]).toMatchObject({ id: "openai/gpt-4o", contextWindow: 128000 });
});

it("writes agents.entries overrides when the config already uses entries", async () => {
  const { settingsPath } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    `{
  // my note
  "agents": {
    "ownership": "explicit",
    "entries": { "main": { "model": "openai/gpt-4o" } },
  },
}`,
  );
  const response = await post({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o", agentModels: { main: "codex/gpt-5.6-sol" } });
  expect(response.status).toBe(200);
  const text = require("node:fs").readFileSync(settingsPath, "utf8");
  // JSON5 comments and the unrelated key survive the write.
  expect(text).toContain("// my note");
  expect(text).toContain('"ownership": "explicit"');
  const settings = JSON5.parse(text);
  expect(settings.agents.entries.main.model).toBe("afrouter/codex/gpt-5.6-sol");
  // The retired agents.list is never introduced.
  expect(settings.agents.list).toBeUndefined();
});

it("returns 409 and leaves the file untouched when it cannot be parsed", async () => {
  const { settingsPath } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  const broken = '{ "agents": ';
  await fs.writeFile(settingsPath, broken);
  const response = await post({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" });
  expect(response.status).toBe(409);
  expect(require("node:fs").readFileSync(settingsPath, "utf8")).toBe(broken);
});

it("never writes a placeholder API key", async () => {
  const { settingsPath } = await setup();
  await post({ baseUrl: "http://x", apiKey: "", model: "openai/gpt-4o" });
  const settings = parse(settingsPath);
  expect(settings.models.providers.afrouter.apiKey).toBeUndefined();
});

it("re-Apply is idempotent and reset removes only ours", async () => {
  const { settingsPath, agentDir, agentModels } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(
    settingsPath,
    JSON.stringify({
      models: { providers: { mine: { baseUrl: "http://mine" } } },
      agents: { defaults: { model: { primary: "theirs" } } },
    }),
  );
  await fs.mkdir(agentDir, { recursive: true });
  await fs.writeFile(agentModels, JSON.stringify({ providers: { mine: { models: [{ id: "theirs" }] } } }));

  const body = { baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o", agentModels: { main: "codex/gpt-5.6-sol" } };
  await post(body);
  const first = require("node:fs").readFileSync(settingsPath, "utf8");
  await post(body);
  expect(require("node:fs").readFileSync(settingsPath, "utf8")).toBe(first);

  const response = await DELETE();
  expect(response.status).toBe(200);
  const settings = parse(settingsPath);
  expect(settings.models.providers.mine).toBeTruthy();
  expect(settings.models.providers.afrouter).toBeUndefined();
  // A user's own primary model is not touched.
  expect(settings.agents.defaults.model.primary).toBe("theirs");
  // The per-agent models.json keeps the user's provider and loses only ours.
  const agent = parse(agentModels);
  expect(agent.providers.mine).toBeTruthy();
  expect(agent.providers.afrouter).toBeUndefined();
});

it("GET reports corrupt state without throwing", async () => {
  const { settingsPath } = await setup();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, "{ broken");
  const response = await GET();
  expect(response.status).toBe(409);
});

it("GET reports install state without throwing when absent", async () => {
  await setup();
  const response = await GET();
  const body = response.body;
  expect(body.installed).toBe(false);
});
