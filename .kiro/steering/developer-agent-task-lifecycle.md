---
inclusion: always
---

# Task Pipeline — How Agents Claim, Execute, and Resolve Tasks

This document describes how Vibecode Heaven tasks move through the board autonomously. There
is **no standalone agent script** — everything below is driven by `session-manager.ts` calling
into `task-claimer.ts`, executing via either a local child process or an ACA worker container,
and resolving through `report_verdict`. Sessions run this loop unattended; no human intervention
is needed during execution.

> Historical note: an earlier standalone `dev-agent.ts` CLI implemented a simpler 3-state
> (`todo → in-progress → developed`) version of this. It was removed as dead code — nothing in
> production (no Dockerfile, no ACA job, no route) ever invoked it. The real pipeline described
> here has always been the one that actually runs.

## The pipeline is stage-chained, not fixed

Each **agent** (a `:Agent` node in Neo4j, `backend/src/db/agents.ts`) declares four fields
that make it a pipeline *stage*:

| Field | Meaning |
|---|---|
| `kind` | `"editor"` (implements changes) or `"inspector"` (reviews only, never modifies files) |
| `claimState` | board column this agent claims tasks FROM |
| `workingState` | column set while the agent is actively working a claimed task |
| `resolveState` | column set on success — this becomes the NEXT stage's `claimState` |
| `requiresTask` | if `false`, the agent loops on its own prompt with no task queue at all (standalone mode) |

A loop session run with a given agent claims from that agent's `claimState`, and resolves into
its `resolveState`. Chaining agents so each one's `resolveState` equals the next one's
`claimState` is what creates a multi-stage pipeline — there's no separate "reviewer" or "QA"
code path, it's the same loop logic in `session-manager.ts` parameterized by whichever agent's
DB row the session is running.

The production pipeline (seeded by `backend/scripts/seed-pipeline-agents.ts`) chains three agents
across a 7-column board (`todo → in-progress → developed → in-code-review → reviewed → in-qa →
done`, see constraints in `backend/src/db/migrate.ts`):

```
┌────────────────┐  resolveState       ┌─────────────────────┐  resolveState      ┌──────────────────────┐
│ developer-agent │  "developed"        │ code-reviewer-agent  │  "reviewed"         │ qa-improvement-agent  │
│ kind: editor    │ ──────────────────▶ │ kind: inspector      │ ──────────────────▶ │ kind: inspector       │
│ claim: todo     │                     │ claim: developed     │                     │ claim: reviewed       │
│ work: in-progress│                    │ work: in-code-review │                     │ work: in-qa           │
│ resolve: developed│                   │ resolve: reviewed    │                     │ resolve: done         │
└────────────────┘                      └─────────────────────┘                     └──────────────────────┘
        ▲                                    │        │                                  │        │
        │        resetTask(task, "todo")     │        │        resetTask(task, "todo")   │        │
        └────────────────────────────────────┘        └──────────────────────────────────┘
     verdict "changes_requested" always bounces the task back to "todo" (developer rework),
     preserving the existing branch + PR URL so the dev agent resumes the same PR.
```

Editor vs. inspector also changes what happens to the working tree: an editor commits, pushes,
and opens/updates a PR; an inspector's file changes (if any) are discarded
(`git reset --hard HEAD && git clean -fd` in `worker/worker.js`) and it never pushes or opens a
PR — it only reads the diff and posts comments.

## 1. Claim (atomic, concurrent-safe)

`claimTask(taskId?, tabIds?, claimState, workingState)` in `backend/src/agent/task-claimer.ts`
uses a two-step CAS (compare-and-swap) retry loop against Neo4j:

1. A read query fetches up to 20 candidate `:Task` node IDs ordered by `priority ASC`,
   `originRank ASC` (user > user-assisted > ai > else), `createdAt ASC` — excluding tasks
   blocked by incomplete `[:DEPENDS_ON]` dependencies, and excluding tasks whose `groupId`
   matches another task already in `workingState`.
