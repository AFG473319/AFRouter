import fs from "fs/promises";
import path from "path";
import os from "os";
import { parseYAML, stringifyYAML } from "confbox/yaml";
import { DESKTOP_PROFILE, WEB_PROFILE, LLM_PI_AI_ID, isPatchList } from "./dshProfilePatch.js";

// DeepSeek Harness (dsh) integration helpers — file I/O side.
//
// Two live documents, and only one of them is per-profile:
//
//   $DSH_HOME/profiles/<profile>/cordis.patch.yml   the profile's loader patch
//     (the live plugin config; `llm-pi-ai.providers.afrouter` lives here). The
//     Desktop app runs the `desktop` profile, `dsh web` runs `web`, so each
//     profile needs its own write.
//   $DSH_HOME/.credentials.yaml                     the credential store, shared
//     by every profile.
//
// `$DSH_HOME/settings.yaml` is NOT read any more: dsh-settings imports it once
// into the active profile patch and renames it `settings.yaml.imported`. See
// ./dshProfilePatch.js for the patch semantics and why a write replaces a row's
// whole config.

export const CREDENTIAL_REF = "AFROUTER_API_KEY";
export const DEFAULT_API_KEY = "sk_afrouter";

export const getDshHome = () => process.env.DSH_HOME || path.join(os.homedir(), ".dsh");

export const getProfilesDir = () => path.join(getDshHome(), "profiles");
export const getProfileDir = (profile) => path.join(getProfilesDir(), profile);
export const getPatchPath = (profile) => path.join(getProfileDir(profile), "cordis.patch.yml");
// The machine-local layer that outranks EVERY profile layer. Because a patch
// replaces a row's whole config, an `llm-pi-ai` row here would erase whatever
// the profile row sets — so we never write it, but we must report it.
export const getHomePatchPath = () => path.join(getDshHome(), "cordis.patch.yml");
export const getCredentialsPath = () => path.join(getDshHome(), ".credentials.yaml");
export const getLegacySettingsPath = () => path.join(getDshHome(), "settings.yaml");
export const getImportedSettingsPath = () => path.join(getDshHome(), "settings.yaml.imported");

export { DESKTOP_PROFILE, WEB_PROFILE };

const isPlainObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);

// A patch file must be a top-level ARRAY of entries (cordis-plugin-include
// rejects anything else with "config file must be a top-level array of
// entries"). Anything else is reported as corrupt rather than repaired.
//
// Returns { missing } | { corrupt } | { data }. Never throws.
export const readPatchFile = async (profile) => {
  let raw;
  try {
    raw = await fs.readFile(getPatchPath(profile), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const data = parseYAML(raw);
    if (!isPatchList(data)) return { corrupt: true };
    return { data };
  } catch {
    return { corrupt: true };
  }
};

// Does the machine-local layer declare an `llm-pi-ai` row? Layer order is
// bundles -> profile patch -> $DSH_HOME/cordis.patch.yml, and a patch replaces a
// row's whole config, so a home-level `llm-pi-ai` row ERASES the profile row's
// providers — an Apply would look successful and change nothing. Report it so
// the card can say so instead of failing silently.
export const homePatchShadowsLlmpiAi = async () => {
  let raw;
  try {
    raw = await fs.readFile(getHomePatchPath(), "utf-8");
  } catch {
    return false;
  }
  try {
    const data = parseYAML(raw);
    if (!isPatchList(data)) return false;
    return data.some((row) => isPlainObject(row) && row.id === LLM_PI_AI_ID);
  } catch {
    return false;
  }
};

// Same contract for the credential store, which is a mapping.
export const readCredentialsYaml = async () => {
  let raw;
  try {
    raw = await fs.readFile(getCredentialsPath(), "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    return { corrupt: true };
  }
  try {
    const data = parseYAML(raw);
    return { data: isPlainObject(data) ? data : {} };
  } catch {
    return { corrupt: true };
  }
};

// Timestamped backup -> temp file -> atomic rename with EPERM/EACCES retries
// (Windows file-lock races). Skips the backup when the target does not exist.
const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

export const writeAtomic = async (filePath, content) => {
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

const exists = async (candidate) => {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
};

// A profile counts as installed once its directory exists, which happens the
// first time that profile is launched.
export const isProfileInstalled = async (profile) => exists(getProfileDir(profile));
// The harness home existing at all means dsh has been used — with EITHER
// profile. Detection must not require the specific profile's directory, because
// the common case this integration fixes is "the Desktop app was installed and
// configured, and the profile patch exists but has no route yet".
export const isHarnessInstalled = async () => {
  if (await exists(getDshHome())) return true;
  if (await exists(getProfilesDir())) return true;
  if (await exists(getCredentialsPath())) return true;
  // A pre-import install may still be sitting on the legacy document.
  if (await exists(getLegacySettingsPath())) return true;
  return false;
};

// ─── .credentials.yaml ──────────────────────────────────────────────────────

const readRefValue = (creds) => creds?.refs?.[CREDENTIAL_REF];

export const hasCredentialRef = (creds) => {
  const value = readRefValue(creds);
  return typeof value === "string" && value.length > 0;
};

export const upsertCredentialRef = (creds, value) => {
  const next = isPlainObject(creds) ? creds : {};
  if (next.version === undefined) next.version = 1;
  const refs = isPlainObject(next.refs) ? next.refs : {};
  refs[CREDENTIAL_REF] = value || DEFAULT_API_KEY;
  next.refs = refs;
  return next;
};

// Reset ownership (D4): drop the ref only when it holds the AFRouter default
// (`sk_afrouter`). A real dashboard key the user configured is left in place,
// so Reset cannot destroy a live credential. `force` bypasses the guard for
// callers that explicitly intend to clear it.
export const removeCredentialRef = (creds, { force = false } = {}) => {
  const next = isPlainObject(creds) ? creds : {};
  const refs = next.refs;
  if (!isPlainObject(refs) || !Object.prototype.hasOwnProperty.call(refs, CREDENTIAL_REF)) {
    return { credentials: next, removed: false };
  }
  const value = refs[CREDENTIAL_REF];
  if (!force && value !== DEFAULT_API_KEY) {
    return { credentials: next, removed: false };
  }
  delete refs[CREDENTIAL_REF];
  if (Object.keys(refs).length === 0) delete next.refs;
  return { credentials: next, removed: true };
};

export const stringifyYamlDocument = (value) => stringifyYAML(value);

export { isPlainObject };
