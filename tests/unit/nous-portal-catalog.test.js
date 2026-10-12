import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";
import { openRouterEffortValues } from "../../src/lib/modelCatalog/efforts.js";

// catalogOverride resolves CATALOG_FILE from DATA_DIR at import time, so the
// temp dir has to be set before anything pulls that module in — otherwise the
// reader below would point at the real ~/.afrouter catalog instead of the file
// this test writes. Static imports above deliberately do not reach it.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-nous-"));
process.env.DATA_DIR = dataDir;
const catalogFile = path.join(dataDir, "model-catalog.json");

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// Shapes below are taken verbatim from the live https://inference-api.nousresearch.com
// /v1/models catalog (422 models, 2026-10-12), which is OpenRouter-shaped but
// — unlike OpenRouter — publishes real per-model pricing and an effort ladder.

const paid = {
  id: "stepfun/step-5-preview",
  name: "StepFun: Step 5 Preview",
  context_length: 1000000,
  architecture: { input_modalities: ["text", "image", "video"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000010000", completion: "0.0000027000" },
  top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
  supported_parameters: ["tools", "reasoning", "reasoning_effort"],
  reasoning: { mandatory: true, supported_efforts: ["high", "medium", "low"], default_effort: "medium" },
};
// One of the 9 ids that DO carry the ":free" suffix.
const freeSuffixed = {
  id: "poolside/laguna-s-2.1:free",
  context_length: 262144,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0", completion: "0" },
};
// One of the 2 ids that are $0 with NO ":free" suffix — the case a suffix
// filter misses and the reason this filter keys on price instead.
const freeNoSuffix = {
  id: "inclusionai/ling-3.1-flash",
  context_length: 262144,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000000000", completion: "0.0000000000" },
};
const freeNoSuffixB = {
  id: "stealth/missingno",
  context_length: 262144,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing: { prompt: "0.0000000000", completion: "0.0000000000" },
};
const embeddings = {
  id: "some/text-embedding-3",
  context_length: 8192,
  architecture: { input_modalities: ["text"], output_modalities: ["embeddings"] },
  pricing: { prompt: "0", completion: "0" },
};
const imageOutput = {
  id: "vendor/image-model",
  context_length: 131072,
  architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] },
  pricing: { prompt: "0", completion: "0" },
};

describe('FILTERS.nous — free detection is by PRICE, not the ":free" suffix', () => {
  const ids = (models) => FILTERS.nous(models).map((m) => m.id);

  it("finds every $0 model regardless of id suffix", () => {
    const found = ids([paid, freeSuffixed, freeNoSuffix, freeNoSuffixB]);
    // All three $0 models surface; the suffix-less ones are the whole point.
    expect(found).toEqual(expect.arrayContaining([
      "poolside/laguna-s-2.1:free",
      "inclusionai/ling-3.1-flash",
      "stealth/missingno",
    ]));
    expect(found).not.toContain("stepfun/step-5-preview");
  });

  it("treats the two decimal-zero spellings ('0' and '0.0000000000') as free", () => {
    const found = ids([freeSuffixed, freeNoSuffix]);
    expect(found).toHaveLength(2);
  });

  it("never marks a paid model free, and labels every row isFree", () => {
    const rows = FILTERS.nous([paid, freeSuffixed, freeNoSuffix]);
    expect(rows.every((r) => r.isFree === true)).toBe(true);
    expect(rows.find((r) => r.id === paid.id)).toBeUndefined();
  });

  it("rejects absent / empty / malformed pricing instead of reading it as $0", () => {
    // Number("") === 0, so an empty string must NOT count as free.
    expect(ids([{ id: "x/empty-price", context_length: 1, pricing: { prompt: "", completion: "" } }])).toEqual([]);
    expect(ids([{ id: "x/no-pricing", context_length: 1 }])).toEqual([]);
    expect(ids([{ id: "x/garbage", context_length: 1, pricing: { prompt: "n/a", completion: "n/a" } }])).toEqual([]);
    // Partially free (only one side zero) is not free.
    expect(ids([{ id: "x/half", context_length: 1, pricing: { prompt: "0", completion: "0.5" } }])).toEqual([]);
  });

  it("drops embeddings and image/audio-output entries from the chat picker", () => {
    const found = ids([embeddings, imageOutput, freeNoSuffix]);
    expect(found).toEqual(["inclusionai/ling-3.1-flash"]);
  });

  it("keeps contextLength and sorts the largest first", () => {
    const rows = FILTERS.nous([freeSuffixed, { ...freeNoSuffix, context_length: 1048576 }]);
    expect(rows[0].contextLength).toBe(1048576);
    expect(FILTERS.nous([{ id: "x/noc", pricing: { prompt: "0", completion: "0" } }])[0])
      .not.toHaveProperty("contextLength");
  });

  it("is a safe no-op on non-array / junk payloads", () => {
    expect(FILTERS.nous(undefined)).toEqual([]);
    expect(FILTERS.nous({})).toEqual([]);
  });
});

