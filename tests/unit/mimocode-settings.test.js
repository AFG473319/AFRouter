/**
 * Unit tests for /api/cli-tools/mimocode-settings (MiMo Code / Desktop integration).
 *
 * Covers the config-write paths against a temp MIMOCODE_HOME:
 *  - GET never 500s on missing/corrupt config (SC-004)
 *  - GET detects AFRouter provider + active model
 *  - POST writes provider.afrouter + preserves unrelated sections (FR-005)
 *  - POST merges models additively
 *  - POST rejects JSONC (trailing commas, comments) without corrupting the file
 *  - PATCH clearActiveModel
 *  - DELETE removes the provider; DELETE ?model= removes one model
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Reject the binary-install probe so detection always takes the config-path fallback.
vi.mock("child_process", async (importOriginal) => {
  const util = await import("node:util");
  const exec = (cmd, opts, cb) => {
    if (typeof opts === "function") { cb = opts; }
    cb(new Error("not found"), null, null);
  };
  return { exec, promisify: util.promisify };
});

const { GET, POST, PATCH, DELETE } = await import(
  "../../src/app/api/cli-tools/mimocode-settings/route.js"
);

const configPath = () => path.join(state.home, "mimocode.jsonc");

function writeConfig(obj) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
}

function readConfigRaw() {
  return fs.readFileSync(configPath(), "utf-8");
}

function readConfig() {
  return JSON.parse(readConfigRaw());
}

function post(body) {
  return POST({ json: async () => body });
}

function patch(body) {
  return PATCH({ json: async () => body });
}

function del(model) {
  return DELETE({ url: `http://localhost/api${model ? `?model=${encodeURIComponent(model)}` : ""}` });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-home-"));
  process.env.MIMOCODE_HOME = state.home;
  // Redirect Desktop-app detection away from the real %APPDATA%\Xiaomi MiMo AI.
  process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-appdata-"));
});

afterAll(() => {
  delete process.env.MIMOCODE_HOME;
  delete process.env.APPDATA;
});

describe("GET", () => {
  it("reports not-installed without throwing when home and binary are absent", async () => {
    delete process.env.MIMOCODE_HOME;
    state.home = path.join(os.tmpdir(), `mimocode-missing-${Date.now()}`);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(false);
  });

  it("reads an existing config and detects the afrouter provider", async () => {
    writeConfig({
      $schema: "https://mimo.xiaomi.com/mimocode/config.json",
      model: "afrouter/cc/claude-sonnet-5",
      provider: {
        afrouter: {
          name: "AFRouter",
          npm: "@ai-sdk/openai-compatible",
          options: { baseURL: "http://localhost:20128/v1", apiKey: "sk-test" },
          models: { "cc/claude-sonnet-5": { name: "Sonnet" } },
        },
      },
    });
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.mimocode.activeModel).toBe("cc/claude-sonnet-5");
    expect(res.body.mimocode.models).toEqual(["cc/claude-sonnet-5"]);
    expect(res.body.mimocode.baseURL).toBe("http://localhost:20128/v1");
  });

  it("handles JSONC config with comments and trailing commas", async () => {
    const jsonc =
      `{\n` +
      `  // schema for the config\n` +
      `  "$schema": "https://mimo.xiaomi.com/mimocode/config.json",\n` +
      `  "model": "afrouter/cc/claude-sonnet-5",\n` +
      `  "provider": {\n` +
      `    "afrouter": {\n` +
      `      "name": "AFRouter",\n` +
      `      "options": { "baseURL": "http://localhost:20128/v1", /* keep */ "apiKey": "sk-test", },\n` +
      `      "models": { "cc/claude-sonnet-5": { "name": "Sonnet" }, },\n` +
      `    },\n` +
      `  },\n` +
      `}`;
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), jsonc);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.mimocode.activeModel).toBe("cc/claude-sonnet-5");
  });

  it("reports not_configured when no afrouter provider exists", async () => {
    writeConfig({ model: "some/other", provider: {} });
    const res = await GET();
    expect(res.body.hasAFRouter).toBe(false);
    expect(res.body.mimocode.models).toEqual([]);
  });
});

describe("POST", () => {
  it("writes the afrouter provider and active model", async () => {
    const res = await post({
      baseUrl: "http://localhost:20128",
      apiKey: "sk-abc",
      models: ["cc/claude-sonnet-5", "cl/longcat-2.0"],
      activeModel: "cl/longcat-2.0",
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const config = readConfig();
    expect(config.provider.afrouter.npm).toBe("@ai-sdk/openai-compatible");
    expect(config.provider.afrouter.only_configured_models).toBe(true);
    expect(config.provider.afrouter.options.baseURL).toBe("http://localhost:20128/v1");
    expect(config.model).toBe("afrouter/cl/longcat-2.0");
    expect(Object.keys(config.provider.afrouter.models)).toEqual(["cc/claude-sonnet-5", "cl/longcat-2.0"]);
  });

  it("preserves unrelated provider sections and model entries (FR-005)", async () => {
    writeConfig({
      model: "9router/cc/claude-sonnet-5",
      provider: {
        userprovider: { npm: "@ai-sdk/x", options: { baseURL: "https://x/y" }, models: { "m/1": { name: "Keep" } } },
        afrouter: { npm: "@ai-sdk/openai-compatible", options: {}, models: { "cc/claude-sonnet-5": { name: "keep-me" } } },
      },
    });
    await post({ baseUrl: "http://localhost:20128", models: ["cc/claude-sonnet-5", "gemini/gemini-3-pro"], activeModel: "gemini/gemini-3-pro" });

    const config = readConfig();
    expect(config.provider.userprovider).toBeDefined();
    expect(config.provider.userprovider.models["m/1"].name).toBe("Keep");
    expect(config.provider.afrouter.models["cc/claude-sonnet-5"].name).toBe("keep-me");
    expect(Object.keys(config.provider.afrouter.models).sort()).toEqual(["cc/claude-sonnet-5", "gemini/gemini-3-pro"]);
  });

  it("rejects when baseUrl or models are missing", async () => {
    const res = await post({ apiKey: "sk" });
    expect(res.status).toBe(400);
  });

  it("accepts a JSONC existing file and writes clean JSON", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), `{\n  // comment\n  "model": "x/y",\n}`);
    const res = await post({ baseUrl: "http://localhost:20128", models: ["cc/claude-sonnet-5"], activeModel: "cc/claude-sonnet-5" });
    expect(res.status).toBe(200);
    const parsed = readConfig();
    expect(parsed.provider.afrouter.options.baseURL).toBe("http://localhost:20128/v1");
  });
});

