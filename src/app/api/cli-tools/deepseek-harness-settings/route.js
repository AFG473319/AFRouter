"use server";

import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  CREDENTIAL_REF,
  DEFAULT_API_KEY,
  getAfrouterRoute,
  getCredentialsPath,
  getDshHome,
  getSettingsPath,
  hasCredentialRef,
  readCredentialsYaml,
  readSettingsYaml,
  removeAfrouterRoute,
  removeCredentialRef,
  removeModelFromRoute,
  stringifyYamlDocument,
  upsertAfrouterRoute,
  upsertCredentialRef,
  writeAtomic,
} from "@/lib/dshConfig.js";

const execAsync = promisify(exec);

// Conservative fallback for model ids resolvable from neither the live catalog
// nor the static registry — flagged "unverified", never invented (FR-006).
const FALLBACK_SPEC = { contextWindow: 200000, maxTokens: 32000, vision: false, reasoning: false };

const cwd = () => `http://127.0.0.1:${process.env.PORT || 20128}`;

// Detection (D2): the harness home or a `dsh` binary on PATH. Config files may
// not exist yet — that is "installed, not configured", not "not installed".
const checkInstalled = async () => {
  const home = getDshHome();
  for (const candidate of [home, getSettingsPath(), getCredentialsPath()]) {
    try {
      await fs.access(candidate);
      return true;
    } catch {
      /* try next */
    }
  }
  try {
    const isWindows = process.platform === "win32";
    await execAsync(isWindows ? "where dsh" : "which dsh", { windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

// Live catalog first: our own /v1/models, indexed by exact id and by the
// alias-translated spelling (a config may use `oc/…` where the catalog says
// `opencode/…`).
const resolveLiveCatalog = async () => {
  try {
    const res = await fetch(`${cwd()}/v1/models`, { signal: AbortSignal.timeout(4000) });
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

const capsToSpec = (caps, id) => ({
  name: id,
  contextWindow: Math.floor(Number(caps.contextWindow)),
  maxTokens: Math.floor(Number(caps.maxOutput)) || FALLBACK_SPEC.maxTokens,
  vision: caps.vision === true,
  reasoning: caps.reasoning === true,
});

// Catalog (exact, then alias-translated) -> static registry -> fallback.
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
      specs[id] = capsToSpec(caps, id);
    } else {
      specs[id] = { ...FALLBACK_SPEC, name: id };
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

const normalizeCompat = (compat) => {
  if (!compat || typeof compat !== "object") return null;
  const allowed = ["thinkingFormat", "supportsDeveloperRole", "maxTokensField"];
  const next = {};
  for (const key of allowed) {
    if (compat[key] !== undefined && compat[key] !== null && compat[key] !== "") {
      next[key] = compat[key];
    }
  }
  return Object.keys(next).length > 0 ? next : null;
};

// GET - install + AFRouter routing status (contracts/deepseek-harness-settings-api.md)
export async function GET() {
  try {
    const installed = await checkInstalled();
    if (!installed) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        harness: null,
        configPath: getSettingsPath(),
        credentialsPath: getCredentialsPath(),
        message: "DeepSeek Harness is not installed",
      });
    }

    const settingsResult = await readSettingsYaml();
    const credsResult = await readCredentialsYaml();
    const hasCredential = !credsResult.corrupt && hasCredentialRef(credsResult.data);

    if (settingsResult.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        harness: null,
        configPath: getSettingsPath(),
        credentialsPath: getCredentialsPath(),
      });
    }

    const route = getAfrouterRoute(settingsResult.data);
    const models = Array.isArray(route?.models)
      ? route.models.filter((m) => m?.id).map((m) => m.id)
      : [];

    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!route,
      configPath: getSettingsPath(),
      credentialsPath: getCredentialsPath(),
      harness: {
        baseURL: route?.baseURL || null,
        models,
        hasCredential,
        thinkingCompat: route?.compat?.thinkingFormat === "deepseek",
      },
    });
  } catch (error) {
    console.log("Error checking deepseek-harness settings:", error);
    return NextResponse.json({ error: "Failed to check deepseek-harness settings" }, { status: 500 });
  }
}

