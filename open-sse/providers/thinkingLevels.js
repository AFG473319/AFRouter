// Resolve valid thinking levels per model — drives UI level picker (suffix "model(level)").
//
// Thin wrapper over capabilities.js, which owns the single source of truth
// (resolveReasoningLevels + PATTERN_THINKING + FORMAT_LEVELS). Kept as a
// separate module so existing import paths keep working; do NOT add a second
// precedence here — edit capabilities.js instead.
import { getCapabilitiesForModel } from "./capabilities.js";

export { FORMAT_LEVELS, PATTERN_THINKING, orderReasoningLevels, resolveReasoningLevels } from "./capabilities.js";

// Returns valid thinking levels for a model, or null when the model has no reasoning.
export function getThinkingLevels(provider, model) {
  const caps = getCapabilitiesForModel(provider, model);
  if (!caps.reasoning) return null;
  return caps.reasoningLevels || null;
}
