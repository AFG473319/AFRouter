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
    entry.reasoningEfforts = {
      off: null,
      low: "low",
      medium: "medium",
      high: "high",
      max: "max",
    };
    // A DeepSeek-family model behind the gateway thinks unless told otherwise,
    // so `off` must send thinking:{type:disabled}. Opt-in only.
    if (compat?.thinkingFormat === "deepseek") {
      entry.compat = { thinkingFormat: "deepseek" };
    }
  }
  return entry;
};
