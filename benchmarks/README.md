# AFRouter benchmarks

A benchmark suite for measuring the things future optimizations are supposed to
improve: **build time, startup time, request latency, and hot-function cost**.

> Design rule (the whole point): **benchmarks only measure what we control.**
> Live-provider latency is external, seconds-long and noisy — so a chat request
> is timed against a **local stub upstream** instead, keeping our full pipeline
> in scope while provider latency stays ≈ 0 and constant.

## Run

```bash
npm run bench                       # all suites: build → startup → request → unit
npm run bench -- --only startup,request
npm run bench -- --iterations 50 --runs 5
npm run bench -- --compare          # print deltas vs benchmarks/baseline.json
npm run bench -- --help
```

No new dependencies: suites are zero-dep `.mjs` scripts; the in-process tier
reuses `vitest bench` (tinybench ships with vitest in `tests/`).

## Suites

| Suite | What it times | How |
|---|---|---|
| `build` | `npm run build` (`next build --webpack` + postbuild) — the same command CI reports as `BUILD_SECONDS`, but locally with repetitions | external process, wall clock |
| `startup` | gateway boot, three definitions per run (see below) | fresh `node custom-server.js` process per run |
| `request` | full-pipeline request latency (see scenarios) | isolated server + local stub upstream |
| `unit` | translator / RTK / `parseModel` — sub-ms costs a request can't resolve | `vitest bench`, thousands of iterations |

### Startup has three numbers on purpose

They can differ by seconds, so none is "the" answer:

- `startup.readyMs` — spawn → `/api/health` answers `{"ok":true}` (the same
  readiness definition the CI smoke test polls).
- `startup.firstRouteMs` — spawn → first `GET /api/auth/status` (forces the
  **lazy** DB adapter init + schema migration that health never triggers).
- `startup.warmRouteMs` — median latency of further `/api/auth/status` calls
  (steady state once the DB is warm).

A discarded **prime run** creates/migrates the fixture DB first, so measured
runs carry only per-boot work — one-time migration cost would otherwise pollute
run #1.

### Request scenarios (the "overhead ladder")

Each rung adds one more layer of our code, all without any provider in the loop:

| Metric | Endpoint | Adds |
|---|---|---|
| `request.healthMs` | `GET /api/health` | HTTP + Next only |
| `request.authStatusMs` | `GET /api/auth/status` | + DB settings/session read |
| `request.modelsMs` | `GET /v1/models` (`x-afr-internal-models-fetch: 1`) | + rewrite/middleware + model assembly (DB-only) |
| `request.chatNonStreamMs` | `POST /v1/chat/completions` (`stream:false`) | + auth → combo → chatCore → translator → executor → JSON response |
| `request.chatStreamMs` | same, `stream:true` | + SSE stream translation end-to-end |

The chat scenarios route to a **bench-only** `bench` openai-compatible node
whose base URL points at a local stub (`scripts/bench/stub.mjs`) that serves a
canned OpenAI completion/SSE — so the entire production path runs, and only our
own overhead enters the number.

**Warm-up:** 3 full rounds are executed and discarded before timing (first hits
pay lazy route/translator/DB warm-up). Timed samples are collected round-robin
so machine drift affects every scenario equally.

## Isolation guarantees

A run never touches your real setup:

- fresh temp `DATA_DIR` (never `~/.afrouter`) — created, seeded, deleted
  (`--keep` retains it for debugging);
- an ephemeral port (never 20128);
- builds go to **`.next-bench/`** via `NEXT_DIST_DIR` (honored by
  `next.config.mjs` and the postbuild copy) — the repo's real `.next` and any
  running instance are never overwritten or skewed; each build run wipes the
  bench dir first so every measurement is a cold build, like CI's fresh runner;
- the stub provider + connection + API key are seeded into the **fixture only**
  via the real APIs (CLI token computed from the fixture's own
  `machine-id`/`auth/cli-secret`);
