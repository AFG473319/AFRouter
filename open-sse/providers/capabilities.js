// Model capabilities — what each model can read/do beyond plain text.
//
// Fallback order (first match wins), result merged over DEFAULT_CAPABILITIES:
//   1. PROVIDER_CAPABILITIES[provider][model]  — provider-specific override
//   2. MODEL_CAPABILITIES[model]               — canonical exact id (handles exceptions)
//   3. PATTERN_CAPABILITIES                     — glob match, ordered specific -> generic
//   4. DEFAULT_CAPABILITIES                     — safe floor (always returned)
//
// Two extra layers then refine the result:
//   • the synced catalog — modalities keyed by model, limits keyed by provider
//     + model, refreshed from models.dev in the background. It reads a file, so
//     the server installs it via setCatalogSource(); this module stays free of
//     node:fs because the dashboard bundles it into the browser too.
//   • visionPatterns.js — name-based vision detection, last resort so a model
//     nobody has catalogued yet still accepts images.
// Modalities only ever turn a capability ON. Limits from the catalog overlay
// the canonical exact entry (step 2) so a gateway-specific models.dev delta
// (Copilot's 32k Claude output, etc.) actually publishes. Step 1 still
// short-circuits: a hand-written PROVIDER_CAPABILITIES truncation is the
// gateway's own number and must not be overwritten.
//
// ── HOW TO ADD / UPDATE A MODEL ──────────────────────────────────────
// Authoritative data source: https://models.dev/api.json (145 providers, 4000+
// models, MIT). Each model exposes the exact fields we map below:
//   modalities.input  ["text","image","pdf","audio","video"] -> vision / pdf / audioInput / videoInput
//   modalities.output ["text","image","audio"]               -> imageOutput / audioOutput
//   reasoning   -> reasoning      tool_call    -> tools
//   limit.context -> contextWindow   limit.output -> maxOutput
// Look up the model id, then:
//   • If a PATTERN below already covers it correctly -> nothing to do.
//   • If it is an exception (pattern would mis-match) -> add an exact entry to
//     MODEL_CAPABILITIES (only the fields that differ from DEFAULT).
//   • If a whole new family -> add an ordered PATTERN (specific before generic).
// NOTE: models.dev has NO "search" flag (web search is a runtime tool, not a
// model spec); set `search` from vendor docs (Claude 4.x+, GPT-5.x/4o, Gemini
// 2.0+, Grok, Perplexity). Verify with: curl -s https://models.dev/api.json

import { matchPattern } from "./pricing.js";
import { looksLikeVisionModel } from "./visionPatterns.js";
import { getProviderModels } from "../config/providerModels.js";
import { resolveKiroEffortPath } from "../config/kiroConstants.js";

/**
 * Safe floor — every resolved result is merged over this so consumers
 * never need null-checks. Most modern LLMs meet these limits.
 */
export const DEFAULT_CAPABILITIES = {
  // input modalities
  vision: false,        // read images
  pdf: false,           // read PDF / documents
  audioInput: false,    // read audio
  videoInput: false,    // read video
  // output modalities
  imageOutput: false,   // generate images
  audioOutput: false,   // generate audio
  // features
  search: false,        // built-in web search tool / grounding
  tools: true,          // function / tool calling
  reasoning: false,     // thinking / reasoning
  // thinking wire format (only meaningful when reasoning:true). null → derive from transport.format.
  // enum: openai|claude-adaptive|claude-budget|gemini-level|gemini-budget|zai|qwen|deepseek|kimi|minimax|hunyuan|step
  thinkingFormat: null,
  thinkingCanDisable: true,  // false → model cannot turn thinking off (clamp to min instead of disable)
  thinkingRange: null,       // { min, max } for budget formats; null = no clamp
  thinkingEffortSupported: false, // model accepts effort control in its native wire format (reasoning_effort / effort / thinkingLevel). Derived automatically - see EFFORT_WIRE_FORMATS + catalog discovery in getCapabilitiesForModel; the tables below only carry offline fallbacks.
  // limits (tokens)
  contextWindow: 200000,
  maxOutput: 64000,
};

// User-added model metadata can carry dashboard service kinds instead of the
// runtime capability names used here. Map those typed model kinds into input /
// output capabilities so custom vision models are not treated as text-only.
const SERVICE_KIND_CAPABILITIES = {
  imageToText: { vision: true },
  image: { imageOutput: true },
  stt: { audioInput: true },
  tts: { audioOutput: true },
  embedding: { tools: false },
};

export function capabilitiesFromServiceKind(kind) {
  return SERVICE_KIND_CAPABILITIES[kind] || null;
}

/**
 * Canonical exact-id overrides — used for exceptions that patterns would
 * otherwise mis-match. Only declare deltas vs DEFAULT.
 */
