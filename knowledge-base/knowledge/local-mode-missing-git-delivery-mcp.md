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

## Related, separate gap — FIXED 2026-08-27: tab-toggle MCP servers (Atlassian/Azure DevOps/AWS)

A second, distinct instance of the same disease surfaced independently: a local
`code-reviewer-agent` session's transcript showed only the hardcoded `verdict` server plus the
`FALLBACK_TOOLS` set (`read`, `write`, `shell`, `grep`, `glob`, `code`) — none of the tab's
enabled MCP servers (Atlassian, Azure DevOps, AWS API, AWS Docs) were available, even though the
same tab/agent worked correctly when run via the ACA/hosted path.

Root cause (distinct from the git-delivery gap above, though same shape): `mcp-proxy-config.ts`'s
`buildProxyServersConfig()` — which resolves a tab's `mcpConfig` toggles + per-user decrypted
credentials into MCP server definitions — was only ever called from `runSessionAca`'s ACA branch
(~line 2114 in `session-manager.ts`), because its output was packaged for a **proxy sidecar
container** that only exists in ACA. The local path's `runSession()` → `KiroRunner.create()` call
only ever received `meta.mcpServers`/`meta.rawMcpServers` (session-level overrides) — tab-level
toggles were never resolved into anything for local sessions.

Unlike the git-delivery gap, this one didn't need a sidecar-shaped fix: locally, `KiroRunner`
already spawns `kiro-cli` (and can spawn each MCP server) as direct stdio child processes on the
same host — no container boundary to cross. Fix applied:

- `mcp-proxy-config.ts`: added `buildLocalMcpServerEntries(mcpConfig, credentials)`, which reuses
  the exact same `buildAtlassianServer`/`buildAzureDevopsServer`/`buildAwsApiServer`/
  `buildAwsDocsServer` builders as `buildProxyServersConfig`, but returns a flat
  `LocalMcpServerEntry[]` (structurally identical to `KiroRunner`'s `McpServerEntry`) instead of
  a `servers.json`-shaped map — no sidecar packaging, no Base64 env var.
- `session-manager.ts`'s local `runSession()`: in the cold-create branch (`!managed.runner`),
  resolves the session's tab `mcpConfig` (first tab in `meta.tabIds`, merged with
  `meta.mcpConfigOverride` if set — same precedence as the ACA path) and decrypts the owning
  user's credentials, then calls `buildLocalMcpServerEntries()` and prepends the result to the
  `mcpServers` array passed into `KiroRunner.create()`, ahead of the existing
  `meta.mcpServers`-derived entries. Wrapped in try/catch — a resolution failure logs a `stderr`
  warning and falls back to session-level servers only, non-fatal (mirrors the ACA branch's own
  error handling).
- Scoped to the cold-create path only: the pooled-runner reuse branch (`managed.pendingRunner` →
  `newSession()`) does not re-resolve or re-inject MCP servers, consistent with `KiroRunner`'s
  existing design — `sessionMcpServers` is set once at `create()` time, not on `newSession()`.

Verified: `tsc` build clean, full backend suite green (24 files / 215 tests, no regressions).

Still NOT covered by this fix: the git-delivery/pr-review/pr-complete gap above remains open —
those are task-scoped (branch name, task ID) and would need the more invasive per-task rewiring
described in that section, not just a toggle/credential lookup at session-create time.

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
