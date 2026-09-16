# Tasks: DeepSeek Harness (dsh) Integration

**Input**: Design documents from `/specs/002-deepseek-harness-integration/`

**Prerequisites**: plan.md ✓, spec.md ✓, research.md ✓, data-model.md ✓, contracts/deepseek-harness-settings-api.md ✓, quickstart.md ✓

**Tests**: Test tasks (T012, T013) are included per repo convention — justified because the route performs destructive writes to the user's dsh `settings.yaml` and `.credentials.yaml`, which warrants regression coverage.

**Organization**: Tasks grouped by user story. Story mapping: US1 = connect + reset (P1), US2 = multi-model + catalog specs (P2), US3 = manual config / not-installed guidance (P3). Design decisions referenced as D1–D6 from `research.md`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no dependency on incomplete tasks)
- **[Story]**: US1 / US2 / US3
- Exact file paths in every description

## Path Conventions

Single Next.js project: `src/` at repo root, tests in `tests/unit/`. No `open-sse/` changes (constitution Principle I).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Static asset and registry entry so the tool exists in the dashboard.

- [ ] T001 [P] Add icon asset `public/providers/deepseek-harness.png` (32×32-friendly square PNG; reuse the DeepSeek mark behind a distinct filename so it does not collide with `deepseek-tui.png`)
- [ ] T002 Register tool id `deepseek-harness` in `CLI_TOOLS` in `src/shared/constants/cliTools.js` — `configType: "custom"`, `image: "/providers/deepseek-harness.png"`, `color: "#4D6BFE"`, description "DeepSeek Harness (dsh) agent runtime", `docsUrl: "https://github.com/deepseek-ai/deepseek-harness"`, `defaultCommand: "dsh"`, plus notes: info "AFRouter writes an `afrouter` provider route into `$DSH_HOME/settings.yaml` and stores the key in `$DSH_HOME/.credentials.yaml`."; info "dsh reloads settings on the next request — no restart needed."; warning "Config path: ~/.dsh/settings.yaml (or $DSH_HOME/settings.yaml)."

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Config-transform helpers + GET contract + registration glue. No user story work starts before this phase.

**⚠️ CRITICAL**: US1–US3 all depend on the helpers in T003 and the GET contract in T004.

- [ ] T003 Create `src/lib/dshConfig.js` with pure helpers (no handlers): (a) `getDshHome()` = `process.env.DSH_HOME || path.join(os.homedir(), ".dsh")`; `getSettingsPath()` = `<home>/settings.yaml`; `getCredentialsPath()` = `<home>/.credentials.yaml` (FR-011); (b) `readSettingsYaml()` / `readCredentialsYaml()` returning parsed objects with `{ missing: true }` on ENOENT and `{ corrupt: true }` on a YAML parse error — never throw; (c) `parseYAML`/`stringifyYAML` from `confbox/yaml` (D3); (d) `upsertAfrouterRoute(settings, { baseURL, models })` — creates `llm-pi-ai.providers.afrouter` with `displayName: "AFRouter"`, `apiKeyEnv: "AFROUTER_API_KEY"`, `api: "openai-completions"`, normalized `/v1` baseURL, merges/appends model entries by `id` without duplicates, preserves every other section/provider (FR-005); (e) `removeAfrouterRoute(settings)` / `removeModelFromRoute(settings, id)` returning `{ entryRemoved, removed }`; (f) `buildModelEntry(id, caps, compat)` per data-model.md — `contextWindow`, `maxTokens`, `input: [text, image]` only when vision, `reasoningEfforts` only when reasoning, optional `compat.thinkingFormat: deepseek`; (g) `upsertCredentialRef(creds, name, value)` / `removeCredentialRef(creds, name)` preserving all other refs/records and stamping `version: 1` (FR-004/005); (h) `writeAtomic(path, content)` — timestamped `.bak-<YYYYMMDD-HHmmss>` via `fs.copyFile`, write `.tmp`, `fs.rename` with up to 3 retries on `EPERM`/`EACCES` at 150 ms (FR-009)
- [ ] T004 Implement `GET` in `src/app/api/cli-tools/deepseek-harness-settings/route.js` per contracts/deepseek-harness-settings-api.md: detection (D2) = harness home exists **or** `where`/`which dsh` resolves; read settings + credentials via T003 helpers; return `{ installed, hasAFRouter, corrupt, configPath, credentialsPath, harness: { baseURL, models, hasCredential } }`; not-installed → `{ installed: false, harness: null, message }`; corrupt → `{ installed: true, corrupt: true, harness: null }`; never report the credential value (Principles III, SC-004)
- [ ] T005 [P] Register the getter in `src/app/api/cli-tools/all-statuses/route.js` — import `GET as deepseekHarnessGet` from `../deepseek-harness-settings/route` and add `"deepseek-harness": deepseekHarnessGet` to `STATUS_GETTERS`
- [ ] T006 [P] Export `DeepSeekHarnessToolCard` from `src/app/(dashboard)/dashboard/cli-tools/components/index.js` and add `case "deepseek-harness": return <DeepSeekHarnessToolCard {...commonProps} activeProviders={getActiveProviders()} hasActiveProviders={hasActiveProviders} cloudEnabled={cloudEnabled} />` to `renderToolCard()` in `src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js` (import it alongside the other cards); create the card file initially as a status-only stub (fetches GET, renders installed/configured badge) — interactive flow lands in T009

