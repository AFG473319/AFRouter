# Research: ZCode Integration

**Feature**: `001-zcode-integration` | **Date**: 2026-09-14

All unknowns were resolved by direct observation of a live ZCode config and AFRouter source. Findings per decision:

## D1: Model-spec resolution source (FR-006)

**Decision**: Server-side self-fetch of AFRouter's own `GET /v1/models` (`http://127.0.0.1:${process.env.PORT || 20128}/v1/models`), falling back to a direct import of `getCapabilitiesForModel` from `open-sse/providers/capabilities.js` when the self-fetch fails, and to conservative fallback specs (context 200000 / output 32000 / text-only + unverified flag) when the model is absent from both.

**Rationale**: FR-006 names the live catalog as the source of truth — it includes live-resolved provider models and combo-merged capabilities that the static registry lacks. But `/v1/models` is a route handler, not an importable service, and refactoring it out is out of scope (tight-diff preference). The grok-build settings route already imports `getCapabilitiesForModel` server-side, proving the fallback path in-process. Self-fetch is a single loopback HTTP GET at apply-time; `/v1/models` requires no auth (verified — the route handler performs no key check).

**Alternatives considered**:
- Import `getCapabilitiesForModel` only (grok-build precedent): misses combo/live models → stale or wrong specs for exactly the models users route.
- Client-side spec resolution via `/api/models` (dashboard endpoint): specs would cross the wire from the browser and be written to disk on trust; also `/api/models` caps lack `videoInput`/`audioInput`, losing the audio/video modality mapping.
- Refactor `/v1/models` into a shared service: cleanest long-term, but a cross-cutting diff far beyond this feature's scope.

## D2: AFRouter-ownership tracking for selective DELETE (FR-008)

**Status: REVISED — the in-config marker does not survive.** The original decision below was falsified in production; see "Outcome" at the end of this section.

**Decision (original)**: In-config marker — every model AFRouter writes gets `zcode: { modalitiesConfigured: true, afrouter: true }`. DELETE removes only entries carrying `afrouter: true`; when none remain, the whole `AFRouter` entry is removed. Pre-existing (user-added) models never carry the marker and are never removed. The Manual Config snippet includes the marker so remotely-configured setups get identical ownership semantics.

**Rationale**: Keeps AFRouter stateless (constitution IV spirit: no new AFRouter-side persistence for what is config-file state), and the marker travels inside the config file — correct behavior even for configs copied across machines. Safe extensibility is observed: real configs show the `zcode` block carrying varied extra keys (`modalitiesConfigured`, `modified`, `priority`), and ZCode tolerates entries with/without each.

**Alternatives considered**:
- Sidecar state file under `~/.afrouter` listing added model keys: breaks for Manual Config / copied configs, adds persistent state for zero benefit.
- "Has `zcode` block" as the ownership test: wrong — user-added models (all 22 in the observed config) already carry `zcode.modalitiesConfigured: true`; deleting on that test would wipe user data.
- Treat whole entry as AFRouter-owned (Hermes-style full-entry delete): rejected by clarification Q5 — must preserve user-added models.

**Risk**: ZCode could, in principle, rewrite/drop unknown keys inside `zcode` blocks. Mitigation: quickstart verification step (apply → relaunch ZCode → confirm marker survived and picker works). If ZCode strips it, fall back to spec-hash matching is possible but not needed unless proven broken.

**Outcome (2026-09-15): the risk materialized — this cost both usability bugs the feature then shipped with.**

ZCode rewrites `~/.zcode/v2/config.json` on exit and rebuilds each model entry from a fixed key list. Its schema for the model-level `zcode` block (extracted from `app.asar`) is `{ modalitiesConfigured, kinds, defaultKind, modelIdByKind, disabledReason, supportsTools, supportsStructuredOutput, reasoningProfile, reasoning, hasMaxOutputTokens, priority, modified, deleted }` — our `afrouter` key is not in it, so it is dropped on the next ZCode close even though the block itself is preserved.

Evidence from one real config's timestamped backups: `…134741` had 7 models / 7 marked; `…141826` and later had 10 / 0 — every marker gone, zero models removed. Consequences:

1. "Can't remove the models" — DELETE tested `zcode.afrouter === true`, so after the first ZCode close nothing was removable and the whole card silently degraded to "user-added, manage inside ZCode".
2. "Doesn't recognize its own models" — the card's `afrouterModels` list came from the same marker, so it rendered empty.

