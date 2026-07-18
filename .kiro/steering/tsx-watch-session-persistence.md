---
inclusion: fileMatch
fileMatchPattern: "backend/src/session-store.ts,backend/src/session-manager.ts,sessions.json,backend/package.json"
---

# TSX Watch — Auto-Restart Sessions After Server Reload (TEMPORARY)

## Context

The backend dev server uses `tsx watch` for hot-reload during development. When the autonomous agent edits backend `.ts` files, `tsx watch` detects the change and restarts the server — which kills the `kiro-cli` child process mid-task.

## Current Solution

A two-part approach handles this gracefully:

### 1. Auto-restart on server boot

When the server starts, `initSessions()` in `session-manager.ts`:
- Loads `sessions.json` from disk
- Detects sessions that were "running" before the restart (via `__wasRunning` flag from `session-store.ts`)
- Resets orphaned in-progress tasks back to "todo" (via `resetOrphanedTasks()` in `task-claimer.ts`)
- Auto-restarts those sessions after a 2-second delay (to let the server finish initializing)

### 2. `sessions.json` excluded from tsx watch

The `--exclude ../sessions.json` flag in `backend/package.json` prevents the persistence file from triggering unnecessary restarts.

## Flow When Agent Edits Backend Source

1. Agent edits a `.ts` file → `tsx watch` restarts the server
2. `kiro-cli` child process dies (pipe broken)
3. Server boots, calls `initSessions()`
4. Sees session was "running" → marks it for auto-restart
5. Resets orphaned in-progress tasks back to "todo"
6. After 2s delay, calls `startSession()` → new `kiro-cli` spawned
7. Agent picks up the next todo task (including the one that was interrupted)

## Limitations

- There's a ~5 second gap during restart (server boot + 2s delay + ACP handshake)
- The interrupted task loses its progress and starts from scratch
- Output buffer is cleared on restart (not persisted to disk)

## When to Remove This Workaround

This workaround should be **removed** when we implement **devcontainers for the CLI processes**. With devcontainers:
- Agent processes run in isolated containers, independent of the host backend server
- Server restarts no longer kill agent processes
- The auto-restart logic in `initSessions()` can be simplified
- Remove the `--exclude` flag from `package.json`
- Remove this steering file

## Files Involved

- `backend/package.json` — contains the `--exclude ../sessions.json` flag
- `backend/src/session-store.ts` — writes `sessions.json`, sets `__wasRunning` flag on load
- `backend/src/session-manager.ts` — `initSessions()` auto-restarts previously-running sessions
- `backend/src/agent/task-claimer.ts` — `resetOrphanedTasks()` resets stuck in-progress tasks
- `sessions.json` — persisted session metadata (excluded from tsx watch)
