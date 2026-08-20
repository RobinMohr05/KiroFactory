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


