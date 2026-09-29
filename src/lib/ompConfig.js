/**
 * Oh My Pi (omp) config shapes, shared by /api/cli-tools/omp-settings and the
 * dashboard card so the file we write and the Manual Config preview cannot drift.
 *
 * Oh My Pi (https://omp.sh, github.com/can1357/oh-my-pi) is a fork of Pi with
 * the same agent-directory layout, but two things changed that matter here:
 *
 *   models.json  ->  models.yml     YAML, not JSON
 *   settings.json ->  config.yml     same file Pi used for shellPath/theme
 *
 * Both live under the *agent directory* — `~/.omp/agent` by default,
 * `$PI_CODING_AGENT_DIR` when set. `omp config path` prints the active one.
 *
 *   models.yml   { providers: { "<id>": { baseUrl, apiKey, api, models[] } } }
 *   config.yml   { modelRoles: { default: "<provider>/<id>[:level]", ... }, … }
 *
 * How OMP differs from the tools we already integrate:
 *
 *   aspect            OpenCode         ZCode              dsh                 Pi                 Oh My Pi
 *   ---------------   --------------   ----------------   ------------------   -----------------   -----------------
 *   format            JSON (v1/v2)     JSON               YAML (2 files)      JSON (2 files)     YAML (2 files)
 *   wire protocol     implied           implied            explicit `api:`     explicit `api:`    explicit `api:`
 *   credential        inline in options inline in options  ref in a 2nd file   inline `apiKey`    inline `apiKey` (env-name-or-literal)
 *   model metadata    name+limit        limit+modalities    id+ctx+max+input     id+name+ctx+max+   id+name+ctx+max+
 *                                                                                input+reasoning    input+reasoning
 *   "make it default" n/a               n/a                route picker         defaultProvider +   `modelRoles.default`
 *                                                                                defaultModel       (a selector, per role)
 *   reload            on session start  restart needed     hot (~1s)           /model             `omp config set` /
 *                                                                                                                       next launch
 *
 * The four OMP-specific things we exploit, each verified against omp 18.4.3:
 *
 *   1. `modelRoles` is a *record* of workload selectors, not a single
 *      default pair. OMP resolves `@default` for the chat model and offers
 *      `smol`/`slow`/`plan`/`vision`/… for everything else, so "start on
 *      AFRouter" is one key rather than two.
 *
 *   2. Selectors split on the FIRST `/` (`parseModelString` uses `indexOf`),
 *      so an AFRouter model id that itself contains slashes — our ids are
 *      `kilo/stealth/space-bunny-alpha`, `cc/claude-sonnet-4-5` — round-trips
 *      intact as `afrouter/kilo/stealth/space-bunny-alpha`. Verified on the
 *      wire: the gateway received `"model": "kilo/stealth/space-bunny-alpha"`.
 *
 *   3. A trailing `:<thinking-level>` is split off with `lastIndexOf(":")`,
 *      which is safe for those ids because they contain no colon. Levels are
 *      `off|minimal|low|medium|high|xhigh|max`; omitting one lets the model
 *      keep whatever effort the session is already on.
 *
 *   4. Auth needs no `authHeader: true`. `resolveOpenAIRequestSetup` sets
 *      `headers.Authorization ??= \`Bearer ${apiKey}\`` for every
 *      openai-completions request, so declaring `apiKey` is sufficient. That
 *      flag only re-derives the header for *discovered* models whose rows are
 *      cached without headers, which does not apply to models we declare.
 *
 * Deliberately NOT written, and why:
 *   - `cost`: a custom model with no `cost` shows a local $0 estimate in OMP's
 *     status line. Writing invented per-token prices would be worse than $0,
 *     and AFRouter does not publish a stable tariff per routed model.
 *   - `promptCache`: declares a provider's cache lifetime so OMP can warm it.
 *     AFRouter publishes none per routed model, and a wrong value makes OMP
 *     keep replaying a cold cache. Omitted (never warmed) is the safe default.
 *   - `authHeader` / `transport: pi-native`: the first is redundant (see 4),
 *     the second targets an `omp auth-gateway`, not a plain OpenAI gateway.
 *   - `compat` / `modelOverrides` / `discovery`: AFRouter is a faithful
 *     OpenAI surface, so URL-based auto-detection already picks the right
 *     request shaping, and the `afrouter` provider block is entirely ours so
 *     there is no built-in catalog for overrides to patch.
 *   - `thinking`: requires an explicit `efforts` list, and declaring one would
 *     *narrow* the picker. Leaving it unset gives every level the model
 *     supports, which is the widest correct set.
 *   - `enabledModels` / `disabledProviders`: global filters the user may have
 *     set deliberately. Narrowing them would fight the user's own config.
 *
 * Pure module (no Node builtins, no confbox) so the client-side card can
 * import it too; YAML parsing/serialization lives in the route.
 */

