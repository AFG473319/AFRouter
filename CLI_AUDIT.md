# CLI / headless audit ? 2026-09-17

Scope: commits `69eab212` and `6e6882a6`, compared with dashboard API contracts.
This is a first repair batch, not certification of complete dashboard parity.
Tests use mocks or an isolated temporary home; no production gateway, accounts,
external tool configuration, OAuth flow, or live provider was mutated.

## Confirmed defects

The following items are fixed in this working tree.

| Priority | Finding | Evidence / impact | Repair scope |
| --- | --- | --- | --- |
| High | Invalid ports silently select another destination | `globals()` accepts `20128oops`, falls back on garbage, and accepts out-of-range values. A management command can target the wrong gateway. | Strict validation and usage exit. |
| High | Negative setting values become booleans | `--value -1` parses as `value: true`. | Preserve negative numeric values; reject a missing value. |
| High | Empty bulk-delete filter matches every combo | `required()` accepts an empty string, and every name includes it. | Reject blank required values before API calls. |
| Medium | Boolean flags consume commands | `nodes --human list` loses its action. | Explicit boolean parsing. |
| Medium | Unknown actions report success | Dispatcher prints help to stdout and returns 0. | Usage errors on stderr, exit 2. |
| Medium | Offline status reports success | Failed health/version requests are wrapped in successful output. | Nonzero failure exit. |
| Medium | Missing resource IDs reach API calls | Commands interpolate `undefined` into resource paths. | Validate positional IDs before transport. |
| Medium | Default compatible-node creation fails | CLI omits `apiType`, but POST requires `chat` or `responses`. | Default to chat while preserving explicit choice. |
| Medium | Custom-model deletion fails in both interfaces | Client sends only `id`; route requires `providerAlias` and identifies models by type too. | Carry full identity through client, headless, and menu. |
| Medium | Headless Codex setup fails with HTTP 400 | CLI sends `models[]`; route requires `model`. | Single-model payload plus subagent option. |
| Medium | Tool setup ignores explicit host | Fallback endpoint is always localhost, even with `--host`. | Honor selected host including IPv6. |
| Medium | JSON key listing is not masked | Only human table masks keys despite help saying list is masked. | Mask JSON list; explicit get/create remain reveal operations. |
| Medium | Settings patch accepts non-object JSON | `null`, arrays and scalars are sent to the settings endpoint. | Reject invalid shapes as usage errors before transport. |

The pre-existing untracked contract test reproduced **12/12 failures** before
changes (five are separate port cases). The focused Codex caller test passes
after its fix. A separate real POST-route test writes valid TOML and preserves
an existing profile in an isolated home: no TOML serializer defect was reproduced.

## Remaining defects and parity backlog

These are not fixed by the initial repair batch; API existence alone is not CLI parity.

- Headless OAuth connection onboarding/imports are absent from the providers domain,
  even though client helpers and dashboard OAuth/import routes exist.
- Provider edits expose only a subset of dashboard connection settings; key update
  is absent from headless despite `updateApiKey` existing in the client.
- Pricing edits/reset are absent from headless; translator load/save/translate/send
  and console inspection have no corresponding domain/menu.
- Tool configuration still uses a generic multi-model fallback. Tool-specific
  settings, individual model removal, and explicit ZCode ownership adoption are
  not comprehensively exposed. The ZCode dashboard route now also writes
  per-model reasoning levels to ZCode 3.14+'s Personal layer
  (`~/.zcode/v2/provider_config.json`, with manual-override skip, corrupt-file
  refusal and ZCode-style locking); headless exposes none of that either.
  Guide-only tools must not be sent to nonexistent
  settings routes. Validate each tool against its own route rather than promise
  universal setup support.
- Headless MITM alias writes send `{alias, model}` but the route requires
  `{tool, mappings}`; the read path also lacks tool selection. This is a confirmed
  contract mismatch, not repaired here.
- Voice discovery advertises credential-dependent providers but directs all
  providers to the generic voices endpoint; specialized routes need auditing.
- Proxy deployment actions, provider-specific quota actions, usage filters,
  streaming observations, and media generation are not fully represented.
- Several composite actions (such as network endpoint inspection and combo bulk
  deletion) can still report exit 0 with nested errors or partial failures.
