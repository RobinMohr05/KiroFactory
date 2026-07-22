---
inclusion: always
---

# Task Origin Convention

When the user asks you to create a task (via the API at `POST /api/tasks`), always set the `origin` field to `"user-assisted"`. This indicates the task was created through a collaborative conversation between the user and the AI agent.

Only use a different origin if the user explicitly specifies one.
