import { describe, expect, it } from "vitest";

import { resolveModelSpec } from "../../open-sse/providers/modelSpecs.js";
import { aggregateComboCapabilities } from "../../open-sse/providers/capabilities.js";
import { buildModelEntry as buildPiEntry, piThinkingLevelMap } from "../../src/lib/piConfig.js";
import { buildModelEntry as buildOmpEntry, ompThinking } from "../../src/lib/ompConfig.js";
import { buildModelEntry as buildDshEntry } from "../../src/lib/dshModelSpecs.js";
import { buildModelEntry as buildOpenCodeEntry, opencodeReasoningVariants } from "../../src/lib/opencodeConfig.js";
import { buildModelEntry as buildMimocodeEntry } from "../../src/lib/mimocodeConfig.js";
import { buildHermesModelEntry } from "../../src/lib/hermesConfig.js";
import { mapReasoningLevels } from "../../src/lib/zcodeReasoningLevels.js";
import { applyGrokBuildConfig } from "../../src/lib/grokBuildConfig.js";

// Fixed model set (task spec): GPT-style ladder with none, Codex no-disable,
// Claude 4.6 no xhigh, Claude adaptive with xhigh/max, DeepSeek none/high/max,
// zai on/off, a codebuddy-cn override, a non-reasoning vision model, a combo.
const MODELS = {
  gpt: "openai/gpt-5",
  codex: "codex/gpt-5.6-sol",
  claude46: "claude/claude-sonnet-4.6",
  claudeAdaptive: "claude/claude-opus-4.7",
  deepseek: "deepseek/deepseek-v4-pro",
  zai: "glm/glm-5.3",
  codebuddy: "codebuddy-cn/glm-5.3",
  visionFlat: "openai/gpt-4o",
};

const split = (id) => {
  const i = id.indexOf("/");
  return [id.slice(0, i), id.slice(i + 1)];
};

const specFor = (id) => {
  const [p, m] = split(id);
  return resolveModelSpec(p, m);
};

