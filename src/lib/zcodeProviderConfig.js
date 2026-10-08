// Writer for ZCode's Personal provider layer: ~/.zcode/v2/provider_config.json
// (env override ZCODE_PERSONAL_PROVIDER_CONFIG_FILE, base dir override
// ZCODE_DATA_BASE_DIR — apps/zcode-cli/packages/cli/src/provider-runtime-env.ts).
//
// Why this file exists (root cause): ZCode 3.14+ imports the legacy
// ~/.zcode/v2/config.json into the Personal layer ONLY ONCE, when
// provider_config.json does not exist yet
// (packages/provider-node/src/personal-provider-config-repository.ts
// #readLocked, importer
// apps/zcode-cli/packages/bootstrap/src/app/legacy-cli-personal-provider-config-importer.ts).
// The importer copies provider name, apiKey, baseURL, kind, model ids and
// contextWindow only — `reasoning.variants` / `defaultVariant` are dropped,
// and any model added after that first import never appears. The selectable
// thinking efforts must therefore be written here, as
// `modelConfigRules.providerModelRules[].config.optionSpecs.reasoningLevel.values`.
//
// Format (packages/provider-node/src/provider-config-file-codec.ts,
// packages/provider/src/config/rule-data-schema.ts,
// packages/shared/src/model-config.ts — every schema is .strict()):
//
// {
//   "schemaVersion": 1,
//   "config": {
//     "providerOrder": ["<providerId>", ...],
//     "providerConfigRules": { "providerRules": [
//       { "providerId": "<uuid>", "providerName": "AFRouter", "config": {
//         "group": "standard-personal",
//         "access": { "type": "api-key", "apiKey": "..." },
//         "api": { "type": "openai-chat-completions", "baseUrl": "..." },
//         "personalModelIds": [...], "modelOrder": [...] } } ] },
//     "modelConfigRules": {
//       "providerModelRules": [
//         { "providerId": "<uuid>", "modelId": "...", "config": {
//           "properties": { "contextWindow": 400000,
//             "inputFormat": { "supportsText": true, "supportsImage": true } },
//           "optionSpecs": {
//             "reasoningLevel": { "values": ["low", "medium", "high"] },
//             "maxOutputTokens": { "max": 128000 } } } } ],
//       "manualProviderModelRules": [] } }
// }
//
// Rules we rely on (all verified against ZCode master):
// - reasoningLevel.values: non-empty, unique, ordered lowest→highest; the
//   LAST value is ZCode's default tier, the FIRST is for auxiliary calls.
//   There is no defaultVariant field. `map` is inherited from ZCode's
//   builtin modelApiRules for the API type (the builtin catch-all declares
//   the empty merge-patch "{}"), so it is never written here.
// - providerModelRules are the sparse "smart" rules; manualProviderModelRules
//   are the user's hand-set rules. The same providerId+modelId in both
//   lists is a schema error — a manual rule always wins and is left alone.
// - If the file fails validation ZCode leaves it on disk but runs with an
//   EMPTY personal layer (the user loses every custom provider in the app),
//   so we validate the full document before writing and abort on any error.
// - No ownership marker is written here (unlike config.json): an unknown
//   key would fail the strict schema. Ownership stays in the ~/.afrouter
//   ledger (src/lib/zcodeModelOwnership.js), keyed by the config.json path.
//
// Concurrency: ZCode writers lock with a directory `<file>.lock` holding
// owner-<token>.json, write a temp file in the same directory and rename
// it (packages/shared/src/node/{atomicFileLock,privateFilePersistence}.ts).
// The desktop app polls the file about every second, so a rename is all
// it takes to pick changes up. We mirror the lock, the 8s max wait and
// the EPERM/EBUSY/EACCES rename retries exactly.

import fs from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { zcodeReasoningValues } from "./zcodeReasoningLevels.js";

const SCHEMA_VERSION = 1;
const PROVIDER_NAME = "AFRouter";
const PROVIDER_GROUP = "standard-personal";
const API_TYPE = "openai-chat-completions";

// Mirrors ZCode's DEFAULT_* constants
// (packages/shared/src/node/privateFilePersistence.ts).
const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400];
const LOCK_OWNERLESS_GRACE_MS = 100;
const LOCK_MAX_WAIT_MS = 8000;
const RENAME_RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

// Same code ZCode uses for lock timeouts (packages/shared/src/errors.ts),
// so callers can branch on it identically.
export const ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE = "ZCODE_FILE_LOCK_TIMEOUT";

export class PersonalConfigCorruptError extends Error {
  constructor(filePath) {
    super(`ZCode personal provider config is not valid JSON: ${filePath}`);
    this.name = "PersonalConfigCorruptError";
    this.filePath = filePath;
  }
}