**Revised decision**: ownership lives in a durable ledger at `~/.afrouter/zcode-model-ownership.json`, keyed by config path (`src/lib/zcodeModelOwnership.js`); the marker is still written for interop but is only a bootstrap hint. When the ledger has no record for a config, `resolveOwnership` bootstraps by claiming keys that either still carry the marker or resolve in AFRouter's own catalog/static registry — the entry is named AFRouter and points at our baseURL, so a routable key is one we added. Unresolvable keys are left alone as user data. The ledger is rewritten on every apply/delete, so a key removed by the user drops out of ownership and a hand-re-added key is no longer claimed.

Two related fixes shipped with it:
- `resolveModelSpecs` now matches a config id against the live catalog through the request path's own alias resolver, so `oc/…` IDs match the catalog's `opencode/…` spelling instead of needlessly falling back to conservative specs.
- The catalog self-fetch derives its port from the incoming request URL instead of assuming `process.env.PORT` (the Next server is commonly started with `--port` and no `PORT` env, which made the fetch miss and every model look unverified).

**Cost of the original choice**: it was the cheapest option only while true. Because it was load-bearing for both recognition and removal, one wrong assumption broke two user-visible features at once, and it took a relaunch to surface. A marker whose survival is an assumption should not gate a destructive operation.

## D3: Atomic write + backup on Windows (FR-007)

**Decision**: Write sequence per apply/delete: (1) `fs.copyFile(config, config.bak-<YYYYMMDD-HHmmss>)` timestamped backup; (2) serialize the full JSON; (3) `fs.writeFile(config + ".tmp")`; (4) `fs.rename(tmp, config)`; on `EPERM`/`EACCES` retry up to 3× with 150 ms delay (Windows file-lock races with ZCode/AV), then fail cleanly with the backup intact.

**Rationale**: `fs.rename` overwrites atomically on both POSIX and Windows (libuv uses `MoveFileExW` with `MOVEFILE_REPLACE_EXISTING`), but a running ZCode or antivirus can hold the target briefly — retries absorb that. Timestamped backups (not a single `.bak`) survive consecutive applies without overwriting the only good copy. Matches the user's own `config.json.bak-<date>` habit observed in `~/.zcode/v2/`.

**Alternatives considered**: single fixed `.bak` (loses earlier state on back-to-back applies); write-in-place (corruption window on crash); lock-file coordination (over-engineering for a single-user home-dir file).

## D4: Provider entry lookup + creation (FR-003)

**Decision**: Scan `provider` map values for `name === "AFRouter"` and `source === "custom"` (builtin `builtin:*` entries with the same name are ignored — they're ZCode-shipped skeletons, not ours). If none, create under a fresh UUID (`crypto.randomUUID()`). If multiple, pick the first match and report the ambiguity in the response payload.

**Rationale**: Observed config shows name-collision is real (`Z.ai - Coding Plan` appears under two keys); matching on `name` + `source` disambiguates ours (always created with `source: "custom"`) from any future builtin lookalike. UUID creation mirrors the other custom entries (`NVIDIA NIM`, `TokenRouter`, …).

**Alternatives considered**: fixed well-known key (breaks the observed UUID convention); first-entry-wins by name only (could hijack a builtin).

## D5: Card UX pattern (US1/US2)

**Decision**: Clone the OpenCodeToolCard structure — endpoint selector (`BaseUrlSelect`), API-key selector (`ApiKeySelect`), multi-model list with add/remove, Apply/Reset buttons, Manual Config modal — driven by the new `/api/cli-tools/zcode-settings` route. No subagent section (ZCode has no direct equivalent of OpenCode's `agent.explorer`).

**Rationale**: Clarification Q4 fixed multi-model management; OpenCode is the direct precedent with identical data flow (GET status → hydrate list; POST merge). Shared helpers (`matchKnownEndpoint`, `rememberEndpoint`) keep endpoint UX consistent (FR-012).

**Alternatives considered**: Hermes single-model input (contradicts Q4); Copilot-style guide steps (only for unconfigurable tools).

## D6: Reasoning defaults (FR-005)

**Decision**: New AFRouter-written entries with catalog `reasoning: true` get `{ enabled: true, variants: ["low", "high", "max"], defaultVariant: "max" }`; the block is omitted entirely otherwise. Refresh/apply never touches existing entries' `variants`, `defaultVariant`, `name`, or `priority`.

**Rationale**: Live-config survey shows this is the dominant convention (18 of 19 reasoning-bearing entries); `bai/mimo-v2.5`'s `["enabled","off"]` is user-chosen and must survive re-apply. The catalog exposes no variant list (`thinkingFormat`/`thinkingCanDisable` don't map), so deriving variants was rejected outright.

**Alternatives considered**: deriving variants from `thinkingEffortSupported`/`thinkingRange` — no observed config correlates those with variant lists; inventing per-format schemes contradicts FR-006's "don't invent".