describe("cli model snapshot: fixed model set", () => {
  it("resolves the documented ladders", () => {
    expect(specFor(MODELS.gpt).reasoningLevels).toContain("none");
    expect(specFor(MODELS.codex).reasoningLevels).not.toContain("none");
    expect(specFor(MODELS.claude46).reasoningLevels).not.toContain("xhigh");
    expect(specFor(MODELS.claude46).reasoningLevels).toContain("max");
    expect(specFor(MODELS.claudeAdaptive).reasoningLevels).toEqual(
      expect.arrayContaining(["xhigh", "max"]),
    );
    expect(specFor(MODELS.zai).reasoningLevels).toEqual(["none", "thinking"]);
    expect(specFor(MODELS.codebuddy).reasoningLevels).toEqual(["low", "high", "max"]);
    expect(specFor(MODELS.visionFlat).reasoning).toBe(false);
    expect(specFor(MODELS.visionFlat).reasoningLevels).toBeUndefined();
  });

  it("pi entries carry thinkingLevelMap only for mappable reasoning models", () => {
    const entries = Object.fromEntries(
      Object.values(MODELS).map((id) => {
        const s = specFor(id);
        return [id, buildPiEntry(id, { ...s, maxTokens: s.maxOutput, vision: s.vision })];
      }),
    );
    // GPT ladder: full map, off enabled.
    expect(entries[MODELS.gpt].thinkingLevelMap).toEqual({
      off: "none", minimal: "minimal", low: "low", medium: "medium",
      high: "high", xhigh: "xhigh", max: null,
    });
    // Codex no-disable: off hidden.
    expect(entries[MODELS.codex].thinkingLevelMap.off).toBeNull();
    // Claude 4.6: xhigh hidden.
    expect(entries[MODELS.claude46].thinkingLevelMap).toMatchObject({ xhigh: null, max: "max" });
    // zai binary ladder: no mappable effort, field omitted.
    expect(entries[MODELS.zai].thinkingLevelMap).toBeUndefined();
    expect(entries[MODELS.zai].reasoning).toBe(true);
    // Non-reasoning vision model: reasoning + map both absent.
    expect(entries[MODELS.visionFlat].reasoning).toBeUndefined();
    expect(entries[MODELS.visionFlat].thinkingLevelMap).toBeUndefined();
    expect(entries[MODELS.visionFlat].input).toEqual(["text", "image"]);
    expect(entries).toMatchSnapshot();
  });

  it("omp entries carry thinking blocks only for mappable reasoning models", () => {
    const entries = Object.fromEntries(
      Object.values(MODELS).map((id) => {
        const s = specFor(id);
        return [id, buildOmpEntry(id, { ...s, maxTokens: s.maxOutput, vision: s.vision })];
      }),
    );
    expect(entries[MODELS.gpt].thinking).toEqual({
      mode: "effort",
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      defaultLevel: "xhigh",
    });
    expect(entries[MODELS.codebuddy].thinking).toEqual({
      mode: "effort", efforts: ["low", "high", "max"], defaultLevel: "max",
    });
    expect(entries[MODELS.zai].thinking).toBeUndefined();
    expect(entries[MODELS.visionFlat].thinking).toBeUndefined();
    expect(entries).toMatchSnapshot();
  });

  it("dsh entries map none to off and keep the real vocabulary", () => {
    const entries = Object.fromEntries(
      Object.values(MODELS).map((id) => {
        const s = specFor(id);
        return [id, buildDshEntry(id, { ...s, maxTokens: s.maxOutput })];
      }),
    );
    expect(entries[MODELS.gpt].reasoningEfforts.off).toBeNull();
    expect(entries[MODELS.codex].reasoningEfforts.off).toBeUndefined();
    expect(entries[MODELS.visionFlat].reasoningEfforts).toBeUndefined();
    expect(entries).toMatchSnapshot();
  });

  it("opencode v1+v2 entries carry variants only for reasoning models", () => {
    const v1 = Object.fromEntries(
      Object.values(MODELS).map((id) => [id, buildOpenCodeEntry(id, specFor(id), "v1")]),
    );
    const v2 = Object.fromEntries(
      Object.values(MODELS).map((id) => [id, buildOpenCodeEntry(id, specFor(id), "v2")]),
    );
    expect(Object.keys(v1[MODELS.gpt].variants)).toEqual(
      ["none", "minimal", "low", "medium", "high", "xhigh"],
    );
    expect(v1[MODELS.codex].variants.none).toBeUndefined();
    expect(v1[MODELS.visionFlat].variants).toBeUndefined();
    expect(v2[MODELS.gpt].variants).toEqual([
      { id: "none", settings: { reasoningEffort: "none" } },
      { id: "minimal", settings: { reasoningEffort: "minimal" } },
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "xhigh", settings: { reasoningEffort: "xhigh" } },
    ]);
    expect(v2[MODELS.visionFlat].variants).toBeUndefined();
    expect(opencodeReasoningVariants({ reasoning: false })).toBeUndefined();
    expect({ v1, v2 }).toMatchSnapshot();
  });

  it("mimocode entries keep limit/modalities/reasoning shape", () => {
    const entries = Object.fromEntries(
      Object.values(MODELS).map((id) => [id, buildMimocodeEntry(id, specFor(id))]),
    );
    expect(entries[MODELS.gpt].limit.context).toBe(specFor(MODELS.gpt).contextWindow);
    expect(entries[MODELS.gpt].reasoning).toBe(true);
    expect(entries[MODELS.visionFlat].reasoning).toBe(false);
    expect(entries).toMatchSnapshot();
  });

  it("zcode mapper converts none to disabled and keeps order", () => {
    expect(mapReasoningLevels(specFor(MODELS.gpt).reasoningLevels)).toEqual(
      ["disabled", "minimal", "low", "medium", "high", "xhigh"],
    );
    expect(mapReasoningLevels(specFor(MODELS.codex).reasoningLevels)[0]).not.toBe("disabled");
    expect(mapReasoningLevels(specFor(MODELS.codex).reasoningLevels)).not.toContain("none");
    // zai binary ladder becomes the documented disabled/enabled toggle.
    expect(mapReasoningLevels(specFor(MODELS.zai).reasoningLevels)).toEqual(["disabled", "enabled"]);
    expect(mapReasoningLevels([])).toBeNull();
  });

  it("grok sections write resolved limits, reasoning in description", () => {
    const models = [MODELS.gpt, MODELS.visionFlat].map((id) => {
      const s = specFor(id);
      return { model: id, contextWindow: s.contextWindow, maxOutput: s.maxOutput, vision: s.vision, reasoning: s.reasoning };
    });
    const toml = applyGrokBuildConfig("", { baseUrl: "http://127.0.0.1:20128/v1", models });
    expect(toml).toContain(`context_window = ${specFor(MODELS.gpt).contextWindow}`);
    expect(toml).toContain("reasoning");
    expect(toml).toMatchSnapshot();
  });

  it("hermes model entries carry the documented per-model keys only", () => {
    const entries = Object.fromEntries(
      Object.values(MODELS).map((id) => [id, buildHermesModelEntry(specFor(id))]),
    );
    // context_length is resolved from the real spec, never invented.
    expect(entries[MODELS.gpt].context_length).toBe(specFor(MODELS.gpt).contextWindow);
    expect(entries[MODELS.visionFlat].context_length).toBe(specFor(MODELS.visionFlat).contextWindow);
    // supports_vision only when the model really takes images.
    expect(entries[MODELS.visionFlat].supports_vision).toBe(true);
    expect(entries[MODELS.deepseek].supports_vision).toBeUndefined();
    // Hermes no longer reads max_output_tokens, so it is never written.
    for (const entry of Object.values(entries)) {
      expect(Object.keys(entry).sort()).toEqual(
        entry.supports_vision ? ["context_length", "supports_vision"] : ["context_length"],
      );
    }
    expect(entries).toMatchSnapshot();
  });

  it("combos keep the union; the dispatcher reconciles per member", () => {
    const combo = aggregateComboCapabilities([MODELS.codex, MODELS.deepseek]);
    expect(combo.reasoning).toBe(true);
    // Union: codex-only minimal/xhigh-ish levels survive alongside deepseek's.
    expect(combo.reasoningLevels).toEqual(expect.arrayContaining(["minimal", "max"]));
    expect(piThinkingLevelMap({ reasoning: true, reasoningLevels: [] })).toBeUndefined();
    expect(ompThinking({ reasoning: true, reasoningLevels: [] })).toBeUndefined();
  });
});