export class PersonalConfigInvalidError extends Error {
  constructor(message, filePath) {
    super(`${message} (${filePath})`);
    this.name = "PersonalConfigInvalidError";
    this.filePath = filePath;
  }
}

// Resolved per call so env overrides (and the test suite's temp dirs)
// take effect without reloading the module.
export function getPersonalConfigPath() {
  const explicit = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim();
  if (explicit) return explicit;
  const baseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir();
  return path.join(baseDir, ".zcode", "v2", "provider_config.json");
}

const timestamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

// ---------------------------------------------------------------------------
// Shape validation — mirrors ZCode's strict zod schemas so a document we
// write always decodes. Unknown keys, wrong types and cross-list
// duplicates are all rejected (ZCode would run an empty layer otherwise).
// ---------------------------------------------------------------------------

const PROVIDER_API_TYPES = new Set([
  "anthropic-messages",
  "openai-chat-completions",
  "openai-responses",
]);
const PROVIDER_GROUPS = new Set([
  "standard-personal",
  "zai-family",
  "bigmodel-family",
]);
const ACCESS_TYPES = new Set(["api-key", "zhipu-coding-plan-api-key"]);
const PROVIDER_CONFIG_KEYS = new Set([
  "group",
  "logo",
  "access",
  "api",
  "builtinModelIds",
  "personalModelIds",
  "modelOrder",
  "visibility",
]);
const MODEL_PROPERTY_KEYS = new Set([
  "requiresMfjsToolSchema",
  "contextWindow",
  "inputFormat",
  "outputFormat",
  "supportsToolCall",
  "supportsJsonSchemaOutput",
  "supportsNativeWebSearch",
  "supportsMidConversationSystem",
]);
const INPUT_FORMAT_KEYS = new Set([
  "supportsText",
  "supportsImage",
  "supportsVideo",
  "supportsAudio",
  "supportsPdf",
]);
const OPTION_SPEC_KEYS = new Set(["reasoningLevel", "maxOutputTokens"]);
const ENUM_SPEC_KEYS = new Set(["values", "map"]);
const LIMIT_SPEC_KEYS = new Set(["max", "map"]);

const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isNonEmptyString = (v) => typeof v === "string" && v.trim() !== "";

function checkKeys(obj, allowed, where, issues) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) issues.push(`${where}: unknown key "${key}"`);
  }
}

function checkIdList(value, where, issues) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    issues.push(`${where}: must be an array of non-empty strings`);
  }
}

function validateProviderRule(rule, where, issues) {
  if (!isRecord(rule)) {
    issues.push(`${where}: rule must be an object`);
    return;
  }
  checkKeys(rule, new Set(["providerId", "templateId", "providerName", "enabled", "config"]), where, issues);
  if (!isNonEmptyString(rule.providerId)) {
    issues.push(`${where}: providerId must be a non-empty string`);
  }
  if (rule.templateId !== undefined && rule.templateId !== null && !isNonEmptyString(rule.templateId)) {
    issues.push(`${where}: templateId must be a non-empty string`);
  }
  if (rule.providerName !== undefined && rule.providerName !== null && !isNonEmptyString(rule.providerName)) {
    issues.push(`${where}: providerName must be a non-empty string`);
  }
  if (rule.enabled !== undefined && typeof rule.enabled !== "boolean") {
    issues.push(`${where}: enabled must be a boolean`);
  }
  const config = rule.config;
  if (!isRecord(config)) {
    issues.push(`${where}: config must be an object`);
    return;
  }
  checkKeys(config, PROVIDER_CONFIG_KEYS, `${where}.config`, issues);
  if (config.group !== undefined && config.group !== null && !PROVIDER_GROUPS.has(config.group)) {
    issues.push(`${where}.config.group: unknown group`);
  }
  if (config.access !== undefined && config.access !== null) {
    const access = config.access;
    if (!isRecord(access)) {
      issues.push(`${where}.config.access: must be an object`);
    } else {
      checkKeys(access, new Set(["type", "apiKey", "apiKeyManagementUrl"]), `${where}.config.access`, issues);
      if (!ACCESS_TYPES.has(access.type)) {
        issues.push(`${where}.config.access.type: unknown access type`);
      }
      if (access.apiKey !== undefined && access.apiKey !== null && typeof access.apiKey !== "string") {
        issues.push(`${where}.config.access.apiKey: must be a string`);
      }
    }
  }
  if (config.api !== undefined && config.api !== null) {
    const api = config.api;
    if (!isRecord(api)) {
      issues.push(`${where}.config.api: must be an object`);
    } else {
      checkKeys(api, new Set(["type", "baseUrl", "headers"]), `${where}.config.api`, issues);
      if (!PROVIDER_API_TYPES.has(api.type)) {
        issues.push(`${where}.config.api.type: unknown api type`);
      }
      if (api.baseUrl !== undefined && api.baseUrl !== null) {
        try {
          new URL(api.baseUrl);
        } catch {
          issues.push(`${where}.config.api.baseUrl: not a valid URL`);
        }
      }
    }
  }
  checkIdList(config.builtinModelIds, `${where}.config.builtinModelIds`, issues);
  checkIdList(config.personalModelIds, `${where}.config.personalModelIds`, issues);
  checkIdList(config.modelOrder, `${where}.config.modelOrder`, issues);
}

