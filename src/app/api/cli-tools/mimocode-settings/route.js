"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";

const execAsync = promisify(exec);

const CONFIG_NAMES = ["mimocode.jsonc", "mimocode.json", "config.json"];

const getConfigDir = () => {
  if (process.env.MIMOCODE_HOME) return process.env.MIMOCODE_HOME;
  return path.join(os.homedir(), ".config", "mimocode");
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

const getConfigPath = () => {
  const dir = getConfigDir();
  return path.join(dir, CONFIG_NAMES[0]);
};

// MiMo Code is an OpenCode fork: the config is JSONC (comments + trailing
// commas) but can also be plain JSON. Strip BOM, string-aware comments and
// trailing commas before parsing so URLs inside strings survive.
const parseJsonc = (content) => {
  let inString = false;
  let out = "";
  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    const next = content[i + 1];
    if (inString) {
      out += c;
      if (c === "\\") { out += next || ""; i++; }
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === "/" && next === "/") {
      while (i < content.length && content[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < content.length && !(content[i] === "*" && content[i + 1] === "/")) i++;
      i++;
      out += "\n";
      continue;
    }
    out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
};

const readConfig = async () => {
  try {
    const configPath = await resolveExistingConfigPath();
    if (!configPath) return { content: null, configPath };
    const content = await fs.readFile(configPath, "utf-8");
    return { content, configPath, data: parseJsonc(content.replace(/^\uFEFF/, "")) };
  } catch (error) {
    if (error.code === "ENOENT") return { content: null, configPath: null };
    return { content: null, configPath: null, corrupt: true };
  }
};

const hasAFRouterConfig = (config) => {
  if (!config?.provider) return false;
  return !!config.provider["afrouter"];
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

    const providerConfig = config?.provider?.["afrouter"];
    const modelMap = providerConfig?.models || {};

    return NextResponse.json({
      installed: true,
      corrupt: false,
      config,
      hasAFRouter: hasAFRouterConfig(config),
      configPath,
      mimocode: {
        models: Object.keys(modelMap),
        activeModel: config?.model?.startsWith("afrouter/") ? config.model.replace(/^afrouter\//, "") : null,
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

    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);

    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const existing = await readConfig();
    if (existing.corrupt) {
      return NextResponse.json({ success: false, error: "MiMo config is unreadable — fix or restore mimocode.jsonc before applying" }, { status: 409 });
    }

    const config = existing.data && typeof existing.data === "object" ? existing.data : {};
    const configPath = existing.configPath || getConfigPath();
    const configDir = path.dirname(configPath);

    await fs.mkdir(configDir, { recursive: true });

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = apiKey || "sk_afrouter";

    if (!config.provider) config.provider = {};

    const existingProvider = config.provider["afrouter"] || {
      name: "AFRouter",
      npm: "@ai-sdk/openai-compatible",
      only_configured_models: true,
      options: {},
      models: {},
    };

    existingProvider.options = {
      ...existingProvider.options,
      baseURL: normalizedBaseUrl,
      apiKey: keyToUse,
    };

    existingProvider.models = existingProvider.models || {};

    for (const m of modelsArray) {
      if (!m || typeof m !== "string") continue;
      const existing = existingProvider.models[m];
      // Additively merge: preserve user-tuned fields (name, tool_call,
      // reasoning, limit) on already-present entries (mirrors FR-005).
      if (existing && typeof existing === "object") {
        existingProvider.models[m] = {
          ...existing,
          modalities: existing.modalities || { input: ["text", "image"], output: ["text"] },
        };
      } else {
        existingProvider.models[m] = { name: m, modalities: { input: ["text", "image"], output: ["text"] } };
      }
    }

    config.provider["afrouter"] = existingProvider;

    if (activeModel === "") {
      config.model = "";
    } else {
      const finalActive = activeModel || modelsArray[0];
      if (finalActive) {
        config.model = `afrouter/${finalActive}`;
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: "MiMo Code settings applied successfully!",
      configPath,
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
      if (config.model?.startsWith("afrouter/")) {
        config.model = "";
      }
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

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
      return NextResponse.json({ success: true, message: "MiMo config unreadable — nothing reset", removed: 0 });
    }

    const config = existing.data && typeof existing.data === "object" ? existing.data : {};
    const configPath = existing.configPath;
    if (!configPath) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    if (modelToRemove && config.provider?.["afrouter"]?.models) {
      delete config.provider["afrouter"].models[modelToRemove];

      if (Object.keys(config.provider["afrouter"].models).length === 0) {
        delete config.provider["afrouter"];
        if (config.model?.startsWith("afrouter/")) delete config.model;
      } else if (config.model === `afrouter/${modelToRemove}`) {
        const remainingModels = Object.keys(config.provider["afrouter"].models);
        config.model = `afrouter/${remainingModels[0]}`;
      }
    } else {
      if (config.provider) delete config.provider["afrouter"];
      if (config.model?.startsWith("afrouter/")) delete config.model;
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    return NextResponse.json({
      success: true,
      message: modelToRemove ? `Model "${modelToRemove}" removed` : "AFRouter settings removed from MiMo Code",
    });
  } catch (error) {
    console.log("Error resetting mimocode settings:", error);
    return NextResponse.json({ error: "Failed to reset mimocode settings" }, { status: 500 });
  }
}