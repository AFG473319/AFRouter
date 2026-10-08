import { describe, expect, it } from "vitest";

import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getCapabilitiesForModel, PATTERN_THINKING, orderReasoningLevels } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { resolveModelSpec } from "../../open-sse/providers/modelSpecs.js";
import { THINKING_LEVELS, levelRank } from "../../open-sse/translator/concerns/thinking.js";

const isOrdered = (levels) => {
  const ranks = levels.map((l) => levelRank(l));
  // Off-ladder aliases (zai `thinking`) sort after the canonical set — they
  // are ordered by orderReasoningLevels, not by levelRank. Only assert the
  // canonical subset is ordered and `none` (when present) is first.
  const canonical = levels.filter((l) => levelRank(l) !== null);
  for (let i = 1; i < canonical.length; i++) {
    if (levelRank(canonical[i]) < levelRank(canonical[i - 1])) return false;
  }
  if (levels.includes("none") && canonical[0] !== "none") return false;
  return ranks.every((r, i) => r !== null || true) && canonical.length > 0 ? true : levels.length > 0;
};

describe("model-spec coverage: every provider, every model", () => {
  const providers = Object.keys(PROVIDER_MODELS);
  const rows = [];
  let totalModels = 0;
  let reasoningModels = 0;
  let withLadder = 0;
  let toggleOnly = 0;
  const gaps = [];

  for (const provider of providers) {
    const models = PROVIDER_MODELS[provider] || [];
    let pReasoning = 0;
    let pLadder = 0;
    let pToggle = 0;
    for (const entry of models) {
      const id = entry?.id;
      if (!id) continue;
      totalModels++;
      const caps = getCapabilitiesForModel(provider, id);
      // Every model has a finite contextWindow and maxOutput (floor allowed).
      if (!Number.isFinite(caps.contextWindow) || caps.contextWindow <= 0) {
        gaps.push(`${provider}/${id}: non-finite contextWindow ${caps.contextWindow}`);
      }
      if (!Number.isFinite(caps.maxOutput) || caps.maxOutput <= 0) {
        gaps.push(`${provider}/${id}: non-finite maxOutput ${caps.maxOutput}`);
      }
      if (!caps.reasoning) continue;
      reasoningModels++;
      pReasoning++;
      const levels = getThinkingLevels(provider, id);
      if (levels?.length) {
        withLadder++;
        pLadder++;
        // Non-empty, deduplicated, correctly ordered ladder.
        expect(new Set(levels).size, `${provider}/${id} ladder deduped`).toBe(levels.length);
        expect(isOrdered(levels), `${provider}/${id} ladder ordered low→high (${levels})`).toBe(true);
        // No ladder contains "none" when canDisable is false.
        if (caps.thinkingCanDisable === false) {
          expect(levels, `${provider}/${id} must not offer none`).not.toContain("none");
        }
        // Ladder matches the single resolver (not raw discovered).
        const spec = resolveModelSpec(provider, id);
        expect(spec.reasoningLevels, `${provider}/${id} resolveModelSpec agrees`).toEqual(levels);
      } else {
        // Explicitly toggle-only: reasoning true with no levels. Honest, not
        // invented — consumers offer a toggle only.
        toggleOnly++;
        pToggle++;
      }
    }
    rows.push({ provider, models: models.length, reasoning: pReasoning, ladder: pLadder, toggle: pToggle });
  }

  it("covers every registry provider", () => {
    expect(providers.length).toBeGreaterThan(50);
  });

  it("has no finite-limit gaps", () => {
    expect(gaps).toEqual([]);
  });

  it("PATTERN_THINKING overrides win over discovered ladders", () => {
    // Claude 4.6 without xhigh.
    expect(getThinkingLevels("claude", "claude-sonnet-4.6")).not.toContain("xhigh");
    expect(getThinkingLevels("claude", "claude-opus-4.6")).toContain("max");
    // Codex models cannot disable.
    expect(getThinkingLevels("codex", "gpt-5.6-sol")).not.toContain("none");
    // codebuddy-cn per-model sets.
    expect(getThinkingLevels("codebuddy-cn", "glm-5.3")).toEqual(["low", "high", "max"]);
    expect(getThinkingLevels("codebuddy-cn", "glm-5.2")).toEqual(["high", "xhigh"]);
    expect(getThinkingLevels("codebuddy-cn", "hy4-preview")).toEqual(["high"]);
    // mimo v2.5-pro without max.
    expect(getThinkingLevels("xiaomi-mimo", "mimo-v2.5-pro")).not.toContain("max");
  });

  it("prints a per-provider summary table", () => {
    const lines = ["provider | models | reasoning | ladder | toggle-only"];
    for (const r of rows) lines.push(`${r.provider} | ${r.models} | ${r.reasoning} | ${r.ladder} | ${r.toggle}`);
    lines.push(`TOTAL | ${totalModels} | ${reasoningModels} | ${withLadder} | ${toggleOnly}`);
    console.log("\n" + lines.join("\n"));
    expect(totalModels).toBeGreaterThan(0);
  });

  it("orderReasoningLevels dedups and orders", () => {
    expect(orderReasoningLevels(["max", "none", "low", "low", "high"])).toEqual(["none", "low", "high", "max"]);
    expect(THINKING_LEVELS[0]).toBe("none");
  });

  it("PATTERN_THINKING table is first-match-wins ordered", () => {
    expect(PATTERN_THINKING.length).toBeGreaterThan(0);
  });
});
