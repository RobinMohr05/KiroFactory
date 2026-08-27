# Local dev-agent sessions missing sync_task_branch/finalize_branch_sync/submit_task_changes

Investigated 2026-08-27 after a developer-agent local session reported these MCP tools as
unavailable, plus a separate double-logged-output symptom in the same session transcript.
Fixed 2026-08-27 (same day) — see "FIXED" section below for the final design.

## Root cause

- `worker/worker.js`'s `buildMcpServers()` (used only by the ACA/hosted worker path —
  `runSessionAca` in `backend/src/session-manager.ts`) conditionally injects 4 MCP servers based
  on task/agent context: `verdict` (always), `pr-review` (if `REPO_URL` set), `pr-complete`
  (inspector-kind + auto-merge enabled + `qa-improvement-agent` only), and `git-delivery`
  (editor-kind + no `PERSISTENT_BRANCH_NAME` + `REPO_URL`). `git-delivery` is what exposes
  `sync_task_branch`, `finalize_branch_sync`, `submit_task_changes`.
- The **local** path (`runSession` → `KiroRunner.create()` in `backend/src/agent/kiro-runner.ts`)
  had no equivalent of `buildMcpServers()`. `KiroRunner.buildMcpServersPayload()` only hardcoded
  the `verdict` server plus whatever `mcpServers`/`rawMcpServers` were passed in from the DB
  `Session` record (`meta.mcpServers`/`meta.rawMcpServers` — user/session-configured servers only,
  set once at session creation).
- Local mode (`runSession`/`runLoopMode` in `session-manager.ts`) also had **zero repo/git wiring
  at all** — no `getTabById`/`repositoryUrl`/PAT credential resolution, no branch concept. It ran
  directly against `meta.cwd` as a plain local folder. All of that logic (~line 2001 onward in
  `session-manager.ts`, pre-fix line numbers) existed only inside `runSessionAca`.
- `worker/git-delivery-mcp-server.js` itself was fully reusable as-is for local mode — it's a
  plain Node stdio MCP server driven entirely by env vars (`WORKSPACE`, `TASK_BRANCH_NAME`,
  `TASK_ID`, `REPO_URL`, `GIT_PROVIDER`, `GITHUB_PAT`/`AZURE_DEVOPS_PAT`, `DELIVERY_RESULT_PATH`,
  etc.) and `execFileSync` git commands — nothing ACA/container-specific about it.

## FIXED 2026-08-27: full local git-delivery/pr-review parity

Implemented exactly the design sketched in this note's original "What full parity would require"
section (kept below for the historical record of the design process). Summary of the final
implementation:

- **`backend/src/agent/repo-url-parser.ts`**: added `buildTaskBranchName(taskType, taskId,
  taskTitle)`, mirroring `worker.js`'s `buildBranchName()` exactly (`[type]/#[id]_[slug]`) — the
  local and ACA paths must compute the identical branch name for the same task, since the DB's
  `task.branch` is otherwise the only source of truth once a branch exists remotely. `slugifyTitle`
  already existed in this file and needed no changes.
- **`backend/src/agent/kiro-runner.ts`**: `newSession()` gained optional `overrideMcpServers`/
  `overrideRawMcpServers` params that replace `this.sessionMcpServers`/`this.sessionRawMcpServers`
  before rebuilding the `session/new` payload. This avoids respawning the whole kiro-cli subprocess
  per task just to change which MCP servers are attached — the git-delivery server's env vars
  (branch name, task ID/title) are only known once a task is claimed, so they must be injectable
  per-task, not just once at `create()` time.