// POST - merge the `afrouter` route + credential ref (FR-003/FR-004/FR-005)
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models, modelSpecs, compat } = await request.json();
    const modelsArray = Array.isArray(models)
      ? models.filter((m) => typeof m === "string" && m)
      : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const settingsResult = await readSettingsYaml();
    if (settingsResult.corrupt) {
      return NextResponse.json(
        { success: false, error: "DeepSeek Harness settings.yaml is unreadable — fix or restore it before applying" },
        { status: 409 },
      );
    }

    const catalog = await resolveLiveCatalog();
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);
    // Client-supplied specs win over resolved ones (they may be hand-tuned).
    const merged = { ...specs };
    if (modelSpecs && typeof modelSpecs === "object") {
      for (const id of modelsArray) {
        if (modelSpecs[id]) merged[id] = { ...merged[id], ...modelSpecs[id], name: id };
      }
    }

    const normalizedCompat = normalizeCompat(compat);
    const nextSettings = upsertAfrouterRoute(settingsResult.data, {
      baseUrl,
      models: modelsArray,
      specs: merged,
      compat: normalizedCompat,
    });
    const { backupPath } = await writeAtomic(getSettingsPath(), stringifyYamlDocument(nextSettings));

    const credsResult = await readCredentialsYaml();
    if (!credsResult.corrupt) {
      const key = apiKey?.trim() || DEFAULT_API_KEY;
      const nextCreds = upsertCredentialRef(credsResult.data, key);
      await writeAtomic(getCredentialsPath(), stringifyYamlDocument(nextCreds));
    }

    return NextResponse.json({
      success: true,
      message:
        "DeepSeek Harness settings applied. Pick the `afrouter` route in dsh's model picker.",
      configPath: getSettingsPath(),
      credentialsPath: getCredentialsPath(),
      backupPath,
      written: modelsArray,
      unverified,
    });
  } catch (error) {
    console.log("Error applying deepseek-harness settings:", error);
    return NextResponse.json({ error: "Failed to apply deepseek-harness settings" }, { status: 500 });
  }
}

// DELETE - remove the route (or one model), ownership-scoped credential (D4/FR-007)
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const settingsResult = await readSettingsYaml();
    if (settingsResult.missing) {
      return NextResponse.json({
        success: true,
        message: "No DeepSeek Harness settings to reset",
        removed: 0,
        entryRemoved: false,
      });
    }
    if (settingsResult.corrupt || !getAfrouterRoute(settingsResult.data)) {
      return NextResponse.json({
        success: true,
        message: "No AFRouter route in DeepSeek Harness settings",
        removed: 0,
        entryRemoved: false,
      });
    }

    // removeAfrouterRoute mutates the passed object, so count before removing.
    const result = modelToRemove
      ? removeModelFromRoute(settingsResult.data, modelToRemove)
      : (() => {
          const modelCount = getAfrouterRoute(settingsResult.data)?.models?.length || 0;
          const { settings, entryRemoved } = removeAfrouterRoute(settingsResult.data);
          return { settings, removed: modelCount, entryRemoved };
        })();

    await writeAtomic(getSettingsPath(), stringifyYamlDocument(result.settings));

    // The credential ref goes only when it still holds the AFRouter default; a
    // real dashboard key survives so Reset cannot destroy a live credential.
    let credentialRemoved = false;
    const credsResult = await readCredentialsYaml();
    if (!credsResult.corrupt) {
      const { credentials, removed } = removeCredentialRef(credsResult.data);
      if (removed) {
        await writeAtomic(getCredentialsPath(), stringifyYamlDocument(credentials));
        credentialRemoved = true;
      }
    }

    return NextResponse.json({
      success: true,
      message: result.entryRemoved
        ? "AFRouter route removed from DeepSeek Harness"
        : `Removed ${result.removed} AFRouter model${result.removed === 1 ? "" : "s"} from DeepSeek Harness`,
      removed: result.removed,
      entryRemoved: result.entryRemoved,
      credentialRemoved,
    });
  } catch (error) {
    console.log("Error resetting deepseek-harness settings:", error);
    return NextResponse.json({ error: "Failed to reset deepseek-harness settings" }, { status: 500 });
  }
}