function validateModelRule(rule, where, issues) {
  if (!isRecord(rule)) {
    issues.push(`${where}: rule must be an object`);
    return;
  }
  checkKeys(rule, new Set(["providerId", "modelId", "config"]), where, issues);
  if (!isNonEmptyString(rule.providerId)) {
    issues.push(`${where}: providerId must be a non-empty string`);
  }
  if (!isNonEmptyString(rule.modelId)) {
    issues.push(`${where}: modelId must be a non-empty string`);
  }
  const config = rule.config;
  if (!isRecord(config)) {
    issues.push(`${where}: config must be an object`);
    return;
  }
  checkKeys(config, new Set(["enabled", "properties", "optionSpecs"]), `${where}.config`, issues);
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    issues.push(`${where}.config.enabled: must be a boolean`);
  }
  const properties = config.properties;
  if (properties !== undefined && properties !== null) {
    if (!isRecord(properties)) {
      issues.push(`${where}.config.properties: must be an object`);
    } else {
      checkKeys(properties, MODEL_PROPERTY_KEYS, `${where}.config.properties`, issues);
      if (properties.contextWindow !== undefined) {
        if (!Number.isInteger(properties.contextWindow) || properties.contextWindow <= 0) {
          issues.push(`${where}.config.properties.contextWindow: must be a positive integer`);
        }
      }
      const inputFormat = properties.inputFormat;
      if (inputFormat !== undefined && inputFormat !== null) {
        if (!isRecord(inputFormat)) {
          issues.push(`${where}.config.properties.inputFormat: must be an object`);
        } else {
          checkKeys(inputFormat, INPUT_FORMAT_KEYS, `${where}.config.properties.inputFormat`, issues);
          for (const key of Object.keys(inputFormat)) {
            if (typeof inputFormat[key] !== "boolean") {
              issues.push(`${where}.config.properties.inputFormat.${key}: must be a boolean`);
            }
          }
        }
      }
    }
  }
  const optionSpecs = config.optionSpecs;
  if (optionSpecs !== undefined && optionSpecs !== null) {
    if (!isRecord(optionSpecs)) {
      issues.push(`${where}.config.optionSpecs: must be an object`);
    } else {
      checkKeys(optionSpecs, OPTION_SPEC_KEYS, `${where}.config.optionSpecs`, issues);
      const reasoningLevel = optionSpecs.reasoningLevel;
      if (reasoningLevel !== undefined && reasoningLevel !== null) {
        if (!isRecord(reasoningLevel)) {
          issues.push(`${where}.config.optionSpecs.reasoningLevel: must be an object`);
        } else {
          checkKeys(reasoningLevel, ENUM_SPEC_KEYS, `${where}.config.optionSpecs.reasoningLevel`, issues);
          const values = reasoningLevel.values;
          if (values !== undefined) {
            if (
              !Array.isArray(values) ||
              values.length === 0 ||
              !values.every(isNonEmptyString) ||
              new Set(values).size !== values.length
            ) {
              issues.push(
                `${where}.config.optionSpecs.reasoningLevel.values: must be a non-empty array of unique non-empty strings`
              );
            }
          }
        }
      }
      const maxOutputTokens = optionSpecs.maxOutputTokens;
      if (maxOutputTokens !== undefined && maxOutputTokens !== null) {
        if (!isRecord(maxOutputTokens)) {
          issues.push(`${where}.config.optionSpecs.maxOutputTokens: must be an object`);
        } else {
          checkKeys(maxOutputTokens, LIMIT_SPEC_KEYS, `${where}.config.optionSpecs.maxOutputTokens`, issues);
          if (maxOutputTokens.max !== undefined) {
            if (!Number.isInteger(maxOutputTokens.max) || maxOutputTokens.max <= 0) {
              issues.push(`${where}.config.optionSpecs.maxOutputTokens.max: must be a positive integer`);
            }
          }
        }
      }
    }
  }
}

/**
 * Validate a provider_config.json document against ZCode's strict schemas.
 * Returns a list of human-readable issues (empty when valid).
 */
