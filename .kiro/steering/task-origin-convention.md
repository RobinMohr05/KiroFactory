---
inclusion: always
---

# Task Origin Convention

## Terminology

When the user refers to "items" or "tasks" in conversation, they mean the
**tasks stored in the database** (`:Task` nodes in Neo4j), not IDE tasks,
spec tasks, or to-do items. Always interpret task-related requests in the
context of the DB-backed task system managed by `backend/src/db/tasks.ts`
and `backend/src/agent/task-claimer.ts`.

## Database layer

The backend uses **Neo4j AuraDB** (cloud-hosted graph database) with the
`neo4j-driver` npm package — raw Cypher queries via managed transactions
(`readQuery`/`writeQuery` from `backend/src/db/connection.ts`). There is no
ORM or query builder.

Key patterns the developer agent needs to know:

- **No SQL.** All queries are Cypher. There is no `backend/sql/` directory,
  no `mssql` package, no SQL Server connection.
- **Relationships replace join tables.** E.g. `(:Task)-[:IN_TAB]->(:Tab)`
  replaces the old `task_tabs` table; `(:Task)-[:DEPENDS_ON]->(:Task)` is
  the dependency graph.
- **IDs are allocated by Counter nodes** (`backend/src/db/id-counter.ts`),
  not auto-increment columns. Every `createX()` calls `getNextId("Label")`.
- **Schema is constraint-based.** `backend/src/db/migrate.ts` runs
  idempotent `CREATE CONSTRAINT/INDEX IF NOT EXISTS` on startup — there are
  no incremental migration steps to add.
- **Task claiming** uses a CAS (compare-and-swap) retry loop with
  lock-forcing writes — not SQL Server's `UPDLOCK`/`READPAST`. See the
  extensive comment at the top of `backend/src/agent/task-claimer.ts`.
- **`files` and `columns` are native Neo4j list properties**, not separate
  tables or JSON strings.
- **`isBlocked` is computed at read time**, never stored — derived from
  whether any `[:DEPENDS_ON]` target has `state <> 'done'`.
- **Environment variables:** `NEO4J_URI`, `NEO4J_USERNAME`,
  `NEO4J_PASSWORD`, `NEO4J_DATABASE` (optional — AuraDB uses the instance
  ID as database name).

## How to create a task

Use `backend/scripts/create-task.ts` — do not call `POST /api/tasks` and do not
write a one-off `.temp/` script for this. This is the single, deterministic
path for creating tasks from a Kiro session, and it's what keeps all the
defaults in this file consistently applied. It creates tasks directly via
the DB layer (`createTask()` in `backend/src/db/tasks.ts`), the same layer
the authenticated API route itself calls, so this doesn't skip any DB-level
validation (cycle checks, etc.) — it just skips the HTTP/auth layer, which
isn't needed for a trusted local script.

```
cd backend && npx tsx scripts/create-task.ts --file <path-to-json>
cd backend && npx tsx scripts/create-task.ts --json '<inline json array>'
```

Input is a JSON array of task specs (one or more). See the script's own header
comment for the full field list — `title`, `type`, `priority`, and `tabIds`
are required; everything else follows the defaults described below and in
"Type, priority, description, and files". For a batch of tasks that depend on
each other (see `.kiro/steering/task-creation-interview.md`'s "Multiple
tasks" section), use `dependsOnBatchIndex` to reference an earlier entry by
its position in the same array — the script resolves those to real task IDs
after each one is created. To depend on a task that already exists from a
past session, use `dependsOnTaskId` with its real ID instead.

The script reads `NEO4J_URI`/`NEO4J_USERNAME`/`NEO4J_PASSWORD` from
`backend/.env` via `dotenv`, exactly like every other script in
`backend/scripts/` — never pass credentials as arguments or write them into
an input JSON file.

## Origin field

Always set the `origin` field to `"user-assisted"` (the script's default —
no need to pass it explicitly unless overriding). This indicates the task
was created through a collaborative conversation between the user and the
AI agent.

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

So a task spec for `create-task.ts` on this repo should include `tabIds: [2]`.
(No separate `userId` field is needed — `createTask()` derives ownership
from the tab's own `OWNS` relationship, not a stored property on the task.)

These IDs were confirmed on 2026-08-03. If tabs get renumbered or the user's
account changes, re-verify with a query against `users`/`tabs` rather than
trusting this note blindly.

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
