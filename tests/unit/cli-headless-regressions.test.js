import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const api = require("../../cli/src/cli/api/client.js");
const { runHeadless, DOMAINS } = require("../../cli/src/cli/headless/index.js");
const { parseArgs, required } = require("../../cli/src/cli/headless/args.js");

afterEach(() => vi.restoreAllMocks());

describe("headless safety and contract regressions", () => {
  it.each(["", " ", true, undefined])("rejects blank or missing required values: %s", (value) => {
    expect(() => required({ filter: value }, "filter")).toThrow(/required/);
  });

  it("keeps JSON payload flags distinct from booleans", () => {
    expect(parseArgs(["settings", "patch", "--json", '{"enabled":false}']).opts.json).toBe('{"enabled":false}');
    expect(parseArgs(["nodes", "-h", "list"]).positionals).toEqual(["nodes", "list"]);
    expect(parseArgs(["nodes", "--json", "list"]).positionals).toEqual(["nodes", "list"]);
    expect(parseArgs(["settings", "set", "--value", "-0.25"]).opts.value).toBe("-0.25");
  });

  it("returns usage errors for invalid connection flags before configuring transport", async () => {
    const configure = vi.spyOn(api, "configure");
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runHeadless(["nodes", "list", "--port", "oops"])).toBe(2);
    expect(await runHeadless(["nodes", "list", "--host"])).toBe(2);
    expect(configure).not.toHaveBeenCalled();
  });

  it.each([
    ["providers", "delete"], ["nodes", "delete"], ["keys", "get"],
    ["combos", "delete"], ["network", "pool-test"], ["usage", "connection"],
  ])("rejects missing IDs for %s %s", async (domain, action) => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    expect(await runHeadless([domain, action])).toBe(2);
  });

  it("does not fetch combos for an empty bulk-delete filter", async () => {
    const list = vi.spyOn(api, "getCombos");
    await expect(DOMAINS.combos.run("bulk-delete", [], { filter: "" })).rejects.toMatchObject({ isUsage: true });
    expect(list).not.toHaveBeenCalled();
  });

  it.each(["null", "[]", "42", "invalid"])("rejects non-object settings patches: %s", async (json) => {
    const update = vi.spyOn(api, "updateSettings");
    expect(await DOMAINS.settings.run("patch", [], { json })).toHaveProperty("usage");
    expect(update).not.toHaveBeenCalled();
  });

  it("does not set a boolean when --value has no value", async () => {
    const update = vi.spyOn(api, "updateSettings");
    expect(await DOMAINS.settings.run("set", [], { key: "test", value: true })).toHaveProperty("usage");
    expect(update).not.toHaveBeenCalled();
  });

  it("masks JSON key listings without mutating the API response", async () => {
    const key = "sk_afrouter_example_secret_key";
    const keys = [{ id: "test", key }];
    vi.spyOn(api, "getApiKeys").mockResolvedValue({ success: true, data: { keys } });
    const result = await DOMAINS.keys.run("list", [], {});
    expect(result.data.keys[0].key).not.toBe(key);
    expect(keys[0].key).toBe(key);
  });

  it.each([["router.example", "router.example"], ["::1", "[::1]"]])("uses selected host %s and Codex subagent model", async (host, urlHost) => {
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ success: true, data: {} });
    const apply = vi.spyOn(api, "applyCliToolSettings").mockResolvedValue({ success: true, data: {} });
    await DOMAINS.tools.run("setup", [], {
      tool: "codex", model: "test/main", "subagent-model": "test/sub", "api-key": "test-only-key",
    }, { host, port: 34567 });
    expect(apply).toHaveBeenCalledWith("codex", {
      baseUrl: `http://${urlHost}:34567/v1`, apiKey: "test-only-key", model: "test/main", subagentModel: "test/sub",
    });
  });

  it("preserves explicitly selected Responses nodes", async () => {
    const create = vi.spyOn(api, "createProviderNode").mockResolvedValue({ success: true, data: {} });
    await DOMAINS.nodes.run("add", [], { name: "Test", prefix: "test", "base-url": "https://example.invalid", type: "openai-compatible", "api-type": "responses" });
    expect(create.mock.calls[0][0].apiType).toBe("responses");
  });
});