describe("openRouterEffortValues — Nous's reasoning.supported_efforts", () => {
  it("takes the ladder verbatim (already our wire vocabulary) and dedupes", () => {
    expect(openRouterEffortValues({
      reasoning: { supported_efforts: ["max", "xhigh", "high", "medium", "low", "high"] },
    })).toEqual(["max", "xhigh", "high", "medium", "low"]);
  });

  it("drops 'none' and flags thinking non-disableable when mandatory", () => {
    const model = { reasoning: { mandatory: true, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"] } };
    expect(openRouterEffortValues(model)).toEqual(["max", "xhigh", "high", "medium", "low"]);
  });

  it("keeps 'none' when the model can disable thinking", () => {
    expect(openRouterEffortValues({ reasoning: { mandatory: false, supported_efforts: ["high", "low", "none"] } }))
      .toEqual(["high", "low", "none"]);
  });

  it("returns undefined when no ladder is published (toggle/budget-only)", () => {
    expect(openRouterEffortValues({ supported_parameters: ["reasoning"] })).toBeUndefined();
    expect(openRouterEffortValues({ reasoning: { mandatory: true } })).toBeUndefined();
  });

  it("filters values outside the canonical ladder", () => {
    expect(openRouterEffortValues({ reasoning: { supported_efforts: ["high", "banana", 3] } })).toEqual(["high"]);
    // A mandatory model whose only value is 'none' has no usable ladder.
    expect(openRouterEffortValues({ reasoning: { mandatory: true, supported_efforts: ["none"] } })).toBeUndefined();
  });
});

describe("mergeNousCatalog — Nous's own catalog feeds the runtime spec file", () => {
  let sync;
  beforeEach(async () => {
    vi.resetModules();
    ({ mergeNousCatalog: sync } = await import("../../src/lib/modelCatalog/sync.js"));
  });
  afterEach(() => vi.unstubAllGlobals());

  const withNous = (data) => {
    const models = { "other:model": { vision: true } };
    const providers = { other: { model: { contextWindow: 1 } } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ data })));
    return { models, providers };
  };

  it("files context, output cap, input modalities and the effort ladder", async () => {
    const { models, providers } = withNous([paid]);
    const result = await sync(models, providers);

    // baseId is vendor-stripped + lowercased + ":free"-stripped, like every row.
    expect(models["nous-portal:step-5-preview"]).toEqual({ vision: true, videoInput: true });
    const row = providers["nous-portal"]["step-5-preview"];
    expect(row.contextWindow).toBe(1000000);
    expect(row.maxOutput).toBe(64000);
    // mandatory === true, so 'none' is not offered and canDisable is false.
    expect(row.reasoning).toEqual({ levels: ["high", "medium", "low"], canDisable: false });
    expect(result.filed).toBe(1);
  });

  it("strips the ':free' suffix so both spellings land on one row", async () => {
    const { models, providers } = withNous([freeSuffixed, { ...freeSuffixed, id: "poolside/laguna-s-2.1" }]);
    await sync(models, providers);
    expect(providers["nous-portal"]["laguna-s-2.1"].contextWindow).toBe(262144);
    // text-only input contributes no modality row (nothing beyond "text").
    expect(models["nous-portal:laguna-s-2.1"]).toBeUndefined();
  });

  it("records a reasoning flag without a ladder for toggle-only models", async () => {
    const { models, providers } = withNous([{
      id: "x/toggle-only", context_length: 8192, supported_parameters: ["reasoning"],
    }]);
    await sync(models, providers);
    expect(providers["nous-portal"]["toggle-only"]).toEqual({
      contextWindow: 8192, reasons: true,
    });
  });

  it("is fail-open: a Nous outage leaves the models.dev rows untouched", async () => {
    const models = { "other:model": { vision: true } };
    const providers = { other: { model: { contextWindow: 1 } } };
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const result = await sync(models, providers);
    expect(result).toEqual({ skipped: true });
    expect(models).toEqual({ "other:model": { vision: true } });
    expect(providers).toEqual({ other: { model: { contextWindow: 1 } } });
  });

  it("skips on a non-2xx or malformed body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    expect((await sync({}, {})).skipped).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ nope: true })));
    expect((await sync({}, {})).skipped).toBe(true);
  });
});

