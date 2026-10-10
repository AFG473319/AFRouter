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
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export const CRUSH_PROVIDER_ID = "afrouter";
export const CRUSH_SCHEMA_URL = "https://charm.land/crush.json";

// charmbracelet/crush README (Configuration): $CRUSH_GLOBAL_CONFIG then
// $HOME/.config/crush/crush.json. XDG is honoured by the same expression.
export const getCrushConfigPath = () => {
  if (process.env.CRUSH_GLOBAL_CONFIG) return path.join(process.env.CRUSH_GLOBAL_CONFIG, "crush.json");
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configDir, "crush", "crush.json");
};

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

// Only OUR provider counts as configured: a foreign entry that happens to sit
// on port 20128 would otherwise light up the badge for a Crush we never wrote.
const hasOurConfig = (settings) => {
  const entry = settings?.providers?.[CRUSH_PROVIDER_ID];
  return Boolean(entry?.base_url);
};

const readJson = async (filePath) => {
  const { exists, raw } = await readConfig(filePath, "json");
  if (!exists) return null;
  try {
    const parsed = parseConfigText(raw, "json", "crush.json");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch (error) {
    if (error instanceof CliConfigParseError) throw error;
    return null;
  }
};

// One catwalk Model entry (charmbracelet/catwalk pkg/catwalk/provider.go).
// Every field there is serialized unconditionally (only reasoning_levels and
// default_reasoning_effort are omitempty), so the entry always carries a full
// numeric spec instead of Crush having to guess one.
const buildModelEntry = (id) => {
  const spec = specForCli(id);
  const contextWindow = Math.floor(Number(spec.contextWindow));
  const maxTokens = Math.floor(Number(spec.maxOutput));
  const levels = Array.isArray(spec.levels) ? spec.levels : [];
  const entry = {
    id,
    name: id,
    // A gateway publishes no per-model tariff; a published 0 is Crush's own
    // "unknown cost" value rather than an invented price.
    cost_per_1m_in: 0,
    cost_per_1m_out: 0,
    cost_per_1m_in_cached: 0,
    cost_per_1m_out_cached: 0,
    context_window: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 128000,
    default_max_tokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 4096,
    can_reason: spec.reasoning === true,
    // Toggle-only and non-reasoning models get no ladder: an omitted list is
    // "no effort control", where ["low","medium","high"] would be a guess.
    ...(levels.length ? { reasoning_levels: [...levels] } : null),
    ...(spec.defaultLevel ? { default_reasoning_effort: spec.defaultLevel } : null),
    supports_attachments: spec.vision === true,
  };
  return entry;
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

    const configPath = getCrushConfigPath();
    let config;
    try {
      config = await readJson(configPath);
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json(
          { installed: true, corrupt: true, config: null, hasAFRouter: false, configPath },
          { status: 409 },
        );
      }
      throw error;
    }

    return NextResponse.json({
      installed: true,
      config,
      hasAFRouter: hasOurConfig(config),
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
    const { baseUrl, apiKey, model, models } = rawBody || {};
    if (!baseUrl) {
      return NextResponse.json({ error: { message: "baseUrl is required" } }, { status: 400 });
    }

    const ids = (Array.isArray(models) ? models : [])
      .map((m) => (typeof m === "string" ? m.trim() : m?.id?.trim?.()))
      .filter(Boolean);
    if (model && typeof model === "string" && model.trim()) ids.unshift(model.trim());
    const uniqueIds = [...new Set(ids.length ? ids : ["provider/model-id"])];

    const configPath = getCrushConfigPath();
    await fs.mkdir(path.dirname(configPath), { recursive: true });

    let existing = {};
    try {
      existing = (await readJson(configPath)) || {};
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: { message: error.message } }, { status: 409 });
      }
      throw error;
    }

    if (!existing.providers || typeof existing.providers !== "object") existing.providers = {};
    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const resolved = uniqueIds.map(buildModelEntry);

    // Migrate a legacy "9router" block to "afrouter" instead of leaving both.
    const legacy = existing.providers["9router"];
    if (legacy && !existing.providers[CRUSH_PROVIDER_ID]) {
      existing.providers[CRUSH_PROVIDER_ID] = { ...legacy };
    }
    delete existing.providers["9router"];

    // Additive merge by model id: re-Apply refreshes specs (matters after a
    // catalog refresh) and stays idempotent; hand-added entries survive.
    const previous = Array.isArray(existing.providers[CRUSH_PROVIDER_ID]?.models)
      ? existing.providers[CRUSH_PROVIDER_ID].models
      : [];
    const byId = new Map();
    for (const m of previous) {
      if (m && typeof m.id === "string") byId.set(m.id, m);
    }
    for (const m of resolved) byId.set(m.id, m);

    existing.providers[CRUSH_PROVIDER_ID] = {
      ...existing.providers[CRUSH_PROVIDER_ID],
      type: "openai-compat",
      base_url: normalizedBaseUrl,
      api_key: await resolveCliApiKey(apiKey),
      models: [...byId.values()],
    };

    // Selection: Crush's own models.large/small (internal/config SelectedModel).
    existing.models = existing.models && typeof existing.models === "object" ? existing.models : {};
    if (existing.models.large) {
      existing.models.large = { ...existing.models.large, model: uniqueIds[0], provider: CRUSH_PROVIDER_ID };
    }
    if (!existing.models.large) {
      existing.models.large = { model: uniqueIds[0], provider: CRUSH_PROVIDER_ID };
    }

    existing.$schema = CRUSH_SCHEMA_URL;

    const backupPath = await writeWithBackup(configPath, `${JSON.stringify(existing, null, 2)}\n`);

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
    const { exists, raw } = await readConfig(configPath, "json");
    if (!exists) {
      return NextResponse.json({ success: true, message: "No config file to reset" });
    }
    let existing;
    try {
      existing = parseConfigText(raw, "json", "crush.json");
    } catch (error) {
      if (error instanceof CliConfigParseError) {
        return NextResponse.json({ error: { message: error.message } }, { status: 409 });
      }
      throw error;
    }

    const hadOurs =
      Boolean(existing.providers?.[CRUSH_PROVIDER_ID]) || Boolean(existing.providers?.["9router"]);
    if (existing.providers) {
      for (const id of [CRUSH_PROVIDER_ID, "9router"]) delete existing.providers[id];
      if (Object.keys(existing.providers).length === 0) delete existing.providers;
    }
    if (existing.models?.large?.provider === CRUSH_PROVIDER_ID) delete existing.models.large;
    if (existing.models && Object.keys(existing.models).length === 0) delete existing.models;
    if (existing.$schema === CRUSH_SCHEMA_URL) delete existing.$schema;
    if (hadOurs) await writeWithBackup(configPath, `${JSON.stringify(existing, null, 2)}\n`);

    return NextResponse.json({ success: true, message: "AFRouter removed from Crush" });
  } catch (err) {
    if (err instanceof CliConfigParseError) {
      return NextResponse.json({ error: { message: err.message } }, { status: 409 });
    }
    return NextResponse.json({ error: { message: err.message } }, { status: 500 });
  }
}
