# Phase 0 Research: DeepSeek Harness (dsh) Integration

**Feature**: `002-deepseek-harness-integration` | **Date**: 2026-09-15

## What DeepSeek Harness is

`dsh` is DeepSeek AI's open-source agent harness (MIT, developer preview, v0.1.0-rc.x as of research date). It is an **everything-is-a-plugin** runtime built on [Cordis](https://github.com/cordiverse/cordis). It is not a single CLI binary like Claude Code; it is a composition of plugins mounted into a **profile**.

Key facts that shape this integration:

- Distribution: `npx @deepseek-ai/dsh <mode>` (npm) or a pnpm source checkout. No global binary required.
- Entry modes: `dsh --profile <name>`, `dsh web` (alias for `--profile web`), `dsh --profile headless "<task>"`, `dsh plugin --profile <name> <pnpm args>`.
- Runtime: Node.js ≥ 22.19 (or ≥ 24).
- Web UI default: `http://127.0.0.1:3080`. `--host 0.0.0.0` is deliberately rejected.
- Harness home: `$DSH_HOME`, defaulting to `~/.dsh`. Profiles live at `$DSH_HOME/profiles/<name>`.
- State is driven by YAML, **not** TOML/JSON: `settings.yaml`, `.credentials.yaml`, and per-profile `cordis.patch.yml`.

## How dsh models are actually configured (the integration target)

Per the official providers guide (`docs/user/guide/providers.md`) and the `@deepseek-ai/dsh-llm-pi-ai` package reference, model routes live in a `settings.yaml` document under the `llm-pi-ai` settings section. AFRouter is exactly the "custom OpenAI-compatible gateway" case the docs describe.

Minimal AFRouter route (what the integration should write):

```yaml
llm-pi-ai:
  providers:
    afrouter:
      displayName: AFRouter
      apiKeyEnv: AFROUTER_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:20128/v1
      models:
        - id: cc/claude-sonnet-4-5-20250929
          name: cc/claude-sonnet-4-5-20250929
          contextWindow: 200000
          maxTokens: 32000
```

Hard requirements from the docs:

- A hand-declared route (one the installed catalog does not ship) **must** name `api`, `baseURL`, and a non-empty `models` list, or the profile is refused where it is written.
- `api` must be one of `openai-completions`, `openai-responses`, `anthropic-messages`. AFRouter speaks OpenAI Chat Completions → `openai-completions`.
- `baseURL` is the level expected by the selected protocol adapter. For `openai-completions` the adapter appends `/chat/completions`, so `baseURL` must end in `/v1`.
- `apiKeyEnv` is a **credential reference (env-var name), never the secret**. The secret is resolved per request through the credentials service.
- A model id entered by hand is treated as **text-only** unless `input: [text, image]` is declared.
- A model entered by hand declares **no reasoning levels** unless `reasoningEfforts` is declared.
- `contextWindow` and `maxTokens` have route-level fallbacks (`defaultContextWindow` 262,144 / `defaultMaxTokens` 32,768) but are best declared per model.
- The docs note that many OpenAI-compatible gateways need `compat.supportsDeveloperRole: false` and `compat.maxTokensField: max_tokens`. AFRouter's gateway already accepts OpenAI's native shape, so these are **not** required for the default route; they are exposed only as an advanced option if a specific model misbehaves.

### Credentials (two viable paths)

The credentials service stores secrets in `$DSH_HOME/.credentials.yaml` under `refs:` keyed by env-var name:

```yaml
version: 1

refs:
  AFROUTER_API_KEY: sk_afrouter
```

Resolution order: inherited environment → stored file → project `.env` → `$DSH_HOME/.env`. Writing `refs.<envName>` in `.credentials.yaml` is sufficient for the route's `apiKeyEnv` reference to resolve, without touching the user's process environment.

**Decision D1 — credential write strategy.** Write the AFRouter key into `$DSH_HOME/.credentials.yaml` `refs.AFROUTER_API_KEY` (merged, preserving all other refs/records verbatim), and reference it from the route via `apiKeyEnv: AFROUTER_API_KEY`. Rationale: it matches how the dsh Web UI itself stores keys, needs no shell/env manipulation, and keeps the secret out of `settings.yaml` (which the docs explicitly require). Falling back to `$DSH_HOME/.env` is rejected because the credentials store takes precedence and is the documented mechanism.

