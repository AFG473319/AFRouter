# v0.5.96 (2026-10-10)

## Fixes
- **Every CLI tool integration now writes a config the tool actually loads.** An audit compared each tool's docs and source against our writers and found the writers were configuring files the tools never read. Fixed: Kilo writes `provider.afrouter` + `model` into `kilo.jsonc` (its `auth.json` schema drops anything but oauth/api/wellknown; the VS Code keys never existed); Cline writes `settings/providers.json` with provider `openai-compatible` keeping `/v1` (`globalState.json` is the legacy path); Smelt owns a `provider.register("afrouter", …)` block in `~/.config/smelt/init.lua` (`~/.smelt/config.json` is never loaded; the key is export-only via `AFROUTER_API_KEY`); CodeWhale writes `[providers.afrouter]` + root `provider` (`[openai]` is unread); Forge writes `<base>/.forge.toml` (`$FORGE_CONFIG` → `~/forge` → `~/.forge`) with `[[providers]]` + `[session]`; jcode's env file moved to the platform config dir with per-model `[[providers.afrouter.models]]` specs and `[provider]` defaults; Hermes honours `HERMES_HOME` (`%LOCALAPPDATA%\hermes` on native Windows); Grok Build and DeepSeek TUI Apply 500s fixed; Codex profiles point at the `afrouter` provider; Zed uses `~/.config/zed` on macOS.
- **Shared groundwork for all writers.** `src/lib/cliConfigIO.js` parses JSON/JSONC/JSON5/TOML/YAML and aborts with 409 instead of wiping user files, with backup + atomic writes (0600 for secrets); `src/lib/cliModelSpec.js` resolves per-model specs (context, output, vision, reasoning ladder) from the shared resolver so no writer invents limits; `src/lib/cliPaths.js` resolves per-OS config dirs and env overrides.

Tests: `tests/unit/cli-kilo-settings-route.test.js`, `tests/unit/cli-cline-settings-route.test.js` and `tests/unit/cli-config-tools.test.js` (new — fresh install, commented-file preservation, 409 on parse errors, idempotent re-Apply, Reset scoping for kilo/cline/smelt/codewhale/forge/jcode).

# v0.5.95 (2026-10-09)

## Fixes
- **OpenCode dropped the whole AFRouter provider.** OpenCode V2 catalogs per-model variants as an array of `{ id, settings: { reasoningEffort } }`, but the writer emitted V1's named-object map with a top-level `reasoningEffort`. OpenCode logged the entry as malformed and skipped the provider, so no AFRouter models appeared in its picker. V2 output now uses the array form; V1 output is unchanged.

# v0.5.94 (2026-10-09)

## Features
- **Hermes Agent now takes many AFRouter models, not one.** Hermes' `providers:` dict holds *named* custom endpoints, and each entry's `models:` mapping serves several models; slots then point at the entry by reference (`provider: custom:afrouter`) instead of re-declaring `base_url` per slot. AFRouter previously wrote an anonymous `provider: custom` with an inline `base_url` into every slot — one endpoint per model, so `hermes model` and `/model` could never offer a second AFRouter model. Dashboard → CLI Tools → Hermes now has a **Models** list (add / remove, one chip per model) like OpenCode, DSH, Pi, OMP and ZCode, and the Default Model plus every role slot is picked from it.
- **Per-model specs are imported from the official docs' schema.** Each model under `providers.afrouter.models.<id>` carries its resolved `context_length` (2nd link of Hermes' documented context-resolution chain, after the `model.context_length` pin) and `supports_vision` (written only when the model takes images). Specs resolve self-fetched `/v1/models` (4s, alias-tolerant) → static registry → conservative 128k fallback flagged `unverified`, never invented. `discover_models: false` makes that mapping the picker's catalog, so `hermes model` works even while the gateway is down.
- **The role list is now the real one.** Hermes' auxiliary task ids come from `hermes_cli/config_defaults.py`: the card offers all 18 documented slots (`vision`, `compression`, `skills_hub`, `approval`, `review`, `mcp`, `title_generation`, `memory_query_rewrite`, `tts_audio_tags`, `triage_specifier`, `kanban_decomposer`, `profile_describer`, `goal_judge`, `curator`, `monitor`, `background_review`, `moa_reference`, `moa_aggregator`) plus the top-level `delegation` block. **Web Extract is gone** — `auxiliary.web_extract`/`session_search` no longer use an aux LLM and Hermes ignores leftover blocks, so the old slot looked configured and did nothing.
- **Key handling follows the documented pattern.** The entry declares `key_env: AFROUTER_API_KEY` and the key is written to `~/.hermes/.env`, so `config.yaml` carries no secret and stays shareable. A user's own `OPENAI_API_KEY` is never claimed or removed.

## Fixes
- **Reset could not clear a single model, and left slots dangling.** `DELETE ?model=<id>` now removes exactly one model from `providers.afrouter` and clears any slot pinned to it; a full Reset drops the provider entry, every slot pointing at us, and our `.env` line. Removing a model we never wrote is a no-op instead of a silent full reset.
- **An unreadable `config.yaml` used to be overwritten.** The file is now parsed with a real YAML parser (it has a nested `providers:` mapping, which line-based rewriting cannot do safely); a document that is not a mapping, or does not parse, is reported as `corrupt` and answered with **409** — nothing is written until the user fixes or restores it. Writes are backup + temp-file + atomic rename with EPERM/EACCES retries.
- **Legacy inline endpoints could silently override the new provider.** `delegation.base_url` takes precedence over `provider`, so a stale inline endpoint left by an older build is stripped when a slot is rewritten.
- **The Reset button was permanently disabled.** The card read `hermesStatus.hasAFRouter` while the route returned `has9Router`.
- **The model picker no longer buries enabled models under hundreds you never enabled.** Cline's `/models` answers with its entire resale catalog (400+ ids), which the picker rendered verbatim as rows. `scopeLiveCatalogModels()` (`src/shared/utils/liveCatalogModels.js`) keeps the row set to what the user actually enabled — the curated registry plus that provider's custom models and aliases — while a live row may only rename or annotate a row that already exists, never invent one; a provider with no curated registry at all (Zed) still passes its live catalog through unchanged.

Tests: `tests/unit/hermes-settings.test.js` (rewritten — 19 cases covering the multi-model `providers:` shape, slot references without endpoint duplication, the documented per-model key set, the fresh-install `model: ""` sentinel, additive idempotent re-Apply, legacy inline-endpoint upgrade, role un-setting, dead-slot refusal, `.env`-only key handling, corrupt-file 409, DELETE scoping) and `tests/unit/cli-model-snapshot.test.js` (Hermes entries joined the shared spec snapshot) and `tests/unit/model-select-live-catalog-scope.test.js` (new — live catalog as metadata, enabled-set rows, alias scoping, Zed pass-through). Verified against the official docs at hermes-agent.nousresearch.com (configuring-models, integrations/providers, user-guide/configuration) and `hermes_cli/config_defaults.py` — field-by-field citations are in `CLI_AUDIT.md` and `src/lib/hermesConfig.js`.

# v0.5.93 (2026-10-09)

