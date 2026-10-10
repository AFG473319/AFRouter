/**
 * Zed config shapes, shared by /api/cli-tools/zed-settings and the dashboard
 * card so the file we write and the Manual Config preview cannot drift.
 *
 * Zed (https://zed.dev) keeps user settings in a single JSON document:
 *
 *   Linux   ~/.config/zed/settings.json
 *   macOS   ~/.config/zed/settings.json
 *   Windows %APPDATA%\Zed\settings.json
 *
 * AI configuration lives under `language_models.openai_compatible`:
 *
 *   {
 *     "language_models": {
 *       "openai_compatible": {
 *         "afrouter": {
 *           "api_url": "http://localhost:20128/v1",
 *           "available_models": [
 *             {
 *               "name": "anthropic/claude-sonnet-4-5",
 *               "display_name": "Claude Sonnet 4.5",
 *               "max_tokens": 200000,
 *               "max_output_tokens": 64000,
 *               "capabilities": { "tools": true, "images": false }
 *             }
 *           ]
 *         }
 *       }
 *     }
 *   }
 *
 * Zed's settings.json is JSONC — it supports line and block comments and
 * trailing commas. The route strips both before parsing.
 *
 * Auth: Zed stores API keys in the system keychain, not in settings.json.
 * The key can be set via the environment variable AFROUTER_API_KEY or
 * through Zed's settings UI. We write the provider config only.
 *
 * Pure module (no Node builtins) so the client-side card can import it too.
 */

import { specForCli } from "@/lib/cliModelSpec.js";

export const ZED_PROVIDER_ID = "afrouter";

// Zed resolves the settings path per-platform.
export const ZED_SETTINGS_FILE = "settings.json";

// crates/language_model_core ReasoningEffort, serde rename_all = "lowercase".
// Zed has no "ultra", so `ultra` is dropped instead of being renamed.
export const ZED_REASONING_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Zed talks to /v1/chat/completions; the gateway card supplies the bare origin. */
export const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed.replace(/\/+\/v1$/, "/v1") : `${trimmed}/v1`;
};

/**
 * One Zed model entry. Zed requires `max_tokens` (the context window) on
 * `OpenAiCompatibleAvailableModel` and reads `max_output_tokens`, `reasoning_effort`
 * and `capabilities.*` (crates/settings_content/src/language_model.rs,
 * crates/language_models/src/provider/open_ai_compatible.rs). ReasoningEffort is
 * none|minimal|low|medium|high|xhigh|max.
 *
 * Every number comes from the shared resolver: a hardcoded 200000/64000 once made
 * every model look like a 200k/64k text model.
 */
export const buildModelEntry = (modelId, spec) => {
  const caps = spec || specForCli(modelId);
  const contextWindow = Math.floor(Number(caps.contextWindow));
  const maxOutput = Math.floor(Number(caps.maxOutput));
  const levels = Array.isArray(caps.levels) ? caps.levels : [];
  // Zed has no "ultra" variant, so a level it cannot express is dropped rather
  // than renamed into a neighbouring one.
  const effort = levels
    .filter((level) => ZED_REASONING_EFFORTS.includes(level))
    .at(-1);
  const entry = {
    name: modelId,
    display_name: modelId,
    max_tokens: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
    max_output_tokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 16384,
    capabilities: {
      tools: caps.tools !== false,
      images: caps.vision === true,
      parallel_tool_calls: false,
      prompt_cache_key: false,
      chat_completions: true,
      interleaved_reasoning: false,
      max_tokens_parameter: false,
    },
  };
  // Only for reasoning models: writing an effort for a non-reasoning model would
  // make Zed request reasoning it does not support.
  if (caps.reasoning === true) {
    const defaultEffort = caps.defaultLevel && ZED_REASONING_EFFORTS.includes(caps.defaultLevel)
      ? caps.defaultLevel
      : effort;
    if (defaultEffort) entry.reasoning_effort = defaultEffort;
    if (typeof caps.interleavedReasoning === "boolean") {
      entry.capabilities.interleaved_reasoning = caps.interleavedReasoning;
    }
  }
  return entry;
};

/**
 * One Zed provider entry under language_models.openai_compatible.
 * `specs` is an optional id -> resolved-spec map; without it each model is
 * resolved from the shared resolver.
 */
