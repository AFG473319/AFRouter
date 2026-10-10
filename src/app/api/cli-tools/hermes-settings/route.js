"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseYAML, stringifyYAML } from "confbox/yaml";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  HERMES_API_KEY_ENV,
  HERMES_AUX_TASKS,
  HERMES_CONFIG_DIR_SEGMENTS,
  HERMES_CONFIG_FILE,
  HERMES_DELEGATION_SLOT,
  HERMES_ENV_FILE,
  HERMES_FALLBACK_SPEC,
  HERMES_PROVIDER_ID,
  HERMES_PROVIDER_REF,
  buildHermesMainBlock,
  buildHermesSlot,
  clearSlotReference,
  isOurSlot,
  normalizeHermesBaseUrl,
  readHermesModelIds,
  readHermesProvider,
  removeHermesProvider,
  upsertHermesProvider,
} from "@/lib/hermesConfig.js";

const execAsync = promisify(exec);

const getHermesDir = () => {
  // Official layout (hermes-agent.nousresearch.com/docs/getting-started/installation):
  // HERMES_HOME selects user data; default is ~/.hermes on POSIX and
  // %LOCALAPPDATA%\hermes on native Windows.
  if (process.env.HERMES_HOME) return process.env.HERMES_HOME;
  if (os.platform() === "win32") {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "hermes");
  }
  return path.join(os.homedir(), ...HERMES_CONFIG_DIR_SEGMENTS);
};
const getHermesConfigPath = () => path.join(getHermesDir(), HERMES_CONFIG_FILE);
const getHermesEnvPath = () => path.join(getHermesDir(), HERMES_ENV_FILE);

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// ─── YAML read/write ────────────────────────────────────────────────────────
//
// config.yaml is a real YAML document with a nested `providers:` mapping, so it
// is round-tripped through a parser rather than rewritten line-by-line. A
// document that parses but is not a mapping (an array, a bare scalar) counts as
// corrupt too: treating it as {} would silently overwrite whatever the user
// actually had there.
const readYamlDocument = async (filePath) => {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const data = parseYAML(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) return { corrupt: true };
    return { data };
  } catch {
    return { corrupt: true };
  }
};

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${d.getHours()}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Timestamped backup -> temp file -> atomic rename, with EPERM/EACCES retries
// (Windows file-lock races with Hermes or an AV scanner). No backup when the
// target does not exist yet, which is the normal first-apply case.
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
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, "utf-8");
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

// Detection: a `hermes` binary, or any of ~/.hermes's own files. A config file
// may not exist yet on a fresh install — that is "installed, not configured",
// not "not installed".
const checkHermesInstalled = async () => {
  try {
    const isWindows = process.platform() === "win32";
    await execAsync(isWindows ? "where hermes" : "which hermes", {
      windowsHide: true,
      env: npmPathEnv(),
    });
    return true;
  } catch {
    for (const candidate of [getHermesConfigPath(), getHermesEnvPath(), getHermesDir()]) {
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

// ─── spec resolution ────────────────────────────────────────────────────────
//
// Live catalog first (our own /v1/models, indexed by exact id and by the
// alias-translated spelling), then the static registry, then the conservative
// fallback. Never invent values: an unresolved id is reported `unverified`.
const resolveSelfOrigin = (request) => {
  try {
    const url = new URL(request?.url || "");
    if (url.port) return `http://127.0.0.1:${url.port}`;
  } catch {
    // fall through
  }
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
};

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
      const caps = { ...m.capabilities, name: m.name || m.id };
      byId.set(m.id, caps);
      const bare = m.id.includes("/") ? m.id.slice(m.id.indexOf("/") + 1) : m.id;
      const owner = m.owned_by || (m.id.includes("/") ? m.id.slice(0, m.id.indexOf("/")) : null);
      if (bare && owner) byAliasId.set(`${owner}/${bare}`, caps);
    }
    return { byId, byAliasId };
  } catch {
    return null;
  }
};

