"use server";

import { NextResponse } from "next/server";
import { resolveCliApiKey } from "../resolveApiKey.js";
import { specForCli } from "@/lib/cliModelSpec.js";
import {
  CliConfigParseError,
  editJsoncText,
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

const PROVIDER_ID = "afrouter";

// docs.openclaw.ai/help/environment: OPENCLAW_HOME replaces the home dir for all
// internal path defaults; OPENCLAW_CONFIG_PATH names the config file directly.
// OPENCLAW_STATE_DIR overrides the state dir (default ~/.openclaw) which shares
// the same default location, so honor it as a dir fallback.
const getOpenClawDir = () =>
  path.resolve(process.env.OPENCLAW_HOME || process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"));
const getOpenClawSettingsPath = () =>
  process.env.OPENCLAW_CONFIG_PATH
    ? path.resolve(process.env.OPENCLAW_CONFIG_PATH)
    : path.join(getOpenClawDir(), "openclaw.json");

// Check if openclaw CLI is installed (via which/where or config file exists)
const checkOpenClawInstalled = async () => {
  try {
    const isWindows = os.platform() === "win32";
    const command = isWindows ? "where openclaw" : "which openclaw";
    // On Windows, inject %APPDATA%\npm into PATH so npm global packages are found
    const env = isWindows
      ? { ...process.env, PATH: `${process.env.APPDATA}\\npm;${process.env.PATH}` }
      : process.env;
    await execAsync(command, { windowsHide: true, env });
    return true;
  } catch {
    for (const candidate of [getOpenClawSettingsPath(), getOpenClawDir()]) {
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

// OpenClaw's config format is JSON5 (comments + trailing commas), so it goes
// through the shared JSON5 parser. An unparseable file aborts with 409 instead
// of being treated as "no config" and overwritten. The raw text is read first so
// the 409 branch is reached before any throw escapes to the handler.
const readSettingsFile = async (settingsPath) => {
  let raw;
  try {
    raw = await fs.readFile(settingsPath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, raw: "" };
    throw error;
  }
  return { exists: true, raw };
};

// agents.entries is the current roster key (src/config/zod-schema.agents.ts):
// a record keyed by agent id. agents.list was retired and validation rejects it.
const readAgentEntries = (settings) => {
  const entries = settings?.agents?.entries;
  return entries && typeof entries === "object" && !Array.isArray(entries) ? entries : null;
};

const agentModelId = (entry) => {
  const model = entry?.model;
  if (typeof model === "string") return model;
  if (model && typeof model === "object") return model.primary ?? "";
  return "";
};

const hasAFRouterConfig = (settings) => Boolean(settings?.models?.providers?.[PROVIDER_ID]);

// One OpenClaw model entry (src/config/zod-schema.core.ts ModelDefinitionSchema):
// id+name required, plus contextWindow, maxTokens, reasoning and input.
const buildModelEntry = (id) => {
  const spec = specForCli(id);
  const contextWindow = Math.floor(Number(spec.contextWindow));
  const maxTokens = Math.floor(Number(spec.maxOutput));
  const shortName = String(id).split("/").pop() || id;
  return {
    id,
    name: shortName,
    ...(Number.isFinite(contextWindow) && contextWindow > 0 ? { contextWindow } : null),
    ...(Number.isFinite(maxTokens) && maxTokens > 0 ? { maxTokens } : null),
    ...(spec.reasoning === true ? { reasoning: true } : null),
    // Closed union: "text" | "image" | "video" | "audio". Writing anything else
    // makes OpenClaw drop the whole model.
    input: spec.vision === true ? ["text", "image"] : ["text"],
  };
};

// Read a per-agent models.json and return the AFRouter models declared there.
const readAgentModels = async (agentDir) => {
  try {
    const content = await fs.readFile(path.join(agentDir, "models.json"), "utf-8");
    const parsed = parseConfigText(content, "json5", "models.json");
    const models = parsed?.providers?.[PROVIDER_ID]?.models;
    return Array.isArray(models) ? models.map((m) => m?.id).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const writeAgentModels = async (agentDir, modelIds, baseUrl, apiKey) => {
  await fs.mkdir(agentDir, { recursive: true });
  const modelsPath = path.join(agentDir, "models.json");
  let existing = {};
  let raw = "";
  try {
    raw = await fs.readFile(modelsPath, "utf-8");
    existing = parseConfigText(raw, "json5", "models.json");
  } catch {
    /* No existing per-agent models */
  }
  const next = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
  next.providers = next.providers && typeof next.providers === "object" ? next.providers : {};
  next.providers[PROVIDER_ID] = {
    ...(next.providers[PROVIDER_ID] && typeof next.providers[PROVIDER_ID] === "object" ? next.providers[PROVIDER_ID] : {}),
    baseUrl,
    // A placeholder key would be sent as a bearer token and 401; the field is
    // omitted entirely when no key resolved.
    ...(apiKey ? { apiKey } : null),
    api: "openai-completions",
    models: modelIds.map(buildModelEntry),
  };
  await writeWithBackup(modelsPath, `${JSON.stringify(next, null, 2)}\n`, { secret: true });
  return { raw };
};

export async function GET() {
  try {
    const isInstalled = await checkOpenClawInstalled();
    const settingsPath = getOpenClawSettingsPath();

    if (!isInstalled) {
      return NextResponse.json({
        installed: false,
        settings: null,
        agents: [],
        hasAFRouter: false,
        settingsPath,
        message: "Open Claw CLI is not installed",
      });
    }

    let raw;
    try {
      raw = await fs.readFile(settingsPath, "utf-8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return NextResponse.json({ installed: true, settings: null, agents: [], hasAFRouter: false, settingsPath });
      }
      throw error;
    }
    let settings;
    try {
      settings = parseConfigText(raw, "json5", "openclaw.json");
    } catch (error) {
      // A corrupt file is reported as corrupt; it is never treated as "no config",
      // which would let an Apply overwrite it.
      if (error instanceof CliConfigParseError || error?.status === 409) {
        return NextResponse.json(
          { installed: true, corrupt: true, settings: null, agents: [], hasAFRouter: false, settingsPath, error: error.message },
          { status: 409 },
        );
      }
      console.log("Error parsing openclaw settings:", error);
      return NextResponse.json({ error: "Failed to read OpenClaw settings" }, { status: 500 });
    }

    const entries = readAgentEntries(settings);
    const agents = await Promise.all(
      Object.entries(entries || {}).map(async ([id, entry]) => ({
        id,
        model: agentModelId(entry),
        agentDir: typeof entry?.agentDir === "string" ? entry.agentDir : null,
        models: entry?.agentDir ? await readAgentModels(entry.agentDir) : [],
      })),
    );

    return NextResponse.json({
      installed: true,
      settings,
      agents,
      hasAFRouter: hasAFRouterConfig(settings),
      settingsPath,
    });
  } catch (error) {
    console.log("Error checking openclaw settings:", error);
    return NextResponse.json({ error: "Failed to check openclaw settings" }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const { baseUrl, apiKey, model, agentModels = {} } = await request.json();

    if (!baseUrl || !model) {
      return NextResponse.json({ error: "baseUrl and model are required" }, { status: 400 });
    }

    const openclawDir = getOpenClawDir();
    const settingsPath = getOpenClawSettingsPath();
    await fs.mkdir(openclawDir, { recursive: true });

    let settings = {};
    let raw = "";
    try {
      const file = await readSettingsFile(settingsPath);
      if (file.exists) {
        raw = file.raw;
        settings = parseConfigText(raw, "json5", "openclaw.json");
      }
    } catch (error) {
      if (error instanceof CliConfigParseError || error?.status === 409) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) settings = {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    // Model refs split on the first "/" (docs.openclaw.ai/cli/models), so a
    // value round-tripped from GET ("afrouter/<model>") must be stripped
    // before re-prefixing to avoid "afrouter/afrouter/…".
    const stripProviderPrefix = (m) => String(m || "").replace(/^afrouter\//, "");
    const bareModel = stripProviderPrefix(model);
    const fullModelId = `${PROVIDER_ID}/${bareModel}`;
    const keyToUse = (await resolveCliApiKey(apiKey)) || "";

    if (!settings.agents) settings.agents = {};
    if (!settings.agents.defaults) settings.agents.defaults = {};
    // docs.openclaw.ai/gateway/config-agents/models: defaults.model accepts a
    // string or { primary }. A foreign string pin is preserved below; only an
    // unset or ours-prefixed value is repointed.
    const existingDefaultsModel = settings.agents.defaults.model;
    const existingPrimary = typeof existingDefaultsModel === "string"
      ? existingDefaultsModel
      : existingDefaultsModel?.primary;
    if (!settings.agents.defaults.model || typeof settings.agents.defaults.model === "string") {
      settings.agents.defaults.model = typeof existingDefaultsModel === "object" && existingDefaultsModel !== null
        ? existingDefaultsModel
        : {};
    }
    if (!settings.agents.defaults.models) settings.agents.defaults.models = {};
    if (!settings.models) settings.models = {};
    if (!settings.models.providers) settings.models.providers = {};

    // Drop our previous allowlist entries before re-adding the current set.
    Object.keys(settings.agents.defaults.models)
      .filter((k) => k.startsWith(`${PROVIDER_ID}/`))
      .forEach((k) => { delete settings.agents.defaults.models[k]; });

    // Only repoint the primary when it is ours or unset: the user's own pin on
    // another provider is not ours to change (including a foreign string pin
    // preserved above).
    const primaryModel = settings.agents.defaults.model?.primary ?? existingPrimary;
    if (!primaryModel || String(primaryModel).startsWith(`${PROVIDER_ID}/`)) {
      settings.agents.defaults.model.primary = fullModelId;
    } else if (typeof existingDefaultsModel === "string") {
      // Preserve the foreign string pin verbatim instead of converting it.
      settings.agents.defaults.model = existingDefaultsModel;
    }

    const allModelIds = new Set([bareModel]);
    Object.values(agentModels).forEach((m) => { if (m) allModelIds.add(stripProviderPrefix(m)); });

    allModelIds.forEach((m) => {
      settings.agents.defaults.models[`${PROVIDER_ID}/${m}`] = {};
    });

    // The provider entry now carries per-model specs, so `{id,name}` (OpenClaw's
    // 200k text-only default) is no longer what the tool has to guess from.
    settings.models.providers[PROVIDER_ID] = {
      ...(settings.models.providers[PROVIDER_ID] && typeof settings.models.providers[PROVIDER_ID] === "object"
        ? settings.models.providers[PROVIDER_ID]
        : {}),
      baseUrl: normalizedBaseUrl,
      ...(keyToUse ? { apiKey: keyToUse } : null),
      api: "openai-completions",
      models: [...allModelIds].map(buildModelEntry),
    };

    // Per-agent overrides live under agents.entries (a record keyed by agent id).
    const entries = readAgentEntries(settings);
    if (entries) {
      for (const [id, entry] of Object.entries(entries)) {
        const agentModelRaw = agentModels[id];
        if (!agentModelRaw) continue;
        const agentModel = stripProviderPrefix(agentModelRaw);
        entries[id] = { ...entry };
        if (typeof entry?.model === "string") entries[id].model = `${PROVIDER_ID}/${agentModel}`;
        else entries[id].model = { ...(entry?.model || {}), primary: `${PROVIDER_ID}/${agentModel}` };
        if (typeof entry?.agentDir === "string" && entry.agentDir) {
          const agentDir = path.isAbsolute(entry.agentDir)
            ? entry.agentDir
            : path.resolve(getOpenClawDir(), entry.agentDir);
          await writeAgentModels(agentDir, [agentModel, bareModel], normalizedBaseUrl, keyToUse);
        }
      }
    }

    // JSON5 edit so the user's comments and formatting survive the write.
    const settingsText = editJsoncText(raw || "{}", [
      { path: ["agents"], value: settings.agents },
      { path: ["models"], value: settings.models },
    ]);
    await writeWithBackup(settingsPath, settingsText, { secret: true });

    return NextResponse.json({
      success: true,
      message: "Open Claw settings applied successfully!",
      settingsPath,
    });
  } catch (error) {
    console.log("Error updating openclaw settings:", error);
    return NextResponse.json({ error: "Failed to update openclaw settings" }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const settingsPath = getOpenClawSettingsPath();
    let raw;
    const file = await readSettingsFile(settingsPath);
    if (!file.exists) {
      return NextResponse.json({ success: true, message: "No settings file to reset" });
    }
    raw = file.raw;
    let settings;
    try {
      settings = parseConfigText(raw, "json5", "openclaw.json");
    } catch (error) {
      if (error instanceof CliConfigParseError || error?.status === 409) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      throw error;
    }

    if (settings.models?.providers) {
      delete settings.models.providers[PROVIDER_ID];
      if (Object.keys(settings.models.providers).length === 0) delete settings.models.providers;
      if (settings.models && Object.keys(settings.models).length === 0) delete settings.models;
    }

    if (settings.agents?.defaults?.models) {
      Object.keys(settings.agents.defaults.models)
        .filter((k) => k.startsWith(`${PROVIDER_ID}/`))
        .forEach((k) => delete settings.agents.defaults.models[k]);
      if (Object.keys(settings.agents.defaults.models).length === 0) delete settings.agents.defaults.models;
    }

    if (String(settings.agents?.defaults?.model?.primary || settings.agents?.defaults?.model || "").startsWith(`${PROVIDER_ID}/`)) {
      if (typeof settings.agents.defaults.model === "string") delete settings.agents.defaults.model;
      else delete settings.agents.defaults.model.primary;
    }

    // Per-agent overrides and their per-agent models.json references.
    const entries = readAgentEntries(settings);
    if (entries) {
      for (const [id, entry] of Object.entries(entries)) {
        const model = agentModelId(entry);
        if (!model.startsWith(`${PROVIDER_ID}/`)) continue;
        const next = { ...entry };
        if (typeof entry.model === "string") delete next.model;
        else if (entry.model && typeof entry.model === "object") {
          const { primary: _primary, ...rest } = entry.model;
          next.model = Object.keys(rest).length > 0 ? rest : undefined;
          if (next.model === undefined) delete next.model;
        }
        if (Object.keys(next).length === 0) delete entries[id];
        else entries[id] = next;
        if (typeof entry?.agentDir === "string" && entry.agentDir) {
          await removeAgentModels(
            path.isAbsolute(entry.agentDir) ? entry.agentDir : path.resolve(getOpenClawDir(), entry.agentDir),
          );
        }
      }
      if (Object.keys(entries).length === 0) delete settings.agents.entries;
    }
    // AgentsSchema rejects an empty `agents` object (must contain at least one
    // configured agent when present), so drop emptied containers to leave a
    // schema-valid file after removing a sole bare entry.
    if (settings.agents?.defaults && Object.keys(settings.agents.defaults).length === 0) {
      delete settings.agents.defaults;
    }
    if (settings.agents && Object.keys(settings.agents).length === 0) {
      delete settings.agents;
    }

    // JSON5 edit so the user's comments and formatting survive the write.
    const settingsText = editJsoncText(raw, [
      { path: ["agents"], value: settings.agents },
      { path: ["models"], value: settings.models },
    ]);
    await writeWithBackup(settingsPath, settingsText, { secret: true });
    return NextResponse.json({ success: true, message: "AFRouter settings removed successfully" });
  } catch (error) {
    console.log("Error resetting openclaw settings:", error);
    return NextResponse.json({ error: "Failed to reset openclaw settings" }, { status: 500 });
  }
}

// Remove only the afrouter provider block from one per-agent models.json.
const removeAgentModels = async (agentDir) => {
  const modelsPath = path.join(agentDir, "models.json");
  try {
    const content = await fs.readFile(modelsPath, "utf-8");
    const parsed = parseConfigText(content, "json5", "models.json");
    if (parsed?.providers?.[PROVIDER_ID]) {
      delete parsed.providers[PROVIDER_ID];
      if (Object.keys(parsed.providers).length === 0) delete parsed.providers;
      await writeWithBackup(modelsPath, `${JSON.stringify(parsed, null, 2)}\n`, { secret: true });
    }
  } catch (error) {
    if (!(error instanceof CliConfigParseError || error?.status === 409) && error.code !== "ENOENT") throw error;
  }
};
