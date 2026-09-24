import { PROVIDERS } from "./providers.js";
import REGISTRY from "../providers/registry/index.js";
// PROVIDER_MODELS now built from providers/registry (transport + models co-located)
import { PROVIDER_MODELS } from "../providers/index.js";
import { modelQuotaFamily, modelStrip, modelTargetFormat, modelSupportedFormats, normalizeModelId, providerDefaultTargetFormat } from "../providers/models/schema.js";
import { CODEX_REVIEW_SUFFIX, isMuseSparkModel } from "../providers/models/helpers.js";
import { FORMATS } from "../translator/formats.js";
export { PROVIDER_MODELS };


// Helper functions
export function getProviderModels(aliasOrId) {
  return PROVIDER_MODELS[aliasOrId] || [];
}

export function getDefaultModel(aliasOrId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return models?.[0]?.id || null;
}

// Providers whose registry uses dots in version numbers (e.g. "claude-sonnet-4.5").
// For these, we tolerate clients sending dashes ("claude-sonnet-4-5") by normalizing
// digit-hyphen-digit to digit-dot-digit before lookup. Other providers are left untouched.
const DOT_VERSION_PROVIDERS = new Set(["kr", "kiro"]);

// Find a registry entry by id. For Kiro models, tolerates dash/dot version separators
// ("claude-sonnet-4-5" ~= "claude-sonnet-4.5"). Other providers use exact match only.
function findModel(models, modelId, aliasOrId) {
  if (!models) return undefined;
  const baseModelId = stripThinkingModelId(modelId);
  const index = getModelIndex(aliasOrId);
  const normalizedModelId = DOT_VERSION_PROVIDERS.has(aliasOrId)
    ? normalizeModelId(baseModelId)
    : baseModelId;
  return index?.exact.get(modelId)
    || index?.base.get(baseModelId)
    || index?.normalized.get(normalizedModelId)
    || undefined;
}

// Registry models are immutable after module initialization. Build lookup maps once
// instead of scanning every provider's model array for each routing field lookup.
function stripThinkingModelId(modelId) {
  return typeof modelId === "string"
    ? modelId.replace(/\([^()]+\)\s*$/, "").trim()
    : modelId;
}

function getModelIndex(aliasOrId) {
  return MODEL_INDEXES[aliasOrId];
}

const MODEL_INDEXES = Object.fromEntries(
  Object.entries(PROVIDER_MODELS).map(([alias, models]) => {
    const exact = new Map();
    const base = new Map();
    const normalized = new Map();
    for (const model of models) {
      if (!exact.has(model.id)) exact.set(model.id, model);
      const modelBase = stripThinkingModelId(model.id);
      if (!base.has(modelBase)) base.set(modelBase, model);
      if (DOT_VERSION_PROVIDERS.has(alias)) {
        const modelNormalized = normalizeModelId(modelBase);
        if (!normalized.has(modelNormalized)) normalized.set(modelNormalized, model);
      }
    }
    return [alias, { exact, base, normalized }];
  }),
);

export function isValidModel(aliasOrId, modelId, passthroughProviders = new Set()) {
  if (passthroughProviders.has(aliasOrId)) return true;
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return false;
  return !!findModel(models, modelId, aliasOrId);
}

export function findModelName(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return modelId;
  const found = findModel(models, modelId, aliasOrId);
  return found?.name || modelId;
}

const PROVIDER_DEFS_BY_KEY = new Map();
for (const entry of REGISTRY) {
  for (const key of [entry.id, entry.alias, entry.uiAlias]) {
    if (key && !PROVIDER_DEFS_BY_KEY.has(key)) PROVIDER_DEFS_BY_KEY.set(key, entry);
  }
}

function findProviderDef(aliasOrId) {
  if (!aliasOrId) return undefined;
  return PROVIDER_DEFS_BY_KEY.get(aliasOrId);
}

