# Implementation Plan: DeepSeek Harness (dsh) Integration

**Branch**: `002-deepseek-harness-integration` | **Date**: 2026-09-15 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/002-deepseek-harness-integration/spec.md`

## Summary

Add a **DeepSeek Harness** card to the AFRouter dashboard CLI-tools page. Detection keys on `$DSH_HOME` (default `~/.dsh`). On Apply, merge an `afrouter` provider route into `$DSH_HOME/settings.yaml` under the `llm-pi-ai` settings section (`api: openai-completions`, `baseURL: <afrouter>/v1`, `apiKeyEnv: AFROUTER_API_KEY`) with one model entry per selected AFRouter model, and store the key as a credential ref in `$DSH_HOME/.credentials.yaml`. Reset removes only the `afrouter` route. Model capacities come from AFRouter's live `/v1/models` catalog with a static fallback. Mirrors the OpenCode card + deepseek-tui route patterns; no engine (`open-sse/`) changes — all app-side (`src/`) work.

## Technical Context

**Language/Version**: JavaScript (ESM), Node ≥ 20 (Next.js App Router server routes); the generated config targets dsh's Node ≥ 22.19 runtime but nothing here executes dsh.

**Primary Dependencies**: Next.js App Router, React, shared UI components, `fs/promises`, `confbox/yaml` (`parseYAML`/`stringifyYAML`, already in `dependencies`), `open-sse/providers/capabilities.js` (`getCapabilitiesForModel`), `open-sse/services/model.js` (`resolveProviderAlias`).

**Storage**: N/A — AFRouter-side state is zero. All state lives in dsh's own `$DSH_HOME/settings.yaml` and `$DSH_HOME/.credentials.yaml` (external, dsh-owned).

**Testing**: vitest (independent `tests/` package), judged against `tests/__baseline__/verify-no-regression.mjs` per constitution Principle V.

**Target Platform**: AFRouter dashboard (Next.js server routes + React cards); cross-platform home-dir paths via `os.homedir()` + `DSH_HOME` override.

**Performance Goals**: Status endpoint < 500 ms including YAML parse; Apply < 2 s including backup + write.

**Constraints**: Must not clobber dsh-owned data (preserve all unrelated `settings.yaml` sections/providers and all `.credentials.yaml` refs/records); never 500 on missing/corrupt config; `settings.yaml` must never contain the secret (credential ref only); YAML must round-trip other sections byte-for-byte as far as a parse/stringify cycle allows; plain JS/ESM only, no TypeScript.

**Scale/Scope**: One new API route + one card component + registry/status/dispatcher additions; single-machine scope (dashboard and dsh co-located); ~7 files touched/added.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| # | Principle | Impact | Assessment |
|---|-----------|--------|------------|
| I | Engine-App Boundary Discipline | none | All work app-side (`src/` + `public/`); zero `open-sse/` changes. Only reads `getCapabilitiesForModel`/`resolveProviderAlias`, which are existing read-only imports. |
| II | Translation Correctness via Pivot and Direct Routes | none | No translator work. dsh speaks OpenAI Chat Completions, already the pivot format. |
| III | Credential and Request Security (NON-NEGOTIABLE) | low | The API key is written to dsh's owner-only `$DSH_HOME/.credentials.yaml` (the documented store) and referenced by name in `settings.yaml`; it is never returned in plaintext by GET (status returns only whether a ref is configured), never logged, and never placed in `settings.yaml`. Reuses the existing `ApiKeySelect` flow. No IP/forwarding-header code touched. |
| IV | Data Integrity via SQLite Adapter Chain | none | No AFRouter-side persistence; dsh's YAML files are external. Writes use backup + atomic rename. |
| V | Regression-Gated Quality | low | New tests under `tests/unit/` judged via `verify-no-regression.mjs`. Provider registry/alias untouched, so `verify-*.mjs` provider checks are not triggered. All changes pass `npx eslint .` and Conventional Commits. |

**Pre-design gate: PASS** — no violations. Post-design re-check at end of this file: **PASS**.

## Project Structure

### Documentation (this feature)

```text
specs/002-deepseek-harness-integration/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── data-model.md        # Phase 1 output
├── quickstart.md        # Phase 1 output
├── contracts/           # Phase 1 output
└── tasks.md             # Phase 2 output (NOT created by this plan)
```

### Source Code (repository root)

```text
src/
├── shared/constants/cliTools.js                     # register `deepseek-harness` in CLI_TOOLS
├── lib/dshConfig.js                                 # NEW: YAML merge/reset helpers for settings.yaml + .credentials.yaml
├── app/api/cli-tools/deepseek-harness-settings/route.js   # NEW: GET / POST / DELETE
├── app/api/cli-tools/all-statuses/route.js          # import + register deepseek-harness getter
── app/(dashboard)/dashboard/cli-tools/
    ├── components/DeepSeekHarnessToolCard.js        # NEW: card UI (OpenCode-style multi-model)
    ├── components/index.js                          # export DeepSeekHarnessToolCard
    ── [toolId]/ToolDetailClient.js                 # case "deepseek-harness" → card

