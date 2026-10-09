/**
 * Live-catalog scoping for the model picker (ModelSelectModal).
 *
 * Cline's /models answers with the whole resale catalog (400+ ids), and the
 * picker used to render every one of them as a row — so the handful of models
 * the user had enabled sat under hundreds they had not. The live catalog is
 * per-account *metadata* (display names, kinds); the row set is what the user
 * enabled: the curated registry plus custom models and aliases.
 */

import { describe, it, expect } from "vitest";
import { scopeLiveCatalogModels } from "../../src/shared/utils/liveCatalogModels.js";

const LIVE_CATALOG = [
  // 400+ real rows upstream; these stand in for the interesting ones.
  { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6 (upstream name)" },
  { id: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" },
  { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash" },
  { id: "some/other-model", name: "Some Other Model" },
];

const REGISTRY = [
  { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", kind: "llm" },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", kind: "llm" },
];

describe("scopeLiveCatalogModels", () => {
  it("drops live rows the user never enabled", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: REGISTRY,
      alias: "cl",
    });
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
    ]);
  });

  it("keeps registry rows the live catalog does not carry", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: REGISTRY,
      alias: "cl",
    });
    // claude-sonnet-4.6 is enabled and routable even though upstream stopped
    // listing it; removing enabled rows is how the picker lost models before.
    expect(models.some((m) => m.id === "anthropic/claude-sonnet-4.6")).toBe(true);
  });

  it("renames a registry row from its live row, keeping the row's kind", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: REGISTRY,
      alias: "cl",
    });
    const opus = models.find((m) => m.id === "anthropic/claude-opus-4.6");
    expect(opus.name).toBe("Claude Opus 4.6 (upstream name)");
    expect(opus.kind).toBe("llm");
  });

  it("surfaces a custom model that only exists in the live catalog", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: REGISTRY,
      customModels: [
        { providerAlias: "cl", id: "z-ai/glm-5.3-flash", type: "llm" },
        { providerAlias: "cc", id: "anthropic/claude-sonnet-5", type: "llm" },
      ],
      modelAliases: {},
      alias: "cl",
    });
    const ids = models.map((m) => m.id);
    expect(ids).toContain("z-ai/glm-5.3-flash");
    // A custom model of another provider never joins this provider's rows.
    expect(ids).not.toContain("anthropic/claude-sonnet-5");
  });

  it("surfaces an alias stored under this provider's alias", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: REGISTRY,
      customModels: [],
      modelAliases: { "My Fast Model": "cl/some/other-model" },
      alias: "cl",
    });
    expect(models.map((m) => m.id)).toContain("some/other-model");
  });

  it("ignores aliases scoped to a different provider", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: REGISTRY,
      customModels: [],
      modelAliases: {
        "Their Model": "cc/some/other-model",
        "Mine": "cl/some/other-model",
      },
      alias: "cl",
    });
    // one row per id — the other provider's alias must not duplicate it
    expect(models.filter((m) => m.id === "some/other-model")).toHaveLength(1);
  });

  it("ignores an aliased full model that is not prefixed by the alias", () => {
    const models = scopeLiveCatalogModels({
      liveModels: [],
      registryModels: [{ id: "gpt-5", name: "GPT-5", kind: "llm" }],
      customModels: [],
      modelAliases: { "Unrelated": "other-provider/gpt-6" },
      alias: "cl",
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-5"]);
  });

  it("falls back to the registry when the live catalog is unavailable", () => {
    const models = scopeLiveCatalogModels({
      liveModels: [],
      registryModels: REGISTRY,
      alias: "cl",
    });
    expect(models.map((m) => m.id)).toEqual([
      "anthropic/claude-opus-4.6",
      "anthropic/claude-sonnet-4.6",
    ]);
  });

  it("passes the live catalog through when the provider has no registry (Zed)", () => {
    const models = scopeLiveCatalogModels({
      liveModels: LIVE_CATALOG,
      registryModels: [],
      customModels: [{ providerAlias: "zd", id: "not/in/catalog", type: "llm" }],
      modelAliases: {},
      alias: "zd",
    });
    // Live is the only row source: every live row survives, and the custom model
    // is added downstream by the custom-models path, not here.
    expect(models.map((m) => m.id)).toEqual(LIVE_CATALOG.map((m) => m.id));
  });

  it("keeps live rows without duplicate ids", () => {
    const models = scopeLiveCatalogModels({
      liveModels: [...LIVE_CATALOG, { id: "z-ai/glm-5.3-flash", name: "GLM 5.3 Flash (dup)" }],
      registryModels: REGISTRY,
      customModels: [{ providerAlias: "cl", id: "z-ai/glm-5.3-flash", type: "llm" }],
      alias: "cl",
    });
    expect(models.filter((m) => m.id === "z-ai/glm-5.3-flash")).toHaveLength(1);
    expect(models.find((m) => m.id === "z-ai/glm-5.3-flash").name).toBe("GLM 5.3 Flash");
  });

  it("tolerates missing inputs", () => {
    expect(scopeLiveCatalogModels()).toEqual([]);
    expect(scopeLiveCatalogModels({ registryModels: REGISTRY })).toEqual(REGISTRY);
    expect(scopeLiveCatalogModels({ liveModels: LIVE_CATALOG })).toEqual(LIVE_CATALOG);
  });
});
