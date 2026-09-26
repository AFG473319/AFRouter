/**
 * Pi config shapes, shared by /api/cli-tools/pi-settings and the dashboard card
 * so the file we write and the Manual Config preview cannot drift.
 *
 * Pi (https://pi.dev, github.com/earendil-works/pi) keeps user-level config in
 * the *agent directory* — `~/.pi/agent` by default, `$PI_CODING_AGENT_DIR` when
 * set. Two documents matter here:
 *
 *   models.json    { "providers": { "<id>": { baseUrl, api, apiKey, models[] } } }
 *   settings.json  { defaultProvider, defaultModel, defaultThinkingLevel, ... }
 *
 * How Pi differs from the tools we already integrate:
 *
 *   aspect            OpenCode            ZCode              dsh                 Pi
 *   ---------------   -----------------   ----------------   ------------------   ---------------------
 *   format            JSON (v1/v2 shapes) JSON               YAML (2 files)     JSON (2 files)
 *   wire protocol     implied             implied            explicit `api:`     explicit `api:` (required)
 *   credential        inline in options   inline in options  ref in a 2nd file  inline `apiKey`, or
 *                                                                                `$ENV` / `!command`
 *   model metadata    name+limit+modal.   limit+modalities   id+ctx+max+input   id+name+ctx+max+input+
 *                                                                                reasoning (first-class)
 *   "make it default" n/a                 n/a                route picker       defaultProvider +
 *                                                                                defaultModel in settings
 *   reload            on session start     restart needed     hot (~1s)          /model reloads
 *                                                                                models.json, /reload
 *                                                                                for settings.json
 *
 * The three Pi-specific things we actually exploit:
 *   1. `api` must be declared — we always write `openai-completions`, which is
 *      the wire protocol of AFRouter's /v1/chat/completions.
 *   2. Model metadata is first-class, not cosmetic. `contextWindow` drives
 *      Pi's compaction threshold, `input` drives image encoding, `reasoning`
 *      drives the /thinking picker. So we resolve real specs instead of writing
 *      bare ids — that is the single biggest reason Pi is more than a JSON file.
 *   3. `settings.json` can pin the startup model, so AFRouter can become the
 *      default without touching anything else in that document.
 *
 * Deliberately NOT written, and why:
 *   - `promptCache`: declares a provider's cache lifetime so Pi can warm it.
 *     AFRouter does not publish one per routed model, and a wrong value makes Pi
 *     keep replaying a cold cache. Omitted (the docs' default = never warmed).
 *   - `authHeader`: Pi's OpenAI-compatible client already sends
 *     `Authorization: Bearer <apiKey>`; the flag exists for APIs that do *not*
 *     handle auth themselves, and setting it can double the header.
 *   - `samplingParams` / `compat`: merged verbatim into every request body and
 *     used for verified endpoint quirks. AFRouter is a faithful OpenAI surface,
 *     so the defaults are correct and the user keeps control of temperature.
 *   - `thinkingLevelMap`: omitted = Pi's default map (off..high), the widest
 *     set every routed provider understands. Declaring it would only *narrow*
 *     the /thinking picker.
 *   - `modelOverrides`: only meaningful against a provider's built-in catalog.
 *     The `afrouter` provider is entirely ours, so `models` is the whole story.
 *
 * Pure module (no Node builtins) so the client-side card can import it too.
 */

export const PI_PROVIDER_ID = "afrouter";

// Pi resolves the agent dir from $PI_CODING_AGENT_DIR, else ~/.pi/agent.
export const PI_AGENT_DIR_SUFFIX = ["pi", "agent"];
export const PI_MODELS_FILE = "models.json";
export const PI_SETTINGS_FILE = "settings.json";

export const PI_API = "openai-completions";
export const PI_DEFAULT_API_KEY = "sk_afrouter";

// Conservative fallback for ids resolvable from neither the live catalog nor the
// static registry — flagged "unverified", never invented.
export const FALLBACK_SPEC = Object.freeze({
  contextWindow: 200000,
  maxTokens: 32000,
  vision: false,
  pdf: false,
  audioInput: false,
  videoInput: false,
  reasoning: false,
  tools: true,
});

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Pi talks to /v1/chat/completions; the gateway card supplies the bare origin. */
export const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

/**
 * One Pi model entry. `input` is explicit even for text-only models so the file
 * is self-describing; `reasoning` is omitted when false because that is Pi's
 * documented default and a bare `false` reads as "verified non-reasoning".
 */
export const buildModelEntry = (id, caps = {}) => {
  const entry = {
    id,
    contextWindow: Math.floor(caps.contextWindow ?? FALLBACK_SPEC.contextWindow),
    maxTokens: Math.floor(caps.maxTokens ?? FALLBACK_SPEC.maxTokens),
    input: ["text"],
  };
  if (caps.vision) entry.input.push("image");
  if (caps.pdf) entry.input.push("pdf");
  if (caps.audioInput) entry.input.push("audio");
  if (caps.videoInput) entry.input.push("video");
  if (caps.reasoning === true) entry.reasoning = true;
  return entry;
};

/** The AFRouter provider entry Pi loads as one OpenAI-compatible provider. */
export const buildProviderEntry = ({ baseUrl, apiKey, models = [], specs = {} } = {}) => ({
  baseUrl: normalizeBaseUrl(baseUrl),
  api: PI_API,
  apiKey: apiKey || PI_DEFAULT_API_KEY,
  models: models.map((id) => buildModelEntry(id, specs[id] || {})),
});

