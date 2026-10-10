"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { parseTOML, stringifyTOML } from "confbox";
import { CliConfigParseError, readConfig, writeWithBackup } from "@/lib/cliConfigIO.js";

const execAsync = promisify(exec);

export const CODEWHALE_PROVIDER_ID = "afrouter";
// codewhale-hq/Codewhale docs/CONFIGURATION.md ("Where It Looks"): default
// ~/.codewhale/config.toml, legacy fallback ~/.deepseek/config.toml,
// overrides CLI --config, env CODEWHALE_CONFIG_PATH, legacy DEEPSEEK_CONFIG_PATH.
export const getCodewhaleConfigPath = () => {
  if (process.env.CODEWHALE_CONFIG_PATH) return process.env.CODEWHALE_CONFIG_PATH;
  if (process.env.DEEPSEEK_CONFIG_PATH) return process.env.DEEPSEEK_CONFIG_PATH;
  return path.join(os.homedir(), ".codewhale", "config.toml");
};
export const getLegacyConfigPath = () => path.join(os.homedir(), ".deepseek", "config.toml");

const checkCodewhaleInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
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
    return parseTOML(raw);
  } catch (error) {
    throw new CliConfigParseError(file, String(error?.message || error).split("\n")[0]);
  }
};

const readPrimary = async (configPath) => {
  const { exists, raw } = await readConfig(configPath, "toml");
  if (!exists) return { exists: false, raw: "", config: {} };
  return { exists: true, raw, config: parseTomlStrict(raw, "config.toml") };
};

const hasAFRouterConfig = (config) => {
  if (!config || typeof config !== "object") return false;
  if (config.provider === CODEWHALE_PROVIDER_ID) return true;
  return Boolean(config.providers?.[CODEWHALE_PROVIDER_ID]);
};

export async function GET() {
  try {
    const installed = await checkCodewhaleInstalled();
    const configPath = getCodewhaleConfigPath();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "CodeWhale CLI is not installed" });
    }
    const { exists, config } = await readPrimary(configPath).catch((error) => {
      if (error instanceof CliConfigParseError) return { exists: true, config: null, parseError: error };
      throw error;
    });
    if (config === null) {
      return NextResponse.json({ installed: true, corrupt: true, config: null, hasAFRouter: false, configPath }, { status: 409 });
    }
    return NextResponse.json({
      installed: true,
      config: exists ? config : null,
      hasAFRouter: exists ? hasAFRouterConfig(config) : false,
      configPath,
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function POST(request) {
  let rawBody;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: { message: "Invalid JSON body" } }, { status: 400 });
  }

  try {
    const { baseUrl, apiKey, model } = rawBody || {};
    if (!baseUrl || !model) {
      return NextResponse.json({ error: { message: "baseUrl and model are required" } }, { status: 400 });
    }

    const configPath = getCodewhaleConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const { exists, raw, config: parsed } = await readPrimary(configPath);
    const config = parsed && typeof parsed === "object" ? parsed : {};
    void exists;
    void raw;

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const modelId = String(model).trim();
    config.providers = config.providers && typeof config.providers === "object" ? config.providers : {};
    config.providers[CODEWHALE_PROVIDER_ID] = {
      ...(config.providers[CODEWHALE_PROVIDER_ID] && typeof config.providers[CODEWHALE_PROVIDER_ID] === "object"
        ? config.providers[CODEWHALE_PROVIDER_ID]
        : {}),
      kind: "openai-compatible",
      base_url: normalizedBaseUrl,
      api_key: await resolveCliApiKey(apiKey),
      model: modelId,
    };
    config.provider = CODEWHALE_PROVIDER_ID;
    config.default_text_model = modelId;

    await writeWithBackup(configPath, stringifyTOML(config));

    return NextResponse.json({ success: true, message: "CodeWhale settings applied successfully!", configPath });
  } catch (err) {
    if (err instanceof CliConfigParseError) {
      return NextResponse.json({ error: { message: err.message } }, { status: 409 });
    }
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getCodewhaleConfigPath();
    const { exists, config } = await readPrimary(configPath);
    if (!exists) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    if (config.providers) delete config.providers[CODEWHALE_PROVIDER_ID];
    if (config.providers && Object.keys(config.providers).length === 0) delete config.providers;
    if (config.provider === CODEWHALE_PROVIDER_ID) delete config.provider;
    if (typeof config.default_text_model === "string") delete config.default_text_model;

    if (Object.keys(config).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await writeWithBackup(configPath, stringifyTOML(config));
    }
    return NextResponse.json({ success: true, message: "AFRouter removed from CodeWhale" });
  } catch (err) {
    if (err instanceof CliConfigParseError) {
      return NextResponse.json({ error: { message: err.message } }, { status: 409 });
    }
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