const capsToSpec = (caps) => ({
  name: caps.name || undefined,
  contextWindow: Math.floor(Number(caps.contextWindow)),
  maxOutput: Math.floor(Number(caps.maxOutput)),
  vision: caps.vision === true,
  reasoning: caps.reasoning === true,
});

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
    if (caps && Number.isFinite(caps.contextWindow)) {
      specs[id] = capsToSpec(caps);
    } else {
      specs[id] = { ...HERMES_FALLBACK_SPEC };
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

// ─── slot helpers ───────────────────────────────────────────────────────────

/**
 * Read one slot block back to the fields the card displays. `key` is the field
 * the slot spells its model id in — `default:` for the main block, `model:`
 * everywhere else — so the response mirrors the file's own key names.
 */
const readSlot = (block, key = "model") => {
  if (!isObject(block)) return null;
  const value = block[key];
  if (value === null || value === undefined || value === "") return null;
  return { [key]: String(value), provider: block.provider ?? null };
};

const slotIsOurs = (block, baseUrl) => isOurSlot(block, baseUrl);

/**
 * Write our reference into one slot block, keeping every field we do not own.
 * `base_url`/`api_key`/`api_mode` are stripped first: `delegation.base_url`
 * takes precedence over `provider`, so a stale inline endpoint left from an
 * older AFRouter build would silently override the named provider.
 *
 * The main block spells the id `default:` (Hermes also accepts `model:` there);
 * every other slot spells it `model:`.
 */
const writeSlot = (previous, model, isMain = false) => {
  const base = isObject(previous) ? clearSlotReference(previous) : {};
  return { ...base, ...(isMain ? buildHermesMainBlock(model) : buildHermesSlot(model)) };
};

/**
 * Strip our reference out of one slot block. Other keys are preserved so a
 * user's own timeout/extra_body tuning survives; the block is dropped only when
 * nothing is left in it.
 */
const stripSlot = (previous) => {
  if (!isObject(previous)) return null;
  const stripped = clearSlotReference(previous);
  return Object.keys(stripped).length > 0 ? stripped : null;
};

// ─── .env helpers ───────────────────────────────────────────────────────────
// Only the API key lives here; Hermes' own docs put API keys in ~/.hermes/.env
// and name them from the provider entry with `key_env`.

const upsertEnvVar = (envText, key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}=${value}`;
  if (re.test(envText)) return envText.replace(re, line);
  return envText.length > 0 && !envText.endsWith("\n") ? `${envText}\n${line}\n` : `${envText}${line}\n`;
};

const removeEnvVar = (envText, key) => envText.replace(new RegExp(`^${key}=.*\\r?\\n?`, "m"), "");

const readEnvFile = async () => {
  try {
    return await fs.readFile(getHermesEnvPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
};

// ─── GET ────────────────────────────────────────────────────────────────────

export async function GET(request) {
  try {
    const installed = await checkHermesInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        configPath: getHermesConfigPath(),
        envPath: getHermesEnvPath(),
        settings: null,
        provider: null,
        models: [],
        message: "Hermes Agent is not installed",
      });
    }

    const configPath = getHermesConfigPath();
    const result = await readYamlDocument(configPath);
    if (result.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath,
        envPath: getHermesEnvPath(),
        settings: null,
        provider: null,
        models: [],
      });
    }

    const doc = result.data || {};
    const provider = readHermesProvider(doc);
    const models = readHermesModelIds(doc);

    const auxiliary = {};
    for (const { id } of HERMES_AUX_TASKS) {
      const slot = readSlot(doc.auxiliary?.[id]);
      if (slot) auxiliary[id] = slot;
    }

    // Unverified ids are computed from what is actually in the file, so the
    // notice follows the config rather than the last thing the card sent.
    let unverified = [];
    if (models.length > 0) {
      const catalog =
        (await resolveLiveCatalog(resolveSelfOrigin(request))) ||
        (await resolveLiveCatalog(`http://127.0.0.1:${process.env.PORT || 20128}`));
      const resolved = await resolveModelSpecs(models, catalog);
      unverified = models.filter((id) => resolved.unverified.includes(id));
    }

    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!provider,
      configPath,
      envPath: getHermesEnvPath(),
      settings: {
        model: readSlot(doc.model, "default"),
        delegation: readSlot(doc.delegation),
        auxiliary,
      },
      provider: provider
        ? {
            name: provider.name ?? HERMES_PROVIDER_ID,
            api: provider.api ?? provider.base_url ?? null,
            transport: provider.transport ?? provider.api_mode ?? null,
            discoverModels: provider.discover_models !== false,
            hasApiKey: typeof provider.api_key === "string" && provider.api_key.length > 0,
            keyEnv: provider.key_env ?? null,
            models,
          }
        : null,
      models,
      unverified,
    });
  } catch (error) {
    console.log("Error checking hermes settings:", error);
    return NextResponse.json({ error: "Failed to check hermes settings" }, { status: 500 });
  }
}

