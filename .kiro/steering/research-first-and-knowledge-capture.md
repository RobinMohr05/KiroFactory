---
inclusion: always
---

# Research First, Ask Before Assuming, Capture Knowledge

Standing conventions for how to work in this workspace, confirmed with the user 2026-08-13.

## Research before answering, and ask about open questions

- Before proposing or making a change, look at the actual code/config first — don't guess or
  "imagine" plausible-sounding behavior into an answer.
- When multiple reasonable interpretations exist, or a decision affects scope (delete vs.
  deprecate, doc-note vs. new task, steering vs. skill, etc.), surface it as an explicit question
  with concrete proposals rather than silently picking one.
- Priority order when sources conflict: the user's explicit instruction > what the code actually
  does (ground truth) > existing docs/steering (can be stale) > assumption.

## Docs vs. code: code wins

- When a steering file, README, or design doc disagrees with what the code actually does, the
  code is correct and the doc is stale. Reconcile by rewriting the doc to match the code — don't
  change working code to match a doc unless the user is asking for that specific behavior change.
- If reconciling a doc reveals the documented code path is never actually invoked in production
  (no route, no Dockerfile/CI/job references it), that's a real finding to raise — confirm with
  the user whether to delete it or keep it as documented legacy tooling before assuming either
  way.
- Precedent: `backend/src/agent/dev-agent.ts` (and its exclusive dependents `git-workspace.ts`,
  `github-pr.ts`, plus `docs/worker-git-workflow.md`) were confirmed dead — never invoked by any
  Dockerfile, ACA job, or route, only reachable via local npm scripts — and were removed
  entirely, with `.kiro/steering/developer-agent-task-lifecycle.md` rewritten to describe the
  actual `session-manager.ts` + `task-claimer.ts` + `worker.js` pipeline instead. Default to this
  resolution (remove + rewrite docs) rather than leaving dead code in place "for reference."

## Task/board state isn't ground truth either — a written fix isn't a wired fix

The same "code wins" skepticism applies to the DB's task state, not just to docs/steering. A
task marked `done`/`resolved` is a claim someone (human or agent) made, not proof the underlying
code path actually runs.

- Precedent: task #598 ("Local-mode pipeline has no commit gate") was itself marked `done` in
  Neo4j while its own fix — `backend/src/agent/local-git-check.ts`'s `hasLocalGitChanges()` plus
  a fully-written test file (`local-commit-gate.test.ts`) spec'ing the exact desired behavior —
  sat completely unwired: nothing in `session-manager.ts` ever called it. This was only caught
  by grepping for actual call sites of the helper (found none in non-test code) and then running
  the existing test suite, which failed immediately with a plain "0 calls" assertion error.
- General rule this generalizes to: a well-tested helper file existing in the repo is not evidence
  it's integrated anywhere. Before trusting that a documented/tracked fix has landed — whether the
  evidence is a task's `done` state, a steering note, or just "there's a file for it" — grep for
  where it's actually called from, and run its tests, rather than taking the board column at face
  value.
