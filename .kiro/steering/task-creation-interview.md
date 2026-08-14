---
inclusion: always
---

# Task Creation Interview

Applies whenever the user asks you to create one or more tasks (e.g. "create
a task for...", "add a task to...", "file a task about..."). See
`task-origin-convention.md` for terminology, the `origin`/user/tab defaults,
and how `type`/`priority`/`files` should generally be inferred.

## Why this matters

A created task's `description` is dropped, largely verbatim, into the prompt
sent to an autonomous developer agent (see
`backend/src/agent/prompt-builder.ts`, `buildDevPrompt`).
That agent:

- gets no back-and-forth — it runs single-shot, unattended, under a timeout
  (default 15 min)
- is explicitly told not to look for other tasks, not to scope-creep, and to
  stop after this one task
- has to decide on its own whether "done" has been reached

If the description is vague, that agent will either guess (risking the wrong
implementation) or stall. Your job in this interview is to produce a
description that a competent engineer with zero prior conversation context
could execute correctly without asking a follow-up question.

## Process

Don't create the task on the first message. Work through the checklist
below, asking only about what's actually missing or ambiguous — skip
questions the user already answered implicitly. Prefer a short round of
targeted questions over one giant questionnaire; you can iterate.

**Checklist — a task description is ready when you can answer all of these:**

1. **Goal** — What should exist/change/be fixed when this is done? State it
   concretely, not as a vague intent ("improve the task list" is not
   enough; "add pagination to the task list, 20 items per page" is).
2. **Scope boundaries** — What is explicitly *not* part of this task? Call
   out anything adjacent that might tempt scope creep, so the agent doesn't
   wander into it.
3. **Relevant files/areas** — If you or the user already know which
   files/modules are involved, name them (populates `files` and helps the
   agent start in the right place). If genuinely unknown, it's fine to leave
   this for the agent to discover — don't go spelunking through the repo
   just to fill this field (per `task-origin-convention.md`).
4. **Acceptance criteria** — How would the agent (or you, reviewing the PR)
   verify this is actually done? Prefer concrete, checkable criteria
   (specific behavior, an error that should no longer occur, a build/test
   command that should pass) over "make it better."
5. **Constraints** — Any conventions, patterns, or things to avoid that
   aren't obvious from the codebase alone (e.g. "don't touch the DB schema,"
   "match the existing error-handling pattern in `x.ts`")?
6. **Type and priority** — Confirm your inferred `type`
   (`bug`/`feature`/`improvement`) and `priority` (1=Critical..4=Low) match
   the user's intent if there's any ambiguity. Don't ask if it's obvious
   from how they described it.

If the user's request is already unambiguous and narrow (e.g. they paste an
exact error and file to fix), you can skip most questions — don't interrogate
someone over something that's already fully specified. The bar is "would the
developer agent succeed unattended," not "did I ask N questions."

## Drafting and confirming

Once you have enough to write a self-contained description:

1. Draft the `title` and `description` (and `files`/`type`/`priority` if
   applicable).
2. Show the draft to the user before creating it — a task description is
   effectively a one-shot spec for an unattended agent, so a quick confirm
   is worth it. Keep this brief (the draft itself, not a long preamble).
3. On confirmation, create the task via the API per
   `task-origin-convention.md` (origin, tab/user defaults, etc.).
4. If the user wants multiple tasks from one conversation, draft all of them
   together for review before creating any, so boundaries between tasks are
   clear (avoid overlapping scope across tasks).
