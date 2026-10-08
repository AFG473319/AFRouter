/**
 * Kilo providers must be catalogued from Kilo's own API, not models.dev.
 *
 * The daily sync used to take Kilo's modalities/limits/reasoning from
 * models.dev's secondhand `kilo` entry. This pins the replacement: the sync
 * fetches KILO_CATALOG_URL directly, converts Kilo's OpenRouter-shaped
 * entries, and never lets models.dev's `kilo` row through.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "9r-kilo-catalog-"));
process.env.DATA_DIR = dataDir;
const catalogFile = path.join(dataDir, "model-catalog.json");

// models.dev's copy — present with different data on purpose. If it leaks
// through, the mismatched values in `written` give it away.
const MODELS_DEV = {
  kilo: { models: { "efficient": { modalities: { input: ["text", "image"] } } } },
};

const KILO_CATALOG = {
  data: [
    {
      id: "anthropic/claude-sonnet-4.6",
      name: "Anthropic: Claude Sonnet 4.6",
      architecture: { input_modalities: ["text", "image", "pdf"], output_modalities: ["text"] },
      context_length: 1000000,
      top_provider: { max_completion_tokens: 128000 },
      supported_parameters: ["tools", "reasoning", "reasoning_effort"],
      opencode: {
        variants: {
          none: { reasoning: { enabled: true, effort: "none" } },
          high: { reasoning: { enabled: true, effort: "high" } },
          disabled: { reasoning: { enabled: false, effort: "max" } },
        },
      },
    },
    // "file" is Kilo's other spelling for document input — must land as pdf.
    {
      id: "vendor/pdf-model",
      name: "PDF Model",
      architecture: { input_modalities: ["text", "file"], output_modalities: ["text"] },
      context_length: 32000,
      top_provider: { max_completion_tokens: 4096 },
      supported_parameters: ["tools"],
    },
  ],
};

let build, getCatalogModalities, getCatalogReasoning, invalidateCatalog, syncModelCatalog, kiloCatalogFromKiloApi;

beforeAll(async () => {
  ({ build, syncModelCatalog, kiloCatalogFromKiloApi } = await import("../../src/lib/modelCatalog/sync.js"));
  ({ getCatalogModalities, getCatalogReasoning, invalidateCatalog } = await import("../../open-sse/providers/catalogOverride.js"));
  expect(typeof syncModelCatalog).toBe("function");
});

afterAll(async () => {
  const capabilities = await import("../../open-sse/providers/capabilities.js");
  capabilities.setCatalogSource(null);
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("kilo providers synced from Kilo's own catalog", () => {
  it("replaces models.dev's kilo entry with the live catalog", { timeout: 30000 }, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const body = String(url).includes("api.kilo.ai") ? KILO_CATALOG : MODELS_DEV;
      return {
        ok: true, status: 200,
        headers: new Map([["etag", 'W/"kilo-etag"']]),
        json: async () => body,
      };
    };
    try {
      expect((await syncModelCatalog()).status).toBe("updated");
    } finally {
      globalThis.fetch = realFetch;
    }

    const written = JSON.parse(fs.readFileSync(catalogFile, "utf8"));
    // Kilo's catalog serves both local ids...
    expect(written.models["kilocode:claude-sonnet-4.6"]).toEqual({ vision: true, pdf: true });
    expect(written.models["kilo-gateway:claude-sonnet-4.6"]).toEqual({ vision: true, pdf: true });
    // ...and Kilo's own spellings win over the mirror: the models.dev-only
    // "efficient" entry must NOT be filed under either Kilo provider.
    expect(written.models["kilocode:efficient"]).toBeUndefined();
    expect(written.models["kilo-gateway:efficient"]).toBeUndefined();
    // "file" input modality normalizes to pdf.
    expect(written.models["kilocode:pdf-model"]).toEqual({ pdf: true });

    invalidateCatalog();
    expect(getCatalogModalities("kilo-gateway", "anthropic/claude-sonnet-4.6")).toEqual({ vision: true, pdf: true });
    // The reasoning ladder comes from Kilo's opencode.variants: enabled only.
    expect(getCatalogReasoning("kilo-gateway", "anthropic/claude-sonnet-4.6")).toEqual({
      levels: ["none", "high"],
      canDisable: true,
    });
  });

  it("converts Kilo's shape into the models.dev shape build() expects", () => {
    const converted = kiloCatalogFromKiloApi(KILO_CATALOG);
    const model = converted.models["vendor/pdf-model"];
    expect(model.modalities.input).toEqual(["text", "pdf"]);
    expect(model.limit).toEqual({ context: 32000, output: 4096 });
    expect(model.tool_call).toBe(true);
    expect(model.reasoning).toBe(false);
    const sonnet = converted.models["anthropic/claude-sonnet-4.6"];
    expect(sonnet.reasoning).toBe(true);
    expect(sonnet.reasoning_options).toEqual([{ type: "effort", values: ["none", "high"] }]);
  });
});
