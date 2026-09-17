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
  not comprehensively exposed. Guide-only tools must not be sent to nonexistent
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
