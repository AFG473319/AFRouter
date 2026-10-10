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

export const FORGE_PROVIDER_ID = "afrouter";
export const FORGE_API_KEY_VAR = "AFROUTER_API_KEY";
// tailcallhq/forgecode crates/forge_config/src/reader.rs: base is $FORGE_CONFIG,
// else ~/forge when it exists (legacy), else ~/.forge; file is .forge.toml.
export const getForgeBaseDir = async () => {
  if (process.env.FORGE_CONFIG) return process.env.FORGE_CONFIG;
  const legacy = path.join(os.homedir(), "forge");
  try {
    await fs.access(legacy);
    return legacy;
  } catch {
    return path.join(os.homedir(), ".forge");
  }
};
export const getForgeConfigPath = async () => path.join(await getForgeBaseDir(), ".forge.toml");

const checkForgeInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where forge" : "which forge";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(await getForgeConfigPath());
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
    throw new CliConfigParseError("config", String(error?.message || error).split("\n")[0]);
  }
};

const hasAFRouterConfig = (config) => {
  if (!config || typeof config !== "object") return false;
  if (config.session?.provider_id === FORGE_PROVIDER_ID) return true;
  const providers = Array.isArray(config.providers) ? config.providers : [];
  return providers.some((p) => p?.id === FORGE_PROVIDER_ID);
};

const upsertProvider = (config, { baseUrl, model }) => {
  const providers = Array.isArray(config.providers) ? [...config.providers] : [];
  const url = `${normalizeBaseUrl(baseUrl)}/chat/completions`;
  const modelId = String(model).trim();
  let spec = {};
  try {
    const slash = modelId.indexOf("/");
    spec = resolveModelSpec(slash > 0 ? modelId.slice(0, slash) : null, slash > 0 ? modelId.slice(slash + 1) : modelId) || {};
  } catch {
    spec = {};
  }
  const context = Math.floor(Number(spec.contextWindow));
  const modelEntry = { id: modelId };
  if (Number.isFinite(context) && context > 0) modelEntry.context_window = context;

  const idx = providers.findIndex((p) => p?.id === FORGE_PROVIDER_ID);
  const entry = {
    ...(idx >= 0 && providers[idx] && typeof providers[idx] === "object" ? providers[idx] : {}),
    id: FORGE_PROVIDER_ID,
    url,
    response_type: "OpenAI",
    api_key_var: FORGE_API_KEY_VAR,
    models: [modelEntry],
  };
  // Preserve other models the user added by hand on our entry.
  if (idx >= 0 && Array.isArray(providers[idx]?.models)) {
    const existing = providers[idx].models.filter((m) => m?.id && m.id !== modelId);
    entry.models = [...existing, modelEntry];
  }
  if (idx >= 0) providers[idx] = entry;
  else providers.push(entry);
  config.providers = providers;
  config.session = { ...(config.session && typeof config.session === "object" ? config.session : {}) };
  config.session.provider_id = FORGE_PROVIDER_ID;
  config.session.model_id = modelId;
  return config;
};

const removeProvider = (config) => {
  let removed = 0;
  if (Array.isArray(config.providers)) {
    const before = config.providers.length;
    config.providers = config.providers.filter((p) => p?.id !== FORGE_PROVIDER_ID);
    removed = before - config.providers.length;
    if (config.providers.length === 0) delete config.providers;
  }
  if (config.session?.provider_id === FORGE_PROVIDER_ID) {
    delete config.session.provider_id;
    delete config.session.model_id;
    if (Object.keys(config.session).length === 0) delete config.session;
  }
  return { config, removed };
};

export async function GET() {
  try {
    const installed = await checkForgeInstalled();
    const configPath = await getForgeConfigPath();
    if (!installed) {
      return NextResponse.json({ installed: false, config: null, message: "ForgeCode CLI is not installed" });
    }
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
    const { baseUrl, model } = rawBody || {};
    if (!baseUrl || !model) {
      return NextResponse.json({ error: { message: "baseUrl and model are required" } }, { status: 400 });
    }
    const configPath = await getForgeConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const { exists, raw } = await readConfig(configPath, "toml");
    const config = exists ? parseTomlStrict(raw) : {};
    const next = upsertProvider(config && typeof config === "object" ? config : {}, { baseUrl, model });
    await writeWithBackup(configPath, stringifyTOML(next));
    return NextResponse.json({
      success: true,
      message: `ForgeCode settings applied successfully! Export ${FORGE_API_KEY_VAR} with your AFRouter key before running forge.`,
      configPath,
    });
  } catch (err) {
    if (err instanceof CliConfigParseError) {
      return NextResponse.json({ error: { message: err.message } }, { status: 409 });
    }
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = await getForgeConfigPath();
    const { exists, raw } = await readConfig(configPath, "toml");
    if (!exists) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    let config;
    try {
      config = parseTomlStrict(raw);
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: { message: error.message } }, { status: 409 });
      }
      throw error;
    }
    const { removed } = removeProvider(config);
    if (removed === 0 && !config.session) {
      return NextResponse.json({ success: true, message: "AFRouter removed from ForgeCode" });
    }
    if (Object.keys(config).length === 0) {
      await fs.rm(configPath, { force: true });
    } else {
      await writeWithBackup(configPath, stringifyTOML(config));
    }
    return NextResponse.json({ success: true, message: "AFRouter removed from ForgeCode" });
  } catch (err) {
    if (err instanceof CliConfigParseError) {
      return NextResponse.json({ error: { message: err.message } }, { status: 409 });
    }
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
