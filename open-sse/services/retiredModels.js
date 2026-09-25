// Retired-model detection and bypass.
//
// A "retired" model is an id the upstream has removed from its catalog while
// keeping the credential valid — NVIDIA NIM sunsets hosted models after a fixed
// window, and the id then answers 404/406 forever while every sibling model on
// the same API key keeps working. The generic error path treats that 404 as a
// 2-minute account cooldown, so a dead id is retried every 2 minutes forever
// and the whole connection shows up as "unavailable" in the dashboard.
//
// This module gives those failures a model-scoped, escalating horizon instead:
//   - `retiredModel_<model>`  ISO expiry, read by routing to skip the id
//   - `retiredStrikes_<model>` consecutive failures, drives the escalation
//   - `modelLock_<model>`     set too, so existing lock-based skipping and the
//                             dashboard cooldown badge keep working unchanged
//
// The credential is never poisoned for a retirement: sibling models on the same
// key are healthy, so testStatus is left alone (same reasoning as the
// Antigravity pool-scoped quota skip in auth.js).
import {
  RETIRED_MODEL_RULES,
  RETIRED_MODEL_COOLDOWNS,
} from "../config/errorConfig.js";

/** Flat field prefix holding a retired model's bypass expiry (ISO string). */
export const RETIRED_MODEL_PREFIX = "retiredModel_";


/**
 * Wording that means "the account is throttled", not "the id is gone". When one
 * of these appears in the body we refuse the status-only verdict below: some
 * upstreams answer 404 for a throttled account, and escalating that to a 30-day
 * model bypass would take a perfectly good model out of rotation for a month.
 */
const ACCOUNT_SCOPED_TEXT = [
  "rate limit",
  "too many requests",
  "quota exceeded",
  "capacity",
  "overloaded",
  "no credentials",
];

/** Flat field prefix holding a retired model's consecutive strike count. */
export const RETIRED_STRIKES_PREFIX = "retiredStrikes_";

/** Build the flat field key for a model's retirement marker. */
export function getRetiredModelKey(model) {
  return model ? `${RETIRED_MODEL_PREFIX}${model}` : null;
}

/** Build the flat field key for a model's strike counter. */
export function getRetiredStrikesKey(model) {
  return model ? `${RETIRED_STRIKES_PREFIX}${model}` : null;
}

/**
 * Does this upstream error mean "this model id is gone", as opposed to
 * "your credential is bad" or "slow down"?
 *
 * Text rules are checked first and win over status: a 404 whose body names a
 * *different* model id is a combo fallthrough artifact, not a retirement of
 * the model being requested.
 *
 * @param {number} status - HTTP status code from upstream
 * @param {string|object} errorText - Error message or raw error body
 * @returns {boolean}
 */
export function isRetiredModelError(status, errorText) {
  // A retirement verdict is only safe when we know WHICH model it is about.
  if (!errorText) return false;

  const raw = typeof errorText === "string" ? errorText : JSON.stringify(errorText);
  const lower = raw.toLowerCase();

  for (const rule of RETIRED_MODEL_RULES) {
    if (rule.text && lower.includes(rule.text)) return true;
  }

  // Status-only verdict: allowed unless the body says the failure is
  // account-scoped (throttle/quota/capacity), which is never a retirement.
  if (ACCOUNT_SCOPED_TEXT.some((text) => lower.includes(text))) return false;

  for (const rule of RETIRED_MODEL_RULES) {
    if (rule.status && rule.status === status) return true;
  }

  return false;
}

/**
 * Cooldown for the Nth consecutive retirement of a model (1-based), capped at
 * the last ladder entry.
 * @param {number} strikes - Consecutive retirement failures so far
 * @returns {number} Cooldown in milliseconds
 */
export function getRetiredModelCooldownMs(strikes) {
  const n = Number(strikes);
  if (!Number.isFinite(n) || n < 1) return RETIRED_MODEL_COOLDOWNS[0];
  const idx = Math.min(Math.floor(n) - 1, RETIRED_MODEL_COOLDOWNS.length - 1);
  return RETIRED_MODEL_COOLDOWNS[idx];
}

