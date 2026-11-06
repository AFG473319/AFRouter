# AGENTS.md

Instructions for coding agents working in this repository. This file is the single source of truth: `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` and `.cursor/rules/` only point here.

## What this is

AFRouter (`afrouter-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `afrouter-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `afrouter`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Bun variants: `npm run dev:bun` / `build:bun` / `start:bun`.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`). To verify a change, prefer `npm run agent -- check` (see **Agent harness** below).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package — not wired into root `npm test`):
```bash
npm install                             # ROOT deps first — tests import from src/ which needs `open`, `undici`, etc.
cd tests && npm install                 # then tests' own deps (vitest) → tests/node_modules (allowed by tests/.gitignore)
npx vitest run                          # all tests; auto-discovers tests/vitest.config.js
npx vitest run unit/capabilities.test.js   # single file (path relative to tests/)
```
> The committed `tests/package.json` `test` script hardcodes Unix paths (`NODE_PATH=/tmp/node_modules …`) — a shared-install workaround from upstream. On Windows (or anywhere), ignore it and use the `npx vitest` form above; `vitest.config.js` resolves the `open-sse`/`@/` aliases from the repo root regardless of where vitest lives.
>
> **The suite is NOT expected to be all-green on a plain checkout.** ~938 pass, ~64 fail. Judge regressions with `tests/__baseline__/verify-no-regression.mjs`, not a raw run. Expected red:
> - 26 catalogued in `tests/__baseline__/known-fails.txt` (rtk, oauth-cursor-auto-import, translator-request-normalization, …).
> - `unit/embeddings.cloud.test.js` imports `cloud/src/handlers/embeddings.js` — the `cloud/` worker dir is **not in this repo**, so it always fails here.
> - `unit/xai-oauth-service.test.js` times out (5s) when the xAI endpoint-discovery fetch isn't reachable/mocked.
> - `real/*.real.test.js` make live provider calls — need credentials, skip otherwise.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` with an adapter fallback chain (`driver.js`): `bun:sqlite` → `better-sqlite3` (optional native dep) → `node:sqlite` (Node ≥22.5) → `sql.js` (pure-JS fallback, always works). `better-sqlite3` is deliberately in `optionalDependencies` so install never fails without build tools.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.afrouter/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.afrouter` and do **not** follow `DATA_DIR`.

### RTK token saver (`open-sse/rtk/`)
Pre-translate hooks that compress `tool_result` content in-place to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of them. Skips `is_error`/`status:"error"` results to preserve traces.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- **Security-first on PRs**: Security is the top priority when reviewing or creating PRs. Audit authentication, credential/token storage & leaks, header manipulation (`X-Forwarded-For`), and SSRF risks before functional logic. Always include explicit security warnings/notes when reporting PR reviews or changes to the user.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).

## Agent harness

Verify your change with `npm run agent -- <cmd>`.

`scripts/agent/` is a repo-local CLI for coding agents (Claude Code, Codex, OpenCode, Gemini CLI, Antigravity, Grok Build, Cursor, Copilot, Kilo, Qoder, …). It runs AFRouter in an **isolated sandbox** and answers with **one JSON line**. Plain Node (≥20, 22 LTS recommended); never Bun. Nothing is downloaded at run time.

### Rules (read these first)
1. **Browserless by default.** Use `check` after every change. Do **not** open a browser (`shot`, `record`, `flow --engine browser`) unless the change is visual (CSS, layout, `className`, components) **or the user asked** to see it. A plain `page`/`render`/`api` call is enough for everything else.
2. **Stop after 2 failures on the same step.** If a command fails the same way twice, stop retrying and report the error and the `runDir` to the user. Do not loop on screenshots or timeouts.
3. **Never use port 20128** (or 20127/20129) and **never the real data dir** (`%APPDATA%\afrouter` on Windows, `~/.afrouter` elsewhere). The harness picks a free port and a temp `DATA_DIR` + fake `HOME` itself and refuses the real ones; do not override `DATA_DIR`, `PORT` or `HOME` for it.
4. Never point the harness at real provider keys. Chat goes to a local **fake upstream** (`fake/fake-ok`, `fake/fake-429`, …).
5. Only `down` stops the server; it kills only PIDs the harness recorded. Never `pkill`/`taskkill` by name.
6. Read the JSON, not the terminal noise. Bulky output is in files under `.agent/runs/<id>/`; open them only when the JSON points you there.

### The loop
1. Make the change.
2. `npm run agent -- check` → fix until `"ok": true`. `check` is baseline-aware: tests listed in `tests/__baseline__/known-fails.txt` never count as regressions.
3. Gateway/API change: add or extend a test in `tests/` at the lowest layer that fails; `api` / `chat` give a quick runtime transcript.
4. Dashboard logic change: `render <route>` (client page in happy-dom after its data loads) or a `*.dom.test.js` with Testing Library; `page <route>` for the server-rendered view; `flow <file.json>` for a scripted interaction.
5. Visual change, or the user asked: `shot <route>` **once** and give the user the PNG path. Use `--baseline name` / `diff` for before/after proof.
6. When done: `npm run agent -- down`.

### Commands
| Command | Use it when | Notes |
|---|---|---|
| `doctor` | once per machine, or when a lane misbehaves | measures each lane (Next, ESLint, Vitest, happy-dom, SQLite, playwright-core, browser, ffmpeg); writes `.agent/capabilities.json` |
| `up` / `down` / `status` | explicit server control (other commands auto-start it) | `up` reuses a warm server in ms. `up --fresh` restarts, `up --clean-build` also wipes `.next-agent` (stale/corrupt dev build), `up --prod` serves an existing `npm run build`, `up --webpack`, `down --clean` deletes the sandbox. Boot timeout 600 s by default (a cold Turbopack compile on a slow disk takes minutes): `up --timeout <sec>`, `AFROUTER_HARNESS_BOOT_TIMEOUT` or config `bootTimeoutSec` |
| `check [--files a,b] [--no-server] [--base ref]` | **after every change** | changed files vs `master` (+ staged/unstaged/untracked): ESLint on changed lines only (cached, 900 s timeout), related Vitest + DOM tests vs the known-fails baseline, Next `/_next/mcp` errors, API smoke, a chat through the fake upstream, SSR outline + happy-dom render of affected pages, server-log errors, DB integrity |
| `watch [--server] [--once]` | long sessions | re-runs a scoped `check` on every save; NDJSON on stdout and in `.agent/watch.ndjson` |
| `api <METHOD> <path> [--data JSON\|@file] [--auth auto\|session\|key\|none]` | one HTTP call | session cookie for `/api/*`, API key for `/v1/*` are added for you |
| `chat [--format openai\|anthropic\|responses] [--model fake/fake-429] [--tools]` | gateway/translator changes | streams through the gateway to the fake upstream; returns chunks, text, finish reason, upstream calls |
| `page <route…> \| --all` | server-rendered view of a page | role/text outline of the SSR HTML (no client data) |
| `render <route\|component-file> [--props JSON]` | client page/component logic | mounts it in happy-dom with `fetch` wired to the sandbox server; outline after data loads + console/page/network errors |
| `flow <file.json> [--engine dom\|browser]` | scripted UI steps | JSON steps (`goto/click/fill/press/expect/expectText/api/snap…`), happy-dom by default; example `scripts/agent/flows/create-api-key.json` |
| `test [files] [-t name] [--related a.js] [--dom] [--watch]` | run Vitest directly | 2 workers, known-fails aware |
| `errors` / `logs [--grep re]` / `state [table] [--sql …] [--files]` | diagnosis | Next errors + server log; read-only view of the sandbox DB and files |
| `shot <route> [--full] [--dark] [--width W] [--baseline name]` | **Layer 2: visual changes or when asked** | headless system browser: PNG (path only), AI aria snapshot, console/page errors, failed requests |
| `record <flow.json> [--webm]` | **Layer 2: visual flow proof** | flow in the browser with frames + a contact sheet; `--webm` only if `ffmpeg` is on PATH |
| `diff <a.png> <b.png>` | before/after proof | pixel diff (pixelmatch), writes `diff.png` |

Global flags: `--pretty` (indented JSON). Exit codes: `0` ok, `1` check failed, `2` harness error.

### Output shape
Every command prints exactly **one JSON object on one line, at most 20 KB**:
```json
{"cmd":"check","ok":false,"summary":"1 problem(s): lint: 1 new error(s)","failures":["lint: 1 new error(s)"],
 "advice":"Fix the first failure, then re-run check. If the same failure repeats twice, stop and report it.",
 "notCovered":["css/layout","hydration","pixels"],"runDir":"/abs/.agent/runs/20261106-…-check","ms":41234}
```
- `ok` is the verdict; `failures[]` lists what to fix (first one first); `advice` says what to do next.
- Paths are absolute. Screenshots, frames, HTML, Vitest/ESLint JSON and the full unbounded result (`result.json`) live in `runDir`.
- When the 20 KB cap forces cuts, noise goes first (logs, network, text) and locators last; `omitted[]` lists each cut field with a `hint` for getting the rest.
- `watch` is the only long-running command; `watch` prints NDJSON (`ready`, `change`, `check` events).

### Browser settings (Layer 2 only)
Nothing is ever downloaded: the harness drives an **installed** Chromium-family browser through `playwright-core`.
- **Auto mode** (default): tries, in order, Windows: Edge, Chrome, Brave, Chromium, Playwright cache; macOS: Chrome, Edge, Chromium, Brave; Linux: Chrome, Chromium, Edge, Brave. Each candidate is proven with a headless 1×1 screenshot and the winner is cached in `.agent/browser.json`.
- **Choose one** (first wins): `--browser auto|edge|chrome|chromium|brave|<path>` flag → `AFROUTER_HARNESS_BROWSER_PATH=<path>` (or `AFROUTER_HARNESS_BROWSER=<id>`) → `"browser"` in `agent-harness.config.json` (repo root, gitignored) or `.agent/config.json` → auto.
- `agent-harness.config.json` example: `{ "browser": "edge", "browserArgs": [], "viewport": { "width": 1280, "height": 800 } }` (also `bootTimeoutSec`, `webpack`).
- `npm run agent -- doctor` lists the browsers found, the probe result and timing for each, and which one is selected. If none works, Layer 2 is off and Layer 1 still works.

### What the browserless lane cannot see
happy-dom has **no layout and no CSS**: sizes are zero, overflow/contrast/positioning are invisible, and hydration mismatches never happen. `check` says so in `notCovered` and suggests `shot` when visual files changed.

### Where agents read this
`AGENTS.md` (this file) is the single source of truth. Pointers: `CLAUDE.md` (Claude Code, imports `@AGENTS.md`), `GEMINI.md` (Gemini CLI), `.github/copilot-instructions.md` (GitHub Copilot), `.cursor/rules/agent-harness.mdc` (Cursor), and the skill `.agents/skills/agent-harness/SKILL.md`. Codex, OpenCode, Antigravity, Grok Build, Kilo and Qoder read `AGENTS.md` directly. Update this file first; the pointers only link here.