// ─── POST ───────────────────────────────────────────────────────────────────

export async function POST(request) {
  try {
    const { baseUrl, apiKey, models, model: legacyModel, selections } = await request.json();

    // `models` is the additive list declared under `providers.afrouter` — this
    // is what makes Hermes offer many AFRouter models. `selections` assigns
    // them to slots: [{ role, model }], where "default" is the main model,
    // "delegation" the top-level subagent block, and anything else an
    // `auxiliary.<task>` block. Legacy callers (the CLI quick setup) send a
    // bare `model`, which is treated as the default slot.
    const modelList = Array.isArray(models)
      ? models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim())
      : [];
    const sel = Array.isArray(selections) && selections.some((s) => s?.role && s?.model)
      ? selections.filter((s) => s?.role && s?.model)
      : legacyModel ? [{ role: "default", model: legacyModel }] : [];
    const roles = new Map();
    for (const { role, model } of sel) {
      if (typeof role === "string" && typeof model === "string" && model.trim()) {
        roles.set(role, model.trim());
      }
    }
    const defaultModel = roles.get("default");
    if (!baseUrl || !defaultModel) {
      return NextResponse.json({ error: "baseUrl and a default model are required" }, { status: 400 });
    }

    const configPath = getHermesConfigPath();
    const existing = await readYamlDocument(configPath);
    if (existing.corrupt) {
      return NextResponse.json(
        {
          success: false,
          error: `${configPath} is unreadable — fix or restore the latest backup before applying`,
        },
        { status: 409 },
      );
    }

    // The default model is always part of the provider's catalog, so a caller
    // that only sends a slot assignment still gets a usable picker entry.
    const declaredModels = defaultModel && !modelList.includes(defaultModel)
      ? [defaultModel, ...modelList]
      : modelList;

    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(declaredModels, catalog);

    const normalizedBaseUrl = normalizeHermesBaseUrl(baseUrl);
    let doc = upsertHermesProvider(existing.data || {}, {
      baseUrl: normalizedBaseUrl,
      keyEnv: HERMES_API_KEY_ENV,
      models: declaredModels,
      specs,
    });

    // Main model.
    doc.model = writeSlot(doc.model, defaultModel, true);

    // Delegation — its own top-level block, not an auxiliary task.
    if (roles.has(HERMES_DELEGATION_SLOT)) {
      doc[HERMES_DELEGATION_SLOT] = writeSlot(doc[HERMES_DELEGATION_SLOT], roles.get(HERMES_DELEGATION_SLOT));
    } else if (slotIsOurs(doc[HERMES_DELEGATION_SLOT], normalizedBaseUrl)) {
      const stripped = stripSlot(doc[HERMES_DELEGATION_SLOT]);
      if (stripped) doc[HERMES_DELEGATION_SLOT] = stripped;
      else delete doc[HERMES_DELEGATION_SLOT];
    }

    // Auxiliary tasks. An unset role whose block still points at us is cleared,
    // so "remove the override" round-trips instead of sticking forever.
    const auxiliary = isObject(doc.auxiliary) ? { ...doc.auxiliary } : {};
    for (const { id } of HERMES_AUX_TASKS) {
      if (roles.has(id)) {
        auxiliary[id] = writeSlot(auxiliary[id], roles.get(id));
      } else if (slotIsOurs(auxiliary[id], normalizedBaseUrl)) {
        const stripped = stripSlot(auxiliary[id]);
        if (stripped) auxiliary[id] = stripped;
        else delete auxiliary[id];
      }
    }
    doc.auxiliary = auxiliary;

    const { backupPath } = await writeAtomic(configPath, stringifyYAML(doc));

    // .env: upsert the key the entry resolves through `key_env`. Only written
    // when the caller supplies one, so an existing key on this machine is never
    // clobbered with an empty value.
    let envWritten = false;
    if (apiKey) {
      const newEnv = upsertEnvVar(await readEnvFile(), HERMES_API_KEY_ENV, apiKey);
      await writeAtomic(getHermesEnvPath(), newEnv);
      envWritten = true;
    }

    return NextResponse.json({
      success: true,
      message: `Hermes settings applied — ${declaredModels.length} model${declaredModels.length === 1 ? "" : "s"} under the ${HERMES_PROVIDER_ID} provider. Switch between them with hermes model, /model, or /model ${HERMES_PROVIDER_REF}:<model-id>.`,
      configPath,
      envPath: getHermesEnvPath(),
      backupPath,
      envWritten,
      models: declaredModels,
      unverified,
    });
  } catch (error) {
    console.log("Error updating hermes settings:", error);
    return NextResponse.json({ error: "Failed to update hermes settings" }, { status: 500 });
  }
}

