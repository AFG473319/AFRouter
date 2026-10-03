import { KILO_API_BASE_URL, KILO_CATALOG_URL, KILO_OPENROUTER_CHAT_URL } from "../../config/kiloCatalog.js";

export default {
  id: "kilocode",
  priority: 70,
  alias: "kc",
  uiAlias: "kc",
  display: {
    name: "Kilo Code",
    icon: "code",
    color: "#FF6B35",
    textIcon: "KC",
    website: "https://kilocode.ai",
    notice: {
      signupUrl: "https://kilocode.ai",
    },
  },
  category: "oauth",
  transport: {
    baseUrl: KILO_OPENROUTER_CHAT_URL,
    headers: {},
    auth: {
      combined: true,
      header: "Authorization",
      scheme: "bearer",
      hooks: [
        "kilocodeOrg",
      ],
    },
  },
  // Seed snapshot, verified against the live catalog (KILO_CATALOG_URL).
  // Kilo proxies an OpenRouter-shaped catalog and rejects an unlisted id with
  // "The requested model ... does not exist", so the dated ids it used to carry
  // (claude-*-4-20250514, deepseek-reasoner) are gone — they only ever produced
  // rows that could not route. Anything else in the 401-model catalog arrives via
  // modelsFetcher + passthroughModels; this list is the offline/fallback view.
  // `isFree` mirrors the catalog's own flag rather than being inferred from the
  // id: kilo-auto/free is free without carrying a `:free` suffix.
  models: [
    { id: "kilo-auto/free", name: "Kilo Auto Free", isFree: true },
    { id: "kilo-auto/frontier", name: "Kilo Auto Frontier" },
    { id: "kilo-auto/balanced", name: "Kilo Auto Balanced" },
    { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6" },
    { id: "anthropic/claude-opus-4.7", name: "Claude Opus 4.7" },
    { id: "openai/gpt-5.4", name: "GPT-5.4" },
    { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    { id: "openai/gpt-4.1", name: "GPT-4.1" },
    { id: "openai/o3", name: "o3" },
    { id: "deepseek/deepseek-chat", name: "DeepSeek Chat" },
  ],
  // Kilo Code proxies the OpenRouter catalog (401 models at time of writing),
  // so the hardcoded list above is only a fallback. Surfacing the full catalog
  // requires a fetcher + passthroughModels, matching how openrouter.js is set up.
  // Without these, only the seeded models appear in the combo model picker,
  // hiding dynamic models like cohere/north-mini-code:free and poolside/laguna-s.2:free.
  //
  // modelSpecs is what fills in context window / modalities / max output when a
  // model from that catalog is saved. Without it the lookup bails out before
  // fetching, the model is stored with no caps, and every Kilo Code model then
  // falls back to DEFAULT_CAPABILITIES.contextWindow (200K) — including ones
  // whose real window is 1M. The catalog is public and already OpenRouter-shaped
  // (data[] + architecture.input_modalities + top_provider.max_completion_tokens
  // + context_length + supported_parameters + opencode.variants), so it needs no
  // credentials.
  //
  // One fetcher, one list, ONE url: `url` is stated explicitly rather than left
  // to customSpecs.js falling back to modelsFetcher.url, so the spec lookup and
  // the suggestion list can never point at different catalogs.
  //
  // "kilo-free" filters on the catalog's own isFree flag, so it keeps the
  // genuinely free ids under 200k context that a $0+200k heuristic drops.
  // kilo-gateway.js reads the same catalog through the unfiltered view.
  modelSpecs: { format: "openrouter", url: KILO_CATALOG_URL, auth: "none" },
  modelsFetcher: { url: KILO_CATALOG_URL, type: "kilo-free" },
  passthroughModels: true,
  oauth: {
    apiBaseUrl: KILO_API_BASE_URL,
    initiateUrl: "https://api.kilo.ai/api/device-auth/codes",
    pollUrlBase: "https://api.kilo.ai/api/device-auth/codes",
  },
};
