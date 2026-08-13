---
inclusion: fileMatch
fileMatchPattern: "backend/src/agent/kiro-runner.ts,worker/worker.js,backend/src/session-manager.ts"
---

# Kiro CLI Credit/Usage Tracking

## Status: shipped, with one known gap

Credit tracking from kiro-cli is implemented and live in both local and ACA worker modes.
**What's missing:** durable per-task persistence — usage only lives in in-memory session state
today and is lost on session restart. See "Known gap" below before treating this as fully done.

## How credit data arrives: `_kiro.dev/metadata`

Credit data is delivered as a **Kiro-proprietary extension notification** over the same NDJSON
stdio stream used for all ACP messages — NOT the ACP-standard `usage_update` session update
(present in the schema but unpopulated by kiro-cli 2.16.0), and NOT `PromptResponse.usage`
(currently absent/null).

### Notification shape

```jsonc
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/metadata",
  "params": {
    "sessionId": "<acp-session-uuid>",
    "contextUsagePercentage": 1.9138001203536987,
    // Only present on the FINAL metadata notification of a turn:
    "meteringUsage": [
      {
        "value": 0.06094613300165838,   // credits consumed this turn
        "unit": "credit",
        "unitPlural": "credits"
      }
    ],
    "turnDurationMs": 2279              // wall-clock turn time (ms)
  }
}
```

### Emission pattern during a prompt turn

Multiple `_kiro.dev/metadata` notifications are emitted per turn:

1. **Pre-prompt** — `{ contextUsagePercentage }` only (after session/new, before agent output).
2. **Mid-turn** — `{ contextUsagePercentage }` only (after streaming ends, before credits are
   tallied).
3. **End-of-turn** — `{ contextUsagePercentage, meteringUsage, turnDurationMs }`. This is the
   one that carries the credit cost, arriving immediately before the `session/prompt` JSON-RPC
   response.

The actionable notification is the one with a non-empty `meteringUsage`. Earlier ones in the
same turn are only useful for context-window monitoring, not cost.

## Where it's captured today

### `backend/src/agent/kiro-runner.ts` (local dev mode)

`handleMessage()` intercepts `_kiro.dev/*` notifications. On `_kiro.dev/metadata` with a
non-empty `meteringUsage`, it sums all entries where `unit === "credit"` and stores the total on
`client._lastTurnCredits`, read by the caller after the turn completes as `lastTurnCredits`.

### `worker/worker.js` (production ACA container)

The ACP message handler checks `method === "_kiro.dev/metadata"`. On a non-empty
`meteringUsage`, it sums credit entries into `turnStats.credits` and logs a `turn-metering`
structured log entry (`credits`, `unit`, `turnDurationMs`, `contextUsagePercentage`). This value
flows back to the orchestrator as `credits` on the `prompt-done` worker message
(`worker-ws-handler.ts` → `session-manager.ts`).

### `backend/src/session-manager.ts` (both modes)

After each turn, `managed.totalCreditsUsed` (local) or `session.totalCreditsUsed` (ACA) is
incremented by the turn's credits, mirrored onto `session.meta.totalCreditsUsed`, broadcast to
the browser over the client WebSocket, and surfaced as a system-log line: `"Task used X credits
(session total: Y credits)"`.

**Reset semantics:** `totalCreditsUsed` is reset to `0` whenever a session is (re)started — it is
a live "this run" counter, not a lifetime total.

## Known gap: no durable per-task persistence

`totalCreditsUsed` lives only in the in-memory `ManagedSession`/`session.meta` — there is no
`credits` column on the `tasks` table (`backend/sql/schema.sql`) and no code path writes
per-task or per-turn credit cost to the database. Consequences:

- Restarting a session zeroes its running total; there is no way to recover "how many credits did
  task #142 actually cost" after the fact.
- There is no cross-session or cross-task cost reporting (e.g. "total credits spent this week",
  "which task type is most expensive") beyond manually correlating log lines.

If this is worth solving, the natural next step is accumulating credits per task across all its
turns (a task may span multiple turns if reworked) and persisting that total when the task
resolves — but this hasn't been scoped or built. Treat it as a real gap, not an oversight to
silently work around.

## Local session file (alternative source, not used by KiroFactory)

The same data also exists in kiro-cli's local session metadata file
(`$KIRO_HOME/sessions/cli/<session-uuid>.json`,
`session_state.conversation_metadata.user_turn_metadatas[N].metering_usage`), readable from
inside the ACA worker container at `/root/.kiro/sessions/cli/` (runs as root). KiroFactory does
not use this path — the stdio notification is simpler, real-time, and doesn't require knowing
the session UUID in advance. Documented here only so it isn't "rediscovered" later; prefer the
stdio path if extending this feature.

## Reference: confirmed facts (as of kiro-cli 2.16.0)

| Question | Answer |
|----------|--------|
| Is credit data emitted over ACP stdio? | Yes — via `_kiro.dev/metadata` |
| Is it the standard ACP `usage_update`? | No — proprietary extension method |
| Is `PromptResponse.usage` populated? | No — returned absent |
| Is the local session file reachable in the ACA worker? | Yes, but unused (see above) |

**ACP spec evolution:** the standard `UsageUpdate` (`sessionUpdate: "usage_update"`) and
`PromptResponse.usage` exist in the schema (marked UNSTABLE) but aren't populated by kiro-cli
2.16.0. If a future version populates them, prefer the standard path and drop the
`_kiro.dev/metadata` extension handling — but don't do so speculatively; re-verify against the
kiro-cli version actually in use first.

## Related: broader Kiro usage/cost data (CLI session files, IDE storage, billing dashboard)

This document covers only the live ACP-stdio path KiroFactory itself uses. For a broader
reference on reading Kiro credit/token/usage data from kiro-cli's local JSONL session logs, the
Kiro IDE's SQLite storage, and the official billing/enterprise dashboards — useful when
investigating cost questions that aren't about KiroFactory's own worker/orchestrator code — see
the `kiro-usage-data-access` skill.