/** The `afrouter` provider entry, or null when Pi has none. */
export const readPiProvider = (models) => {
  const entry = models?.providers?.[PI_PROVIDER_ID];
  return isObject(entry) ? entry : null;
};

/** Model ids currently declared under the AFRouter provider. */
export const readPiModelIds = (models) => {
  const list = readPiProvider(models)?.models;
  return Array.isArray(list) ? list.filter((m) => m && typeof m === "object" && m.id).map((m) => m.id) : [];
};

/**
 * Upsert `providers.afrouter` in models.json, merging models additively by id.
 * Every other provider and field is preserved. A pre-existing entry keeps any
 * field we do not own (custom `headers`, a hand-added `modelOverrides`, …) so a
 * user's own tuning survives a re-Apply.
 */
export const upsertPiProvider = (models, { baseUrl, apiKey, models: ids = [], specs = {} } = {}) => {
  const next = isObject(models) ? models : {};
  const providers = isObject(next.providers) ? next.providers : {};
  const previous = isObject(providers[PI_PROVIDER_ID]) ? providers[PI_PROVIDER_ID] : {};
  const built = buildProviderEntry({ baseUrl, apiKey, models: ids, specs });

  const byId = new Map();
  for (const model of Array.isArray(previous.models) ? previous.models : []) {
    if (model && typeof model === "object" && model.id) byId.set(model.id, model);
  }
  for (const model of built.models) byId.set(model.id, model);

  providers[PI_PROVIDER_ID] = {
    ...previous,
    baseUrl: built.baseUrl,
    api: built.api,
    // An empty key falls back to Pi's `sk_afrouter` local default, which is what
    // a fresh install expects; a real key the user chose is always written.
    ...(built.apiKey ? { apiKey: built.apiKey } : {}),
    models: [...byId.values()],
  };
  next.providers = providers;
  return next;
};

/**
 * Remove one model from the provider, or the whole provider when `modelId` is
 * falsy. `providers` is dropped entirely when it empties so a reset leaves Pi's
 * file as it was found.
 */
export const removePiProvider = (models, modelId = null) => {
  const next = isObject(models) ? models : {};
  const providers = next.providers;
  if (!isObject(providers) || !isObject(providers[PI_PROVIDER_ID])) {
    return { models: next, removed: 0, entryRemoved: false };
  }
  const dropEntry = () => {
    delete providers[PI_PROVIDER_ID];
    if (Object.keys(providers).length === 0) delete next.providers;
  };

  if (!modelId) {
    const before = Array.isArray(providers[PI_PROVIDER_ID].models)
      ? providers[PI_PROVIDER_ID].models.length
      : 0;
    dropEntry();
    return { models: next, removed: before, entryRemoved: true };
  }

  const list = Array.isArray(providers[PI_PROVIDER_ID].models) ? providers[PI_PROVIDER_ID].models : [];
  const before = list.length;
  providers[PI_PROVIDER_ID].models = list.filter((m) => m?.id !== modelId);
  const removed = before - providers[PI_PROVIDER_ID].models.length;
  if (providers[PI_PROVIDER_ID].models.length === 0) {
    dropEntry();
    return { models: next, removed, entryRemoved: true };
  }
  return { models: next, removed, entryRemoved: false };
};

// ─── settings.json — the startup model ──────────────────────────────────────

/**
 * What Pi would start on, and whether that is us. `defaultProvider` and
 * `defaultModel` are separate keys; only the pair pointing at `afrouter`
 * belongs to this integration.
 */
export const readPiDefaults = (settings) => ({
  provider: typeof settings?.defaultProvider === "string" ? settings.defaultProvider : null,
  model: typeof settings?.defaultModel === "string" ? settings.defaultModel : null,
  isAFRouter: settings?.defaultProvider === PI_PROVIDER_ID,
});

/**
 * Pin the AFRouter provider (and optionally its default model) as Pi's startup
 * selection. `modelId` null/"" pins the provider only, leaving the model to Pi's
 * own picker. Every other setting is preserved.
 */
export const upsertPiDefaults = (settings, { modelId = null, setDefault = true, providerModelIds = [] } = {}) => {
  const next = isObject(settings) ? settings : {};
  if (!setDefault) return clearPiDefaults(next, { providerModelIds });
  next.defaultProvider = PI_PROVIDER_ID;
  if (modelId) next.defaultModel = modelId;
  return next;
};

/**
 * Clear our startup pin. Both keys are only touched while they still point at
 * AFRouter, so a Reset can never delete a `defaultProvider`/`defaultModel` the
 * user repointed at something else. `providerModelIds` is the AFRouter model
 * list as it stood *before* the removal, which is how we know a leftover
 * `defaultModel` was ours.
 */
export const clearPiDefaults = (settings, { providerModelIds = [] } = {}) => {
  const next = isObject(settings) ? settings : {};
  if (next.defaultProvider === PI_PROVIDER_ID) delete next.defaultProvider;
  if (typeof next.defaultModel === "string" && providerModelIds.includes(next.defaultModel)) {
    delete next.defaultModel;
  }
  return next;
};

/** Two-space JSON with a trailing newline — what Pi's own files look like. */
export const stringifyJsonDocument = (value) => `${JSON.stringify(value, null, 2)}\n`;