export const buildProviderEntry = ({ baseUrl, models = [], specs = {} } = {}) => ({
  api_url: normalizeBaseUrl(baseUrl),
  available_models: [...models]
    .filter((m) => typeof m === "string" && m)
    .map((m) => buildModelEntry(m, isObject(specs[m]) ? specs[m] : undefined)),
});

/** The language_models section, or null when absent. */
export const readLanguageModels = (settings) => {
  const lm = settings?.language_models;
  return isObject(lm) ? lm : null;
};

/** The openai_compatible section, or null when absent. */
export const readOpenAiCompatible = (settings) => {
  const lm = readLanguageModels(settings);
  if (!lm || !isObject(lm.openai_compatible)) return null;
  return lm.openai_compatible;
};

/** The AFRouter provider entry, or null when Zed has none. */
export const readZedProvider = (settings) => {
  const oac = readOpenAiCompatible(settings);
  if (!oac) return null;
  return oac[ZED_PROVIDER_ID] || null;
};

/** Model names currently declared under the AFRouter provider. */
export const readZedModelIds = (settings) => {
  const provider = readZedProvider(settings);
  if (!provider || !Array.isArray(provider.available_models)) return [];
  return provider.available_models
    .filter((m) => isObject(m) && typeof m.name === "string" && m.name)
    .map((m) => m.name);
};

/**
 * Upsert the AFRouter provider into language_models.openai_compatible,
 * merging models additively by name. Every other provider and field is
 * preserved. A pre-existing entry keeps any field we do not own.
 */
export const upsertZedProvider = (settings, { baseUrl, models = [], specs = {} } = {}) => {
  const next = isObject(settings) ? settings : {};
  const lm = isObject(next.language_models) ? next.language_models : {};
  const oac = isObject(lm.openai_compatible) ? lm.openai_compatible : {};
  const previous = oac[ZED_PROVIDER_ID] || null;
  const built = buildProviderEntry({ baseUrl, models, specs });

  const existingModels = new Map();
  if (previous && Array.isArray(previous.available_models)) {
    for (const m of previous.available_models) {
      if (isObject(m) && typeof m.name === "string" && m.name) {
        existingModels.set(m.name, m);
      }
    }
  }
  for (const m of built.available_models) {
    existingModels.set(m.name, m);
  }

  const entry = {
    ...previous,
    api_url: built.api_url,
    available_models: [...existingModels.values()],
  };

  next.language_models = {
    ...lm,
    openai_compatible: { ...oac, [ZED_PROVIDER_ID]: entry },
  };
  return next;
};

/**
 * Remove the AFRouter provider from language_models.openai_compatible.
 * When `modelId` is provided, only that model is removed; the provider entry
 * survives with its remaining models. When the model list empties, the entry
 * is removed entirely.
 */
export const removeZedProvider = (settings, modelId = null) => {
  const next = isObject(settings) ? settings : {};
  const lm = isObject(next.language_models) ? next.language_models : {};
  if (!isObject(lm.openai_compatible)) {
    return { settings: next, removed: 0, entryRemoved: false };
  }

  const oac = { ...lm.openai_compatible };
  const previous = oac[ZED_PROVIDER_ID];
  if (!previous) {
    return { settings: next, removed: 0, entryRemoved: false };
  }

  const models = Array.isArray(previous.available_models) ? previous.available_models : [];

  if (!modelId) {
    const removed = models.length;
    delete oac[ZED_PROVIDER_ID];
    next.language_models = { ...lm, openai_compatible: oac };
    return { settings: next, removed, entryRemoved: true };
  }

  const before = models.length;
  const remaining = models.filter((m) => !(isObject(m) && m.name === modelId));
  const removed = before - remaining.length;

  if (remaining.length === 0) {
    delete oac[ZED_PROVIDER_ID];
    next.language_models = { ...lm, openai_compatible: oac };
    return { settings: next, removed, entryRemoved: true };
  }

  oac[ZED_PROVIDER_ID] = { ...previous, available_models: remaining };
  next.language_models = { ...lm, openai_compatible: oac };
  return { settings: next, removed, entryRemoved: false };
};

/** Two-space JSON with a trailing newline — what Zed's own files look like. */
export const stringifyJsonDocument = (value) => `${JSON.stringify(value, null, 2)}\n`;
