import { KILO_CATALOG_URL, KILO_GATEWAY_CHAT_URL } from "../../config/kiloCatalog.js";

export default {
  id: "kilo-gateway",
  alias: "kgw",
  aliases: [
    "kilo-gateway",
    "kilogateway",
  ],
  uiAlias: "kgw",
  category: "freeTier",
  display: {
    name: "Kilo Gateway",
    icon: "login",
    color: "#8B5CF6",
    textIcon: "KG",
    website: "https://kilo.ai",
    notice: {
      apiKeyUrl: "https://kilo.ai/dashboard?tab=apiKeys",
    },
  },
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: KILO_GATEWAY_CHAT_URL,
    // Validating a key against the same catalog the specs come from means one
    // request proves both that the credential works and that the gateway serves
    // the models the dashboard will offer.
    validateUrl: KILO_CATALOG_URL,
  },
  // The live catalog. Kilo publishes 401 models here with real specs —
  // architecture.input_modalities, context_length /
  // top_provider.max_completion_tokens, supported_parameters, isFree — plus a
  // per-model reasoning level map under opencode.variants. Without a fetcher this
  // provider served a 6-model seed and its levels came from a `*nemotron*` name
  // pattern by accident; the catalog is public and needs no credentials.
  //
  // `kilo-gateway` is the non-free surface (kilo-auto/*, paid ids), so it uses
  // the UNFILTERED catalog view and relies on each row's own `isFree` flag to say
  // which of its ~400 models actually cost nothing — filtering on `isFree` here
  // would suggest nothing, and dropping the flag is what made the dashboard read
  // every model as free. `kilocode` keeps the isFree view over the same catalog.
  //
  // `url` is stated explicitly on both modelSpecs and modelsFetcher so the spec
  // lookup and the suggestion list can never point at different catalogs.
  modelSpecs: { format: "openrouter", url: KILO_CATALOG_URL, auth: "none" },
  modelsFetcher: { url: KILO_CATALOG_URL, type: "kilo-gateway" },
  passthroughModels: true,
  // Seed snapshot, verified against the live catalog (KILO_CATALOG_URL).
  // Kilo rejects an unlisted id with "The requested model ... does not exist",
  // so the `:free` suffix that used to sit on kat-coder is gone: only the paid
  // id exists. Retained as the offline/fallback view when the fetcher is
  // unreachable; contextLength is display metadata (routing caps resolve
  // through the capabilities tables). `isFree` is the catalog's own flag —
  // kilo-auto/free carries it without a `:free` suffix on its id.
  models: [
    { id: "kilo-auto/free", name: "Kilo Auto Free", contextLength: 256000, isFree: true },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B (Free)", contextLength: 262144, isFree: true },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (Free)", contextLength: 1000000, isFree: true },
    { id: "kwaipilot/kat-coder-pro-v2.5", name: "Kat Coder Pro v2.5", contextLength: 262144 },
    { id: "kilo-auto/frontier", name: "Kilo Auto Frontier", contextLength: 1000000 },
    { id: "kilo-auto/balanced", name: "Kilo Auto Balanced", contextLength: 1000000 },
  ],
};