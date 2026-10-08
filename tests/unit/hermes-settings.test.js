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

vi.mock("child_process", () => ({
  exec: (_cmd, _opts, callback) => {
    const error = new Error("not found");
    error.code = 1;
    callback(error, "", "");
  },
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/hermes-settings/route.js");

const configPath = () => path.join(state.home, ".hermes", "config.yaml");
const readYaml = () => fs.readFileSync(configPath(), "utf-8");

function post(body) {
  return POST({ json: async () => body });
}

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
});

describe("hermes-settings", () => {
  it("writes model + delegation + aux roles with chat_completions api_mode", async () => {
    const res = await post({
      baseUrl: "http://127.0.0.1:20128",
      apiKey: "k",
      selections: [
        { role: "default", model: "cc/claude-sonnet-4-5" },
        { role: "delegation", model: "cc/claude-opus-4-7" },
        { role: "vision", model: "openai/gpt-4o" },
      ],
    });
    expect(res.body.success).toBe(true);
    const yaml = readYaml();
    expect(yaml).toContain('default: "cc/claude-sonnet-4-5"');
    expect(yaml).toContain('model: "cc/claude-opus-4-7"');
    expect(yaml).toContain("vision:\n    provider: \"custom\"");
    expect(yaml.match(/api_mode: "chat_completions"/g).length).toBe(3);
    expect(yaml).toContain('provider: "custom"');
    expect(res.body.backupPath).toBeNull();
  });

  it("replaces the fresh-install empty-string sentinel instead of duplicating keys", async () => {
    fs.mkdirSync(path.join(state.home, ".hermes"), { recursive: true });
    fs.writeFileSync(configPath(), 'model: ""\n');
    await post({ baseUrl: "http://x", apiKey: "k", model: "cc/claude-sonnet-4-5" });
    const yaml = readYaml();
    expect(yaml.match(/^model:/gm).length).toBe(1);
    expect(yaml).toContain('default: "cc/claude-sonnet-4-5"');
  });

  it("upgrades a sentinel without trailing newline without leaving a stale key", async () => {
    fs.mkdirSync(path.join(state.home, ".hermes"), { recursive: true });
    fs.writeFileSync(configPath(), 'model: ""');
    await post({ baseUrl: "http://x", apiKey: "k", model: "cc/claude-sonnet-4-5" });
    expect(readYaml().match(/^model:/gm).length).toBe(1);
  });

  it("re-Apply is idempotent and backs up the previous file", async () => {
    const body = { baseUrl: "http://x", apiKey: "k", model: "cc/claude-sonnet-4-5" };
    await post(body);
    const first = readYaml();
    const res = await post(body);
    expect(readYaml()).toBe(first);
    expect(res.body.backupPath).toBeTruthy();
  });

  it("preserves unrelated providers and user sections", async () => {
    fs.mkdirSync(path.join(state.home, ".hermes"), { recursive: true });
    fs.writeFileSync(configPath(), 'other:\n  keep: true\n');
    await post({ baseUrl: "http://x", apiKey: "k", model: "a/b" });
    expect(readYaml()).toContain("keep: true");
  });

  it("DELETE removes only custom-provider blocks", async () => {
    await post({ baseUrl: "http://x", apiKey: "k", model: "a/b" });
    const res = await DELETE();
    expect(res.body.success).toBe(true);
    expect(readYaml()).not.toContain("cc/claude");
  });

  it("GET reports not-installed without throwing when absent", async () => {
    const res = await GET();
    expect(res.body.installed).toBe(false);
  });
});
