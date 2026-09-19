/**
 * Unit tests for /api/cli-tools/workbuddy-settings (WorkBuddy models.json integration).
 *
 * Covers the config-write paths against a temp home:
 *  - GET never 500s on missing/corrupt config
 *  - POST creates models.json from scratch (not-installed)
 *  - POST merges AFRouter models additively and preserves other vendors
 *  - POST registers new ids in availableModels so WorkBuddy actually picks them up
 *  - DELETE removes only vendor "AFRouter" models
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: null }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => (state.home ? state.home : actual.homedir());
  return { ...actual, default: { ...actual, homedir } };
});

// Reject the binary-install probe so detection always takes the config-path fallback.
vi.mock("child_process", async (importOriginal) => {
  const util = await import("node:util");
  const exec = (cmd, opts, cb) => {
    if (typeof opts === "function") { cb = opts; }
    cb(new Error("not found"), null, null);
  };
  return { exec, promisify: util.promisify };
});

const { GET, POST, DELETE } = await import(
  "../../src/app/api/cli-tools/workbuddy-settings/route.js"
);

const configPath = () => path.join(state.home, ".workbuddy", "models.json");

function writeRaw(text) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), text);
}

function writeConfig(obj) {
  writeRaw(JSON.stringify(obj, null, 2));
}

function readConfig() {
  return JSON.parse(fs.readFileSync(configPath(), "utf-8"));
}

function post(body) {
  return POST(
    new Request("http://localhost/api/cli-tools/workbuddy-settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

function del(model) {
  return DELETE(
    new Request(
      `http://localhost/api/cli-tools/workbuddy-settings${model ? `?model=${encodeURIComponent(model)}` : ""}`,
      { method: "DELETE" }
    )
  );
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "workbuddy-home-"));
});

describe("GET", () => {
  it("reports not-installed without throwing when the file is absent", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.workbuddy).toBeNull();
  });

  it("reports corrupt instead of 500 on unparseable JSON", async () => {
    writeRaw("{ not json");
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).corrupt).toBe(true);
  });
});

describe("POST", () => {
  it("creates models.json from scratch when WorkBuddy was never configured", async () => {
    const res = await post({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-5"],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const cfg = readConfig();
    expect(cfg.models).toHaveLength(1);
    expect(cfg.models[0]).toMatchObject({
      id: "cc/claude-sonnet-5",
      vendor: "AFRouter",
      url: "http://localhost:20128/v1/chat/completions",
    });
  });

  it("merges additively and never claims other-vendor ids", async () => {
    writeConfig({
      models: [
        { id: "user-model", name: "user", vendor: "Other", apiKey: "x", url: "https://x/v1/chat/completions" },
      ],
      availableModels: ["user-model"],
    });
    const res = await post({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk_afrouter",
      models: ["user-model", "cc/claude-sonnet-5"],
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.skipped).toEqual(["user-model"]);
    const cfg = readConfig();
    expect(cfg.models.map((m) => m.id).sort()).toEqual(["cc/claude-sonnet-5", "user-model"]);
    // other-vendor entry stays byte-identical
    expect(cfg.models.find((m) => m.id === "user-model")).toEqual({
      id: "user-model", name: "user", vendor: "Other", apiKey: "x", url: "https://x/v1/chat/completions",
    });
  });

  it("registers new ids in availableModels so WorkBuddy picks them up", async () => {
    writeConfig({
      models: [
        { id: "user-model", name: "user", vendor: "Other", apiKey: "x", url: "https://x/v1/chat/completions" },
      ],
      availableModels: ["user-model"],
    });
    await post({
      baseUrl: "http://localhost:20128/v1",
      apiKey: "sk_afrouter",
      models: ["cc/claude-sonnet-5"],
    });
    const cfg = readConfig();
    expect(cfg.availableModels).toContain("user-model");
    expect(cfg.availableModels).toContain("cc/claude-sonnet-5");
  });

  it("400s when models are missing", async () => {
    const res = await post({ baseUrl: "http://localhost:20128/v1", models: [] });
    expect(res.status).toBe(400);
  });
});

describe("DELETE", () => {
  it("removes only AFRouter-vendor models and prunes them from availableModels", async () => {
    writeConfig({
      models: [
        { id: "cc/claude-sonnet-5", name: "cc/claude-sonnet-5", vendor: "AFRouter", apiKey: "k", url: "https://x/v1/chat/completions" },
        { id: "user-model", name: "user", vendor: "Other", apiKey: "x", url: "https://x/v1/chat/completions" },
      ],
      availableModels: ["cc/claude-sonnet-5", "user-model"],
    });
    const res = await del();
    expect((await res.json()).removed).toBe(1);
    const cfg = readConfig();
    expect(cfg.models.map((m) => m.id)).toEqual(["user-model"]);
    expect(cfg.availableModels || []).not.toContain("cc/claude-sonnet-5");
  });
});
