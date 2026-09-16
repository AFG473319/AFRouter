# Phase 1 Data Model: DeepSeek Harness (dsh) Integration

**Feature**: `002-deepseek-harness-integration` | **Date**: 2026-09-15

All state lives in dsh-owned files under the harness home. AFRouter-side state is zero.

## Paths

| Name | Resolution | Notes |
|---|---|---|
| Harness home | `process.env.DSH_HOME` else `path.join(os.homedir(), ".dsh")` | Honors `DSH_HOME` (FR-011) |
| Settings file | `<home>/settings.yaml` | The document the dsh Models page writes |
| Credentials file | `<home>/.credentials.yaml` | Owner-only; dsh's secret store |
| Profiles dir | `<home>/profiles/` | Existence is a secondary install signal |

## `settings.yaml` (AFRouter-owned slice)

Only `llm-pi-ai.providers.afrouter` is AFRouter-owned. Everything else in the document is preserved verbatim.

```yaml
llm-pi-ai:
  providers:
    afrouter:                         # AFRouter-owned route key
      displayName: AFRouter
      apiKeyEnv: AFROUTER_API_KEY     # credential reference, never the secret
      api: openai-completions         # OpenAI Chat Completions
      baseURL: http://127.0.0.1:20128/v1
      models:                         # non-empty; required for a hand-declared route
        - id: cc/claude-sonnet-4-5-20250929
          name: cc/claude-sonnet-4-5-20250929
          contextWindow: 200000
          maxTokens: 32000
        - id: gemini/gemini-2.5-pro
          name: gemini/gemini-2.5-pro
          contextWindow: 1048576
          maxTokens: 65536
          input: [text, image]        # declared only when the catalog reports vision
        - id: deepseek/deepseek-v4-pro
          name: deepseek/deepseek-v4-pro
          contextWindow: 1000000
          maxTokens: 256000
          compat:
            thinkingFormat: deepseek  # only when reasoning behind the gateway needs it
          reasoningEfforts:
            off:
            low: low
            medium: medium
            high: high
            max: max
```

### Field rules (from the `dsh-llm-pi-ai` reference)

| Field | Required | Value written | Rule |
|---|---|---|---|
| `displayName` | no | `AFRouter` | Label in the picker |
| `apiKeyEnv` | yes | `AFROUTER_API_KEY` | Credential reference resolved per request |
| `api` | yes | `openai-completions` | Hand-declared route must name a protocol |
| `baseURL` | yes | `<baseUrl>/v1` | `openai-completions` appends `/chat/completions` |
| `models` | yes | ≥ 1 entry | Route is refused with an empty list |
| model `id` | yes | exact AFRouter model value (`alias/model-id`) | Sent on the wire |
| model `name` | no | same as `id` | Picker label |
| model `contextWindow` | yes (hand-declared) | catalog `contextWindow` | Positive integer |
| model `maxTokens` | yes (hand-declared) | catalog `maxOutput` | Positive integer |
| model `input` | no | `[text, image]` | Only when catalog reports vision; omit for text-only |
| model `reasoningEfforts` | no | level map with OpenAI spellings | Only when catalog reports reasoning |
| model `compat` | no | `{ thinkingFormat: deepseek }` | Only for DeepSeek-family models behind the gateway; advanced toggle |
| route `compat` | no | optional | Advanced toggle (`supportsDeveloperRole: false`, `maxTokensField: max_tokens`) |

## `.credentials.yaml` (AFRouter-owned slice)

Only `refs.AFROUTER_API_KEY` is AFRouter-owned. All other refs and records are preserved.

```yaml
version: 1

refs:
  AFROUTER_API_KEY: sk_afrouter
  DEEPSEEK_API_KEY: sk-...        # preserved
records:
  llm-pi-ai/openai-codex:         # preserved verbatim
    kind: grant
    payload:
      type: oauth
      access: eyJ...
```

### Reset ownership rule

| Stored value | Reset behavior |
|---|---|
| `sk_afrouter` (the AFRouter default) | Remove `refs.AFROUTER_API_KEY` |
| Written by this integration to a real key | Remove (integration-owned) |
| A key the user entered by hand before this integration | Preserve |

## API route data shapes

### `GET /api/cli-tools/deepseek-harness-settings`

```json
{
  "installed": true,
  "hasAFRouter": true,
  "configPath": "C:\\Users\\me\\.dsh\\settings.yaml",
  "credentialsPath": "C:\\Users\\me\\.dsh\\.credentials.yaml",
  "corrupt": false,
  "harness": {
    "baseURL": "http://127.0.0.1:20128/v1",
    "models": ["cc/claude-sonnet-4-5-20250929"],
    "hasCredential": true
  }
}
```

Not installed → `{ "installed": false, "harness": null, "message": "DeepSeek Harness is not installed" }`.
Corrupt settings → `{ "installed": true, "corrupt": true, "harness": null }`.
No route → `{ "installed": true, "hasAFRouter": false, "harness": { "models": [] } }`.

### `POST /api/cli-tools/deepseek-harness-settings`

Request: `{ "baseUrl": "http://127.0.0.1:20128/v1", "apiKey": "sk_afrouter", "models": ["cc/...","gemini/..."], "modelSpecs": { "cc/...": {"contextWindow":200000,"maxTokens":32000,"vision":false,"reasoning":false} }, "compat": {"thinkingFormat":"deepseek"} }`

Response: `{ "success": true, "message": "...", "configPath": "...", "credentialsPath": "...", "written": ["cc/..."], "unverified": [], "backupPath": "..." }`

Rules: `baseUrl` and a non-empty `models` array required (else 400); normalize `/v1`; upsert the `afrouter` route; merge/append models into the existing list; write the credential ref.

### `DELETE /api/cli-tools/deepseek-harness-settings`

- No query → remove the `afrouter` route; remove the credential ref only under the ownership rule.
- `?model=<id>` → remove that model from the route's list; delete the route when the list becomes empty.

Response: `{ "success": true, "message": "...", "entryRemoved": bool, "removed": <n> }`

## State transitions

```
not installed        --(harness home absent)-->  [card: install guidance + Manual Config]
installed, no config --(Apply)-->  installed, configured (afrouter route + credential ref)
installed, configured --(Apply more models)-->  installed, configured (route extended)
installed, configured --(Reset)-->  installed, not configured (route removed; user key preserved)
installed, configured --(Reset ?model=)-->  installed, configured (one model removed)
```
