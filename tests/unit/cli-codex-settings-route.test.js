import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseTOML } from "confbox";
import { POST } from "../../src/app/api/cli-tools/codex-settings/route.js";

vi.mock("../../src/app/api/models/route.js", () => ({ GET: async () => Response.json({ models: [] }) }));

let temporaryHome;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (temporaryHome) {
    const resolved = path.resolve(temporaryHome);
    if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) || !path.basename(resolved).startsWith("afrouter-cli-codex-")) throw new Error("Unsafe test cleanup path");
    await fs.rm(resolved, { recursive: true, force: true });
    temporaryHome = undefined;
  }
});

it("merges Codex settings without losing an existing TOML profile", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "afrouter-cli-codex-"));
  temporaryHome = home;
  const codexHome = path.join(home, ".codex");
  vi.stubEnv("CODEX_HOME", codexHome);
  vi.spyOn(os, "homedir").mockReturnValue(home);
  await fs.mkdir(codexHome);
  const configPath = path.join(codexHome, "config.toml");
  await fs.writeFile(configPath, '[profiles.review]\nmodel = "existing-model"\n');
  const response = await POST(new Request("http://localhost/api/cli-tools/codex-settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ baseUrl: "http://localhost:20128/v1", apiKey: "test-only-key", model: "test/model" }),
  }));
  expect(response.status).toBe(200);
  expect(parseTOML(await fs.readFile(configPath, "utf8"))).toEqual({
    profiles: { review: { model: "existing-model" } },
    model: "test/model",
    model_provider: "afrouter",
    model_catalog_json: path.join(codexHome, "afrouter-models.json"),
    model_providers: { afrouter: {
      name: "AFRouter",
      base_url: "http://localhost:20128/v1",
      wire_api: "responses",
      supports_websockets: false,
      http_headers: { Authorization: "Bearer test-only-key" },
    } },
    agents: { default_subagent_model: "test/model" },
  });
});
