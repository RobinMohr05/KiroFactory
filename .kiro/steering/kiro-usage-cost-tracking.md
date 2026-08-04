---
inclusion: fileMatch
fileMatchPattern: "backend/src/agent/kiro-runner.ts,worker/worker.js,backend/src/session-manager.ts"
---

# Kiro CLI Credit/Usage Data — Confirmed Availability

## Investigation Summary (confirmed 2026-08-04)

Credit/usage data from kiro-cli **IS available over the ACP stdio channel** and does
NOT require reading the local session file. Both `kiro-runner.ts` (local dev) and
`worker.js` (production ACA container) can capture it from messages they already
parse.

## How It Arrives: `_kiro.dev/metadata` Notification

The credit data is delivered as a **Kiro-proprietary extension notification** over
the same NDJSON stdio stream used for all ACP messages. It is NOT the ACP-standard
`usage_update` session update (which exists in the schema but kiro-cli 2.16.0 does
not populate), and NOT the `PromptResponse.usage` field (which kiro-cli currently
returns as absent/null).

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

1. **Pre-prompt** — `{ contextUsagePercentage }` only (after session/new, before
   agent output). Represents context window fill after system prompt is loaded.
2. **Mid-turn** — `{ contextUsagePercentage }` only (after the agent finishes
   streaming output, before credits are tallied).
3. **End-of-turn** — `{ contextUsagePercentage, meteringUsage, turnDurationMs }`.
   This is the one that carries the credit cost. It arrives **immediately before**
   the `session/prompt` JSON-RPC response (`PromptResponse`).

The actionable notification is the one that has `meteringUsage` present and
non-empty. Earlier metadata notifications in the same turn can be ignored for
cost tracking purposes (they are useful for context-window monitoring only).

## Where to Capture It in KiroFactory

### `backend/src/agent/kiro-runner.ts` (local dev mode)

The `handleMessage()` function already intercepts all `_kiro.dev/*` notifications
(lines ~211-227). Currently it only looks for `_kiro.dev/session/update`. To
capture usage:

```typescript
if (msg.method === "_kiro.dev/metadata") {
  const params = msg.params as {
    sessionId?: string;
    contextUsagePercentage?: number;
    meteringUsage?: Array<{ value: number; unit: string; unitPlural: string }>;
    turnDurationMs?: number;
  };
  if (params.meteringUsage?.length) {
    // This is the end-of-turn metadata with credit cost
    client.updateQueue.push({
      sessionUpdate: "usage_update",  // synthetic, for downstream consumers
      meteringUsage: params.meteringUsage,
      turnDurationMs: params.turnDurationMs,
      contextUsagePercentage: params.contextUsagePercentage,
    } as any);
    client.updateResolve?.();
    client.updateResolve = null;
  }
  return; // already handled (don't forward to SDK)
}
```

### `worker/worker.js` (production ACA container)

The `handleAcpMessage()` function checks `msg.method` for routing. Add handling
for `_kiro.dev/metadata` alongside the existing `_kiro.dev/agent/not_found` case:

```javascript
if (method === "_kiro.dev/metadata") {
  const params = msg.params ?? {};
  if (params.meteringUsage?.length) {
    logInfo("turn-metering", {
      credits: params.meteringUsage[0].value,
      unit: params.meteringUsage[0].unit,
      turnDurationMs: params.turnDurationMs,
      contextUsagePercentage: params.contextUsagePercentage,
    });
    // Forward to orchestrator so it can persist credits per task
    sendSessionUpdate({
      sessionUpdate: "usage_update",
      meteringUsage: params.meteringUsage,
      turnDurationMs: params.turnDurationMs,
      contextUsagePercentage: params.contextUsagePercentage,
    });
  }
  return true;
}
```

## Local Session File (alternative / backup path)

The same data is also available in the kiro-cli local session metadata file:

- **Path:** `$KIRO_HOME/sessions/cli/<session-uuid>.json`
  (default `KIRO_HOME` is `~/.kiro`)
- **Location in JSON:**
  `session_state.conversation_metadata.user_turn_metadatas[N].metering_usage`

Each turn's metadata entry includes:
```jsonc
{
  "metering_usage": [{ "value": 0.0609, "unit": "credit", "unitPlural": "credits" }],
  "input_token_count": 12345,
  "output_token_count": 678,
  "cache_read_input_token_count": 9000,
  "cache_write_input_token_count": 1500,
  "turn_duration": { "secs": 2, "nanos": 279494671 },
  "context_usage_percentage": 1.91,
  "model": "auto"
}
```

### Reachability from worker container

In the ACA worker container, kiro-cli writes to `/root/.kiro/sessions/cli/` (the
container runs as root). This path is readable by `worker.js` while the container
is alive. However, since the data is also available over the stdio channel (the
`_kiro.dev/metadata` notification), there is **no need to read the file** — the
stdio approach is simpler, real-time, and doesn't require knowing the session UUID
in advance.

## Confirmed Answers to the Open Questions

| Question | Answer |
|----------|--------|
| Is credit data emitted over ACP stdio? | **Yes** — via `_kiro.dev/metadata` notification |
| Is it the standard ACP `usage_update`? | No — kiro-cli uses a proprietary extension method |
| Is `PromptResponse.usage` populated? | No — kiro-cli 2.16.0 returns it as absent |
| Is the local session file reachable in the ACA worker? | Yes — at `/root/.kiro/sessions/cli/<uuid>.json` |
| Which path should KiroFactory use? | **Stdio (`_kiro.dev/metadata`)** — real-time, no file I/O |

## Key Design Decisions for Follow-Up Implementation

1. **Parse `_kiro.dev/metadata`** in both `kiro-runner.ts` and `worker.js` to
   extract `meteringUsage[0].value` (credits) and `turnDurationMs` per turn.
2. **Forward to orchestrator** via the existing `session-update` WebSocket message
   (worker → orchestrator) or capture directly (local dev mode).
3. **Persist per-task** — accumulate credits across all turns of a task (a task may
   have multiple prompt turns if retried or multi-step).
4. **Schema consideration** — the `meteringUsage` array could theoretically have
   multiple entries (e.g., if multiple models are used in one turn). Sum all
   `value` fields where `unit === "credit"` for the total.
5. **ACP spec evolution** — the standard `UsageUpdate` (`sessionUpdate:
   "usage_update"`) and `PromptResponse.usage` exist in the schema (marked
   UNSTABLE) but are not populated by kiro-cli 2.16.0. If a future version
   populates them, KiroFactory should prefer the standard path. Until then, the
   `_kiro.dev/metadata` extension is the only source of credit data.