- **`backend/src/agent/local-git-delivery.ts`** (new module): `buildLocalGitDeliveryServer()` and
  `buildLocalPrReviewServer()` build the exact same env var sets as `worker.js`'s `buildMcpServers()`
  (same variable names, same conditional logic — e.g. `pr-review`'s `ALLOW_POST_COMMENT`/
  `ALLOW_RESOLVE_COMMENT` inversion by agent kind), pointing `args` at the existing
  `worker/git-delivery-mcp-server.js` / `worker/pr-review-mcp-server.js` scripts directly (resolved
  relatively, same depth as `kiro-runner.ts`'s existing `verdict-mcp-server.js` reference). Also
  exports `buildDeliveryResultPath(sessionId)` — uses `os.tmpdir()` instead of `worker.js`'s
  hardcoded `/tmp` path since local sessions run on Windows too.
- **`backend/src/session-manager.ts`**:
  - `runLoopMode()` now resolves git delivery context (tab → `repositoryUrl` → provider → PAT)
    **once per loop start**, mirroring `runSessionAca`'s `gitOptions` block almost verbatim. Only
    for `stages.kind === "editor"` sessions with at least one tab assigned. Wrapped in try/catch —
    resolution failure logs a `stderr` warning and the session proceeds with no git-delivery tools
    at all (same non-fatal pattern as every other MCP-wiring failure path in this file).
  - **Per claimed task**, before `newSession()`: computes `TASK_BRANCH_NAME` via
    `buildTaskBranchName()`, a fresh `DELIVERY_RESULT_PATH` via `buildDeliveryResultPath()` (any
    stale file from a previous task is deleted first), and builds the `git-delivery` server (always,
    if git context resolved) plus `pr-review` (only if `task.pullRequestUrl` is already set — a
    rework pass, matching `worker.js`'s own `if (REPO_URL)` gate for that server, just scoped
    further to "task already has a PR" since a first-attempt task has nothing to review yet).
    These are passed into `newSession()`'s new override params.
  - **After `streamPrompt()` returns**, for editor-kind tasks: reads `DELIVERY_RESULT_PATH` (if the
    file exists — the agent may not have called `submit_task_changes` this turn), exactly mirroring
    `worker.js`'s own `finishPromptTurn()` read-back. `deliveryResult.committed || .pushed` is now
    OR'd into the existing `hasLocalGitChanges()` commit gate (task #598) — so an MCP-driven
    commit/push satisfies the gate exactly like a manually-committed change already did, instead of
    the gate having no way to see it. When the turn resolves successfully AND the delivery result
    carried a `branchName`/`prUrl`, those are now passed into `resolveTask()` (tri-state semantics
    preserved — a field this turn didn't produce is omitted, not nulled, so it doesn't clobber a
    value a prior turn already stored).
- **Prompt-builder**: no changes needed. `buildDevPrompt()` already unconditionally instructed the
  agent to use `sync_task_branch`/`finalize_branch_sync`/`submit_task_changes` by name and forbade
  raw git commands — it was written generically (not ACA-specific) and the tool names match the
  local git-delivery server's tool names exactly, since both point at the same underlying script.
  This also explains why the original bug was silent instead of an obvious tool-not-found error:
  the agent was explicitly told to call tools that, locally, simply didn't exist in its toolset —
  it degraded to "explain why I can't do this" rather than erroring.
- **Tests**: `backend/src/agent/repo-url-parser.test.ts` gained 5 cases for `buildTaskBranchName`
  (format, determinism, uniqueness per task ID, special characters). New
  `backend/src/tests/local-git-delivery.test.ts` covers: git-delivery server injection with the
  correct branch name, conditional pr-review injection on rework passes, delivery-result read-back
  satisfying the commit gate and populating `resolveTask`'s branch/PR args, and confirming the gate
  still resets the task when no delivery result exists and there are no raw git changes either.
  Full suite green (25 files / 224 tests) after the change; `tsc` build clean.

### Known remaining limitations (not addressed by this fix)

- **No fresh clone / branch checkout on task claim.** Unlike the ACA path (which gets a brand-new
  ephemeral container + clone per run), local mode reuses whatever working tree already exists at
  `meta.cwd`. `sync_task_branch` (the git-delivery MCP tool) does create/checkout the task branch
  via `git fetch`/`checkout -B`, so this mostly works — but if `meta.cwd` isn't already a clone of
  the same `repositoryUrl` the tab has configured, or has uncommitted debris from a previous
  unrelated task, nothing in this fix detects or resets that (the ACA path's `git-workspace.ts`
  clean/re-clone step has no local equivalent). Operationally: keep one local session's `cwd`
  pointed at one clone of one repo, consistent with how local sessions were already being used
  before this fix (task-branch switching within that clone, not a fresh clone per task).
- **`pr-review` for editor-kind is read+resolve only** (`ALLOW_POST_COMMENT=false`), matching the
  ACA path's own restriction — this was an intentional carry-over, not a new limitation.
- **git context is resolved once per loop start, not re-resolved per task.** If a session's tab's
  `repositoryUrl`/provider/PAT changes mid-loop (e.g. credential rotated while the session is
  running), the session won't pick that up until it's restarted. Matches how session-level MCP
  config (non-git) already behaves in this codebase — not a regression introduced by this fix.

## What full parity for local mode would require (historical — design notes preserved from before the fix)

- Resolving the session's tab → `repositoryUrl` → git provider → PAT (mirroring
  `runSessionAca`'s tab lookup, ~line 2001+ in `session-manager.ts`).
- Computing/tracking a `TASK_BRANCH_NAME` per claimed task (mirrors
  `buildPersistentBranchName`/branch-per-task logic used server-side today only for ACA).
- A way to re-inject the `git-delivery`/`pr-review`/`pr-complete` MCP servers into `KiroRunner`
  **per task**, not just per session — `KiroRunner.newSession()` is already called once per
  claimed task in `runLoopMode`, but there's no "update mcpServers for this session" hook today;
  `sessionMcpServers` is only set once at `create()`/`newSession()` time from session-level
  config, not task-level context (branch name, task id, etc. are only known after claiming).

This was a substantial, multi-file design change (new local git-workspace setup + credential
resolution + per-task MCP server rewiring), not a one-line fix — flagged to the user rather than
silently implemented at the time this section was originally written. See the FIXED section above
for what was actually built once the user asked for it to be implemented.

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
