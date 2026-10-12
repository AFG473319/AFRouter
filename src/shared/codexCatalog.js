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
      const isReasoning = spec.reasoning === true;
      // Codex ReasoningEffort is an open string (codex-rs/protocol/src/openai_models.rs):
      // none|minimal|low|medium|high|xhigh|max|ultra|persistent are named variants and
      // anything else falls through to Custom(String). Pass the resolved ladder through
      // verbatim rather than re-whitelisting it.
      const efforts = [...new Set((Array.isArray(spec.reasoningEfforts) ? spec.reasoningEfforts : []).filter((effort) => typeof effort === "string" && effort.length > 0))];
      const ladder = isReasoning ? efforts.map((effort) => ({ effort, description: effort })) : [];
      // No invented "medium" for a reasoning model with no ladder, and no effort at all
      // for a non-reasoning model: the catalog key is the ONLY source of the wire
      // reasoning.effort, and omitting it makes Codex drop the whole `reasoning` object.
      // The default must stay inside `ladder` — Codex reads the selectable set from
      // `supported_reasoning_levels`, and an off-ladder default would be replaced by the
      // ladder's middle entry anyway (core/src/session/turn_context.rs).
      const specDefault = isReasoning ? (spec.defaultReasoningEffort || spec.defaultLevel) : undefined;
      const defaultEffort = specDefault || (isReasoning && efforts.includes("medium") ? "medium" : undefined);
      const entry = {
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
        // REQUIRED on every entry: codex-rs protocol ModelInfo declares
        // `supported_reasoning_levels: Vec<ReasoningEffortPreset>` with no
        // #[serde(default)], so a missing key fails the whole catalog at parse time
        // ("missing field `supported_reasoning_levels`"). Always emit the array; it is
        // empty for a non-reasoning model or a reasoning model with no declared ladder,
        // which is exactly the shape Codex's own catalog fallback sends. An empty ladder
        // is also the wire-safe choice: with no levels Codex enables no reasoning effort
        // picker and falls back to `default_reasoning_level`, so no off-ladder effort is
        // ever forwarded upstream.
        supported_reasoning_levels: ladder,
        // Real ModelInfo gates. `supports_reasoning_summaries` is read by no Codex
        // release and `supports_parallel_tool_calls` is a request-level field, not a
        // catalog one; the actual summary parameter defaults to true.
        supports_reasoning_summary_parameter: isReasoning && spec.reasoningSummary !== false,
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
      if (defaultEffort) entry.default_reasoning_level = defaultEffort;
      return entry;
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
