# Quickstart: DeepSeek Harness (dsh) Integration

**Feature**: `002-deepseek-harness-integration`

## For the implementer

Reference precedents to read before coding:

- Route: `src/app/api/cli-tools/deepseek-tui-settings/route.js` (single-tool route, GET/POST/DELETE, backup + atomic write) — but replace the hand-rolled TOML with `confbox/yaml`, and take the multi-model merge from `opencode-settings/route.js` and the safety posture from `zcode-settings/route.js`.
- Card: `src/app/(dashboard)/dashboard/cli-tools/components/OpenCodeToolCard.js` (multi-model list + `ModelSelectModal` + Manual Config).
- Config transforms: `src/lib/grokBuildConfig.js` (the precedent for a `src/lib/*Config.js` module) and `src/lib/zcodeModelOwnership.js`.
- Capabilities: `getCapabilitiesForModel(provider, modelId)` in `open-sse/providers/capabilities.js`; alias resolution `resolveProviderAlias` in `open-sse/services/model.js`.

Run the dashboard:

```bash
PORT=20128 npm run dev
```

Lint before committing:

```bash
npx eslint .
```

Tests (from the independent `tests/` package):

```bash
cd tests && npx vitest run unit/deepseek-harness-settings.test.js
```

Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, never raw pass counts.

## Manual verification (local)

1. Start AFRouter on `20128` and confirm `curl http://127.0.0.1:20128/v1/models` returns models.
2. Ensure a harness home exists: `~/.dsh` (or set `DSH_HOME`). `npx @deepseek-ai/dsh web --no-open` once if you want dsh to create it.
3. Open `http://127.0.0.1:20128/dashboard/cli-tools`, expand **DeepSeek Harness**.
4. Pick the endpoint (`http://127.0.0.1:20128/v1`), an API key, and 1–2 models → **Apply**.
5. Inspect `~/.dsh/settings.yaml` — expect:

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

6. Inspect `~/.dsh/.credentials.yaml` — expect `version: 1` and `refs.AFROUTER_API_KEY`; confirm no other refs/records were lost.
7. In dsh (`npx @deepseek-ai/dsh web`), pick the `afrouter` route and one of the applied models, run a task, and confirm it reaches AFRouter.
8. Back in the card, click **Reset** and confirm the `afrouter` route is gone from `settings.yaml` while other providers and the user's real key survive.

## What success looks like

- One Apply, no YAML editing (SC-001).
- Status < 500 ms, Apply < 2 s (SC-002).
- Applying 1 then 5 models never loses existing dsh settings or credentials (SC-003).
- No missing/corrupt config ever produces a 500 (SC-004).
- Reset returns dsh to its pre-integration route set (SC-005).