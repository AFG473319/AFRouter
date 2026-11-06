---
name: agent-harness
description: Verify a change to AFRouter (gateway, API routes, dashboard pages) with the repo's agent harness, `npm run agent -- <cmd>`, which runs an isolated server and prints one bounded JSON line. Use after every code change in this repo, and when asked to check, test, screenshot or debug the app.
---

# AFRouter agent harness

Full reference: the **Agent harness** section of `AGENTS.md` (single source of truth). This skill is the short form.

## Rules
- Browserless by default. No `shot` / `record` / `flow --engine browser` unless the change is visual (CSS, layout, className, components) or the user asked to see it.
- Stop after 2 failures on the same step. Report the error and `runDir`; do not keep retrying.
- Never use port 20128 (or 20127/20129) and never the real data dir (`%APPDATA%\afrouter`, `~/.afrouter`). Do not override `DATA_DIR`, `PORT` or `HOME`.
- Only `npm run agent -- down` stops the server. Never kill processes by name.

## Loop
1. `npm run agent -- check` after the change; fix `failures[0]` first; repeat until `"ok": true` (known baseline failures never count).
2. API / gateway: `api <METHOD> <path>`, `chat [--format anthropic]` (fake upstream, no real keys).
3. Dashboard logic: `render <route>` (happy-dom, data loaded), `page <route>` (SSR), `flow <file.json>`.
4. Visual change or asked: `shot <route>` once; hand the user the PNG path. Before/after: `--baseline name` or `diff a.png b.png`.
5. `npm run agent -- down` when finished.

## Output
One JSON object per command, ≤20 KB: `cmd`, `ok`, `ms`, `failures[]`, `advice`, `runDir` (absolute; bulky files and the full `result.json` are there), `omitted[]` when something was cut. Exit 0 ok, 1 check failed, 2 harness error.

## When something is off
`npm run agent -- doctor` shows which lanes work (Vitest, happy-dom, browser, ffmpeg) and writes `.agent/capabilities.json`. A stale dev build: `up --clean-build`. Browser choice: `--browser`, `AFROUTER_HARNESS_BROWSER_PATH`, or `agent-harness.config.json`.