## Features
- **One reasoning-ladder resolver for every provider.** `resolveReasoningLevels()` in `open-sse/providers/capabilities.js` is now the single source of truth (exact Codex entry → PATTERN_THINKING override → discovered models.dev ladder → format default → drop `none` when `thinkingCanDisable === false` → Kiro null case). `getCapabilitiesForModel` emits the resolved `reasoningLevels` for every reasoning model and omits it for toggle-only/unknown effort control instead of inventing levels; `getThinkingLevels()` is a thin wrapper and `resolveModelSpec()` (`open-sse/providers/modelSpecs.js`) projects the full spec (levels, canDisable, defaultLevel, limits, modalities, tools). `/v1/models` backfills static, live, custom-model and alias paths; Codex/ZCode prefer the shared resolver; combos keep the union (dispatcher re-encodes via coerceLevels). `thinkingCanDisable: false` added to Codex gpt-6*/gpt-5.6* and Kiro GPT-5.6 caps (backend 400s on `reasoning_effort: "none"`, #4031).
- **Every CLI tool gets resolved specs.** Pi writes per-model `thinkingLevelMap` (identity values, null hides; `off`→`"none"` or hidden when the model cannot disable); OMP writes `thinking: {mode: effort, efforts, defaultLevel}`; OpenCode writes per-level `variants` (`reasoningEffort`, v1+v2); DSH keeps its display→wire map fed by the resolver; Crush writes resolved `context_window` per model with a multi-model additive list (was one hardcoded 128000); Grok Build writes resolved limits per `[model.<slot>]`; Hermes writes explicit `api_mode: "chat_completions"`, handles the fresh-install `model: ""` sentinel, and backs up + atomically writes `config.yaml` (switch models via `hermes model`/`/model`/re-Apply — single main slot is Hermes' design). Tools whose schemas have no per-model effort field (MimoCode, Zed, Droid, Copilot, Claude, Cline, CodeWhale, Forge, JCode, OpenClaw, Smelt, WorkBuddy, DeepSeek TUI, Cowork, Devin) write limits/modalities where allowed and invent no keys — see CLI_AUDIT.md table.

## Fixes
- **Kilo's pdf capability was stripped from a quarter of its catalog.** Kilo spells document input `pdf` on some models and `file` on others — 25 of 401 live models use only `pdf` — so mapping just one silently dropped the pdf flag. `customSpecs.js` now sets `caps.pdf = input.includes("pdf") || input.includes("file")`, keeping vision/audioInput/videoInput per modality as before.
- **Kilo's runtime specs keep flowing through models.dev like every other provider.** The Kilo-shaped conversion and second fetch added alongside the official-catalog lookup were dropped again: Kilo's daily-sync rows go through the same models.dev entry (`kilocode`/`kilo-gateway` → `kilo` alias) every other provider uses, while Kilo's own catalog stays authoritative where Kilo-specific data is needed — save-time spec lookup and the suggestion lists, which carry `isFree`/`contextLength`/`reasoningEfforts` models.dev does not publish. Discovered reasoning ladders keep working via the uniform path (models.dev publishes `reasoning_options` for 271/397 kilo ids).
- **ZCode's tool page is no longer "Coming soon".** `toolId === "zcode"` fell through to `DefaultToolCard`, so Dashboard → CLI Tools → ZCode showed the generic placeholder instead of the card with its per-model level chips and manual-override notice. `ZCodeToolCard` is exported from `components/index.js` and `ToolDetailClient` now matches `case "zcode"`.

Tests: `tests/unit/model-spec-coverage.test.js` (new — every registry provider/model: ladders deduped/ordered, overrides win, no `none` when canDisable is false, finite limits, per-provider table), `tests/unit/thinking-ladder-wire.test.js` (new — every ladder value through `applyFormat`), `tests/unit/cli-model-snapshot.test.js` (new — fixed model set across pi/omp/dsh/opencode/mimocode/zcode/grok snapshots), `tests/unit/crush-settings.test.js` + `tests/unit/hermes-settings.test.js` (new — route integration incl. sentinel, idempotency, backup).

# v0.5.92 (2026-10-08)

## Features
- **ZCode now receives per-model reasoning levels.** Applying models from Dashboard → CLI Tools → ZCode updated `~/.zcode/v2/config.json` only, and ZCode 3.14+'s one-time legacy import of that file copies just name/apiKey/baseURL/kind/model ids/contextWindow — it **drops `variants`** — so every applied model showed up in ZCode with no per-model thinking-effort levels (the picker fell back to ZCode's built-in ladder, and toggle models lost their on/off switch). Apply now follows the config.json write with an upsert into ZCode's **Personal layer** `~/.zcode/v2/provider_config.json` (ZCode 3.14+; `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_DATA_BASE_DIR` override the location), mirroring ZCode's own import shape: the same UUID `providerId` as the config.json entry, `providerName` "AFRouter", group `standard-personal`, refreshed `baseUrl`/`apiKey`, new ids appended to `personalModelIds`/`modelOrder`/`providerOrder`, and a `providerModelRules` entry per model carrying `contextWindow`, `inputFormat`, `maxOutputTokens.max` and `reasoningLevel.values`.
- **Level mapping is pure and order-preserving** (`src/lib/zcodeReasoningLevels.js`): AFRouter's `none` is dropped, `disabled` is prepended when the model can disable thinking, the zai on/off pair `["none","thinking"]` becomes `["disabled","enabled"]`, AFRouter's already lowest→highest order is kept, duplicates removed, strongest last. Non-reasoning models get no `reasoningLevel` rule at all. The legacy config.json `reasoning.variants` block keeps AFRouter's own vocabulary — only the Personal layer uses ZCode's.
- **Manual settings always win.** Models that already have a `manualProviderModelRules` entry in the Personal file are skipped and reported as manual overrides (409-free, listed in the API response and the card); the user's own per-model rules are never read or written, and survive Reset even when our provider rule is removed.
- **Safe file handling.** The writer validates the full document first and aborts on any issue (corrupt or wrong `schemaVersion` → the route answers 409 **before** anything is written), takes ZCode's own directory lock (`<file>.lock` + `owner-<token>.json`, ~8s max wait, stale/ownerless reclamation) so a concurrent ZCode save is never clobbered, backs up the existing file with a timestamp, and writes via temp-file + rename with EPERM/EBUSY/EACCES retries. Other providers and rules are preserved byte-for-byte, and no AFRouter marker keys are written into this file. Reset (DELETE) removes only ledger-owned models from `personalModelIds`/`modelOrder`/`providerModelRules`, dropping the provider rule and `providerOrder` entry only when no models remain. `GET` reports `personalConfig` (present, path, `levelsByModel`, `manualModels`), and the card renders per-model level chips plus a manual-override notice. Restart ZCode after Apply to load the new layer.

Tests: `tests/unit/zcode-provider-config.test.js` (new — mapper, writer, removal, status reader, route integration: fresh install, legacy-file-only, ZCode-made file with other providers preserved, GPT/Claude/DeepSeek/on-off/non-reasoning ladders, manual-override skip + report, idempotent re-apply, backup, corrupt refusal, lock timeout, reclamation, DELETE scoping) and `tests/unit/zcode-settings.test.js` (existing, unchanged) — both in the reasoning-effort CI gate. ZCode's schema (`provider-config-file-codec`, `rule-data-schema`, `provider-data-schema`, `model-config`, `model-selection-config`) was re-verified against zai-org/ZCode master; nothing changed.

# Upstream sync: 9Router v0.5.95 (2026-10-01)

## Features
- **Providers**: add Meta Muse provider with OAuth login and model catalog; add v1m System One provider
- **GLM**: add Z.ai OAuth login to GLM Coding (dual-auth)
- **Codex**: add GPT-6.1 Sol; expose 1M context variants for GPT-6 and GPT-5.6; add gpt-daybreak/reserve models and route bare `gpt-5.x`/`gpt-6.x` slugs to codex
- **Claude**: add Claude Sonnet 5.5 (plus `claude-opus-5.5` models in the Kiro registry)
- **CLI**: add `connect` command for remote 9Router servers
- **Providers**: per-provider custom header overrides from the registry
- **Agnes**: seed the 2.5/3.0 model ids in the registry
- **Usage**: sync `?provider=` URL param with provider filter for bookmarkable deep links (#4395)
- **Dashboard**: drop NEW badges in sidebar, mark 9Remote as HOT

## Fixes
- **Claude**: preserve intentional prefill from non-messages[] source formats; keep a trailing user turn so cleanup never yields assistant prefill
- **Claude**: cache a tool loop's final tool results with the 4th breakpoint
- **Claude**: resolve Sonnet 5.x to adaptive thinking so no forged thinking placeholders are sent; inject unsigned thinking placeholders for opencode-go DeepSeek `/messages` (#4436)
- **Thinking**: add `xhigh` to claude-adaptive thinking levels
- **Claude**: keep a user turn whose only block is `container_upload`
- **Capabilities**: publish real GPT-6/GPT-5.4+ context windows and combo token limits
- **Responses**: wait for real usage before emitting `response.completed`, bounded by a 3s watchdog
- **Codex**: stop refresh-token reuse that logs accounts out on auto-ping; preserve hosted web search on GPT-6 Sol/Luna; remove ghost models
- **Grok CLI**: send Grok CLI 1.0.44 so proxy stops returning HTTP 426
- **Proxy**: auto-fallback to insecure TLS on self-signed cert errors; hold strictProxy when no proxy resolves
- **Translator**: strip `errorMessage` and other non-standard schema keywords from Gemini tool schemas; dedupe same-name tools for DeepSeek models (#3333)
- **Codebuddy**: parse the 6004 rate limit error and extract `resetsAtMs`; forward `recurring` for codebuddy-intl quota packs (#4422)
- **CLI Tools**: replace `sk_9router` placeholder with first active dashboard API key
- **Dashboard**: exclude hidden providers from usage stats provider list
- **Capabilities**: add deepseek-v4-1-flash vision alias; add zed to live catalog providers

# v0.5.91 (2026-10-02)

## Fixes
- **Kilo Gateway / Kilo Code specs now come from the official catalog, and the catalog was never consulted at all.** Three separate defects, one symptom (every Kilo model falling back to the 200K/64K floor):
  - **`POST /api/models/custom` had stopped calling `lookupCustomModelSpecs`.** The v0.5.91 upstream merge replaced the route wholesale and dropped the catalog enrichment line, leaving the module as dead code — so a model saved from Kilo Code, OpenRouter, Nous or NVIDIA stored no capabilities at all. Restored: the provider's declared catalog wins over the caller's flags (the Add-Model form always sends every checkbox, so an unticked "vision" is a form default, not a measurement), and a field the catalog does not publish keeps what was sent. Specs now resolve for every provider with a `modelSpecs` source, not just Kilo.
  - **The catalog URL was the unversioned alias.** Both registries read `api.kilo.ai/api/gateway/models`; they now read the documented `https://api.kilo.ai/api/gateway/v1/models` from one shared constant (`open-sse/config/kiloCatalog.js`), stated explicitly on `modelSpecs` as well as `modelsFetcher` so a future fetcher change cannot silently repoint the spec lookup somewhere else. kilo-gateway validates a credential against that same catalog, so one request now proves both that the key works and that the gateway serves the models the dashboard will offer.
  - **Kilo's reasoning vocabulary was dropped twice.** `normalizeCatalogSpecs` ignored `opencode.variants`, so a saved model kept a reasoning boolean with no levels and the picker offered nothing; the variant map is now read through `kiloEffortValues`, which keeps only wire values (Kilo's variant *keys* — `instant`, `thinking` — are display labels the router cannot send). The `kilo-free`/`kilo-gateway` suggestion filter carried the whole `{levels, canDisable}` object into a `reasoningEfforts` field that is a plain string array everywhere else, so it was unusable; both carry the canonical wire values now.
- **Disable All skipped every model added by hand.** The provider page recomputed "what is available" from the registry seed alone, but the "Import from /models" button, the Suggested chips and Add Model all save as *custom* models — so Disable All reported disabling everything while those models stayed enabled, and they had no way to be restored either. The page now renders from `assembleProviderModelRows` (the helper that already existed and was already tested, but nothing called): one id appears in exactly one section, Disable-All covers exactly the ids rendered as available — built-ins, custom models and legacy aliases together — and a disabled model is always restorable. This also puts an end to the duplicate-chip regression from the Kilo dashboard fix below: the page had been re-deriving all four sources locally, and a `kiloFreeModels` fetch was still pointing at the `/api/providers/kilo/free-models` route that fix deleted, so it always returned nothing.
- **Kilo Gateway reported every model as free.** Its suggestion filter is deliberately *unfiltered* (kilo-auto/\* plus the paid ids are that lane's point) but the page captioned that list "Suggested free models (≥200k context)" regardless, so ~400 paid ids were announced as free. `isFree` is now carried through the filters and rendered as a FREE badge — on the seeded rows and the suggestion chips alike — and the caption reads "Suggested models" unless the filter really is free-only. The flag beats the id shape: `kilo-auto/free` and `stealth/space-bunny-alpha` cost nothing with no `:free` suffix. Two more causes: `providers/[id]/ModelRow` declared an `isFree` prop and never rendered it (the provider page had no FREE badge at all), and the client suggestion cache was keyed by URL alone — the two Kilo surfaces share one URL but request different types, so whichever page loaded first served its list to the other for 10 minutes. The cache keys on `(url, type)`.
- **Reasoning discovery reached almost no model, so every picker showed the same fallback ladder** (`off/low/medium/high/max`) and models that do reason were labelled "does not support reasoning". Three independent causes, all fixed:
  - **The catalog was keyed by registry id but read by dashboard alias.** `/api/models`, the no-connections `/v1/models` path and every CLI-tool route hand the reader `oc`, `cl`, `kc`… while the file is written under `opencode`, `cline`, `kilocode`. The lookup missed silently and the caller fell back to its hardcoded defaults — discovery "worked" and nobody could see it. `open-sse/providers/catalogOverride.js` now resolves alias → registry id once, for all three getters, which also repairs modality and window discovery on those paths.
  - **Only models a registry seeds were indexed.** `build()` walked each provider's static `models` array, but a `passthroughModels` gateway serves its real list through a `modelsFetcher` — so `space-bunny-free`, `big-pickle`, `longcat-2.5-preview-free`, `cline-free/*`, `stealth/*`, `stepfun/*`… were never in it and could never resolve. The sync now records a model's effort ladder for **every** model the upstream catalogs, filed under each local id, and registry providers with an empty seed list claim their upstream name too.
  - **models.dev files some gateways under another id.** `PROVIDER_ALIASES` gains `cline → cline-pass` and `kilocode`/`kilo-gateway` → `kilo` (both Kilo providers fetch `api.kilo.ai/api/gateway/v1/models`, exactly what models.dev catalogs as `kilo`; the ids match verbatim). The rule — add an entry only when the model ids actually overlap, because a wrong mapping files another service's ladder under our id — is now written next to the table.
- **A reasoning model with no ladder is no longer reported as not reasoning.** models.dev marks toggle/budget models `reasoning: true` without publishing `reasoning_options`; that positive evidence now sets the capability, while the level set stays the hand tables' answer and the effort wire flag stays off (a toggle is not effort control). Stored as a separate `providers[model].reasons` key so `getCatalogReasoning` still reads "no ladder" as "no ladder".
- **A live `/v1/models` row could blank out the discovered ladder.** The DeepSeek Harness routes preferred the live row wholesale; when a gateway's own resolver built it, it carried no levels and the static resolution (which reads the synced catalog) was never consulted. Levels and the reasoning flag are now backfilled from the static side.
- **Catalog schema v3 → v4** so a current-looking etag cannot short-circuit the rebuild that adds the new rows; a v3 file only knows the seeded ids.

Every DeepSeek Harness profile patch stores specs at Apply time, so the card must be **applied again** for the corrected per-model ladders to reach `cordis.patch.yml`.

Tests: `tests/unit/reasoning-discovery.test.js` (alias resolution, passthrough indexing, `reasons` without levels) and `tests/unit/model-catalog-scope.test.js` (registry-driven upstream claims, schema version read from the constant) — both in the reasoning-effort set.

# v0.5.90 (2026-10-02)

## Features
- **Reasoning-effort auto-recognition for every provider**: `thinkingEffortSupported` was hand-declared per model, so it read `false` almost everywhere — notably on a fresh install with no catalog file synced yet, where every model's effort picker stayed off. It is now derived in `getCapabilitiesForModel` from two layers instead of a table: a discovered effort ladder (models.dev `reasoning_options`, synced daily into the catalog, catalog schema v3) is positive per-model evidence for **any** provider, and failing that a reasoning model on an effort-wire format (`openai`, `claude-adaptive`, `gemini-level`, `deepseek`, `kimi`, `step`, `tokenrouter`, `commandcode`) supports effort on the format default alone. Budget-only (`claude-budget`, `gemini-budget`, `qwen`, `hunyuan`) and toggle-only (`minimax`, `kiro`) formats stay false because their encoders map levels to budgets/switches; `zai` stays gated on per-model evidence because z.ai only reads `reasoning_effort` from GLM-5.2 onward. Combos propagate the flag (`aggregateComboCapabilities`).
- **New models resolve themselves — no per-model table edits**: `getCapabilitiesForLiveModel(provider, modelId, live)` resolves ids the static tables do not know from live data only: an explicitly passed capabilities object, then the live **display name** through the shared family patterns (gateways name models after their family, so `GLM-5.3`/`DeepSeek-V4-Pro`/`Kimi-K3` resolve with zero provider-specific entries), then the gateway's own per-model signals (`is_reasoning`, `is_vl`, token limits — Qoder publishes these), and otherwise the untouched floor, because inventing a value is worse than omitting it. Qoder's signals now flow through `routableQoderModels` into `/v1/models`, and `/v1/models` attaches `reasoningLevels` for live models so the dashboard and every CLI-tool consumer see the real per-model ladder. Kiro's live items no longer leak their `{ thinking, agentic }` variant flags into `model.capabilities` (wrong shape, wrong key).
- **Cline "Add free models" button**: new `GET /api/providers/cline/free-models` serves the free tier from Cline's public `recommended-models` feed (`free[]`, unauthenticated — Cline's own SDK calls it the same way), which the `cline` provider page offers as a button next to the existing `/models` import. It reuses the exported `fetchClineFreeTierModels` so the route and the model-list resolver share one fetch path, and skips ids already present in custom models or aliases. Cline's four free ids (`cline-free/deepseek-v4.1-flash`, `cline-free/mimo-v2.6-flash`, `cline-free/muse-spark-1.3-contributor`, `stealth/space-bunny-alpha`) do not appear in `/api/v1/models` at all, which is why they must come from the feed. clinepass has no free tier, so the button is cline-only.
- **Per-model efforts reach the CLI tools**: Codex (`supported_reasoning_levels`), the DeepSeek Harness family, and ZCode (`variants`/`defaultVariant`) all write the model's real levels — discovered ladder first, then the shared per-model levels, with ZCode's hardcoded `low/high/max` demoted to a last-resort fallback for models that declare nothing. Tools whose config schema has no per-model effort field (Pi, Oh My Pi, OpenCode, Mimocode) continue to receive the correct per-model `reasoning` boolean, which is the most their schema can express.
- **Union Alpha retired**: the model is gone upstream. Its entries were dropped from the `opencode` and `opencode-zen` registries, and the OpenCode executor's Anthropic-Messages branch is now registry-driven (`getModelTargetFormat(...) === "claude"`) instead of a hardcoded id set, so a future claude-target model routes with no code change and a retired one stops matching by itself.

## Fixes
- **Reasoning levels no longer lost on exact-table hits**: the discovered per-model ladder applies uniformly, including to models whose exact `MODEL_CAPABILITIES` entry short-circuits the family pattern table. The GLM-5.2 entry exists only to raise its context window to 1M, and it was silently shadowing `*glm-5.2*`'s effort support; the same applied to `deepseek-v4.1-flash` and `deepseek-flash`.
- **ZCode wrote invented variants**: brand-new model entries got a hardcoded `variants: ["low","high","max"]` regardless of what the model supports, and `none` (the disable switch) was folded in with the efforts. Both fixed; user-tuned variants on existing entries are still preserved.

Tests: `tests/unit/reasoning-effort-auto.test.js` and `tests/unit/cline-free-models-route.test.js` (new), plus `reasoning-discovery`, `thinking-levels`, `kilo-reasoning`, `thinking-combo-coercion`, `zcode-settings`, `qoder-context-tier`, `opencode-zen-models`, `opencode-muse-spark-thinking` — the reasoning-effort files are in the CI core gate.

> Note: v0.5.89 was never published to npm; its DeepSeek Harness Desktop work ships in this release.

# v0.5.89 (2026-10-02)

## Features
- **DeepSeek Harness Desktop**: new CLI tool integration, sharing the DeepSeek Harness icon. dsh is an everything-is-a-plugin Cordis runtime composed per **profile**, and the Desktop app runs the `desktop` profile while `dsh web` runs `web` — each with its own config file. The Desktop card therefore writes `$DSH_HOME/profiles/desktop/cordis.patch.yml`, and the existing DeepSeek Harness card now writes `profiles/web/cordis.patch.yml`; the two are independent and never touch each other. Both share one `$DSH_HOME/.credentials.yaml`. An optional **Default model** toggle pins the `agent-default-model` row (`provider: afrouter`, model, optional `reasoningEffort` from pi-ai's `off…max` levels) so a fresh session starts on AFRouter — off by default, because it changes what dsh starts on. Shared pure patch shapes live in `src/lib/dshProfilePatch.js`; the `web`/`desktop` cards render from one component driven by each entry's `dshProfile`.

## Fixes
- **DeepSeek Harness wrote a config file dsh no longer reads**: the integration wrote `$DSH_HOME/settings.yaml`, but `@deepseek-ai/dsh-settings` imports that document **once** into the active profile's Cordis patch and then renames it `settings.yaml.imported` — so on any machine where dsh had already booted, Apply reported success and changed nothing. (On the author's machine the imported route had landed in the `web` profile, which is exactly why the Desktop app never saw it.) The live surface is now the profile's `cordis.patch.yml` patch layer, and the import target is the profile actually being configured. Because a patch **replaces the whole `config` of the row it targets** (verified in `@deepseek-ai/cordis-plugin-include`), every write rebuilds the complete `llm-pi-ai` config from the row already in the file: other providers declared in that row and unrelated keys (`defaultContextWindow`, `retryPolicy`) survive, and unrelated rows keep their position. Reset removes only our `providers.afrouter` and drops the row only when nothing of ours or the user's is left in it. Detection now also flags a machine-local `$DSH_HOME/cordis.patch.yml` that declares its own `llm-pi-ai` row — that layer outranks the profile layer, so it would silently erase our route. Corrupt-file handling matches dsh's own rule (a patch file must be a top-level YAML array of entries) and refuses to write. Verified against dsh's real include dialect (`JSON_SCHEMA` + the `!!js` type) and against the live `profiles/web/cordis.patch.yml`. Tests: `tests/unit/deepseek-harness-settings.test.js` (also promoted into the CI core gate).

# v0.5.88 (2026-09-29)

## Features
- **Oh My Pi**: new CLI tool integration. AFRouter registers itself as an `afrouter` provider in Oh My Pi's agent directory — `~/.omp/agent/models.yml`, or `$PI_CODING_AGENT_DIR` when set — with `api: "openai-completions"`, so Oh My Pi's `/model` picker offers AFRouter models. Real per-model specs are resolved from the live `/v1/models` catalog (`contextWindow`, `maxTokens`, `input`, `reasoning`), which is what Oh My Pi uses to size its compaction budget, image encoding and the `/thinking` picker. An optional **Startup** toggle pins `modelRoles.default` in `config.yml` — with an optional thinking level appended as `:off`…`:max` — so `omp` starts on AFRouter with no `/model` step. Model ids keep their slashes: Oh My Pi splits a `provider/modelId` selector on the **first** `/`, so `afrouter/kilo/stealth/space-bunny-alpha` resolves to the right model, verified end-to-end against the real `omp` binary (the gateway receives `"model": "kilo/stealth/space-bunny-alpha"` with `Authorization: Bearer …`). `cost` and `promptCache` are deliberately left unset — a gateway publishes no per-model tariff or cache lifetime, and a wrong value would make Oh My Pi misprice tokens or keep warming a cold cache. Ownership is ledger-only (`<DATA_DIR>/omp-model-ownership.json`), so Reset never deletes a model a user typed in by hand, and an unrecorded one is only adopted on an explicit flag. Shared pure shapes live in `src/lib/ompConfig.js`. Tests: `tests/unit/omp-settings.test.js`.
- **Zed**: new CLI tool integration. AFRouter writes an `ai.custom_providers` entry into Zed's `settings.json` (base URL, model list, Authorization header) so Zed's model picker offers AFRouter models. Dashboard card + `GET`/`POST`/`DELETE` handlers; shared pure shapes in `src/lib/zedConfig.js`.

## Fixes
- **MiMo Code / Desktop model specs**: Apply wrote every model as `{ name, modalities: { input: ["text","image"] } }` — claiming image support on text-only models, dropping pdf/audio/video that MiMoCode's `/modalities` TUI does support, and leaving `limit`/`reasoning`/`tool_call` unset so MiMoCode could not size context or gate thinking and tools. Specs are now resolved from the live `/v1/models` catalog → static capability tables → a conservative fallback (reported `unverified`), and written in MiMoCode's documented shape. A display `name` the user set is preserved while machine-readable fields refresh on re-Apply. Manual Config uses the same shared builder (`src/lib/mimocodeConfig.js`) so the preview matches what Apply writes.
- **Pi / Oh My Pi / DeepSeek Harness Manual Config**: the Pi and OMP previews fell back to conservative defaults even when the static tables knew the model; the DSH preview hardcoded 200k/32k and omitted `input`/`reasoningEfforts`. All three now resolve specs from the static capability tables (same as the route) through their shared builders. Pi/OMP/DSH `buildModelEntry` also accepts raw capability tables (`maxOutput`), so a card can pass `getCapabilitiesForModel` output without a field-name mismatch. Input modalities stay schema-correct: Pi/OMP never write `video`/`audio`/`pdf` (their schemas only accept `text`/`image`); MiMoCode does write the extra modalities its `/modalities` TUI supports.
- **NVIDIA NIM auto-retire removed**: the "dead-model bypass" classified ordinary 404s as upstream retirement, escalated to 30-day model locks, and hid the id from `/v1/models` and the dashboard — which made NVIDIA NIM models unusable. The feature is gone; a 404 now takes the normal cooldown path and models stay listed and routable.

## Engineering
- **Tests + Lint on GitHub Actions**: `test.yml` (core gate, full advisory suite vs known-fails baseline, registry drift guards) and `lint.yml` (eslint with GitHub annotations) run on master pushes, PRs, and dispatch — offloading long CPU runs and large artifacts from the dev laptop.

# v0.5.87 (2026-09-26)

## Fixes
- **Pi Coding Agent**: writing `video`/`pdf`/`audio` into a model's `input` modalities broke Pi's `ModelDefinitionSchema`, which only accepts `text`/`image` — one such model invalidated the **entire** `models.json`, so Pi loaded none of them. Those modalities are never written now, and entries already in the file are sanitized on Apply. Unverified models now get Pi's documented 128k/16k defaults instead of a stale OpenCode-copied 200k/32k, catalog display names are written for the `/model` picker, `apiKey` is always present (Pi requires it once models are defined), `baseUrl` normalization can no longer produce double slashes, and the Windows install probe now looks in `%APPDATA%\npm`. Deleting one model no longer wipes the **Startup** pin: `defaultModel` only repoints when the pinned model itself was removed, and `setDefault: false` from the card actually clears a pin that points at us. The card now uses the correct `pi.png` icon.
- **Kilo Code dashboard**: free models each rendered **twice** in Available Models, and a disabled one rendered twice under Disabled models too. Three lists fed one row set without any id-level collapse: the registry seed, a kilocode-only `/api/providers/kilo/free-models` route (the catalog's `isFree` flag), and the user's custom models — and 15 of Kilo's 18 free ids appear in more than one of them. The custom-model list was deduped against the seed alone rather than the seed *plus* that catalog, so every free model the "Add" flow had saved came back as a second chip; because the disabled-models store is keyed by model id only, the pair could never agree on a single state (the live account rendered 29 chips for 20 models, and disabling one of those free ids put it in the Disabled section twice). The redundant route and its page state are gone — the catalog is now fetched through one path — and every source (seed, live catalog, custom models, legacy aliases) collapses to one id in exactly one section via a new pure helper, `src/shared/utils/providerModelRows.js`, so Available / Disabled / Suggested / Disable-All can no longer disagree. Kilo's authoritative `isFree` flag is the filter that survived, as a new `kilo-free` type: the generic `openrouter-free` pricing heuristic it competed with required $0 pricing *and* a 200k context floor, which silently hid three genuinely free ids (`liquid/lfm-2.5-2.6b:free`, `nvidia/nemotron-3.5-content-safety:free`, `stepfun/step-3.7-flash:free`) and offered `$0`-priced **audio-output** `google/lyria-3-pro-preview` as a chat model.
- **Kilo registries**: seeds verified against the live catalog. `anthropic/claude-sonnet-4-20250514`, `anthropic/claude-opus-4-20250514` and `deepseek/deepseek-reasoner` no longer exist upstream (Kilo 400s unlisted ids with "The requested model ... does not exist"), so those rows could only ever fail; replaced with current ids plus Kilo's own `kilo-auto/*` router tiers. `kilo-gateway`'s `kwaipilot/kat-coder-pro-v2.5:free` was pulled by Kilo — only the paid id exists.

## Engineering
- **Release images**: `docker-publish.yml` wrote the `dockerhub=true|false` marker into the same heredoc that built the `images` output, so `docker/metadata-action` rejected the list (`Unknown image attribute: dockerhub=false`) and failed the image build on the GHCR-only path this repo actually takes. `images` is now a single comma-separated line with `dockerhub` as its own output.

# v0.5.86 (2026-09-26)

## Features
- **Pi Coding Agent**: new CLI tool integration. AFRouter registers itself as an `afrouter` provider in Pi's agent directory — `~/.pi/agent/models.json`, or `$PI_CODING_AGENT_DIR` when set — with `api: "openai-completions"`, so Pi's `/model` picker offers AFRouter models. Pi re-reads the file each time `/model` opens, so no restart is needed. Real per-model specs are resolved from the live `/v1/models` catalog (`contextWindow`, `maxTokens`, `input`, `reasoning`), which is what Pi uses to size compaction, image encoding and the `/thinking` picker. An optional **Startup** toggle pins `defaultProvider`/`defaultModel` in `settings.json` so `pi` starts on AFRouter with no `/model` step. Dashboard card supports endpoint selection (local/tunnel/Tailscale), API-key picker, multi-model apply, per-model removal, Manual Config for remote machines, and a Reset that removes only the models AFRouter wrote (tracked in a ledger, so hand-added models under the same provider are spared and reported).

## Fixes
- **Kilo Code model specs**: kilocode was the only OpenRouter-shaped provider without a `modelSpecs` declaration, so the catalog lookup bailed out before fetching anything. A model saved from Kilo Code's catalog therefore stored no capabilities and fell back to the 200K/64K default floor — including models whose real context window is 1M. It now declares `modelSpecs: { format: "openrouter", auth: "none" }` (identical to OpenRouter's; the catalog is public, so no credentials are needed), so context window, max output and modalities come from the catalog.

# v0.5.85 (2026-09-24)

## Features
- **TypeSafe AI**: free-tier provider with the Jev 1.13 decisions-only models, served through `POST /v1/systemone` (typed `{answers}` + usage). Any `typesafe/*` passthrough id routes and logs like a registered Jev model, and `oc/jev-1.13-free` stays the only OpenCode-routed id. New provider tile on the dashboard.
- **Beta builds**: every non-master push and PR now publishes a rolling UNSTABLE download box as a GitHub prerelease (`beta-latest`) after the smoke test — stable `objects.githubusercontent.com` link instead of Azure-blob artifacts: `gh release download beta-latest --repo AFG473319/AFRouter`.

## Fixes
- **Model specs**: `/v1/models` reports the real capabilities for models you add to a connection (context window, max output, modalities, reasoning) instead of the 200K/64K default floor. The add flow already captured the exact specs from the provider's catalog (OpenRouter/Nous) — the listing now uses them, merges them with hand-written table knowledge (flags only turn on, table extras survive), and applies the same merge to combo members.
- **Jev System One**: requests now record Request Logs / usage like chat models (rows are written even when upstream omits usage, tokens mapped from TypeSafe's `{input_tokens, output_tokens}`) and emit Console Log lines (`▶` request, `📊 DONE` / `✗ ERROR`).
- **OpenAI reasoning models**: thinking can no longer be switched off — `reasoning_effort: "none"` is rejected upstream, so these models now clamp to the minimum instead of offering a disable option.
- **OpenCode settings card**: explains which rule picked V1 vs V2 (manual, existing config shape, installed CLI version, default) and no longer renders the version twice.
- **TypeSafe logo**: provider tile art fixed (outer pink disc removed).

## Engineering
- **Benchmarks**: zero-dependency `npm run bench` suite — cold build, gateway startup (health / first route / warm route), full-pipeline request latency against a local stub upstream, and `vitest bench` hot functions. Runs on GitHub Actions (PRs, master, manual dispatch) with advisory-only baseline comparison; see `benchmarks/README.md`.

# v0.5.84 (2026-09-20)

## Features
- **Agent Skills**: publish the full skill set on the dashboard Skills page — `afrouter-systemone` (System One decisions), `afrouter-video` (Grok Imagine), and the STT capability skill were missing from the 0.5.83 build. Ten skills are now listed (entry + 9 capabilities), each with a copyable raw URL.
- **Agent Skills**: `AFROUTER_URL` is documented as optional — every skill resolves `BASE="${AFROUTER_URL:-http://localhost:20128}"` and no longer instructs an agent to look for the variable. Auth is documented as required by default, matching `requireApiKey: true`.

## Fixes
- **Jev System One**: `/v1/systemone` now writes the same request logs as chat models — `usageHistory` (Request Logs / usage stats) and request details. Token counts are mapped from TypeSafe `{input_tokens, output_tokens}` into the prompt/completion columns; rows are recorded even when upstream omits usage so Jev calls no longer disappear from the logs.
- **Agent Skills**: correct the System One skill — `oc/jev-1.13-free` is the only routed id, and `GET /v1/models` omits no-auth providers (opencode has no connection), so the skill now gives the exact model id instead of a catalog query that returns nothing on a populated instance.
- **Agent Skills**: add the missing `Authorization` header to the System One curl example.

# v0.5.83 (2026-09-20)

## Features
- **Jev System One**: TypeSafe `jev-1.13-free` joins OpenCode Free as a decisions-only model (`targetFormat: systemone`, served upstream at `POST /zen/v1/systemone`). New gateway endpoint `POST /v1/systemone` forwards `{model, state, questions}` with the connection's credentials and returns typed `{answers}`; chat requests to Jev fail fast with a 400 pointing at it. The dashboard Test button sends a minimal `noul` decision probe and expects typed answers instead of chat choices. Only the free id is advertised — paid `jev-1.13` needs a Zen API key and is left out of the noAuth provider.
- **Models**: `deepseek-v4.*` accepts low..max effort; flag `thinkingEffortSupported` and vision.
- **Providers**: add DeepSeek-V4.1-Flash to CodeBuddy intl and Ollama Cloud; scope the synced model catalog to gateways.
- **i18n**: Persian (fa) translation integration.
- **OpenCode Go**: dashboard notice now quotes the current $10/mo subscription price.

## Fixes
- **Dev server**: remove a duplicated `getCommandCodeUsage` import (and duplicate handler key) in `open-sse/services/usage.js` that broke compilation with a 500 on every page.
- **CommandCode**: retry on transient stream errors without emitting fake stop chunks; preserve images and `reasoning_effort` on `/alpha/generate`.
- **Kiro**: preserve underscores in tool names and restore sanitized names in responses; neutral placeholder for tool-result-only user turns; keep tool-result images through translation.
- **Antigravity**: scope cached thought signatures to the model family; sanitize the Hermes system identity; strip the Claude Code billing header from system prompts.
- **Zed**: harden the OAuth lifecycle and live-model support; lower display priority in the OAuth list.
- **Codex**: route bare `codex-auto-review` to the Codex provider (#4135).
- **DeepSeek**: V4.1-Flash ids carry vision; improve credit-balance display.
- **Stream**: report aborts after HTTP 200 in-band instead of closing silently.

# v0.5.82 (2026-09-19)

## Features
- **OpenCode**: registry-driven Anthropic Messages routing — endpoint and auth follow the model registry when no source-matched transport exists.
- **Codex integration**: OpenCode-style multi-model selection backed by one AFRouter provider and a generated Codex model catalog; includes per-model context, vision and reasoning metadata, default/subagent selection, CODEX_HOME support, secret-free status, manual snippets, backups, rollback, and ownership-aware Reset that preserves credentials and user edits.
- **CLI tools**: add MiMo Code / MiMo Desktop integration — a new card writes an `afrouter` provider entry (`npm: @ai-sdk/openai-compatible`, `only_configured_models`) into the shared `mimocode.jsonc` (honors `$MIMOCODE_HOME`, checks `~/.config/mimocode` and `%LOCALAPPDATA%\mimocode`). MiMo Desktop runs on the MiMoCode engine and both read the same config file, so one Apply configures the CLI, the Desktop app, and the TUI. The config is read as JSONC (BOM, comments, trailing commas, URLs in strings) so a hand-edited file is never clobbered on a blind parse; Apply merges additively — user-tuned fields on existing model entries (`name`, `tool_call`, `reasoning`, `limit`) and unrelated providers are preserved. Detection covers the `mimo` binary, the Desktop app dir (`%APPDATA%\Xiaomi MiMo AI` / `~/Library/Application Support`), or an existing config. Includes `GET`/`POST`/`PATCH`/`DELETE`, Manual Config snippet, installation guide, notes (shared config, first-`/` model-id split, do-not-edit `preferences.json`/`model-catalog.json`), unit tests, and CLI TUI menu entry.

## Fixes
- **Custom models**: fetch exact model specs from Nous Portal and OpenRouter catalogs when adding or re-adding a model; persist catalog capabilities and token limits, with existing defaults retained when lookup fails or fields are missing.
- **Codex model picker**: keep the default reasoning effort in a nonempty selectable list, including custom reasoning models such as `nous/stealth/union-alpha` whose effort ladder is unavailable. Preserve declared effort choices without inventing extra levels.
- **CLI/headless**: validate ports and resource IDs, preserve boolean flags and negative numeric values, reject blank required values and invalid settings patches, and return error exit codes for unknown commands and failed gateway status checks.
- **CLI/headless**: default compatible nodes to Chat Completions, preserve custom-model provider/type on deletion in both interfaces, send Codex's single-model payload, honor the selected endpoint host, and mask JSON key listings.
- **CLI audit**: document remaining dashboard parity gaps in `CLI_AUDIT.md`; add isolated contract, subprocess transport, terminal-menu, and Codex config-merge regression tests.
- **WorkBuddy**: register applied models in `availableModels` so Apply actually surfaces them in the WorkBuddy picker (previously entries were written to `models` but never listed); Reset prunes removed ids; Manual Config snippet includes the list. Add `workbuddy-settings` unit tests.
- **MiMo Code**: give the CLI-tool icon a transparent background (white corners removed, black squircle and MI mark preserved).

# v0.5.81 (2026-09-16)

## Features
- **CLI tools**: add DeepSeek Harness (`dsh`) integration — a new card writes an `afrouter` provider route (`llm-pi-ai.providers.afrouter`, `api: openai-completions`) into `$DSH_HOME/settings.yaml` and stores the key as `refs.AFROUTER_API_KEY` in `$DSH_HOME/.credentials.yaml`, so dsh's model picker offers AFRouter models without hand-editing YAML. Multi-model management with catalog-accurate `contextWindow`/`maxTokens`/`input`/`reasoningEfforts`, an optional DeepSeek thinking-off `compat` toggle, Manual Config snippets (settings + credentials + optional default-model pin), and a Reset that removes only the AFRouter route and preserves a real dashboard key. Honors `DSH_HOME`; writes are backup + atomic; a corrupt `settings.yaml` is never overwritten.

## Fixes
- **CLI tools**: ZCode model ownership is now tracked in a durable ledger (`~/.afrouter/zcode-model-ownership.json`) instead of an in-config marker that ZCode's rewriter strips on exit — previously every model AFRouter applied became unowned after ZCode restarted, and a later Reset could no longer remove them. Apply/Reset classification now distinguishes owned models, marker-bearing pre-ledger models, and "bootstrap candidates" (resolvable but never recorded): candidates are never claimed or deleted silently — Apply adopts them only with an explicit `adoptBootstrap` flag (card: "Adopt as mine"), Reset reports them as `skippedCandidates`, and re-sending the whole hydrated chip list never escalates hand-added models into owned ones or rewrites their user-tuned specs.
- **OpenCode**: derive Responses-only routing from the model registry, and route OpenCode Go `gpt-5.6-luna` (including thinking variants) to the Responses API.

# v0.5.80 (2026-09-15)

## Features
- **CLI tools**: add ZCode integration (provider card + settings route + spec-kit artifacts)

## Fixes
- **CLI tools**: ZCode card now reflects the real AFRouter entry contents (chips render every model in the entry; user-added models are dimmed and protected), hydration no longer clobbers an in-progress selection while the model modal is open, and a chip is removed only when the server confirms removal. Replace the placeholder icon with the official Z logo. Also names the provider entry AFRouter (not 9Router) — shipped too late for 0.5.79, which still bakes the old name.

# v0.5.79 (2026-09-15)

## Features
- **CLI tools**: add ZCode integration (provider card + settings route + spec-kit artifacts)
- **Antigravity**: pool-aware quota routing with cache warm-up and 503 fit-block; grouped pool quota display with subscription tier badges; warm quota cache after background token refresh
- **CommandCode**: track credit windows and plan allowance in the usage dashboard; record prompt-cache reads as usage detail
- **Combos**: add Cursor/Claude default presets and bulk select
- **Usage**: add all-time period to usage stats and chart
- **GitHub**: track AI Credits and enforce local usage limits
- **Models**: merge member capabilities into combo `/v1/models` entries
- **Claude**: store account email and real plan on OAuth connect
- **Providers**: add OrcaRouter (`orcarouter.ai`) — OpenAI-compatible gateway routing to OpenAI, Anthropic, Google, DeepSeek, Qwen, Kimi, GLM, MiniMax & more at provider cost; seeds current-gen models only (GPT 5.6 series, `orcarouter/free` / `orcarouter/fusion*` routers, the $0 free pool), plus embeddings/TTS/image endpoints and live `/v1/models` catalog fetching with older ids available on demand
- **Capabilities**: resolve OrcaRouter router ids (`orcarouter/fusion*`, `orcarouter/free`) and its legacy `deepseek-chat`/`deepseek-reasoner` aliases (1M V4-Flash) with real catalog specs scoped to the provider; add `gpt-image-1.5`/`gpt-image-1-mini` to the canonical image-model table
- **Dashboard**: fix suggested-models fetch for generic OpenAI-shaped catalogs (`openai` filter type was unregistered — tokenrouter, venice, vercel, perplexity-agent silently returned nothing); only catalogs whose filter actually selects $0 models are labeled "Suggested free models" now, free ids sort first, and ctx-less entries no longer render "NaNk ctx" tooltips; surface why a provider connection test failed

## Fixes
- **Auth**: don't cool down an account for a request-scoped 4xx
- **Translator**: keep Responses tool-output images as images; strip `output_config.format` for Claude-compatible gateways
- **Passthrough**: strip `output_config.format` for Claude passthrough targets
- **RTK**: skip ponytail injection on media-carrying requests
- **Cursor**: route bare Cursor catalog ids to `cu/` not `openai`
- **CommandCode**: render credit amounts with a dot decimal
- **Gemini**: do not mistake schema maps for schemas when recursing; expand shorthand string subschemas in tool declarations
- **Stream**: stop blocking an Ollama upstream's NDJSON as a non-SSE body
- **OAuth**: parse numeric epoch `expiresAt` so imported connections still refresh
- **DB**: prevent silent database wipe on SQLite corruption and add startup `quick_check`
- **Google PSE**: configure and validate search engine IDs

## Performance
- **Memory**: cap per-stream content/thinking capture to 4KB (`STREAM_CONTENT_CAPTURE_MAX`) — long agent/dashboard streams no longer pin the whole response text in heap; usage estimation still uses the unbounded `totalContentLength` counter. Remove the write-only unbounded content accumulator in the Ollama translator.
- **Performance (usage stats)**: bound the `getUsageStats` last-used overlay scan to a 60-day window even for the `all` period, so the dashboard `/api/usage/stream` tick no longer reads the entire `usageHistory` table on every request.
- **GitHub**: throttle AI Credits usage checks

# v0.5.78 (2026-09-14)

## Features
- **Rebrand**: rename everything from 9Router to AFRouter — packages (`afrouter-app`, `@afg473319/afrouter`), CLI binary (`afrouter`), data dirs (`~/.afrouter`), internal headers (`x-afr-*`), default keys (`sk_afrouter`), skill ids, and UI strings; default port stays **20128**

# Unreleased

## Performance
- **Memory**: cap per-stream content/thinking capture to 4KB (`STREAM_CONTENT_CAPTURE_MAX`) — long agent/dashboard streams no longer pin the whole response text in heap; usage estimation still uses the unbounded `totalContentLength` counter. Remove the write-only unbounded content accumulator in the Ollama translator.
- **Performance (usage stats)**: bound the `getUsageStats` last-used overlay scan to a 60-day window even for the `all` period, so the dashboard `/api/usage/stream` tick no longer reads the entire `usageHistory` table on every request.

## Features
- **NVIDIA NIM**: dead-model bypass — when the upstream retires a model id (NIM sunsets hosted models after a fixed window), the id is bypassed per-model with an escalating cooldown (5m → 30m → 6h → 24h → 7d → 30d cap) instead of the flat 2-minute 404 cooldown that retried it forever; the credential stays active so healthy sibling models keep working, and a model that answers again is un-retired automatically. A model retired on any connection is hidden from `/v1/models` and the dashboard listing, and combos fall through to the next model with a 404 instead of surfacing a rate limit.
- **NVIDIA NIM**: live catalog sync — new NIM ids are discovered without a release via a models.dev `modelsFetcher` (text-in/text-out, tool-calling, $0 cost entries only), exact specs (context window, max output, modalities, reasoning, tools) are captured from the same catalog at add time and reported on `/v1/models`, catalog ids are accepted before an explicit add (`passthroughModels`), and the NIM card gains STT alongside TTS/embeddings.
- **Providers**: add OrcaRouter (`orcarouter.ai`) — OpenAI-compatible gateway routing to OpenAI, Anthropic, Google, DeepSeek, Qwen, Kimi, GLM, MiniMax & more at provider cost; seeds current-gen models only (GPT 5.6 series, `orcarouter/free` / `orcarouter/fusion*` routers, the $0 free pool), plus embeddings/TTS/image endpoints and live `/v1/models` catalog fetching with older ids available on demand
- **Capabilities**: resolve OrcaRouter router ids (`orcarouter/fusion*`, `orcarouter/free`) and its legacy `deepseek-chat`/`deepseek-reasoner` aliases (1M V4-Flash) with real catalog specs scoped to the provider; add `gpt-image-1.5`/`gpt-image-1-mini` to the canonical image-model table
- **Dashboard**: fix suggested-models fetch for generic OpenAI-shaped catalogs (`openai` filter type was unregistered — tokenrouter, venice, vercel, perplexity-agent silently returned nothing); only catalogs whose filter actually selects $0 models are labeled "Suggested free models" now, free ids sort first, and ctx-less entries no longer render "NaNk ctx" tooltips


## Features
- **Providers**: add Meta Muse provider with OAuth login and model catalog; add v1m System One provider
- **GLM**: add Z.ai OAuth login to GLM Coding (dual-auth)
- **Codex**: add GPT-6.1 Sol; expose 1M context variants for GPT-6 and GPT-5.6; add gpt-daybreak/reserve models and route bare `gpt-5.x`/`gpt-6.x` slugs to codex
- **Claude**: add Claude Sonnet 5.5 (plus `claude-opus-5.5` models in the Kiro registry)
- **CLI**: add `connect` command for remote 9Router servers
- **Providers**: per-provider custom header overrides from the registry
- **Agnes**: seed the 2.5/3.0 model ids in the registry
- **Usage**: sync `?provider=` URL param with provider filter for bookmarkable deep links (#4395)
- **Dashboard**: drop NEW badges in sidebar, mark 9Remote as HOT

## Fixes
- **Claude**: preserve intentional prefill from non-messages[] source formats; keep a trailing user turn so cleanup never yields assistant prefill
- **Claude**: cache a tool loop's final tool results with the 4th breakpoint
- **Claude**: resolve Sonnet 5.x to adaptive thinking so no forged thinking placeholders are sent; inject unsigned thinking placeholders for opencode-go DeepSeek `/messages` (#4436)
- **Thinking**: add `xhigh` to claude-adaptive thinking levels
- **Claude**: keep a user turn whose only block is `container_upload`
- **Capabilities**: publish real GPT-6/GPT-5.4+ context windows and combo token limits
- **Responses**: wait for real usage before emitting `response.completed`, bounded by a 3s watchdog
- **Codex**: stop refresh-token reuse that logs accounts out on auto-ping; preserve hosted web search on GPT-6 Sol/Luna; remove ghost models
- **Grok CLI**: send Grok CLI 1.0.44 so proxy stops returning HTTP 426
- **Proxy**: auto-fallback to insecure TLS on self-signed cert errors; hold strictProxy when no proxy resolves
- **Translator**: strip `errorMessage` and other non-standard schema keywords from Gemini tool schemas; dedupe same-name tools for DeepSeek models (#3333)
- **Codebuddy**: parse the 6004 rate limit error and extract `resetsAtMs`; forward `recurring` for codebuddy-intl quota packs (#4422)
- **CLI Tools**: replace `sk_9router` placeholder with first active dashboard API key
- **Dashboard**: exclude hidden providers from usage stats provider list
- **Capabilities**: add deepseek-v4-1-flash vision alias; add zed to live catalog providers

# v0.5.91 (2026-09-26)

## Features
- **Web Search & Fetch**: add TinyFish Search and Fetch with one API-key connection, normalized results, and official provider icon
- **Providers**: add Token Harbor provider and four OpenAI-compatible aggregator providers (dahl, atria, agnes, bai)
- **Claude**: forward `x-claude-code-session-id` on OAuth requests; merge client `anthropic-beta` flags and forward rate-limit headers; return thinking text to OpenAI-format clients
- **Codex**: add GPT-6 Sol and Luna support
- **CLI Tools**: support multiple model profiles for Codex CLI
- **Hermes**: multi-role model config (delegation + auxiliary slots)
- **OpenCode Go**: complete the Go catalog (40 models) with auto-fetch + family endpoint regex
- **Usage**: show and redeem free limit resets for cc accounts
- **Cline**: expose the `cline-free/*` tier and price it at zero
- **Combos**: display vision adapter models in an ordered table view

## Fixes
- **Claude**: decloak tool names when `toolNameMap` misses (#4342); update spoofed cli version to 2.1.280 to support Opus 5.5
- **Providers API**: make POST `/api/providers` O(1) and refuse silent key overwrite (#4350)
- **Capabilities**: stop caching the catalog source per module copy (#4351)
- **OAuth**: stop Zed paste-token crash and add IDE auto-import (#4359)
- **Dashboard**: resolve combo limits with the server's capabilities (#4360); lazy-load charts and `marked`, preload in background on idle
- **Responses**: carry the streamed output items in `response.completed` (#4307)
- **STT**: dispatch live-API-only Gemini models over the Live WebSocket transport (#4006)
- **Gemini**: guard terminal model turns and unresponded functionCalls in `normalizeGeminiContents`
- **Command Code**: replay raw byte chunks to preserve all NDJSON lines
- **Translator**: stop emitting empty `<think>` markers into OpenAI content
- **CLI Tools**: refresh Codex settings after apply (#4347); keep existing `ANTHROPIC_AUTH_TOKEN` when applying Claude settings
- **Tray**: native arm64 macOS menubar binary, no Rosetta required
- **CLI**: filter model selector by active connections and noAuth providers
- **Usage**: key live byApiKey stats by full api key to prevent team-key collision and preserve API key usage attribution
- **Tailscale**: cap enable-flow health wait at 20s

# v0.5.86 (2026-09-23)

## Features
- **Xiaomi MiMo**: server-assisted desktop login for headless/Docker deployments, five account clusters (cn/sgp/ams/ru/in), and v2.6 pro/flash/pro-ultraspeed models with dual-route (account service vs. cloud API)
- **Claude**: add Claude Opus 5.5 support
- **i18n**: translate React text rewrites via characterData mutation observer

## Fixes
- **Proxy Pools**: keep request headers intact through Vercel/Cloudflare/Deno relays (spreading a `Headers` instance yielded `{}`, dropping auth and content-type)
- **Xiaomi MiMo login**: keep the session in the httpOnly cookie only, require dashboard auth on the proxy branch, and stop forwarding authorization headers upstream

# v0.5.85 (2026-09-22)

## Features
- **System One**: add `/v1/systemone` decision endpoint for Jev models (OpenCode Zen and OpenRouter lanes), wire into sidebar and Media Providers page with interactive probe testing
- **CLI Tools**: add dynamic configuration, settings APIs, and official logos for Pi, OMP, Crush, ForgeCode, Smelt, and CodeWhale
- **Analytics & Usage**: add Requests mode, provider/model breakdown charts, All Time period filter, and refined overview cards
- **Combos**: add Cursor/Claude Default presets; support bulk select/delete and bulk strategy changes (Fallback / Round Robin / Fusion)
- **Model Capabilities**: expose model capability metadata on `/v1/models` and aggregate capabilities across combo targets
- **OpenCode Zen & MiMo**: add OpenCode Zen (`opencode-zen`) provider with free-tier fingerprint; switch default vision fallback to MiMo V2.6 Flash Free
- **Qoder CN**: add `qoder-cn` provider for qoder.com.cn with OAuth flow, COSY protocol, and CN gateway routing

## Fixes
- **Translator**: map Claude `refusal` stop_reason to `content_filter` and surface explanation; strip replayed reasoning fields for Groq, Mistral, and Cerebras (#4220)
- **Antigravity**: drop requestType `agent` to avoid false 429 `RESOURCE_EXHAUSTED`; separate weekly and short-window (5-hour) quotas and deduplicate dashboard rows
- **Responses API**: report usage on `response.completed` so clients can auto-compact (#3432)
- **Hugging Face**: migrate to Inference Providers router (`router.huggingface.co`), expand image models catalog, and add STT route
- **Qoder**: prevent signed request replay (`403/103 Duplicate request`), handle code 110 billing blocks, and preserve upstream SSE error status
- **Performance**: bound usage `lastUsed` scan to a 2-day window; map large budget tokens to `max` reasoning tier
- **Docker**: publish verified multi-platform images (linux/amd64 and linux/arm64) with configurable apk build mirrors

# v0.5.81 (2026-09-18)

## Features
- **Xiaomi MiMo**: merge MiMo Desktop support into `xiaomi-mimo` with dual auth (API key + Desktop/OAuth session), Preview models support, and encrypted-callback OAuth flow
- **Claude Code**: add 1M-context toggle (`[1m]` marker) and drive `CLAUDE_CODE_AUTO_COMPACT_WINDOW` directly from the dashboard
- **Models**: add DeepSeek-V4.1-Flash to DeepSeek provider, CodeBuddy-Intl, and Ollama (`deepseek-v4.1-flash:cloud`); enable `low`..`max` reasoning effort levels and vision capability for DeepSeek-V4.*
- **i18n**: integrate Persian (fa) translation

## Fixes
- **Cursor**: stop AgentService empty turns (`OUT 0`) and silent hangs — fold system prompts instead of `custom_system_prompt`, send `ModelDetails`, read Composer/Grok `thinking_delta`, ack request-context without echoing MCP tools, and reject IDE execs so the model can continue
- **RTK**: for Cursor, compress source-format `tool_result` / `role:tool` **before** translation — its translator rewrites those shapes, so post-translate compression missed them. Other providers keep the post-translate pass unchanged
- **OpenCode / OpenCode Go**: resolve 403 `FreeTierError` and 429 rate limits with canonical session format, valid User-Agent, and stable upstream session reuse; force stream and declare `forceStream` for free-tier SSE aggregation; cloak decoy tools, normalize Muse Free tool choice, and strip prior reasoning items on Responses models; route Union Alpha via Messages API
- **Kiro**: preserve underscores in tool names (`mcp__server__tool`) and restore client tool names in responses; use neutral placeholder for tool-result-only turns; forward tool-result images
- **Stream**: report aborts after HTTP 200 in-band (per-format error frames) instead of closing silently
- **Command Code**: preserve images and `reasoning_effort` on `/alpha/generate`; retry transient stream errors and avoid fake stop chunks; add Quota Tracker support
- **Zed**: harden OAuth lifecycle (preserve `systemId`, renew proxy timeout), support live model resolution, and lower display priority in OAuth list
- **Antigravity**: scope cached thought signatures to model family; strip Claude Code billing headers from system prompts; sanitize Hermes system identity
- **Codex**: route bare `codex-auto-review` requests to the Codex provider (#4135)
- **Auth**: do not cool down an account for request-scoped 4xx errors
- **Usage**: improve DeepSeek credit balance display as currency credit instead of 0/total quota bar
- **Model Catalog**: scope synced catalog to gateways and declare vision capabilities for DeepSeek V4.1-Flash IDs

# v0.5.75 (2026-09-10)

## Features
- **Video**: add OpenRouter and Vertex AI (Veo) video generation on `/v1/videos/*` via a provider adapter layer; poll requests resolve their provider from `x-connection-id` or `?provider=`
- **Antigravity**: add weekly quota tracking (Gemini weekly / Claude & GPT weekly) and free-tier handling from `retrieveUserQuotaSummary` (#3892)
- **Codex**: add GPT Image 2.5, Flare and Sunburst image models with multi-image support; add the same ids to the OpenAI catalog
- **Qoder**: surface usage to all clients and stop inlining large attachments — images upload through `/api/v2/image/upload` like qodercli, oversized file blocks become stubs, context tier auto-escalates
- **OpenCode Go**: add newly published models (glm-5.3, kimi-k3, deepseek-flash, longcat-2.0, hy4-preview, hy3 on chat/completions; qwen3.8-max, qwen3.8-flash on `/messages`; grok-4.6, gpt-5.6-luna on Responses) and list `deepseek-v4.1-flash` first in the catalog
- **CLI tools**: group the model selector by provider with full-text search and manual custom model ID entry
- **CodeBuddy-CN**: replace `deepseek-v4-flash` with `deepseek-v4.1-flash`

## Fixes
- **Tools**: scope Claude tool type defaulting to gateways declaring `requireClaudeToolType` — the global default broke Anthropic-compatible endpoints that only accept the legacy typeless tool shape (#3905)
- **Claude**: cap re-anchored `cache_control` at the 4-marker budget so a spent budget no longer 400s and triggers a full combo failover; wrap bare single-object content turns before the mid-conversation-system fold
- **Cline / Airforce**: unwrap the `{"success":true,"data":…}` envelope on non-stream chat completions (#3644); add the live Cline/ClinePass model catalog and refresh Airforce free models
- **Cline**: stop `workos:`-prefixing ClinePass API keys (401 on every request, #2333) and add clinepass token refresh
- **Kiro**: never send a top-level `systemPrompt` (`400 REQUEST_BODY_INVALID`); route requests through current runtime surfaces (#3776)
- **Codex**: strip Unicode-property tool schema patterns the validator rejects (#3922); restore the `Version` header and single-source the CLI version
- **DeepSeek**: keep Anthropic-only tool types when forwarding to `/anthropic/v1/messages`
- **Qoder**: drop the Responses usage plumbing from shared translator/handler code, which changed token accounting for every provider, not just Qoder
- **Antigravity**: normalize contents and handle intermediate tool responses; protect the OAuth token-refresh path from Google anti-abuse rate limits (#3813)
- **Providers**: clear stale connection health state (`modelLock_*`, `backoffLevel`, `rateLimitedUntil`, `errorCode`) when a connection is re-validated (#3810, #3830); remove the duplicate `qwen` provider that shadowed `alims-intl`
- **Video / Vertex**: reject job ids and model ids that would escape the request URL path (SSRF)
- **Usage**: parse the Fable weekly limit from `limits[]` instead of fabricating a row (#3847)
- **Auth**: set a 24h `maxAge` on the dashboard session cookie
# Unreleased

## Features
- **Providers**: add OrcaRouter (`orcarouter.ai`) — OpenAI-compatible gateway routing to OpenAI, Anthropic, Google, DeepSeek, Qwen, Kimi, GLM, MiniMax & more at provider cost; seeds current-gen models only (GPT 5.6 series, `orcarouter/free` / `orcarouter/fusion*` routers, the $0 free pool), plus embeddings/TTS/image endpoints and live `/v1/models` catalog fetching with older ids available on demand
- **Capabilities**: resolve OrcaRouter router ids (`orcarouter/fusion*`, `orcarouter/free`) and its legacy `deepseek-chat`/`deepseek-reasoner` aliases (1M V4-Flash) with real catalog specs scoped to the provider; add `gpt-image-1.5`/`gpt-image-1-mini` to the canonical image-model table
- **Dashboard**: fix suggested-models fetch for generic OpenAI-shaped catalogs (`openai` filter type was unregistered — tokenrouter, venice, vercel, perplexity-agent silently returned nothing); only catalogs whose filter actually selects $0 models are labeled "Suggested free models" now, free ids sort first, and ctx-less entries no longer render "NaNk ctx" tooltips

# v0.5.69 (2026-09-05)

## Features
- **Codex**: add GPT 6.0 Astra (`gpt-6-astra`) with vision, thinking and search capabilities
- **Usage**: add Claude Fable quota tracker support with weekly window normalization (`weekly fable (7d)`)
- **Dashboard**: group Antigravity Gemini and Claude quotas in Quota Tracker, prune stale hidden keys
- **OpenCode Go**: add `muse-spark-1.3-contributor` model and support parallel tool calls on Responses path (#3819)
- **Providers & Models**: align CodeBuddy-CN catalog/capabilities with server config; add GPT-5.6 Sol, Terra, Luna image aliases on Codex (#3806); refresh Qoder catalog with capability mapping and image pass-through
- **CLI tools**: replace Copilot MITM with VS Code extension setup guide
- **Gemini**: persist and replay `thoughtSignature` scoped by session namespace

## Fixes
- **Claude**: normalize adaptive auto effort (`output_config.effort`) (#3792)
- **Antigravity**: prevent Google anti-abuse rate limits during multi-account refresh (#3813)
- **Anthropic-compatible**: forward Claude beta flags to nodes fronting Anthropic (#3797)
- **Dashboard**: dynamic mode label for local/remote detection (#3801)
- **Codex**: format reset credit API errors cleanly (#3778)
- **Security**: guard cowork MCP tools probe against SSRF (#3783)
- **OpenCode Go**: track OpenCode Go quota (#3791) and send stable session headers (#3800)
- **Logger**: suppress noisy background token refresh logs
- **CLI**: export packed `.tgz` directly into workspace root instead of parent directory

# v0.5.65 (2026-09-03)

## Features
- **Fetch**: add Ollama Cloud web fetch provider
- **Gemini / Antigravity**: add Gemini 3.8 Flash support and bump IDE fingerprint to 2.11.0
- **Claude**: add Claude Fable 5.1 support (adaptive thinking with `output_config.effort`), bump Claude Code fingerprint to 2.1.258 for new-model access
- **Providers**: add client-side status filter (All / Active / Inactive / No connection) on the Providers dashboard; add max height and scroll for connection list
- **Providers & Models**: streamline tokenrouter model catalog down to 22 flagship/newest models and add missing provider icons; refresh Codebuddy-CN catalog (add hy4-preview/hy3/glm-5.3/kimi-k3-1, drop EOL glm-5.0/glm-4.7)
- **Models**: capability toggles (vision, reasoning) when adding custom models with upsert and live caps refresh
- **CLI tools**: support saving and managing custom API key presets
- **Quota**: add usage and rate-limit tracking for Groq via `x-ratelimit-*` headers
- **i18n**: complete Indonesian translation (1391 keys)

## Fixes
- **Security**: close SSRF guard bypasses in `ssrfGuard.js` (alternate IPv6 encodings, hostname trailing dots, wildcard DNS resolution check, safe redirect handling) (#3714)
- **Model markers**: strip the `[1m]` context marker Claude Code appends to model names (`claude-opus-5[1m]`) preventing model resolution failures (#3690)
- **Claude**: drop `server_tool_use` blocks carrying foreign IDs to avoid Anthropic 400 rejections; never anchor cache breakpoints on `defer_loading` tools (#3567)
- **Antigravity**: strike-break optimistic quota readings that keep 429ing by blocking the connection+model pair for 15m after 3 strikes (#3681); preserve client identity on model catalog requests (#3414)
- **Auth**: protect root `/responses` rewrite requiring API key validation in dashboardGuard
- **Chat & Docker**: return 503 Service Unavailable when all credentials are rate-limited; explicitly bundle `node-machine-id` into standalone Docker runtime image
- **OpenCode**: route Muse Spark models to `/zen/v1/responses` and declare vision support; filter inactive free model
- **Kiro**: preserve inline images as OpenAI-compatible `image_url` parts in OpenAI MITM; remove redundant top-level `systemPrompt` from payload
- **Usage**: read Responses-shape `cached_tokens` in `extractUsageFromResponse` for non-streaming traffic
- **Models**: support single model lookup with provider-prefixed IDs (e.g. `cc/claude-sonnet-5`)
- **Translator**: route Gemini thinking through `reasoning_effort` on OpenAI-compatible wire; convert `prefixItems` and ensure array items in Gemini schema sanitizer
- **UI**: apply persisted theme before first paint to prevent flash on reload; translate combo vision adapter label

# v0.5.59 (2026-08-29)

## Features
- **Search**: new web search providers — Antigravity (Google Search grounding
  on the existing OAuth account pool, citations keyed and merged by URL) and
  Xquik (X search with `x-api-key` auth, cursor pagination, credit-based
  usage), both on `POST /v1/search`. Based on #3437 by @Nautilaceae
- **Search**: ollama-search and zai-search borrow a chat provider's API key
  instead of requiring their own connection, driven by a new
  `credentialFallback` registry field. zai-search later folded into the `glm`
  provider itself so the web search page shows the shared connection
- **Models**: daily background sync of model capabilities from models.dev —
  modalities keyed by model id (majority of sources must declare one),
  context/output limits keyed by provider + model, strictly additive and
  sitting below the hand-written tables. ETag + mtime cache, 60s startup
  delay, `MODEL_CATALOG_SYNC=off` to disable
- **Models**: add GLM-5.3-Flash (1M context, natively multimodal), DeepSeek
  V4 Vision, Grok 4.5/4.6 (500k context); correct glm-4.6v/4.5v video input
  and output limits, backfill glm-4.6v on glm-cn
- **Usage**: show the Zed plan quota on the dashboard — plan, edit
  predictions, hosted model requests and billing-cycle reset; unlimited rows
  render as "N used · Unlimited"
- **Usage**: track GPT-5.3-Codex-Spark quota windows (spark_session /
  spark_weekly) from the Codex usage response (#3431)
- **Antigravity**: quota-aware routing — on 409/429 fetch live quota for the
  exact per-model resetAt and skip only the exhausted account/model pair;
  report the earliest reset when every account is blocked (#3561)
- **Antigravity**: map image `size` to the aspect-ratio model suffix (-WxH);
  add the Gemini 3.7 Flash tiers to MITM defaultModels so they show up in
  the dashboard model-mapping table
- **Dashboard**: bulk import Grok CLI accounts from JSON — paste an array or
  drag-drop multiple .json files, all OAuth connections created in a single
  call, mirroring the codex flow
- **CLI tools**: endpoint presets shared across every tool card through one
  live-resyncing store, instead of per-card localStorage copies that never
  saw each other's saved endpoints
- **Token Saver**: configurable compression timeout (`headroomTimeoutMs`) —
  the fixed 3000 ms made busy machines time out and send inconsistently
  compressed bodies, hurting prompt caching
- **i18n**: pt-BR expanded to 1132 terms

## Fixes
- **Claude Code**: add Claude Fable 5.1 and advertise Claude Code 2.1.258 in
  both the request header and billing identity; use its permanent adaptive-thinking
  mode with `output_config.effort`
- **Stream**: record usage when a client closes on the terminal event — the
  Responses API has no [DONE] sentinel, so codex closed the socket on
  `response.completed` and cancelled the reader before flush() ran its usage
  side effects; the tail now lives in a once-guarded finalizeStream(). Also
  stop logging a disconnect for every completed Responses call
- **Stream**: parse the trailing NDJSON line an Ollama stream leaves behind
  without a closing newline — the final chunk carrying `done_reason` and the
  token counts was dropped
- **Session**: read the Claude Code session id from the
  `x-claude-code-session-id` header — `metadata.user_id` is dropped by
  Responses translation, splitting one conversation across several
  `prompt_cache_key` values and missing the upstream prefix cache
- **Usage**: preserve nested `cached_tokens` — the top-level-only read
  persisted `cached_tokens: 0` for every Responses-format provider (codex,
  grok-cli, …), billing cache hits at the full input rate
- **Usage**: GLM quotas accept CREDIT_LIMIT plans and multi-interval windows
  (5h session / 7d weekly) instead of overwriting a single "session" key
- **Models**: the catalog sync no longer erases its own output — deltas were
  measured against the previous run's writes (the second run cut `providers`
  from 20 entries to 5); one vote per provider in the modality tally, ETag
  restored from file on startup, and the worker thread dropped after the
  bundler rewrote its path into a module-not-found error
- **Executor**: CommandCode returns errors as a `type:"error"` event inside
  an HTTP 200 NDJSON stream — peek the first events before committing, abort
  and return a real 4xx/5xx so combo/account fallback triggers instead of
  streaming the error text as content
- **Search**: scope failure locks on the credential-fallback path — a failing
  search locked `modelLock___all` and took the shared glm key offline for
  chat as well; locks are now attributed to the connection's owner and
  scoped to `websearch:<provider>`
- **Providers**: connection tests get a 15s AbortSignal timeout instead of
  hanging and exhausting the browser socket pool; guard undefined provider
  names on the providers page
- **Antigravity**: sanitize competing-client branding via a config-driven
  rule table (Zed's Claude-agent prompt, opencode → antigravity) — upstream
  answers 429 Quota Exhausted. Applied in the executor so the shared
  openai-to-gemini translator leaves gemini/vertex/zed untouched
- **MiniMax**: preserve images on the sourceFormat-matched OpenAI transport
  — MiniMax-M3 resolved a Claude-shaped body posted to the OpenAI endpoint,
  silently dropping `image_url` blocks (#3418)
- **Claude**: decloak tool names in same-format streaming passthrough —
  OAuth-cloaked names (CLAUDE_TOOL_SUFFIX) leaked to the client and every
  tool call was rejected as unknown
- **Tools**: default a missing `tools[].type` to "custom" on Claude-format
  requests — strict Anthropic-compatible gateways (MiniMax) reject the
  request with 400 otherwise
- **Translator**: zai thinkingFormat sends the top-level `reasoning_effort`
  object GLM-5.2+ requires — every GLM-5.x request ran at the model default
  (max); gated on GLM-5.2+ since older GLM does not read it (#2721)
- **RTK**: system prompt injection matches each target wire format
  (Chat/Responses/Claude/Gemini/Kiro) and is exact-idempotent across retries,
  so distinct prompts sharing a long prefix are no longer collapsed (#3202).
  Also set the diagnostic before the silent null return on Responses
  translation failure so the panel is no longer blank
- **OpenCode**: route muse-spark through /zen/v1/responses (it 500s on
  chat/completions), normalizing the Chat fields the Responses API rejects
  and clamping max/ultra effort to xhigh
- **CLI**: install better-sqlite3 without build tools on Node 22+ (N-API
  13.0.3 ships per-platform prebuilds, `--ignore-scripts` skips the implicit
  node-gyp build); Node < 22 stays on 12.6.2, working installs untouched
- **CLI tools**: send the API key Codex actually reads —
  `[model_providers.9router.http_headers]` instead of auth.json (which left
  every request 401 and clobbered an existing ChatGPT login); subagent model
  moved to `agents.default_subagent_model`
- **OAuth**: refresh Cline tokens with the extension JSON contract
- **Dashboard**: clamp the API key mask length — keys shorter than 8 chars
  threw RangeError and crashed the media-provider detail page
- **UI**: wait for the Material Symbols font itself before revealing icons —
  `document.fonts.ready` resolved before the 4MB woff2 even started loading,
  leaving icons blank until a second load

# v0.5.55 (2026-08-14)

## Features
- **Auth**: native SAML 2.0 SSO alongside OIDC — AuthnRequest generation, ACS
  assertion handling, SP metadata export, admin config test, replay-protected
  via a `saml_state` cookie matched against `InResponseTo`
- **Providers**: add Alibaba Token Plan (`token-plan.ap-southeast-1`) — the
  fourth Alibaba key type, Singapore-only and OpenAI-compatible transport only
- **Providers**: add `glm-5.3` to GLM Coding and GLM (China)
- **Providers**: Kimchi accepts API keys as well as OAuth (dual auth), with a
  working Test Connection for both modes
- **Antigravity**: add Gemini 3.7 Flash and its tiered high/medium/low variants
  (also in the Gemini registry) with pricing and quota tracking
- **TTS**: add Fish Audio — model id travels in an HTTP `model` header, voice
  is a `reference_id` (preset or cloned voice model)
- **OpenCode-Go**: route by request format via declared transports instead of
  forcing every client into `/messages` — Codex/OpenAI clients no longer pay a
  lossy Responses→OpenAI→Claude double translation. Per-model `supportedFormats`
  guard; the bespoke executor is gone (its shared `_lastModel` cache could cross
  auth headers between concurrent requests)
- **Usage**: dedup + cache Claude quota calls (120s TTL keyed by access token,
  in-flight promise dedup, last-good read on soft failure) to stop multiple
  tabs tripping 429; manual refresh (↻) sends `force=1` to bypass the cache

## Fixes
- **Docker**: ship `sql.js` in the image so the pure-JS DB fallback can start —
  file tracing carried the package's JS without `dist/sql-wasm.wasm`, so a
  container with no native driver aborted with ENOENT and never got a database
  (#3248)
- **Usage**: read Gemini `usageMetadata` out of the antigravity `{ response }`
  envelope — every non-streaming antigravity request logged `IN 0 | OUT 0`
  (#3260)
- **Claude**: re-anchor passthrough cache breakpoints — the client's own
  `cache_control` markers point at pre-normalization offsets, so the tail was
  re-cached every request. Last system block and last tool pinned at 1h TTL,
  last assistant turn at 5m, mid-conversation system messages folded into the
  neighbouring user turn instead of hoisted into `body.system`
- **Combos**: detect images from Hermes and attachment payloads (`images[]`,
  `experimental_attachments`, message-level `image_url`/`audio_url`, inline
  `data:` URIs) so the Vision Adapter auto-switch fires for Hermes/Ollama/
  Vercel AI SDK shapes
- **Kiro**: intercept chat via `x-amz-target` — Kiro IDE 1.0.228+ moved
  `GenerateAssistantResponse` to `POST /` + header, bypassing MITM. Also emit
  the now-mandatory initial-response frame and map the `auto` model slot
- **Kiro**: report real output tokens and stop discarding usable turns
- **Qoder**: detect billing blocks at stream start and return a synthetic 403
  so combo/account fallback triggers instead of leaking the error into chat
- **Antigravity**: strip competitive system prompts (Zed IDE's Claude-agent
  prompt) that Antigravity flags with a 429 Quota Exhausted
- **OpenCode**: send the official client fingerprint on free-tier requests so
  the Console stops classifying traffic as unidentified and rate-limiting it;
  session id resolves conversation-stable to preserve prompt caching
- **Responses**: don't close the message on an empty `tool_calls` array — some
  providers attach one to every chunk, and the truthy check ended the message
  on the first content token (#3234)
- **Translator**: preserve `prompt_cache_key` when converting chat to responses
- **Models**: expose snake_case token limits on `/v1/models`
- **Combos**: strip `stream_options` from the Fusion panel fan-out to avoid a
  DeepSeek 400 (#3024); raise the dashboard model-test probe budget to 1024 and
  soft-pass reasoning-only responses (#3010)
- **Headroom**: the toggle reflects the `headroomEnabled` setting even when the
  proxy is down — it previously showed OFF while the engine kept calling
  `/v1/compress`; proxy status stays visible via the status chip
- **Hermes**: add the `api_key` parameter to the model block in YAML config
- **Providers**: add llm7 to provider test support

## Docs
- **i18n**: add Spanish, French, and Brazilian Portuguese README translations

## Security
- **Real IP**: `x-9r-real-ip` and the Host fallback were trusted from
  client-controlled headers whenever `custom-server.js` was not in the request
  path (`npm run start`, `start:bun`), letting a remote caller pose as local to
  skip API key auth and reach `LOCAL_ONLY_PATHS` (`/api/mcp/*`,
  `/api/tunnel/enable`, `/api/auth/reset-password`). The server now stamps a
  per-process `x-9r-peer-token` on every request it sanitizes and only trusts
  `x-9r-real-ip` behind it — falling back to Host in development and failing
  closed in production (GHSA-pjm4-8fpg-f9p6). Also fixes IPv6 loopback
  detection (`::1`, `::ffff:127.0.0.1`) and routes `npm run start` /
  `start:bun` through `custom-server.js`
- **Search**: `resolveBaseUrl()` rejects client-supplied non-public baseUrls
  (SSRF guard on `/v1/search`)
- **Login**: fresh-install remote login with the default password returns 403
  without issuing a JWT
- **Usage**: `/api/usage/request-details` redacts request/response payloads

# v0.5.50 (2026-08-05)

## Features
- **Providers**: add TokenRouter (300+ models via OpenAI-compatible gateway) with
  exact per-model pricing for 110 models and `reasoning_effort` thinking config
- **Providers**: add Self-hosted STT / TTS / Embedding — point 9Router at your own
  OpenAI-compatible speech and embedding servers (whisper.cpp, faster-whisper,
  Kokoro-FastAPI, llama-server, vLLM, Infinity). Unlike the named cloud providers
  these read `baseUrl` per connection, so one provider can front several machines
- **Combos**: default-enable vision/audio capacity adapter (auto-routes to a
  vision/audio-capable model when the target lacks that capability, falling back
  to `oc/mimo-v2.5-free`), wired into chat handler routing
- **Endpoint**: auto-provision a "Default Key" for first-time users so `/v1`
  works without a manual dashboard step
- **Codex**: support GPT-5.6 Max/Ultra reasoning-level overrides (cx/ routes only)
- **Qoder**: support PAT (Personal Access Token) connections end-to-end, alongside
  OAuth device flow
- **CLI tools**: add OpenDesign (manalkaff/opendesign) support
- **Headroom**: report effective payload savings (tool schema/history bytes broken
  out, byte-savings % reflects actual outbound reduction)
- **Ollama**: Cloud quota tracker (session + weekly) + proactive background OAuth
  token refresh scheduler for all providers

## Fixes
- **Providers**: remove Qwen (OAuth flow stopped working reliably)
- **Passthrough**: detect codex-tui/Codex Desktop as native Codex client — they
  were falling through to the translator and losing fields like `reasoning.summary`
- **OAuth**: scope antigravity header fixes to loadCodeAssist/onboardUser only
- **OAuth**: keep `open` external in the build so xAI/Grok token refresh works on
  Windows
- **OAuth**: declare missing `searchParams` in register-session handler (was a
  500 instead of JSON on error)
- **DB**: `ENABLE_REQUEST_LOGS` env var now overrides the UI setting correctly;
  observability defaults to off (opt-in)
- **Translator**: preserve Codex Responses Lite tool use across chat-native
  OpenAI-compatible providers
- **Translator**: don't drop image-only user messages in `prepareClaudeRequest`
- **Translator**: drop JSON Schema keywords Gemini rejects (`uniqueItems`,
  `contains`, `multipleOf`, `unevaluatedProperties`, `unevaluatedItems`,
  `contentSchema`)
- **Claude**: remove global header cache that leaked one client's identity
  headers onto another client/account sharing the server; gate `anthropic-beta`
  by model instead
- **Antigravity**: drop retired Gemini 3.0 quota tiers, show Gemini 3.6 Flash
  usage bars
- **Cloudflare AI**: declare API key authentication (dashboard showed "No
  connections" despite an active key)
- **GitHub Copilot**: hold monthly-exhausted accounts until UTC month reset
  instead of only cooling down 120s
- **CodeBuddy**: dodge Tencent CN content filter, add usage tracking, normalize
  codebuddy-intl messages
- **Usage**: stop losing cached prompt tokens in the forced-SSE→JSON path
- **Grok CLI**: display the public subscription tier from the OAuth token claim
- **Providers**: count apikey connections for Ollama free-tier card; free-tier/
  apikey providers without `authModes` now default to apikey (were treated
  oauth-only)
- **Build**: include static/public assets in standalone output (login page hung
  on 404s when run via PM2)
- **Server**: support IntelliJ IDEA OpenAI-compatible clients over HTTP (h2c
  upgrade handling)
- **Auth**: redirect already-logged-in sessions away from `/login`
- **CLI tools**: enable Apply button for dynamic OpenAI/Anthropic-compatible
  provider connections
- **CLI**: include complete API artifacts in the CLI package
- **TTS**: a bare self-hosted model name is the MODEL, not the voice — `kokoro`
  was parsed as a voice against a default model, 404ing or synthesising with the
  wrong one
- **Embeddings**: self-hosted embeddings no longer fall back to `api.openai.com`
  when a connection has no `baseUrl` — that silently sent the input text and API
  key to OpenAI under a provider named "Self-hosted"
- **Embeddings**: an adapter that rejects a misconfigured connection now returns
  400 with the reason instead of escaping the handler uncaught
- **Embeddings**: bound the upstream fetch with `FETCH_CONNECT_TIMEOUT_MS` — an
  endpoint that drops packets never returns headers, so the request previously
  hung indefinitely

## Docs
- **i18n**: fix port typo, add RTK Token Saver feature descriptions

# v0.5.45 (2026-07-30)

## Features
- **TTS**: add Xiaomi MiMo text-to-speech (preset voices 冰糖/茉莉/苏打/白桦/Mia/Chloe/Milo/Dean, style control, language hint dropdown with Auto-detect, i18n for Style label/placeholder)
- **Providers**: add Poolside (OpenAI-compatible)
- **Providers**: add api-airforce, baidu, bazaarlink, bluesminds, kilo-gateway, llm7, morph, sambanova, tencent
- **OAuth**: zed / trae / windsurf providers + harden callback proxies
- **CLI tools**: set Claude Code max context tokens
- **Qoder**: PAT auth + refresh model list
- **Gemini**: Gemini 3.6 Flash tier routing + Gemini 3.5 Flash Lite
- **Claude**: bump default Opus to `claude-opus-5`
- **Kiro**: add Claude Opus 5 models
- **Usage**: Kimi and DeepSeek usage handlers
- **Usage**: SuperGrok weekly pool via gRPC-web

## Fixes
- **Refresh**: rotate `refresh_token` between retry attempts
- **Kiro**: canonicalize tool history and route API keys correctly
- **Kiro**: normalize dashboard thinking intensity models
- **Cursor**: stop leaking agent tool errors as text
- **Gemini**: fill empty tool schemas after `$ref` strip
- **Antigravity**: strip `stream_options` from non-stream requests
- **Jina-reader**: recover after transient errors, use JSON POST API
- **Usage**: record exact embedding tokens
- **Tunnel**: preserve successor cloudflared PID
- **Console-log**: initialize capture at server boot + prevent SSE proxy buffering
- **Dashboard**: count dual-auth, free-tier OAuth and API-key connections correctly
- **Dashboard**: flex quota rows, thin global scrollbars, no hidden-row overflow

## Docs
- **i18n**: expand pt-BR translation to 986 terms
- README: Indonesian translation

# v0.5.40 (2026-07-20)

## Features
- **i18n**: add Khmer (km) translations
- **CLI tools**: configure Grok Build subagent models
- **Kimi**: merge OAuth into dual-auth provider, add K3 / K2.7 models
- **Dashboard**: ProviderTopology flow animation

## Fixes
- **DB**: resolve better-sqlite3 parameter binding crash
- **Translator**: pass `service_tier` through OpenAI → Responses conversion
- **Kiro**: map GPT-5.6 reasoning effort fields
- **Kiro**: validate terminal streams before emitting output
- **Kiro**: map GPT reasoning effort fields
- **Codex**: current `client_version` + refresh-aware model sync
- **Alicode-intl**: split into Coding Plan + Model Studio providers
- **Cursor**: HTTP/2 AgentService support + version bump 3.12.17
- **Dashboard**: cut duplicate API/icon spam, lazy-load provider assets


# v0.5.35 (2026-07-16)

## Features
- **xAI**: Grok Imagine video generation (`/v1/videos`) + CLI
- **CLI tools**: Grok Build setup — choose separate main/general-purpose/explore/plan models and preserve each model's context window
- **GitHub Copilot**: route Claude models through Copilot's native `/v1/messages`
- **Kiro**: add GPT-5.6 model family (#2596)
- **RTK**: `X-9Router-Token-Saver` header to bypass token savers per request
- **Providers**: quota visibility settings
- **Translator**: drop temperature for all Claude models
- **i18n**: Thai (th) + Persian (fa) translations / README

## Fixes
- **Providers**: bulk-add API keys no longer overwrite existing keys (gap-fill `Key N`)
- **Anthropic**: lowercase `anthropic-version` header to prevent duplication on `/v1/messages`
- **Alicode-intl**: use DashScope compatible-mode endpoint so standard keys work
- **Grok CLI**: align Grok Build with current subscription protocol (#2590)
- **Grok CLI**: surface `expiresAt` so proactive token refresh fires (#2546)
- **Kiro**: improve direct session cache reuse
- **Models**: populate capabilities for live-catalog LLM models
- **Models**: list compatible provider models in `/v1/models`
- **Thinking**: send explicit `thinking:{type:adaptive}` alongside `output_config.effort`
- **Translator**: strip `client_metadata` when converting openai-responses → openai

## Improvements
- **Perf**: skip inactive background services on startup

## Docs
- README: Persian YouTube tutorial

# v0.5.30 (2026-07-10)

## Features
- **Perplexity**: add Agent API provider (#2492)
- **Grok CLI**: add Grok CLI / Grok Build provider with OAuth device-code flow (#2502)
- **Featherless**: add OpenAI-compatible provider presets
- **SearXNG**: configure endpoint via SEARXNG_URL env (#2499)
- **Providers**: add max thinking level for gpt-5.6-sol (#2500)
- **Headroom**: add extras detection and install UI (#2403)
- **Headroom**: activate/uninstall extras + fix interpreter detection
- **PXPipe**: PXPIPE token saver — multimodal prompt compression (#2465)
- **Proxy-Pools**: auto-rotate strategy for no-auth providers (#2409)

## Fixes
- **Cloudflare-AI**: support accountId in bulk key import (#2449)
- **DB**: backup on schema change, MCP child cleanup, codex models, usage providers OOM
- **Codex**: avoid bare-email OAuth dedup (#2477)
- **CLI**: allow staged app bundle builds (#2479)
- **Headroom**: compress Kiro conversation state (#2488)
- **Gemini-CLI**: raise output floor for thinking and add validated toolConfig (#2486)
- **GitHub**: label Copilot profiles by account identity (#2498)
- **OpenAI-to-Claude**: unwrap bare {function:{…}} tools without parent type (#2473)
- **Translator**: clamp thinking effort max->xhigh for OpenAI format (#2466)
- **RTK/find**: detect and group Windows backslash-style find output (#2448)
- **Codex**: handle fast tier and capacity SSE (#2452)
- **Volcengine-ark**: clamp Kimi max_tokens to 32768 endpoint cap
- **Antigravity**: align provider fingerprint with IDE Desktop 2.1.1 (#2389)
- **Pricing**: update Claude/Codex model rates and add new models

## Improvements
- **i18n(zh-CN)**: complete Chinese translations for all UI strings (#2436)
- **API**: caching for tunnel and version status endpoints
- **Perf**: faster dev startup and lighter bundle

# v0.5.20 (2026-07-07)

## Features
- **Thinking**: per-model thinking level picker on provider page — appends `(level)` suffix to copied model names for forced reasoning effort across all formats (openai, claude, gemini, deepseek, kimi, qwen, zai, minimax, hunyuan, step)
- **RTK**: add JS-native git-log filter (#2423)
- **Caveman**: add targeted upstream-aligned style rules (#2424)
- **i18n**: add Farsi (fa) language support (#2385)

## Fixes
- **Thinking**: strip `(level)` suffix from upstream `body.model` so providers no longer reject requests
- **Translator**: preserve developer instructions in openai-responses conversion (#2434)
- **count_tokens**: count structured Anthropic blocks (#2419)
- **Volcengine-ark**: clamp GLM-5 max_tokens to model output ceiling (#2428)
- **Kimi**: normalize reasoning_effort to backend enum (#2427)
- **Claude**: reconcile max_tokens vs thinking budget and lift per-model ceiling (#2381)
- **Kiro**: deliver system prompt natively, add Opus 4.5/4.7/4.8, tolerate dash version ids (#2366)
- **Headroom**: proxy dashboard through app (#2372)
- **MITM**: recover from stale lock file on server start

# v0.5.18 (2026-07-03)

## Features
- **Usage**: track cached tokens + correct input/output/cache cost (#2209) — hodtien
- **Codex**: show reset credit expiry details (#2290) — Rafli Ahmad Zulfikar
- **NVIDIA**: add new models and capabilities — decolua
- **ClinePass**: add provider support — sternelee

## Fixes
- **Usage**: dedupe streaming request-details log entries — Qin Li
- **Claude**: drop foreign thinking signatures in passthrough — decolua
- Prevent non-SSE stream pipe crash and cross-IdP account overwrites (#2244) — KunN-21
- **Kiro**: route IdC auth to regional CodeWhisperer surface (#2297) — Volodymyr Saakian
- **Kiro**: add Claude Sonnet 5 model support (#2264) — Edison42
- **Xiaomi-tokenplan**: region selector, key validation, multi-connection (#2251) — MiQieR
- **Translator**: strict Anthropic content block compliance (#2225) — Sahrul Ramadhan Hardiansyah
- **Kimchi**: strip reasoning_content echo to bound multi-turn input tokens — KunN-21
- **Kimchi**: bump User-Agent to kimchi/0.1.40 (#2256) — Ansh7473
- **Codebuddy-cn**: strip empty tool_calls arrays to preserve reasoning — zmf
- **Antigravity**: preserve Claude tool delta index (#2223) — Sutarto Jordan Chrisfivo
- **MITM**: generate root CA on server startup (#2228) — Sutarto Jordan Chrisfivo

# v0.5.15 (2026-06-29)

## Features
- Add Kimchi OAuth provider — Nant361
- Refine Qwen vision/video + thinking model patterns — decolua
- Opt-in Codex auto-ping quota keep-alive — Emirhan

## Fixes
- **Responses**: handle response.done terminal events (#2142) — rifuki
- **Headroom**: skip unsafe responses tool history (#2132) — Sutarto Jordan Chrisfivo
- **Translator**: map mid-conversation system message to user (claude→openai) — decolua
- **Gemini**: normalize contents to prevent 400 invalid_argument (#2192) — warelik
- **Gemini**: backfill thoughtSignature + suppress stream done sentinel — WARELIK
- **Alicode**: preserve cache_control for DashScope providers (#2069) — Rex
- **Antigravity**: strip deprecated/readOnly/writeOnly from tool schemas — iletai, Yudhistira-Official
- **CodeBuddy CN**: show bonus packs as one-time, not monthly-replenishing — whale9820
- **Kiro**: strip leaked <thinking> tags from content stream (#2158) — hamsa0x7
- **Tray**: make Windows context menu DPI-aware — Emirhan
- **Kilocode**: expose full gateway catalog in combo model picker — jellylarper
- **OpenCode**: fix Go GLM — decolua

# v0.5.12 (2026-06-26)

## Features
- Add token-saver dashboard page — decolua
- Add bulk delete for provider connections — teddytkz
- Resolve GitHub Copilot model catalog from upstream — caiqinzhou
- Add Venice AI provider — Brokenc0de
- Add Kiro external_idp import for Microsoft SSO (CLIProxyAPI) — Stevanus Pangau
- Overhaul Blackbox provider catalog + WebUI test support — suryacagur

## Fixes
- Provider thinking compatibility (DeepSeek/Gemini) — Mink Nguyen
- Stop double-counting streaming usage at source — decolua
- Usage logging dedupe to reduce stats churn — Mink Nguyen
- Prevent non-JSON SSE lines / duplicate [DONE] from breaking clients (PR #2046) — qianze
- Resolve Gemini TTS models from catalog — nguyenha935
- Support Kiro IDC (organization) token import — quanturbo
- Preserve forced streaming for JSON clients (#2031) — Joseph Yaksich
- Preserve Responses text format (Codex) — tenglong
- Support Gemini native TTS generateContent endpoint — nguyenha935
- Add missing zh-CN endpoint key label (i18n) — weimaozhen
- CodeBuddy: only send reasoning params when client requests reasoning (#2071) — Rex
- CodeBuddy CN: show one-shot bonus packs as expiring, not monthly-replenishing
- Show custom provider models in combo picker — Sapto
- Docker: add docker-compose.yml with headroom enabled by default — nitsuahlabs
- Clarify token diagnostics vs provider billing (headroom, #1998) — Sutarto Jordan Chrisfivo
- Translate openai-responses input through OpenAI for compression (#1998) — Ankit
- Kiro: report 1M context window for claude-opus-4.8 — EdisonPVE
- Avoid stale redirects after auth changes (#2100) — Emirhan
- Mark Claude Opus 4.7 (dashed id) as 1M context — Brokenc0de
- Preserve reasoning effort through Codex translations — ntdung6868
- Token-saver: full width card layout — decolua
- Antigravity: retry transient upstream failures — Sutarto Jordan Chrisfivo
- Param-support: handle strip rules without match/drop (#1960) — Joseph Yaksich
- Translator: resolve custom provider prefix in debug endpoint (#1083) — hamsa0x7

# v0.5.8 (2026-06-21)

## Features
- **Antigravity**: native image generation support (image models tagged kind:image, hiển thị trong media-providers UI)
- **CodeBuddy CN**: API key auth + credit quota tracker
- **CodeBuddy CN**: short model prefix alias "cbcn"

## Fixes
- **MiniMax-M3**: enable vision capability
- **Headroom**: support Docker sidecar proxy
- **Antigravity**: image executor fixes
- **mimo-free**: Chrome User-Agent rotation to bypass anti-abuse gate
- **cloudflare-ai**: flatten content-part arrays to string to avoid oneOf 400 (#1926)
- **Translator**: normalize tools to Anthropic-native shape for non-Anthropic providers
- **CLI**: handle Next.js 16 nested standalone output path (#1940)
- **Codex**: preserve custom tools during request normalization
- **next.config**: add new route for responses endpoint to API

# v0.5.6 (2026-06-20)

## Features
- **Ponytail**: minimalist code generation feature
- **Headroom**: proxy lifecycle management + dashboard UI (one-click start/stop, install detection, status probing, token saver, claude↔openai shape conversion)
- **CodeBuddy CN**: new OAuth provider (copilot.tencent.com) — 15-model catalog, /v2 inference, forced streaming, OpenAI-style reasoning
- **OpenCode-Go**: align models with official endpoints; route Qwen 3.7 MiniMax via /v1/messages, GLM/Kimi/DeepSeek/MiMo via /chat/completions

## Fixes
- **Anthropic-compatible validation**: use POST /v1/messages (GET /models not spec, false "invalid" for valid keys)
- **CLI tools**: tolerate JSONC configs in all 8 settings routes (opencode, openclaw, kilo, droid, cowork, copilot, claude, cline)
- **Gemini/Antigravity**: preserve 'pattern' in tool schema translation (glob/grep)
- **Combo/Fusion**: flatten Anthropic-style tool messages in panel calls (prevent 503)
- **Models**: store provider custom models by provider scope
- **Perplexity**: use /v1/models endpoint for key validation

# v0.5.4 (2026-06-18)

## Fixes
- **Kiro**: honor thinking effort budgets
- **AG/Kiro/Xiaomi**: provider fixes
- **Combo/Fusion**: flatten tool history in panel calls to prevent 503
- **LLM selector**: show custom vision models in selector and model list
- **Image**: prevent compatible nodes from shadowing provider aliases

# v0.5.2 (2026-06-17)

## Features
- **Combo Fusion strategy** — fans the prompt out to all member models in parallel, then a configurable judge model synthesizes one final answer (quorum-grace, anonymized sources, graceful degradation)
- **Per-combo strategy selector** — pick `fallback` / `round-robin` / `fusion` / `capacity` per combo (replaces the old round-robin toggle), with a judge picker for fusion
- **Capacity auto-switch** — reorders models per request so images/PDFs route to capable models first
- **Kiro headless API-key auth** (`ksk_`) + direct `claude↔kiro` route that avoids the lossy OpenAI two-hop pivot
- **Claude auto-ping** — warms the 5h quota window right after reset so a fresh window starts immediately (per-connection toggle)

## Fixes
- **Claude 429**: stop hammering the OAuth usage endpoint — cache resetAt, throttle quota refresh to 3 min, cool down after a 429 (chat unaffected)
- **Usage logs always empty**: missing `await` on `getAdapter()` in `getRecentLogs` made `/api/usage/logs` & `/api/usage/request-logs` return nothing
- **Executors**: strip params unsupported by the provider/model (drops deprecated `temperature` for claude-opus-4 → Anthropic 400)
- **Translator**: derive deterministic tool_call ids for gemini/antigravity → OpenAI so function call/response pair correctly (fixes tool-pairing 400s)
- **Antigravity**: strip `optional` from tool schemas before sending to Gemini
- **Claude-to-OpenAI**: handle OpenAI-format responses in the non-streaming path (e.g. xiaomi-tokenplan)
- **Usage views**: show edited connection names consistently across Providers & Quota Tracker
- **Security**: hardened reverse-proxy local-access trust
- **Security**: SSRF hardening on web fetch

## Internal
- Large **open-sse / translator refactor** (~40 commits): unified provider/model registry (LiteLLM-style `models[]` + `kind` field, 100 co-located registry files), single-sourced media/OAuth/refresh/token URLs, registry-based dispatch for usage & token-refresh, DRY translator concerns (buildUsage, encodeDataUri, finishReasonMap, chunkBuilder, reasoningDelta…), ESM-safe registry init, large-file splits, dead-code removal, and golden/no-regression test gates

# v0.4.80 (2026-06-13)

## Features
- Vercel AI Gateway: support embeddings, images and credit usage (#1183)
- Add MiMo Free no-auth provider (#1789)
- Vertex: support ADC `authorized_user` credential
- Cowork: re-enable Claude Cowork with preset-only stdio MCP
- Codex: bulk add accounts via JSON (#1719)
- Kiro: enable multi-endpoint failover for GenerateAssistantResponse (#1722)

## Fixes
- Security: re-auth on DB export/import + SSRF guard on web fetch
- Auth: real client IP rate-limiting + remote default-password guard
- Cerebras/Mistral: strip unsupported `client_metadata` from downstream requests (#1742)
- SiliconFlow: update baseUrl `.cn` -> `.com` + curate verified model list (#1760)
- Gemini-to-OpenAI: route unsigned thought parts to `reasoning_content` (#1752)
- Claude-to-OpenAI: strip Anthropic billing header from system prompt (#1765)
- Anthropic-compatible: send Bearer auth for third-party gateways (#1795)
- Usage-stats: avoid partial stats on initial SSE race (#1767)
- Proxy: use `export default` in proxy.js for Next.js 16 middleware detection
- Claude passthrough: add body normalization
- GitHub Copilot: refresh missing/expired token on models discovery (#1727) + add mappable gpt-5-mini/gpt-5.4-nano slots for Copilot MITM (#1653)
- Kiro: auto-resolve profileArn to prevent 403 on IDC login, enhance profile ARN resolution, update endpoint to `runtime.us-east-1.kiro.dev` (#1713)
- Tunnel: detect system-installed Tailscale via dual-socket probe (#1723) + non-blocking probes to prevent UI freeze
- CommandCode: force `stream=true` in transformRequest (#1706)
- Qoder: increase timeouts for reasoning models and improve stream handling
- Dashboard: show provider node name instead of connection name in topology (#1770) + show explicit `kind="llm"` combos on combos page (#1684)

## Docs
- README: add Indonesian 9Router tutorial video (#1709)

# v0.4.71 (2026-06-06)

## Features
- Caveman: add wenyan classical Chinese levels and sync upstream prompts; locale-based visibility on endpoint page
- i18n: endpoint exposure notice across multiple languages + Russian README
- Antigravity: add gemini-3.5-flash-extra-low (Low) model
- xiaomi-tokenplan: add Claude-native MiMo V2.5 Pro alias via dedicated executor
- Qoder: fetch latest model + dashboard import-model button (#1642)
- MiniMax: add MiniMax-M3 + update Quota Tracker coding/CN (#1631)

## Fixes
- Codex: harden streaming timeouts (stall/connect raised to 60s, configurable per-provider), accept `response.done` event, and always emit a terminal `response.failed` + `[DONE]` for Responses passthrough when a stream closes, stalls, or aborts before a terminal event — prevents codex clients from hanging (#1648, #1680, #1688, #1618)
- Codex: durable OAuth refresh lifecycle (#1664)
- Tunnel: skip virtual interfaces to prevent false netchange watchdog
- Claude: fix forced tool_choice 400 on cc/ OAuth route (#1592)
- Proxy: raise Next client body limit to 128MB via `NINEROUTER_PROXY_CLIENT_MAX_BODY_SIZE` (#1529, #1572)
- MiniMax: echo `reasoning_content` on follow-up turns to avoid 400 (#1543)
- Kiro: handle 400 on tool-bearing history without client tools; add mappable "auto" model slot; fix binary EventStream crash + add models & TTS tool filtering
- Antigravity: passthrough tab-autocomplete + mark default agent slot mandatory
- Qoder: allow `qmodel_latest` model key (#1638)
- Providers: restore one-connection guard for compatible/embedding nodes
- Model-test: route image/STT probes to their real endpoints, harden STT ping; add opencode-go + xiaomi-tokenplan to connection test (#1576, #1628)

## Improvements
- Dashboard: reorganize menu actions across sidebar/header/profile
- Translator: add data-driven coverage, bug-exposing cases, and real provider smoke tests

# v0.4.66 (2026-05-29)

## Features
- Add Qoder provider: device-flow OAuth, COSY signing, WAF-bypass body encoding, live model catalog, dashboard quota tracker, 11 models (#1372)
- Add new models: Claude Opus 4.8 (Claude Code), GPT 5.4 Mini (Codex)

## Fixes
- DeepSeek thinking mode: echo `reasoning_content` back on follow-up/tool-call turns so OpenCode-free and custom providers no longer 400 with "reasoning_content must be passed back" (#1543)
- Reasoning injector: match deepseek/kimi model ids case-insensitively (covers custom providers using capitalized model names)
- OpenCode suggested-models: include free models without the `-free` suffix, e.g. `big-pickle` (#1535)

## Improvements
- Codex: trim sunset models, keep gpt-5.5 / gpt-5.4 / gpt-5.3-codex family, add gpt-5.4-mini
- volcengine-ark: refresh model list (add DeepSeek-V4-Flash/Pro, drop EOL entries)
- Lower stream stall timeout 35s → 30s for faster hang detection

# v0.4.63 (2026-05-26)

## Fixes
- GitHub Copilot: never route Gemini/Claude models to the `/responses` endpoint; prevents misleading "does not support Responses API" 400s (#1062)
- proxyFetch: restore missing `Readable` import causing runtime `ReferenceError` in DNS-bypass fetch path

## Improvements
- Lower stream stall timeout from 60s → 35s for faster hang detection

# v0.4.62 (2026-05-26)

## Fixes
- Codex: auto-retry when upstream drops mid-stream (no more hangs)
- Codex: fix random 400/404 errors, tool-calling failures, and unstable prompt cache
- MITM: support Antigravity 2.x 
- Sanitize Read tool args to prevent retry loops from non-Anthropic models (#1144)
- Implement json_schema fallback for OpenAI-compatible providers without native Structured Output (#1343)
- Strip empty Read pages argument in OpenAI-to-Claude translator (#1354)
- Forward Gemini output dimensions for embeddings (#1366)
- Resolve setState-in-effect errors in dashboard components (#1362)
- Gemini CLI: reuse stored OAuth project IDs for quota checks and show clearer setup guidance when the project is missing (#1271, #1428)

## Features
- Add Cloudflare Workers proxy deployer and pool integration (#1360)
- Add Deno Deploy relays support and improved proxy pools dashboard layout (#1437)

## Improvements
- Refactor Tunnel into dedicated Cloudflare and Tailscale manager modules
- Refactor tokenRefresh service with in-flight dedup to prevent refresh_token_reused errors

# v0.4.59 (2026-05-21)

## Fixes
- OAuth: fix login flow on Windows

# v0.4.58 (2026-05-21)

## Features
- xAI Grok provider (OAuth, API key, image)
- Provider limits: paginated accounts with page size controls

## Fixes
- Tailscale: fix connection status on Windows (#1300)
- Tunnel: fix false "checking" when tunnel URL is reachable
- Stream: fix pipe errors on client disconnect/abort

# v0.4.55 (2026-05-18)

## Features
- Xiaomi MiMo Token Plan: region selector (Singapore / China / Europe) — keys are cluster-specific
- Antigravity: risk confirmation dialog before first connection
- Gemini CLI: surface upstream retry delay on 429 errors

## Fixes
- MITM: cannot kill process on macOS under sudo (lsof not found in PATH)
- Stream: false-positive stall timeout on Claude reasoning / Kiro responses
- Tunnel: cannot re-enable after disable (stuck state)
- Tunnel: cloudflared error messages now include log tail for easier debugging
- Language switcher: applies selected locale immediately on close (#1234)
- Antigravity OAuth: metadata now matches the official client

## Improvements
- Gemini CLI: bump engine to 0.34.0
- Re-hide `qwen` (OAuth EOL) and `iflow` (not ready) providers

# v0.4.52 (2026-05-17)

## Features
- Add Vercel AI Gateway provider support (#1183)
- rtk: Kiro format tool result compression — handle conversationState.history & currentMessage, preserve error results, ~13.6% savings (#1194)

## Fixes
- openclaw: normalize agent.model object form `{primary, fallbacks}` before .startsWith → fix TypeError & 'not configured' status (#1216)
- Usage Details pagination: stay inside mobile viewport <640px (#1218)
- Fix test model error
- Fix MIMO provider in Codex
- Disable log file creation when using MITM AG

# v0.4.50 (2026-05-16)

## Fixes
- Fix duplicate tray icon on macOS when hiding to tray
- Fix tray not showing in background mode on macOS
- Fix hide to tray broken on Windows/Linux
- Fix Shutdown button in web UI not working

# v0.4.49 (2026-05-16)

## Features
- Add Kiro provider support: full request/response translation, live model listing, reasoning content support
- Add `buildOutput` RTK filter with autodetect for npm/yarn/cargo build logs
- Add MITM warning notification in tray and dashboard

## Improvements
- Add modalities (input/output) to model configuration for OpenCode
- Fix tray hide-to-tray: keep current process alive instead of spawning detached child (fixes macOS NSStatusItem ghost icon)
- Fix tray kill: graceful shutdown with SIGTERM/SIGKILL escalation
- Fix SIGHUP handling so macOS terminal close doesn't kill tray process
- Hide deprecated providers (qwen, iflow, antigravity)
- Update i18n across 32 languages

## Fixes
- Fix model check (test-models) blocked by dashboardGuard: pass machineId-based CLI token in internal self-calls

# v0.4.46 (2026-05-15)

## Breaking Changes
- Tunnel public URL changed — old tunnel links no longer work, please reconnect to get the new URL
