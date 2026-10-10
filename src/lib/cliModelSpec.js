import { resolveModelSpec } from "../../open-sse/providers/modelSpecs.js";

// Splits "provider/model" (first slash only, matching the gateway's parser).
const splitModelRef = (ref) => {
  const str = String(ref || "");
  const slash = str.indexOf("/");
  return slash > 0 ? { provider: str.slice(0, slash), model: str.slice(slash + 1) } : { provider: null, model: str };
};

// Per-model spec for CLI writers. Toggle-only models (reasoning with no ladder)
// get levels and defaultLevel undefined and must not be offered an effort picker.
export function specForCli(modelRef) {
  const { provider, model } = splitModelRef(modelRef);
  const spec = resolveModelSpec(provider, model);
  return {
    contextWindow: spec.contextWindow,
    maxOutput: spec.maxOutput,
    vision: spec.vision,
    reasoning: spec.reasoning,
    levels: spec.reasoningLevels,
    canDisable: spec.canDisable,
    defaultLevel: spec.defaultLevel,
  };
}

// Vocabulary mappers: AFRouter ladder -> each tool's accepted set. Levels a tool
// cannot express are dropped rather than renamed.
export function mapLevels(levels, allowed) {
  if (!levels) return undefined;
  const set = new Set(allowed);
  const out = levels.filter((l) => set.has(l));
  return out.length ? out : undefined;
}
