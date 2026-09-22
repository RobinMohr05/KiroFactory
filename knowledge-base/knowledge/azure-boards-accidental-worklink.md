# Accidental Azure Boards work-item links from KiroFactory PRs (fixed 2026-09-22)

## Symptom

PRs/commits created by KiroFactory's worker for the VCH tab occasionally showed up
auto-linked to unrelated Azure Boards work items — e.g. a 2015 closed Bug in the
`SD_OnlineSolutions` project got a new "Fixed in Commit" ArtifactLink out of nowhere.

## Root cause

1. VCH's actual repo is **`AI-Community/tecfactory` on `tecalliance.visualstudio.com`
   (Azure Repos Git)** — not `github.com/RobinMohr05/KiroFactory` as
   `.kiro/steering/task-origin-convention.md` claimed at the time. That steering note is
   stale for the deployed/production instance (it may still be accurate for a personal
   dev fork, but not for the "VCH" tab itself). Worth re-verifying against the `tabs` row
   directly rather than trusting that doc if this comes up again.
2. Azure Repos Git has a **native** work-item linker (distinct from the GitHub↔Boards
   `AB#123` integration) that auto-links any bare `#<number>` found in a **commit
   message** or **PR title/description** to whatever work item has that numeric ID —
   anywhere in the Azure DevOps organization, with zero awareness of which repo/project
   "owns" that number. Confirmed via Stack Overflow + reproduced directly: work item
   #1774 in `SD_OnlineSolutions` (unrelated, from 2015) got linked the instant PR #126879
   in `tecfactory` was created with title `"... [KiroFactory #1774]"` from branch
   `feature/#1774_...`.
3. KiroFactory's own commit/PR-title format embedded the task ID as a bare `#<id>`:
   - `worker/worker.js`: `commitAndPush()`'s `commitTitle`, `buildPrContent()`'s `title`
   - `worker/git-delivery-mcp-server.js`: `submit_task_changes`'s commit/PR title building
     (both the create and update branches, including the "no new changes, push existing
     commits" path)
   - `worker/shared-branch-utils.js`: `buildGroupPrContent()`'s single-task and grouped
     title/description formats
4. TecAlliance's Azure DevOps org has 60+ projects going back to 2015 with work item IDs
   in the same low-thousands numeric range KiroFactory's own Neo4j task-ID counter is
   currently in — so collisions aren't rare edge cases, they're near-guaranteed as both
   counters climb.

## Fix

Changed every one of those title-building sites from `#${taskId}` to `KF-${taskId}`
(e.g. `[KiroFactory KF-1774]` instead of `[KiroFactory #1774]`). `KF-<id>` is not Azure
Boards link syntax (that's `AB#<id>`), so it can never trigger the auto-link, while
staying human-readable and greppable. Branch names (`buildBranchName()` in worker.js,
still `${taskType}/#${taskId}_...`) were deliberately left alone — Azure Boards' linker
scans commit messages and PR titles/descriptions, not branch name strings, so the `#` in
a branch name doesn't itself cause linking.

Updated in the same pass: `backend/src/agent/prompt-builder.ts`'s dev-agent instructions
(which told the agent about the old `[Vibecode Heaven #id]` suffix format) and the test
assertions in `git-delivery-mcp-server.test.js`, `shared-branch-group.test.ts`, and
`prompt-builder.test.ts` that pinned the old format.

## If this resurfaces

If a KiroFactory PR/commit ever again shows up linked to an unrelated work item, check
for any *other* place a bare `#<taskId>` (or any other ID) might still leak into a commit
message or PR title/description — not just re-check these already-fixed sites. Also
double check whether a *different* Azure Repos Git repo (not `tecfactory`) is affected,
since this is a per-organization hazard, not specific to one repo.
