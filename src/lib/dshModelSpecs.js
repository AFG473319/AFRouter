// Pure model-spec shapes for DeepSeek Harness (dsh). Split out of dshConfig.js
// so the client-side dashboard card can import them without pulling Node
// builtins (fs/path/os) into the browser bundle.
//
// `input` is declared only for vision models and `reasoningEfforts` only when
// the model reasons — a hand-declared model is text-only and reasoning-less by
// default. Accepts either the dsh spec shape (`maxTokens`) or raw capability
// tables (`maxOutput`).

export const FALLBACK_SPEC = Object.freeze({
  contextWindow: 200000,
  maxTokens: 32000,
  vision: false,
  reasoning: false,
});

export const buildModelEntry = (id, spec = {}, compat = null) => {
  const maxTokens = Math.floor(Number(spec.maxTokens ?? spec.maxOutput));
  const contextWindow = Math.floor(Number(spec.contextWindow));
  const entry = {
    id,
    name: spec.name || id,
    contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : FALLBACK_SPEC.contextWindow,
    maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : FALLBACK_SPEC.maxTokens,
  };
  if (spec.vision) entry.input = ["text", "image"];
  if (spec.reasoning) {
    entry.reasoningEfforts = buildReasoningEfforts(spec.reasoningLevels ?? spec.reasoningEfforts);
    // A DeepSeek-family model behind the gateway thinks unless told otherwise,
    // so `off` must send thinking:{type:disabled}. Opt-in only.
    if (compat?.thinkingFormat === "deepseek") {
      entry.compat = { thinkingFormat: "deepseek" };
    }
  }
  return entry;
};

// Turn a model's own level set into DSH's display→wire map.
//
// DSH requires the map to offer a picker, so a model with no known set keeps the
// historical conservative default. When the set IS known — discovered from
// models.dev or declared by the registry — declaring anything else would send a
// level the model may reject, so the map is built from the real vocabulary:
// `none` becomes the `off: null` disable, and every other level maps to itself.
export const buildReasoningEfforts = (levels) => {
  if (!Array.isArray(levels) || levels.length === 0) {
    return { off: null, low: "low", medium: "medium", high: "high", max: "max" };
  }
  const efforts = {};
  if (levels.includes("none")) efforts.off = null;
  for (const level of levels) {
    if (level === "none") continue;
    efforts[level] = level;
  }
  return efforts;
};
