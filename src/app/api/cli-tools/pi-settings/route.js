"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { readOwnership, writeOwnership } from "@/lib/piModelOwnership.js";
import {
  FALLBACK_SPEC,
  PI_MODELS_FILE,
  PI_SETTINGS_FILE,
  clearPiDefaults,
  readPiDefaults,
  readPiModelIds,
  readPiProvider,
  removePiProvider,
  stringifyJsonDocument,
  upsertPiDefaults,
  upsertPiProvider,
} from "@/lib/piConfig.js";

const execAsync = promisify(exec);

// Pi resolves the agent dir from $PI_CODING_AGENT_DIR and otherwise uses
// ~/.pi/agent. Resolved per call so the test suite can redirect it.
const getAgentDir = () =>
  process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");

const getModelsPath = () => path.join(getAgentDir(), PI_MODELS_FILE);
const getSettingsPath = () => path.join(getAgentDir(), PI_SETTINGS_FILE);

// Safe JSON read: missing -> { missing: true }; unparseable -> { corrupt: true }.
// Never throws to the handler — the UI must never see a 500 for a bad user file.
// A file that parses but is not a JSON object (an array, a bare string) is
// corrupt too: treating it as `{}` would silently overwrite whatever the user
// actually had there.
const readJson = async (filePath) => {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { corrupt: true };
    return { data };
  } catch {
    return { corrupt: true };
  }
};

// Timestamped backup -> temp file -> atomic rename with EPERM/EACCES retries
// (Windows file-lock races with Pi/AV). Skips the backup when the target does
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

// Detection: the agent dir, either of its config files, or a `pi` binary on
// PATH. A config file may not exist yet on a fresh install — that is
// "installed, not configured", not "not installed".
const checkInstalled = async () => {
  for (const candidate of [getAgentDir(), getModelsPath(), getSettingsPath()]) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      /* try next */
    }
  }
  try {
    const isWindows = process.platform === "win32";
    await execAsync(isWindows ? "where pi" : "which pi", { windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

// Self-fetch must target the port this instance actually listens on. The request
// URL carries it; `process.env.PORT` is only a fallback because the Next server
// may be started with --port and no PORT env.
const resolveSelfOrigin = (request) => {
  try {
    const url = new URL(request?.url || "");
    if (url.port) return `http://127.0.0.1:${url.port}`;
  } catch {
    // fall through
  }
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
};

// Live catalog first: our own /v1/models, indexed by exact id and by the
// alias-translated spelling (a config may use `oc/…` where the catalog says
// `opencode/…`).
const resolveLiveCatalog = async (origin) => {
  try {
    const res = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data : [];
    const byId = new Map();
    const byAliasId = new Map();
    for (const m of models) {
      if (!m?.id || !m.capabilities) continue;
      byId.set(m.id, m.capabilities);
      const bare = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
      const owner = m.owned_by || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : null);
      if (bare && owner) byAliasId.set(`${owner}/${bare}`, m.capabilities);
    }
    return { byId, byAliasId };
  } catch {
    return null;
  }
};

const capsToSpec = (caps) => ({
  contextWindow: Math.floor(Number(caps.contextWindow)),
  maxTokens: Math.floor(Number(caps.maxOutput)),
  vision: caps.vision === true,
  pdf: caps.pdf === true,
  audioInput: caps.audioInput === true,
  videoInput: caps.videoInput === true,
  reasoning: caps.reasoning === true,
});

// Catalog (exact, then alias-translated) -> static registry -> conservative
// fallback. Never invent values: an unresolved id is reported `unverified` and
// gets the documented Pi defaults.
const resolveModelSpecs = async (ids, catalog) => {
  const specs = {};
  const unverified = [];
  for (const id of ids) {
    const slash = id.indexOf("/");
    const prefix = slash > 0 ? id.slice(0, slash) : null;
    const bare = slash > 0 ? id.slice(slash + 1) : id;

    let caps = catalog?.byId?.get(id) || null;
    if (!caps && prefix) {
      const translated = resolveProviderAlias(prefix);
      caps =
        catalog?.byAliasId?.get(`${translated}/${bare}`) ||
        catalog?.byAliasId?.get(`${prefix}/${bare}`) ||
        null;
    }
    if (!caps) {
      const staticCaps = getCapabilitiesForModel(prefix, bare);
      if (staticCaps && Number.isFinite(staticCaps.contextWindow)) caps = staticCaps;
    }
    if (caps && Number.isFinite(caps.contextWindow) && Number.isFinite(caps.maxOutput)) {
      specs[id] = capsToSpec(caps);
    } else {
      specs[id] = { ...FALLBACK_SPEC };
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

/**
 * Ownership classification. Once a ledger record exists it is authoritative:
 * owned = recorded ids that are still present, and anything else in the entry
 * is a `candidate` (typed in by hand) that DELETE never touches and Apply only
 * adopts with an explicit flag.
 *
 * Before any ledger record exists — a fresh install, or a config the user
 * pasted from another machine's Manual Config — every id in `providers.afrouter`
 * counts as ours. Unlike ZCode, Pi's AFRouter provider block is a provider entry
 * we own outright rather than a shared entry with hand-added models, and Pi
 * offers no per-model marker we can safely inject, so "everything under our
 * provider id" is the correct pre-ledger reading and it lets a pasted config
 * still be reset cleanly.
 */
const classifyOwnership = async (models) => {
  const ids = readPiModelIds(models);
  const { known, models: recorded } = await readOwnership(getModelsPath());
  if (known) {
    const ownedSet = new Set(recorded);
    const owned = ids.filter((id) => ownedSet.has(id));
    const ownedOnly = new Set(owned);
    return { known, owned, candidates: ids.filter((id) => !ownedOnly.has(id)) };
  }
  return { known, owned: ids, candidates: [] };
};

// GET - install + AFRouter routing status
export async function GET(request) {
  try {
    const installed = await checkInstalled();
    const configPath = getModelsPath();
    const settingsPath = getSettingsPath();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        configPath,
        settingsPath,
        pi: null,
        message: "Pi coding agent is not installed",
      });
    }

    const modelsResult = await readJson(configPath);
    if (modelsResult.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath,
        settingsPath,
        pi: null,
      });
    }

    const models = modelsResult.data || {};
    const provider = readPiProvider(models);
    const ids = readPiModelIds(models);
    const { owned, candidates } = await classifyOwnership(models);

    let unverified = [];
    if (ids.length > 0) {
      const catalog =
        (await resolveLiveCatalog(resolveSelfOrigin(request))) ||
        // The batch `all-statuses` endpoint calls GET with no request, so fall
        // back to the dashboard default port before giving up on the catalog.
        (await resolveLiveCatalog(`http://127.0.0.1:${process.env.PORT || 20128}`));
      const resolved = await resolveModelSpecs(ids, catalog);
      unverified = ids.filter((id) => resolved.unverified.includes(id));
    }

    // settings.json is optional: Pi creates it on first run, and a missing file
    // simply means no startup pin exists yet.
    const settingsResult = await readJson(settingsPath);
    const defaults = readPiDefaults(
      settingsResult.corrupt || settingsResult.missing ? {} : settingsResult.data,
    );

    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!provider,
      configPath,
      settingsPath,
      agentDir: getAgentDir(),
      settingsCorrupt: settingsResult.corrupt === true,
      pi: {
        models: ids,
        afrouterModels: owned,
        unverified,
        bootstrapCandidates: candidates,
        baseURL: provider?.baseUrl || null,
        api: provider?.api || null,
        // Never the key itself.
        hasApiKey: typeof provider?.apiKey === "string" && provider.apiKey.length > 0,
        defaultProvider: defaults.provider,
        defaultModel: defaults.model,
        isDefault: defaults.isAFRouter,
      },
    });
  } catch (error) {
    console.log("Error checking pi settings:", error);
    return NextResponse.json({ error: "Failed to check pi settings" }, { status: 500 });
  }
}

