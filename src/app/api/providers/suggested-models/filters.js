// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

// $0 ids on generic OpenAI-shape gateways: suffixed convention ("x-free",
// OpenRouter-style "model:free") or router pool ("orcarouter/free"). Pricing
// fields are absent from /v1/models, so the id shape is the only signal —
// same heuristic as "opencode-free".
const isFreeModelId = (id) => /(^|[-_/:])free$/i.test(id || "");

export const FILTERS = {
  // Generic OpenAI-shaped /v1/models catalog (orcarouter, tokenrouter, venice, vercel, perplexity-agent).
  // Previously 400'd as "unknown type" — those providers silently showed no suggested models.
  // Bounded + sorted: some gateways expose 90-300+ ids and stock OpenAI-shape
  // entries carry no context_length (omit it rather than emitting undefined,
  // which renders as "NaNk ctx" in the dashboard). Free ids (orcarouter/free,
  // *-free) sort first so $0 options surface ahead of the paid catalog.
  "openai": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m?.id)
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        ...(typeof m.context_length === "number" ? { contextLength: m.context_length } : {}),
      }))
      .sort((a, b) => {
        const freeDiff = Number(isFreeModelId(b.id)) - Number(isFreeModelId(a.id));
        if (freeDiff !== 0) return freeDiff;
        return (b.contextLength || 0) - (a.contextLength || 0);
      })
      .slice(0, 100),

  // NVIDIA's public /v1/models endpoint is OpenAI-shaped but only returns
  // ids. models.dev is the provider-scoped catalog used here instead: it keeps
  // the live NIM ids and carries enough metadata to avoid suggesting
  // embeddings, image/video models, safety models, and paid-only entries as
  // chat models. The page's existing custom-model flow persists the full specs
  // when a suggestion is added.
  "nvidia": (payload) => {
    const envelope = Array.isArray(payload) ? payload[0] : payload;
    const provider = envelope?.nvidia || envelope;
    return Object.values(provider?.models || {})
      .filter((model) => model?.id)
      .filter((model) => model.modalities?.input?.includes("text") && model.modalities?.output?.includes("text"))
      .filter((model) => model.tool_call === true)
      .filter((model) => model.cost?.input === 0 && model.cost?.output === 0)
      .sort((a, b) => String(b.last_updated || "").localeCompare(String(a.last_updated || ""))
        || (b.limit?.context || 0) - (a.limit?.context || 0))
      .slice(0, 100)
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        ...(Number.isSafeInteger(model.limit?.context) && model.limit.context > 0
          ? { contextLength: model.limit.context }
          : {}),
      }));
  },

  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  "airforce-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || m.media_type === "chat" || m.media_type === "text"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  // Nous Portal mirrors OpenRouter's catalog shape; the picker section is
  // "free models", and on Nous only ids suffixed ":free" are free.
  "nous": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.endsWith(":free"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0)),
};
