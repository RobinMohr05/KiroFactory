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

## End-of-session knowledge capture

When a session surfaces reusable findings (a bug's root cause, an undocumented gotcha, a working
recipe, a workspace convention), decide where it belongs before ending the session — don't let it
evaporate in chat history or linger in `.temp/`:

| Where | When |
|---|---|
| **Steering** (`.kiro/steering/*.md`) | Relevant often/broadly across sessions in this workspace. `inclusion: always` for things that should shape every session; `inclusion: fileMatch` for things only relevant when specific files are touched. |
| **Skill** (`.kiro/skills/<name>/SKILL.md`) | Specialized, occasional-use knowledge — won't come up in most sessions, but is valuable when it is needed (a how-to recipe, credentials/environment setup, a reference for a narrow task). Rule of thumb: **everything that won't be used that often should be a skill, not steering.** |
| **Hook** (`.kiro/hooks/*.json`) | Only when automatically triggering an action on a specific event is genuinely necessary — be conservative. Most "remember to do X" process reminders belong in always-included steering (already in every session's context), not a hook that fires on every session/tool/file event. |
| **Nowhere / `.temp/`** | Scratch investigation notes not worth preserving once the task is done — clean these up. |

Prefer extending an existing steering file or skill that already covers the topic over creating a
new, narrowly-overlapping one — fragmenting related knowledge across many tiny files makes it
harder to find later. Only split into a new file when the topic is genuinely distinct.
