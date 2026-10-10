"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { resolveModelSpec } from "../../../../../open-sse/providers/modelSpecs.js";
import {
  AFROUTER_PROVIDER_ID,
  buildModelEntry,
  buildProviderEntry,
} from "@/lib/opencodeConfig.js";
import { getKiloConfigPath } from "@/lib/cliPaths.js";
import {
  CliConfigParseError,
  editJsoncText,
  parseConfigText,
  readConfig,
  writeWithBackup,
} from "@/lib/cliConfigIO.js";

const execAsync = promisify(exec);

const getConfigPath = () => getKiloConfigPath();

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where kilo" : "which kilo";
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

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

// Kilo is an OpenCode fork: provider.afrouter is the V1 shape
// (npm @ai-sdk/openai-compatible, options { baseURL, apiKey }, models { id: entry }).
// Specs come from the shared resolver so context/output/vision/reasoning and the
// effort ladder stay correct; unknown ids fall back to the conservative floor.
const capsForModel = (id) => {
  const str = String(id || "");
  const slash = str.indexOf("/");
  const provider = slash > 0 ? str.slice(0, slash) : null;
  const model = slash > 0 ? str.slice(slash + 1) : str;
  try {
    return resolveModelSpec(provider, model);
  } catch {
    return { contextWindow: 200000, maxOutput: 64000, vision: false, reasoning: false, tools: true };
  }
};

const hasAFRouterConfig = (config) => Boolean(config?.provider?.[AFROUTER_PROVIDER_ID]);

export async function GET() {
  try {
    const installed = await checkInstalled();
    const configPath = getConfigPath();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Kilo Code CLI is not installed" });
    }
    let raw;
    try {
      raw = await fs.readFile(configPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ installed: true, settings: null, hasAFRouter: false, configPath });
      }
      throw error;
    }
    let config;
    try {
      config = parseConfigText(raw, "json", "kilo.jsonc");
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json(
          { installed: true, corrupt: true, settings: null, hasAFRouter: false, configPath },
          { status: 409 },
        );
      }
      throw error;
    }
    const provider = config?.provider?.[AFROUTER_PROVIDER_ID] || null;
    return NextResponse.json({
      installed: true,
      settings: config ? { model: config.model || null, provider: provider ? Object.keys(provider.models || {}) : [] } : null,
      hasAFRouter: hasAFRouterConfig(config),
      configPath,
    });
  } catch (error) {
    console.log("Error checking kilo settings:", error);
    return NextResponse.json({ error: "Failed to check kilo settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models } = await request.json();
    const modelId = typeof model === "string" && model.trim()
      ? model.trim()
      : Array.isArray(models) && typeof models[0] === "string" ? models[0].trim() : "";
    if (!baseUrl || !modelId) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const configPath = getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    const { exists, raw } = await readConfig(configPath, "json");
    const config = exists ? raw.trim() ? parseConfigText(raw, "json", "kilo.jsonc") : {} : {};
    const current = config && typeof config === "object" && !Array.isArray(config) ? config : {};

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const keyToUse = await resolveCliApiKey(apiKey);
    const sourceProvider = current.provider?.[AFROUTER_PROVIDER_ID] || {};
    const provider = buildProviderEntry("v1", sourceProvider);
    provider.options = { ...(provider.options || {}), baseURL: normalizedBaseUrl, apiKey: keyToUse };
    provider.models = { ...(provider.models || {}) };
    provider.models[modelId] = buildModelEntry(modelId, capsForModel(modelId), "v1");

    const base = exists ? raw : "{}";
    const next = editJsoncText(base, [
      { path: ["provider", AFROUTER_PROVIDER_ID], value: provider },
      { path: ["model"], value: `${AFROUTER_PROVIDER_ID}/${modelId}` },
    ]);
    await writeWithBackup(configPath, next, { secret: true });

    return NextResponse.json({ success: true, message: "Kilo Code settings applied successfully!", configPath });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error updating kilo settings:", error);
    return NextResponse.json({ error: "Failed to update kilo settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getConfigPath();
    const { exists, raw } = await readConfig(configPath, "json").catch((error) => {
      if (error instanceof CliConfigParseError) throw error;
      throw error;
    });
    if (!exists) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    let current;
    try {
      current = parseConfigText(raw, "json", "kilo.jsonc");
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    if (!current?.provider?.[AFROUTER_PROVIDER_ID] && !(typeof current?.model === "string" && current.model.startsWith(`${AFROUTER_PROVIDER_ID}/`))) {
      return NextResponse.json({ success: true, message: "AFRouter settings removed from Kilo Code" });
    }
    const providerMap = { ...(current.provider || {}) };
    delete providerMap[AFROUTER_PROVIDER_ID];
    const edits = [{ path: ["provider", AFROUTER_PROVIDER_ID], value: undefined }];
    if (typeof current.model === "string" && current.model.startsWith(`${AFROUTER_PROVIDER_ID}/`)) {
      edits.push({ path: ["model"], value: undefined });
    }
    // When the provider map empties, drop it so we don't leave "provider": {}.
    let next = editJsoncText(raw, edits);
    if (Object.keys(providerMap).length === 0) {
      next = editJsoncText(next, [{ path: ["provider"], value: undefined }]);
    }
    await writeWithBackup(configPath, next, { secret: true });
    return NextResponse.json({ success: true, message: "AFRouter settings removed from Kilo Code" });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error resetting kilo settings:", error);
    return NextResponse.json({ error: "Failed to reset kilo settings" }, { status: 500 });
  }
}
