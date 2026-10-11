import { describe, expect, it } from "vitest";
import {
  applyGrokBuildConfig,
  grokSlotForModel,
  parseGrokBuildConfig,
  resetGrokBuildConfig,
} from "../../src/lib/grokBuildConfig.js";

const BASE_CONFIG = `[cli]
installer = "internal"

[ui]
yolo = false

[models]
default = "grok-4.5"
default_reasoning_effort = "high"

[subagents]
enabled = true

[subagents.models]
general-purpose = "grok-4.5"
explore = "grok-build"
plan = "grok-4.5"

[mcp_servers.example]
url = "https://example.com/mcp"
enabled = true
`;

const MODELS = [
  { model: "cx/gpt-5.6-sol", contextWindow: 400000, maxOutput: 128000, vision: true, reasoning: true, effort: "high" },
  { model: "cc/claude-sonnet-5", contextWindow: 1000000, maxOutput: 128000, reasoning: true, effort: "medium" },
];

const APPLY_INPUT = {
  baseUrl: "http://127.0.0.1:20128/v1",
  apiKey: "sk-test",
  models: MODELS,
  subagentModels: {
    explore: { model: "gemini/gemini-3-flash", contextWindow: 1048576 },
  },
};

describe("grokSlotForModel", () => {
  it("derives bare-key slots from model ids and resolves collisions", () => {
    expect(grokSlotForModel("cx/gpt-5.6-sol")).toBe("cx-gpt-5-6-sol");
    expect(grokSlotForModel("openai/o3-mini (preview)")).toBe("openai-o3-mini-preview");
    const used = new Set(["gpt-5"]);
    expect(grokSlotForModel("gpt.5", used)).toBe("gpt-5-2");
  });
});