/**
 * Is this model currently bypassed on this connection?
 * @param {object} connection
 * @param {string|null} model
 * @returns {boolean}
 */
export function isModelRetired(connection, model) {
  const key = getRetiredModelKey(model);
  if (!key || !connection) return false;
  const expiry = connection[key];
  if (!expiry) return false;
  const t = new Date(expiry).getTime();
  return Number.isFinite(t) && t > Date.now();
}

/**
 * Read the consecutive strike count for a model (0 when never seen).
 * @param {object} connection
 * @param {string|null} model
 * @returns {number}
 */
export function getRetiredStrikes(connection, model) {
  const key = getRetiredStrikesKey(model);
  if (!key || !connection) return 0;
  const n = Number(connection[key]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Build the DB update that retires a model on a connection.
 * Sets the bypass marker, bumps the strike counter, and sets the model lock so
 * the existing lock-based skipping in auth.js picks it up with no extra wiring.
 *
 * @param {string|null} model
 * @param {object} [opts]
 * @param {number} [opts.strikes] - The NEW total consecutive strike count
 * @param {string} [opts.reason] - Short upstream reason, recorded for the dashboard
 * @returns {object} Flat-field update for updateProviderConnection()
 */
export function buildRetireModelUpdate(model, opts = {}) {
  const retiredKey = getRetiredModelKey(model);
  if (!retiredKey) return {};

  const n = Number(opts.strikes);
  const strikes = Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
  const until = new Date(Date.now() + getRetiredModelCooldownMs(strikes)).toISOString();
  const reason = typeof opts.reason === "string" ? opts.reason.slice(0, 100) : null;

  return {
    [retiredKey]: until,
    [getRetiredStrikesKey(model)]: strikes,
    // Reuse the model lock so credential selection skips the id and the
    // dashboard cooldown badge renders without any extra code path.
    [`modelLock_${model}`]: until,
    ...(reason ? { lastError: reason } : {}),
  };
}

/**
 * Build the DB update that un-retires a model after a success.
 * Clears the marker, the strike count and the model lock.
 * @param {string|null} model
 * @returns {object} Flat-field update for updateProviderConnection()
 */
export function buildUnretireModelUpdate(model) {
  const retiredKey = getRetiredModelKey(model);
  if (!retiredKey) return {};
  return {
    [retiredKey]: null,
    [getRetiredStrikesKey(model)]: null,
    [`modelLock_${model}`]: null,
  };
}

/**
 * List every currently-retired model on a connection.
 * @param {object} connection
 * @returns {Array<{model: string, until: string, strikes: number}>}
 */
export function listRetiredModels(connection) {
  if (!connection) return [];
  const now = Date.now();
  const out = [];
  for (const [key, value] of Object.entries(connection)) {
    if (!key.startsWith(RETIRED_MODEL_PREFIX) || !value) continue;
    const t = new Date(value).getTime();
    if (!Number.isFinite(t) || t <= now) continue;
    const model = key.slice(RETIRED_MODEL_PREFIX.length);
    out.push({ model, until: value, strikes: getRetiredStrikes(connection, model) });
  }
  return out;
}

/**
 * Aggregate the retired models across every connection of one provider.
 * A model retired on ANY active connection is treated as retired provider-wide:
 * catalog retirement is a property of the upstream account/program, and the
 * sibling connections share the same catalog.
 *
 * @param {Array<object>} connections
 * @returns {Map<string, {until: string, strikes: number, connectionId: string}>}
 */
export function collectRetiredModelsByModel(connections) {
  const map = new Map();
  for (const connection of connections || []) {
    for (const entry of listRetiredModels(connection)) {
      const existing = map.get(entry.model);
      // Keep the longest-running retirement: the earliest expiry is the one
      // that must be respected for "still retired?".
      if (!existing || new Date(entry.until).getTime() > new Date(existing.until).getTime()) {
        map.set(entry.model, {
          until: entry.until,
          strikes: Math.max(entry.strikes, existing?.strikes || 0),
          connectionId: connection.id,
        });
      }
    }
  }
  return map;
}
