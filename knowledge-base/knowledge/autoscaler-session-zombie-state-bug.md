# AutoScaler / Session Zombie-State Bug — No Dead-Worker Detection, No Stop Verification

Investigated 2026-09-22 following a user report: "autoscalers pick up tasks, leave them in
'doing', sessions die and tasks are left unattended; stopping an autoscaler doesn't actually
stop its sessions."

## Confirmed live on this deployment (local WSL worker mode)

Ran a one-off Cypher query against the live AuraDB instance. Findings at time of writing:

- All 6 AutoScalers (`developments`/`reviewers`/`QAs` × 2 tabs) show `status: 'stopped'` in Neo4j.
- 6 of their pooled `Session` nodes still show `status: 'running'` in Neo4j (e.g. sessions 1902,
  1903, 1906, 1908, 1909, 1912).
- `wsl -d kirofactory-docker -- docker ps -a` returns **zero containers, running or stopped** —
  the WSL distro is up, but every worker container is gone.
- The orchestrator Node process (port 3500) has been running the whole time — no server restart
  happened, confirmed by checking process uptime against session timestamps.
- 6 tasks (1784, 1785, 1811, 1824, 1825, 1826) sit in working states (`in-progress`,
  `in-code-review`) with `updatedAt` timestamps from the current session — some point at
  sessions still marked `"running"` in the DB (1785→1912, 1784→1908), others at sessions already
  marked `"completed"` that never released their claim (1811→1910, 1784→1911, 1791→1913,
  1825→1943).

This is not a hypothetical — it is the system's actual current state, reproducing both halves of
the user's report simultaneously.

## Root cause chain

**1. No WebSocket heartbeat on the `/internal/worker` connection.**
`backend/src/worker-ws-handler.ts` has zero `ping`/`pong`/`isAlive` logic. `isWorkerConnected()`
and the `workerConnections` map are only ever updated by the `ws.on("close")`/`ws.on("error")`
handlers — i.e. only when the OS/network layer actually delivers a close/error event. If the
underlying WSL2 VM or its container is killed abruptly (VM reset, `wsl --shutdown`, host
sleep/resume, OOM-killed container, Docker daemon restart) rather than exiting the process
cleanly, the TCP socket can go dark with no FIN/RST ever delivered to the orchestrator side. When
that happens, `isWorkerConnected()` keeps returning `true` and the session's DB/in-memory
`status` stays `"running"` forever — nothing ever tells the orchestrator the peer is gone.
(Same architectural gap exists in the ACA/remote path — `aca-worker-spawner.ts`'s only liveness
check, `waitForWorkerOrAbort`'s `STATUS_POLL_INTERVAL_MS` job-status poll, runs **only during
initial connection**, before the WebSocket is established; nothing polls execution status for the
remainder of a long-running session.)

**2. No runtime health check reconciles "session says running" against "container/job actually
alive" while a session is active.** The only reconciliation of session status vs. reality happens
in `initSessions()` at server *startup* (resets in-memory `status: "running"` → `"stopped"`, then
schedules `resetOrphanedTasks()`). Since the orchestrator process didn't restart, that path never
ran. There is no periodic sweep, no cron, nothing that asks "is this still real?" for a running
session between server restarts.