public/providers/deepseek-harness.png                # icon asset (distinct from deepseek-tui.png)

tests/unit/deepseek-harness-settings.test.js         # NEW: route/merge/reset unit tests

open-sse/                                            # untouched — no engine changes
```

**Structure Decision**: Follow the established `<tool>-settings` route + `<Tool>ToolCard` component pattern (deepseek-tui route + OpenCode card precedent). Config transforms are non-trivial (two YAML documents, section-scoped merge), so they live in `src/lib/dshConfig.js` per the `grokBuildConfig.js` precedent. Registration touches four known integration points: `CLI_TOOLS` constants, the `all-statuses` batch route, `components/index.js`, and the `ToolDetailClient` switch.

## Design Decisions (from research.md)

- **D1** Store the key as a `refs.AFROUTER_API_KEY` entry in `$DSH_HOME/.credentials.yaml`; reference it via `apiKeyEnv` in `settings.yaml`. Never inline the secret.
- **D2** `installed` is true when `$DSH_HOME` (or a resolvable `dsh` binary) exists, independent of whether `settings.yaml` exists; missing config → `not_configured`, never `not installed`.
- **D3** Parse/serialize YAML with `confbox/yaml` — already a dependency; consistent with the codex/jcode TOML routes. Caveat: this parser drops comments on round-trip, so every write is preceded by a timestamped backup and the card notes that Apply normalizes the document.
- **D4** Reset removes the `afrouter` route; removes the credential ref only when it holds the AFRouter default or is integration-owned, so a user's real key survives.
- **D5** No ownership ledger — the `afrouter` key namespaces AFRouter state unambiguously.
- **D6** No active/default-model write in `settings.yaml`; the user picks the model in dsh's picker. Manual Config may show the optional `dsh-agent-default-model` snippet.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

None — design stays within existing patterns; no new abstractions.

## Implementation Phases (summary; detailed tasks in tasks.md)

1. **Setup** — icon asset + `CLI_TOOLS` registry entry.
2. **Foundational** — `src/lib/dshConfig.js` helpers (paths, YAML read, route upsert/remove, credential upsert/remove, atomic write), GET route, status/dispatcher/card-barrel wiring.
3. **US1** — POST applies an `afrouter` route with one selected model; DELETE resets; interactive card.
4. **US2** — multi-model list with catalog-accurate `contextWindow`/`maxTokens`/`input`/`reasoningEfforts`.
5. **US3** — Manual Config (`settings.yaml` + `.credentials.yaml` snippets, plus optional default-model patch) and not-installed guidance.

## Post-Design Constitution Re-Check

*GATE: Re-evaluated after Phase 1 artifacts were produced.*

| # | Principle | Assessment |
|---|-----------|------------|
| I | Engine-App Boundary | PASS — zero `open-sse/` surface changes; only read-only capability/alias lookups. |
| II | Translation Correctness | PASS — no translators; dsh consumes OpenAI Chat Completions directly. |
| III | Credential & Request Security | PASS — secret lives only in dsh's owner-only credential store; `settings.yaml` carries a reference; GET reports configured/not-configured, never the value. |
| IV | Data Integrity via SQLite | PASS — no AFRouter-side persistence; external YAML handled with backup + atomic write. |
| V | Regression-Gated Quality | PASS — unit tests planned under `tests/unit/`, judged via `verify-no-regression.mjs`; eslint + Conventional Commits required. |

**Post-design gate: PASS** — no violations; complexity tracking table remains empty.