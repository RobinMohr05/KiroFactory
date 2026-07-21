---
inclusion: always
---

# Project Terminology

When the user refers to "items" or "tasks" in conversation, they mean the **tasks stored in the database** (the `tasks` table), not IDE tasks, spec tasks, or to-do items. Always interpret task-related requests in the context of the DB-backed task system managed by `backend/src/db/tasks.ts` and `backend/src/agent/task-claimer.ts`.
