"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { specForCli } from "@/lib/cliModelSpec.js";
import { resolveCliApiKey } from "../resolveApiKey.js";
import {
  parseConfigText,
  writeWithBackup,
} from "@/lib/cliConfigIO.js";

const execAsync = promisify(exec);

const VENDOR = "AFRouter";

// WorkBuddy shares CodeBuddy's models.json format (TinyFish research):
// user-level ~/.workbuddy/models.json, project-level <project>/.workbuddy/models.json,
// { models: [{ id, name, vendor, apiKey, url (full path ending /chat/completions),
//   supportsToolCall, supportsImages, ... }], availableModels?: [id] }.
// Only OpenAI-format APIs are supported; the file hot-reloads (~1s debounce).
// availableModels gates the picker: POST registers written ids additively (only
// when the key already exists — absent means no gating), DELETE prunes removed ids.
// WorkBuddy writes the current CLI's custom models to ~/.workbuddy/models.json;
// the official codebuddy.ai docs page (updated 2026-09-30) documents
// ~/.workbuddy-ai/models.json. When both exist the newer directory wins, so both
// are read and only the one that already exists is written.
const CONFIG_DIRS = [
  () => path.join(os.homedir(), ".workbuddy-ai"),
  () => path.join(os.homedir(), ".workbuddy"),
];

const getConfigCandidates = () => CONFIG_DIRS.map((build) => path.join(build(), "models.json"));

const getConfigPath = async () => {
  const candidates = getConfigCandidates();
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return candidates[0];
};

const checkInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    await execAsync(isWindows ? "where workbuddy" : "which workbuddy", { windowsHide: true });
    return true;
  } catch {
    for (const candidate of getConfigCandidates()) {
      try {
        await fs.access(path.dirname(candidate));
        return true;
      } catch {
        /* try next */
      }
    }
    for (const candidate of getConfigCandidates()) {
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

// ENOENT -> { notInstalled: true }; unparseable -> { corrupt: true }. Never throws.
// The raw text is read directly: readConfig would parse on our behalf and throw,
// which the outer handler would turn into a 500 instead of a 409.
const readConfig = async () => {
  const configPath = await getConfigPath();
  let raw;
  try {
    raw = await fs.readFile(configPath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { notInstalled: true, configPath };
    return { corrupt: true, configPath };
  }
  try {
    const data = parseConfigText(raw, "json", "models.json");
    if (!data || typeof data !== "object" || Array.isArray(data)) return { corrupt: true, configPath };
    return { data, configPath };
  } catch (error) {
    return { corrupt: true, configPath, error: error?.message };
  }
};

const listModels = (config) => {
  const models = config?.models;
  return Array.isArray(models) ? models.filter((m) => m && typeof m.id === "string") : [];
};

// Ownership: vendor === "AFRouter" (the marker AFRouter writes). User models
// with other vendors are never touched by POST/DELETE.
const isOwned = (model) => model?.vendor === VENDOR;

const normalizeChatUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").replace(/\/+$/, "");
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v1$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
};

// One models.json entry. maxInputTokens / maxOutputTokens come from the spec,
// supportsImages from its vision flag, and supportsReasoning plus
// reasoning.supportedEfforts carry the ladder — CodeBuddy's docs state that the
// max/xhigh tiers must be declared in supportedEfforts or they are downgraded
// to high.
const buildEntry = (id, url, key) => {
  const spec = specForCli(id);
  const contextWindow = Math.floor(Number(spec.contextWindow));
  const maxOutput = Math.floor(Number(spec.maxOutput));
  const levels = Array.isArray(spec.levels) ? spec.levels : [];
  return {
    id,
    name: id,
    vendor: VENDOR,
    apiKey: key,
    url,
    supportsToolCall: true,
    supportsImages: spec.vision === true,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { maxInputTokens: contextWindow } : null),
    ...(Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutputTokens: maxOutput } : null),
    ...(spec.reasoning === true ? { supportsReasoning: true } : null),
    ...(spec.reasoning === true && levels.length > 0
      ? {
          reasoning: {
            ...(spec.defaultLevel ? { defaultEffort: spec.defaultLevel } : null),
            supportedEfforts: [...levels],
          },
        }
      : null),
  };
};

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Backup + atomic write via the shared helper, 0600 (the file holds API keys).
const writeConfigAtomic = async (config, configPath) => {
  const { backupPath } = await writeWithBackup(configPath, `${JSON.stringify(config, null, 2)}\n`, { secret: true });
  return { backupPath };
};

