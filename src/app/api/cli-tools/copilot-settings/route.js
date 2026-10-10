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
import fs from "fs/promises";
import path from "path";
import os from "os";

// VS Code reads chatLanguageModels.json from the active profile's root, which is
// <userDataDir>/User (microsoft/vscode userDataProfile.ts languageModelsResource).
// Non-default profiles, portable installs and Insiders live elsewhere; this is
// the default profile path for each OS.
export const getConfigPath = () => {
  const home = os.homedir();
  const platform = os.platform();
  if (platform === "win32") {
    return path.join(process.env.APPDATA || home, "Code", "User", "chatLanguageModels.json");
  }
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Code", "User", "chatLanguageModels.json");
  }
  return path.join(home, ".config", "Code", "User", "chatLanguageModels.json");
};

export const PROVIDER_NAME = "AFRouter";

// A VS Code settings.json-style file may carry trailing commas, so it goes through
// the shared parser: an unparseable file aborts with 409 instead of being wiped
// (which used to destroy the user's other BYOK providers).
const readEntries = async (configPath) => {
  const { exists, raw } = await readConfig(configPath, "json");
  if (!exists) return [];
  const parsed = parseConfigText(raw, "json", "chatLanguageModels.json");
  return Array.isArray(parsed) ? parsed : [];
};

const buildModelEntry = (id) => {
  const spec = specForCli(id);
  const contextWindow = Math.floor(Number(spec.contextWindow));
  const maxOutput = Math.floor(Number(spec.maxOutput));
  const levels = Array.isArray(spec.levels) ? spec.levels : [];
  return {
    id,
    name: id,
    // url is filled in by buildEntry, which knows the normalized base URL.
    url: "",
    toolCalling: true,
    vision: spec.vision === true,
    maxInputTokens: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
    maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 16384,
    // Documented keys: `thinking` is a boolean capability flag and
    // `supportsReasoningEffort` is the array that makes VS Code show the
    // Thinking Effort picker. Only written when the model actually reasons.
    ...(spec.reasoning === true ? { thinking: true } : null),
    ...(spec.reasoning === true && levels.length > 0 ? { supportsReasoningEffort: [...levels] } : null),
  };
};

const buildEntry = (baseUrl, apiKey, models) => {
  const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
  return {
    name: PROVIDER_NAME,
    // Documented BYOK provider for any OpenAI-compatible endpoint. `vendor: "azure"`
    // routed through AzureBYOKModelProvider, which only accepted the URL because
    // `resolveAzureUrl` short-circuits on an explicit /chat/completions path — the
    // "#models.ai.azure.com" fragment was never read.
    vendor: "customendpoint",
    apiType: "chat-completions",
    apiKey,
    models: models.map((id) => {
      const entry = buildModelEntry(id);
      entry.url = `${normalizedBaseUrl}/chat/completions`;
      return entry;
    }),
  };
};

export const hasAFRouterConfig = (config) => Array.isArray(config) && config.some((entry) => entry?.name === PROVIDER_NAME);

export async function GET() {
  try {
    const configPath = getConfigPath();
    let config = [];
    let corrupt = false;
    try {
      config = await readEntries(configPath);
    } catch (error) {
      if (!(error instanceof CliConfigParseError)) throw error;
      corrupt = true;
    }
    const entry = corrupt ? null : (config.find((e) => e?.name === PROVIDER_NAME) || null);
    return NextResponse.json({
      installed: true,
      corrupt,
      config: corrupt ? null : config,
      hasAFRouter: hasAFRouterConfig(config),
      configPath,
      currentModel: entry?.models?.[0]?.id || null,
      currentUrl: entry?.models?.[0]?.url || null,
    });
  } catch (error) {
    console.log("Error checking copilot settings:", error);
    return NextResponse.json({ error: "Failed to check copilot settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();
    if (!baseUrl || !Array.isArray(models) || models.length === 0) {
      return NextResponse.json({ error: "baseUrl and models are required" }, { status: 400 });
    }

    const configPath = getConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const existing = await readEntries(configPath);
    const keyToUse = await resolveCliApiKey(apiKey);

    const newEntry = buildEntry(baseUrl, keyToUse, models);
    const idx = existing.findIndex((e) => e?.name === PROVIDER_NAME);
    if (idx >= 0) existing[idx] = newEntry;
    else existing.push(newEntry);

    await writeWithBackup(configPath, `${JSON.stringify(existing, null, 2)}\n`, { secret: true });
    return NextResponse.json({
      success: true,
      message: "Copilot settings applied! Reload VS Code to take effect.",
      configPath,
    });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error updating copilot settings:", error);
    return NextResponse.json({ error: "Failed to update copilot settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getConfigPath();
    let existing;
    try {
      existing = await readEntries(configPath);
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    const next = existing.filter((e) => e?.name !== PROVIDER_NAME);
    // Keep other BYOK providers; an emptied array is a valid reset state.
    await writeWithBackup(configPath, `${JSON.stringify(next, null, 2)}\n`, { secret: true });
    return NextResponse.json({ success: true, message: "AFRouter removed from Copilot config" });
  } catch (error) {
    console.log("Error resetting copilot settings:", error);
    return NextResponse.json({ error: "Failed to reset copilot settings" }, { status: 500 });
  }
}
