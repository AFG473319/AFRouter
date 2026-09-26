import { describe, expect, it } from "vitest";
import {
  assembleProviderModelRows,
  dedupeModelRows,
  isFreeModelId,
} from "@/shared/utils/providerModelRows.js";

// Shapes mirror what the provider detail page feeds in: the registry seed
// (open-sse/providers/registry/kilocode.js), the modelsFetcher suggestions
// (/api/providers/suggested-models), custom models (/api/models/custom), and the
// disabled ids keyed by provider alias (/api/models/disabled).
const SEED = [
  { id: "kilo-auto/free", name: "Kilo Auto Free" },
  { id: "kilo-auto/frontier", name: "Kilo Auto Frontier" },
  { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
];

// What the "kilo-free" filter returns for the same endpoint the seed came from.
const SUGGESTED = [
  { id: "kilo-auto/free", name: "Auto Free", contextLength: 256000 },
  { id: "cohere/north-mini-code:free", name: "North Mini Code", contextLength: 256000 },
  { id: "liquid/lfm-2.5-2.6b:free", name: "LFM 2.5", contextLength: 65536 },
];

// The user's real state: free catalog ids were added as custom models, so the
// old page (which ALSO merged a kilocode-only catalog) emitted two chips each.
const CUSTOM = (id, providerAlias = "kc") => ({ providerAlias, id, type: "llm", name: id });

const assemble = (overrides = {}) => assembleProviderModelRows({
  builtInModels: SEED,
  customModels: [],
  modelAliases: {},
  disabledIds: [],
  providerStorageAlias: "kc",
  suggestedModels: SUGGESTED,
  ...overrides,
});

// Every chip list the page renders, joined — the invariant is that a model id
// appears in exactly one of them.
const allRendered = (rows) => [
  ...rows.activeCustomRows,
  ...rows.displayModels,
  ...rows.disabledDisplayModels,
  ...rows.disabledCustomRows,
  ...rows.suggestedFreeDisabled,
  ...rows.suggestedNotAdded,
];

const assertRenderedOnce = (rows) => {
  const ids = allRendered(rows).map((m) => m.id);
  expect(new Set(ids).size, `duplicate chips: ${ids.join(", ")}`).toBe(ids.length);
  return ids;
};

describe("provider model rows", () => {
  it("collapses the seed into one row per model id", () => {
    const { baseRows } = assemble();
    expect(baseRows.map((m) => m.id)).toEqual([
      "kilo-auto/free",
      "kilo-auto/frontier",
      "anthropic/claude-sonnet-4.6",
    ]);
  });

  it("renders a model that is a seed row AND a custom model exactly once", () => {
    const rows = assemble({
      customModels: [CUSTOM("kilo-auto/free"), CUSTOM("cohere/north-mini-code:free")],
    });
    assertRenderedOnce(rows);
    // The seed owns its id; getProviderCustomModelRows must not re-add it.
    expect(rows.activeCustomRows.map((m) => m.id)).toEqual(["cohere/north-mini-code:free"]);
    expect(rows.displayModels.map((m) => m.id)).toContain("kilo-auto/free");
  });

  it("renders a disabled model exactly once, and never in Available", () => {
    const rows = assemble({
      customModels: [CUSTOM("cohere/north-mini-code:free")],
      disabledIds: ["cohere/north-mini-code:free", "kilo-auto/frontier"],
    });
    const ids = assertRenderedOnce(rows);
    expect(rows.displayModels.map((m) => m.id)).not.toContain("kilo-auto/frontier");
    expect(ids).toContain("kilo-auto/frontier");
    // Both stay restorable, each exactly once: the seeded one from Disabled
    // models, the user-added one from the disabled custom rows.
    expect(rows.disabledDisplayModels.map((m) => m.id)).toEqual(["kilo-auto/frontier"]);
    expect(rows.disabledCustomRows.map((m) => m.id)).toEqual(["cohere/north-mini-code:free"]);
    expect(rows.suggestedFreeDisabled).toEqual([]);
  });

  it("restores every disabled id exactly once across all sections", () => {
    const disabledIds = ["kilo-auto/free", "kilo-auto/frontier", "anthropic/claude-sonnet-4.6"];
    const rows = assemble({ disabledIds, customModels: [CUSTOM("kilo-auto/free")] });
    const restore = [
      ...rows.disabledDisplayModels,
      ...rows.disabledCustomRows,
      ...rows.suggestedFreeDisabled,
    ].map((m) => m.id);
    expect([...restore].sort()).toEqual([...disabledIds].sort());
    assertRenderedOnce(rows);
  });

  it("keeps suggestions that duplicate a seed row out of the Suggested list", () => {
    const { suggestedNotAdded } = assemble();
    expect(suggestedNotAdded.map((m) => m.id)).toEqual([
      "cohere/north-mini-code:free",
      "liquid/lfm-2.5-2.6b:free",
    ]);
  });

  it("hides a suggestion the user already added as a custom model", () => {
    const rows = assemble({ customModels: [CUSTOM("liquid/lfm-2.5-2.6b:free")] });
    expect(rows.suggestedNotAdded.map((m) => m.id)).toEqual(["cohere/north-mini-code:free"]);
    assertRenderedOnce(rows);
  });

  it("hides a suggestion reachable through a legacy alias", () => {
    const rows = assemble({ modelAliases: { nmc: "kc/cohere/north-mini-code:free" } });
    expect(rows.suggestedNotAdded.map((m) => m.id)).not.toContain("cohere/north-mini-code:free");
    assertRenderedOnce(rows);
  });

  it("excludes non-llm kinds from the chat rows", () => {
    const rows = assemble({
      builtInModels: [...SEED, { id: "google/lyria-3-pro-preview", name: "Lyria", kind: "music" }],
    });
    expect(rows.displayModels.map((m) => m.id)).not.toContain("google/lyria-3-pro-preview");
    // A typed seed row is not a chat row, so it must not be offered as one either.
    expect(rows.disableAllIds).not.toContain("google/lyria-3-pro-preview");
  });

  it("gives Disable-All each active id exactly once", () => {
    const rows = assemble({ customModels: [CUSTOM("kilo-auto/free"), CUSTOM("qwen/qwen3.8-27b:free")] });
    assertRenderedOnce(rows);
    expect(rows.disableAllIds).toEqual([
      "kilo-auto/free",
      "kilo-auto/frontier",
      "anthropic/claude-sonnet-4.6",
      "qwen/qwen3.8-27b:free",
    ]);
  });

  it("leaves disabled ids out of Disable-All", () => {
    expect(assemble({ disabledIds: ["kilo-auto/free"] }).disableAllIds).not.toContain("kilo-auto/free");
  });

  it("is a no-op for providers with no suggestions and no custom models", () => {
    const rows = assembleProviderModelRows({
      builtInModels: [{ id: "gemini-3-flash", name: "Gemini 3 Flash" }],
      providerStorageAlias: "gemini",
    });
    expect(rows.displayModels.map((m) => m.id)).toEqual(["gemini-3-flash"]);
    expect(rows.suggestedNotAdded).toEqual([]);
    expect(rows.disableAllIds).toEqual(["gemini-3-flash"]);
  });

  it("keeps rows from another provider's alias out of this provider", () => {
    const rows = assemble({
      customModels: [CUSTOM("kilo-auto/free", "openrouter")],
      modelAliases: { "or-free": "openrouter/kilo-auto/free" },
    });
    expect(rows.activeCustomRows).toEqual([]);
    expect(rows.suggestedNotAdded.map((m) => m.id)).toContain("cohere/north-mini-code:free");
  });
});

describe("dedupeModelRows", () => {
  it("drops rows with no usable id instead of colliding on one key", () => {
    expect(dedupeModelRows([{ id: "" }, { id: "   " }, {}, null, { id: "a" }])).toEqual([{ id: "a" }]);
  });

  it("trims ids for comparison but keeps the original row", () => {
    const row = { id: " a ", name: "A" };
    expect(dedupeModelRows([row, { id: "a" }])).toEqual([row]);
  });

  it("lets the earlier list win when lists are concatenated", () => {
    expect(dedupeModelRows([{ id: "x", name: "Seed" }, { id: "x", name: "Catalog" }, { id: "y" }]))
      .toEqual([{ id: "x", name: "Seed" }, { id: "y" }]);
  });

  it("tolerates a missing list", () => {
    expect(dedupeModelRows(undefined)).toEqual([]);
  });
});

describe("isFreeModelId", () => {
  it.each([
    "openrouter/free",
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "deepseek/deepseek-v4-flash-free",
    "cohere/north-mini-code:free",
  ])("matches the $0 shapes the filters use: %s", (id) => {
    expect(isFreeModelId(id)).toBe(true);
  });

  it.each(["anthropic/claude-sonnet-4.6", "free-tier/model", "openai/gpt-4.1", "", undefined])(
    "does not match %s", (id) => {
      expect(isFreeModelId(id)).toBe(false);
    },
  );
});
