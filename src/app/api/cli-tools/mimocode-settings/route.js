"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { parseConfigText, writeWithBackup } from "@/lib/cliConfigIO.js";
import {
  AFROUTER_PROVIDER_ID,
  FALLBACK_SPEC,
  buildProviderEntry,
  mergeModelEntry,
  modelSelection,
} from "@/lib/mimocodeConfig.js";

const execAsync = promisify(exec);

const CONFIG_NAMES = ["mimocode.jsonc", "mimocode.json", "config.json"];

// MiMoCode's docs (mimo.xiaomi.com/mimocode/config-overrides) describe
// MIMOCODE_HOME as a profile root holding config/, data/, state/ and cache/ —
// and loadGlobal() reads $MIMOCODE_HOME/config/mimocode.jsonc. Writing to
// $MIMOCODE_HOME/mimocode.jsonc produced a file MiMo never loads.
// Without MIMOCODE_HOME the global config resolves through XDG_CONFIG_HOME.
const getConfigDir = () => {
  if (process.env.MIMOCODE_HOME) return path.join(process.env.MIMOCODE_HOME, "config");
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdg, "mimocode");
};

const getCandidateDirs = () => {
  const dirs = [getConfigDir()];
  if (os.platform() === "win32" && process.env.LOCALAPPDATA) {
    const local = path.join(process.env.LOCALAPPDATA, "mimocode");
    if (!dirs.includes(local)) dirs.push(local);
  }
  return dirs;
};

const resolveExistingConfigPath = async () => {
  for (const dir of getCandidateDirs()) {
    for (const name of CONFIG_NAMES) {
      const p = path.join(dir, name);
      try {
        await fs.access(p);
        return p;
      } catch { /* not this file */ }
    }
  }
  return null;
};

const getConfigPath = async () => {
  return (await resolveExistingConfigPath()) || path.join(getConfigDir(), CONFIG_NAMES[0]);
};

const readConfig = async () => {
  const configPath = await resolveExistingConfigPath();
  if (!configPath) return { content: null, configPath: await getConfigPath() };
  let content;
  try {
    content = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { content: null, configPath };
    return { content: null, configPath, corrupt: true };
  }
  try {
    return { content, configPath, data: parseConfigText(content, "json", "mimocode.jsonc") };
  } catch (error) {
    return { content, configPath, corrupt: true, error: error?.message };
  }
};

const hasAFRouterConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider[AFROUTER_PROVIDER_ID];
};

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

const desktopAppInstalled = async () => {
  const bases =
    os.platform() === "win32"
      ? [process.env.APPDATA, path.join(os.homedir(), "AppData", "Roaming")]
      : os.platform() === "darwin"
      ? [path.join(os.homedir(), "Library", "Application Support")]
      : [];
  for (const base of bases) {
    if (!base) continue;
    try {
      await fs.access(path.join(base, "Xiaomi MiMo AI"));
      return true;
    } catch { /* not here */ }
  }
  return false;
};

// MiMo Code CLI (`mimo`) OR the MiMo Desktop app (which ships an embedded
// engine and no PATH binary) OR an existing config file.
const checkMiMoInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where mimo" : "which mimo";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    if (await desktopAppInstalled()) return true;
    try {
      return !!(await resolveExistingConfigPath());
    } catch {
      return false;
    }
  }
};

// GET - check MiMo install + read current AFRouter settings
export async function GET() {
  try {
    const isInstalled = await checkMiMoInstalled();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "MiMo Code / Desktop is not installed",
      });
    }

    const { content, configPath, data: config, corrupt } = await readConfig();
    if (corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath,
        mimocode: null,
      });
    }

    const providerConfig = config?.provider?.[AFROUTER_PROVIDER_ID];
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      corrupt: false,
      config,
      hasAFRouter: hasAFRouterConfig(config),
      configPath,
      mimocode: {
        models: Object.keys(modelMap),
        activeModel: config?.model?.startsWith(`${AFROUTER_PROVIDER_ID}/`)
          ? config.model.slice(AFROUTER_PROVIDER_ID.length + 1)
          : null,
        baseURL: providerConfig?.options?.baseURL || null,
      },
    });
  } catch (error) {
    console.log("Error checking mimocode settings:", error);
    return NextResponse.json({ error: "Failed to check mimocode settings" }, { status: 500 });
  }
}

