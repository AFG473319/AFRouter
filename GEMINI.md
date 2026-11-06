# GEMINI.md

All agent instructions for this repository live in [`AGENTS.md`](AGENTS.md) (single source of truth). Read it before working here.

Verify every change with the agent harness: `npm run agent -- check` (one JSON line, ≤20 KB). Rules: no browser (`shot`/`record`) unless the change is visual or the user asked; stop after 2 failures on the same step and report; never use port 20128 or the real AFRouter data dir. To load `AGENTS.md` automatically instead, set `"context": { "fileName": ["AGENTS.md", "GEMINI.md"] }` in `.gemini/settings.json`.
