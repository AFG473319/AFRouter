import { NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { resolveProviderAlias } from "open-sse/services/model.js";
import {
  DEFAULT_API_KEY,
  getCredentialsPath,
  getDshHome,
  getPatchPath,
  getProfileDir,
  hasCredentialRef,
  homePatchShadowsLlmpiAi,
  isHarnessInstalled,
  isPlainObject,
  readCredentialsYaml,
  readPatchFile,
  removeCredentialRef,
  stringifyYamlDocument,
  upsertCredentialRef,
  writeAtomic,
} from "@/lib/dshConfig.js";
import {
  ROUTE_KEY,
  getAfrouterRoute,
  getDefaultModel,
  normalizeBaseUrl,
  readRouteBaseUrl,
  readRouteModels,
  removeAfrouterRoute,
  removeDefaultModel,
  removeModelFromRoute,
  upsertAfrouterRoute,
  upsertDefaultModel,
} from "@/lib/dshProfilePatch.js";

const execAsync = promisify(exec);

// Conservative fallback for model ids resolvable from neither the live catalog
// nor the static registry — flagged "unverified", never invented (FR-006).
const FALLBACK_SPEC = { contextWindow: 200000, maxTokens: 32000, vision: false, reasoning: false };

const cwd = () => `http://127.0.0.1:${process.env.PORT || 20128}`;

const fileExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

// Detection (D2): the harness home, a `dsh` binary on PATH. The profile patch
// may not exist yet — that is "installed, not configured", not "not installed".
const checkInstalled = async () => {
  if (await isHarnessInstalled()) return true;
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
const resolveModelSpecs = (ids, catalog) => {
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

// A hand-declared dsh route with an empty `models` list is refused where it is
// written, so never emit a patch the harness would reject.
const wouldBeRejected = (patchList) => {
  const route = getAfrouterRoute(patchList);
  if (!route) return false;
  return !isPlainObject(route) || !Array.isArray(route.models) || route.models.length === 0;
};

/**
 * Build the GET/POST/DELETE handlers for one dsh profile.
 *
 * The Desktop app and `dsh web` are separate Cordis profiles with separate
 * `cordis.patch.yml` files, so each dashboard card owns exactly one profile and
 * the handlers are otherwise identical.
 *
 * @param profile - shipped dsh profile name (`desktop` or `web`).
 * @param settingsUrl - dashboard route the card calls, echoed in messages.
 */
export const createDshSettingsHandlers = ({ profile, settingsUrl }) => {
  // GET - install + AFRouter routing status for this profile.
  const GET = async () => {
    try {
      const installed = await checkInstalled();
      const configPath = getPatchPath(profile);
      if (!installed) {
        return NextResponse.json({
          installed: false,
          hasAFRouter: false,
          harness: null,
          profile,
          configPath,
          credentialsPath: getCredentialsPath(),
          message: "DeepSeek Harness is not installed",
        });
      }

      const patch = await readPatchFile(profile);
      const credsResult = await readCredentialsYaml();
      const hasCredential = !credsResult.corrupt && hasCredentialRef(credsResult.data);

      if (patch.corrupt) {
        return NextResponse.json({
          installed: true,
          corrupt: true,
          hasAFRouter: false,
          harness: null,
          profile,
          configPath,
          credentialsPath: getCredentialsPath(),
        });
      }

      const patchList = patch.missing ? [] : patch.data;
      const route = getAfrouterRoute(patchList);
      const defaultModel = getDefaultModel(patchList);

      return NextResponse.json({
        installed: true,
        corrupt: false,
        hasAFRouter: !!route,
        profile,
        configPath,
        credentialsPath: getCredentialsPath(),
        // True when the legacy document was imported, i.e. a route may still be
        // sitting in settings.yaml.imported and not in the live patch.
        legacyImported: await fileExists(`${getDshHome()}/settings.yaml.imported`),
        // True when the higher-precedence home layer declares `llm-pi-ai`, which
        // would erase this profile's providers map.
        homePatchShadows: await homePatchShadowsLlmpiAi(),
        harness: {
          baseURL: readRouteBaseUrl(route),
          models: readRouteModels(route),
          hasCredential,
          thinkingCompat: route?.compat?.thinkingFormat === "deepseek",
          defaultModel: defaultModel?.provider === ROUTE_KEY ? defaultModel.model : null,
          defaultReasoningEffort:
            defaultModel?.provider === ROUTE_KEY ? defaultModel.reasoningEffort || null : null,
        },
      });
    } catch (error) {
      console.log(`Error checking deepseek-harness(${profile}) settings:`, error);
      return NextResponse.json({ error: "Failed to check DeepSeek Harness settings" }, { status: 500 });
    }
  };

  // POST - merge the `afrouter` route + credential ref (FR-003/FR-004/FR-005)
  const POST = async (request) => {
    try {
      const { baseUrl, apiKey, models, modelSpecs, compat, setDefault, defaultModel, reasoningEffort } =
        await request.json();
      const modelsArray = Array.isArray(models) ? models.filter((m) => typeof m === "string" && m) : [];
      if (!baseUrl || modelsArray.length === 0) {
        return NextResponse.json({ error: "baseUrl and at least one model are required" }, { status: 400 });
      }

      const patch = await readPatchFile(profile);
      if (patch.corrupt) {
        return NextResponse.json(
          {
            success: false,
            error: `DeepSeek Harness ${profile} profile cordis.patch.yml is unreadable — fix or restore it before applying`,
          },
          { status: 409 },
        );
      }

      const catalog = await resolveLiveCatalog();
      const { specs, unverified } = resolveModelSpecs(modelsArray, catalog);
      // Client-supplied specs win over resolved ones (they may be hand-tuned).
      const merged = { ...specs };
      if (modelSpecs && typeof modelSpecs === "object") {
        for (const id of modelsArray) {
          if (modelSpecs[id]) merged[id] = { ...merged[id], ...modelSpecs[id], name: id };
        }
      }

      const normalizedCompat = normalizeCompat(compat);
      let nextPatch = upsertAfrouterRoute(patch.missing ? [] : patch.data, {
        baseUrl,
        models: modelsArray,
        specs: merged,
        compat: normalizedCompat,
      });

      // Opt-in default pin. `defaultModel` defaults to the first selected model.
      const pinnedModel = typeof defaultModel === "string" && defaultModel ? defaultModel : modelsArray[0];
      if (setDefault === true && pinnedModel) {
        nextPatch = upsertDefaultModel(nextPatch, {
          model: pinnedModel,
          reasoningEffort: typeof reasoningEffort === "string" ? reasoningEffort : undefined,
        });
      } else if (setDefault === false) {
        // Explicitly off: drop the pin only while it still points at AFRouter.
        nextPatch = removeDefaultModel(nextPatch).patchList;
      }

      if (wouldBeRejected(nextPatch)) {
        return NextResponse.json(
          { success: false, error: "Refusing to write a route with an empty models list" },
          { status: 400 },
        );
      }

      await fs.mkdir(getProfileDir(profile), { recursive: true });
      const { backupPath } = await writeAtomic(getPatchPath(profile), stringifyYamlDocument(nextPatch));

      const credsResult = await readCredentialsYaml();
      if (!credsResult.corrupt) {
        const key = apiKey?.trim() || DEFAULT_API_KEY;
        const nextCreds = upsertCredentialRef(credsResult.data, key);
        await writeAtomic(getCredentialsPath(), stringifyYamlDocument(nextCreds));
      }

      const defaultNote =
        setDefault === true ? ` Default model set to ${ROUTE_KEY}/${pinnedModel}.` : "";

      return NextResponse.json({
        success: true,
        message:
          `DeepSeek Harness settings applied to the ${profile} profile. ` +
          `Pick the \`${ROUTE_KEY}\` route in dsh's model picker.${defaultNote}`,
        profile,
        configPath: getPatchPath(profile),
        credentialsPath: getCredentialsPath(),
        backupPath,
        written: modelsArray,
        unverified,
      });
    } catch (error) {
      console.log(`Error applying deepseek-harness(${profile}) settings:`, error);
      return NextResponse.json({ error: "Failed to apply DeepSeek Harness settings" }, { status: 500 });
    }
  };

  // DELETE - remove the route (or one model), ownership-scoped credential (D4/FR-007)
  const DELETE = async (request) => {
    try {
      const { searchParams } = new URL(request.url);
      const modelToRemove = searchParams.get("model");

      const patch = await readPatchFile(profile);
      if (patch.missing || patch.corrupt || !getAfrouterRoute(patch.data)) {
        return NextResponse.json({
          success: true,
          message: `No AFRouter route in the DeepSeek Harness ${profile} profile`,
          removed: 0,
          entryRemoved: false,
          defaultCleared: false,
        });
      }

      const result = modelToRemove
        ? removeModelFromRoute(patch.data, modelToRemove)
        : (() => {
            const modelCount = readRouteModels(getAfrouterRoute(patch.data)).length;
            const { patchList, entryRemoved } = removeAfrouterRoute(patch.data);
            return { patchList, removed: modelCount, entryRemoved };
          })();

      // A full reset also releases a default pin that still points at AFRouter;
      // a single-model removal leaves the pin alone.
      let defaultCleared = false;
      if (!modelToRemove) {
        const cleared = removeDefaultModel(result.patchList);
        result.patchList = cleared.patchList;
        defaultCleared = cleared.removed;
      }

      await writeAtomic(getPatchPath(profile), stringifyYamlDocument(result.patchList));

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
          ? `AFRouter route removed from the DeepSeek Harness ${profile} profile`
          : `Removed ${result.removed} AFRouter model${result.removed === 1 ? "" : "s"} from the DeepSeek Harness ${profile} profile`,
        removed: result.removed,
        entryRemoved: result.entryRemoved,
        credentialRemoved,
        defaultCleared,
        settingsUrl,
      });
    } catch (error) {
      console.log(`Error resetting deepseek-harness(${profile}) settings:`, error);
      return NextResponse.json({ error: "Failed to reset DeepSeek Harness settings" }, { status: 500 });
    }
  };

  return { GET, POST, DELETE };
};
