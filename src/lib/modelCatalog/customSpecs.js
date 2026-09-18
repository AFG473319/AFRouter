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

// Opt-in provider-owned sources, never a URL from the request. Authentication
// stays server-side and redirects are disabled so credentials cannot travel to
// a different host. Lookup failure must never prevent a manual model save.
export async function lookupCustomModelSpecs(providerAlias, modelId) {
  try {
    const provider = registry.find((p) => p.id === providerAlias || p.alias === providerAlias);
    const source = provider?.modelSpecs;
    if (!source || source.format !== "openrouter") return null;
    const headers = { Accept: "application/json" };
    if (source.auth === "bearer") {
      const connections = await getProviderConnections({ provider: provider.id, isActive: true });
      const token = connections.map((c) => c.accessToken || c.apiKey).find(Boolean);
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const response = await fetch(provider.modelsFetcher.url, {
      headers, redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = await response.json();
    if (!Array.isArray(data?.data)) return null;
    // Preserve vendor prefixes and tier suffixes; each listing has its own limits.
    const model = data.data.find((m) => m?.id === modelId);
    return model ? normalizeCatalogSpecs(model) : null;
  } catch {
    return null;
  }
}
