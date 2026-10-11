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

## CLI tool config writers — current state (2026-10-11, PRs #39 + #41)

Every tool that accepts per-model metadata now writes specs resolved from
`resolveModelSpec()` (`open-sse/providers/modelSpecs.js`, itself built on
`resolveReasoningLevels()` in `open-sse/providers/capabilities.js`), through the
shared IO in `src/lib/cliConfigIO.js`: a parse failure aborts with **409** instead
of overwriting the user's file, every write is **backup + atomic** (0600 when the
file holds a key), and effort levels are never invented. Paths and env overrides
are per tool. Verification column names the doc/source the writer was checked
against.

| Tool | Config path(s) per OS + env overrides | What's written | Effort field + vocabulary | Doc / source verified against |
| --- | --- | --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml` + `afrouter-models.json` (default `~/.codex`) | `model`, `model_provider`, provider table, catalog with `context_window`, `supported_reasoning_levels` | `default_reasoning_level` + `supported_reasoning_levels`; OpenAI vocabulary incl. `max`, `ultra` (open string) | codex-rs `protocol/src/openai_models.rs` |
| Crush | `$CRUSH_GLOBAL_CONFIG/crush.json`, else `$XDG_CONFIG_HOME/crush/crush.json` | `providers.afrouter` + full catwalk model (`context_window`, `default_max_tokens`, `can_reason`, `supports_attachments`, `cost_per_1m_*`) | `reasoning_levels` + `default_reasoning_effort`; left out for toggle-only/non-reasoning | charmbracelet/catwalk `pkg/catwalk/provider.go` |
| Zed | `%APPDATA%\Zed\settings.json` (Win), `~/.config/zed` (mac/Linux, XDG/FLATPAK) | `language_models.openai_compatible` model objects | `reasoning_effort`: none\|minimal\|low\|medium\|high\|xhigh\|max | crates/settings_content `language_model.rs` |
| Copilot | VSCode `…/Code/User/chatLanguageModels.json` | `vendor: customendpoint`, `apiType`, per-model `maxInputTokens`, `maxOutputTokens`, `vision`, `thinking` | `supportsReasoningEffort` (array) | microsoft/vscode-docs language-models |
| Droid | `~/.factory/settings.json` (`%USERPROFILE%\.factory`) | `customModels[]` with `provider: generic-chat-completion-api`, `maxOutputTokens`, `noImageSupport`, top-level `model` | none (top-level `reasoningEffort` is provider-level) | docs.factory.ai/model-independence/byok |
| OpenClaw | `$OPENCLAW_HOME/$OPENCLAW_CONFIG_PATH` else `~/.openclaw/openclaw.json` (JSON5) | `models.providers.afrouter` models + `agents.entries` overrides + per-agent `models.json` | `thinkingLevelMap`; `agents.defaults.thinkingDefault` | openclaw `src/config/zod-schema.core.ts` |
| WorkBuddy | `~/.workbuddy-ai/models.json` preferred, else `~/.workbuddy/models.json` | `models[]` with `maxInputTokens`, `maxOutputTokens`, `supportsImages`, `supportsReasoning` | `reasoning.supportedEfforts` (+`defaultEffort`) | codebuddy.ai/docs/cli/models |
| OMP | agent dir `$PI_CODING_AGENT_DIR`/`~/.omp/agent`: `models.yml`\|`models.yaml`, `config.yml`\|`config.yaml` | provider `models[]` id/name/input/contextWindow/maxTokens/reasoning | `thinking: {mode: effort, efforts, defaultLevel, requiresEffort}`; lowest-first | can1357/oh-my-pi docs/models.md |
| DeepSeek Harness | `$DSH_HOME/profiles/<web\|desktop>/cordis.patch.yml` | contextWindow, input, `reasoningEfforts` (no guessed maxTokens) | display→wire map, `none`→`off: null`; dsh levels off..max (`ultra`→max) | dsh `packages/llm/llm-pi-ai/src/catalog.ts` |
| DeepSeek TUI / CodeWhale | `$CODEWHALE_CONFIG_PATH` else `~/.codewhale/config.toml` (legacy `~/.deepseek`) | `[providers.afrouter]` kind/base_url/api_key/model/context_window, `provider`, `default_text_model` | none documented | codewhale-hq/Codewhale docs/CONFIGURATION.md |
| MiMoCode | `$MIMOCODE_HOME/config/mimocode.jsonc`, else `$XDG_CONFIG_HOME/mimocode/mimocode.jsonc` | V1 provider: `limit`, `reasoning`, `tool_call`, `modalities` | `variants` map (`reasoningEffort`) | mimo.xiaomi.com/mimocode (config-overrides) |
| OpenCode | `$OPENCODE_CONFIG`, else `$XDG_CONFIG_HOME/opencode/opencode.{json,jsonc}` | V1 or V2 provider + subagent | V1 `variants` map / V2 `variants[]` (`reasoningEffort`) | opencode.ai/docs/models |
| jcode | `~/.jcode/config.toml`; env file in `dirs::config_dir()/jcode` (`$JCODE_HOME`) | `providers.afrouter` + `[[providers.afrouter.models]]` (context_window, reasoning, reasoning_effort, input) + `[provider]` | `reasoning_effort` | 1jehuang/jcode `jcode-config-types` |
| Grok Build | `$GROK_HOME/config.toml` (default `~/.grok`) | one `[model.<id>]` per model + `[models] default` | `supports_reasoning_effort` + `reasoning_effort`; `[models].default_reasoning_effort` (low\|medium\|high) | docs.x.ai/build/settings/reference |
| Kilo | `$KILO_CONFIG`/`$KILO_CONFIG_DIR` else `$XDG_CONFIG_HOME/kilo/kilo.jsonc` | OpenCode V1 `provider.afrouter` + `model` | V1 `variants` map | kilo.ai/docs/getting-started/settings |
| Cline | `$CLINE_DATA_DIR`/`$CLINE_DIR` else `~/.cline/data/settings/providers.json` | `providers.openai-compatible` settings (baseUrl kept with `/v1`) | none documented | docs.cline.bot/getting-started/config |
| Smelt | `$XDG_CONFIG_HOME/smelt/init.lua` | managed `provider.register("afrouter", ...)` Lua block | none (effort not in provider register) | leonardcser.github.io/smelt |
| Forge | `$FORGE_CONFIG` → `~/forge` → `~/.forge` `.forge.toml` | `[[providers]]` afrouter + `[session]` | none | tailcallhq/forgecode `forge_config/src/reader.rs` |
| Hermes | `$HERMES_HOME` else `~/.hermes` (POSIX) / `%LOCALAPPDATA%\hermes` (Win) | `providers.afrouter.models.<id>.context_length` + `.supports_vision`, slots `provider: custom:afrouter` | none — no per-model ladder; `agent.reasoning_overrides` omitted to avoid inflating cost | hermes-agent.nousresearch.com docs |
| ZCode | `$ZCODE_DATA_BASE_DIR/.zcode/v2/{config.json,provider_config.json}` | limit/modalities + Personal `providerModelRules` | ZCode values (`disabled`/`enabled`/levels) | zai-org/ZCode provider-config codec |
| Pi | `$PI_CODING_AGENT_DIR` (`~` expanded) else `~/.pi/agent/models.json` | contextWindow, maxTokens, input, reasoning | `thinkingLevelMap` (identity; `off` hides when no-disable) | pi.dev/docs/latest/models |
| Cowork | Claude-3p `configLibrary/<id>.json` (`~/.config/Claude-3p`, `%LOCALAPPDATA%\Claude-3p`) | `inferenceProvider`, `inferenceGateway*`, `inferenceModels`, `managedMcpServers` | per-model `maxEffort` (low\|medium\|high\|xhigh\|max) + `supports1m` | claude.com/docs/third-party/claude-desktop |

Tools that carry only an id/base URL/key (no per-model effort field in their
schema) are not listed individually: Claude (env vars), Devin (local ACP binary),
continue/roo/amp/qwen/cursor/opendesign (guide-only), Antigravity/Kiro (MITM
model-mapping lists).

### Kiro MITM mapping list

Kiro has no fallback: a MITM slot whose id is not in the Kiro provider registry
never maps, so the request bypasses AFRouter. `MITM_TOOLS.kiro.defaultModels`
must therefore be a subset of `open-sse/providers/registry/kiro.js` (pseudo-ids
`auto` and `simple-task` excepted). GPT-5.6 multipliers/context match
kiro.dev/docs/models (Sol 4.4x, Terra 2.2x, Luna 0.6x, 1M context).

Re-Apply semantics: Pi/OMP/OpenCode/MiMoCode/Crush/DSH refresh specs for models
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