export function getModelTargetFormat(aliasOrId, modelId) {
  if ((!aliasOrId || aliasOrId === "oc" || aliasOrId === "opencode" || aliasOrId === "ocg" || aliasOrId === "opencode-go") && isMuseSparkModel(modelId)) {
    return FORMATS.OPENAI_RESPONSES;
  }
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, aliasOrId);
  const explicit = modelTargetFormat(found);
  if (explicit) return explicit;
  // Passthrough/unlisted ids inherit the provider's default format
  // (TypeSafe AI: defaultTargetFormat "systemone" for every model).
  return providerDefaultTargetFormat(findProviderDef(aliasOrId));
}

/**
 * True when provider/model is a decisions-only System One model (TypeSafe Jev,
 * OpenCode Jev free, …). Handles registered targetFormat and provider-level
 * defaultTargetFormat so passthrough ids route and log like the catalog ones.
 */
export function isSystemOneModel(aliasOrId, modelId) {
  return getModelTargetFormat(aliasOrId, modelId) === "systemone";
}

// Declared upstream formats for a model (registry `supportedFormats`). Drives the
// per-model guard on the sourceFormat-matched transport; null when undeclared.
export function getModelSupportedFormats(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  return modelSupportedFormats(findModel(models, modelId, aliasOrId));
}

export function getModelType(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  if (!models) return null;
  const found = findModel(models, modelId, aliasOrId);
  return found?.kind || found?.type || null;
}

export function getModelUpstreamId(aliasOrId, modelId) {
  // Split off thinking suffix "(level)" so lookup hits the base id; re-append it to
  // the result so downstream applyThinking still sees the suffix (body.model is stripped separately).
  const sufMatch = typeof modelId === "string" ? modelId.match(/\([^()]+\)\s*$/) : null;
  const suffix = sufMatch ? sufMatch[0] : "";
  const baseId = suffix ? modelId.slice(0, sufMatch.index).trim() : modelId;
  const models = PROVIDER_MODELS[aliasOrId];
  const found = findModel(models, baseId, aliasOrId);
  const resolvedId = found?.upstreamModelId || found?.id;
  if (resolvedId) {
    const presetMatch = resolvedId.match(/\([^()]+\)\s*$/);
    const presetSuffix = presetMatch?.[0] || "";
    const resolvedBase = presetSuffix ? resolvedId.slice(0, presetMatch.index).trim() : resolvedId;
    return resolvedBase + (suffix || presetSuffix);
  }
  if (aliasOrId === "cx" && typeof baseId === "string" && baseId.endsWith(CODEX_REVIEW_SUFFIX)) {
    return baseId.slice(0, -CODEX_REVIEW_SUFFIX.length) + suffix;
  }
  return baseId + suffix;
}

export function getModelQuotaFamily(aliasOrId, modelId) {
  const models = PROVIDER_MODELS[aliasOrId];
  return modelQuotaFamily(findModel(models, modelId, aliasOrId));
}

// OAuth short aliases — derived from registry `alias` (single source). everything else: alias = id.
// vertex/vertex-partner keep alias=id (kept via the `|| id` fallback in consumers).
export const OAUTH_ALIASES = Object.fromEntries(
  REGISTRY.filter(r => r.alias && r.alias !== r.id).map(r => [r.id, r.alias])
);

// Derived from PROVIDERS — no need to maintain manually
export const PROVIDER_ID_TO_ALIAS = Object.fromEntries(
  Object.keys(PROVIDERS).map(id => [id, OAUTH_ALIASES[id] || id])
);

export function getModelsByProviderId(providerId) {
  const alias = PROVIDER_ID_TO_ALIAS[providerId] || providerId;
  return PROVIDER_MODELS[alias] || [];
}

// Get strip list for a model entry (explicit opt-in only)
// Returns array of content types to strip, e.g. ["image", "audio"]
export function getModelStrip(alias, modelId) {
  return modelStrip(findModel(PROVIDER_MODELS[alias], modelId, alias));
}
