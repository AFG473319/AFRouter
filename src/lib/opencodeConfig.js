/**
 * OpenCode config shapes, shared by /api/cli-tools/opencode-settings and the
 * dashboard card so the file we write and the Manual Config preview cannot drift.
 *
 * OpenCode 2 still reads V1 files, but its native shape differs and it warns
 * about the V1 fields it retired. We therefore build either shape and never mix
 * the two inside one provider, model, or agent entry — OpenCode's normalizer only
 * tolerates mixing at the top level:
 *
 *   V1                            V2
 *   provider                      providers
 *   npm                           package ("aisdk:" prefix for AI SDK packages)
 *   options                       settings
 *   model.tool_call               model.capabilities.tools
 *   model.modalities              model.capabilities.input / .output
 *   model.attachment, .reasoning  retired — V2 ignores them with a warning
 *   agent                         agents
 *
 * Pure module (no Node builtins) so the client-side card can import it too.
 */

export const AFROUTER_PROVIDER_ID = "afrouter";

export const SUBAGENT_NAME = "explorer";
export const SUBAGENT_DESCRIPTION = "Fast explorer subagent for codebase exploration";

export const V1_PACKAGE = "@ai-sdk/openai-compatible";
export const V2_PACKAGE = "aisdk:@ai-sdk/openai-compatible";

export const FORMATS = Object.freeze(["v1", "v2"]);
export const DEFAULT_FORMAT = "v1";

// Conservative fallback for ids resolvable from neither the live catalog nor the
// static registry — flagged "unverified", never invented.
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

export const isFormat = (value) => FORMATS.includes(value);

export const providerMapKey = (format) => (format === "v2" ? "providers" : "provider");
export const agentMapKey = (format) => (format === "v2" ? "agents" : "agent");
export const otherFormat = (format) => (format === "v2" ? "v1" : "v2");

// Accepted input modalities are identical in both shapes; V2 keeps them under
// `capabilities` and V1 splits them across modalities/tool_call/attachment.
export const buildModelCapabilities = (caps) => {
  const input = ["text"];
  if (caps.vision) input.push("image");
  if (caps.pdf) input.push("pdf");
  if (caps.audioInput) input.push("audio");
  if (caps.videoInput) input.push("video");
  return { tools: caps.tools !== false, input, output: ["text"] };
};

export const buildModelEntry = (id, caps, format = DEFAULT_FORMAT) => {
  const limit = {
    context: Math.floor(caps.contextWindow),
    output: Math.floor(caps.maxOutput),
  };
  const capabilities = buildModelCapabilities(caps);
  if (format === "v2") return { name: id, limit, capabilities };
  return {
    name: id,
    limit,
    reasoning: caps.reasoning === true,
    tool_call: capabilities.tools,
    attachment: capabilities.input.some((modality) => modality !== "text"),
    modalities: { input: capabilities.input, output: capabilities.output },
  };
};

/**
 * Rewrite a model entry into `format` without touching its values, so switching
 * shapes never leaves V1 and V2 members side by side in one provider. Values V2
 * retired (attachment/reasoning) are preserved where the target shape has them.
 */
export const reshapeModelEntry = (entry, format) => {
  if (!isObject(entry)) return entry;
  if (format === "v2") {
    // V2 dropped attachment/reasoning on models, so they are not carried over.
    const { tool_call, modalities, attachment, reasoning, id, options, ...rest } = entry;
    return {
      ...rest,
      ...(typeof id === "string" && rest.modelID === undefined ? { modelID: id } : null),
      ...(isObject(options) && rest.settings === undefined ? { settings: options } : null),
      capabilities: isObject(entry.capabilities)
        ? entry.capabilities
        : {
            tools: tool_call !== false,
            input: Array.isArray(modalities?.input) ? modalities.input : ["text"],
            output: Array.isArray(modalities?.output) ? modalities.output : ["text"],
          },
    };
  }

  const { capabilities: rawCapabilities, modelID, settings, ...rest } = entry;
  const capabilities = isObject(rawCapabilities) ? rawCapabilities : null;
  const input = Array.isArray(capabilities?.input) ? capabilities.input : ["text"];
  const output = Array.isArray(capabilities?.output) ? capabilities.output : ["text"];
  return {
    ...rest,
    ...(typeof modelID === "string" && rest.id === undefined ? { id: modelID } : null),
    ...(isObject(settings) && rest.options === undefined ? { options: settings } : null),
    tool_call: capabilities ? capabilities.tools !== false : entry.tool_call !== false,
    attachment: input.some((modality) => modality !== "text"),
    modalities: { input, output },
    reasoning: entry.reasoning === true,
  };
};

