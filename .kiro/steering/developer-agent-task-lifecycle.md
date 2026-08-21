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
capture and output streaming behave identically regardless of mode. **What is NOT identical:**
the safety checks built on top of that verdict — see "Local mode has no commit gate" below. Also,
the git-delivery MCP tools (`sync_task_branch`, `finalize_branch_sync`, `submit_task_changes`)
that `buildDevPrompt()` instructs every editor-kind agent to use for all git operations are wired
up only in `worker/worker.js` (ACA) — a local `KiroRunner` session is never given these tools,
so a local developer-agent turn has no way to actually commit/push/open a PR even if it wanted
to, regardless of how the turn otherwise concludes.

**No working-directory isolation in local mode — confirmed gap, not yet fixed (2026-08-21).**
`DEFAULT_CWD` in `session-manager.ts` (`resolve(import.meta.dirname, "../..")`) is the literal
KiroFactory project root, and every local session uses it unless a caller explicitly overrides
`cwd`. There is no per-session or per-task directory allocation anywhere in the local path — no
`git worktree`, no clone-per-session, nothing. Compare ACA/remote mode, where every worker
execution gets its own container with a fresh `git clone` into `/workspace`
(`worker/worker.js`'s `WORKSPACE` constant).

Concretely: the standard 3-stage pipeline run locally (`developer-agent` →
`code-reviewer-agent` → `qa-improvement-agent`) is three concurrent long-lived loop sessions
that, by default, all point `kiro-cli` at the *same directory on disk* at the same time — and
since local dev agents are explicitly told not to run `git checkout`/`git branch` (no
git-delivery tools to manage a task branch either, per above), there's no branch-per-task
separation to fall back on. Add an interactive/chat session or a human editing the repo at the
same time (e.g. via this very IDE) and they're all sharing one working tree with zero
coordination. This is a live conflict risk today, not a hypothetical.

`.devcontainer/` in the repo root is **not** related to this and does not fix it — that config
is the human contributor's dev environment for working on KiroFactory itself (confirmed: zero
references to devcontainer/Docker anywhere in `backend/src/` or `worker/`'s actual session/agent
execution code). No agent session, local or ACA, runs inside it.

The fix (some form of per-session/per-task working-directory isolation — git worktrees, a
clone-per-session mirroring the ACA approach, or literal containers) is an open design question
as of this writing, not yet resolved or task-tracked. If picking this up, resolve the design
question with the user first (worktrees avoid making Docker a hard local dependency; literal
containers would need `KiroRunner.create()`'s plain `spawn("kiro-cli", ...)` reworked to spawn
inside one) before filing or claiming a task — an underspecified task here would be immediately
auto-claimed by the live pipeline per the claiming rules in this same document.

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

### Local mode has no commit gate — confirmed live, tracked as task #598

All of the above (`hasChanges`/`committed` cross-check, the no-changes-and-no-verdict check) is
`runLoopModeAca()`-only. **`runLoopMode()` (local mode) has no equivalent.** Its success/failure
branch only looks at whether `streamPrompt()` threw and at `managed.turnVerdict` — never at
whether any file actually changed. `streamPrompt()` itself hardcodes `hasChanges: false`
unconditionally into every `TurnEndSummary` it builds (local mode has no git integration to
populate it with — see §2 above), and that hardcoded `false` is written to the DB's
`Turn.hasChanges` but never read back by the loop's own decision logic. A `developer-agent` turn
that returns normally with no verdict (expected for editor-kind agents — only inspectors are
required to call `report_verdict`) falls straight into the `else` branch and gets
`resolveTask(task.id, stages.resolveState)` unconditionally, with zero verification that anything
was actually implemented.

Confirmed live on 2026-08-21: three local loop sessions (`developer-agent` → `code-reviewer-agent`
→ `qa-improvement-agent`) ran end-to-end on two tasks and marked both `done`. One had **zero file
changes anywhere in the working tree**. The other's change was a stub (a field added but never
read) that fails the dev agent's own self-authored test 3 out of 4 assertions. All three stages —
including both inspector stages, whose entire job is supposed to be catching exactly this —
passed both through. Tracked as task #598. If working on `runLoopMode()`, `streamPrompt()`, or
considering running the full pipeline locally rather than via ACA, know that historically it
provided **no delivery guarantee at all** — a task reaching `"done"` locally was not evidence any
code was written.

