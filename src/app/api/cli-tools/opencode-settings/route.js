"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

const execAsync = promisify(exec);

const getConfigDir = () => path.join(os.homedir(), ".config", "opencode");
const getConfigPath = () => path.join(getConfigDir(), "opencode.json");

// Conservative fallback for ids resolvable from neither the live catalog nor the
// static registry — flagged "unverified", never invented (mirrors ZCode/dsh).
const FALLBACK_SPEC = { contextWindow: 200000, maxOutput: 64000, vision: false, pdf: false, audioInput: false, videoInput: false, reasoning: false, tools: true };

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

// OpenCode model-entry shape (ConfigProviderV1.Model): limits, reasoning,
// tool_call and the per-modality input list all come from capabilities. The old
// shape hardcoded ["text","image"] for every model, which lied about vision and
// left context/output at OpenCode's 0 default (breaking compaction).
const buildModelEntry = (id, caps) => {
  const input = ["text"];
  if (caps.vision) input.push("image");
  if (caps.pdf) input.push("pdf");
  if (caps.audioInput) input.push("audio");
  if (caps.videoInput) input.push("video");
  const attachment = Boolean(caps.vision || caps.pdf || caps.audioInput || caps.videoInput);
  return {
    name: id,
    limit: {
      context: Math.floor(caps.contextWindow),
      output: Math.floor(caps.maxOutput),
    },
    reasoning: caps.reasoning === true,
    tool_call: caps.tools !== false,
    attachment,
    modalities: { input, output: ["text"] },
  };
};

// Check if opencode CLI is installed (via which/where or config file exists)
const checkOpenCodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where opencode" : "which opencode";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
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

const hasAFRouterConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider["afrouter"];
};

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
    const providerConfig = config?.provider?.["afrouter"];
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      config,
      hasAFRouter: hasAFRouterConfig(config),
      configPath: getConfigPath(),
        opencode: {
          models: Object.keys(modelMap),
          activeModel: config?.model?.startsWith("afrouter/") ? config.model.replace(/^afrouter\//, "") : null,
          baseURL: providerConfig?.options?.baseURL || null,
        },
    });
  } catch (error) {
    console.log("Error checking opencode settings:", error);
    return NextResponse.json({ error: "Failed to check opencode settings" }, { status: 500 });
  }
}

// POST - Apply AFRouter as openai-compatible provider (multi-model support)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel, subagentModel } = await request.json();

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

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_afrouter";
    const effectiveSubagentModel = subagentModel || modelsArray[0];

    // Ensure provider object
    if (!config.provider) config.provider = {};

    // Preserve any existing afrouter provider entry and its models
    const existingProvider = config.provider["afrouter"] || { npm: "@ai-sdk/openai-compatible", options: {}, models: {} };

    // Merge options (overwrite baseURL/apiKey)
    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    // Ensure models map exists
    existingProvider.models = existingProvider.models || {};

    // Resolve each requested model's specs from the live catalog, the static
    // capability tables, or the conservative fallback. Unknown ids are still
    // written (with fallback specs) so the user's selection is never dropped.
    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);

    // Add or update entries for all requested models. `onlyIds` semantics:
    // every requested id is refreshed so a re-Apply after a capability update
    // propagates the new limits. Entries the user hand-edited keep their `name`
    // only when it differs from the id (preserve display names), but the
    // machine-readable spec fields are always refreshed.
    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      const caps = specs.get(m) || FALLBACK_SPEC;
      const entry = buildModelEntry(m, caps);
      const existingEntry = existingProvider.models[m];
      if (existingEntry && typeof existingEntry === "object" && typeof existingEntry.name === "string" && existingEntry.name !== m) {
        entry.name = existingEntry.name;
      }
      existingProvider.models[m] = entry;
    }

    // Save merged provider back
    config.provider["afrouter"] = existingProvider;

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

    // Add subagent configuration
    if (!config.agent) config.agent = {};
    config.agent.explorer = {
      description: "Fast explorer subagent for codebase exploration",
      mode: "subagent",
      model: `afrouter/${effectiveSubagentModel}`,
    };

    await writeConfigAtomic(config);

    return NextResponse.json({
      success: true,
      message: "OpenCode settings applied successfully!",
      configPath,
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

    // If specific model provided, remove just that model
    if (modelToRemove && config.provider?.["afrouter"]?.models) {
      delete config.provider["afrouter"].models[modelToRemove];
      
      // If no models left, remove the provider
      if (Object.keys(config.provider["afrouter"].models).length === 0) {
        delete config.provider["afrouter"];
        if (config.model?.startsWith("afrouter/")) delete config.model;
      } else if (config.model === `afrouter/${modelToRemove}`) {
        // If removed model was active, switch to first remaining model
        const remainingModels = Object.keys(config.provider["afrouter"].models);
        config.model = `afrouter/${remainingModels[0]}`;
      }
    } else {
      // No specific model - remove entire afrouter provider
      if (config.provider) delete config.provider["afrouter"];
      if (config.model?.startsWith("afrouter/")) delete config.model;
    }

    // Remove subagent configuration
    if (config.agent?.explorer?.model?.startsWith("afrouter/")) {
      delete config.agent.explorer;
      // Clean up empty agent object
      if (Object.keys(config.agent).length === 0) delete config.agent;
    }

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