/**
 * Build the `afrouter` provider entry in `format`, carrying over anything the
 * user added (name, env, headers, body, models) and the opposite shape's
 * credential block.
 */
export const buildProviderEntry = (format, source = {}) => {
  const safe = isObject(source) ? source : {};
  const { npm, options, package: pkg, settings, models, ...rest } = safe;
  const options_ = isObject(options) ? options : {};
  const settings_ = isObject(settings) ? settings : {};
  const entry =
    format === "v2"
      ? {
          package: typeof pkg === "string" && pkg ? pkg : V2_PACKAGE,
          ...rest,
          settings: { ...options_, ...settings_ },
        }
      : {
          npm: typeof npm === "string" && npm ? npm : V1_PACKAGE,
          ...rest,
          options: { ...settings_, ...options_ },
        };
  entry.models = isObject(models) ? models : {};
  return entry;
};

export const providerCredentialKey = (format) => (format === "v2" ? "settings" : "options");
export const providerBaseUrl = (provider) =>
  provider?.settings?.baseURL || provider?.options?.baseURL || null;

export const buildSubagentEntry = (model) => ({
  description: SUBAGENT_DESCRIPTION,
  mode: "subagent",
  model: `${AFROUTER_PROVIDER_ID}/${model}`,
});

/** True when the agent entry is one AFRouter wrote, never the user's own. */
export const isOwnedSubagent = (entry) =>
  typeof entry?.model === "string" && entry.model.startsWith(`${AFROUTER_PROVIDER_ID}/`);

/** Drop AFRouter's subagent override from one map, cleaning up an emptied map. */
export const removeOwnedSubagent = (config, mapKey) => {
  const map = config?.[mapKey];
  if (!isObject(map) || !isOwnedSubagent(map[SUBAGENT_NAME])) return;
  delete map[SUBAGENT_NAME];
  if (Object.keys(map).length === 0) delete config[mapKey];
};

/**
 * Find the `afrouter` provider in either shape. Returns the map key it lives
 * under so callers can write back to the same place.
 */
export const readAFRouterProvider = (config) => {
  for (const key of ["providers", "provider"]) {
    const entry = config?.[key]?.[AFROUTER_PROVIDER_ID];
    if (isObject(entry)) return { mapKey: key, format: key === "providers" ? "v2" : "v1", entry };
  }
  return { mapKey: null, format: null, entry: null };
};

/** The AFRouter subagent model id (without the `afrouter/` prefix), or "". */
export const readSubagentModel = (config) => {
  for (const key of ["agents", "agent"]) {
    const entry = config?.[key]?.[SUBAGENT_NAME];
    if (isObject(entry) && typeof entry.model === "string" && entry.model.startsWith(`${AFROUTER_PROVIDER_ID}/`)) {
      return entry.model.slice(AFROUTER_PROVIDER_ID.length + 1);
    }
  }
  return "";
};

/**
 * Which shape an existing config is written in, or null when it is empty or
 * carries both (V1 and V2 members may coexist at the top level).
 */
export const detectConfigFormat = (config) => {
  if (!isObject(config)) return null;
  const v1 = isObject(config.provider) || isObject(config.agent);
  const v2 = isObject(config.providers) || isObject(config.agents);
  if (v2 && !v1) return "v2";
  if (v1 && !v2) return "v1";
  return null;
};

/** Major version from `opencode --version` output, or null when unparseable. */
export const parseVersionMajor = (raw) => {
  const match = String(raw ?? "").match(/(\d+)\.\d+/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
};

/** OpenCode 2 uses the native shape; V1 is what older clients read. */
export const formatForVersion = (raw) => {
  const major = parseVersionMajor(raw);
  return major === null ? null : major >= 2 ? "v2" : "v1";
};

/**
 * Shape to write: an explicit choice wins, then the config's own shape, then the
 * installed CLI version, then the V1 default (which V2 still reads).
 */
export const resolveFormat = ({ requested, config, version } = {}) => {
  if (isFormat(requested)) return { format: requested, source: "manual" };
  const detected = detectConfigFormat(config);
  if (detected) return { format: detected, source: "config" };
  const fromVersion = formatForVersion(version);
  return fromVersion ? { format: fromVersion, source: "version" } : { format: DEFAULT_FORMAT, source: "default" };
};
