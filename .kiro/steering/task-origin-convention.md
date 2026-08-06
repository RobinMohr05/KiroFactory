---
inclusion: always
---

# Task Origin Convention

## Terminology

When the user refers to "items" or "tasks" in conversation, they mean the
**tasks stored in the database** (the `tasks` table), not IDE tasks, spec
tasks, or to-do items. Always interpret task-related requests in the context
of the DB-backed task system managed by `backend/src/db/tasks.ts` and
`backend/src/agent/task-claimer.ts`.

## Origin field

When the user asks you to create a task (via the API at `POST /api/tasks`), always set the `origin` field to `"user-assisted"`. This indicates the task was created through a collaborative conversation between the user and the AI agent.

Only use a different origin if the user explicitly specifies one.

## Default account and tab

Unless the user says otherwise, create tasks for:

- **User:** `robin.mohr@tecalliance.net` — `users.id = 1`
- **Tab:** for tasks about *this* repo (KiroFactory), the tab is `VCH` —
  `tabs.id = 2`, `repository_url = https://github.com/RobinMohr05/KiroFactory`.
  The user sometimes refers to it as "VHC" or "kirofactory" — same tab. This is
  the one mapping worth hardcoding here, since "which tab corresponds to the
  workspace I'm currently sitting in" isn't something the database can tell you
  on its own.

So a `CreateTaskInput` for a task on this repo should include `tabIds: [2]`
(and, if calling the DB layer directly instead of the authenticated API,
`userId: 1` for ownership checks that rely on it).

These IDs were looked up directly against the `TecFactory` database
(`REDACTED_DB_SERVER`) and confirmed on 2026-08-03. If tabs get
renumbered or the user's account changes, re-verify with a query against
`users`/`tabs` rather than trusting this note blindly.

For any *other* repo/tab (there are several other tabs for other projects),
don't hardcode a mapping here — just query `tabs` (name, repository_url,
user_id) to find the right one when needed. That data already lives in the
DB; duplicating it in steering would just go stale.

## Type, priority, description, and files

Don't apply fixed defaults for `type`, `priority`, or `files` — infer them
from the conversation/task context each time:

- `type` (`"bug" | "feature" | "improvement"`) and `priority` (`1`-`4`,
  1=Critical) — infer from how the user describes the work.
- `files` — only set this if the relevant file(s) are already clear from
  context (e.g. the user named them, or we were just editing them). Don't
  spend extra effort searching the repo just to populate this field.
