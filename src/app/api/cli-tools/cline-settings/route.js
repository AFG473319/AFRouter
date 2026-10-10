"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  CliConfigParseError,
  parseConfigText,
  readConfig,
  writeWithBackup,
} from "@/lib/cliConfigIO.js";

const execAsync = promisify(exec);

export const CLINE_PROVIDER_ID = "openai-compatible";

// Cline keeps provider settings for the extension, CLI and SDK in one file:
// ~/.cline/data/settings/providers.json (docs.cline.bot/getting-started/config,
// docs.cline.bot/cli/cli-reference). Env overrides: CLINE_DATA_DIR replaces
// ~/.cline/data, CLINE_DIR replaces ~/.cline (composition CLINE_DIR/data is
// our fallback; docs never state it explicitly).
export const getDataDir = () => {
  if (process.env.CLINE_DATA_DIR) return process.env.CLINE_DATA_DIR;
  if (process.env.CLINE_DIR) return path.join(process.env.CLINE_DIR, "data");
  return path.join(os.homedir(), ".cline", "data");
};
export const getProvidersPath = () => path.join(getDataDir(), "settings", "providers.json");

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where cline" : "which cline";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getProvidersPath());
      return true;
    } catch {
      try {
        await fs.access(getDataDir());
        return true;
      } catch {
        return false;
      }
    }
  }
};

const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
};

const readProvidersEntry = (doc) => doc?.providers?.[CLINE_PROVIDER_ID] || null;

export const hasAFRouterConfig = (doc) => {
  const entry = readProvidersEntry(doc);
  if (!entry) return false;
  const baseUrl = entry?.settings?.baseUrl || "";
  return baseUrl.includes("localhost") || baseUrl.includes("127.0.0.1") || baseUrl.includes("afrouter");
};

const toSettings = (doc) => {
  const entry = readProvidersEntry(doc);
  const settings = entry?.settings || {};
  return {
    provider: settings.provider || null,
    baseUrl: settings.baseUrl || null,
    model: settings.model || null,
    // Legacy aliases the card read from globalState.json.
    actModeOpenAiModelId: settings.model || null,
    planModeOpenAiModelId: settings.model || null,
    openAiBaseUrl: settings.baseUrl || null,
  };
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    const providersPath = getProvidersPath();
    if (!installed) {
      return NextResponse.json({ installed: false, settings: null, message: "Cline CLI is not installed" });
    }
    const { exists, raw } = await readConfig(providersPath, "json");
    if (!exists) {
      return NextResponse.json({ installed: true, settings: null, hasAFRouter: false, providersPath });
    }
    let doc;
    try {
      doc = parseConfigText(raw, "json", "providers.json");
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json(
          { installed: true, corrupt: true, settings: null, hasAFRouter: false, providersPath },
          { status: 409 },
        );
      }
      throw error;
    }
    return NextResponse.json({
      installed: true,
      settings: toSettings(doc),
      hasAFRouter: hasAFRouterConfig(doc),
      providersPath,
    });
  } catch (error) {
    console.log("Error checking cline settings:", error);
    return NextResponse.json({ error: "Failed to check cline settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model } = await request.json();
    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const providersPath = getProvidersPath();
    await fs.mkdir(path.dirname(providersPath), { recursive: true });

    const { exists, raw } = await readConfig(providersPath, "json");
    const doc = exists
      ? parseConfigText(raw || "{}", "json", "providers.json")
      : {};
    const current = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};

    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    const keyToUse = await resolveCliApiKey(apiKey);
    const now = new Date().toISOString();
    const previous = current.providers?.[CLINE_PROVIDER_ID];
    const previousSettings = previous?.settings && typeof previous.settings === "object" ? previous.settings : {};
    current.version = current.version ?? 1;
    current.lastUsedProvider = CLINE_PROVIDER_ID;
    current.providers = current.providers && typeof current.providers === "object" ? current.providers : {};
    current.providers[CLINE_PROVIDER_ID] = {
      ...(previous && typeof previous === "object" ? previous : {}),
      settings: {
        ...previousSettings,
        provider: CLINE_PROVIDER_ID,
        apiKey: keyToUse,
        model: String(model).trim(),
        baseUrl: normalizedBaseUrl,
        headers: previousSettings.headers && typeof previousSettings.headers === "object" ? previousSettings.headers : {},
      },
      updatedAt: previous?.updatedAt || now,
      tokenSource: previous?.tokenSource || "manual",
    };

    await writeWithBackup(providersPath, `${JSON.stringify(current, null, 2)}\n`, { secret: true });
    return NextResponse.json({ success: true, message: "Cline settings applied successfully!", providersPath });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error updating cline settings:", error);
    return NextResponse.json({ error: "Failed to update cline settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const providersPath = getProvidersPath();
    const { exists, raw } = await readConfig(providersPath, "json");
    if (!exists) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    let current;
    try {
      current = parseConfigText(raw, "json", "providers.json");
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    if (!current?.providers?.[CLINE_PROVIDER_ID]) {
      return NextResponse.json({ success: true, message: "AFRouter settings removed from Cline" });
    }
    delete current.providers[CLINE_PROVIDER_ID];
    if (current.lastUsedProvider === CLINE_PROVIDER_ID) delete current.lastUsedProvider;
    if (current.providers && Object.keys(current.providers).length === 0) delete current.providers;
    await writeWithBackup(providersPath, `${JSON.stringify(current, null, 2)}\n`, { secret: true });
    return NextResponse.json({ success: true, message: "AFRouter settings removed from Cline" });
  } catch (error) {
    if (error instanceof CliConfigParseError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.log("Error resetting cline settings:", error);
    return NextResponse.json({ error: "Failed to reset cline settings" }, { status: 500 });
  }
}
