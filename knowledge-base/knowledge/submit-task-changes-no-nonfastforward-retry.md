# Fixed: `submit_task_changes` had no non-fast-forward push retry (unlike worker.js)

Found and fixed 2026-09-03, from a live production transcript (task 1565, three runs across
one loop session).

## Symptom

An editor-kind agent's turn completed cleanly (RED→GREEN TDD, tests passing, build clean,
`report_verdict`/summary all correct), called `@git-delivery/submit_task_changes`, which
committed successfully but then failed the push with:

```
! [rejected]  HEAD -> feature/#1565_... (non-fast-forward)
hint: Updates were rejected because the tip of your current branch is behind
```

`worker.js` classified this as `deliveryFailed: true` ("committed but couldn't push — a git
credential/permission problem, not a task problem — retrying will not help") and permanently
blocked the task for the rest of the session after 3 consecutive failures. The GitHub PAT itself
was fine — `verifyPushAccess()` had already confirmed push access via a `--dry-run` preflight at
container startup (a throwaway ref, unrelated to the real task branch's state).

## Root cause

`worker.js` already has `pushWithRebaseRetry()` — on a non-fast-forward rejection it fetches the
remote branch, rebases the local commit on top, and retries (up to 3 attempts), specifically
*because* a non-fast-forward is a recoverable race (another run advancing the same branch — a
sibling task, a prior run's `resolve_review_comment`, etc.), not a credential problem. But that
retry only lived in `worker.js`'s own legacy `commitAndPush()`/`pushWithRebaseRetry()` path,
used by standalone/persistent-branch sessions.

The git-delivery MCP tools path — `sync_task_branch` / `submit_task_changes` in
`worker/git-delivery-mcp-server.js`, which is what every editor-kind agent is actually instructed
to use per `prompt-builder.ts`'s `buildDevPrompt()` — had its own separate, plain `execGit(["push",
...])` with **no retry at all**, in both of `handleSubmitTaskChanges`'s push call sites (the
normal "new changes" path and the "no uncommitted changes but local commits are ahead" path). A
rejected push there surfaced immediately as a hard failure with no recovery attempt.

This is exactly why the transcript's Run #3 failed: `sync_task_branch` had already put the agent
on the correct task branch, the agent did real, correct work, committed it — but something
(likely Run #2's `resolve_review_comment` call, or another sibling run) advanced the remote branch
in the ~1 minute since the last sync, and the bare `submit_task_changes` push had no way to
recover from that.

## Fix

Added a `pushWithRebaseRetry(remote, branchName, maxAttempts=3)` helper to
`git-delivery-mcp-server.js`, mirroring `worker.js`'s version almost line-for-line: on a detected
non-fast-forward rejection (`/\[rejected\]|non-fast-forward|fetch first|behind its remote/i`),
fetch the branch, rebase onto `FETCH_HEAD`, and retry the push; abort the rebase and surface both
errors together if the rebase itself conflicts; return immediately (no retry) for any other error,
since a real auth/permission failure needs to surface and block as-is. Both push call sites in
`handleSubmitTaskChanges` now go through this helper instead of a bare `execGit(["push", ...])`.

Added a regression test (`git-delivery-mcp-server.test.js`, "recovers from a non-fast-forward push
rejection by rebasing and retrying") that simulates a second clone pushing to the same task branch
before `submit_task_changes` runs, and asserts the push still succeeds with both commits present
on the remote afterward. Confirmed the test fails without the fix and passes with it.

## Note on this repo's test harness on Windows

6 pre-existing tests in `git-delivery-mcp-server.test.js` fail on Windows/PowerShell regardless of
this change — `execSync("git commit -m 'multi word message'")` gets mangled by PowerShell's
quoting (`error: pathspec 'word'' did not match...`). This is a harness bug, not a product bug;
confirmed by running the suite on `develop` before any changes (same 8 pass / 6 fail). Any new test
added here should avoid multi-word `-m` messages passed through `execSync` string form, or use a
single-word placeholder, to sidestep it.
