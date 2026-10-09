/**
 * Hermes Agent (Nous Research) config shapes, shared by
 * /api/cli-tools/hermes-settings and the dashboard card so the YAML we write
 * and the Manual Config preview cannot drift.
 *
 * Docs (verified while writing this module — every field below is cited):
 *   https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models
 *   https://hermes-agent.nousresearch.com/docs/integrations/providers
 *   https://hermes-agent.nousresearch.com/docs/user-guide/configuration
 *   hermes_cli/config_defaults.py (the canonical DEFAULT_CONFIG)
 *
 * What Hermes actually supports, and why this module looks the way it does:
 *
 *  1. ONE named provider serves MANY models. `providers:` is a dict of named
 *     custom endpoints; each entry carries the endpoint, the credential and a
 *     `models:` mapping of model id -> per-model metadata. Slots then point at
 *     it by reference — `provider: custom:<name>` — instead of re-declaring a
 *     base_url per slot. A single anonymous `provider: custom` with an inline
 *     `base_url` (what we used to write) is one endpoint with ONE model, which
 *     is exactly the limitation this module removes.
 *       providers:
 *         afrouter: { api: …/v1, key_env: …, models: { <id>: {…}, … } }
 *       model:
 *         default: cc/claude-sonnet-4-5
 *         provider: custom:afrouter
 *
 *  2. `models:` may be a list of ids or a mapping. The mapping is required for
 *     per-model metadata, so that is what we write. Per-model keys documented
 *     for `providers.<name>.models.<id>`: `context_length`, `supports_vision`,
 *     `prompt_caching`, `answer_in_reasoning`.
 *
 *  3. `max_output_tokens` is legacy and NO LONGER READ ("Hermes no longer reads
 *     model.max_tokens, HERMES_MAX_TOKENS, provider output-cap settings, or
 *     model_overrides.*.*.max_output_tokens. Remove these legacy settings.").
 *     We therefore do not write it — an output cap that Hermes ignores is worse
 *     than none, because it looks authoritative in the file.
 *
 *  4. `discover_models: false` makes Hermes use only the `models` we declare
 *     instead of probing the endpoint's /models. That is what turns the applied
 *     list into the picker's list, and it keeps `hermes model` / `/model`
 *     usable while the gateway is down.
 *
 *  5. `auxiliary.<task>` slots are a CLOSED, code-defined set — the ids come
 *     from hermes_cli/config_defaults.py. `auxiliary.web_extract` and
 *     `auxiliary.session_search` are dead ("no longer use an aux LLM; leftover
 *     blocks in user config are ignored"), so Hermes_AUX_TASKS deliberately
 *     omits them: writing them would look configured and do nothing.
 *
 *  6. `delegation:` is top-level, NOT under `auxiliary:` — its own block with
 *     model/provider/base_url/api_key/api_mode plus subagent tuning.
 *
 *  7. Hermes has no per-model reasoning LADDER field. The only per-model
 *     reasoning knob is `agent.reasoning_overrides` (model id -> one effort).
 *     We do not write it: the documented default when no effort is configured
 *     is `reasoning_effort: medium` on the chat_completions transport, which is
 *     sane, whereas our resolver's `defaultLevel` is the *strongest* declared
 *     level — writing that would silently triple reasoning-token cost on every
 *     model. Costs and cache lifetimes are absent for the same reason OMP omits
 *     them: a gateway publishes no per-model tariff.
 *
 * Pure module (no Node builtins, no confbox) so the client-side card can import
 * it too; YAML parsing/serialization lives in the route and the card.
 */

export const HERMES_CONFIG_DIR_SEGMENTS = [".hermes"];
export const HERMES_CONFIG_FILE = "config.yaml";
export const HERMES_ENV_FILE = ".env";

/**
 * Named provider key under `providers:`. Must be a bare YAML-safe token because
 * slots reference it as `provider: custom:<id>`.
 */
export const HERMES_PROVIDER_ID = "afrouter";
/** How every slot points at our provider entry. */
export const HERMES_PROVIDER_REF = `custom:${HERMES_PROVIDER_ID}`;
/** Display name Hermes shows in the picker (defaults to the dict key). */
export const HERMES_PROVIDER_NAME = "AFRouter";

/**
 * AFRouter is an OpenAI-compatible gateway, so declare the wire explicitly.
 * `transport` is the `providers:`-dict spelling; the legacy `custom_providers:`
 * list called it `api_mode`. Both accept chat_completions | anthropic_messages
 * | codex_responses. Empty means auto-detect, and a wrong guess would
 * mistranslate every request.
 */
export const HERMES_TRANSPORT = "chat_completions";

