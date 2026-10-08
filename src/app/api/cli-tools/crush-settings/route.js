"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

const CRUSH_PROVIDER_ID = "9router";

const getCrushConfigPath = () => {
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "crush", "crush.json");
};

const getCrushDir = () => path.dirname(getCrushConfigPath());

const checkCrushInstalled = async () => {
  const isWindows = os.platform() === "win32";
  try {
    const command = isWindows ? "where crush" : "which crush";
    await execAsync(command, { windowsHide: true });
    return true;
  } catch {
    try {
      await fs.access(getCrushConfigPath());
      return true;
    } catch {
      return false;
    }
  }
};

const has9RouterConfig = (settings) => {
  if (!settings || !settings.providers) return false;
  const p = settings.providers["9router"];
  if (p && p.base_url) return true;
  for (const prov of Object.values(settings.providers)) {
    if (prov.base_url && prov.base_url.includes("20128")) return true;
  }
  return false;
};

const readConfig = async () => {
  try {
    const content = await fs.readFile(getCrushConfigPath(), "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
};

// Backup + atomic write: never leave a half-written crush.json behind.
const writeConfigAtomic = async (config) => {
  const configPath = getCrushConfigPath();
  const text = JSON.stringify(config, null, 2);
  let backupPath = null;
  try {
    await fs.access(configPath);
    backupPath = `${configPath}.bak-${Date.now()}`;
    await fs.copyFile(configPath, backupPath);
  } catch {
    /* No existing config — nothing to back up */
  }
  const tmpPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, text, "utf-8");
  await fs.rename(tmpPath, configPath);
  return backupPath;
};

// Resolved context window for one "provider/model" id, via the shared Part 1
// resolver (finite safe floor when the registry does not know the id — the
// same convention every other tool route uses).
const resolveContextWindow = (id) => {
  const slash = id.indexOf("/");
  const caps = getCapabilitiesForModel(
    slash > 0 ? id.slice(0, slash) : null,
    slash > 0 ? id.slice(slash + 1) : id,
  );
  return Math.floor(caps.contextWindow);
};

export async function GET() {
  try {
    const installed = await checkCrushInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        config: null,
        message: "Crush CLI is not installed",
      });
    }

    const config = await readConfig();

    return NextResponse.json({
      installed: true,
      config,
      has9Router: has9RouterConfig(config),
      configPath: getCrushConfigPath(),
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
    const { baseUrl, apiKey, model, models } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    // Accept a models list (multi-model native: Crush switches between
    // entries without touching AFRouter); `model` stays as legacy fallback.
    const ids = (Array.isArray(models) ? models : [])
      .map((m) => (typeof m === "string" ? m.trim() : m?.id?.trim?.()))
      .filter(Boolean);
    if (model && typeof model === "string" && model.trim()) ids.unshift(model.trim());
    const uniqueIds = [...new Set(ids.length ? ids : ["provider/model-id"])];

    const configPath = getCrushConfigPath();
    await fs.mkdir(getCrushDir(), { recursive: true });

    let existing = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      /* No existing config */
    }

    if (!existing.providers || typeof existing.providers !== "object") existing.providers = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const resolved = uniqueIds.map((id) => ({ id, name: id, context_window: resolveContextWindow(id) }));

    // Additive merge by model id: re-Apply refreshes specs for models already
    // written (matters after a catalog refresh) and is idempotent; entries
    // the user added by hand under our provider are preserved.
    const previous = Array.isArray(existing.providers[CRUSH_PROVIDER_ID]?.models)
      ? existing.providers[CRUSH_PROVIDER_ID].models
      : [];
    const byId = new Map();
    for (const m of previous) {
      if (m && typeof m.id === "string") byId.set(m.id, m);
    }
    for (const m of resolved) byId.set(m.id, m);

    existing.providers[CRUSH_PROVIDER_ID] = {
      type: "openai-compat",
      base_url: normalizedBaseUrl,
      api_key: await resolveCliApiKey(apiKey),
      models: [...byId.values()],
    };

    const backupPath = await writeConfigAtomic(existing);

    return NextResponse.json({
      success: true,
      message: "Crush settings applied successfully!",
      configPath,
      backupPath,
      written: resolved.map((m) => m.id),
    });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const configPath = getCrushConfigPath();
    let existing = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }

    if (existing.providers && existing.providers[CRUSH_PROVIDER_ID]) {
      delete existing.providers[CRUSH_PROVIDER_ID];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
      await writeConfigAtomic(existing);
    }

    return NextResponse.json({ success: true, message: "9Router removed from Crush" });
  } catch (err) {
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