2. Each candidate is attempted in order via `attemptClaim()` — its own managed write
   transaction. The Cypher forces a write lock unconditionally first (`SET t._touch = true`),
   then re-checks `state = claimState` under the lock, then conditionally sets
   `state = workingState` via `FOREACH(CASE...)`. First success wins; losers move to the next
   candidate.

- If the session has `tabIds` set, the candidate query adds a `[:IN_TAB]` relationship filter
  so it only claims tasks belonging to its assigned tab(s); otherwise any tab is eligible.
- `claimState`/`workingState` are parameters (not hardcoded), which is what lets each pipeline
  stage claim from and write to different columns.

Idle-loop wake-up is event-driven, not polling: `waitForTaskAvailable()` parks on an in-process
`EventEmitter` until `notifyTaskAvailable()` fires (called by task creation, `resolveTask`, and
`resetTask` — i.e. every write that moves a task into a claimable state), with a 5-minute
fallback timer as a safety net.

## 2. Execute — local vs. ACA (remote)

Mode is chosen per `WORKER_MODE` (`local`/`remote`) or auto-detected from ACA config presence
(see `ARCHITECTURE.md` §5).

**Remote (production):** `session-manager.ts` calls `aca-worker-spawner.ts` to start an Azure
Container Apps Job execution for the session (managed-identity auth, per-session env vars:
agent config, decrypted git PAT, MCP proxy config, etc.). The worker container
(`worker/worker.js`) connects back over `/internal/worker` WebSocket, clones the repo, and for
each claimed task: creates/recovers the task's branch, starts a **fresh ACP session per task**
(no history carried between tasks), delivers the prompt to `kiro-cli`, then on completion either
commits/pushes/opens a PR (editor) or discards any changes (inspector), and reports the result
back (`stopReason`, `hasChanges`, `prUrl`, `branchName`, `credits`, `verdict`).

**Local (dev only):** `KiroRunner` (`backend/src/agent/kiro-runner.ts`) spawns `kiro-cli` as a
child process directly on the orchestrator host — no container, no git integration at all. Both
paths funnel through the same `processUpdate()` logic in `session-manager.ts`, so verdict
capture and output streaming behave identically regardless of mode.

The turn prompt itself depends on agent `kind` (`buildTurnPrompt` in `session-manager.ts`):
editors get `buildDevPrompt` ("implement this"), inspectors get `buildReviewPrompt`
("review only, post comments, report a verdict — do not modify files").

Timeout: enforced by the ACA worker (`startPromptTimer`, default from the session's
`timeoutSeconds`, sends `session/cancel` then force-closes after a 30s grace period). Local mode
has no orchestrator-side timeout.

## 3. Resolve — verdict, success, failure, or cancellation

Agents report a verdict via the `report_verdict` MCP tool
(`worker/verdict-mcp-server.js`), one of:

| Verdict | Meaning | Effect |
|---|---|---|
| `resolved` | Editor made changes normally | `resolveTask(task, stages.resolveState, branch, prUrl)` — advance to next stage |
| `no_action_needed` | Nothing to change/review | **Advances one stage** (`resolveTask(task, stages.resolveState)`) — never jumps straight to `done`. An editor saying "already implemented" still needs code review; only when every stage agrees is a task actually done. |
| `changes_requested` | Inspector found issues and posted them | `resetTask(task, "todo", branch, prUrl)` — always bounces all the way back to the developer, preserving branch/PR so the dev agent resumes the same PR |

`report_verdict` enforces that `changes_requested` cannot be reported without at least one
`post_review_comment` call that same turn — this stops an inspector from describing issues only
in chat text and bouncing a task with no actionable feedback anywhere the next agent can see.