export function validatePersonalConfigShape(doc) {
  const issues = [];
  if (!isRecord(doc)) {
    return ["document must be an object"];
  }
  checkKeys(doc, new Set(["schemaVersion", "config"]), "document", issues);
  if (doc.schemaVersion !== SCHEMA_VERSION) {
    issues.push(`schemaVersion must be ${SCHEMA_VERSION}`);
  }
  const config = doc.config;
  if (!isRecord(config)) {
    return [...issues, "config must be an object"];
  }
  checkKeys(config, new Set(["providerOrder", "providerConfigRules", "modelConfigRules", "defaultModelSelection"]), "config", issues);
  checkIdList(config.providerOrder, "config.providerOrder", issues);

  const providerConfigRules = config.providerConfigRules;
  if (providerConfigRules !== undefined) {
    if (!isRecord(providerConfigRules)) {
      issues.push("config.providerConfigRules: must be an object");
    } else {
      checkKeys(providerConfigRules, new Set(["providerRules"]), "config.providerConfigRules", issues);
      const rules = providerConfigRules.providerRules;
      if (rules !== undefined) {
        if (!Array.isArray(rules)) {
          issues.push("config.providerConfigRules.providerRules: must be an array");
        } else {
          const seen = new Set();
          rules.forEach((rule, index) => {
            validateProviderRule(rule, `config.providerConfigRules.providerRules[${index}]`, issues);
            if (isNonEmptyString(rule?.providerId)) {
              if (seen.has(rule.providerId)) {
                issues.push(`config.providerConfigRules.providerRules: duplicate providerId "${rule.providerId}"`);
              }
              seen.add(rule.providerId);
            }
          });
        }
      }
    }
  }

  const modelConfigRules = config.modelConfigRules;
  if (modelConfigRules !== undefined) {
    if (!isRecord(modelConfigRules)) {
      issues.push("config.modelConfigRules: must be an object");
    } else {
      checkKeys(modelConfigRules, new Set(["providerModelRules", "manualProviderModelRules"]), "config.modelConfigRules", issues);
      const smart = modelConfigRules.providerModelRules;
      const manual = modelConfigRules.manualProviderModelRules;
      if (smart !== undefined && !Array.isArray(smart)) {
        issues.push("config.modelConfigRules.providerModelRules: must be an array");
      }
      if (manual !== undefined && !Array.isArray(manual)) {
        issues.push("config.modelConfigRules.manualProviderModelRules: must be an array");
      }
      if (Array.isArray(smart)) {
        smart.forEach((rule, index) => {
          validateModelRule(rule, `config.modelConfigRules.providerModelRules[${index}]`, issues);
        });
      }
      if (Array.isArray(manual)) {
        manual.forEach((rule, index) => {
          validateModelRule(rule, `config.modelConfigRules.manualProviderModelRules[${index}]`, issues);
        });
      }
      // The same providerId+modelId in both lists is a schema error in
      // ZCode (personalModelConfigRulesSchema superRefine).
      if (Array.isArray(smart) && Array.isArray(manual)) {
        const smartIds = new Set(
          smart.filter(isRecord).map((r) => JSON.stringify([r.providerId, r.modelId]))
        );
        for (const rule of manual) {
          if (isRecord(rule) && smartIds.has(JSON.stringify([rule.providerId, rule.modelId]))) {
            issues.push(
              `config.modelConfigRules: provider/model "${rule.providerId}/${rule.modelId}" declared in both providerModelRules and manualProviderModelRules`
            );
          }
        }
      }
    }
  }

  const selection = config.defaultModelSelection;
  if (selection !== undefined && selection !== null) {
    if (!isRecord(selection)) {
      issues.push("config.defaultModelSelection: must be an object");
    } else {
      checkKeys(selection, new Set(["providerId", "modelId"]), "config.defaultModelSelection", issues);
      if (!isNonEmptyString(selection.providerId)) {
        issues.push("config.defaultModelSelection.providerId: must be a non-empty string");
      }
      if (!isNonEmptyString(selection.modelId)) {
        issues.push("config.defaultModelSelection.modelId: must be a non-empty string");
      }
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// Safe read: ENOENT -> { notInstalled: true }; unparseable or shape-invalid
// -> { corrupt: true }. Never throws to the caller.
export async function readPersonalConfig(filePath = getPersonalConfigPath()) {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    try {
      const parsed = JSON.parse(raw);
      const issues = validatePersonalConfigShape(parsed);
      if (issues.length > 0) return { corrupt: true, issues };
      return { data: parsed };
    } catch {
      return { corrupt: true };
    }
  } catch (error) {
    if (error.code === "ENOENT") return { notInstalled: true };
    return { corrupt: true };
  }
}

// Locate the AFRouter provider rule: the known providerId (the legacy
// config.json entry key, which ZCode's one-time import reuses) first, then
// providerName + group. Returns { rule, index } or { rule: null }.
function findAFRouterRule(doc, providerId) {
  const rules = doc?.config?.providerConfigRules?.providerRules;
  if (!Array.isArray(rules)) return { rule: null, index: -1 };
  const byId = rules.findIndex((r) => isRecord(r) && r.providerId === providerId);
  if (byId !== -1) return { rule: rules[byId], index: byId };
  const byName = rules
    .map((r, index) => ({ r, index }))
    .filter(
      ({ r }) =>
        isRecord(r) &&
        r.providerName === PROVIDER_NAME &&
        r.config?.group === PROVIDER_GROUP
    );
  if (byName.length === 0) return { rule: null, index: -1 };
  // More than one AFRouter-named rule is ambiguous: the first is used, but
  // upsert reports it so the route can surface the ambiguity.
  return { rule: byName[0].r, index: byName[0].index, ambiguous: byName.length > 1 };
}

function modelRuleKey(rule) {
  return JSON.stringify([rule.providerId, rule.modelId]);
}

// ---------------------------------------------------------------------------
// Lock — mirrors ZCode's withFileLock/acquireFileLock: a `<file>.lock`
// directory holding one owner-<token>.json per writer. Only locks whose
// owner process has exited (or ownerless locks past a short grace period)
// are reclaimed; everything else waits up to maxWaitMs and then times out
// with ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE.
// ---------------------------------------------------------------------------

// In-process FIFO per path, so concurrent upserts in one dashboard process
// do not thundering-herd the directory lock (same as ZCode's withFileLock).
const processLockTails = new Map();

function getErrorCode(error) {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) !== "ESRCH";
  }
}

