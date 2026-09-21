"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  AFROUTER_PROVIDER_ID,
  FALLBACK_SPEC,
  SUBAGENT_NAME,
  agentMapKey,
  buildModelEntry,
  buildProviderEntry,
  buildSubagentEntry,
  isOwnedSubagent,
  otherFormat,
  providerBaseUrl,
  providerCredentialKey,
  providerMapKey,
  readAFRouterProvider,
  readSubagentModel,
  removeOwnedSubagent,
  reshapeModelEntry,
  resolveFormat,
} from "@/lib/opencodeConfig.js";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Self-fetch must target the port this instance actually listens on. The
// request URL carries it; PORT is only a fallback because the Next server may
// be started with --port and no PORT env.
const resolveSelfOrigin = (request) => {
  try {
    const url = new URL(request?.url || "");
    if (url.port) return `http://127.0.0.1:${url.port}`;
  } catch {
    // fall through
  }
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
};

// Live catalog first: our own /v1/models, indexed by exact id and by the
// alias-translated spelling (a config may use `oc/…` where the catalog says
// `opencode/…`).
const resolveLiveCatalog = async (origin) => {
  try {
    const res = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data : [];
    const byId = new Map();
    const byAliasId = new Map();
    for (const m of models) {
      if (!m?.id || !m.capabilities) continue;
      byId.set(m.id, m.capabilities);
      const bare = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
      const owner = m.owned_by || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : null);
      if (bare && owner) byAliasId.set(`${owner}/${bare}`, m.capabilities);
    }
    return { byId, byAliasId };
  } catch {
    return null;
  }
};

