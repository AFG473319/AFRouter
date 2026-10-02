/**
 * Discovered per-model reasoning levels.
 *
 * models.dev publishes each model's reasoning controls as `reasoning_options`
 * (an `effort` ladder, a `toggle`, or a numeric `budget_tokens`). AFrouter already
 * syncs that catalog daily; this test pins that an `effort` ladder is carried
 * through the sync into `getCatalogReasoning`, surfaced on capabilities, and used
 * by `getThinkingLevels` — so a model's selectable levels come from a real
 * per-model source instead of a format default.
 *
 * A `toggle`/`budget` model must NOT be given an empty level set: the
 * hand-authored tables describe those better, so discovery stays out of the way.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The catalog reader resolves its file path from DATA_DIR at import time, so the
// temp dir has to exist before the first import.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-reasoning-"));
process.env.DATA_DIR = dataDir;
const catalogFile = path.join(dataDir, "model-catalog.json");

const upstream = {
  ladder: {
    models: {
      "ladder-model": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh", "max"] }],
      },
      // Reasons, but exposes no selectable magnitude → no effort ladder.
      "toggle-model": {
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      },
      // Numeric budget → also not a level ladder.
      "budget-model": {
        reasoning: true,
        reasoning_options: [{ type: "budget_tokens", min: 1024, max: 32768 }],
      },
    },
  },
};

const entries = [
  { provider: "ladder", model: "ladder-model", current: { contextWindow: 200000, maxOutput: 128000 } },
  { provider: "ladder", model: "toggle-model", current: { contextWindow: 200000, maxOutput: 128000 } },
  { provider: "ladder", model: "budget-model", current: { contextWindow: 200000, maxOutput: 128000 } },
];

let build, getCatalogReasoning, capabilities, thinkingLevels;

beforeAll(async () => {
  ({ build } = await import("../../src/lib/modelCatalog/sync.js"));
  ({ getCatalogReasoning } = await import("../../open-sse/providers/catalogOverride.js"));
  capabilities = await import("../../open-sse/providers/capabilities.js");
  thinkingLevels = await import("../../open-sse/providers/thinkingLevels.js");

  const { models, providers } = build(upstream, entries);
  fs.writeFileSync(catalogFile, JSON.stringify({ v: 3, models, providers }));
  // Install the reader the same way the server does at startup. Restored to null
  // in afterAll so this file cannot perturb other suites through the process-wide
  // catalog slot.
  capabilities.setCatalogSource({
    getModalities: () => null,
    getLimits: () => null,
    getReasoning: getCatalogReasoning,
  });
});

afterAll(() => {
  capabilities.setCatalogSource(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("discovered reasoning levels", () => {
  it("carries an effort ladder through the sync", () => {
    expect(getCatalogReasoning("ladder", "ladder-model")).toEqual({
      levels: ["none", "low", "medium", "high", "xhigh", "max"],
      canDisable: true,
    });
  });

  it("does not invent levels for a toggle or budget model", () => {
    expect(getCatalogReasoning("ladder", "toggle-model")).toBeNull();
    expect(getCatalogReasoning("ladder", "budget-model")).toBeNull();
  });

  it("surfaces the ladder on capabilities and marks the model as reasoning", () => {
    const caps = capabilities.getCapabilitiesForModel("ladder", "ladder-model");
    expect(caps.reasoning).toBe(true);
    expect(caps.reasoningLevels).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("uses the discovered ladder as the model's selectable levels", () => {
    expect(thinkingLevels.getThinkingLevels("ladder", "ladder-model"))
      .toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
  });

  it("leaves a model without a discovered ladder on the format default", () => {
    // No effort ladder → getThinkingLevels falls back to the hand-authored tables
    // rather than returning the discovery result.
    const caps = capabilities.getCapabilitiesForModel("ladder", "toggle-model");
    expect(caps.reasoningLevels).toBeUndefined();
  });
});