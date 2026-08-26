# KiroFactory Knowledge Base

This is an Obsidian vault. Its purpose is to capture understanding of the **current codebase**
and **future plans** for KiroFactory in a form that's easy for both the human maintainer and the
Kiro AI agent to navigate and build on.

## Why this exists (vs. `.kiro/steering/`)

`.kiro/steering/*.md` files with `inclusion: always` are injected into *every single* AI
request automatically — that's expensive context budget, so only genuinely universal standing
rules belong there (terminology, conventions that apply to any task, meta-rules about how to
investigate/verify). See `.kiro/steering/knowledge-base-pointer.md` for the actual rule.

Everything else — deep-dive topic knowledge, pipeline internals, infrastructure notes, future
plans, design tradeoffs not yet decided — lives here instead. The AI is expected to come here
**on demand**, when a task actually touches one of these topics, rather than having it loaded
into context on every request.

Rule of thumb: **if it's not needed on literally every request, it belongs here, not in
steering.** If content in steering isn't actually universal, it should move here.

## Folder structure

- **`input/`** — raw, unprocessed drop-ins: brain-dumps, pasted logs, half-formed notes, meeting
  notes, anything you want captured before it's organized. Gitignored (personal, transient).
- **`knowledge/`** — the actual refined knowledge base. Durable, linked, tagged notes about the
  codebase and plans. Committed to git — this is the real deliverable.
- **`archive/`** — the *original* `input/` files, once the AI has processed them into proper
  `knowledge/` notes. Kept for history/traceability, not deleted. Gitignored (same reasoning as
  `input/` — these are superseded raw material, not curated knowledge).

## Workflow

1. Drop raw material into `input/`.
2. Ask the AI to process it — it reads the raw file(s), writes/updates proper note(s) in
   `knowledge/`, then moves the original from `input/` to `archive/`.
3. `knowledge/` accumulates as the real, linked knowledge base. Link related notes with
   `[[wikilinks]]` so Obsidian's graph view reflects actual relationships between topics.
4. If a `knowledge/` note turns out to describe something needed on *every* request (not just
   when its topic comes up), promote it back into `.kiro/steering/` as a proper always-included
   steering file, and remove/shrink the knowledge-base copy accordingly.

## For the AI: how to use this vault

- Land here first when investigating anything not already answered by steering's always-included
  files — check `knowledge/` for an existing note on the topic before re-deriving it from scratch.
- When you learn something durable during a task (an architectural fact, a gotcha, a decision),
  write or update a note in `knowledge/` rather than letting it evaporate at the end of the
  conversation.
- Don't duplicate steering content here, and don't duplicate knowledge-base content back into
  steering — each topic should have exactly one home. If you find drift, flag it to the user
  rather than silently picking a side.
