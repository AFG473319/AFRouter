"use server";

import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import { readOwnership, writeOwnership } from "@/lib/zcodeModelOwnership.js";

const PROVIDER_NAME = "AFRouter";

// Conservative fallback for IDs that resolve in neither the live catalog nor
// the static registry (FR-006) — written with specs flagged "unverified".
const FALLBACK_SPECS = { context: 200000, output: 32000, input: ["text"] };

const getConfigPath = () => path.join(os.homedir(), ".zcode", "v2", "config.json");

// Safe config read: ENOENT -> { installed: false }; unparseable -> { corrupt: true }.
// Never throws to the handler — the UI must never see a 500 for a bad user file (SC-004).
const readConfig = async () => {
  try {
    const raw = await fs.readFile(getConfigPath(), "utf-8");
    try {
      return { data: JSON.parse(raw) };
    } catch {
      return { corrupt: true };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { notInstalled: true };
    return { corrupt: true };
  }
};

// Locate the AFRouter entry per research D4: match on name + source, never on a
// hardcoded map key (builtin entries use `builtin:<slug>` keys, custom use UUIDs).
const findAFRouterEntry = (config) => {
  if (!config || typeof config !== "object") return { entry: null, ambiguous: false };
  const providers = config.provider && typeof config.provider === "object" ? config.provider : {};
  const hits = Object.values(providers).filter(
    (v) => v && v.name === PROVIDER_NAME && v.source === "custom"
  );
  return { entry: hits[0] || null, ambiguous: hits.length > 1 };
};

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// Write sequence per research D3: timestamped backup -> temp file -> atomic rename
// with EPERM/EACCES retries (Windows file-lock races with ZCode/AV).
const writeConfigAtomic = async (config) => {
  const configPath = getConfigPath();
  const backupPath = `${configPath}.bak-${timestamp()}`;
  await fs.copyFile(configPath, backupPath);
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
  return { backupPath };
};

const listModelKeys = (entry) => Object.keys((entry && entry.models) || {});

// The in-config marker is written for interop, but it is NOT durable: ZCode
// rebuilds every model entry from its own key list on exit and drops unknown
// keys, so `zcode.afrouter` disappears the first time ZCode closes. Observed on
// a real config (7 marked models -> 7 unmarked, none removed), which is why
// ownership is tracked in the ~/.afrouter ledger instead and the marker is only
// a bootstrap hint.
const hasMarker = (modelEntry) => !!(modelEntry && modelEntry.zcode && modelEntry.zcode.afrouter === true);

// Alias -> provider id, using the same resolver the request path uses, so a
// config id like `oc/…` matches the live catalog's `opencode/…` spelling.
const resolveAliasPrefix = (prefix) => resolveProviderAlias(prefix);

// Ownership classification (FR-008). The ledger is authoritative once written:
// owned + recorded marker keys only; unrecorded-but-marked keys are
// candidates (freely-pasted Manual Config snippets). When the ledger has no
// record for this config yet — every config predating the ledger, and every
// config ZCode has already stripped the marker from — only marker-bearing
// keys count as owned. Resolvable-but-unmarked keys are also reported as
// `candidates`: they suggest a pre-ledger AFRouter apply, but routability
// does not prove authorship, so DELETE never touches them and Apply only
// adopts them with an explicit `adoptBootstrap` flag. Keys nothing can
// resolve are left alone as user data.
const classifyOwnership = async (entry, catalog) => {
  const keys = listModelKeys(entry);
  const { known, models } = await readOwnership(getConfigPath());
  if (known) {
    const recorded = new Set(models);
    const owned = keys.filter((k) => recorded.has(k));
    const ownedKeys = new Set(owned);
    return {
      known,
      owned,
      candidates: keys.filter((k) => !ownedKeys.has(k) && hasMarker(entry.models?.[k])),
    };
  }
  if (keys.length === 0) return { known, owned: [], candidates: [] };

  const { specs } = await resolveModelSpecs(keys, catalog);
  return {
    known,
    owned: keys.filter((k) => hasMarker(entry.models?.[k])),
    candidates: keys.filter((k) => !hasMarker(entry.models?.[k]) && specs.get(k)?.verified),
  };
};

// T007 (D1 + FR-005/FR-006): resolve specs from the live catalog —
// self-fetch of our own /v1/models (no auth), falling back to the static
// registry, then conservative fallback + unverified flag. Never invent values.
const resolveLiveCatalog = async (origin) => {
  try {
    const res = await fetch(`${origin}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data : [];
    const byId = new Map();
    // Also index by alias-translated id so config ids using a different alias
    // spelling than the catalog (e.g. `oc/…` vs `opencode/…`) still hit.
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

// Self-fetch must target the port this instance actually listens on. The
// request URL carries it; `process.env.PORT` is only a fallback because the
// Next server may be started with --port and no PORT env.
const resolveSelfOrigin = (request) => {
  try {
    const url = new URL(request?.url || "");
    if (url.port) return `http://127.0.0.1:${url.port}`;
  } catch {
    // fall through
  }
  return `http://127.0.0.1:${process.env.PORT || 20128}`;
};

const capsToSpec = (caps) => ({
  context: caps.contextWindow,
  output: caps.maxOutput,
  input: [
    "text",
    caps.vision ? "image" : null,
    caps.videoInput ? "video" : null,
    caps.audioInput ? "audio" : null,
  ].filter(Boolean),
  reasoning: caps.reasoning === true,
});

// Resolve model IDs -> per-ID spec + unverified list. Catalog first (exact id,
// then alias-translated id), static registry second, conservative fallback
// (flagged) last.
const resolveModelSpecs = async (ids, catalog) => {
  const specs = new Map();
  const unverified = [];
  for (const id of ids) {
    const bare = id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
    const prefix = id.includes("/") ? id.slice(0, id.indexOf("/")) : null;
    let caps = catalog?.byId?.get(id) || null;
    if (!caps && prefix) {
      const translatedPrefix = resolveAliasPrefix(prefix);
      caps = catalog?.byAliasId?.get(`${translatedPrefix}/${bare}`)
        || catalog?.byAliasId?.get(`${prefix}/${bare}`)
        || null;
    }
    if (!caps) {
      const staticCaps = getCapabilitiesForModel(prefix, bare);
      if (staticCaps && Number.isFinite(staticCaps.contextWindow)) {
        caps = staticCaps;
      }
    }
    if (caps && Number.isFinite(caps.contextWindow) && Number.isFinite(caps.maxOutput)) {
      specs.set(id, { ...capsToSpec(caps), verified: true });
    } else {
      specs.set(id, { ...FALLBACK_SPECS, reasoning: false, verified: false });
      unverified.push(id);
    }
  }
  return { specs, unverified };
};

// T007: exact ZCode model-entry shape per data-model.md. Brand-new entries get
// the dominant reasoning convention (research D6); user-tuned fields on
// existing entries are preserved by mergeModelEntries (FR-005).
const buildModelEntry = (spec) => {
  const entry = {
    limit: { context: spec.context, output: spec.output },
    modalities: { input: spec.input, output: ["text"] },
    zcode: { modalitiesConfigured: true, afrouter: true },
  };
  if (spec.reasoning) {
    entry.reasoning = { enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" };
  }
  return entry;
};

// T012 (FR-005): merge applied models additively. Existing keys are refreshed
// ONLY on limit/modalities — reasoning variants/defaultVariant, name and
// zcode.priority of a pre-existing entry are never overwritten. New keys get
// the full built shape including the afrouter ownership marker (D2).
// `onlyIds` scopes the write to ids in the current call so re-sending the
// whole entry (card hydration) never rewrites specs of hand-added models.
const mergeModels = (entry, specs, { onlyIds = null } = {}) => {
  const models = entry.models && typeof entry.models === "object" ? entry.models : {};
  for (const [id, spec] of specs) {
    if (onlyIds && !onlyIds.has(id)) continue;
    const existing = models[id];
    if (existing && typeof existing === "object") {
      models[id] = {
        ...existing,
        limit: { context: spec.context, output: spec.output },
        modalities: { input: spec.input, output: ["text"] },
      };
    } else {
      models[id] = buildModelEntry(spec);
    }
  }
  entry.models = models;
  return entry;
};

const findEntryKey = (config) => {
  const providers = config.provider && typeof config.provider === "object" ? config.provider : {};
  return Object.keys(providers).find(
    (k) => providers[k] && providers[k].name === PROVIDER_NAME && providers[k].source === "custom"
  ) || null;
};

// POST - merge AFRouter provider entry into ZCode config (contracts/zcode-settings-api.md)
//
// Ownership rule: `models` is the set of ids the card wants managed after
// this call. Brand-new ids are created/adopted. Already-owned ids get their
// limit/modalities refreshed (user-tuned fields preserved). Ids that are
// neither owned nor marked are NOT adopted and NOT rewritten: they stay in the
// entry byte-identical so re-sending the whole hydrated chip list can never
// silently convert hand-added models into deletable ones. Adopting such a
// pre-ledger bootstrap candidate requires the explicit `adoptBootstrap` flag.
// Endpoint/apiKey refresh always applies.
export async function POST(request) {
  try {
    const { baseUrl, apiKey, models, adoptBootstrap } = await request.json();
    const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
    if (!baseUrl || modelsArray.length === 0) {
      return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
    }

    const result = await readConfig();
    if (result.corrupt || result.notInstalled) {
      return NextResponse.json({ success: false, error: "ZCode config is missing or unreadable — fix or restore it before applying" }, { status: 409 });
    }

    const config = result.data;
    if (!config || typeof config !== "object" || !config.provider || typeof config.provider !== "object") {
      config.provider = {};
    }

    const normalizedBaseUrl = baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { specs, unverified } = await resolveModelSpecs(modelsArray, catalog);

    // Upsert entry: fresh UUID key when absent (D4), preserve otherwise.
    let entryKey = findEntryKey(config);
    if (!entryKey) {
      entryKey = crypto.randomUUID();
      config.provider[entryKey] = {
        name: PROVIDER_NAME,
        kind: "openai-compatible",
        options: { apiKey: apiKey || "", baseURL: normalizedBaseUrl },
        source: "custom",
        models: {},
      };
    }
    const entry = config.provider[entryKey];
    entry.kind = "openai-compatible";
    entry.source = "custom";
    entry.options = {
      ...entry.options,
      baseURL: normalizedBaseUrl,
      ...(apiKey ? { apiKey } : {}),
    };

    // Ownership + writability share one classification so they agree when the
    // live catalog is unavailable (test harness rejects fetch): pre-existing
    // resolvable ids fall back to the static registry for both.
    const { owned, candidates } = await classifyOwnership(entry, catalog);
    const ownedSet = new Set(owned);
    const existingKeys = new Set(listModelKeys(entry));
    // Writability is "owned OR brand-new OR explicitly adopted candidate".
    // Brand-new ids are created/adopted. Adopting a pre-existing candidate
    // requires it to be in the call AND the explicit flag — so the card's
    // "Adopt as mine" button works, but merely re-sending the whole hydrated
    // chip list never claims anything. Re-sent-but-unowned ids stay
    // byte-identical below because they are not in `writable`.
    const adoptedCandidates = new Set(
      modelsArray.filter((id) => existingKeys.has(id) && candidates.includes(id) && adoptBootstrap === true)
    );
    const markedKeys = new Set(modelsArray.filter((id) => hasMarker(entry.models?.[id])));
    const writableNew = new Set([
      ...modelsArray.filter(
        (id) =>
          adoptBootstrap === true ||
          !existingKeys.has(id) ||
          markedKeys.has(id) ||
          specs.get(id)?.verified !== true
      ),
      ...adoptedCandidates,
    ]);
    const writable = new Set([...ownedSet, ...writableNew]);
    mergeModels(entry, specs, { onlyIds: writable });
    // Record ownership in the ledger, not just the config. Only writable ids
    // are adopted; previously owned ids merely need to still be present, and
    // ones the user removed drop out. A re-added-by-hand id is no longer
    // claimed by default.
    const present = new Set(listModelKeys(entry));
    const adopted = [
      ...owned.filter((k) => present.has(k)),
      ...[...writableNew].filter((k) => present.has(k)),
    ];
    const { backupPath } = await writeConfigAtomic(config);
    await writeOwnership(getConfigPath(), [...new Set(adopted)]);

    return NextResponse.json({
      success: true,
      message: "ZCode settings applied successfully!",
      configPath: getConfigPath(),
      backupPath,
      written: modelsArray,
      unverified,
      restartAdvice: true,
    });
  } catch (error) {
    console.log("Error applying zcode settings:", error);
    return NextResponse.json({ error: "Failed to apply zcode settings" }, { status: 500 });
  }
}

// DELETE - ownership-scoped removal (D2 / FR-008). Only models AFRouter owns
// (per the durable ledger, or still-marked keys on pre-ledger configs) are
// removed; user-added models in the same entry survive. Bootstrap candidates
// (resolvable but unmarked, no ledger record) are reported as
// `skippedCandidates` and never deleted silently. The entry itself is
// deleted only when its models map becomes empty.
export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const modelToRemove = searchParams.get("model");

    const result = await readConfig();
    if (result.corrupt || result.notInstalled) {
      return NextResponse.json({ success: true, message: "No ZCode config to reset", removed: 0, entryRemoved: false, skippedCandidates: [] });
    }

    const config = result.data;
    const entryKey = findEntryKey(config);
    if (!entryKey) {
      return NextResponse.json({ success: true, message: "No AFRouter entry in ZCode config", removed: 0, entryRemoved: false, skippedCandidates: [] });
    }

    const entry = config.provider[entryKey];
    const models = entry.models && typeof entry.models === "object" ? entry.models : {};
    const catalog = await resolveLiveCatalog(resolveSelfOrigin(request));
    const { owned, candidates } = await classifyOwnership(entry, catalog);
    const ownedSet = new Set(owned);
    let removed = 0;
    for (const key of Object.keys(models)) {
      const matches = modelToRemove ? key === modelToRemove : true;
      if (matches && ownedSet.has(key)) {
        delete models[key];
        removed++;
      }
    }

    // Bootstrap candidates are never deleted silently: a full Reset reports
    // them so the user can adopt-then-remove or delete by hand inside ZCode.
    const remainingCandidates = modelToRemove
      ? []
      : candidates.filter((k) => Object.prototype.hasOwnProperty.call(models, k));

    let entryRemoved = false;
    if (Object.keys(models).length === 0) {
      delete config.provider[entryKey];
      entryRemoved = true;
    }

    if (removed > 0 || entryRemoved) {
      await writeConfigAtomic(config);
      const remaining = Object.keys(models);
      await writeOwnership(
        getConfigPath(),
        entryRemoved ? [] : owned.filter((k) => remaining.includes(k))
      );
    }

    return NextResponse.json({
      success: true,
      message: entryRemoved
        ? "AFRouter entry removed from ZCode"
        : `Removed ${removed} AFRouter model${removed === 1 ? "" : "s"} from ZCode`,
      removed,
      entryRemoved,
      skippedCandidates: remainingCandidates,
    });
  } catch (error) {
    console.log("Error resetting zcode settings:", error);
    return NextResponse.json({ error: "Failed to reset zcode settings" }, { status: 500 });
  }
}
// GET - report install + AFRouter routing status per contracts/zcode-settings-api.md
export async function GET(request) {
  try {
    const result = await readConfig();
    if (result.notInstalled) {
      return NextResponse.json({
        installed: false,
        hasAFRouter: false,
        configPath: getConfigPath(),
        zcode: null,
        message: "ZCode is not installed",
      });
    }
    if (result.corrupt) {
      return NextResponse.json({
        installed: true,
        corrupt: true,
        hasAFRouter: false,
        configPath: getConfigPath(),
        zcode: null,
      });
    }
    const { entry, ambiguous } = findAFRouterEntry(result.data);
    const models = entry ? listModelKeys(entry) : [];
    // T013: flag entry models whose specs are not resolvable from the live
    // catalog or static registry so the card can badge them (FR-006).
    let unverified = [];
    let owned = [];
    let candidates = [];
    // The self origin takes the request port when available; the batch
    // `all-statuses` endpoint calls GET with no request, so fall back to the
    // dashboard default port before giving up on the live catalog entirely.
    let catalog = null;
    if (entry && models.length > 0) {
      catalog =
        (await resolveLiveCatalog(resolveSelfOrigin(request)))
        || (await resolveLiveCatalog(`http://127.0.0.1:${process.env.PORT || 20128}`));
      const { specs } = await resolveModelSpecs(models, catalog);
      unverified = models.filter((k) => specs.get(k) && !specs.get(k).verified);
      ({ owned, candidates } = await classifyOwnership(entry, catalog));
    }
    return NextResponse.json({
      installed: true,
      corrupt: false,
      hasAFRouter: !!entry,
      configPath: getConfigPath(),
      ambiguousEntry: ambiguous,
      zcode: {
        models,
        afrouterModels: owned,
        unverified,
        baseURL: entry?.options?.baseURL || null,
        bootstrapCandidates: candidates,
      },
    });
  } catch (error) {
    console.log("Error checking zcode settings:", error);
    return NextResponse.json({ error: "Failed to check zcode settings" }, { status: 500 });
  }
}
