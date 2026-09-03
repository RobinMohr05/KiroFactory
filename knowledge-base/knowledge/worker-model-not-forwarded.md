# Fixed: session's `model` field was never forwarded to ACA/WSL worker containers

Found and fixed 2026-09-03, from a live session where the agent reported "I'm running on Auto"
despite the session being configured (per its `model` field/UI setting) for a specific Claude
Sonnet model.

## Root cause

`session.meta.model` (stored in Neo4j, set via the session UI/API — see `backend/src/db/sessions.ts`)
is only ever consumed by the **local-mode** path: `kiro-runner.ts`'s `KiroRunner.create()` reads
`opts.model` and appends `--model <value>` to the `kiro-cli acp` args. That's the path used when
`WORKER_MODE=local` (no container, `kiro-cli` spawned directly on the orchestrator host).

The **ACA/WSL worker path** — `worker/worker.js`, spawned by both `aca-worker-spawner.ts` (Azure
Container Apps Job) and `wsl-worker-spawner.ts` (local Docker-in-WSL2, which mirrors ACA's env var
contract exactly by design) — never received the model at all:

- `aca-worker-spawner.ts`'s `startWorkerJob()` builds an `envVars` array (`SESSION_ID`,
  `AGENT_NAME`, `AGENT_KIND`, etc.) with no `MODEL` entry.
- `wsl-worker-spawner.ts`'s `startWorkerJob()` mirrors it 1:1, same gap.
- `worker.js`'s `spawnKiro()` builds `["acp", "--agent", AGENT_NAME]` with no `--model` flag,
  and had zero references to `model`/`MODEL` anywhere in the file.
- `session-manager.ts`'s `ContainerWorkerSpawner.start(...)` interface (the shared abstraction
  both spawners implement) never had a `model` parameter to pass through in the first place —
  the `meta.model` value was sitting right there in scope at the call site and simply never
  forwarded.

So any session run via ACA or WSL (i.e. anything using the worker container, which per
`ARCHITECTURE.md` is the normal/production path — local `KiroRunner` mode is the minority case)
silently ignored its configured model and always got kiro-cli's own default ("Auto"), regardless
of what the UI/API said. This matches the report: the log showed a WSL/ACA worker session
("ACP session ready", "Autonomous loop started") whose agent replied "I'm running on Auto" though
the session was set to a specific Sonnet model.

## Fix

Threaded `model` through the full chain, matching the existing pattern used for
`agentConfigBase64` immediately above it in both spawners:

- `aca-worker-spawner.ts` / `wsl-worker-spawner.ts`: added `model?: string | null` as the final
  parameter of `startWorkerJob()`, and push `{ name: "MODEL", value: model }` /
  `-e MODEL=${model}` onto the env vars/args when non-empty.
- `session-manager.ts`: added `model` to the `ContainerWorkerSpawner.start(...)` interface and
  both `makeAcaSpawner`/`makeWslSpawner` implementations; the actual `spawner.start(...)` call
  site now passes `meta.model` (was already in scope, just never passed).
- `worker/worker.js`: added `const MODEL = process.env.MODEL || ""`, and `spawnKiro()` now
  appends `--model ${MODEL}` to the `kiro-cli acp` args when set, plus logs it in the
  "Starting kiro-cli acp..." system output line so it's visible in session logs going forward.

All additions are backward compatible (optional trailing params, `if (model)` guards) — sessions
with no `model` set behave exactly as before (kiro-cli's own default).

## Verification

- `cd backend && npm run build` — `tsc` passes with no type errors after the signature changes.
- `wsl-worker-spawner.test.ts` (4 tests) — passes; existing calls only pass the first 5 positional
  args, so the new optional `model` param doesn't break them.
- Full backend suite: 372/376 passing after the change (same 4 pre-existing failures — timeout-
  sensitive tests in `planner-session-pool.test.ts`, `idle-loop-task-visibility-fixes.test.ts`,
  `task-planner-board-mcp.test.ts` — none of which reference `startWorkerJob`/
  `ContainerWorkerSpawner`/`spawner.start`, confirmed by grep).
- `node --check worker/worker.js` — syntax OK.

Not yet verified end-to-end against a real ACA/WSL worker run with a non-empty model (would
require actually starting a session) — that's the next thing to confirm if this recurs.
