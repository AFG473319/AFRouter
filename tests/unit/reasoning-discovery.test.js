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
      // A real zai-format id: its exact table entry short-circuits the
      // *glm-5.2* pattern, so without derivation the wire flag stays false.
      "glm-5.2": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["high", "max"] }],
      },
      // A 4.x id: toggle-only upstream, so the wire flag must stay false.
      "glm-4.6v": {
        reasoning: true,
        reasoning_options: [{ type: "toggle" }],
      },
    },
  },
  // A passthrough gateway: these ids are NOT in the registry snapshot's model
  // list (they arrive through a modelsFetcher), which is what made every one of
  // them fall back to the fixed ladder.
  opencode: {
    models: {
      "space-bunny-free": {
        reasoning: true,
        reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
      },
      "big-pickle": { reasoning: true },
    },
  },
};

const entries = [
  { provider: "ladder", model: "ladder-model", current: { contextWindow: 200000, maxOutput: 128000 } },
  { provider: "ladder", model: "toggle-model", current: { contextWindow: 200000, maxOutput: 128000 } },
  { provider: "ladder", model: "budget-model", current: { contextWindow: 200000, maxOutput: 128000 } },
  { provider: "ladder", model: "glm-5.2", current: { contextWindow: 200000, maxOutput: 128000 } },
  { provider: "ladder", model: "glm-4.6v", current: { contextWindow: 200000, maxOutput: 128000 } },
  // Seed view only: the registry's static list for a passthrough provider does
  // not contain space-bunny-free / big-pickle.
  { provider: "opencode", model: "jev-1.13-free", current: { contextWindow: 200000, maxOutput: 32000 } },
];

let build, getCatalogReasoning, getCatalogReasons, capabilities, thinkingLevels;

beforeAll(async () => {
  ({ build } = await import("../../src/lib/modelCatalog/sync.js"));
  let CATALOG_VERSION;
  ({ getCatalogReasoning, getCatalogReasons, CATALOG_VERSION } = await import("../../open-sse/providers/catalogOverride.js"));
  capabilities = await import("../../open-sse/providers/capabilities.js");
  thinkingLevels = await import("../../open-sse/providers/thinkingLevels.js");

  const { models, providers } = build(upstream, entries);
  fs.writeFileSync(catalogFile, JSON.stringify({ v: CATALOG_VERSION, models, providers }));
  // Install the reader the same way the server does at startup. Restored to null
  // in afterAll so this file cannot perturb other suites through the process-wide
  // catalog slot.
  capabilities.setCatalogSource({
    getModalities: () => null,
    getLimits: () => null,
    getReasoning: getCatalogReasoning,
    getReasons: getCatalogReasons,
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

  it("auto-recognizes the wire flag for a zai model with a discovered ladder", () => {
    // "glm-5.2" hits an exact table entry (zai format, no flag) that
    // short-circuits the *glm-5.2* pattern — the flag must come from the
    // discovered ladder instead of a hand edit on the entry.
    const caps = capabilities.getCapabilitiesForModel("ladder", "glm-5.2");
    expect(caps.thinkingFormat).toBe("zai");
    expect(caps.reasoningLevels).toEqual(["high", "max"]);
    expect(caps.thinkingEffortSupported).toBe(true);
  });

  it("keeps the wire flag off for a toggle-only model", () => {
    // Upstream publishes no effort ladder for 4.x, so the zai wire keeps
    // skipping the field — a toggle is not effort control.
    const caps = capabilities.getCapabilitiesForModel("ladder", "glm-4.6v");
    expect(caps.thinkingFormat).toBe("zai");
    expect(caps.thinkingEffortSupported).toBe(false);
  });

  it("indexes a passthrough model the registry never seeds", () => {
    // space-bunny-free is not in the static `models` list of its provider — it
    // only exists because a modelsFetcher surfaces it — and that is precisely
    // the case that used to fall through to the fixed fallback ladder.
    const caps = capabilities.getCapabilitiesForModel("opencode", "space-bunny-free");
    expect(caps.reasoning).toBe(true);
    expect(caps.reasoningLevels).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("resolves a dashboard alias to the registry id the file is keyed by", () => {
    // /api/models, the no-connections /v1/models path and the CLI-tool routes
    // hand the reader `oc`, not `opencode`. Without this the lookup misses the
    // row silently and every consumer sees "no levels".
    expect(getCatalogReasoning("oc", "space-bunny-free")).toEqual({
      levels: ["low", "medium", "high", "xhigh", "max"],
      canDisable: false,
    });
    expect(capabilities.getCapabilitiesForModel("oc", "space-bunny-free").reasoningLevels)
      .toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("reports a reasoning model with no ladder as reasoning, but invents no levels", () => {
    // big-pickle reasons (models.dev says so) yet publishes no ladder: it must
    // stop being labelled "does not support reasoning" without being handed a
    // vocabulary only the hand tables should choose.
    expect(getCatalogReasoning("opencode", "big-pickle")).toBeNull();
    expect(getCatalogReasons("opencode", "big-pickle")).toBe(true);
    const caps = capabilities.getCapabilitiesForModel("oc", "big-pickle");
    expect(caps.reasoning).toBe(true);
    expect(caps.reasoningLevels).toBeUndefined();
    // ...and a toggle is still not effort control.
    expect(caps.thinkingEffortSupported).toBe(false);
  });
});