export const MODEL_CAPABILITIES = {
  // Claude Fable 5.1, Opus 5.5/5, 4.6/4.7/4.8, and Kiro Sonnet 5 have 1M context + adaptive thinking (override generic claude pattern)
  "claude-fable-5-1": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 128000 },
  // Claude Opus 5.5 — experimental preview on Kiro (rateMultiplier: 2.0, 1M context) (#4410)
  "claude-opus-5.5":                   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5.5-thinking":          { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5.5-agentic":           { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5.5-thinking-agentic":  { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5":     { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-7":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-6":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8":   { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4.8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-opus-4-8-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4.6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-4-6": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  // Sonnet 5.5 rejects thinking.type "disabled" (use "between_tools") and forced tool_choice (any/tool).
  "claude-sonnet-5-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000, thinkingOffType: "between_tools", forcedToolChoice: false },
  "claude-sonnet-5": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },
  "claude-sonnet-5-thinking-agentic": { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 },

  // Gemini image-gen / OpenAI image / xai image variants
  "gpt-image-1":       { imageOutput: true, tools: false },

  // GLM vision variants (text GLM has no vision) — 5.3-Flash and 5V-Turbo are
  // natively multimodal per z.ai, and 5.3-Flash carries the full 1M window.
  "glm-5.3-flash":     { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "zai", contextWindow: 1000000, maxOutput: 131072 },
  "glm-4.6v":          { vision: true, videoInput: true, reasoning: true, thinkingFormat: "zai", contextWindow: 128000, maxOutput: 32768 },
  "glm-4.5v":          { vision: true, videoInput: true, reasoning: true, thinkingFormat: "zai", contextWindow: 64000, maxOutput: 16384 },
  // GLM-5.2 has 1M context — pattern *glm-5* only gives 200k, so override here
  "glm-5.2":           { reasoning: true, thinkingFormat: "zai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 131072 },

  // DeepSeek's first V4 model with image input; text limits match V4-Flash.
  "deepseek-v4-flash-vision-exp": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },

  // DeepSeek V4.1-Flash is natively multimodal — models.dev lists
  // opencode-go/deepseek-v4.1-flash with modalities.input ["text","image"] — and upstream
  // the retired v4-flash / vision-exp ids route to it, so the live V4.1 ids carry the
  // same image capability as the exp id above. "deepseek-flash" is the GA id on the
  // DeepSeek API; it previously fell through to the generic *deepseek* pattern, whose
  // 128K/64K limits are kept here. The repeated fields are deliberate: an exact entry
  // short-circuits the pattern table, so a vision-only delta would drop them.
  // Some providers (e.g. Kenari) expose this model under the hyphenated ID
  // "deepseek-v4-1-flash" (dash instead of dot); add it as an alias (#4293).
  "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
  "deepseek-v4-1-flash": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
  "deepseek-flash":      { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000, maxOutput: 64000 },

  // Qwen plain coder/text (no vision) — registry "vision-model" / "coder-model" aliases
  "vision-model":      { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },
  "coder-model":       { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 },

  // Kimi flagship + coding (platform + Kimi Code ids) — vision/video native
  "kimi-k3":           { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "k3":                { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 },
  "kimi-for-coding":   { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-for-coding-highspeed": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code":    { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  "kimi-k2.7-code-highspeed": { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 },
  // OpenCode Free Muse Spark — multimodal (text+image per models.dev meta/muse-spark)
  // via OpenAI Responses input_image; reasoning supports up to xhigh.
  "muse-spark-1.2-contributor-free": { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 },
  "muse-spark-1.3-contributor-free": { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 },
  // OpenCode Free Union Alpha — multimodal (text+vision), 262K context, 131K max output
  "union-alpha": { vision: true, contextWindow: 262144, maxOutput: 131072 },
};

const KIRO_GPT_5_6_CAPABILITIES = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000 };

// Codex OAuth (ChatGPT backend) — per-model context window reported by upstream
// (lower than OpenAI API's 1.05M). Sol differs from Terra/Luna. #2720
// thinkingCanDisable:false — the backend 400s on reasoning_effort "none"
// (Unsupported value), so the picker must not offer it and the wire clamps to
// minimal instead. See tests/unit/thinking-openai-reasoning-cannot-disable.test.js (#4031).
const CODEX_GPT_56_SOL_CAPS  = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 372000, maxOutput: 128000 };
const CODEX_GPT_56_DEFAULT_CAPS = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000 };
const CODEX_EXTENDED_CAPS = { ...CODEX_GPT_56_DEFAULT_CAPS, contextWindow: 872000 };

// Devin CLI's registry declares a 200k context window for these GPT variants.
// Keep the GPT feature/output fields because provider overrides short-circuit
// the generic pattern rather than merging with it.
const DEVIN_CLI_GPT_CAPS = { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 };

/**
 * Provider-specific capability overrides. Keyed by provider alias/id.
 */