// POST - Apply AFRouter as openai-compatible provider
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel } = await request.json();

    const modelsArray = Array.isArray(models)
      ? models.filter((m) => typeof m === "string" && m)
      : (typeof model === "string" && model ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const existing = await readConfig();
    if (existing.corrupt) {
      return NextResponse.json({ success: false, error: "MiMo config is unreadable — fix or restore mimocode.jsonc before applying" }, { status: 409 });
    }

    const config = existing.data && typeof existing.data === "object" ? existing.data : {};
    const configPath = existing.configPath || (await getConfigPath());
    const configDir = path.dirname(configPath);

    await fs.mkdir(configDir, { recursive: true });

    const sourceProvider = config.provider?.[AFROUTER_PROVIDER_ID] || {};
    const provider = buildProviderEntry({ baseUrl, apiKey, source: sourceProvider });

    // Resolve real specs (live catalog → static registry → conservative
    // fallback) and rewrite every requested id so a re-Apply after a capability
    // update propagates correct limits/modalities. A display `name` the user
    // set (anything other than the bare id) is preserved.
    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);

    for (const m of modelsArray) {
      const caps = specs.get(m) || FALLBACK_SPEC;
      provider.models[m] = mergeModelEntry(m, caps, provider.models[m]);
    }

    if (!config.provider) config.provider = {};
    config.provider[AFROUTER_PROVIDER_ID] = provider;

    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = modelSelection(finalActive);
      }
    }

    await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, { secret: true });

    return NextResponse.json({
      success: true,
      message: "MiMo Code settings applied successfully!",
      configPath,
      written: modelsArray,
      unverified,
    });
  } catch (error) {
    console.log("Error applying mimocode settings:", error);
    return NextResponse.json({ error: "Failed to apply settings" }, { status: 500 });
  }
}

// PATCH - Update specific settings (e.g., clear active model)
export async function PATCH(request) {
  try {
    const { clearActiveModel } = await request.json();

    const existing = await readConfig();
    if (existing.corrupt) {
      return NextResponse.json({ success: false, error: "MiMo config is unreadable" }, { status: 409 });
    }
    const configPath = existing.configPath;
    if (!configPath) {
      return NextResponse.json({ success: true, message: "No config file found" });
    }

    const config = existing.data && typeof existing.data === "object" ? existing.data : {};

    if (clearActiveModel === true) {
      if (config.model?.startsWith(`${AFROUTER_PROVIDER_ID}/`)) {
        config.model = "";
      }
    }

    await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, { secret: true });

    return NextResponse.json({
      success: true,
      message: "Settings updated",
    });
  } catch (error) {
    console.log("Error patching mimocode settings:", error);
    return NextResponse.json({ error: "Failed to patch settings" }, { status: 500 });
  }
}

// DELETE - Remove AFRouter provider or specific models from config
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const existing = await readConfig();
    if (existing.corrupt) {
      // Never report success on a file we could not read: the user would believe
      // their settings were reset when nothing was touched.
      return NextResponse.json(
        { success: false, error: existing.error || "MiMo config is unreadable — nothing was reset", removed: 0 },
        { status: 409 },
      );
    }

    const config = existing.data && typeof existing.data === "object" ? existing.data : {};
    const configPath = existing.configPath;
    if (!configPath) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    if (modelToRemove && config.provider?.[AFROUTER_PROVIDER_ID]?.models) {
      delete config.provider[AFROUTER_PROVIDER_ID].models[modelToRemove];

      if (Object.keys(config.provider[AFROUTER_PROVIDER_ID].models).length === 0) {
        delete config.provider[AFROUTER_PROVIDER_ID];
        if (config.model?.startsWith(`${AFROUTER_PROVIDER_ID}/`)) delete config.model;
      } else if (config.model === modelSelection(modelToRemove)) {
        const remainingModels = Object.keys(config.provider[AFROUTER_PROVIDER_ID].models);
        config.model = modelSelection(remainingModels[0]);
      }
    } else {
      if (config.provider) delete config.provider[AFROUTER_PROVIDER_ID];
      if (config.model?.startsWith(`${AFROUTER_PROVIDER_ID}/`)) delete config.model;
    }

    await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, { secret: true });

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "AFRouter settings removed from MiMo Code",
    });
  } catch (error) {
    console.log("Error resetting mimocode settings:", error);
    return NextResponse.json({ error: "Failed to reset mimocode settings" }, { status: 500 });
  }
}