function parseLockMetadata(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      createdAt:
        typeof parsed.createdAt === "number" && Number.isFinite(parsed.createdAt) && parsed.createdAt >= 0
          ? parsed.createdAt
          : null,
      pid:
        typeof parsed.pid === "number" && Number.isSafeInteger(parsed.pid) && parsed.pid > 0
          ? parsed.pid
          : null,
    };
  } catch {
    return { createdAt: null, pid: null };
  }
}

async function isOwnerFileReclaimable(ownerFile, ownerlessGraceMs, observedAt) {
  let metadata = { createdAt: null, pid: null };
  try {
    const raw = await fs.readFile(ownerFile, "utf-8");
    metadata = parseLockMetadata(raw);
  } catch {
    return false;
  }
  if (metadata.pid !== null && !isProcessAlive(metadata.pid)) return true;
  if (metadata.pid === null) {
    let createdAt = metadata.createdAt;
    if (createdAt === null) {
      try {
        const stat = await fs.stat(ownerFile);
        createdAt = stat.mtimeMs;
      } catch {
        return false;
      }
    }
    return observedAt - createdAt >= ownerlessGraceMs;
  }
  return false;
}

async function removeAbandonedLock(lockFile, ownerlessGraceMs) {
  try {
    const stat = await fs.stat(lockFile);
    if (!stat.isDirectory()) return { removed: false };
    const entries = await fs.readdir(lockFile);
    const owners = entries.filter((e) => e.startsWith("owner-") && e.endsWith(".json"));
    const observedAt = Date.now();
    if (owners.length === 1) {
      const ownerFile = path.join(lockFile, owners[0]);
      if (!(await isOwnerFileReclaimable(ownerFile, ownerlessGraceMs, observedAt))) {
        return { removed: false };
      }
      await fs.rm(ownerFile, { force: true });
      await fs.rmdir(lockFile);
      return { removed: true };
    }
    if (observedAt - (stat.mtimeMs || observedAt) < ownerlessGraceMs) {
      return { removed: false };
    }
    for (const owner of owners) {
      if (!(await isOwnerFileReclaimable(path.join(lockFile, owner), ownerlessGraceMs, observedAt))) {
        return { removed: false };
      }
    }
    await Promise.all(entries.map((entry) => fs.rm(path.join(lockFile, entry), { force: true })));
    await fs.rmdir(lockFile);
    return { removed: true };
  } catch (error) {
    if (getErrorCode(error) === "ENOENT" || getErrorCode(error) === "ENOTEMPTY") {
      return { removed: false };
    }
    return { removed: false };
  }
}

function createFileLockTimeoutError(filePath, lockFile, waitedMs, cause) {
  const error = new Error(
    `Timed out after ${waitedMs}ms waiting for the ZCode file lock: ${lockFile}`
  );
  error.code = ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE;
  error.filePath = filePath;
  error.cause = cause;
  return error;
}