- Launcher dispatch recognizes a domain only as the first argv token; global flags
  before the domain need a separate launcher-safe parsing/dispatch test.

## Verification and next batches

Results: 37 focused tests across five files pass, including real CLI subprocesses
against a disposable HTTP server and a terminal-menu selection test. Another 17
existing CLI video/build-artifact tests pass: **54 tests across seven files**.
The help smoke check and `git diff --check` pass. ESLint was stopped after several
minutes without output; lint is not verified. The full repository suite and live
dashboard/provider end-to-end flows were not run.

Run from the repository root:

```
node tests/node_modules/vitest/vitest.mjs run --config tests/vitest.config.js tests/unit/cli-headless-contract.test.js tests/unit/cli-headless-regressions.test.js tests/unit/cli-headless-process.test.js tests/unit/cli-models-menu.test.js tests/unit/cli-codex-settings-route.test.js
node cli/cli.js providers --help
```

Next: maintain an action-level dashboard/TUI/headless matrix, implement missing
noninteractive workflows in small tested batches, then run opt-in end-to-end checks
against an explicitly selected disposable gateway. Existing README parity claims
are ahead of the implementation. The pre-existing README edits are left untouched.

## Model specs and reasoning efforts — 2026-10-08 (PR #33)

Single resolver: `resolveReasoningLevels()` in `open-sse/providers/capabilities.js`
(exact Codex entry → PATTERN_THINKING override → discovered models.dev ladder →
format default → drop `none` when `thinkingCanDisable === false` → Kiro null case).
`resolveModelSpec()` (`open-sse/providers/modelSpecs.js`) projects the full spec.
Combos keep the union (dispatcher re-encodes via coerceLevels). Per-tool wiring:

