# Vibecode Heaven Worker — Git Workflow Specification

## Overview

This document defines the end-to-end workflow for the Vibecode Heaven developer worker (dev-agent). The worker autonomously claims tasks, checks out the assigned repository, creates a feature branch, executes the implementation via Kiro, commits/pushes changes, and creates a Pull Request on GitHub.

## Workflow Steps

```
┌─────────────────────────────────────────────────────────┐
│  1. Claim highest-priority task (todo → in-progress)    │
│  2. Resolve repository URL from task's tab              │
│  3. Prepare workspace (clone or pull develop)           │
│  4. Create feature branch from develop                  │
│  5. Execute Kiro agent on the branch                    │
│  6. Commit & push changes                              │
│  7. Create Pull Request (GitHub REST API)              │
│  8. Mark task as "developed"                           │
└─────────────────────────────────────────────────────────┘
```

---

## Requirements

### R1 — Task Claiming (existing, unchanged)

The worker claims the highest-priority task from the database using atomic row locking (`claimTask`). The task state transitions from `todo` → `in-progress`.

Priority ordering: priority ASC, then origin weight (user > user-assisted > ai), then oldest first.

### R2 — Repository Resolution

- The worker resolves the task's repository URL from `tab.repositoryUrl` of the tab the task belongs to.
- A task belongs to exactly one tab (single-repo assumption).
- If no `repositoryUrl` is set on the tab, the worker logs an error and resets the task to `todo`.

### R3 — Workspace Preparation (reuse + pull)

- The worker maintains a local checkout directory per repository under a configurable workspace root (`WORKSPACE_ROOT` env var, default: `./workspaces`).
- Directory naming: `{WORKSPACE_ROOT}/{owner}_{repo}` (derived from the repository URL).
- **If the directory already exists:**
  1. `git fetch origin`
  2. `git checkout develop`
  3. `git pull origin develop`
  4. Clean any leftover state: `git reset --hard origin/develop`
- **If the directory doesn't exist:**
  1. `git clone <repositoryUrl> <dir>`
  2. `git checkout develop`
- If `develop` doesn't exist on the remote, the worker logs an error and resets the task to `todo`.

### R4 — Branch Creation

- Create a new branch from `develop` with the naming convention:

  ```
  [task_type]/#[task_id]_[task_title_slug]
  ```

- **Title slugification rules:**
  - Lowercase
  - Spaces replaced with hyphens
  - Strip characters not in `[a-z0-9-]`
  - Collapse multiple hyphens into one
  - Truncate to max 60 characters (avoid overly long branch names)
  - Trim trailing hyphens

- **Example:** Task ID 42, type `feature`, title "Add User Login Page"
  → `feature/#42_add-user-login-page`

- Command: `git checkout -b <branch_name>`

### R5 — Agent Execution

- The Kiro agent (via `KiroRunner`) executes in the checked-out repository directory (NOT the Vibecode Heaven project root).
- The prompt instructs the agent NOT to perform any git operations — the orchestrator handles all git work.
- The agent's `cwd` is set to the repository checkout path.
- Timeout applies as configured (default 15 minutes).

### R6 — Commit & Push

After successful agent execution:

1. Check `git status --porcelain`:
   - If no changes: log a warning and proceed to mark developed (the agent may have determined the work was already done).
2. Stage all changes: `git add -A`
3. Commit with message:
   - **Title:** `<task_title> [Vibecode Heaven #<task_id>]`
   - **Body:** Task type, priority, and description
4. Push: `git push -u origin <branch_name>`
5. Push failures retry up to 2 attempts with a 2-second delay between attempts.

### R7 — Pull Request Creation (GitHub REST API)

After successful push, create a GitHub Pull Request via the REST API.

