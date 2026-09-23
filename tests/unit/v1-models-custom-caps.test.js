// Regression: /v1/models must surface the specs captured when a model was added
// to a connection. The add flow (POST /api/models/custom) enriches from the
// provider's live catalog and persists them as `caps` on the custom-model row;
// the listing used to read only the model's kind from that row and recompute
// capabilities from the static tables, so every newly added model fell back to
// DEFAULT_CAPABILITIES (200K/64K, text-only, no reasoning).
//
// Hermetic: the DB is mocked and no fetch happens on this path (explicit
// enabledModels skip the dynamic fetch and no live resolver runs). The fixture
// below is synthetic — it only mirrors the *shape* a provider catalog produces
// (declared false booleans included, positive integer limits), not any real
// model's spec.
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
  getCombos: vi.fn(),
  getCustomModels: vi.fn(),
  getModelAliases: vi.fn(),
}));
vi.mock("@/lib/localDb", () => db);
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));

import { buildModelsList } from "../../src/app/api/v1/models/route.js";

const SYNTHETIC_MODEL_ID = "acme-labs/nova-alpha";
const SYNTHETIC_OUTPUT_ID = `openrouter/${SYNTHETIC_MODEL_ID}`;

const CATALOG_CAPS = {
  vision: true,
  pdf: false,
  audioInput: false,
  videoInput: true,
  tools: true,
  reasoning: true,
  contextWindow: 1000000,
  maxOutput: 524288,
};

const setup = (customModels) => {
  db.getProviderConnections.mockResolvedValue([
    {
      id: "conn-1",
      provider: "openrouter",
      apiKey: "test-only-key",
      isActive: true,
      providerSpecificData: { enabledModels: [SYNTHETIC_MODEL_ID] },
    },
  ]);
  db.getCombos.mockResolvedValue([]);
  db.getCustomModels.mockResolvedValue(customModels);
  db.getModelAliases.mockResolvedValue({});
};

const findModel = (list, id) => list.find((m) => m.id === id);

beforeEach(() => {
  vi.resetAllMocks();
  setup([]);
});

describe("/v1/models — added model specs", () => {
  it("uses the catalog specs persisted when the model was added", async () => {
    setup([
      {
        providerAlias: "openrouter",
        id: SYNTHETIC_MODEL_ID,
        name: "Nova Alpha",
        type: "llm",
        caps: CATALOG_CAPS,
      },
    ]);

    const model = findModel(await buildModelsList(["llm"]), SYNTHETIC_OUTPUT_ID);

    expect(model).toBeDefined();
    expect(model.capabilities).toMatchObject(CATALOG_CAPS);
    expect(model.context_length).toBe(1000000);
    expect(model.max_completion_tokens).toBe(524288);
  });

  it("keeps the persisted specs when the row carries no explicit type", async () => {
    setup([
      {
        providerAlias: "openrouter",
        id: SYNTHETIC_MODEL_ID,
        name: "Nova Alpha",
        caps: CATALOG_CAPS,
      },
    ]);

    const model = findModel(await buildModelsList(["llm"]), SYNTHETIC_OUTPUT_ID);

    expect(model.capabilities).toMatchObject({ reasoning: true, contextWindow: 1000000, maxOutput: 524288 });
  });

  it("falls back to the static tables when the row carries no specs", async () => {
    setup([{ providerAlias: "openrouter", id: SYNTHETIC_MODEL_ID, name: "Nova Alpha" }]);

    const model = findModel(await buildModelsList(["llm"]), SYNTHETIC_OUTPUT_ID);

    // No catalog data persisted: the resolved object must still be complete.
    expect(model.capabilities.contextWindow).toBeGreaterThan(0);
    expect(model.capabilities.maxOutput).toBeGreaterThan(0);
  });

  it("merges persisted limits with table-resolved extras", async () => {
    // A partially-specified row must not blank out table knowledge: the
    // resolved entry keeps fields the row never declared.
    setup([
      {
        providerAlias: "openrouter",
        id: SYNTHETIC_MODEL_ID,
        caps: { contextWindow: 1000000, maxOutput: 524288 },
      },
    ]);

    const model = findModel(await buildModelsList(["llm"]), SYNTHETIC_OUTPUT_ID);

    expect(model.capabilities.contextWindow).toBe(1000000);
    expect(model.capabilities.tools).toBe(true);
  });

  it("does not let declared-false booleans switch off a table-resolved flag", async () => {
    // `*gpt-5*` resolves with vision/reasoning from the static tables; a
    // catalog row declaring vision:false must not turn that off — booleans
    // only ever turn ON through the merge.
    db.getProviderConnections.mockResolvedValue([
      {
        id: "conn-2",
        provider: "openrouter",
        apiKey: "test-only-key",
        isActive: true,
        providerSpecificData: { enabledModels: ["gpt-5.4-mini"] },
      },
    ]);
    db.getCustomModels.mockResolvedValue([
      {
        providerAlias: "openrouter",
        id: "gpt-5.4-mini",
        caps: { vision: false, reasoning: false, contextWindow: 400000 },
      },
    ]);

    const model = findModel(await buildModelsList(["llm"]), "openrouter/gpt-5.4-mini");

    expect(model.capabilities.vision).toBe(true);
    expect(model.capabilities.reasoning).toBe(true);
    expect(model.capabilities.contextWindow).toBe(400000);
  });

  it("merges persisted specs into combo members", async () => {
    setup([
      {
        providerAlias: "openrouter",
        id: SYNTHETIC_MODEL_ID,
        type: "llm",
        caps: CATALOG_CAPS,
      },
    ]);
    db.getCombos.mockResolvedValue([
      { name: "combo-alpha", kind: "llm", models: [SYNTHETIC_OUTPUT_ID] },
    ]);

    const combo = findModel(await buildModelsList(["llm"]), "combo-alpha");

    expect(combo.capabilities.contextWindow).toBe(1000000);
    expect(combo.capabilities.reasoning).toBe(true);
    expect(combo.context_length).toBe(1000000);
  });
});
