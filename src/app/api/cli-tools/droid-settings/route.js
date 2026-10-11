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

const execAsync = promisify(exec);

const getDroidDir = () => path.join(os.homedir(), ".factory");
const getDroidSettingsPath = () => path.join(getDroidDir(), "settings.json");

// Check if droid CLI is installed (via which/where or config file exists)
const checkDroidInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where droid" : "which droid";
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    try {
      await fs.access(getDroidSettingsPath());
      return true;
    } catch {
      return false;
    }
  }
};

// Read current settings.json
const readSettings = async () => {
  try {
    const settingsPath = getDroidSettingsPath();
    const content = await fs.readFile(settingsPath, "utf-8");
    // Tolerate JSONC (trailing commas) and treat unparseable files as "no config"
    // rather than throwing a 500 that the UI misreads as "tool not installed".
    const stripped = content.replace(/,(\s*[}\]])/g, "$1");
    return JSON.parse(stripped);
  } catch (error) {
    return null;
  }
};

// Check if settings has AFRouter customModels
const hasAFRouterConfig = (settings) => {
  if (!settings || !settings.customModels) return false;
  return settings.customModels.some(m => m.id?.startsWith("custom:AFRouter"));
};

// GET - Check droid CLI and read current settings
export async function GET() {
  try {
    const isInstalled = await checkDroidInstalled();
    
    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        message: "Factory Droid CLI is not installed",
      });
    }

    const settings = await readSettings();

    return NextResponse.json({
      installed: true,
      settings,
      hasAFRouter: hasAFRouterConfig(settings),
      settingsPath: getDroidSettingsPath(),
    });
  } catch (error) {
    console.log("Error checking droid settings:", error);
    return NextResponse.json({ error: "Failed to check droid settings" }, { status: 500 });
  }
}

