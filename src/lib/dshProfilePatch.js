// Pure Cordis-patch shapes for DeepSeek Harness (dsh) profiles.
//
// WHY THIS EXISTS (the integration target changed):
// dsh is an everything-is-a-plugin Cordis runtime composed per **profile**
// (`$DSH_HOME/profiles/<name>`). Live plugin configuration is the profile's
// `cordis.patch.yml` — "a top-level YAML array of loader patch entries
// (id-targeted config overrides, disables, and insert lists)" — and that file
// is per-profile: the Desktop app runs the `desktop` profile while `dsh web`
// runs `web`, so each needs its own patch.
//
// A legacy `$DSH_HOME/settings.yaml` is imported ONCE by `@deepseek-ai/dsh-settings`
// into the active profile patch and then renamed to `settings.yaml.imported`
// (see that package's README). Writing it afterwards is inert, which is why the
// original integration silently stopped working. `.credentials.yaml` is still
// the live credential store and is shared by every profile.
//
// PATCH SEMANTICS (verified in @deepseek-ai/cordis-plugin-include src/index.ts:120):
// a non-insert patch assigns `target[key] = value` per top-level key, so a row
// carrying `config` REPLACES the target row's whole config — there is no deep
// merge. Every write here therefore builds a complete `config` from the row's
// existing config in the patch file, so unrelated keys (and providers the user
// declared in the same row) survive.
//
// This module is pure: no fs/path imports, so the client-side dashboard card
// can import it. File I/O lives in ./dshConfig.js.

import { buildModelEntry } from "./dshModelSpecs.js";

// The bundle row id that mounts `@deepseek-ai/dsh-llm-pi-ai`: the multi-provider
// adapter whose `providers` dictionary holds our route. `dsh-base` inserts this
// row dormant (no config, "zero routes until a `llm-pi-ai:` settings section
// supplies provider profiles"), so a profile patch supplies the whole config.
export const LLM_PI_AI_ID = "llm-pi-ai";

// The row that picks the model a freshly created agent starts on. Its fields
// (`provider`, `model`, optional `reasoningEffort`) mirror exactly what the
// plugin's own `saveSelection()` persists into the active profile patch.
export const DEFAULT_MODEL_ID = "agent-default-model";

// Shipped DSH profiles. The Desktop app is the `desktop` profile (dsh-base
// branches on `profileContext?.name === 'desktop'` for its desktop platform
// integration); a plain `dsh web` launch is the `web` profile.
export const DESKTOP_PROFILE = "desktop";
export const WEB_PROFILE = "web";

export const ROUTE_KEY = "afrouter";

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

// A `!!js` expression parses to `{ __jsExpr }` under the include dialect. Treat
// it as opaque: never read through it, never drop it.
const isJsExpr = (value) => isPlainObject(value) && typeof value.__jsExpr === "string";

// ─── patch document ─────────────────────────────────────────────────────────

export const isPatchList = (value) => Array.isArray(value);

// Index patch rows by id. Only top-level rows carry ids we target (the bundle
// nest is a separate source we never edit).
const indexById = (patchList) => {
  const map = new Map();
  for (const row of patchList) {
    if (isPlainObject(row) && typeof row.id === "string" && row.id) map.set(row.id, row);
  }
  return map;
};

export const findPatchRow = (patchList, id) => indexById(Array.isArray(patchList) ? patchList : []).get(id) || null;

// Upsert a patch row, preserving its position when it already exists so a
// rewrite does not reorder a user's file more than necessary.
const upsertRow = (patchList, id, buildConfig) => {
  const next = Array.isArray(patchList) ? [...patchList] : [];
  const existing = findPatchRow(next, id);
  const existingConfig = isPlainObject(existing?.config) ? existing.config : {};
  const config = buildConfig(existingConfig);
  if (existing) {
    const index = next.indexOf(existing);
    // Spread the existing row so unrelated keys (`insert`, `inject`, `disabled`)
    // survive; only `config` is replaced.
    next[index] = { ...existing, id, config };
  } else {
    // No `name`: a patch whose `name` disagrees with the target row is SKIPPED
    // with a warning (src/index.ts:115), which would make our write silently
    // inert if a future dsh version renames the package. Addressing by id alone
    // is what the working web-profile example does and cannot mismatch.
    next.push({ id, config });
  }
  return next;
};

const removeRow = (patchList, id) => {
  if (!Array.isArray(patchList)) return { patchList: [], removed: false };
  const next = patchList.filter((row) => !(isPlainObject(row) && row.id === id));
  return { patchList: next, removed: next.length !== patchList.length };
};

// `removeRow` reports `removed`; callers here report `entryRemoved`.
const dropRow = (patchList, id) => {
  const { patchList: next, removed } = removeRow(patchList, id);
  return { patchList: next, entryRemoved: removed };
};

// ─── llm-pi-ai route ────────────────────────────────────────────────────────

export const getLlmpiAiConfig = (patchList) => {
  const row = findPatchRow(patchList, LLM_PI_AI_ID);
  return isPlainObject(row?.config) ? row.config : null;
};

export const getAfrouterRoute = (patchList) => {
  const config = getLlmpiAiConfig(patchList);
  return isPlainObject(config?.providers?.[ROUTE_KEY]) ? config.providers[ROUTE_KEY] : null;
};

// Read tolerantly: a js-expr `baseURL`, or a non-string, reads as null rather
// than being coerced or thrown on.
export const readRouteBaseUrl = (route) =>
  typeof route?.baseURL === "string" ? route.baseURL : null;

