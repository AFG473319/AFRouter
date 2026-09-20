---
name: afrouter-systemone
description: Typed decisions through AFRouter /v1/systemone (TypeSafe Jev 1.13 Free). Use when the user wants classification, routing, scoring or urgency detection with probabilities instead of generated text.
---

# AFRouter — System One decisions (Jev 1.13 Free)

Auth: send `Authorization: Bearer $AFROUTER_KEY` (required unless the gateway has `requireApiKey` off). Setup: https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter/SKILL.md

```bash
BASE="${AFROUTER_URL:-http://localhost:20128}"
```

Jev is a decisions-only model: it evaluates typed **questions** against a **state** and returns probabilities rather than generated text.

## Discover

The model id is fixed: **`oc/jev-1.13-free`**. `oc` is the alias of the `opencode` provider, so `opencode/jev-1.13-free` is the same model. It runs on AFRouter's no-auth OpenCode provider, so it needs no OpenCode account and no credits.

Call that id directly. `GET /v1/models` groups by saved connections, and `opencode` is a no-auth provider with no connection, so the catalog omits it whenever the instance has any other provider connected.

`/v1/models/info` reports `endpoint: /v1/chat/completions` for Jev because it defaults to the LLM kind. Jev's real endpoint is `/v1/systemone`, as shown below.

## Endpoint

`POST $BASE/v1/systemone` — model id **`oc/jev-1.13-free`**

## Examples

```bash
curl -X POST $BASE/v1/systemone \
  -H "Authorization: Bearer $AFROUTER_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"oc/jev-1.13-free","state":"Hi, my payouts have been failing for 3 days. Please help ASAP.","questions":{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}}'
```

Full request with all three question types:

```json
{
  "model": "oc/jev-1.13-free",
  "state": "Hi, my payouts have been failing for 3 days. Please help ASAP.",
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "Does this convey urgency?" },
    "department":  { "type": "choice", "instructions": "Which team should handle this?",
                     "criteria": { "billing": "Payments, invoicing, refunds",
                                   "technical": "Bugs, outages, integrations",
                                   "sales": "Pricing, upgrades, new accounts" } },
    "frustration": { "type": "score",  "instructions": "How frustrated is the customer?",
                     "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

Rules (gateway validates before forwarding): `state` (string/object/array) and at least one question are required; `choice` needs a non-empty `criteria` map (max 255 options); `score` needs a `criteria` array of 2–10 ordered levels. All questions in one call are evaluated in parallel against the same state.

JS:

```js
const r = await fetch(`${process.env.AFROUTER_URL || "http://localhost:20128"}/v1/systemone`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.AFROUTER_KEY}`, "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "oc/jev-1.13-free",
    state: "Hi, my payouts have been failing for 3 days. Please help ASAP.",
    questions: { is_urgent: { type: "noul", instructions: "Does this convey urgency?" } },
  }),
});
const { answers } = await r.json();
console.log(answers.is_urgent.noul);  // 0..1 probability of yes
```

## Response shape

```json
{ "model": "jev-1.13-free",
  "answers": {
    "department":  { "type": "choice", "choice": "technical", "confidence": 0.73,
                     "probabilities": { "technical": 0.82, "billing": 0.18, "sales": 0 } },
    "frustration": { "type": "score", "score": 1, "confidence": 1,
                     "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                     "probabilities": { "0": 0, "1": 1, "2": 0 } },
    "is_urgent":   { "type": "noul", "noul": 1 } },
  "usage": { "input_tokens": 425, "output_tokens": 73 }, "cost": "0" }
```

`choice`/`score` also return `confidence` (0–1, derived from the distribution); `noul` returns a 0 (no) → 1 (yes) probability. Free tier: `cost: "0"`.

## Provider quirks

| Provider | `model` format | Notes |
|---|---|---|
| `opencode` (`oc`) | `jev-1.13-free` | Free, no-auth, served by the AFRouter gateway — no OpenCode account needed |
| `opencode-go` (`ocg`) | — | Carries no System One model |

Jev ids route to `https://opencode.ai/zen/v1/systemone`; the request body is passed through untouched (no chat translation).

## Errors

- `400` validation text (missing `state`/`questions`, bad question type, bad `criteria`) — fix the body and retry.
- `400 Model <x> is not a System One model` — you sent a chat model here; use `/v1/chat/completions` for it.
- `400` on `/v1/chat/completions` naming a System One model — switch to `/v1/systemone` as shown above.
- `401 Missing API key` — auth is on by default; send `Authorization: Bearer $AFROUTER_KEY`.
- `503 All accounts unavailable` — upstream accounts exhausted; wait or add another provider account.

Upstream reference: https://docs.typesafe.ai/api
