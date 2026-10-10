"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";
import { resolveModelSpec } from "../../../../../open-sse/providers/modelSpecs.js";
import { CliConfigParseError, readConfig, writeWithBackup } from "@/lib/cliConfigIO.js";

const execAsync = promisify(exec);

export const JCODE_PROVIDER_ID = "afrouter";
export const JCODE_API_KEY_ENV = "JCODE_AFROUTER_API_KEY";

export const getJcodeConfigDir = () => path.join(os.homedir(), ".jcode");
// JCODE_HOME relocates the whole config tree (mirrors app_config_dir).
export const getConfigPath = () =>
  process.env.JCODE_HOME
    ? path.join(process.env.JCODE_HOME, "config", "jcode", "config.toml")
    : path.join(getJcodeConfigDir(), "config.toml");

// 1jehuang/jcode crates/jcode-storage/src/lib.rs app_config_dir():
// dirs::config_dir()/jcode — ~/.config/jcode (Linux),
// ~/Library/Application Support/jcode (macOS), %APPDATA%\jcode (Windows);
// JCODE_HOME set → $JCODE_HOME/config/jcode.
export const getAppConfigDir = () => {
  if (process.env.JCODE_HOME) return path.join(process.env.JCODE_HOME, "config", "jcode");
  if (os.platform() === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "jcode");
  }
  if (os.platform() === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "jcode");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "jcode");
};
export const getProviderEnvPath = () => path.join(getAppConfigDir(), "provider-afrouter.env");

const checkJcodeInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where jcode" : "which jcode";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(path.dirname(getConfigPath()));
      return true;
    } catch {
      return false;
    }
  }
};

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

const parseTomlStrict = (raw) => {
  try {
    return parseTOML(raw);
  } catch (error) {
    throw new CliConfigParseError("config.toml", String(error?.message || error).split("\n")[0]);
  }
};

const capsForModel = (id) => {
  const str = String(id || "");
  const slash = str.indexOf("/");
  try {
    return resolveModelSpec(slash > 0 ? str.slice(0, slash) : null, slash > 0 ? str.slice(slash + 1) : str);
  } catch {
    return {};
  }
};

const buildModelEntry = (id) => {
  const caps = capsForModel(id) || {};
  const entry = { id };
  const context = Math.floor(Number(caps.contextWindow));
  if (Number.isFinite(context) && context > 0) entry.context_window = context;
  if (caps.reasoning === true) entry.reasoning = true;
  if (Array.isArray(caps.reasoningLevels) && caps.reasoningLevels.length && caps.defaultLevel) {
    entry.reasoning_effort = caps.defaultLevel;
  }
  entry.input = caps.vision === true ? ["text", "image"] : ["text"];
  return entry;
};

export const hasAFRouterConfig = (config) => Boolean(config?.providers?.[JCODE_PROVIDER_ID]);

const readProviderEnv = async () => {
  try {
    return await fs.readFile(getProviderEnvPath(), "utf-8");
  } catch {
    return "";
  }
};

const upsertEnvValue = (text, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}="${value}"`;
  if (re.test(text)) return text.replace(re, line);
  return text.length > 0 && !text.endsWith("\n") ? `${text}\n${line}\n` : `${text}${line}\n`;
};

const removeEnvValue = (text, key) => text.replace(new RegExp(`^${key}=.*\\r?\\n?`, "m"), "");

export async function GET() {
  const isInstalled = await checkJcodeInstalled();

  if (!isInstalled) {
    return NextResponse.json({
      installed: false,
      message: "jcode not installed. Install via: curl -fsSL https://jcode.sh/install | bash",
    });
  }

  const configPath = getConfigPath();
  const { exists, raw } = await readConfig(configPath, "toml");
  if (!exists) {
    return NextResponse.json({ installed: true, config: null, hasAFRouter: false, configPath });
  }
  let config;
  try {
    config = parseTomlStrict(raw);
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ installed: true, corrupt: true, config: null, hasAFRouter: false, configPath }, { status: 409 });
    }
    throw error;
  }

  return NextResponse.json({ installed: true, config, hasAFRouter: hasAFRouterConfig(config), configPath });
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models, model } = await request.json();
    const modelList = Array.isArray(models)
      ? models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
      : typeof model === "string" && model.trim() ? [model.trim()] : [];

    if (!baseUrl || !apiKey || modelList.length === 0) {
      return NextResponse.json({ error: "baseUrl, apiKey and models are required" }, { status: 400 });
    }

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const configPath = getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const { exists, raw } = await readConfig(configPath, "toml");
    const config = exists ? parseTomlStrict(raw) : {};
    const doc = config && typeof config === "object" ? config : {};

    doc.providers = doc.providers && typeof doc.providers === "object" ? doc.providers : {};
    doc.providers[JCODE_PROVIDER_ID] = {
      ...(doc.providers[JCODE_PROVIDER_ID] && typeof doc.providers[JCODE_PROVIDER_ID] === "object"
        ? doc.providers[JCODE_PROVIDER_ID]
        : {}),
      type: "openai-compatible",
      base_url: normalizedBaseUrl,
      auth: "bearer",
      api_key_env: JCODE_API_KEY_ENV,
      env_file: "provider-afrouter.env",
      default_model: modelList[0],
      requires_api_key: true,
      models: modelList.map(buildModelEntry),
    };
    // Without a default the profile stays inert until --provider-profile afrouter.
    doc.provider = doc.provider && typeof doc.provider === "object" ? doc.provider : {};
    doc.provider.default_provider = JCODE_PROVIDER_ID;
    doc.provider.default_model = modelList[0];

    await writeWithBackup(configPath, stringifyTOML(doc));

    await fs.mkdir(getAppConfigDir(), { recursive: true });
    const envPath = getProviderEnvPath();
    const next = upsertEnvValue(await readProviderEnv(), JCODE_API_KEY_ENV, String(apiKey));
    await writeWithBackup(envPath, next, { secret: true });

    return NextResponse.json({
      success: true,
      message: "jcode configured successfully. Use: jcode --provider-profile afrouter",
      configPath,
    });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error configuring jcode:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getConfigPath();
    const { exists, raw } = await readConfig(configPath, "toml");
    if (exists) {
      const config = parseTomlStrict(raw);
      if (config.providers) delete config.providers[JCODE_PROVIDER_ID];
      if (config.providers && Object.keys(config.providers).length === 0) delete config.providers;
      if (config.provider?.default_provider === JCODE_PROVIDER_ID) delete config.provider.default_provider;
      if (config.provider?.default_model !== undefined) delete config.provider.default_model;
      if (config.provider && Object.keys(config.provider).length === 0) delete config.provider;
      await writeWithBackup(configPath, stringifyTOML(config));
    }

    const envPath = getProviderEnvPath();
    const current = await readProviderEnv();
    if (current.includes(JCODE_API_KEY_ENV)) {
      await writeWithBackup(envPath, removeEnvValue(current, JCODE_API_KEY_ENV), { secret: true });
    }

    return NextResponse.json({ success: true, message: "afrouter configuration removed from jcode" });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("Error removing jcode configuration:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