describe("PATCH", () => {
  it("clears the active model without removing the provider", async () => {
    writeConfig({ model: "afrouter/cc/claude-sonnet-5", provider: { afrouter: { models: { "cc/claude-sonnet-5": {} } } } });
    const res = await patch({ clearActiveModel: true });
    expect(res.status).toBe(200);
    expect(readConfig().model).toBe("");
  });

  it("is a no-op when no config exists", async () => {
    const res = await patch({ clearActiveModel: true });
    expect(res.status).toBe(200);
  });
});

describe("DELETE", () => {
  it("removes the whole afrouter provider", async () => {
    writeConfig({ model: "afrouter/cc/claude-sonnet-5", provider: { afrouter: { models: { "cc/claude-sonnet-5": {} } } } });
    const res = await del();
    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.provider.afrouter).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  it("removes a single model and stays put when others remain", async () => {
    writeConfig({
      model: "afrouter/gemini/gemini-3-pro",
      provider: { afrouter: { models: { "cc/claude-sonnet-5": {}, "gemini/gemini-3-pro": {} } } },
    });
    const res = await del("cc/claude-sonnet-5");
    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.provider.afrouter.models["cc/claude-sonnet-5"]).toBeUndefined();
    expect(config.provider.afrouter.models["gemini/gemini-3-pro"]).toBeDefined();
    expect(config.model).toBe("afrouter/gemini/gemini-3-pro");
  });

  it("switches the active model when removing the current one", async () => {
    writeConfig({
      model: "afrouter/cc/claude-sonnet-5",
      provider: { afrouter: { models: { "cc/claude-sonnet-5": {}, "gemini/gemini-3-pro": {} } } },
    });
    const res = await del("cc/claude-sonnet-5");
    expect(res.status).toBe(200);
    const config = readConfig();
    expect(config.model).toBe("afrouter/gemini/gemini-3-pro");
  });
});