export const OMP_PROVIDER_ID = "afrouter";

// OMP resolves the agent dir from $PI_CODING_AGENT_DIR, else ~/.omp/agent.
export const OMP_AGENT_DIR_SEGMENTS = ["omp", "agent"];
export const OMP_MODELS_FILE = "models.yml";
export const OMP_CONFIG_FILE = "config.yml";

export const OMP_API = "openai-completions";
export const OMP_DEFAULT_API_KEY = "sk_afrouter";

// The role that decides which model a plain `omp` launch starts on. Every other
// role (smol/slow/plan/vision/…) is the user's own routing choice, so we only
// ever touch this one key.
export const OMP_DEFAULT_ROLE = "default";

// Thinking suffixes OMP's `splitThinkingSuffix` understands. Kept as a set so
// a role value we wrote can be told apart from one the user typed.
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

// Conservative fallback for ids resolvable from neither the live catalog nor
// the static registry — flagged "unverified", never invented. 128k/16k text-only
// is a widely-supported floor, so a model is never over-declared.
export const FALLBACK_SPEC = Object.freeze({
  contextWindow: 128000,
  maxTokens: 16384,
  vision: false,
  reasoning: false,
});

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * OMP talks to /v1/chat/completions; the gateway card supplies the bare origin.
 * A `/v1` already on the URL is left alone rather than doubled.
 */
export const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
};

/**
 * Sanitize input modalities so only OMP's documented ("text" | "image")[] are
 * written. The schema is a closed union, so a foreign value (video, audio, pdf)
 * fails validation for the whole models.yml and OMP drops every custom model.
 */
export const sanitizeModelInput = (input) => {
  if (!Array.isArray(input)) return ["text"];
  const sanitized = input.filter((item) => item === "text" || item === "image");
  if (!sanitized.includes("text")) sanitized.unshift("text");
  return sanitized;
};

/**
 * One OMP model entry. `input` is explicit even for text-only models so the
 * file is self-describing; `reasoning` is omitted when false because that is
 * OMP's default and a bare `false` reads as "verified non-reasoning".
 *
 * `contextWindow` drives OMP's local context budget (compaction threshold),
 * and `maxTokens` its default max-output, so both are resolved from real specs
 * rather than guessed.
 */
export const buildModelEntry = (id, caps = {}) => {
  const entry = {
    id,
    contextWindow: Math.floor(caps.contextWindow ?? FALLBACK_SPEC.contextWindow),
    maxTokens: Math.floor(caps.maxTokens ?? FALLBACK_SPEC.maxTokens),
    input: ["text"],
  };
  if (caps.name && typeof caps.name === "string" && caps.name !== id) {
    entry.name = caps.name;
  }
  if (caps.vision) entry.input.push("image");
  if (caps.reasoning === true) entry.reasoning = true;
  return entry;
};