// The writer and the reader must agree on keys AND units, or the price the sync
// persists is never the price cost calculation uses — the two halves of this
// feature live in different modules, so only a round trip proves they meet.
describe("pricing round-trip — sync output is what the cost path reads", () => {
  let getCatalogPricing, getCatalogLimits;

  const withCache = {
    id: "vendor/with-cache", context_length: 8192,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.0000015000", completion: "0.0000060000", input_cache_read: "0.0000001500" },
  };
  // Present in the catalog but publishes no pricing at all: must leave the
  // static tables in charge rather than be read as free.
  const noPrice = { id: "vendor/no-price", context_length: 1000, architecture: { input_modalities: ["text"], output_modalities: ["text"] } };

  beforeAll(async () => {
    const models = {};
    const providers = {};
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
      data: [paid, freeSuffixed, freeNoSuffix, withCache, noPrice],
    })));
    const { mergeNousCatalog } = await import("../../src/lib/modelCatalog/sync.js");
    await mergeNousCatalog(models, providers);
    const catalog = await import("../../open-sse/providers/catalogOverride.js");
    // stamp the version the reader itself declares rather than a literal
    fs.writeFileSync(catalogFile, JSON.stringify({ v: catalog.CATALOG_VERSION, models, providers }));
    catalog.invalidateCatalog();
    getCatalogPricing = catalog.getCatalogPricing;
    getCatalogLimits = catalog.getCatalogLimits;
    vi.unstubAllGlobals();
  });

  // The sync keys rows by baseId ("step-5-preview") while a request arrives as
  // the full id ("stepfun/step-5-preview"): the reader's baseId fallback is what
  // joins the two, and it is the same function on both sides.
  it("resolves the reseller's own price in $/1M, not the vendor's list rate", () => {
    expect(getCatalogPricing("nous-portal", "stepfun/step-5-preview")).toEqual({ input: 1, output: 2.7 });
  });

  it("calls a $0 model free even without a ':free' suffix", () => {
    expect(getCatalogPricing("nous-portal", "inclusionai/ling-3.1-flash")).toEqual({ input: 0, output: 0 });
  });

  it("resolves the ':free' form of a suffix-less $0 model to the same row", () => {
    expect(getCatalogPricing("nous-portal", "poolside/laguna-s-2.1:free")).toEqual({ input: 0, output: 0 });
  });

  it("carries the cache rate only when the catalog publishes one", () => {
    expect(getCatalogPricing("nous-portal", "vendor/with-cache")).toEqual({ input: 1.5, output: 6, cached: 0.15 });
    expect(getCatalogPricing("nous-portal", "stepfun/step-5-preview")).not.toHaveProperty("cached");
  });

  it("returns null when no price is published, so static tables keep answering", () => {
    expect(getCatalogPricing("nous-portal", "vendor/no-price")).toBeNull();
    expect(getCatalogPricing("nous-portal", "never/seen")).toBeNull();
    // a models.dev-sourced provider carries limits but no pricing block
    expect(getCatalogPricing("openai", "gpt-5")).toBeNull();
  });

  it("keeps context limits readable alongside the price it shares a row with", () => {
    expect(getCatalogLimits("nous-portal", "stepfun/step-5-preview")).toMatchObject({
      contextWindow: 1000000,
      pricing: { input: 1, output: 2.7 },
    });
  });

  it("accepts the dashboard alias, which is what several call sites pass", () => {
    expect(getCatalogPricing("nous", "inclusionai/ling-3.1-flash")).toEqual({ input: 0, output: 0 });
  });
});
