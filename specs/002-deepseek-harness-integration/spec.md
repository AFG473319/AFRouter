# Feature Specification: DeepSeek Harness (dsh) Integration

**Feature Branch**: `002-deepseek-harness-integration`

**Created**: 2026-09-15

**Status**: Draft

**Input**: User description: "Research dsh (DeepSeek Harness), find its config rules, then create a plan to add DeepSeek Harness integration in the CLI Tools part so users can add AFRouter models in DeepSeek Harness easier. Check the existing OpenCode, Codex, Claude Code and Claude Cowork CLI tools to understand how it works."

## Clarifications

### Session 2026-09-15

- Q: Should the first version ship the dashboard card only, or also CLI launcher menu parity? → A: Dashboard card only in v1; CLI launcher parity deferred (matches the ZCode decision).
- Q: Does dsh need its API key in `settings.yaml`, an env var, or the credential store? → A: Credential store (`$DSH_HOME/.credentials.yaml` `refs:`), referenced by name from `settings.yaml` via `apiKeyEnv` — the documented mechanism, and `settings.yaml` must never hold the secret.
- Q: Should the card manage a single model or a list? → A: Multi-model list management (OpenCode style), because one dsh route serves many AFRouter models.
- Q: Should Apply also set the default/active model inside dsh? → A: No — the model is selected in dsh's own picker; the card writes the route + models only, with an optional Manual Config snippet for users who want to pin a default.
- Q: Should Reset delete the stored credential too? → A: Only when it holds the AFRouter default or was integration-written; a user's real dashboard key is preserved.
- Q: What identifies a dsh installation? → A: The harness home (`$DSH_HOME`, default `~/.dsh`) or a `dsh` binary on PATH; config files may not exist yet and are still "installed, not configured".

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Connect DeepSeek Harness to AFRouter from the dashboard (Priority: P1)

A user running AFRouter and dsh on the same machine opens the dashboard CLI-tools page, expands the DeepSeek Harness card, picks an endpoint, an API key, and one or more models, and clicks Apply. dsh's model picker then offers the `afrouter` provider and those models, and traffic routes through AFRouter.

**Why this priority**: This is the entire value of the feature — one-click routing of dsh traffic through AFRouter without hand-editing YAML.

**Independent Test**: With dsh's harness home present, expand the card, select one model, and click Apply. Parse `$DSH_HOME/settings.yaml` and confirm `llm-pi-ai.providers.afrouter` exists with `api: openai-completions`, the AFRouter `/v1` base URL, the chosen model in its `models` list, and `apiKeyEnv: AFROUTER_API_KEY`; parse `$DSH_HOME/.credentials.yaml` and confirm `refs.AFROUTER_API_KEY` is set. Click Reset and confirm the `afrouter` route is gone.

**Acceptance Scenarios**:

1. **Given** dsh is installed (harness home exists) and AFRouter has an active provider, **When** the user applies one model with the local endpoint, **Then** `settings.yaml` contains an `llm-pi-ai.providers.afrouter` route (`api: openai-completions`, AFRouter `/v1` base URL, the model in `models`) and `.credentials.yaml` contains the key under `refs`.
2. **Given** the `afrouter` route already points at the selected endpoint, **When** card status is evaluated, **Then** the card shows the "Connected" state.
3. **Given** the user clicks Reset, **When** reset completes, **Then** the `afrouter` route is removed, unrelated providers and settings are untouched, and the card leaves "Connected".

---

### User Story 2 - Manage multiple dsh models with catalog-accurate specs (Priority: P2)

A user adds several AFRouter models to dsh at once, or removes a single model without disturbing the rest, and each model carries correct capacity and capability declarations (context window, max output, image input, reasoning levels).

**Why this priority**: A dsh route requires a model list; hand-declaring each model's capacities is exactly the tedious work the integration removes.

**Independent Test**: Apply with two models, verify both `models` entries exist with correct `contextWindow`/`maxTokens`, and that `input`/`reasoningEfforts` are present exactly when the catalog reports vision/reasoning. Remove one model, verify the other is untouched.

**Acceptance Scenarios**:

1. **Given** an existing `afrouter` route with models, **When** the user applies additional models, **Then** new models are appended and existing entries are preserved.
2. **Given** AFRouter's `/v1/models` catalog reports capabilities for a model, **When** it is written, **Then** `contextWindow`/`maxTokens` match the catalog, `input: [text, image]` is present only for vision models, and `reasoningEfforts` is present only for reasoning models.
3. **Given** a model the catalog does not describe, **When** it is written, **Then** conservative fallback capacities are used and the model is reported as "unverified" rather than inventing values.

---

### User Story 3 - Manual config for remote machines (Priority: P3)

A user whose dsh runs on another machine, or who prefers to edit YAML by hand, copies ready-made `settings.yaml` and `.credentials.yaml` snippets from the Manual Config modal.

**Why this priority**: Covers remote/headless setups but the local flow (US1/US2) delivers the core value alone.