// POST - Update AFRouter customModels (merge with existing settings)
// Accepts either `model` (string, legacy single-model) or `models` (array of strings, multi-model)
// Also accepts `activeModel` to set which model is active/primary
export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, models, activeModel } = await request.json();
    
    // Accept either `models` (array) or `model` (string, legacy)
    const modelsArray = Array.isArray(models) ? models.slice() : (typeof model === "string" ? [model] : []);
    
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const droidDir = getDroidDir();
    const settingsPath = getDroidSettingsPath();

    // Ensure directory exists
    await fs.mkdir(droidDir, { recursive: true });

    // Read existing settings through the shared parser: an unparseable
    // settings.json aborts with 409 instead of being silently overwritten.
    let settings = {};
    try {
      const { exists, raw } = await readConfig(settingsPath, "json");
      if (exists) {
        const parsed = parseConfigText(raw, "json", "settings.json");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
      }
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    // Ensure customModels array exists
    if (!settings.customModels) {
      settings.customModels = [];
    }

    // Remove all existing AFRouter configs
    settings.customModels = settings.customModels.filter(m => !m.id?.startsWith("custom:AFRouter"));

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const keyToUse = (await resolveCliApiKey(apiKey)) || "";

    // Determine active model: prefer explicit activeModel, else first of modelsArray
    // If activeModel is explicitly empty string, no model will be set as default
    let defaultIndex = 0;
    if (typeof activeModel === "string") {
      if (activeModel === "") {
        defaultIndex = -1; // signal: don't set a default
      } else {
        const idx = modelsArray.indexOf(activeModel);
        defaultIndex = idx >= 0 ? idx : 0;
      }
    }

    // Add entries for all requested models
    // The first one (index 0) will be the default if defaultIndex >= 0
    for (let i = 0; i < modelsArray.length; i++) {
      const m = modelsArray[i];
      if (!m || typeof m !== "string") continue;
      const spec = specForCli(m);
      const maxOutput = Math.floor(Number(spec.maxOutput));
      const normalizedKey = keyToUse.trim();
      settings.customModels.push({
        model: m,
        id: `custom:AFRouter-${i}`,
        index: i,
        baseUrl: normalizedBaseUrl,
        // Never write the placeholder: Droid sends it as a bearer token and the
        // upstream answers 401. An empty omits the field entirely.
        ...(normalizedKey ? { apiKey: normalizedKey } : null),
        displayName: m,
        maxOutputTokens: Number.isFinite(maxOutput) && maxOutput > 0 ? maxOutput : 131072,
        noImageSupport: spec.vision !== true,
        // docs.factory.ai/model-independence/byok: "generic-chat-completion-api"
        // speaks OpenAI Chat Completions; "openai" means the Responses API on
        // OpenAI's own endpoint. AFRouter serves /v1/chat/completions.
        provider: "generic-chat-completion-api",
      });
    }

    // Set default model if applicable
    if (defaultIndex >= 0 && modelsArray[defaultIndex]) {
      const defaultId = `custom:AFRouter-${defaultIndex}`;
      const defaultIndexInList = settings.customModels.findIndex((m) => m?.id === defaultId);
      const defaultEntry = settings.customModels[defaultIndexInList]
        || settings.customModels.find((m) => m?.model === modelsArray[defaultIndex] && String(m?.id || "").startsWith("custom:AFRouter"));
      if (defaultEntry && defaultIndexInList >= 0) {
        // Move only OUR entry to the front; the user's own models keep their
        // position and are never given an `index` they did not ask for.
        settings.customModels.splice(defaultIndexInList, 1);
        const all = [{ ...defaultEntry, index: 0 }, ...settings.customModels];
        let next = 1;
        for (const m of all) {
          if (String(m?.id || "").startsWith("custom:AFRouter") && m !== defaultEntry) m.index = next++;
        }
        settings.customModels = all;
        // The top-level `model` key is what actually starts Droid on this model;
        // array order alone does not select it (docs.factory.com/droid-cli/settings).
        settings.model = defaultEntry.model;
      }
    } else if (defaultIndex === -1) {
      delete settings.model;
    }

    // Write settings (backup + atomic, 0600 — settings.json holds the API key)
    await writeWithBackup(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { secret: true });

    return NextResponse.json({
      success: true,
      message: "Factory Droid settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    console.log("Error updating droid settings:", error);
    return NextResponse.json({ error: "Failed to update droid settings" }, { status: 500 });
  }
}

// DELETE - Remove AFRouter customModels only (keep other settings)
export async function DELETE() {
  try {
    const settingsPath = getDroidSettingsPath();

    // Read existing settings
    let settings = {};
    let existed = false;
    // Model ids we are about to drop, so the active-model check can tell ours
    // from the user's own.
    let modelIdsWeOwn = new Set();
    try {
      const { exists, raw } = await readConfig(settingsPath, "json");
      existed = exists;
      if (exists) {
        const parsed = parseConfigText(raw, "json", "settings.json");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) settings = parsed;
      }
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    if (!existed) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }

    if (Array.isArray(settings.customModels)) {
      modelIdsWeOwn = new Set(
        settings.customModels.filter((m) => m?.id?.startsWith("custom:AFRouter")).map((m) => m?.model),
      );
    }

    // Remove AFRouter customModels
    if (settings.customModels) {
      settings.customModels = settings.customModels.filter(m => !m.id?.startsWith("custom:AFRouter"));

      // Remove customModels array if empty
      if (settings.customModels.length === 0) {
        delete settings.customModels;
      }
    }

    // Only drop the active model when it still points at one of ours.
    if (typeof settings.model === "string" && modelIdsWeOwn.has(settings.model)) {
      delete settings.model;
    }

    // Write updated settings
    await writeWithBackup(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { secret: true });

    return NextResponse.json({
      success: true,
      message: "AFRouter settings removed successfully",
    });
  } catch (error) {
    console.log("Error resetting droid settings:", error);
    return NextResponse.json({ error: "Failed to reset droid settings" }, { status: 500 });
  }
}