describe("grokBuildConfig", () => {
  it("writes one slot per model, named after the original model id", () => {
    const result = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    const parsed = parseGrokBuildConfig(result);

    expect(parsed.default).toBe("cx-gpt-5-6-sol");
    expect(parsed.model).toMatchObject({
      slot: "cx-gpt-5-6-sol",
      model: "cx/gpt-5.6-sol",
      name: "cx/gpt-5.6-sol",
      base_url: "http://127.0.0.1:20128/v1",
      context_window: 400000,
      max_completion_tokens: 128000,
    });
    expect(result).toContain("max_completion_tokens = 128000");
    expect(result).toContain(
      'description = "Routed via AFRouter gateway · vision · reasoning · 400K context · 128K max output"',
    );
    expect(parsed.models).toHaveLength(2);
    expect(parsed.models[1]).toMatchObject({
      slot: "cc-claude-sonnet-5",
      model: "cc/claude-sonnet-5",
      name: "cc/claude-sonnet-5",
      context_window: 1000000,
    });
    expect(result).toContain("[model.cx-gpt-5-6-sol]");
    expect(result).toContain("[model.cc-claude-sonnet-5]");
    expect(result).not.toContain("[model.afrouter]");
  });

  it("writes supports_reasoning_effort / reasoning_effort per model and the [models] default", () => {
    const result = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    // docs.x.ai/build/settings/reference [model.<id>]: both are real controls.
    expect(result).toContain("supports_reasoning_effort = true");
    expect(result).toContain('reasoning_effort = "high"');
    // The global default mirrors the first (default) model's effort.
    expect(result).toContain('default_reasoning_effort = "high"');
    expect(result.match(/^default_reasoning_effort = /gm)).toHaveLength(1);
  });

  it("omits the effort keys for a non-reasoning model and clears a stale default", () => {
    const result = applyGrokBuildConfig(BASE_CONFIG, {
      ...APPLY_INPUT,
      models: [{ model: "openai/gpt-4o", contextWindow: 128000, reasoning: false }],
    });
    expect(result).not.toContain("supports_reasoning_effort");
    expect(result).not.toContain("default_reasoning_effort");
  });

  it("preserves unrelated config sections", () => {
    const result = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    expect(result).toContain("[cli]\ninstaller = \"internal\"");
    expect(result).toContain("[ui]\nyolo = false");
    expect(result).toContain("default_reasoning_effort = \"high\"");
    expect(result).toContain("[mcp_servers.example]");
    expect(result).toContain("url = \"https://example.com/mcp\"");
  });

  it("is idempotent and replaces previously owned slots not in the new set", () => {
    let result = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    result = applyGrokBuildConfig(result, {
      ...APPLY_INPUT,
      models: [...MODELS, { model: "gemini/gemini-3-flash", contextWindow: 1048576 }],
      subagentModels: {
        explore: { model: "mimo/mimo", contextWindow: 262144 },
      },
    });

    expect(result.match(/^\[model\.cx-gpt-5-6-sol\]$/gm)).toHaveLength(1);
    expect(result.match(/^\[model\.cc-claude-sonnet-5\]$/gm)).toHaveLength(1);
    expect(result).toContain("[model.gemini-gemini-3-flash]");
    expect(result.match(/^# afrouter-prev-subagent-explore/gm)).toHaveLength(1);
    expect(parseGrokBuildConfig(result).models).toHaveLength(3);

    // Re-apply with a different set: stale owned slots disappear.
    result = applyGrokBuildConfig(result, {
      ...APPLY_INPUT,
      models: [{ model: "mimo/mimo", contextWindow: 262144 }],
      subagentModels: {},
    });
    expect(result).not.toContain("[model.cx-gpt-5-6-sol]");
    expect(result).not.toContain("[model.cc-claude-sonnet-5]");
    expect(result).not.toContain("[model.gemini-gemini-3-flash]");
    expect(result).toContain("[model.mimo-mimo]");
    expect(parseGrokBuildConfig(result).default).toBe("mimo-mimo");
  });

  it("never touches user-authored model sections", () => {
    const config = `${BASE_CONFIG}\n[model.my-own]\nmodel = "grok-4.5"\nbase_url = "https://example.com"\nname = "Mine"\n`;
    let result = applyGrokBuildConfig(config, APPLY_INPUT);
    expect(result).toContain("[model.my-own]");
    result = resetGrokBuildConfig(result);
    expect(result).toContain("[model.my-own]");
  });

  it("subagent overrides reuse a main slot when the model matches, else get their own", () => {
    const result = applyGrokBuildConfig(BASE_CONFIG, {
      ...APPLY_INPUT,
      subagentModels: {
        "general-purpose": { model: "cx/gpt-5.6-sol", contextWindow: 400000 },
        explore: { model: "gemini/gemini-3-flash", contextWindow: 1048576 },
      },
    });
    const parsed = parseGrokBuildConfig(result);

    expect(parsed.subagentMappings["general-purpose"]).toBe("cx-gpt-5-6-sol");
    expect(result.match(/^\[model\.cx-gpt-5-6-sol\]$/gm)).toHaveLength(1);
    expect(parsed.subagentMappings.explore).toBe("gemini-gemini-3-flash");
    expect(parsed.subagentModels.explore).toMatchObject({
      model: "gemini/gemini-3-flash",
      context_window: 1048576,
    });
    expect(parsed.subagentModels.plan).toBeNull();
  });

  it("blank override restores previous subagent mapping and removes owned slot", () => {
    let result = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    result = applyGrokBuildConfig(result, {
      ...APPLY_INPUT,
      subagentModels: {}, // explore blank => inherit / restore previous
    });

    const parsed = parseGrokBuildConfig(result);
    expect(parsed.subagentMappings.explore).toBe("grok-build");
    expect(parsed.subagentModels.explore).toBeNull();
    expect(result).not.toContain("[model.gemini-gemini-3-flash]");
  });

  it("reset restores previous default and all previous subagent mappings", () => {
    const applied = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    const reset = resetGrokBuildConfig(applied);
    const parsed = parseGrokBuildConfig(reset);

    expect(parsed.default).toBe("grok-4.5");
    expect(parsed.models).toHaveLength(0);
    expect(parsed.model).toBeNull();
    expect(parsed.subagentMappings).toEqual({
      "general-purpose": "grok-4.5",
      explore: "grok-build",
      plan: "grok-4.5",
    });
    expect(reset).not.toContain("Routed via AFRouter gateway");
    expect(reset).not.toContain("afrouter-prev-");
    expect(reset).toContain("[mcp_servers.example]");
  });

  it("removes mappings that were originally unset", () => {
    const config = `[models]\ndefault = "grok-build"\n\n[mcp_servers.x]\nenabled = true\n`;
    const applied = applyGrokBuildConfig(config, {
      ...APPLY_INPUT,
      subagentModels: {
        plan: { model: "cc/claude-sonnet-5", contextWindow: 1000000 },
      },
    });
    const reset = resetGrokBuildConfig(applied);

    expect(parseGrokBuildConfig(applied).subagentMappings.plan).toBe("cc-claude-sonnet-5");
    expect(parseGrokBuildConfig(reset).subagentMappings.plan).toBeNull();
    expect(reset).not.toContain("[subagents.models]");
    expect(reset).toContain("[mcp_servers.x]");
  });

  it("migrates legacy afrouter slots written by older versions", () => {
    const legacy = `${BASE_CONFIG}
# afrouter-prev-default = "grok-4.5"

[model.afrouter]
model = "cx/gpt-5.6-sol"
base_url = "http://127.0.0.1:20128/v1"
name = "AFRouter"
description = "Routed via AFRouter gateway"
api_backend = "chat_completions"
api_key = "sk_afrouter"
context_window = 400000

[subagents.models]
general-purpose = "afrouter-general-purpose"

[model.afrouter-general-purpose]
model = "cc/claude-sonnet-5"
base_url = "http://127.0.0.1:20128/v1"
name = "AFRouter general-purpose"
description = "Routed via AFRouter gateway"
api_backend = "chat_completions"
api_key = "sk_afrouter"
`;

    const applied = applyGrokBuildConfig(legacy, APPLY_INPUT);
    expect(applied).not.toContain("[model.afrouter]");
    expect(applied).toContain("[model.cx-gpt-5-6-sol]");

    const reset = resetGrokBuildConfig(applied);
    expect(reset).not.toContain("Routed via AFRouter gateway");
    expect(parseGrokBuildConfig(reset).default).toBe("grok-4.5");
    expect(parseGrokBuildConfig(reset).subagentMappings["general-purpose"]).toBe("grok-4.5");
  });

  it("legacy single-model callers without subagentModels leave overrides untouched", () => {
    const applied = applyGrokBuildConfig(BASE_CONFIG, APPLY_INPUT);
    const updated = applyGrokBuildConfig(applied, {
      baseUrl: APPLY_INPUT.baseUrl,
      apiKey: APPLY_INPUT.apiKey,
      model: "gemini/gemini-3.1-pro",
      contextWindow: 1048576,
    });

    const parsed = parseGrokBuildConfig(updated);
    expect(parsed.models).toHaveLength(1);
    expect(parsed.model.model).toBe("gemini/gemini-3.1-pro");
    expect(parsed.subagentMappings.explore).toBe("gemini-gemini-3-flash");
    expect(parsed.subagentModels.explore.model).toBe("gemini/gemini-3-flash");
  });

  it("omits context_window when no spec is known", () => {
    const result = applyGrokBuildConfig(BASE_CONFIG, {
      ...APPLY_INPUT,
      models: [{ model: "unknown/model" }],
      subagentModels: {},
    });
    expect(result).toContain("[model.unknown-model]");
    expect(result).not.toMatch(/context_window|max_completion_tokens/);
    expect(result).toContain(`description = "Routed via AFRouter gateway"`);
    const parsed = parseGrokBuildConfig(result);
    expect(parsed.model.context_window).toBeNull();
    expect(parsed.model.max_completion_tokens).toBeNull();
  });
});