**Update 2026-08-21 — fixed, but only closes half the gap:** `runLoopMode()` now calls
`hasLocalGitChanges(meta.cwd)` (`backend/src/agent/local-git-check.ts` — `git status --porcelain`,
falling back to `git log <base>..HEAD` for a clean-tree-but-committed turn) for editor-kind agents
that finish a turn with no verdict. If it reports no changes, the task is reset to
`stages.claimState` instead of resolved — matching the ACA `hasChanges`/`committed` cross-check's
philosophy. Inspector-kind agents are exempt (they never produce file changes by design). Covered
by `backend/src/tests/local-commit-gate.test.ts` (all 3 cases passing: no-changes-and-no-verdict →
reset, changes-present → resolve, inspector → git check skipped entirely).

This closes the "silently marked done with zero changes" failure mode, but does **not** give local
mode an actual delivery mechanism — the git-delivery MCP tools gap described just above this
section is still unresolved. A local developer-agent turn that edits files directly (bypassing the
git-delivery tools it's told to use, since they don't exist locally) and leaves them uncommitted
will now correctly fail the gate and retry forever rather than being marked `"done"`, but it still
has no way to commit/push/open a PR even if the agent behaves exactly as instructed. Local mode
today is safe (no more false "done"s) but still non-functional as a way to actually ship code
without ACA — treat it as suitable for interactive/chat sessions, not as a substitute for the ACA
pipeline.

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

## The `groupId` lock is per-stage — and "No tasks available" can be a lie

Confirmed by investigation 2026-08-20 (tasks 588/589/590, all `groupId: "mobile-responsive"`).

Both `claimTask()`'s candidate query and `getAvailableTaskCount()` exclude a task when a
groupId sibling already sits in **the caller's own `workingState`**:

```cypher
AND ( t.groupId IS NULL OR
      NOT EXISTS { MATCH (g:Task {state: $workingState})
                   WHERE g.groupId = t.groupId AND g.id <> t.id } )
```

Two consequences that are easy to misread:

1. **Two sessions running the same agent cannot work two tasks of one group in parallel.** With
   three tasks in one group and two reviewer sessions, exactly one reviews at a time; the other
   correctly finds nothing claimable.
2. **It does NOT prevent a dev and a reviewer from working the same group — and therefore the
   same branch — simultaneously**, because the exclusion only looks at one `workingState`. A
   task in `in-progress` does not block a claim into `in-code-review`. Observed live: an editor
   pushing commits to the shared branch while an inspector reviewed a sibling task on it.

The misleading part: because `getAvailableTaskCount()` applies the same exclusion, a fully
group-locked queue returns **0**, and the loop's idle branch reports
`"No tasks available. Waiting for new tasks..."` — indistinguishable from an empty board, even
while the column visibly holds tasks in the UI. `describeClaimFailure()` produces the correct
`"waiting on its group — sibling task N is still being worked"` message, but it is only reached
after `claimTask()` returns null, which requires `todoCount > 0` — so on a group-locked queue
the good message is unreachable. It is not a deadlock: `resolveTask`/`resetTask` fire
`notifyTaskAvailable()`, so the parked session wakes as soon as the sibling leaves the stage —
whichever parked session wakes first wins the claim, which is why a task can appear to be
"picked up by a different session" than the one you were watching.

Before concluding a queue is stuck, check for a groupId sibling in that stage's `workingState`.

## Diagnosing what the pipeline actually did

`:Turn` nodes (`backend/src/db/turns.ts`, `(:Session)-[:HAS_TURN]->(:Turn)`) are the
authoritative per-turn record and the fastest way to reconstruct pipeline behavior — they carry
`sessionId`, `taskId`, `verdict`, `startedAt`/`endedAt`, `credits`, `hasChanges`. One Cypher
read ordered by `startedAt` shows every stage handoff, including verdict loops that are
invisible from the board's current state.

Note that the orchestrator's `worker-prompt-done` log line takes its `taskId` from
`session.meta.currentTaskId` at prompt-done time, not from the worker — so it reflects the
orchestrator's in-memory view, whereas `:Turn` is what was committed.

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