// ─── DELETE ─────────────────────────────────────────────────────────────────

export async function DELETE(request) {
  try {
    // Accept both an absolute URL (what Next passes) and an origin-relative one,
    // and treat a missing `?model=` as "remove the whole provider".
    let modelToRemove = null;
    try {
      modelToRemove = new URL(String(request?.url || ""), "http://localhost").searchParams.get("model");
    } catch {
      modelToRemove = null;
    }

    const configPath = getHermesConfigPath();
    const existing = await readYamlDocument(configPath);
    if (existing.missing) {
      return NextResponse.json({ success: true, message: "No config file to reset", removed: 0 });
    }
    if (existing.corrupt) {
      return NextResponse.json(
        { success: false, error: `${configPath} is unreadable — nothing was removed` },
        { status: 409 },
      );
    }

    let doc = existing.data || {};
    if (!readHermesProvider(doc)) {
      return NextResponse.json({
        success: true,
        message: "No AFRouter provider in Hermes config.yaml",
        removed: 0,
      });
    }

    const baseUrl = normalizeHermesBaseUrl(readHermesProvider(doc)?.api || "");
    let removed = 0;
    if (modelToRemove) {
      const result = removeHermesProvider(doc, modelToRemove);
      doc = result.doc;
      removed = result.removed;
      if (removed === 0) {
        return NextResponse.json({
          success: true,
          message: `"${modelToRemove}" is not under the ${HERMES_PROVIDER_ID} provider — left untouched`,
          removed: 0,
        });
      }
    } else {
      const result = removeHermesProvider(doc, null);
      doc = result.doc;
      removed = result.removed;
    }

    // Drop every reference to us, including one to a model we just removed, so
    // no slot is left pointing at a provider entry that no longer exists. A
    // slot block that names no provider is not a usable model, so the whole
    // block goes — the same contract the previous implementation had.
    const entryGone = !readHermesProvider(doc);
    if (slotIsOurs(doc.model, baseUrl)) delete doc.model;
    if (slotIsOurs(doc[HERMES_DELEGATION_SLOT], baseUrl)) delete doc[HERMES_DELEGATION_SLOT];

    if (isObject(doc.auxiliary)) {
      const auxiliary = { ...doc.auxiliary };
      for (const { id } of HERMES_AUX_TASKS) {
        if (!slotIsOurs(auxiliary[id], baseUrl)) continue;
        // A single-model delete also clears a slot pinned to that model: it can
        // never be selected again, so leaving it would be a dangling reference.
        const gone = modelToRemove && auxiliary[id]?.model === modelToRemove;
        if (entryGone || gone) delete auxiliary[id];
      }
      doc.auxiliary = auxiliary;
    }

    await writeAtomic(configPath, stringifyYAML(doc));

    // Only the key we own is removed; a user's own OPENAI_API_KEY (Hermes'
    // documented fallback for hand-written custom endpoints) is theirs.
    const envText = await readEnvFile();
    const newEnv = removeEnvVar(envText, HERMES_API_KEY_ENV);
    if (newEnv !== envText) await writeAtomic(getHermesEnvPath(), newEnv);

    return NextResponse.json({
      success: true,
      message: entryGone
        ? `AFRouter provider and ${removed} model${removed === 1 ? "" : "s"} removed from Hermes config.yaml`
        : `${removed} model${removed === 1 ? "" : "s"} removed from the ${HERMES_PROVIDER_ID} provider`,
      configPath,
      removed,
    });
  } catch (error) {
    console.log("Error resetting hermes settings:", error);
    return NextResponse.json({ error: "Failed to reset hermes settings" }, { status: 500 });
  }
}