/** The AFRouter provider entry OMP loads as one OpenAI-compatible provider. */
export const buildProviderEntry = ({ baseUrl, apiKey, models = [], specs = {} } = {}) => ({
  baseUrl: normalizeBaseUrl(baseUrl),
  apiKey: apiKey || OMP_DEFAULT_API_KEY,
  api: OMP_API,
  models: models.map((id) => buildModelEntry(id, specs[id] || {})),
});

/** The `afrouter` provider entry, or null when OMP has none. */
export const readOmpProvider = (models) => {
  const entry = models?.providers?.[OMP_PROVIDER_ID];
  return isObject(entry) ? entry : null;
};

/** Model ids currently declared under the AFRouter provider. */
export const readOmpModelIds = (models) => {
  const list = readOmpProvider(models)?.models;
  return Array.isArray(list) ? list.filter((m) => m && typeof m === "object" && m.id).map((m) => m.id) : [];
};

/**
 * Upsert `providers.afrouter` in models.yml, merging models additively by id.
 * Every other provider and field is preserved. A pre-existing entry keeps any
 * field we do not own (custom `headers`, a hand-added `modelOverride`, …) so a
 * user's own tuning survives a re-Apply, and its modalities are sanitized so a
 * hand-typed `video` cannot fail the schema and take our models down with it.
 */
export const upsertOmpProvider = (models, { baseUrl, apiKey, models: ids = [], specs = {} } = {}) => {
  const next = isObject(models) ? models : {};
  const providers = isObject(next.providers) ? next.providers : {};
  const previous = isObject(providers[OMP_PROVIDER_ID]) ? providers[OMP_PROVIDER_ID] : {};
  const built = buildProviderEntry({ baseUrl, apiKey, models: ids, specs });

  const byId = new Map();
  for (const model of Array.isArray(previous.models) ? previous.models : []) {
    if (model && typeof model === "object" && model.id) {
      byId.set(model.id, {
        ...model,
        ...(model.input ? { input: sanitizeModelInput(model.input) } : {}),
      });
    }
  }
  for (const model of built.models) byId.set(model.id, model);

  providers[OMP_PROVIDER_ID] = {
    ...previous,
    baseUrl: built.baseUrl,
    apiKey: built.apiKey || previous.apiKey || OMP_DEFAULT_API_KEY,
    api: OMP_API,
    models: [...byId.values()],
  };
  next.providers = providers;
  return next;
};

/**
 * Remove one model from the provider, or the whole provider when `modelId` is
 * falsy. `providers` is dropped entirely when it empties so a reset leaves
 * OMP's file as it was found.
 */
export const removeOmpProvider = (models, modelId = null) => {
  const next = isObject(models) ? models : {};
  const providers = next.providers;
  if (!isObject(providers) || !isObject(providers[OMP_PROVIDER_ID])) {
    return { models: next, removed: 0, entryRemoved: false };
  }
  const dropEntry = () => {
    delete providers[OMP_PROVIDER_ID];
    if (Object.keys(providers).length === 0) delete next.providers;
  };

  if (!modelId) {
    const before = Array.isArray(providers[OMP_PROVIDER_ID].models)
      ? providers[OMP_PROVIDER_ID].models.length
      : 0;
    dropEntry();
    return { models: next, removed: before, entryRemoved: true };
  }

  const list = Array.isArray(providers[OMP_PROVIDER_ID].models) ? providers[OMP_PROVIDER_ID].models : [];
  const before = list.length;
  providers[OMP_PROVIDER_ID].models = list.filter((m) => m?.id !== modelId);
  const removed = before - providers[OMP_PROVIDER_ID].models.length;
  if (providers[OMP_PROVIDER_ID].models.length === 0) {
    dropEntry();
    return { models: next, removed, entryRemoved: true };
  }
  return { models: next, removed, entryRemoved: false };
};

// ─── config.yml — the startup model role ───────────────────────────────────