---

## Phase 3: User Story 1 — Connect DeepSeek Harness to AFRouter (Priority: P1)

**Story goal**: Local user expands the card, applies one model, and dsh's picker offers the `afrouter` route; Reset undoes it.

**Independent test**: Apply one model → parse `$DSH_HOME/settings.yaml`, confirm `llm-pi-ai.providers.afrouter` (`api: openai-completions`, `/v1` baseURL, model present, `apiKeyEnv: AFROUTER_API_KEY`) and `refs.AFROUTER_API_KEY` in `.credentials.yaml`; Reset → route gone, other providers intact.

- [ ] T007 [US1] Implement `POST` in `src/app/api/cli-tools/deepseek-harness-settings/route.js` per contract: require `baseUrl` + non-empty `models` array (400 otherwise); normalize `/v1`; create `<home>`/`settings.yaml` when absent; upsert the route (T003d) and the credential ref (T003g) with `apiKey || "sk_afrouter"`; refuse to write an unparseable `settings.yaml` (respond `{ success: false, error }`, file untouched); write both files via `writeAtomic`; respond `{ success, message, configPath, credentialsPath, written, unverified, backupPath }`
- [ ] T008 [US1] Implement `DELETE` in `src/app/api/cli-tools/deepseek-harness-settings/route.js` per contract + D4: no query → remove the route (drop `llm-pi-ai` only when empty) and remove the credential ref only when it holds `sk_afrouter` or is integration-owned; `?model=<id>` → remove only that model, delete the route when the list empties; missing files → idempotent success; respond `{ success, message, entryRemoved, removed }`; backup before write
- [ ] T009 [US1] Build interactive `DeepSeekHarnessToolCard` in `src/app/(dashboard)/dashboard/cli-tools/components/DeepSeekHarnessToolCard.js` modeled on `OpenCodeToolCard`: status hydration from GET; `BaseUrlSelect` (local/tunnel/tailscale presets) + `ApiKeySelect`; single-model apply via `ModelSelectModal`; `handleApply` → POST with `{ baseUrl, apiKey, models }` + `rememberEndpoint`; Reset → DELETE; badges Connected / Not configured / Other via `matchKnownEndpoint`; success message notes the user should pick the `afrouter` model in dsh

---

## Phase 4: User Story 2 — Multi-model management with catalog-accurate specs (Priority: P2)

**Story goal**: The card manages a list of models, each carrying correct capacities and capabilities pulled from AFRouter's catalog.

**Independent test**: Apply two models → both entries present with correct `contextWindow`/`maxTokens`; `input`/`reasoningEfforts` present exactly when the catalog reports vision/reasoning; remove one → the other is untouched.