async function acquireFileLock(lockFile, retryDelaysMs, ownerlessGraceMs, maxWaitMs) {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const ownerFile = path.join(lockFile, `owner-${token}.json`);
  const payload = `${JSON.stringify({ pid: process.pid, createdAt: Date.now(), token })}\n`;
  const startedAt = Date.now();
  const effectiveGraceMs = Math.min(
    Math.max(ownerlessGraceMs, 0),
    Math.max(Math.floor(maxWaitMs / 2), 0)
  );
  let lastRemovalError;

  for (let attempt = 0; ; attempt += 1) {
    let createdLock = false;
    try {
      await fs.mkdir(lockFile);
      createdLock = true;
      const createdStat = await fs.stat(lockFile);
      await fs.writeFile(ownerFile, payload, { encoding: "utf-8", flag: "wx" });
      const currentStat = await fs.stat(lockFile);
      const currentOwners = (await fs.readdir(lockFile)).filter(
        (entry) => entry.startsWith("owner-") && entry.endsWith(".json")
      );
      if (
        currentStat.dev !== createdStat.dev ||
        currentStat.ino !== createdStat.ino ||
        currentOwners.length !== 1 ||
        currentOwners[0] !== `owner-${token}.json`
      ) {
        throw Object.assign(new Error("ZCode file lock ownership changed during acquire"), {
          code: "EEXIST",
        });
      }
      return async () => {
        await fs.rm(ownerFile, { force: true }).catch(() => {});
        await fs.rmdir(lockFile).catch(() => {});
      };
    } catch (error) {
      if (createdLock) {
        await fs.rm(ownerFile, { force: true }).catch(() => {});
        await fs.rmdir(lockFile).catch(() => {});
      }
      const lostCreatedLock = createdLock && getErrorCode(error) === "ENOENT";
      if (getErrorCode(error) !== "EEXIST" && !lostCreatedLock) {
        throw error;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= maxWaitMs) {
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(lockFile, lockFile, elapsedMs, error);
      }
      const removalAttempt = await removeAbandonedLock(lockFile, effectiveGraceMs);
      if (removalAttempt.removed) continue;
      if (removalAttempt.error) lastRemovalError = removalAttempt.error;

      const remainingMs = Math.max(maxWaitMs - elapsedMs, 0);
      if (retryDelaysMs.length === 0 || remainingMs === 0) {
        const removalErrorCode = getErrorCode(lastRemovalError);
        if (removalErrorCode === "EACCES" || removalErrorCode === "EPERM") {
          throw lastRemovalError;
        }
        throw createFileLockTimeoutError(lockFile, lockFile, elapsedMs, lastRemovalError ?? error);
      }
      const retryDelayMs = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] ?? remainingMs;
      await new Promise((r) => setTimeout(r, Math.min(retryDelayMs, remainingMs)));
    }
  }
}

