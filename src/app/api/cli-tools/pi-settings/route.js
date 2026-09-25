"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

const PROVIDER_ID = "afrouter";

// Conservative fallback for ids that resolve in neither the live catalog nor
// the static registry — written with specs flagged "unverified" (same policy
// as the zcode/opencode cards).
const FALLBACK_SPEC = { contextWindow: 200000, maxOutput: 32000, vision: false, reasoning: false };

const getConfigDir = () => path.join(os.homedir(), ".pi", "agent");
const getConfigPath = () => path.join(getConfigDir(), "models.json");

// Safe config read: ENOENT -> { notInstalled: true }; unparseable -> { corrupt: true }.
// A bad user file must never surface as a 500 (same policy as zcode-settings).
const readConfigResult = async () => {
  let raw;
  try {
    raw = await fs.readFile(getConfigPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { notInstalled: true };
    return { corrupt: true };
  }
  try {
    return { data: JSON.parse(raw) };
  } catch {
    return { corrupt: true };
  }
};

const isPlainObject = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Pi's provider shape (https://github.com/badlogic/pi-mono): { providers: { <id>:
// { baseUrl, api, apiKey, compat, models: [...] } } }. models.json may carry a
// top-level "providers" map — anything else Pi puts in the file lives outside it,
// so all writes only touch config.providers[PROVIDER_ID].
const readProvidersMap = (config) => {
  if (!isPlainObject(config)) return {};
  return isPlainObject(config.providers) ? config.providers : {};
};

const findAFRouterEntry = (config) => {
  const providers = readProvidersMap(config);
  return isPlainObject(providers[PROVIDER_ID]) ? providers[PROVIDER_ID] : null;
};

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Backup -> temp file -> atomic rename with EPERM/EACCES retries (Windows
// file-lock races with a running Pi), mirroring writeConfigAtomic elsewhere.
const writeConfigAtomic = async (config) => {
  const configPath = getConfigPath();
  await fs.mkdir(getConfigDir(), { recursive: true });
  try {
    await fs.copyFile(configPath, `${configPath}.bak-${timestamp()}`);
  } catch {
    // No existing file (first apply) — nothing to back up.
  }
  const tmpPath = `${configPath}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(config, null, 2));
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmpPath, configPath);
      break;
    } catch (error) {
      if ((error.code === "EPERM" || error.code === "EACCES") && attempt < 2) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      throw error;
    }
  }
};

// Self-fetch must target the port this instance actually listens on. The
// request URL carries it; PORT is only a fallback because the Next server may
// be started with --port and no PORT env (same convention as opencode/zcode).
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

// Resolve model ids -> Pi model entries. Catalog first (exact id, then
// alias-translated id), static registry second, conservative fallback
// (flagged) last. Never invent values.
const resolveModelSpecs = async (ids, catalog) => {
  const specs = new Map();
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
      specs.set(id, {
        contextWindow: caps.contextWindow,
        maxTokens: caps.maxOutput,
        input: ["text", caps.vision ? "image" : null].filter(Boolean),
        reasoning: caps.reasoning === true,
        verified: true,
      });
    } else {
      specs.set(id, {
        contextWindow: FALLBACK_SPEC.contextWindow,
        maxTokens: FALLBACK_SPEC.maxOutput,
        input: ["text"],
        reasoning: false,
        verified: false,
      });
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

// GET - report install + AFRouter routing status. Mirrors the response shape
// of the other cli-tools routes: { installed, hasAFRouter, configPath, pi: {...} }.
export async function GET(request) {
  try {
    const result = await readConfigResult();
    if (result.notInstalled) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        configPath: getConfigPath(),
        pi: null,
        message: "Pi is not installed",
      });
    }
    if (result.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath: getConfigPath(),
        pi: null,
      });
    }

    const entry = findAFRouterEntry(result.data);
    const models = entry && Array.isArray(entry.models) ? entry.models : [];

    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!entry,
      configPath: getConfigPath(),
      pi: {
        models: models.map((m) => m?.id).filter(Boolean),
        unverified: [],
        baseURL: entry?.baseUrl || null,
      },
    });
  } catch (error) {
    console.log("Error checking pi settings:", error);
    return NextResponse.json({ error: "Failed to check pi settings" }, { status: 500 });
  }
}

// POST - merge the AFRouter provider entry into Pi's models.json. `models` is
// the set of ids the card wants managed; already-present ids keep any
// user-tuned fields and only get their spec fields refreshed.
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models } = await request.json();
    const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const existing = await readConfigResult();
    if (existing.corrupt) {
      return NextResponse.json(
        { success: false, error: "Pi models.json is unreadable — fix or restore it before applying" },
        { status: 409 },
      );
    }
    const config = existing.data || {};

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);

    if (!isPlainObject(config.providers)) config.providers = {};
    const entry = isPlainObject(config.providers[PROVIDER_ID]) ? config.providers[PROVIDER_ID] : {};

    // Endpoint + credential always refresh; Pi accepts an env-var reference so
    // users who do not want the key on disk can set AFROUTER_API_KEY instead —
    // but only when the caller passed no key (default local token case keeps
    // sk_afrouter, matching every other card).
    entry.baseUrl = normalizedBaseUrl;
    entry.api = "openai-completions";
    entry.apiKey = apiKey || "sk_afrouter";
    entry.compat = {
      ...(isPlainObject(entry.compat) ? entry.compat : {}),
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    };

    // Merge models additively: new ids get the full built shape; existing ids
    // keep display `name` (when customized) and user-tuned fields, and only
    // the spec fields are refreshed.
    const existingModels = new Map(
      (Array.isArray(entry.models) ? entry.models : [])
        .filter((m) => m && typeof m.id === "string")
        .map((m) => [m.id, m]),
    );
    const merged = [];
    for (const id of modelsArray) {
      const spec = specs.get(id);
      const prev = existingModels.get(id);
      const modelEntry = {
        id,
        name: prev && typeof prev.name === "string" && prev.name !== id ? prev.name : id,
        input: spec?.input || ["text"],
        contextWindow: spec?.contextWindow ?? FALLBACK_SPEC.contextWindow,
        maxTokens: spec?.maxTokens ?? FALLBACK_SPEC.maxOutput,
        ...(spec?.reasoning ? { reasoning: true } : {}),
      };
      merged.push(modelEntry);
    }
    // Preserve user models AFRouter does not manage (same ownership spirit as
    // zcode-settings): entries with an id outside modelsArray stay untouched.
    for (const [id, m] of existingModels) {
      if (!modelsArray.includes(id)) merged.push(m);
    }
    entry.models = merged;

    config.providers[PROVIDER_ID] = entry;
    await writeConfigAtomic(config);

    return NextResponse.json({
      success: true,
      message: "Pi settings applied successfully!",
      configPath: getConfigPath(),
      written: modelsArray,
      unverified,
    });
  } catch (error) {
    console.log("Error applying pi settings:", error);
    return NextResponse.json({ error: "Failed to apply pi settings" }, { status: 500 });
  }
}

// DELETE - remove the AFRouter entry only. Hand-added providers and models
// outside the AFRouter entry are kept. `?model=<id>` removes a single AFRouter
// model instead of the whole entry.
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const result = await readConfigResult();
    if (result.notInstalled) {
      return NextResponse.json({ success: true, message: "No Pi models.json to reset" });
    }
    if (result.corrupt) {
      return NextResponse.json(
        { success: false, error: "Pi models.json is unreadable — fix or restore it first" },
        { status: 409 },
      );
    }

    const config = result.data;
    const entry = findAFRouterEntry(config);
    if (!entry) {
      return NextResponse.json({ success: true, message: "No AFRouter entry in Pi config" });
    }

    if (modelToRemove) {
      const models = Array.isArray(entry.models) ? entry.models : [];
      const next = models.filter((m) => m?.id !== modelToRemove);
      if (next.length === models.length) {
        return NextResponse.json({ success: true, message: `Model "${modelToRemove}" not in the AFRouter entry`, removed: 0 });
      }
      entry.models = next;
      await writeConfigAtomic(config);
      return NextResponse.json({ success: true, message: `Model "${modelToRemove}" removed`, removed: 1 });
    }

    delete config.providers[PROVIDER_ID];
    if (Object.keys(config.providers).length === 0) delete config.providers;
    await writeConfigAtomic(config);

    return NextResponse.json({ success: true, message: "AFRouter entry removed from Pi" });
  } catch (error) {
    console.log("Error resetting pi settings:", error);
    return NextResponse.json({ error: "Failed to reset pi settings" }, { status: 500 });
  }
}
