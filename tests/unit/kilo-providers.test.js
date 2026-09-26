import { describe, expect, it } from "vitest";
import kilocode from "../../open-sse/providers/registry/kilocode.js";
import kiloGateway from "../../open-sse/providers/registry/kilo-gateway.js";
import { FILTERS } from "../../src/app/api/providers/suggested-models/filters.js";
import { PROVIDER_MODELS } from "../../open-sse/providers/index.js";

// Kilo Code and Kilo Gateway are the same upstream (api.kilo.ai): one
// OpenRouter-shaped catalog of ~394 ids behind two surfaces — the OAuth
// /api/openrouter/chat/completions proxy and the API-key /api/gateway
// /chat/completions. The gateway 400s any id the catalog does not list, so a
// stale seed entry is a chip that can only ever fail. These ids were checked
// against GET https://api.kilo.ai/api/gateway/models; keep them in sync when the
// catalog is refreshed (the same endpoint the modelsFetcher reads).
const CATALOG_IDS = [
  "kilo-auto/free",
  "kilo-auto/frontier",
  "kilo-auto/balanced",
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-opus-4.7",
  "openai/gpt-5.4",
  "google/gemini-2.5-pro",
  "google/gemini-2.5-flash",
  "openai/gpt-4.1",
  "openai/o3",
  "deepseek/deepseek-chat",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "kwaipilot/kat-coder-pro-v2.5",
];

describe("kilo provider registries", () => {
  it("seeds only ids the live catalog still lists", () => {
    const listed = new Set(CATALOG_IDS);
    const dead = [...kilocode.models, ...kiloGateway.models]
      .map((m) => m.id)
      .filter((id) => !listed.has(id));
    expect(dead).toEqual([]);
  });

  it("drops the retired ids that used to sit in the seed", () => {
    const ids = kilocode.models.map((m) => m.id);
    expect(ids).not.toContain("anthropic/claude-sonnet-4-20250514");
    expect(ids).not.toContain("anthropic/claude-opus-4-20250514");
    expect(ids).not.toContain("deepseek/deepseek-reasoner");
    // kwaipilot's free tier was pulled: only the paid id exists.
    expect(kiloGateway.models.map((m) => m.id)).not.toContain("kwaipilot/kat-coder-pro-v2.5:free");
    expect(kiloGateway.models.map((m) => m.id)).toContain("kwaipilot/kat-coder-pro-v2.5");
  });

  it("exposes the seed through the kc/kgw aliases used by the dashboard and /v1/models", () => {
    expect(PROVIDER_MODELS.kc.map((m) => m.id)).toEqual(kilocode.models.map((m) => m.id));
    expect(PROVIDER_MODELS.kgw.map((m) => m.id)).toEqual(kiloGateway.models.map((m) => m.id));
  });

  it("reads the catalog through exactly one fetcher per provider", () => {
    // The duplicate was a kilocode-only /api/providers/kilo/free-models route
    // hitting the same URL with a different filter — that is what rendered every
    // free model twice.
    expect(kilocode.modelsFetcher.url).toBe("https://api.kilo.ai/api/gateway/models");
    expect(kilocode.modelsFetcher.type).toBe("kilo-free");
    expect(kilocode.passthroughModels).toBe(true);
    // modelSpecs is what gives a saved model its real context window; without it
    // every Kilo model falls back to the 200K default.
    expect(kilocode.modelSpecs).toEqual({ format: "openrouter", auth: "none" });
    expect(kilocode.modelSpecs.url ?? kilocode.modelsFetcher.url)
      .toBe("https://api.kilo.ai/api/gateway/models");
  });

  it("routes the OAuth surface and the API-key surface to their own base URLs", () => {
    expect(kilocode.transport.baseUrl).toBe("https://api.kilo.ai/api/openrouter/chat/completions");
    expect(kiloGateway.transport.baseUrl).toBe("https://api.kilo.ai/api/gateway/chat/completions");
  });
});

describe("kilo-free suggested filter", () => {
  // One catalog entry per shape the endpoint returns, mirroring the real payload
  // (OpenRouter envelope plus Kilo's own isFree flag).
  const catalog = [
    // Free, large context — the normal case.
    { id: "poolside/laguna-s-2.1:free", name: "Poolside: Laguna S 2.1 (free)", isFree: true, context_length: 262144, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
    // Free but under the 200k floor the old "openrouter-free" filter required —
    // this is what that filter silently hid.
    { id: "liquid/lfm-2.5-2.6b:free", name: "Liquid: LFM2.5-2.6B (free)", isFree: true, context_length: 65536, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
    // $0 pricing but audio-only: Kilo lists it at zero, yet it is not a chat
    // model, and the pricing heuristic used to suggest it as one.
    { id: "google/lyria-3-pro-preview", name: "Google: Lyria 3 Pro Preview", isFree: false, context_length: 1048576, architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] }, pricing: { prompt: "0", completion: "0" } },
    // Paid model — never a free suggestion.
    { id: "anthropic/claude-sonnet-4.6", name: "Anthropic: Claude Sonnet 4.6", isFree: false, context_length: 1000000, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0.000003", completion: "0.000015" } },
    // Guardrail model: free and text-output, so it stays (it is a legitimate
    // chat-shaped endpoint); filtering it would be a policy call, not a shape one.
    { id: "nvidia/nemotron-3.5-content-safety:free", name: "NVIDIA: Nemotron 3.5 Content Safety (free)", isFree: true, context_length: 128000, architecture: { output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
  ];

  const out = FILTERS["kilo-free"](catalog);
  const ids = out.map((m) => m.id);

  it("keeps the models Kilo itself marks free", () => {
    expect(ids).toContain("poolside/laguna-s-2.1:free");
    expect(ids).toContain("nvidia/nemotron-3.5-content-safety:free");
  });

  it("keeps free ids below the 200k context floor", () => {
    expect(ids).toContain("liquid/lfm-2.5-2.6b:free");
  });

  it("drops paid models and non-text-output models", () => {
    expect(ids).not.toContain("anthropic/claude-sonnet-4.6");
    expect(ids).not.toContain("google/lyria-3-pro-preview");
  });

  it("sorts by context and omits a missing context instead of rendering NaN", () => {
    expect(ids[0]).toBe("poolside/laguna-s-2.1:free");
    const noCtx = FILTERS["kilo-free"]([{ id: "a:free", isFree: true }]);
    expect(noCtx[0]).toEqual({ id: "a:free", name: "a:free" });
  });

  it("carries the curated name and tolerates a malformed payload", () => {
    expect(out.find((m) => m.id === "poolside/laguna-s-2.1:free").name).toBe("Poolside: Laguna S 2.1 (free)");
    expect(FILTERS["kilo-free"](undefined)).toEqual([]);
    expect(FILTERS["kilo-free"]([{}, null])).toEqual([]);
  });

  it("shows what the pricing heuristic used to get wrong", () => {
    const old = FILTERS["openrouter-free"](catalog).map((m) => m.id);
    // hidden by the 200k floor, and audio-only Lyria offered as a chat model
    expect(old).not.toContain("liquid/lfm-2.5-2.6b:free");
    expect(old).toContain("google/lyria-3-pro-preview");
  });
});