async function withPersonalConfigLock(filePath, operation, { maxWaitMs = LOCK_MAX_WAIT_MS } = {}) {
  const lockFile = `${filePath}.lock`;
  const previousTail = processLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue;
  const currentTail = new Promise((resolve) => {
    releaseProcessQueue = resolve;
  });
  processLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock;
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(
      lockFile,
      LOCK_RETRY_DELAYS_MS,
      LOCK_OWNERLESS_GRACE_MS,
      maxWaitMs
    );
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processLockTails.get(filePath) === currentTail) {
        processLockTails.delete(filePath);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Atomic write — same-directory temp file + rename with EPERM/EBUSY/EACCES
// retries (Windows file-lock races with ZCode/AV).
// ---------------------------------------------------------------------------

async function renameWithRetry(tempFile, filePath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(tempFile, filePath);
      return;
    } catch (error) {
      const code = getErrorCode(error);
      const delay = RENAME_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) {
        throw error;
      }
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

async function atomicWriteTextFile(filePath, content) {
  const directory = path.dirname(filePath);
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
  );
  await fs.mkdir(directory, { recursive: true });
  try {
    await fs.writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function backupIfExists(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    return null;
  }
  const backupPath = `${filePath}.bak-${timestamp()}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

function freshDocument() {
  return {
    schemaVersion: SCHEMA_VERSION,
    config: {
      providerOrder: [],
      providerConfigRules: { providerRules: [] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
}

function normalizeModelIds(ids) {
  const seen = new Set();
  const result = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id === "string" && id.trim() !== "" && !seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}

// Build the providerModelRules entry for one applied model. `spec` is a
// resolved spec from the route's resolveModelSpecs (context/output always
// finite — conservative fallback specs for unverified ids).
function buildModelRule(providerId, modelId, spec) {
  const properties = {
    contextWindow: spec.context,
    inputFormat: {
      supportsText: true,
      ...(Array.isArray(spec.input) && spec.input.includes("image") ? { supportsImage: true } : {}),
    },
  };
  const optionSpecs = { maxOutputTokens: { max: spec.output } };
  const values = zcodeReasoningValues(spec);
  if (values) optionSpecs.reasoningLevel = { values };
  return {
    providerId,
    modelId,
    config: { properties, optionSpecs },
  };
}

/**
 * Upsert the AFRouter provider rule and per-model rules into
 * provider_config.json. Creates the file when missing (mirroring ZCode's
 * own one-time import: same providerId as the legacy config.json entry,
 * providerName "AFRouter"), refreshes baseUrl/apiKey, appends new model
 * ids to personalModelIds/modelOrder and the providerId to providerOrder,
 * and upserts a providerModelRules entry per applied model. Models that
 * already have a manualProviderModelRules entry are skipped and reported
 * as manualOverrides — the user's own settings win.
 *
 * @returns {Promise<{path: string, created: boolean, providerCreated: boolean,
 *   applied: string[], manualOverrides: string[], backupPath: string|null,
 *   ambiguous: boolean}>}
 */
export async function upsertPersonalProviderConfig({
  filePath = getPersonalConfigPath(),
  providerId,
  baseUrl,
  apiKey,
  models = [],
  lockOptions,
}) {
  if (!isNonEmptyString(providerId)) {
    throw new PersonalConfigInvalidError("providerId is required", filePath);
  }
  let baseUrlValid = true;
  try {
    new URL(baseUrl);
  } catch {
    baseUrlValid = false;
  }

  return withPersonalConfigLock(filePath, async () => {
    // Re-read under the lock (ZCode's #readLocked pattern): another writer
    // may have created or changed the file since the caller last looked.
    const current = await readPersonalConfig(filePath);
    if (current.corrupt) {
      throw new PersonalConfigCorruptError(filePath);
    }
    const created = current.notInstalled === true;
    const doc = created ? freshDocument() : JSON.parse(JSON.stringify(current.data));
    const config = doc.config;
    const rules = config.providerConfigRules.providerRules;
    const modelRules = config.modelConfigRules.providerModelRules;
    const manualRules = config.modelConfigRules.manualProviderModelRules;

    const found = findAFRouterRule(doc, providerId);
    let rule = found.rule;
    const providerCreated = !rule;
    if (providerCreated) {
      rule = {
        providerId,
        providerName: PROVIDER_NAME,
        config: {
          group: PROVIDER_GROUP,
          access: { type: "api-key", ...(apiKey ? { apiKey } : {}) },
          api: { type: API_TYPE, baseUrl },
          personalModelIds: [],
          modelOrder: [],
        },
      };
      rules.push(rule);
      if (!config.providerOrder.includes(providerId)) {
        config.providerOrder.push(providerId);
      }
    } else {
      rule.providerName = PROVIDER_NAME;
      rule.config.group = PROVIDER_GROUP;
      const accessApiKey = apiKey || rule.config.access?.apiKey;
      rule.config.access = {
        type: "api-key",
        ...(accessApiKey ? { apiKey: accessApiKey } : {}),
      };
      if (baseUrlValid) {
        rule.config.api = { ...rule.config.api, type: API_TYPE, baseUrl };
      }
      // Track the RULE's id: a name+group match may carry a
      // different providerId than the legacy config.json key.
      if (!config.providerOrder.includes(rule.providerId)) {
        config.providerOrder.push(rule.providerId);
      }
    }

    const personalModelIds = normalizeModelIds(rule.config.personalModelIds);
    const modelOrder = normalizeModelIds(rule.config.modelOrder);
    const applied = [];
    const manualOverrides = [];
    const manualKeys = new Set(manualRules.map(modelRuleKey));

    for (const model of models) {
      if (!model || !isNonEmptyString(model.id)) continue;
      const key = JSON.stringify([providerId, model.id]);
      if (manualKeys.has(key)) {
        manualOverrides.push(model.id);
        continue;
      }
      if (!personalModelIds.includes(model.id)) personalModelIds.push(model.id);
      if (!modelOrder.includes(model.id)) modelOrder.push(model.id);
      const entry = buildModelRule(providerId, model.id, model.spec);
      const existingIndex = modelRules.findIndex(
        (r) => isRecord(r) && r.providerId === providerId && r.modelId === model.id
      );
      if (existingIndex === -1) modelRules.push(entry);
      else modelRules[existingIndex] = entry;
      applied.push(model.id);
    }

    rule.config.personalModelIds = personalModelIds;
    rule.config.modelOrder = modelOrder;

    const issues = validatePersonalConfigShape(doc);
    if (issues.length > 0) {
      throw new PersonalConfigInvalidError(issues.join("; "), filePath);
    }

    const backupPath = await backupIfExists(filePath);
    await atomicWriteTextFile(filePath, `${JSON.stringify(doc, null, 2)}\n`);
    return {
      path: filePath,
      created,
      providerCreated,
      applied,
      manualOverrides,
      backupPath,
      ambiguous: found.ambiguous === true,
    };
  }, lockOptions);
}

// ---------------------------------------------------------------------------
// Removal (DELETE) — owned models only; manual rules and other providers
// are never touched. The provider rule and its providerOrder entry are
// removed only when no models are left.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{path: string, present: boolean, removed: string[],
 *   providerRemoved: boolean, backupPath: string|null}>}
 */
export async function removePersonalProviderModels({
  filePath = getPersonalConfigPath(),
  providerId,
  modelIds = [],
  lockOptions,
}) {
  const removeSet = new Set(modelIds.filter(isNonEmptyString));
  if (removeSet.size === 0) {
    return { path: filePath, present: false, removed: [], providerRemoved: false, backupPath: null };
  }

  return withPersonalConfigLock(filePath, async () => {
    const current = await readPersonalConfig(filePath);
    // Missing or corrupt: nothing to clean. A corrupt file means ZCode is
    // already running an empty personal layer (mirrors the legacy
    // config.json DELETE behaviour of a no-op success).
    if (current.notInstalled || current.corrupt) {
      return { path: filePath, present: !current.notInstalled, removed: [], providerRemoved: false, backupPath: null };
    }
    const doc = JSON.parse(JSON.stringify(current.data));
    const config = doc.config;
    const rules = config.providerConfigRules.providerRules;
    const modelRules = config.modelConfigRules.providerModelRules;

    const found = findAFRouterRule(doc, providerId);
    const rule = found.rule;
    if (!rule) {
      return { path: filePath, present: true, removed: [], providerRemoved: false, backupPath: null };
    }

    const before = normalizeModelIds(rule.config.personalModelIds);
    const remaining = before.filter((id) => !removeSet.has(id));
    const removed = before.filter((id) => removeSet.has(id));

    rule.config.personalModelIds = remaining;
    rule.config.modelOrder = normalizeModelIds(rule.config.modelOrder).filter(
      (id) => !removeSet.has(id) || remaining.includes(id)
    );
    const keptModelRules = modelRules.filter(
      (r) => !(isRecord(r) && r.providerId === providerId && removeSet.has(r.modelId))
    );
    config.modelConfigRules.providerModelRules = keptModelRules;

    let providerRemoved = false;
    if (remaining.length === 0) {
      const index = rules.indexOf(rule);
      if (index !== -1) rules.splice(index, 1);
      config.providerOrder = config.providerOrder.filter((id) => id !== providerId);
      // No models left: drop any lingering smart rules for this provider too.
      config.modelConfigRules.providerModelRules = keptModelRules.filter(
        (r) => !(isRecord(r) && r.providerId === providerId)
      );
      providerRemoved = true;
    }

    const issues = validatePersonalConfigShape(doc);
    if (issues.length > 0) {
      throw new PersonalConfigInvalidError(issues.join("; "), filePath);
    }

    if (removed.length === 0 && !providerRemoved) {
      return { path: filePath, present: true, removed: [], providerRemoved: false, backupPath: null };
    }

    const backupPath = await backupIfExists(filePath);
    await atomicWriteTextFile(filePath, `${JSON.stringify(doc, null, 2)}\n`);
    return { path: filePath, present: true, removed, providerRemoved, backupPath };
  }, lockOptions);
}

// ---------------------------------------------------------------------------
// Status (GET) — which file is in use and the levels ZCode will offer.
// ---------------------------------------------------------------------------

/**
 * @returns {Promise<{present: boolean, path: string, providerId: string|null,
 *   modelIds: string[], levelsByModel: Object.<string, string[]>,
 *   manualModels: string[], corrupt: boolean, ambiguous: boolean}>}
 */
export async function readPersonalProviderStatus({
  filePath = getPersonalConfigPath(),
  providerId,
} = {}) {
  const result = await readPersonalConfig(filePath);
  const base = {
    path: filePath,
    providerId: null,
    modelIds: [],
    levelsByModel: {},
    manualModels: [],
    ambiguous: false,
  };
  if (result.notInstalled) {
    return { ...base, present: false, corrupt: false };
  }
  if (result.corrupt) {
    return { ...base, present: true, corrupt: true };
  }
  const doc = result.data;
  const found = findAFRouterRule(doc, providerId);
  const rule = found.rule;
  if (!rule) {
    return { ...base, present: true, corrupt: false, ambiguous: found.ambiguous === true };
  }
  const modelIds = normalizeModelIds(rule.config.personalModelIds);
  const levelsByModel = {};
  const manualModels = [];
  for (const modelRule of doc.config.modelConfigRules.providerModelRules || []) {
    if (!isRecord(modelRule) || modelRule.providerId !== rule.providerId) continue;
    const values = modelRule.config?.optionSpecs?.reasoningLevel?.values;
    if (Array.isArray(values) && values.length > 0) {
      levelsByModel[modelRule.modelId] = [...values];
    }
  }
  for (const modelRule of doc.config.modelConfigRules.manualProviderModelRules || []) {
    if (isRecord(modelRule) && modelRule.providerId === rule.providerId) {
      manualModels.push(modelRule.modelId);
    }
  }
  return {
    ...base,
    present: true,
    corrupt: false,
    providerId: rule.providerId,
    modelIds,
    levelsByModel,
    manualModels,
    ambiguous: found.ambiguous === true,
  };
}
