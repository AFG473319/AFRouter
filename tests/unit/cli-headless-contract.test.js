import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const api = require("../../cli/src/cli/api/client.js");
const { parseArgs, globals } = require("../../cli/src/cli/headless/args.js");
const { runHeadless } = require("../../cli/src/cli/headless/index.js");

afterEach(() => vi.restoreAllMocks());

describe("headless command contracts", () => {
  it("does not consume actions after boolean flags", () => {
    expect(parseArgs(["nodes", "--human", "list"])).toEqual({ positionals: ["nodes", "list"], opts: { human: true } });
  });
  it.each(["oops", "20128oops", "0", "65536", true])("rejects invalid port %s", (port) => {
    expect(() => globals({ port })).toThrow(/port/i);
  });
  it("preserves negative numeric values", () => {
    expect(parseArgs(["settings", "set", "--value", "-1"]).opts.value).toBe("-1");
  });
  it("returns usage errors on stderr for unknown actions", async () => {
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    expect(await runHeadless(["nodes", "bogus"])).toBe(2);
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalled();
  });
  it("fails status when the gateway is offline", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(api, "req").mockResolvedValue({ success: false, error: "offline" });
    vi.spyOn(api, "getVersion").mockResolvedValue({ success: false, error: "offline" });
    expect(await runHeadless(["status"])).toBe(1);
  });
  it("defaults compatible nodes to chat", async () => {
    const create = vi.spyOn(api, "createProviderNode").mockResolvedValue({ success: true, data: {} });
    const nodes = require("../../cli/src/cli/headless/domains/nodes.js");
    await nodes.run("add", [], { name: "Test", prefix: "test", "base-url": "https://example.invalid/v1", type: "openai-compatible" });
    expect(create.mock.calls[0][0].apiType).toBe("chat");
  });
  it("passes full custom model identity", async () => {
    const remove = vi.spyOn(api, "deleteCustomModel").mockResolvedValue({ success: true, data: {} });
    const models = require("../../cli/src/cli/headless/domains/models.js");
    await models.run("custom-del", [], { provider: "test", id: "model", type: "embedding" });
    expect(remove).toHaveBeenCalledWith("model", "test", "embedding");
  });
  it("uses Codex's single-model contract", async () => {
    vi.spyOn(api, "getTunnelStatus").mockResolvedValue({ success: true, data: {} });
    const apply = vi.spyOn(api, "applyCliToolSettings").mockResolvedValue({ success: true, data: {} });
    const tools = require("../../cli/src/cli/headless/domains/tools.js");
    await tools.run("setup", [], { tool: "codex", model: "test/model", "api-key": "test-key" }, { port: 20128, host: "127.0.0.1" });
    expect(apply.mock.calls[0][1]).toMatchObject({ model: "test/model" });
  });
});