export const PROVIDER_CAPABILITIES = {
  // NVIDIA NIM is OpenAI-compatible → rejects MiniMax/GLM native `thinking` field.
  // Force openai reasoning_effort format for its reasoning models. #issue
  "nvidia": {
    "minimaxai/minimax-m2.7": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 },
    "minimaxai/minimax-m3": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 131072 },
    "z-ai/glm-5.2": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 128000 },
    "deepseek-ai/deepseek-v4-pro": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
    "deepseek-ai/deepseek-v4-flash": { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 65536 },
  },
  // glm-5.3-flash on OpenCode Go is served by a backend that rejects the z.ai
  // `thinking` object (400: unknown field "thinking") and wants reasoning_effort.
  // Overrides the global entry, whose z.ai shape is correct for z.ai itself.
  "opencode-go": {
    "glm-5.3-flash": { vision: true, videoInput: true, pdf: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 131072 },
  },
  // NOTE: no "qoder" table on purpose. Qoder's ids are opaque gateway keys
  // (ultimate, qmodel, kmodel, ...) that the gateway renames at will; a
  // hand-kept table would rot. Opaque ids resolve dynamically instead via
  // getCapabilitiesForLiveModel (live display name -> family patterns, plus
  // the gateway's own per-model is_reasoning/is_vl signals).
  "codex": {
    "gpt-6.1-sol":               { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000 },
    "gpt-6-astra":               { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000 },
    "gpt-6-sol":                 { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000 },
    "gpt-6-luna":                { vision: true, reasoning: true, search: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 272000, maxOutput: 128000 },
    "gpt-6-astra[1m]":           CODEX_EXTENDED_CAPS,
    "gpt-6-sol[1m]":             CODEX_EXTENDED_CAPS,
    "gpt-6-luna[1m]":            CODEX_EXTENDED_CAPS,
    "gpt-5.6-sol[1m]":           CODEX_EXTENDED_CAPS,
    "gpt-5.6-terra[1m]":         CODEX_EXTENDED_CAPS,
    "gpt-5.6-luna[1m]":          CODEX_EXTENDED_CAPS,
    "gpt-5.6-sol":               CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-sol-review":        CODEX_GPT_56_SOL_CAPS,
    "gpt-5.6-terra":             CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-terra-review":      CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna":              CODEX_GPT_56_DEFAULT_CAPS,
    "gpt-5.6-luna-review":       CODEX_GPT_56_DEFAULT_CAPS,
  },
  "kiro": {
    "gpt-5.6-sol": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-thinking": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-sol-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-terra-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
    "gpt-5.6-luna-thinking-agentic": KIRO_GPT_5_6_CAPABILITIES,
  },
  "devin-cli": {
    "gpt-5.4-high": DEVIN_CLI_GPT_CAPS,
    "gpt-5.4-medium": DEVIN_CLI_GPT_CAPS,
    "gpt-5.4-low": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-xhigh": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-high": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-medium": DEVIN_CLI_GPT_CAPS,
    "gpt-5.5-low": DEVIN_CLI_GPT_CAPS,
  },
  // CodeBuddy.cn — authoritative per-model metadata from the gateway's model
  // config (contextWindow=maxInputTokens, maxOutput=maxOutputTokens, vision=
  // supportsImages). Every model reasons via OpenAI-style reasoning_effort
  // (see registry thinkingFormat). For thinkingCanDisable use the server's
  // reasoning.canDisableThinking flag — see the note in the codebuddy-cn block
  // below; it is NOT the inverse of onlyReasoning.
  "codebuddy-cn": {
    "glm-5.2":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.1":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 48000 },
    "glm-5.0":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    // maxOutput 64000 per both the plugin-baked fallback and the live server
    // table (the old 38000 had no source and truncated output).
    "glm-5v-turbo":       { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 64000 },
    "glm-4.7":            { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 48000 },
    "minimax-m3":         { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 512000, maxOutput: 128000 },
    "kimi-k2.7":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.6":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 256000, maxOutput: 32000 },
    "kimi-k2.5":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 164000, maxOutput: 32000 },
    "hy3-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "deepseek-v4-flash":  { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 50000 },
    "deepseek-v3-2-volc": { reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 96000, maxOutput: 32000 },
    // Per-model values mirror the server's product-config payload (the plugin
    // fetches it from copilot.tencent.com; the `models[]` entries carry
    // maxInputTokens/maxOutputTokens/supportsImages). contextWindow =
    // maxInputTokens, maxOutput = maxOutputTokens. Where the server and the
    // plugin-baked fallback disagree, the server table wins.
    // ⚠️ thinkingCanDisable maps to the server's reasoning.canDisableThinking —
    // it is NOT the inverse of onlyReasoning. onlyReasoning means "thinking is
    // on by default"; canDisableThinking means "it CAN be turned off". glm-5.3
    // and glm-5.3-flash are onlyReasoning:true BUT canDisableThinking:true, so
    // their thinking is switchable; the hy* models are forced always-on.
    "hy3":                { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 192000, maxOutput: 64000 },
    "hy4-preview":        { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 64000 },
    "glm-5.3":            { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 48000 },
    "glm-5.3-flash":      { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 32000 },
    "kimi-k3-1":          { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: false, contextWindow: 1000000, maxOutput: 32000 },
    "deepseek-v4-pro":    { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 50000 },
    // deepseek-v4.1-flash replaces v4-flash (dropped from the server list;
    // the old endpoint still answers 200 but the published list is the
    // contract). maxOutput 128000 per the server's product-config payload.
    "deepseek-v4.1-flash": { vision: true, reasoning: true, thinkingFormat: "openai", thinkingCanDisable: true, contextWindow: 1000000, maxOutput: 128000 },
  },
  // Poolside Laguna — OpenAI-compatible, all reasoning-capable (32K max output).
  "poolside": {
    "laguna-s-2.1":  { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 },
    "laguna-xs-2.1": { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 },
  },
  // Ollama Cloud — the generic *deepseek-v4* pattern misses the vision badge
  // the library page publishes for this model (text+image in, 1M context).
  // ponytail: thinkingFormat stays "deepseek" to preserve today's body shape;
  // Ollama's native toggle is the top-level `think` field (bool or
  // low/medium/high/max), which no format in thinkingUnified.js emits yet —
  // openai-to-ollama.js drops it. Wire a "think" format when thinking on
  // Ollama Cloud is actually needed.
  "ollama": {
    "deepseek-v4.1-flash:cloud": { vision: true, reasoning: true, thinkingFormat: "deepseek", contextWindow: 1000000, maxOutput: 384000 },
  },
};

// Qoder CN serves the identical model catalog from the CN gateway, so it shares
// the intl Qoder capability table verbatim (vision/reasoning/contextWindow).
PROVIDER_CAPABILITIES["qoder-cn"] = PROVIDER_CAPABILITIES["qoder"];
PROVIDER_CAPABILITIES.cx = PROVIDER_CAPABILITIES.codex;
PROVIDER_CAPABILITIES.dv = PROVIDER_CAPABILITIES["devin-cli"];
PROVIDER_CAPABILITIES.devin = PROVIDER_CAPABILITIES["devin-cli"];

/**
 * Pattern fallback — glob (* = wildcard), matched case-insensitively and
 * anchored (^...$) so a pattern must match the full model id. ORDER MATTERS:
 * vision/specific variants first, text-only/generic families last, to avoid
 * a broad family pattern swallowing an exception (e.g. glm-4.6v vs glm-5).
 */
