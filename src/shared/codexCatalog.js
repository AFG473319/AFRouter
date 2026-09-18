export function normalizeCodexBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) endpoint without credentials, query parameters, or fragments");
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/v1") ? pathname : `${pathname}/v1`;
  return url.toString().replace(/\/$/, "");
}

export function buildCodexCatalog(models, specs = {}) {
  return {
    models: models.map((id, index) => {
      const spec = specs[id] || {};
      const contextWindow = Number.isSafeInteger(spec.contextWindow) && spec.contextWindow > 0 ? spec.contextWindow : 128000;
      const efforts = [...new Set((Array.isArray(spec.reasoningEfforts) ? spec.reasoningEfforts : []).filter((effort) => ["none", "minimal", "low", "medium", "high", "xhigh"].includes(effort)))];
      if (efforts.length === 0) efforts.push(spec.reasoning === true ? "medium" : "none");
      const defaultEffort = efforts.includes("medium") ? "medium" : efforts[0];
      return {
        slug: id,
        display_name: `AFRouter / ${spec.name || id}`,
        description: `Routed through AFRouter: ${id}`,
        visibility: "list",
        supported_in_api: true,
        priority: index,
        context_window: contextWindow,
        max_context_window: contextWindow,
        auto_compact_token_limit: Math.floor(contextWindow * 0.9),
        effective_context_window_percent: 95,
        input_modalities: spec.vision === true ? ["text", "image"] : ["text"],
        default_reasoning_level: defaultEffort,
        supported_reasoning_levels: efforts.map((effort) => ({ effort, description: effort })),
        supports_reasoning_summaries: false,
        supports_parallel_tool_calls: false,
        support_verbosity: false,
        supports_search_tool: false,
        shell_type: "shell_command",
        apply_patch_tool_type: null,
        experimental_supported_tools: [],
        additional_speed_tiers: [],
        use_responses_lite: false,
        truncation_policy: { mode: "tokens", limit: Math.min(10000, Math.floor(contextWindow / 10)) },
        base_instructions: "You are a coding assistant. Follow the user's instructions and repository guidance. Use available tools to inspect, edit, and verify code. Report results accurately.",
      };
    }),
  };
}

export function codexProvider(baseUrl, apiKey) {
  const token = String(apiKey ?? "").trim();
  if (!token) throw new Error("An API key is required for Codex");
  return {
    name: "AFRouter",
    base_url: normalizeCodexBaseUrl(baseUrl),
    wire_api: "responses",
    supports_websockets: false,
    http_headers: { Authorization: `Bearer ${token}` },
  };
}

const tomlString = (value) => JSON.stringify(String(value)).replace(/\x7f/g, "\\u007f");

export function stringifyCodexConfig({ model, catalogPath, provider, subagentModel }) {
  if (!provider?.base_url || !provider.http_headers?.Authorization) throw new Error("A complete AFRouter provider configuration is required");
  return [
    `model = ${tomlString(model)}`,
    'model_provider = "afrouter"',
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    "[model_providers.afrouter]",
    `name = ${tomlString(provider.name)}`,
    `base_url = ${tomlString(provider.base_url)}`,
    'wire_api = "responses"',
    "supports_websockets = false",
    "",
    "[model_providers.afrouter.http_headers]",
    `Authorization = ${tomlString(provider.http_headers.Authorization)}`,
    ...(subagentModel ? ["", "[agents]", `default_subagent_model = ${tomlString(subagentModel)}`] : []),
    "",
  ].join("\n");
}
