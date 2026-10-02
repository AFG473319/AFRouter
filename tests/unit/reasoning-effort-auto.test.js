// Auto-recognized reasoning effort across EVERY provider (no hard-coding).
// With no catalog file installed (fresh install / offline / browser bundle),
// a reasoning model on an effort-wire format must still report
// thinkingEffortSupported:true from the format default alone — for API-key
// providers, OAuth providers (qoder), and OpenCode Free alike. Budget-only
// and toggle-only formats stay false; zai stays gated on per-model evidence.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  getCapabilitiesForModel,
  getCapabilitiesForLiveModel,
  setCatalogSource,
  aggregateComboCapabilities,
} from "../../open-sse/providers/capabilities.js";

beforeAll(() => {
  setCatalogSource(null);
});

afterAll(() => {
  setCatalogSource(null);
});

describe("effort-wire formats default to supported (any provider)", () => {
  const cases = [
    ["openai", "gpt-5"],
    ["anthropic", "claude-opus-4-7"],
    ["gemini", "gemini-3-pro"],
    ["kimi", "kimi-k3"],
    ["stepfun", "step-3.5-flash"],
    ["deepseek", "deepseek-v4-flash"],
    ["opencode", "muse-spark-1.3-contributor-free"],
    ["commandcode", "deepseek/deepseek-v4-pro"],
  ];
  for (const [provider, model] of cases) {
    it(`${provider}/${model} reports effort support`, () => {
      const caps = getCapabilitiesForModel(provider, model);
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingEffortSupported).toBe(true);
    });
  }
});

describe("budget/toggle formats stay unsupported", () => {
  const cases = [
    ["anthropic", "claude-opus-4-5"], // generic opus -> claude-budget
    ["qwen", "coder-model"], // qwen budget-mapped
    ["minimax", "minimax-m3"], // toggle-only adaptive
    ["glm", "glm-5"], // zai without per-model evidence
  ];
  for (const [provider, model] of cases) {
    it(`${provider}/${model} keeps the flag off`, () => {
      const caps = getCapabilitiesForModel(provider, model);
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingEffortSupported).toBe(false);
    });
  }
});

describe("opaque gateway ids resolve dynamically (no per-model table)", () => {
  it("resolves Qoder family models through their live display names", () => {
    // Opaque keys carry no family signal; the live display names do, and the
    // shared pattern tables resolve them with zero qoder-specific entries.
    const cases = [
      ["dmodel", "DeepSeek-V4-Pro", "deepseek"],
      ["dfmodel", "DeepSeek-V4-Flash", "deepseek"],
      ["gmodel", "GLM-5.3", "zai"],
      ["gfmodel", "GLM-5.3-Flash", "zai"],
      ["kmodel_latest", "Kimi-K3", "kimi"],
      ["kmodel", "Kimi-K2.7-Code", "kimi"],
      ["qmodel", "Qwen3.7-Max", "qwen"],
      ["mmodel", "MiniMax-M3", "minimax"],
    ];
    for (const [id, name, format] of cases) {
      // The bare id alone hits the floor: nothing is hardcoded for it.
      expect(getCapabilitiesForModel("qoder", id).reasoning).toBe(false);
      const caps = getCapabilitiesForLiveModel("qoder", id, { name });
      expect(caps.reasoning).toBe(true);
      expect(caps.thinkingFormat).toBe(format);
    }
  });

  it("honours the gateway's own per-model reasoning signal for router modes", () => {
    // "ultimate"/"auto" match no family pattern; the live is_reasoning flag
    // the gateway publishes per key is the positive evidence.
    const caps = getCapabilitiesForLiveModel("qoder", "ultimate", {
      name: "Ultimate",
      isReasoning: true,
      isVL: false,
      contextLength: 262144,
      maxOutputTokens: 131072,
    });
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(262144);
    expect(caps.maxOutput).toBe(131072);
  });

  it("never invents values without live evidence", () => {
    const caps = getCapabilitiesForLiveModel("qoder", "ultimate", { name: "Ultimate" });
    expect(caps.reasoning).toBe(false);
  });

  it("qoder-cn shares the dynamic path", () => {
    const caps = getCapabilitiesForLiveModel("qoder-cn", "dmodel", { name: "DeepSeek-V4-Pro" });
    expect(caps.reasoning).toBe(true);
    expect(caps.thinkingFormat).toBe("deepseek");
  });

  it("retired models fall to the floor (union-alpha is gone upstream)", () => {
    const caps = getCapabilitiesForModel("opencode", "union-alpha");
    expect(caps.reasoning).toBe(false);
  });

  it("non-reasoning models stay off", () => {
    expect(getCapabilitiesForModel("openai", "gpt-image-1").thinkingEffortSupported).toBe(false);
  });
});

describe("combos propagate effort support", () => {
  it("is true when any member supports effort", () => {
    // Levels union only covers declared ladders (no catalog here), but the
    // effort flag must still propagate so the picker enables control.
    const caps = aggregateComboCapabilities(["openai/gpt-5", "qwen/coder-model"]);
    expect(caps.thinkingEffortSupported).toBe(true);
  });
});