export const PATTERN_CAPABILITIES = [
  // ── Claude (4.6+ = adaptive thinking; older/haiku = budget) ──────
  { pattern: "*claude*opus-5*",     caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*sonnet-5*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*opus-4.6*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.7*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*opus-4.8*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.6*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*sonnet-4.7*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-adaptive" } },
  { pattern: "*claude*haiku*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*opus*",   caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*sonnet*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },
  { pattern: "*claude*fable*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude*mythos*", caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget", contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*claude-3*",      caps: { vision: true } },
  { pattern: "*claude*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "claude-budget" } },

  // ── Gemini (all 2.0+ multimodal + google_search grounding, 1M ctx) ─
  { pattern: "*gemini*image*",  caps: { vision: true, imageOutput: true, contextWindow: 1048576 } },
  { pattern: "*gemini-3.8*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3.7*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-3*pro*",  caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65535 } },
  { pattern: "*gemini-3*",      caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-level", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2.5*",    caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, search: true, thinkingFormat: "gemini-budget", thinkingRange: { min: 0, max: 24576 }, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini-2*",      caps: { vision: true, audioInput: true, videoInput: true, search: true, contextWindow: 1048576, maxOutput: 65536 } },
  { pattern: "*gemini*",        caps: { vision: true, search: true, contextWindow: 1048576 } },
  { pattern: "*gemma*",         caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*nanobanana*",    caps: { vision: true, imageOutput: true } },

  // ── OpenAI GPT-6.x (vision + thinking + web search) ──────────────
  // 1.05M is the API window for the whole gpt-6 family (astra, luna, sol alike).
  // A gateway that truncates lower records its own number in
  // PROVIDER_CAPABILITIES, which wins over this pattern — Kiro at 272k, Codex
  // OAuth at 272k/372k (see CODEX_GPT_56_* above). This entry used to carry
  // Kiro's 272k, so every other provider's gpt-6 models inherited one gateway's
  // limit and were published at 3.9x under their real window.
  { pattern: "*gpt-6*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },

  // ── OpenAI GPT-5.x (vision + thinking + web search) ──────────────
  { pattern: "*gpt-5*image*",   caps: { imageOutput: true } },
  { pattern: "*gpt-5*codex*",   caps: { reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  // gpt-5.4 is where the 1.05M window starts, but the mini and nano tiers stayed
  // at 400k — first match wins, so those two have to be listed ahead of it.
  { pattern: "*gpt-5.4-mini*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4-nano*",  caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-5.4*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.5*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5.6*",       caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 1050000, maxOutput: 128000 } },
  { pattern: "*gpt-5*",         caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 400000, maxOutput: 128000 } },
  { pattern: "*gpt-4o*",        caps: { vision: true, search: true, contextWindow: 128000, maxOutput: 16384 } },
  { pattern: "*gpt-4.1*",       caps: { vision: true, contextWindow: 1000000, maxOutput: 32768 } },
  { pattern: "*gpt-4-turbo*",   caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*gpt-4*",         caps: { contextWindow: 128000 } },
  { pattern: "*gpt-3.5*",       caps: { contextWindow: 16385, maxOutput: 4096 } },
  { pattern: "*gpt-oss*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },

  // ── OpenAI o-series (reasoning, vision) ──────────────────────────
  { pattern: "*o1-mini*",       caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 128000 } },
  { pattern: "*o1*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o3*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },
  { pattern: "*o4*",            caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 100000 } },

  // ── Grok (vision + Live Search) ──────────────────────────────────
  { pattern: "*grok*image*",    caps: { imageOutput: true } },
  { pattern: "*grok-code*",     caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 256000 } },
  // Grok 4.6: 500k context, no text output limit (docs.x.ai/developers/grok-4-6)
  { pattern: "*grok-4.6*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 500000 } },
  // Grok 4.5 (Grok CLI / Grok Build): 500k context per cli-chat-proxy /v1/models
  { pattern: "*grok-4.5*",      caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 500000, maxOutput: 64000 } },
  { pattern: "*grok-4*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },
  { pattern: "*grok-3*",        caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 131072 } },
  { pattern: "*grok*",          caps: { vision: true, reasoning: true, search: true, thinkingFormat: "openai", contextWindow: 256000 } },

  // ── Qwen (3.5+ = native vision/video; coder & max = text-only; QwQ = thinking-only) ─
  { pattern: "*qwen*vl*",       caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwen*omni*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*qwen*coder*",    caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000 } },
  { pattern: "*qwen*max*",      caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.5*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.6*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen3.7*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*plus*",     caps: { vision: true, reasoning: true, thinkingFormat: "qwen", contextWindow: 1000000, maxOutput: 65536 } },
  { pattern: "*qwen*235b*",     caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },
  { pattern: "*qwq*",           caps: { reasoning: true, thinkingFormat: "qwen", thinkingCanDisable: false, contextWindow: 131072 } },
  { pattern: "*qwen*",          caps: { reasoning: true, thinkingFormat: "qwen", contextWindow: 262144 } },

  // ── Kimi (enabled→reasoning_effort; K2.7-code cannot disable) ─────
  { pattern: "*kimi*k3*",       caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*kimi*for-coding*", caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2.7*code*", caps: { vision: true, videoInput: true, reasoning: true, thinkingFormat: "kimi", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 65536 } },
  { pattern: "*kimi*k2*",       caps: { vision: true, reasoning: true, thinkingFormat: "kimi", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*kimi*",          caps: { reasoning: true, thinkingFormat: "kimi", contextWindow: 262144 } },

  // ── GLM / Z.ai (thinking.enabled; disable via enable_thinking:false) ─
  // reasoning_effort is only read by z.ai from GLM-5.2 onward (docs.z.ai/guides/capabilities/thinking) —
  // older GLM (4.x, 5.0, 5.1, 5-turbo, 5v-turbo) ignore it, so gate it per exact version, not the "*glm-5*" catch-all.
  { pattern: "*glm-5.3*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-5.2*",       caps: { reasoning: true, thinkingFormat: "zai", thinkingEffortSupported: true, contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-5*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4.7*",       caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000, maxOutput: 128000 } },
  { pattern: "*glm-4*",         caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },
  { pattern: "*glm*",           caps: { reasoning: true, thinkingFormat: "zai", contextWindow: 200000 } },

  // ── DeepSeek (thinking.enabled + reasoning_effort; r1 = thinking-only) ─
  // v4.1+ has real image input (probed live on Alibaba MaaS: correct color
  // read from a PNG). v4-pro / v4-flash-0731 accept image blocks but ignore
  // them (answered "Unknown"), so vision stays scoped to v4.* dotted releases.
  { pattern: "*deepseek-v4.*",  caps: { vision: true, reasoning: true, thinkingFormat: "deepseek", thinkingEffortSupported: true, contextWindow: 1000000, maxOutput: 128000 } },
  { pattern: "*deepseek-v4*",   caps: { reasoning: true, thinkingFormat: "deepseek", thinkingEffortSupported: true, contextWindow: 1000000, maxOutput: 384000 } },
  { pattern: "*reasoner*",      caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-r*",    caps: { reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 128000 } },
  { pattern: "*deepseek-chat*", caps: { contextWindow: 128000 } },
  { pattern: "*deepseek*",      caps: { reasoning: true, thinkingFormat: "deepseek", contextWindow: 128000 } },

  // ── MiniMax (M3 = adaptive; M2.x cannot disable) ─────────────────
  { pattern: "*minimax*image*", caps: { imageOutput: true } },
  { pattern: "*minimax-m3*",    caps: { vision: true, reasoning: true, thinkingFormat: "minimax", contextWindow: 1000000, maxOutput: 131072 } },
  { pattern: "*minimax-m2.7*",  caps: { vision: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax-m2.5*",  caps: { vision: true, reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 204800, maxOutput: 131072 } },
  { pattern: "*minimax*",       caps: { reasoning: true, thinkingFormat: "minimax", thinkingCanDisable: false, contextWindow: 200000, maxOutput: 131072 } },

  // ── Xiaomi MiMo (vision + <think>-tag reasoning, always-on, can't disable) ──
  { pattern: "*mimo*v2.6*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*v2.5*",     caps: { vision: true, audioInput: true, videoInput: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 1048576, maxOutput: 131072 } },
  { pattern: "*mimo*omni*",     caps: { vision: true, audioInput: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 131072 } },
  { pattern: "*mimo*",          caps: { vision: true, reasoning: true, thinkingFormat: "deepseek", thinkingCanDisable: false, contextWindow: 262144, maxOutput: 131072 } },

  // ── Llama (4 = vision/1M; 3.x = text-only/128K) ──────────────────
  { pattern: "*llama-4*",       caps: { vision: true, contextWindow: 1000000 } },
  { pattern: "*llama*",         caps: { contextWindow: 128000 } },

  // ── Mistral (Large 3 = vision/256K; codestral text) ──────────────
  { pattern: "*codestral*",     caps: { contextWindow: 256000 } },
  { pattern: "*mistral-large*", caps: { vision: true, contextWindow: 256000 } },
  { pattern: "*mistral*",       caps: { contextWindow: 128000 } },

  // ── Cohere (Command A Vision = vision; others text) ──────────────
  { pattern: "*command-a-vision*", caps: { vision: true, contextWindow: 128000 } },
  { pattern: "*command*",       caps: { contextWindow: 128000 } },

  // ── Perplexity (web search native) ───────────────────────────────
  { pattern: "*sonar*",         caps: { search: true, contextWindow: 128000 } },
  { pattern: "*pplx*",          caps: { search: true, contextWindow: 128000 } },
  { pattern: "*perplexity*",    caps: { search: true, contextWindow: 128000 } },

  // ── Poolside Laguna (resellers: openrouter/nvidia/kilocode/vercel/...) ──
  // Free tiers cap S 2.1 well below the paid 1M window → match the free suffix
  // (":free" or "-free", depending on reseller) before the plain id.
  { pattern: "*laguna-s-2.1*free*", caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },
  { pattern: "*laguna-s-2.1*",  caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 1000000, maxOutput: 32000 } },
  { pattern: "*laguna*",        caps: { reasoning: true, thinkingFormat: "openai", contextWindow: 200000, maxOutput: 32000 } },


  // ── OpenCode Free Muse Spark (multimodal text+image; OpenAI Responses reasoning supports up to xhigh) ─
  { pattern: "*muse*spark*",    caps: { vision: true, reasoning: true, thinkingFormat: "openai", contextWindow: 1048576, maxOutput: 131072 } },
  // ── Others ───────────────────────────────────────────────────────
  { pattern: "*hunyuan*",       caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "hy3*",            caps: { reasoning: true, thinkingFormat: "hunyuan", contextWindow: 262144, maxOutput: 262144 } },
  { pattern: "*step-*",         caps: { reasoning: true, thinkingFormat: "step", contextWindow: 128000 } },
  { pattern: "*nemotron*",      caps: { reasoning: true, contextWindow: 128000 } },
  { pattern: "*ling-*",         caps: { reasoning: true, contextWindow: 128000 } },
];

/**
 * Aggregate capabilities for a combo from its constituent model IDs.
 * Each entry in comboModels is a fully-qualified "provider/model" string.
 *
 * Union:        vision, pdf, audioInput, videoInput, imageOutput, audioOutput, search
 * Intersection: tools
 * Primary:      reasoning fields from the first (primary) model
 * Conservative: contextWindow = min; maxOutput = max
 *
 * @param {string[]} comboModels
 * @param {Object|null} [comboLookup] optional map of combo name → models array for nested resolution
 * @param {Function|null} [resolveCaps] optional (fullId) → caps override. The synced model
 *   catalog is server-only (it reads a file), so a browser-side resolution cannot see the
 *   limits it supplies and silently falls back to the generic patterns below. Callers that
 *   have the server's answer (/api/models, via useModelCaps) pass it here; it is merged over
 *   the local tables, so fields it does not carry (tools, pdf, audio/video, thinking*) survive.
 * @param {number} [_depth] internal recursion depth guard
 * @returns {object|null} full capabilities object, or null for empty input
 */
export function aggregateComboCapabilities(comboModels, comboLookup = null, resolveCaps = null, _depth = 0) {
  if (!comboModels?.length || _depth > 6) return null;
  const allCaps = comboModels.map((fullId) => {
    // Nested combo: bare name (no slash) that exists in the lookup — recurse
    if (!fullId.includes("/") && comboLookup?.[fullId]) {
      return aggregateComboCapabilities(comboLookup[fullId], comboLookup, resolveCaps, _depth + 1)
          ?? resolveCaps?.(fullId)
          ?? getCapabilitiesForModel(null, fullId);
    }
    const slash = fullId.indexOf("/");
    const provider = slash === -1 ? null : fullId.slice(0, slash);
    const model = slash === -1 ? fullId : fullId.slice(slash + 1);
    const local = getCapabilitiesForModel(provider, model);
    const override = resolveCaps?.(fullId);
    return override ? { ...local, ...override } : local;
  });
  const first = allCaps[0];
  return {
    vision:      allCaps.some((c) => c.vision),
    pdf:         allCaps.some((c) => c.pdf),
    audioInput:  allCaps.some((c) => c.audioInput),
    videoInput:  allCaps.some((c) => c.videoInput),
    imageOutput: allCaps.some((c) => c.imageOutput),
    audioOutput: allCaps.some((c) => c.audioOutput),
    search:      allCaps.some((c) => c.search),
    tools:       allCaps.every((c) => c.tools),
    reasoning:          first.reasoning,
    // Union of every member's selectable efforts: a combo can express any level
    // any member supports, and the per-candidate reconciler maps the chosen
    // level onto whichever member ultimately serves the request
    // (translateRequest coerceLevels=true → resolveLevelFor nearest-supported,
    // thinking.js). Intersection would hide levels that ARE available whenever
    // their owning seat serves; the wire never sends a member a level it
    // rejects — it is re-encoded onto that member's nearest level instead.
    // Absent (not `[]`) when no member declares levels, so the picker can tell
    // "no effort control" from "control with an empty set".
    reasoningLevels:    (() => {
      const union = new Set();
      for (const c of allCaps) {
        for (const l of (c.reasoningLevels || c.reasoningEfforts || [])) union.add(l);
      }
      return union.size ? [...union] : undefined;
    })(),
    thinkingFormat:     first.thinkingFormat,
    thinkingCanDisable: first.thinkingCanDisable,
    thinkingEffortSupported: allCaps.some((c) => c.thinkingEffortSupported),
    thinkingRange:      first.thinkingRange,
    contextWindow: Math.min(...allCaps.map((c) => c.contextWindow)),
    maxOutput:     Math.max(...allCaps.map((c) => c.maxOutput)),
  };
}

/**
 * Resolve capabilities for a model using the 4-step fallback chain,
 * merged over DEFAULT_CAPABILITIES so the result is always complete.
 *
 * @param {string} provider
 * @param {string} model
 * @returns {object} full capabilities object
 */
const MODALITY_KEYS = ["vision", "pdf", "audioInput", "videoInput"];

// Catalog lookups, installed by the server at startup. Left as no-ops in the
// browser bundle, where there is no file to read.
//
// The server bundles this module into every route chunk that needs it, and each
// copy carries its own module state, so an install landing in the copy the
// startup hook imported stays invisible to the copy resolving requests. The slot
// lives on globalThis instead, and every read goes through it: caching it locally
// would keep a reader alive in other copies after setCatalogSource(null).
let catalogSource = null;

/**
 * Install the synced catalog reader (server only).
 * @param {{ getModalities: (provider: string, model: string) => object|null,
 *           getLimits: (provider: string, model: string) => object|null } | null} source
 */
export function setCatalogSource(source) {
  catalogSource = source;
  if (typeof globalThis !== "undefined") globalThis.__9rCatalogSource = source;
}

function getCatalogSource() {
  if (typeof globalThis === "undefined") return catalogSource;
  return globalThis.__9rCatalogSource || null;
}

// Apply the synced catalog + name heuristic on top of a table-resolved result.
// Strictly additive: a capability already true stays true, and a false one only
// flips when an outside source positively declares support.
function refine(base, provider, model) {
  const result = { ...DEFAULT_CAPABILITIES, ...base };

  const source = getCatalogSource();
  if (source) {
    const modalities = source.getModalities(provider, model);
    if (modalities) {
      for (const key of MODALITY_KEYS) {
        if (modalities[key] === true) result[key] = true;
      }
    }

    const limits = source.getLimits(provider, model);
    if (limits) {
      if (limits.contextWindow > 0) result.contextWindow = limits.contextWindow;
      if (limits.maxOutput > 0) result.maxOutput = limits.maxOutput;
    }
  }

  if (!result.vision && looksLikeVisionModel(model)) result.vision = true;

  return result;
}

// Mirrors Command Code CLI `isKnownTextOnlyModel` (no image input). New models
// default to vision; only this denylist stays text-only.
const COMMANDCODE_TEXT_ONLY = new Set([
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-flash-fast",
  "zai-org/glm-5.3",
  "zai-org/glm-5.2",
  "zai-org/glm-5.2-fast",
  "zai-org/glm-5.1",
  "zai-org/glm-5",
  "minimaxai/minimax-m2.7",
  "minimax/minimax-m2.7-free",
  "minimaxai/minimax-m2.5",
  "xiaomi/mimo-v2.5-pro",
  "qwen/qwen3.6-max-preview",
  "qwen/qwen3.7-max",
  "meituan/longcat-2.0:free",
  "stepfun/step-3.5-flash",
  "tencent/hy4-preview",
  "tencent/hy3",
  "tencent/hy3-paid",
  "nvidia/nemotron-3-ultra-550b-a55b",
  "poolside/laguna-s-2.1-free",
  "inclusionai/ling-3.0-flash-free",
  "inclusionai/ling-3.0-flash-sante:free",
]);

function isCommandCodeTextOnly(model) {
  const key = String(model || "").toLowerCase();
  if (COMMANDCODE_TEXT_ONLY.has(key)) return true;
  for (const id of COMMANDCODE_TEXT_ONLY) {
    const base = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
    if (key === base || key.endsWith("/" + base)) return true;
  }
  return false;
}
// ── Single source of truth for selectable reasoning levels ─────────────
// Canonical ladder order (low → high). `none` is FIRST and terminal ("thinking
// disabled", not minimal effort). `ultra` is real on two Codex models (one step
// above max). Off-ladder aliases (e.g. zai `thinking`) sort after the canonical
// set, preserving first-seen order.
const LEVEL_RANK = new Map(
  ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"].map((l, i) => [l, i])
);

export function orderReasoningLevels(levels) {
  const seen = new Set();
  const ranked = [];
  const unranked = [];
  for (const l of levels || []) {
    if (typeof l !== "string" || seen.has(l)) continue;
    seen.add(l);
    if (LEVEL_RANK.has(l)) ranked.push(l);
    else unranked.push(l);
  }
  ranked.sort((a, b) => LEVEL_RANK.get(a) - LEVEL_RANK.get(b));
  return [...ranked, ...unranked];
}

// Shared level sets (deduped) — verified against provider docs + wire in thinkingUnified.applyFormat.
const L = {
  base: ["none", "low", "medium", "high"],                          // qwen, step, hunyuan, gemini-budget
  onOff: ["none", "thinking"],                                      // zai (binary), minimax (adaptive)
  openai: ["none", "minimal", "low", "medium", "high", "xhigh"],    // GPT-5.x / o-series (no "max")
  levelMax: ["none", "low", "medium", "high", "max"],               // kimi
  budgetX: ["none", "low", "medium", "high", "xhigh", "max"],       // claude-budget, claude-adaptive
  gemini: ["minimal", "low", "medium", "high"],                     // gemini-3 thinkingLevel (no disable)
  hiMax: ["none", "high", "max"],                                   // deepseek (low/med→high, xhigh→max)
};

// thinkingFormat → valid selectable levels (source of truth for UI options).
export const FORMAT_LEVELS = {
  openai: L.openai,
  "claude-adaptive": L.budgetX,
  "claude-budget": L.budgetX,
  "gemini-level": L.gemini,
  "gemini-budget": L.base,
  zai: L.onOff,
  qwen: L.base,
  kimi: L.levelMax,
  deepseek: L.hiMax,
  commandcode: ["none", "low", "medium", "high", "xhigh", "max"],
  minimax: L.onOff,
  hunyuan: L.base,
  step: L.base,
};

const CODEX_GPT_5_6_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// Opus/Sonnet 4.6 lack xhigh (Anthropic + Kiro docs) — keep the 4-level+max set.
const CLAUDE_NO_XHIGH = ["none", "low", "medium", "high", "max"];

// Model-name pattern overrides (glob, first match wins) — more precise than format default.
export const PATTERN_THINKING = [
  { pattern: "*claude*4.6*", levels: CLAUDE_NO_XHIGH },
  { pattern: "*claude*4-6*", levels: CLAUDE_NO_XHIGH },
  { provider: "codex", pattern: "*gpt-6*", levels: CODEX_GPT_5_6_LEVELS },
  { provider: "codex", pattern: "*gpt-5.6-sol*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-terra*", levels: [...CODEX_GPT_5_6_LEVELS, "ultra"] },
  { provider: "codex", pattern: "*gpt-5.6-luna*", levels: CODEX_GPT_5_6_LEVELS },
  { pattern: "*codex*", levels: ["low", "medium", "high", "xhigh"] }, // codex cannot disable thinking
  { pattern: "*mimo*v2.6*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // mimo-v2.5-pro on opencode-go rejects reasoning_effort "max" (probed live); v2.5 accepts it.
  { pattern: "*mimo*v2.5-pro*", levels: ["none", "low", "medium", "high", "xhigh"] },
  // DeepSeek v4.* (Alibaba MaaS, probed live): effort low|medium|high|xhigh|max
  // all 200 via output_config.effort; "none" is a 400 on the anthropic route
  // (disable thinking instead). none kept for the picker = disable.
  { pattern: "*deepseek-v4.*", levels: ["none", "low", "medium", "high", "xhigh", "max"] },
  // codebuddy-cn per-model effort sets — the server's product-config payload
  // publishes `reasoning.supportedEfforts` per model. NOTE: the chat endpoint
  // accepts any level you send (probed none/minimal/low/medium/high/xhigh/max
  // → all 200), but values outside a model's supportedEfforts are silently
  // clamped, so the declared set stays authoritative for the picker. Models
  // that publish no supportedEfforts (glm-5.1 / glm-5v-turbo / kimi-k2.x /
  // kimi-k3-1 / minimax-m3) fall through to the openai format default.
  { provider: "codebuddy-cn", pattern: "glm-5.3*",     levels: ["low", "high", "max"] },
  { provider: "codebuddy-cn", pattern: "glm-5.2",      levels: ["high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
  { provider: "codebuddy-cn", pattern: "hy3*",         levels: ["low", "high"] },
  { provider: "codebuddy-cn", pattern: "hy4*",         levels: ["high"] },
  // codebuddy-intl rides the same gateway catalog, so its deepseek levels match.
  { provider: "codebuddy-intl", pattern: "deepseek-v4*", levels: ["low", "high", "xhigh"] },
];

// Resolve the selectable reasoning ladder for one model — the ONLY place the
// precedence lives. Order: exact Codex registry entry → PATTERN_THINKING
// override → discovered ladder (models.dev reasoning_options via the synced
// catalog) → thinkingFormat default. Returns `undefined` (not `[]`) when the
// model reasons but exposes no known effort control — callers must offer a
// toggle only and must NOT invent levels. `none` is kept only when the model
// can disable thinking (thinkingCanDisable !== false). Kiro models with no
// effort path resolve to `undefined` (Kiro null case).
export function resolveReasoningLevels(provider, model, caps, discoveredLevels = null, codexLevels = null) {
  if (provider === "kiro") {
    try {
      if (resolveKiroEffortPath(model) === null) return undefined;
    } catch { /* kiro helper unavailable (browser bundle) — fall through */ }
  }
  if (!caps?.reasoning) return undefined;
  const hit = PATTERN_THINKING.find((entry) =>
    (!entry.provider || entry.provider === provider) && matchPattern(entry.pattern, model)
  );
  let levels = codexLevels || hit?.levels || discoveredLevels || FORMAT_LEVELS[caps.thinkingFormat];
  if (!levels) return undefined;
  let ordered = orderReasoningLevels(levels);
  if (caps.thinkingCanDisable === false) ordered = ordered.filter((l) => l !== "none");
  return ordered.length ? ordered : undefined;
}

// Formats whose applyFormat encoder in thinkingUnified.js sends an effort level
// (reasoning_effort / output_config.effort / thinkingLevel). Budget-only formats
// (claude-budget, gemini-budget, qwen, hunyuan) and toggle-only ones (minimax,
// kiro) map levels to budgets/switches instead, so the flag stays false there.
// zai is deliberately absent: z.ai only reads reasoning_effort from GLM-5.2
// onward, so zai models need positive per-model evidence (a discovered effort
// ladder or a table fallback) rather than a format default.
const EFFORT_WIRE_FORMATS = new Set([
  "openai",
  "claude-adaptive",
  "gemini-level",
  "deepseek",
  "kimi",
  "step",
  "tokenrouter",
  "commandcode",
]);

export function getCapabilitiesForModel(provider, model) {
  const result = resolveCapabilities(provider, model);
  // Auto-recognized effort support, two layers:
  // 1. Discovered effort ladder (models.dev reasoning_options): positive
  //    per-model evidence this model takes effort control, for ANY provider
  //    including OAuth and OpenCode Free ids. Applies to every effort-wire
  //    format plus zai.
  // 2. Format default: a reasoning model on an effort-wire format supports
  //    effort even with no catalog file (fresh install, offline, browser
  //    bundle) - no per-model table edit needed, for any provider.
  // Toggle/budget-only models keep the tables answer (no field).
  const source = getCatalogSource();
  const discovered = source?.getReasoning?.(provider, model);
  const reasoned = result.reasoning;
  if (discovered?.levels?.length) {
    result.reasoning = true;
    result.reasoningLevels = discovered.levels;
    if (result.thinkingFormat === "zai" || EFFORT_WIRE_FORMATS.has(result.thinkingFormat)) {
      result.thinkingEffortSupported = true;
    }
  } else {
    // Upstream positively says the model reasons but publishes no ladder (it is
    // toggle/budget only). Turn the capability on — "does not reason" would be
    // wrong — and leave everything else at the tables' answer: a toggle is not
    // effort control, so neither the wire flag nor the level set may be inferred
    // from it.
    if (!reasoned && source?.getReasons?.(provider, model)) result.reasoning = true;
    if (reasoned && EFFORT_WIRE_FORMATS.has(result.thinkingFormat)) {
      result.thinkingEffortSupported = true;
    }
  }
  // Single source of truth for the picker ladder: exact Codex entry, then
  // PATTERN_THINKING override, then the discovered ladder above, then the
  // format default — with the canDisable filter and Kiro null case. Every
  // reasoning model with known effort control leaves here with an ordered,
  // deduplicated ladder; toggle-only / unknown-effort models leave with NO
  // reasoningLevels key so consumers offer a toggle instead of inventing
  // levels. Codex exact entries come from the co-located registry (transport +
  // models); the suffix "(level)" picker form is stripped before lookup.
  if (result.reasoning) {
    let codexLevels = null;
    if (provider === "codex" || provider === "cx") {
      try {
        const baseId = String(model || "").replace(/\([^()]+\)\s*$/, "");
        codexLevels = getProviderModels("cx").find((entry) => entry.id === baseId)?.thinkingLevels || null;
      } catch { codexLevels = null; }
    }
    const resolved = resolveReasoningLevels(provider, model, result, result.reasoningLevels || null, codexLevels);
    if (resolved?.length) result.reasoningLevels = resolved;
    else delete result.reasoningLevels;
  } else {
    delete result.reasoningLevels;
  }
  return result;
}

// Resolve capabilities for a model id the static tables do not know (opaque
// gateway keys, brand-new upstream ids). No per-model hardcoding: every answer
// below is derived at call time from live data the gateway itself publishes.
//
// Precedence:
//  1. An explicitly passed capabilities object (a resolver that already knows).
//  2. The live display name through the shared tables: gateways name models
//     after their family ("GLM-5.3", "DeepSeek-V4-Pro", "Kimi-K3"), so the
//     normal id-based lookup resolves them with zero new entries. A gateway
//     rename or a brand-new family id self-resolves the same way.
//  3. The gateway's own per-model signals (Qoder publishes is_reasoning/is_vl
//     plus token limits per key): positive live evidence beats the floor.
//  4. Otherwise the static result untouched (never invent values).
export function getCapabilitiesForLiveModel(provider, modelId, live = {}) {
  if (live?.capabilities) return live.capabilities;
  const base = getCapabilitiesForModel(provider, modelId);
  if (base.reasoning) return base;
  const name = typeof live?.name === "string" && live.name.trim() ? live.name.trim() : null;
  if (name && name !== modelId) {
    const byName = getCapabilitiesForModel(provider, name);
    if (byName.reasoning) {
      return {
        ...byName,
        contextWindow: Number.isFinite(live?.contextLength) && live.contextLength > 0
          ? live.contextLength
          : byName.contextWindow,
        maxOutput: Number.isFinite(live?.maxOutputTokens) && live.maxOutputTokens > 0
          ? live.maxOutputTokens
          : byName.maxOutput,
      };
    }
  }
  if (live?.isReasoning) {
    return {
      ...base,
      reasoning: true,
      vision: base.vision || live.isVL === true,
      contextWindow: Number.isFinite(live?.contextLength) && live.contextLength > 0
        ? live.contextLength
        : base.contextWindow,
      maxOutput: Number.isFinite(live?.maxOutputTokens) && live.maxOutputTokens > 0
        ? live.maxOutputTokens
        : base.maxOutput,
    };
  }
  if (live?.isVL) {
    return { ...base, vision: true };
  }
  return base;
}

function resolveCapabilities(provider, model) {
  if (!model) return { ...DEFAULT_CAPABILITIES };

  // Canonical exact lookup strips vendor prefix: "anthropic/claude-opus-4.7" -> "claude-opus-4.7".
  const baseModel = model.includes("/") ? model.split("/").pop() : model;

  // CommandCode wire is /alpha/generate for every model. Family patterns
  // (deepseek-v4 → thinkingFormat:deepseek, vision:false) must not win here.
  if (provider === "commandcode" || provider === "cmc") {
    const providerCaps = PROVIDER_CAPABILITIES.commandcode;
    if (providerCaps?.[model]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[model] };
    if (providerCaps?.[baseModel]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[baseModel] };
    return {
      ...DEFAULT_CAPABILITIES,
      reasoning: true,
      thinkingFormat: "commandcode",
      thinkingEffortSupported: true,
      vision: !isCommandCodeTextOnly(model),
      contextWindow: 1000000,
      maxOutput: 384000,
    };
  }

  // 1. Provider-specific override
  if (provider) {
    const providerCaps = PROVIDER_CAPABILITIES[provider];
    if (providerCaps?.[model]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[model] };
    if (providerCaps?.[baseModel]) return { ...DEFAULT_CAPABILITIES, ...providerCaps[baseModel] };
  }

  // 2. Canonical exact, then catalog overlay so provider-scoped models.dev
  //    deltas still apply. Step 1 above still short-circuits.
  if (MODEL_CAPABILITIES[baseModel]) return refine(MODEL_CAPABILITIES[baseModel], provider, model);
  if (MODEL_CAPABILITIES[model]) return refine(MODEL_CAPABILITIES[model], provider, model);

  // 3. Pattern match (first match wins), refined by catalog + name heuristic
  for (const { pattern, caps } of PATTERN_CAPABILITIES) {
    if (matchPattern(pattern, baseModel) || matchPattern(pattern, model)) {
      return refine(caps, provider, model);
    }
  }

  // 4. Floor
  return refine(null, provider, model);
}
