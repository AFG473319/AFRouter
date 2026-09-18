import { afterEach, expect, it, vi } from "vitest";
import { fetchCodexStatus } from "../../src/shared/codexStatus.js";

afterEach(() => vi.unstubAllGlobals());

it("does not misreport a timeout as an absent installation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new DOMException("timeout", "TimeoutError")));
  expect(await fetchCodexStatus()).toMatchObject({ installed: null, error: expect.stringContaining("timed out") });
});

it("does not misreport an auth failure as an absent installation", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ error: "Unauthorized" }, { status: 401 })));
  expect(await fetchCodexStatus()).toEqual({ installed: null, error: "Unauthorized" });
});

it("preserves successful detection and explicit absence", async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ installed: true, configPath: "C:/Users/Test/.codex/config.toml" }))
    .mockResolvedValueOnce(Response.json({ installed: false }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await fetchCodexStatus()).toMatchObject({ installed: true });
  expect(await fetchCodexStatus()).toEqual({ installed: false });
});

it("handles non-JSON build failures as a failed check", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>Build error</html>", { status: 500 })));
  expect(await fetchCodexStatus()).toMatchObject({ installed: null, error: expect.any(String) });
});
