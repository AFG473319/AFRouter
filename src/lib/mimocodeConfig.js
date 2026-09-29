/**
 * MiMoCode / MiMo Desktop config shapes, shared by /api/cli-tools/mimocode-settings
 * and the dashboard card so the file we write and the Manual Config preview
 * cannot drift.
 *
 * MiMoCode is an OpenCode fork: the config is JSONC under
 * `~/.config/mimocode/mimocode.jsonc` (or `$MIMOCODE_HOME` / `%LOCALAPPDATA%\mimocode`).
 * The AFRouter provider entry is the V1 OpenCode shape:
 *
 *   provider.afrouter = {
 *     name, npm: "@ai-sdk/openai-compatible", only_configured_models,
 *     options: { baseURL, apiKey },
 *     models: {
 *       "<id>": {
 *         name,
 *         limit: { context, output },
 *         reasoning,
 *         tool_call,
 *         modalities: { input: [...], output: ["text"] },
 *       },
 *     },
 *   }
 *
 * Model metadata is load-bearing in MiMoCode: `limit.context` sizes the context
 * budget / compaction, `modalities.input` drives what the TUI attaches, and
 * `reasoning` / `tool_call` gate thinking and tools. Specs are therefore resolved
 * from the live catalog / static capability tables — never invented.
 *
 * Deliberately NOT written, and why:
 *   - `attachment`: not in MiMoCode's documented model schema. `modalities.input`
 *     already carries the same signal (any non-text modality).
 *   - `cost`: a gateway publishes no per-model tariff; invented prices are worse
 *     than MiMoCode's own default.
 *
 * Pure module (no Node builtins) so the client-side card can import it too.
 */

export const AFROUTER_PROVIDER_ID = "afrouter";
export const PROVIDER_NAME = "AFRouter";
export const PACKAGE = "@ai-sdk/openai-compatible";
export const DEFAULT_API_KEY = "sk_afrouter";

/** Top-level selection is always `<provider-id>/<model-id>`; ids may contain `/`. */
export const modelSelection = (id) => `${AFROUTER_PROVIDER_ID}/${id}`;

// Conservative fallback for ids resolvable from neither the live catalog nor the
// static registry — flagged "unverified", never invented. Matches the capability
// floor MiMoCode itself would apply, minus any invented vision/reasoning.
export const FALLBACK_SPEC = Object.freeze({
  contextWindow: 200000,
  maxOutput: 64000,
  vision: false,
  pdf: false,
  audioInput: false,
  videoInput: false,
  reasoning: false,
  tools: true,
});

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** AFRouter talks to /v1/chat/completions; the card supplies the bare origin. */
export const normalizeBaseUrl = (baseUrl) => {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return trimmed.endsWith("/v1") ? trimmed.replace(/\/+\/v1$/, "/v1") : `${trimmed}/v1`;
};

/**
 * Input modalities MiMoCode's `/modalities` TUI understands. Always starts with
 * text; extras are only added when the resolved spec actually claims them.
 */
export const buildModelInput = (caps = {}) => {
  const input = ["text"];
  if (caps.vision) input.push("image");
  if (caps.pdf) input.push("pdf");
  if (caps.audioInput) input.push("audio");
  if (caps.videoInput) input.push("video");
  return input;
};

/**
 * One MiMoCode model entry. Machine-readable fields always come from `caps`
 * (catalog / static registry / FALLBACK_SPEC). Display `name` defaults to the id.
 */
export const buildModelEntry = (id, caps = {}) => {
  const context = Math.floor(caps.contextWindow ?? FALLBACK_SPEC.contextWindow);
  const output = Math.floor(caps.maxOutput ?? FALLBACK_SPEC.maxOutput);
  return {
    name: id,
    limit: {
      context: Number.isFinite(context) && context > 0 ? context : FALLBACK_SPEC.contextWindow,
      output: Number.isFinite(output) && output > 0 ? output : FALLBACK_SPEC.maxOutput,
    },
    reasoning: caps.reasoning === true,
    tool_call: caps.tools !== false,
    modalities: {
      input: buildModelInput(caps),
      output: ["text"],
    },
  };
};

/**
 * Refresh the machine-readable spec fields of an existing entry while keeping
 * a display `name` the user set (anything other than the bare id). Capabilities
 * always win over stale hand-edits so a re-Apply after a catalog update
 * propagates correct limits/modalities.
 */
export const mergeModelEntry = (id, caps = {}, existing = null) => {
  const entry = buildModelEntry(id, caps);
  if (isObject(existing) && typeof existing.name === "string" && existing.name !== id) {
    entry.name = existing.name;
  }
  return entry;
};

/** The `afrouter` provider entry, carrying over anything the user added. */
export const buildProviderEntry = ({ baseUrl, apiKey, source = {} } = {}) => {
  const safe = isObject(source) ? source : {};
  const { models, options, ...rest } = safe;
  const options_ = isObject(options) ? options : {};
  return {
    name: typeof safe.name === "string" && safe.name ? safe.name : PROVIDER_NAME,
    npm: typeof safe.npm === "string" && safe.npm ? safe.npm : PACKAGE,
    only_configured_models: true,
    ...rest,
    options: {
      ...options_,
      baseURL: normalizeBaseUrl(baseUrl),
      apiKey: apiKey || DEFAULT_API_KEY,
    },
    models: isObject(models) ? models : {},
  };
};

/** Model ids currently declared under the AFRouter provider. */
export const readModelIds = (config) => {
  const models = config?.provider?.[AFROUTER_PROVIDER_ID]?.models;
  return isObject(models) ? Object.keys(models) : [];
};
