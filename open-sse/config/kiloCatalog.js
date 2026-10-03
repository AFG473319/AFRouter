// Kilo's single authoritative model catalog.
//
// Kilo Code (OAuth → /api/openrouter/chat/completions) and Kilo Gateway (API
// key → /api/gateway/chat/completions) are two transport surfaces over ONE
// catalog. This is the documented, versioned path, and per model it publishes
// everything a model row needs — nothing has to be guessed from the id:
//
//   architecture.input_modalities / output_modalities  -> modalities
//   context_length                                      -> context window
//   top_provider.max_completion_tokens                  -> max output
//   supported_parameters                                -> tools / reasoning
//   isFree                                              -> Kilo's own free flag
//   opencode.variants                                   -> reasoning level map
//
// It is public: no credentials are needed for any read of it, and
// src/lib/modelCatalog/customSpecs.js refuses redirects so a credential could
// never travel to another host.
//
// ONE constant, every call site. Both registries read it through their
// `modelsFetcher` (the dashboard's suggestion list) and their `modelSpecs` (the
// specs persisted when a model is saved), kilo-gateway validates a key against
// it, and src/app/api/providers/suggested-models/filters.js reads the same two
// views. Kilo also answers on the unversioned /api/gateway/models and
// /api/openrouter/models aliases with byte-identical payloads, but those are
// not the documented path — keeping one constant is what stops the two
// surfaces from drifting onto different catalogs.

export const KILO_API_BASE_URL = "https://api.kilo.ai";
export const KILO_CATALOG_URL = "https://api.kilo.ai/api/gateway/v1/models";
export const KILO_GATEWAY_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
export const KILO_OPENROUTER_CHAT_URL = "https://api.kilo.ai/api/openrouter/chat/completions";