---
name: afrouter-stt
description: Speech-to-text through AFRouter /v1/audio/transcriptions. Use when the user wants audio transcribed or subtitles generated from an audio file.
---

# AFRouter — Speech-to-Text

Auth: send `Authorization: Bearer $AFROUTER_KEY` (required unless the gateway has `requireApiKey` off). Setup: https://raw.githubusercontent.com/AFG473319/AFRouter/refs/heads/master/skills/afrouter/SKILL.md

```bash
BASE="${AFROUTER_URL:-http://localhost:20128}"
```

## Discover

```bash
curl $BASE/v1/models/stt | jq '.data[].id'
# Per-model params (language, response_format, prompt, temperature support)
curl "$BASE/v1/models/info?id=openai/whisper-1"
```

`model` = STT model ID (e.g. `openai/whisper-1`, `groq/whisper-large-v3`, `deepgram/nova-3`, `gemini/gemini-2.5-flash`).

## Endpoint

`POST $BASE/v1/audio/transcriptions` (OpenAI Whisper compatible, `multipart/form-data`)

| Field | Required | Notes |
|---|---|---|
| `model` | yes | from `/v1/models/stt` |
| `file` | yes | audio file (mp3, wav, m4a, webm, ogg, flac) |
| `language` | no | ISO-639-1 (e.g. `en`, `vi`) |
| `prompt` | no | hint text to guide transcription |
| `response_format` | no | `json` (default) / `text` / `verbose_json` / `srt` / `vtt` |
| `temperature` | no | 0–1 |

## Examples

```bash
curl -X POST "$BASE/v1/audio/transcriptions" \
  -H "Authorization: Bearer $AFROUTER_KEY" \
  -F "model=openai/whisper-1" \
  -F "file=@audio.mp3" \
  -F "language=vi"
```

JS (Node):

```js
import { createReadStream } from "node:fs";
const form = new FormData();
form.append("model", "groq/whisper-large-v3-turbo");
form.append("file", new Blob([await (await import("node:fs/promises")).readFile("audio.mp3")]), "audio.mp3");
const r = await fetch(`${process.env.AFROUTER_URL || "http://localhost:20128"}/v1/audio/transcriptions`, {
  method: "POST",
  headers: { "Authorization": `Bearer ${process.env.AFROUTER_KEY}` },
  body: form,
});
const { text } = await r.json();
console.log(text);
```

## Response shape

Default (`response_format=json`):
```json
{ "text": "Xin chào, đây là bản ghi âm." }
```

`verbose_json` adds `language`, `duration`, `segments[]` with timestamps.
`srt` / `vtt` return subtitle text.

## Provider quirks

| Provider | `model` format | Notes |
|---|---|---|
| `openai` | `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe` | Native OpenAI shape |
| `groq` | `whisper-large-v3`, `whisper-large-v3-turbo`, `distil-whisper-large-v3-en` | Fastest; OpenAI shape |
| `gemini` | `gemini-2.5-flash`, `gemini-2.5-pro`, `gemini-2.5-flash-lite` | Server converts to `generateContent` with audio inline |
| `deepgram` | `nova-3`, `nova-2`, `whisper-large` | Token auth; server adapts response |
| `assemblyai` | `universal-3-pro`, `universal-2` | Async upload+poll handled server-side |
| `nvidia` | `nvidia/parakeet-ctc-1.1b-asr` | NIM endpoint |
| `huggingface` | `openai/whisper-large-v3`, `openai/whisper-small` | HF Inference API |
