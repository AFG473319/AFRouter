"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  ZED_PROVIDER_ID,
  readZedModelIds,
  readZedProvider,
  removeZedProvider,
  stringifyJsonDocument,
  upsertZedProvider,
} from "@/lib/zedConfig.js";

const execAsync = promisify(exec);

// Zed resolves the settings path per-platform.
const getConfigDir = () => {
  const home = os.homedir();
  if (os.platform() === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Zed");
  }
  if (os.platform() === "darwin") {
    return path.join(home, "Library", "Application Support", "Zed");
  }
  return path.join(home, ".config", "zed");
};

const getConfigPath = () => path.join(getConfigDir(), "settings.json");

// Zed's settings.json is JSONC — it supports // and /* */ comments and
// trailing commas as an extension. Strip both before JSON.parse so a
// hand-edited or Zed-written file doesn't read as corrupt.
const stripJsonComments = (text) => {
  let result = "";
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < len && text[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < len && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
    } else if (ch === '"') {
      result += ch;
      i++;
      while (i < len) {
        result += text[i];
        if (text[i] === "\\") {
          i++;
          if (i < len) result += text[i];
        } else if (text[i] === '"') {
          break;
        }
        i++;
      }
      i++;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
};

const stripTrailingCommas = (text) => text.replace(/,(\s*[}\]])/g, "$1");

// Safe JSON read: missing -> { missing: true }; unparseable -> { corrupt: true }.
// Never throws to the handler — the UI must never see a 500 for a bad user file.
const readJson = async (filePath) => {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const cleaned = stripTrailingCommas(stripJsonComments(raw));
    const data = JSON.parse(cleaned);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { corrupt: true };
    return { data };
  } catch {
    return { corrupt: true };
  }
};

// Timestamped backup -> temp file -> atomic rename with EPERM/EACCES retries
// (Windows file-lock races with Zed/AV). Skips the backup when the target does
// not exist, which is the normal first-apply case.
const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

const writeAtomic = async (filePath, content) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let backupPath = null;
  try {
    backupPath = `${filePath}.bak-${timestamp()}`;
    await fs.copyFile(filePath, backupPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    backupPath = null;
  }
  const tmpPath = `${filePath}.tmp`;
  await fs.writeFile(tmpPath, content);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, filePath);
      break;
    } catch (error) {
      if ((error.code === "EPERM" || error.code === "EACCES") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw error;
    }
  }
  return { backupPath };
};

const npmPathEnv = () => {
  const isWindows = process.platform === "win32";
  return isWindows && process.env.APPDATA
    ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH || ""}` }
    : process.env;
};

// Detection: the settings file, the config dir, or a `zed` binary on PATH.
// A settings file may not exist yet on a fresh install — that is
// "installed, not configured", not "not installed".
const checkInstalled = async () => {
  for (const candidate of [getConfigPath(), getConfigDir()]) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      /* try next */
    }
  }
  try {
    const isWindows = process.platform === "win32";
    await execAsync(isWindows ? "where zed" : "which zed", { windowsHide: true, env: npmPathEnv() });
    return true;
  } catch {
    return false;
  }
};

// GET - install + AFRouter routing status
export async function GET() {
  try {
    const installed = await checkInstalled();
    const configPath = getConfigPath();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        configPath,
        zed: null,
        message: "Zed editor is not installed",
      });
    }

    const result = await readJson(configPath);
    if (result.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath,
        zed: null,
      });
    }

    const settings = result.data || {};
    const provider = readZedProvider(settings);
    const models = readZedModelIds(settings);

    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!provider,
      configPath,
      zed: {
        models,
        baseURL: provider?.api_url || null,
        providerCount: isObject(settings?.language_models?.openai_compatible)
          ? Object.keys(settings.language_models.openai_compatible).length
          : 0,
      },
    });
  } catch (error) {
    console.log("Error checking zed settings:", error);
    return NextResponse.json({ error: "Failed to check zed settings" }, { status: 500 });
  }
}

// POST - merge the AFRouter provider into settings.json
export async function POST(request) {
  try {
    const { baseUrl, models } = await request.json();
    const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const configPath = getConfigPath();
    const result = await readJson(configPath);
    if (result.corrupt) {
      return NextResponse.json(
        { success: false, error: "Zed settings.json is unreadable — fix or restore it before applying" },
        { status: 409 },
      );
    }

    const current = result.data || {};
    const next = upsertZedProvider(current, { baseUrl, models: modelsArray });
    const { backupPath } = await writeAtomic(configPath, stringifyJsonDocument(next));

    return NextResponse.json({
      success: true,
      message: "Zed settings applied! Set AFROUTER_API_KEY env var or enter the key in Zed's AI panel, then restart Zed.",
      configPath,
      backupPath,
      written: modelsArray,
    });
  } catch (error) {
    console.log("Error applying zed settings:", error);
    return NextResponse.json({ error: "Failed to apply zed settings" }, { status: 500 });
  }
}

// DELETE - remove the AFRouter provider or specific models from settings.json
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const configPath = getConfigPath();
    const result = await readJson(configPath);
    if (result.missing || result.corrupt) {
      return NextResponse.json({
        success: true,
        message: "No Zed settings.json to reset",
        removed: 0,
        entryRemoved: false,
      });
    }

    const current = result.data || {};
    if (!readZedProvider(current)) {
      return NextResponse.json({
        success: true,
        message: "No AFRouter provider in Zed settings",
        removed: 0,
        entryRemoved: false,
      });
    }

    const { settings: next, removed, entryRemoved } = removeZedProvider(current, modelToRemove);
    await writeAtomic(configPath, stringifyJsonDocument(next));

    return NextResponse.json({
      success: true,
      message: entryRemoved
        ? "AFRouter provider removed from Zed"
        : `Removed ${removed} AFRouter model${removed === 1 ? "" : "s"} from Zed`,
      removed,
      entryRemoved,
    });
  } catch (error) {
    console.log("Error resetting zed settings:", error);
    return NextResponse.json({ error: "Failed to reset zed settings" }, { status: 500 });
  }
}
