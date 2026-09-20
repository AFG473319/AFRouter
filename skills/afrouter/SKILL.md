---
name: afrouter
description: Setup for AFRouter, a local or remote OpenAI-compatible AI gateway, plus an index of every capability skill. Use when the user mentions AFRouter or asks for AI capability routing without provider boilerplate.
---

# AFRouter

Local/remote AI gateway exposing OpenAI-compatible REST. One key, many providers, auto-fallback.

## Base URL

Resolve the base URL once and use it everywhere:

```bash
BASE="${AFROUTER_URL:-http://localhost:20128}"
```

`AFROUTER_URL` is a convenience variable for these skills, not a gateway setting. Set it to reach a remote VPS or tunnel gateway; when it is unset, `$BASE` is `http://localhost:20128`. The CLI launcher reaches the same gateway through `AFROUTER_HOST` (default `127.0.0.1`) and `AFROUTER_PORT` (default `20128`).

## Auth

Send the API key on every request:

```bash
export AFROUTER_KEY="sk_afrouter..."   # create in Dashboard → Keys
curl -s "$BASE/v1/models" -H "Authorization: Bearer $AFROUTER_KEY"
```

AFRouter ships with `requireApiKey: true`, so a request without the header returns `401 Missing API key`. The gateway skips the key check only when the operator turns `requireApiKey` off (Dashboard → Endpoint).

## Verify

```bash
curl -s "$BASE/api/health"        # → {"ok":true}
```

`/api/health` serves without auth, so it confirms the gateway is up before you debug keys.

## Discover models

```bash
curl -s "$BASE/v1/models" -H "Authorization: Bearer $AFROUTER_KEY"           # chat/LLM (default)
curl -s "$BASE/v1/models/image" -H "Authorization: Bearer $AFROUTER_KEY"     # image-gen
curl -s "$BASE/v1/models/tts" -H "Authorization: Bearer $AFROUTER_KEY"       # text-to-speech
curl -s "$BASE/v1/models/embedding" -H "Authorization: Bearer $AFROUTER_KEY" # embeddings
curl -s "$BASE/v1/models/web" -H "Authorization: Bearer $AFROUTER_KEY"       # web search + fetch (entries have `kind` field)
curl -s "$BASE/v1/models/stt" -H "Authorization: Bearer $AFROUTER_KEY"       # speech-to-text
curl -s "$BASE/v1/models/image-to-text" -H "Authorization: Bearer $AFROUTER_KEY"  # vision
```

Use `data[].id` as the `model` field in requests. Combos appear with `owned_by:"combo"`.

Response shape:
```json
{ "object": "list", "data": [
  { "id": "openai/gpt-5", "object": "model", "owned_by": "openai", "created": 1735000000 },
  { "id": "tavily/search", "object": "model", "kind": "webSearch", "owned_by": "tavily", "created": 1735000000 }
]}
```

## Capability skills

When the user needs a specific capability, fetch that skill's `SKILL.md` from its raw URL:

| Capability | Raw URL |
|---|---|
| Chat / code-gen | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-chat/SKILL.md |
| Image generation | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-image/SKILL.md |
| Video generation (xAI Grok Imagine) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-video/SKILL.md |
| Text-to-speech | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-web-fetch/SKILL.md |
| System One decisions (Jev) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-systemone/SKILL.md |

## Errors

- `401 Missing API key` → auth is on by default; send `Authorization: Bearer $AFROUTER_KEY` (Dashboard → Keys)
- `ECONNREFUSED` on `http://localhost:20128` → the gateway is not running; start it with `npm run dev` or `afrouter`
- `400 Invalid model format` → check `model` exists in `/v1/models/<kind>`
- `503 All accounts unavailable` → wait `retry-after` or add another provider account