**Independent Test**: Open Manual Config, copy both snippets onto another machine's `$DSH_HOME`, and confirm dsh shows the `afrouter` models.

**Acceptance Scenarios**:

1. **Given** dsh is not detected locally, **When** the user opens the card, **Then** they see guidance plus working Manual Config snippets instead of a dead end.
2. **Given** the user wants to pin a default model, **When** they open Manual Config, **Then** an optional `dsh-agent-default-model` snippet is shown alongside the route snippet.

---

### Edge Cases

- **`$DSH_HOME/settings.yaml` does not exist** (dsh installed but never configured): report installed + not configured, still allow Apply (create the file/section), and offer Manual Config.
- **`settings.yaml` exists but has no `llm-pi-ai` section**: create the section without disturbing other sections.
- **`settings.yaml` is unparseable YAML**: never 500; report a safe "no config" result and refuse to write until the user fixes it, so a corrupt file is not overwritten.
- **`.credentials.yaml` is missing**: create it with `version: 1` + `refs`.
- **`.credentials.yaml` has an existing AFRouter ref**: overwrite only that ref; preserve every other ref and record.
- **dsh is running**: `settings.yaml` changes take effect on the next request without a restart, and the credentials store hot-reloads; the card notes this rather than demanding a restart.
- **Non-local endpoints (tunnel/tailscale)**: reuse `matchKnownEndpoint` so Connected/Other states stay consistent with other cards.
- **`DSH_HOME` is set to a non-default location**: honor the environment variable over `~/.dsh`.
- **A model needs gateway-specific request compatibility**: expose an advanced `compat` toggle (e.g. `thinkingFormat: deepseek`, `supportsDeveloperRole: false`) that is off by default, since AFRouter's endpoint usually needs neither.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The dashboard CLI-tools page MUST list a "DeepSeek Harness" card.
- **FR-002**: The status endpoint MUST report `installed`, `hasAFRouter`, `configPath`, and the current route details, and MUST NOT return 500 for a missing or corrupt config.
- **FR-003**: Apply MUST upsert `llm-pi-ai.providers.afrouter` in `$DSH_HOME/settings.yaml` with `api: openai-completions`, the normalized `/v1` base URL, `apiKeyEnv: AFROUTER_API_KEY`, and a non-empty `models` list.
- **FR-004**: Apply MUST NOT write the API key into `settings.yaml`; the key MUST be stored as `refs.AFROUTER_API_KEY` in `$DSH_HOME/.credentials.yaml`.
- **FR-005**: Apply MUST preserve every unrelated `settings.yaml` section and every unrelated `llm-pi-ai.providers` route, and every unrelated `.credentials.yaml` ref/record.
- **FR-006**: Apply MUST resolve each model's `contextWindow`, `maxTokens`, image input, and reasoning levels from AFRouter's live catalog, falling back to the static capability registry, and marking unresolvable models as unverified.
- **FR-007**: Reset MUST remove the `afrouter` route without touching other providers or settings, and MUST remove the credential ref only when it holds the AFRouter default or was integration-written.
- **FR-008**: The card MUST support adding and removing individual models, and reflect the configured state (Connected / Not configured / Other).
- **FR-009**: Writes MUST use a timestamped backup plus an atomic rename so a concurrent dsh read cannot see a half-written file.
- **FR-010**: The card MUST offer a Manual Config modal with `settings.yaml` and `.credentials.yaml` snippets for remote/hand configuration.
- **FR-011**: The card MUST honor `DSH_HOME` when resolving paths.

### Key Entities

- **dsh harness home**: `$DSH_HOME` or `~/.dsh`; holds `settings.yaml`, `.credentials.yaml`, and `profiles/`.
- **AFRouter dsh route**: `llm-pi-ai.providers.afrouter` — the provider entry the integration owns.
- **dsh model entry**: one element of the route's `models` list (`id`, `name`, `contextWindow`, `maxTokens`, optional `input`, optional `reasoningEfforts`, optional `compat`).
- **Credential ref**: `refs.AFROUTER_API_KEY` in `.credentials.yaml`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can connect dsh to AFRouter in one Apply with no manual YAML editing.
- **SC-002**: Status answers in < 500 ms; Apply completes in < 2 s.
- **SC-003**: Applying 1 and then 5 models never loses or corrupts any pre-existing dsh setting or credential.
- **SC-004**: No missing/corrupt config ever produces a 500 that the UI misreads as "installed".
- **SC-005**: Reset returns dsh to its pre-integration route set (no `afrouter` route) without removing other providers.

## Assumptions

- dsh remains CLI/web-only with `settings.yaml` + `.credentials.yaml` under `$DSH_HOME`; the schema is read from the `dsh-llm-pi-ai` and `dsh-credentials-local` package references at time of writing. dsh is a developer preview and the schema may change — the feature should degrade gracefully (not crash) on an unrecognized section, and the plan tracks a verification task.
- The user runs AFRouter and dsh on the same machine for the local flow; tunnel/tailscale URLs cover the remote case.
- `confbox/yaml` is an acceptable YAML parser (already a project dependency).