**Failure / timeout:** any other failure resets the task to the *agent's own* `claimState`
(`resetTask(task, stages.claimState, ...)`) — not always `"todo"`. A failed review, for example,
resets to `"developed"` (the reviewer's own claim state), not back to square one.

**Cancelled turns are treated as failures.** If `stopReason === "cancelled"` (timeout or an
explicit `session/cancel`), `session-manager.ts` forces `success = false` and resets the task
even if the worker reports `hasChanges`/a clean push — a cancelled turn never reached `end_turn`,
and git operations in the worker run unconditionally after a turn ends, so without this check a
timed-out/killed turn looked identical to a real success and could get marked `"developed"` with
a PR opened on unverified, possibly-broken work.

**MCP init failures also force a failure**, regardless of reported verdict: if any MCP server
failed to start this turn (`_kiro.dev/mcp/server_init_failure`), the agent may have been silently
missing tools (e.g. an inspector missing `post_review_comment`) — its verdict can't be trusted,
so the turn is failed and the task is reset.

### The `no_action_needed` cross-check (a real bug this code guards against)

If an editor reports `no_action_needed` but actually left uncommitted changes, blindly trusting
the verdict would silently discard real work. Before honoring the verdict, the worker runs
`git status --porcelain`; if it shows changes, the verdict is ignored and the normal
commit/push/PR flow runs instead, so the work still gets delivered.

There's a deeper, related failure mode this also guards against: if a task's `branch` column in
the DB gets cleared (e.g. by a resolution that didn't pass a branch value) while a real branch
still exists on the remote, a naive `git checkout -B <name> DEV_BRANCH` on the next run would
**force-reset and silently wipe those real commits** — leaving an inspector to "review" an empty
diff and wrongly report no issues on code it never saw. The worker avoids this by probing
`git ls-remote` for the task's deterministic branch name (`[type]/#[id]_[slug]`) before falling
back to creating a fresh branch, recovering the existing remote branch if one is found instead of
overwriting it.

## 4. Loop mode

A session with `loop: true` (`runLoopMode`/`runLoopModeAca` in `session-manager.ts`) repeats:

```
while running:
  if no tasks available in stages.claimState: wait for notifyTaskAvailable(), then recheck
  claim a task from stages.claimState (optionally filtered to the session's tabIds)
  build the turn prompt for stages.kind (editor vs inspector)
  execute, await result
  apply verdict/failure/cancellation rules above → resolveTask or resetTask
  repeat
```

Which column a session polls is entirely a function of which agent it runs — a session running
`developer-agent` polls `todo`; a session running `code-reviewer-agent` polls `developed`. If
`requiresTask` is `false` for the agent, the session skips the task queue entirely and just
repeats its own prompt on an interval (used for long-running standalone research/monitoring
sessions, not part of the task pipeline).

The ACA loop additionally tracks consecutive failures per task (max 3, with backoff) and treats
a "committed but couldn't push" delivery failure as immediately unretryable rather than looping
on an environment/credential problem it can't fix by retrying.

## Concurrency & recovery

- The CAS retry loop with lock-forcing writes guarantees no two sessions claim the same task
  (verified by a dedicated concurrency integration test against the real AuraDB instance).
- If the orchestrator process crashes mid-task, `resetOrphanedTasks()` (called once on startup,
  `session-manager.ts`'s `initSessions()`) resets any task stuck in `"in-progress"` back to
  `"todo"` so it can be retried. This is a blunt, non-stage-aware safety net — it only recovers
  the specific hardcoded `"in-progress"` state, which happens to be every seeded agent's default
  `workingState` today.

## Relevant source files

- `backend/src/session-manager.ts` — owns the loop logic, mode selection, verdict/failure rules
- `backend/src/agent/task-claimer.ts` — atomic claim, `resolveTask`/`resetTask`, orphan cleanup
- `backend/src/agent/prompt-builder.ts` — `buildDevPrompt` (editor) / `buildReviewPrompt` (inspector)
- `backend/src/agent/kiro-runner.ts` — local-mode ACP client wrapper
- `backend/src/aca-worker-spawner.ts` — starts ACA Job executions for remote mode
- `backend/src/worker-ws-handler.ts` — the `/internal/worker` WebSocket endpoint
- `worker/worker.js` — the ACA worker: git clone/branch/commit/push/PR, verdict cross-check
- `worker/verdict-mcp-server.js` — the `report_verdict` MCP tool and its enforcement rules
- `backend/scripts/seed-pipeline-agents.ts` — seeds the production 3-stage agent chain