/**
 * `.env` variable the entry resolves its key from. Keeping the key out of
 * config.yaml means the file stays shareable; Hermes' own docs put API keys in
 * ~/.hermes/.env and name them with `key_env`.
 */
export const HERMES_API_KEY_ENV = "AFROUTER_API_KEY";
export const HERMES_FALLBACK_API_KEY = "sk_afrouter";

/**
 * Conservative fallback for ids resolvable from neither the live catalog nor the
 * static registry — flagged "unverified", never invented. 128k is a widely
 * supported floor and `context_length` is an explicit pin in Hermes, so a model
 * is never over-declared.
 */
export const HERMES_FALLBACK_SPEC = Object.freeze({
  contextWindow: 128000,
  maxOutput: 16384,
  vision: false,
  reasoning: false,
});

/**
 * Every auxiliary task slot Hermes defines, in docs order. Sourced from
 * hermes_cli/config_defaults.py DEFAULT_CONFIG["auxiliary"]; `delegation` is
 * excluded here because it is a top-level block, not an auxiliary task.
 */
export const HERMES_AUX_TASKS = [
  { id: "vision", label: "Vision" },
  { id: "compression", label: "Compression" },
  { id: "skills_hub", label: "Skills Hub" },
  { id: "approval", label: "Approval" },
  { id: "review", label: "Review Reviewer" },
  { id: "mcp", label: "MCP" },
  { id: "title_generation", label: "Title Generation" },
  { id: "memory_query_rewrite", label: "Memory Query Rewrite" },
  { id: "tts_audio_tags", label: "TTS Audio Tags" },
  { id: "triage_specifier", label: "Triage Specifier" },
  { id: "kanban_decomposer", label: "Kanban Decomposer" },
  { id: "profile_describer", label: "Profile Describer" },
  { id: "goal_judge", label: "Goal Judge" },
  { id: "curator", label: "Curator" },
  { id: "monitor", label: "Monitor" },
  { id: "background_review", label: "Background Review" },
  { id: "moa_reference", label: "MoA Reference" },
  { id: "moa_aggregator", label: "MoA Aggregator" },
];

/** Slots that are NOT model slots, listed so a caller can tell them apart. */
export const HERMES_DELEGATION_SLOT = "delegation";

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Hermes wants the endpoint root that already ends in /v1. A `/v1` already on
 * the URL is left alone rather than doubled.
 */
export const normalizeHermesBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

/**
 * One model's metadata under `providers.<name>.models.<id>`.
 *
 * Only documented keys are written, and only when we actually resolved them:
 *   - context_length  -> resolved context window (an explicit Hermes pin)
 *   - supports_vision -> true, when the model takes images; omitted otherwise
 *                         (absent means "let Hermes detect")
 *
 * Accepts either the resolved-spec shape (`maxOutput`) or a raw capability row
 * (`maxTokens`), so the route and the card can share it.
 */
export const buildHermesModelEntry = (spec = {}) => {
  const contextWindow = Math.floor(Number(spec.contextWindow));
  const entry = {
    context_length: Number.isFinite(contextWindow) && contextWindow > 0
      ? contextWindow
      : HERMES_FALLBACK_SPEC.contextWindow,
  };
  if (spec.vision === true) entry.supports_vision = true;
  return entry;
};

/**
 * The whole `providers.afrouter` entry. `models` is a mapping so every applied
 * model keeps its own metadata; `discover_models: false` makes that mapping the
 * picker's catalog.
 */
export const buildHermesProviderEntry = ({ baseUrl, keyEnv, models = [], specs = {} } = {}) => {
  const entry = {
    name: HERMES_PROVIDER_NAME,
    api: normalizeHermesBaseUrl(baseUrl),
    transport: HERMES_TRANSPORT,
  };
  if (keyEnv) entry.key_env = keyEnv;
  entry.discover_models = false;
  entry.models = {};
  for (const id of models) {
    if (typeof id !== "string" || !id) continue;
    entry.models[id] = buildHermesModelEntry(isObject(specs[id]) ? specs[id] : {});
  }
  return entry;
};

/** The `afrouter` provider entry of a parsed config.yaml, or null. */
export const readHermesProvider = (doc) => {
  const entry = doc?.providers?.[HERMES_PROVIDER_ID];
  return isObject(entry) ? entry : null;
};

/**
 * Model ids declared under our provider. `models` accepts a mapping or a list,
 * so both are read.
 */
export const readHermesModelIds = (doc) => {
  const models = readHermesProvider(doc)?.models;
  if (Array.isArray(models)) return models.filter((m) => typeof m === "string" && m);
  if (isObject(models)) return Object.keys(models);
  return [];
};

