/**
 * Unit tests for /api/cli-tools/hermes-settings (Nous Research Hermes Agent).
 *
 * The behavior under test is the multi-model shape: ONE named provider under
 * `providers:` (`afrouter`) that serves many models via its `models:` mapping,
 * referenced from every slot as `provider: custom:afrouter`. That is what makes
 * Hermes offer several AFRouter models in `hermes model` / `/model` — the old
 * shape declared one anonymous `provider: custom` endpoint per slot, which is
 * one model per endpoint.
 *
 * Every field asserted here is cited from the official docs:
 *   docs/user-guide/configuring-models  (providers dict, models mapping,
 *                                        provider: custom:<name>, api_mode)
 *   docs/integrations/providers         (providers.<name> fields, transport,
 *                                        discover_models, key_env, per-model
 *                                        context_length / supports_vision,
 *                                        "no longer reads max_output_tokens")
 *   docs/user-guide/configuration       (auxiliary task slots, delegation)
 *   hermes_cli/config_defaults.py       (canonical auxiliary task ids; web_extract
 *                                        and session_search are dead)
 *
 * os.homedir is redirected to a per-test temp dir so this machine's real
 * ~/.hermes/config.yaml is never read or written; the `hermes` PATH probe and
 * global.fetch are stubbed so spec resolution is deterministic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseYAML } from "confbox/yaml";

import { GET, POST, DELETE } from "../../src/app/api/cli-tools/hermes-settings/route.js";
import { HERMES_AUX_TASKS } from "../../src/lib/hermesConfig.js";
import { CLI_TOOLS } from "../../src/shared/constants/cliTools.js";

const state = vi.hoisted(() => ({ home: null }));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  const homedir = () => (state.home ? state.home : actual.homedir());
  return { ...actual, default: { ...actual, homedir } };
});

// The `hermes` PATH probe is not exercised: a mocked `child_process` does not
// reach the route module (vi.mock externalizes the builtin on that import
// path), so install detection is driven by ~/.hermes existing instead — which
// is what a real "installed, not yet configured" machine looks like anyway.
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

// The route self-fetches /v1/models for live specs. Refuse it so resolution
// falls through to the static registry, exactly as it does when the gateway is
// unreachable.
vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));

const ENDPOINT_URL = "/api/cli-tools/hermes-settings";

const dir = () => process.env.HERMES_HOME || path.join(state.home, ".hermes");
const configPath = () => path.join(dir(), "config.yaml");
const envPath = () => path.join(dir(), ".env");
const readYaml = () => fs.readFileSync(configPath(), "utf-8");
const readDoc = () => parseYAML(readYaml());
const readEnv = () => fs.readFileSync(envPath(), "utf-8");

function post(body) {
  return POST({ json: async () => body });
}

const BASE = "http://127.0.0.1:20128";

// openai/gpt-4o is the vision model; deepseek/deepseek-v4-pro is text-only;
// kilo/stealth/... carries slashes in its id, which is what proves the
// `models:` mapping keeps slash-bearing ids intact as YAML keys.
const MODEL_A = "openai/gpt-4o";
const MODEL_B = "openai/gpt-5";
const MODEL_C = "kilo/stealth/space-bunny-alpha";
const MODEL_TEXT_ONLY = "deepseek/deepseek-v4-pro";

beforeEach(() => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-home-"));
  // Pin the Hermes home so path resolution is platform-independent
  // (native Windows defaults to %LOCALAPPDATA%\hermes).
  vi.stubEnv("HERMES_HOME", path.join(state.home, ".hermes"));
  fetch.mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("hermes-settings", () => {
  it("declares ONE provider serving MANY models", async () => {
    const res = await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B, MODEL_C],
      selections: [{ role: "default", model: MODEL_B }],
    });
    expect(res.body.success).toBe(true);

    const doc = readDoc();
    // One named provider, not one anonymous endpoint per slot.
    expect(Object.keys(doc.providers)).toEqual(["afrouter"]);
    const provider = doc.providers.afrouter;
    expect(provider.api).toBe(`${BASE}/v1`);
    expect(provider.transport).toBe("chat_completions");
    expect(provider.key_env).toBe("AFROUTER_API_KEY");
    // discovery off => this mapping IS the picker's catalog
    expect(provider.discover_models).toBe(false);

    // Every model lands in the mapping, each with its own metadata.
    expect(Object.keys(provider.models).sort()).toEqual([MODEL_A, MODEL_B, MODEL_C].sort());
    for (const id of Object.keys(provider.models)) {
      expect(typeof provider.models[id].context_length).toBe("number");
      expect(provider.models[id].context_length).toBeGreaterThan(0);
    }
  });

  it("slots reference the named provider instead of re-declaring the endpoint", async () => {
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [
        { role: "default", model: MODEL_B },
        { role: "delegation", model: MODEL_A },
        { role: "vision", model: MODEL_A },
        { role: "compression", model: MODEL_B },
      ],
    });
    const doc = readDoc();

    expect(doc.model).toMatchObject({ default: MODEL_B, provider: "custom:afrouter" });
    expect(doc.delegation).toMatchObject({ model: MODEL_A, provider: "custom:afrouter" });
    expect(doc.auxiliary.vision).toMatchObject({ model: MODEL_A, provider: "custom:afrouter" });
    expect(doc.auxiliary.compression).toMatchObject({ model: MODEL_B, provider: "custom:afrouter" });

    // The endpoint must not be duplicated per slot: a stale inline base_url on
    // `delegation` takes precedence over `provider`, which would silently
    // override the named provider.
    for (const slot of [doc.model, doc.delegation, doc.auxiliary.vision, doc.auxiliary.compression]) {
      expect(slot.base_url).toBeUndefined();
      expect(slot.api_key).toBeUndefined();
      expect(slot.api_mode).toBeUndefined();
    }
  });

  it("writes only the documented per-model spec fields", async () => {
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B, MODEL_TEXT_ONLY],
      selections: [{ role: "default", model: MODEL_B }],
    });
    const { models } = readDoc().providers.afrouter;

    // context_length is the second link of Hermes' documented resolution chain
    // (model.context_length pin -> providers.<name>.models.<id>.context_length).
    expect(models[MODEL_B].context_length).toBeGreaterThan(0);

    // supports_vision only for a model that actually takes images — the key is
    // omitted rather than written false, so Hermes keeps its own detection.
    expect(models[MODEL_A].supports_vision).toBe(true);
    expect(models[MODEL_TEXT_ONLY].supports_vision).toBeUndefined();
    expect(Object.values(models).some((e) => e.supports_vision === false)).toBe(false);

    // Hermes no longer reads max_output_tokens anywhere; writing it would look
    // authoritative in the file and do nothing.
    for (const entry of Object.values(models)) {
      expect(entry.max_output_tokens).toBeUndefined();
      expect(Object.keys(entry).every((k) =>
        ["context_length", "supports_vision", "prompt_caching", "answer_in_reasoning"].includes(k),
      )).toBe(true);
    }
  });

  it("replaces the fresh-install empty-string sentinel without duplicating keys", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(configPath(), 'model: ""\n');
    await post({ baseUrl: BASE, apiKey: "sk_test", model: MODEL_A, models: [MODEL_A] });
    const doc = readDoc();
    expect(Object.keys(doc).filter((k) => k === "model").length).toBe(1);
    expect(doc.model.default).toBe(MODEL_A);
    // The sentinel must not survive anywhere as a stale non-mapping value.
    expect(typeof doc.model).toBe("object");
  });

  it("merges models additively and is idempotent, backing up the previous file", async () => {
    const body = {
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [{ role: "default", model: MODEL_A }],
    };
    await post(body);
    const first = readYaml();
    const res = await post(body);
    expect(readYaml()).toBe(first);
    expect(res.body.backupPath).toBeTruthy();

    // Adding a third model keeps the first two.
    await post({ ...body, models: [MODEL_A, MODEL_B, MODEL_C] });
    expect(Object.keys(readDoc().providers.afrouter.models).sort())
      .toEqual([MODEL_A, MODEL_B, MODEL_C].sort());
  });

  it("preserves unrelated providers, fields we do not own, and user sections", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      configPath(),
      [
        "other:",
        "  keep: true",
        "providers:",
        "  my-gateway:",
        "    api: https://llm.internal.example.com/v1",
        "    key_env: GW_KEY",
        "terminal:",
        "  backend: docker",
        "",
      ].join("\n"),
    );
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A],
      selections: [{ role: "default", model: MODEL_A }],
    });
    const doc = readDoc();
    expect(doc.other).toEqual({ keep: true });
    expect(doc.terminal).toEqual({ backend: "docker" });
    // A foreign provider is never claimed.
    expect(doc.providers["my-gateway"]).toEqual({
      api: "https://llm.internal.example.com/v1",
      key_env: "GW_KEY",
    });
  });

  it("keeps a user's own fields on our provider entry across a re-Apply", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      configPath(),
      [
        "providers:",
        "  afrouter:",
        "    api: http://old.example.com/v1",
        "    extra_headers:",
        "      CF-Access-Client-Id: xxxx",
        "    models:",
        "      openai/gpt-4o:",
        "        context_length: 999",
        "",
      ].join("\n"),
    );
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [{ role: "default", model: MODEL_B }],
    });
    const entry = readDoc().providers.afrouter;
    expect(entry.api).toBe(`${BASE}/v1`);
    expect(entry.extra_headers).toEqual({ "CF-Access-Client-Id": "xxxx" });
    expect(Object.keys(entry.models).sort()).toEqual([MODEL_A, MODEL_B].sort());
  });

  it("upgrades a legacy inline custom endpoint, dropping the stale base_url", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(
      configPath(),
      [
        "model:",
        '  default: "openai/gpt-4o"',
        '  provider: "custom"',
        "  base_url: \"http://127.0.0.1:20128/v1\"",
        '  api_key: "${OPENAI_API_KEY}"',
        '  api_mode: "chat_completions"',
        "delegation:",
        '  model: "openai/gpt-5"',
        '  provider: "custom"',
        "  base_url: \"http://127.0.0.1:20128/v1\"",
        "",
      ].join("\n"),
    );
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [{ role: "default", model: MODEL_A }],
    });
    const doc = readDoc();
    expect(Object.keys(doc.providers)).toEqual(["afrouter"]);
    expect(doc.model).toEqual({ default: MODEL_A, provider: "custom:afrouter" });
    // Legacy blocks we no longer reference must lose our endpoint fields.
    expect(doc.delegation?.base_url).toBeUndefined();
    expect(doc.delegation?.api_key).toBeUndefined();
  });

  it("clears a role the user un-set instead of leaving it stuck", async () => {
    const body = {
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [
        { role: "default", model: MODEL_B },
        { role: "vision", model: MODEL_A },
      ],
    };
    await post(body);
    expect(readDoc().auxiliary.vision.provider).toBe("custom:afrouter");

    await post({ ...body, selections: [{ role: "default", model: MODEL_B }] });
    expect(readDoc().auxiliary.vision).toBeUndefined();
  });

  it("never writes a dead auxiliary slot", async () => {
    // web_extract / session_search stopped using an aux LLM; Hermes ignores
    // leftover blocks, so writing one would look configured and do nothing.
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [
        { role: "default", model: MODEL_B },
        { role: "web_extract", model: MODEL_A },
        { role: "session_search", model: MODEL_A },
      ],
    });
    const aux = readDoc().auxiliary;
    expect(aux.web_extract).toBeUndefined();
    expect(aux.session_search).toBeUndefined();
  });

  it("every documented auxiliary slot is writable and matches the card's role list", async () => {
    const selections = HERMES_AUX_TASKS.map(({ id }) => ({ role: id, model: MODEL_A }));
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [{ role: "default", model: MODEL_B }, ...selections],
    });
    const aux = readDoc().auxiliary;
    for (const { id } of HERMES_AUX_TASKS) {
      expect(aux[id]).toMatchObject({ model: MODEL_A, provider: "custom:afrouter" });
    }
    // The card renders exactly the canonical set — a drift here is the bug that
    // shipped `web_extract` as a role.
    expect(CLI_TOOLS.hermes.roles.map((r) => r.id)).toEqual(HERMES_AUX_TASKS.map((t) => t.id));
    expect(CLI_TOOLS.hermes.roles.map((r) => r.id)).not.toContain("web_extract");
  });

  it("writes the key to .env only, never into config.yaml", async () => {
    await post({ baseUrl: BASE, apiKey: "sk_secret_value", models: [MODEL_A], selections: [{ role: "default", model: MODEL_A }] });
    expect(readEnv()).toContain("AFROUTER_API_KEY=sk_secret_value");
    expect(readYaml()).not.toContain("sk_secret_value");
  });

  it("refuses to write an unreadable config.yaml", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(configPath(), "model: [unclosed\n  : : :\n");
    const before = readYaml();
    const res = await post({ baseUrl: BASE, apiKey: "k", models: [MODEL_A], selections: [{ role: "default", model: MODEL_A }] });
    expect(res.status).toBe(409);
    expect(readYaml()).toBe(before);
  });

  it("GET reports install state, models and the endpoint without leaking the key", async () => {
    await post({ baseUrl: BASE, apiKey: "sk_secret_value", models: [MODEL_A, MODEL_B], selections: [{ role: "default", model: MODEL_B }] });
    fetch.mockClear();
    const res = await GET();
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(true);
    expect(res.body.provider.api).toBe(`${BASE}/v1`);
    expect(res.body.models.sort()).toEqual([MODEL_A, MODEL_B].sort());
    expect(res.body.settings.model.default).toBe(MODEL_B);
    expect(JSON.stringify(res.body)).not.toContain("sk_secret_value");
  });

  it("GET never 500s on a missing or corrupt config.yaml", async () => {
    // ~/.hermes exists (a fresh install) but holds no config yet.
    fs.mkdirSync(dir(), { recursive: true });
    const res = await GET();
    expect(res.body.installed).toBe(true);
    expect(res.body.hasAFRouter).toBe(false);
    expect(res.body.models).toEqual([]);
    expect(res.body.settings).toEqual({ model: null, delegation: null, auxiliary: {} });

    fs.writeFileSync(configPath(), "\t- not: [valid\n");
    const corrupt = await GET();
    expect(corrupt.body.corrupt).toBe(true);
    expect(corrupt.body.settings).toBeNull();
  });

  it("GET reports not-installed when ~/.hermes is absent", async () => {
    const res = await GET();
    expect(res.body.installed).toBe(false);
    expect(res.body.settings).toBeNull();
  });

  it("DELETE removes the provider, our slots and our .env key", async () => {
    fs.mkdirSync(dir(), { recursive: true });
    fs.writeFileSync(envPath(), "OPENAI_API_KEY=mine\nAFROUTER_API_KEY=sk_test\n");
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [
        { role: "default", model: MODEL_B },
        { role: "delegation", model: MODEL_A },
        { role: "mcp", model: MODEL_A },
      ],
    });
    const res = await DELETE();
    expect(res.body.success).toBe(true);

    const doc = readDoc();
    expect(doc.providers).toBeUndefined();
    expect(doc.model).toBeUndefined();
    expect(doc.delegation).toBeUndefined();
    expect(doc.auxiliary?.mcp).toBeUndefined();
    // A key the user owns is theirs, not ours.
    expect(readEnv()).toContain("OPENAI_API_KEY=mine");
    expect(readEnv()).not.toContain("AFROUTER_API_KEY");
  });

  it("DELETE of one model drops it and clears slots that pointed at it", async () => {
    await post({
      baseUrl: BASE,
      apiKey: "sk_test",
      models: [MODEL_A, MODEL_B],
      selections: [
        { role: "default", model: MODEL_B },
        { role: "vision", model: MODEL_A },
        { role: "mcp", model: MODEL_B },
      ],
    });
    const res = await DELETE({ url: `${ENDPOINT_URL}?model=${encodeURIComponent(MODEL_A)}` });
    expect(res.body.removed).toBe(1);

    const doc = readDoc();
    expect(Object.keys(doc.providers.afrouter.models)).toEqual([MODEL_B]);
    // A dangling slot can never be selected again, so it is cleared.
    expect(doc.auxiliary.vision).toBeUndefined();
    // Untouched slots survive.
    expect(doc.auxiliary.mcp.model).toBe(MODEL_B);

    // Removing a model that is not ours is a no-op.
    const again = await DELETE({ url: `${ENDPOINT_URL}?model=openai/gpt-4o-mini` });
    expect(again.body.removed).toBe(0);
    expect(Object.keys(readDoc().providers.afrouter.models)).toEqual([MODEL_B]);
  });

  it("DELETE is inert when nothing is configured", async () => {
    const res = await DELETE();
    expect(res.body.success).toBe(true);
    expect(res.body.removed).toBe(0);
  });
});
