import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const state = vi.hoisted(() => ({ home: null }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => state.home || actual.homedir();
  return { ...actual, homedir, default: { ...actual, homedir } };
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

vi.mock("../../src/app/api/cli-tools/resolveApiKey.js", () => ({
  resolveCliApiKey: async (key) => (key && key.trim() ? key.trim() : ""),
}));

const smelt = await import("../../src/app/api/cli-tools/smelt-settings/route.js");
const codewhale = await import("../../src/app/api/cli-tools/codewhale-settings/route.js");
const forge = await import("../../src/app/api/cli-tools/forge-settings/route.js");
const jcode = await import("../../src/app/api/cli-tools/jcode-settings/route.js");

const req = (body) => ({ json: async () => body });
const platformConfigDir = (name) => {
  if (os.platform() === "win32") return path.join(process.env.APPDATA, name);
  return path.join(process.env.XDG_CONFIG_HOME, name);
};
const ENV_KEYS = ["XDG_CONFIG_HOME", "APPDATA", "CODEWHALE_CONFIG_PATH", "FORGE_CONFIG", "JCODE_HOME"];

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "cli-tools-home-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.XDG_CONFIG_HOME = path.join(state.home, ".config");
  process.env.APPDATA = path.join(state.home, "AppData", "Roaming");
});

describe("smelt-settings", () => {
  const configPath = () => path.join(platformConfigDir("smelt"), "init.lua");

  it("fresh install writes a managed init.lua block with the afrouter provider", async () => {
    const res = await smelt.POST(req({ baseUrl: "http://127.0.0.1:20128", apiKey: "k", model: "cc/claude-opus-4-7" }));
    expect(res.body.success).toBe(true);
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toContain('smelt.provider.register("afrouter"');
    expect(text).toContain('api_base = "http://127.0.0.1:20128/v1"');
    expect(text).toContain('api_key_env = "AFROUTER_API_KEY"');
  });

  it("preserves user Lua outside the managed block and is idempotent", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), 'print("mine")\n');
    await smelt.POST(req({ baseUrl: "http://x", model: "openai/gpt-4o" }));
    await smelt.POST(req({ baseUrl: "http://x", model: "openai/gpt-4o" }));
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toContain('print("mine")');
    expect(text.match(/smelt\.provider\.register/g)).toHaveLength(1);
  });

  it("DELETE removes only the managed block", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), 'print("mine")\n');
    await smelt.POST(req({ baseUrl: "http://x", model: "openai/gpt-4o" }));
    const res = await smelt.DELETE();
    expect(res.body.success).toBe(true);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe('print("mine")\n');
  });
});

describe("codewhale-settings", () => {
  const configPath = () => path.join(state.home, ".codewhale", "config.toml");

  it("fresh install writes provider = afrouter with providers.afrouter", async () => {
    const res = await codewhale.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    expect(res.body.success).toBe(true);
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toMatch(/provider = "afrouter"/);
    expect(text).toMatch(/\[providers\.afrouter\]/);
    expect(text).toMatch(/base_url = "http:\/\/x\/v1"/);
    expect(text).toMatch(/kind = "openai-compatible"/);
  });

  it("existing user file is preserved and parse errors return 409 without writing", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), 'theme = "dark"\n');
    await codewhale.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    expect(fs.readFileSync(configPath(), "utf-8")).toContain('theme = "dark"');

    fs.writeFileSync(configPath(), "this is = = broken");
    const res = await codewhale.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("this is = = broken");
  });

  it("DELETE removes only the afrouter provider", async () => {
    await codewhale.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    await codewhale.DELETE();
    const text = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), "utf-8") : "";
    expect(text).not.toMatch(/afrouter/);
  });
});

describe("forge-settings", () => {
  const configPath = () => path.join(state.home, ".forge", ".forge.toml");

  it("fresh install writes [[providers]] and [session] to ~/.forge/.forge.toml", async () => {
    const res = await forge.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    expect(res.body.success).toBe(true);
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toMatch(/\[\[providers\]\]/);
    expect(text).toMatch(/id = "afrouter"/);
    expect(text).toMatch(/api_key_var = "AFROUTER_API_KEY"/);
    expect(text).toMatch(/\[session\]/);
    expect(text).toMatch(/provider_id = "afrouter"/);
  });

  it("re-apply is idempotent and keeps other providers", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), '[[providers]]\nid = "other"\nurl = "http://o"\n');
    await forge.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    await forge.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toMatch(/id = "other"/);
    // Line-anchored: `provider_id = "afrouter"` in [session] also contains the
    // substring `id = "afrouter"`.
    expect(text.match(/^id = "afrouter"$/gm)).toHaveLength(1);
  });

  it("DELETE removes only the afrouter provider", async () => {
    await forge.POST(req({ baseUrl: "http://x", apiKey: "k", model: "openai/gpt-4o" }));
    await forge.DELETE();
    const text = fs.existsSync(configPath()) ? fs.readFileSync(configPath(), "utf-8") : "";
    expect(text).not.toMatch(/afrouter/);
  });
});

describe("jcode-settings", () => {
  // config.toml lives in ~/.jcode (1jehuang/jcode README); only the provider
  // env file lives under the platform config dir (dirs::config_dir()/jcode).
  const configPath = () => path.join(state.home, ".jcode", "config.toml");
  const envPath = () => path.join(platformConfigDir("jcode"), "provider-afrouter.env");

  it("writes config.toml under ~/.jcode and the env file under the platform config dir, with default_provider", async () => {
    const res = await jcode.POST(req({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] }));
    expect(res.body.success).toBe(true);
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).toMatch(/default_provider = "afrouter"/);
    expect(text).toMatch(/base_url = "http:\/\/x\/v1"/);
    expect(text).toMatch(/context_window = /);
    const env = fs.readFileSync(envPath(), "utf-8");
    expect(env).toContain('JCODE_AFROUTER_API_KEY="k"');
  });

  it("honors JCODE_HOME", async () => {
    process.env.JCODE_HOME = path.join(state.home, "jh");
    await jcode.POST(req({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] }));
    expect(fs.existsSync(path.join(state.home, "jh", "config", "jcode", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(state.home, "jh", "config", "jcode", "provider-afrouter.env"))).toBe(true);
  });

  it("parse error returns 409 and leaves the file untouched", async () => {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), "broken = = toml");
    const res = await jcode.POST(req({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] }));
    expect(res.status).toBe(409);
    expect(fs.readFileSync(configPath(), "utf-8")).toBe("broken = = toml");
  });

  it("DELETE removes the afrouter provider and key", async () => {
    await jcode.POST(req({ baseUrl: "http://x", apiKey: "k", models: ["openai/gpt-4o"] }));
    await jcode.DELETE();
    const text = fs.readFileSync(configPath(), "utf-8");
    expect(text).not.toMatch(/afrouter/);
    const env = fs.readFileSync(envPath(), "utf-8");
    expect(env).not.toContain("JCODE_AFROUTER_API_KEY");
  });
});