// POST - merge the `afrouter` provider into models.json, and optionally pin it
// as Pi's startup selection in settings.json
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models, adoptBootstrap, setDefault, defaultModel } = await request.json();
    const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const modelsPath = getModelsPath();
    const modelsResult = await readJson(modelsPath);
    if (modelsResult.corrupt) {
      return NextResponse.json(
        { success: false, error: "Pi models.json is unreadable — fix or restore it before applying" },
        { status: 409 },
      );
    }

    const settingsPath = getSettingsPath();
    const settingsResult = await readJson(settingsPath);
    if (settingsResult.corrupt) {
      return NextResponse.json(
        { success: false, error: "Pi settings.json is unreadable — fix or restore it before applying" },
        { status: 409 },
      );
    }

    const current = modelsResult.data || {};
    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);

    // Writability is "owned OR brand-new OR explicitly adopted candidate".
    // Merely re-sending the whole hydrated chip list must never convert a
    // hand-added model into a deletable one, so candidates need the flag.
    const { owned, candidates } = await classifyOwnership(current);
    const existing = new Set(readPiModelIds(current));
    const ownedSet = new Set(owned);
    const adopted =
      adoptBootstrap === true ? modelsArray.filter((id) => existing.has(id)) : [];
    const writable = new Set([
      ...ownedSet,
      ...modelsArray.filter((id) => !existing.has(id)),
      ...adopted,
    ]);

    // Restrict the write to what we may touch, then re-add every previously
    // owned id that is still on the card so Apply is idempotent per model.
    const nextModels = upsertPiProvider(current, {
      baseUrl,
      apiKey,
      models: [...writable],
      specs,
    });
    // Preserve hand-added entries verbatim: upsert merged the whole previous
    // list, so nothing of theirs was dropped or rewritten.
    const present = new Set(readPiModelIds(nextModels));
    const { backupPath } = await writeAtomic(modelsPath, stringifyJsonDocument(nextModels));

    // Record exactly what we now manage. `writable` already contains every
    // previously-owned id that is still present, so filtering it by what
    // survived the merge is both the update and the adoption set; a candidate
    // the user did not adopt is never recorded and therefore never deleted.
    await writeOwnership(modelsPath, [...writable].filter((id) => present.has(id)));

    // settings.json: pin the startup model only when asked. Reading it as
    // optional means a missing file is created on demand.
    let defaultWritten = null;
    if (setDefault === true) {
      const pinned = defaultModel && modelsArray.includes(defaultModel) ? defaultModel : modelsArray[0];
      const nextSettings = upsertPiDefaults(settingsResult.data || {}, { modelId: pinned });
      const settingsBackup = await writeAtomic(settingsPath, stringifyJsonDocument(nextSettings));
      defaultWritten = { model: pinned, backupPath: settingsBackup.backupPath };
    }

    return NextResponse.json({
      success: true,
      message: defaultWritten
        ? "Pi settings applied. It is now the startup provider — run pi to use it."
        : "Pi settings applied! Open /model in Pi to pick an AFRouter model.",
      configPath: modelsPath,
      settingsPath,
      backupPath,
      written: [...writable],
      unverified,
      defaultModel: defaultWritten,
      skippedCandidates: candidates.filter((id) => !writable.has(id)),
    });
  } catch (error) {
    console.log("Error applying pi settings:", error);
    return NextResponse.json({ error: "Failed to apply pi settings" }, { status: 500 });
  }
}

