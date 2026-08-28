---
inclusion: always
---

# Knowledge Base — Check Here First

This workspace has an Obsidian knowledge base at `knowledge-base/` (see
`knowledge-base/README.md` for its full purpose and workflow). It holds deep-dive, topic-specific
knowledge about this codebase and future plans — content that's useful but not needed on every
single request, so it lives outside always-included steering.

Before investigating a topic not already covered by another always-included steering file, check
`knowledge-base/knowledge/` for an existing note. Notable topics currently there include the task
pipeline internals (claim/execute/resolve lifecycle) and Azure infrastructure specifics
(resource names, log querying, known bugs/gaps).

If you learn something durable while working — an architectural fact, a gotcha, a decision — add
or update a note in `knowledge-base/knowledge/` rather than letting it evaporate at the end of the
conversation. Don't duplicate content that's already in an always-included steering file here or
vice versa.
