# API Contract: `deepseek-harness-settings`

**Feature**: `002-deepseek-harness-integration` | **Date**: 2026-09-15

Route: `src/app/api/cli-tools/deepseek-harness-settings/route.js`
Auth: covered by `PROTECTED_API_PATHS` in `src/dashboardGuard.js` (no guard change needed).
Never returns 500 for a missing or corrupt config (SC-004).

## `GET`

Status snapshot for the card and the `all-statuses` batch.

**Response 200 — installed and configured**

```json
{
  "installed": true,
  "hasAFRouter": true,
  "configPath": "<home>/settings.yaml",
  "credentialsPath": "<home>/.credentials.yaml",
  "corrupt": false,
  "harness": {
    "baseURL": "http://127.0.0.1:20128/v1",
    "models": ["cc/claude-sonnet-4-5-20250929"],
    "hasCredential": true
  }
}
```

**Response 200 — not installed**

```json
{ "installed": false, "harness": null, "message": "DeepSeek Harness is not installed" }
```

**Response 200 — installed, unparseable settings**

```json
{ "installed": true, "corrupt": true, "harness": null, "configPath": "<home>/settings.yaml" }
```

**Response 200 — installed, no AFRouter route**

```json
{ "installed": true, "hasAFRouter": false, "corrupt": false, "harness": { "models": [] } }
```

**Behavior**

- `installed` = harness home exists **or** a `dsh` binary resolves on PATH. Independent of whether `settings.yaml` exists (D2).
- `hasAFRouter` = `llm-pi-ai.providers.afrouter` exists with a `baseURL`.
- `hasCredential` reports whether `refs.AFROUTER_API_KEY` is set — **never the value** (Principle III).
- Corrupt YAML yields `corrupt: true`, never a throw.

## `POST`

Upsert the `afrouter` route and the credential ref.

**Request**

```json
{
  "baseUrl": "http://127.0.0.1:20128/v1",
  "apiKey": "sk_afrouter",
  "models": ["cc/claude-sonnet-4-5-20250929", "gemini/gemini-2.5-pro"],
  "modelSpecs": {
    "cc/claude-sonnet-4-5-20250929": { "contextWindow": 200000, "maxTokens": 32000, "vision": false, "reasoning": false },
    "gemini/gemini-2.5-pro": { "contextWindow": 1048576, "maxTokens": 65536, "vision": true, "reasoning": true }
  },
  "compat": { "thinkingFormat": "deepseek" }
}
```

- `baseUrl` (string) and `models` (non-empty array) required → else `400 { error }`.
- `modelSpecs` optional; when a model has no spec, resolve it server-side from the catalog (FR-006).
- `compat` optional advanced overrides; omitted by default.
- `apiKey` optional; when absent the existing ref is preserved.

**Response 200**

```json
{
  "success": true,
  "message": "DeepSeek Harness settings applied. Pick the afrouter model in dsh.",
  "configPath": "<home>/settings.yaml",
  "credentialsPath": "<home>/.credentials.yaml",
  "written": ["cc/claude-sonnet-4-5-20250929", "gemini/gemini-2.5-pro"],
  "unverified": [],
  "backupPath": "<home>/settings.yaml.bak-20260915-120000"
}
```

**Behavior**

- Normalize `baseUrl` to end in `/v1`.
- Create `<home>` and/or `settings.yaml` when absent.
- Merge into `llm-pi-ai.providers.afrouter`, preserving all other sections/providers (FR-005) and appending models without duplicating existing ids.
- Write `refs.AFROUTER_API_KEY` in `.credentials.yaml`, preserving all other refs/records.
- Backup + atomic rename for both files (FR-009).
- Refuse to write an unparseable `settings.yaml` (respond `{ success: false, error }`, file untouched).

## `DELETE`

**Request** — `DELETE /api/cli-tools/deepseek-harness-settings` (no query) or `?model=<id>`.

**Response 200**

```json
{ "success": true, "message": "AFRouter route removed", "entryRemoved": true, "removed": 3 }
```

**Behavior**

- No query: remove `llm-pi-ai.providers.afrouter`; drop the `llm-pi-ai` section only when it becomes empty; remove the credential ref only when it holds `sk_afrouter` or was integration-written (D4).
- `?model=<id>`: remove only that model; delete the route when the list becomes empty.
- Missing files → idempotent success (`{ success: true, message: "No config to reset" }`).
- Backup before write.

## `all-statuses` registration

```js
import { GET as deepseekHarnessGet } from "../deepseek-harness-settings/route";
// STATUS_GETTERS:
"deepseek-harness": deepseekHarnessGet,
```

## CLI launcher parity (deferred)

Not in v1. When added later, follow `cli/src/cli/menus/cliTools.js` + `cli/src/cli/api/client.js` (`getCliToolSettings`/`applyCliToolSettings`/`resetCliToolSettings`) hitting the same route.