// DELETE - ownership-scoped removal from models.json, plus the settings.json
// startup pin when it still points at us
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const modelsPath = getModelsPath();
    const modelsResult = await readJson(modelsPath);
    if (modelsResult.missing || modelsResult.corrupt) {
      return NextResponse.json({
        success: true,
        message: "No Pi models.json to reset",
        removed: 0,
        entryRemoved: false,
        skippedCandidates: [],
      });
    }

    const current = modelsResult.data || {};
    if (!readPiProvider(current)) {
      return NextResponse.json({
        success: true,
        message: "No AFRouter provider in Pi models.json",
        removed: 0,
        entryRemoved: false,
        skippedCandidates: [],
      });
    }

    // Snapshot the AFRouter model list before removal: it is what tells us a
    // leftover `defaultModel` in settings.json was ours.
    const providerIdsBefore = readPiModelIds(current);
    const { owned, candidates } = await classifyOwnership(current);
    const ownedSet = new Set(owned);

    // Count only the ids we are actually allowed to delete.
    const targets = providerIdsBefore.filter((id) => ownedSet.has(id) && (!modelToRemove || id === modelToRemove));
    if (targets.length === 0) {
      return NextResponse.json({
        success: true,
        message: modelToRemove
          ? `"${modelToRemove}" is not an AFRouter-managed model — left untouched`
          : "No AFRouter-managed models to reset",
        removed: 0,
        entryRemoved: false,
        skippedCandidates: modelToRemove ? [] : candidates,
      });
    }

    let removed = 0;
    let nextModels = current;
    for (const id of targets) {
      const result = removePiProvider(nextModels, id);
      nextModels = result.models;
      removed += result.removed;
    }
    const entryRemoved = !readPiProvider(nextModels);

    await writeAtomic(modelsPath, stringifyJsonDocument(nextModels));
    const remaining = readPiModelIds(nextModels);
    await writeOwnership(modelsPath, owned.filter((id) => remaining.includes(id)));

    // Clear the startup pin while it still points at AFRouter. Settings are only
    // touched when a model was actually removed, so a no-op DELETE is inert.
    let defaultCleared = false;
    const settingsPath = getSettingsPath();
    const settingsResult = await readJson(settingsPath);
    if (!settingsResult.missing && !settingsResult.corrupt) {
      const defaults = readPiDefaults(settingsResult.data);
      if (defaults.isAFRouter || providerIdsBefore.includes(defaults.model)) {
        await writeAtomic(
          settingsPath,
          stringifyJsonDocument(clearPiDefaults(settingsResult.data, { providerModelIds: providerIdsBefore })),
        );
        defaultCleared = true;
      }
    }

    return NextResponse.json({
      success: true,
      message: entryRemoved
        ? "AFRouter provider removed from Pi"
        : `Removed ${removed} AFRouter model${removed === 1 ? "" : "s"} from Pi`,
      removed,
      entryRemoved,
      defaultCleared,
      skippedCandidates: modelToRemove ? [] : candidates.filter((id) => remaining.includes(id)),
    });
  } catch (error) {
    console.log("Error resetting pi settings:", error);
    return NextResponse.json({ error: "Failed to reset pi settings" }, { status: 500 });
  }
}
