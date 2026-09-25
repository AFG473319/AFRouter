import { getProviderConnections } from "@/lib/db/index.js";
import registry from "open-sse/providers/registry/index.js";

const FETCH_TIMEOUT_MS = 10000;

// Only consume fields explicitly declared by the catalog. Missing fields keep
// the existing fallback; false declarations must not be turned into guesses.
export function normalizeCatalogSpecs(model) {
  const caps = {};
  const input = model.architecture?.input_modalities;
  if (Array.isArray(input)) {
    for (const [modality, key] of Object.entries({ image: "vision", audio: "audioInput", video: "videoInput", file: "pdf" })) {
      caps[key] = input.includes(modality);
    }
  }
  const parameters = model.supported_parameters;
  if (Array.isArray(parameters)) {
    caps.tools = parameters.includes("tools");
    caps.reasoning = parameters.includes("reasoning") || parameters.includes("reasoning_effort");
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
