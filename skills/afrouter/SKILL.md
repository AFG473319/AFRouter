---
name: afrouter
description: Entry point for AFRouter — local/remote AI gateway with OpenAI-compatible REST for chat, image, TTS, embeddings, web search, web fetch. Use when the user mentions AFRouter, AFROUTER_URL, or wants AI without writing provider boilerplate. This skill covers setup + indexes capability skills; fetch the relevant capability SKILL.md from the URLs below when needed.
---

# AFRouter

Local/remote AI gateway exposing OpenAI-compatible REST. One key, many providers, auto-fallback.

## Setup

```bash
export AFROUTER_URL="${AFROUTER_URL:-http://localhost:20128}"  # local default; or your VPS / tunnel URL
export AFROUTER_KEY="sk-..."                                   # from Dashboard → Keys (only if requireApiKey=true)
```

If `AFROUTER_URL` is unset, assume `http://localhost:20128` — never abort for a missing env var. `AFROUTER_KEY` is only needed when the gateway has auth enabled (local default: disabled, omit the header).

All requests: `${AFROUTER_URL}/v1/...` with header `Authorization: Bearer ${AFROUTER_KEY}` (omit if auth disabled).

Verify: `curl $AFROUTER_URL/api/health` → `{"ok":true}`

## Discover models

```bash
curl $AFROUTER_URL/v1/models                  # chat/LLM (default)
curl $AFROUTER_URL/v1/models/image            # image-gen
curl $AFROUTER_URL/v1/models/tts              # text-to-speech
curl $AFROUTER_URL/v1/models/embedding        # embeddings
curl $AFROUTER_URL/v1/models/web              # web search + fetch (entries have `kind` field)
curl $AFROUTER_URL/v1/models/stt              # speech-to-text
curl $AFROUTER_URL/v1/models/image-to-text    # vision
```

Use `data[].id` as `model` field in requests. Combos appear with `owned_by:"combo"`.

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
| Text-to-speech | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-tts/SKILL.md |
| Speech-to-text | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-stt/SKILL.md |
| Embeddings | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-embeddings/SKILL.md |
| Web search | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-web-search/SKILL.md |
| Web fetch (URL → markdown) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-web-fetch/SKILL.md |
| System One decisions (Jev) | https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter-systemone/SKILL.md |

## Errors

- 401 → set/refresh `AFROUTER_KEY` (Dashboard → Keys)
- 400 `Invalid model format` → check `model` exists in `/v1/models/<kind>`
- 503 `All accounts unavailable` → wait `retry-after` or add another provider account
