---
name: afrouter-embeddings
description: Vector embeddings through AFRouter /v1/embeddings. Use when the user wants embeddings for RAG, semantic search, clustering or similarity.
---

# AFRouter — Embeddings

Auth: send `Authorization: Bearer $AFROUTER_KEY` (required unless the gateway has `requireApiKey` off). Setup: https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter/SKILL.md

```bash
BASE="${AFROUTER_URL:-http://localhost:20128}"
```

## Discover

```bash
curl $BASE/v1/models/embedding | jq '.data[].id'
# Per-model dimensions
curl "$BASE/v1/models/info?id=openai/text-embedding-3-small"
```

## Endpoint

`POST $BASE/v1/embeddings`

| Field | Required | Notes |
|---|---|---|
| `model` | yes | from `/v1/models/embedding` |
| `input` | yes | string OR array of strings |
| `encoding_format` | no | `float` (default) / `base64` |
| `dimensions` | no | OpenAI v3 only |

## Examples

```bash
curl -X POST $BASE/v1/embeddings \
  -H "Authorization: Bearer $AFROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"openai/text-embedding-3-small","input":["hello","world"]}'
```

JS:

```js
const r = await fetch(`${process.env.AFROUTER_URL || "http://localhost:20128"}/v1/embeddings`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.AFROUTER_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gemini/text-embedding-004", input: "RAG chunk text" }),
});
const { data } = await r.json();
console.log(data[0].embedding.length);  // dimension
```

## Response shape

```json
{ "object": "list", "model": "openai/text-embedding-3-small",
  "data": [
    { "object": "embedding", "index": 0, "embedding": [0.0123, -0.045, ...] },
    { "object": "embedding", "index": 1, "embedding": [...] }
  ],
  "usage": { "prompt_tokens": 5, "total_tokens": 5 } }
```

## Provider quirks

| Provider | Notes |
|---|---|
| `openai`, `openrouter`, `mistral`, `voyage-ai`, `fireworks`, `together`, `nebius`, `github`, `nvidia`, `jina-ai` | Native OpenAI shape — `dimensions` works only on OpenAI v3 (`text-embedding-3-*`) |
| `gemini`, `google_ai_studio` | Server auto-converts to `embedContent`/`batchEmbedContents` — send OpenAI shape |
| `openai-compatible-*`, `custom-embedding-*` | Custom `baseUrl` from credentials |

Batch (`input` as array) is faster; some providers cap batch size.