- **Endpoint:** `POST https://api.github.com/repos/{owner}/{repo}/pulls`
- **Authentication:** GitHub PAT passed as `Authorization: Bearer <token>` header.
- **Request body:**
  ```json
  {
    "title": "<task_title> [Vibecode Heaven #<task_id>]",
    "body": "## Task\n\n**Type:** <type>\n**Priority:** <priority>\n**ID:** <task_id>\n\n## Description\n\n<task_description>\n\n---\n*Created automatically by Vibecode Heaven*",
    "head": "<branch_name>",
    "base": "develop"
  }
  ```
- **URL parsing:** Support both formats:
  - `https://github.com/{owner}/{repo}` (with or without `.git`)
  - `git@github.com:{owner}/{repo}.git`
- **Response:** Log the PR URL from the response (`html_url`).

### R8 — State Transition: Developed

- After PR creation succeeds, the task state transitions to `developed`.
- The PR URL is logged in the output.

### R9 — Error Handling & Logging

Each step is individually logged with timestamps.

| Failure Point | Action |
|---|---|
| No repository URL on tab | Reset to `todo`, log error |
| `develop` branch doesn't exist on remote | Reset to `todo`, log error |
| Git clone/pull fails | Reset to `todo`, log error |
| Agent execution fails or times out | Reset to `todo`, log error |
| No changes after agent run | Mark `developed`, log warning |
| Commit fails | Reset to `todo`, log error |
| Push fails (after retries) | Reset to `todo`, log error |
| PR creation fails (HTTP error) | Log error; task stays `in-progress` (code is pushed, manual intervention needed) |

### R10 — Credential Storage (GitHub PAT)

- A new credential key `githubPat` is added to the `CredentialKey` union type.
- The GitHub PAT is stored encrypted per-user, same as existing Azure DevOps PAT pattern.
- The worker retrieves the decrypted PAT from the credential store before performing git and API operations.

### R11 — Git Authentication for Clone/Push

- The worker uses the GitHub PAT for HTTPS-based git operations.
- Approach: Inject credentials via the repository URL for subprocess calls:
  ```
  https://{pat}@github.com/{owner}/{repo}.git
  ```
- The PAT is only held in memory for the duration of the git command — never written to disk or logged.

### R12 — Loop Behavior

- After marking the task as `developed`, the single iteration ends.
- In `--loop` mode, the worker proceeds to the next iteration (claim next task).
- At the start of each iteration, workspace preparation (R3) ensures the local checkout is clean and up-to-date with `develop`.

### R13 — Configuration

| Config | Source | Default |
|---|---|---|
| `WORKSPACE_ROOT` | Environment variable | `./workspaces` |
| GitHub PAT | Credential store (per-user, encrypted) | — |
| Timeout per task | CLI arg `--timeout` | 900s (15 min) |
| Loop mode | CLI arg `--loop` | false |
| Agent name | CLI arg `--agent` | `developer-agent` |

---

## Implementation Notes

- **PR creation uses Node's built-in `fetch`** (available in Node 18+). No external dependencies needed.
- The existing `commitAndPush` function in `dev-agent.ts` will be refactored to support the new branch-based workflow.
- The `ClaimedTask` interface may need extension to include the resolved `repositoryUrl` and credential info.
- Branch cleanup (deleting old feature branches locally) is not in scope for v1 but should be considered for future iterations.

## File Changes Summary

| File | Change |
|---|---|
| `backend/src/types.ts` | Add `githubPat` to `CredentialKey` |
| `backend/src/agent/dev-agent.ts` | Refactor to new workflow (branch, PR) |
| `backend/src/agent/task-claimer.ts` | Extend to return tab/repo info with claimed task |
| `backend/src/agent/prompt-builder.ts` | Update prompt (agent works in repo dir) |
| `backend/src/agent/github-pr.ts` | New file: GitHub PR creation via REST API |
| `backend/src/agent/git-workspace.ts` | New file: workspace prep, branch creation, commit/push |
| `backend/src/agent/repo-url-parser.ts` | New file: parse owner/repo from GitHub URLs |
