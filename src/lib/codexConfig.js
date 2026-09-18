import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { parseTOML, stringifyTOML } from "confbox";
import { buildCodexCatalog, codexProvider } from "@/shared/codexCatalog.js";

export const getCodexHome = () => path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
export const getCodexPaths = () => ({
  config: path.join(getCodexHome(), "config.toml"),
  catalog: path.join(getCodexHome(), "afrouter-models.json"),
  state: path.join(getCodexHome(), "afrouter-integration.json"),
});

export async function readOptional(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

const parseJson = (raw) => raw === null ? null : JSON.parse(raw.replace(/^\uFEFF/, ""));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fields = [["model"], ["model_provider"], ["model_catalog_json"], ["model_context_window"], ["model_auto_compact_token_limit"], ["model_reasoning_effort"], ["model_providers", "afrouter"], ["agents", "default_subagent_model"]];
const readField = (config, keys) => keys.reduce((value, key) => value?.[key], config) ?? null;
const setField = (config, keys, value) => {
  const parent = keys.length === 1 ? config : (config[keys[0]] ||= {});
  if (value === null) delete parent[keys.at(-1)];
  else parent[keys.at(-1)] = value;
};

export async function readCodexFiles() {
  const paths = getCodexPaths();
  const raw = await readOptional(paths.config);
  let config;
  try {
    config = raw === null ? {} : parseTOML(raw.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("Cannot parse config.toml; restore the file from backup before continuing");
  }
  for (const key of ["model_providers", "agents"]) {
    if (config[key] !== undefined && (!config[key] || typeof config[key] !== "object" || Array.isArray(config[key]))) throw new Error("Invalid Codex configuration table");
  }
  const state = parseJson(await readOptional(paths.state));
  if (state && (state.version !== 1 || !Array.isArray(state.fields) || !Array.isArray(state.models))) {
    throw new Error("Invalid AFRouter ownership record; restore it from backup before continuing");
  }
  const catalogRaw = await readOptional(paths.catalog);
  if (catalogRaw !== null) {
    const catalog = parseJson(catalogRaw);
    if (!Array.isArray(catalog?.models)) throw new Error("Invalid AFRouter catalog; existing files were not changed");
  }
  return { paths, config, state, raw, catalogRaw };
}

async function replaceFile(file, contents) {
  if (contents === null) {
    await fs.unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function writeCodexTransaction(entries) {
  await fs.mkdir(getCodexHome(), { recursive: true });
  const originals = await Promise.all(entries.map(async ([file]) => [file, await readOptional(file)]));
  const backupId = `${Date.now()}-${randomUUID()}`;
  for (const [file, contents] of originals) {
    if (contents !== null) await fs.writeFile(`${file}.bak-${backupId}`, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  const changed = [];
  try {
    for (const [file, contents] of entries) {
      await replaceFile(file, contents);
      changed.push(file);
    }
  } catch (error) {
    for (const file of changed.reverse()) await replaceFile(file, originals.find(([original]) => original === file)[1]);
    throw error;
  }
}

let pending = Promise.resolve();
export function withCodexLock(action) {
  const result = pending.then(action);
  pending = result.catch(() => {});
  return result;
}

export async function applyCodexSettings({ baseUrl, apiKey, models, activeModel, subagentModel, removeModels = [], specs }) {
  const { paths, config, state, catalogRaw } = await readCodexFiles();
  if (config.model_catalog_json && path.resolve(getCodexHome(), config.model_catalog_json) !== paths.catalog) {
    throw new Error("A user-owned model_catalog_json is configured. Keep it unchanged or remove that setting manually before applying AFRouter");
  }
  if (catalogRaw !== null && (!state || catalogRaw !== state.catalog)) {
    throw new Error("The AFRouter catalog is unowned or was edited outside AFRouter; restore its backup before applying");
  }
  const selected = [...new Set([...(state?.models || []).filter((id) => !removeModels.includes(id)), ...models])];
  if (!selected.includes(activeModel)) throw new Error("The default model must be in the selected models");
  if (subagentModel && !selected.includes(subagentModel)) selected.push(subagentModel);
  if (selected.length > 200) throw new Error("Select at most 200 models");
  const mergedSpecs = { ...state?.specs, ...specs };
  const nextState = { version: 1, models: selected, specs: mergedSpecs, fields: fields.map((keys) => {
    const previous = state?.fields.find((field) => equal(field.keys, keys));
    const current = readField(config, keys);
    return { keys, before: previous && equal(current, previous.applied) ? previous.before : current };
  }) };
  config.model = activeModel;
  config.model_provider = "afrouter";
  config.model_catalog_json = paths.catalog;
  delete config.model_context_window;
  delete config.model_auto_compact_token_limit;
  delete config.model_reasoning_effort;
  config.model_providers ||= {};
  const previousProvider = config.model_providers.afrouter || {};
  const provider = { ...previousProvider, ...codexProvider(baseUrl, apiKey) };
  for (const key of ["auth", "env_key", "experimental_bearer_token", "requires_openai_auth"]) delete provider[key];
  provider.http_headers = { ...Object.fromEntries(Object.entries(previousProvider.http_headers || {}).filter(([key]) => key.toLowerCase() !== "authorization")), ...provider.http_headers };
  if (provider.env_http_headers) {
    provider.env_http_headers = Object.fromEntries(Object.entries(provider.env_http_headers).filter(([key]) => key.toLowerCase() !== "authorization"));
  }
  provider.supports_websockets = false;
  config.model_providers.afrouter = provider;
  config.agents ||= {};
  if (subagentModel) config.agents.default_subagent_model = subagentModel;
  else delete config.agents.default_subagent_model;
  for (const field of nextState.fields) field.applied = readField(config, field.keys);
  nextState.catalog = `${JSON.stringify(buildCodexCatalog(selected, mergedSpecs), null, 2)}\n`;
  await writeCodexTransaction([
    [paths.catalog, nextState.catalog],
    [paths.state, JSON.stringify(nextState, null, 2)],
    [paths.config, stringifyTOML(config)],
  ]);
  return { models: selected, specs: mergedSpecs, configPath: paths.config, catalogPath: paths.catalog };
}

export async function resetCodexSettings() {
  const { paths, config, state, catalogRaw, raw } = await readCodexFiles();
  if (raw === null) return;
  if (state) {
    for (const field of state.fields) {
      if (!fields.some((keys) => equal(keys, field.keys))) throw new Error("Invalid ownership field");
      if (equal(readField(config, field.keys), field.applied)) setField(config, field.keys, field.before);
    }
  } else {
    if (config.model_provider === "afrouter") {
      delete config.model_provider;
      delete config.model;
    }
    if (config.model_providers) delete config.model_providers.afrouter;
  }
  const entries = [[paths.config, stringifyTOML(config)]];
  if (state && catalogRaw === state.catalog) entries.push([paths.catalog, null]);
  if (state) entries.push([paths.state, null]);
  await writeCodexTransaction(entries);
}
