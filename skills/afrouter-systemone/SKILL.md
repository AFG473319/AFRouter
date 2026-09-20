---
name: afrouter-systemone
description: Structured decisions via TypeSafe Jev 1.13 Free through AFRouter — POST /v1/systemone with {model: oc/jev-1.13-free, state, questions} using noul/choice/score questions. Use when the user wants classification, routing, scoring, urgency detection, or any typed decision with probabilities instead of generated text.
---

# AFRouter — System One decisions (Jev 1.13 Free)

Requires `AFROUTER_URL` (defaults to `http://localhost:20128` when unset -- no export needed for a local gateway) and `AFROUTER_KEY` only if auth enabled. See https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter/SKILL.md for setup. No key is needed when the gateway runs with auth disabled.

Jev is a decisions-only model: it evaluates typed **questions** against a **state** and returns probabilities — it cannot generate chat text. Calling it via `/v1/chat/completions` returns `400` telling you to use `/v1/systemone` instead.

## Endpoint

- `POST $AFROUTER_URL/v1/systemone` — model id **`oc/jev-1.13-free`**
  (`oc` is the alias of the `opencode` provider; `opencode/jev-1.13-free` works identically.
  The catalog also lists `opencode/jev-1.13` (paid) — it needs a Zen key with balance, so prefer the free id.)

## Request

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

```bash
curl -X POST $AFROUTER_URL/v1/systemone \
  -H "Content-Type: application/json" \
  -d '{"model":"oc/jev-1.13-free","state":"Hi, my payouts have been failing for 3 days. Please help ASAP.","questions":{"is_urgent":{"type":"noul","instructions":"Does this convey urgency?"}}}'
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

## Errors

- `400` validation text (missing `state`/`questions`, bad question type, bad `criteria`) — fix the body and retry.
- `400 Model <x> is not a System One model` — you sent a chat model here; use `/v1/chat/completions` for it.
- `400` on `/v1/chat/completions` naming a System One model — switch to `/v1/systemone` as shown above.
- `503 All accounts unavailable` — upstream accounts exhausted; wait or add another provider account.

Upstream reference: https://docs.typesafe.ai/api
