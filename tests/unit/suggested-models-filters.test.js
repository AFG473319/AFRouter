import { describe, expect, it } from "vitest";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";

describe("suggested-models filters", () => {
  describe("openai (generic OpenAI-shape catalog)", () => {
    it("sorts $0 ids (orcarouter/free, *-free) ahead of the paid catalog", () => {
      const out = FILTERS.openai([
        { id: "anthropic/claude-opus-4.8", context_length: 200000 },
        { id: "z-ai/glm-5.3-flash-free", context_length: 1000000 },
        { id: "openai/gpt-5.5", context_length: 400000 },
        { id: "orcarouter/free" },
      ]);
      // free group first (then by ctx, ctx-less last), paid catalog after
      expect(out.map((m) => m.id)).toEqual([
        "z-ai/glm-5.3-flash-free",
        "orcarouter/free",
        "openai/gpt-5.5",
        "anthropic/claude-opus-4.8",
      ]);
    });

    it("treats OpenRouter-style :free suffixes as $0", () => {
      const out = FILTERS.openai([
        { id: "vendor/model:free", context_length: 16000 },
        { id: "vendor/paid", context_length: 400000 },
      ]);
      expect(out.map((m) => m.id)).toEqual(["vendor/model:free", "vendor/paid"]);
    });

    it("omits contextLength when the catalog entry carries no numeric context_length", () => {
      const out = FILTERS.openai([{ id: "orcarouter/free", name: "Orca Free" }]);
      expect(out[0]).toEqual({ id: "orcarouter/free", name: "Orca Free" });
    });

    it("filters out entries without an id and caps at 100", () => {
      const many = Array.from({ length: 150 }, (_, i) => ({ id: `vendor/model-${i}`, context_length: i }));
      const out = FILTERS.openai([{ name: "no id" }, ...many]);
      expect(out).toHaveLength(100);
    });

    it("tolerates a non-array payload", () => {
      expect(FILTERS.openai(null)).toEqual([]);
      expect(FILTERS.openai({ data: "unexpected" })).toEqual([]);
    });
  });

  describe("nvidia (models.dev provider catalog)", () => {
    const model = (overrides = {}) => ({
      id: "vendor/model",
      name: "Model",
      modalities: { input: ["text"], output: ["text"] },
      tool_call: true,
      cost: { input: 0, output: 0 },
      limit: { context: 128000 },
      last_updated: "2026-01-01",
      ...overrides,
    });

    it("returns free tool-capable chat models with context specs", () => {
      const out = FILTERS.nvidia({ nvidia: { models: { "vendor/model": model() } } });
      expect(out).toEqual([{ id: "vendor/model", name: "Model", contextLength: 128000 }]);
    });

    it("excludes non-chat, paid, and non-tool models and orders newest first", () => {
      const out = FILTERS.nvidia({ nvidia: { models: {
        old: model(),
        new: model({ id: "vendor/new", last_updated: "2026-02-01" }),
        paid: model({ id: "vendor/paid", cost: { input: 0.1, output: 0 } }),
        image: model({ id: "vendor/image", modalities: { input: ["text"], output: ["image"] } }),
        noTools: model({ id: "vendor/no-tools", tool_call: false }),
      } } });
      expect(out.map((m) => m.id)).toEqual(["vendor/new", "vendor/model"]);
    });

    it("tolerates missing or malformed provider data", () => {
      expect(FILTERS.nvidia(null)).toEqual([]);
      expect(FILTERS.nvidia({ nvidia: { models: {} } })).toEqual([]);
    });
  });
});
