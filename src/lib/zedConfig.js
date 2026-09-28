/**
 * Zed config shapes, shared by /api/cli-tools/zed-settings and the dashboard
 * card so the file we write and the Manual Config preview cannot drift.
 *
 * Zed (https://zed.dev) keeps user settings in a single JSON document:
 *
 *   Linux   ~/.config/zed/settings.json
 *   macOS   ~/Library/Application Support/Zed/settings.json
 *   Windows %APPDATA%\Zed\settings.json
 *
 * AI configuration lives under the `ai` key:
 *
 *   {
 *     "ai": {
 *       "provider": "custom",
 *       "custom_providers": [
 *         {
 *           "name": "AFRouter",
 *           "url": "http://localhost:20128/v1",
 *           "models": ["anthropic/claude-sonnet-4-5", "openai/gpt-4o"],
 *           "headers": { "Authorization": "Bearer sk_afrouter" }
 *         }
 *       ]
 *     }
 *   }
 *
 * How Zed differs from the other tools we integrate:
 *
 *   aspect            OpenCode       ZCode          Pi             Zed
 *   ---------------   -------------  -------------  -------------  -------------
 *   format            JSON (v1/v2)   JSON           JSON (2 files)  JSON (1 file)
 *   wire protocol     implied        implied        explicit `api`  implied (custom)
 *   credential        inline options inline options inline apiKey  headers.Authorization
 *   model metadata    name+limit     limit+modal.   full spec      none (strings only)
 *   "make it default" model field    n/a            settings.json   ai.provider="custom"
 *   reload            session start  restart        /model,/reload  restart/reload
 *
 * Zed's model entries are plain strings — no per-model metadata. The provider
 * entry carries the base URL, model list, and auth headers. Setting
 * `ai.provider` to `"custom"` makes Zed show the custom providers in its AI
 * panel; the user picks the AFRouter provider from the dropdown.
 *
 * Pure module (no Node builtins) so the client-side card can import it too.
 */

export const ZED_PROVIDER_NAME = "AFRouter";

// Zed resolves the settings path per-platform.
export const ZED_SETTINGS_FILE = "settings.json";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Zed talks to /v1/chat/completions; the gateway card supplies the bare origin. */
export const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed.replace(/\/+\/v1$/, "/v1") : `${trimmed}/v1`;
};

/**
 * One Zed custom provider entry. `models` is a plain string array — Zed has
 * no per-model metadata. Auth goes in `headers.Authorization` as a Bearer
 * token, which is how Zed sends it upstream.
 */
export const buildProviderEntry = ({ baseUrl, apiKey, models = [] } = {}) => ({
  name: ZED_PROVIDER_NAME,
  url: normalizeBaseUrl(baseUrl),
  models: [...models].filter((m) => typeof m === "string" && m),
  headers: {
    Authorization: `Bearer ${apiKey || "sk_afrouter"}`,
  },
});

/** The `ai` section of Zed's settings, or null when absent. */
export const readAiSection = (settings) => {
  const ai = settings?.ai;
  return isObject(ai) ? ai : null;
};

/** The AFRouter custom provider entry, or null when Zed has none. */
export const readZedProvider = (settings) => {
  const ai = readAiSection(settings);
  if (!ai || !Array.isArray(ai.custom_providers)) return null;
  return (
    ai.custom_providers.find(
      (p) => isObject(p) && p.name === ZED_PROVIDER_NAME,
    ) || null
  );
};

/** Model names currently declared under the AFRouter provider. */
export const readZedModelIds = (settings) => {
  const provider = readZedProvider(settings);
  if (!provider || !Array.isArray(provider.models)) return [];
  return provider.models.filter((m) => typeof m === "string" && m);
};

/**
 * Upsert the AFRouter custom provider into the `ai` section, merging models
 * additively by name. Every other provider and field is preserved. A
 * pre-existing entry keeps any field we do not own (custom `headers`, a
 * hand-added `api_key`, …) so a user's own tuning survives a re-Apply.
 */
export const upsertZedProvider = (settings, { baseUrl, apiKey, models = [] } = {}) => {
  const next = isObject(settings) ? settings : {};
  const ai = isObject(next.ai) ? next.ai : {};
  const providers = Array.isArray(ai.custom_providers) ? ai.custom_providers : [];
  const previous = providers.find((p) => isObject(p) && p.name === ZED_PROVIDER_NAME) || null;
  const built = buildProviderEntry({ baseUrl, apiKey, models });

  const existingModels = new Set(
    previous && Array.isArray(previous.models)
      ? previous.models.filter((m) => typeof m === "string" && m)
      : [],
  );
  for (const m of built.models) existingModels.add(m);

  const entry = {
    ...previous,
    name: built.name,
    url: built.url,
    models: [...existingModels],
    headers: { ...(isObject(previous?.headers) ? previous.headers : {}), ...built.headers },
  };

  const idx = providers.findIndex((p) => isObject(p) && p.name === ZED_PROVIDER_NAME);
  if (idx >= 0) {
    providers[idx] = entry;
  } else {
    providers.push(entry);
  }

  next.ai = { ...ai, provider: "custom", custom_providers: providers };
  return next;
};

/**
 * Remove the AFRouter provider from the `ai` section. When `modelId` is
 * provided, only that model is removed; the provider entry survives with its
 * remaining models. When the provider's model list empties, the entry is
 * removed entirely. `ai.provider` is reset to `"anthropic"` (Zed's default)
 * when no custom providers remain.
 */
export const removeZedProvider = (settings, modelId = null) => {
  const next = isObject(settings) ? settings : {};
  const ai = isObject(next.ai) ? next.ai : {};
  if (!Array.isArray(ai.custom_providers)) {
    return { settings: next, removed: 0, entryRemoved: false };
  }

  const providers = [...ai.custom_providers];
  const idx = providers.findIndex((p) => isObject(p) && p.name === ZED_PROVIDER_NAME);
  if (idx < 0) {
    return { settings: next, removed: 0, entryRemoved: false };
  }

  const entry = providers[idx];
  const models = Array.isArray(entry.models) ? entry.models : [];

  if (!modelId) {
    const removed = models.length;
    providers.splice(idx, 1);
    const remaining = providers.filter((p) => isObject(p));
    next.ai = { ...ai, custom_providers: remaining };
    if (remaining.length === 0) {
      next.ai.provider = "anthropic";
    }
    return { settings: next, removed, entryRemoved: true };
  }

  const before = models.length;
  entry.models = models.filter((m) => m !== modelId);
  const removed = before - entry.models.length;

  if (entry.models.length === 0) {
    providers.splice(idx, 1);
    const remaining = providers.filter((p) => isObject(p));
    next.ai = { ...ai, custom_providers: remaining };
    if (remaining.length === 0) {
      next.ai.provider = "anthropic";
    }
    return { settings: next, removed, entryRemoved: true };
  }

  next.ai = { ...ai, custom_providers: providers };
  return { settings: next, removed, entryRemoved: false };
};

/** Two-space JSON with a trailing newline — what Zed's own files look like. */
export const stringifyJsonDocument = (value) => `${JSON.stringify(value, null, 2)}\n`;
