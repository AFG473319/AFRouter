import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getDefaultModel, getModelUpstreamId, getModelTargetFormat, isValidModel } from "../../open-sse/config/providerModels.js";


describe("Token Harbor provider", () => {
  const tokenharbor = REGISTRY.find((entry) => entry.id === "tokenharbor");

  it("registers as an API-key OpenAI-compatible provider", () => {
    expect(tokenharbor).toBeDefined();
    expect(tokenharbor.alias).toBe("th");
    expect(tokenharbor.aliases).toContain("token-harbor");
    expect(tokenharbor.category).toBe("apikey");
    expect(tokenharbor.authType).toBe("apikey");
    expect(tokenharbor.authModes).toEqual(["apikey"]);
    expect(tokenharbor.hasFree).toBe(true);
  });

  it("uses Token Harbor's documented endpoints", () => {
    expect(PROVIDERS.tokenharbor).toMatchObject({
      format: "openai",
      baseUrl: "https://tokenharbor.ai/v1/chat/completions",
      validateUrl: "https://tokenharbor.ai/v1/models",
    });
    expect(tokenharbor.modelsFetcher).toBeUndefined();
  });

  it("seeds TH Orchestra and current chat models", () => {
    const models = PROVIDER_MODELS.th || [];
    expect(models.map((model) => model.id)).toEqual(expect.arrayContaining([
      "th-orchestra",
      "claude-opus-5",
      "gpt-6-astra",
      "gemini-3.6-flash",
      "deepseek-v4-flash:free",
      "qwen3.8-max",
      "glm-5.3",
      "kimi-k3",
    ]));
    expect(getDefaultModel("th")).toBe("th-orchestra");
    expect(isValidModel("th", "claude-opus-5")).toBe(true);
  });

  it("keeps model lookup behavior for registry models and thinking suffixes", () => {
    expect(isValidModel("kr", "claude-sonnet-4-5")).toBe(true);
    expect(getModelUpstreamId("kr", "claude-sonnet-4-5(high)")).toBe("claude-sonnet-4.5(high)");
    expect(getModelTargetFormat("th", "claude-opus-5")).toBeNull();
  });

  it("accepts future catalog IDs without adding a custom executor", () => {
    expect(tokenharbor.passthroughModels).toBe(true);
    expect(PROVIDERS.tokenharbor.executor).toBeUndefined();
  });

  it("keeps registry ids unique", () => {
    const ids = REGISTRY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