### Detection

There is no `dsh` binary to `which`/`where` in the common npx workflow, and in a source checkout `dsh` is a `pnpm dsh` script. Detection therefore keys on the harness home and profile tree:

- Installed if `$DSH_HOME` (or `~/.dsh`) exists, or any of: `~/.dsh/settings.yaml`, `~/.dsh/.credentials.yaml`, `~/.dsh/profiles/` exists.
- Also treat a resolvable `dsh` binary on PATH (`where`/`which dsh`) as installed.
- Export `DSH_HOME` support: resolve `process.env.DSH_HOME` first, else `path.join(os.homedir(), ".dsh")`.

**Decision D2 — installed must never require a config file.** Missing `settings.yaml` means "installed but not configured" (the Web UI may never have been opened), not "not installed", mirroring the deepseek-tui/zcode routes' `installed` vs `hasAFRouter` split.

### Config file location and merge target

`settings.yaml` is the same document the dsh Models page writes. The integration must:

- Read `$DSH_HOME/settings.yaml` (YAML), preserving unrelated top-level sections and unrelated providers.
- Merge/upsert only `llm-pi-ai.providers.afrouter`.
- Preserve other routes under `llm-pi-ai.providers` and other keys of `llm-pi-ai`.
- On Reset, remove only the `afrouter` route (and leave the credential ref in place, or remove it only when it was AFRouter-written — decided in D4).

**Decision D3 — YAML via `confbox`.** The repo already depends on `confbox@^0.2.4` and imports `parseTOML`/`stringifyTOML` in the codex and jcode routes. `confbox` also exports a `yaml` subpath (`confbox/yaml`) backed by `js-yaml`. Use `parseYAML` / `stringifyYAML` from `confbox/yaml` — no new dependency, consistent with existing config routes.

**D3 caveat — comments are not preserved.** `confbox/yaml`'s `parseYAML`/`stringifyYAML` explicitly drop comments. A parse→stringify round-trip therefore rewrites `settings.yaml` without any comments the user (or dsh) had. Mitigations: (a) always write the timestamped backup so nothing is unrecoverable; (b) restrict the mutation to the parsed object rather than string-splicing; (c) document in the card notes that Apply rewrites the YAML document (comments/users' formatting may be normalized). dsh's own `.credentials.yaml` provider preserves comments via line edits, so this is a real difference the plan should call out rather than hide. If comment preservation becomes a hard requirement, the route can be upgraded to a comment-preserving editor later without changing the API contract.

**Decision D4 — reset scope.** `DELETE` removes the `afrouter` provider route from `settings.yaml`. The credential ref is removed only when its stored value equals the AFRouter default (`sk_afrouter`) or was written by this integration; a user-supplied real dashboard key is left untouched so Reset cannot destroy a credential the user still needs. This mirrors zcode's ownership-scoped reset philosophy at a smaller scale; a full ownership ledger is over-engineering for a single ref (see D5).

**Decision D5 — single-route, single-ref simplicity.** Unlike ZCode (22 user models, ownership ledger required), the dsh route is a single AFRouter-owned provider entry under a namespaced key (`afrouter`). Ownership is unambiguous by the key itself, so no ledger is needed. Keep the implementation in the route file (or a small `src/lib/dshConfig.js` if the YAML merge grows), following the deepseek-tui route's inline-helper style.

### Multi-model and specs

dsh routes require a non-empty `models` list. AFRouter serves many models through one gateway, so the card must support selecting N models (OpenCode-style), writing one model entry each. Capacities come from AFRouter's own catalog:

- Live self-fetch of `http://127.0.0.1:${PORT||20128}/v1/models` (zcode precedent) with static fallback `getCapabilitiesForModel` from `open-sse/providers/capabilities.js` (grok-build/zcode precedent).
- Map `contextWindow` → `contextWindow`, `maxOutput` → `maxTokens`.
- Declare `input: [text, image]` when the catalog reports vision; omit otherwise (text-only default).
- Declare `reasoningEfforts` only when the catalog reports reasoning. Because AFRouter passes `reasoning_effort` through, use the OpenAI spelling mapping (`off:`, `low: low`, `medium: medium`, `high: high`, `max: max`) and, for DeepSeek-family models behind the gateway, `compat.thinkingFormat: deepseek` so `off` actually disables thinking — this is called out explicitly in the dsh providers guide. Default to declaring reasoning levels only for models whose catalog entry reports reasoning support.

### Active model / default selection

`dsh-llm-pi-ai` does not own a "current model" setting; the selected model is recorded per session and the default is chosen in the dsh model picker. There is a separate `@deepseek-ai/dsh-agent-default-model` plugin whose config names `provider` + `model`, but it is a composition (`cordis.patch.yml`) concern, not a `settings.yaml` concern. Writing it would require patching the profile composition, which is fragile under a developer-preview project.

**Decision D6 — no active-model write.** The card writes the route + full model list; the user picks the model inside dsh (mirrors ZCode, which defers active-model selection to the app). The card may show a note telling the user to select the `afrouter` model in dsh's picker. Optionally expose the `provider: afrouter` / `model: <id>` snippet in Manual Config for users who want to pin a default via their profile patch.

## How the existing CLI Tools feature works (integration points)

Confirmed by repo exploration:

- Registry: `src/shared/constants/cliTools.js` → `CLI_TOOLS`. An entry with `configType: "custom"`.
- Page grid: `src/app/(dashboard)/dashboard/cli-tools/CLIToolsPageClient.js` auto-renders every `CLI_TOOLS` entry — **no grid edit needed**.
- Detail dispatcher: `src/app/(dashboard)/dashboard/cli-tools/[toolId]/ToolDetailClient.js` → `switch (toolId)`; unmapped ids fall through to `DefaultToolCard`.
- Card barrel: `src/app/(dashboard)/dashboard/cli-tools/components/index.js`.
- Status batch: `src/app/api/cli-tools/all-statuses/route.js` → `STATUS_GETTERS`.
- Route contract: `GET` → `{ installed, hasAFRouter, configPath, ... }` never 500s; `POST` → `{ baseUrl, apiKey, models }`; `DELETE` → remove AFRouter-written state.
- Reference implementations chosen: route → `deepseek-tui-settings/route.js` (single tool, TOML) with the multi-model merge of `opencode-settings/route.js` and safety of `zcode-settings/route.js`; card → `OpenCodeToolCard.js` (multi-model + ModelSelectModal + Manual Config).
- Model specs: `getCapabilitiesForModel(provider, modelId)` from `open-sse/providers/capabilities.js`; alias resolution via `open-sse/services/model.js` (`resolveProviderAlias`).
- Auth/guard: `/api/cli-tools` is already in `PROTECTED_API_PATHS` (`src/dashboardGuard.js`); a new tool route needs no guard change (only cowork + antigravity are `LOCAL_ONLY_PATHS`).

## Icon asset

`public/providers/deepseek.png` already exists and is a suitable DeepSeek mark. To distinguish Harness from DeepSeek TUI, add `public/providers/deepseek-harness.png` (reuse the DeepSeek logo if no dedicated asset exists; a distinct name is what the registry references).

## Sources

- Official repo: `deepseek-ai/deepseek-harness` (README, `apps/cli/reference/README.md`, `docs/user/guide/providers.md`, `docs/config-catalog.md`).
- `@deepseek-ai/dsh-llm-pi-ai` package README (provider route schema, `settings.yaml` shape).
- `@deepseek-ai/dsh-credentials-local` package README (`.credentials.yaml` `refs:`/`records:` shape, resolution order).
- Independent guides cross-checking the CLI: findharness.com CLI cheat sheet, open-harness.net complete guide.
- In-repo precedent: `specs/001-zcode-integration/`, `deepseek-tui-settings/route.js`, `grok-build-settings/route.js`, `opencode-settings/route.js`, `OpenCodeToolCard.js`.