// Resolve model IDs -> full capability spec. Catalog first (exact id, then
// alias-translated id), static registry second, conservative fallback last.
const resolveModelSpecs = async (ids, catalog) => {
  const specs = new Map();
  const unverified = [];
  for (const id of ids) {
    const slash = id.indexOf("/");
    const prefix = slash > 0 ? id.slice(0, slash) : null;
    const bare = slash > 0 ? id.slice(slash + 1) : id;

    let caps = catalog?.byId?.get(id) || null;
    if (!caps && prefix) {
      const translated = resolveProviderAlias(prefix);
      caps =
        catalog?.byAliasId?.get(`${translated}/${bare}`) ||
        catalog?.byAliasId?.get(`${prefix}/${bare}`) ||
        null;
    }
    if (!caps) {
      const staticCaps = getCapabilitiesForModel(prefix, bare);
      if (staticCaps && Number.isFinite(staticCaps.contextWindow)) caps = staticCaps;
    }
    if (caps && Number.isFinite(caps.contextWindow) && Number.isFinite(caps.maxOutput)) {
      specs.set(id, caps);
    } else {
      specs.set(id, { ...FALLBACK_SPEC });
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

const npmPathEnv = () => {
  const isWindows = os.platform() === "win32";
  return isWindows
    ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
    : process.env;
};

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const command = os.platform() === "win32" ? "where opencode" : "which opencode";
    await execAsync(command, { windowsHide: true, env: npmPathEnv() });
    return true;
  } catch {
    try {
      await fs.access(getConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

// `opencode --version` — V2 reports a 2.x version, which is the only reliable
// signal on a fresh install that has no config file to inspect yet.
const readOpenCodeVersion = async () => {
  try {
    const { stdout } = await execAsync("opencode --version", { windowsHide: true, env: npmPathEnv() });
    return stdout.trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
};

// Read + parse the config, distinguishing the three outcomes the handlers need:
//   { missing: true }              -> no file yet (fresh install)
//   { corrupt: true }              -> exists but unparseable (never overwrite)
//   { data }                       -> parsed config
// opencode config files may use JSONC (comments/trailing commas); strip trailing
// commas before parsing so valid JSONC does not read as corrupt.
const readConfigResult = async () => {
  let content;
  try {
    content = await fs.readFile(getConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return { data: JSON.parse(stripped) };
  } catch {
    return { corrupt: true };
  }
};

const readConfig = async () => {
  const result = await readConfigResult();
  return result.data ?? null;
};

const hasAFRouterConfig = (config) => Boolean(readAFRouterProvider(config).entry);

// Write the config via a temp file + atomic rename. OpenCode rewrites this file
// on config changes, so a torn write would drop the user's whole provider tree.
const writeConfigAtomic = async (config) => {
  const configPath = getConfigPath();
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, configPath);
      break;
    } catch (error) {
      if ((error.code === "EPERM" || error.code === "EACCES") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw error;
    }
  }
};

// Drop the `afrouter` entry from the shape we are NOT writing, then the map
// itself when nothing else lives in it. Keeps one provider out of both shapes.
const dropStaleProvider = (config, mapKey) => {
  if (!isPlainObject(config[mapKey])) return;
  delete config[mapKey][AFROUTER_PROVIDER_ID];
  if (Object.keys(config[mapKey]).length === 0) delete config[mapKey];
};

/**
 * Write, carry over, or clear AFRouter's subagent override in the requested
 * shape.
 *
 * A blank model means "let OpenCode decide" — V1/V2 then inherit the session's
 * model — so we remove our entry instead of pinning the first selected model.
 * Following the Grok Build integration, an *omitted* field (headless callers
 * that never knew about it) leaves an existing override untouched, while an
 * explicit empty string clears it.
 */
const applySubagent = (config, format, subagentModel) => {
  const mapKey = agentMapKey(format);
  const otherKey = agentMapKey(otherFormat(format));
  const explicit = typeof subagentModel === "string" ? subagentModel.trim() : undefined;

  const existing = config[mapKey]?.[SUBAGENT_NAME] ?? config[otherKey]?.[SUBAGENT_NAME];
  const carriedModel =
    explicit === undefined && isOwnedSubagent(existing)
      ? existing.model.slice(AFROUTER_PROVIDER_ID.length + 1)
      : null;

  // Ours may sit in the other shape; drop it before writing the new one.
  for (const key of [mapKey, otherKey]) removeOwnedSubagent(config, key);

  const model = explicit || carriedModel;
  if (!model) return;
  if (!isPlainObject(config[mapKey])) config[mapKey] = {};
  config[mapKey][SUBAGENT_NAME] = buildSubagentEntry(model);
};

// GET - Check opencode CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkOpenCodeInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "OpenCode CLI is not installed",
      });
    }

    const config = await readConfig();
    const version = await readOpenCodeVersion();
    const { format, source: formatSource } = resolveFormat({ config, version });
    const providerConfig = readAFRouterProvider(config).entry;
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasAFRouter: hasAFRouterConfig(config),
      configPath: getConfigPath(),
      opencode: {
        models: Object.keys(modelMap),
        activeModel: config?.model?.startsWith("afrouter/") ? config.model.replace(/^afrouter\//, "") : null,
        baseURL: providerBaseUrl(providerConfig),
        subagentModel: readSubagentModel(config),
        version,
        format,
        formatSource,
      },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply AFRouter as an openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel, format: requestedFormat } =
      await request.json();

    // Accept either `model` (string, legacy) or `models` (array of strings)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configDir = getConfigDir();
    const configPath = getConfigPath();

    await fs.mkdir(configDir, { recursive: true });

    // Read existing config or start fresh. Reuse the JSONC-safe reader so a
    // config with comments/trailing commas survives an Apply (plain JSON.parse
    // would throw and we would silently overwrite the whole file). A corrupt
    // file is never overwritten — the user is told to fix it first.
    const existing = await readConfigResult();
    if (existing.corrupt) {
      return NextResponse.json(
        { success: false, error: "OpenCode config is unreadable — fix or restore it before applying" },
        { status: 409 },
      );
    }
    const config = existing.data || {};

    // Which shape to write: an explicit choice from the card wins, then the
    // config's own shape, then the installed CLI version (V2 uses the native
    // shape; V1 is the default because V2 still reads it).
    const version = await readOpenCodeVersion();
    const { format, source: formatSource } = resolveFormat({ requested: requestedFormat, config, version });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_afrouter";

    const mapKey = providerMapKey(format);
    const staleMapKey = providerMapKey(otherFormat(format));

    // Rebuild the provider in the target shape from whichever shape it is in
    // now, so switching formats never leaves V1 and V2 members side by side.
    const sourceProvider =
      config[mapKey]?.[AFROUTER_PROVIDER_ID] || config[staleMapKey]?.[AFROUTER_PROVIDER_ID] || {};
    const provider = buildProviderEntry(format, sourceProvider);
    provider[providerCredentialKey(format)] = {
      ...provider[providerCredentialKey(format)],
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Convert models the user already had, then refresh the requested ones from
    // resolved capability specs. `onlyIds` semantics: every requested id is
    // refreshed so a re-Apply after a capability update propagates new limits.
    // Entries the user hand-edited keep their display `name` when it differs
    // from the id, but their machine-readable spec fields are always refreshed.
    for (const id of Object.keys(provider.models)) {
      provider.models[id] = reshapeModelEntry(provider.models[id], format);
    }

    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);

    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      const caps = specs.get(m) || FALLBACK_SPEC;
      const entry = buildModelEntry(m, caps, format);
      const existingEntry = provider.models[m];
      if (
        existingEntry &&
        typeof existingEntry === "object" &&
        typeof existingEntry.name === "string" &&
        existingEntry.name !== m
      ) {
        entry.name = existingEntry.name;
      }
      provider.models[m] = entry;
    }

    if (!isPlainObject(config[mapKey])) config[mapKey] = {};
    config[mapKey][AFROUTER_PROVIDER_ID] = provider;
    dropStaleProvider(config, staleMapKey);

    // Set the active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, clear the model
    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `afrouter/${finalActive}`;
      }
    }

    // Add, carry over, or clear the subagent override.
    applySubagent(config, format, subagentModel);

    await writeConfigAtomic(config);

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
      format,
      formatSource,
      written: modelsArray,
      unverified,
    });
  } catch (error) {
    console.log("Error applying opencode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();

    const existing = await readConfigResult();
    if (existing.missing) {
      return NextResponse.json({ success: true, message: "No config file found" });
    }
    if (existing.corrupt) {
      return NextResponse.json(
        { success: false, error: "OpenCode config is unreadable — fix or restore it first" },
        { status: 409 },
      );
    }
    const config = existing.data;

    if (clearActiveModel === true) {
      // Clear active model but keep models in the list
      if (config.model?.startsWith("afrouter/")) {
        config.model = "";
      }
    }

    await writeConfigAtomic(config);

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching opencode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove AFRouter provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const existing = await readConfigResult();
    if (existing.missing) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    if (existing.corrupt) {
      return NextResponse.json(
        { success: false, error: "OpenCode config is unreadable — fix or restore it first" },
        { status: 409 },
      );
    }
    const config = existing.data;

    // The provider may live in either shape depending on the OpenCode version
    // the user runs, so every mutation walks both maps.
    const providerMapKeys = [providerMapKey("v2"), providerMapKey("v1")];

    if (modelToRemove) {
      // If specific model provided, remove just that model
      for (const mapKey of providerMapKeys) {
        const models = config[mapKey]?.[AFROUTER_PROVIDER_ID]?.models;
        if (!isPlainObject(models) || !Object.prototype.hasOwnProperty.call(models, modelToRemove)) continue;
        delete models[modelToRemove];
        if (Object.keys(models).length === 0) {
          delete config[mapKey][AFROUTER_PROVIDER_ID];
        } else if (config.model === `afrouter/${modelToRemove}`) {
          // If removed model was active, switch to first remaining model
          config.model = `afrouter/${Object.keys(models)[0]}`;
        }
      }
      // The provider is gone entirely — drop the dangling active model too.
      if (config.model === `afrouter/${modelToRemove}`) delete config.model;
    } else {
      // No specific model - remove entire afrouter provider
      for (const mapKey of providerMapKeys) {
        if (isPlainObject(config[mapKey])) delete config[mapKey][AFROUTER_PROVIDER_ID];
      }
      if (config.model?.startsWith("afrouter/")) delete config.model;
    }

    // Clean up provider maps we emptied (but never a map holding other providers)
    for (const mapKey of providerMapKeys) {
      if (isPlainObject(config[mapKey]) && Object.keys(config[mapKey]).length === 0) delete config[mapKey];
    }

    // Remove subagent configuration from either shape
    for (const mapKey of [agentMapKey("v2"), agentMapKey("v1")]) removeOwnedSubagent(config, mapKey);

    await writeConfigAtomic(config);

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "AFRouter settings removed from OpenCode",
    });
  } catch (error) {
    console.log("Error resetting opencode settings:", error);
    return NextResponse.json({ error: "Failed to reset opencode settings" }, { status: 500 });
  }
}
