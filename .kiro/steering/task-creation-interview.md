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
sent to an **autonomous developer agent**. That agent:

- gets no back-and-forth — it runs single-shot, unattended, under a timeout
  (default 15 min)
- is explicitly told not to look for other tasks, not to scope-creep, and to
  stop after this one task
- has to decide on its own whether "done" has been reached
- cannot ask follow-up questions — the description is ALL it gets

If the description is vague, that agent will either guess (risking the wrong
implementation) or stall. Your job in this interview is to produce a
description that a competent engineer with zero prior conversation context
could execute correctly without asking a follow-up question.

**Write the description FOR the executing agent, not for a human reading a
ticket.** Use second-person imperative ("Implement X by doing Y"), embed
enough repo/architectural context inline that the agent doesn't need prior
conversation, and be explicit about what "done" looks like.

## The method — frontier-based interview

Model the task as a **decision tree**. Every decision branches into further
decisions that depend on it. Work the tree in **rounds**:

1. The **frontier** is every decision whose prerequisites are already
   settled — the questions you can ask *now* without guessing at answers
   you haven't heard yet.
2. Ask the entire frontier in one round. Number each question and provide
   your own recommended answer. Then **stop and wait** for the user's
   answers before starting the next round.
3. Format each question like this:

   ```
   **Q1 - <question title>**: <question body>

   Rec: <your recommended answer>
   ```

4. Each round, the user's answers reshape the tree: settled decisions push
   the frontier outward and unblock questions that depended on them.
   Recompute the frontier and ask the next round. A question whose answer
   depends on another question still open this round belongs to a *later*
   round, not this one.

**Finding facts is your job when feasible.** If a frontier question needs a
fact from the environment (filesystem, code, tools, docs), look it up
yourself rather than asking the user — don't block the round on something
you could discover. The **decisions** stay the user's — put each one to them
and wait for an answer.

The session is done when the frontier is empty: every branch of the decision
tree visited, nothing left silently assumed.

## Passivity check

Watch for the user answering "agreed" / "yes" / "sounds good" to every
recommendation without any pushback, coming out with a spec you wrote that
they only nodded at. If a round produces zero corrections or "I don't
know" answers, treat that as a signal to check whether your questions were
pitched at enough fidelity — not as confirmation that you're done. Probe
one level deeper on at least one question to verify actual engagement.

## When conversation can't resolve it

Some questions can't be settled through more talk — they need something
concrete to react to (a prototype, a visual, an experiment). When you hit
one of these:

- **Suggest splitting into a spike + implementation task** — a spike task
  that explores the unknown, followed by a proper task once the spike
  settles the question.
- **Or suggest the user create the task via the IDE** where they can do
  exploratory coding in a conversational session first.

Don't keep rephrasing an unresolvable question. Recognize it, name it, and
offer the escape hatch above.

## Convergence guard

If you've completed 3+ rounds without convergence (the frontier keeps
growing, the user keeps changing direction, or scope remains unclear),
explicitly name the situation and suggest:

1. Splitting into multiple smaller tasks with clear boundaries, or
2. Creating the task via the IDE where a more interactive workflow is
   available, or
3. Doing a spike task first to settle the unknowns.

## Multiple tasks

If the user wants multiple tasks from one conversation, grill the *set*
together — ask questions that establish boundaries between tasks in the same
round (to avoid overlapping scope). Then draft all of them at once for
review before creating any.

## Drafting and confirming

Once the frontier is empty and you have enough to write a self-contained
description:

1. Draft the `title` and `description` (and `files`/`type`/`priority` if
   applicable). Write the description in a style optimized for the
   autonomous developer agent that will receive it:
   - Second-person imperative ("Implement...", "Add...", "Fix...")
   - Include relevant file paths, function names, architectural context
   - Explicit acceptance criteria the agent can self-verify against
   - Name what is NOT in scope so the agent doesn't wander

2. Show the draft to the user before creating it. Keep this brief (the
   draft itself, not a long preamble).

3. On confirmation, create the task via the API per
   `task-origin-convention.md` (origin, tab/user defaults, etc.).

## Escape hatch

If the user's request is already unambiguous and narrow (e.g. they paste an
exact error and the file to fix), you can skip most of the interview. The
bar is "would the autonomous developer agent succeed unattended with this
description alone," not "did I ask N rounds of questions."