**3. `resetOrphanedTasks()` is stage-unaware — even a restart wouldn't fully fix this.**
`backend/src/agent/task-claimer.ts`'s `resetOrphanedTasks()` hardcodes `WHERE t.state =
'in-progress'`. The pipeline has three working states (`in-progress`, `in-code-review`, `in-qa` —
see `developer-agent-task-lifecycle.md`), so a task orphaned mid-review or mid-QA would NOT be
recovered by a server restart today; only a task orphaned mid-development would.

**4. `stopSession()`/`stopAutoScaler()` never verify the stop actually happened.**
`stopSession()` (session-manager.ts) synchronously rejects any pending prompt awaiter and flips
`status` to `"stopped"` immediately, then fires `containerSpawner.stop()` as a bare
`.catch(() => {})` — never awaited by the caller, and its own failure path (both
`wsl-worker-spawner.ts` and `aca-worker-spawner.ts`) is explicitly "best-effort, never throws."
`stopAutoScaler()` awaits `stopSession()` per session, but since `stopSession()` itself doesn't
wait for the container teardown to actually complete/confirm, `stopAutoScaler()` has no way to
know whether the underlying `docker stop` / ACA "stop execution" call succeeded. The observed DB
state (autoscaler `"stopped"`, session still `"running"`) is consistent with either: (a) this
exact zombie-container scenario, where there was nothing left to stop and the container was
already gone before `stopSession` even ran, or (b) a stop call that silently failed and was never
surfaced. Either way, the user-facing symptom is identical: "I stopped it and it's still running."

**5. The autoscaler's own polling only trusts the same stale flag.** `watchSessionCompletion` /
`watchSessionIdle` in `autoscaler-manager.ts` poll `getSession(id)?.status !== "running"` every
1-5s to detect a session finishing/crashing and trigger `reconcile()`. This is a reasonable
pattern, but it is only as good as `status` itself — and per point 1, `status` can be
indefinitely wrong with no external signal to correct it.

## Why "sessions die and tasks are left unattended" happens

A worker container dies (or the whole WSL VM resets) without a clean WS close. Nothing detects
this. The session sits forever as `status: "running"` with a `currentTaskId` still set. The task
sits forever in whatever `workingState` it was claimed into. The autoscaler's reconcile loop never
sees a reason to replace the session (it looks "running"), so no new session is spawned to pick up
the slack either — the pool silently loses real capacity while still reporting the old target as
met.

## Why "stopping an autoscaler doesn't stop its sessions" happens

Two contributing mechanisms, not mutually exclusive:
- If the session's container is already a zombie (case above), there's nothing left to stop —
  `stopSession()` sends signals into the void, marks status `"stopped"` optimistically, but the
  DB write path for session status wasn't actually reached in the observed case (session rows
  show `"running"`, not `"stopped"`) — suggesting `stopAutoScaler()`'s loop over
  `managed.sessionIds` didn't include these sessions at all, most likely because they had already
  fallen out of `managed.sessionIds` tracking or the autoscaler process instance managing them was
  itself replaced/lost track (in-memory `autoScalers` Map state, not persisted) without a clean
  stop ever being issued for them in the first place.
- Even in the clean-stop case, `stopSession()` fires-and-forgets the actual container teardown, so
  a slow or failing `docker stop`/ACA stop call is invisible to the operator — the UI/DB already
  says "stopped" before the container teardown is confirmed, let alone completed.

## Fix directions (not yet implemented as of this writing)

1. **Add WS ping/pong heartbeat** to `/internal/worker` (both directions) with a reasonable
   timeout (e.g. 30-60s no-pong → treat as `onWorkerExited("disconnected")`). This is the
   foundational fix — without it, every other mitigation is papering over an undetectable failure
   mode.
2. **Periodic runtime reconciliation**, not just startup-time: a sweep (e.g. every few minutes)
   that cross-checks every session with `status: "running"` against its actual container/job
   status via the spawner's `status()` method (already exists, used only during connect-wait) and
   corrects both the session and its claimed task if the container is gone.
3. **Make `resetOrphanedTasks()` stage-aware** — reset tasks in ANY working state whose owning
   session is gone, not just the hardcoded `"in-progress"`. Consider driving this from the actual
   claimState/workingState pairs of seeded agents rather than a hardcoded string.
4. **Make `stopSession()`/`stopAutoScaler()` verify teardown**, at minimum logging (structured,
   not `console.warn`) a clear operator-visible signal when a stop call fails, and ideally
   confirming via a status poll that the container actually reached a terminal state before
   reporting the stop as successful.
5. When a session's container is found to be a zombie (health check fails) and it has a
   `currentTaskId`, that task must be reset to its stage's `claimState` as part of the same
   correction — this is the piece that actually closes the "task left unattended" loop for the
   user's board.

## How to re-check this state in the future

Query Neo4j directly (see `.kiro/steering/task-origin-convention.md` for the DB access pattern —
raw Cypher via `readQuery`, no ORM):

```cypher
// Sessions marked running under a stopped AutoScaler
MATCH (f:AutoScaler)-[:OWNS_SESSION]->(s:Session)
WHERE f.status = 'stopped' AND s.status = 'running'
RETURN f.id, f.name, s.id, s.status, s.currentTaskId

// Tasks stuck in a working state
MATCH (t:Task) WHERE NOT t.state IN ['todo', 'done']
RETURN t.id, t.title, t.state, t.updatedAt ORDER BY t.updatedAt DESC
```

Cross-reference with `wsl -d kirofactory-docker -- docker ps -a` (local mode) or
`az containerapp job execution list -g SandboxForRM -n kirofactory-worker` (ACA/remote mode, see
`azure-infra-notes.md`) to see whether the underlying containers genuinely exist.
