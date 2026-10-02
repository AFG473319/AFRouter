// Concern: reasoning_effort ↔ provider-native thinking config.
// Central source of truth for level↔budget maps (web-standard values).
// Provider-specific application lives in thinkingUnified.js; this file is maps-only.

// Discrete effort levels, ordered low→high.
export const EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];

// The canonical reasoning ladder, ordered weakest→strongest.
//
// `none` is FIRST and is a TERMINAL state, not the bottom of the effort scale:
// it means "thinking disabled", not "think as little as possible". So it never
// participates in nearest-level matching — a request for `none` is either
// honoured (the candidate can disable thinking) or refused by
// `thinkingCanDisable: false`, which keeps it out of the offered set entirely.
// `EFFORT_LEVELS` is the same ladder minus that terminal value, so the two can
// never drift.
export const THINKING_LEVELS = ["none", ...EFFORT_LEVELS];

// Rank a level on the canonical ladder. `null` for anything not on it (a
// provider-specific alias, a typo, "auto") so callers can pass levels straight
// through instead of guessing.
export function levelRank(level) {
  if (typeof level !== "string") return null;
  const i = THINKING_LEVELS.indexOf(level.toLowerCase().trim());
  return i === -1 ? null : i;
}

// Off-ladder INTENT aliases: values a caller may ask for that are not on the
// canonical ladder but still name a strength, so they can be reconciled instead
// of passed through. `ultra` is real on two Codex models and is a step above
// `max` everywhere else, so its honest intent is "the strongest available".
//
// Provider DISPLAY labels (`instant`, `thinking` — Kilo) deliberately do NOT
// live here: they are resolved at the picker, where the label carries its own
// wire value, so they must never reach the reconciler.
export const INTENT_ALIASES = { ultra: "max" };

// Reconcile a requested level against the levels a specific candidate supports.
//
// ⚠️ `coerce` MUST stay false for an ordinary single-model request. A level is
// only meaningful against the model it was CHOSEN for, and the offered set is
// not always a faithful description of what an upstream accepts — the sets are
// partly name-pattern derived (zai declares `[none, thinking]` while its wire
// takes `low`/`high` happily). Coercing against such a list rewrites levels that
// would otherwise be sent verbatim: a regression, not a fix.
//
// Pass `coerce: true` only where candidates genuinely differ — combo member
// selection and account/model fallback. There the caller's intent must survive
// onto a candidate it was not chosen for, and the nearest level is the correct
// encoding of that intent.
//
// Returns `requested` unchanged when it is already supported, when the
// candidate declares no set, or when the value names no strength at all
// (`auto`, a raw budget) — pass-through beats inventing a value.
export function resolveLevelFor(requested, supported, { coerce = false } = {}) {
  if (!coerce) return requested;
  if (!Array.isArray(supported) || supported.length === 0) return requested;
  if (supported.includes(requested)) return requested;

  // An off-ladder alias reconciles at its nearest on-ladder intent.
  const intent = INTENT_ALIASES[String(requested).toLowerCase()];
  if (intent !== undefined) return nearestLevel(intent, supported);

  const rank = levelRank(requested);
  if (rank === null) return requested;

  // On the ladder but unsupported — the nearest available strength.
  return nearestLevel(requested, supported);
}

// Nearest level a candidate actually supports.
//
// Direction is "nearest", which needs no rounding policy: when the requested
// level sits above the candidate's ceiling the nearest supported level IS that
// ceiling, and likewise at the floor. Ties (equidistant on either side) resolve
// to the STRONGER level, because under-thinking silently degrades an answer
// while over-thinking only costs tokens.
export function nearestLevel(requested, supported) {
  if (!Array.isArray(supported) || supported.length === 0) return requested;
  const target = levelRank(requested);
  if (target === null) return requested;

  let best = null;
  let bestRank = null;
  let bestDistance = Infinity;
  for (const candidate of supported) {
    const rank = levelRank(candidate);
    if (rank === null) continue;
    const distance = Math.abs(rank - target);
    if (distance === 0) return candidate;
    // On an equal distance the STRONGER level wins, so the fallback loop is a
    // plain "is this better than what we have" rather than order-dependent.
    const better =
      distance < bestDistance || (distance === bestDistance && rank > bestRank);
    if (better) {
      best = candidate;
      bestRank = rank;
      bestDistance = distance;
    }
  }
  return best === null ? requested : best;
}

// Web-standard level → budget_tokens (Anthropic/Gemini docs).
export const LEVEL_TO_BUDGET = {
  none: 0,
  minimal: 512,
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
  max: 128000,
};

// Returns budget_tokens for an effort level, or undefined if unknown.
// 0 means "no thinking"; undefined means "effort not recognized".
export function effortToBudget(effort) {
  if (!effort) return undefined;
  return LEVEL_TO_BUDGET[String(effort).toLowerCase()];
}

// OpenAI reasoning_effort → Gemini thinkingLevel (gemini-3 enum: minimal|low|medium|high).
// Gemini 3 cannot fully disable thinking; "none"/"off" map to "minimal".
export function effortToThinkingLevel(effort) {
  const e = String(effort).toLowerCase().trim();
  if (e === "none" || e === "off") return "minimal";
  if (e === "xhigh" || e === "max") return "high";
  return e;
}

// Numeric budget → nearest discrete level (reverse map via thresholds).
// Returns null when budget <= 0 (no reasoning).
// Thresholds are midpoints between LEVEL_TO_BUDGET values: max (128000) is
// reachable, with the xhigh/max boundary at the 32768/128000 midpoint (80384).
export function budgetToLevel(budget) {
  const b = Number(budget);
  if (!b || b <= 0) return null;
  if (b <= 768) return "minimal";
  if (b <= 4096) return "low";
  if (b <= 16384) return "medium";
  if (b <= 28672) return "high";
  if (b <= 80384) return "xhigh";
  return "max";
}

// Gemini thinkingBudget (numeric) → OpenAI reasoning_effort (antigravity reverse map).
export function budgetToEffort(budget) {
  if (!budget || budget <= 0) return null;
  if (budget <= 2048) return "low";
  if (budget <= 16384) return "medium";
  return "high";
}
