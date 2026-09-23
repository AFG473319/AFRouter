import { describe, expect, it } from "vitest";

import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { getModelTargetFormat, isSystemOneModel } from "../../open-sse/config/providerModels.js";
import { isSystemOneModelRef } from "../../src/app/api/models/test/ping.js";

describe("TypeSafe AI provider", () => {
  const typesafe = REGISTRY.find((e) => e.id === "typesafe");

  it("is registered as a freeTier apikey provider", () => {
    expect(typesafe).toBeDefined();
    expect(typesafe.category).toBe("freeTier");
    expect(typesafe.authType).toBe("apikey");
    expect(typesafe.authModes).toContain("apikey");
    expect(typesafe.alias).toBe("typesafe");
  });

  it("points transport at the SystemOne endpoint with a models validateUrl", () => {
    expect(typesafe.transport.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
    expect(typesafe.transport.validateUrl).toBe("https://api.typesafe.ai/v1/models");
  });

  it("exposes Jev 1.13 + jev-latest as systemone models with passthrough", () => {
    expect(typesafe.passthroughModels).toBe(true);
    const ids = (PROVIDER_MODELS.typesafe || []).map((m) => m.id);
    expect(ids).toContain("jev-1.13.0");
    expect(ids).toContain("jev-latest");
    expect(getModelTargetFormat("typesafe", "jev-1.13.0")).toBe("systemone");
    expect(getModelTargetFormat("typesafe", "jev-latest")).toBe("systemone");
  });

  it("treats every TypeSafe model (incl. passthrough ids) as System One", () => {
    expect(typesafe.defaultTargetFormat).toBe("systemone");
    expect(getModelTargetFormat("typesafe", "jev-1.13.0")).toBe("systemone");
    expect(getModelTargetFormat("typesafe", "jev-latest")).toBe("systemone");
    // Unlisted / future Jev ids inherit the provider default
    expect(getModelTargetFormat("typesafe", "jev-1.15.0")).toBe("systemone");
    expect(isSystemOneModel("typesafe", "jev-1.15.0")).toBe(true);
    expect(isSystemOneModelRef("typesafe/jev-1.15.0")).toBe(true);
    expect(isSystemOneModelRef("typesafe/jev-latest")).toBe(true);
    expect(isSystemOneModelRef("typesafe/jev-1.13.0(high)")).toBe(true);
  });

  it("does not mark OpenCode chat models as System One", () => {
    expect(isSystemOneModel("oc", "jev-1.13")).toBe(false);
    expect(isSystemOneModelRef("oc/jev-1.13")).toBe(false);
    expect(isSystemOneModelRef("oc/muse-spark-1.3-contributor-free")).toBe(false);
  });

  it("builds into the runtime PROVIDERS map (DefaultExecutor serves baseUrl verbatim)", () => {
    expect(PROVIDERS.typesafe).toBeDefined();
    expect(PROVIDERS.typesafe.baseUrl).toBe("https://api.typesafe.ai/v1/systemone");
  });

  it("keeps every registry id unique after adding typesafe", () => {
    const ids = REGISTRY.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