- `DISABLE_BACKGROUND_TOKEN_REFRESH=1` removes the token-refresh scheduler from
  the noise window (tunnels/MITM/cloud sync are already off by default).

## Results, baselines, comparison

- Every run writes `benchmarks/results/<stamp>-<label>.json` with machine
  metadata (platform, CPU, node version), git sha, and per-metric
  `min/median/mean/p95/max` + raw samples. `benchmarks/results/` is gitignored.
- To set a baseline: copy a results file to `benchmarks/baseline.json`
  (committed, machine-labeled — baselines are **machine-specific**; a mismatched
  machine warns loudly and makes deltas untrustworthy).
- `--compare` prints per-metric deltas. **±3% = noise.** Nothing here is a hard
  CI gate — runner noise makes failing a build on a 5% wiggle a lie.
- **CI hosts vary:** two consecutive `ubuntu-latest` runs landed on EPYC 7763
  vs EPYC 9V74 (same platform/cores/node, different CPU model). `--compare`
  prints a soft *host CPU differs* note for that case instead of a hard
  mismatch, and sub-second numbers — especially the `unit` tier — can swing
  tens of percent between hosts. Prefer `build`/`startup`/`request` for trend
  reading; if a delta looks too good (or bad) to be true, re-run or
  re-baseline before believing it.

## Continuous integration (`.github/workflows/bench.yml`)

The whole suite runs on GitHub Actions so performance work doesn't have to
bake a laptop:

- **Triggers:** every PR (numbers for the change under review), pushes to
  `master` (mainline trend), and manual `workflow_dispatch` — dispatch exposes
  the suite subset (`only`, comma list), `runs`, `iterations`, and a results
  `label`. Feature-branch pushes already run `beta.yml`; bench there on demand.
- **Flow:** `npm ci` (root + `tests/`) → `npm run bench -- --label ci-<sha>
  [--compare]` → console output (metric table + deltas) mirrored into the job
  **summary** → `benchmarks/results/*.json` uploaded as a run **artifact**
  (kept 30 days).
- **Baselines are recorded ON the runner.** A laptop baseline compares as
  cross-machine noise and warns loudly. Bootstrap: after the first green CI
  run, download the artifact's JSON and commit it as
  `benchmarks/baseline.json`; afterwards the workflow passes `--compare`
  automatically whenever that file exists.
- **Gating: none.** A slower number never fails the run — only infrastructure
  problems (build error, suite crash) do.
- Isolation is unchanged on the runner: cold `.next-bench/`, temp `DATA_DIR`,
  ephemeral port, fixture provider + loopback stub — no live provider, no
  `~/.afrouter`, no port 20128.

## Caveats to keep in mind

- The stub sits on loopback: connection pooling/TLS/retry behavior toward real
  providers is **not** covered (add latency injection to the stub if ever needed).
- Unit benches pre-register translators (`registerAll.js`): they measure
  **steady-state** translation, not the one-time lazy module load.
- The build suite builds **cold into `.next-bench/`** (dist dir wiped first, like
  a fresh CI runner) and never overwrites the real `.next`.
- `startup`/`request` need a production build: the `build` suite produces
  `.next-bench/BUILD_ID`, and they also fall back to `.next/BUILD_ID` if you
  built with `npm run build` yourself.
- Unit-tier `n` is tinybench's iteration count; vitest's JSON reporter exports
  aggregates only, so `samples` is empty and `p95` is `null` (`—`) for those
  metrics — their `median/min/max/mean` come from tinybench's distribution.
- Post-response work (usage persistence, request-log flush) happens after the
  client got its response and is therefore outside the timed window.

## Adding a metric

1. In-process function → add a `bench()` in `tests/benchmarks/*.bench.js`.
2. Endpoint / pipeline → add a scenario in `scripts/bench/request.mjs`.
3. New suite → add `scripts/bench/<name>.mjs` exporting `run<Name>()` returning
   `{ "metric.name": stats(samples) }`, register it in `scripts/bench/index.mjs`
   (`SUITES` + `runners`), document it here.
