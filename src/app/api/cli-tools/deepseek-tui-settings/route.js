"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { specForCli } from "@/lib/cliModelSpec.js";
import {
  CliConfigParseError,
  parseConfigText,
  readConfig,
  writeWithBackup,
} from "@/lib/cliConfigIO.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { stringifyTOML } from "confbox";

const execAsync = promisify(exec);

const PROVIDER_NAME = "afrouter";

// DeepSeek TUI was renamed to CodeWhale, which reads ~/.codewhale/config.toml and
// migrates ~/.deepseek once on first launch (docs/CONFIGURATION.md). Writes to the
// old ~/.deepseek path after that migration are ignored, so this card targets the
// CodeWhale file. CODEWHALE_CONFIG_PATH / DEEPSEEK_CONFIG_PATH still override.
const getCodewhaleDir = () => {
  const explicit = process.env.CODEWHALE_CONFIG_PATH || process.env.DEEPSEEK_CONFIG_PATH;
  return explicit ? path.dirname(explicit) : path.join(os.homedir(), ".codewhale");
};
const getCodewhaleConfigPath = () =>
  process.env.CODEWHALE_CONFIG_PATH
    || process.env.DEEPSEEK_CONFIG_PATH
    || path.join(getCodewhaleDir(), "config.toml");
const getLegacyConfigPath = () => path.join(os.homedir(), ".deepseek", "config.toml");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where codewhale" : "which codewhale";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    for (const candidate of [getCodewhaleConfigPath(), getLegacyConfigPath()]) {
      try {
        await fs.access(candidate);
        return true;
      } catch {
        /* try next */
      }
    }
    return false;
  }
};

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

const parseTomlStrict = (raw, file) => {
  try {
    return parseConfigText(raw, "toml", file);
  } catch (error) {
    if (error instanceof CliConfigParseError) throw error;
    throw new CliConfigParseError(file, String(error?.message || error).split("\n")[0]);
  }
};

const buildProviderEntry = (baseUrl, apiKey, model) => {
  const spec = specForCli(model);
  const contextWindow = Math.floor(Number(spec.contextWindow));
  return {
    kind: "openai-compatible",
    base_url: normalizeBaseUrl(baseUrl),
    api_key: apiKey,
    model,
    // context_window drives CodeWhale's auto-compact timing.
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { context_window: contextWindow } : null),
  };
};

// CodeWhale reads the file through its own loader only when it parses, so a
// corrupt file is reported rather than treated as "no config" and overwritten.
const readPrimary = async () => {
  const file = getCodewhaleConfigPath();
  const { exists, raw } = await readConfig(file, "toml");
  if (!exists) return { exists: false, raw: "", config: {} };
  return { exists: true, raw, config: parseTomlStrict(raw, path.basename(file)) || {} };
};

const hasAFRouterConfig = (config) =>
  config?.provider === PROVIDER_NAME || Boolean(config?.providers?.[PROVIDER_NAME]);

export async function GET() {
  try {
    const installed = await checkInstalled();
    const configPath = getCodewhaleConfigPath();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, hasAFRouter: false, configPath, message: "DeepSeek TUI / CodeWhale is not installed" });
    }
    let result;
    try {
      result = await readPrimary();
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ installed: true, corrupt: true, settings: null, hasAFRouter: false, configPath, error: error.message }, { status: 409 });
      }
      throw error;
    }
    return NextResponse.json({
      installed: true,
      settings: result.config,
      hasAFRouter: result.exists ? hasAFRouterConfig(result.config) : false,
      configPath,
    });
  } catch (error) {
    console.log("Error checking deepseek-tui settings:", error);
    return NextResponse.json({ error: "Failed to check deepseek-tui settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const configPath = getCodewhaleConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const { config } = await readPrimary();
    const doc = config && typeof config === "object" ? config : {};

    doc.providers = doc.providers && typeof doc.providers === "object" ? doc.providers : {};
    doc.providers[PROVIDER_NAME] = buildProviderEntry(baseUrl, await resolveCliApiKey(apiKey), model);
    doc.provider = PROVIDER_NAME;
    doc.default_text_model = model;

    await writeWithBackup(configPath, stringifyTOML(doc), { secret: true });

    return NextResponse.json({
      success: true,
      message: "DeepSeek TUI (CodeWhale) settings applied successfully!",
      configPath,
    });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error updating deepseek-tui settings:", error);
    return NextResponse.json({ error: "Failed to update deepseek-tui settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getCodewhaleConfigPath();
    const { exists, config } = await readPrimary();
    if (!exists) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    // Remove only our entries; never rewrite the whole file to a bare
    // `provider = "deepseek"` (that used to wipe the user's other settings).
    if (config.providers) {
      delete config.providers[PROVIDER_NAME];
      if (Object.keys(config.providers).length === 0) delete config.providers;
    }
    if (config.provider === PROVIDER_NAME) delete config.provider;
    if (typeof config.default_text_model === "string") delete config.default_text_model;

    if (Object.keys(config).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await writeWithBackup(configPath, stringifyTOML(config), { secret: true });
    }
    return NextResponse.json({ success: true, message: `${PROVIDER_NAME} config removed` });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error resetting deepseek-tui settings:", error);
    return NextResponse.json({ error: "Failed to reset deepseek-tui settings" }, { status: 500 });
  }
}