/**
 * Upsert `providers.afrouter`, merging models additively by id. Every other
 * provider and field is preserved — a hand-added entry under `providers:` is
 * never claimed, and a field we do not own on our own entry (a user-added
 * `extra_headers`, `capabilities`, …) survives a re-Apply.
 */
export const upsertHermesProvider = (doc, { baseUrl, keyEnv, models = [], specs = {} } = {}) => {
  const next = isObject(doc) ? doc : {};
  const providers = isObject(next.providers) ? next.providers : {};
  const previous = isObject(providers[HERMES_PROVIDER_ID]) ? providers[HERMES_PROVIDER_ID] : {};
  const built = buildHermesProviderEntry({ baseUrl, keyEnv, models, specs });

  // Merge by id: keep ids the user added by hand, refresh the ones we own.
  const merged = {};
  const previousModels = previous.models;
  if (isObject(previousModels)) Object.assign(merged, previousModels);
  else if (Array.isArray(previousModels)) {
    for (const id of previousModels) if (typeof id === "string" && id) merged[id] = {};
  }
  for (const id of Object.keys(built.models)) merged[id] = built.models[id];

  providers[HERMES_PROVIDER_ID] = {
    ...previous,
    name: HERMES_PROVIDER_NAME,
    api: built.api,
    transport: HERMES_TRANSPORT,
    ...(keyEnv ? { key_env: keyEnv } : {}),
    discover_models: false,
    models: merged,
  };
  if (!keyEnv) delete providers[HERMES_PROVIDER_ID].key_env;
  next.providers = providers;
  return next;
};

/**
 * Remove one model, or the whole provider when `modelId` is falsy. `providers`
 * is dropped entirely when it empties so a Reset leaves the file as found.
 */
export const removeHermesProvider = (doc, modelId = null) => {
  const next = isObject(doc) ? doc : {};
  const providers = next.providers;
  if (!isObject(providers) || !isObject(providers[HERMES_PROVIDER_ID])) {
    return { doc: next, removed: 0, entryRemoved: false };
  }
  const dropEntry = () => {
    delete providers[HERMES_PROVIDER_ID];
    if (Object.keys(providers).length === 0) delete next.providers;
  };

  if (!modelId) {
    const models = providers[HERMES_PROVIDER_ID].models;
    const before = isObject(models) ? Object.keys(models).length : 0;
    dropEntry();
    return { doc: next, removed: before, entryRemoved: true };
  }

  const models = providers[HERMES_PROVIDER_ID].models;
  const before = isObject(models) ? Object.keys(models).length : Array.isArray(models) ? models.length : 0;
  if (isObject(models)) {
    if (!(modelId in models)) return { doc: next, removed: 0, entryRemoved: false };
    delete models[modelId];
    if (Object.keys(models).length === 0) {
      dropEntry();
      return { doc: next, removed: 1, entryRemoved: true };
    }
  } else if (Array.isArray(models)) {
    if (!models.includes(modelId)) return { doc: next, removed: 0, entryRemoved: false };
    providers[HERMES_PROVIDER_ID].models = models.filter((m) => m !== modelId);
    if (providers[HERMES_PROVIDER_ID].models.length === 0) {
      dropEntry();
      return { doc: next, removed: 1, entryRemoved: true };
    }
  }
  return { doc: next, removed: 1, entryRemoved: false };
};

/**
 * True when a slot block belongs to us, i.e. it points at our named provider.
 * Slots written by older AFRouter builds carry `provider: custom` with one of
 * our base_urls inline, so those are matched too and get upgraded on Apply.
 */
export const isOurSlot = (slot, baseUrl) => {
  if (!isObject(slot)) return false;
  if (slot.provider === HERMES_PROVIDER_REF) return true;
  if (slot.provider !== "custom") return false;
  const url = String(slot.base_url || "");
  if (!url) return false;
  return baseUrl ? url === baseUrl : /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(url);
};

/** Strip every reference to our provider out of one slot block. */
export const clearSlotReference = (slot) => {
  if (!isObject(slot)) return slot;
  const next = { ...slot };
  delete next.provider;
  delete next.model;
  delete next.default;
  delete next.base_url;
  delete next.api_key;
  delete next.api_mode;
  return next;
};

/** Build a slot block that points at our named provider. */
export const buildHermesSlot = (model) => ({
  provider: HERMES_PROVIDER_REF,
  model: String(model),
});

/** Build the main-model block. `default:` holds the id (Hermes also accepts `model:`). */
export const buildHermesMainBlock = (model) => ({
  default: String(model),
  provider: HERMES_PROVIDER_REF,
});