/** Build the OMP selector for one of our models: `afrouter/<id>[:level]`. */
export const buildModelSelector = (id, thinkingLevel = null) => {
  const base = `${OMP_PROVIDER_ID}/${id}`;
  const level = typeof thinkingLevel === "string" ? thinkingLevel.trim().toLowerCase() : "";
  return THINKING_LEVELS.has(level) ? `${base}:${level}` : base;
};

/**
 * Split a role selector we may have written into its AFRouter model id, or null
 * when it points somewhere else. Tolerates the `:level` suffix so a pinned role
 * still identifies the model it belongs to.
 */
export const parseModelSelector = (selector) => {
  if (typeof selector !== "string") return null;
  const value = selector.trim();
  const prefix = `${OMP_PROVIDER_ID}/`;
  if (!value.startsWith(prefix)) return null;
  const rest = value.slice(prefix.length);
  if (!rest) return null;
  const colon = rest.lastIndexOf(":");
  const level = colon > 0 ? rest.slice(colon + 1) : "";
  return colon > 0 && THINKING_LEVELS.has(level.toLowerCase()) ? rest.slice(0, colon) : rest;
};

/**
 * What OMP would start on, and whether that is us. `modelRoles` is a record of
 * selectors keyed by role; only `default` decides the startup chat model, and
 * only a `default` pointing at `afrouter/` belongs to this integration.
 */
export const readOmpDefaults = (config) => {
  const selector = config?.modelRoles?.[OMP_DEFAULT_ROLE];
  const modelId = parseModelSelector(selector);
  return {
    selector: typeof selector === "string" ? selector : null,
    model: modelId,
    isAFRouter: modelId !== null,
  };
};

/**
 * Pin the AFRouter default role so a plain `omp` launch starts on it. A role
 * value is a concrete selector, so there is no "provider only" state here the
 * way Pi's `defaultProvider`/`defaultModel` pair had one: with no model to
 * pin, the file is left exactly as found rather than seeded with a selector
 * that resolves to nothing. Every other role and setting is preserved.
 */
export const upsertOmpDefaults = (config, { modelId = null, setDefault = true, thinkingLevel = null } = {}) => {
  const next = isObject(config) ? config : {};
  if (!setDefault) return clearOmpDefaults(next);
  if (!modelId) return next;
  const roles = isObject(next.modelRoles) ? next.modelRoles : {};
  roles[OMP_DEFAULT_ROLE] = buildModelSelector(modelId, thinkingLevel);
  next.modelRoles = roles;
  return next;
};

/**
 * Clear our startup pin. The key is only removed while it still points at
 * AFRouter, so a Reset can never delete a `default` role the user repointed at
 * another provider. `modelRoles` itself is only dropped when our key was the
 * last one in it — an empty record the user wrote is left alone.
 */
export const clearOmpDefaults = (config) => {
  const next = isObject(config) ? config : {};
  const roles = isObject(next.modelRoles) ? next.modelRoles : null;
  if (!roles) return next;
  if (parseModelSelector(roles[OMP_DEFAULT_ROLE]) === null) return next;
  delete roles[OMP_DEFAULT_ROLE];
  if (Object.keys(roles).length === 0) delete next.modelRoles;
  return next;
};

/**
 * The thinking level our pinned role currently carries, so the card can show
 * the level select's real state instead of guessing.
 *
 * Scoped to a role that is actually ours: a `kilo/foo:high` selector happens to
 * end in a level-shaped suffix, and reporting that as "our" level would make
 * the card show a thinking level for a startup model it does not own. null when
 * the role is not ours or carries no suffix.
 */
export const readOmpThinkingLevel = (config) => {
  const selector = config?.modelRoles?.[OMP_DEFAULT_ROLE];
  if (typeof selector !== "string") return null;
  if (parseModelSelector(selector) === null) return null;
  const colon = selector.lastIndexOf(":");
  if (colon <= 0) return null;
  const level = selector.slice(colon + 1).trim().toLowerCase();
  return THINKING_LEVELS.has(level) ? level : null;
};
