// AFRouter → ZCode reasoning-level mapping (pure, unit-tested).
//
// ZCode 3.14+ keeps custom providers in a Personal layer
// (~/.zcode/v2/provider_config.json). A model's selectable thinking
// efforts are declared as `optionSpecs.reasoningLevel.values`:
// non-empty, unique, ordered lowest→highest. ZCode uses the LAST value
// as the default (highest) tier and the FIRST for auxiliary calls, and
// sends the chosen value upstream as `reasoning_effort` — converting
// "disabled" → "none" and "enabled" → "high" on the wire
// (packages/provider/src/model-selection-config.ts picks values.at(-1);
// the openai-chat-completions executor applies the level).
//
// AFRouter's own ladders (open-sse/providers/thinkingLevels.js) use
// "none" as the disable switch and "thinking" as the on/off "on" state
// (zai/minimax formats). This module converts between the two
// vocabularies WITHOUT reordering: AFRouter's order is already
// lowest→highest, and the strongest level must stay last.
//
// Wire compatibility (verified against our request path):
// ZCode can only ever send the declared values, with the two conversions
// above. Every resulting token — none, minimal, low, medium, high,
// xhigh, max, ultra — is accepted by extractThinking (any string becomes
// a level intent) and mapped per-format by thinkingUnified.applyFormat
// (openai passes through via normalizeOpenAILevel; zai maps to
// enable_thinking/low|high|max; claude-budget/kimi/gemini map through
// LEVEL_TO_BUDGET with safe fallbacks). No request-path change is
// needed; this is recorded here so the guarantee is not re-derived.

const DISABLE = "disabled";
const ENABLE = "enabled";

// Convert one AFRouter level token to its ZCode value, or null to drop
// it from the tier list. "none" is handled by the caller (it is the
// disable switch, not a tier); "thinking" is the on/off "on" state.
function toZcodeValue(level) {
  if (level === "thinking") return ENABLE;
  return level;
}

/**
 * Map an AFRouter thinking ladder to ZCode reasoningLevel.values.
 *
 * - "none" is dropped; if present (the model can disable thinking),
 *   "disabled" is prepended as the lowest tier.
 * - On/off models (["none", "thinking"]) become ["disabled", "enabled"].
 * - AFRouter's order (already lowest→highest) is kept, de-duplicated,
 *   so the strongest level ends up last (ZCode's default tier).
 * - Non-reasoning models (null/empty input, or no levels) return null:
 *   no reasoningLevel rule is written at all, and the model inherits
 *   ZCode's builtin catch-all toggle ["disabled", "enabled"].
 *
 * @param {string[] | null | undefined} afrouterLevels
 * @returns {string[] | null}
 */
export function mapReasoningLevels(afrouterLevels) {
  if (!Array.isArray(afrouterLevels)) return null;
  const values = [];
  let canDisable = false;
  for (const level of afrouterLevels) {
    if (typeof level !== "string" || level.trim() === "") continue;
    if (level === "none") {
      canDisable = true;
      continue;
    }
    const value = toZcodeValue(level);
    if (value === null) continue;
    if (!values.includes(value)) values.push(value);
  }
  if (canDisable) values.unshift(DISABLE);
  return values.length > 0 ? values : null;
}

/**
 * ZCode reasoningLevel.values for a resolved model spec, or null when
 * the model has no reasoning (no rule is written for it).
 * @param {{ reasoning?: boolean, reasoningLevels?: string[] } | null} spec
 */
export function zcodeReasoningValues(spec) {
  if (!spec || spec.reasoning !== true) return null;
  return mapReasoningLevels(spec.reasoningLevels);
}
