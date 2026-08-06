---
inclusion: always
---

# Temporary Files Convention

When you need to create temporary scripts, notes, or scratch files that are only needed during the course of a task (not part of the permanent codebase), place them inside a `.temp/` folder at the workspace root.

**Use `.temp/` for things like:**
- One-off debugging or exploration scripts
- Scratch notes or intermediate output while investigating an issue
- Temporary data dumps, generated fixtures, or sample payloads used to verify a change
- Any file you create solely to help yourself complete a task, that the user didn't ask to keep

**Do NOT put in `.temp/`:**
- Anything the user explicitly asked you to create as a deliverable
- Source code, config, or scripts that are part of the actual feature/fix
- Tests intended to be kept in the repo's test suite

`.temp/` is gitignored, so nothing placed there will ever be committed. Clean up files inside `.temp/` when they're no longer needed for the task, but don't worry about it being tracked by git.
