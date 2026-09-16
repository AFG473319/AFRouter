import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseYAML, stringifyYAML } from "confbox/yaml";

// DeepSeek Harness (dsh) integration helpers.
//
// dsh keeps model routes in `$DSH_HOME/settings.yaml` under the `llm-pi-ai`
// settings section, and secrets in `$DSH_HOME/.credentials.yaml` under `refs`.
// AFRouter owns exactly one route (`llm-pi-ai.providers.afrouter`) and one
// credential ref (`AFROUTER_API_KEY`); everything else in both documents is
// preserved verbatim. See specs/002-deepseek-harness-integration/.

export const ROUTE_KEY = "afrouter";
export const CREDENTIAL_REF = "AFROUTER_API_KEY";
export const DEFAULT_API_KEY = "sk_afrouter";

const SETTINGS_SECTION = "llm-pi-ai";

export const getDshHome = () =>
  process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

export const getSettingsPath = () => path.join(getDshHome(), "settings.yaml");
export const getCredentialsPath = () => path.join(getDshHome(), ".credentials.yaml");

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

// Read + parse a YAML document. Missing -> { missing: true }; unparseable ->
// { corrupt: true }. Never throws to the handler (SC-004).
const readYaml = async (filePath) => {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const data = parseYAML(raw);
    return { data: isPlainObject(data) ? data : {} };
  } catch {
    return { corrupt: true };
  }
};

export const readSettingsYaml = () => readYaml(getSettingsPath());
export const readCredentialsYaml = () => readYaml(getCredentialsPath());

// Timestamped backup -> temp file -> atomic rename with EPERM/EACCES retries
// (Windows file-lock races). Skips the backup when the target does not exist.
const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export const writeAtomic = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  try {
    backupPath = `${filePath}.bak-${timestamp()}`;
    await fs.copyFile(filePath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    backupPath = null;
  }
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      break;
    } catch (error) {
      if ((error.code === "EPERM" || error.code === "EACCES") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw error;
    }
  }
  return { backupPath };
};

// ─── settings.yaml ──────────────────────────────────────────────────────────

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

export const getAfrouterRoute = (settings) =>
  settings?.[SETTINGS_SECTION]?.providers?.[ROUTE_KEY] || null;

// Build a single dsh model entry from resolved specs. `input` is declared only
// for vision models and `reasoningEfforts` only when the model reasons — a
// hand-declared model is text-only and reasoning-less by default.
export const buildModelEntry = (id, spec = {}, compat = null) => {
  const entry = {
    id,
    name: spec.name || id,
    contextWindow: spec.contextWindow,
    maxTokens: spec.maxTokens,
  };
  if (spec.vision) entry.input = ["text", "image"];
  if (spec.reasoning) {
    entry.reasoningEfforts = {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    };
    // A DeepSeek-family model behind the gateway thinks unless told otherwise,
    // so `off` must send thinking:{type:disabled}. Opt-in only.
    if (compat?.thinkingFormat === "deepseek") {
      entry.compat = { thinkingFormat: "deepseek" };
    }
  }
  return entry;
};

// Upsert the AFRouter route, merging models additively by id. Every other
// section, provider and route field is preserved (FR-005).
export const upsertAfrouterRoute = (settings, { baseUrl, models = [], specs = {}, compat = null }) => {
  const next = isPlainObject(settings) ? settings : {};
  const section = isPlainObject(next[SETTINGS_SECTION]) ? next[SETTINGS_SECTION] : {};
  const providers = isPlainObject(section.providers) ? section.providers : {};
  const route = isPlainObject(providers[ROUTE_KEY]) ? providers[ROUTE_KEY] : {};

  route.displayName = "AFRouter";
  route.apiKeyEnv = CREDENTIAL_REF;
  route.api = "openai-completions";
  route.baseURL = normalizeBaseUrl(baseUrl);
  if (compat && Object.keys(compat).length > 0) {
    route.compat = { ...(isPlainObject(route.compat) ? route.compat : {}), ...compat };
  }

  const existing = Array.isArray(route.models) ? route.models : [];
  const byId = new Map(
    existing
      .filter((m) => m && typeof m === "object" && m.id)
      .map((m) => [m.id, m]),
  );
  for (const id of models) {
    byId.set(id, buildModelEntry(id, specs[id] || {}, compat));
  }
  route.models = [...byId.values()];

  providers[ROUTE_KEY] = route;
  section.providers = providers;
  next[SETTINGS_SECTION] = section;
  return next;
};

// Remove the AFRouter route. Drops the `llm-pi-ai` section only when it has
// nothing left, and preserves any other top-level section.
export const removeAfrouterRoute = (settings) => {
  const next = isPlainObject(settings) ? settings : {};
  const section = next[SETTINGS_SECTION];
  if (!isPlainObject(section) || !isPlainObject(section.providers)) {
    return { settings: next, entryRemoved: false };
  }
  if (!Object.prototype.hasOwnProperty.call(section.providers, ROUTE_KEY)) {
    return { settings: next, entryRemoved: false };
  }
  delete section.providers[ROUTE_KEY];
  if (Object.keys(section.providers).length === 0) delete section.providers;
  if (Object.keys(section).length === 0) delete next[SETTINGS_SECTION];
  return { settings: next, entryRemoved: true };
};

// Remove a single model from the AFRouter route; deletes the route when its
// list empties.
export const removeModelFromRoute = (settings, modelId) => {
  const route = getAfrouterRoute(settings);
  if (!route || !Array.isArray(route.models)) {
    return { settings, removed: 0, entryRemoved: false };
  }
  const before = route.models.length;
  route.models = route.models.filter((m) => m?.id !== modelId);
  const removed = before - route.models.length;
  if (route.models.length === 0) {
    const { settings: cleaned, entryRemoved } = removeAfrouterRoute(settings);
    return { settings: cleaned, removed, entryRemoved };
  }
  return { settings, removed, entryRemoved: false };
};

// ─── .credentials.yaml ──────────────────────────────────────────────────────

const readRefValue = (creds) => creds?.refs?.[CREDENTIAL_REF];

export const hasCredentialRef = (creds) => {
  const value = readRefValue(creds);
  return typeof value === "string" && value.length > 0;
};

export const upsertCredentialRef = (creds, value) => {
  const next = isPlainObject(creds) ? creds : {};
  if (next.version === undefined) next.version = 1;
  const refs = isPlainObject(next.refs) ? next.refs : {};
  refs[CREDENTIAL_REF] = value || DEFAULT_API_KEY;
  next.refs = refs;
  return next;
};

// Reset ownership (D4): drop the ref only when it holds the AFRouter default
// (`sk_afrouter`). A real dashboard key the user configured is left in place,
// so Reset cannot destroy a live credential. `force` bypasses the guard for
// callers that explicitly intend to clear it.
export const removeCredentialRef = (creds, { force = false } = {}) => {
  const next = isPlainObject(creds) ? creds : {};
  const refs = next.refs;
  if (!isPlainObject(refs) || !Object.prototype.hasOwnProperty.call(refs, CREDENTIAL_REF)) {
    return { credentials: next, removed: false };
  }
  const value = refs[CREDENTIAL_REF];
  if (!force && value !== DEFAULT_API_KEY) {
    return { credentials: next, removed: false };
  }
  delete refs[CREDENTIAL_REF];
  if (Object.keys(refs).length === 0) delete next.refs;
  return { credentials: next, removed: true };
};

export const stringifyYamlDocument = (value) => stringifyYAML(value);
