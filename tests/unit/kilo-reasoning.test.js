/**
 * Unit tests for Kilo's reasoning-level mapper.
 *
 * Kilo's catalog publishes a per-model variant map whose KEY is a display label
 * and whose `reasoning.effort` is the wire value. Measured against the live
 * catalog: 127 `thinking → high` and 97 `instant → none`, so the key/effort
 * split is the normal case, not an edge case. These tests pin that, plus the
 * `reasoning.enabled` axis and the "reasons but no effort control" case.
 */

import { describe, it, expect } from "vitest";
import { kiloReasoningLevels, kiloEffortValues } from "../../src/lib/kiloReasoning.js";

// Real entries, copied from https://api.kilo.ai/api/gateway/models
const SPACE_BUNNY = {
  id: "stealth/space-bunny-alpha",
  supported_parameters: ["max_tokens", "tools", "reasoning", "reasoning_effort"],
  opencode: {
    variants: {
      low: { reasoning: { enabled: true, effort: "low" } },
      medium: { reasoning: { enabled: true, effort: "medium" } },
      high: { reasoning: { enabled: true, effort: "high" } },
      xhigh: { reasoning: { enabled: true, effort: "xhigh" } },
      max: { reasoning: { enabled: true, effort: "max" } },
    },
  },
};

describe("kiloReasoningLevels", () => {
  it("reads a straight level→effort map", () => {
    const r = kiloReasoningLevels(SPACE_BUNNY);
    expect(r.levels.map((l) => l.level)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(r.levels.map((l) => l.effort)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(r.canDisable).toBe(false);
  });

  it("keeps an alias's display label distinct from its wire value", () => {
    // `thinking` is Kilo's label for effort `high`; `instant` for `none`.
    const r = kiloReasoningLevels({
      id: "alias/model",
      opencode: {
        variants: {
          instant: { reasoning: { enabled: true, effort: "none" } },
          thinking: { reasoning: { enabled: true, effort: "high" } },
          max: { reasoning: { enabled: true, effort: "max" } },
        },
      },
    });
    // Ordered weakest→strongest by display label, not alphabetical.
    expect(r.levels).toEqual([
      { level: "instant", effort: "none" },
      { level: "thinking", effort: "high" },
      { level: "max", effort: "max" },
    ]);
    // `instant` carries effort `none`, so the model can disable thinking.
    expect(r.canDisable).toBe(true);
  });

  it("drops variants whose reasoning is not enabled", () => {
    const r = kiloReasoningLevels({
      id: "partial/model",
      opencode: {
        variants: {
          none: { reasoning: { enabled: false, effort: "none" } },
          high: { reasoning: { enabled: true, effort: "high" } },
        },
      },
    });
    expect(r.levels).toEqual([{ level: "high", effort: "high" }]);
    expect(r.canDisable).toBe(false);
  });

  it("falls back to the key as the effort when a variant omits one", () => {
    const r = kiloReasoningLevels({
      id: "sparse/model",
      opencode: { variants: { medium: { reasoning: { enabled: true } } } },
    });
    expect(r.levels).toEqual([{ level: "medium", effort: "medium" }]);
  });

  it("reports no selectable effort for a model that reasons without variants", () => {
    // 4 such models in the live catalog (typesafe/jev-router, openrouter/auto*).
    const r = kiloReasoningLevels({
      id: "typesafe/jev-router",
      supported_parameters: ["reasoning", "reasoning_effort"],
      opencode: {},
    });
    expect(r).toEqual({ levels: [], canDisable: false });
  });

  it("returns null when the catalog declares no reasoning at all", () => {
    // 118 models: no variants, no reasoning parameter.
    expect(kiloReasoningLevels({ id: "plain/model", supported_parameters: ["tools"], opencode: {} })).toBeNull();
    expect(kiloReasoningLevels({ id: "bare/model" })).toBeNull();
  });

  it("treats reasoning_effort as a reasoning signal on its own", () => {
    const r = kiloReasoningLevels({
      id: "effort-only/model",
      supported_parameters: ["reasoning_effort"],
      opencode: {},
    });
    expect(r).toEqual({ levels: [], canDisable: false });
  });

  it("exposes only wire values through kiloEffortValues — never display aliases", () => {
    // The router reconciles canonical levels at dispatch; display aliases are a
    // picker concern and must not leak into the supported-effort set.
    expect(kiloEffortValues({
      id: "alias/model",
      opencode: {
        variants: {
          instant: { reasoning: { enabled: true, effort: "none" } },
          thinking: { reasoning: { enabled: true, effort: "high" } },
        },
      },
    })).toEqual(["none", "high"]);
    expect(kiloEffortValues({ id: "plain/model" })).toBeNull();
  });
});
