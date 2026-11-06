# Copilot instructions

All agent instructions for this repository live in [`AGENTS.md`](../AGENTS.md) at the repo root (single source of truth). Follow it.

Short version: verify every change with `npm run agent -- check` (one JSON line, ≤20 KB; `ok`, `failures[]`, `advice`). No browser (`shot`/`record`) unless the change is visual or the user asked. Stop after 2 failures on the same step and report. Never use port 20128 or the real AFRouter data dir.
