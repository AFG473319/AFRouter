import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setupDb(opts = {}) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "9router-cursor-bare-"));
  process.env.DATA_DIR = tempDir;
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  vi.resetModules();

  if (opts.mockCursorLive) {
    vi.doMock("open-sse/services/cursorModels.js", () => ({
      resolveCursorModels: vi.fn(async () => ({
        models: opts.mockCursorLive,
      })),
      clearCursorModelCache: vi.fn(),
      parseCursorUsableModels: vi.fn(),
    }));
  }

  const models = await import("@/models/index.js");
  const { getModelInfo, resolveBareModelViaCursor } = await import("@/sse/services/model.js");

  return {
    ...models,
    getModelInfo,
    resolveBareModelViaCursor,
    cleanup() {
      try { global._dbAdapter?.instance?.close?.(); } catch {}
      delete global._dbAdapter;
      fs.rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

describe("bare Cursor model routing", () => {
  let cleanup = () => {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    vi.doUnmock("open-sse/services/cursorModels.js");
    vi.clearAllMocks();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("routes bare gpt-* to cursor when the id is in the live Cursor catalog", async () => {
    const ctx = await setupDb({
      mockCursorLive: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }],
    });
    cleanup = ctx.cleanup;

    await ctx.createProviderConnection({
      provider: "cursor",
      name: "cursor-test",
      accessToken: "cursor-token",
      isActive: true,
      providerSpecificData: { machineId: "machine-1" },
    });

    await expect(ctx.getModelInfo("gpt-5.6-sol")).resolves.toEqual({
      provider: "cursor",
      model: "gpt-5.6-sol",
    });
  });

  it("routes bare composer-* to cursor when a Cursor connection is active", async () => {
    const ctx = await setupDb({ mockCursorLive: [] });
    cleanup = ctx.cleanup;

    await ctx.createProviderConnection({
      provider: "cursor",
      name: "cursor-test",
      accessToken: "cursor-token",
      isActive: true,
      providerSpecificData: { machineId: "machine-1" },
    });

    await expect(ctx.getModelInfo("composer-2.5")).resolves.toEqual({
      provider: "cursor",
      model: "composer-2.5",
    });
  });

  // Bare Codex-only slugs (gpt-5.x/6.x, gpt-daybreak-*, gpt-reserve*) infer the
  // codex provider since v0.5.95 (upstream #4405: they 404 on the OpenAI API
  // for Codex-OAuth-only users), so the openai-fallback case uses gpt-4o,
  // which still falls through to the generic gpt-* rule.
  it("still infers openai for bare gpt-4* when no Cursor connection exists", async () => {
    const ctx = await setupDb({
      mockCursorLive: [{ id: "gpt-4o", name: "GPT 4o" }],
    });
    cleanup = ctx.cleanup;

    await expect(ctx.getModelInfo("gpt-4o")).resolves.toEqual({
      provider: "openai",
      model: "gpt-4o",
    });
  });

  it("prefers an explicit model alias over Cursor catalog routing", async () => {
    const ctx = await setupDb({
      mockCursorLive: [{ id: "gpt-5.6-sol", name: "GPT 5.6 Sol" }],
    });
    cleanup = ctx.cleanup;

    await ctx.createProviderConnection({
      provider: "cursor",
      name: "cursor-test",
      accessToken: "cursor-token",
      isActive: true,
      providerSpecificData: { machineId: "machine-1" },
    });
    await ctx.setModelAlias("gpt-5.6-sol", "openai/gpt-5.6-sol");

    await expect(ctx.getModelInfo("gpt-5.6-sol")).resolves.toEqual({
      provider: "openai",
      model: "gpt-5.6-sol",
    });
  });
});
