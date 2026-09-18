# Codex CLI / App Integration

AFRouter connects Codex to multiple upstream models using one custom provider and a separate model catalog. The generated catalog was checked with Codex CLI 0.154.0. Older clients may require an upgrade.

## Dashboard setup

1. Start AFRouter and open **Dashboard > CLI Tools > OpenAI Codex CLI / App**.
2. Choose the endpoint and an AFRouter API key.
3. Use **Add Model** to select multiple models. You can also enter a routed model ID or combo explicitly.
4. Click a model chip or use **Default Model** to choose the startup model. Optionally select a subagent model; leaving it blank uses Codex's normal inheritance.
5. Click **Apply**, then fully quit and reopen Codex. Select the published models from Codex's model picker or use `codex --model provider/model-id`.

Selection changes are staged until Apply. Previously managed models are retained unless explicitly removed. Reset disconnects this integration and restores the values it replaced, provided those values have not since been edited by the user.

## Files and provider structure

The gateway uses its `CODEX_HOME` environment variable, defaulting to `~/.codex`. Apply writes files on the gateway's machine, not the browser's machine. For remote installations, use **Manual Config** and update the catalog path for the machine running Codex.

- `config.toml`: selected model, the AFRouter provider, and `model_catalog_json`.
- `afrouter-models.json`: Codex model entries with context windows, compaction thresholds, input modalities, and supported reasoning efforts.
- `afrouter-integration.json`: ownership and previous values used for safe Reset. Keep this file with the configuration; it contains private settings and must not be shared.

Codex does not support `[model_providers.afrouter.models]`. The provider defines transport and authentication; model specifications belong in the separate JSON catalog. The dashboard groups these models under AFRouter, but Codex controls its own picker layout.

For manual configuration, merge the generated snippets instead of overwriting your configuration. A minimal provider configuration using the recommended environment-based authentication is:

```toml
model = "provider/model-id"
model_provider = "afrouter"
model_catalog_json = "/absolute/path/to/.codex/afrouter-models.json"

[model_providers.afrouter]
name = "AFRouter"
base_url = "http://127.0.0.1:20128/v1"
wire_api = "responses"
supports_websockets = false
env_key = "AFROUTER_API_KEY"
```

Set `AFROUTER_API_KEY` in the environment that launches Codex. Automatic Apply instead writes the dashboard-selected key as a provider-scoped Authorization header, so no shell setup is required. It never edits Codex's `auth.json` or logs out your OpenAI account.

## Model specs and limitations

The integration resolves exact model IDs and aliases from AFRouter's catalog, including stored custom-model capabilities. It uses the gateway's thinking-level resolver, restricted to the compatible Codex effort vocabulary. It does not invent an effort ladder for models without declared reasoning support.

Every entry includes its default in a nonempty selectable effort list. When no compatible effort ladder is known, the catalog exposes only the existing default: `medium` for reasoning models, `none` otherwise. Codex can select single-option models directly without showing another reasoning popup. This compatibility default is not proof of upstream support for adjustable effort levels.

Unknown models and combos receive an explicitly reported fallback: 128K context and text input only. This fallback is not a verified upstream limit. Register accurate custom-model metadata before using models with different limits. Output limits remain gateway/upstream concerns; they are not published as an unsupported Codex config field.

Global context-window, compaction, and reasoning-effort overrides would mask per-model metadata, so Apply temporarily removes them and Reset restores owned values. Explicit profiles, project settings, command-line overrides, and resumed sessions may still override user-level defaults.

The catalog does not advertise unverified search, parallel-tool, freeform-patch, WebSocket, or paid-tier capabilities. Publishing metadata does not make an upstream implement a missing capability.

## Safety and recovery

Apply and Reset back up existing files as `.bak-*`, replace files atomically, and roll back completed writes if a later write fails. TOML values are preserved, but serialization can normalize formatting and remove comments; backups retain the original text. Backups may contain credentials, so keep them private.

An existing user-owned `model_catalog_json` or an externally edited AFRouter catalog blocks Apply rather than being overwritten. Restore a damaged file from its backup before retrying. Reset leaves externally edited catalog contents and subsequent user edits intact. It never removes unrelated credentials or custom agent roles.

Only the selected AFRouter model catalog is active while this provider is selected. This does not merge native OpenAI models into the AFRouter route. Reset restores the prior provider settings when still owned.

## References

- [Official Codex configuration reference](https://developers.openai.com/codex/config-reference)
- [Official Codex advanced configuration](https://developers.openai.com/codex/config-advanced)
- [codex-router catalog implementation](https://github.com/duolahypercho/codex-router/blob/08dc3b6b2c30f2fa11dd433a6db3f40f761b51d4/src/catalog.mjs)