- [ ] T010 [US2] Add catalog spec resolution in `src/app/api/cli-tools/deepseek-harness-settings/route.js` (FR-006): `resolveModelSpecs(ids)` self-fetches `http://127.0.0.1:${process.env.PORT || 20128}/v1/models` (no auth, `AbortSignal.timeout(4000)`) and maps each id → `{ contextWindow, maxOutput, vision, reasoning }`; on fetch failure fall back to `getCapabilitiesForModel(provider, modelId)` from `open-sse/providers/capabilities.js`; ids found in neither get conservative fallback `{ context: 200000, output: 32000, input: ["text"] }` and land in an `unverified` list — never invent values. Feed these into `buildModelEntry` (T003f)
- [ ] T011 [US2] Upgrade `DeepSeekHarnessToolCard` to the OpenCode-style multi-model flow: `selectedModels` list with per-model remove (`.filter`), `ModelSelectModal` with `addedModelValues`/`closeOnSelect={false}`, per-model spec map sent as `modelSpecs` on Apply, an "unverified models" notice from the POST response, and an optional advanced `compat` toggle (`thinkingFormat: deepseek`, `supportsDeveloperRole: false`, `maxTokensField: max_tokens`) defaulting off

---

## Phase 5: User Story 3 — Manual config & not-installed guidance (Priority: P3)

**Story goal**: A user on another machine, or one who prefers hand-editing, gets ready-made YAML.

**Independent test**: Open Manual Config, copy both snippets onto another machine's `$DSH_HOME`, confirm dsh lists the `afrouter` models.

- [ ] T012 [US3] Add `getManualConfigs()` to `DeepSeekHarnessToolCard` returning three entries for `ManualConfigModal`: (a) `~/.dsh/settings.yaml` with the `llm-pi-ai.providers.afrouter` block (route + selected models with resolved specs) using `{{apiKey}}`-style placeholders only where needed (the key is not in this file); (b) `~/.dsh/.credentials.yaml` with `version: 1` + `refs.AFROUTER_API_KEY`; (c) an optional comment/snippet showing the `dsh-agent-default-model` `provider: afrouter` + `model: <id>` composition pin (D6)
- [ ] T013 [US3] Add the not-installed branch to `DeepSeekHarnessToolCard` (mirror `DeepSeekTuiToolCard`): a warning panel explaining dsh is detected via `$DSH_HOME`/`~/.dsh` (or `dsh` on PATH), an install hint (`npx @deepseek-ai/dsh web`), and a Manual Config button so remote users are not dead-ended

---

## Phase 6: Polish & Verification

- [ ] T014 [P] Add `tests/unit/deepseek-harness-settings.test.js` covering `src/lib/dshConfig.js` with temp-dir fixtures: route upsert preserves unrelated sections/providers; model merge does not duplicate ids; `buildModelEntry` adds `input`/`reasoningEfforts` only when the catalog says so; credential upsert preserves other refs/records; reset ownership rule (default key removed, user key preserved); GET never-500 on missing/corrupt YAML; atomic write produces a backup. Mock `os.homedir`, `DSH_HOME`, and reject live `fetch`. Judge with `tests/__baseline__/verify-no-regression.mjs`
- [ ] T015 [P] Verify against a real dsh install (research follow-up): run `npx @deepseek-ai/dsh --profile web --dump-config` after Apply and confirm the `afrouter` route mounts and the model picker lists the models; capture the dsh version used and note any schema drift in `research.md` (dsh is a developer preview)
- [ ] T016 Run `npx eslint .` and fix all findings; confirm no `open-sse/` files changed (`git status`); update `CHANGELOG.md` with a `feat(cli-tools): add DeepSeek Harness (dsh) integration` entry

---

## Dependencies & Execution Order

- Phase 1 → Phase 2 (T003 blocks T004; T004 blocks T007/T010) → Phases 3–5 → Phase 6.
- T005, T006 are independent registration glue once T004 exists.
- T009 depends on T007/T008; T011 depends on T009 + T010; T012/T013 depend on T009.
- US1 is a shippable slice on its own; US2 and US3 refine it.

## Out of Scope (deferred)

- CLI launcher menu parity (`cli/src/cli/menus/cliTools.js`, `cli/src/cli/api/client.js`) — matches the ZCode v1 decision.
- Writing a default/active model into the dsh profile composition (`cordis.patch.yml`) — fragile under a developer-preview project; offered as a Manual Config snippet only (D6).
- MITM/proxy integration — dsh is an OpenAI-compatible HTTP client, so no interception is needed.