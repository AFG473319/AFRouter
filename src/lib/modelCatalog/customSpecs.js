import { getProviderConnections } from "@/lib/db/index.js";
import registry from "open-sse/providers/registry/index.js";
import { kiloEffortValues } from "@/lib/kiloReasoning.js";
import { openRouterEffortValues } from "./efforts.js";

const FETCH_TIMEOUT_MS = 10000;

// Only consume fields explicitly declared by the catalog. Missing fields keep
// the existing fallback; false declarations must not be turned into guesses.
export function normalizeCatalogSpecs(model) {
  const caps = {};
  const input = model.architecture?.input_modalities;
  if (Array.isArray(input)) {
    for (const [modality, key] of Object.entries({ image: "vision", audio: "audioInput", video: "videoInput" })) {
      caps[key] = input.includes(modality);
    }
    // Kilo spells document input "pdf" on some models and "file" on others —
    // 25 of 401 live models use only "pdf", so mapping just one silently
    // strips the pdf flag from a large slice of the catalog.
    caps.pdf = input.includes("pdf") || input.includes("file");
  }
  // Output modalities are capabilities too: a model that emits images or audio
  // must not read as a text-only chat model (Nous lists image-output and
  // audio-output entries this way). Emitted only when the catalog declares the
  // field, so a partial listing keeps the existing default instead of a
  // fabricated false.
  const output = model.architecture?.output_modalities;
  if (Array.isArray(output)) {
    caps.imageOutput = output.includes("image");
    caps.audioOutput = output.includes("audio");
  }
  const parameters = model.supported_parameters;
  if (Array.isArray(parameters)) {
    caps.tools = parameters.includes("tools");
    caps.reasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort");
  }
  // The reasoning EFFORT LADDER, when the catalog publishes one.
  //
  // Kilo publishes it as `opencode.variants` (a display-label → wire-effort map
  // and the only reason a Kilo model has selectable levels at all).
  //
  // OpenRouter publishes none — and the comment here used to claim Nous didn't
  // either. That is wrong: Nous's /v1/models carries
  // `reasoning.supported_efforts` for ~188 of its 422 models, already spelled in
  // our exact wire vocabulary (none/minimal/low/medium/high/xhigh/max), so those
  // levels are taken verbatim instead of being left to the hand tables' family
  // guesses. `reasoning.mandatory` (~113 models) means thinking cannot be turned
  // off, so `none` is dropped and the model marked not-disableable — a ladder
  // that offers `none` to a model that 400s on it is worse than no ladder.
  //
  // Only WIRE values are kept (Kilo's variant keys are display labels the router
  // cannot send), and an empty ladder is dropped, so "no reasoning" stays
  // distinguishable from "reasons, no selectable effort".
  const efforts = openRouterEffortValues(model);
  if (efforts?.length) {
    caps.reasoningEfforts = efforts;
    caps.reasoning = true;
    if (model?.reasoning?.mandatory === true) caps.thinkingCanDisable = false;
  } else {
    const kilo = kiloEffortValues(model);
    if (kilo?.length) caps.reasoningEfforts = kilo;
  }
  for (const [key, value] of Object.entries({
    contextWindow: model.context_length,
    maxOutput: model.top_provider?.max_completion_tokens,
  })) {
    if (Number.isSafeInteger(value) && value > 0) caps[key] = value;
  }
  return { ...(typeof model.name === "string" && model.name ? { name: model.name } : {}), caps };
}

// models.dev has a different shape from the OpenAI/NVIDIA-style catalog. Keep
// the conversion here, next to the existing OpenRouter conversion, so a model
// added from the NVIDIA catalog does not silently get guessed capabilities.
export function normalizeModelsDevSpecs(model) {
  const caps = {};
  const input = model?.modalities?.input;
  if (Array.isArray(input)) {
    for (const [modality, key] of Object.entries({ image: "vision", audio: "audioInput", video: "videoInput", pdf: "pdf" })) {
      caps[key] = input.includes(modality);
    }
  }
  if (typeof model?.tool_call === "boolean") caps.tools = model.tool_call;
  if (typeof model?.reasoning === "boolean") caps.reasoning = model.reasoning;
  for (const [key, value] of Object.entries({
    contextWindow: model?.limit?.context,
    maxOutput: model?.limit?.output,
  })) {
    if (Number.isSafeInteger(value) && value > 0) caps[key] = value;
  }
  return { ...(typeof model?.name === "string" && model.name ? { name: model.name } : {}), caps };
}

// Opt-in provider-owned sources, never a URL from the request. Authentication
// stays server-side and redirects are disabled so credentials cannot travel to
// a different host. Lookup failure must never prevent a manual model save.
export async function lookupCustomModelSpecs(providerAlias, modelId) {
  try {
    const provider = registry.find((p) => p.id === providerAlias || p.alias === providerAlias);
    const source = provider?.modelSpecs;
    if (!source || !["openrouter", "models-dev"].includes(source.format)) return null;
    const headers = { Accept: "application/json" };
    if (source.auth === "bearer") {
      const connections = await getProviderConnections({ provider: provider.id, isActive: true });
      const token = connections.map((c) => c.accessToken || c.apiKey).find(Boolean);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const url = source.url || provider.modelsFetcher?.url;
    if (!url) return null;
    const response = await fetch(url, {
      headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    let model;
    if (source.format === "models-dev") {
      model = data?.[source.provider || provider.id]?.models?.[modelId];
    } else if (Array.isArray(data?.data)) {
      // Preserve vendor prefixes and tier suffixes; each listing has its own limits.
      model = data.data.find((m) => m?.id === modelId);
    }
    if (!model) return null;
    return source.format === "models-dev" ? normalizeModelsDevSpecs(model) : normalizeCatalogSpecs(model);
  } catch {
    return null;
  }
}
