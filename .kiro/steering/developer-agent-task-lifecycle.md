---
inclusion: auto
---

# Developer Agent — Task Lifecycle

This document describes how the Vibecode Heaven developer agent autonomously finds, claims, executes, and resolves tasks. The program takes over entirely — no human intervention is needed during execution.

## Task Lifecycle Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                                                                      │
│   1. FIND TASK                                                       │
│   ───────────                                                        │
│   Query the database for the highest-priority available task.        │
│   Priority ordering:                                                 │
│     - Priority ASC (1=Critical first)                                │
│     - Origin: user > user-assisted > ai                              │
│     - Created date ASC (oldest first)                                │
│                                                                      │
│   If no tasks available: wait (loop mode) or exit (single-shot).     │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   2. CLAIM TASK (atomic, concurrent-safe)                            │
│   ─────────────                                                      │
│   Uses SQL Server row-level locking (UPDLOCK + READPAST):            │
│     - UPDLOCK: locks the row so no other agent can read it           │
│     - READPAST: other agents skip locked rows (no waiting)           │
│                                                                      │
│   In a single transaction:                                           │
│     UPDATE tasks SET state = 'in-progress'                           │
│     WHERE id = (SELECT TOP 1 ... WITH (UPDLOCK, READPAST))           │
│                                                                      │
│   Result: the agent now "owns" this task. No other agent can         │
│   claim the same task — they'll get the next one.                    │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   3. EXECUTE TASK                                                    │
│   ──────────────                                                     │
│   - Build a focused prompt from the task data (title, description,   │
│     files, priority, type)                                           │
│   - Spawn a kiro-cli ACP session with that prompt                    │
│   - Stream output in real-time (agent messages, tool calls)          │
│   - Enforce a timeout (default: 15 minutes per task)                 │
│                                                                      │
│   The prompt instructs the AI to:                                    │
│     - Read the relevant files                                        │
│     - Implement the change                                           │
│     - Verify it compiles                                             │
│     - STOP after this single task (no scope creep)                   │
│                                                                      │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   4. RESOLVE — SUCCESS or ROLLBACK                                   │
│   ───────────────────────────────────                                │
│                                                                      │
│   ON SUCCESS (prompt completed without error/timeout):               │
│     UPDATE tasks SET state = 'developed'                             │
│     → Task moves to "Developed" column on the board                  │
│                                                                      │
│   ON FAILURE (error, timeout, or crash):                             │
│     UPDATE tasks SET state = 'todo'                                  │
│     → Task is ROLLED BACK to "Todo" — available for retry            │
│     → No partial work is persisted in DB state                       │
│     → The task can be picked up again (by same or different agent)   │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Execution Modes

| Mode | Behavior | Command |
|------|----------|---------|
| Single-shot | Claim one task, execute, exit | `npx tsx src/agent/dev-agent.ts` |
| Specific task | Claim task by ID | `--task 5` |
| Loop (continuous) | Keep claiming tasks until none left or SIGINT | `--loop` |
| Custom agent | Use a different .kiro/agents/ definition | `--agent my-agent` |
| Timeout override | Change per-task timeout | `--timeout 600` |

## Loop Mode Behavior

In `--loop` mode the agent continuously:
1. Check how many todo tasks are available
2. If none: wait `--interval` seconds (default 10), then recheck
3. If available: claim one, execute it, resolve it
4. Repeat until SIGINT or fatal error

Graceful shutdown: on SIGINT, finishes the current task before stopping.

## Concurrency Safety

Multiple agents can run in parallel. The UPDLOCK + READPAST pattern guarantees:
- No two agents claim the same task
- No deadlocks (READPAST skips locked rows instead of waiting)
- If an agent crashes mid-task, the task stays `in-progress` until manually reset or a watchdog resets it

## Key Design Decisions

1. **The program finds the task** — the AI never picks its own work. The task-claimer selects based on priority/origin/age.
2. **Atomic claim** — finding + claiming happens in one transaction. No race conditions.
3. **Rollback on failure** — if anything goes wrong, the task returns to `todo`. No manual intervention needed.
4. **Focused prompts** — the AI gets a single, clearly-scoped task with explicit "do NOT do other things" rules.
5. **Timeout enforcement** — prevents runaway sessions from holding a task hostage.
6. **Orphan cleanup** — on startup, kills any leftover kiro-cli processes from crashed previous runs.

## Relevant Source Files

- `backend/src/agent/dev-agent.ts` — Main entry point, orchestrates the full lifecycle
- `backend/src/agent/task-claimer.ts` — Atomic task claiming with SQL row locking
- `backend/src/agent/prompt-builder.ts` — Constructs the implementation prompt from task data
- `backend/src/agent/kiro-runner.ts` — ACP client wrapper (spawns kiro-cli, streams NDJSON)
- `backend/src/agent/index.ts` — Public exports for the agent module