| Tool | Config file | Spec fields written | Effort field + vocabulary | Doc link |
| --- | --- | --- | --- | --- |
| Codex | `~/.codex/config.toml` + `afrouter-models.json` | context window, `model_reasoning_effort`, `reasoningEfforts` catalog | `reasoningEfforts` list, OpenAI vocabulary | Codex CLI docs |
| ZCode | `~/.zcode/v2/config.json` + Personal `provider_config.json` | limit, modalities, `reasoning.variants` / `reasoningLevel.values` | ZCode values (`disabled`/`enabled`/levels, strongest last) | zai-org/ZCode `provider-config-file-codec` |
| DeepSeek Harness Web/Desktop | `$DSH_HOME/profiles/<web\|desktop>/cordis.patch.yml` | contextWindow, maxTokens, input, `reasoningEfforts`, compat | display→wire map, `none`→`off: null` | dsh docs |
| Kilo | `~/.local/share/kilo/auth.json` (auth only) | none (auth.json holds no model metadata) | none — Kilo's precise display→wire map lives in the catalog surfaces (`kiloReasoning.js`), not the auth file | https://api.kilo.ai catalog |
| Pi | `~/.pi/agent/models.json` | contextWindow, maxTokens, input, reasoning | `thinkingLevelMap` (Pi keys, identity values, null hides; `off`→`"none"` or null) | https://pi.dev/docs/latest/models, earendil-works/pi v0.72.0 (#3208) |
| OMP | `~/.omp/agent/models.yml` | contextWindow, maxTokens, input, reasoning | `thinking: {mode: effort, efforts, defaultLevel}` (lowest-first) | can1357/oh-my-pi docs/models.md |
| OpenCode | `~/.config/opencode/opencode.json` (v1/v2) | limit, capabilities/modalities, reasoning (v1) | `variants` per level (`reasoningEffort`) | https://opencode.ai/docs/models/ |
| MimoCode | `~/.config/mimocode/mimocode.jsonc` (V1 shape) | limit, reasoning, tool_call, modalities | none verified in MimoCode docs — reasoning bool only, no invented keys | (OpenCode-fork V1 shape) |
| Grok Build | `~/.grok/config.toml` `[model.<slot>]` | context_window, max_completion_tokens, vision/reasoning in description | none — schema has no effort field | Grok CLI docs |
| Crush | `~/.config/crush/crush.json` | context_window (resolved; was hardcoded 128000), multi-model list | none verified — no effort field in schema | https://github.com/charmbracelet/crush/issues/2983, deepseek crush guide |
| Zed | `settings.json` `language_models.openai_compatible` | provider config (static per zedConfig) | none — Zed drives effort itself | Zed docs |
| Droid | `~/.factory/settings.json` | model id + maxOutputTokens | none verified | Factory docs |
| Copilot | VSCode `chatLanguageModels.json` | vision/maxOutputTokens (static) | none — provider-level only | VSCode docs |
| Hermes | `~/.hermes/config.yaml` (+`.env`) | `providers.afrouter.models.<id>.context_length` + `.supports_vision` (per model, multi-model additive list); slots reference `provider: custom:afrouter` | none — schema has no per-model ladder field. `agent.reasoning_overrides` is one effort per model and our resolver's `defaultLevel` is the *strongest* level, so writing it would silently inflate reasoning-token cost; omitted (`reasoning_effort: medium` is the documented chat_completions default) | https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models, /docs/integrations/providers
| Claude, Cline, CodeWhale, Forge, JCode, OpenClaw, Smelt, WorkBuddy, DeepSeek TUI, Cowork, Devin | various (id/baseUrl/key only or detect-only) | id/baseUrl/key only | none — no per-model effort field in schema (Cline's effort controls are provider-level UI, not config) | per-tool docs (see research notes in PR) |

Re-Apply semantics: Pi/OMP/OpenCode/MimoCode/Crush/DSH refresh specs for models
already written (additive merge overwrites owned entries — idempotent). ZCode
config.json preserves reasoning variants on existing entries by design (FR-005,
user-tuned); the Personal layer rebuilds rules from the resolver (manual-rule
overrides skipped). Hermes upserts `providers.afrouter` additively by model id
(idempotent; backup + atomic) and rewrites only the slot blocks that point at us.

### Hermes: one named provider, many models

Hermes' `providers:` dict holds named custom endpoints, and each entry's
`models:` mapping (list **or** id→metadata map) serves several models. Slots
reference the entry by name — `provider: custom:afrouter` — instead of
re-declaring `base_url` per slot. The previous implementation wrote an anonymous
`provider: custom` with an inline `base_url` into every slot, which is one
endpoint per model: `hermes model` / `/model` could never list a second AFRouter
model. Now:

```yaml
providers:
  afrouter:
    name: AFRouter
    api: http://127.0.0.1:20128/v1
    transport: chat_completions     # dict form; legacy list called it api_mode
    key_env: AFROUTER_API_KEY       # key lives in ~/.hermes/.env
    discover_models: false          # this mapping IS the picker's catalog
    models:
      openai/gpt-4o:
        context_length: 128000
        supports_vision: true
      deepseek/deepseek-v4-pro:
        context_length: 1000000

model:
  default: openai/gpt-4o
  provider: custom:afrouter
delegation:
  model: deepseek/deepseek-v4-pro
  provider: custom:afrouter
auxiliary:
  vision:
    model: openai/gpt-4o
    provider: custom:afrouter
```

Switch between them with `hermes model`, `/model` inside a chat, or
`/model custom:afrouter:<model-id>`. Docs:
[configuring-models](https://hermes-agent.nousresearch.com/docs/user-guide/configuring-models),
[providers](https://hermes-agent.nousresearch.com/docs/integrations/providers).

Verified against the source (`hermes_cli/config_defaults.py`): the canonical
auxiliary task ids are `vision, compression, skills_hub, approval, review, mcp,
title_generation, memory_query_rewrite, tts_audio_tags, triage_specifier,
kanban_decomposer, profile_describer, goal_judge, curator, monitor,
background_review, moa_reference, moa_aggregator`. `auxiliary.web_extract` and
`auxiliary.session_search` are dead — Hermes ignores leftover blocks — so the
role list no longer offers Web Extract, and `delegation` is a top-level block
rather than an auxiliary task.

Per-model keys are limited to what the docs define for
`providers.<name>.models.<id>`: `context_length` (2nd link of Hermes' context
resolution chain) and `supports_vision`. `max_output_tokens` is **not** written —
"Hermes no longer reads … `model_overrides.*.*.max_output_tokens`".

Grok Build rewrites owned `[model.<slot>]` sections (idempotent).
