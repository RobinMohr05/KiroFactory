# Local dev-agent sessions missing sync_task_branch/finalize_branch_sync/submit_task_changes

Investigated 2026-08-27 after a developer-agent local session reported these MCP tools as
unavailable, plus a separate double-logged-output symptom in the same session transcript.

## Root cause

- `worker/worker.js`'s `buildMcpServers()` (used only by the ACA/hosted worker path —
  `runSessionAca` in `backend/src/session-manager.ts`) conditionally injects 4 MCP servers based
  on task/agent context: `verdict` (always), `pr-review` (if `REPO_URL` set), `pr-complete`
  (inspector-kind + auto-merge enabled + `qa-improvement-agent` only), and `git-delivery`
  (editor-kind + no `PERSISTENT_BRANCH_NAME` + `REPO_URL`). `git-delivery` is what exposes
  `sync_task_branch`, `finalize_branch_sync`, `submit_task_changes`.
- The **local** path (`runSession` → `KiroRunner.create()` in `backend/src/agent/kiro-runner.ts`)
  has no equivalent of `buildMcpServers()`. `KiroRunner.buildMcpServersPayload()` only hardcodes
  the `verdict` server plus whatever `mcpServers`/`rawMcpServers` were passed in from the DB
  `Session` record (`meta.mcpServers`/`meta.rawMcpServers` — user/session-configured servers only,
  set once at session creation).
- Worse: local mode (`runSession`/`runLoopMode` in `session-manager.ts`) has **zero repo/git
  wiring at all** — no `getTabById`/`repositoryUrl`/PAT credential resolution, no branch concept.
  It runs directly against `meta.cwd` as a plain local folder. All of that logic (~line 2001
  onward in `session-manager.ts`) exists only inside `runSessionAca`.
- `worker/git-delivery-mcp-server.js` itself is fully reusable as-is for local mode — it's a plain
  Node stdio MCP server driven entirely by env vars (`WORKSPACE`, `TASK_BRANCH_NAME`, `TASK_ID`,
  `REPO_URL`, `GIT_PROVIDER`, `GITHUB_PAT`/`AZURE_DEVOPS_PAT`, `DELIVERY_RESULT_PATH`, etc.) and
  `execFileSync` git commands — nothing ACA/container-specific about it.

## What full parity for local mode would require

- Resolving the session's tab → `repositoryUrl` → git provider → PAT (mirroring
  `runSessionAca`'s tab lookup, ~line 2001+ in `session-manager.ts`).
- Computing/tracking a `TASK_BRANCH_NAME` per claimed task (mirrors
  `buildPersistentBranchName`/branch-per-task logic used server-side today only for ACA).
- A way to re-inject the `git-delivery`/`pr-review`/`pr-complete` MCP servers into `KiroRunner`
  **per task**, not just per session — `KiroRunner.newSession()` is already called once per
  claimed task in `runLoopMode`, but there's no "update mcpServers for this session" hook today;
  `sessionMcpServers` is only set once at `create()`/`newSession()` time from session-level
  config, not task-level context (branch name, task id, etc. are only known after claiming).

This is a substantial, multi-file design change (new local git-workspace setup + credential
resolution + per-task MCP server rewiring), not a one-line fix. Flagged to the user rather than
silently implemented; not yet built as of this note.

## Separate, fixed: double log line output (StrictMode WebSocket race)

Root cause: `frontend/src/main.tsx` wraps the app in `<StrictMode>`. `AppContext.tsx`'s init
`useEffect` calls `connectWebSocket()`, which opens a `new WebSocket(...)`. StrictMode dev-mode
double-invokes this effect (mount → cleanup → mount) synchronously, but `WebSocket.close()` in
the cleanup is asynchronous — so the first socket can still be `OPEN` (and still registered
server-side in `websocket-handler.ts`'s per-user `clients` Map) when the second socket connects.
The server's `broadcastToUser` then sends every message to both sockets, both arrive in the same
tab, and each is appended via `SessionsPanel.tsx`'s `ws-session-output` listener
(`setOutput(prev => [...prev, detail.entry])`) — producing every log line doubled, matching the
reported symptom exactly.

Fix applied (`frontend/src/context/AppContext.tsx`): tagged each socket with an `isCurrent()`
closure check (`wsRef.current === ws`) inside `connectWebSocket`'s `open`/`message`/`close`
handlers, so a superseded (stale) socket is inert — its messages are ignored and it force-closes
itself. The init effect's cleanup now also nulls `wsRef.current` before calling `.close()` on the
stale socket, so the second mount's new socket is never mistaken for stale.

This bug is production-mode-inert (StrictMode's double-invoke only happens in React dev mode), so
it wouldn't reproduce in a deployed/hosted build — only in local `npm run dev`.
