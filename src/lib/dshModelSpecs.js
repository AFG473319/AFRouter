// Pure model-spec shapes for DeepSeek Harness (dsh). Split out of dshConfig.js
// so the client-side dashboard card can import them without pulling Node
// builtins (fs/path/os) into the browser bundle.
//
// `input` is declared only for vision models and `reasoningEfforts` only when
// the model reasons — a hand-declared model is text-only and reasoning-less by
// default. Accepts either the dsh spec shape (`maxTokens`) or raw capability
// tables (`maxOutput`).

// dsh's accepted thinking vocabulary (packages/llm/llm-pi-ai/src/catalog.ts
// THINKING_LEVELS): off | minimal | low | medium | high | xhigh | max. Levels
// outside it (`ultra`, and any future provider-only level) are dropped, never
// emitted: PiAiReasoningEfforts keys are ModelThinkingLevel, so an unknown key
// would fail resolution instead of offering the level.
const DSH_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

export const FALLBACK_SPEC = Object.freeze({
  contextWindow: 200000,
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
  };
  // maxTokens is OPTIONAL in dsh and, when written, becomes a HARD per-request
  // output cap (docs: "Configuring one also makes it this model's per-request
  // default"). A guessed value would therefore cap real responses, so it is
  // written only when a verified spec supplies one.
  if (Number.isFinite(maxTokens) && maxTokens > 0) entry.maxTokens = maxTokens;
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
// `none` becomes the `off: null` disable and every other known level maps to
// itself. A level dsh does not know (`ultra`) is dropped: reasoningEfforts keys
// are ModelThinkingLevel (off..max), so emitting it would fail the route's
// resolution instead of offering the level.
export const buildReasoningEfforts = (levels) => {
  if (!Array.isArray(levels) || levels.length === 0) {
    return { off: null, minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" };
  }
  const efforts = {};
  if (levels.includes("none")) efforts.off = null;
  for (const level of levels) {
    if (level === "none") continue;
    if (DSH_LEVELS.includes(level)) efforts[level] = level;
  }
  return efforts;
};