export async function GET() {
  try {
    const installed = await checkInstalled();
    const result = await readConfig();
    if (result.notInstalled) {
      return NextResponse.json({
        installed,
        hasAFRouter: false,
        configPath: (await getConfigPath()),
        workbuddy: null,
        message: installed
          ? "WorkBuddy detected but ~/.workbuddy/models.json does not exist yet — Apply will create it"
          : "WorkBuddy is not installed",
      });
    }
    if (result.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath: (await getConfigPath()),
        workbuddy: null,
      });
    }
    const models = listModels(result.data);
    const owned = models.filter(isOwned).map((m) => m.id);
    const urls = [...new Set(models.filter(isOwned).map((m) => m.url).filter(Boolean))];
    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: owned.length > 0,
      configPath: (await getConfigPath()),
      workbuddy: {
        models: models.map((m) => m.id),
        afrouterModels: owned,
        urls,
        availableModels: Array.isArray(result.data.availableModels) ? result.data.availableModels : null,
      },
    });
  } catch (error) {
    console.log("Error checking workbuddy settings:", error);
    return NextResponse.json({ error: "Failed to check workbuddy settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();
    const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }
    const result = await readConfig();
    if (result.corrupt) {
      return NextResponse.json(
        { success: false, error: result.error || "WorkBuddy models.json is unreadable — fix or restore it before applying" },
        { status: 409 }
      );
    }
    const config = result.notInstalled ? {} : result.data;
    const existing = listModels(config);
    const byId = new Map(existing.map((m) => [m.id, m]));
    const url = normalizeChatUrl(baseUrl);
    const key = (await resolveCliApiKey(apiKey)) || "";
    for (const id of modelsArray) {
      const prev = byId.get(id);
      if (prev && typeof prev === "object") {
        // Refresh routing fields on owned entries; never claim user models:
        // an id that exists with another vendor stays byte-identical.
        if (!isOwned(prev)) continue;
        byId.set(id, { ...prev, ...buildEntry(id, url, key) });
      } else if (!prev) {
        byId.set(id, buildEntry(id, url, key));
      }
    }
    config.models = [...byId.values()];
    // availableModels gates what WorkBuddy's picker actually offers: register
    // every written (owned) id additively. Never remove here and never touch
    // the key when absent (absent = no gating) so user-disabled or hand-added
    // models are never enabled or hidden behind the user's back.
    if (Array.isArray(config.availableModels)) {
      const listed = new Set(config.availableModels.filter((id) => typeof id === "string"));
      for (const id of modelsArray) {
        const m = byId.get(id);
        if (m && isOwned(m)) listed.add(id);
      }
      config.availableModels = [...listed];
    }
    const { backupPath } = await writeConfigAtomic(config, result.configPath);
    const skipped = modelsArray.filter((id) => {
      const m = byId.get(id);
      return m && !isOwned(m);
    });
    return NextResponse.json({
      success: true,
      message: "WorkBuddy settings applied successfully! No restart needed — models.json hot-reloads.",
      configPath: (await getConfigPath()),
      backupPath,
      written: modelsArray.filter((id) => !skipped.includes(id)),
      skipped,
    });
  } catch (error) {
    console.log("Error applying workbuddy settings:", error);
    return NextResponse.json({ error: "Failed to apply workbuddy settings" }, { status: 500 });
  }
}

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");
    const result = await readConfig();
    if (result.corrupt) {
      return NextResponse.json(
        { success: false, error: result.error || "WorkBuddy models.json is unreadable — nothing was removed" },
        { status: 409 }
      );
    }
    if (result.notInstalled) {
      return NextResponse.json({ success: true, message: "No WorkBuddy config to reset", removed: 0 });
    }
    const config = result.data;
    const existing = listModels(config);
    let removed = 0;
    const removedIds = [];
    config.models = existing.filter((m) => {
      const matches = modelToRemove ? m.id === modelToRemove : true;
      if (matches && isOwned(m)) {
        removed++;
        removedIds.push(m.id);
        return false;
      }
      return true;
    });
    // Prune removed ids from availableModels so WorkBuddy stops offering them.
    // Other entries are left untouched.
    if (removed > 0 && Array.isArray(config.availableModels)) {
      const gone = new Set(removedIds);
      config.availableModels = config.availableModels.filter((id) => !gone.has(id));
    }
    if (removed > 0) {
      const { backupPath } = await writeConfigAtomic(config, result.configPath);
      return NextResponse.json({
        success: true,
        message: modelToRemove
          ? `Removed ${modelToRemove} from WorkBuddy`
          : `Removed ${removed} AFRouter model${removed === 1 ? "" : "s"} from WorkBuddy`,
        removed,
        backupPath,
      });
    }
    return NextResponse.json({ success: true, message: "No AFRouter models in WorkBuddy config", removed: 0 });
  } catch (error) {
    console.log("Error resetting workbuddy settings:", error);
    return NextResponse.json({ error: "Failed to reset workbuddy settings" }, { status: 500 });
  }
}
