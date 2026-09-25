// OpenAI-compatible error types mapping (client-facing)
export const ERROR_TYPES = {
  400: { type: "invalid_request_error", code: "bad_request" },
  401: { type: "authentication_error", code: "invalid_api_key" },
  402: { type: "billing_error", code: "payment_required" },
  403: { type: "permission_error", code: "insufficient_quota" },
  404: { type: "invalid_request_error", code: "model_not_found" },
  406: { type: "invalid_request_error", code: "model_not_supported" },
  429: { type: "rate_limit_error", code: "rate_limit_exceeded" },
  500: { type: "server_error", code: "internal_server_error" },
  502: { type: "server_error", code: "bad_gateway" },
  503: { type: "server_error", code: "service_unavailable" },
  504: { type: "server_error", code: "gateway_timeout" }
};

// Default error messages per status code (client-facing)
export const DEFAULT_ERROR_MESSAGES = {
  400: "Bad request",
  401: "Invalid API key provided",
  402: "Payment required",
  403: "You exceeded your current quota",
  404: "Model not found",
  406: "Model not supported",
  429: "Rate limit exceeded",
  500: "Internal server error",
  502: "Bad gateway - upstream provider error",
  503: "Service temporarily unavailable",
  504: "Gateway timeout"
};

// Exponential backoff config for rate limits
export const BACKOFF_CONFIG = {
  base: 2000,
  max: 5 * 60 * 1000,
  maxLevel: 15
};

// Default cooldown for transient/unknown errors
export const TRANSIENT_COOLDOWN_MS = 30 * 1000;

// Hard cap for provider-reported rate limit cooldown (e.g. codex resets_at can be 5-6h)
export const MAX_RATE_LIMIT_COOLDOWN_MS = 30 * 60 * 1000;

// Cooldown durations (ms)
const COOLDOWN = {
  long: 2 * 60 * 1000,
  short: 5 * 1000,
};

/**
 * Unified error classification rules.
 * Checked top-to-bottom: text rules first (by order), then status rules.
 * Each rule: { text?, status?, cooldownMs?, backoff? }
 *   - text: substring match (case-insensitive) on error message
 *   - status: HTTP status code match
 *   - cooldownMs: fixed cooldown duration
 *   - backoff: true = use exponential backoff (rate limit)
 */
export const ERROR_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "no credentials",           cooldownMs: COOLDOWN.long },
  { text: "request not allowed",      cooldownMs: COOLDOWN.short },
  { text: "improperly formed request", cooldownMs: COOLDOWN.long },
  { text: "rate limit",               backoff: true },
  { text: "too many requests",        backoff: true },
  { text: "quota exceeded",           backoff: true },
  { text: "capacity",                 backoff: true },
  { text: "overloaded",               backoff: true },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 401, cooldownMs: COOLDOWN.long },
  { status: 402, cooldownMs: COOLDOWN.long },
  { status: 403, cooldownMs: COOLDOWN.long },
  { status: 404, cooldownMs: COOLDOWN.long },
  { status: 429, backoff: true },
];

// --- Retired models -------------------------------------------------------
// Some upstreams retire model ids instead of failing the credential: NVIDIA
// NIM sunsets hosted models after a fixed window, and the id then answers 404
// forever while every sibling model on the same API key keeps working. A 404
// must not be treated as a plain 2-minute cooldown here — that retries a dead
// id every 2 minutes, indefinitely.
//
// Text rules win over status rules: a 404 whose body names a *different*
// model ("model X not found" for a combo fallthrough) is a routing artifact,
// not a retirement.
export const RETIRED_MODEL_RULES = [
  // --- Text-based rules (checked first, order = priority) ---
  { text: "model not found" },
  { text: "model_not_found" },
  { text: "model does not exist" },
  { text: "no such model" },
  { text: "unknown model" },
  { text: "model is not available" },
  { text: "model not available" },
  { text: "no longer available" },
  { text: "is deprecated" },
  { text: "has been deprecated" },
  { text: "decommissioned" },
  { text: "model_not_supported" },
  { text: "model not supported" },
  { text: "unsupported model" },

  // --- Status-based rules (fallback when text doesn't match) ---
  { status: 404 },
  { status: 406 },
];

/**
 * Cooldown ladder for a retired model, indexed by consecutive strike count.
 * Strike 1 is deliberately short so a transient routing hiccup is not punished,
 * but each repeat multiplies until the id is effectively bypassed. Capped at 30
 * days: long enough that a genuinely dead id stops being retried, short enough
 * that a resurrected id comes back on its own without a manual unlock.
 */
export const RETIRED_MODEL_COOLDOWNS = [
  5 * 60 * 1000,           // 5 min  — first sighting, probably transient
  30 * 60 * 1000,          // 30 min
  6 * 60 * 60 * 1000,      // 6 h
  24 * 60 * 60 * 1000,     // 24 h
  7 * 24 * 60 * 60 * 1000, // 7 d
  30 * 24 * 60 * 60 * 1000,// 30 d — cap
];

/** Number of leading ladder entries (used by tests / docs). */
export const RETIRED_MODEL_MAX_STRIKES = RETIRED_MODEL_COOLDOWNS.length;

// Backward compat: COOLDOWN_MS object (used by index.js re-export)
export const COOLDOWN_MS = {
  unauthorized: COOLDOWN.long,
  paymentRequired: COOLDOWN.long,
  notFound: COOLDOWN.long,
  transient: TRANSIENT_COOLDOWN_MS,
  requestNotAllowed: COOLDOWN.short,
};