export const readRouteModels = (route) =>
  Array.isArray(route?.models) ? route.models.filter((m) => isPlainObject(m) && m.id).map((m) => m.id) : [];

// Upsert the AFRouter route. `baseUrl` is normalized to a `/v1` suffix because
// the `openai-completions` protocol adapter appends `/chat/completions`.
// Models merge additively by id; every other provider in the row and every
// other key of the row's config are preserved.
export const upsertAfrouterRoute = (patchList, { baseUrl, models = [], specs = {}, compat = null }) => {
  const normalized = normalizeBaseUrl(baseUrl);
  const next = upsertRow(patchList, LLM_PI_AI_ID, (existingConfig) => {
    const providers = isPlainObject(existingConfig.providers) ? { ...existingConfig.providers } : {};
    const previous = isPlainObject(providers[ROUTE_KEY]) ? providers[ROUTE_KEY] : {};

    const route = {
      ...previous,
      displayName: "AFRouter",
      apiKeyEnv: "AFROUTER_API_KEY",
      api: "openai-completions",
      baseURL: normalized,
    };
    if (compat && Object.keys(compat).length > 0) {
      route.compat = { ...(isPlainObject(previous.compat) ? previous.compat : {}), ...compat };
    } else {
      delete route.compat;
    }

    const byId = new Map(
      (Array.isArray(previous.models) ? previous.models : [])
        .filter((m) => isPlainObject(m) && m.id)
        .map((m) => [m.id, m]),
    );
    for (const id of models) byId.set(id, buildModelEntry(id, specs[id] || {}, compat));
    route.models = [...byId.values()];

    providers[ROUTE_KEY] = route;
    return { ...existingConfig, providers };
  });
  return next;
};

// Remove one model from the route; the route itself goes when its list empties.
export const removeModelFromRoute = (patchList, modelId) => {
  const route = getAfrouterRoute(patchList);
  if (!route || !Array.isArray(route.models)) {
    return { patchList, removed: 0, entryRemoved: false };
  }
  const kept = route.models.filter((m) => !(isPlainObject(m) && m.id === modelId));
  const removed = route.models.length - kept.length;
  if (kept.length === 0) return removeAfrouterRoute(patchList);
  const next = upsertRow(patchList, LLM_PI_AI_ID, (existingConfig) => {
    const providers = { ...existingConfig.providers };
    providers[ROUTE_KEY] = { ...getAfrouterRoute(patchList), models: kept };
    return { ...existingConfig, providers };
  });
  return { patchList: next, removed, entryRemoved: false };
};

// Drop the route. The `llm-pi-ai` row goes only when nothing of ours or the
// user's is left in it: another provider declared in the same row, or any other
// config key, keeps the row (with our provider removed). Deleting a row the
// user still needs would silently break their other gateways.
export const removeAfrouterRoute = (patchList) => {
  const row = findPatchRow(patchList, LLM_PI_AI_ID);
  const config = isPlainObject(row?.config) ? row.config : null;
  if (!config || !isPlainObject(config.providers) || !Object.hasOwn(config.providers, ROUTE_KEY)) {
    return { patchList, entryRemoved: false };
  }

  const providers = { ...config.providers };
  delete providers[ROUTE_KEY];
  const configKeys = Object.keys(config).filter((key) => key !== "providers");

  if (Object.keys(providers).length === 0 && configKeys.length === 0) {
    return dropRow(patchList, LLM_PI_AI_ID);
  }

  const next = upsertRow(patchList, LLM_PI_AI_ID, () => {
    const rebuilt = { ...config };
    if (Object.keys(providers).length > 0) rebuilt.providers = providers;
    else delete rebuilt.providers;
    return rebuilt;
  });
  return { patchList: next, entryRemoved: true };
};

// ─── agent-default-model ────────────────────────────────────────────────────

export const getDefaultModel = (patchList) => {
  const row = findPatchRow(patchList, DEFAULT_MODEL_ID);
  if (!isPlainObject(row?.config)) return null;
  const { provider, model, reasoningEffort } = row.config;
  if (typeof provider !== "string" || typeof model !== "string") return null;
  return { provider, model, reasoningEffort: typeof reasoningEffort === "string" ? reasoningEffort : undefined };
};

// True only while the pinned default still points at our route — the guard that
// stops a Reset from repointing a default the user set to something else.
export const defaultPointsAtAfrouter = (patchList) => getDefaultModel(patchList)?.provider === ROUTE_KEY;

// Build the config `saveSelection()` itself would persist: the complete
// selection, with `reasoningEffort` omitted (not nulled) when unset.
export const buildDefaultModelConfig = ({ model, reasoningEffort }) => {
  const config = { provider: ROUTE_KEY, model };
  if (reasoningEffort) config.reasoningEffort = reasoningEffort;
  return config;
};

export const upsertDefaultModel = (patchList, { model, reasoningEffort }) =>
  upsertRow(patchList, DEFAULT_MODEL_ID, () => buildDefaultModelConfig({ model, reasoningEffort }));

// Clear the default only when it still points at AFRouter.
// Clear the default only when it still points at AFRouter. Returns `removed`
// (not `entryRemoved`) to match `removeRow`, the shape its caller reads.
export const removeDefaultModel = (patchList) => {
  if (!defaultPointsAtAfrouter(patchList)) return { patchList, removed: false };
  const { patchList: next, removed } = removeRow(patchList, DEFAULT_MODEL_ID);
  return { patchList: next, removed };
};

// ─── shared ─────────────────────────────────────────────────────────────────

export const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};
