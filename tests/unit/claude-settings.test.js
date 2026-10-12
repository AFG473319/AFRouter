/**
 * Unit tests for /api/cli-tools/claude-settings (Claude Code integration) —
 * specifically the `modelPicker` lineup, which is what lets a user add more than
 * one model per family (Haiku/Fable/Sonnet/Opus) to Claude Code's /model
 * picker. The four ANTHROPIC_DEFAULT_*_MODEL env vars each pin exactly one
 * model per alias; modelPicker.options is an array and has no such ceiling.
 *
 * Covers:
 *  - GET reports picker rows, sanitized, and never 500s on a missing/corrupt file
 *  - POST writes more than four rows (the point of the feature)
 *  - POST merges into an existing modelPicker, preserving keys we do not own
 *    (replaceBuiltInOptions) and every unrelated top-level setting
 *  - POST omits modelPicker entirely when the row list is empty
 *  - POST leaves existing rows alone when the caller sends no modelPicker
 *  - POST rejects a non-array modelPicker with a 400 and writes nothing
 *  - POST still writes the family env vars alongside the picker rows
 *  - DELETE drops our rows but keeps user-owned modelPicker keys, and still
 *    removes the family env vars
 *  - the shared shape's dedupe/cap/blank-dropping rules
 *
 * os.homedir is mocked so ~/.claude and ~/.claude.json land in a per-test temp
 * dir; CLAUDE_CONFIG_DIR is deleted so the route cannot pick up a real one from
 * the host; the `claude` PATH probe and next/server are stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: null, claudeOnPath: true }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => (state.home ? state.home : actual.homedir());
  return { ...actual, default: { ...actual, homedir } };
});

// `claude` is looked up on PATH for install detection (where/which). Make that
// deterministic instead of depending on the host machine.
vi.mock("child_process", () => ({
  exec: (_cmd, _opts, callback) => {
    if (state.claudeOnPath) return callback(null, { stdout: "claude", stderr: "" });
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

const { GET, POST, DELETE } = await import("../../src/app/api/cli-tools/claude-settings/route.js");
const {
  sanitizePickerRow,
  sanitizePickerRows,
  applyModelPicker,
  buildModelPicker,
  readPickerRows,
} = await import("../../src/lib/claudePickerConfig.js");

const settingsPath = () => path.join(state.home, ".claude", "settings.json");
const claudeJsonPath = () => path.join(state.home, ".claude.json");

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2));
}

const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));

const post = (body) => POST({ json: async () => body, url: "http://127.0.0.1:20128/api/cli-tools/claude-settings" });
const get = () => GET({ url: "http://127.0.0.1:20128/api/cli-tools/claude-settings" });
const del = () => DELETE({ url: "http://127.0.0.1:20128/api/cli-tools/claude-settings" });

const BASE_ENV = { ANTHROPIC_BASE_URL: "http://127.0.0.1:20128/v1", ANTHROPIC_AUTH_TOKEN: "sk_test_key" };

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-home-"));
  state.claudeOnPath = true;
  // A real CLAUDE_CONFIG_DIR on the host would redirect every write out of the
  // temp home; the route must fall back to ~/.claude of the mocked homedir.
  delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
  fs.rmSync(state.home, { recursive: true, force: true });
});

describe("GET", () => {
  it("reports no picker rows when the file has none", async () => {
    writeSettings({ env: BASE_ENV });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.modelPicker).toEqual([]);
  });

  it("never 500s on a corrupt settings file", async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), "{ not json\n");
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.body.installed).toBe(true);
    expect(res.body.settings).toBeNull();
    expect(res.body.modelPicker).toEqual([]);
  });

  it("returns picker rows sanitized, dropping the unusable ones", async () => {
    writeSettings({
      env: BASE_ENV,
      modelPicker: {
        replaceBuiltInOptions: true,
        options: [
          { model: "cc/claude-opus-5", label: "Opus" },
          { model: "   " },
          { model: "cc/claude-sonnet-5", description: "daily" },
          "junk",
          { label: "no model" },
        ],
      },
    });
    const res = await get();
    expect(res.body.modelPicker).toEqual([
      { model: "cc/claude-opus-5", label: "Opus" },
      { model: "cc/claude-sonnet-5", description: "daily" },
    ]);
  });
});

describe("POST modelPicker", () => {
  it("writes more than four picker rows — past the one-per-family ceiling", async () => {
    const rows = [
      { model: "cc/claude-opus-5", label: "Opus 5" },
      { model: "cc/claude-opus-4-6", label: "Opus 4.6" },
      { model: "cc/claude-sonnet-5" },
      { model: "cc/claude-sonnet-4-5" },
      { model: "cc/claude-haiku-4-5-20251001", description: "cheap" },
      { model: "kilo/stealth/space-bunny-alpha" },
      { model: "cc/gpt-5.6-terra" },
    ];
    const res = await post({ env: BASE_ENV, modelPicker: rows });
    expect(res.status).toBe(200);
    expect(readSettings().modelPicker).toEqual({ options: rows });
  });

  it("merges into an existing modelPicker and keeps keys we do not own", async () => {
    writeSettings({ theme: "dark", modelPicker: { options: [{ model: "stale" }], replaceBuiltInOptions: true } });
    const res = await post({ env: BASE_ENV, modelPicker: [{ model: "cc/claude-opus-5", label: "Opus" }] });
    expect(res.status).toBe(200);
    const settings = readSettings();
    expect(settings.modelPicker).toEqual({ options: [{ model: "cc/claude-opus-5", label: "Opus" }], replaceBuiltInOptions: true });
    expect(settings.theme).toBe("dark");
  });

  it("omits modelPicker entirely when the row list is empty", async () => {
    writeSettings({ env: BASE_ENV });
    const res = await post({ env: BASE_ENV, modelPicker: [] });
    expect(res.status).toBe(200);
    expect(readSettings()).not.toHaveProperty("modelPicker");
  });

  it("leaves existing rows alone when the caller sends no modelPicker", async () => {
    writeSettings({ env: BASE_ENV, modelPicker: { options: [{ model: "kept" }] } });
    const res = await post({ env: { ANTHROPIC_BASE_URL: "http://other:1/v1" } });
    expect(res.status).toBe(200);
    expect(readSettings().modelPicker).toEqual({ options: [{ model: "kept" }] });
  });

  it("rejects a non-array modelPicker with a 400 and writes nothing", async () => {
    writeSettings({ env: BASE_ENV });
    const before = fs.readFileSync(settingsPath(), "utf-8");
    const res = await post({ env: BASE_ENV, modelPicker: { options: [{ model: "x" }] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/modelPicker/);
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(before);
  });

  it("drops blank and duplicate rows so the file holds a usable lineup", async () => {
    const res = await post({
      env: BASE_ENV,
      modelPicker: [
        { model: "  cc/claude-opus-5  " },
        { model: "cc/claude-opus-5" },
        { model: "" },
        { model: "cc/claude-haiku-4-5-20251001[1m]" },
      ],
    });
    expect(res.status).toBe(200);
    expect(readSettings().modelPicker).toEqual({
      options: [{ model: "cc/claude-opus-5" }, { model: "cc/claude-haiku-4-5-20251001[1m]" }],
    });
  });

  it("writes the family env vars alongside the picker rows", async () => {
    const res = await post({
      env: {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:20128",
        ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "cc/claude-haiku-4-5-20251001",
      },
      modelPicker: [{ model: "extra/model" }],
    });
    expect(res.status).toBe(200);
    const settings = readSettings();
    expect(settings.env.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:20128/v1");
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("cc/claude-opus-5");
    expect(settings.modelPicker).toEqual({ options: [{ model: "extra/model" }] });
  });
});

describe("DELETE", () => {
  it("drops our picker rows but keeps user-owned modelPicker keys", async () => {
    writeSettings({
      env: { ...BASE_ENV, KEEP_ME: "1", ANTHROPIC_DEFAULT_OPUS_MODEL: "cc/claude-opus-5" },
      modelPicker: { options: [{ model: "ours" }], replaceBuiltInOptions: true },
    });
    const res = await del();
    expect(res.status).toBe(200);
    const settings = readSettings();
    expect(settings.modelPicker).toEqual({ replaceBuiltInOptions: true });
    expect(settings.env).toMatchObject({ KEEP_ME: "1" });
    expect(settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBeUndefined();
  });

  it("removes the modelPicker key entirely when it held only our rows", async () => {
    writeSettings({ env: BASE_ENV, modelPicker: { options: [{ model: "ours" }] } });
    await del();
    const settings = readSettings();
    expect(settings).not.toHaveProperty("modelPicker");
    // BASE_ENV is entirely ours, so the reset also drops the now-empty env object.
    expect(settings).toEqual({});
  });

  it("still clears the family env vars and the Exa MCP entry", async () => {
    writeSettings({
      env: {
        ANTHROPIC_BASE_URL: BASE_ENV.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: BASE_ENV.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_DEFAULT_SONNET_MODEL: "cc/claude-sonnet-5",
        ANTHROPIC_DEFAULT_HAIKU_MODEL: "cc/claude-haiku-4-5-20251001",
        ANTHROPIC_DEFAULT_FABLE_MODEL: "cc/claude-fable-5",
      },
    });
    await del();
    const settings = readSettings();
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL"]) {
      expect(settings.env?.[key]).toBeUndefined();
    }
    expect(fs.existsSync(claudeJsonPath())).toBe(true);
  });

  it("is idempotent when nothing is configured", async () => {
    writeSettings({ env: BASE_ENV });
    await del();
    const once = fs.readFileSync(settingsPath(), "utf-8");
    await del();
    expect(fs.readFileSync(settingsPath(), "utf-8")).toBe(once);
  });
});

describe("shared picker shape", () => {
  it("caps the row count and keeps order", () => {
    const many = Array.from({ length: 80 }, (_, i) => ({ model: `m${i}` }));
    const rows = sanitizePickerRows(many);
    expect(rows).toHaveLength(50);
    expect(rows[0].model).toBe("m0");
    expect(rows[49].model).toBe("m49");
  });

  it("keeps the model id verbatim, including the [1m] marker", () => {
    expect(sanitizePickerRow({ model: "cc/claude-sonnet-5[1m]" })).toEqual({ model: "cc/claude-sonnet-5[1m]" });
  });

  it("drops a row with no model rather than writing an empty picker entry", () => {
    expect(sanitizePickerRow({ label: "name only" })).toBeNull();
    expect(sanitizePickerRow(null)).toBeNull();
    expect(sanitizePickerRow("string")).toBeNull();
  });

  it("reads rows back off a document with no picker config", () => {
    expect(readPickerRows({})).toEqual([]);
    expect(readPickerRows({ modelPicker: {} })).toEqual([]);
    expect(readPickerRows({ modelPicker: { options: "nope" } })).toEqual([]);
  });

  it("builds a picker object only when there is something to list", () => {
    expect(buildModelPicker([])).toBeNull();
    expect(buildModelPicker([{ model: "x" }])).toEqual({ options: [{ model: "x" }] });
  });

  it("applies onto a missing document without inventing one", () => {
    expect(applyModelPicker(null, [{ model: "x" }])).toEqual({ modelPicker: { options: [{ model: "x" }] } });
    expect(applyModelPicker(null, [])).toEqual({});
  });
});
