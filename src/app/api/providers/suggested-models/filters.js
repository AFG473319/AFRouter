import { kiloReasoningLevels } from "@/lib/kiloReasoning.js";

// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];
// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

// $0 ids on generic OpenAI-shape gateways: suffixed convention ("x-free",
// OpenRouter-style "model:free") or router pool ("orcarouter/free"). Pricing
// fields are absent from /v1/models, so the id shape is the only signal —
// same heuristic as "opencode-free".
const isFreeModelId = (id) => /(^|[-_/:])free$/i.test(id || "");

// Shared Kilo catalog mapping (kilo-free + kilo-gateway). Kept in one place so
// the two surfaces cannot drift on specs or reasoning levels.
const kiloCatalog = (models, { freeOnly }) =>
  (Array.isArray(models) ? models : [])
    .filter((m) => m?.id)
    .filter((m) => !freeOnly || m.isFree === true)
    .filter((m) => (m.architecture?.output_modalities || ["text"]).includes("text"))
    .map((m) => {
      const reasoning = kiloReasoningLevels(m);
      return {
        id: m.id,
        name: m.name || m.id,
        ...(Number.isSafeInteger(m.context_length) && m.context_length > 0
          ? { contextLength: m.context_length }
          : {}),
        // Absent (not `[]`) when the model does not reason at all, so consumers
        // can tell "no reasoning" from "reasons, no selectable effort".
        ...(reasoning ? { reasoningEfforts: reasoning } : {}),
      };
    })
    .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));


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

  // Kilo's gateway catalog is OpenRouter-shaped but declares its own free flag,
  // so use it instead of guessing from $0 pricing: the pricing heuristic also
  // needs a context floor (it is what hides 65k-128k free ids and, worse,
  // suggests $0 audio-output models like google/lyria-3-pro-preview as chat
  // models). isFree is authoritative and covers both cases.
  //
  // `reasoningEfforts` is carried through because this is the ONLY place the
  // catalog's per-model level map is available to the dashboard: Kilo publishes
  // it under opencode.variants (a display-name → wire-effort map), and dropping
  // it here is why Kilo models had no selectable reasoning levels. Levels are
  // resolved at the picker, where the label the user sees carries its own wire
  // value, so no nearest-level coercion is involved for a single model.
  "kilo-free": (models) => kiloCatalog(models, { freeOnly: true }),

  // Kilo Gateway shares the catalog and its level map but is not free-only: it
  // is the paid/auto-routing surface (kilo-auto/*), so filtering on isFree
  // would suggest nothing.
  "kilo-gateway": (models) => kiloCatalog(models, { freeOnly: false }),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // Go subscription catalogue — every /models id is selectable; the endpoint lane
  // per model is resolved by the family regex (see open-sse/providers/models/helpers.js)
  "opencode-go": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string")
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
